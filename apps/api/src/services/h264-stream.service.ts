import fs from 'node:fs';
import net from 'node:net';
import type { ChildProcess } from 'node:child_process';
import type { InstanceRecord } from '@droidforge/shared';
import type { AppEnv } from '../config/env.js';
import type { AdbExecutor } from './adb.service.js';
import type { StreamSocket } from './stream.service.js';

/** Frame flag byte prepended to every binary packet sent to clients. */
export const FRAME_DELTA = 0;
export const FRAME_CONFIG = 1;
export const FRAME_KEY = 2;

const REMOTE_JAR = '/data/local/tmp/scrcpy-server.jar';
const START_TIMEOUT_MS = 12000;
const MAX_GOP_FRAMES = 900;
const MAX_CLIENT_BUFFER = 4 * 1024 * 1024;

interface H264Room {
  instance: InstanceRecord;
  clients: Set<StreamSocket>;
  waitingKey: Set<StreamSocket>;
  proc?: ChildProcess;
  sock?: net.Socket;
  connectingSock?: net.Socket;
  localPort?: number;
  width: number;
  height: number;
  config?: Buffer;
  gop: Buffer[];
  ready: Promise<void>;
  isReady: boolean;
  closed: boolean;
  framesSent: number;
}

export interface StreamCheckResult {
  jarPresent: boolean;
  adbForwardSupported: boolean;
  started: boolean;
  firstFrameMs: number | null;
  width: number | null;
  height: number | null;
  error: string | null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function bufferedAmount(ws: StreamSocket): number {
  return (ws as unknown as { bufferedAmount?: number }).bufferedAmount ?? 0;
}

/**
 * Streams the Android display as H.264 using scrcpy-server (video only, no control channel).
 * One encoder session per instance is shared between every connected client.
 */
export class H264StreamService {
  private readonly rooms = new Map<string, H264Room>();

  constructor(
    private readonly adb: AdbExecutor,
    private readonly env: AppEnv,
  ) {}

  isSupported(): boolean {
    return Boolean(this.adb.forward && this.adb.spawnShell && fs.existsSync(this.env.SCRCPY_SERVER_PATH));
  }

  /** Subscribes a client; rejects when H.264 cannot be started so the caller can fall back to JPEG. */
  async subscribe(instance: InstanceRecord, ws: StreamSocket): Promise<void> {
    let room = this.rooms.get(instance.id);
    if (!room || room.closed) {
      room = this.createRoom(instance);
      this.rooms.set(instance.id, room);
    }
    const current = room;
    current.clients.add(ws);
    ws.on('close', () => this.unsubscribe(instance.id, ws));

    try {
      await current.ready;
    } catch (err) {
      current.clients.delete(ws);
      throw err;
    }
    if (ws.readyState !== 1 || current.closed) return;
    this.sendInit(current, ws);
  }

  unsubscribe(instanceId: string, ws: StreamSocket): void {
    const room = this.rooms.get(instanceId);
    if (!room) return;
    room.clients.delete(ws);
    room.waitingKey.delete(ws);
    if (room.clients.size === 0) {
      this.teardown(room);
    }
  }

  stopInstance(instanceId: string): void {
    const room = this.rooms.get(instanceId);
    if (!room) return;
    for (const ws of room.clients) ws.close();
    this.teardown(room);
  }

  stopAll(): void {
    for (const room of [...this.rooms.values()]) {
      for (const ws of room.clients) ws.close();
      this.teardown(room);
    }
  }

  /** Diagnostic: starts an encoder session and reports time to first frame. */
  async check(instance: InstanceRecord): Promise<StreamCheckResult> {
    const result: StreamCheckResult = {
      jarPresent: fs.existsSync(this.env.SCRCPY_SERVER_PATH),
      adbForwardSupported: Boolean(this.adb.forward && this.adb.spawnShell),
      started: false,
      firstFrameMs: null,
      width: null,
      height: null,
      error: null,
    };
    if (!result.jarPresent || !result.adbForwardSupported) {
      result.error = !result.jarPresent
        ? `scrcpy-server not found at ${this.env.SCRCPY_SERVER_PATH}`
        : 'ADB executor lacks forward/spawnShell support';
      return result;
    }

    const started = Date.now();
    const probe: StreamSocket = {
      readyState: 1,
      send: () => undefined,
      close: () => undefined,
      on: () => undefined,
    };
    try {
      const existing = this.rooms.get(instance.id);
      const room = existing ?? this.createRoom(instance);
      if (!existing) this.rooms.set(instance.id, room);
      room.clients.add(probe);
      try {
        await room.ready;
        result.started = true;
        result.width = room.width;
        result.height = room.height;
        const deadline = Date.now() + 8000;
        while (room.framesSent === 0 && Date.now() < deadline) await sleep(50);
        result.firstFrameMs = room.framesSent > 0 ? Date.now() - started : null;
        if (room.framesSent === 0) result.error = 'Encoder started but no frame received (screen may be static)';
      } finally {
        room.clients.delete(probe);
        if (room.clients.size === 0) this.teardown(room);
      }
    } catch (err) {
      result.error = err instanceof Error ? err.message : String(err);
    }
    return result;
  }

