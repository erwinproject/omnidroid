import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  formatProxyUrl,
  generateRealisticIdentity,
  parseProxyString,
  type CloneInstanceInput,
  type CreateInstanceInput,
  type DeleteInstanceResult,
  type DeleteSnapshotResult,
  type DeviceProfile,
  type InstanceHealth,
  type InstanceProxyState,
  type InstanceRecord,
  type ProxyConfig,
  type PruneReport,
  type SetInstanceProxyInput,
  type SnapshotRecord,
  type UpdateInstanceInput,
} from '@droidforge/shared';
import type { AppEnv } from '../config/env.js';
import type { StateStore } from '../db/database.js';
import type { RedroidDockerManager } from '../docker/redroid-docker.manager.js';
import type { AdbExecutor } from './adb.service.js';
import type { AiSnapshotService } from './ai-snapshot.service.js';
import type { ProxyRelayService } from './proxy-relay.service.js';
import type { PruneService } from './prune.service.js';
import type { RecordingService } from './recording.service.js';
import type { StealthService } from './stealth.service.js';
import type { StreamService } from './stream.service.js';

export class InstanceOrchestrator {
  constructor(
    private readonly env: AppEnv,
    private readonly store: StateStore,
    private readonly docker: RedroidDockerManager,
    private readonly adb: AdbExecutor,
    private readonly stealth: StealthService,
    private readonly proxyRelay: ProxyRelayService,
    private readonly recordings: RecordingService,
    private readonly pruneService: PruneService,
    private readonly stream: StreamService,
    private readonly aiSnapshot: AiSnapshotService,
  ) {}

  private resolveProfile(input: CreateInstanceInput): DeviceProfile {
    const base = this.store.getProfile(input.profileId);
    if (!base) {
      throw new Error(`Device profile not found: ${input.profileId}`);
    }
    const merged: DeviceProfile = {
      ...base,
      ...(input.deviceProfile ?? {}),
    };

    const identity = generateRealisticIdentity(merged.macOui);
    if (!merged.serialNo) merged.serialNo = identity.serialNo;
    if (!merged.androidId) merged.androidId = identity.androidId;
    if (!merged.macAddress) merged.macAddress = identity.macAddress;

    return merged;
  }

  private resolveInitialProxy(input: CreateInstanceInput): {
    proxy: string | null;
    proxyConfig: ProxyConfig | null;
    proxyProfileId: string | null;
  } {
    if (input.proxyProfileId) {
      const saved = this.store.getProxy(input.proxyProfileId);
      if (!saved) {
        const err = new Error(`Proxy profile not found: ${input.proxyProfileId}`) as Error & { statusCode?: number };
        err.statusCode = 404;
        throw err;
      }
      const config: ProxyConfig = {
        protocol: saved.protocol,
        host: saved.host,
        port: saved.port,
        username: saved.username,
        password: saved.password,
        bypass: saved.bypass,
      };
      return {
        proxy: formatProxyUrl(config, true),
        proxyConfig: config,
        proxyProfileId: saved.id,
      };
    }

    if (input.proxyConfig) {
      return {
        proxy: formatProxyUrl(input.proxyConfig, true),
        proxyConfig: input.proxyConfig,
        proxyProfileId: null,
      };
    }

    if (input.proxy && input.proxy.trim()) {
      const parsed = parseProxyString(input.proxy);
      return {
        proxy: formatProxyUrl(parsed, true),
        proxyConfig: parsed,
        proxyProfileId: null,
      };
    }

    return { proxy: null, proxyConfig: null, proxyProfileId: null };
  }

