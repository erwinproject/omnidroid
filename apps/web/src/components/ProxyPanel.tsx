import React, { useCallback, useEffect, useState } from 'react';
import {
  formatProxyUrl,
  parseProxyString,
  type InstanceProxyState,
  type InstanceProxyVerifyResult,
  type InstanceRecord,
  type ProxyConfig,
  type ProxyProfile,
  type ProxyProtocol,
  type ProxyTestResult,
} from '@droidforge/shared';
import {
  Activity,
  CheckCircle2,
  Eye,
  EyeOff,
  Globe,
  Plus,
  RefreshCw,
  ShieldCheck,
  Trash2,
  Upload,
  Wifi,
  WifiOff,
  Zap,
} from 'lucide-react';
import { createClient } from '../api/client';

interface Props {
  instance: InstanceRecord;
  onProxyChanged: () => void;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export const ProxyPanel: React.FC<Props> = ({ instance, onProxyChanged }) => {
  const [proxyState, setProxyState] = useState<InstanceProxyState | null>(null);
  const [stateLoading, setStateLoading] = useState(false);
  const [stateError, setStateError] = useState<string | null>(null);

  const [pool, setPool] = useState<ProxyProfile[]>([]);
  const [poolLoading, setPoolLoading] = useState(false);
  const [poolError, setPoolError] = useState<string | null>(null);

  const [smartPaste, setSmartPaste] = useState('');
  const [poolName, setPoolName] = useState('');
  const [protocol, setProtocol] = useState<ProxyProtocol>('http');
  const [host, setHost] = useState('');
  const [port, setPort] = useState('8080');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [bypass, setBypass] = useState('localhost,127.0.0.1');
  const [syncTimezone, setSyncTimezone] = useState(true);

  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [actionMsg, setActionMsg] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const [testResult, setTestResult] = useState<ProxyTestResult | null>(null);
  const [verifyResult, setVerifyResult] = useState<InstanceProxyVerifyResult | null>(null);

  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkText, setBulkText] = useState('');
  const [bulkProtocol, setBulkProtocol] = useState<ProxyProtocol>('http');
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const loadProxyState = useCallback(async (quiet = false) => {
    if (!quiet) {
      setStateLoading(true);
      setStateError(null);
    }
    try {
      const state = await createClient().instances.getProxy(instance.id);
      setProxyState(state);
      setStateError(null);
    } catch (e) {
      setStateError(e instanceof Error ? e.message : String(e));
    } finally {
      if (!quiet) setStateLoading(false);
    }
  }, [instance.id]);

  const loadPool = useCallback(async () => {
    setPoolLoading(true);
    setPoolError(null);
    try {
      const items = await createClient().proxies.list();
      setPool(items);
    } catch (e) {
      setPoolError(e instanceof Error ? e.message : String(e));
    } finally {
      setPoolLoading(false);
    }
  }, []);

  useEffect(() => {
    setVerifyResult(null);
    setTestResult(null);
    setActionMsg(null);
    setActionError(null);
    setConfirmDeleteId(null);
    void loadProxyState(false);
    void loadPool();
  }, [instance.id, loadProxyState, loadPool]);

  useEffect(() => {
    const timer = setInterval(() => {
      void loadProxyState(true);
    }, 5000);
    return () => clearInterval(timer);
  }, [loadProxyState]);

