import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { AppEnv } from '../config/env.js';

export interface RecordingJob {
  jobId: string;
  instanceId: string;
  remotePath: string;
  localPath: string;
  startedAt: string;
  active: boolean;
}

export class RecordingService {
  private readonly jobs = new Map<string, RecordingJob>();

  constructor(private readonly env: AppEnv) {}

  createJob(instanceId: string): RecordingJob {
    const jobId = `rec_${crypto.randomBytes(4).toString('hex')}`;
    const remotePath = `/sdcard/${jobId}.mp4`;
    const localPath = path.resolve(this.env.DATA_DIR, 'recordings', `${instanceId}_${jobId}.mp4`);
    fs.mkdirSync(path.dirname(localPath), { recursive: true });

    const job: RecordingJob = {
      jobId,
      instanceId,
      remotePath,
      localPath,
      startedAt: new Date().toISOString(),
      active: true,
    };
    this.jobs.set(jobId, job);
    return job;
  }

  getJob(jobId: string): RecordingJob | undefined {
    return this.jobs.get(jobId);
  }

  findActiveJob(instanceId: string, jobId?: string): RecordingJob | undefined {
    if (jobId) {
      const job = this.jobs.get(jobId);
      return job && job.instanceId === instanceId ? job : undefined;
    }
    for (const job of this.jobs.values()) {
      if (job.instanceId === instanceId && job.active) {
        return job;
      }
    }
    return undefined;
  }

  markStopped(jobId: string): void {
    const job = this.jobs.get(jobId);
    if (job) {
      job.active = false;
    }
  }

  getActiveLocalPaths(): Set<string> {
    const active = new Set<string>();
    for (const job of this.jobs.values()) {
      if (job.active) {
        active.add(path.resolve(job.localPath));
      }
    }
    return active;
  }

  getTrackedInstanceByLocalPath(filePath: string): string | undefined {
    const target = path.resolve(filePath);
    for (const job of this.jobs.values()) {
      if (path.resolve(job.localPath) === target) {
        return job.instanceId;
      }
    }
    return undefined;
  }

  removeForInstance(instanceId: string): { removedFiles: number; reclaimedBytes: number } {
    let removedFiles = 0;
    let reclaimedBytes = 0;
    const deletedPaths = new Set<string>();

    for (const [jobId, job] of this.jobs.entries()) {
      if (job.instanceId !== instanceId) continue;
      job.active = false;
      this.jobs.delete(jobId);

      const resolved = path.resolve(job.localPath);
      if (fs.existsSync(resolved)) {
        try {
          const stat = fs.statSync(resolved);
          if (stat.isFile()) {
            fs.unlinkSync(resolved);
            reclaimedBytes += stat.size;
            removedFiles += 1;
            deletedPaths.add(resolved);
          }
        } catch {
          // Ignore already removed or inaccessible recording file
        }
      }
    }

    const recordingsDir = path.resolve(this.env.DATA_DIR, 'recordings');
    if (fs.existsSync(recordingsDir)) {
      try {
        for (const entry of fs.readdirSync(recordingsDir)) {
          if (!entry.startsWith(`${instanceId}_`)) continue;
          const resolved = path.resolve(recordingsDir, entry);
          if (deletedPaths.has(resolved)) continue;
          try {
            const stat = fs.statSync(resolved);
            if (stat.isFile()) {
              fs.unlinkSync(resolved);
              reclaimedBytes += stat.size;
              removedFiles += 1;
              deletedPaths.add(resolved);
            }
          } catch {
            // Ignore transient unlink errors
          }
        }
      } catch {
        // Ignore directory read failure
      }
    }

    return { removedFiles, reclaimedBytes };
  }
}
