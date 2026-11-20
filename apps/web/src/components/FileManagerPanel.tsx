import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { InstanceRecord } from '@droidforge/shared';
import {
  ArrowUp,
  Download,
  File as FileIcon,
  Folder,
  FolderPlus,
  RefreshCw,
  Trash2,
  Upload,
} from 'lucide-react';
import { getApiKey } from '../api/client';
import { formatBytes, uploadFiles } from '../lib/upload';

interface Entry {
  name: string;
  isDir: boolean;
  size: number;
  permissions: string;
  modified: string;
}

interface Props {
  instance: InstanceRecord;
}

const SHORTCUTS: Array<{ label: string; path: string }> = [
  { label: 'Storage', path: '/sdcard' },
  { label: 'Download', path: '/sdcard/Download' },
  { label: 'Pictures', path: '/sdcard/Pictures' },
  { label: 'DCIM', path: '/sdcard/DCIM' },
  { label: 'Documents', path: '/sdcard/Documents' },
  { label: 'Movies', path: '/sdcard/Movies' },
];

function joinPath(dir: string, name: string): string {
  return `${dir.replace(/\/+$/, '')}/${name}`;
}

function parentOf(dir: string): string {
  const parts = dir.split('/').filter(Boolean);
  parts.pop();
  return `/${parts.join('/')}`;
}

function authHeaders(): Record<string, string> {
  const key = getApiKey();
  return key ? { 'X-API-Key': key } : {};
}

