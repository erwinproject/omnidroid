import React, { useEffect, useState } from 'react';
import type { DeviceProfile, InstanceRecord, UpdateInstanceInput } from '@droidforge/shared';
import { RotateCcw, X, Zap } from 'lucide-react';
import { createClient } from '../api/client';
import { formatPresetOptionLabel, groupDeviceProfiles } from '../lib/presets';

interface Props {
  instance: InstanceRecord | null;
  onClose: () => void;
  onSaved: () => void;
}

const labelClass = 'mb-1 block text-[13px] font-semibold text-[var(--ink-secondary)]';

export const EditInstanceModal: React.FC<Props> = ({ instance, onClose, onSaved }) => {
  const [profiles, setProfiles] = useState<DeviceProfile[]>([]);
  const [name, setName] = useState('');
  const [memoryMb, setMemoryMb] = useState(2048);
  const [cpus, setCpus] = useState(2);
  const [width, setWidth] = useState(1080);
  const [height, setHeight] = useState(2400);
  const [dpi, setDpi] = useState(420);
  const [profileId, setProfileId] = useState('');
  const [brand, setBrand] = useState('');
  const [manufacturer, setManufacturer] = useState('');
  const [model, setModel] = useState('');
  const [fps, setFps] = useState(30);
  const [gpuMode, setGpuMode] = useState<'guest' | 'host' | 'auto'>('guest');
  const [stealthMode, setStealthMode] = useState(true);
  const [enableRoot, setEnableRoot] = useState(false);
  const [exposeAdbPort, setExposeAdbPort] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const instanceId = instance?.id;
  useEffect(() => {
    if (!instance) return;
    setName(instance.name);
    setMemoryMb(instance.memoryMb);
    setCpus(instance.cpus);
    setWidth(instance.width);
    setHeight(instance.height);
    setDpi(instance.dpi);
    setProfileId(instance.profile.id);
    setBrand(instance.profile.brand);
    setManufacturer(instance.profile.manufacturer);
    setModel(instance.profile.model);
    setFps(instance.fps);
    setGpuMode(instance.gpuMode);
    setStealthMode(instance.stealthMode);
    setEnableRoot(Boolean(instance.enableRoot));
    setExposeAdbPort(Boolean(instance.hostAdbPort));
    setError(null);
    createClient()
      .profiles.list()
      .then(setProfiles)
      .catch(() => setProfiles([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instanceId]);

  useEffect(() => {
    if (!instance) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape' && !submitting) onClose();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [instance, submitting, onClose]);

  if (!instance) return null;

  function applyPreset(id: string) {
    setProfileId(id);
    const p = profiles.find((x) => x.id === id);
    if (p) {
      setBrand(p.brand);
      setManufacturer(p.manufacturer);
      setModel(p.model);
    }
  }

  function buildPatch(): UpdateInstanceInput {
    const cur = instance as InstanceRecord;
    const patch: UpdateInstanceInput = {};
    if (name !== cur.name) patch.name = name;
    if (memoryMb !== cur.memoryMb) patch.memoryMb = memoryMb;
    if (cpus !== cur.cpus) patch.cpus = cpus;
    if (width !== cur.width) patch.width = width;
    if (height !== cur.height) patch.height = height;
    if (dpi !== cur.dpi) patch.dpi = dpi;
    if (fps !== cur.fps) patch.fps = fps;
    if (gpuMode !== cur.gpuMode) patch.gpuMode = gpuMode;
    if (stealthMode !== cur.stealthMode) patch.stealthMode = stealthMode;
    if (enableRoot !== Boolean(cur.enableRoot)) patch.enableRoot = enableRoot;
    if (exposeAdbPort !== Boolean(cur.hostAdbPort)) patch.exposeAdbPort = exposeAdbPort;
    const profileChanged = profileId !== cur.profile.id;
    const override: Record<string, string> = {};
    if (brand !== cur.profile.brand) override.brand = brand;
    if (manufacturer !== cur.profile.manufacturer) override.manufacturer = manufacturer;
    if (model !== cur.profile.model) override.model = model;
    if (profileChanged) patch.profileId = profileId;
    if (Object.keys(override).length > 0) {
      patch.deviceProfile = override;
      if (!profileChanged) patch.profileId = cur.profile.id;
    }
    return patch;
  }

  const patch = buildPatch();
  const rebootKeys: Array<keyof UpdateInstanceInput> = [
    'fps',
    'gpuMode',
    'stealthMode',
    'exposeAdbPort',
    'profileId',
    'deviceProfile',
  ];
  const needsReboot = rebootKeys.some((k) => patch[k] !== undefined);
  const hasChanges = Object.keys(patch).length > 0;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!hasChanges) {
      onClose();
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await createClient().instances.update((instance as InstanceRecord).id, patch);
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  const num = (setter: (n: number) => void) => (e: React.ChangeEvent<HTMLInputElement>) => setter(Number(e.target.value));

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-3 sm:p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget && !submitting) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="edit-inst-title"
        className="nb-panel-elevated flex max-h-[92dvh] w-full max-w-2xl flex-col"
      >
        <div className="flex items-center justify-between border-b-2 border-[var(--border)] bg-[var(--bg-subtle)] px-4 py-3">
          <h2 id="edit-inst-title" className="text-base font-extrabold text-[var(--ink)]">
            Edit {instance.name}
          </h2>
          <button type="button" onClick={onClose} disabled={submitting} aria-label="Close" className="nb-btn nb-btn-secondary px-2">
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="min-h-0 flex-1 space-y-5 overflow-y-auto p-4">
          <div>
            <label htmlFor="edit-name" className={labelClass}>
              Name
            </label>
            <input
              id="edit-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              pattern="[a-zA-Z0-9_\-]{2,64}"
              required
              className="nb-input"
            />
          </div>

          <fieldset className="space-y-3">
            <legend className="flex items-center gap-1.5 text-sm font-extrabold text-[var(--ink)]">
              <Zap className="h-4 w-4" aria-hidden="true" /> Applies instantly (no reboot)
            </legend>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
              <div>
                <label htmlFor="edit-mem" className={labelClass}>
                  RAM (MB)
                </label>
                <input id="edit-mem" type="number" min={1024} max={32768} step={256} value={memoryMb} onChange={num(setMemoryMb)} className="nb-input num" />
              </div>
              <div>
                <label htmlFor="edit-cpu" className={labelClass}>
                  CPUs
                </label>
                <input id="edit-cpu" type="number" min={1} max={16} step={0.5} value={cpus} onChange={num(setCpus)} className="nb-input num" />
              </div>
              <div>
                <label htmlFor="edit-w" className={labelClass}>
                  Width
                </label>
                <input id="edit-w" type="number" min={320} max={2160} value={width} onChange={num(setWidth)} className="nb-input num" />
              </div>
              <div>
                <label htmlFor="edit-h" className={labelClass}>
                  Height
                </label>
                <input id="edit-h" type="number" min={480} max={3840} value={height} onChange={num(setHeight)} className="nb-input num" />
              </div>
              <div>
                <label htmlFor="edit-dpi" className={labelClass}>
                  DPI
                </label>
                <input id="edit-dpi" type="number" min={120} max={640} value={dpi} onChange={num(setDpi)} className="nb-input num" />
              </div>
            </div>
            <label className="flex min-h-[44px] cursor-pointer items-center gap-2.5 border-2 border-[var(--border)] bg-[var(--bg-surface)] px-3 py-2 text-[13px] font-semibold text-[var(--ink)]">
              <input type="checkbox" checked={enableRoot} onChange={(e) => setEnableRoot(e.target.checked)} />
              Enable Root Access (su Daemon)
            </label>
          </fieldset>

          <fieldset className="space-y-3">
            <legend className="flex items-center gap-1.5 text-sm font-extrabold text-[var(--ink)]">
              <RotateCcw className="h-4 w-4" aria-hidden="true" /> Needs reboot (container recreated, /data kept)
            </legend>
            <div>
              <label htmlFor="edit-preset" className={labelClass}>
                Device Preset
              </label>
              <select id="edit-preset" value={profileId} onChange={(e) => applyPreset(e.target.value)} className="nb-input">
                {(profiles.length === 0 || !profiles.some((p) => p.id === profileId)) && (
                  <option value={profileId}>{profileId}</option>
                )}
                {groupDeviceProfiles(profiles).map((group) => (
                  <optgroup key={group.label} label={group.label}>
                    {group.profiles.map((p) => (
                      <option key={p.id} value={p.id}>
                        {formatPresetOptionLabel(p)}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div>
                <label htmlFor="edit-brand" className={labelClass}>
                  Brand
                </label>
                <input id="edit-brand" value={brand} onChange={(e) => setBrand(e.target.value)} className="nb-input" />
              </div>
              <div>
                <label htmlFor="edit-manufacturer" className={labelClass}>
                  Manufacturer
                </label>
                <input id="edit-manufacturer" value={manufacturer} onChange={(e) => setManufacturer(e.target.value)} className="nb-input" />
              </div>
              <div>
                <label htmlFor="edit-model" className={labelClass}>
                  Model
                </label>
                <input id="edit-model" value={model} onChange={(e) => setModel(e.target.value)} className="nb-input" />
              </div>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <label htmlFor="edit-fps" className={labelClass}>
                  Display FPS
                </label>
                <input id="edit-fps" type="number" min={15} max={60} value={fps} onChange={num(setFps)} className="nb-input num" />
              </div>
              <div>
                <label htmlFor="edit-gpu" className={labelClass}>
                  GPU Mode
                </label>
                <select id="edit-gpu" value={gpuMode} onChange={(e) => setGpuMode(e.target.value as 'guest' | 'host' | 'auto')} className="nb-input">
                  <option value="guest">guest (software)</option>
                  <option value="host">host</option>
                  <option value="auto">auto</option>
                </select>
              </div>
            </div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <label className="flex min-h-[44px] cursor-pointer items-center gap-2.5 border-2 border-[var(--border)] bg-[var(--bg-surface)] px-3 py-2 text-[13px] font-semibold text-[var(--ink)]">
                <input type="checkbox" checked={stealthMode} onChange={(e) => setStealthMode(e.target.checked)} />
                Stealth mode
              </label>
              <label className="flex min-h-[44px] cursor-pointer items-center gap-2.5 border-2 border-[var(--border)] bg-[var(--bg-surface)] px-3 py-2 text-[13px] font-semibold text-[var(--ink)]">
                <input type="checkbox" checked={exposeAdbPort} onChange={(e) => setExposeAdbPort(e.target.checked)} />
                Expose ADB port on host
              </label>
            </div>
          </fieldset>

          {needsReboot && (
            <div className="border-2 border-[var(--border)] bg-[var(--status-warn-bg)] p-3 text-[13px] font-semibold text-[var(--status-warn-ink)]">
              These changes recreate the container and reboot Android. App data in /data is preserved.
            </div>
          )}
          {error && (
            <div className="border-2 border-[var(--border)] bg-[var(--status-err-bg)] p-3 text-[13px] font-semibold text-[var(--status-err-ink)]">
              {error}
            </div>
          )}

          <div className="flex justify-end gap-2 border-t-2 border-[var(--border)] pt-3">
            <button type="button" onClick={onClose} disabled={submitting} className="nb-btn nb-btn-secondary">
              Cancel
            </button>
            <button type="submit" disabled={submitting || !hasChanges} className="nb-btn nb-btn-primary">
              {submitting ? 'Applying...' : needsReboot ? 'Save and Reboot' : 'Save'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
