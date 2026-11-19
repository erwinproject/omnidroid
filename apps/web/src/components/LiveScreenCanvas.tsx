import React, { useEffect, useRef, useState } from 'react';
import type { AiSnapshotResponse, InstanceRecord } from '@droidforge/shared';
import { Camera, Home, Layers, RotateCw, Square, Undo2 } from 'lucide-react';
import { buildWsUrl, createClient } from '../api/client';

interface Props {
  instance: InstanceRecord;
  aiSnapshot: AiSnapshotResponse | null;
  showAiOverlay: boolean;
  onCaptureAiSnapshot: () => void;
  onToggleAiOverlay: () => void;
}

export const LiveScreenCanvas: React.FC<Props> = ({
  instance,
  aiSnapshot,
  showAiOverlay,
  onCaptureAiSnapshot,
  onToggleAiOverlay,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const dragStart = useRef<{ x: number; y: number; time: number } | null>(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const ws = new WebSocket(buildWsUrl(`/ws/instances/${instance.id}/stream?fps=8`));
    ws.binaryType = 'blob';
    wsRef.current = ws;

    ws.onopen = () => setConnected(true);
    ws.onclose = () => setConnected(false);
    ws.onmessage = async (event) => {
      if (!(event.data instanceof Blob)) return;
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
    };

    return () => {
      ws.close();
      wsRef.current = null;
    };
  }, [instance.id]);

  function getNormalizedCoords(e: React.MouseEvent<HTMLCanvasElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)),
      y: Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height)),
    };
  }

  function handleMouseDown(e: React.MouseEvent<HTMLCanvasElement>) {
    const pt = getNormalizedCoords(e);
    dragStart.current = { ...pt, time: Date.now() };
  }

  function handleMouseUp(e: React.MouseEvent<HTMLCanvasElement>) {
    if (!dragStart.current || !wsRef.current || wsRef.current.readyState !== 1) return;
    const end = getNormalizedCoords(e);
    const start = dragStart.current;
    dragStart.current = null;

    const dist = Math.hypot(end.x - start.x, end.y - start.y);
    if (dist < 0.02) {
      wsRef.current.send(JSON.stringify({ type: 'tap', x: end.x, y: end.y }));
    } else {
      wsRef.current.send(
        JSON.stringify({
          type: 'swipe',
          x1: start.x,
          y1: start.y,
          x2: end.x,
          y2: end.y,
          durationMs: Math.min(1000, Math.max(120, Date.now() - start.time)),
        }),
      );
    }
  }

  function sendKey(key: string) {
    if (wsRef.current?.readyState === 1) {
      wsRef.current.send(JSON.stringify({ type: 'keyevent', key }));
    } else {
      void createClient().input.keyevent(instance.id, key);
    }
  }

  return (
    <div className="flex h-full flex-col items-center justify-between gap-3 p-4">
      <div className="flex w-full items-center justify-between rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-xs">
        <div className="flex items-center gap-2">
          <span className={`h-2 w-2 rounded-full ${connected ? 'bg-emerald-400' : 'bg-amber-500'}`} />
          <span className="font-medium text-zinc-200">
            {instance.name} — {instance.profile.brand} {instance.profile.model}
          </span>
          <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-zinc-400">
            Android {instance.androidVersion}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            onClick={onCaptureAiSnapshot}
            className="flex items-center gap-1 rounded bg-emerald-600/20 px-2 py-1 text-emerald-300 hover:bg-emerald-600/30"
          >
            <Layers className="h-3.5 w-3.5" />
            AI SoM Snapshot
          </button>
          {aiSnapshot && (
            <button
              onClick={onToggleAiOverlay}
              className={`rounded px-2 py-1 ${showAiOverlay ? 'bg-amber-500 text-zinc-950 font-medium' : 'bg-zinc-800 text-zinc-300'}`}
            >
              {showAiOverlay ? 'Live View' : 'Show SoM'}
            </button>
          )}
          <a
            href={`/api/v1/instances/${instance.id}/screen/screenshot?format=png`}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1 rounded bg-zinc-800 px-2 py-1 text-zinc-200 hover:bg-zinc-700"
          >
            <Camera className="h-3.5 w-3.5" />
            PNG
          </a>
        </div>
      </div>

      <div className="relative flex flex-1 items-center justify-center overflow-hidden rounded-2xl border-4 border-zinc-800 bg-black shadow-2xl">
        {showAiOverlay && aiSnapshot ? (
          <img
            src={`data:${aiSnapshot.mimeType};base64,${aiSnapshot.annotatedImageBase64}`}
            alt="AI Set-of-Marks Snapshot"
            className="max-h-[68vh] w-auto object-contain"
          />
        ) : (
          <canvas
            ref={canvasRef}
            width={360}
            height={780}
            onMouseDown={handleMouseDown}
            onMouseUp={handleMouseUp}
            className="max-h-[68vh] w-auto cursor-crosshair select-none bg-zinc-950"
          />
        )}
      </div>

      <div className="flex items-center gap-2 rounded-full border border-zinc-800 bg-zinc-900 px-4 py-1.5">
        <button onClick={() => sendKey('BACK')} title="Back" className="rounded-full p-2 text-zinc-300 hover:bg-zinc-800 hover:text-white">
          <Undo2 className="h-4 w-4" />
        </button>
        <button onClick={() => sendKey('HOME')} title="Home" className="rounded-full p-2 text-zinc-300 hover:bg-zinc-800 hover:text-white">
          <Home className="h-4 w-4" />
        </button>
        <button onClick={() => sendKey('RECENTS')} title="Recents" className="rounded-full p-2 text-zinc-300 hover:bg-zinc-800 hover:text-white">
          <Square className="h-4 w-4" />
        </button>
        <button
          onClick={() => void createClient().device.rotation(instance.id, { mode: 'landscape' })}
          title="Rotate Landscape"
          className="rounded-full p-2 text-zinc-300 hover:bg-zinc-800 hover:text-white"
        >
          <RotateCw className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
};
