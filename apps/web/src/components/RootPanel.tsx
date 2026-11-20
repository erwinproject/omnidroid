import React, { useCallback, useEffect, useState } from 'react';
import type { InstanceRecord, RootMode, RootStatusResponse } from '@droidforge/shared';
import { Check, Lock, Plus, RefreshCw, ShieldAlert, Trash2, Unlock } from 'lucide-react';
import { createClient, getApiKey } from '../api/client';

interface Props {
  instance: InstanceRecord;
  onRootChanged?: () => void;
}

export const RootPanel: React.FC<Props> = ({ instance, onRootChanged }) => {
  const [status, setStatus] = useState<RootStatusResponse | null>(null);
  const [packages, setPackages] = useState<string[]>([]);
  const [selectedPkg, setSelectedPkg] = useState('');
  const [customPkg, setCustomPkg] = useState('');
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const stopped = instance.status === 'stopped';

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const client = createClient();
      const rootRes = await client.device.getRoot(instance.id);
      setStatus(rootRes);

      if (!stopped) {
        const res = await fetch(`/api/v1/instances/${instance.id}/apps?type=user`, {
          headers: getApiKey() ? { 'X-API-Key': getApiKey() } : {},
        });
        if (res.ok) {
          const data = (await res.json()) as { packages: string[] };
          setPackages(data.packages);
          if (data.packages.length > 0) {
            setSelectedPkg((prev) => (prev && data.packages.includes(prev) ? prev : data.packages[0]!));
          }
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [instance.id, stopped]);

  useEffect(() => {
    void load();
  }, [load, instance.enableRoot, instance.status]);

  async function applyRootPatch(patch: {
    enabled?: boolean;
    mode?: RootMode;
    adbRoot?: boolean;
    allowedPackages?: string[];
  }) {
    setBusy(true);
    setError(null);
    try {
      const updated = await createClient().device.setRoot(instance.id, patch);
      setStatus(updated);
      onRootChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function grantPackage(pkg: string) {
    const trimmed = pkg.trim();
    if (!trimmed) return;
    setBusy(true);
    setError(null);
    try {
      const updated = await createClient().device.grantRootApp(instance.id, trimmed);
      setStatus(updated);
      setCustomPkg('');
      onRootChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function revokePackage(pkg: string) {
    setBusy(true);
    setError(null);
    try {
      const updated = await createClient().device.revokeRootApp(instance.id, pkg);
      setStatus(updated);
      onRootChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const enabled = status?.enabled ?? instance.enableRoot;
  const mode = status?.mode ?? instance.rootConfig.mode;
  const adbRoot = status?.adbRoot ?? instance.rootConfig.adbRoot;
  const allowedPackages = status?.allowedPackages ?? instance.rootConfig.allowedPackages;
  const recentLogs = status?.recentLogs ?? [];

  const badgeText = stopped
    ? 'Stopped'
    : enabled
      ? status?.daemonRunning && status?.suBinaryPresent
        ? 'Root Active'
        : 'Root Syncing'
      : 'Root Off (Stealth Clean)';

  const badgeClass = stopped
    ? 'bg-[var(--status-idle-bg)] text-[var(--status-idle-ink)]'
    : enabled
      ? 'bg-[var(--status-ok-bg)] text-[var(--status-ok-ink)]'
      : 'bg-[var(--bg-subtle)] text-[var(--ink-secondary)]';

  return (
    <div className="space-y-3 border-b-2 border-[var(--border)] pb-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-extrabold text-[var(--ink)]">Root Access (su)</h3>
            <span className={`border-2 border-[var(--border)] px-2 py-0.5 text-xs font-extrabold ${badgeClass}`}>
              {badgeText}
            </span>
          </div>
          <p className="mt-0.5 text-xs text-[var(--ink-muted)]">
            Live toggle without reboot. Installs <code>/system/bin/su</code> and <code>df-su</code> daemon.
          </p>
        </div>

        <div className="flex items-center gap-1.5">
          <button
            type="button"
            disabled={loading}
            onClick={() => void load()}
            aria-label="Refresh root status"
            className="nb-btn nb-btn-secondary px-2.5"
          >
            <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void applyRootPatch({ enabled: !enabled })}
            className={`nb-btn ${enabled ? 'nb-btn-danger' : 'nb-btn-primary'}`}
          >
            {enabled ? <Lock className="h-3.5 w-3.5" aria-hidden="true" /> : <Unlock className="h-3.5 w-3.5" aria-hidden="true" />}
            <span>{busy ? 'Applying...' : enabled ? 'Disable Root' : 'Enable Root'}</span>
          </button>
        </div>
      </div>

      {error && (
        <div className="border-2 border-[var(--border)] bg-[var(--status-err-bg)] p-2.5 text-xs font-semibold text-[var(--status-err-ink)]">
          {error}
        </div>
      )}

      {enabled && (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => void applyRootPatch({ mode: 'allow_all' })}
              className={`nb-btn ${mode === 'allow_all' ? 'nb-btn-primary' : 'nb-btn-secondary'}`}
            >
              Allow All Apps
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void applyRootPatch({ mode: 'allowlist' })}
              className={`nb-btn ${mode === 'allowlist' ? 'nb-btn-primary' : 'nb-btn-secondary'}`}
            >
              Allowlist Only
            </button>
          </div>

          <label className="flex min-h-[42px] cursor-pointer items-center gap-2.5 border-2 border-[var(--border)] bg-[var(--bg-ground)] px-3 py-2 text-xs font-bold text-[var(--ink)]">
            <input
              type="checkbox"
              checked={adbRoot}
              disabled={busy}
              onChange={(e) => void applyRootPatch({ adbRoot: e.target.checked })}
              className="h-4 w-4 shrink-0 accent-[var(--ink)]"
            />
            <span>Allow ADB Shell (<code>su</code> from <code>adb shell</code>)</span>
          </label>

          {mode === 'allowlist' && (
            <div className="space-y-2 border-2 border-[var(--border)] bg-[var(--bg-ground)] p-3">
              <div className="text-xs font-extrabold text-[var(--ink)]">Authorized Apps ({allowedPackages.length})</div>
              {packages.length > 0 && (
                <div className="flex gap-2">
                  <select
                    value={selectedPkg}
                    onChange={(e) => setSelectedPkg(e.target.value)}
                    disabled={busy}
                    className="nb-input min-w-0 flex-1 text-xs"
                    aria-label="Installed app package"
                  >
                    {packages.map((p) => (
                      <option key={p} value={p}>
                        {p}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    disabled={busy || !selectedPkg}
                    onClick={() => void grantPackage(selectedPkg)}
                    className="nb-btn nb-btn-primary shrink-0 px-3"
                  >
                    <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                    <span>Grant</span>
                  </button>
                </div>
              )}

              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void grantPackage(customPkg);
                }}
                className="flex gap-2"
              >
                <label htmlFor="root-custom-pkg" className="sr-only">
                  Package name to grant root
                </label>
                <input
                  id="root-custom-pkg"
                  value={customPkg}
                  onChange={(e) => setCustomPkg(e.target.value)}
                  placeholder="com.example.app"
                  disabled={busy}
                  className="nb-input min-w-0 flex-1 text-xs"
                />
                <button
                  type="submit"
                  disabled={busy || !customPkg.trim()}
                  className="nb-btn nb-btn-secondary shrink-0 px-3"
                >
                  Grant Pkg
                </button>
              </form>

              {allowedPackages.length === 0 ? (
                <p className="text-xs text-[var(--ink-muted)]">
                  No apps authorized yet. Grant a package above or switch to Allow All Apps.
                </p>
              ) : (
                <div className="space-y-1.5">
                  {allowedPackages.map((pkg) => (
                    <div
                      key={pkg}
                      className="flex items-center justify-between gap-2 border-2 border-[var(--border)] bg-[var(--bg-surface)] px-2.5 py-1.5"
                    >
                      <code className="min-w-0 flex-1 truncate text-xs font-bold text-[var(--ink)]">{pkg}</code>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void revokePackage(pkg)}
                        className="nb-btn nb-btn-danger px-2"
                        aria-label={`Revoke root for ${pkg}`}
                      >
                        <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-extrabold text-[var(--ink)]">Recent su Requests</span>
              <span className="num text-[11px] font-semibold text-[var(--ink-muted)]">
                {recentLogs.length} logged
              </span>
            </div>
            {recentLogs.length === 0 ? (
              <div className="border-2 border-dashed border-[var(--border)] p-2.5 text-xs text-[var(--ink-muted)]">
                No su requests recorded yet.
              </div>
            ) : (
              <div className="max-h-44 space-y-1.5 overflow-y-auto">
                {recentLogs.slice(0, 10).map((entry, idx) => (
                  <div
                    key={`${entry.timestamp}-${entry.pid}-${idx}`}
                    className="flex items-center justify-between gap-2 border-2 border-[var(--border)] bg-[var(--bg-ground)] p-2 text-xs"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span
                          className={`inline-flex items-center gap-1 border border-[var(--border)] px-1.5 py-0.5 text-[10px] font-extrabold ${
                            entry.allowed
                              ? 'bg-[var(--status-ok-bg)] text-[var(--status-ok-ink)]'
                              : 'bg-[var(--status-err-bg)] text-[var(--status-err-ink)]'
                          }`}
                        >
                          {entry.allowed ? <Check className="h-2.5 w-2.5" /> : <ShieldAlert className="h-2.5 w-2.5" />}
                          {entry.allowed ? 'ALLOW' : 'DENY'}
                        </span>
                        <code className="truncate font-bold text-[var(--ink)]">
                          {entry.packageName ?? `uid:${entry.uid}`}
                        </code>
                      </div>
                      <div className="num mt-0.5 truncate text-[11px] text-[var(--ink-muted)]">{entry.command}</div>
                    </div>
                    {!entry.allowed &&
                      entry.packageName &&
                      entry.packageName !== 'com.android.shell' &&
                      !allowedPackages.includes(entry.packageName) && (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void grantPackage(entry.packageName!)}
                          className="nb-btn nb-btn-primary shrink-0 px-2 py-1 text-[11px]"
                        >
                          Allow
                        </button>
                      )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