  async create(input: CreateInstanceInput): Promise<InstanceRecord> {
    if (this.store.getInstanceByName(input.name)) {
      throw new Error(`Instance with name "${input.name}" already exists`);
    }

    const id = crypto.randomBytes(4).toString('hex');
    const profile = this.resolveProfile(input);
    const width = input.width ?? profile.width;
    const height = input.height ?? profile.height;
    const dpi = input.dpi ?? profile.dpi;
    const containerName = `redroid-${id}`;
    const volumeName = `redroid-data-${id}`;
    const enablePlayStore = Boolean(input.enablePlayStore);
    const image = input.customImage
      ? input.customImage
      : enablePlayStore
        ? `${this.env.REDROID_PLAYSTORE_IMAGE_REPO}:${input.androidVersion}.0.0-playstore`
        : `${this.env.REDROID_IMAGE_REPO}:${input.androidVersion}.0.0-latest`;
    const hostAdbPort = input.exposeAdbPort
      ? this.store.allocateUniqueAdbPort(this.env.ADB_PORT_MIN, this.env.ADB_PORT_MAX)
      : null;

    const resolvedProxy = this.resolveInitialProxy(input);

    const now = new Date().toISOString();
    const record: InstanceRecord = {
      id,
      name: input.name,
      containerId: null,
      containerName,
      volumeName,
      image,
      androidVersion: input.androidVersion,
      status: 'creating',
      adbTarget: `${containerName}:5555`,
      hostAdbPort,
      width,
      height,
      dpi,
      fps: input.fps,
      gpuMode: input.gpuMode,
      memoryMb: input.memoryMb,
      cpus: input.cpus,
      stealthMode: input.stealthMode,
      enablePlayStore,
      bootConfigDirty: false,
      proxy: resolvedProxy.proxy,
      proxyConfig: resolvedProxy.proxyConfig,
      proxyProfileId: resolvedProxy.proxyProfileId,
      profile,
      customProps: input.customProps ?? {},
      createdAt: now,
      updatedAt: now,
    };

    this.store.saveInstance(record);

    try {
      const containerId = await this.docker.createContainer(record);
      record.containerId = containerId;
      record.status = input.autoStart ? 'booting' : 'stopped';
      record.updatedAt = new Date().toISOString();
      this.store.saveInstance(record);

      if (input.autoStart) {
        await this.docker.startContainer(containerId);
        this.schedulePostBootSetup(record);
      }

      return record;
    } catch (err) {
      if (!record.containerId) {
        await this.docker.removeContainer(null, record.volumeName, true, record.containerName).catch(() => undefined);
      }
      this.store.updateInstanceStatus(record.id, 'error');
      throw err;
    }
  }

  private async ensureAdbAuthorized(instance: InstanceRecord, forceRestartAdbd = false): Promise<boolean> {
    if (!instance.containerId || !this.adb.getPublicKey || !this.docker.authorizeAdbKey) {
      return false;
    }
    const pubKey = await this.adb.getPublicKey();
    if (!pubKey) return false;
    const restarted = await this.docker.authorizeAdbKey(instance.containerId, pubKey, forceRestartAdbd);
    if (restarted) {
      await this.adb.disconnect(instance.adbTarget).catch(() => undefined);
      await new Promise((r) => setTimeout(r, 800));
    }
    return restarted;
  }

  private async applyBootCompleteSetup(instance: InstanceRecord): Promise<void> {
    if (instance.stealthMode) {
      await this.stealth.applyPostBootHardening(instance).catch(() => undefined);
    }
    const latest = this.store.getInstance(instance.id) ?? instance;
    if (latest.proxyConfig) {
      await this.proxyRelay.applyToAndroid(this.adb, latest, latest.proxyConfig).catch(() => undefined);
    }
  }

  private schedulePostBootSetup(instance: InstanceRecord): void {
    // Non-blocking boot watcher: connects ADB & applies post-boot stealth + proxy setup
    void (async () => {
      for (let attempt = 0; attempt < 90; attempt++) {
        await new Promise((r) => setTimeout(r, 2000));
        const current = this.store.getInstance(instance.id);
        if (!current || current.status === 'stopped') return;
        await this.ensureAdbAuthorized(current).catch(() => false);
        const connected = await this.adb.connect(current.adbTarget);
        if (!connected) continue;
        if (this.adb.isAuthorized && !(await this.adb.isAuthorized(current.adbTarget))) {
          await this.ensureAdbAuthorized(current, true).catch(() => false);
          continue;
        }
        const booted = await this.adb.isBootCompleted(current.adbTarget);
        if (booted) {
          await this.applyBootCompleteSetup(current);
          this.store.updateInstanceStatus(current.id, 'running');
          return;
        }
      }
    })();
  }

