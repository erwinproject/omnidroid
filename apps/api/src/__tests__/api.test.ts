import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';
import { BUILTIN_DEVICE_PROFILES, parseProxyString } from '@droidforge/shared';
import { buildApp } from '../app.js';
import { loadEnv } from '../config/env.js';
import {
  buildRedroidBootArgs,
  type DockerContainerSummary,
  type DockerImageSummary,
  type DockerVolumeSummary,
  type RedroidDockerManager,
} from '../docker/redroid-docker.manager.js';
import type { AdbExecutor } from '../services/adb.service.js';
import { extractInteractiveElements } from '../services/ai-snapshot.service.js';
import { ProxyRelayService } from '../services/proxy-relay.service.js';
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
    authorizeAdbKey: vi.fn().mockResolvedValue(false),
    putFileToContainer: vi.fn().mockResolvedValue(undefined),
    execInContainer: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' }),
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
    listAllContainers: vi.fn().mockResolvedValue([]),
    listAllVolumes: vi.fn().mockResolvedValue([]),
    getVolumeSize: vi.fn().mockResolvedValue(0),
    listDockerImages: vi.fn().mockResolvedValue([]),
    getBuildCacheUsageBytes: vi.fn().mockResolvedValue(0),
    removeVolume: vi.fn().mockResolvedValue(undefined),
    removeImage: vi.fn().mockResolvedValue(undefined),
    pruneDanglingImages: vi.fn().mockResolvedValue({ imagesDeleted: [], spaceReclaimed: 0 }),
    pruneBuildCache: vi.fn().mockResolvedValue({ spaceReclaimed: 0 }),
    getSystemImages: vi.fn().mockResolvedValue([
      {
        androidVersion: '13',
        baseImage: 'redroid/redroid:13.0.0-latest',
        baseInstalled: true,
        playStoreImage: 'droidforge/redroid:13.0.0-playstore',
        playStoreInstalled: true,
        playStoreSizeMb: 1900,
        buildCommand: 'bash scripts/build-playstore-image.sh 13',
      },
    ]),
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
    getPublicKey: vi.fn().mockResolvedValue('mock-adb-pub-key'),
    isAuthorized: vi.fn().mockResolvedValue(true),
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

    expect(args).toContain('androidboot.use_memfd=true');
    expect(args).toContain('ro.vendor.api_level=202404');
    expect(args).toContain('ro.product.model=SM-S928B');
    expect(args).toContain('ro.product.brand=samsung');
    expect(args).toContain('ro.build.type=user');
    expect(args).toContain('ro.build.tags=release-keys');
    expect(args).toContain('ro.debuggable=0');
    expect(args).toContain('ro.kernel.qemu=0');
    expect(args).toContain('ro.boot.verifiedbootstate=green');
    expect(args).toContain('ro.serialno=R5CX1234ABCD');
    expect(args).toContain('ro.hardware.hwcomposer=redroid');
    expect(args.some((a) => a.startsWith('ro.boot.hardware='))).toBe(false);
    expect(args).toContain('persist.custom.flag=enabled');
  });

  it('allows customProps to override the default ro.vendor.api_level', () => {
    const args = buildRedroidBootArgs({
      width: 1080,
      height: 2400,
      dpi: 420,
      fps: 30,
      gpuMode: 'guest',
      stealthMode: true,
      profile: BUILTIN_DEVICE_PROFILES[0],
      customProps: { 'ro.vendor.api_level': '33' },
    });

    expect(args).toContain('ro.vendor.api_level=33');
    expect(args).not.toContain('ro.vendor.api_level=202404');
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

function listenServer(server: net.Server | http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        reject(new Error('Expected TCP address'));
        return;
      }
      resolve(addr.port);
    });
  });
}

function sendConnectEcho(
  relayHost: string,
  relayPort: number,
  targetHost: string,
  targetPort: number,
  payload: string,
): Promise<{ statusLine: string; reply: string }> {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host: relayHost, port: relayPort }, () => {
      sock.write(`CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\n\r\n`);
    });
    let buf = Buffer.alloc(0);
    let connected = false;
    let statusLine = '';
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error('CONNECT echo timed out'));
    }, 5000);

    sock.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      if (!connected) {
        const end = buf.indexOf('\r\n\r\n');
        if (end === -1) return;
        const head = buf.subarray(0, end).toString('utf8');
        statusLine = head.split(/\r?\n/)[0] ?? '';
        if (!statusLine.includes('200')) {
          clearTimeout(timer);
          sock.destroy();
          resolve({ statusLine, reply: '' });
          return;
        }
        connected = true;
        buf = buf.subarray(end + 4);
        sock.write(payload);
      }
      if (connected && buf.length > 0) {
        const text = buf.toString('utf8');
        if (text.includes(`ECHO:${payload}`)) {
          clearTimeout(timer);
          sock.destroy();
          resolve({ statusLine, reply: text });
        }
      }
    });
    sock.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function sendProxiedHttpGet(relayHost: string, relayPort: number, targetUrl: string): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: relayHost,
        port: relayPort,
        method: 'GET',
        path: targetUrl,
        headers: { Host: new URL(targetUrl).host },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          resolve({ statusCode: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') });
        });
      },
    );
    req.once('error', reject);
    req.end();
  });
}

