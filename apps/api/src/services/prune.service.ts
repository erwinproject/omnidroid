import fs from 'node:fs';
import path from 'node:path';
import {
  PruneOptionsSchema,
  type PruneItem,
  type PruneOptions,
  type PruneOptionsInput,
  type PruneReport,
  type PruneSummaryCounts,
  type SnapshotRecord,
} from '@droidforge/shared';
import type { AppEnv } from '../config/env.js';
import type { StateStore } from '../db/database.js';
import type {
  DockerContainerSummary,
  DockerImageSummary,
  RedroidDockerManager,
} from '../docker/redroid-docker.manager.js';
import type { RecordingService } from './recording.service.js';

export interface PruneInternalOptions {
  excludeVolumes?: string[];
}

interface ActiveStateSnapshot {
  instanceIds: Set<string>;
  containerIds: Set<string>;
  containerNames: Set<string>;
  volumeNames: Set<string>;
  images: Set<string>;
  excludeVolumes: Set<string>;
}

const REDROID_CONTAINER_NAME_RE = /^\/?redroid-[0-9a-f]{8}$/;
const ANONYMOUS_VOLUME_RE = /^[0-9a-f]{64}$/;
const INSTANCE_FILE_PREFIX_RE = /^([0-9a-f]{8})_/;

export class PruneService {
  constructor(
    private readonly env: AppEnv,
    private readonly store: StateStore,
    private readonly docker: RedroidDockerManager,
    private readonly recordings: RecordingService,
  ) {}

  async prune(rawOptions?: PruneOptionsInput, internal?: PruneInternalOptions): Promise<PruneReport> {
    const startedAtMs = Date.now();
    const options = PruneOptionsSchema.parse(rawOptions ?? {});

    const counts: PruneSummaryCounts = {
      orphanedContainers: 0,
      orphanedVolumes: 0,
      anonymousVolumes: 0,
      orphanedSnapshots: 0,
      orphanedRecordings: 0,
      tempFiles: 0,
      danglingImages: 0,
      unusedImages: 0,
      buildCacheBytes: 0,
    };
    const items: PruneItem[] = [];
    const errors: string[] = [];

    const instances = this.store.listInstances();
    const active: ActiveStateSnapshot = {
      instanceIds: new Set(instances.map((i) => i.id)),
      containerIds: new Set(instances.map((i) => i.containerId).filter((x): x is string => Boolean(x))),
      containerNames: new Set(instances.map((i) => i.containerName)),
      volumeNames: new Set(instances.map((i) => i.volumeName)),
      images: new Set(instances.map((i) => i.image)),
      excludeVolumes: new Set(internal?.excludeVolumes ?? []),
    };

    let reclaimedBytes = 0;

    // Phase 1: Docker resources (gracefully degraded if Docker daemon is unavailable)
    reclaimedBytes += await this.pruneDockerResources(options, active, counts, items, errors);

    // Phase 2: Local DATA_DIR subdirectories only (never root DATA_DIR, .android/, or droidforge.db*)
    reclaimedBytes += this.pruneSnapshots(options, active, counts, items, errors);
    reclaimedBytes += this.pruneRecordings(options, active, counts, items, errors);
    reclaimedBytes += this.pruneTempDirectories(options, counts, items, errors);

    if (!options.dryRun) {
      this.store.checkpoint();
    }

    return {
      dryRun: options.dryRun,
      executedAt: new Date().toISOString(),
      durationMs: Math.max(0, Date.now() - startedAtMs),
      reclaimedBytes,
      counts,
      items,
      errors,
    };
  }

  private isOrphanedManagedContainer(container: DockerContainerSummary, active: ActiveStateSnapshot): boolean {
    const isManaged =
      container.labels['droidforge.managed'] === 'true' ||
      container.names.some((n) => REDROID_CONTAINER_NAME_RE.test(n));
    if (!isManaged) return false;

    if (container.labels['droidforge.role'] === 'helper') {
      return container.state.toLowerCase() !== 'running';
    }

    const labelInstanceId = container.labels['droidforge.instance_id'];
    if (labelInstanceId && active.instanceIds.has(labelInstanceId)) return false;
    if (active.containerIds.has(container.id)) return false;
    if (container.names.some((n) => active.containerNames.has(n.replace(/^\/+/, '')))) return false;

    return true;
  }

