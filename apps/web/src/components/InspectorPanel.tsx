import React, { useEffect, useRef, useState } from 'react';
import type { AiSnapshotResponse, InstanceHealth, InstanceRecord, StealthCheckReport } from '@droidforge/shared';
import {
  Check,
  Code2,
  Copy,
  Cpu,
  Globe,
  Layers,
  Package,
  Pause,
  Play,
  RefreshCw,
  ShieldCheck,
  Terminal,
  Trash2,
  Upload,
} from 'lucide-react';
import { buildWsUrl, createClient, getApiKey } from '../api/client';
import { ProxyPanel } from './ProxyPanel';

interface Props {
  instance: InstanceRecord;
  health: InstanceHealth | null;
  aiSnapshot: AiSnapshotResponse | null;
  aiSnapshotLoading: boolean;
  aiSnapshotError: string | null;
  onCaptureAiSnapshot: () => void;
  onInstanceRefresh?: () => void;
}

type Tab = 'ai' | 'apps' | 'proxy' | 'stealth' | 'logcat' | 'api';

export const InspectorPanel: React.FC<Props> = ({
  instance,
  health,
  aiSnapshot,
  aiSnapshotLoading,
  aiSnapshotError,
  onCaptureAiSnapshot,
  onInstanceRefresh,
}) => {
  const [tab, setTab] = useState<Tab>('ai');
  const [nodeFilter, setNodeFilter] = useState('');
  const [clickStatus, setClickStatus] = useState<string | null>(null);

  const [packages, setPackages] = useState<string[]>([]);
  const [appsLoading, setAppsLoading] = useState(false);
  const [appsError, setAppsError] = useState<string | null>(null);
  const [appsStatusMsg, setAppsStatusMsg] = useState<string | null>(null);
  const [confirmUninstallPkg, setConfirmUninstallPkg] = useState<string | null>(null);
  const [uploadingApk, setUploadingApk] = useState(false);

  const [stealthReport, setStealthReport] = useState<StealthCheckReport | null>(null);
  const [stealthLoading, setStealthLoading] = useState(false);
  const [stealthError, setStealthError] = useState<string | null>(null);

  const [shellCmd, setShellCmd] = useState('getprop ro.product.model');
  const [shellOut, setShellOut] = useState('');
  const [shellRunning, setShellRunning] = useState(false);
  const [shellError, setShellError] = useState<string | null>(null);

  const [logs, setLogs] = useState<string[]>([]);
  const [logLevel, setLogLevel] = useState('I');
  const [logPaused, setLogPaused] = useState(false);
  const [logWsState, setLogWsState] = useState<'connecting' | 'live' | 'paused' | 'closed'>('connecting');
  const logEndRef = useRef<HTMLDivElement | null>(null);

  const [copiedId, setCopiedId] = useState<string | null>(null);

  useEffect(() => {
    setStealthReport(null);
    setStealthError(null);
    setShellOut('');
    setShellError(null);
    setPackages([]);
    setAppsError(null);
    setAppsStatusMsg(null);
    setConfirmUninstallPkg(null);
    setClickStatus(null);
  }, [instance.id]);

  useEffect(() => {
    if (tab !== 'logcat') return;
    if (logPaused) {
      setLogWsState('paused');
      return;
    }
    let disposed = false;
    setLogs([]);
    setLogWsState('connecting');
    const ws = new WebSocket(buildWsUrl(`/ws/instances/${instance.id}/logcat?level=${logLevel}`));
    ws.onopen = () => {
      if (!disposed) setLogWsState('live');
    };
    ws.onclose = () => {
      if (!disposed) setLogWsState('closed');
    };
    ws.onerror = () => {
      if (!disposed) setLogWsState('closed');
    };
    ws.onmessage = (ev) => {
      if (disposed) return;
      const lines = String(ev.data).split(/\r?\n/).filter(Boolean);
      setLogs((prev) => [...prev.slice(-300), ...lines]);
    };
    return () => {
      disposed = true;
      ws.close();
    };
  }, [tab, instance.id, logLevel, logPaused]);

  useEffect(() => {
    if (!logPaused) {
      logEndRef.current?.scrollIntoView({ behavior: 'auto' });
    }
  }, [logs, logPaused]);

  async function loadApps() {
    setAppsLoading(true);
    setAppsError(null);
    try {
      const res = await fetch(`/api/v1/instances/${instance.id}/apps?type=user`, {
        headers: getApiKey() ? { 'X-API-Key': getApiKey() } : {},
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const data = (await res.json()) as { packages: string[] };
      setPackages(data.packages);
    } catch (err) {
      setAppsError(err instanceof Error ? err.message : String(err));
    } finally {
      setAppsLoading(false);
    }
  }

  async function uploadApk(file: File) {
    setUploadingApk(true);
    setAppsError(null);
    setAppsStatusMsg(`Installing ${file.name}...`);
    try {
      const form = new FormData();
      form.append('file', file);
      const res = await fetch(`/api/v1/instances/${instance.id}/apps/install`, {
        method: 'POST',
        headers: getApiKey() ? { 'X-API-Key': getApiKey() } : {},
        body: form,
      });
      if (!res.ok) {
        throw new Error(`Install failed (HTTP ${res.status})`);
      }
      setAppsStatusMsg(`Installed ${file.name}`);
      await loadApps();
    } catch (err) {
      setAppsStatusMsg(null);
      setAppsError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploadingApk(false);
    }
  }

  async function launchPackage(pkg: string) {
    setAppsError(null);
    try {
      const res = await fetch(`/api/v1/instances/${instance.id}/apps/${pkg}/launch`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(getApiKey() ? { 'X-API-Key': getApiKey() } : {}),
        },
        body: '{}',
      });
      if (!res.ok) throw new Error(`Launch failed (HTTP ${res.status})`);
      setAppsStatusMsg(`Launched ${pkg}`);
    } catch (err) {
      setAppsError(err instanceof Error ? err.message : String(err));
    }
  }

  async function uninstallPackage(pkg: string) {
    setAppsError(null);
    try {
      const res = await fetch(`/api/v1/instances/${instance.id}/apps/${pkg}`, {
        method: 'DELETE',
        headers: getApiKey() ? { 'X-API-Key': getApiKey() } : {},
      });
      if (!res.ok) throw new Error(`Uninstall failed (HTTP ${res.status})`);
      setConfirmUninstallPkg(null);
      setAppsStatusMsg(`Removed ${pkg}`);
      await loadApps();
    } catch (err) {
      setAppsError(err instanceof Error ? err.message : String(err));
    }
  }

  async function clickAiElement(elementId: number, label: string) {
    setClickStatus(null);
    try {
      await createClient().ui.click(instance.id, { elementId });
      setClickStatus(`Clicked #${elementId} (${label})`);
    } catch (err) {
      setClickStatus(err instanceof Error ? err.message : String(err));
    }
  }

  async function runStealthCheck() {
    setStealthLoading(true);
    setStealthError(null);
    try {
      const report = await createClient().device.stealthCheck(instance.id);
      setStealthReport(report);
    } catch (err) {
      setStealthError(err instanceof Error ? err.message : String(err));
    } finally {
      setStealthLoading(false);
    }
  }

  async function runShell(e?: React.FormEvent) {
    if (e) e.preventDefault();
    if (!shellCmd.trim()) return;
    setShellRunning(true);
    setShellError(null);
    try {
      const res = await createClient().device.shell(instance.id, { command: shellCmd, timeoutMs: 10000 });
      setShellOut(res.stdout || res.stderr || `(exit ${res.exitCode})`);
    } catch (err) {
      setShellError(err instanceof Error ? err.message : String(err));
    } finally {
      setShellRunning(false);
    }
  }

  async function copySnippet(id: string, text: string) {
    let copied = false;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        copied = true;
      }
    } catch {
      copied = false;
    }
    if (!copied) {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        copied = document.execCommand('copy');
        document.body.removeChild(ta);
      } catch {
        copied = false;
      }
    }
    if (copied) {
      setCopiedId(id);
      setTimeout(() => setCopiedId((curr) => (curr === id ? null : curr)), 1800);
    }
  }

  const tabs: Array<{ id: Tab; label: string; title: string; icon: React.ReactNode }> = [
    { id: 'ai', label: 'UI', title: 'UI & AI', icon: <Layers className="h-3.5 w-3.5" aria-hidden="true" /> },
    { id: 'apps', label: 'Apps', title: 'Apps & APK', icon: <Package className="h-3.5 w-3.5" aria-hidden="true" /> },
    { id: 'proxy', label: 'Proxy', title: 'Proxy & Network', icon: <Globe className="h-3.5 w-3.5" aria-hidden="true" /> },
    { id: 'stealth', label: 'Stealth', title: 'Stealth & ADB', icon: <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" /> },
    { id: 'logcat', label: 'Logs', title: 'Logcat Stream', icon: <Terminal className="h-3.5 w-3.5" aria-hidden="true" /> },
    { id: 'api', label: 'API', title: 'REST & WebSocket API', icon: <Code2 className="h-3.5 w-3.5" aria-hidden="true" /> },
  ];

  const filteredElements = aiSnapshot
    ? aiSnapshot.elements.filter((el) => {
        const q = nodeFilter.trim().toLowerCase();
        if (!q) return true;
        return (
          el.label.toLowerCase().includes(q) ||
          el.resourceId.toLowerCase().includes(q) ||
          el.className.toLowerCase().includes(q) ||
          String(el.id) === q
        );
      })
    : [];

  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const apiSnippets = [
    {
      id: 'som',
      title: 'AI Set-of-Marks Snapshot',
      cmd: `curl -s "${origin}/api/v1/instances/${instance.id}/ui/ai-snapshot"`,
    },
    {
      id: 'click',
      title: 'Click AI Element #1',
      cmd: `curl -X POST "${origin}/api/v1/instances/${instance.id}/ui/click" \\\n  -H "Content-Type: application/json" \\\n  -d '{"elementId": 1}'`,
    },
    {
      id: 'proxy',
      title: 'Verify Exit IP Through Proxy',
      cmd: `curl -X POST "${origin}/api/v1/instances/${instance.id}/proxy/verify"`,
    },
    {
      id: 'stealth',
      title: 'Stealth Audit Report',
      cmd: `curl -s "${origin}/api/v1/instances/${instance.id}/device/stealth-check"`,
    },
  ];

  return (
    <div className="nb-panel flex h-full min-h-0 flex-col">
      <div
        role="tablist"
        aria-label="Device Inspector sections"
        className="grid shrink-0 grid-cols-6 border-b-2 border-[var(--border)] bg-[var(--bg-subtle)]"
      >
        {tabs.map((t) => {
          const active = tab === t.id;
          return (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={active}
              title={t.title}
              onClick={() => {
                setTab(t.id);
                if (t.id === 'apps') void loadApps();
              }}
              className={`flex min-h-[44px] min-w-0 items-center justify-center gap-1 border-r-2 border-[var(--border)] px-1 text-xs font-bold whitespace-nowrap transition-colors last:border-r-0 xl:px-1.5 ${
                active
                  ? 'bg-[var(--accent)] text-[var(--accent-ink)]'
                  : 'bg-[var(--bg-surface)] text-[var(--ink-secondary)] hover:bg-[var(--bg-ground)] hover:text-[var(--ink)]'
              }`}
            >
              <span className="hidden 2xl:inline-flex">{t.icon}</span>
              <span className="truncate">{t.label}</span>
            </button>
          );
        })}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3.5 text-[13px] sm:p-4">
        {tab === 'ai' && (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3 className="text-sm font-extrabold text-[var(--ink)]">AI Set-of-Marks Accessibility Tree</h3>
                <p className="text-xs text-[var(--ink-muted)]">
                  {aiSnapshot
                    ? `${aiSnapshot.elements.length} interactive nodes indexed`
                    : 'Dump numbered UI targets for agent automation'}
                </p>
              </div>
              <button
                type="button"
                onClick={onCaptureAiSnapshot}
                disabled={aiSnapshotLoading || instance.status === 'stopped'}
                className="nb-btn nb-btn-primary"
              >
                {aiSnapshotLoading ? 'Capturing...' : 'Capture Snapshot'}
              </button>
            </div>

            {aiSnapshotError && (
              <div className="border-2 border-[var(--border)] bg-[var(--status-err-bg)] p-3 text-[13px] font-semibold text-[var(--status-err-ink)]">
                {aiSnapshotError}
              </div>
            )}

            {clickStatus && (
              <div className="border-2 border-[var(--border)] bg-[var(--status-ok-bg)] px-3 py-2 text-xs font-bold text-[var(--status-ok-ink)]">
                {clickStatus}
              </div>
            )}

            {!aiSnapshot ? (
              <div className="space-y-3">
                <div className="border-2 border-dashed border-[var(--border)] bg-[var(--bg-ground)] p-3.5 text-[13px] text-[var(--ink-secondary)]">
                  {instance.status === 'stopped'
                    ? 'Instance is stopped. Boot this device first before dumping the Android UI hierarchy.'
                    : 'No accessibility snapshot captured yet. Capture a snapshot to inspect clickable nodes and overlay numbered marks on the screen.'}
                </div>

                <div className="nb-panel bg-[var(--bg-ground)] p-3.5">
                  <div className="mb-2.5 border-b-2 border-[var(--border)] pb-1.5 text-[13px] font-extrabold text-[var(--ink)]">
                    Hardware Spec Sheet
                  </div>
                  <dl className="num grid grid-cols-2 gap-x-3 gap-y-2 text-[13px]">
                    <div>
                      <dt className="text-xs font-semibold text-[var(--ink-muted)]">Device Model</dt>
                      <dd className="font-bold text-[var(--ink)]">
                        {instance.profile.brand} {instance.profile.model}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs font-semibold text-[var(--ink-muted)]">Android Release</dt>
                      <dd className="font-bold text-[var(--ink)]">Android {instance.androidVersion}</dd>
                    </div>
                    <div>
                      <dt className="text-xs font-semibold text-[var(--ink-muted)]">Display</dt>
                      <dd className="font-bold text-[var(--ink)]">
                        {instance.width}x{instance.height} ({instance.dpi} dpi)
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs font-semibold text-[var(--ink-muted)]">Compute Allocation</dt>
                      <dd className="font-bold text-[var(--ink)]">
                        {instance.cpus} vCPU · {instance.memoryMb} MB
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs font-semibold text-[var(--ink-muted)]">ADB Endpoint</dt>
                      <dd className="truncate font-bold text-[var(--ink)]">
                        {instance.hostAdbPort ? `Host :${instance.hostAdbPort}` : instance.adbTarget}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs font-semibold text-[var(--ink-muted)]">Stealth Hardening</dt>
                      <dd className="font-bold text-[var(--ink)]">
                        {instance.stealthMode ? 'Enabled (User build)' : 'Disabled'}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs font-semibold text-[var(--ink-muted)]">Play Store (GApps)</dt>
                      <dd className="font-bold text-[var(--ink)]">
                        {instance.enablePlayStore ? 'Enabled (MindTheGapps)' : 'AOSP Only'}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs font-semibold text-[var(--ink-muted)]">Network / Proxy</dt>
                      <dd className="num truncate font-bold text-[var(--ink)]">
                        {instance.proxyConfig
                          ? `${instance.proxyConfig.protocol.toUpperCase()} ${instance.proxyConfig.host}:${instance.proxyConfig.port}`
                          : instance.proxy || 'Direct'}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs font-semibold text-[var(--ink-muted)]">Boot State</dt>
                      <dd className="font-bold text-[var(--ink)]">
                        {health ? (health.bootCompleted ? 'Boot completed' : 'Booting') : instance.status}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs font-semibold text-[var(--ink-muted)]">Live RAM</dt>
                      <dd className="font-bold text-[var(--ink)]">
                        {health?.memoryUsageMb != null ? `${Math.round(health.memoryUsageMb)} MB` : '-'}
                      </dd>
                    </div>
                  </dl>
                </div>
              </div>
            ) : (
              <div className="space-y-2.5">
                <div>
                  <label htmlFor="som-filter" className="sr-only">
                    Filter UI elements
                  </label>
                  <input
                    id="som-filter"
                    value={nodeFilter}
                    onChange={(e) => setNodeFilter(e.target.value)}
                    placeholder="Filter nodes by label, resource ID, or #..."
                    className="nb-input"
                  />
                </div>

                {filteredElements.length === 0 ? (
                  <div className="border-2 border-dashed border-[var(--border)] p-4 text-center text-[13px] text-[var(--ink-muted)]">
                    No UI elements match &ldquo;{nodeFilter}&rdquo;.
                  </div>
                ) : (
                  <div className="space-y-2">
                    {filteredElements.map((el) => (
                      <div
                        key={el.id}
                        className="nb-panel flex items-center justify-between gap-2 bg-[var(--bg-ground)] p-2.5"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="num shrink-0 border-2 border-[var(--border)] bg-[var(--accent)] px-1.5 py-0.5 text-xs font-extrabold text-[var(--accent-ink)]">
                              #{el.id}
                            </span>
                            <span className="truncate font-bold text-[var(--ink)]">
                              {el.label || el.className}
                            </span>
                          </div>
                          <div className="num mt-1 truncate text-xs text-[var(--ink-muted)]">
                            <code>{el.resourceId || el.className}</code> ({el.bounds.centerX}, {el.bounds.centerY})
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() => void clickAiElement(el.id, el.label)}
                          className="nb-btn nb-btn-secondary shrink-0 px-3"
                        >
                          Click
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {tab === 'apps' && (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-extrabold text-[var(--ink)]">Installed User Packages</h3>
              <button
                type="button"
                onClick={() => void loadApps()}
                disabled={appsLoading}
                className="nb-btn nb-btn-secondary"
              >
                <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
                {appsLoading ? 'Loading...' : 'Refresh'}
              </button>
            </div>

            <label className="flex min-h-[52px] cursor-pointer items-center justify-center gap-2 border-2 border-dashed border-[var(--border)] bg-[var(--bg-ground)] p-3.5 text-[13px] font-bold text-[var(--ink)] hover:bg-[var(--bg-subtle)]">
              <Upload className="h-4 w-4 shrink-0" aria-hidden="true" />
              <span>{uploadingApk ? 'Installing APK...' : 'Upload and Install APK (.apk)'}</span>
              <input
                type="file"
                accept=".apk"
                disabled={uploadingApk}
                className="sr-only"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void uploadApk(f);
                  e.target.value = '';
                }}
              />
            </label>

            {appsError && (
              <div className="flex flex-wrap items-center justify-between gap-2 border-2 border-[var(--border)] bg-[var(--status-err-bg)] p-3 text-[13px] font-semibold text-[var(--status-err-ink)]">
                <span>Could not load apps: {appsError}</span>
                <button type="button" onClick={() => void loadApps()} className="nb-btn nb-btn-secondary">
                  Retry
                </button>
              </div>
            )}

            {appsStatusMsg && (
              <div className="border-2 border-[var(--border)] bg-[var(--status-ok-bg)] px-3 py-2 text-xs font-bold text-[var(--status-ok-ink)]">
                {appsStatusMsg}
              </div>
            )}

            {appsLoading ? (
              <div className="space-y-2">
                <div className="h-12 border-2 border-[var(--border-subtle)] bg-[var(--bg-subtle)]" />
                <div className="h-12 border-2 border-[var(--border-subtle)] bg-[var(--bg-subtle)]" />
              </div>
            ) : packages.length === 0 && !appsError ? (
              <div className="border-2 border-dashed border-[var(--border)] p-4 text-center text-[13px] text-[var(--ink-muted)]">
                No user-installed APKs found on this device.
              </div>
            ) : (
              <div className="space-y-2">
                {packages.map((pkg) => (
                  <div
                    key={pkg}
                    className="nb-panel flex flex-wrap items-center justify-between gap-2 bg-[var(--bg-ground)] p-2.5"
                  >
                    <code className="min-w-0 flex-1 truncate text-[13px] font-bold text-[var(--ink)]">{pkg}</code>
                    <div className="flex shrink-0 items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => void launchPackage(pkg)}
                        className="nb-btn nb-btn-primary px-3"
                        aria-label={`Launch ${pkg}`}
                      >
                        <Play className="h-3.5 w-3.5" aria-hidden="true" />
                        <span>Launch</span>
                      </button>
                      {confirmUninstallPkg === pkg ? (
                        <>
                          <button
                            type="button"
                            onClick={() => void uninstallPackage(pkg)}
                            className="nb-btn nb-btn-danger px-2.5"
                          >
                            Confirm
                          </button>
                          <button
                            type="button"
                            onClick={() => setConfirmUninstallPkg(null)}
                            className="nb-btn nb-btn-secondary px-2.5"
                          >
                            Cancel
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setConfirmUninstallPkg(pkg)}
                          className="nb-btn nb-btn-danger px-2.5"
                          aria-label={`Uninstall ${pkg}`}
                        >
                          <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {tab === 'stealth' && (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3 className="text-sm font-extrabold text-[var(--ink)]">Anti-Emulator Stealth Audit</h3>
                <p className="text-xs text-[var(--ink-muted)]">Verify build props, HAL markers, identity, and ABI</p>
              </div>
              <button
                type="button"
                onClick={() => void runStealthCheck()}
                disabled={stealthLoading || instance.status === 'stopped'}
                className="nb-btn nb-btn-primary"
              >
                {stealthLoading ? 'Auditing...' : 'Run Stealth Check'}
              </button>
            </div>

            {stealthError && (
              <div className="flex flex-wrap items-center justify-between gap-2 border-2 border-[var(--border)] bg-[var(--status-err-bg)] p-3 text-[13px] font-semibold text-[var(--status-err-ink)]">
                <span>Stealth audit failed: {stealthError}</span>
                <button type="button" onClick={() => void runStealthCheck()} className="nb-btn nb-btn-secondary">
                  Retry
                </button>
              </div>
            )}

            {!stealthReport && !stealthLoading && !stealthError && (
              <div className="border-2 border-dashed border-[var(--border)] bg-[var(--bg-ground)] p-3.5 text-[13px] text-[var(--ink-secondary)]">
                Run the audit to inspect live Redroid system properties against real physical device fingerprints.
              </div>
            )}

            {stealthReport && (
              <div className="space-y-2.5">
                <div className="nb-panel bg-[var(--bg-ground)] p-3">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-[13px] font-bold text-[var(--ink)]">Stealth Score</span>
                    <span className="num text-2xl font-extrabold text-[var(--ink)]">{stealthReport.score} / 100</span>
                  </div>
                  <div className="mt-2 h-3 w-full border-2 border-[var(--border)] bg-[var(--bg-surface)]">
                    <div
                      className="h-full bg-[var(--accent)]"
                      style={{ width: `${Math.max(0, Math.min(100, stealthReport.score))}%` }}
                    />
                  </div>
                  <div className="num mt-2 flex flex-wrap gap-3 text-xs font-bold text-[var(--ink-secondary)]">
                    <span>Passed: {stealthReport.passed}</span>
                    <span>Warnings: {stealthReport.warnings}</span>
                    <span>Failed: {stealthReport.failed}</span>
                  </div>
                </div>

                {stealthReport.checks.map((c) => (
                  <div key={c.key} className="nb-panel bg-[var(--bg-ground)] p-2.5">
                    <div className="flex items-center justify-between gap-2">
                      <code className="truncate text-[13px] font-bold text-[var(--ink)]">{c.key}</code>
                      <span
                        className={`shrink-0 border-2 border-[var(--border)] px-2 py-0.5 text-xs font-extrabold uppercase ${
                          c.status === 'pass'
                            ? 'bg-[var(--status-ok-bg)] text-[var(--status-ok-ink)]'
                            : c.status === 'warn'
                              ? 'bg-[var(--status-warn-bg)] text-[var(--status-warn-ink)]'
                              : 'bg-[var(--status-err-bg)] text-[var(--status-err-ink)]'
                        }`}
                      >
                        {c.status}
                      </span>
                    </div>
                    <div className="mt-1 truncate text-xs text-[var(--ink-secondary)]">
                      <code>{c.actual}</code>
                    </div>
                    <div className="mt-0.5 text-xs text-[var(--ink-muted)]">{c.detail}</div>
                  </div>
                ))}
              </div>
            )}

            <div className="space-y-2.5 border-t-2 border-[var(--border)] pt-3">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5 text-sm font-extrabold text-[var(--ink)]">
                  <Cpu className="h-4 w-4 shrink-0" aria-hidden="true" />
                  <span>Quick ADB Shell</span>
                </div>
                {shellOut && (
                  <button type="button" onClick={() => setShellOut('')} className="nb-btn nb-btn-secondary px-2.5">
                    Clear
                  </button>
                )}
              </div>

              <form onSubmit={(e) => void runShell(e)} className="flex gap-2">
                <label htmlFor="adb-shell-input" className="sr-only">
                  ADB shell command
                </label>
                <input
                  id="adb-shell-input"
                  value={shellCmd}
                  onChange={(e) => setShellCmd(e.target.value)}
                  className="nb-input flex-1 text-[13px]"
                />
                <button type="submit" disabled={shellRunning} className="nb-btn nb-btn-primary shrink-0">
                  {shellRunning ? 'Running...' : 'Run'}
                </button>
              </form>

              {shellError && (
                <div className="border-2 border-[var(--border)] bg-[var(--status-err-bg)] p-2.5 text-xs font-semibold text-[var(--status-err-ink)]">
                  {shellError}
                </div>
              )}

              {shellOut && (
                <pre className="max-h-48 overflow-auto border-2 border-[var(--border)] bg-[var(--bg-terminal)] p-3 text-xs text-[var(--ink-terminal)]">
                  <code>{shellOut}</code>
                </pre>
              )}
            </div>
          </div>
        )}

        {tab === 'proxy' && (
          <ProxyPanel instance={instance} onProxyChanged={() => onInstanceRefresh?.()} />
        )}

        {tab === 'logcat' && (
          <div className="flex h-full min-h-[260px] flex-col gap-2.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <label htmlFor="logcat-level" className="sr-only">
                  Logcat level
                </label>
                <select
                  id="logcat-level"
                  value={logLevel}
                  onChange={(e) => setLogLevel(e.target.value)}
                  className="nb-input w-auto min-w-[130px]"
                >
                  <option value="V">Verbose (V)</option>
                  <option value="D">Debug (D)</option>
                  <option value="I">Info (I)</option>
                  <option value="W">Warn (W)</option>
                  <option value="E">Error (E)</option>
                </select>
                <span className="border-2 border-[var(--border)] bg-[var(--bg-subtle)] px-2 py-1 text-xs font-bold text-[var(--ink)]">
                  {logWsState}
                </span>
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setLogPaused((v) => !v)}
                  className={`nb-btn ${logPaused ? 'nb-btn-primary' : 'nb-btn-secondary'}`}
                >
                  {logPaused ? <Play className="h-3.5 w-3.5" aria-hidden="true" /> : <Pause className="h-3.5 w-3.5" aria-hidden="true" />}
                  <span>{logPaused ? 'Resume' : 'Pause'}</span>
                </button>
                <button type="button" onClick={() => setLogs([])} className="nb-btn nb-btn-secondary">
                  Clear
                </button>
              </div>
            </div>

            <pre className="min-h-0 flex-1 overflow-auto border-2 border-[var(--border)] bg-[var(--bg-terminal)] p-3 text-xs leading-relaxed text-[var(--ink-terminal)]">
              <code>
                {logs.length === 0
                  ? instance.status === 'stopped'
                    ? 'Instance is stopped. Boot it to stream live logcat output.'
                    : 'Waiting for Android logcat output...'
                  : logs.join('\n')}
              </code>
              <div ref={logEndRef} />
            </pre>
          </div>
        )}

        {tab === 'api' && (
          <div className="space-y-4">
            <a
              href="/docs"
              target="_blank"
              rel="noreferrer"
              className="nb-btn nb-btn-primary w-full justify-center text-sm"
            >
              Open Interactive Swagger UI (/docs)
            </a>

            <div className="nb-panel bg-[var(--bg-ground)] p-3">
              <div className="text-xs font-bold text-[var(--ink-muted)]">Active Instance ID</div>
              <div className="mt-1 flex items-center justify-between gap-2">
                <code className="truncate text-[13px] font-bold text-[var(--ink)]">{instance.id}</code>
                <button
                  type="button"
                  onClick={() => void copySnippet('inst-id', instance.id)}
                  className="nb-btn nb-btn-secondary px-2.5"
                >
                  {copiedId === 'inst-id' ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                  <span>{copiedId === 'inst-id' ? 'Copied' : 'Copy'}</span>
                </button>
              </div>
            </div>

            {apiSnippets.map((item) => (
              <div key={item.id} className="space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[13px] font-bold text-[var(--ink)]">{item.title}</span>
                  <button
                    type="button"
                    onClick={() => void copySnippet(item.id, item.cmd)}
                    className="nb-btn nb-btn-secondary px-2.5"
                  >
                    {copiedId === item.id ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                    <span>{copiedId === item.id ? 'Copied' : 'Copy'}</span>
                  </button>
                </div>
                <pre className="overflow-auto border-2 border-[var(--border)] bg-[var(--bg-terminal)] p-3 text-xs text-[var(--ink-terminal)]">
                  <code>{item.cmd}</code>
                </pre>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
