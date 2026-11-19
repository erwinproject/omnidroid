import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PruneCategory, PruneItem, PruneReport } from '@droidforge/shared';
import { AlertTriangle, CheckCircle2, HardDrive, RefreshCw, Trash2, X } from 'lucide-react';
import { createClient } from '../api/client';

interface Props {
  open: boolean;
  onClose: () => void;
  onPruned: () => void;
}

type CategoryFlagKey =
  | 'removeOrphanedContainers'
  | 'removeOrphanedVolumes'
  | 'removeOrphanedSnapshots'
  | 'removeOrphanedRecordings'
  | 'removeTempFiles'
  | 'removeDanglingImages'
  | 'removeUnusedRedroidImages'
  | 'removeBuildCache';

interface CategoryConfig {
  key: CategoryFlagKey;
  label: string;
  description: string;
  matches: PruneCategory[];
  advanced?: boolean;
}

const CATEGORY_CONFIGS: CategoryConfig[] = [
  {
    key: 'removeOrphanedContainers',
    label: 'Orphaned Containers',
    description: 'Leftover Redroid or exited helper containers not tracked in the database.',
    matches: ['orphaned_container'],
  },
  {
    key: 'removeOrphanedVolumes',
    label: 'Orphaned & Anonymous Volumes',
    description: 'Unmounted redroid-data volumes and anonymous Docker volumes.',
    matches: ['orphaned_volume', 'anonymous_volume'],
  },
  {
    key: 'removeOrphanedSnapshots',
    label: 'Orphaned Snapshots',
    description: 'Snapshot .tar.gz archives left behind from deleted instances.',
    matches: ['orphaned_snapshot'],
  },
  {
    key: 'removeOrphanedRecordings',
    label: 'Orphaned Screen Recordings',
    description: 'MP4 recording files from deleted or untracked instances.',
    matches: ['orphaned_recording'],
  },
  {
    key: 'removeTempFiles',
    label: 'Temporary Upload & Download Files',
    description: 'Stale transfer files older than 60 seconds in uploads and downloads.',
    matches: ['temp_file'],
  },
  {
    key: 'removeDanglingImages',
    label: 'Dangling Docker Images',
    description: 'Untagged image layers no longer referenced by any container.',
    matches: ['dangling_image'],
  },
  {
    key: 'removeUnusedRedroidImages',
    label: 'Unused Redroid & Helper Images',
    description: 'Removes unused redroid, Play Store, or alpine helper images. Re-pulling or rebuilding may take time.',
    matches: ['unused_image'],
    advanced: true,
  },
  {
    key: 'removeBuildCache',
    label: 'Docker Build Cache',
    description: 'Clears unused Docker builder cache on the host. Future image builds will be slower.',
    matches: ['build_cache'],
    advanced: true,
  },
];

