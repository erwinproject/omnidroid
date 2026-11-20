import fs from 'node:fs';
import path from 'node:path';
import Docker from 'dockerode';
import type { DeviceProfile, InstanceRecord, SystemImageStatus } from '@droidforge/shared';
import type { AppEnv } from '../config/env.js';

export interface ContainerStatsResult {
  running: boolean;
  cpuPercent: number | null;
  memoryUsageMb: number | null;
  memoryLimitMb: number | null;
}

export interface DockerContainerSummary {
  id: string;
  names: string[];
  image: string;
  imageId: string;
  state: string;
  status: string;
  labels: Record<string, string>;
  mounts: Array<{ type: string; name?: string; source?: string; destination?: string }>;
  sizeRw: number;
}

export interface DockerVolumeSummary {
  name: string;
  driver: string;
  mountpoint: string;
  labels: Record<string, string>;
  sizeBytes: number;
  refCount: number | null;
}

export interface DockerImageSummary {
  id: string;
  repoTags: string[];
  sizeBytes: number;
  dangling: boolean;
  containers: number;
}

interface DockerDfResult {
  Volumes?: Array<{
    Name?: string;
    UsageData?: { Size?: number; RefCount?: number } | null;
  }>;
  BuildCache?: Array<{
    InUse?: boolean;
    Size?: number;
  }>;
}

function isDockerNotFound(err: unknown): boolean {
  const e = err as { statusCode?: number; message?: string };
  if (e?.statusCode === 404) return true;
  return typeof e?.message === 'string' && /no such/i.test(e.message);
}

export function buildRedroidBootArgs(instance: {
  width: number;
  height: number;
  dpi: number;
  fps: number;
  gpuMode: 'guest' | 'host' | 'auto';
  stealthMode: boolean;
  profile: DeviceProfile;
  customProps: Record<string, string>;
}): string[] {
  const { width, height, dpi, fps, gpuMode, stealthMode, profile, customProps } = instance;

  const props: Record<string, string> = {
    'androidboot.redroid_width': String(width),
    'androidboot.redroid_height': String(height),
    'androidboot.redroid_dpi': String(dpi),
    'androidboot.redroid_fps': String(fps),
    'androidboot.redroid_gpu_mode': gpuMode,
    'androidboot.use_memfd': 'true',
    // Redroid 12/13/14 libcutils creates memfds without F_SEAL_SHRINK|F_SEAL_GROW when
    // androidboot.use_memfd=true (required on Linux 5.18+ without /dev/ashmem).
    // Modern Chrome/Chromium requires those seals in GetMemoryProtectionMask() and crashes
    // with SIGTRAP unless ro.vendor.api_level >= 202404, which enables Chromium's direct
    // memfd_create + ftruncate + F_ADD_SEALS(F_SEAL_SHRINK|F_SEAL_GROW) path.
    'ro.vendor.api_level': '202404',
    'ro.setupwizard.mode': 'DISABLED',
  };

  // Device identity & build props (model, brand, manufacturer, device, type, fingerprint)
  const productPartitions = ['', 'system.', 'vendor.', 'odm.', 'product.', 'system_ext.'];
  for (const part of productPartitions) {
    props[`ro.product.${part}brand`] = profile.brand;
    props[`ro.product.${part}manufacturer`] = profile.manufacturer;
    props[`ro.product.${part}model`] = profile.model;
    props[`ro.product.${part}device`] = profile.device;
    props[`ro.product.${part}name`] = profile.product;
  }

  props['ro.build.fingerprint'] = profile.buildFingerprint;
  props['ro.system.build.fingerprint'] = profile.buildFingerprint;
  props['ro.vendor.build.fingerprint'] = profile.buildFingerprint;
  props['ro.bootimage.build.fingerprint'] = profile.buildFingerprint;
  props['ro.build.id'] = profile.buildId;
  props['ro.build.type'] = profile.buildType;
  props['ro.build.tags'] = profile.buildTags;
  props['ro.build.version.security_patch'] = profile.securityPatch;
  props['ro.hardware'] = profile.hardware;
  // Redroid only ships hwcomposer.redroid.so and gpu_config.sh does not set ro.hardware.hwcomposer
  props['ro.hardware.hwcomposer'] = 'redroid';
  props['ro.product.board'] = profile.board;
  props['ro.board.platform'] = profile.platform;

  if (profile.serialNo) {
    props['ro.serialno'] = profile.serialNo;
    props['ro.boot.serialno'] = profile.serialNo;
  }

  // Locale, timezone & carrier
  props['persist.sys.locale'] = profile.locale;
  props['persist.sys.timezone'] = profile.timezone;
  props['gsm.operator.alpha'] = profile.carrierName;
  props['gsm.sim.operator.alpha'] = profile.carrierName;
  props['gsm.operator.numeric'] = profile.carrierMccMnc;
  props['gsm.sim.operator.numeric'] = profile.carrierMccMnc;
  props['gsm.operator.iso-country'] = profile.countryIso;
  props['gsm.sim.operator.iso-country'] = profile.countryIso;
  props['gsm.sim.state'] = 'READY';

  if (stealthMode) {
    props['ro.build.type'] = 'user';
    props['ro.build.tags'] = 'release-keys';
    props['ro.debuggable'] = '0';
    props['ro.secure'] = '1';
    props['ro.boot.verifiedbootstate'] = 'green';
    props['ro.boot.flash.locked'] = '1';
    props['ro.boot.vbmeta.device_state'] = 'locked';
    props['ro.kernel.qemu'] = '0';
    props['ro.boot.qemu'] = '0';
    props['ro.build.characteristics'] = 'default';
  }

  // User explicit customProps override everything else
  for (const [k, v] of Object.entries(customProps)) {
    props[k] = v;
  }

  return Object.entries(props).map(([k, v]) => `${k}=${v}`);
}

