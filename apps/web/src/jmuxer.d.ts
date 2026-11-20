declare module 'jmuxer' {
  interface JMuxerOptions {
    node: HTMLVideoElement | string;
    mode?: 'both' | 'video' | 'audio';
    flushingTime?: number;
    maxDelay?: number;
    fps?: number;
    clearBuffer?: boolean;
    debug?: boolean;
    onReady?: () => void;
    onError?: (data: unknown) => void;
  }

  export default class JMuxer {
    constructor(options: JMuxerOptions);
    feed(data: {
      video?: Uint8Array;
      audio?: Uint8Array;
      duration?: number;
      isLastVideoFrameComplete?: boolean;
    }): void;
    reset(): void;
    destroy(): void;
  }
}
