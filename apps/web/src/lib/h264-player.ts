import JMuxer from 'jmuxer';

const FRAME_CONFIG = 1;
const FRAME_KEY = 2;

export type H264Renderer = 'webcodecs' | 'mse';

export function pickRenderer(): H264Renderer {
  const secure = typeof window !== 'undefined' && window.isSecureContext;
  if (secure && typeof VideoDecoder !== 'undefined' && typeof EncodedVideoChunk !== 'undefined') {
    return 'webcodecs';
  }
  return 'mse';
}

interface PlayerOptions {
  renderer: H264Renderer;
  canvas: HTMLCanvasElement | null;
  video: HTMLVideoElement | null;
  onFrame: () => void;
}

function hex(n: number): string {
  return n.toString(16).padStart(2, '0');
}

/** Builds the `avc1.PPCCLL` codec string from the first SPS NAL found in an Annex-B buffer. */
function codecFromAnnexB(data: Uint8Array): string | null {
  for (let i = 0; i + 4 < data.length; i++) {
    const startCode3 = data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1;
    const startCode4 = data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 0 && data[i + 3] === 1;
    if (!startCode3 && !startCode4) continue;
    const nal = i + (startCode4 ? 4 : 3);
    if (nal + 3 < data.length && (data[nal] & 0x1f) === 7) {
      return `avc1.${hex(data[nal + 1])}${hex(data[nal + 2])}${hex(data[nal + 3])}`;
    }
  }
  return null;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function bytesEqual(a: Uint8Array | null, b: Uint8Array): boolean {
  if (!a || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Decodes the DroidForge H.264 WebSocket stream.
 * Packet layout: 1 flag byte (0 delta, 1 config/SPS+PPS, 2 key) followed by Annex-B data.
 * - webcodecs: hardware-friendly decoder drawing to a canvas (needs HTTPS/localhost)
 * - mse: jmuxer feeding a <video> element (works over plain HTTP)
 */
export class H264Player {
  private readonly opts: PlayerOptions;
  private decoder: VideoDecoder | null = null;
  private config: Uint8Array | null = null;
  private needKey = true;
  private latest: VideoFrame | null = null;
  private rafId = 0;
  private timestamp = 0;
  private jmuxer: JMuxer | null = null;
  private mseReady = false;
  private mseNeedsKey = true;
  private mseQueue: Uint8Array[] = [];
  private lastFeedMs = 0;
  private syncTimer: number | undefined;
  private destroyed = false;

  constructor(opts: PlayerOptions) {
    this.opts = opts;
    if (opts.renderer === 'mse' && opts.video) {
      this.jmuxer = new JMuxer({
        node: opts.video,
        mode: 'video',
        flushingTime: 0,
        fps: 60,
        maxDelay: 250,
        clearBuffer: true,
        debug: false,
        onReady: () => {
          if (this.destroyed) return;
          this.mseReady = true;
          this.flushMseQueue();
        },
        onError: () => {
          if (!this.destroyed) this.resetMse();
        },
      });
      opts.video.muted = true;
      void opts.video.play().catch(() => undefined);
      this.syncTimer = window.setInterval(() => this.catchUp(), 250);
    }
  }

  push(buffer: ArrayBuffer): void {
    if (this.destroyed || buffer.byteLength < 2) return;
    const view = new Uint8Array(buffer);
    const flag = view[0];
    const payload = view.subarray(1);

    if (this.opts.renderer === 'mse') {
      if (flag === FRAME_CONFIG) {
        const changed = this.config !== null && !bytesEqual(this.config, payload);
        this.config = payload.slice();
        if (changed) {
          this.resetMse();
        }
        return;
      }
      if (flag === FRAME_KEY) {
        this.mseNeedsKey = false;
        const data = this.config ? concat(this.config, payload) : payload.slice();
        if (!this.mseReady) {
          this.mseQueue = [data];
        } else {
          this.feedMse(data);
        }
        return;
      }
      if (this.mseNeedsKey) return;
      if (!this.mseReady) {
        if (this.mseQueue.length < 60) {
          this.mseQueue.push(payload.slice());
        } else {
          this.mseQueue = [];
          this.mseNeedsKey = true;
        }
      } else {
        this.feedMse(payload);
      }
      return;
    }

    if (flag === FRAME_CONFIG) {
      this.config = payload.slice();
      this.configureDecoder();
      this.needKey = true;
      return;
    }
    if (!this.decoder || this.decoder.state !== 'configured') return;
    if (this.needKey && flag !== FRAME_KEY) return;
    if (flag === FRAME_KEY) this.needKey = false;

    // Backlog guard: if the decoder is far behind, wait for the next keyframe.
    if (this.decoder.decodeQueueSize > 8 && flag !== FRAME_KEY) {
      this.needKey = true;
      return;
    }

    const data = flag === FRAME_KEY && this.config ? concat(this.config, payload) : payload;
    try {
      this.decoder.decode(
        new EncodedVideoChunk({
          type: flag === FRAME_KEY ? 'key' : 'delta',
          timestamp: (this.timestamp += 16666),
          data,
        }),
      );
    } catch {
      this.needKey = true;
    }
  }

  private feedMse(data: Uint8Array): void {
    const now = performance.now();
    const duration = this.lastFeedMs ? Math.max(16, Math.min(50, Math.round(now - this.lastFeedMs))) : 16;
    this.lastFeedMs = now;
    this.jmuxer?.feed({ video: data, duration, isLastVideoFrameComplete: true });
    this.opts.onFrame();
  }

  private flushMseQueue(): void {
    const queued = this.mseQueue;
    this.mseQueue = [];
    for (const pkt of queued) {
      this.feedMse(pkt);
    }
    void this.opts.video?.play().catch(() => undefined);
  }

  private resetMse(): void {
    this.mseReady = false;
    this.mseNeedsKey = true;
    this.mseQueue = [];
    this.lastFeedMs = 0;
    try {
      this.jmuxer?.reset();
    } catch {
      // ignore reset errors when MSE is closing
    }
  }

  private configureDecoder(): void {
    if (!this.config) return;
    const codec = codecFromAnnexB(this.config) ?? 'avc1.42E01F';
    if (this.decoder && this.decoder.state !== 'closed') {
      try {
        this.decoder.close();
      } catch {
        // already closed
      }
    }
    this.decoder = new VideoDecoder({
      output: (frame) => this.onDecoded(frame),
      error: () => {
        this.needKey = true;
      },
    });
    const cfg = {
      codec,
      optimizeForLatency: true,
      avc: { format: 'annexb' },
    } as VideoDecoderConfig;
    this.decoder.configure(cfg);
  }

  private onDecoded(frame: VideoFrame): void {
    if (this.destroyed) {
      frame.close();
      return;
    }
    if (this.latest) this.latest.close();
    this.latest = frame;
    if (!this.rafId) {
      this.rafId = requestAnimationFrame(() => this.draw());
    }
  }

  private draw(): void {
    this.rafId = 0;
    const frame = this.latest;
    this.latest = null;
    const canvas = this.opts.canvas;
    if (!frame) return;
    if (canvas) {
      const w = frame.displayWidth;
      const h = frame.displayHeight;
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      canvas.getContext('2d')?.drawImage(frame, 0, 0);
      this.opts.onFrame();
    }
    frame.close();
  }

  /** Keeps MSE playback close to the live edge to avoid accumulating latency. */
  private catchUp(): void {
    const video = this.opts.video;
    if (!video || video.buffered.length === 0) return;
    const end = video.buffered.end(video.buffered.length - 1);
    if (end - video.currentTime > 0.2) {
      video.currentTime = end - 0.03;
    }
    if (video.paused) void video.play().catch(() => undefined);
  }

  destroy(): void {
    this.destroyed = true;
    this.mseReady = false;
    this.mseQueue = [];
    if (this.rafId) cancelAnimationFrame(this.rafId);
    if (this.syncTimer) window.clearInterval(this.syncTimer);
    if (this.latest) this.latest.close();
    this.latest = null;
    if (this.decoder && this.decoder.state !== 'closed') {
      try {
        this.decoder.close();
      } catch {
        // ignore
      }
    }
    this.decoder = null;
    try {
      this.jmuxer?.destroy();
    } catch {
      // ignore
    }
    this.jmuxer = null;
  }
}
