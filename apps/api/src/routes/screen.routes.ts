import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import sharp from 'sharp';
import { ScreenshotQuerySchema } from '@droidforge/shared';
import type { AppContext } from '../context.js';

interface RecordingJob {
  jobId: string;
  instanceId: string;
  remotePath: string;
  localPath: string;
  startedAt: string;
  active: boolean;
}

const activeRecordings = new Map<string, RecordingJob>();

export function registerScreenRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/v1/instances/:id/screen/info', { schema: { tags: ['Screen'], summary: 'Get screen resolution, density, rotation, and wake state' } }, async (req) => {
    const { id } = req.params as { id: string };
    const inst = ctx.orchestrator.requireInstance(id);
    const [sizeRes, densityRes, powerRes, rotRes] = await Promise.all([
      ctx.adb.shell(inst.adbTarget, 'wm size'),
      ctx.adb.shell(inst.adbTarget, 'wm density'),
      ctx.adb.shell(inst.adbTarget, 'dumpsys power | grep mWakefulness'),
      ctx.adb.shell(inst.adbTarget, 'dumpsys input | grep SurfaceOrientation'),
    ]);

    const sizeMatch = sizeRes.stdout.match(/(\d+)x(\d+)/);
    const densityMatch = densityRes.stdout.match(/(\d+)/);
    const rotMatch = rotRes.stdout.match(/SurfaceOrientation:\s*(\d+)/);

    return {
      width: sizeMatch ? Number(sizeMatch[1]) : inst.width,
      height: sizeMatch ? Number(sizeMatch[2]) : inst.height,
      density: densityMatch ? Number(densityMatch[1]) : inst.dpi,
      rotation: rotMatch ? Number(rotMatch[1]) : 0,
      isAwake: /Awake/i.test(powerRes.stdout),
    };
  });

  app.get('/api/v1/instances/:id/screen/screenshot', { schema: { tags: ['Screen'], summary: 'Capture screenshot (PNG/JPEG/WebP, binary or base64)' } }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const inst = ctx.orchestrator.requireInstance(id);
    const query = ScreenshotQuerySchema.parse(req.query);

    const png = await ctx.adb.screencapPng(inst.adbTarget);
    let pipeline = sharp(png);
    if (query.scale < 1) {
      const meta = await pipeline.metadata();
      if (meta.width) {
        pipeline = pipeline.resize({ width: Math.max(64, Math.round(meta.width * query.scale)) });
      }
    }

    let output: Buffer;
    let mimeType: string;
    if (query.format === 'jpeg') {
      output = await pipeline.jpeg({ quality: query.quality }).toBuffer();
      mimeType = 'image/jpeg';
    } else if (query.format === 'webp') {
      output = await pipeline.webp({ quality: query.quality }).toBuffer();
      mimeType = 'image/webp';
    } else {
      output = await pipeline.png().toBuffer();
      mimeType = 'image/png';
    }

    if (query.encoding === 'base64') {
      return { mimeType, base64: output.toString('base64') };
    }
    return reply.type(mimeType).send(output);
  });

  app.post('/api/v1/instances/:id/screen/record/start', { schema: { tags: ['Screen'], summary: 'Start MP4 screen recording on the instance' } }, async (req) => {
    const { id } = req.params as { id: string };
    const inst = ctx.orchestrator.requireInstance(id);
    const jobId = `rec_${crypto.randomBytes(4).toString('hex')}`;
    const remotePath = `/sdcard/${jobId}.mp4`;
    const localPath = path.resolve(ctx.env.DATA_DIR, 'recordings', `${jobId}.mp4`);

    fs.mkdirSync(path.dirname(localPath), { recursive: true });
    await ctx.adb.shell(inst.adbTarget, `nohup screenrecord --time-limit 180 ${remotePath} >/dev/null 2>&1 &`);

    const job: RecordingJob = {
      jobId,
      instanceId: inst.id,
      remotePath,
      localPath,
      startedAt: new Date().toISOString(),
      active: true,
    };
    activeRecordings.set(jobId, job);
    return { jobId, startedAt: job.startedAt };
  });

  app.post('/api/v1/instances/:id/screen/record/stop', { schema: { tags: ['Screen'], summary: 'Stop active screen recording and pull MP4' } }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const inst = ctx.orchestrator.requireInstance(id);
    const body = (req.body ?? {}) as { jobId?: string };

    const job = body.jobId
      ? activeRecordings.get(body.jobId)
      : [...activeRecordings.values()].find((j) => j.instanceId === inst.id && j.active);

    if (!job) return reply.code(404).send({ error: 'No active recording job found' });

    await ctx.adb.shell(inst.adbTarget, 'pkill -SIGINT screenrecord || true');
    await new Promise((r) => setTimeout(r, 800));
    await ctx.adb.pullFile(inst.adbTarget, job.remotePath, job.localPath);
    await ctx.adb.shell(inst.adbTarget, `rm -f ${job.remotePath}`);
    job.active = false;

    return {
      jobId: job.jobId,
      downloadUrl: `/api/v1/instances/${inst.id}/screen/record/${job.jobId}`,
    };
  });

  app.get('/api/v1/instances/:id/screen/record/:jobId', { schema: { tags: ['Screen'], summary: 'Download recorded MP4 video' } }, async (req, reply) => {
    const { jobId } = req.params as { id: string; jobId: string };
    const job = activeRecordings.get(jobId);
    if (!job || !fs.existsSync(job.localPath)) {
      return reply.code(404).send({ error: 'Recording file not found' });
    }
    return reply.type('video/mp4').send(fs.createReadStream(job.localPath));
  });
}
