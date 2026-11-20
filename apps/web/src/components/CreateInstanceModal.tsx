import React, { useEffect, useState } from 'react';
import {
  extractFingerprintAndroidVersion,
  isPlayStoreSupportedAndroidVersion,
  parseProxyString,
  type AndroidVersion,
  type CreateDeviceProfileInput,
  type CreateInstanceInput,
  type DeviceProfile,
  type ProxyProfile,
  type ProxyProtocol,
  type ProxyTestResult,
  type SystemImageStatus,
} from '@droidforge/shared';
import { BookmarkPlus, Globe, RefreshCw, ShieldCheck, Shuffle, Store, X, Zap } from 'lucide-react';
import { createClient } from '../api/client';
import { formatPresetOptionLabel, groupDeviceProfiles } from '../lib/presets';

interface Props {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}

export const CreateInstanceModal: React.FC<Props> = ({ open, onClose, onCreated }) => {
  const [profiles, setProfiles] = useState<DeviceProfile[]>([]);
  const [profilesLoading, setProfilesLoading] = useState(false);
  const [randomizing, setRandomizing] = useState(false);

  const [name, setName] = useState(`android-${Math.floor(1000 + Math.random() * 9000)}`);
  const [androidVersion, setAndroidVersion] = useState<AndroidVersion>('13');
  const [profileId, setProfileId] = useState('pixel-8-pro');
  const [savePresetOpen, setSavePresetOpen] = useState(false);
  const [savePresetName, setSavePresetName] = useState('');
  const [savingPreset, setSavingPreset] = useState(false);
  const [savePresetNotice, setSavePresetNotice] = useState<string | null>(null);
  const [stealthMode, setStealthMode] = useState(true);
  const [enablePlayStore, setEnablePlayStore] = useState(false);
  const [enableRoot, setEnableRoot] = useState(false);
  const [playStoreTouched, setPlayStoreTouched] = useState(false);
  const [exposeAdbPort, setExposeAdbPort] = useState(false);
  const [memoryMb, setMemoryMb] = useState(2048);
  const [cpus, setCpus] = useState(2);
  const [proxyMode, setProxyMode] = useState<'none' | 'saved' | 'custom'>('none');
  const [proxyProfileId, setProxyProfileId] = useState('');
  const [proxyProtocol, setProxyProtocol] = useState<ProxyProtocol>('http');
  const [proxy, setProxy] = useState('');
  const [proxyTestResult, setProxyTestResult] = useState<ProxyTestResult | null>(null);
  const [testingProxy, setTestingProxy] = useState(false);
  const [savedProxies, setSavedProxies] = useState<ProxyProfile[]>([]);
  const [systemImages, setSystemImages] = useState<SystemImageStatus[]>([]);
  const [customImage, setCustomImage] = useState('');

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

  function loadProfiles() {
    setProfilesLoading(true);
    setError(null);
    const client = createClient();
    Promise.all([
      client.profiles.list(),
      client.system.images().catch(() => [] as SystemImageStatus[]),
      client.proxies.list().catch(() => [] as ProxyProfile[]),
    ])
      .then(([list, imgs, proxies]) => {
        setProfiles(list);
        const initial = list.find((p) => p.id === profileId) ?? list[0];
        if (initial) applyPresetFields(initial);
        setSystemImages(imgs);
        setSavedProxies(proxies);
        if (proxies.length > 0 && !proxyProfileId) {
          setProxyProfileId(proxies[0].id);
        }
        if (!playStoreTouched) {
          if (!isPlayStoreSupportedAndroidVersion(androidVersion)) {
            setEnablePlayStore(false);
          } else {
            const img = imgs.find((i) => i.androidVersion === androidVersion);
            setEnablePlayStore(Boolean(img?.playStoreInstalled));
          }
        }
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setProfilesLoading(false));
  }

  useEffect(() => {
    if (!open) return;
    setSavePresetOpen(false);
    setSavePresetNotice(null);
    loadProfiles();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape' && !submitting && !savingPreset) onClose();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, submitting, savingPreset, onClose]);

  function handleSelectAndroidVersion(nextVer: AndroidVersion) {
    setAndroidVersion(nextVer);
    if (!isPlayStoreSupportedAndroidVersion(nextVer)) {
      setEnablePlayStore(false);
      return;
    }
    if (!playStoreTouched) {
      const img = systemImages.find((item) => item.androidVersion === nextVer);
      setEnablePlayStore(Boolean(img?.playStoreInstalled));
    }
  }

  async function handleSaveAsPreset() {
    const trimmedName = savePresetName.trim();
    if (trimmedName.length < 2) {
      setError('Enter a custom preset name (at least 2 characters).');
      return;
    }
    const base = profiles.find((p) => p.id === profileId) ?? profiles[0];
    if (!base) {
      setError('Base preset is not loaded yet.');
      return;
    }

    setSavingPreset(true);
    setError(null);
    setSavePresetNotice(null);
    try {
      const payload: CreateDeviceProfileInput = {
        name: trimmedName,
        brand: brand.trim() || base.brand,
        manufacturer: manufacturer.trim() || base.manufacturer,
        model: model.trim() || base.model,
        device: base.device,
        product: base.product,
        hardware: base.hardware,
        board: base.board,
        platform: base.platform,
        buildType,
        buildTags: buildTags.trim() || base.buildTags,
        buildId: base.buildId,
        buildFingerprint: buildFingerprint.trim() || base.buildFingerprint,
        securityPatch: base.securityPatch,
        width: base.width,
        height: base.height,
        dpi: base.dpi,
        macOui: base.macOui,
        locale: base.locale,
        timezone: timezone.trim() || base.timezone,
        carrierName: carrierName.trim() || base.carrierName,
        carrierMccMnc: base.carrierMccMnc,
        countryIso: base.countryIso,
      };
      const client = createClient();
      const created = await client.profiles.create(payload);
      const updatedList = await client.profiles.list();
      setProfiles(updatedList);
      applyPresetFields(created);
      setSavePresetOpen(false);
      setSavePresetName('');
      setSavePresetNotice(`Saved custom preset "${created.name}".`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingPreset(false);
    }
  }

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
    setRandomizing(true);
    setError(null);
    try {
      const selected = profiles.find((p) => p.id === profileId);
      const id = await createClient().profiles.generateIdentity(selected?.macOui);
      setSerialNo(id.serialNo);
      setAndroidId(id.androidId);
      setMacAddress(id.macAddress);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRandomizing(false);
    }
  }

  const selectedImageStatus = systemImages.find((img) => img.androidVersion === androidVersion);
  const playStoreSupported = isPlayStoreSupportedAndroidVersion(androidVersion);
  const selectedPreset = profiles.find((p) => p.id === profileId);
  const groupedProfiles = groupDeviceProfiles(profiles);
  const presetAndroidVer = extractFingerprintAndroidVersion(buildFingerprint);
  const validAndroidVersions: readonly AndroidVersion[] = ['11', '12', '13', '14', '15', '16'];
  const switchablePresetVer =
    presetAndroidVer && (validAndroidVersions as readonly string[]).includes(presetAndroidVer)
      ? (presetAndroidVer as AndroidVersion)
      : null;

  async function handleTestCreateProxy() {
    setTestingProxy(true);
    setProxyTestResult(null);
    setError(null);
    try {
      let result: ProxyTestResult;
      if (proxyMode === 'saved' && proxyProfileId) {
        result = await createClient().proxies.test({ proxyProfileId });
      } else if (proxyMode === 'custom' && proxy.trim()) {
        const parsed = parseProxyString(proxy.trim(), proxyProtocol);
        result = await createClient().proxies.test({ config: parsed });
      } else {
        throw new Error('Select a saved proxy or enter a proxy endpoint first.');
      }
      setProxyTestResult(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setTestingProxy(false);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      let proxyPayload: Pick<CreateInstanceInput, 'proxyProfileId' | 'proxyConfig' | 'proxy'> = {};
      if (proxyMode === 'saved' && proxyProfileId) {
        proxyPayload = { proxyProfileId };
      } else if (proxyMode === 'custom' && proxy.trim()) {
        const parsedProxy = parseProxyString(proxy.trim(), proxyProtocol);
        proxyPayload = { proxyConfig: parsedProxy };
      }

      const payload: CreateInstanceInput = {
        name,
        androidVersion,
        profileId,
        stealthMode,
        enablePlayStore,
        enableRoot,
        exposeAdbPort,
        memoryMb,
        cpus,
        fps: 30,
        gpuMode: 'guest',
        autoStart: true,
        ...proxyPayload,
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
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-3 sm:p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget && !submitting) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-instance-title"
        className="nb-panel-elevated flex max-h-[92dvh] w-full max-w-2xl flex-col overflow-hidden"
      >
        <div className="flex shrink-0 items-center justify-between border-b-2 border-[var(--border)] bg-[var(--bg-subtle)] px-4 py-3">
          <h2 id="create-instance-title" className="text-base font-extrabold text-[var(--ink)] sm:text-lg">
            Create Redroid Android Instance
          </h2>
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            aria-label="Close Create Instance dialog"
            className="nb-btn nb-btn-secondary px-2.5"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col">
          <div className="flex-1 space-y-4 overflow-y-auto p-4 text-sm">
            {error && (
              <div className="flex flex-wrap items-center justify-between gap-2 border-2 border-[var(--border)] bg-[var(--status-err-bg)] p-3 text-[13px] font-medium text-[var(--status-err-ink)]">
                <span>{error}</span>
                {profiles.length === 0 && (
                  <button type="button" onClick={loadProfiles} className="nb-btn nb-btn-secondary">
                    <RefreshCw className="h-3.5 w-3.5" />
                    Retry Presets
                  </button>
                )}
              </div>
            )}

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <label htmlFor="inst-name" className="mb-1.5 block text-[13px] font-bold text-[var(--ink)]">
                  Instance Name
                </label>
                <input
                  id="inst-name"
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="nb-input"
                />
              </div>
              <div>
                <label htmlFor="inst-android" className="mb-1.5 block text-[13px] font-bold text-[var(--ink)]">
                  Android Version
                </label>
                <select
                  id="inst-android"
                  value={androidVersion}
                  onChange={(e) => handleSelectAndroidVersion(e.target.value as AndroidVersion)}
                  className="nb-input"
                >
                  <option value="11">Android 11</option>
                  <option value="12">Android 12</option>
                  <option value="13">Android 13 (Recommended)</option>
                  <option value="14">Android 14</option>
                  <option value="15">Android 15</option>
                  <option value="16">Android 16 (Latest)</option>
                </select>
              </div>
            </div>

            <div className="space-y-3 border-2 border-[var(--border)] bg-[var(--bg-ground)] p-3 sm:p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2 text-sm font-extrabold text-[var(--ink)]">
                  <ShieldCheck className="h-4 w-4 shrink-0" aria-hidden="true" />
                  <span>Device Profile and Stealth Identity</span>
                </div>
                <button
                  type="button"
                  onClick={() => void handleRandomize()}
                  disabled={randomizing}
                  className="nb-btn nb-btn-secondary"
                >
                  <Shuffle className="h-3.5 w-3.5" aria-hidden="true" />
                  {randomizing ? 'Generating...' : 'Randomize Identity'}
                </button>
              </div>

              <div>
                <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
                  <label htmlFor="inst-preset" className="block text-[13px] font-bold text-[var(--ink)]">
                    Device Preset
                  </label>
                  <button
                    type="button"
                    disabled={profilesLoading || savingPreset}
                    onClick={() => {
                      setSavePresetNotice(null);
                      setSavePresetOpen((prev) => {
                        const next = !prev;
                        if (next && !savePresetName.trim()) {
                          setSavePresetName(`${brand || 'Custom'} ${model || 'Device'} Custom`.trim());
                        }
                        return next;
                      });
                    }}
                    className="nb-btn nb-btn-secondary px-2.5 text-xs"
                  >
                    <BookmarkPlus className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                    <span>Save as Preset</span>
                  </button>
                </div>
                <select
                  id="inst-preset"
                  disabled={profilesLoading}
                  value={profileId}
                  onChange={(e) => {
                    const found = profiles.find((p) => p.id === e.target.value);
                    if (found) applyPresetFields(found);
                  }}
                  className="nb-input"
                >
                  {profilesLoading ? (
                    <option value={profileId}>Loading device presets...</option>
                  ) : profiles.length === 0 ? (
                    <option value={profileId}>{profileId}</option>
                  ) : (
                    <>
                      {!profiles.some((p) => p.id === profileId) && (
                        <option value={profileId}>{profileId}</option>
                      )}
                      {groupedProfiles.map((group) => (
                        <optgroup key={group.label} label={group.label}>
                          {group.profiles.map((p) => (
                            <option key={p.id} value={p.id}>
                              {formatPresetOptionLabel(p)}
                            </option>
                          ))}
                        </optgroup>
                      ))}
                    </>
                  )}
                </select>

                {selectedPreset && (
                  <p className="num mt-1.5 text-xs font-medium text-[var(--ink-muted)]">
                    {selectedPreset.width}x{selectedPreset.height} @ {selectedPreset.dpi} DPI · Platform: {selectedPreset.platform} · Patch: {selectedPreset.securityPatch}
                  </p>
                )}

                {presetAndroidVer && presetAndroidVer !== androidVersion && (
                  <div className="mt-2 flex flex-wrap items-center justify-between gap-2 border-2 border-[var(--border)] bg-[var(--status-warn-bg)] px-2.5 py-2 text-xs font-semibold text-[var(--status-warn-ink)]">
                    <span>
                      Fingerprint targets Android {presetAndroidVer}, while instance OS is Android {androidVersion}.
                    </span>
                    {switchablePresetVer && (
                      <button
                        type="button"
                        onClick={() => handleSelectAndroidVersion(switchablePresetVer)}
                        className="nb-btn nb-btn-secondary px-2.5 text-xs"
                      >
                        Switch to Android {switchablePresetVer}
                      </button>
                    )}
                  </div>
                )}

                {savePresetOpen && (
                  <div className="mt-2 flex flex-wrap items-center gap-2 border-2 border-[var(--border)] bg-[var(--bg-surface)] p-2.5">
                    <input
                      id="inst-save-preset-name"
                      value={savePresetName}
                      onChange={(e) => setSavePresetName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          void handleSaveAsPreset();
                        }
                      }}
                      placeholder="Custom preset name"
                      aria-label="Custom preset name"
                      className="nb-input min-w-[180px] flex-1"
                    />
                    <button
                      type="button"
                      disabled={savingPreset}
                      onClick={() => void handleSaveAsPreset()}
                      className="nb-btn nb-btn-primary px-3 text-xs"
                    >
                      {savingPreset ? 'Saving...' : 'Save Preset'}
                    </button>
                    <button
                      type="button"
                      disabled={savingPreset}
                      onClick={() => setSavePresetOpen(false)}
                      className="nb-btn nb-btn-secondary px-2.5 text-xs"
                    >
                      Cancel
                    </button>
                  </div>
                )}

                {savePresetNotice && (
                  <div className="mt-2 border-2 border-[var(--border)] bg-[var(--status-ok-bg)] px-2.5 py-1.5 text-xs font-semibold text-[var(--status-ok-ink)]">
                    {savePresetNotice}
                  </div>
                )}
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <div>
                  <label htmlFor="inst-brand" className="mb-1 block text-[13px] font-semibold text-[var(--ink-secondary)]">
                    Brand
                  </label>
                  <input
                    id="inst-brand"
                    value={brand}
                    onChange={(e) => setBrand(e.target.value)}
                    className="nb-input"
                  />
                </div>
                <div>
                  <label
                    htmlFor="inst-manufacturer"
                    className="mb-1 block text-[13px] font-semibold text-[var(--ink-secondary)]"
                  >
                    Manufacturer
                  </label>
                  <input
                    id="inst-manufacturer"
                    value={manufacturer}
                    onChange={(e) => setManufacturer(e.target.value)}
                    className="nb-input"
                  />
                </div>
                <div>
                  <label htmlFor="inst-model" className="mb-1 block text-[13px] font-semibold text-[var(--ink-secondary)]">
                    Model
                  </label>
                  <input
                    id="inst-model"
                    value={model}
                    onChange={(e) => setModel(e.target.value)}
                    className="nb-input"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <div>
                  <label
                    htmlFor="inst-build-type"
                    className="mb-1 block text-[13px] font-semibold text-[var(--ink-secondary)]"
                  >
                    Build Type
                  </label>
                  <select
                    id="inst-build-type"
                    value={buildType}
                    onChange={(e) => setBuildType(e.target.value as 'user' | 'userdebug')}
                    className="nb-input"
                  >
                    <option value="user">user (Production)</option>
                    <option value="userdebug">userdebug</option>
                  </select>
                </div>
                <div>
                  <label
                    htmlFor="inst-build-tags"
                    className="mb-1 block text-[13px] font-semibold text-[var(--ink-secondary)]"
                  >
                    Build Tags
                  </label>
                  <input
                    id="inst-build-tags"
                    value={buildTags}
                    onChange={(e) => setBuildTags(e.target.value)}
                    className="nb-input"
                  />
                </div>
                <div>
                  <label
                    htmlFor="inst-carrier"
                    className="mb-1 block text-[13px] font-semibold text-[var(--ink-secondary)]"
                  >
                    Carrier
                  </label>
                  <input
                    id="inst-carrier"
                    value={carrierName}
                    onChange={(e) => setCarrierName(e.target.value)}
                    className="nb-input"
                  />
                </div>
              </div>

              <div>
                <label
                  htmlFor="inst-fingerprint"
                  className="mb-1 block text-[13px] font-semibold text-[var(--ink-secondary)]"
                >
                  Build Fingerprint
                </label>
                <input
                  id="inst-fingerprint"
                  value={buildFingerprint}
                  onChange={(e) => setBuildFingerprint(e.target.value)}
                  className="nb-input num text-[13px]"
                />
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <div>
                  <label
                    htmlFor="inst-serial"
                    className="mb-1 block text-[13px] font-semibold text-[var(--ink-secondary)]"
                  >
                    Serial No
                  </label>
                  <input
                    id="inst-serial"
                    value={serialNo}
                    onChange={(e) => setSerialNo(e.target.value)}
                    placeholder="Auto-generated"
                    className="nb-input num text-[13px]"
                  />
                </div>
                <div>
                  <label
                    htmlFor="inst-android-id"
                    className="mb-1 block text-[13px] font-semibold text-[var(--ink-secondary)]"
                  >
                    ANDROID_ID (16 hex)
                  </label>
                  <input
                    id="inst-android-id"
                    value={androidId}
                    onChange={(e) => setAndroidId(e.target.value)}
                    placeholder="Auto-generated"
                    className="nb-input num text-[13px]"
                  />
                </div>
                <div>
                  <label htmlFor="inst-mac" className="mb-1 block text-[13px] font-semibold text-[var(--ink-secondary)]">
                    MAC Address
                  </label>
                  <input
                    id="inst-mac"
                    value={macAddress}
                    onChange={(e) => setMacAddress(e.target.value)}
                    placeholder="Auto-generated"
                    className="nb-input num text-[13px]"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 gap-2 pt-1 sm:grid-cols-2">
                <label className="flex min-h-[44px] cursor-pointer items-center gap-2.5 border-2 border-[var(--border)] bg-[var(--bg-surface)] px-3 py-2 text-[13px] font-semibold text-[var(--ink)]">
                  <input
                    type="checkbox"
                    checked={stealthMode}
                    onChange={(e) => setStealthMode(e.target.checked)}
                    className="h-4 w-4 shrink-0 accent-[var(--ink)]"
                  />
                  <span>Stealth Mode (Anti-Emulator Hardening)</span>
                </label>
                <label className="flex min-h-[44px] cursor-pointer items-center gap-2.5 border-2 border-[var(--border)] bg-[var(--bg-surface)] px-3 py-2 text-[13px] font-semibold text-[var(--ink)]">
                  <input
                    type="checkbox"
                    checked={exposeAdbPort}
                    onChange={(e) => setExposeAdbPort(e.target.checked)}
                    className="h-4 w-4 shrink-0 accent-[var(--ink)]"
                  />
                  <span>Expose Host ADB Port (15555-19999)</span>
                </label>
                <label className="flex min-h-[44px] cursor-pointer items-center gap-2.5 border-2 border-[var(--border)] bg-[var(--bg-surface)] px-3 py-2 text-[13px] font-semibold text-[var(--ink)] sm:col-span-2">
                  <input
                    type="checkbox"
                    checked={enableRoot}
                    onChange={(e) => setEnableRoot(e.target.checked)}
                    className="h-4 w-4 shrink-0 accent-[var(--ink)]"
                  />
                  <span>Enable Root Access (su Daemon)</span>
                </label>
              </div>

              <div className="border-2 border-[var(--border)] bg-[var(--bg-surface)] p-3 space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <label className="flex min-h-[44px] cursor-pointer items-center gap-2.5 text-[13px] font-bold text-[var(--ink)]">
                    <input
                      type="checkbox"
                      checked={enablePlayStore}
                      disabled={!playStoreSupported}
                      onChange={(e) => {
                        setPlayStoreTouched(true);
                        setEnablePlayStore(e.target.checked);
                      }}
                      className="h-4 w-4 shrink-0 accent-[var(--ink)]"
                    />
                    <Store className="h-4 w-4 shrink-0" aria-hidden="true" />
                    <span>Google Play Store + GMS (MindTheGapps)</span>
                  </label>
                  {!playStoreSupported ? (
                    <span className="num border-2 border-[var(--border)] bg-[var(--status-idle-bg)] px-2 py-0.5 text-xs font-extrabold uppercase text-[var(--status-idle-ink)]">
                      Not Available
                    </span>
                  ) : (
                    selectedImageStatus && (
                      <span
                        className={`num border-2 border-[var(--border)] px-2 py-0.5 text-xs font-extrabold uppercase ${
                          selectedImageStatus.playStoreInstalled
                            ? 'bg-[var(--status-ok-bg)] text-[var(--status-ok-ink)]'
                            : 'bg-[var(--status-warn-bg)] text-[var(--status-warn-ink)]'
                        }`}
                      >
                        {selectedImageStatus.playStoreInstalled
                          ? `Built (${selectedImageStatus.playStoreSizeMb ?? '?'} MB)`
                          : 'Not Built'}
                      </span>
                    )
                  )}
                </div>
                {!playStoreSupported ? (
                  <p className="text-xs text-[var(--ink-muted)]">
                    Play Store MindTheGapps overlay is supported on Android 12, 13, and 14. Android {androidVersion} boots AOSP{' '}
                    <code>redroid/redroid:{androidVersion}.0.0-latest</code> unless a Custom Redroid Image is specified.
                  </p>
                ) : selectedImageStatus && !selectedImageStatus.playStoreInstalled ? (
                  <div className="border-2 border-[var(--border)] bg-[var(--status-warn-bg)] p-2 text-xs font-semibold text-[var(--status-warn-ink)]">
                    Build Play Store image on server first:{' '}
                    <code>{selectedImageStatus.buildCommand}</code>
                  </div>
                ) : (
                  <p className="text-xs text-[var(--ink-muted)]">
                    Boots {selectedImageStatus?.playStoreImage ?? `droidforge/redroid:${androidVersion}.0.0-playstore`} with Google Play Store and ARM translation.
                  </p>
                )}
              </div>
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div>
                <label htmlFor="inst-ram" className="mb-1 block text-[13px] font-bold text-[var(--ink)]">
                  RAM (MB)
                </label>
                <input
                  id="inst-ram"
                  type="number"
                  min={1024}
                  max={32768}
                  step={512}
                  value={memoryMb}
                  onChange={(e) => setMemoryMb(Number(e.target.value))}
                  className="nb-input num"
                />
              </div>
              <div>
                <label htmlFor="inst-cpus" className="mb-1 block text-[13px] font-bold text-[var(--ink)]">
                  vCPUs
                </label>
                <input
                  id="inst-cpus"
                  type="number"
                  min={1}
                  max={16}
                  value={cpus}
                  onChange={(e) => setCpus(Number(e.target.value))}
                  className="nb-input num"
                />
              </div>
              <div>
                <label htmlFor="inst-timezone" className="mb-1 block text-[13px] font-bold text-[var(--ink)]">
                  Timezone
                </label>
                <input
                  id="inst-timezone"
                  value={timezone}
                  onChange={(e) => setTimezone(e.target.value)}
                  className="nb-input"
                />
              </div>
            </div>

            <div className="space-y-3 border-2 border-[var(--border)] bg-[var(--bg-ground)] p-3 sm:p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2 text-sm font-extrabold text-[var(--ink)]">
                  <Globe className="h-4 w-4 shrink-0" aria-hidden="true" />
                  <span>Network Proxy (HTTP / HTTPS / SOCKS5 + Auth)</span>
                </div>
                {proxyMode !== 'none' && (
                  <button
                    type="button"
                    disabled={testingProxy}
                    onClick={() => void handleTestCreateProxy()}
                    className="nb-btn nb-btn-secondary"
                  >
                    <Zap className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                    <span>{testingProxy ? 'Testing...' : 'Test Proxy'}</span>
                  </button>
                )}
              </div>

              <div className="grid grid-cols-3 gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setProxyMode('none');
                    setProxyTestResult(null);
                  }}
                  className={`nb-btn ${proxyMode === 'none' ? 'nb-btn-primary' : 'nb-btn-secondary'}`}
                >
                  Direct
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setProxyMode('saved');
                    setProxyTestResult(null);
                  }}
                  className={`nb-btn ${proxyMode === 'saved' ? 'nb-btn-primary' : 'nb-btn-secondary'}`}
                >
                  Saved ({savedProxies.length})
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setProxyMode('custom');
                    setProxyTestResult(null);
                  }}
                  className={`nb-btn ${proxyMode === 'custom' ? 'nb-btn-primary' : 'nb-btn-secondary'}`}
                >
                  Custom
                </button>
              </div>

              {proxyMode === 'saved' && (
                <div>
                  <label htmlFor="inst-proxy-profile" className="mb-1 block text-xs font-bold text-[var(--ink-secondary)]">
                    Select Saved Proxy from Pool
                  </label>
                  {savedProxies.length === 0 ? (
                    <div className="border-2 border-dashed border-[var(--border)] bg-[var(--bg-surface)] p-2.5 text-xs text-[var(--ink-muted)]">
                      No saved proxies found in pool. Switch to Custom to enter one directly.
                    </div>
                  ) : (
                    <select
                      id="inst-proxy-profile"
                      value={proxyProfileId}
                      onChange={(e) => {
                        setProxyProfileId(e.target.value);
                        setProxyTestResult(null);
                      }}
                      className="nb-input num"
                    >
                      {savedProxies.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name} ({p.protocol.toUpperCase()} {p.host}:{p.port}
                          {p.lastCountryCode ? ` - ${p.lastCountryCode}` : ''})
                        </option>
                      ))}
                    </select>
                  )}
                </div>
              )}

              {proxyMode === 'custom' && (
                <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-[140px_minmax(0,1fr)]">
                  <div>
                    <label htmlFor="inst-proxy-proto" className="mb-1 block text-xs font-bold text-[var(--ink-secondary)]">
                      Default Protocol
                    </label>
                    <select
                      id="inst-proxy-proto"
                      value={proxyProtocol}
                      onChange={(e) => setProxyProtocol(e.target.value as ProxyProtocol)}
                      className="nb-input"
                    >
                      <option value="http">HTTP</option>
                      <option value="https">HTTPS</option>
                      <option value="socks5">SOCKS5</option>
                    </select>
                  </div>
                  <div>
                    <label htmlFor="inst-proxy" className="mb-1 block text-xs font-bold text-[var(--ink-secondary)]">
                      Proxy Endpoint (url or host:port[:user:pass])
                    </label>
                    <input
                      id="inst-proxy"
                      value={proxy}
                      onChange={(e) => setProxy(e.target.value)}
                      placeholder="socks5://user:pass@1.2.3.4:1080"
                      className="nb-input num"
                    />
                  </div>
                </div>
              )}

              {proxyTestResult && (
                <div
                  className={`border-2 border-[var(--border)] p-2.5 text-xs font-semibold ${
                    proxyTestResult.ok
                      ? 'bg-[var(--status-ok-bg)] text-[var(--status-ok-ink)]'
                      : 'bg-[var(--status-err-bg)] text-[var(--status-err-ink)]'
                  }`}
                >
                  {proxyTestResult.ok ? (
                    <span className="num">
                      Proxy OK ({proxyTestResult.latencyMs ?? '?'} ms) / Exit IP: {proxyTestResult.exitIp} (
                      {[proxyTestResult.city, proxyTestResult.countryCode].filter(Boolean).join(', ') || 'Unknown'})
                    </span>
                  ) : (
                    <span>Proxy test failed: {proxyTestResult.error}</span>
                  )}
                </div>
              )}
            </div>

            <div>
              <label htmlFor="inst-custom-image" className="mb-1 block text-[13px] font-bold text-[var(--ink)]">
                Custom Redroid Image (optional)
              </label>
              <input
                id="inst-custom-image"
                value={customImage}
                onChange={(e) => setCustomImage(e.target.value)}
                placeholder="redroid/redroid:13.0.0-latest"
                className="nb-input"
              />
            </div>
          </div>

          <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t-2 border-[var(--border)] bg-[var(--bg-subtle)] px-4 py-3">
            <button type="button" onClick={onClose} disabled={submitting} className="nb-btn nb-btn-secondary">
              Cancel
            </button>
            <button type="submit" disabled={submitting} className="nb-btn nb-btn-primary">
              {submitting ? 'Creating Instance...' : 'Create and Boot Instance'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