  async restoreActiveRelays(): Promise<void> {
    const list = this.store.listInstances();
    for (const inst of list) {
      if ((inst.status === 'running' || inst.status === 'booting') && inst.proxyConfig) {
        try {
          await this.proxyRelay.ensureRelay(inst.id, inst.proxyConfig);
        } catch {
          // Ignore individual restore failure on startup
        }
      }
    }
  }

  async applyInstanceProxy(id: string, input: SetInstanceProxyInput): Promise<InstanceProxyState> {
    const inst = this.requireInstance(id);
    if (!input.enabled) {
      return this.clearInstanceProxy(id);
    }

    let nextConfig: ProxyConfig | null = null;
    let nextProfileId: string | null = null;
    let timezoneHint: string | null = null;

    if (input.proxyProfileId) {
      const saved = this.store.getProxy(input.proxyProfileId);
      if (!saved) {
        const err = new Error(`Proxy profile not found: ${input.proxyProfileId}`) as Error & { statusCode?: number };
        err.statusCode = 404;
        throw err;
      }
      nextConfig = {
        protocol: saved.protocol,
        host: saved.host,
        port: saved.port,
        username: saved.username,
        password: saved.password,
        bypass: saved.bypass,
      };
      nextProfileId = saved.id;
      timezoneHint = saved.lastTimezone;
    } else if (input.config) {
      nextConfig = input.config;
    } else if (input.raw && input.raw.trim()) {
      nextConfig = parseProxyString(input.raw);
    } else {
      return this.clearInstanceProxy(id);
    }

    const updated: InstanceRecord = {
      ...inst,
      proxy: formatProxyUrl(nextConfig, true),
      proxyConfig: nextConfig,
      proxyProfileId: nextProfileId,
      updatedAt: new Date().toISOString(),
    };
    this.store.saveInstance(updated);

    if (updated.status === 'running' || updated.status === 'booting') {
      if (input.syncTimezone && !timezoneHint) {
        const probe = await this.proxyRelay.testProxy(nextConfig, 8000);
        timezoneHint = probe.timezone;
      }
      await this.proxyRelay.applyToAndroid(this.adb, updated, nextConfig, input.syncTimezone, timezoneHint);
    }

    return this.proxyRelay.getAndroidState(this.adb, updated);
  }

  async clearInstanceProxy(id: string): Promise<InstanceProxyState> {
    const inst = this.requireInstance(id);
    const updated: InstanceRecord = {
      ...inst,
      proxy: null,
      proxyConfig: null,
      proxyProfileId: null,
      updatedAt: new Date().toISOString(),
    };
    this.store.saveInstance(updated);

    if (updated.status === 'running' || updated.status === 'booting') {
      await this.proxyRelay.clearOnAndroid(this.adb, updated);
    } else {
      await this.proxyRelay.stopRelay(id);
    }

    return this.proxyRelay.getAndroidState(this.adb, updated);
  }

  async start(id: string): Promise<InstanceRecord> {
    let inst = this.requireInstance(id);
    if (!inst.containerId) throw new Error('Container not created');
    if (inst.bootConfigDirty) inst = await this.recreateContainer(inst);
    await this.docker.startContainer(inst.containerId!);
    const updated = this.store.updateInstanceStatus(id, 'booting')!;
    this.schedulePostBootSetup(updated);
    return updated;
  }

  async stop(id: string): Promise<InstanceRecord> {
    const inst = this.requireInstance(id);
    await this.proxyRelay.stopRelay(id);
    await this.adb.disconnect(inst.adbTarget).catch(() => undefined);
    if (inst.containerId) {
      await this.docker.stopContainer(inst.containerId);
    }
    return this.store.updateInstanceStatus(id, 'stopped')!;
  }