function sendHalfClosedHttpGet(relayHost: string, relayPort: number, targetUrl: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const u = new URL(targetUrl);
    const sock = net.createConnection({ host: relayHost, port: relayPort }, () => {
      sock.write(`GET ${targetUrl} HTTP/1.0\r\nHost: ${u.host}\r\nConnection: close\r\n\r\n`);
      sock.end();
    });
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error('Half-closed GET timed out'));
    }, 5000);
    sock.on('data', (c: Buffer) => chunks.push(c));
    sock.once('end', () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    sock.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

describe('Play Store Boot Flags & Proxy Subsystem', () => {
  it('sets ro.setupwizard.mode=DISABLED in buildRedroidBootArgs for GApps/Play Store containers', () => {
    const profile = BUILTIN_DEVICE_PROFILES[0];
    const args = buildRedroidBootArgs({
      width: 1080,
      height: 2400,
      dpi: 420,
      fps: 30,
      gpuMode: 'guest',
      stealthMode: true,
      profile,
      customProps: {},
    });
    expect(args).toContain('ro.setupwizard.mode=DISABLED');
  });

  it('parses HTTP, HTTPS, SOCKS5, user:pass@host:port, and host:port:user:pass strings', () => {
    expect(parseProxyString('http://alice:s3cr3t@10.0.0.1:8080')).toEqual({
      protocol: 'http',
      host: '10.0.0.1',
      port: 8080,
      username: 'alice',
      password: 's3cr3t',
      bypass: 'localhost,127.0.0.1',
    });

    expect(parseProxyString('https://proxy.corp:8443')).toEqual({
      protocol: 'https',
      host: 'proxy.corp',
      port: 8443,
      bypass: 'localhost,127.0.0.1',
    });

    expect(parseProxyString('socks5://user:pass@1.2.3.4:1080')).toEqual({
      protocol: 'socks5',
      host: '1.2.3.4',
      port: 1080,
      username: 'user',
      password: 'pass',
      bypass: 'localhost,127.0.0.1',
    });

    expect(parseProxyString('5.6.7.8:9090:bob:pw123', 'socks5')).toEqual({
      protocol: 'socks5',
      host: '5.6.7.8',
      port: 9090,
      username: 'bob',
      password: 'pw123',
      bypass: 'localhost,127.0.0.1',
    });

    expect(parseProxyString('bob:pw@9.9.9.9:3128')).toEqual({
      protocol: 'http',
      host: '9.9.9.9',
      port: 3128,
      username: 'bob',
      password: 'pw',
      bypass: 'localhost,127.0.0.1',
    });

    expect(parseProxyString('192.168.1.50:8888')).toEqual({
      protocol: 'http',
      host: '192.168.1.50',
      port: 8888,
      bypass: 'localhost,127.0.0.1',
    });
  });

  it('tunnels traffic through HTTP CONNECT/forward upstream with Basic auth and rejects bad credentials', async () => {
    const sockets = new Set<net.Socket>();
    const echoServer = net.createServer((sock) => {
      sockets.add(sock);
      sock.on('close', () => sockets.delete(sock));
      sock.on('error', () => {});
      sock.on('data', (d) => sock.write(Buffer.concat([Buffer.from('ECHO:'), d])));
    });
    const httpTarget = http.createServer((req, res) => {
      if (req.url === '/ping') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ pong: true }));
        return;
      }
      res.writeHead(404);
      res.end();
    });

    let seenAuth = false;
    const expectedAuth = `Basic ${Buffer.from('u1:p1').toString('base64')}`;
    const httpProxy = net.createServer((client) => {
      sockets.add(client);
      client.on('close', () => sockets.delete(client));
      client.on('error', () => {});
      let buf = Buffer.alloc(0);
      let connected = false;
      client.on('data', (chunk: Buffer) => {
        if (connected) return;
        buf = Buffer.concat([buf, chunk]);
        const end = buf.indexOf('\r\n\r\n');
        if (end === -1) return;
        connected = true;
        const headerText = buf.subarray(0, end).toString('utf8');
        const rest = buf.subarray(end + 4);
        const lines = headerText.split(/\r?\n/);
        const firstParts = (lines[0] ?? '').split(' ');
        const method = (firstParts[0] ?? '').toUpperCase();
        const target = firstParts[1] ?? '';
        const authLine = lines.find((l) => l.toLowerCase().startsWith('proxy-authorization:'));
        const authVal = authLine ? authLine.split(':').slice(1).join(':').trim() : '';
        if (authVal !== expectedAuth) {
          client.write('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n');
          client.end();
          return;
        }
        seenAuth = true;
        if (method === 'CONNECT') {
          const [tHost, tPortRaw] = target.split(':');
          const upstream = net.createConnection({ host: tHost, port: Number(tPortRaw) }, () => {
            sockets.add(upstream);
            upstream.on('close', () => sockets.delete(upstream));
            upstream.on('error', () => client.destroy());
            client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
            if (rest.length > 0) upstream.write(rest);
            client.pipe(upstream);
            upstream.pipe(client);
          });
        } else {
          const u = new URL(target);
          const upReq = http.request(
            {
              host: u.hostname,
              port: Number(u.port || 80),
              path: `${u.pathname}${u.search}`,
              method,
              headers: { Host: u.host, Connection: 'close' },
            },
            (upRes) => {
              const chunks: Buffer[] = [];
              upRes.on('data', (c: Buffer) => chunks.push(c));
              upRes.on('end', () => {
                const body = Buffer.concat(chunks);
                client.write(
                  `HTTP/1.1 ${upRes.statusCode ?? 200} OK\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n`,
                );
                client.end(body);
              });
            },
          );
          upReq.on('error', () => client.destroy());
          upReq.end();
        }
      });
    });

    const env = loadEnv({
      NODE_ENV: 'test',
      PROXY_RELAY_HOST: '127.0.0.1',
      PROXY_RELAY_PORT_MIN: '24500',
      PROXY_RELAY_PORT_MAX: '24549',
    });
    const relay = new ProxyRelayService(env);

    try {
      const echoPort = await listenServer(echoServer);
      const httpPort = await listenServer(httpTarget);
      const proxyPort = await listenServer(httpProxy);

      const endpoint = await relay.ensureRelay('test-http-ok', {
        protocol: 'http',
        host: '127.0.0.1',
        port: proxyPort,
        username: 'u1',
        password: 'p1',
        bypass: 'localhost',
      });

      const okRes = await sendConnectEcho(endpoint.host, endpoint.port, '127.0.0.1', echoPort, 'hello-http');
      expect(okRes.statusLine).toContain('200');
      expect(okRes.reply).toBe('ECHO:hello-http');
      expect(seenAuth).toBe(true);
      expect(relay.getRelayInfo('test-http-ok').stats.totalRequests).toBeGreaterThanOrEqual(1);

      // Mimic toybox nc immediate TCP half-close after GET HTTP/1.0
      const halfClosed = await sendHalfClosedHttpGet(endpoint.host, endpoint.port, `http://127.0.0.1:${httpPort}/ping`);
      expect(halfClosed).toContain('200');
      expect(halfClosed).toContain('{"pong":true}');

      const badEndpoint = await relay.ensureRelay('test-http-bad', {
        protocol: 'http',
        host: '127.0.0.1',
        port: proxyPort,
        username: 'u1',
        password: 'wrong',
        bypass: 'localhost',
      });
      const badRes = await sendConnectEcho(badEndpoint.host, badEndpoint.port, '127.0.0.1', echoPort, 'blocked');
      expect(badRes.statusLine).toContain('502');
    } finally {
      await relay.stopAll();
      for (const s of sockets) s.destroy();
      await Promise.all([
        new Promise<void>((r) => echoServer.close(() => r())),
        new Promise<void>((r) => httpTarget.close(() => r())),
        new Promise<void>((r) => httpProxy.close(() => r())),
      ]);
    }
  });

  it('tunnels both CONNECT and plain HTTP GET via SOCKS5 upstream with RFC 1928/1929 user/pass auth', async () => {
    const sockets = new Set<net.Socket>();
    const echoServer = net.createServer((sock) => {
      sockets.add(sock);
      sock.on('close', () => sockets.delete(sock));
      sock.on('error', () => {});
      sock.on('data', (d) => sock.write(Buffer.concat([Buffer.from('ECHO:'), d])));
    });
    const httpTarget = http.createServer((req, res) => {
      if (req.url === '/ping') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ pong: true }));
        return;
      }
      res.writeHead(404);
      res.end();
    });

    let socksAuthed = 0;
    const socksServer = net.createServer((client) => {
      sockets.add(client);
      client.on('close', () => sockets.delete(client));
      client.on('error', () => {});
      let stage: 'greeting' | 'auth' | 'connect' | 'piping' = 'greeting';
      let buf = Buffer.alloc(0);

      client.on('data', (chunk: Buffer) => {
        if (stage === 'piping') return;
        buf = Buffer.concat([buf, chunk]);

        if (stage === 'greeting') {
          if (buf.length < 2) return;
          const nmethods = buf[1] ?? 0;
          if (buf.length < 2 + nmethods) return;
          const methods = buf.subarray(2, 2 + nmethods);
          buf = buf.subarray(2 + nmethods);
          if (!methods.includes(0x02)) {
            client.write(Buffer.from([0x05, 0xff]));
            client.end();
            return;
          }
          stage = 'auth';
          client.write(Buffer.from([0x05, 0x02]));
        }

        if (stage === 'auth') {
          if (buf.length < 2) return;
          const ulen = buf[1] ?? 0;
          if (buf.length < 3 + ulen) return;
          const plen = buf[2 + ulen] ?? 0;
          if (buf.length < 3 + ulen + plen) return;
          const user = buf.subarray(2, 2 + ulen).toString('utf8');
          const pass = buf.subarray(3 + ulen, 3 + ulen + plen).toString('utf8');
          buf = buf.subarray(3 + ulen + plen);
          if (user !== 'suser' || pass !== 'spass') {
            client.write(Buffer.from([0x01, 0x01]));
            client.end();
            return;
          }
          socksAuthed += 1;
          stage = 'connect';
          client.write(Buffer.from([0x01, 0x00]));
        }

        if (stage === 'connect') {
          if (buf.length < 5) return;
          const atyp = buf[3];
          let targetHost = '';
          let targetPort = 0;
          let need = 0;
          if (atyp === 0x01) {
            need = 10;
            if (buf.length < need) return;
            targetHost = `${buf[4]}.${buf[5]}.${buf[6]}.${buf[7]}`;
            targetPort = buf.readUInt16BE(8);
          } else if (atyp === 0x03) {
            const dlen = buf[4] ?? 0;
            need = 4 + 1 + dlen + 2;
            if (buf.length < need) return;
            targetHost = buf.subarray(5, 5 + dlen).toString('utf8');
            targetPort = buf.readUInt16BE(5 + dlen);
          } else {
            client.destroy();
            return;
          }
          const rest = buf.subarray(need);
          buf = Buffer.alloc(0);
          stage = 'piping';

          const upstream = net.createConnection({ host: targetHost, port: targetPort }, () => {
            sockets.add(upstream);
            upstream.on('close', () => sockets.delete(upstream));
            upstream.on('error', () => client.destroy());
            client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
            if (rest.length > 0) upstream.write(rest);
            client.pipe(upstream);
            upstream.pipe(client);
          });
        }
      });
    });

    const env = loadEnv({
      NODE_ENV: 'test',
      PROXY_RELAY_HOST: '127.0.0.1',
      PROXY_RELAY_PORT_MIN: '24550',
      PROXY_RELAY_PORT_MAX: '24599',
    });
    const relay = new ProxyRelayService(env);

    try {
      const echoPort = await listenServer(echoServer);
      const httpPort = await listenServer(httpTarget);
      const socksPort = await listenServer(socksServer);

      const endpoint = await relay.ensureRelay('test-socks5', {
        protocol: 'socks5',
        host: '127.0.0.1',
        port: socksPort,
        username: 'suser',
        password: 'spass',
        bypass: 'localhost',
      });

      const connRes = await sendConnectEcho(endpoint.host, endpoint.port, '127.0.0.1', echoPort, 'hello-socks');
      expect(connRes.statusLine).toContain('200');
      expect(connRes.reply).toBe('ECHO:hello-socks');

      const httpRes = await sendProxiedHttpGet(endpoint.host, endpoint.port, `http://127.0.0.1:${httpPort}/ping`);
      expect(httpRes.statusCode).toBe(200);
      expect(JSON.parse(httpRes.body)).toEqual({ pong: true });

      // Mimic toybox nc immediate TCP half-close (FIN right after GET HTTP/1.0 headers)
      const halfClosed = await sendHalfClosedHttpGet(endpoint.host, endpoint.port, `http://127.0.0.1:${httpPort}/ping`);
      expect(halfClosed).toContain('200');
      expect(halfClosed).toContain('{"pong":true}');
      expect(socksAuthed).toBe(3);
    } finally {
      await relay.stopAll();
      for (const s of sockets) s.destroy();
      await Promise.all([
        new Promise<void>((r) => echoServer.close(() => r())),
        new Promise<void>((r) => httpTarget.close(() => r())),
        new Promise<void>((r) => socksServer.close(() => r())),
      ]);
    }
  });

  it('serves /api/v1/system/images, proxy pool CRUD + bulk import, Play Store selection, and instance proxy masking', async () => {
    const env = loadEnv({
      NODE_ENV: 'test',
      REQUIRE_AUTH: 'false',
      PROXY_RELAY_HOST: '127.0.0.1',
      PROXY_RELAY_PORT_MIN: '24600',
      PROXY_RELAY_PORT_MAX: '24699',
    });
    const adb = await createMockAdb(true);
    const { app } = await buildApp({ env, docker: createMockDocker(), adb });

    try {
      // 1. System image readiness
      const sysRes = await app.inject({ method: 'GET', url: '/api/v1/system/images' });
      expect(sysRes.statusCode).toBe(200);
      const images = sysRes.json() as Array<{ androidVersion: string; playStoreImage: string }>;
      expect(images.some((i) => i.androidVersion === '13' && i.playStoreImage === 'droidforge/redroid:13.0.0-playstore')).toBe(true);

      // 2. Proxy Pool CRUD & Bulk Import
      const createProxy = await app.inject({
        method: 'POST',
        url: '/api/v1/proxies',
        payload: {
          name: 'Unit SOCKS5',
          protocol: 'socks5',
          host: '10.10.0.2',
          port: 1080,
          username: 'u',
          password: 'secret-pool-password',
          bypass: 'localhost,127.0.0.1',
        },
      });
      expect(createProxy.statusCode).toBe(201);
      const createdProxy = createProxy.json();
      expect(createdProxy.password).toBe('***');

      const importRes = await app.inject({
        method: 'POST',
        url: '/api/v1/proxies/import',
        payload: {
          defaultProtocol: 'http',
          text: 'http://alice:pw@1.1.1.1:8080\nsocks5://2.2.2.2:1080\ninvalid-line-without-port',
        },
      });
      expect(importRes.statusCode).toBe(201);
      const importJson = importRes.json();
      expect(importJson.imported).toHaveLength(2);
      expect(importJson.failed).toHaveLength(1);

      const listRes = await app.inject({ method: 'GET', url: '/api/v1/proxies' });
      expect(listRes.statusCode).toBe(200);
      expect(listRes.json().length).toBeGreaterThanOrEqual(3);

      const delRes = await app.inject({ method: 'DELETE', url: `/api/v1/proxies/${createdProxy.id}` });
      expect(delRes.statusCode).toBe(200);

      // 3. Play Store image selection
      const createPlay = await app.inject({
        method: 'POST',
        url: '/api/v1/instances',
        payload: {
          name: 'playstore-unit',
          androidVersion: '13',
          enablePlayStore: true,
          autoStart: false,
        },
      });
      expect(createPlay.statusCode).toBe(201);
      const playInst = createPlay.json();
      expect(playInst.enablePlayStore).toBe(true);
      expect(playInst.image).toBe('droidforge/redroid:13.0.0-playstore');

      // 4. Instance proxy attach, mask, get, and clear
      const setProxyRes = await app.inject({
        method: 'PUT',
        url: `/api/v1/instances/${playInst.id}/proxy`,
        payload: {
          enabled: true,
          config: {
            protocol: 'socks5',
            host: '1.2.3.4',
            port: 1080,
            username: 'alice',
            password: 'secret',
            bypass: 'localhost,127.0.0.1',
          },
          syncTimezone: false,
        },
      });
      expect(setProxyRes.statusCode).toBe(200);
      const proxyState = setProxyRes.json();
      expect(proxyState.enabled).toBe(true);
      expect(proxyState.config.hasPassword).toBe(true);
      expect(proxyState.config.password).toBeUndefined();

      const instRes = await app.inject({ method: 'GET', url: `/api/v1/instances/${playInst.id}` });
      expect(instRes.statusCode).toBe(200);
      expect(instRes.json().proxyConfig.password).toBe('***');

      const getProxyRes = await app.inject({ method: 'GET', url: `/api/v1/instances/${playInst.id}/proxy` });
      expect(getProxyRes.statusCode).toBe(200);
      expect(getProxyRes.json().enabled).toBe(true);

      const clearProxyRes = await app.inject({ method: 'DELETE', url: `/api/v1/instances/${playInst.id}/proxy` });
      expect(clearProxyRes.statusCode).toBe(200);
      expect(clearProxyRes.json().enabled).toBe(false);
      expect(clearProxyRes.json().config).toBeNull();
    } finally {
      await app.close();
    }
  });
});

