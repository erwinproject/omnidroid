import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';

/** Single-quote a value for the Android shell. */
export function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Normalizes a device path and rejects anything that is not absolute. */
export function normalizeDevicePath(input: string | undefined, fallback = '/sdcard'): string {
  const raw = (input ?? '').trim() || fallback;
  if (raw.includes('\0')) throw httpError(400, 'Invalid path');
  if (!raw.startsWith('/')) throw httpError(400, 'Path must be absolute');
  const normalized = path.posix.normalize(raw);
  return normalized.length > 1 && normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
}

function httpError(statusCode: number, message: string): Error & { statusCode: number } {
  const err = new Error(message) as Error & { statusCode: number };
  err.statusCode = statusCode;
  return err;
}

/** Paths that must never be deleted: the root and top-level system directories. */
function isProtectedPath(p: string): boolean {
  const depth = p.split('/').filter(Boolean).length;
  if (depth < 2) return true;
  return ['/sdcard/Android', '/storage/emulated', '/storage/emulated/0', '/data/data', '/data/app'].includes(p);
}

export interface DeviceFileEntry {
  name: string;
  isDir: boolean;
  size: number;
  permissions: string;
  modified: string;
}

export function parseLsOutput(stdout: string): DeviceFileEntry[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('total '))
    .map((line) => {
      const parts = line.split(/\s+/);
      const permissions = parts[0] ?? '';
      let name = parts.slice(7).join(' ');
      const arrow = name.indexOf(' -> ');
      const isLink = permissions.startsWith('l');
      if (isLink && arrow >= 0) name = name.slice(0, arrow);
      return {
        name,
        isDir: permissions.startsWith('d') || isLink,
        size: Number(parts[4] ?? 0) || 0,
        permissions,
        modified: `${parts[5] ?? ''} ${parts[6] ?? ''}`.trim(),
      };
    })
    .filter((e) => e.name && e.name !== '.' && e.name !== '..')
    .sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name));
}

function safeFileName(name: string): string {
  const base = path.posix.basename(name.replace(/\\/g, '/')).replace(/[\0\r\n]/g, '');
  return base || `upload_${Date.now()}`;
}