  async restart(id: string): Promise<InstanceRecord> {
    let inst = this.requireInstance(id);
    if (!inst.containerId) throw new Error('Container not created');
    await this.proxyRelay.stopRelay(id);
    this.stream.stopInstance(id);
    if (inst.bootConfigDirty) {
      inst = await this.recreateContainer(inst);
      await this.docker.startContainer(inst.containerId!);
    } else {
      await this.docker.restartContainer(inst.containerId);
    }
    const updated = this.store.updateInstanceStatus(id, 'booting')!;
    this.schedulePostBootSetup(updated);
    return updated;
  }

  /** Recreates the Docker container from the stored record, keeping the /data volume. */
  private async recreateContainer(inst: InstanceRecord): Promise<InstanceRecord> {
    this.stream.stopInstance(inst.id);
    await this.adb.disconnect(inst.adbTarget).catch(() => undefined);
    await this.docker.removeContainer(inst.containerId, inst.volumeName, false, inst.containerName);
    const next: InstanceRecord = { ...inst, containerId: null, bootConfigDirty: false };
    const containerId = await this.docker.createContainer(next);
    next.containerId = containerId;
    next.updatedAt = new Date().toISOString();
    this.store.saveInstance(next);
    return next;
  }

  /**
   * Edits an instance. Live-safe fields apply immediately; boot-time fields
   * (profile, fps, GPU, stealth, props, image, ADB port) recreate the container
   * while preserving the /data volume.
   */
  async update(id: string, patch: UpdateInstanceInput): Promise<InstanceRecord> {
    const current = this.requireInstance(id);
    const wasActive = current.status === 'running' || current.status === 'booting';
    let next: InstanceRecord = { ...current };
    let needsRecreate = false;
    let displayChanged = false;

    if (patch.name !== undefined && patch.name !== current.name) {
      const clash = this.store.getInstanceByName(patch.name);
      if (clash && clash.id !== id) throw new Error(`Instance with name "${patch.name}" already exists`);
      next.name = patch.name;
    }

    // ---- Boot-time fields (container recreate) ----
    if (patch.fps !== undefined && patch.fps !== current.fps) {
      next.fps = patch.fps;
      needsRecreate = true;
    }
    if (patch.gpuMode !== undefined && patch.gpuMode !== current.gpuMode) {
      next.gpuMode = patch.gpuMode;
      needsRecreate = true;
    }
    if (patch.stealthMode !== undefined && patch.stealthMode !== current.stealthMode) {
      next.stealthMode = patch.stealthMode;
      needsRecreate = true;
    }
    if (patch.customProps !== undefined) {
      next.customProps = patch.customProps;
      needsRecreate = true;
    }

    if (patch.profileId !== undefined || patch.deviceProfile !== undefined) {
      const base = this.store.getProfile(patch.profileId ?? current.profile.id) ?? current.profile;
      const merged: DeviceProfile = {
        ...base,
        // keep the instance identity unless explicitly overridden
        serialNo: current.profile.serialNo,
        androidId: current.profile.androidId,
        macAddress: current.profile.macAddress,
        ...(patch.deviceProfile ?? {}),
      };
      const identity = generateRealisticIdentity(merged.macOui);
      if (!merged.serialNo) merged.serialNo = identity.serialNo;
      if (!merged.androidId) merged.androidId = identity.androidId;
      if (!merged.macAddress) merged.macAddress = identity.macAddress;
      next.profile = merged;
      needsRecreate = true;
    }

    const versionChanged = patch.androidVersion !== undefined && patch.androidVersion !== current.androidVersion;
    const storeChanged = patch.enablePlayStore !== undefined && patch.enablePlayStore !== current.enablePlayStore;
    if (versionChanged || storeChanged) {
      next.androidVersion = patch.androidVersion ?? current.androidVersion;
      next.enablePlayStore = patch.enablePlayStore ?? current.enablePlayStore;
      next.image = next.enablePlayStore
        ? `${this.env.REDROID_PLAYSTORE_IMAGE_REPO}:${next.androidVersion}.0.0-playstore`
        : `${this.env.REDROID_IMAGE_REPO}:${next.androidVersion}.0.0-latest`;
      needsRecreate = true;
    }

    if (patch.exposeAdbPort !== undefined && Boolean(current.hostAdbPort) !== patch.exposeAdbPort) {
      next.hostAdbPort = patch.exposeAdbPort
        ? this.store.allocateUniqueAdbPort(this.env.ADB_PORT_MIN, this.env.ADB_PORT_MAX)
        : null;
      needsRecreate = true;
    }

    // ---- Display (live via wm, persisted on next boot) ----
    for (const key of ['width', 'height', 'dpi'] as const) {
      const value = patch[key];
      if (value !== undefined && value !== current[key]) {
        next[key] = value;
        displayChanged = true;
      }
    }

    // ---- Resources (live via docker update) ----
    const resourcesChanged =
      (patch.memoryMb !== undefined && patch.memoryMb !== current.memoryMb) ||
      (patch.cpus !== undefined && patch.cpus !== current.cpus);
    if (patch.memoryMb !== undefined) next.memoryMb = patch.memoryMb;
    if (patch.cpus !== undefined) next.cpus = patch.cpus;

    next.updatedAt = new Date().toISOString();

    if (needsRecreate) {
      // Boot args are read from the record, so width/height/dpi are applied by the recreate too.
      next.bootConfigDirty = false;
      await this.proxyRelay.stopRelay(id).catch(() => undefined);
      this.store.saveInstance(next);
      next = await this.recreateContainer(next);
      if (wasActive) {
        await this.docker.startContainer(next.containerId!);
        next = this.store.updateInstanceStatus(id, 'booting')!;
        this.schedulePostBootSetup(next);
      } else {
        next = this.store.updateInstanceStatus(id, 'stopped')!;
      }
      return next;
    }

    if (displayChanged) next.bootConfigDirty = true;
    this.store.saveInstance(next);

    if (resourcesChanged && next.containerId) {
      try {
        await this.docker.updateResources(next.containerId, next.memoryMb, next.cpus);
      } catch {
        next.bootConfigDirty = true;
        this.store.saveInstance(next);
      }
    }
    if (displayChanged && wasActive) {
      await this.adb.shell(next.adbTarget, `wm size ${next.width}x${next.height}`).catch(() => undefined);
      await this.adb.shell(next.adbTarget, `wm density ${next.dpi}`).catch(() => undefined);
      this.stream.stopInstance(id); // viewers reconnect with the new resolution
    }

    return this.requireInstance(id);
  }
  private removeSnapshotFilesForInstance(instanceId: string): {
    removedFiles: number;
    reclaimedBytes: number;
  } {
    let removedFiles = 0;
    let reclaimedBytes = 0;
    const deletedPaths = new Set<string>();

    for (const snap of this.store.listSnapshots(instanceId)) {
      const resolved = path.resolve(snap.filePath);
      if (fs.existsSync(resolved)) {
        try {
          const stat = fs.statSync(resolved);
          if (stat.isFile()) {
            fs.unlinkSync(resolved);
            removedFiles += 1;
            reclaimedBytes += stat.size;
            deletedPaths.add(resolved);
          }
        } catch {
          // Ignore already removed snapshot file
        }
      }
    }

    const snapshotsDir = path.resolve(this.env.DATA_DIR, 'snapshots');
    if (fs.existsSync(snapshotsDir)) {
      try {
        for (const entry of fs.readdirSync(snapshotsDir)) {
          if (!entry.startsWith(`${instanceId}_`)) continue;
          const resolved = path.resolve(snapshotsDir, entry);
          if (deletedPaths.has(resolved)) continue;
          try {
            const stat = fs.statSync(resolved);
            if (stat.isFile()) {
              fs.unlinkSync(resolved);
              removedFiles += 1;
              reclaimedBytes += stat.size;
              deletedPaths.add(resolved);
            }
          } catch {
            // Ignore transient unlink errors
          }
        }
      } catch {
        // Ignore directory read errors
      }
    }

    return { removedFiles, reclaimedBytes };
  }

