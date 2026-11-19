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
  capturing: boolean;
}

export class StreamService {
  private readonly rooms = new Map<string, StreamRoom>();

  constructor(private readonly adb: AdbExecutor) {}

  subscribe(instance: InstanceRecord, ws: StreamSocket, fps = 8): void {
    let room = this.rooms.get(instance.id);
    if (!room) {
      room = {
        instance,
        clients: new Set<StreamSocket>(),
        capturing: false,
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
      if (room.timer) clearInterval(room.timer);
      this.rooms.delete(instanceId);
    }
  }

  stopInstance(instanceId: string): void {
    const room = this.rooms.get(instanceId);
    if (!room) return;
    if (room.timer) clearInterval(room.timer);
    for (const ws of room.clients) {
      ws.close();
    }
    this.rooms.delete(instanceId);
  }

  private startLoop(room: StreamRoom, fps: number): void {
    const intervalMs = Math.round(1000 / fps);
    room.timer = setInterval(async () => {
      if (room.capturing || room.clients.size === 0) return;
      room.capturing = true;
      try {
        const png = await this.adb.screencapPng(room.instance.adbTarget);
        const jpeg = await sharp(png).resize({ width: Math.min(room.instance.width, 540) }).jpeg({ quality: 72 }).toBuffer();
        for (const client of room.clients) {
          if (client.readyState === 1) {
            client.send(jpeg);
          }
        }
      } catch {
        // Instance may be booting or temporarily unreachable; skip frame
      } finally {
        room.capturing = false;
      }
    }, intervalMs);
  }

  stopAll(): void {
    for (const room of this.rooms.values()) {
      if (room.timer) clearInterval(room.timer);
      for (const ws of room.clients) {
        ws.close();
      }
    }
    this.rooms.clear();
  }
}