export const FileManagerPanel: React.FC<Props> = ({ instance }) => {
  const [dir, setDir] = useState('/sdcard');
  const [entries, setEntries] = useState<Entry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [newFolder, setNewFolder] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const stopped = instance.status === 'stopped';
  const base = `/api/v1/instances/${instance.id}/files`;

  const load = useCallback(
    async (target: string) => {
      if (stopped) return;
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(`${base}/list?path=${encodeURIComponent(target)}`, { headers: authHeaders() });
        const data = (await res.json().catch(() => ({}))) as { entries?: Entry[]; error?: string };
        if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
        setEntries(data.entries ?? []);
        setDir(target);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    },
    [base, stopped],
  );

  useEffect(() => {
    setStatus(null);
    setConfirmDelete(null);
    void load('/sdcard');
  }, [instance.id, instance.status, load]);

  async function upload(files: File[]) {
    if (files.length === 0 || stopped) return;
    setError(null);
    setProgress(0);
    setStatus(`Uploading ${files.length} file${files.length > 1 ? 's' : ''}...`);
    try {
      const res = await uploadFiles<{ files?: Array<{ name: string; ok: boolean; error?: string }> }>(
        `${base}/push?remotePath=${encodeURIComponent(`${dir.replace(/\/+$/, '')}/`)}`,
        files,
        (p) => setProgress(Math.round((p.loaded / Math.max(1, p.total)) * 100)),
      );
      const failed = res.files?.filter((f) => !f.ok) ?? [];
      setStatus(
        failed.length === 0
          ? `Uploaded ${files.length} file${files.length > 1 ? 's' : ''} to ${dir}`
          : `Uploaded with ${failed.length} failure(s): ${failed.map((f) => f.name).join(', ')}`,
      );
      await load(dir);
    } catch (err) {
      setStatus(null);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setProgress(null);
    }
  }

  async function remove(name: string) {
    setError(null);
    try {
      const res = await fetch(`${base}?path=${encodeURIComponent(joinPath(dir, name))}`, {
        method: 'DELETE',
        headers: authHeaders(),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setConfirmDelete(null);
      setStatus(`Deleted ${name}`);
      await load(dir);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function createFolder(e: React.FormEvent) {
    e.preventDefault();
    const name = (newFolder ?? '').trim();
    if (!name || name.includes('/')) return;
    setError(null);
    try {
      const res = await fetch(`${base}/mkdir`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ path: joinPath(dir, name) }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setNewFolder(null);
      setStatus(`Created ${name}`);
      await load(dir);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  function downloadHref(name: string): string {
    const key = getApiKey();
    return `${base}/pull?path=${encodeURIComponent(joinPath(dir, name))}${key ? `&apiKey=${encodeURIComponent(key)}` : ''}`;
  }

  if (stopped) {
    return (
      <div className="border-2 border-dashed border-[var(--border)] p-4 text-center text-[13px] text-[var(--ink-muted)]">
        Boot the instance to browse and share files.
      </div>
    );
  }

  const crumbs = dir.split('/').filter(Boolean);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-extrabold text-[var(--ink)]">File Sharing</h3>
        <div className="flex items-center gap-1.5">
          <button type="button" onClick={() => setNewFolder(newFolder === null ? '' : null)} className="nb-btn nb-btn-secondary">
            <FolderPlus className="h-3.5 w-3.5" aria-hidden="true" />
            <span>New folder</span>
          </button>
          <button type="button" onClick={() => void load(dir)} disabled={loading} className="nb-btn nb-btn-secondary" aria-label="Refresh files">
            <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </div>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {SHORTCUTS.map((s) => (
          <button
            key={s.path}
            type="button"
            onClick={() => void load(s.path)}
            className={`nb-btn px-2.5 ${dir === s.path ? 'nb-btn-primary' : 'nb-btn-secondary'}`}
          >
            {s.label}
          </button>
        ))}
      </div>

      <nav aria-label="Current folder" className="num flex flex-wrap items-center gap-1 text-xs font-bold text-[var(--ink-secondary)]">
        <button type="button" onClick={() => void load('/')} className="underline">
          /
        </button>
        {crumbs.map((c, i) => {
          const target = `/${crumbs.slice(0, i + 1).join('/')}`;
          return (
            <React.Fragment key={target}>
              <span>/</span>
              <button type="button" onClick={() => void load(target)} className="underline">
                {c}
              </button>
            </React.Fragment>
          );
        })}
      </nav>

      {newFolder !== null && (
        <form onSubmit={createFolder} className="flex gap-2">
          <label htmlFor="new-folder-name" className="sr-only">
            New folder name
          </label>
          <input
            id="new-folder-name"
            autoFocus
            value={newFolder}
            onChange={(e) => setNewFolder(e.target.value)}
            placeholder="Folder name"
            className="nb-input flex-1"
          />
          <button type="submit" disabled={!newFolder.trim() || newFolder.includes('/')} className="nb-btn nb-btn-primary">
            Create
          </button>
        </form>
      )}

      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          void upload(Array.from(e.dataTransfer.files));
        }}
        className={`flex min-h-[64px] cursor-pointer flex-col items-center justify-center gap-1 border-2 border-dashed border-[var(--border)] p-3 text-center text-[13px] font-bold text-[var(--ink)] ${
          dragOver ? 'bg-[var(--accent)] text-[var(--accent-ink)]' : 'bg-[var(--bg-ground)] hover:bg-[var(--bg-subtle)]'
        }`}
        onClick={() => inputRef.current?.click()}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') inputRef.current?.click();
        }}
      >
        <Upload className="h-4 w-4" aria-hidden="true" />
        <span>{progress !== null ? `Uploading... ${progress}%` : `Drop files here or click to upload to ${dir}`}</span>
        {progress !== null && (
          <div className="h-2 w-full max-w-xs border-2 border-[var(--border)] bg-[var(--bg-surface)]">
            <div className="h-full bg-[var(--accent)]" style={{ width: `${progress}%` }} />
          </div>
        )}
        <input
          ref={inputRef}
          type="file"
          multiple
          className="sr-only"
          onChange={(e) => {
            void upload(Array.from(e.target.files ?? []));
            e.target.value = '';
          }}
        />
      </div>

      {error && (
        <div className="border-2 border-[var(--border)] bg-[var(--status-err-bg)] p-3 text-[13px] font-semibold text-[var(--status-err-ink)]">
          {error}
        </div>
      )}
      {status && (
        <div className="border-2 border-[var(--border)] bg-[var(--status-ok-bg)] px-3 py-2 text-xs font-bold text-[var(--status-ok-ink)]">
          {status}
        </div>
      )}

      <div className="space-y-1.5">
        {dir !== '/' && (
          <button
            type="button"
            onClick={() => void load(parentOf(dir))}
            className="nb-panel flex w-full items-center gap-2 bg-[var(--bg-ground)] p-2.5 text-left text-[13px] font-bold"
          >
            <ArrowUp className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span>..</span>
          </button>
        )}
        {loading && entries.length === 0 ? (
          <div className="h-12 border-2 border-[var(--border-subtle)] bg-[var(--bg-subtle)]" />
        ) : entries.length === 0 ? (
          <div className="border-2 border-dashed border-[var(--border)] p-4 text-center text-[13px] text-[var(--ink-muted)]">
            This folder is empty.
          </div>
        ) : (
          entries.map((entry) => (
            <div
              key={entry.name}
              className="nb-panel flex flex-wrap items-center justify-between gap-2 bg-[var(--bg-ground)] p-2.5"
            >
              <button
                type="button"
                onClick={() => (entry.isDir ? void load(joinPath(dir, entry.name)) : undefined)}
                className="flex min-w-0 flex-1 items-center gap-2 text-left"
                disabled={!entry.isDir}
              >
                {entry.isDir ? (
                  <Folder className="h-4 w-4 shrink-0" aria-hidden="true" />
                ) : (
                  <FileIcon className="h-4 w-4 shrink-0" aria-hidden="true" />
                )}
                <span className="min-w-0">
                  <span className="block truncate text-[13px] font-bold text-[var(--ink)]">{entry.name}</span>
                  <span className="num block text-[11px] text-[var(--ink-muted)]">
                    {entry.isDir ? 'Folder' : formatBytes(entry.size)} · {entry.modified}
                  </span>
                </span>
              </button>
              <div className="flex shrink-0 items-center gap-1.5">
                {!entry.isDir && (
                  <a
                    href={downloadHref(entry.name)}
                    download={entry.name}
                    className="nb-btn nb-btn-secondary px-2.5"
                    aria-label={`Download ${entry.name}`}
                  >
                    <Download className="h-3.5 w-3.5" aria-hidden="true" />
                  </a>
                )}
                {confirmDelete === entry.name ? (
                  <>
                    <button type="button" onClick={() => void remove(entry.name)} className="nb-btn nb-btn-danger px-2.5">
                      Confirm
                    </button>
                    <button type="button" onClick={() => setConfirmDelete(null)} className="nb-btn nb-btn-secondary px-2.5">
                      Cancel
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    onClick={() => setConfirmDelete(entry.name)}
                    className="nb-btn nb-btn-danger px-2.5"
                    aria-label={`Delete ${entry.name}`}
                  >
                    <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                )}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
};