  async remove(
    id: string,
    removeVolumeOrOptions: boolean | { removeVolume?: boolean; prune?: boolean } = true,
  ): Promise<DeleteInstanceResult> {
    const inst = this.requireInstance(id);
    const removeVolume =
      typeof removeVolumeOrOptions === 'boolean'
        ? removeVolumeOrOptions
        : (removeVolumeOrOptions.removeVolume ?? true);
    const shouldPrune =
      typeof removeVolumeOrOptions === 'boolean'
        ? this.env.AUTO_PRUNE_ON_DELETE
        : (removeVolumeOrOptions.prune ?? this.env.AUTO_PRUNE_ON_DELETE);

    this.stream.stopInstance(id);
    this.aiSnapshot.clearInstance(id);
    await this.proxyRelay.stopRelay(id);
    await this.adb.disconnect(inst.adbTarget).catch(() => undefined);

    const volumeSize = removeVolume ? await this.docker.getVolumeSize(inst.volumeName).catch(() => 0) : 0;
    await this.docker.removeContainer(inst.containerId, inst.volumeName, removeVolume, inst.containerName);

    const snapRemoval = this.removeSnapshotFilesForInstance(id);
    const recRemoval = this.recordings.removeForInstance(id);

    this.store.deleteInstance(id);

    let pruneReport: PruneReport | null = null;
    if (shouldPrune) {
      pruneReport = await this.pruneService.prune(
        {
          dryRun: false,
          removeDanglingImages: this.env.PRUNE_DANGLING_IMAGES_ON_DELETE,
          removeUnusedRedroidImages: false,
          removeBuildCache: false,
          minTempFileAgeMs: 300_000,
        },
        { excludeVolumes: removeVolume ? [] : [inst.volumeName] },
      );
    } else {
      this.store.checkpoint();
    }

    const reclaimedBytes =
      volumeSize +
      snapRemoval.reclaimedBytes +
      recRemoval.reclaimedBytes +
      (pruneReport?.reclaimedBytes ?? 0);

    return {
      deleted: true,
      instanceId: id,
      removedVolume: removeVolume,
      removedSnapshotFiles: snapRemoval.removedFiles,
      removedRecordingFiles: recRemoval.removedFiles,
      reclaimedBytes,
      prune: pruneReport,
    };
  }