  function buildFormConfig(): ProxyConfig {
    const parsedPort = Number(port);
    if (!host.trim()) {
      throw new Error('Proxy host is required.');
    }
    if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
      throw new Error('Proxy port must be between 1 and 65535.');
    }
    return {
      protocol,
      host: host.trim(),
      port: parsedPort,
      ...(username.trim() ? { username: username.trim() } : {}),
      ...(password ? { password } : {}),
      bypass: bypass.trim() || 'localhost,127.0.0.1',
    };
  }

  function applyParsedString(raw: string) {
    setActionError(null);
    const trimmed = raw.trim();
    if (!trimmed) return;
    try {
      const parsed = parseProxyString(trimmed, protocol, bypass);
      setProtocol(parsed.protocol);
      setHost(parsed.host);
      setPort(String(parsed.port));
      setUsername(parsed.username ?? '');
      setPassword(parsed.password ?? '');
      setBypass(parsed.bypass);
      if (!poolName.trim()) {
        setPoolName(`${parsed.host}:${parsed.port}`);
      }
      setActionMsg(`Parsed ${parsed.protocol.toUpperCase()} endpoint ${parsed.host}:${parsed.port}.`);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleTestForm() {
    setActionError(null);
    setActionMsg(null);
    setActionBusy('test-form');
    try {
      const config = buildFormConfig();
      const result = await createClient().proxies.test({ config });
      setTestResult(result);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setActionBusy(null);
    }
  }

  async function handleApplyForm() {
    setActionError(null);
    setActionMsg(null);
    setActionBusy('apply-form');
    try {
      const config = buildFormConfig();
      const updated = await createClient().instances.setProxy(instance.id, {
        enabled: true,
        config,
        syncTimezone,
      });
      setProxyState(updated);
      setVerifyResult(null);
      setActionMsg(
        instance.status === 'stopped'
          ? 'Proxy saved and will activate automatically when this instance boots.'
          : `Live proxy relay active via ${updated.relayEndpoint ?? 'instance relay'}.`,
      );
      onProxyChanged();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setActionBusy(null);
    }
  }

  async function handleSaveToPool() {
    setActionError(null);
    setActionMsg(null);
    setActionBusy('save-pool');
    try {
      const config = buildFormConfig();
      const created = await createClient().proxies.create({
        name: poolName.trim() || `${config.protocol.toUpperCase()} ${config.host}:${config.port}`,
        protocol: config.protocol,
        host: config.host,
        port: config.port,
        ...(config.username ? { username: config.username } : {}),
        ...(config.password ? { password: config.password } : {}),
        bypass: config.bypass,
      });
      setPool((prev) => [created, ...prev]);
      setPoolName('');
      setActionMsg(`Saved "${created.name}" to proxy pool.`);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setActionBusy(null);
    }
  }

  async function handleClearProxy() {
    setActionError(null);
    setActionMsg(null);
    setActionBusy('clear');
    try {
      const updated = await createClient().instances.clearProxy(instance.id);
      setProxyState(updated);
      setVerifyResult(null);
      setActionMsg('Instance switched to Direct network (proxy cleared).');
      onProxyChanged();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setActionBusy(null);
    }
  }

  async function handleVerifyInsideAndroid() {
    setActionError(null);
    setActionMsg(null);
    setActionBusy('verify');
    try {
      const res = await createClient().instances.verifyProxy(instance.id);
      setVerifyResult(res);
      await loadProxyState(true);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setActionBusy(null);
    }
  }

  async function handleTestPoolItem(item: ProxyProfile) {
    setActionError(null);
    setActionMsg(null);
    setActionBusy(`test:${item.id}`);
    try {
      const res = await createClient().proxies.testById(item.id);
      setTestResult(res);
      await loadPool();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setActionBusy(null);
    }
  }

  async function handleApplyPoolItem(item: ProxyProfile) {
    setActionError(null);
    setActionMsg(null);
    setActionBusy(`apply:${item.id}`);
    try {
      const updated = await createClient().instances.setProxy(instance.id, {
        enabled: true,
        proxyProfileId: item.id,
        syncTimezone,
      });
      setProxyState(updated);
      setVerifyResult(null);
      setProtocol(item.protocol);
      setHost(item.host);
      setPort(String(item.port));
      setUsername(item.username ?? '');
      setBypass(item.bypass);
      setActionMsg(
        instance.status === 'stopped'
          ? `Attached "${item.name}". Relay will boot with instance.`
          : `Live traffic routed through "${item.name}".`,
      );
      onProxyChanged();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setActionBusy(null);
    }
  }

  async function handleDeletePoolItem(id: string) {
    setActionError(null);
    setActionMsg(null);
    setActionBusy(`delete:${id}`);
    try {
      await createClient().proxies.delete(id);
      setPool((prev) => prev.filter((p) => p.id !== id));
      setConfirmDeleteId(null);
      setActionMsg('Proxy deleted from pool.');
      await loadProxyState(true);
      onProxyChanged();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setActionBusy(null);
    }
  }

  async function handleBulkImport() {
    if (!bulkText.trim()) return;
    setActionError(null);
    setActionMsg(null);
    setActionBusy('bulk-import');
    try {
      const res = await createClient().proxies.import({
        text: bulkText,
        defaultProtocol: bulkProtocol,
      });
      await loadPool();
      setBulkText('');
      setBulkOpen(false);
      setActionMsg(`Imported ${res.imported.length} proxies (${res.failed.length} skipped).`);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setActionBusy(null);
    }
  }

  return (
    <div className="space-y-4">
      {/* Feedback Banners */}
      {actionError && (
        <div className="border-2 border-[var(--border)] bg-[var(--status-err-bg)] p-3 text-[13px] font-semibold text-[var(--status-err-ink)]">
          {actionError}
        </div>
      )}
      {actionMsg && (
        <div className="border-2 border-[var(--border)] bg-[var(--status-ok-bg)] p-3 text-[13px] font-semibold text-[var(--status-ok-ink)]">
          {actionMsg}
        </div>
      )}

      {/* 1. Active Network Status & Live Relay Telemetry */}
      <section className="nb-panel bg-[var(--bg-ground)] p-3 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Globe className="h-4 w-4 shrink-0 text-[var(--ink)]" aria-hidden="true" />
            <h3 className="text-sm font-extrabold text-[var(--ink)]">Active Instance Network</h3>
          </div>
          <div className="flex items-center gap-2">
            {proxyState?.enabled && proxyState.config ? (
              <span className="inline-flex items-center gap-1 border-2 border-[var(--border)] bg-[var(--status-ok-bg)] px-2 py-0.5 text-xs font-extrabold uppercase text-[var(--status-ok-ink)]">
                <Wifi className="h-3.5 w-3.5" aria-hidden="true" />
                {proxyState.config.protocol} Relay
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 border-2 border-[var(--border)] bg-[var(--bg-subtle)] px-2 py-0.5 text-xs font-extrabold uppercase text-[var(--ink)]">
                <WifiOff className="h-3.5 w-3.5" aria-hidden="true" />
                Direct
              </span>
            )}
            <button
              type="button"
              onClick={() => void loadProxyState(false)}
              disabled={stateLoading}
              aria-label="Refresh proxy status"
              className="nb-btn nb-btn-secondary px-2.5"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${stateLoading ? 'animate-spin' : ''}`} aria-hidden="true" />
            </button>
          </div>
        </div>

        {stateError && (
          <div className="border-2 border-[var(--border)] bg-[var(--status-err-bg)] p-2.5 text-xs font-semibold text-[var(--status-err-ink)]">
            {stateError}
          </div>
        )}

        <dl className="grid grid-cols-2 gap-x-3 gap-y-2 border-t-2 border-[var(--border-subtle)] pt-2.5 text-xs">
          <div>
            <dt className="font-semibold text-[var(--ink-muted)]">Upstream Proxy</dt>
            <dd className="num truncate font-bold text-[var(--ink)]">
              {proxyState?.enabled && proxyState.config
                ? formatProxyUrl(
                    {
                      ...proxyState.config,
                      password: proxyState.config.hasPassword ? '***' : undefined,
                    },
                    true,
                  )
                : 'None (Direct host egress)'}
            </dd>
          </div>
          <div>
            <dt className="font-semibold text-[var(--ink-muted)]">Local Relay Bridge</dt>
            <dd className="num truncate font-bold text-[var(--ink)]">
              {proxyState?.relayEndpoint ? (
                <code>{proxyState.relayEndpoint}</code>
              ) : proxyState?.enabled ? (
                'Starts on boot'
              ) : (
                'Inactive'
              )}
            </dd>
          </div>
          <div>
            <dt className="font-semibold text-[var(--ink-muted)]">Android Setting</dt>
            <dd className="num truncate font-bold text-[var(--ink)]">
              {proxyState?.androidHttpProxy ? <code>{proxyState.androidHttpProxy}</code> : 'Direct (:0)'}
            </dd>
          </div>
          <div>
            <dt className="font-semibold text-[var(--ink-muted)]">Relay Traffic</dt>
            <dd className="num font-bold text-[var(--ink)]">
              {proxyState
                ? `${proxyState.stats.totalRequests} req / ${formatBytes(proxyState.stats.bytesIn + proxyState.stats.bytesOut)} (${proxyState.stats.activeConnections} open)`
                : '0 req'}
            </dd>
          </div>
        </dl>

        {proxyState?.stats.lastError && (
          <div className="border-2 border-[var(--border)] bg-[var(--status-warn-bg)] p-2 text-xs font-semibold text-[var(--status-warn-ink)]">
            Last relay notice: {proxyState.stats.lastError}
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={actionBusy !== null || instance.status === 'stopped'}
            onClick={() => void handleVerifyInsideAndroid()}
            className="nb-btn nb-btn-primary flex-1"
          >
            <ShieldCheck className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span>{actionBusy === 'verify' ? 'Verifying...' : 'Verify Exit IP in Android'}</span>
          </button>
          {proxyState?.enabled && (
            <button
              type="button"
              disabled={actionBusy !== null}
              onClick={() => void handleClearProxy()}
              className="nb-btn nb-btn-secondary"
            >
              {actionBusy === 'clear' ? 'Clearing...' : 'Set Direct'}
            </button>
          )}
        </div>

        {verifyResult && (
          <div
            className={`border-2 border-[var(--border)] p-3 text-xs ${
              verifyResult.ok
                ? 'bg-[var(--status-ok-bg)] text-[var(--status-ok-ink)]'
                : 'bg-[var(--status-err-bg)] text-[var(--status-err-ink)]'
            }`}
          >
            <div className="flex items-center justify-between gap-2 font-extrabold">
              <span>
                Android Exit IP Check: {verifyResult.ok ? (verifyResult.viaProxy ? 'Routed via Proxy' : 'Direct Egress') : 'Failed'}
              </span>
              {verifyResult.latencyMs !== null && <span className="num">{verifyResult.latencyMs} ms</span>}
            </div>
            {verifyResult.ok ? (
              <div className="num mt-1.5 space-y-0.5 font-semibold">
                <div>IP: {verifyResult.exitIp ?? 'Unknown'}</div>
                <div>
                  Location: {[verifyResult.city, verifyResult.countryCode].filter(Boolean).join(', ') || 'Unknown'}
                  {verifyResult.timezone ? ` (${verifyResult.timezone})` : ''}
                </div>
                {verifyResult.isp && <div className="truncate">ISP: {verifyResult.isp}</div>}
              </div>
            ) : (
              <div className="mt-1 font-semibold">{verifyResult.error}</div>
            )}
          </div>
        )}
      </section>

      {/* 2. Attach / Switch / Test Proxy Form */}
      <section className="nb-panel bg-[var(--bg-ground)] p-3 space-y-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Activity className="h-4 w-4 shrink-0 text-[var(--ink)]" aria-hidden="true" />
            <h3 className="text-sm font-extrabold text-[var(--ink)]">Configure & Test Proxy</h3>
          </div>
        </div>

        <div>
          <label htmlFor="proxy-smart-paste" className="mb-1 block text-xs font-bold text-[var(--ink-secondary)]">
            Smart Paste (HTTP, HTTPS, SOCKS5, user:pass@host:port, host:port:user:pass)
          </label>
          <div className="flex gap-2">
            <input
              id="proxy-smart-paste"
              value={smartPaste}
              onChange={(e) => setSmartPaste(e.target.value)}
              onPaste={(e) => {
                const pasted = e.clipboardData.getData('text');
                if (pasted.includes(':') && pasted.split('\n').length === 1) {
                  setTimeout(() => applyParsedString(pasted), 0);
                }
              }}
              placeholder="socks5://user:pass@1.2.3.4:1080"
              className="nb-input num flex-1"
            />
            <button
              type="button"
              onClick={() => applyParsedString(smartPaste)}
              disabled={!smartPaste.trim()}
              className="nb-btn nb-btn-secondary shrink-0 px-3"
            >
              Parse
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-3">
          <div>
            <label htmlFor="proxy-protocol" className="mb-1 block text-xs font-bold text-[var(--ink-secondary)]">
              Protocol
            </label>
            <select
              id="proxy-protocol"
              value={protocol}
              onChange={(e) => setProtocol(e.target.value as ProxyProtocol)}
              className="nb-input"
            >
              <option value="http">HTTP</option>
              <option value="https">HTTPS (TLS)</option>
              <option value="socks5">SOCKS5</option>
            </select>
          </div>
          <div>
            <label htmlFor="proxy-host" className="mb-1 block text-xs font-bold text-[var(--ink-secondary)]">
              Host / IP
            </label>
            <input
              id="proxy-host"
              value={host}
              onChange={(e) => setHost(e.target.value)}
              placeholder="192.168.10.25"
              className="nb-input num"
            />
          </div>
          <div>
            <label htmlFor="proxy-port" className="mb-1 block text-xs font-bold text-[var(--ink-secondary)]">
              Port
            </label>
            <input
              id="proxy-port"
              type="number"
              min={1}
              max={65535}
              value={port}
              onChange={(e) => setPort(e.target.value)}
              className="nb-input num"
            />
          </div>
        </div>

        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
          <div>
            <label htmlFor="proxy-username" className="mb-1 block text-xs font-bold text-[var(--ink-secondary)]">
              Username (optional)
            </label>
            <input
              id="proxy-username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="off"
              className="nb-input"
            />
          </div>
          <div>
            <label htmlFor="proxy-password" className="mb-1 block text-xs font-bold text-[var(--ink-secondary)]">
              Password (optional)
            </label>
            <div className="flex gap-1.5">
              <input
                id="proxy-password"
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="new-password"
                className="nb-input flex-1"
              />
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                aria-label={showPassword ? 'Hide password' : 'Show password'}
                className="nb-btn nb-btn-secondary shrink-0 px-2.5"
              >
                {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
          <div>
            <label htmlFor="proxy-bypass" className="mb-1 block text-xs font-bold text-[var(--ink-secondary)]">
              Bypass Hosts
            </label>
            <input
              id="proxy-bypass"
              value={bypass}
              onChange={(e) => setBypass(e.target.value)}
              placeholder="localhost,127.0.0.1"
              className="nb-input num"
            />
          </div>
          <div>
            <label htmlFor="proxy-pool-name" className="mb-1 block text-xs font-bold text-[var(--ink-secondary)]">
              Pool Label (for saving)
            </label>
            <input
              id="proxy-pool-name"
              value={poolName}
              onChange={(e) => setPoolName(e.target.value)}
              placeholder="US Residential #1"
              className="nb-input"
            />
          </div>
        </div>

        <label className="flex min-h-[44px] cursor-pointer items-center gap-2.5 border-2 border-[var(--border)] bg-[var(--bg-surface)] px-3 py-2 text-xs font-semibold text-[var(--ink)]">
          <input
            type="checkbox"
            checked={syncTimezone}
            onChange={(e) => setSyncTimezone(e.target.checked)}
            className="h-4 w-4 shrink-0 accent-[var(--ink)]"
          />
          <span>Sync Android device timezone to proxy exit IP timezone</span>
        </label>

        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          <button
            type="button"
            disabled={actionBusy !== null}
            onClick={() => void handleTestForm()}
            className="nb-btn nb-btn-secondary"
          >
            <Zap className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span>{actionBusy === 'test-form' ? 'Testing...' : 'Test Proxy'}</span>
          </button>
          <button
            type="button"
            disabled={actionBusy !== null}
            onClick={() => void handleApplyForm()}
            className="nb-btn nb-btn-primary"
          >
            <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span>{actionBusy === 'apply-form' ? 'Applying...' : 'Apply to Device'}</span>
          </button>
          <button
            type="button"
            disabled={actionBusy !== null}
            onClick={() => void handleSaveToPool()}
            className="nb-btn nb-btn-secondary"
          >
            <Plus className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span>{actionBusy === 'save-pool' ? 'Saving...' : 'Save to Pool'}</span>
          </button>
        </div>

        {testResult && (
          <div
            className={`border-2 border-[var(--border)] p-3 text-xs ${
              testResult.ok
                ? 'bg-[var(--status-ok-bg)] text-[var(--status-ok-ink)]'
                : 'bg-[var(--status-err-bg)] text-[var(--status-err-ink)]'
            }`}
          >
            <div className="flex items-center justify-between gap-2 font-extrabold">
              <span>{testResult.ok ? 'Proxy Connectivity OK' : 'Proxy Test Failed'}</span>
              {testResult.latencyMs !== null && <span className="num">{testResult.latencyMs} ms</span>}
            </div>
            {testResult.ok ? (
              <div className="num mt-1.5 space-y-0.5 font-semibold">
                <div>Exit IP: {testResult.exitIp ?? 'Unknown'}</div>
                <div>
                  Geo: {[testResult.city, testResult.country, testResult.countryCode].filter(Boolean).join(', ') || 'Unknown'}
                </div>
                <div>
                  Timezone: {testResult.timezone ?? 'Unknown'} {testResult.isp ? `/ ISP: ${testResult.isp}` : ''}
                </div>
              </div>
            ) : (
              <div className="mt-1 font-semibold">{testResult.error}</div>
            )}
          </div>
        )}
      </section>

      {/* 3. Saved Proxy Pool & Bulk Import */}
      <section className="nb-panel bg-[var(--bg-ground)] p-3 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="text-sm font-extrabold text-[var(--ink)]">Saved Proxy Pool ({pool.length})</h3>
            <p className="text-xs text-[var(--ink-muted)]">1-click latency check and live switch across instances</p>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setBulkOpen((v) => !v)}
              className="nb-btn nb-btn-secondary px-3"
            >
              <Upload className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span>{bulkOpen ? 'Hide Import' : 'Bulk Import'}</span>
            </button>
            <button
              type="button"
              onClick={() => void loadPool()}
              disabled={poolLoading}
              aria-label="Refresh saved proxy pool"
              className="nb-btn nb-btn-secondary px-2.5"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${poolLoading ? 'animate-spin' : ''}`} aria-hidden="true" />
            </button>
          </div>
        </div>

        {bulkOpen && (
          <div className="space-y-2.5 border-2 border-[var(--border)] bg-[var(--bg-surface)] p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <label htmlFor="proxy-bulk-text" className="text-xs font-bold text-[var(--ink)]">
                One proxy per line (with or without protocol)
              </label>
              <select
                aria-label="Default bulk import protocol"
                value={bulkProtocol}
                onChange={(e) => setBulkProtocol(e.target.value as ProxyProtocol)}
                className="nb-input w-auto py-1 text-xs"
              >
                <option value="http">Default: HTTP</option>
                <option value="https">Default: HTTPS</option>
                <option value="socks5">Default: SOCKS5</option>
              </select>
            </div>
            <textarea
              id="proxy-bulk-text"
              rows={4}
              value={bulkText}
              onChange={(e) => setBulkText(e.target.value)}
              placeholder={'socks5://user:pass@1.2.3.4:1080\n5.6.7.8:8080:user:pass\nhttp://9.10.11.12:3128'}
              className="nb-input num text-xs"
            />
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setBulkOpen(false)}
                className="nb-btn nb-btn-secondary"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={actionBusy !== null || !bulkText.trim()}
                onClick={() => void handleBulkImport()}
                className="nb-btn nb-btn-primary"
              >
                {actionBusy === 'bulk-import' ? 'Importing...' : 'Import to Pool'}
              </button>
            </div>
          </div>
        )}

        {poolError && (
          <div className="flex flex-wrap items-center justify-between gap-2 border-2 border-[var(--border)] bg-[var(--status-err-bg)] p-3 text-xs font-semibold text-[var(--status-err-ink)]">
            <span>{poolError}</span>
            <button type="button" onClick={() => void loadPool()} className="nb-btn nb-btn-secondary">
              Retry
            </button>
          </div>
        )}

        {poolLoading && pool.length === 0 ? (
          <div className="border-2 border-dashed border-[var(--border)] bg-[var(--bg-surface)] p-4 text-center text-xs font-semibold text-[var(--ink-muted)]">
            Loading saved proxy pool...
          </div>
        ) : pool.length === 0 ? (
          <div className="border-2 border-dashed border-[var(--border)] bg-[var(--bg-surface)] p-4 text-center text-xs text-[var(--ink-muted)]">
            No saved proxies yet. Fill the form above and save, or use Bulk Import.
          </div>
        ) : (
          <div className="space-y-2">
            {pool.map((item) => {
              const attached = proxyState?.proxyProfileId === item.id;
              return (
                <div
                  key={item.id}
                  className={`border-2 border-[var(--border)] p-2.5 ${
                    attached
                      ? 'border-l-[6px] border-l-[var(--accent)] bg-[var(--bg-surface)]'
                      : 'bg-[var(--bg-surface)]'
                  }`}
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="truncate text-[13px] font-extrabold text-[var(--ink)]">{item.name}</span>
                        {attached && (
                          <span className="border border-[var(--border)] bg-[var(--accent)] px-1.5 py-0.5 text-xs font-extrabold uppercase text-[var(--accent-ink)]">
                            Active
                          </span>
                        )}
                        {item.username && (
                          <span className="border border-[var(--border)] bg-[var(--bg-subtle)] px-1.5 py-0.5 text-xs font-bold text-[var(--ink)]">
                            Auth
                          </span>
                        )}
                      </div>
                      <div className="num mt-0.5 truncate text-xs font-semibold text-[var(--ink-secondary)]">
                        {item.protocol.toUpperCase()} {item.host}:{item.port}
                      </div>
                      <div className="num mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-[var(--ink-muted)]">
                        <span>
                          Status:{' '}
                          <strong className="text-[var(--ink)]">
                            {item.lastStatus === 'ok'
                              ? `OK (${item.lastLatencyMs ?? '?'} ms)`
                              : item.lastStatus === 'error'
                                ? 'Failed'
                                : 'Untested'}
                          </strong>
                        </span>
                        {item.lastExitIp && <span>Exit: {item.lastExitIp}</span>}
                        {(item.lastCountryCode || item.lastCity) && (
                          <span>{[item.lastCity, item.lastCountryCode].filter(Boolean).join(', ')}</span>
                        )}
                      </div>
                      {item.lastStatus === 'error' && item.lastError && (
                        <div className="mt-1 truncate text-xs font-semibold text-[var(--status-err-ink)]">
                          {item.lastError}
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="mt-2.5 flex flex-wrap gap-1.5">
                    <button
                      type="button"
                      disabled={actionBusy !== null}
                      onClick={() => void handleTestPoolItem(item)}
                      className="nb-btn nb-btn-secondary flex-1 px-2.5"
                    >
                      {actionBusy === `test:${item.id}` ? 'Testing...' : 'Test'}
                    </button>
                    <button
                      type="button"
                      disabled={actionBusy !== null}
                      onClick={() => void handleApplyPoolItem(item)}
                      className="nb-btn nb-btn-primary flex-1 px-2.5"
                    >
                      {actionBusy === `apply:${item.id}` ? 'Applying...' : 'Apply'}
                    </button>
                    {confirmDeleteId === item.id ? (
                      <>
                        <button
                          type="button"
                          disabled={actionBusy !== null}
                          onClick={() => void handleDeletePoolItem(item.id)}
                          className="nb-btn nb-btn-danger px-2.5"
                        >
                          Confirm
                        </button>
                        <button
                          type="button"
                          disabled={actionBusy !== null}
                          onClick={() => setConfirmDeleteId(null)}
                          className="nb-btn nb-btn-secondary px-2.5"
                        >
                          Cancel
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        disabled={actionBusy !== null}
                        onClick={() => setConfirmDeleteId(item.id)}
                        aria-label={`Delete proxy ${item.name}`}
                        className="nb-btn nb-btn-secondary px-2.5"
                      >
                        <Trash2 className="h-4 w-4" aria-hidden="true" />
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
};
