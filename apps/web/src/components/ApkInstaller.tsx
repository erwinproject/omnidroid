import React, { useRef, useState } from 'react';
import { Link2, Upload } from 'lucide-react';
import { getApiKey } from '../api/client';
import { formatBytes, uploadFiles } from '../lib/upload';

interface Props {
  instanceId: string;
  disabled?: boolean;
  onInstalled: () => void;
}

type ItemState = 'queued' | 'installing' | 'done' | 'failed';

interface QueueItem {
  id: number;
  name: string;
  size: number;
  state: ItemState;
  progress: number;
  message?: string;
}

const ACCEPT = '.apk,.xapk,.apks,.apkm';
let nextId = 1;

export const ApkInstaller: React.FC<Props> = ({ instanceId, disabled, onInstalled }) => {
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [url, setUrl] = useState('');
  const [urlBusy, setUrlBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const busy = queue.some((q) => q.state === 'queued' || q.state === 'installing') || urlBusy;
  const endpoint = `/api/v1/instances/${instanceId}/apps/install`;

  function patch(id: number, change: Partial<QueueItem>) {
    setQueue((prev) => prev.map((q) => (q.id === id ? { ...q, ...change } : q)));
  }

  async function installFiles(files: File[]) {
    if (disabled || files.length === 0) return;
    const items: QueueItem[] = files.map((f) => ({
      id: nextId++,
      name: f.name,
      size: f.size,
      state: 'queued',
      progress: 0,
    }));
    setQueue((prev) => [...items, ...prev].slice(0, 20));

    let anyOk = false;
    for (let i = 0; i < files.length; i++) {
      const file = files[i]!;
      const item = items[i]!;
      patch(item.id, { state: 'installing' });
      try {
        const res = await uploadFiles<{ results?: Array<{ ok: boolean; error?: string; obbFiles?: number }> }>(
          endpoint,
          [file],
          (p) => patch(item.id, { progress: Math.round((p.loaded / Math.max(1, p.total)) * 100) }),
        );
        const first = res.results?.[0];
        patch(item.id, {
          state: 'done',
          progress: 100,
          message: first?.obbFiles ? `Installed + ${first.obbFiles} OBB file(s)` : 'Installed',
        });
        anyOk = true;
      } catch (err) {
        patch(item.id, { state: 'failed', message: err instanceof Error ? err.message : String(err) });
      }
    }
    if (anyOk) onInstalled();
  }

  async function installFromUrl(e: React.FormEvent) {
    e.preventDefault();
    const target = url.trim();
    if (!target || disabled) return;
    const id = nextId++;
    const name = target.split('/').pop()?.split('?')[0] || target;
    setQueue((prev) => [{ id, name, size: 0, state: 'installing' as const, progress: 100 }, ...prev].slice(0, 20));
    setUrlBusy(true);
    try {
      const key = getApiKey();
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(key ? { 'X-API-Key': key } : {}) },
        body: JSON.stringify({ url: target }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      patch(id, { state: 'done', message: 'Installed from URL' });
      setUrl('');
      onInstalled();
    } catch (err) {
      patch(id, { state: 'failed', message: err instanceof Error ? err.message : String(err) });
    } finally {
      setUrlBusy(false);
    }
  }

  const stateClass: Record<ItemState, string> = {
    queued: 'bg-[var(--status-idle-bg)] text-[var(--status-idle-ink)]',
    installing: 'bg-[var(--status-warn-bg)] text-[var(--status-warn-ink)]',
    done: 'bg-[var(--status-ok-bg)] text-[var(--status-ok-ink)]',
    failed: 'bg-[var(--status-err-bg)] text-[var(--status-err-ink)]',
  };

  return (
    <div className="space-y-2.5">
      <div
        role="button"
        tabIndex={0}
        aria-disabled={disabled}
        onClick={() => !disabled && inputRef.current?.click()}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') inputRef.current?.click();
        }}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          void installFiles(Array.from(e.dataTransfer.files));
        }}
        className={`flex min-h-[72px] cursor-pointer flex-col items-center justify-center gap-1 border-2 border-dashed border-[var(--border)] p-3.5 text-center text-[13px] font-bold text-[var(--ink)] ${
          dragOver ? 'bg-[var(--accent)] text-[var(--accent-ink)]' : 'bg-[var(--bg-ground)] hover:bg-[var(--bg-subtle)]'
        } ${disabled ? 'opacity-50' : ''}`}
      >
        <Upload className="h-4 w-4 shrink-0" aria-hidden="true" />
        <span>Drop APK files here or click to choose</span>
        <span className="text-[11px] font-semibold text-[var(--ink-muted)]">
          .apk, .xapk, .apks, .apkm · multiple files · split APK + OBB supported
        </span>
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPT}
          multiple
          disabled={disabled}
          className="sr-only"
          onChange={(e) => {
            void installFiles(Array.from(e.target.files ?? []));
            e.target.value = '';
          }}
        />
      </div>

      <form onSubmit={installFromUrl} className="flex gap-2">
        <label htmlFor="apk-url" className="sr-only">
          APK download URL
        </label>
        <input
          id="apk-url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://example.com/app.apk"
          disabled={disabled || busy}
          className="nb-input min-w-0 flex-1"
        />
        <button type="submit" disabled={disabled || busy || !url.trim()} className="nb-btn nb-btn-secondary shrink-0">
          <Link2 className="h-3.5 w-3.5" aria-hidden="true" />
          <span>Install URL</span>
        </button>
      </form>

      {queue.length > 0 && (
        <ul className="space-y-1.5" aria-label="Install queue">
          {queue.map((q) => (
            <li key={q.id} className="nb-panel bg-[var(--bg-ground)] p-2.5">
              <div className="flex items-center justify-between gap-2">
                <span className="min-w-0 truncate text-[13px] font-bold text-[var(--ink)]">
                  {q.name}
                  {q.size > 0 && <span className="num ml-2 text-[11px] text-[var(--ink-muted)]">{formatBytes(q.size)}</span>}
                </span>
                <span className={`shrink-0 border-2 border-[var(--border)] px-2 py-0.5 text-[11px] font-extrabold ${stateClass[q.state]}`}>
                  {q.state === 'installing' && q.progress < 100 ? `Uploading ${q.progress}%` : q.state === 'installing' ? 'Installing' : q.state}
                </span>
              </div>
              {q.message && (
                <p className={`mt-1 break-words text-[12px] ${q.state === 'failed' ? 'text-[var(--status-err-ink)]' : 'text-[var(--ink-muted)]'}`}>
                  {q.message}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};