  private isUnusedManagedImage(
    img: DockerImageSummary,
    active: ActiveStateSnapshot,
    remainingContainers: DockerContainerSummary[],
  ): boolean {
    if (img.dangling || img.repoTags.length === 0) return false;

    const prefixes = [
      `${this.env.REDROID_IMAGE_REPO}:`,
      `${this.env.REDROID_PLAYSTORE_IMAGE_REPO}:`,
    ];
    const isTargetRepo = img.repoTags.some(
      (tag) => prefixes.some((p) => tag.startsWith(p)) || tag === 'alpine:3.20',
    );
    if (!isTargetRepo) return false;

    if (img.repoTags.some((tag) => active.images.has(tag))) return false;
    if (
      remainingContainers.some(
        (c) => c.imageId === img.id || img.repoTags.includes(c.image),
      )
    ) {
      return false;
    }
    return true;
  }

  private async pruneDockerResources(
    options: PruneOptions,
    active: ActiveStateSnapshot,
    counts: PruneSummaryCounts,
    items: PruneItem[],
    errors: string[],
  ): Promise<number> {
    let reclaimed = 0;

    let containers: DockerContainerSummary[];
    try {
      containers = await this.docker.listAllContainers();
    } catch (err) {
      errors.push(`Docker inspection failed: ${err instanceof Error ? err.message : String(err)}`);
      return 0;
    }

    const orphanedContainers = containers.filter((c) => this.isOrphanedManagedContainer(c, active));
    const removedContainerIds = new Set<string>();

    if (options.removeOrphanedContainers) {
      for (const c of orphanedContainers) {
        const displayName = c.names[0]?.replace(/^\/+/, '') || c.id.slice(0, 12);
        const reason =
          c.labels['droidforge.role'] === 'helper'
            ? 'Exited DroidForge helper container'
            : 'Orphaned Redroid container not tracked in database';

        if (options.dryRun) {
          removedContainerIds.add(c.id);
          counts.orphanedContainers += 1;
          reclaimed += c.sizeRw;
          items.push({ id: c.id, name: displayName, category: 'orphaned_container', sizeBytes: c.sizeRw, reason });
          continue;
        }

        try {
          await this.docker.removeContainer(c.id, undefined, false, displayName);
          removedContainerIds.add(c.id);
          counts.orphanedContainers += 1;
          reclaimed += c.sizeRw;
          items.push({ id: c.id, name: displayName, category: 'orphaned_container', sizeBytes: c.sizeRw, reason });
        } catch (err) {
          errors.push(`Failed to remove container ${displayName}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    const remainingContainers = containers.filter((c) => !removedContainerIds.has(c.id));

    if (options.removeOrphanedVolumes) {
      reclaimed += await this.pruneDockerVolumes(options, active, remainingContainers, counts, items, errors);
    }

    if (options.removeDanglingImages || options.removeUnusedRedroidImages) {
      reclaimed += await this.pruneDockerImages(options, active, remainingContainers, counts, items, errors);
    }

    if (options.removeBuildCache) {
      reclaimed += await this.pruneDockerBuildCache(options, counts, items, errors);
    }

    return reclaimed;
  }

  private async pruneDockerVolumes(
    options: PruneOptions,
    active: ActiveStateSnapshot,
    remainingContainers: DockerContainerSummary[],
    counts: PruneSummaryCounts,
    items: PruneItem[],
    errors: string[],
  ): Promise<number> {
    let reclaimed = 0;
    let volumes;
    try {
      volumes = await this.docker.listAllVolumes();
    } catch (err) {
      errors.push(`Failed to list Docker volumes: ${err instanceof Error ? err.message : String(err)}`);
      return 0;
    }

    const mountedVolumeNames = new Set<string>();
    for (const c of remainingContainers) {
      for (const m of c.mounts) {
        if (m.name) mountedVolumeNames.add(m.name);
      }
    }

    for (const v of volumes) {
      if (mountedVolumeNames.has(v.name)) continue;
      if (active.volumeNames.has(v.name) || active.excludeVolumes.has(v.name)) continue;

      const labelInstanceId = v.labels['droidforge.instance_id'];
      if (labelInstanceId && active.instanceIds.has(labelInstanceId)) continue;

      const isManagedVolume = v.name.startsWith('redroid-data-') || v.labels['droidforge.managed'] === 'true';
      const isAnonymousVolume = ANONYMOUS_VOLUME_RE.test(v.name) && Object.keys(v.labels).length === 0;
      if (!isManagedVolume && !isAnonymousVolume) continue;

      const category = isManagedVolume ? 'orphaned_volume' : 'anonymous_volume';
      const reason = isManagedVolume
        ? 'Orphaned Redroid /data volume with no matching instance'
        : 'Unused anonymous Docker volume';

      if (!options.dryRun) {
        try {
          await this.docker.removeVolume(v.name, isManagedVolume);
        } catch (err) {
          errors.push(`Failed to remove volume ${v.name}: ${err instanceof Error ? err.message : String(err)}`);
          continue;
        }
      }

      if (category === 'orphaned_volume') counts.orphanedVolumes += 1;
      else counts.anonymousVolumes += 1;

      reclaimed += v.sizeBytes;
      items.push({ id: v.name, name: v.name, category, sizeBytes: v.sizeBytes, reason });
    }

    return reclaimed;
  }

  private async pruneDockerImages(
    options: PruneOptions,
    active: ActiveStateSnapshot,
    remainingContainers: DockerContainerSummary[],
    counts: PruneSummaryCounts,
    items: PruneItem[],
    errors: string[],
  ): Promise<number> {
    let reclaimed = 0;
    let images: DockerImageSummary[];
    try {
      images = await this.docker.listDockerImages();
    } catch (err) {
      errors.push(`Failed to list Docker images: ${err instanceof Error ? err.message : String(err)}`);
      return 0;
    }

    const usedImageIds = new Set(remainingContainers.map((c) => c.imageId).filter(Boolean));

    if (options.removeDanglingImages) {
      const dangling = images.filter((img) => img.dangling && !usedImageIds.has(img.id));
      if (options.dryRun) {
        for (const img of dangling) {
          counts.danglingImages += 1;
          reclaimed += img.sizeBytes;
          items.push({
            id: img.id,
            name: img.id.slice(0, 19),
            category: 'dangling_image',
            sizeBytes: img.sizeBytes,
            reason: 'Dangling untagged Docker image',
          });
        }
      } else {
        try {
          const res = await this.docker.pruneDanglingImages();
          const danglingById = new Map(dangling.map((d) => [d.id, d]));
          const seenIds = new Set<string>();

          for (const rawId of res.imagesDeleted) {
            if (seenIds.has(rawId)) continue;
            seenIds.add(rawId);
            const matched = danglingById.get(rawId);
            counts.danglingImages += 1;
            items.push({
              id: rawId,
              name: rawId.slice(0, 19),
              category: 'dangling_image',
              sizeBytes: matched?.sizeBytes ?? 0,
              reason: 'Dangling untagged Docker image',
            });
          }

          if (res.imagesDeleted.length === 0 && res.spaceReclaimed > 0) {
            counts.danglingImages += Math.max(1, dangling.length);
            items.push({
              id: 'dangling-images',
              name: 'Dangling images',
              category: 'dangling_image',
              sizeBytes: res.spaceReclaimed,
              reason: 'Dangling untagged Docker image layers',
            });
          }

          reclaimed += res.spaceReclaimed;
        } catch (err) {
          errors.push(`Failed to prune dangling images: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    if (options.removeUnusedRedroidImages) {
      const candidates = images.filter((img) => this.isUnusedManagedImage(img, active, remainingContainers));
      for (const img of candidates) {
        const displayName = img.repoTags[0] ?? img.id;
        if (!options.dryRun) {
          try {
            await this.docker.removeImage(img.id, false);
          } catch (err) {
            errors.push(`Failed to remove image ${displayName}: ${err instanceof Error ? err.message : String(err)}`);
            continue;
          }
        }
        counts.unusedImages += 1;
        reclaimed += img.sizeBytes;
        items.push({
          id: img.id,
          name: displayName,
          category: 'unused_image',
          sizeBytes: img.sizeBytes,
          reason: 'Unused Redroid/helper image not referenced by any instance or container',
        });
      }
    }

    return reclaimed;
  }

  private async pruneDockerBuildCache(
    options: PruneOptions,
    counts: PruneSummaryCounts,
    items: PruneItem[],
    errors: string[],
  ): Promise<number> {
    if (options.dryRun) {
      const cacheBytes = await this.docker.getBuildCacheUsageBytes();
      if (cacheBytes <= 0) return 0;
      counts.buildCacheBytes = cacheBytes;
      items.push({
        id: 'docker-build-cache',
        name: 'Docker Build Cache',
        category: 'build_cache',
        sizeBytes: cacheBytes,
        reason: 'Unused Docker builder cache',
      });
      return cacheBytes;
    }

    try {
      const res = await this.docker.pruneBuildCache();
      if (res.spaceReclaimed <= 0) return 0;
      counts.buildCacheBytes = res.spaceReclaimed;
      items.push({
        id: 'docker-build-cache',
        name: 'Docker Build Cache',
        category: 'build_cache',
        sizeBytes: res.spaceReclaimed,
        reason: 'Unused Docker builder cache',
      });
      return res.spaceReclaimed;
    } catch (err) {
      errors.push(`Failed to prune Docker build cache: ${err instanceof Error ? err.message : String(err)}`);
      return 0;
    }
  }

  private pruneSnapshots(
    options: PruneOptions,
    active: ActiveStateSnapshot,
    counts: PruneSummaryCounts,
    items: PruneItem[],
    errors: string[],
  ): number {
    if (!options.removeOrphanedSnapshots) return 0;

    let reclaimed = 0;
    const snapshotsDir = path.resolve(this.env.DATA_DIR, 'snapshots');
    const allDbSnapshots = this.store.listAllSnapshots();
    const dbByPath = new Map<string, SnapshotRecord>(
      allDbSnapshots.map((snap) => [path.resolve(snap.filePath), snap]),
    );
    const nowMs = Date.now();

    if (fs.existsSync(snapshotsDir)) {
      let entries: string[] = [];
      try {
        entries = fs.readdirSync(snapshotsDir);
      } catch (err) {
        errors.push(`Failed to read snapshots directory: ${err instanceof Error ? err.message : String(err)}`);
      }

      for (const entry of entries) {
        const fullPath = path.resolve(snapshotsDir, entry);
        let stat: fs.Stats;
        try {
          stat = fs.statSync(fullPath);
        } catch {
          continue;
        }
        if (!stat.isFile()) continue;

        const dbRecord = dbByPath.get(fullPath);
        let isOrphan = false;
        let reason = '';

        if (dbRecord) {
          if (!active.instanceIds.has(dbRecord.instanceId)) {
            isOrphan = true;
            reason = 'Snapshot archive belongs to deleted instance';
          }
        } else {
          const prefixId = entry.match(INSTANCE_FILE_PREFIX_RE)?.[1];
          const ageMs = nowMs - stat.mtimeMs;
          if (prefixId && !active.instanceIds.has(prefixId)) {
            isOrphan = true;
            reason = 'Orphaned snapshot archive from deleted instance';
          } else if (ageMs >= options.minTempFileAgeMs) {
            isOrphan = true;
            reason = 'Untracked snapshot file not referenced in database';
          }
        }

        if (!isOrphan) continue;

        if (!options.dryRun) {
          try {
            fs.unlinkSync(fullPath);
            if (dbRecord) {
              this.store.deleteSnapshot(dbRecord.id);
            }
          } catch (err) {
            errors.push(`Failed to delete snapshot ${entry}: ${err instanceof Error ? err.message : String(err)}`);
            continue;
          }
        }

        counts.orphanedSnapshots += 1;
        reclaimed += stat.size;
        items.push({
          id: fullPath,
          name: entry,
          category: 'orphaned_snapshot',
          sizeBytes: stat.size,
          reason,
        });
      }
    }

    if (!options.dryRun) {
      this.store.deleteOrphanedSnapshotRows();
    }

    return reclaimed;
  }

  private pruneRecordings(
    options: PruneOptions,
    active: ActiveStateSnapshot,
    counts: PruneSummaryCounts,
    items: PruneItem[],
    errors: string[],
  ): number {
    if (!options.removeOrphanedRecordings) return 0;

    const recordingsDir = path.resolve(this.env.DATA_DIR, 'recordings');
    if (!fs.existsSync(recordingsDir)) return 0;

    let entries: string[] = [];
    try {
      entries = fs.readdirSync(recordingsDir);
    } catch (err) {
      errors.push(`Failed to read recordings directory: ${err instanceof Error ? err.message : String(err)}`);
      return 0;
    }

    const activePaths = this.recordings.getActiveLocalPaths();
    const nowMs = Date.now();
    let reclaimed = 0;

    for (const entry of entries) {
      const fullPath = path.resolve(recordingsDir, entry);
      if (activePaths.has(fullPath)) continue;

      let stat: fs.Stats;
      try {
        stat = fs.statSync(fullPath);
      } catch {
        continue;
      }
      if (!stat.isFile()) continue;

      const ownerInstanceId =
        this.recordings.getTrackedInstanceByLocalPath(fullPath) ??
        entry.match(INSTANCE_FILE_PREFIX_RE)?.[1];

      if (ownerInstanceId && active.instanceIds.has(ownerInstanceId)) {
        continue;
      }
      if (!ownerInstanceId && nowMs - stat.mtimeMs < options.minTempFileAgeMs) {
        continue;
      }

      if (!options.dryRun) {
        try {
          fs.unlinkSync(fullPath);
        } catch (err) {
          errors.push(`Failed to delete recording ${entry}: ${err instanceof Error ? err.message : String(err)}`);
          continue;
        }
      }

      counts.orphanedRecordings += 1;
      reclaimed += stat.size;
      items.push({
        id: fullPath,
        name: entry,
        category: 'orphaned_recording',
        sizeBytes: stat.size,
        reason: 'Screen recording belonging to deleted or untracked instance',
      });
    }

    return reclaimed;
  }

  private pruneTempDirectories(
    options: PruneOptions,
    counts: PruneSummaryCounts,
    items: PruneItem[],
    errors: string[],
  ): number {
    if (!options.removeTempFiles) return 0;

    let reclaimed = 0;
    const nowMs = Date.now();

    for (const subDir of ['uploads', 'downloads'] as const) {
      const dirPath = path.resolve(this.env.DATA_DIR, subDir);
      if (!fs.existsSync(dirPath)) continue;

      let entries: string[] = [];
      try {
        entries = fs.readdirSync(dirPath);
      } catch (err) {
        errors.push(`Failed to read ${subDir} directory: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }

      for (const entry of entries) {
        const fullPath = path.resolve(dirPath, entry);
        let stat: fs.Stats;
        try {
          stat = fs.statSync(fullPath);
        } catch {
          continue;
        }
        if (!stat.isFile()) continue;

        const ageMs = nowMs - stat.mtimeMs;
        if (ageMs < options.minTempFileAgeMs) continue;

        if (!options.dryRun) {
          try {
            fs.unlinkSync(fullPath);
          } catch (err) {
            errors.push(`Failed to delete temp file ${subDir}/${entry}: ${err instanceof Error ? err.message : String(err)}`);
            continue;
          }
        }

        counts.tempFiles += 1;
        reclaimed += stat.size;
        items.push({
          id: fullPath,
          name: `${subDir}/${entry}`,
          category: 'temp_file',
          sizeBytes: stat.size,
          reason: `Stale temporary file in ${subDir}/`,
        });
      }
    }

    return reclaimed;
  }
}
