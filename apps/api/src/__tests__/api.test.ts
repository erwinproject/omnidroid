import type { ChildProcess } from 'node:child_process';
import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';
import { BUILTIN_DEVICE_PROFILES } from '@droidforge/shared';
import { buildApp } from '../app.js';
import { loadEnv } from '../config/env.js';
import { buildRedroidBootArgs, type RedroidDockerManager } from '../docker/redroid-docker.manager.js';
import type { AdbExecutor } from '../services/adb.service.js';
import { extractInteractiveElements } from '../services/ai-snapshot.service.js';
import { matchSelector, parseUiHierarchyXml } from '../services/ui-automation.service.js';

const SAMPLE_UI_XML = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" text="" resource-id="" class="android.widget.FrameLayout" package="com.example.app" content-desc="" checkable="false" checked="false" clickable="false" enabled="true" focusable="false" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[0,0][1080,2400]">
    <node index="0" text="Sign In" resource-id="com.example.app:id/btn_login" class="android.widget.Button" package="com.example.app" content-desc="Login Button" checkable="false" checked="false" clickable="true" enabled="true" focusable="true" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[100,1000][980,1140]" />
    <node index="1" text="" resource-id="com.example.app:id/input_email" class="android.widget.EditText" package="com.example.app" content-desc="Email Address" checkable="false" checked="false" clickable="true" enabled="true" focusable="true" focused="true" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[100,700][980,820]" />
  </node>
