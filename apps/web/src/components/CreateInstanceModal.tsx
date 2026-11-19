import React, { useEffect, useState } from 'react';
import type { CreateInstanceInput, DeviceProfile } from '@droidforge/shared';
import { Shuffle, ShieldCheck, X } from 'lucide-react';
import { createClient } from '../api/client';

interface Props {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}

export const CreateInstanceModal: React.FC<Props> = ({ open, onClose, onCreated }) => {
  const [profiles, setProfiles] = useState<DeviceProfile[]>([]);
  const [name, setName] = useState(`android-${Math.floor(1000 + Math.random() * 9000)}`);
  const [androidVersion, setAndroidVersion] = useState<'11' | '12' | '13' | '14'>('13');
  const [profileId, setProfileId] = useState('pixel-8-pro');
  const [stealthMode, setStealthMode] = useState(true);
  const [exposeAdbPort, setExposeAdbPort] = useState(false);
  const [memoryMb, setMemoryMb] = useState(2048);
  const [cpus, setCpus] = useState(2);
  const [proxy, setProxy] = useState('');
  const [customImage, setCustomImage] = useState('');

  // Custom model / brand / type / fingerprint overrides
  const [brand, setBrand] = useState('');
  const [manufacturer, setManufacturer] = useState('');
  const [model, setModel] = useState('');
  const [buildType, setBuildType] = useState<'user' | 'userdebug'>('user');
  const [buildTags, setBuildTags] = useState('release-keys');
  const [buildFingerprint, setBuildFingerprint] = useState('');
  const [serialNo, setSerialNo] = useState('');
  const [androidId, setAndroidId] = useState('');
  const [macAddress, setMacAddress] = useState('');
  const [carrierName, setCarrierName] = useState('Telkomsel');
  const [timezone, setTimezone] = useState('Asia/Jakarta');

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    createClient()
      .profiles.list()
      .then((list) => {
        setProfiles(list);
        const initial = list.find((p) => p.id === profileId) ?? list[0];
        if (initial) applyPresetFields(initial);
      })
      .catch((e) => setError(String(e)));
  }, [open]);

  function applyPresetFields(p: DeviceProfile) {
    setProfileId(p.id);
    setBrand(p.brand);
    setManufacturer(p.manufacturer);
    setModel(p.model);
    setBuildType(p.buildType);
    setBuildTags(p.buildTags);
    setBuildFingerprint(p.buildFingerprint);
    setCarrierName(p.carrierName);
    setTimezone(p.timezone);
  }

  async function handleRandomize() {
    const selected = profiles.find((p) => p.id === profileId);
    const id = await createClient().profiles.generateIdentity(selected?.macOui);
    setSerialNo(id.serialNo);
    setAndroidId(id.androidId);
    setMacAddress(id.macAddress);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const payload: CreateInstanceInput = {
        name,
        androidVersion,
        profileId,
        stealthMode,
        exposeAdbPort,
        memoryMb,
        cpus,
        fps: 30,
        gpuMode: 'guest',
        autoStart: true,
        ...(proxy.trim() ? { proxy: proxy.trim() } : {}),
        ...(customImage.trim() ? { customImage: customImage.trim() } : {}),
        deviceProfile: {
          brand: brand || undefined,
          manufacturer: manufacturer || undefined,
          model: model || undefined,
          buildType,
          buildTags,
          buildFingerprint: buildFingerprint || undefined,
          serialNo: serialNo || undefined,
          androidId: androidId || undefined,
          macAddress: macAddress || undefined,
          carrierName: carrierName || undefined,
          timezone: timezone || undefined,
        },
      };
      await createClient().instances.create(payload);
      onCreated();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4">
      <div className="max-h-[92vh] w-full max-w-2xl overflow-y-auto rounded-xl border border-zinc-800 bg-zinc-900 p-6 shadow-2xl">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-white">Create Redroid Android Instance</h2>
          <button onClick={onClose} className="rounded p-1 text-zinc-400 hover:bg-zinc-800 hover:text-white">
            <X className="h-5 w-5" />
          </button>
        </div>

        {error && (
          <div className="mb-4 rounded-lg border border-red-800 bg-red-950/60 p-3 text-sm text-red-200">{error}</div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4 text-sm">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-xs text-zinc-400">Instance Name</label>
              <input
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-white"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs text-zinc-400">Android Version</label>
              <select
                value={androidVersion}
                onChange={(e) => setAndroidVersion(e.target.value as '11' | '12' | '13' | '14')}
                className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-white"
              >
                <option value="11">Android 11</option>
                <option value="12">Android 12</option>
                <option value="13">Android 13 (Recommended)</option>
                <option value="14">Android 14</option>
              </select>
            </div>
          </div>

          <div className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-4 space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 font-medium text-emerald-400">
                <ShieldCheck className="h-4 w-4" />
                <span>Device Profile & Anti-Emulator Stealth</span>
              </div>
              <button
                type="button"
                onClick={handleRandomize}
                className="flex items-center gap-1.5 rounded-md bg-zinc-800 px-2.5 py-1 text-xs text-zinc-200 hover:bg-zinc-700"
              >
                <Shuffle className="h-3.5 w-3.5" />
                Randomize Identity
              </button>
            </div>

            <div>
              <label className="mb-1 block text-xs text-zinc-400">Device Preset</label>
              <select
                value={profileId}
                onChange={(e) => {
                  const found = profiles.find((p) => p.id === e.target.value);
                  if (found) applyPresetFields(found);
                }}
                className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-white"
              >
                {profiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} ({p.brand} / {p.model})
                  </option>
                ))}
              </select>
            </div>

            <div className="grid grid-cols-3 gap-2">
              <div>
                <label className="mb-1 block text-xs text-zinc-400">Brand</label>
                <input
                  value={brand}
                  onChange={(e) => setBrand(e.target.value)}
                  className="w-full rounded border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 text-white"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs text-zinc-400">Manufacturer</label>
                <input
                  value={manufacturer}
                  onChange={(e) => setManufacturer(e.target.value)}
                  className="w-full rounded border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 text-white"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs text-zinc-400">Model</label>
                <input
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  className="w-full rounded border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 text-white"
                />
              </div>
            </div>

            <div className="grid grid-cols-3 gap-2">
              <div>
                <label className="mb-1 block text-xs text-zinc-400">Build Type</label>
                <select
                  value={buildType}
                  onChange={(e) => setBuildType(e.target.value as 'user' | 'userdebug')}
                  className="w-full rounded border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 text-white"
                >
                  <option value="user">user (Production)</option>
                  <option value="userdebug">userdebug</option>
                </select>
              </div>
              <div>
                <label className="mb-1 block text-xs text-zinc-400">Build Tags</label>
                <input
                  value={buildTags}
                  onChange={(e) => setBuildTags(e.target.value)}
                  className="w-full rounded border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 text-white"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs text-zinc-400">Carrier</label>
                <input
                  value={carrierName}
                  onChange={(e) => setCarrierName(e.target.value)}
                  className="w-full rounded border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 text-white"
                />
              </div>
            </div>

            <div>
              <label className="mb-1 block text-xs text-zinc-400">Build Fingerprint</label>
              <input
                value={buildFingerprint}
                onChange={(e) => setBuildFingerprint(e.target.value)}
                className="w-full rounded border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 font-mono text-xs text-white"
              />
            </div>

            <div className="grid grid-cols-3 gap-2">
              <div>
                <label className="mb-1 block text-xs text-zinc-400">Serial No (auto if blank)</label>
                <input
                  value={serialNo}
                  onChange={(e) => setSerialNo(e.target.value)}
                  placeholder="Auto-generated"
                  className="w-full rounded border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 font-mono text-xs text-white"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs text-zinc-400">ANDROID_ID (16 hex)</label>
                <input
                  value={androidId}
                  onChange={(e) => setAndroidId(e.target.value)}
                  placeholder="Auto-generated"
                  className="w-full rounded border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 font-mono text-xs text-white"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs text-zinc-400">MAC Address</label>
                <input
                  value={macAddress}
                  onChange={(e) => setMacAddress(e.target.value)}
                  placeholder="Auto-generated"
                  className="w-full rounded border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 font-mono text-xs text-white"
                />
              </div>
            </div>

            <div className="flex flex-wrap gap-4 pt-1">
              <label className="flex items-center gap-2 text-xs text-zinc-200">
                <input
                  type="checkbox"
                  checked={stealthMode}
                  onChange={(e) => setStealthMode(e.target.checked)}
                  className="rounded border-zinc-600"
                />
                Enable Stealth Mode (Anti-Emulator Hardening)
              </label>
              <label className="flex items-center gap-2 text-xs text-zinc-200">
                <input
                  type="checkbox"
                  checked={exposeAdbPort}
                  onChange={(e) => setExposeAdbPort(e.target.checked)}
                  className="rounded border-zinc-600"
                />
                Expose Unique Host ADB Port (15555–19999)
              </label>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="mb-1 block text-xs text-zinc-400">RAM (MB)</label>
              <input
                type="number"
                min={1024}
                max={32768}
                step={512}
                value={memoryMb}
                onChange={(e) => setMemoryMb(Number(e.target.value))}
                className="w-full rounded border border-zinc-700 bg-zinc-950 px-2.5 py-1.5 text-white"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs text-zinc-400">vCPUs</label>
              <input
                type="number"
                min={1}
                max={16}
                value={cpus}
                onChange={(e) => setCpus(Number(e.target.value))}
                className="w-full rounded border border-zinc-700 bg-zinc-950 px-2.5 py-1.5 text-white"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs text-zinc-400">Timezone</label>
              <input
                value={timezone}
                onChange={(e) => setTimezone(e.target.value)}
                className="w-full rounded border border-zinc-700 bg-zinc-950 px-2.5 py-1.5 text-white"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-xs text-zinc-400">HTTP Proxy (optional, host:port)</label>
              <input
                value={proxy}
                onChange={(e) => setProxy(e.target.value)}
                placeholder="192.168.1.10:8888"
                className="w-full rounded border border-zinc-700 bg-zinc-950 px-2.5 py-1.5 text-white"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs text-zinc-400">Custom Redroid Image (optional, e.g. w/ ARM NDK)</label>
              <input
                value={customImage}
                onChange={(e) => setCustomImage(e.target.value)}
                placeholder="redroid/redroid:13.0.0-latest"
                className="w-full rounded border border-zinc-700 bg-zinc-950 px-2.5 py-1.5 text-white"
              />
            </div>
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-zinc-700 px-4 py-2 text-zinc-300 hover:bg-zinc-800"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="rounded-lg bg-emerald-600 px-4 py-2 font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
            >
              {submitting ? 'Creating...' : 'Create & Boot Instance'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
