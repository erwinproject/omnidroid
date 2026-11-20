import type { InstanceRecord, StealthCheckItem, StealthCheckReport } from '@droidforge/shared';
import type { AdbExecutor } from './adb.service.js';

const EMULATOR_MARKERS = ['redroid', 'goldfish', 'ranchu', 'vbox', 'genymotion', 'nox', 'bluestacks', 'generic_x86'];

export class StealthService {
  constructor(private readonly adb: AdbExecutor) {}

  async applyPostBootHardening(instance: InstanceRecord): Promise<void> {
    const target = instance.adbTarget;
    const { profile, proxy } = instance;

    if (profile.androidId) {
      await this.adb.shell(target, `settings put secure android_id ${profile.androidId}`);
    }

    // Realistic battery: unplugged, discharging, random 45-88%
    const level = Math.floor(45 + Math.random() * 44);
    await this.adb.shell(target, `dumpsys battery set ac 0`);
    await this.adb.shell(target, `dumpsys battery set usb 0`);
    await this.adb.shell(target, `dumpsys battery set wireless 0`);
    await this.adb.shell(target, `dumpsys battery set status 3`);
    await this.adb.shell(target, `dumpsys battery set level ${level}`);

    // Timezone & locale
    if (profile.timezone) {
      await this.adb.shell(target, `setprop persist.sys.timezone ${profile.timezone}`);
    }
  }

  async runStealthCheck(instance: InstanceRecord): Promise<StealthCheckReport> {
    const target = instance.adbTarget;
    const checks: StealthCheckItem[] = [];

    const propRes = await this.adb.shell(target, 'getprop');
    const props = parseGetProp(propRes.stdout);

    const model = props['ro.product.model'] ?? '';
    const brand = props['ro.product.brand'] ?? '';
    const buildType = props['ro.build.type'] ?? '';
    const buildTags = props['ro.build.tags'] ?? '';
    const fingerprint = props['ro.build.fingerprint'] ?? '';
    const debuggable = props['ro.debuggable'] ?? '';
    const qemu = props['ro.kernel.qemu'] ?? '0';
    const hardware = props['ro.hardware'] ?? '';
    const abilist = props['ro.product.cpu.abilist'] ?? '';

    const hasMarker = (val: string) =>
      EMULATOR_MARKERS.some((m) => val.toLowerCase().includes(m));

    // 1. Model & Brand check
    checks.push({
      key: 'ro.product.model',
      category: 'build',
      status: model && !hasMarker(model) ? 'pass' : 'fail',
      actual: `${brand} / ${model}`,
      detail: model && !hasMarker(model)
        ? 'Custom realistic device model & brand active.'
        : 'Model or brand contains emulator marker or is empty.',
    });

    // 2. Build type
    checks.push({
      key: 'ro.build.type',
      category: 'build',
      status: buildType === 'user' ? 'pass' : 'fail',
      actual: buildType || '(empty)',
      detail: buildType === 'user' ? 'Production user build type.' : 'Expected "user", non-user builds are flagged.',
    });

    // 3. Build tags
    checks.push({
      key: 'ro.build.tags',
      category: 'build',
      status: buildTags === 'release-keys' ? 'pass' : 'fail',
      actual: buildTags || '(empty)',
      detail: buildTags === 'release-keys' ? 'Signed release-keys tag.' : 'test-keys/dev-keys are flagged by apps.',
    });

    // 4. Fingerprint
    checks.push({
      key: 'ro.build.fingerprint',
      category: 'build',
      status: fingerprint && !hasMarker(fingerprint) && !fingerprint.includes('test-keys') ? 'pass' : 'fail',
      actual: fingerprint || '(empty)',
      detail: 'Build fingerprint should match a real retail device.',
    });

    // 5. Emulator markers (qemu / hardware)
    checks.push({
      key: 'ro.kernel.qemu',
      category: 'emulator_markers',
      status: qemu !== '1' && !hasMarker(hardware) ? 'pass' : 'fail',
      actual: `qemu=${qemu}, hardware=${hardware}`,
      detail: 'QEMU & virtual hardware markers should not be exposed.',
    });

    // 6. Debuggable
    checks.push({
      key: 'ro.debuggable',
      category: 'emulator_markers',
      status: debuggable === '0' ? 'pass' : 'warn',
      actual: debuggable || '(empty)',
      detail: debuggable === '0' ? 'ro.debuggable=0 (non-debuggable).' : 'ro.debuggable=1 may trigger root/emulator checks.',
    });

    // 7. Android ID
    const aidRes = await this.adb.shell(target, 'settings get secure android_id');
    const androidId = aidRes.stdout.trim();
    checks.push({
      key: 'secure.android_id',
      category: 'identity',
      status: /^[0-9a-fA-F]{16}$/.test(androidId) ? 'pass' : 'warn',
      actual: androidId || '(empty)',
      detail: '16-char hexadecimal unique ANDROID_ID.',
    });

    // 8. Battery realism
    const batRes = await this.adb.shell(target, 'dumpsys battery');
    const usbPowered = /USB powered:\s*true/i.test(batRes.stdout);
    const levelMatch = batRes.stdout.match(/level:\s*(\d+)/i);
    const level = levelMatch ? Number(levelMatch[1]) : 100;
    checks.push({
      key: 'hardware.battery',
      category: 'hardware',
      status: !usbPowered && level < 100 ? 'pass' : 'warn',
      actual: `level=${level}%, usbPowered=${usbPowered}`,
      detail: !usbPowered && level < 100
        ? 'Realistic unplugged battery level.'
        : 'Stuck 100% USB charging is a common emulator heuristic.',
    });

    // 9. ABI / ARM translation
    const hasArm = abilist.includes('arm64-v8a') || abilist.includes('armeabi-v7a');
    checks.push({
      key: 'ro.product.cpu.abilist',
      category: 'abi',
      status: hasArm ? 'pass' : 'warn',
      actual: abilist || '(empty)',
      detail: hasArm
        ? 'ARM ABI supported (native or libndk/houdini translation).'
        : 'x86_64-only ABI detected; use a Redroid image with libndk_translation for ARM64 apps.',
    });

    // 10. Root su binary exposure
    const suRes = await this.adb.shell(
      target,
      'test -x /system/bin/su -o -x /system/xbin/su && echo EXPOSED || echo CLEAN',
    );
    const suExposed = suRes.stdout.includes('EXPOSED');
    checks.push({
      key: 'root.su_binary',
      category: 'emulator_markers',
      status: suExposed ? 'warn' : 'pass',
      actual: suExposed ? 'su present in /system/bin or /system/xbin' : 'clean (no su binary)',
      detail: suExposed
        ? 'Root su binary is exposed to apps; disable Root in the Root panel to hide it.'
        : 'No su binary present in /system/bin or /system/xbin.',
    });

    const passed = checks.filter((c) => c.status === 'pass').length;
    const warnings = checks.filter((c) => c.status === 'warn').length;
    const failed = checks.filter((c) => c.status === 'fail').length;
    const score = Math.round(((passed + warnings * 0.5) / checks.length) * 100);

    return {
      instanceId: instance.id,
      checkedAt: new Date().toISOString(),
      score,
      passed,
      warnings,
      failed,
      checks,
    };
  }
}

export function parseGetProp(output: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^\[([^\]]+)\]:\s*\[(.*)\]$/);
    if (match) {
      result[match[1]] = match[2];
    }
  }
  return result;
}
