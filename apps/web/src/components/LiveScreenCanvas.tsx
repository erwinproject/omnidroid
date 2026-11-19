import React, { useEffect, useRef, useState } from 'react';
import type { AiSnapshotResponse, InstanceHealth, InstanceRecord } from '@droidforge/shared';
import { Camera, Home, Keyboard, Layers, Power, RefreshCw, RotateCw, Square, Undo2 } from 'lucide-react';
import { buildWsUrl, createClient } from '../api/client';

interface Props {
  instance: InstanceRecord;
  health: InstanceHealth | null;
  aiSnapshot: AiSnapshotResponse | null;
  aiSnapshotLoading: boolean;
  aiSnapshotError: string | null;
  showAiOverlay: boolean;
  onCaptureAiSnapshot: () => void;
  onToggleAiOverlay: () => void;
  onStartInstance: (id: string) => void;
  actionBusy: boolean;
}

export const LiveScreenCanvas: React.FC<Props> = ({
  instance,
  health,
  aiSnapshot,
  aiSnapshotLoading,
  aiSnapshotError,
  showAiOverlay,
  onCaptureAiSnapshot,
  onToggleAiOverlay,
  onStartInstance,
  actionBusy,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const dragStart = useRef<{ x: number; y: number; time: number; pointerId: number } | null>(null);

  const [streamStatus, setStreamStatus] = useState<'connecting' | 'live' | 'offline'>('connecting');
  const [hasFrame, setHasFrame] = useState(false);
  const [streamEpoch, setStreamEpoch] = useState(0);
  const [orientation, setOrientation] = useState<'portrait' | 'landscape'>('portrait');
  const [showTextBar, setShowTextBar] = useState(false);
  const [textInput, setTextInput] = useState('');
  const [sendingText, setSendingText] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [stageBounds, setStageBounds] = useState<{ maxW: number; maxH: number }>({ maxW: 360, maxH: 520 });

  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const update = () => {
      const w = Math.max(180, Math.floor(el.clientWidth - 32));
      const h = Math.max(220, Math.floor(el.clientHeight - 32));
      setStageBounds((prev) => (prev.maxW === w && prev.maxH === h ? prev : { maxW: w, maxH: h }));
    };
    update();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    setHasFrame(false);
    setFeedback(null);
    if (instance.status === 'stopped') {
      setStreamStatus('offline');
      wsRef.current = null;
      return;
    }

    setStreamStatus('connecting');
    const ws = new WebSocket(buildWsUrl(`/ws/instances/${instance.id}/stream?fps=8`));
    ws.binaryType = 'blob';
    wsRef.current = ws;

    ws.onopen = () => setStreamStatus('live');
    ws.onclose = () => setStreamStatus('offline');
    ws.onerror = () => setStreamStatus('offline');
    ws.onmessage = async (event) => {
      if (!(event.data instanceof Blob)) return;
      try {
        const bitmap = await createImageBitmap(event.data);
        const canvas = canvasRef.current;
        if (!canvas) {
          bitmap.close();
          return;
        }
        if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
          canvas.width = bitmap.width;
          canvas.height = bitmap.height;
        }
        const ctx = canvas.getContext('2d');
        ctx?.drawImage(bitmap, 0, 0);
        bitmap.close();
        setHasFrame(true);
      } catch {
        // Ignore transient decode failure on truncated frames
      }
    };

    return () => {
      ws.close();
      wsRef.current = null;
    };
  }, [instance.id, instance.status, streamEpoch]);

  function getNormalizedCoords(e: React.PointerEvent<HTMLCanvasElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, (e.clientX - rect.left) / Math.max(1, rect.width))),
      y: Math.max(0, Math.min(1, (e.clientY - rect.top) / Math.max(1, rect.height))),
    };
  }

  function handlePointerDown(e: React.PointerEvent<HTMLCanvasElement>) {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const pt = getNormalizedCoords(e);
    dragStart.current = { ...pt, time: Date.now(), pointerId: e.pointerId };
  }

  function handlePointerUp(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!dragStart.current || dragStart.current.pointerId !== e.pointerId) return;
    const start = dragStart.current;
    dragStart.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }

    const end = getNormalizedCoords(e);
    const dist = Math.hypot(end.x - start.x, end.y - start.y);
    const ws = wsRef.current;

    if (dist < 0.02) {
      if (ws?.readyState === 1) {
        ws.send(JSON.stringify({ type: 'tap', x: end.x, y: end.y }));
      } else {
        void createClient().input.tap(instance.id, { x: end.x, y: end.y, normalized: true });
      }
      setFeedback(`Tap ${Math.round(end.x * 100)}%, ${Math.round(end.y * 100)}%`);
    } else {
      const durationMs = Math.min(1000, Math.max(120, Date.now() - start.time));
      if (ws?.readyState === 1) {
        ws.send(
          JSON.stringify({
            type: 'swipe',
            x1: start.x,
            y1: start.y,
            x2: end.x,
            y2: end.y,
            durationMs,
          }),
        );
      } else {
        void createClient().input.swipe(instance.id, {
          x1: start.x,
          y1: start.y,
          x2: end.x,
          y2: end.y,
          durationMs,
          normalized: true,
        });
      }
      setFeedback(`Swipe ${durationMs} ms`);
    }
  }

  function handlePointerCancel() {
    dragStart.current = null;
  }

  async function sendKey(key: string) {
    try {
      if (wsRef.current?.readyState === 1) {
        wsRef.current.send(JSON.stringify({ type: 'keyevent', key }));
      } else {
        await createClient().input.keyevent(instance.id, key);
      }
      setFeedback(`Sent key ${key}`);
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : String(err));
    }
  }

  async function toggleRotation() {
    const next = orientation === 'portrait' ? 'landscape' : 'portrait';
    try {
      await createClient().device.rotation(instance.id, { mode: next });
      setOrientation(next);
      setFeedback(`Rotated ${next}`);
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : String(err));
    }
  }

  async function submitText(e: React.FormEvent) {
    e.preventDefault();
    if (!textInput.trim()) return;
    setSendingText(true);
    try {
      await createClient().input.text(instance.id, { text: textInput, clearFirst: false });
      setFeedback(`Typed "${textInput.slice(0, 24)}"`);
      setTextInput('');
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : String(err));
    } finally {
      setSendingText(false);
    }
  }

  const streamLabel =
    instance.status === 'stopped'
      ? 'Stopped'
      : streamStatus === 'live'
        ? 'Stream Live'
        : streamStatus === 'connecting'
          ? 'Connecting'
          : 'Disconnected';

  const streamBadgeClass =
    instance.status === 'stopped'
      ? 'bg-[var(--status-idle-bg)] text-[var(--status-idle-ink)]'
      : streamStatus === 'live'
        ? 'bg-[var(--status-ok-bg)] text-[var(--status-ok-ink)]'
        : 'bg-[var(--status-warn-bg)] text-[var(--status-warn-ink)]';

  return (
    <div className="nb-panel flex h-full min-h-0 flex-col justify-between gap-2.5 p-3 sm:p-4">
      <div className="flex flex-col gap-2 border-b-2 border-[var(--border)] pb-2.5 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className={`inline-block border-2 border-[var(--border)] px-2 py-0.5 text-xs font-extrabold ${streamBadgeClass}`}>
              {streamLabel}
            </span>
            <h2 className="truncate text-sm font-extrabold text-[var(--ink)] sm:text-base">
              {instance.name} · {instance.profile.brand} {instance.profile.model}
            </h2>
          </div>
          <div className="num mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs font-semibold text-[var(--ink-secondary)]">
            <span>Android {instance.androidVersion}</span>
            <span>
              {instance.width}x{instance.height}
            </span>
            {health && (
              <span>
                {health.bootCompleted ? 'Boot ready' : 'Booting'} ·{' '}
                {health.memoryUsageMb != null ? `${Math.round(health.memoryUsageMb)} MB RAM` : 'RAM idle'}
              </span>
            )}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={onCaptureAiSnapshot}
            disabled={aiSnapshotLoading || instance.status === 'stopped'}
            className="nb-btn nb-btn-primary"
          >
            <Layers className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span>{aiSnapshotLoading ? 'Capturing...' : 'AI SoM'}</span>
          </button>

          {aiSnapshot && (
            <button
              type="button"
              onClick={onToggleAiOverlay}
              className={`nb-btn ${showAiOverlay ? 'nb-btn-primary' : 'nb-btn-secondary'}`}
            >
              {showAiOverlay ? 'Live View' : 'Show SoM'}
            </button>
          )}

          <a
            href={`/api/v1/instances/${instance.id}/screen/screenshot?format=png`}
            target="_blank"
            rel="noreferrer"
            className="nb-btn nb-btn-secondary"
          >
            <Camera className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span>PNG</span>
          </a>
        </div>
      </div>

      {aiSnapshotError && (
        <div className="border-2 border-[var(--border)] bg-[var(--status-err-bg)] px-3 py-2 text-[13px] font-semibold text-[var(--status-err-ink)]">
          AI Snapshot failed: {aiSnapshotError}
        </div>
      )}

      <div ref={stageRef} className="flex min-h-0 flex-1 items-center justify-center p-1">
        <div className="nb-panel-elevated relative inline-flex max-h-full max-w-full items-center justify-center overflow-hidden bg-[var(--bg-terminal)] p-1.5 sm:p-2">
          {instance.status === 'stopped' ? (
            <div className="flex h-[320px] w-[240px] flex-col items-center justify-center gap-3 p-4 text-center text-[var(--ink-terminal)] sm:h-[420px] sm:w-[280px]">
              <div className="text-base font-extrabold">Instance Stopped</div>
              <p className="text-[13px] text-[#C6C6BD]">
                Boot {instance.name} to stream the Redroid display and accept touch input.
              </p>
              <button
                type="button"
                disabled={actionBusy}
                onClick={() => onStartInstance(instance.id)}
                className="nb-btn nb-btn-primary"
              >
                <Power className="h-4 w-4" aria-hidden="true" />
                {actionBusy ? 'Booting...' : 'Boot Instance'}
              </button>
            </div>
          ) : showAiOverlay && aiSnapshot ? (
            <img
              src={`data:${aiSnapshot.mimeType};base64,${aiSnapshot.annotatedImageBase64}`}
              alt={`AI Set-of-Marks overlay for ${instance.name}`}
              style={{ maxWidth: stageBounds.maxW, maxHeight: stageBounds.maxH }}
              className="block h-auto w-auto object-contain"
            />
          ) : (
            <div className="relative flex items-center justify-center">
              <canvas
                ref={canvasRef}
                width={360}
                height={780}
                onPointerDown={handlePointerDown}
                onPointerUp={handlePointerUp}
                onPointerCancel={handlePointerCancel}
                aria-label={`Live Android screen for ${instance.name}`}
                style={{ maxWidth: stageBounds.maxW, maxHeight: stageBounds.maxH }}
                className="block h-auto w-auto cursor-crosshair touch-none select-none bg-[var(--bg-terminal)]"
              />
              {!hasFrame && (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-[var(--bg-terminal)] p-4 text-center text-[var(--ink-terminal)]">
                  <div className="text-sm font-bold">
                    {streamStatus === 'connecting'
                      ? 'Connecting video stream...'
                      : streamStatus === 'live'
                        ? 'Awaiting first video frame...'
                        : 'Stream disconnected'}
                  </div>
                  <p className="max-w-[24ch] text-[13px] text-[#C6C6BD]">
                    {instance.status === 'booting'
                      ? 'Android SurfaceFlinger is booting. Video starts automatically when ready.'
                      : streamStatus === 'offline'
                        ? 'Reconnect WebSocket stream to resume live frames.'
                        : 'Live frames will render as soon as the next screen capture arrives.'}
                  </p>
                  {streamStatus === 'offline' && (
                    <button
                      type="button"
                      onClick={() => setStreamEpoch((n) => n + 1)}
                      className="nb-btn nb-btn-primary"
                    >
                      <RefreshCw className="h-4 w-4" aria-hidden="true" />
                      Reconnect
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="space-y-2 border-t-2 border-[var(--border)] pt-2.5">
        {showTextBar && (
          <form onSubmit={submitText} className="flex gap-2">
            <label htmlFor="live-text-inject" className="sr-only">
              Send text to Android device
            </label>
            <input
              id="live-text-inject"
              value={textInput}
              onChange={(e) => setTextInput(e.target.value)}
              placeholder="Type text to inject into focused Android field..."
              className="nb-input flex-1"
            />
            <button type="submit" disabled={sendingText || !textInput.trim()} className="nb-btn nb-btn-primary shrink-0">
              {sendingText ? 'Sending...' : 'Send'}
            </button>
          </form>
        )}

        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              onClick={() => void sendKey('BACK')}
              disabled={instance.status === 'stopped'}
              aria-label="Android Back"
              className="nb-btn nb-btn-secondary px-3"
            >
              <Undo2 className="h-4 w-4" aria-hidden="true" />
              <span className="hidden sm:inline">Back</span>
            </button>
            <button
              type="button"
              onClick={() => void sendKey('HOME')}
              disabled={instance.status === 'stopped'}
              aria-label="Android Home"
              className="nb-btn nb-btn-secondary px-3"
            >
              <Home className="h-4 w-4" aria-hidden="true" />
              <span className="hidden sm:inline">Home</span>
            </button>
            <button
              type="button"
              onClick={() => void sendKey('RECENTS')}
              disabled={instance.status === 'stopped'}
              aria-label="Android Recents"
              className="nb-btn nb-btn-secondary px-3"
            >
              <Square className="h-4 w-4" aria-hidden="true" />
              <span className="hidden sm:inline">Recents</span>
            </button>
            <button
              type="button"
              onClick={() => void toggleRotation()}
              disabled={instance.status === 'stopped'}
              aria-label={`Rotate screen to ${orientation === 'portrait' ? 'landscape' : 'portrait'}`}
              className="nb-btn nb-btn-secondary px-3"
            >
              <RotateCw className="h-4 w-4" aria-hidden="true" />
              <span className="hidden sm:inline">{orientation === 'portrait' ? 'Landscape' : 'Portrait'}</span>
            </button>
            <button
              type="button"
              onClick={() => setShowTextBar((v) => !v)}
              disabled={instance.status === 'stopped'}
              aria-expanded={showTextBar}
              className={`nb-btn px-3 ${showTextBar ? 'nb-btn-primary' : 'nb-btn-secondary'}`}
            >
              <Keyboard className="h-4 w-4" aria-hidden="true" />
              <span>Type</span>
            </button>
          </div>

          <div className="num text-xs font-semibold text-[var(--ink-muted)]">
            {feedback || `${instance.width}x${instance.height} @ ${instance.fps}fps`}
          </div>
        </div>
      </div>
    </div>
  );
};