  async health(id: string): Promise<InstanceHealth> {
    const inst = this.requireInstance(id);
    const stats = await this.docker.getContainerStats(inst.containerId);
    let adbConnected = false;
    let bootCompleted = false;

    if (stats.running) {
      await this.ensureAdbAuthorized(inst).catch(() => false);
      let connected = await this.adb.connect(inst.adbTarget);
      if (connected && this.adb.isAuthorized && !(await this.adb.isAuthorized(inst.adbTarget))) {
        await this.ensureAdbAuthorized(inst, true).catch(() => false);
        connected = await this.adb.connect(inst.adbTarget);
      }
      adbConnected = connected && (this.adb.isAuthorized ? await this.adb.isAuthorized(inst.adbTarget) : true);
      if (adbConnected) {
        bootCompleted = await this.adb.isBootCompleted(inst.adbTarget);
        if (bootCompleted && inst.status !== 'running') {
          await this.applyBootCompleteSetup(inst);
          this.store.updateInstanceStatus(inst.id, 'running');
        }
      }
    }

    return {
      instanceId: inst.id,
      containerRunning: stats.running,
      adbConnected,
      bootCompleted,
      cpuPercent: stats.cpuPercent,
      memoryUsageMb: stats.memoryUsageMb,
      memoryLimitMb: stats.memoryLimitMb,
    };
  }