const CATEGORY_LABELS: Record<PruneCategory, string> = {
  orphaned_container: 'Container',
  orphaned_volume: 'Volume',
  anonymous_volume: 'Anon Vol',
  orphaned_snapshot: 'Snapshot',
  orphaned_recording: 'Recording',
  temp_file: 'Temp File',
  dangling_image: 'Dangling Image',
  unused_image: 'Unused Image',
  build_cache: 'Build Cache',
};

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export const PruneModal: React.FC<Props> = ({ open, onClose, onPruned }) => {
  const [options, setOptions] = useState<Record<CategoryFlagKey, boolean>>({
    removeOrphanedContainers: true,
    removeOrphanedVolumes: true,
    removeOrphanedSnapshots: true,
    removeOrphanedRecordings: true,
    removeTempFiles: true,
    removeDanglingImages: true,
    removeUnusedRedroidImages: false,
    removeBuildCache: false,
  });

  const [preview, setPreview] = useState<PruneReport | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);

  const [pruning, setPruning] = useState(false);
  const [pruneError, setPruneError] = useState<string | null>(null);
  const [pruneResult, setPruneResult] = useState<PruneReport | null>(null);

  const scanSeqRef = useRef(0);

  const runScan = useCallback(async (includeUnusedImages: boolean, includeBuildCache: boolean) => {
    const seq = ++scanSeqRef.current;
    setScanning(true);
    setScanError(null);
    try {
      const report = await createClient().system.prunePreview({
        includeUnusedImages,
        includeBuildCache,
      });
      if (seq === scanSeqRef.current) {
        setPreview(report);
      }
    } catch (err) {
      if (seq === scanSeqRef.current) {
        setScanError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (seq === scanSeqRef.current) {
        setScanning(false);
      }
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    setPruneResult(null);
    setPruneError(null);
    void runScan(options.removeUnusedRedroidImages, options.removeBuildCache);
  }, [open, options.removeUnusedRedroidImages, options.removeBuildCache, runScan]);

  useEffect(() => {
    if (!open) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape' && !pruning) onClose();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, pruning, onClose]);

  const enabledCategories = useMemo(() => {
    const set = new Set<PruneCategory>();
    for (const cfg of CATEGORY_CONFIGS) {
      if (options[cfg.key]) {
        for (const cat of cfg.matches) set.add(cat);
      }
    }
    return set;
  }, [options]);

  const selectedItems = useMemo<PruneItem[]>(() => {
    if (!preview) return [];
    return preview.items.filter((item) => enabledCategories.has(item.category));
  }, [preview, enabledCategories]);

  const selectedBytes = useMemo(
    () => selectedItems.reduce((sum, item) => sum + item.sizeBytes, 0),
    [selectedItems],
  );

  async function handlePrune() {
    setPruning(true);
    setPruneError(null);
    try {
      const report = await createClient().system.prune({
        dryRun: false,
        ...options,
      });
      setPruneResult(report);
      onPruned();
      await runScan(options.removeUnusedRedroidImages, options.removeBuildCache);
    } catch (err) {
      setPruneError(err instanceof Error ? err.message : String(err));
    } finally {
      setPruning(false);
    }
  }

  if (!open) return null;

  const standardCategories = CATEGORY_CONFIGS.filter((c) => !c.advanced);
  const advancedCategories = CATEGORY_CONFIGS.filter((c) => c.advanced);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-3 sm:p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget && !pruning) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="prune-modal-title"
        className="nb-panel-elevated flex max-h-[92dvh] w-full max-w-2xl flex-col overflow-hidden"
      >
        <div className="flex shrink-0 items-center justify-between gap-2 border-b-2 border-[var(--border)] bg-[var(--bg-subtle)] px-4 py-3">
          <div className="flex min-w-0 items-center gap-2">
            <HardDrive className="h-4 w-4 shrink-0 text-[var(--ink)]" aria-hidden="true" />
            <h2 id="prune-modal-title" className="truncate text-base font-extrabold text-[var(--ink)] sm:text-lg">
              Storage & Container Prune
            </h2>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <button
              type="button"
              disabled={scanning || pruning}
              onClick={() => void runScan(options.removeUnusedRedroidImages, options.removeBuildCache)}
              className="nb-btn nb-btn-secondary px-2.5"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${scanning ? 'animate-spin' : ''}`} aria-hidden="true" />
              <span>{scanning ? 'Scanning...' : 'Rescan'}</span>
            </button>
            <button
              type="button"
              disabled={pruning}
              onClick={onClose}
              aria-label="Close Storage Prune dialog"
              className="nb-btn nb-btn-secondary px-2.5"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4 text-sm">
          {pruneResult && (
            <div
              className={`space-y-1.5 border-2 border-[var(--border)] p-3 text-xs font-semibold ${
                pruneResult.errors.length > 0
                  ? 'bg-[var(--status-warn-bg)] text-[var(--status-warn-ink)]'
                  : 'bg-[var(--status-ok-bg)] text-[var(--status-ok-ink)]'
              }`}
            >
              <div className="flex items-center gap-2 text-[13px] font-extrabold">
                <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden="true" />
                <span className="num">
                  Pruned {pruneResult.items.length} item(s), reclaimed {formatBytes(pruneResult.reclaimedBytes)} in{' '}
                  {pruneResult.durationMs} ms.
                </span>
              </div>
              {pruneResult.errors.length > 0 && (
                <ul className="list-disc space-y-0.5 pl-5">
                  {pruneResult.errors.map((errMsg, idx) => (
                    <li key={idx}>{errMsg}</li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {pruneError && (
            <div className="flex items-start gap-2 border-2 border-[var(--border)] bg-[var(--status-err-bg)] p-3 text-xs font-semibold text-[var(--status-err-ink)]">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              <span>Prune failed: {pruneError}</span>
            </div>
          )}

          {scanError && (
            <div className="flex flex-wrap items-center justify-between gap-2 border-2 border-[var(--border)] bg-[var(--status-err-bg)] p-3 text-xs font-semibold text-[var(--status-err-ink)]">
              <span>Scan failed: {scanError}</span>
              <button
                type="button"
                onClick={() => void runScan(options.removeUnusedRedroidImages, options.removeBuildCache)}
                className="nb-btn nb-btn-secondary"
              >
                <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
                Retry Scan
              </button>
            </div>
          )}

          {preview?.errors && preview.errors.length > 0 && (
            <div className="space-y-1 border-2 border-[var(--border)] bg-[var(--status-warn-bg)] p-3 text-xs font-semibold text-[var(--status-warn-ink)]">
              <div className="font-extrabold">Partial scan warnings</div>
              <ul className="list-disc space-y-0.5 pl-5">
                {preview.errors.map((errMsg, idx) => (
                  <li key={idx}>{errMsg}</li>
                ))}
              </ul>
            </div>
          )}

          {scanning && !preview ? (
            <div className="space-y-3" aria-label="Scanning unused storage">
              <div className="h-20 border-2 border-[var(--border-subtle)] bg-[var(--bg-subtle)]" />
              <div className="h-40 border-2 border-[var(--border-subtle)] bg-[var(--bg-subtle)]" />
            </div>
          ) : (
            <>
              <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-3">
                <div className="border-2 border-[var(--border)] bg-[var(--bg-ground)] p-3">
                  <div className="text-xs font-bold text-[var(--ink-muted)]">Selected Reclaimable</div>
                  <div className="num mt-1 text-lg font-extrabold text-[var(--ink)]">{formatBytes(selectedBytes)}</div>
                </div>
                <div className="border-2 border-[var(--border)] bg-[var(--bg-ground)] p-3">
                  <div className="text-xs font-bold text-[var(--ink-muted)]">Selected Items</div>
                  <div className="num mt-1 text-lg font-extrabold text-[var(--ink)]">
                    {selectedItems.length} / {preview?.items.length ?? 0}
                  </div>
                </div>
                <div className="border-2 border-[var(--border)] bg-[var(--bg-ground)] p-3">
                  <div className="text-xs font-bold text-[var(--ink-muted)]">Delete Policy</div>
                  <div className="mt-1 text-xs font-extrabold text-[var(--status-ok-ink)]">
                    Auto-prune on instance delete active
                  </div>
                </div>
              </div>

              <div className="space-y-2 border-2 border-[var(--border)] bg-[var(--bg-ground)] p-3">
                <div className="text-xs font-extrabold uppercase tracking-wide text-[var(--ink-secondary)]">
                  Safe Cleanup Targets
                </div>
                <div className="grid grid-cols-1 gap-2">
                  {standardCategories.map((cfg) => {
                    const matched = (preview?.items ?? []).filter((item) => cfg.matches.includes(item.category));
                    const catBytes = matched.reduce((sum, item) => sum + item.sizeBytes, 0);
                    return (
                      <label
                        key={cfg.key}
                        className="flex min-h-[44px] cursor-pointer items-start justify-between gap-3 border-2 border-[var(--border)] bg-[var(--bg-surface)] px-3 py-2"
                      >
                        <div className="flex items-start gap-2.5">
                          <input
                            type="checkbox"
                            checked={options[cfg.key]}
                            disabled={pruning}
                            onChange={(e) => setOptions((prev) => ({ ...prev, [cfg.key]: e.target.checked }))}
                            className="mt-1 h-4 w-4 shrink-0 accent-[var(--ink)]"
                          />
                          <div>
                            <div className="text-[13px] font-bold text-[var(--ink)]">{cfg.label}</div>
                            <div className="text-xs text-[var(--ink-muted)]">{cfg.description}</div>
                          </div>
                        </div>
                        <div className="num shrink-0 text-right text-xs font-bold text-[var(--ink-secondary)]">
                          <div>{matched.length} item(s)</div>
                          <div>{formatBytes(catBytes)}</div>
                        </div>
                      </label>
                    );
                  })}
                </div>
              </div>

              <div className="space-y-2 border-2 border-[var(--border)] bg-[var(--bg-ground)] p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-extrabold uppercase tracking-wide text-[var(--status-warn-ink)]">
                    Advanced (Opt-in)
                  </span>
                  <span className="text-xs font-semibold text-[var(--ink-muted)]">Off by default</span>
                </div>
                <div className="grid grid-cols-1 gap-2">
                  {advancedCategories.map((cfg) => {
                    const matched = (preview?.items ?? []).filter((item) => cfg.matches.includes(item.category));
                    const catBytes = matched.reduce((sum, item) => sum + item.sizeBytes, 0);
                    return (
                      <label
                        key={cfg.key}
                        className="flex min-h-[44px] cursor-pointer items-start justify-between gap-3 border-2 border-[var(--border)] bg-[var(--bg-surface)] px-3 py-2"
                      >
                        <div className="flex items-start gap-2.5">
                          <input
                            type="checkbox"
                            checked={options[cfg.key]}
                            disabled={pruning || scanning}
                            onChange={(e) => setOptions((prev) => ({ ...prev, [cfg.key]: e.target.checked }))}
                            className="mt-1 h-4 w-4 shrink-0 accent-[var(--ink)]"
                          />
                          <div>
                            <div className="text-[13px] font-bold text-[var(--ink)]">{cfg.label}</div>
                            <div className="text-xs text-[var(--ink-muted)]">{cfg.description}</div>
                          </div>
                        </div>
                        <div className="num shrink-0 text-right text-xs font-bold text-[var(--ink-secondary)]">
                          <div>{options[cfg.key] ? `${matched.length} item(s)` : 'Not scanned'}</div>
                          <div>{options[cfg.key] ? formatBytes(catBytes) : '0 B'}</div>
                        </div>
                      </label>
                    );
                  })}
                </div>
              </div>

              {preview && preview.items.length === 0 ? (
                <div className="border-2 border-dashed border-[var(--border)] bg-[var(--bg-ground)] p-4 text-center">
                  <p className="text-[13px] font-bold text-[var(--ink)]">Storage is clean</p>
                  <p className="mt-1 text-xs text-[var(--ink-muted)]">
                    No unused Redroid containers, volumes, snapshots, recordings, or temp files were detected.
                  </p>
                </div>
              ) : (
                preview && (
                  <div className="space-y-2 border-2 border-[var(--border)] bg-[var(--bg-surface)] p-3">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-extrabold uppercase tracking-wide text-[var(--ink-secondary)]">
                        Detected Artifacts ({preview.items.length})
                      </span>
                      <span className="num text-xs font-bold text-[var(--ink-muted)]">
                        {selectedItems.length} selected for removal
                      </span>
                    </div>
                    <div className="max-h-56 space-y-1.5 overflow-y-auto pr-1">
                      {preview.items.map((item) => {
                        const checked = enabledCategories.has(item.category);
                        return (
                          <div
                            key={`${item.category}:${item.id}`}
                            className={`flex items-start justify-between gap-3 border border-[var(--border-subtle)] px-2.5 py-2 text-xs ${
                              checked ? 'bg-[var(--bg-ground)]' : 'bg-[var(--bg-surface)] opacity-55'
                            }`}
                          >
                            <div className="min-w-0 space-y-0.5">
                              <div className="flex flex-wrap items-center gap-1.5">
                                <span className="border border-[var(--border)] bg-[var(--bg-subtle)] px-1.5 py-0.5 text-[11px] font-extrabold uppercase text-[var(--ink)]">
                                  {CATEGORY_LABELS[item.category]}
                                </span>
                                <span className="num truncate font-bold text-[var(--ink)]">{item.name}</span>
                              </div>
                              <div className="text-[11px] text-[var(--ink-muted)]">{item.reason}</div>
                            </div>
                            <div className="num shrink-0 font-bold text-[var(--ink-secondary)]">
                              {formatBytes(item.sizeBytes)}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )
              )}
            </>
          )}
        </div>

        <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t-2 border-[var(--border)] bg-[var(--bg-subtle)] px-4 py-3">
          <div className="num text-xs font-bold text-[var(--ink-secondary)]">
            {selectedItems.length > 0
              ? `Ready to remove ${selectedItems.length} item(s) (${formatBytes(selectedBytes)})`
              : 'No selected items to prune'}
          </div>
          <div className="flex items-center gap-2">
            <button type="button" disabled={pruning} onClick={onClose} className="nb-btn nb-btn-secondary">
              Close
            </button>
            <button
              type="button"
              disabled={scanning || pruning || selectedItems.length === 0}
              onClick={() => void handlePrune()}
              className="nb-btn nb-btn-danger"
            >
              <Trash2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span>{pruning ? 'Pruning...' : 'Prune Now'}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
