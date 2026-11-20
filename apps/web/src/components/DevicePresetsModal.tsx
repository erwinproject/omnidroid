import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  CreateDeviceProfileSchema,
  extractFingerprintAndroidVersion,
  type CreateDeviceProfileInput,
  type DeviceProfile,
} from '@droidforge/shared';
import { Copy, Pencil, Plus, RefreshCw, Search, Smartphone, Trash2, X } from 'lucide-react';
import { createClient } from '../api/client';

interface Props {
  open: boolean;
  onClose: () => void;
  onChanged?: () => void;
}

type LibraryFilter = 'all' | 'custom' | 'builtin';

interface PresetFormState {
  id: string;
  name: string;
  brand: string;
  manufacturer: string;
  model: string;
  device: string;
  product: string;
  hardware: string;
  board: string;
  platform: string;
  buildType: 'user' | 'userdebug';
  buildTags: string;
  buildId: string;
  securityPatch: string;
  buildFingerprint: string;
  width: string;
  height: string;
  dpi: string;
  macOui: string;
  locale: string;
  timezone: string;
  carrierName: string;
  carrierMccMnc: string;
  countryIso: string;
}

function makeBlankForm(): PresetFormState {
  return {
    id: '',
    name: '',
    brand: '',
    manufacturer: '',
    model: '',
    device: '',
    product: '',
    hardware: 'qcom',
    board: '',
    platform: '',
    buildType: 'user',
    buildTags: 'release-keys',
    buildId: 'AP3A.240905.015.A2',
    securityPatch: '2025-03-01',
    buildFingerprint: '',
    width: '1080',
    height: '2400',
    dpi: '420',
    macOui: '3C:28:6D',
    locale: 'id-ID',
    timezone: 'Asia/Jakarta',
    carrierName: 'Telkomsel',
    carrierMccMnc: '51010',
    countryIso: 'id',
  };
}

function formFromProfile(profile: DeviceProfile, mode: 'edit' | 'clone'): PresetFormState {
  return {
    id: mode === 'edit' ? profile.id : '',
    name: mode === 'edit' ? profile.name : `${profile.name} ${profile.isBuiltIn ? 'Custom' : 'Copy'}`,
    brand: profile.brand,
    manufacturer: profile.manufacturer,
    model: profile.model,
    device: profile.device,
    product: profile.product,
    hardware: profile.hardware,
    board: profile.board,
    platform: profile.platform,
    buildType: profile.buildType,
    buildTags: profile.buildTags,
    buildId: profile.buildId,
    securityPatch: profile.securityPatch,
    buildFingerprint: profile.buildFingerprint,
    width: String(profile.width),
    height: String(profile.height),
    dpi: String(profile.dpi),
    macOui: profile.macOui,
    locale: profile.locale,
    timezone: profile.timezone,
    carrierName: profile.carrierName,
    carrierMccMnc: profile.carrierMccMnc,
    countryIso: profile.countryIso,
  };
}

const fieldLabelClass = 'mb-1 block text-xs font-semibold text-[var(--ink-secondary)]';