  async clone(sourceId: string, input: CloneInstanceInput): Promise<InstanceRecord> {
    const source = this.requireInstance(sourceId);
    if (this.store.getInstanceByName(input.name)) {
      throw new Error(`Instance with name "${input.name}" already exists`);
    }

    const newId = crypto.randomBytes(4).toString('hex');
    const newVolume = `redroid-data-${newId}`;
    const containerName = `redroid-${newId}`;

    const profile: DeviceProfile = { ...source.profile };
    if (input.randomizeIdentity) {
      const identity = generateRealisticIdentity(profile.macOui);
      profile.serialNo = identity.serialNo;
      profile.androidId = identity.androidId;
      profile.macAddress = identity.macAddress;
    }

    const hostAdbPort = input.exposeAdbPort
      ? this.store.allocateUniqueAdbPort(this.env.ADB_PORT_MIN, this.env.ADB_PORT_MAX)
      : null;

    const now = new Date().toISOString();
    const cloned: InstanceRecord = {
      ...source,
      id: newId,
      name: input.name,
      containerId: null,
      containerName,
      volumeName: newVolume,
      adbTarget: `${containerName}:5555`,
      hostAdbPort,
      profile,
      status: 'creating',
      createdAt: now,
      updatedAt: now,
    };

    try {
      await this.docker.cloneVolume(source.volumeName, newVolume);
      this.store.saveInstance(cloned);
      const containerId = await this.docker.createContainer(cloned);
      cloned.containerId = containerId;
      cloned.status = 'booting';
      this.store.saveInstance(cloned);
      await this.docker.startContainer(containerId);
      this.schedulePostBootSetup(cloned);
      return cloned;
    } catch (err) {
      await this.docker
        .removeContainer(cloned.containerId, newVolume, true, containerName)
        .catch(() => undefined);
      this.store.deleteInstance(newId);
      throw err;
    }
  }

  async createSnapshot(id: string, name?: string): Promise<SnapshotRecord> {
    const inst = this.requireInstance(id);
    const snapId = `snap_${crypto.randomBytes(4).toString('hex')}`;
    const snapName = name || `snapshot-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    const filePath = path.resolve(this.env.DATA_DIR, 'snapshots', `${inst.id}_${snapId}.tar.gz`);

    const sizeBytes = await this.docker.backupVolumeToTar(inst.volumeName, filePath);
    const record: SnapshotRecord = {
      id: snapId,
      instanceId: inst.id,
      name: snapName,
      filePath,
      sizeBytes,
      createdAt: new Date().toISOString(),
    };
    this.store.saveSnapshot(record);
    return record;
  }

  async restoreSnapshot(id: string, snapId: string): Promise<void> {
    const inst = this.requireInstance(id);
    const snap = this.store.getSnapshot(snapId);
    if (!snap || snap.instanceId !== id) {
      throw new Error(`Snapshot ${snapId} not found for instance ${id}`);
    }

    const wasRunning = inst.status === 'running' || inst.status === 'booting';
    if (wasRunning && inst.containerId) {
      await this.proxyRelay.stopRelay(id);
      await this.docker.stopContainer(inst.containerId);
    }

    await this.docker.restoreVolumeFromTar(inst.volumeName, snap.filePath);

    if (wasRunning && inst.containerId) {
      await this.docker.startContainer(inst.containerId);
      this.schedulePostBootSetup(inst);
    }
  }

  async deleteSnapshot(id: string, snapId: string): Promise<DeleteSnapshotResult> {
    this.requireInstance(id);
    const snap = this.store.getSnapshot(snapId);
    if (!snap || snap.instanceId !== id) {
      const err = new Error(`Snapshot ${snapId} not found for instance ${id}`) as Error & { statusCode?: number };
      err.statusCode = 404;
      throw err;
    }

    let reclaimedBytes = 0;
    const resolved = path.resolve(snap.filePath);
    if (fs.existsSync(resolved)) {
      try {
        const stat = fs.statSync(resolved);
        if (stat.isFile()) {
          fs.unlinkSync(resolved);
          reclaimedBytes = stat.size;
        }
      } catch {
        // Ignore already removed snapshot file
      }
    }

    this.store.deleteSnapshot(snapId);
    this.store.checkpoint();

    return {
      deleted: true,
      snapshotId: snapId,
      reclaimedBytes,
    };
  }

  requireInstance(id: string): InstanceRecord {
    const inst = this.store.getInstance(id);
    if (!inst) {
      const err = new Error(`Instance not found: ${id}`) as Error & { statusCode?: number };
      err.statusCode = 404;
      throw err;
    }
    return inst;
  }
}
