import React, { useEffect, useRef, useState } from 'react';
import type { AiSnapshotResponse, InstanceRecord, StealthCheckReport } from '@droidforge/shared';
import { Code2, Cpu, Layers, Package, Play, ShieldCheck, Terminal, Trash2, Upload } from 'lucide-react';
import { buildWsUrl, createClient, getApiKey } from '../api/client';

interface Props {
  instance: InstanceRecord;
  aiSnapshot: AiSnapshotResponse | null;
  onCaptureAiSnapshot: () => void;
}

type Tab = 'ai' | 'apps' | 'stealth' | 'logcat' | 'api';

export const InspectorPanel: React.FC<Props> = ({ instance, aiSnapshot, onCaptureAiSnapshot }) => {
  const [tab, setTab] = useState<Tab>('ai');
  const [packages, setPackages] = useState<string[]>([]);
  const [stealthReport, setStealthReport] = useState<StealthCheckReport | null>(null);
  const [shellCmd, setShellCmd] = useState('getprop ro.product.model');
  const [shellOut, setShellOut] = useState('');
  const [logs, setLogs] = useState<string[]>([]);
  const [logLevel, setLogLevel] = useState('I');
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const logEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (tab !== 'logcat') return;
    setLogs([]);
    const ws = new WebSocket(buildWsUrl(`/ws/instances/${instance.id}/logcat?level=${logLevel}`));
    ws.onmessage = (ev) => {
      const lines = String(ev.data).split(/\r?\n/).filter(Boolean);
      setLogs((prev) => [...prev.slice(-300), ...lines]);
    };
    return () => ws.close();
  }, [tab, instance.id, logLevel]);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  async function loadApps() {
    const res = await fetch(`/api/v1/instances/${instance.id}/apps?type=user`, {
      headers: getApiKey() ? { 'X-API-Key': getApiKey() } : {},
    });
    if (res.ok) {
      const data = (await res.json()) as { packages: string[] };
      setPackages(data.packages);
    }
  }

  async function uploadApk(file: File) {
    setStatusMsg(`Installing ${file.name}...`);
    const form = new FormData();
    form.append('file', file);
    const res = await fetch(`/api/v1/instances/${instance.id}/apps/install`, {
      method: 'POST',
      headers: getApiKey() ? { 'X-API-Key': getApiKey() } : {},
      body: form,
    });
    setStatusMsg(res.ok ? `Installed ${file.name}` : `Install failed (${res.status})`);
    await loadApps();
  }

  async function runStealthCheck() {
    const report = await createClient().device.stealthCheck(instance.id);
    setStealthReport(report);
  }

  async function runShell() {
    const res = await createClient().device.shell(instance.id, { command: shellCmd, timeoutMs: 10000 });
    setShellOut(res.stdout || res.stderr || `(exit ${res.exitCode})`);
  }

  const tabs: Array<{ id: Tab; label: string; icon: React.ReactNode }> = [
    { id: 'ai', label: 'UI & AI', icon: <Layers className="h-3.5 w-3.5" /> },
    { id: 'apps', label: 'Apps', icon: <Package className="h-3.5 w-3.5" /> },
    { id: 'stealth', label: 'Stealth', icon: <ShieldCheck className="h-3.5 w-3.5" /> },
    { id: 'logcat', label: 'Logcat', icon: <Terminal className="h-3.5 w-3.5" /> },
    { id: 'api', label: 'API/SDK', icon: <Code2 className="h-3.5 w-3.5" /> },
  ];

  return (
    <div className="flex h-full flex-col border-l border-zinc-800 bg-zinc-900/60">
      <div className="flex border-b border-zinc-800 px-2 pt-2">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => {
              setTab(t.id);
              if (t.id === 'apps') void loadApps();
            }}
            className={`flex items-center gap-1.5 border-b-2 px-3 py-2 text-xs font-medium transition ${
              tab === t.id
                ? 'border-emerald-400 text-emerald-300'
                : 'border-transparent text-zinc-400 hover:text-zinc-200'
            }`}
          >
            {t.icon}
            {t.label}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto p-4 text-xs">
        {tab === 'ai' && (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="font-medium text-zinc-200">AI Set-of-Marks Elements</span>
              <button
                onClick={onCaptureAiSnapshot}
                className="rounded bg-emerald-600 px-2.5 py-1 text-white hover:bg-emerald-500"
              >
                Capture Snapshot
              </button>
            </div>
            {!aiSnapshot ? (
              <p className="text-zinc-400">
                Click &ldquo;Capture Snapshot&rdquo; to dump the UI accessibility tree and generate numbered bounding boxes for AI Agent clicking.
              </p>
            ) : (
              <div className="space-y-1.5">
                {aiSnapshot.elements.map((el) => (
                  <div
                    key={el.id}
                    className="flex items-center justify-between rounded-lg border border-zinc-800 bg-zinc-950/70 px-2.5 py-2"
                  >
                    <div className="min-w-0 pr-2">
                      <div className="flex items-center gap-1.5">
                        <span className="rounded bg-emerald-500/20 px-1.5 py-0.5 font-mono font-bold text-emerald-300">
                          #{el.id}
                        </span>
                        <span className="truncate font-medium text-zinc-100">{el.label}</span>
                      </div>
                      <div className="truncate font-mono text-[10px] text-zinc-500">
                        {el.resourceId || el.className} ({el.bounds.centerX}, {el.bounds.centerY})
                      </div>
                    </div>
                    <button
                      onClick={() => void createClient().ui.click(instance.id, { elementId: el.id })}
                      className="shrink-0 rounded bg-zinc-800 px-2 py-1 text-zinc-200 hover:bg-emerald-600 hover:text-white"
                    >
                      Click
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {tab === 'apps' && (
          <div className="space-y-3">
            <label className="flex cursor-pointer items-center justify-center gap-2 rounded-lg border border-dashed border-zinc-700 bg-zinc-950/50 p-4 text-zinc-300 hover:border-emerald-500">
              <Upload className="h-4 w-4" />
              <span>Upload & Install APK</span>
              <input
                type="file"
                accept=".apk"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void uploadApk(f);
                }}
              />
            </label>
            {statusMsg && <div className="rounded bg-zinc-800 px-2.5 py-1.5 text-emerald-300">{statusMsg}</div>}
            <div className="space-y-1.5">
              {packages.map((pkg) => (
                <div key={pkg} className="flex items-center justify-between rounded border border-zinc-800 bg-zinc-950 px-2.5 py-1.5">
                  <span className="truncate font-mono text-zinc-200">{pkg}</span>
                  <div className="flex gap-1">
                    <button
                      onClick={() =>
                        void fetch(`/api/v1/instances/${instance.id}/apps/${pkg}/launch`, {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json', ...(getApiKey() ? { 'X-API-Key': getApiKey() } : {}) },
                          body: '{}',
                        })
                      }
                      className="rounded bg-emerald-600/20 p-1 text-emerald-300 hover:bg-emerald-600 hover:text-white"
                      title="Launch"
                    >
                      <Play className="h-3.5 w-3.5" />
                    </button>
                    <button
                      onClick={async () => {
                        await fetch(`/api/v1/instances/${instance.id}/apps/${pkg}`, {
                          method: 'DELETE',
                          headers: getApiKey() ? { 'X-API-Key': getApiKey() } : {},
                        });
                        await loadApps();
                      }}
                      className="rounded bg-red-600/20 p-1 text-red-300 hover:bg-red-600 hover:text-white"
                      title="Uninstall"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {tab === 'stealth' && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <span className="font-medium text-zinc-200">Anti-Emulator Stealth Audit</span>
              <button
                onClick={runStealthCheck}
                className="rounded bg-emerald-600 px-2.5 py-1 text-white hover:bg-emerald-500"
              >
                Run Stealth Check
              </button>
            </div>

            {stealthReport && (
              <div className="space-y-2">
                <div className="flex items-center justify-between rounded-lg border border-zinc-800 bg-zinc-950 p-3">
                  <span className="text-zinc-400">Stealth Score</span>
                  <span className="text-xl font-bold text-emerald-400">{stealthReport.score} / 100</span>
                </div>
                {stealthReport.checks.map((c) => (
                  <div key={c.key} className="rounded border border-zinc-800 bg-zinc-950/70 p-2">
                    <div className="flex items-center justify-between">
                      <span className="font-mono font-medium text-zinc-200">{c.key}</span>
                      <span
                        className={`rounded px-1.5 py-0.5 text-[10px] font-bold uppercase ${
                          c.status === 'pass'
                            ? 'bg-emerald-500/20 text-emerald-300'
                            : c.status === 'warn'
                              ? 'bg-amber-500/20 text-amber-300'
                              : 'bg-red-500/20 text-red-300'
                        }`}
                      >
                        {c.status}
                      </span>
                    </div>
                    <div className="mt-1 truncate font-mono text-[10px] text-zinc-400">{c.actual}</div>
                    <div className="text-[11px] text-zinc-500">{c.detail}</div>
                  </div>
                ))}
              </div>
            )}

            <div className="space-y-2 border-t border-zinc-800 pt-3">
              <div className="flex items-center gap-1.5 font-medium text-zinc-200">
                <Cpu className="h-3.5 w-3.5" />
                Quick ADB Shell
              </div>
              <div className="flex gap-1.5">
                <input
                  value={shellCmd}
                  onChange={(e) => setShellCmd(e.target.value)}
                  className="flex-1 rounded border border-zinc-700 bg-zinc-950 px-2.5 py-1.5 font-mono text-white"
                />
                <button
                  onClick={runShell}
                  className="rounded bg-zinc-800 px-3 py-1.5 text-zinc-100 hover:bg-zinc-700"
                >
                  Run
                </button>
              </div>
              {shellOut && (
                <pre className="max-h-40 overflow-auto rounded bg-black p-2 font-mono text-[11px] text-emerald-300">
                  {shellOut}
                </pre>
              )}
            </div>
          </div>
        )}

        {tab === 'logcat' && (
          <div className="flex h-full flex-col gap-2">
            <div className="flex items-center justify-between">
              <select
                value={logLevel}
                onChange={(e) => setLogLevel(e.target.value)}
                className="rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-white"
              >
                <option value="V">Verbose (V)</option>
                <option value="D">Debug (D)</option>
                <option value="I">Info (I)</option>
                <option value="W">Warn (W)</option>
                <option value="E">Error (E)</option>
              </select>
              <button onClick={() => setLogs([])} className="rounded bg-zinc-800 px-2 py-1 text-zinc-300 hover:bg-zinc-700">
                Clear
              </button>
            </div>
            <div className="flex-1 overflow-auto rounded bg-black p-2 font-mono text-[11px] text-zinc-300">
              {logs.map((l, idx) => (
                <div key={idx} className="whitespace-pre-wrap break-all">
                  {l}
                </div>
              ))}
              <div ref={logEndRef} />
            </div>
          </div>
        )}

        {tab === 'api' && (
          <div className="space-y-3">
            <a
              href="/docs"
              target="_blank"
              rel="noreferrer"
              className="block rounded-lg border border-emerald-700/50 bg-emerald-950/40 p-3 text-center font-medium text-emerald-300 hover:bg-emerald-900/40"
            >
              Open Interactive Swagger UI (/docs) →
            </a>
            <div>
              <div className="mb-1 text-zinc-400">AI Agent Set-of-Marks Snapshot (cURL)</div>
              <pre className="overflow-auto rounded bg-black p-2.5 font-mono text-[11px] text-emerald-300">
{`curl -s "${window.location.origin}/api/v1/instances/${instance.id}/ui/ai-snapshot"`}
              </pre>
            </div>
            <div>
              <div className="mb-1 text-zinc-400">Click AI Element #1 (cURL)</div>
              <pre className="overflow-auto rounded bg-black p-2.5 font-mono text-[11px] text-emerald-300">
{`curl -X POST "${window.location.origin}/api/v1/instances/${instance.id}/ui/click" \\
  -H "Content-Type: application/json" \\
  -d '{"elementId": 1}'`}
              </pre>
            </div>
            <div>
              <div className="mb-1 text-zinc-400">Stealth Audit (cURL)</div>
              <pre className="overflow-auto rounded bg-black p-2.5 font-mono text-[11px] text-emerald-300">
{`curl -s "${window.location.origin}/api/v1/instances/${instance.id}/device/stealth-check"`}
              </pre>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