export const DevicePresetsModal: React.FC<Props> = ({ open, onClose, onChanged }) => {
  const [profiles, setProfiles] = useState<DeviceProfile[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<LibraryFilter>('all');

  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<PresetFormState>(makeBlankForm);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [formNotice, setFormNotice] = useState<string | null>(null);

  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const loadProfiles = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const list = await createClient().profiles.list();
      setProfiles(list);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    setFormError(null);
    setFormNotice(null);
    setConfirmDeleteId(null);
    void loadProfiles();
  }, [open, loadProfiles]);

  useEffect(() => {
    if (!open) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape' && !saving && !deletingId) {
        onClose();
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, saving, deletingId, onClose]);

  const builtInCount = useMemo(() => profiles.filter((p) => p.isBuiltIn).length, [profiles]);
  const customCount = useMemo(() => profiles.filter((p) => !p.isBuiltIn).length, [profiles]);

  const filteredProfiles = useMemo(() => {
    const q = search.trim().toLowerCase();
    return profiles.filter((p) => {
      if (filter === 'custom' && p.isBuiltIn) return false;
      if (filter === 'builtin' && !p.isBuiltIn) return false;
      if (!q) return true;
      return (
        p.name.toLowerCase().includes(q) ||
        p.brand.toLowerCase().includes(q) ||
        p.model.toLowerCase().includes(q) ||
        p.id.toLowerCase().includes(q)
      );
    });
  }, [profiles, filter, search]);

  if (!open) return null;

  function setField<K extends keyof PresetFormState>(key: K, value: PresetFormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function startNewBlank() {
    setEditingId(null);
    setForm(makeBlankForm());
    setFormError(null);
    setFormNotice(null);
  }

  function startClone(profile: DeviceProfile) {
    setEditingId(null);
    setForm(formFromProfile(profile, 'clone'));
    setFormError(null);
    setFormNotice(`Loaded copy of "${profile.name}". Customize fields and save as a new preset.`);
  }

  function startEdit(profile: DeviceProfile) {
    setEditingId(profile.id);
    setForm(formFromProfile(profile, 'edit'));
    setFormError(null);
    setFormNotice(null);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    setFormNotice(null);

    const candidate: Record<string, unknown> = {
      name: form.name.trim(),
      brand: form.brand.trim(),
      manufacturer: form.manufacturer.trim(),
      model: form.model.trim(),
      device: form.device.trim(),
      product: form.product.trim(),
      hardware: form.hardware.trim(),
      board: form.board.trim(),
      platform: form.platform.trim(),
      buildType: form.buildType,
      buildTags: form.buildTags.trim() || 'release-keys',
      buildId: form.buildId.trim() || 'AP3A.240905.015.A2',
      securityPatch: form.securityPatch.trim() || '2025-03-01',
      buildFingerprint: form.buildFingerprint.trim(),
      width: Number(form.width),
      height: Number(form.height),
      dpi: Number(form.dpi),
      macOui: form.macOui.trim().toUpperCase(),
      locale: form.locale.trim() || 'id-ID',
      timezone: form.timezone.trim() || 'Asia/Jakarta',
      carrierName: form.carrierName.trim() || 'Telkomsel',
      carrierMccMnc: form.carrierMccMnc.trim() || '51010',
      countryIso: form.countryIso.trim().toLowerCase(),
    };

    if (!editingId && form.id.trim()) {
      candidate.id = form.id.trim();
    }

    const parsed = CreateDeviceProfileSchema.safeParse(candidate);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const fieldName = issue?.path.join('.') || 'input';
      setFormError(`Invalid ${fieldName}: ${issue?.message ?? 'Check form fields.'}`);
      return;
    }

    setSaving(true);
    try {
      const client = createClient();
      const payload: CreateDeviceProfileInput = parsed.data;
      if (editingId) {
        const updated = await client.profiles.update(editingId, payload);
        setForm(formFromProfile(updated, 'edit'));
        setFormNotice(`Updated custom preset "${updated.name}".`);
      } else {
        const created = await client.profiles.create(payload);
        setEditingId(created.id);
        setForm(formFromProfile(created, 'edit'));
        setFormNotice(`Created custom preset "${created.name}" (${created.id}).`);
      }
      await loadProfiles();
      onChanged?.();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id: string) {
    setDeletingId(id);
    setFormError(null);
    setFormNotice(null);
    try {
      await createClient().profiles.delete(id);
      setConfirmDeleteId(null);
      if (editingId === id) {
        setEditingId(null);
        setForm(makeBlankForm());
      }
      setFormNotice(`Deleted custom preset "${id}".`);
      await loadProfiles();
      onChanged?.();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-3 sm:p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget && !saving && !deletingId) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="device-presets-title"
        className="nb-panel-elevated flex max-h-[92dvh] w-full max-w-5xl flex-col overflow-hidden"
      >
        <div className="flex shrink-0 items-center justify-between gap-2 border-b-2 border-[var(--border)] bg-[var(--bg-subtle)] px-4 py-3">
          <div className="flex min-w-0 items-center gap-2.5">
            <Smartphone className="h-4 w-4 shrink-0 text-[var(--ink)]" aria-hidden="true" />
            <div className="min-w-0">
              <h2 id="device-presets-title" className="truncate text-base font-extrabold text-[var(--ink)] sm:text-lg">
                Device Presets
              </h2>
              <p className="num text-xs font-semibold text-[var(--ink-muted)]">
                {builtInCount} built-in, {customCount} custom
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={saving || Boolean(deletingId)}
            aria-label="Close Device Presets dialog"
            className="nb-btn nb-btn-secondary shrink-0 px-2.5"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)] lg:overflow-hidden">
          {/* Library Pane */}
          <section
            aria-label="Preset library"
            className="flex flex-col border-b-2 border-[var(--border)] bg-[var(--bg-ground)] lg:min-h-0 lg:border-b-0 lg:border-r-2"
          >
            <div className="shrink-0 space-y-2.5 border-b-2 border-[var(--border)] bg-[var(--bg-surface)] p-3">
              <div className="relative">
                <Search
                  className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--ink-muted)]"
                  aria-hidden="true"
                />
                <input
                  type="search"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search by name, brand, model, or ID"
                  aria-label="Search device presets"
                  className="nb-input pl-9"
                />
              </div>

              <div className="grid grid-cols-3 gap-1.5" role="group" aria-label="Filter device presets">
                {(
                  [
                    { key: 'all', label: `All (${profiles.length})` },
                    { key: 'custom', label: `Custom (${customCount})` },
                    { key: 'builtin', label: `Built-in (${builtInCount})` },
                  ] as const
                ).map((tab) => (
                  <button
                    key={tab.key}
                    type="button"
                    onClick={() => setFilter(tab.key)}
                    aria-pressed={filter === tab.key}
                    className={`nb-btn px-2 text-xs ${
                      filter === tab.key ? 'nb-btn-primary' : 'nb-btn-secondary'
                    }`}
                  >
                    <span className="num truncate">{tab.label}</span>
                  </button>
                ))}
              </div>
            </div>

            <div className="space-y-2.5 p-3 lg:min-h-0 lg:flex-1 lg:overflow-y-auto">
              {loading ? (
                <div className="space-y-2.5" aria-label="Loading device presets">
                  <div className="h-24 border-2 border-[var(--border-subtle)] bg-[var(--bg-subtle)]" />
                  <div className="h-24 border-2 border-[var(--border-subtle)] bg-[var(--bg-subtle)]" />
                  <div className="h-24 border-2 border-[var(--border-subtle)] bg-[var(--bg-subtle)]" />
                </div>
              ) : loadError ? (
                <div className="space-y-2.5 border-2 border-[var(--border)] bg-[var(--status-err-bg)] p-3 text-xs font-semibold text-[var(--status-err-ink)]">
                  <div>Could not load device presets: {loadError}</div>
                  <button type="button" onClick={() => void loadProfiles()} className="nb-btn nb-btn-secondary">
                    <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
                    Retry Presets
                  </button>
                </div>
              ) : filteredProfiles.length === 0 ? (
                <div className="space-y-2.5 border-2 border-dashed border-[var(--border)] bg-[var(--bg-surface)] p-4 text-center">
                  <p className="text-[13px] font-semibold text-[var(--ink-secondary)]">
                    {filter === 'custom' && customCount === 0 && !search.trim()
                      ? 'No custom presets yet. Create one using the form or clone a built-in device.'
                      : 'No device presets match your current filter.'}
                  </p>
                  {search.trim() ? (
                    <button type="button" onClick={() => setSearch('')} className="nb-btn nb-btn-secondary">
                      Clear Search
                    </button>
                  ) : filter === 'custom' ? (
                    <button type="button" onClick={() => setFilter('all')} className="nb-btn nb-btn-secondary">
                      Browse Built-in Presets
                    </button>
                  ) : null}
                </div>
              ) : (
                filteredProfiles.map((p) => {
                  const androidVer = extractFingerprintAndroidVersion(p.buildFingerprint);
                  const isEditingThis = editingId === p.id;
                  const isDeletingThis = deletingId === p.id;
                  return (
                    <article
                      key={p.id}
                      className={`border-2 border-[var(--border)] p-3 ${
                        isEditingThis
                          ? 'border-l-[6px] border-l-[var(--accent)] bg-[var(--bg-surface)] shadow-[3px_3px_0_var(--shadow-color)]'
                          : 'bg-[var(--bg-surface)]'
                      }`}
                    >
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          <h3 className="truncate text-sm font-extrabold text-[var(--ink)]">{p.name}</h3>
                          <p className="mt-0.5 text-xs font-semibold text-[var(--ink-secondary)]">
                            {p.brand} / {p.model}{' '}
                            <span className="num text-[var(--ink-muted)]">({p.id})</span>
                          </p>
                        </div>
                        <div className="flex shrink-0 flex-wrap items-center gap-1">
                          {androidVer && (
                            <span className="num border border-[var(--border)] bg-[var(--bg-subtle)] px-1.5 py-0.5 text-[11px] font-bold text-[var(--ink)]">
                              Android {androidVer}
                            </span>
                          )}
                          <span
                            className={`border border-[var(--border)] px-1.5 py-0.5 text-[11px] font-extrabold ${
                              p.isBuiltIn
                                ? 'bg-[var(--status-idle-bg)] text-[var(--status-idle-ink)]'
                                : 'bg-[var(--status-ok-bg)] text-[var(--status-ok-ink)]'
                            }`}
                          >
                            {p.isBuiltIn ? 'Built-in' : 'Custom'}
                          </span>
                        </div>
                      </div>

                      <div className="num mt-2 text-xs font-medium text-[var(--ink-muted)]">
                        {p.width}x{p.height} @ {p.dpi} DPI · {p.platform} · Patch {p.securityPatch}
                      </div>

                      <div className="mt-2.5 flex flex-wrap gap-1.5 border-t border-[var(--border-subtle)] pt-2">
                        {p.isBuiltIn ? (
                          <button
                            type="button"
                            onClick={() => startClone(p)}
                            className="nb-btn nb-btn-secondary flex-1 px-2.5 text-xs"
                          >
                            <Copy className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                            <span>Clone to Custom</span>
                          </button>
                        ) : (
                          <>
                            <button
                              type="button"
                              disabled={isDeletingThis}
                              onClick={() => startEdit(p)}
                              className="nb-btn nb-btn-secondary flex-1 px-2.5 text-xs"
                            >
                              <Pencil className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                              <span>Edit</span>
                            </button>
                            <button
                              type="button"
                              disabled={isDeletingThis}
                              onClick={() => startClone(p)}
                              className="nb-btn nb-btn-secondary px-2.5 text-xs"
                            >
                              <Copy className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                              <span>Clone</span>
                            </button>
                            {confirmDeleteId === p.id ? (
                              <div className="flex w-full gap-1.5 pt-1">
                                <button
                                  type="button"
                                  disabled={isDeletingThis}
                                  onClick={() => void handleDelete(p.id)}
                                  className="nb-btn nb-btn-danger flex-1 px-2.5 text-xs"
                                >
                                  {isDeletingThis ? 'Deleting...' : 'Confirm Delete'}
                                </button>
                                <button
                                  type="button"
                                  disabled={isDeletingThis}
                                  onClick={() => setConfirmDeleteId(null)}
                                  className="nb-btn nb-btn-secondary px-2.5 text-xs"
                                >
                                  Cancel
                                </button>
                              </div>
                            ) : (
                              <button
                                type="button"
                                disabled={isDeletingThis}
                                onClick={() => setConfirmDeleteId(p.id)}
                                aria-label={`Delete ${p.name}`}
                                className="nb-btn nb-btn-danger px-2.5 text-xs"
                              >
                                <Trash2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                              </button>
                            )}
                          </>
                        )}
                      </div>
                    </article>
                  );
                })
              )}
            </div>
          </section>

          {/* Editor Pane */}
          <section aria-label="Custom preset editor" className="flex flex-col bg-[var(--bg-surface)] lg:min-h-0">
            <div className="flex shrink-0 items-center justify-between gap-2 border-b-2 border-[var(--border)] bg-[var(--bg-subtle)] px-4 py-2.5">
              <h3 className="truncate text-sm font-extrabold text-[var(--ink)]">
                {editingId ? `Editing: ${form.name || editingId}` : 'Create Custom Preset'}
              </h3>
              <button type="button" onClick={startNewBlank} disabled={saving} className="nb-btn nb-btn-secondary px-2.5 text-xs">
                <Plus className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <span>New Blank</span>
              </button>
            </div>

            <form onSubmit={handleSubmit} className="flex flex-col lg:min-h-0 lg:flex-1">
              <div className="space-y-3 p-4 text-sm lg:min-h-0 lg:flex-1 lg:overflow-y-auto">
                {formError && (
                  <div
                    role="alert"
                    className="border-2 border-[var(--border)] bg-[var(--status-err-bg)] p-2.5 text-xs font-semibold text-[var(--status-err-ink)]"
                  >
                    {formError}
                  </div>
                )}

                {formNotice && (
                  <div className="border-2 border-[var(--border)] bg-[var(--status-ok-bg)] p-2.5 text-xs font-semibold text-[var(--status-ok-ink)]">
                    {formNotice}
                  </div>
                )}

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div>
                    <label htmlFor="preset-name" className={fieldLabelClass}>
                      Preset Name *
                    </label>
                    <input
                      id="preset-name"
                      required
                      value={form.name}
                      onChange={(e) => setField('name', e.target.value)}
                      placeholder="Samsung Galaxy S26 Ultra Custom"
                      className="nb-input"
                    />
                  </div>
                  <div>
                    <label htmlFor="preset-id" className={fieldLabelClass}>
                      Custom ID {editingId ? '(locked)' : '(optional, auto-generated)'}
                    </label>
                    <input
                      id="preset-id"
                      value={form.id}
                      disabled={Boolean(editingId)}
                      onChange={(e) => setField('id', e.target.value)}
                      placeholder="custom-s26-ultra"
                      className="nb-input num disabled:opacity-60"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                  <div>
                    <label htmlFor="preset-brand" className={fieldLabelClass}>
                      Brand *
                    </label>
                    <input
                      id="preset-brand"
                      required
                      value={form.brand}
                      onChange={(e) => setField('brand', e.target.value)}
                      placeholder="samsung"
                      className="nb-input"
                    />
                  </div>
                  <div>
                    <label htmlFor="preset-manufacturer" className={fieldLabelClass}>
                      Manufacturer *
                    </label>
                    <input
                      id="preset-manufacturer"
                      required
                      value={form.manufacturer}
                      onChange={(e) => setField('manufacturer', e.target.value)}
                      placeholder="samsung"
                      className="nb-input"
                    />
                  </div>
                  <div>
                    <label htmlFor="preset-model" className={fieldLabelClass}>
                      Model *
                    </label>
                    <input
                      id="preset-model"
                      required
                      value={form.model}
                      onChange={(e) => setField('model', e.target.value)}
                      placeholder="SM-S948B"
                      className="nb-input"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
                  <div>
                    <label htmlFor="preset-device" className={fieldLabelClass}>
                      Device *
                    </label>
                    <input
                      id="preset-device"
                      required
                      value={form.device}
                      onChange={(e) => setField('device', e.target.value)}
                      placeholder="m3q"
                      className="nb-input"
                    />
                  </div>
                  <div>
                    <label htmlFor="preset-product" className={fieldLabelClass}>
                      Product *
                    </label>
                    <input
                      id="preset-product"
                      required
                      value={form.product}
                      onChange={(e) => setField('product', e.target.value)}
                      placeholder="m3qxxx"
                      className="nb-input"
                    />
                  </div>
                  <div>
                    <label htmlFor="preset-hardware" className={fieldLabelClass}>
                      Hardware *
                    </label>
                    <input
                      id="preset-hardware"
                      required
                      value={form.hardware}
                      onChange={(e) => setField('hardware', e.target.value)}
                      placeholder="qcom"
                      className="nb-input"
                    />
                  </div>
                  <div>
                    <label htmlFor="preset-board" className={fieldLabelClass}>
                      Board *
                    </label>
                    <input
                      id="preset-board"
                      required
                      value={form.board}
                      onChange={(e) => setField('board', e.target.value)}
                      placeholder="canoe"
                      className="nb-input"
                    />
                  </div>
                  <div className="col-span-2 sm:col-span-1">
                    <label htmlFor="preset-platform" className={fieldLabelClass}>
                      Platform *
                    </label>
                    <input
                      id="preset-platform"
                      required
                      value={form.platform}
                      onChange={(e) => setField('platform', e.target.value)}
                      placeholder="canoe"
                      className="nb-input"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
                  <div>
                    <label htmlFor="preset-build-type" className={fieldLabelClass}>
                      Build Type
                    </label>
                    <select
                      id="preset-build-type"
                      value={form.buildType}
                      onChange={(e) => setField('buildType', e.target.value as 'user' | 'userdebug')}
                      className="nb-input"
                    >
                      <option value="user">user</option>
                      <option value="userdebug">userdebug</option>
                    </select>
                  </div>
                  <div>
                    <label htmlFor="preset-build-tags" className={fieldLabelClass}>
                      Build Tags
                    </label>
                    <input
                      id="preset-build-tags"
                      value={form.buildTags}
                      onChange={(e) => setField('buildTags', e.target.value)}
                      className="nb-input"
                    />
                  </div>
                  <div>
                    <label htmlFor="preset-build-id" className={fieldLabelClass}>
                      Build ID
                    </label>
                    <input
                      id="preset-build-id"
                      value={form.buildId}
                      onChange={(e) => setField('buildId', e.target.value)}
                      className="nb-input num text-[13px]"
                    />
                  </div>
                  <div>
                    <label htmlFor="preset-patch" className={fieldLabelClass}>
                      Security Patch
                    </label>
                    <input
                      id="preset-patch"
                      value={form.securityPatch}
                      onChange={(e) => setField('securityPatch', e.target.value)}
                      placeholder="2025-03-01"
                      className="nb-input num text-[13px]"
                    />
                  </div>
                </div>

                <div>
                  <label htmlFor="preset-fingerprint" className={fieldLabelClass}>
                    Build Fingerprint *
                  </label>
                  <input
                    id="preset-fingerprint"
                    required
                    value={form.buildFingerprint}
                    onChange={(e) => setField('buildFingerprint', e.target.value)}
                    placeholder="google/blazer/blazer:16/BD3A.250721.001/13824610:user/release-keys"
                    className="nb-input num text-[13px]"
                  />
                </div>

                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  <div>
                    <label htmlFor="preset-width" className={fieldLabelClass}>
                      Width (320-2160)
                    </label>
                    <input
                      id="preset-width"
                      type="number"
                      min={320}
                      max={2160}
                      required
                      value={form.width}
                      onChange={(e) => setField('width', e.target.value)}
                      className="nb-input num"
                    />
                  </div>
                  <div>
                    <label htmlFor="preset-height" className={fieldLabelClass}>
                      Height (480-3840)
                    </label>
                    <input
                      id="preset-height"
                      type="number"
                      min={480}
                      max={3840}
                      required
                      value={form.height}
                      onChange={(e) => setField('height', e.target.value)}
                      className="nb-input num"
                    />
                  </div>
                  <div>
                    <label htmlFor="preset-dpi" className={fieldLabelClass}>
                      DPI (120-640)
                    </label>
                    <input
                      id="preset-dpi"
                      type="number"
                      min={120}
                      max={640}
                      required
                      value={form.dpi}
                      onChange={(e) => setField('dpi', e.target.value)}
                      className="nb-input num"
                    />
                  </div>
                  <div>
                    <label htmlFor="preset-mac-oui" className={fieldLabelClass}>
                      MAC OUI
                    </label>
                    <input
                      id="preset-mac-oui"
                      required
                      value={form.macOui}
                      onChange={(e) => setField('macOui', e.target.value)}
                      placeholder="3C:28:6D"
                      className="nb-input num text-[13px]"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
                  <div>
                    <label htmlFor="preset-locale" className={fieldLabelClass}>
                      Locale
                    </label>
                    <input
                      id="preset-locale"
                      value={form.locale}
                      onChange={(e) => setField('locale', e.target.value)}
                      className="nb-input"
                    />
                  </div>
                  <div>
                    <label htmlFor="preset-timezone" className={fieldLabelClass}>
                      Timezone
                    </label>
                    <input
                      id="preset-timezone"
                      value={form.timezone}
                      onChange={(e) => setField('timezone', e.target.value)}
                      className="nb-input"
                    />
                  </div>
                  <div>
                    <label htmlFor="preset-carrier" className={fieldLabelClass}>
                      Carrier Name
                    </label>
                    <input
                      id="preset-carrier"
                      value={form.carrierName}
                      onChange={(e) => setField('carrierName', e.target.value)}
                      className="nb-input"
                    />
                  </div>
                  <div>
                    <label htmlFor="preset-mccmnc" className={fieldLabelClass}>
                      MCC/MNC
                    </label>
                    <input
                      id="preset-mccmnc"
                      value={form.carrierMccMnc}
                      onChange={(e) => setField('carrierMccMnc', e.target.value)}
                      className="nb-input num"
                    />
                  </div>
                  <div className="col-span-2 sm:col-span-1">
                    <label htmlFor="preset-country" className={fieldLabelClass}>
                      Country ISO
                    </label>
                    <input
                      id="preset-country"
                      maxLength={2}
                      value={form.countryIso}
                      onChange={(e) => setField('countryIso', e.target.value)}
                      className="nb-input"
                    />
                  </div>
                </div>
              </div>

              <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t-2 border-[var(--border)] bg-[var(--bg-subtle)] px-4 py-3">
                <button type="button" onClick={onClose} disabled={saving} className="nb-btn nb-btn-secondary">
                  Close
                </button>
                <button type="submit" disabled={saving} className="nb-btn nb-btn-primary">
                  {saving ? 'Saving...' : editingId ? 'Save Changes' : 'Save Custom Preset'}
                </button>
              </div>
            </form>
          </section>
        </div>
      </div>
    </div>
  );
};
