import React, { useEffect, useState } from 'react';
import type { AiSnapshotResponse, InstanceRecord } from '@droidforge/shared';
import { Plus, Power, RefreshCw, Shield, Smartphone, Square, Trash2 } from 'lucide-react';
import { createClient } from './api/client';
import { CreateInstanceModal } from './components/CreateInstanceModal';
import { InspectorPanel } from './components/InspectorPanel';
import { LiveScreenCanvas } from './components/LiveScreenCanvas';

export const App: React.FC = () => {
  const [instances, setInstances] = useState<InstanceRecord[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [aiSnapshot, setAiSnapshot] = useState<AiSnapshotResponse | null>(null);
  const [showAiOverlay, setShowAiOverlay] = useState(false);

  const selected = instances.find((i) => i.id === selectedId) ?? instances[0] ?? null;

  async function refresh() {
    try {
      const list = await createClient().instances.list();
      setInstances(list);
      if (!selectedId && list[0]) setSelectedId(list[0].id);
    } catch {
      // API may still be starting
    }
  }

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    return () => clearInterval(timer);
  }, []);

  async function captureAiSnapshot() {
    if (!selected) return;
    const snap = await createClient().ui.aiSnapshot(selected.id);
    setAiSnapshot(snap);
    setShowAiOverlay(true);
  }

  return (
    <div className="flex h-screen flex-col bg-zinc-950 text-zinc-100">
      <header className="flex items-center justify-between border-b border-zinc-800 bg-zinc-900/80 px-5 py-3">
        <div className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-600 text-white">
            <Smartphone className="h-4 w-4" />
          </div>
          <div>
            <h1 className="text-sm font-semibold tracking-tight text-white">DroidForge</h1>
            <p className="text-[11px] text-zinc-400">Full Docker Redroid Emulator & AI Automation Platform</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <a
            href="/docs"
            target="_blank"
            rel="noreferrer"
            className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800"
          >
            Swagger API Docs
          </a>
          <button
            onClick={() => setModalOpen(true)}
            className="flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-500"
          >
            <Plus className="h-4 w-4" />
            New Instance
          </button>
        </div>
      </header>

      <div className="grid flex-1 grid-cols-12 overflow-hidden">
        {/* Sidebar: Instances */}
        <aside className="col-span-3 flex flex-col border-r border-zinc-800 bg-zinc-900/40">
          <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-2.5 text-xs">
            <span className="font-medium text-zinc-300">Instances ({instances.length})</span>
            <button onClick={() => void refresh()} className="rounded p-1 text-zinc-400 hover:bg-zinc-800 hover:text-white">
              <RefreshCw className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="flex-1 space-y-2 overflow-y-auto p-3">
            {instances.length === 0 && (
              <div className="rounded-lg border border-dashed border-zinc-800 p-4 text-center text-xs text-zinc-500">
                No Redroid instances yet. Click &ldquo;New Instance&rdquo; to launch one.
              </div>
            )}
            {instances.map((inst) => {
              const active = selected?.id === inst.id;
              return (
                <div
                  key={inst.id}
                  onClick={() => {
                    setSelectedId(inst.id);
                    setAiSnapshot(null);
                    setShowAiOverlay(false);
                  }}
                  className={`cursor-pointer rounded-lg border p-3 transition ${
                    active
                      ? 'border-emerald-500/60 bg-emerald-950/20'
                      : 'border-zinc-800 bg-zinc-900/70 hover:border-zinc-700'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="font-medium text-sm text-white">{inst.name}</span>
                    <span
                      className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
                        inst.status === 'running'
                          ? 'bg-emerald-500/20 text-emerald-300'
                          : inst.status === 'booting'
                            ? 'bg-amber-500/20 text-amber-300'
                            : 'bg-zinc-700 text-zinc-300'
                      }`}
                    >
                      {inst.status}
                    </span>
                  </div>
                  <div className="mt-1 flex items-center gap-1.5 text-[11px] text-zinc-400">
                    <span>
                      {inst.profile.brand} {inst.profile.model}
                    </span>
                    {inst.stealthMode && (
                      <span title="Stealth Mode Active">
                        <Shield className="h-3 w-3 text-emerald-400" />
                      </span>
                    )}
                  </div>
                  <div className="mt-1 font-mono text-[10px] text-zinc-500">
                    Android {inst.androidVersion} · {inst.width}x{inst.height}
                    {inst.hostAdbPort ? ` · ADB :${inst.hostAdbPort}` : ''}
                  </div>
                  <div className="mt-2.5 flex gap-1.5">
                    {inst.status === 'stopped' ? (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          void createClient().instances.start(inst.id).then(refresh);
                        }}
                        className="flex items-center gap-1 rounded bg-emerald-600/20 px-2 py-1 text-[11px] text-emerald-300 hover:bg-emerald-600 hover:text-white"
                      >
                        <Power className="h-3 w-3" /> Start
                      </button>
                    ) : (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          void createClient().instances.stop(inst.id).then(refresh);
                        }}
                        className="flex items-center gap-1 rounded bg-amber-600/20 px-2 py-1 text-[11px] text-amber-300 hover:bg-amber-600 hover:text-white"
                      >
                        <Square className="h-3 w-3" /> Stop
                      </button>
                    )}
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        void createClient().instances.delete(inst.id, true).then(refresh);
                      }}
                      className="flex items-center gap-1 rounded bg-red-600/20 px-2 py-1 text-[11px] text-red-300 hover:bg-red-600 hover:text-white"
                    >
                      <Trash2 className="h-3 w-3" /> Delete
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </aside>

        {/* Center: Live Screen */}
        <main className="col-span-5 overflow-hidden bg-zinc-950">
          {selected ? (
            <LiveScreenCanvas
              instance={selected}
              aiSnapshot={aiSnapshot}
              showAiOverlay={showAiOverlay}
              onCaptureAiSnapshot={() => void captureAiSnapshot()}
              onToggleAiOverlay={() => setShowAiOverlay((v) => !v)}
            />
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-zinc-500">
              Select or create a Redroid instance to view the live screen.
            </div>
          )}
        </main>

        {/* Right: Inspector */}
        <section className="col-span-4 overflow-hidden">
          {selected ? (
            <InspectorPanel
              instance={selected}
              aiSnapshot={aiSnapshot}
              onCaptureAiSnapshot={() => void captureAiSnapshot()}
            />
          ) : (
            <div className="flex h-full items-center justify-center border-l border-zinc-800 text-xs text-zinc-500">
              Inspector ready
            </div>
          )}
        </section>
      </div>

      <CreateInstanceModal open={modalOpen} onClose={() => setModalOpen(false)} onCreated={() => void refresh()} />
    </div>
  );
};