function createStatefulMockDocker(initial?: {
  containers?: DockerContainerSummary[];
  volumes?: DockerVolumeSummary[];
  images?: DockerImageSummary[];
  buildCacheBytes?: number;
}) {
  const containers: DockerContainerSummary[] = [...(initial?.containers ?? [])];
  const volumes: DockerVolumeSummary[] = [...(initial?.volumes ?? [])];
  const images: DockerImageSummary[] = [...(initial?.images ?? [])];
  let buildCacheBytes = initial?.buildCacheBytes ?? 0;
  let seq = 1;

  const mock = {
    ensureNetwork: vi.fn().mockResolvedValue(undefined),
    ensureImage: vi.fn().mockResolvedValue(undefined),
    ensureManagedVolume: vi.fn().mockImplementation(async (volumeName: string, instanceId?: string) => {
      if (!volumes.some((v) => v.name === volumeName)) {
        volumes.push({
          name: volumeName,
          driver: 'local',
          mountpoint: `/var/lib/docker/volumes/${volumeName}/_data`,
          labels: {
            'droidforge.managed': 'true',
            ...(instanceId ? { 'droidforge.instance_id': instanceId } : {}),
          },
          sizeBytes: 2048,
          refCount: 1,
        });
      }
    }),
    createContainer: vi.fn().mockImplementation(async (instance) => {
      const id = `mock-container-${seq++}`;
      await mock.ensureManagedVolume(instance.volumeName, instance.id);
      containers.push({
        id,
        names: [`/${instance.containerName}`],
        image: instance.image,
        imageId: `sha256:img-${instance.image}`,
        state: 'created',
        status: 'Created',
        labels: {
          'droidforge.managed': 'true',
          'droidforge.instance_id': instance.id,
          'droidforge.instance_name': instance.name,
        },
        mounts: [{ type: 'volume', name: instance.volumeName, destination: '/data' }],
        sizeRw: 1024,
      });
      return id;
    }),
    startContainer: vi.fn().mockResolvedValue(undefined),
    stopContainer: vi.fn().mockResolvedValue(undefined),
    restartContainer: vi.fn().mockResolvedValue(undefined),
    authorizeAdbKey: vi.fn().mockResolvedValue(false),
    removeContainer: vi.fn().mockImplementation(
      async (containerId: string | null, volumeName?: string, removeVolume = false, containerName?: string) => {
        const idx = containers.findIndex(
          (c) =>
            (containerId && c.id === containerId) ||
            (containerName && c.names.some((n) => n.replace(/^\/+/, '') === containerName)),
        );
        if (idx !== -1) containers.splice(idx, 1);
        if (removeVolume && volumeName) {
          const vIdx = volumes.findIndex((v) => v.name === volumeName);
          if (vIdx !== -1) volumes.splice(vIdx, 1);
        }
      },
    ),
    getContainerStats: vi.fn().mockResolvedValue({
      running: false,
      cpuPercent: 0,
      memoryUsageMb: 0,
      memoryLimitMb: null,
    }),
    cloneVolume: vi.fn().mockResolvedValue(undefined),
    backupVolumeToTar: vi.fn().mockImplementation(async (_vol: string, destTarPath: string) => {
      fs.mkdirSync(path.dirname(destTarPath), { recursive: true });
      const payload = Buffer.from('mock-tar-gz-snapshot-payload');
      fs.writeFileSync(destTarPath, payload);
      return payload.length;
    }),
    restoreVolumeFromTar: vi.fn().mockResolvedValue(undefined),
    listAllContainers: vi.fn().mockImplementation(async () => [...containers]),
    listAllVolumes: vi.fn().mockImplementation(async () => [...volumes]),
    getVolumeSize: vi.fn().mockImplementation(async (volumeName: string) => {
      return volumes.find((v) => v.name === volumeName)?.sizeBytes ?? 0;
    }),
    listDockerImages: vi.fn().mockImplementation(async () => [...images]),
    getBuildCacheUsageBytes: vi.fn().mockImplementation(async () => buildCacheBytes),
    removeVolume: vi.fn().mockImplementation(async (volumeName: string) => {
      const idx = volumes.findIndex((v) => v.name === volumeName);
      if (idx !== -1) volumes.splice(idx, 1);
    }),
    removeImage: vi.fn().mockImplementation(async (imageId: string) => {
      const idx = images.findIndex((img) => img.id === imageId);
      if (idx !== -1) images.splice(idx, 1);
    }),
    pruneDanglingImages: vi.fn().mockImplementation(async () => {
      const deleted: string[] = [];
      let spaceReclaimed = 0;
      for (let i = images.length - 1; i >= 0; i--) {
        if (images[i].dangling) {
          deleted.push(images[i].id);
          spaceReclaimed += images[i].sizeBytes;
          images.splice(i, 1);
        }
      }
      return { imagesDeleted: deleted, spaceReclaimed };
    }),
    pruneBuildCache: vi.fn().mockImplementation(async () => {
      const reclaimed = buildCacheBytes;
      buildCacheBytes = 0;
      return { spaceReclaimed: reclaimed };
    }),
    getSystemImages: vi.fn().mockResolvedValue([]),
  };

  return {
    docker: mock as unknown as RedroidDockerManager,
    mock,
    containers,
    volumes,
    images,
  };
}

