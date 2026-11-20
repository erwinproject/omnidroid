import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { describe, expect, it, vi } from 'vitest';
import type { InstanceRecord } from '@droidforge/shared';
import { buildApp } from '../app.js';
import { loadEnv } from '../config/env.js';
import type { RedroidDockerManager } from '../docker/redroid-docker.manager.js';
import { normalizeDevicePath, parseLsOutput, shQuote } from '../routes/files.routes.js';
import type { AdbExecutor } from '../services/adb.service.js';
import { detectPackageKind, installPackageFile } from '../services/apk-install.service.js';
import { FRAME_CONFIG, FRAME_DELTA, FRAME_KEY, H264StreamService } from '../services/h264-stream.service.js';
import { buildRootPolicyFile, parsePackagesList, parseSuAuditLog } from '../services/root.service.js';
import type { StreamSocket } from '../services/stream.service.js';

function mockDocker(): RedroidDockerManager {
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
    updateResources: vi.fn().mockResolvedValue(undefined),
    getContainerStats: vi.fn().mockResolvedValue({ running: true, cpuPercent: 1, memoryUsageMb: 1, memoryLimitMb: 2 }),
  } as unknown as RedroidDockerManager;
}

function mockAdb(overrides: Partial<AdbExecutor> = {}): AdbExecutor {
  return {
    connect: vi.fn().mockResolvedValue(true),
    disconnect: vi.fn().mockResolvedValue(undefined),
    shell: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' }),
    execOut: vi.fn(),
    screencapPng: vi.fn(),
    installApk: vi.fn().mockResolvedValue({ exitCode: 0, stdout: 'Success', stderr: '' }),
    installMultiple: vi.fn().mockResolvedValue({ exitCode: 0, stdout: 'Success', stderr: '' }),
    pushFile: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '1 file pushed', stderr: '' }),
    pullFile: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' }),
    isBootCompleted: vi.fn().mockResolvedValue(false),
    spawnLogcat: vi.fn().mockReturnValue({} as ChildProcess),
    ...overrides,
  } as AdbExecutor;
}

describe('File sharing helpers', () => {
  it('quotes shell paths and normalizes device paths', () => {
    expect(shQuote("it's here")).toBe(`'it'\\''s here'`);
    expect(normalizeDevicePath('/sdcard/Download/../DCIM/')).toBe('/sdcard/DCIM');
    expect(normalizeDevicePath(undefined)).toBe('/sdcard');
    expect(() => normalizeDevicePath('relative/path')).toThrow(/absolute/);
  });

  it('parses toybox ls -la output with spaces and symlinks, folders first', () => {
    const entries = parseLsOutput(
      [
        'total 16',
        'drwxrwx--x 2 u0_a1 media_rw 4096 2024-05-01 10:00 .',
        '-rw-rw---- 1 u0_a1 media_rw 2048 2024-05-01 10:01 my photo.jpg',
        'drwxrwx--x 3 u0_a1 media_rw 4096 2024-05-01 10:02 Pictures',
        'lrwxrwxrwx 1 root root 12 2024-05-01 10:03 link -> /storage/x',
      ].join('\n'),
    );
    expect(entries.map((e) => e.name)).toEqual(['link', 'Pictures', 'my photo.jpg']);
    expect(entries.find((e) => e.name === 'my photo.jpg')).toMatchObject({ isDir: false, size: 2048 });
  });
});

