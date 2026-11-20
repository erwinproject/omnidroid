import sharp from 'sharp';
import type { InstanceRecord } from '@droidforge/shared';
import type { AdbExecutor } from './adb.service.js';

export interface StreamSocket {
  readyState: number;
  send(data: Buffer | string): void;
  close(): void;
  on(event: 'close', listener: () => void): void;
}

interface StreamRoom {
  instance: InstanceRecord;
  clients: Set<StreamSocket>;
  timer?: NodeJS.Timeout;
  stopped: boolean;
}

interface Closable {
  stopInstance(instanceId: string): void;
  stopAll(): void;
}

function bufferedOf(ws: StreamSocket): number {
  return (ws as unknown as { bufferedAmount?: number }).bufferedAmount ?? 0;
}

/** JPEG polling stream. Used as a fallback when the H.264 encoder is unavailable. */
export class StreamService {
  private readonly rooms = new Map<string, StreamRoom>();

  private h264?: Closable;

  constructor(private readonly adb: AdbExecutor) {}

  /** Registers the H.264 streamer so lifecycle events (stop/delete) also close its sessions. */
  attachH264(h264: Closable): void {
    this.h264 = h264;
  }

  subscribe(instance: InstanceRecord, ws: StreamSocket, fps = 8): void {
    let room = this.rooms.get(instance.id);
    if (!room) {
      room = {
        instance,
        clients: new Set<StreamSocket>(),
        stopped: false,
      };
      this.rooms.set(instance.id, room);
      this.startLoop(room, Math.max(1, Math.min(20, fps)));
    }
    room.clients.add(ws);

    ws.on('close', () => {
      this.unsubscribe(instance.id, ws);
    });
  }

  unsubscribe(instanceId: string, ws: StreamSocket): void {
    const room = this.rooms.get(instanceId);
    if (!room) return;
    room.clients.delete(ws);
    if (room.clients.size === 0) {
      this.haltRoom(room);
      this.rooms.delete(instanceId);
    }
  }

  stopInstance(instanceId: string): void {
    this.h264?.stopInstance(instanceId);
    const room = this.rooms.get(instanceId);
    if (!room) return;
    this.haltRoom(room);
    for (const ws of room.clients) {
      ws.close();
    }
    this.rooms.delete(instanceId);
  }

  private haltRoom(room: StreamRoom): void {
    room.stopped = true;
    if (room.timer) clearTimeout(room.timer);
  }

  /** Sequential capture loop: the next frame is scheduled only after the previous one finished. */
  private startLoop(room: StreamRoom, fps: number): void {
    const intervalMs = Math.round(1000 / fps);
    const tick = async (): Promise<void> => {
      if (room.stopped) return;
      const started = Date.now();
      const busy = [...room.clients].some((c) => bufferedOf(c) > 1024 * 1024);
      if (room.clients.size > 0 && !busy) {
        try {
          const png = await this.adb.screencapPng(room.instance.adbTarget);
          const jpeg = await sharp(png)
            .resize({ width: Math.min(room.instance.width, 540) })
            .jpeg({ quality: 70 })
            .toBuffer();
          for (const client of room.clients) {
            if (client.readyState === 1) client.send(jpeg);
          }
        } catch {
          // Instance may be booting or temporarily unreachable; skip frame
        }
      }
      if (room.stopped) return;
      room.timer = setTimeout(() => void tick(), Math.max(0, intervalMs - (Date.now() - started)));
    };
    room.timer = setTimeout(() => void tick(), 0);
  }

  stopAll(): void {
    this.h264?.stopAll();
    for (const room of this.rooms.values()) {
      this.haltRoom(room);
      for (const ws of room.clients) {
        ws.close();
      }
    }
    this.rooms.clear();
  }
}
