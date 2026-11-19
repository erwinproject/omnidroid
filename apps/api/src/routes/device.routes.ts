import type { FastifyInstance } from 'fastify';
import {
  BatteryInputSchema,
  ClipboardInputSchema,
  LocationInputSchema,
  NetworkInputSchema,
  RotationInputSchema,
  ShellCommandInputSchema,
} from '@droidforge/shared';
import type { AppContext } from '../context.js';
import { parseGetProp } from '../services/stealth.service.js';

export function registerDeviceRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/v1/instances/:id/device/info', { schema: { tags: ['Device'], summary: 'Get system properties, foreground activity, and battery info' } }, async (req) => {
    const { id } = req.params as { id: string };
    const inst = ctx.orchestrator.requireInstance(id);
    const [propRes, focusRes, batRes] = await Promise.all([
      ctx.adb.shell(inst.adbTarget, 'getprop'),
      ctx.adb.shell(inst.adbTarget, 'dumpsys window | grep -E "mCurrentFocus|mFocusedApp" | head -n 2'),
      ctx.adb.shell(inst.adbTarget, 'dumpsys battery'),
    ]);

    const props = parseGetProp(propRes.stdout);
    const batteryLevel = Number(batRes.stdout.match(/level:\s*(\d+)/i)?.[1] ?? -1);

    return {
      instanceId: inst.id,
      brand: props['ro.product.brand'] ?? inst.profile.brand,
      manufacturer: props['ro.product.manufacturer'] ?? inst.profile.manufacturer,
      model: props['ro.product.model'] ?? inst.profile.model,
      androidVersion: props['ro.build.version.release'] ?? inst.androidVersion,
      sdkLevel: props['ro.build.version.sdk'] ?? '',
      buildType: props['ro.build.type'] ?? inst.profile.buildType,
      buildTags: props['ro.build.tags'] ?? inst.profile.buildTags,
      fingerprint: props['ro.build.fingerprint'] ?? inst.profile.buildFingerprint,
      abiList: props['ro.product.cpu.abilist'] ?? '',
      foreground: focusRes.stdout,
      batteryLevel,
    };
  });

  app.post('/api/v1/instances/:id/device/shell', { schema: { tags: ['Device'], summary: 'Execute an ADB shell command with timeout' } }, async (req) => {
    const { id } = req.params as { id: string };
    const inst = ctx.orchestrator.requireInstance(id);
    const input = ShellCommandInputSchema.parse(req.body);
    return ctx.adb.shell(inst.adbTarget, input.command, input.timeoutMs);
  });

  app.get('/api/v1/instances/:id/device/clipboard', { schema: { tags: ['Device'], summary: 'Read Android clipboard content' } }, async (req) => {
    const { id } = req.params as { id: string };
    const inst = ctx.orchestrator.requireInstance(id);
    const res = await ctx.adb.shell(inst.adbTarget, 'cmd clipboard get-text 2>/dev/null || service call clipboard 2 i32 1');
    return { text: res.stdout };
  });

  app.post('/api/v1/instances/:id/device/clipboard', { schema: { tags: ['Device'], summary: 'Write text to Android clipboard' } }, async (req) => {
    const { id } = req.params as { id: string };
    const inst = ctx.orchestrator.requireInstance(id);
    const input = ClipboardInputSchema.parse(req.body);
    const escaped = input.text.replace(/"/g, '\\"');
    await ctx.adb.shell(inst.adbTarget, `cmd clipboard set-text "${escaped}" 2>/dev/null || am broadcast -a clipper.set -e text "${escaped}"`);
    return { ok: true };
  });

  app.post('/api/v1/instances/:id/device/location', { schema: { tags: ['Device'], summary: 'Set mock GPS coordinates' } }, async (req) => {
    const { id } = req.params as { id: string };
    const inst = ctx.orchestrator.requireInstance(id);
    const input = LocationInputSchema.parse(req.body);
    await ctx.adb.shell(
      inst.adbTarget,
      `cmd location providers set-test-provider-enabled gps true 2>/dev/null; cmd location providers set-test-provider-location gps --location ${input.latitude},${input.longitude} 2>/dev/null || setprop persist.redroid.gps "${input.latitude},${input.longitude},${input.altitude}"`,
    );
    return { ok: true, ...input };
  });

  app.post('/api/v1/instances/:id/device/battery', { schema: { tags: ['Device'], summary: 'Simulate battery level and charging status' } }, async (req) => {
    const { id } = req.params as { id: string };
    const inst = ctx.orchestrator.requireInstance(id);
    const input = BatteryInputSchema.parse(req.body);

    if (input.reset) {
      await ctx.adb.shell(inst.adbTarget, 'dumpsys battery reset');
      return { ok: true, reset: true };
    }
    if (input.unplugged) {
      await ctx.adb.shell(inst.adbTarget, 'dumpsys battery set ac 0 && dumpsys battery set usb 0 && dumpsys battery set wireless 0');
    }
    if (input.level !== undefined) {
      await ctx.adb.shell(inst.adbTarget, `dumpsys battery set level ${input.level}`);
    }
    if (input.status) {
      const map = { charging: 2, discharging: 3, not_charging: 4, full: 5 };
      await ctx.adb.shell(inst.adbTarget, `dumpsys battery set status ${map[input.status]}`);
    }
    return { ok: true };
  });

  app.post('/api/v1/instances/:id/device/network', { schema: { tags: ['Device'], summary: 'Control Wi-Fi, airplane mode, and global HTTP proxy' } }, async (req) => {
    const { id } = req.params as { id: string };
    const inst = ctx.orchestrator.requireInstance(id);
    const input = NetworkInputSchema.parse(req.body);

    if (input.wifi !== undefined) {
      await ctx.adb.shell(inst.adbTarget, `svc wifi ${input.wifi ? 'enable' : 'disable'}`);
    }
    if (input.airplaneMode !== undefined) {
      const val = input.airplaneMode ? 1 : 0;
      await ctx.adb.shell(inst.adbTarget, `settings put global airplane_mode_on ${val} && am broadcast -a android.intent.action.AIRPLANE_MODE --ez state ${input.airplaneMode}`);
    }
    if (input.httpProxy !== undefined) {
      const val = input.httpProxy === null || input.httpProxy === '' ? ':0' : input.httpProxy;
      await ctx.adb.shell(inst.adbTarget, `settings put global http_proxy ${val}`);
    }
    return { ok: true };
  });

  app.post('/api/v1/instances/:id/device/rotation', { schema: { tags: ['Device'], summary: 'Set screen orientation (portrait, landscape, auto)' } }, async (req) => {
    const { id } = req.params as { id: string };
    const inst = ctx.orchestrator.requireInstance(id);
    const input = RotationInputSchema.parse(req.body);

    if (input.mode === 'auto') {
      await ctx.adb.shell(inst.adbTarget, 'settings put system accelerometer_rotation 1');
    } else {
      const rotMap = { portrait: 0, landscape: 1, reverse_portrait: 2, reverse_landscape: 3 };
      await ctx.adb.shell(
        inst.adbTarget,
        `settings put system accelerometer_rotation 0 && settings put system user_rotation ${rotMap[input.mode]}`,
      );
    }
    return { ok: true, mode: input.mode };
  });

  app.get('/api/v1/instances/:id/device/stealth-check', { schema: { tags: ['Device'], summary: 'Run anti-emulator detection audit on the instance' } }, async (req) => {
    const { id } = req.params as { id: string };
    const inst = ctx.orchestrator.requireInstance(id);
    return ctx.stealth.runStealthCheck(inst);
  });
}