describe('Package installer', () => {
  it('detects supported package types', () => {
    expect(detectPackageKind('a.APK')).toBe('apk');
    expect(detectPackageKind('b.xapk')).toBe('bundle');
    expect(detectPackageKind('c.apks')).toBe('bundle');
    expect(detectPackageKind('d.exe')).toBeNull();
  });

  it('installs split bundles with install-multiple and pushes OBB files', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'df-apk-'));
    try {
      const zip = new AdmZip();
      zip.addFile('base.apk', Buffer.from('base'));
      zip.addFile('config.arm64_v8a.apk', Buffer.from('cfg'));
      zip.addFile('Android/obb/com.game.demo/main.1.com.game.demo.obb', Buffer.from('obbdata'));
      zip.addFile('../evil.apk', Buffer.from('zipslip'));
      const bundle = path.join(dir, 'game.xapk');
      zip.writeZip(bundle);

      const adb = mockAdb();
      const res = await installPackageFile(adb, 'target:5555', bundle, 'game.xapk', dir);
      expect(res.ok).toBe(true);
      expect(res.obbFiles).toBe(1);
      expect(adb.installMultiple).toHaveBeenCalledTimes(1);
      const apkPaths = (adb.installMultiple as ReturnType<typeof vi.fn>).mock.calls[0]![1] as string[];
      expect(apkPaths.length).toBe(3);
      for (const p of apkPaths) expect(path.resolve(p).startsWith(path.resolve(dir))).toBe(true);
      expect(adb.pushFile).toHaveBeenCalledWith(
        'target:5555',
        expect.any(String),
        '/sdcard/Android/obb/com.game.demo/main.1.com.game.demo.obb',
      );
      expect(fs.readdirSync(dir).filter((f) => f.startsWith('bundle_'))).toHaveLength(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports adb failures per file', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'df-apk-'));
    try {
      const apk = path.join(dir, 'x.apk');
      fs.writeFileSync(apk, 'x');
      const adb = mockAdb({
        installApk: vi.fn().mockResolvedValue({ exitCode: 1, stdout: '', stderr: 'INSTALL_FAILED_OLDER_SDK' }),
      });
      const res = await installPackageFile(adb, 't', apk, 'x.apk', dir);
      expect(res).toMatchObject({ ok: false, error: 'INSTALL_FAILED_OLDER_SDK' });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('Instance editing and file routes', () => {
  it('applies live edits without recreating and recreates the container for boot-time fields', async () => {
    const env = loadEnv({ NODE_ENV: 'test', REQUIRE_AUTH: 'false' });
    const docker = mockDocker();
    const adb = mockAdb();
    const { app } = await buildApp({ env, docker, adb });
    try {
      const created = await app.inject({
        method: 'POST',
        url: '/api/v1/instances',
        payload: { name: 'edit-me', autoStart: false },
      });
      expect(created.statusCode).toBe(201);
      const inst = created.json() as InstanceRecord;
      expect(docker.createContainer).toHaveBeenCalledTimes(1);

      const live = await app.inject({
        method: 'PATCH',
        url: `/api/v1/instances/${inst.id}`,
        payload: { name: 'renamed', memoryMb: 4096, dpi: 360 },
      });
      expect(live.statusCode).toBe(200);
      expect(live.json()).toMatchObject({ name: 'renamed', memoryMb: 4096, dpi: 360, bootConfigDirty: true });
      expect(docker.createContainer).toHaveBeenCalledTimes(1);

      const dup = await app.inject({ method: 'POST', url: '/api/v1/instances', payload: { name: 'other', autoStart: false } });
      const clash = await app.inject({
        method: 'PATCH',
        url: `/api/v1/instances/${(dup.json() as InstanceRecord).id}`,
        payload: { name: 'renamed' },
      });
      expect(clash.statusCode).toBe(500);
      expect(clash.json().error).toMatch(/already exists/);

      const reboot = await app.inject({
        method: 'PATCH',
        url: `/api/v1/instances/${inst.id}`,
        payload: { profileId: 'samsung-s23-ultra', fps: 60 },
      });
      expect(reboot.statusCode).toBe(200);
      const body = reboot.json() as InstanceRecord;
      expect(body.fps).toBe(60);
      expect(body.profile.id).toBe('samsung-s23-ultra');
      expect(body.profile.serialNo).toBe(inst.profile.serialNo); // identity preserved
      expect(body.bootConfigDirty).toBe(false);
      expect(body.containerId).toBe('mock-container-3');
      expect(docker.removeContainer).toHaveBeenCalledWith(expect.anything(), inst.volumeName, false, inst.containerName);

      const bad = await app.inject({ method: 'PATCH', url: `/api/v1/instances/${inst.id}`, payload: { cpus: 99 } });
      expect(bad.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('lists, creates folders and protects top-level paths', async () => {
    const env = loadEnv({ NODE_ENV: 'test', REQUIRE_AUTH: 'false' });
    const adb = mockAdb({
      shell: vi.fn().mockImplementation(async (_t: string, cmd: string) => ({
        exitCode: 0,
        stdout: cmd.startsWith('ls ') ? 'total 0\ndrwxrwx--x 2 u0 rw 4096 2024-01-01 10:00 Movies' : '',
        stderr: '',
      })),
    });
    const { app } = await buildApp({ env, docker: mockDocker(), adb });
    try {
      const created = await app.inject({ method: 'POST', url: '/api/v1/instances', payload: { name: 'files-1', autoStart: false } });
      const id = (created.json() as InstanceRecord).id;

      const list = await app.inject({ method: 'GET', url: `/api/v1/instances/${id}/files/list?path=/sdcard` });
      expect(list.json().entries).toEqual([expect.objectContaining({ name: 'Movies', isDir: true })]);

      const mk = await app.inject({ method: 'POST', url: `/api/v1/instances/${id}/files/mkdir`, payload: { path: "/sdcard/it's" } });
      expect(mk.statusCode).toBe(200);
      expect(adb.shell).toHaveBeenCalledWith(expect.any(String), `mkdir -p '/sdcard/it'\\''s'`);

      const del = await app.inject({ method: 'DELETE', url: `/api/v1/instances/${id}/files?path=/sdcard` });
      expect(del.statusCode).toBe(400);
      const rel = await app.inject({ method: 'GET', url: `/api/v1/instances/${id}/files/list?path=etc` });
      expect(rel.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });
});

describe('H.264 stream (scrcpy protocol)', () => {
  function frame(flags: bigint, payload: Buffer): Buffer {
    const head = Buffer.alloc(12);
    head.writeBigUInt64BE(flags, 0);
    head.writeUInt32BE(payload.length, 8);
    return Buffer.concat([head, payload]);
  }

  it('parses codec header and frames, caches config + GOP for late joiners', async () => {
    const jar = path.join(os.tmpdir(), `scrcpy-test-${process.pid}.jar`);
    fs.writeFileSync(jar, 'jar');

    const configPayload = Buffer.from([0, 0, 0, 1, 0x67, 0x42, 0xe0, 0x1f]);
    const keyPayload = Buffer.from([0, 0, 0, 1, 0x65, 1, 2, 3]);
    const deltaPayload = Buffer.from([0, 0, 0, 1, 0x41, 9, 9]);

    const server = net.createServer((sock) => {
      const meta = Buffer.alloc(12);
      meta.write('h264', 0, 'ascii');
      meta.writeUInt32BE(720, 4);
      meta.writeUInt32BE(1600, 8);
      const stream = Buffer.concat([
        Buffer.from([0]), // dummy byte
        meta,
        frame(1n << 63n, configPayload),
        frame(1n << 62n, keyPayload),
        frame(0n, deltaPayload),
      ]);
      // fragment to exercise the incremental parser
      sock.write(stream.subarray(0, 7));
      setTimeout(() => sock.write(stream.subarray(7)), 20);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as net.AddressInfo).port;

    const proc = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill: vi.fn(),
    }) as unknown as ChildProcess;
    const adb = mockAdb({
      forward: vi.fn().mockResolvedValue(port),
      removeForward: vi.fn().mockResolvedValue(undefined),
      spawnShell: vi.fn().mockReturnValue(proc),
    });
    const env = loadEnv({ NODE_ENV: 'test', SCRCPY_SERVER_PATH: jar });
    const svc = new H264StreamService(adb, env);
    const instance = { id: 'abc', adbTarget: 'redroid-abc:5555', width: 1080, height: 2400, fps: 30 } as InstanceRecord;

    const sent: Array<Buffer | string> = [];
    const ws: StreamSocket = {
      readyState: 1,
      send: (d) => sent.push(d),
      close: vi.fn(),
      on: () => undefined,
    };

    try {
      expect(svc.isSupported()).toBe(true);
      await svc.subscribe(instance, ws);

      expect(JSON.parse(sent[0] as string)).toEqual({ type: 'config', codec: 'h264', width: 720, height: 1600 });
      const bins = sent.slice(1) as Buffer[];
      expect(bins.map((b) => b[0])).toEqual([FRAME_CONFIG, FRAME_KEY, FRAME_DELTA]);
      expect(bins[0]!.subarray(1).equals(configPayload)).toBe(true);
      expect(bins[1]!.subarray(1).equals(keyPayload)).toBe(true);

      const shellArgs = (adb.spawnShell as ReturnType<typeof vi.fn>).mock.calls[0]![1] as string;
      expect(shellArgs).toContain('video_codec=h264');
      expect(shellArgs).toContain('control=false');
      expect(adb.pushFile).toHaveBeenCalledWith('redroid-abc:5555', jar, '/data/local/tmp/scrcpy-server.jar');

      // late joiner receives config + keyframe + deltas without a new encoder
      const late: Array<Buffer | string> = [];
      await svc.subscribe(instance, { readyState: 1, send: (d) => late.push(d), close: vi.fn(), on: () => undefined });
      expect(adb.spawnShell).toHaveBeenCalledTimes(1);
      expect((late.slice(1) as Buffer[]).map((b) => b[0])).toEqual([FRAME_CONFIG, FRAME_KEY, FRAME_DELTA]);
    } finally {
      svc.stopAll();
      server.close();
      fs.rmSync(jar, { force: true });
    }
  });

  it('rejects when scrcpy-server is missing so callers can fall back to JPEG', async () => {
    const env = loadEnv({ NODE_ENV: 'test', SCRCPY_SERVER_PATH: path.join(os.tmpdir(), 'missing-scrcpy.jar') });
    const svc = new H264StreamService(mockAdb({ forward: vi.fn(), spawnShell: vi.fn() }), env);
    const ws: StreamSocket = { readyState: 1, send: vi.fn(), close: vi.fn(), on: () => undefined };
    await expect(svc.subscribe({ id: 'x', adbTarget: 't', width: 1, height: 1, fps: 30 } as InstanceRecord, ws)).rejects.toThrow(
      /scrcpy-server not found/,
    );
  });
});

describe('Root access policy, API & live toggle', () => {
  it('parses packages.list, builds root policy files, and parses audit logs', () => {
    const { pkgToUid, uidToPkg } = parsePackagesList(
      [
        'com.example.alpha 10123 0 /data/user/0/com.example.alpha default:targetSdkVersion=33 none 0 0 1',
        'com.example.beta 10124 0 /data/user/0/com.example.beta default:targetSdkVersion=33 none 0 0 1',
      ].join('\n'),
    );
    expect(pkgToUid.get('com.example.alpha')).toBe(10123);
    expect(uidToPkg.get(10124)).toBe('com.example.beta');

    expect(buildRootPolicyFile({ enabled: false, mode: 'allow_all', adbRoot: true, allowedPackages: [] }, pkgToUid)).toBe(
      'mode=disabled\nadb_root=1\n',
    );
    expect(buildRootPolicyFile({ enabled: true, mode: 'allow_all', adbRoot: false, allowedPackages: [] }, pkgToUid)).toBe(
      'mode=allow_all\nadb_root=0\n',
    );
    expect(
      buildRootPolicyFile(
        {
          enabled: true,
          mode: 'allowlist',
          adbRoot: true,
          allowedPackages: ['com.example.alpha', 'com.missing.app', 'com.example.alpha'],
        },
        pkgToUid,
      ),
    ).toBe('mode=allowlist\nadb_root=1\nuid=10123\n');

    const logs = parseSuAuditLog(
      [
        '1700000001 10123 412 DENY id',
        '1700000002 2000 500 ALLOW -c whoami',
        '1700000003 10999 611 DENY sh',
      ].join('\n'),
      uidToPkg,
    );
    expect(logs).toHaveLength(3);
    expect(logs[0]).toMatchObject({ uid: 10999, packageName: null, allowed: false, command: 'sh' });
    expect(logs[1]).toMatchObject({ uid: 2000, packageName: 'com.android.shell', allowed: true });
    expect(logs[2]).toMatchObject({ uid: 10123, packageName: 'com.example.alpha', allowed: false, command: 'id' });
  });

  it('toggles root live without recreating, manages allowlist apps, and runs Root Shell', async () => {
    const fakeBin = path.join(os.tmpdir(), `df-su-test-${process.pid}`);
    fs.writeFileSync(fakeBin, '#!/bin/sh\necho ok\n');

    const docker = mockDocker();
    let rootOn = false;
    (docker.execInContainer as ReturnType<typeof vi.fn>).mockImplementation(async (_cid: string, cmd: string[]) => {
      const joined = cmd.join(' ');
      if (joined.includes('===DAEMON===')) {
        return {
          exitCode: 0,
          stdout: [
            '===DAEMON===',
            rootOn ? 'RUNNING' : 'STOPPED',
            '===SU_BIN===',
            rootOn ? 'PRESENT' : 'ABSENT',
            '===PKGS===',
            'com.example.app 10150 0 /data/user/0/com.example.app default none 0 0 1',
            '===LOG===',
            '1700000010 10150 999 DENY id',
          ].join('\n'),
          stderr: '',
        };
      }
      if (joined.includes('cp /data/adb/droidforge/df-su /system/bin/su')) {
        rootOn = true;
      }
      if (joined.includes('rm -f /system/bin/su /system/xbin/su')) {
        rootOn = false;
      }
      if (joined === 'sh -c id') {
        return { exitCode: 0, stdout: 'uid=0(root) gid=0(root)\n', stderr: '' };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    });

    const env = loadEnv({ NODE_ENV: 'test', REQUIRE_AUTH: 'false', DF_SU_BIN_PATH: fakeBin });
    const { app, ctx } = await buildApp({ env, docker, adb: mockAdb() });
    try {
      const created = await app.inject({
        method: 'POST',
        url: '/api/v1/instances',
        payload: { name: 'root-test', autoStart: false, enableRoot: false },
      });
      expect(created.statusCode).toBe(201);
      const inst = created.json() as InstanceRecord;
      expect(inst.enableRoot).toBe(false);
      expect(docker.createContainer).toHaveBeenCalledTimes(1);

      // Simulate running container state without launching background boot timer
      ctx.store.updateInstanceStatus(inst.id, 'running');

      // Root shell fails with 403 while Root is disabled
      const deniedShell = await app.inject({
        method: 'POST',
        url: `/api/v1/instances/${inst.id}/device/shell`,
        payload: { command: 'id', asRoot: true },
      });
      expect(deniedShell.statusCode).toBe(403);

      // Toggle Root ON via PATCH without recreating container
      const patched = await app.inject({
        method: 'PATCH',
        url: `/api/v1/instances/${inst.id}`,
        payload: { enableRoot: true },
      });
      expect(patched.statusCode).toBe(200);
      expect(patched.json()).toMatchObject({ enableRoot: true });
      expect(docker.createContainer).toHaveBeenCalledTimes(1);

      // Explicitly apply PUT /device/root and inspect status
      const enabled = await app.inject({
        method: 'PUT',
        url: `/api/v1/instances/${inst.id}/device/root`,
        payload: { enabled: true, mode: 'allowlist', adbRoot: true },
      });
      expect(enabled.statusCode).toBe(200);
      expect(enabled.json()).toMatchObject({
        enabled: true,
        mode: 'allowlist',
        adbRoot: true,
        daemonRunning: true,
        suBinaryPresent: true,
      });
      expect(docker.putFileToContainer).toHaveBeenCalled();

      // Grant & revoke app in allowlist
      const granted = await app.inject({
        method: 'POST',
        url: `/api/v1/instances/${inst.id}/device/root/apps`,
        payload: { packageName: 'com.example.app' },
      });
      expect(granted.statusCode).toBe(200);
      expect(granted.json().allowedPackages).toEqual(['com.example.app']);

      const status = await app.inject({ method: 'GET', url: `/api/v1/instances/${inst.id}/device/root` });
      expect(status.statusCode).toBe(200);
      expect(status.json().recentLogs[0]).toMatchObject({ packageName: 'com.example.app', allowed: false });

      const revoked = await app.inject({
        method: 'DELETE',
        url: `/api/v1/instances/${inst.id}/device/root/apps/com.example.app`,
      });
      expect(revoked.statusCode).toBe(200);
      expect(revoked.json().allowedPackages).toEqual([]);

      // Root shell succeeds when root is enabled
      const rootShell = await app.inject({
        method: 'POST',
        url: `/api/v1/instances/${inst.id}/device/shell`,
        payload: { command: 'id', asRoot: true },
      });
      expect(rootShell.statusCode).toBe(200);
      expect(rootShell.json().stdout).toContain('uid=0(root)');

      // Disable Root
      const disabled = await app.inject({
        method: 'PUT',
        url: `/api/v1/instances/${inst.id}/device/root`,
        payload: { enabled: false },
      });
      expect(disabled.statusCode).toBe(200);
      expect(disabled.json()).toMatchObject({ enabled: false, daemonRunning: false, suBinaryPresent: false });
    } finally {
      await app.close();
      fs.rmSync(fakeBin, { force: true });
    }
  });
});
