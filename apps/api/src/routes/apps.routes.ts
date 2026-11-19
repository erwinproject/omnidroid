import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance } from 'fastify';
import { AppLaunchInputSchema, AppPermissionsInputSchema } from '@droidforge/shared';
import type { AppContext } from '../context.js';

export function registerAppRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/v1/instances/:id/apps', { schema: { tags: ['Apps'], summary: 'List installed packages on the instance' } }, async (req) => {
    const { id } = req.params as { id: string };
    const { type } = req.query as { type?: 'user' | 'system' | 'all' };
    const inst = ctx.orchestrator.requireInstance(id);

    const flag = type === 'user' ? '-3' : type === 'system' ? '-s' : '';
    const res = await ctx.adb.shell(inst.adbTarget, `pm list packages ${flag}`.trim());
    const packages = res.stdout
      .split(/\r?\n/)
      .map((l) => l.replace(/^package:/, '').trim())
      .filter(Boolean)
      .sort();

    return { count: packages.length, packages };
  });

  app.post('/api/v1/instances/:id/apps/install', { schema: { tags: ['Apps'], summary: 'Install APK via multipart upload or remote URL' } }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const inst = ctx.orchestrator.requireInstance(id);
    const tmpDir = path.resolve(ctx.env.DATA_DIR, 'uploads');
    fs.mkdirSync(tmpDir, { recursive: true });
    const tmpApk = path.join(tmpDir, `${crypto.randomBytes(6).toString('hex')}.apk`);

    try {
      if (req.isMultipart()) {
        const file = await req.file();
        if (!file) return reply.code(400).send({ error: 'Missing APK file in multipart upload' });
        await pipeline(file.file, fs.createWriteStream(tmpApk));
      } else {
        const body = (req.body ?? {}) as { url?: string };
        if (!body.url) return reply.code(400).send({ error: 'Provide multipart APK file or JSON { url }' });
        const resp = await fetch(body.url);
        if (!resp.ok || !resp.body) {
          return reply.code(400).send({ error: `Failed to download APK from URL (${resp.status})` });
        }
        const buf = Buffer.from(await resp.arrayBuffer());
        fs.writeFileSync(tmpApk, buf);
      }

      const result = await ctx.adb.installApk(inst.adbTarget, tmpApk, {
        grantPermissions: true,
        reinstall: true,
      });

      if (result.exitCode !== 0) {
        return reply.code(500).send({ error: result.stderr || result.stdout || 'APK install failed' });
      }
      return { ok: true, output: result.stdout };
    } finally {
      if (fs.existsSync(tmpApk)) fs.unlinkSync(tmpApk);
    }
  });

  app.delete('/api/v1/instances/:id/apps/:packageName', { schema: { tags: ['Apps'], summary: 'Uninstall an application package' } }, async (req) => {
    const { id, packageName } = req.params as { id: string; packageName: string };
    const inst = ctx.orchestrator.requireInstance(id);
    const res = await ctx.adb.shell(inst.adbTarget, `pm uninstall ${packageName}`);
    return { ok: res.exitCode === 0, output: res.stdout || res.stderr };
  });

  app.post('/api/v1/instances/:id/apps/:packageName/launch', { schema: { tags: ['Apps'], summary: 'Launch an application' } }, async (req) => {
    const { id, packageName } = req.params as { id: string; packageName: string };
    const inst = ctx.orchestrator.requireInstance(id);
    const input = AppLaunchInputSchema.parse(req.body ?? {});

    const cmd = input.activity
      ? `am start -n ${packageName}/${input.activity}`
      : `monkey -p ${packageName} -c android.intent.category.LAUNCHER 1`;
    const res = await ctx.adb.shell(inst.adbTarget, cmd);
    return { ok: res.exitCode === 0, output: res.stdout || res.stderr };
  });

  app.post('/api/v1/instances/:id/apps/:packageName/stop', { schema: { tags: ['Apps'], summary: 'Force-stop an application' } }, async (req) => {
    const { id, packageName } = req.params as { id: string; packageName: string };
    const inst = ctx.orchestrator.requireInstance(id);
    await ctx.adb.shell(inst.adbTarget, `am force-stop ${packageName}`);
    return { ok: true };
  });

  app.post('/api/v1/instances/:id/apps/:packageName/clear', { schema: { tags: ['Apps'], summary: 'Clear application data and cache' } }, async (req) => {
    const { id, packageName } = req.params as { id: string; packageName: string };
    const inst = ctx.orchestrator.requireInstance(id);
    const res = await ctx.adb.shell(inst.adbTarget, `pm clear ${packageName}`);
    return { ok: res.exitCode === 0, output: res.stdout };
  });

  app.get('/api/v1/instances/:id/apps/:packageName/info', { schema: { tags: ['Apps'], summary: 'Inspect package version and metadata' } }, async (req) => {
    const { id, packageName } = req.params as { id: string; packageName: string };
    const inst = ctx.orchestrator.requireInstance(id);
    const res = await ctx.adb.shell(inst.adbTarget, `dumpsys package ${packageName} | head -n 40`);
    const versionName = res.stdout.match(/versionName=([^\s]+)/)?.[1] ?? null;
    const versionCode = res.stdout.match(/versionCode=(\d+)/)?.[1] ?? null;
    return { packageName, versionName, versionCode, raw: res.stdout };
  });

  app.post('/api/v1/instances/:id/apps/:packageName/permissions', { schema: { tags: ['Apps'], summary: 'Grant or revoke runtime permissions' } }, async (req) => {
    const { id, packageName } = req.params as { id: string; packageName: string };
    const inst = ctx.orchestrator.requireInstance(id);
    const input = AppPermissionsInputSchema.parse(req.body);

    const results: Array<{ permission: string; ok: boolean }> = [];
    for (const perm of input.permissions) {
      const fullPerm = perm.startsWith('android.permission.') ? perm : `android.permission.${perm}`;
      const res = await ctx.adb.shell(inst.adbTarget, `pm ${input.action} ${packageName} ${fullPerm}`);
      results.push({ permission: fullPerm, ok: res.exitCode === 0 });
    }
    return { ok: results.every((r) => r.ok), results };
  });
}
