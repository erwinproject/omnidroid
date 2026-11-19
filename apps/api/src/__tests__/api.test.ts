import type { ChildProcess } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';
import { BUILTIN_DEVICE_PROFILES, parseProxyString } from '@droidforge/shared';
import { buildApp } from '../app.js';
import { loadEnv } from '../config/env.js';
import { buildRedroidBootArgs, type RedroidDockerManager } from '../docker/redroid-docker.manager.js';
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
