import React, { useCallback, useEffect, useState } from 'react';
import type { AiSnapshotResponse, InstanceHealth, InstanceRecord } from '@droidforge/shared';
import {
  Globe,
  HardDrive,
  KeyRound,
  Layers,
  Monitor,
  Moon,
  Plus,
  Power,
  RefreshCw,
  RotateCcw,
  Shield,
  SlidersHorizontal,
  Square,
  Store,
  Sun,
  Trash2,
  X,
} from 'lucide-react';
import { createClient, getApiKey } from './api/client';
import { ApiKeyModal } from './components/ApiKeyModal';
import { CreateInstanceModal } from './components/CreateInstanceModal';
import { DroidForgeMark } from './components/DroidForgeMark';
import { InspectorPanel } from './components/InspectorPanel';
import { LiveScreenCanvas } from './components/LiveScreenCanvas';
import { PruneModal } from './components/PruneModal';

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

type MobilePane = 'fleet' | 'screen' | 'inspector';
type TabletPane = 'screen' | 'inspector';
type StatusFilter = 'all' | 'running' | 'stopped';
type ThemeMode = 'light' | 'dark';

export const App: React.FC = () => {
  const [instances, setInstances] = useState<InstanceRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedHealth, setSelectedHealth] = useState<InstanceHealth | null>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');

  const [mobilePane, setMobilePane] = useState<MobilePane>('screen');
  const [tabletPane, setTabletPane] = useState<TabletPane>('screen');
  const [fleetDrawerOpen, setFleetDrawerOpen] = useState(false);

  const [modalOpen, setModalOpen] = useState(false);
  const [pruneModalOpen, setPruneModalOpen] = useState(false);
  const [apiKeyModalOpen, setApiKeyModalOpen] = useState(false);
  const [hasApiKey, setHasApiKey] = useState(() => Boolean(getApiKey()));

  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [actionBusyId, setActionBusyId] = useState<string | null>(null);
  const [deleteNotice, setDeleteNotice] = useState<string | null>(null);

  const [aiSnapshot, setAiSnapshot] = useState<AiSnapshotResponse | null>(null);
  const [aiSnapshotLoading, setAiSnapshotLoading] = useState(false);
  const [aiSnapshotError, setAiSnapshotError] = useState<string | null>(null);
  const [showAiOverlay, setShowAiOverlay] = useState(false);

  const [theme, setTheme] = useState<ThemeMode>(() => {
    const attr = typeof document !== 'undefined' ? document.documentElement.dataset.theme : 'light';
    return attr === 'dark' ? 'dark' : 'light';
  });

  const selected = instances.find((i) => i.id === selectedId) ?? instances[0] ?? null;
  const runningCount = instances.filter((i) => i.status === 'running' || i.status === 'booting').length;

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem('droidforge_theme', theme);
    } catch {
      // Ignore storage write failures in restricted environments
    }
  }, [theme]);

  useEffect(() => {
    if (!fleetDrawerOpen) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setFleetDrawerOpen(false);
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [fleetDrawerOpen]);

  const refresh = useCallback(async (isInitial = false) => {
    if (isInitial) setLoading(true);
    try {
      const list = await createClient().instances.list();
      setInstances(list);
      setLoadError(null);
      setLastUpdated(
        new Date().toLocaleTimeString([], {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        }),
      );
      setSelectedId((prev) => {
        if (prev && list.some((i) => i.id === prev)) return prev;
        return list[0]?.id ?? null;
      });
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Unable to reach DroidForge API');
    } finally {
      if (isInitial) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh(true);
    const timer = setInterval(() => void refresh(false), 5000);
    return () => clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    if (!selected || selected.status === 'stopped') {
      setSelectedHealth(null);
      return;
    }
    let cancelled = false;
    async function pollHealth() {
      if (!selected) return;
      try {
        const h = await createClient().instances.health(selected.id);
        if (!cancelled) setSelectedHealth(h);
      } catch {
        if (!cancelled) setSelectedHealth(null);
      }
    }
    void pollHealth();
    const timer = setInterval(() => void pollHealth(), 6000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [selected?.id, selected?.status]);

  async function captureAiSnapshot() {
    if (!selected) return;
    setAiSnapshotLoading(true);
    setAiSnapshotError(null);
    try {
      const snap = await createClient().ui.aiSnapshot(selected.id);
      setAiSnapshot(snap);
      setShowAiOverlay(true);
    } catch (err) {
      setAiSnapshotError(err instanceof Error ? err.message : String(err));
    } finally {
      setAiSnapshotLoading(false);
    }
  }

  async function handleInstanceAction(id: string, action: 'start' | 'stop' | 'restart' | 'delete') {
    setActionBusyId(id);
    setActionError(null);
    if (action === 'delete') {
      setDeleteNotice(null);
    }
    try {
      const client = createClient();
      if (action === 'start') await client.instances.start(id);
      else if (action === 'stop') await client.instances.stop(id);
      else if (action === 'restart') await client.instances.restart(id);
      else if (action === 'delete') {
        const res = await client.instances.delete(id, true, true);
        setConfirmDeleteId(null);
        if (selectedId === id) {
          setAiSnapshot(null);
          setShowAiOverlay(false);
        }
        const cleanedParts = ['container'];
        if (res.removedVolume) cleanedParts.push('/data volume');
        if (res.removedSnapshotFiles > 0) cleanedParts.push(`${res.removedSnapshotFiles} snapshot(s)`);
        if (res.removedRecordingFiles > 0) cleanedParts.push(`${res.removedRecordingFiles} recording(s)`);
        const extraCount = res.prune ? res.prune.items.length : 0;
        const reclaimedText = res.reclaimedBytes > 0 ? ` (${formatBytes(res.reclaimedBytes)} freed)` : '';
        setDeleteNotice(
          `Cleaned ${cleanedParts.join(', ')}${extraCount > 0 ? ` + ${extraCount} unused artifact(s)` : ''}${reclaimedText}.`,
        );
      }
      await refresh(false);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setActionBusyId(null);
    }
  }

  function selectInstance(id: string) {
    setSelectedId(id);
    setAiSnapshot(null);
    setAiSnapshotError(null);
    setShowAiOverlay(false);
    setConfirmDeleteId(null);
    setFleetDrawerOpen(false);
    setMobilePane('screen');
  }

  const visibleInstances = instances.filter((inst) => {
    if (statusFilter === 'running') return inst.status === 'running' || inst.status === 'booting';
    if (statusFilter === 'stopped') return inst.status === 'stopped' || inst.status === 'error';
    return true;
  });

  function renderStatusBadge(status: InstanceRecord['status']) {
    const cls =
      status === 'running'
        ? 'bg-[var(--status-ok-bg)] text-[var(--status-ok-ink)]'
        : status === 'booting' || status === 'creating'
          ? 'bg-[var(--status-warn-bg)] text-[var(--status-warn-ink)]'
          : status === 'error'
            ? 'bg-[var(--status-err-bg)] text-[var(--status-err-ink)]'
            : 'bg-[var(--status-idle-bg)] text-[var(--status-idle-ink)]';
    return (
      <span className={`shrink-0 border-2 border-[var(--border)] px-2 py-0.5 text-xs font-extrabold ${cls}`}>
        {status}
      </span>
    );
  }

  function renderFleetContent(inDrawer = false) {
    return (
      <div className="flex h-full min-h-0 flex-col bg-[var(--bg-surface)]">
        <div className="flex shrink-0 items-center justify-between gap-2 border-b-2 border-[var(--border)] bg-[var(--bg-subtle)] px-3.5 py-2.5">
          <div>
            <h2 className="text-sm font-extrabold text-[var(--ink)]">Fleet ({instances.length})</h2>
            <p className="num text-xs font-semibold text-[var(--ink-muted)]">
              {lastUpdated ? `Synced ${lastUpdated}` : 'Waiting for API'}
            </p>
          </div>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => void refresh(false)}
              aria-label="Refresh instances"
              className="nb-btn nb-btn-secondary px-2.5"
            >
              <RefreshCw className="h-4 w-4" aria-hidden="true" />
            </button>
            {inDrawer && (
              <button
                type="button"
                onClick={() => setFleetDrawerOpen(false)}
                aria-label="Close Fleet drawer"
                className="nb-btn nb-btn-secondary px-2.5"
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            )}
          </div>
        </div>

        {instances.length > 1 && (
          <div className="flex shrink-0 border-b-2 border-[var(--border)] bg-[var(--bg-ground)] p-2 gap-1.5">
            {(['all', 'running', 'stopped'] as const).map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => setStatusFilter(f)}
                className={`min-h-[36px] flex-1 border-2 border-[var(--border)] px-2 text-xs font-bold ${
                  statusFilter === f
                    ? 'bg-[var(--accent)] text-[var(--accent-ink)]'
                    : 'bg-[var(--bg-surface)] text-[var(--ink)] hover:bg-[var(--bg-subtle)]'
                }`}
              >
                {f === 'all' ? 'All' : f === 'running' ? 'Running' : 'Stopped'}
              </button>
            ))}
          </div>
        )}

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
          {actionError && (
            <div className="border-2 border-[var(--border)] bg-[var(--status-err-bg)] p-2.5 text-xs font-semibold text-[var(--status-err-ink)]">
              {actionError}
            </div>
          )}

          {deleteNotice && (
            <div className="flex items-start justify-between gap-2 border-2 border-[var(--border)] bg-[var(--status-ok-bg)] p-2.5 text-xs font-semibold text-[var(--status-ok-ink)]">
              <span className="num">{deleteNotice}</span>
              <button
                type="button"
                onClick={() => setDeleteNotice(null)}
                aria-label="Dismiss cleanup notice"
                className="shrink-0 p-0.5 text-[var(--status-ok-ink)] hover:opacity-75"
              >
                <X className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            </div>
          )}

          {loading ? (
            <div className="space-y-3" aria-label="Loading instances">
              <div className="h-32 border-2 border-[var(--border-subtle)] bg-[var(--bg-subtle)]" />
              <div className="h-32 border-2 border-[var(--border-subtle)] bg-[var(--bg-subtle)]" />
            </div>
          ) : loadError ? (
            <div className="space-y-2.5 border-2 border-[var(--border)] bg-[var(--status-err-bg)] p-3.5 text-[13px] font-semibold text-[var(--status-err-ink)]">
              <div>Could not reach instance list: {loadError}</div>
              <button type="button" onClick={() => void refresh(true)} className="nb-btn nb-btn-secondary">
                <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
                Retry Connection
              </button>
            </div>
          ) : visibleInstances.length === 0 ? (
            <div className="space-y-3 border-2 border-dashed border-[var(--border)] bg-[var(--bg-ground)] p-4 text-center">
              <p className="text-[13px] font-semibold text-[var(--ink-secondary)]">
                {instances.length === 0
                  ? 'No Redroid Android instances provisioned yet.'
                  : `No instances match the "${statusFilter}" filter.`}
              </p>
              {instances.length === 0 && (
                <button type="button" onClick={() => setModalOpen(true)} className="nb-btn nb-btn-primary w-full">
                  <Plus className="h-4 w-4" aria-hidden="true" />
                  Launch First Instance
                </button>
              )}
            </div>
          ) : (
            visibleInstances.map((inst) => {
              const active = selected?.id === inst.id;
              const busy = actionBusyId === inst.id;
              return (
                <article
                  key={inst.id}
                  className={`border-2 border-[var(--border)] p-3 transition-colors ${
                    active
                      ? 'border-l-[6px] border-l-[var(--accent)] bg-[var(--bg-surface)] shadow-[3px_3px_0_var(--shadow-color)]'
                      : 'bg-[var(--bg-ground)] hover:bg-[var(--bg-surface)]'
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => selectInstance(inst.id)}
                    aria-current={active ? 'true' : undefined}
                    className="w-full text-left"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <span className="truncate text-sm font-extrabold text-[var(--ink)]">{inst.name}</span>
                      {renderStatusBadge(inst.status)}
                    </div>

                    <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[13px] font-semibold text-[var(--ink-secondary)]">
                      <span>
                        {inst.profile.brand} {inst.profile.model}
                      </span>
                      {inst.stealthMode && (
                        <span className="inline-flex items-center gap-1 border border-[var(--border)] bg-[var(--bg-subtle)] px-1.5 py-0.5 text-xs font-bold text-[var(--ink)]">
                          <Shield className="h-3 w-3" aria-hidden="true" />
                          Stealth
                        </span>
                      )}
                      {inst.enablePlayStore && (
                        <span className="inline-flex items-center gap-1 border border-[var(--border)] bg-[var(--status-ok-bg)] px-1.5 py-0.5 text-xs font-bold text-[var(--status-ok-ink)]">
                          <Store className="h-3 w-3" aria-hidden="true" />
                          Play Store
                        </span>
                      )}
                      {(inst.proxyConfig || inst.proxy) && (
                        <span className="inline-flex items-center gap-1 border border-[var(--border)] bg-[var(--bg-subtle)] px-1.5 py-0.5 text-xs font-bold uppercase text-[var(--ink)]">
                          <Globe className="h-3 w-3" aria-hidden="true" />
                          {inst.proxyConfig?.protocol ?? 'Proxy'}
                        </span>
                      )}
                    </div>

                    <div className="num mt-1.5 text-xs font-semibold text-[var(--ink-muted)]">
                      Android {inst.androidVersion} · {inst.width}x{inst.height}
                      {inst.hostAdbPort ? ` · ADB :${inst.hostAdbPort}` : ''}
                    </div>
                  </button>

                  <div className="mt-3 flex flex-wrap gap-1.5 border-t-2 border-[var(--border-subtle)] pt-2.5">
                    {inst.status === 'stopped' ? (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void handleInstanceAction(inst.id, 'start')}
                        className="nb-btn nb-btn-primary flex-1 px-2.5"
                      >
                        <Power className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                        <span>{busy ? 'Starting...' : 'Start'}</span>
                      </button>
                    ) : (
                      <>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void handleInstanceAction(inst.id, 'stop')}
                          className="nb-btn nb-btn-secondary flex-1 px-2.5"
                        >
                          <Square className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                          <span>{busy ? 'Working...' : 'Stop'}</span>
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void handleInstanceAction(inst.id, 'restart')}
                          aria-label={`Restart ${inst.name}`}
                          className="nb-btn nb-btn-secondary px-2.5"
                        >
                          <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
                        </button>
                      </>
                    )}

                    {confirmDeleteId === inst.id ? (
                      <div className="w-full space-y-2 border-t border-[var(--border-subtle)] pt-2">
                        <p className="text-xs font-semibold text-[var(--status-err-ink)]">
                          Removes container, /data volume, snapshots, and prunes unused files.
                        </p>
                        <div className="flex gap-1.5">
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => void handleInstanceAction(inst.id, 'delete')}
                            className="nb-btn nb-btn-danger flex-1 px-2.5"
                          >
                            {busy ? 'Deleting...' : 'Confirm Delete'}
                          </button>
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => setConfirmDeleteId(null)}
                            className="nb-btn nb-btn-secondary px-2.5"
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    ) : (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => setConfirmDeleteId(inst.id)}
                        className="nb-btn nb-btn-danger px-2.5"
                        aria-label={`Delete ${inst.name}`}
                      >
                        <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                      </button>
                    )}
                  </div>
                </article>
              );
            })
          )}
        </div>

        <div className="num flex shrink-0 items-center justify-between border-t-2 border-[var(--border)] bg-[var(--bg-ground)] px-3.5 py-2 text-xs font-bold text-[var(--ink-secondary)]">
          <span>Active: {runningCount}</span>
          <span>ADB Pool: 15555-19999</span>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-[100dvh] flex-col overflow-hidden bg-[var(--bg-ground)] text-[var(--ink)]">
      <header className="flex shrink-0 items-center justify-between gap-2 border-b-2 border-[var(--border)] bg-[var(--bg-surface)] px-4 py-2.5">
        <div className="flex min-w-0 items-center gap-2.5">
          <button
            type="button"
            onClick={() => setFleetDrawerOpen(true)}
            className="nb-btn nb-btn-secondary hidden md:inline-flex xl:hidden"
          >
            <Layers className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span className="num">Fleet ({instances.length})</span>
          </button>

          <DroidForgeMark className="h-8 w-8" />

          <div className="min-w-0">
            <h1 className="truncate text-[20px] font-extrabold leading-none tracking-[-0.02em] text-[var(--ink)] sm:text-[22px]">
              DroidForge
            </h1>
            <p className="hidden truncate pt-0.5 text-xs font-semibold text-[var(--ink-muted)] lg:block">
              Docker Redroid Emulator Control Center
            </p>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <div className="num hidden items-center gap-2 border-2 border-[var(--border)] bg-[var(--bg-ground)] px-3 py-1.5 text-xs font-bold text-[var(--ink)] xl:flex">
            <span>{runningCount} running</span>
            <span aria-hidden="true">/</span>
            <span>{instances.length} total</span>
          </div>

          <button
            type="button"
            onClick={() => setPruneModalOpen(true)}
            aria-label="Prune unused storage"
            className="nb-btn nb-btn-secondary px-2.5 sm:px-3"
          >
            <HardDrive className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span className="hidden sm:inline">Prune</span>
          </button>

          <button
            type="button"
            onClick={() => setApiKeyModalOpen(true)}
            aria-label="Configure API Key"
            className="nb-btn nb-btn-secondary px-2.5 sm:px-3"
          >
            <KeyRound className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span className="hidden sm:inline">{hasApiKey ? 'Key Set' : 'API Key'}</span>
          </button>

          <button
            type="button"
            onClick={() => setTheme((t) => (t === 'light' ? 'dark' : 'light'))}
            aria-label={`Switch to ${theme === 'light' ? 'dark' : 'light'} theme`}
            className="nb-btn nb-btn-secondary px-2.5 sm:px-3"
          >
            {theme === 'light' ? (
              <Moon className="h-4 w-4 shrink-0" aria-hidden="true" />
            ) : (
              <Sun className="h-4 w-4 shrink-0" aria-hidden="true" />
            )}
            <span className="hidden md:inline">{theme === 'light' ? 'Dark' : 'Light'}</span>
          </button>

          <a
            href="/docs"
            target="_blank"
            rel="noreferrer"
            className="nb-btn nb-btn-secondary hidden md:inline-flex"
          >
            API Docs
          </a>

          <button type="button" onClick={() => setModalOpen(true)} className="nb-btn nb-btn-primary px-3">
            <Plus className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span className="sm:hidden">New</span>
            <span className="hidden sm:inline">New Instance</span>
          </button>
        </div>
      </header>

      {/* Tablet (<1024px) quick switcher between Screen and Inspector */}
      <div className="hidden shrink-0 items-center justify-between gap-3 border-b-2 border-[var(--border)] bg-[var(--bg-subtle)] px-4 py-2 md:flex lg:hidden">
        <div className="min-w-0 truncate text-[13px] font-bold text-[var(--ink)]">
          {selected ? `${selected.name} (${selected.profile.brand} ${selected.profile.model})` : 'No instance selected'}
        </div>
        <div className="flex shrink-0 gap-2">
          <button
            type="button"
            onClick={() => setTabletPane('screen')}
            className={`nb-btn ${tabletPane === 'screen' ? 'nb-btn-primary' : 'nb-btn-secondary'}`}
          >
            <Monitor className="h-4 w-4" aria-hidden="true" />
            <span>Live Screen</span>
          </button>
          <button
            type="button"
            onClick={() => setTabletPane('inspector')}
            className={`nb-btn ${tabletPane === 'inspector' ? 'nb-btn-primary' : 'nb-btn-secondary'}`}
          >
            <SlidersHorizontal className="h-4 w-4" aria-hidden="true" />
            <span>Inspector</span>
          </button>
        </div>
      </div>

      {/* Main Responsive Workspace */}
      <div className="min-h-0 flex-1 overflow-hidden p-4 lg:grid lg:grid-cols-[minmax(0,1fr)_420px] lg:gap-4 xl:grid-cols-[288px_minmax(0,1fr)_468px]">
        {/* Desktop Fleet Sidebar (>=1280px) */}
        <aside className="nb-panel hidden h-full min-h-0 overflow-hidden xl:block">{renderFleetContent(false)}</aside>

        {/* Live Screen Stage */}
        <main
          className={`h-full min-h-0 overflow-hidden ${
            mobilePane === 'screen' ? 'block' : 'hidden'
          } ${tabletPane === 'screen' ? 'md:block' : 'md:hidden'} lg:block`}
        >
          {selected ? (
            <LiveScreenCanvas
              instance={selected}
              health={selectedHealth}
              aiSnapshot={aiSnapshot}
              aiSnapshotLoading={aiSnapshotLoading}
              aiSnapshotError={aiSnapshotError}
              showAiOverlay={showAiOverlay}
              onCaptureAiSnapshot={() => void captureAiSnapshot()}
              onToggleAiOverlay={() => setShowAiOverlay((v) => !v)}
              onStartInstance={(id) => void handleInstanceAction(id, 'start')}
              actionBusy={actionBusyId === selected.id}
            />
          ) : (
            <div className="nb-panel flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
              <h2 className="text-base font-extrabold text-[var(--ink)]">
                {loading ? 'Loading Emulator Fleet...' : 'No Android Instance Active'}
              </h2>
              <p className="max-w-sm text-[13px] text-[var(--ink-secondary)]">
                {loadError
                  ? `API Error: ${loadError}`
                  : 'Create a Redroid instance to stream the live screen and automate UI controls.'}
              </p>
              {!loading && (
                <div className="flex flex-wrap justify-center gap-2">
                  {loadError && (
                    <button type="button" onClick={() => void refresh(true)} className="nb-btn nb-btn-secondary">
                      Retry API
                    </button>
                  )}
                  <button type="button" onClick={() => setModalOpen(true)} className="nb-btn nb-btn-primary">
                    <Plus className="h-4 w-4" aria-hidden="true" />
                    Create Instance
                  </button>
                </div>
              )}
            </div>
          )}
        </main>

        {/* Inspector Panel */}
        <section
          className={`h-full min-h-0 overflow-hidden ${
            mobilePane === 'inspector' ? 'block' : 'hidden'
          } ${tabletPane === 'inspector' ? 'md:block' : 'md:hidden'} lg:block`}
        >
          {selected ? (
            <InspectorPanel
              instance={selected}
              health={selectedHealth}
              aiSnapshot={aiSnapshot}
              aiSnapshotLoading={aiSnapshotLoading}
              aiSnapshotError={aiSnapshotError}
              onCaptureAiSnapshot={() => void captureAiSnapshot()}
              onInstanceRefresh={() => void refresh(false)}
            />
          ) : (
            <div className="nb-panel flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
              <h2 className="text-sm font-extrabold text-[var(--ink)]">Inspector Ready</h2>
              <p className="text-[13px] text-[var(--ink-muted)]">
                Select or boot an instance to inspect UI hierarchy, packages, stealth score, and logcat.
              </p>
            </div>
          )}
        </section>

        {/* Mobile Fleet View (<768px) */}
        <section className={`h-full min-h-0 overflow-hidden md:hidden ${mobilePane === 'fleet' ? 'block' : 'hidden'}`}>
          <div className="nb-panel h-full min-h-0 overflow-hidden">{renderFleetContent(false)}</div>
        </section>
      </div>

      {/* Mobile Bottom Navigation (<768px) */}
      <nav
        aria-label="Mobile workspace navigation"
        className="grid shrink-0 grid-cols-3 border-t-2 border-[var(--border)] bg-[var(--bg-surface)] pb-[env(safe-area-inset-bottom)] md:hidden"
      >
        <button
          type="button"
          onClick={() => setMobilePane('fleet')}
          className={`flex min-h-[54px] items-center justify-center gap-1.5 border-r-2 border-[var(--border)] px-2 text-[13px] font-extrabold ${
            mobilePane === 'fleet'
              ? 'bg-[var(--accent)] text-[var(--accent-ink)]'
              : 'bg-[var(--bg-surface)] text-[var(--ink)]'
          }`}
        >
          <Layers className="h-4 w-4 shrink-0" aria-hidden="true" />
          <span className="num">Fleet ({instances.length})</span>
        </button>
        <button
          type="button"
          onClick={() => setMobilePane('screen')}
          className={`flex min-h-[54px] items-center justify-center gap-1.5 border-r-2 border-[var(--border)] px-2 text-[13px] font-extrabold ${
            mobilePane === 'screen'
              ? 'bg-[var(--accent)] text-[var(--accent-ink)]'
              : 'bg-[var(--bg-surface)] text-[var(--ink)]'
          }`}
        >
          <Monitor className="h-4 w-4 shrink-0" aria-hidden="true" />
          <span>Screen</span>
        </button>
        <button
          type="button"
          onClick={() => setMobilePane('inspector')}
          className={`flex min-h-[54px] items-center justify-center gap-1.5 px-2 text-[13px] font-extrabold ${
            mobilePane === 'inspector'
              ? 'bg-[var(--accent)] text-[var(--accent-ink)]'
              : 'bg-[var(--bg-surface)] text-[var(--ink)]'
          }`}
        >
          <SlidersHorizontal className="h-4 w-4 shrink-0" aria-hidden="true" />
          <span>Inspector</span>
        </button>
      </nav>

      {/* Tablet Fleet Slide-Over Drawer (768px-1279px) */}
      {fleetDrawerOpen && (
        <div
          className="fixed inset-0 z-40 flex bg-black/65 xl:hidden"
          onClick={(e) => {
            if (e.target === e.currentTarget) setFleetDrawerOpen(false);
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Emulator Fleet Drawer"
            className="h-full w-full max-w-sm border-r-2 border-[var(--border)] bg-[var(--bg-surface)] shadow-[6px_0_0_var(--shadow-color)]"
          >
            {renderFleetContent(true)}
          </div>
        </div>
      )}

      <CreateInstanceModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        onCreated={() => void refresh(false)}
      />

      <PruneModal
        open={pruneModalOpen}
        onClose={() => setPruneModalOpen(false)}
        onPruned={() => void refresh(false)}
      />

      <ApiKeyModal
        open={apiKeyModalOpen}
        onClose={() => setApiKeyModalOpen(false)}
        onSaved={() => {
          setHasApiKey(Boolean(getApiKey()));
          void refresh(true);
        }}
      />
    </div>
  );
};
