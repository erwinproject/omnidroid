import crypto from 'node:crypto';
import path from 'node:path';
import {
  formatProxyUrl,
  generateRealisticIdentity,
  parseProxyString,
  type CloneInstanceInput,
  type CreateInstanceInput,
  type DeviceProfile,
  type InstanceHealth,
  type InstanceProxyState,
  type InstanceRecord,
  type ProxyConfig,
  type SetInstanceProxyInput,
  type SnapshotRecord,
} from '@droidforge/shared';
import type { AppEnv } from '../config/env.js';
import type { StateStore } from '../db/database.js';
import type { RedroidDockerManager } from '../docker/redroid-docker.manager.js';
import type { AdbExecutor } from './adb.service.js';
import type { ProxyRelayService } from './proxy-relay.service.js';
import type { StealthService } from './stealth.service.js';

export class InstanceOrchestrator {
  constructor(
    private readonly env: AppEnv,
    private readonly store: StateStore,
    private readonly docker: RedroidDockerManager,
    private readonly adb: AdbExecutor,
    private readonly stealth: StealthService,
    private readonly proxyRelay: ProxyRelayService,
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
    const inst = this.requireInstance(id);
    if (!inst.containerId) throw new Error('Container not created');
    await this.docker.startContainer(inst.containerId);
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
    const inst = this.requireInstance(id);
    if (!inst.containerId) throw new Error('Container not created');
    await this.proxyRelay.stopRelay(id);
    await this.docker.restartContainer(inst.containerId);
    const updated = this.store.updateInstanceStatus(id, 'booting')!;
    this.schedulePostBootSetup(updated);
    return updated;
  }

  async remove(id: string, removeVolume = false): Promise<void> {
    const inst = this.requireInstance(id);
    await this.proxyRelay.stopRelay(id);
    await this.adb.disconnect(inst.adbTarget).catch(() => undefined);
    await this.docker.removeContainer(inst.containerId, inst.volumeName, removeVolume);
    this.store.deleteInstance(id);
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
    await this.docker.cloneVolume(source.volumeName, newVolume);

    const profile: DeviceProfile = { ...source.profile };
    if (input.randomizeIdentity) {
      const identity = generateRealisticIdentity(profile.macOui);
      profile.serialNo = identity.serialNo;
      profile.androidId = identity.androidId;
      profile.macAddress = identity.macAddress;
    }

    const containerName = `redroid-${newId}`;
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

    this.store.saveInstance(cloned);
    const containerId = await this.docker.createContainer(cloned);
    cloned.containerId = containerId;
    cloned.status = 'booting';
    this.store.saveInstance(cloned);
    await this.docker.startContainer(containerId);
    this.schedulePostBootSetup(cloned);

    return cloned;
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