  private createRoom(instance: InstanceRecord): H264Room {
    const room: H264Room = {
      instance,
      clients: new Set(),
      waitingKey: new Set(),
      width: instance.width,
      height: instance.height,
      gop: [],
      ready: Promise.resolve(),
      isReady: false,
      closed: false,
      framesSent: 0,
    };
    room.ready = this.start(room).catch((err) => {
      this.teardown(room);
      throw err;
    });
    // Avoid unhandled rejection when no client awaits the promise.
    room.ready.catch(() => undefined);
    return room;
  }

  private async start(room: H264Room): Promise<void> {
    const adb = this.adb;
    const target = room.instance.adbTarget;
    if (!adb.forward || !adb.spawnShell) throw new Error('ADB executor does not support streaming');
    if (!fs.existsSync(this.env.SCRCPY_SERVER_PATH)) {
      throw new Error(`scrcpy-server not found at ${this.env.SCRCPY_SERVER_PATH}`);
    }

    await adb.shell(target, 'pkill -f com.genymobile.scrcpy.Server || true', 4000).catch(() => undefined);
    const pushed = await adb.pushFile(target, this.env.SCRCPY_SERVER_PATH, REMOTE_JAR);
    if (pushed.exitCode !== 0) throw new Error(pushed.stderr || 'Failed to push scrcpy-server');
    if (room.closed) throw new Error('Stream closed');

    const maxFps = Math.max(15, Math.min(60, room.instance.fps || 60));
    const args = [
      this.env.SCRCPY_VERSION,
      'log_level=warn',
      'audio=false',
      'control=false',
      'video_codec=h264',
      'video_codec_options=i-frame-interval=2',
      `max_size=${this.env.STREAM_MAX_SIZE}`,
      `max_fps=${maxFps}`,
      `video_bit_rate=${this.env.STREAM_BITRATE}`,
      'tunnel_forward=true',
      'send_device_meta=false',
      'send_codec_meta=true',
      'send_frame_meta=true',
      'send_dummy_byte=true',
      'cleanup=false',
      'power_on=false',
    ];
    const proc = adb.spawnShell(
      target,
      `CLASSPATH=${REMOTE_JAR} app_process / com.genymobile.scrcpy.Server ${args.join(' ')}`,
    );
    room.proc = proc;

    let procError = '';
    proc.stderr?.on('data', (d: Buffer) => {
      procError = (procError + d.toString('utf8')).slice(-600);
    });
    proc.stdout?.on('data', (d: Buffer) => {
      procError = (procError + d.toString('utf8')).slice(-600);
    });
    const exited = new Promise<never>((_, reject) => {
      proc.on('exit', (code) => {
        if (!room.isReady) {
          reject(new Error(`scrcpy-server exited (${String(code)}): ${procError.trim() || 'no output'}`));
        } else {
          this.endRoom(room);
        }
      });
      proc.on('error', (err) => reject(err));
    });
    exited.catch(() => undefined);

    room.localPort = await adb.forward(target, 'localabstract:scrcpy');
    if (room.closed) throw new Error('Stream closed');

    const connect = this.connectAndParse(room);
    const timeout = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('Timed out waiting for scrcpy video stream')), START_TIMEOUT_MS).unref();
    });
    await Promise.race([connect, exited, timeout]);
    room.isReady = true;
  }

  private async connectAndParse(room: H264Room): Promise<void> {
    const port = room.localPort;
    if (!port) throw new Error('No forwarded port');

    for (let attempt = 0; attempt < 60 && !room.closed; attempt++) {
      const ok = await this.tryConnect(room, port);
      if (ok) return;
      await sleep(200);
    }
    throw new Error('Could not connect to scrcpy-server');
  }

  /** Returns true when the codec header was received; false if the socket closed first. */
  private tryConnect(room: H264Room, port: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const sock = net.connect({ host: '127.0.0.1', port });
      room.connectingSock = sock;
      sock.setNoDelay(true);
      let buf: Buffer = Buffer.alloc(0);
      let stage: 'dummy' | 'meta' | 'frames' = 'dummy';
      let settled = false;

      const finish = (value: boolean) => {
        if (settled) return;
        settled = true;
        if (room.connectingSock === sock) room.connectingSock = undefined;
        resolve(value);
      };

      sock.on('data', (chunk: Buffer) => {
        buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);
        for (;;) {
          if (stage === 'dummy') {
            if (buf.length < 1) return;
            buf = buf.subarray(1);
            stage = 'meta';
          } else if (stage === 'meta') {
            if (buf.length < 12) return;
            room.width = buf.readUInt32BE(4) || room.width;
            room.height = buf.readUInt32BE(8) || room.height;
            buf = buf.subarray(12);
            stage = 'frames';
            room.sock = sock;
            finish(true);
          } else {
            if (buf.length < 12) return;
            const ptsFlags = buf.readBigUInt64BE(0);
            const size = buf.readUInt32BE(8);
            if (buf.length < 12 + size) return;
            const payload = buf.subarray(12, 12 + size);
            buf = buf.subarray(12 + size);
            const isConfig = (ptsFlags & (1n << 63n)) !== 0n;
            const isKey = (ptsFlags & (1n << 62n)) !== 0n;
            this.onPacket(room, payload, isConfig, isKey);
          }
        }
      });
      sock.on('close', () => {
        if (!settled) {
          finish(false);
        } else if (!room.closed) {
          this.endRoom(room);
        }
      });
      sock.on('error', () => {
        sock.destroy();
        finish(false);
      });
    });
  }

  private onPacket(room: H264Room, payload: Buffer, isConfig: boolean, isKey: boolean): void {
    const flag = isConfig ? FRAME_CONFIG : isKey ? FRAME_KEY : FRAME_DELTA;
    const packet = Buffer.allocUnsafe(payload.length + 1);
    packet[0] = flag;
    payload.copy(packet, 1);

    if (isConfig) {
      room.config = packet;
      room.gop = [];
      // Resolution/orientation change: announce new size to everyone.
      if (room.isReady) {
        for (const ws of room.clients) {
          if (ws.readyState === 1) ws.send(this.configMessage(room));
          room.waitingKey.add(ws);
        }
      }
    } else if (isKey) {
      room.gop = [packet];
    } else if (room.gop.length > 0) {
      room.gop.push(packet);
      if (room.gop.length > MAX_GOP_FRAMES) room.gop.shift();
    }

    room.framesSent += isConfig ? 0 : 1;

    // Before the room is ready, clients get their init burst (config + GOP) from sendInit().
    if (!room.isReady) return;

    for (const ws of room.clients) {
      if (ws.readyState !== 1) continue;
      if (room.waitingKey.has(ws)) {
        if (isConfig) {
          ws.send(packet);
          continue;
        }
        if (!isKey) continue;
        room.waitingKey.delete(ws);
      }
      // Backpressure: a slow client waits for the next keyframe instead of building latency.
      if (bufferedAmount(ws) > MAX_CLIENT_BUFFER) {
        room.waitingKey.add(ws);
        continue;
      }
      ws.send(packet);
    }
  }

  private configMessage(room: H264Room): string {
    return JSON.stringify({ type: 'config', codec: 'h264', width: room.width, height: room.height });
  }

  private sendInit(room: H264Room, ws: StreamSocket): void {
    room.waitingKey.delete(ws);
    ws.send(this.configMessage(room));
    if (room.config) ws.send(room.config);
    if (room.gop.length > 0) {
      for (const frame of room.gop) ws.send(frame);
    } else {
      room.waitingKey.add(ws);
    }
  }

  private endRoom(room: H264Room): void {
    for (const ws of room.clients) ws.close();
    this.teardown(room);
  }

  private teardown(room: H264Room): void {
    if (room.closed) return;
    room.closed = true;
    if (this.rooms.get(room.instance.id) === room) this.rooms.delete(room.instance.id);
    room.connectingSock?.destroy();
    room.connectingSock = undefined;
    room.sock?.destroy();
    room.proc?.kill('SIGTERM');
    const target = room.instance.adbTarget;
    if (room.localPort && this.adb.removeForward) {
      void this.adb.removeForward(target, room.localPort).catch(() => undefined);
    }
    void this.adb.shell(target, 'pkill -f com.genymobile.scrcpy.Server || true', 4000).catch(() => undefined);
  }
}