export class RedroidDockerManager {
  private readonly docker: Docker;
  private readonly env: AppEnv;

  constructor(env: AppEnv, dockerClient?: Docker) {
    this.env = env;
    this.docker = dockerClient ?? new Docker({ socketPath: env.DOCKER_SOCKET });
  }

  async ensureNetwork(): Promise<void> {
    const networks = await this.docker.listNetworks({
      filters: { name: [this.env.DOCKER_NETWORK] },
    });
    const exists = networks.some((n) => n.Name === this.env.DOCKER_NETWORK);
    if (!exists) {
      await this.docker.createNetwork({
        Name: this.env.DOCKER_NETWORK,
        Driver: 'bridge',
      });
    }
  }

  async ensureImage(image: string): Promise<void> {
    try {
      await this.docker.getImage(image).inspect();
      return;
    } catch {
      // Pull image if not present locally
    }

    if (
      image.startsWith(`${this.env.REDROID_PLAYSTORE_IMAGE_REPO}:`) &&
      image.endsWith('-playstore')
    ) {
      const verMatch = image.match(/:(\d+)\./);
      const ver = verMatch?.[1] ?? '13';
      const err = new Error(
        `Play Store image "${image}" is not built locally yet. Run: bash scripts/build-playstore-image.sh ${ver}`,
      ) as Error & { statusCode?: number };
      err.statusCode = 400;
      throw err;
    }

    const stream = await this.docker.pull(image);
    await new Promise<void>((resolve, reject) => {
      this.docker.modem.followProgress(stream, (err: Error | null) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  async getSystemImages(): Promise<SystemImageStatus[]> {
    const versions: Array<'11' | '12' | '13' | '14'> = ['11', '12', '13', '14'];
    let imagesList: Array<{ RepoTags?: string[]; Size?: number }> = [];
    try {
      imagesList = (await this.docker.listImages()) as Array<{ RepoTags?: string[]; Size?: number }>;
    } catch {
      imagesList = [];
    }

    const findImage = (tag: string) =>
      imagesList.find((img) => Array.isArray(img.RepoTags) && img.RepoTags.includes(tag));

    return versions.map((v) => {
      const baseImage = `${this.env.REDROID_IMAGE_REPO}:${v}.0.0-latest`;
      const playStoreImage = `${this.env.REDROID_PLAYSTORE_IMAGE_REPO}:${v}.0.0-playstore`;
      const baseFound = findImage(baseImage);
      const playFound = findImage(playStoreImage);
      return {
        androidVersion: v,
        baseImage,
        baseInstalled: Boolean(baseFound),
        playStoreImage,
        playStoreInstalled: Boolean(playFound),
        playStoreSizeMb: playFound?.Size ? Math.round(playFound.Size / (1024 * 1024)) : null,
        buildCommand: `bash scripts/build-playstore-image.sh ${v}`,
      };
    });
  }

  async ensureManagedVolume(volumeName: string, instanceId?: string, instanceName?: string): Promise<void> {
    try {
      await this.docker.getVolume(volumeName).inspect();
      return;
    } catch {
      // Create volume with droidforge labels if missing
    }
    const labels: Record<string, string> = {
      'droidforge.managed': 'true',
      ...(instanceId ? { 'droidforge.instance_id': instanceId } : {}),
      ...(instanceName ? { 'droidforge.instance_name': instanceName } : {}),
    };
    await this.docker.createVolume({
      Name: volumeName,
      Labels: labels,
    });
  }

  async createContainer(instance: InstanceRecord): Promise<string> {
    await this.ensureNetwork();
    await this.ensureImage(instance.image);
    await this.ensureManagedVolume(instance.volumeName, instance.id, instance.name);

    const cmd = buildRedroidBootArgs({
      width: instance.width,
      height: instance.height,
      dpi: instance.dpi,
      fps: instance.fps,
      gpuMode: instance.gpuMode,
      stealthMode: instance.stealthMode,
      profile: instance.profile,
      customProps: instance.customProps,
    });

    const portBindings: Record<string, Array<{ HostPort: string }>> = {};
    const exposedPorts: Record<string, Record<string, never>> = { '5555/tcp': {} };
    if (instance.hostAdbPort) {
      portBindings['5555/tcp'] = [{ HostPort: String(instance.hostAdbPort) }];
    }

    const container = await this.docker.createContainer({
      name: instance.containerName,
      Hostname: instance.containerName,
      Image: instance.image,
      MacAddress: instance.profile.macAddress,
      Cmd: cmd,
      ExposedPorts: exposedPorts,
      Labels: {
        'droidforge.managed': 'true',
        'droidforge.instance_id': instance.id,
        'droidforge.instance_name': instance.name,
      },
      HostConfig: {
        Privileged: true,
        Memory: instance.memoryMb * 1024 * 1024,
        NanoCpus: Math.round(instance.cpus * 1e9),
        Binds: [`${instance.volumeName}:/data`],
        PortBindings: portBindings,
        RestartPolicy: { Name: 'unless-stopped' },
        NetworkMode: this.env.DOCKER_NETWORK,
      },
    });

    return container.id;
  }

  /** Live-resizes container memory/CPU without a restart. */
  async updateResources(containerId: string, memoryMb: number, cpus: number): Promise<void> {
    const memory = memoryMb * 1024 * 1024;
    await this.docker.getContainer(containerId).update({
      Memory: memory,
      MemorySwap: memory * 2,
      NanoCpus: Math.round(cpus * 1e9),
    });
  }

  async startContainer(containerId: string): Promise<void> {
    const container = this.docker.getContainer(containerId);
    const info = await container.inspect();
    if (!info.State.Running) {
      await container.start();
    }
  }

  async stopContainer(containerId: string): Promise<void> {
    const container = this.docker.getContainer(containerId);
    try {
      const info = await container.inspect();
      if (info.State.Running) {
        await container.stop({ t: 10 });
      }
    } catch {
      // Container might already be stopped or missing
    }
  }

  async restartContainer(containerId: string): Promise<void> {
    const container = this.docker.getContainer(containerId);
    await container.restart({ t: 10 });
  }

  async authorizeAdbKey(containerId: string, publicKey: string, forceRestartAdbd = false): Promise<boolean> {
    const sanitizedKey = publicKey.split(/\r?\n/)[0]?.replace(/['\r\n]/g, '').trim() ?? '';
    if (!sanitizedKey) return false;

    const restartLines = forceRestartAdbd
      ? ['  setprop ctl.restart adbd 2>/dev/null || true', '  echo "RESTARTED"']
      : [];

    const script = [
      'if [ ! -d /data/misc ]; then echo "DEFERRED"; exit 0; fi',
      'mkdir -p /data/misc/adb && chown 1000:2000 /data/misc/adb && chmod 0750 /data/misc/adb && touch /data/misc/adb/adb_keys',
      `if grep -qxF '${sanitizedKey}' /data/misc/adb/adb_keys; then`,
      '  chown 1000:2000 /data/misc/adb/adb_keys && chmod 0640 /data/misc/adb/adb_keys',
      '  echo "PRESENT"',
      ...restartLines,
      'else',
      `  printf '%s\\n' '${sanitizedKey}' >> /data/misc/adb/adb_keys && chown 1000:2000 /data/misc/adb/adb_keys && chmod 0640 /data/misc/adb/adb_keys && (setprop ctl.restart adbd 2>/dev/null || true)`,
      '  echo "ADDED"',
      'fi',
    ].join('\n');

    try {
      const container = this.docker.getContainer(containerId);
      const exec = await container.exec({
        Cmd: ['sh', '-c', script],
        AttachStdout: true,
        AttachStderr: true,
        User: '0',
      });
      const stream = await exec.start({ Detach: false, Tty: false });
      const output = await new Promise<string>((resolve) => {
        const chunks: Buffer[] = [];
        const timer = setTimeout(() => resolve(Buffer.concat(chunks).toString('utf8')), 8000);
        stream.on('data', (chunk: Buffer) => chunks.push(chunk));
        stream.on('end', () => {
          clearTimeout(timer);
          resolve(Buffer.concat(chunks).toString('utf8'));
        });
        stream.on('error', () => {
          clearTimeout(timer);
          resolve(Buffer.concat(chunks).toString('utf8'));
        });
      });
      return output.includes('ADDED') || output.includes('RESTARTED');
    } catch {
      return false;
    }
  }

  async removeContainer(
    containerId: string | null,
    volumeName?: string,
    removeVolume = false,
    containerName?: string,
  ): Promise<void> {
    let removedById = false;
    if (containerId) {
      const container = this.docker.getContainer(containerId);
      try {
        await container.remove({ force: true, v: true });
        removedById = true;
      } catch {
        // Fallback to containerName lookup below
      }
    }

    if (!removedById && containerName) {
      try {
        await this.docker.getContainer(containerName).remove({ force: true, v: true });
      } catch (err) {
        if (!isDockerNotFound(err)) {
          // Ignore already removed / missing container
        }
      }
    }

    if (removeVolume && volumeName) {
      try {
        await this.docker.getVolume(volumeName).remove({ force: true });
      } catch (err) {
        if (!isDockerNotFound(err)) {
          // Best-effort volume removal
        }
      }
    }
  }

  async listAllContainers(): Promise<DockerContainerSummary[]> {
    let raw: Docker.ContainerInfo[];
    try {
      raw = await this.docker.listContainers({ all: true, size: true });
    } catch {
      raw = await this.docker.listContainers({ all: true });
    }
    return raw.map((c) => {
      const withSize = c as Docker.ContainerInfo & { SizeRw?: number };
      return {
        id: c.Id,
        names: c.Names ?? [],
        image: c.Image ?? '',
        imageId: c.ImageID ?? '',
        state: c.State ?? '',
        status: c.Status ?? '',
        labels: c.Labels ?? {},
        mounts: (c.Mounts ?? []).map((m) => ({
          type: m.Type,
          name: m.Name,
          source: m.Source,
          destination: m.Destination,
        })),
        sizeRw: Math.max(0, withSize.SizeRw ?? 0),
      };
    });
  }

  async listAllVolumes(): Promise<DockerVolumeSummary[]> {
    const res = await this.docker.listVolumes();
    const dfUsage = new Map<string, { Size?: number; RefCount?: number }>();
    try {
      const df = (await this.docker.df()) as DockerDfResult;
      for (const vol of df.Volumes ?? []) {
        if (vol.Name && vol.UsageData) {
          dfUsage.set(vol.Name, vol.UsageData);
        }
      }
    } catch {
      // df() is optional/best-effort
    }

    return (res.Volumes ?? []).map((v) => {
      const usage = dfUsage.get(v.Name) ?? v.UsageData ?? undefined;
      return {
        name: v.Name,
        driver: v.Driver ?? 'local',
        mountpoint: v.Mountpoint ?? '',
        labels: v.Labels ?? {},
        sizeBytes: Math.max(0, usage?.Size ?? 0),
        refCount: typeof usage?.RefCount === 'number' ? usage.RefCount : null,
      };
    });
  }

  async getVolumeSize(volumeName: string): Promise<number> {
    try {
      const df = (await this.docker.df()) as DockerDfResult;
      const found = (df.Volumes ?? []).find((v) => v.Name === volumeName);
      return Math.max(0, found?.UsageData?.Size ?? 0);
    } catch {
      return 0;
    }
  }

  async listDockerImages(): Promise<DockerImageSummary[]> {
    const raw = await this.docker.listImages();
    return raw.map((img) => {
      const repoTags = img.RepoTags ?? [];
      const dangling = repoTags.length === 0 || repoTags.every((t) => t === '<none>:<none>');
      return {
        id: img.Id,
        repoTags,
        sizeBytes: Math.max(0, img.Size ?? 0),
        dangling,
        containers: typeof img.Containers === 'number' ? img.Containers : 0,
      };
    });
  }

  async getBuildCacheUsageBytes(): Promise<number> {
    try {
      const df = (await this.docker.df()) as DockerDfResult;
      let total = 0;
      for (const entry of df.BuildCache ?? []) {
        if (!entry.InUse && typeof entry.Size === 'number' && entry.Size > 0) {
          total += entry.Size;
        }
      }
      return total;
    } catch {
      return 0;
    }
  }

  async removeVolume(volumeName: string, force = false): Promise<void> {
    try {
      await this.docker.getVolume(volumeName).remove({ force });
    } catch (err) {
      if (!isDockerNotFound(err)) throw err;
    }
  }

  async removeImage(imageId: string, force = false): Promise<void> {
    try {
      await this.docker.getImage(imageId).remove({ force });
    } catch (err) {
      if (!isDockerNotFound(err)) throw err;
    }
  }

  async pruneDanglingImages(): Promise<{ imagesDeleted: string[]; spaceReclaimed: number }> {
    const res = await this.docker.pruneImages({ filters: { dangling: ['true'] } });
    const imagesDeleted = (res.ImagesDeleted ?? [])
      .map((item) => item.Deleted || item.Untagged)
      .filter((val): val is string => Boolean(val));
    return {
      imagesDeleted,
      spaceReclaimed: Math.max(0, res.SpaceReclaimed ?? 0),
    };
  }

  async pruneBuildCache(): Promise<{ spaceReclaimed: number }> {
    const res = await this.docker.pruneBuilder();
    return {
      spaceReclaimed: Math.max(0, res.SpaceReclaimed ?? 0),
    };
  }

  async getContainerStats(containerId: string | null): Promise<ContainerStatsResult> {
    if (!containerId) {
      return { running: false, cpuPercent: null, memoryUsageMb: null, memoryLimitMb: null };
    }
    try {
      const container = this.docker.getContainer(containerId);
      const info = await container.inspect();
      if (!info.State.Running) {
        return { running: false, cpuPercent: 0, memoryUsageMb: 0, memoryLimitMb: null };
      }

      const stats = (await container.stats({ stream: false })) as unknown as {
        cpu_stats: { cpu_usage: { total_usage: number }; system_cpu_usage?: number; online_cpus?: number };
        precpu_stats: { cpu_usage: { total_usage: number }; system_cpu_usage?: number };
        memory_stats: { usage?: number; limit?: number };
      };

      const cpuDelta = stats.cpu_stats.cpu_usage.total_usage - (stats.precpu_stats.cpu_usage?.total_usage ?? 0);
      const sysDelta = (stats.cpu_stats.system_cpu_usage ?? 0) - (stats.precpu_stats.system_cpu_usage ?? 0);
      const cpus = stats.cpu_stats.online_cpus ?? 1;
      const cpuPercent = sysDelta > 0 ? Number(((cpuDelta / sysDelta) * cpus * 100).toFixed(2)) : 0;

      const memUsage = stats.memory_stats.usage ? Math.round(stats.memory_stats.usage / (1024 * 1024)) : null;
      const memLimit = stats.memory_stats.limit ? Math.round(stats.memory_stats.limit / (1024 * 1024)) : null;

      return { running: true, cpuPercent, memoryUsageMb: memUsage, memoryLimitMb: memLimit };
    } catch {
      return { running: false, cpuPercent: null, memoryUsageMb: null, memoryLimitMb: null };
    }
  }

  async cloneVolume(sourceVolume: string, targetVolume: string): Promise<void> {
    await this.ensureImage('alpine:3.20');
    await this.ensureManagedVolume(targetVolume);
    const helper = await this.docker.createContainer({
      Image: 'alpine:3.20',
      Cmd: ['sh', '-c', 'cp -a /from/. /to/'],
      Labels: {
        'droidforge.managed': 'true',
        'droidforge.role': 'helper',
      },
      HostConfig: {
        Binds: [`${sourceVolume}:/from:ro`, `${targetVolume}:/to`],
        AutoRemove: true,
      },
    });
    await helper.start();
    await helper.wait();
  }

  async backupVolumeToTar(volumeName: string, destTarPath: string): Promise<number> {
    await this.ensureImage('alpine:3.20');
    const dir = path.resolve(path.dirname(destTarPath));
    const file = path.basename(destTarPath);
    fs.mkdirSync(dir, { recursive: true });

    const helper = await this.docker.createContainer({
      Image: 'alpine:3.20',
      Cmd: ['sh', '-c', `tar -czf /backup/${file} -C /data .`],
      Labels: {
        'droidforge.managed': 'true',
        'droidforge.role': 'helper',
      },
      HostConfig: {
        Binds: [`${volumeName}:/data:ro`, `${dir}:/backup`],
        AutoRemove: true,
      },
    });
    await helper.start();
    await helper.wait();

    return fs.existsSync(destTarPath) ? fs.statSync(destTarPath).size : 0;
  }

  async restoreVolumeFromTar(volumeName: string, srcTarPath: string): Promise<void> {
    await this.ensureImage('alpine:3.20');
    const dir = path.resolve(path.dirname(srcTarPath));
    const file = path.basename(srcTarPath);

    const helper = await this.docker.createContainer({
      Image: 'alpine:3.20',
      Cmd: ['sh', '-c', `rm -rf /data/* && tar -xzf /backup/${file} -C /data`],
      Labels: {
        'droidforge.managed': 'true',
        'droidforge.role': 'helper',
      },
      HostConfig: {
        Binds: [`${volumeName}:/data`, `${dir}:/backup:ro`],
        AutoRemove: true,
      },
    });
    await helper.start();
    await helper.wait();
  }
}