</hierarchy>`;

function createMockDocker(): RedroidDockerManager {
  let seq = 1;
  return {
    ensureNetwork: vi.fn().mockResolvedValue(undefined),
    ensureImage: vi.fn().mockResolvedValue(undefined),
    createContainer: vi.fn().mockImplementation(async () => `mock-container-${seq++}`),
    startContainer: vi.fn().mockResolvedValue(undefined),
    stopContainer: vi.fn().mockResolvedValue(undefined),
    restartContainer: vi.fn().mockResolvedValue(undefined),
    removeContainer: vi.fn().mockResolvedValue(undefined),
    getContainerStats: vi.fn().mockResolvedValue({
      running: true,
      cpuPercent: 12.5,
      memoryUsageMb: 850,
      memoryLimitMb: 2048,
    }),
    cloneVolume: vi.fn().mockResolvedValue(undefined),
    backupVolumeToTar: vi.fn().mockResolvedValue(4096),
    restoreVolumeFromTar: vi.fn().mockResolvedValue(undefined),
  } as unknown as RedroidDockerManager;
}

async function createMockAdb(stealthed = true): Promise<AdbExecutor> {
  const samplePng = await sharp({
    create: { width: 1080, height: 2400, channels: 4, background: { r: 20, g: 24, b: 32, alpha: 1 } },
  })
    .png()
    .toBuffer();

  const shellCommands: string[] = [];

  return {
    connect: vi.fn().mockResolvedValue(true),
    disconnect: vi.fn().mockResolvedValue(undefined),
    shell: vi.fn().mockImplementation(async (_target: string, cmd: string) => {
      shellCommands.push(cmd);
      if (cmd.includes('sys.boot_completed')) return { exitCode: 0, stdout: '1', stderr: '' };
      if (cmd.includes('cat /data/local/tmp/droidforge_ui.xml')) {
        return { exitCode: 0, stdout: SAMPLE_UI_XML, stderr: '' };
      }
      if (cmd === 'getprop') {
        if (stealthed) {
          return {
            exitCode: 0,
            stdout: [
              '[ro.product.brand]: [samsung]',
              '[ro.product.model]: [SM-S918B]',
              '[ro.build.type]: [user]',
              '[ro.build.tags]: [release-keys]',
              '[ro.build.fingerprint]: [samsung/dm3qxxx/dm3q:14/UP1A.231005.007/S918BXXS6CXE9:user/release-keys]',
              '[ro.debuggable]: [0]',
              '[ro.kernel.qemu]: [0]',
              '[ro.hardware]: [qcom]',
              '[ro.product.cpu.abilist]: [arm64-v8a,armeabi-v7a,x86_64]',
            ].join('\n'),
            stderr: '',
          };
        }
        return {
          exitCode: 0,
          stdout: [
            '[ro.product.brand]: [redroid]',
            '[ro.product.model]: [redroid13_x86_64]',
            '[ro.build.type]: [userdebug]',
            '[ro.build.tags]: [test-keys]',
            '[ro.build.fingerprint]: [redroid/redroid_x86_64:13/test-keys]',
            '[ro.debuggable]: [1]',
            '[ro.kernel.qemu]: [1]',
            '[ro.hardware]: [redroid]',
            '[ro.product.cpu.abilist]: [x86_64]',
          ].join('\n'),
          stderr: '',
        };
      }
      if (cmd.includes('settings get secure android_id')) {
        return { exitCode: 0, stdout: 'a1b2c3d4e5f60718', stderr: '' };
      }
      if (cmd === 'dumpsys battery') {
        return { exitCode: 0, stdout: 'Current Battery Service state:\n  USB powered: false\n  level: 74\n', stderr: '' };
      }
      return { exitCode: 0, stdout: 'OK', stderr: '' };
    }),
    execOut: vi.fn().mockResolvedValue(samplePng),
    screencapPng: vi.fn().mockResolvedValue(samplePng),
    installApk: vi.fn().mockResolvedValue({ exitCode: 0, stdout: 'Success', stderr: '' }),
    pushFile: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '1 file pushed', stderr: '' }),
    pullFile: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '1 file pulled', stderr: '' }),
    isBootCompleted: vi.fn().mockResolvedValue(true),
    spawnLogcat: vi.fn().mockReturnValue({} as ChildProcess),
  };
}

describe('Redroid Boot Args & Stealth Prop Injection', () => {
  it('injects custom model, brand, user/release-keys, and anti-emulator flags', () => {
    const profile = {
      ...BUILTIN_DEVICE_PROFILES[1], // Samsung S23 Ultra
      model: 'SM-S928B',
      serialNo: 'R5CX1234ABCD',
    };
    const args = buildRedroidBootArgs({
      width: 1080,
      height: 2340,
      dpi: 450,
      fps: 30,
      gpuMode: 'guest',
      stealthMode: true,
      profile,
      customProps: { 'persist.custom.flag': 'enabled' },
    });

    expect(args).toContain('ro.product.model=SM-S928B');
    expect(args).toContain('ro.product.brand=samsung');
    expect(args).toContain('ro.build.type=user');
    expect(args).toContain('ro.build.tags=release-keys');
    expect(args).toContain('ro.debuggable=0');
    expect(args).toContain('ro.kernel.qemu=0');
    expect(args).toContain('ro.boot.verifiedbootstate=green');
    expect(args).toContain('ro.serialno=R5CX1234ABCD');
    expect(args).toContain('persist.custom.flag=enabled');
  });
});

describe('UI Automation XML Parser & AI Element Extraction', () => {
  it('parses UI Automator XML and matches selectors accurately', () => {
    const tree = parseUiHierarchyXml(SAMPLE_UI_XML);
    expect(tree).toHaveLength(1);

    const loginBtn = matchSelector(tree, { text: 'Sign In', clickable: true });
    expect(loginBtn).toHaveLength(1);
    expect(loginBtn[0].bounds.centerX).toBe(540);
    expect(loginBtn[0].bounds.centerY).toBe(1070);

    const elements = extractInteractiveElements(tree, 1080, 2400);
    expect(elements).toHaveLength(2);
    expect(elements[0].label).toBe('Sign In');
    expect(elements[1].editable).toBe(true);
  });
});

describe('DroidForge Fastify REST API Contract', () => {
  it('enforces X-API-Key authentication when REQUIRE_AUTH=true', async () => {
    const env = loadEnv({ NODE_ENV: 'test', REQUIRE_AUTH: 'true', API_KEY: 'secret-123' });
    const { app } = await buildApp({ env, docker: createMockDocker(), adb: await createMockAdb() });

    const unauth = await app.inject({ method: 'GET', url: '/api/v1/instances' });
    expect(unauth.statusCode).toBe(401);

    const auth = await app.inject({
      method: 'GET',
      url: '/api/v1/instances',
      headers: { 'x-api-key': 'secret-123' },
    });
    expect(auth.statusCode).toBe(200);
    await app.close();
  });

  it('creates instances with custom model/stealth, allocates unique ports > 10000, runs AI snapshot & stealth check', async () => {
    const env = loadEnv({
      NODE_ENV: 'test',
      REQUIRE_AUTH: 'false',
      API_PORT: '13000',
      ADB_PORT_MIN: '15555',
      ADB_PORT_MAX: '19999',
    });
    const adb = await createMockAdb(true);
    const { app } = await buildApp({ env, docker: createMockDocker(), adb });

    // 1. Health & OpenAPI
    const health = await app.inject({ method: 'GET', url: '/health' });
    expect(health.statusCode).toBe(200);
    expect(health.json().port).toBe(13000);

    const openapi = await app.inject({ method: 'GET', url: '/openapi.json' });
    expect(openapi.statusCode).toBe(200);
    expect(openapi.json().openapi).toMatch(/^3\./);

    // 2. Profiles & identity generator
    const profilesRes = await app.inject({ method: 'GET', url: '/api/v1/profiles' });
    expect(profilesRes.statusCode).toBe(200);
    expect(profilesRes.json().length).toBeGreaterThanOrEqual(4);

    // 3. Create 2 instances with unique ADB ports > 10000
    const create1 = await app.inject({
      method: 'POST',
      url: '/api/v1/instances',
      payload: {
        name: 's23-stealth-1',
        androidVersion: '14',
        profileId: 'samsung-s23-ultra',
        stealthMode: true,
        exposeAdbPort: true,
        autoStart: false,
        deviceProfile: {
          model: 'SM-S918B-CUSTOM',
          buildType: 'user',
        },
      },
    });
    expect(create1.statusCode).toBe(201);
    const inst1 = create1.json();
    expect(inst1.hostAdbPort).toBe(15555);
    expect(inst1.profile.model).toBe('SM-S918B-CUSTOM');
    expect(inst1.profile.serialNo).toBeTruthy();
    expect(inst1.profile.androidId).toMatch(/^[0-9a-f]{16}$/);

    const create2 = await app.inject({
      method: 'POST',
      url: '/api/v1/instances',
      payload: {
        name: 'pixel-stealth-2',
        profileId: 'pixel-8-pro',
        exposeAdbPort: true,
        autoStart: false,
      },
    });
    expect(create2.statusCode).toBe(201);
    expect(create2.json().hostAdbPort).toBe(15556);

    // 4. Normalized tap input
    const tap = await app.inject({
      method: 'POST',
      url: `/api/v1/instances/${inst1.id}/input/tap`,
      payload: { x: 0.5, y: 0.5, normalized: true },
    });
    expect(tap.statusCode).toBe(200);
    expect(tap.json().point).toEqual({ x: 540, y: 1170 });

    // 5. AI Set-of-Marks Snapshot + Click by elementId
    const aiSnap = await app.inject({
      method: 'GET',
      url: `/api/v1/instances/${inst1.id}/ui/ai-snapshot`,
    });
    expect(aiSnap.statusCode).toBe(200);
    const snapJson = aiSnap.json();
    expect(snapJson.elements).toHaveLength(2);
    expect(snapJson.annotatedImageBase64.length).toBeGreaterThan(100);

    const aiClick = await app.inject({
      method: 'POST',
      url: `/api/v1/instances/${inst1.id}/ui/click`,
      payload: { elementId: 1 },
    });
    expect(aiClick.statusCode).toBe(200);
    expect(aiClick.json().clicked).toEqual({ x: 540, y: 1070 });

    // 6. Stealth Check audit
    const stealthRes = await app.inject({
      method: 'GET',
      url: `/api/v1/instances/${inst1.id}/device/stealth-check`,
    });
    expect(stealthRes.statusCode).toBe(200);
    expect(stealthRes.json().score).toBe(100);
    expect(stealthRes.json().failed).toBe(0);

    await app.close();
  });

  it('flags leaked emulator markers in stealth-check when container is unhardened', async () => {
    const env = loadEnv({ NODE_ENV: 'test', REQUIRE_AUTH: 'false' });
    const { app } = await buildApp({ env, docker: createMockDocker(), adb: await createMockAdb(false) });

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/instances',
      payload: { name: 'unhardened-1', autoStart: false, stealthMode: false },
    });
    const inst = created.json();

    const stealthRes = await app.inject({
      method: 'GET',
      url: `/api/v1/instances/${inst.id}/device/stealth-check`,
    });
    expect(stealthRes.statusCode).toBe(200);
    expect(stealthRes.json().failed).toBeGreaterThanOrEqual(4);
    expect(stealthRes.json().score).toBeLessThan(60);

    await app.close();
  });
});
