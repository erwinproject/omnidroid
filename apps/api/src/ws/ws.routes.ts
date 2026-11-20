import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';

export function registerWsRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/ws/instances/:id/stream', { websocket: true }, (socket, req) => {
    const { id } = req.params as { id: string };
    const { fps, mode = 'jpeg' } = req.query as { fps?: string; mode?: string };

    let inst;
    try {
      inst = ctx.orchestrator.requireInstance(id);
    } catch {
      socket.close(1008, 'Instance not found');
      return;
    }

    if (mode === 'h264') {
      ctx.h264.subscribe(inst, socket).catch((err: unknown) => {
        const reason = err instanceof Error ? err.message : String(err);
        if (socket.readyState === 1) {
          socket.send(JSON.stringify({ type: 'fallback', reason }));
          socket.close();
        }
      });
    } else {
      ctx.stream.subscribe(inst, socket, fps ? Number(fps) : 8);
    }

    // Bidirectional control messages from Web Dashboard
    socket.on('message', async (raw: Buffer | string) => {
      try {
        const msg = JSON.parse(raw.toString()) as {
          type: 'tap' | 'swipe' | 'keyevent' | 'text';
          x?: number;
          y?: number;
          x1?: number;
          y1?: number;
          x2?: number;
          y2?: number;
          durationMs?: number;
          key?: string | number;
          text?: string;
        };

        if (msg.type === 'tap' && msg.x !== undefined && msg.y !== undefined) {
          await ctx.input.tap(inst, { x: msg.x, y: msg.y, normalized: true });
        } else if (
          msg.type === 'swipe' &&
          msg.x1 !== undefined &&
          msg.y1 !== undefined &&
          msg.x2 !== undefined &&
          msg.y2 !== undefined
        ) {
          await ctx.input.swipe(inst, {
            x1: msg.x1,
            y1: msg.y1,
            x2: msg.x2,
            y2: msg.y2,
            durationMs: msg.durationMs ?? 250,
            normalized: true,
          });
        } else if (msg.type === 'keyevent' && msg.key !== undefined) {
          await ctx.input.keyevent(inst, msg.key);
        } else if (msg.type === 'text' && msg.text) {
          await ctx.input.text(inst, { text: msg.text, clearFirst: false });
        }
      } catch {
        // Ignore malformed control frames
      }
    });
  });

  app.get('/ws/instances/:id/logcat', { websocket: true }, (socket, req) => {
    const { id } = req.params as { id: string };
    const { level = 'V', tag = '*' } = req.query as { level?: string; tag?: string };

    let inst;
    try {
      inst = ctx.orchestrator.requireInstance(id);
    } catch {
      socket.close(1008, 'Instance not found');
      return;
    }

    const filterSpec = `${tag}:${level.toUpperCase()}`;
    const child = ctx.adb.spawnLogcat(inst.adbTarget, ['-s', filterSpec]);

    child.stdout?.on('data', (chunk: Buffer) => {
      if (socket.readyState === 1) {
        socket.send(chunk.toString('utf8'));
      }
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      if (socket.readyState === 1) {
        socket.send(`[stderr] ${chunk.toString('utf8')}`);
      }
    });

    socket.on('close', () => {
      child.kill('SIGTERM');
    });
  });
}