export function registerFileRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/v1/instances/:id/files/list', { schema: { tags: ['Files'], summary: 'List directory contents on the Android instance' } }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const query = req.query as { path?: string };
    const remotePath = normalizeDevicePath(query.path);
    const inst = ctx.orchestrator.requireInstance(id);

    const res = await ctx.adb.shell(inst.adbTarget, `ls -la ${shQuote(remotePath + '/')}`);
    if (res.exitCode !== 0 && !res.stdout) {
      return reply.code(404).send({ error: res.stderr || `Cannot list ${remotePath}` });
    }
    return { path: remotePath, entries: parseLsOutput(res.stdout) };
  });

  app.post('/api/v1/instances/:id/files/mkdir', { schema: { tags: ['Files'], summary: 'Create a directory on the Android instance' } }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { path?: string };
    if (!body.path) return reply.code(400).send({ error: 'Body field "path" is required' });
    const target = normalizeDevicePath(body.path);
    const inst = ctx.orchestrator.requireInstance(id);
    const res = await ctx.adb.shell(inst.adbTarget, `mkdir -p ${shQuote(target)}`);
    if (res.exitCode !== 0) return reply.code(500).send({ error: res.stderr || 'Failed to create directory' });
    return { ok: true, path: target };
  });

  app.post('/api/v1/instances/:id/files/push', { schema: { tags: ['Files'], summary: 'Upload one or more files from host to an Android device directory (or exact file path)' } }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const query = req.query as { remotePath?: string };
    const normalized = normalizeDevicePath(query.remotePath, '/sdcard/Download');
    const isDirTarget = !query.remotePath || query.remotePath.endsWith('/');
    const dirPrefix = normalized === '/' ? '/' : `${normalized}/`;
    const inst = ctx.orchestrator.requireInstance(id);

    const tmpDir = path.resolve(ctx.env.DATA_DIR, 'uploads');
    fs.mkdirSync(tmpDir, { recursive: true });

    const pushed: Array<{ name: string; remotePath: string; ok: boolean; error?: string }> = [];
    const tmpFiles: string[] = [];
    try {
      for await (const part of req.files()) {
        const name = safeFileName(part.filename);
        const tmpFile = path.join(tmpDir, `${crypto.randomBytes(6).toString('hex')}_${name}`);
        tmpFiles.push(tmpFile);
        await pipeline(part.file, fs.createWriteStream(tmpFile));

        const targetPath = isDirTarget ? `${dirPrefix}${name}` : normalized;
        if (isDirTarget && normalized !== '/') {
          await ctx.adb.shell(inst.adbTarget, `mkdir -p ${shQuote(normalized)}`).catch(() => undefined);
        }
        const res = await ctx.adb.pushFile(inst.adbTarget, tmpFile, targetPath);
        if (res.exitCode === 0) {
          pushed.push({ name, remotePath: targetPath, ok: true });
          // Make media visible to the Gallery / Files apps
          void ctx.adb
            .shell(inst.adbTarget, `am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE -d ${shQuote('file://' + targetPath)}`)
            .catch(() => undefined);
        } else {
          pushed.push({ name, remotePath: targetPath, ok: false, error: res.stderr || 'Failed to push file' });
        }
      }

      if (pushed.length === 0) return reply.code(400).send({ error: 'Missing file in multipart form-data' });
      const failed = pushed.filter((p) => !p.ok);
      if (failed.length === pushed.length) {
        return reply.code(500).send({ error: failed[0]?.error ?? 'Failed to push file', files: pushed });
      }
      return { ok: failed.length === 0, remotePath: pushed[0]?.remotePath, files: pushed };
    } finally {
      for (const f of tmpFiles) {
        if (fs.existsSync(f)) fs.unlinkSync(f);
      }
    }
  });

  app.get('/api/v1/instances/:id/files/pull', { schema: { tags: ['Files'], summary: 'Download a file from the Android instance' } }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const query = req.query as { path?: string };
    if (!query.path) return reply.code(400).send({ error: 'Query param "path" is required' });
    const remotePath = normalizeDevicePath(query.path);

    const inst = ctx.orchestrator.requireInstance(id);
    const tmpDir = path.resolve(ctx.env.DATA_DIR, 'downloads');
    fs.mkdirSync(tmpDir, { recursive: true });
    const filename = path.posix.basename(remotePath);
    const tmpFile = path.join(tmpDir, `${crypto.randomBytes(6).toString('hex')}_${filename}`);

    const res = await ctx.adb.pullFile(inst.adbTarget, remotePath, tmpFile);
    if (res.exitCode !== 0 || !fs.existsSync(tmpFile)) {
      if (fs.existsSync(tmpFile)) fs.rmSync(tmpFile, { recursive: true, force: true });
      return reply.code(404).send({ error: res.stderr || 'File not found on device' });
    }
    if (fs.statSync(tmpFile).isDirectory()) {
      fs.rmSync(tmpFile, { recursive: true, force: true });
      return reply.code(400).send({ error: 'Path is a directory; download a single file' });
    }

    const stream = fs.createReadStream(tmpFile);
    const cleanup = () => fs.rm(tmpFile, { force: true }, () => undefined);
    stream.on('close', cleanup);
    stream.on('error', cleanup);
    return reply
      .header('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"; filename*=UTF-8''${encodeURIComponent(filename)}`)
      .header('Content-Length', fs.statSync(tmpFile).size)
      .type('application/octet-stream')
      .send(stream);
  });

  app.delete('/api/v1/instances/:id/files', { schema: { tags: ['Files'], summary: 'Delete a file or directory on the Android instance' } }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const query = req.query as { path?: string };
    if (!query.path) return reply.code(400).send({ error: 'Query param "path" is required' });
    const remotePath = normalizeDevicePath(query.path);
    if (isProtectedPath(remotePath)) {
      return reply.code(400).send({ error: 'Refusing to delete a protected or top-level path' });
    }
    const inst = ctx.orchestrator.requireInstance(id);
    await ctx.adb.shell(inst.adbTarget, `rm -rf ${shQuote(remotePath)}`);
    return { deleted: true, path: remotePath };
  });
}