describe('Storage & Container Prune Subsystem', () => {
  it('auto-prunes container, /data volume, snapshots, recordings, and orphaned artifacts on DELETE instance', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'droidforge-prune-auto-'));
    const anonVolId = 'a'.repeat(64);
    const stateful = createStatefulMockDocker({
      containers: [
        {
          id: 'third-party-web',
          names: ['/droidforge-web'],
          image: 'nginx:alpine',
          imageId: 'sha256:nginx',
          state: 'running',
          status: 'Up',
          labels: {},
          mounts: [],
          sizeRw: 512,
        },
        {
          id: 'orphan-container-1',
          names: ['/redroid-deadbeef'],
          image: 'redroid/redroid:13.0.0-latest',
          imageId: 'sha256:redroid13',
          state: 'exited',
          status: 'Exited',
          labels: { 'droidforge.managed': 'true', 'droidforge.instance_id': 'deadbeef' },
          mounts: [{ type: 'volume', name: 'redroid-data-deadbeef', destination: '/data' }],
          sizeRw: 4000,
        },
      ],
      volumes: [
        {
          name: 'droidforge-api-data',
          driver: 'local',
          mountpoint: '/var/lib/docker/volumes/droidforge-api-data/_data',
          labels: {},
          sizeBytes: 99999,
          refCount: 1,
        },
        {
          name: 'redroid-data-deadbeef',
          driver: 'local',
          mountpoint: '/var/lib/docker/volumes/redroid-data-deadbeef/_data',
          labels: { 'droidforge.managed': 'true', 'droidforge.instance_id': 'deadbeef' },
          sizeBytes: 12000,
          refCount: 1,
        },
        {
          name: anonVolId,
          driver: 'local',
          mountpoint: `/var/lib/docker/volumes/${anonVolId}/_data`,
          labels: {},
          sizeBytes: 3000,
          refCount: 0,
        },
      ],
      images: [
        {
          id: 'sha256:dangling1',
          repoTags: [],
          sizeBytes: 50000,
          dangling: true,
          containers: 0,
        },
      ],
    });

    const env = loadEnv({
      NODE_ENV: 'test',
      REQUIRE_AUTH: 'false',
      DATA_DIR: tempDir,
      AUTO_PRUNE_ON_DELETE: 'true',
      PRUNE_DANGLING_IMAGES_ON_DELETE: 'true',
    });
    const { app } = await buildApp({ env, docker: stateful.docker, adb: await createMockAdb(true) });

    try {
      const keepRes = await app.inject({
        method: 'POST',
        url: '/api/v1/instances',
        payload: { name: 'keep-instance', autoStart: false },
      });
      expect(keepRes.statusCode).toBe(201);
      const keepInst = keepRes.json();

      const delRes = await app.inject({
        method: 'POST',
        url: '/api/v1/instances',
        payload: { name: 'delete-instance', autoStart: false },
      });
      expect(delRes.statusCode).toBe(201);
      const delInst = delRes.json();

      // Create snapshots for both instances
      const keepSnapRes = await app.inject({
        method: 'POST',
        url: `/api/v1/instances/${keepInst.id}/snapshots`,
        payload: { name: 'keep-snap' },
      });
      expect(keepSnapRes.statusCode).toBe(201);
      const keepSnap = keepSnapRes.json();

      const delSnapRes = await app.inject({
        method: 'POST',
        url: `/api/v1/instances/${delInst.id}/snapshots`,
        payload: { name: 'del-snap' },
      });
      expect(delSnapRes.statusCode).toBe(201);
      const delSnap = delSnapRes.json();
      expect(fs.existsSync(delSnap.filePath)).toBe(true);

      // Seed recording files for both instances
      const recDir = path.join(tempDir, 'recordings');
      fs.mkdirSync(recDir, { recursive: true });
      const keepRecPath = path.join(recDir, `${keepInst.id}_rec_11111111.mp4`);
      const delRecPath = path.join(recDir, `${delInst.id}_rec_22222222.mp4`);
      fs.writeFileSync(keepRecPath, Buffer.alloc(1500, 1));
      fs.writeFileSync(delRecPath, Buffer.alloc(2500, 2));

      // Seed stale temp file (>10 mins old) & fresh temp file (<1s old)
      const uploadsDir = path.join(tempDir, 'uploads');
      fs.mkdirSync(uploadsDir, { recursive: true });
      const staleUpload = path.join(uploadsDir, 'stale.apk');
      const freshUpload = path.join(uploadsDir, 'fresh.apk');
      fs.writeFileSync(staleUpload, Buffer.alloc(7000, 3));
      fs.writeFileSync(freshUpload, Buffer.alloc(800, 4));
      const oldTime = new Date(Date.now() - 10 * 60_000);
      fs.utimesSync(staleUpload, oldTime, oldTime);

      // Delete delete-instance with default behavior (removeVolume=true, prune=true)
      const deleteResponse = await app.inject({
        method: 'DELETE',
        url: `/api/v1/instances/${delInst.id}`,
      });
      expect(deleteResponse.statusCode).toBe(200);
      const body = deleteResponse.json();
      expect(body.deleted).toBe(true);
      expect(body.removedVolume).toBe(true);
      expect(body.removedSnapshotFiles).toBe(1);
      expect(body.removedRecordingFiles).toBe(1);
      expect(body.reclaimedBytes).toBeGreaterThan(70000);
      expect(body.prune).not.toBeNull();
      expect(body.prune.counts.orphanedContainers).toBe(1);
      expect(body.prune.counts.orphanedVolumes).toBe(1);
      expect(body.prune.counts.anonymousVolumes).toBe(1);
      expect(body.prune.counts.tempFiles).toBe(1);
      expect(body.prune.counts.danglingImages).toBe(1);

      // Deleted instance artifacts + orphans are gone
      expect(fs.existsSync(delSnap.filePath)).toBe(false);
      expect(fs.existsSync(delRecPath)).toBe(false);
      expect(fs.existsSync(staleUpload)).toBe(false);
      expect(stateful.containers.some((c) => c.id === 'orphan-container-1')).toBe(false);
      expect(stateful.volumes.some((v) => v.name === delInst.volumeName)).toBe(false);
      expect(stateful.volumes.some((v) => v.name === 'redroid-data-deadbeef')).toBe(false);
      expect(stateful.volumes.some((v) => v.name === anonVolId)).toBe(false);
      expect(stateful.images.some((img) => img.id === 'sha256:dangling1')).toBe(false);

      // Active instance, protected host volume/container, and fresh upload remain intact
      expect(fs.existsSync(keepSnap.filePath)).toBe(true);
      expect(fs.existsSync(keepRecPath)).toBe(true);
      expect(fs.existsSync(freshUpload)).toBe(true);
      expect(stateful.containers.some((c) => c.id === 'third-party-web')).toBe(true);
      expect(stateful.volumes.some((v) => v.name === keepInst.volumeName)).toBe(true);
      expect(stateful.volumes.some((v) => v.name === 'droidforge-api-data')).toBe(true);
    } finally {
      await app.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('preserves volume when removeVolume=false&prune=true and skips prune when prune=false', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'droidforge-prune-flags-'));
    const stateful = createStatefulMockDocker({
      volumes: [
        {
          name: 'redroid-data-orphan99',
          driver: 'local',
          mountpoint: '/var/lib/docker/volumes/redroid-data-orphan99/_data',
          labels: { 'droidforge.managed': 'true' },
          sizeBytes: 5000,
          refCount: 0,
        },
      ],
    });
    const env = loadEnv({ NODE_ENV: 'test', REQUIRE_AUTH: 'false', DATA_DIR: tempDir });
    const { app } = await buildApp({ env, docker: stateful.docker, adb: await createMockAdb(true) });

    try {
      const c1 = await app.inject({
        method: 'POST',
        url: '/api/v1/instances',
        payload: { name: 'keep-vol-inst', autoStart: false },
      });
      const inst1 = c1.json();

      // removeVolume=false & prune=true must NOT delete inst1.volumeName, while still pruning orphan99
      const d1 = await app.inject({
        method: 'DELETE',
        url: `/api/v1/instances/${inst1.id}?removeVolume=false&prune=true`,
      });
      expect(d1.statusCode).toBe(200);
      expect(d1.json().removedVolume).toBe(false);
      expect(stateful.volumes.some((v) => v.name === inst1.volumeName)).toBe(true);
      expect(stateful.volumes.some((v) => v.name === 'redroid-data-orphan99')).toBe(false);

      // Re-seed an orphan and test prune=false
      stateful.volumes.push({
        name: 'redroid-data-orphan88',
        driver: 'local',
        mountpoint: '/var/lib/docker/volumes/redroid-data-orphan88/_data',
        labels: { 'droidforge.managed': 'true' },
        sizeBytes: 4000,
        refCount: 0,
      });

      const c2 = await app.inject({
        method: 'POST',
        url: '/api/v1/instances',
        payload: { name: 'no-prune-inst', autoStart: false },
      });
      const inst2 = c2.json();

      const d2 = await app.inject({
        method: 'DELETE',
        url: `/api/v1/instances/${inst2.id}?prune=false`,
      });
      expect(d2.statusCode).toBe(200);
      expect(d2.json().removedVolume).toBe(true);
      expect(d2.json().prune).toBeNull();
      expect(stateful.volumes.some((v) => v.name === inst2.volumeName)).toBe(false);
      expect(stateful.volumes.some((v) => v.name === 'redroid-data-orphan88')).toBe(true);
    } finally {
      await app.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('supports dry-run preview, selective manual prune, opt-in images/build cache, protected files, and snapshot deletion', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'droidforge-prune-manual-'));
    const stateful = createStatefulMockDocker({
      images: [
        {
          id: 'sha256:redroid11',
          repoTags: ['redroid/redroid:11.0.0-latest'],
          sizeBytes: 800_000,
          dangling: false,
          containers: 0,
        },
        {
          id: 'sha256:redroid13',
          repoTags: ['redroid/redroid:13.0.0-latest'],
          sizeBytes: 900_000,
          dangling: false,
          containers: 1,
        },
        {
          id: 'sha256:dangling2',
          repoTags: [],
          sizeBytes: 100_000,
          dangling: true,
          containers: 0,
        },
      ],
      buildCacheBytes: 250_000,
    });

    const env = loadEnv({ NODE_ENV: 'test', REQUIRE_AUTH: 'false', DATA_DIR: tempDir });
    const { app } = await buildApp({ env, docker: stateful.docker, adb: await createMockAdb(true) });

    try {
      // Seed protected root DB and ADB key files inside DATA_DIR
      const dbFile = path.join(tempDir, 'droidforge.db');
      const androidDir = path.join(tempDir, '.android');
      fs.mkdirSync(androidDir, { recursive: true });
      const adbKey = path.join(androidDir, 'adbkey');
      fs.writeFileSync(dbFile, 'sqlite-bytes');
      fs.writeFileSync(adbKey, 'private-adb-key');

      const created = await app.inject({
        method: 'POST',
        url: '/api/v1/instances',
        payload: { name: 'active-prune-test', androidVersion: '13', autoStart: false },
      });
      const inst = created.json();

      // Create snapshot & test DELETE snapshot endpoint
      const snapRes = await app.inject({
        method: 'POST',
        url: `/api/v1/instances/${inst.id}/snapshots`,
        payload: { name: 'snap-to-delete' },
      });
      const snap = snapRes.json();
      expect(fs.existsSync(snap.filePath)).toBe(true);

      const delSnapRes = await app.inject({
        method: 'DELETE',
        url: `/api/v1/instances/${inst.id}/snapshots/${snap.id}`,
      });
      expect(delSnapRes.statusCode).toBe(200);
      expect(delSnapRes.json().deleted).toBe(true);
      expect(delSnapRes.json().reclaimedBytes).toBeGreaterThan(0);
      expect(fs.existsSync(snap.filePath)).toBe(false);

      const listSnapsAfter = await app.inject({
        method: 'GET',
        url: `/api/v1/instances/${inst.id}/snapshots`,
      });
      expect(listSnapsAfter.json()).toHaveLength(0);

      // Start an active recording and write bytes to its local file path
      const recStartRes = await app.inject({
        method: 'POST',
        url: `/api/v1/instances/${inst.id}/screen/record/start`,
      });
      const recJob = recStartRes.json();
      const activeRecPath = path.join(tempDir, 'recordings', `${inst.id}_${recJob.jobId}.mp4`);
      fs.writeFileSync(activeRecPath, Buffer.alloc(1200, 5));

      // Seed orphaned snapshot, orphaned recording, and stale download
      const snapDir = path.join(tempDir, 'snapshots');
      const recDir = path.join(tempDir, 'recordings');
      const dlDir = path.join(tempDir, 'downloads');
      fs.mkdirSync(snapDir, { recursive: true });
      fs.mkdirSync(dlDir, { recursive: true });

      const orphanSnapPath = path.join(snapDir, 'dead1234_snap_abcd.tar.gz');
      const orphanRecPath = path.join(recDir, 'dead1234_rec_abcd.mp4');
      const staleDlPath = path.join(dlDir, 'old-pull.bin');
      const freshDlPath = path.join(dlDir, 'active-pull.bin');
      fs.writeFileSync(orphanSnapPath, Buffer.alloc(3000, 6));
      fs.writeFileSync(orphanRecPath, Buffer.alloc(4000, 7));
      fs.writeFileSync(staleDlPath, Buffer.alloc(5000, 8));
      fs.writeFileSync(freshDlPath, Buffer.alloc(900, 9));
      const oldTime = new Date(Date.now() - 120_000);
      fs.utimesSync(staleDlPath, oldTime, oldTime);

      // 1. Dry-run preview (without unused images / build cache)
      const previewRes = await app.inject({ method: 'GET', url: '/api/v1/system/prune/preview' });
      expect(previewRes.statusCode).toBe(200);
      const preview = previewRes.json();
      expect(preview.dryRun).toBe(true);
      expect(preview.counts.orphanedSnapshots).toBe(1);
      expect(preview.counts.orphanedRecordings).toBe(1);
      expect(preview.counts.tempFiles).toBe(1);
      expect(preview.counts.danglingImages).toBe(1);
      expect(preview.counts.unusedImages).toBe(0);
      expect(preview.counts.buildCacheBytes).toBe(0);
      expect(preview.reclaimedBytes).toBe(3000 + 4000 + 5000 + 100_000);

      // Nothing deleted during dry-run preview
      expect(fs.existsSync(orphanSnapPath)).toBe(true);
      expect(fs.existsSync(orphanRecPath)).toBe(true);
      expect(fs.existsSync(staleDlPath)).toBe(true);
      expect(stateful.images.some((i) => i.id === 'sha256:dangling2')).toBe(true);

      // 2. Preview including unused images & build cache
      const fullPreviewRes = await app.inject({
        method: 'GET',
        url: '/api/v1/system/prune/preview?includeUnusedImages=true&includeBuildCache=true',
      });
      const fullPreview = fullPreviewRes.json();
      expect(fullPreview.counts.unusedImages).toBe(1);
      expect(fullPreview.counts.buildCacheBytes).toBe(250_000);

      // 3. Execute manual prune with opt-in unused Redroid images + build cache
      const pruneRes = await app.inject({
        method: 'POST',
        url: '/api/v1/system/prune',
        payload: {
          dryRun: false,
          removeUnusedRedroidImages: true,
          removeBuildCache: true,
        },
      });
      expect(pruneRes.statusCode).toBe(200);
      const pruneBody = pruneRes.json();
      expect(pruneBody.dryRun).toBe(false);
      expect(pruneBody.counts.orphanedSnapshots).toBe(1);
      expect(pruneBody.counts.orphanedRecordings).toBe(1);
      expect(pruneBody.counts.tempFiles).toBe(1);
      expect(pruneBody.counts.danglingImages).toBe(1);
      expect(pruneBody.counts.unusedImages).toBe(1);
      expect(pruneBody.counts.buildCacheBytes).toBe(250_000);
      expect(pruneBody.errors).toEqual([]);

      // Verify orphaned files + unused image + build cache removed
      expect(fs.existsSync(orphanSnapPath)).toBe(false);
      expect(fs.existsSync(orphanRecPath)).toBe(false);
      expect(fs.existsSync(staleDlPath)).toBe(false);
      expect(stateful.images.some((i) => i.id === 'sha256:dangling2')).toBe(false);
      expect(stateful.images.some((i) => i.id === 'sha256:redroid11')).toBe(false);

      // Verify active image, active recording, fresh temp file, DB, and ADB key remain untouched
      expect(stateful.images.some((i) => i.id === 'sha256:redroid13')).toBe(true);
      expect(fs.existsSync(activeRecPath)).toBe(true);
      expect(fs.existsSync(freshDlPath)).toBe(true);
      expect(fs.existsSync(dbFile)).toBe(true);
      expect(fs.existsSync(adbKey)).toBe(true);
    } finally {
      await app.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
