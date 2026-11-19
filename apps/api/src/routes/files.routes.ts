import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';

export function registerFileRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/v1/instances/:id/files/list', { schema: { tags: ['Files'], summary: 'List directory contents on the Android instance' } }, async (req) => {
    const { id } = req.params as { id: string };
    const { path: remotePath = '/sdcard' } = req.query as { path?: string };
    const inst = ctx.orchestrator.requireInstance(id);

    const res = await ctx.adb.shell(inst.adbTarget, `ls -la "${remotePath}"`);
    const entries = res.stdout
      .split(/\r?\n/)
      .slice(1)
      .filter(Boolean)
      .map((line) => {
        const parts = line.trim().split(/\s+/);
        return {
          permissions: parts[0] ?? '',
          isDir: (parts[0] ?? '').startsWith('d'),
          size: Number(parts[4] ?? 0),
          name: parts.slice(7).join(' '),
        };
      })
      .filter((e) => e.name && e.name !== '.' && e.name !== '..');

    return { path: remotePath, entries };
  });

  app.post('/api/v1/instances/:id/files/push', { schema: { tags: ['Files'], summary: 'Upload a file from host to Android device path' } }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { remotePath = '/sdcard/Download/' } = req.query as { remotePath?: string };
    const inst = ctx.orchestrator.requireInstance(id);

    const file = await req.file();
    if (!file) return reply.code(400).send({ error: 'Missing file in multipart form-data' });

    const tmpDir = path.resolve(ctx.env.DATA_DIR, 'uploads');
    fs.mkdirSync(tmpDir, { recursive: true });
    const tmpFile = path.join(tmpDir, `${crypto.randomBytes(6).toString('hex')}_${file.filename}`);

    try {
      await pipeline(file.file, fs.createWriteStream(tmpFile));
      const targetPath = remotePath.endsWith('/') ? `${remotePath}${file.filename}` : remotePath;
      const res = await ctx.adb.pushFile(inst.adbTarget, tmpFile, targetPath);
      if (res.exitCode !== 0) {
        return reply.code(500).send({ error: res.stderr || 'Failed to push file' });
      }
      return { ok: true, remotePath: targetPath };
    } finally {
      if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
    }
  });

  app.get('/api/v1/instances/:id/files/pull', { schema: { tags: ['Files'], summary: 'Download a file from the Android instance' } }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { path: remotePath } = req.query as { path?: string };
    if (!remotePath) return reply.code(400).send({ error: 'Query param "path" is required' });

    const inst = ctx.orchestrator.requireInstance(id);
    const tmpDir = path.resolve(ctx.env.DATA_DIR, 'downloads');
    fs.mkdirSync(tmpDir, { recursive: true });
    const filename = path.basename(remotePath);
    const tmpFile = path.join(tmpDir, `${crypto.randomBytes(6).toString('hex')}_${filename}`);

    try {
      const res = await ctx.adb.pullFile(inst.adbTarget, remotePath, tmpFile);
      if (res.exitCode !== 0 || !fs.existsSync(tmpFile)) {
        return reply.code(404).send({ error: res.stderr || 'File not found on device' });
      }

      const buf = fs.readFileSync(tmpFile);
      return reply
        .header('Content-Disposition', `attachment; filename="${filename}"`)
        .type('application/octet-stream')
        .send(buf);
    } finally {
      if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
    }
  });

  app.delete('/api/v1/instances/:id/files', { schema: { tags: ['Files'], summary: 'Delete a file or directory on the Android instance' } }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { path: remotePath } = req.query as { path?: string };
    if (!remotePath || remotePath === '/' || remotePath === '/sdcard') {
      return reply.code(400).send({ error: 'Refusing to delete empty or root path' });
    }
    const inst = ctx.orchestrator.requireInstance(id);
    await ctx.adb.shell(inst.adbTarget, `rm -rf "${remotePath}"`);
    return { deleted: true, path: remotePath };
  });
}
