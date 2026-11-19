import crypto from 'node:crypto';
import path from 'node:path';
import {
  generateRealisticIdentity,
  type CloneInstanceInput,
  type CreateInstanceInput,
  type DeviceProfile,
  type InstanceHealth,
  type InstanceRecord,
  type SnapshotRecord,
} from '@droidforge/shared';
import type { AppEnv } from '../config/env.js';
import type { StateStore } from '../db/database.js';
import type { RedroidDockerManager } from '../docker/redroid-docker.manager.js';
import type { AdbExecutor } from './adb.service.js';
import type { StealthService } from './stealth.service.js';

export class InstanceOrchestrator {
  constructor(
    private readonly env: AppEnv,
    private readonly store: StateStore,
    private readonly docker: RedroidDockerManager,
    private readonly adb: AdbExecutor,
    private readonly stealth: StealthService,
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
    const image = input.customImage ?? `${this.env.REDROID_IMAGE_REPO}:${input.androidVersion}.0.0-latest`;
    const hostAdbPort = input.exposeAdbPort
      ? this.store.allocateUniqueAdbPort(this.env.ADB_PORT_MIN, this.env.ADB_PORT_MAX)
      : null;

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
      proxy: input.proxy ?? null,
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

  private schedulePostBootSetup(instance: InstanceRecord): void {
    // Non-blocking boot watcher: connects ADB & applies post-boot stealth hardening
    void (async () => {
      for (let attempt = 0; attempt < 90; attempt++) {
        await new Promise((r) => setTimeout(r, 2000));
        const current = this.store.getInstance(instance.id);
        if (!current || current.status === 'stopped') return;
        await this.ensureAdbAuthorized(instance).catch(() => false);
        const connected = await this.adb.connect(instance.adbTarget);
        if (!connected) continue;
        if (this.adb.isAuthorized && !(await this.adb.isAuthorized(instance.adbTarget))) {
          await this.ensureAdbAuthorized(instance, true).catch(() => false);
          continue;
        }
        const booted = await this.adb.isBootCompleted(instance.adbTarget);
        if (booted) {
          if (instance.stealthMode) {
            await this.stealth.applyPostBootHardening(instance).catch(() => undefined);
          }
          this.store.updateInstanceStatus(instance.id, 'running');
          return;
        }
      }
    })();
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
    await this.adb.disconnect(inst.adbTarget).catch(() => undefined);
    if (inst.containerId) {
      await this.docker.stopContainer(inst.containerId);
    }
    return this.store.updateInstanceStatus(id, 'stopped')!;
  }

  async restart(id: string): Promise<InstanceRecord> {
    const inst = this.requireInstance(id);
    if (!inst.containerId) throw new Error('Container not created');
    await this.docker.restartContainer(inst.containerId);
    const updated = this.store.updateInstanceStatus(id, 'booting')!;
    this.schedulePostBootSetup(updated);
    return updated;
  }

  async remove(id: string, removeVolume = false): Promise<void> {
    const inst = this.requireInstance(id);
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
          if (inst.stealthMode) {
            await this.stealth.applyPostBootHardening(inst).catch(() => undefined);
          }
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
