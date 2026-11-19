import React, { useEffect, useState } from 'react';
import { Eye, EyeOff, KeyRound, X } from 'lucide-react';
import { getApiKey, setApiKey } from '../api/client';

interface Props {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}

export const ApiKeyModal: React.FC<Props> = ({ open, onClose, onSaved }) => {
  const [value, setValue] = useState('');
  const [showKey, setShowKey] = useState(false);

  useEffect(() => {
    if (!open) return;
    setValue(getApiKey());
    setShowKey(false);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setApiKey(value.trim());
    onSaved();
    onClose();
  }

  function handleClear() {
    setApiKey('');
    setValue('');
    onSaved();
    onClose();
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="api-key-modal-title"
        className="nb-panel-elevated w-full max-w-md"
      >
        <div className="flex items-center justify-between border-b-2 border-[var(--border)] bg-[var(--bg-subtle)] px-4 py-3">
          <div className="flex items-center gap-2">
            <KeyRound className="h-4 w-4 text-[var(--ink)]" aria-hidden="true" />
            <h2 id="api-key-modal-title" className="text-base font-extrabold text-[var(--ink)]">
              API Key Authentication
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close API Key dialog"
            className="nb-btn nb-btn-secondary px-2.5"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <form onSubmit={handleSave} className="space-y-4 p-4">
          <p className="text-[13px] leading-relaxed text-[var(--ink-secondary)]">
            Set the <code>X-API-Key</code> header sent to REST and WebSocket endpoints when{' '}
            <code>REQUIRE_AUTH=true</code> is enabled on the server. Stored in browser localStorage.
          </p>

          <div>
            <label htmlFor="droidforge-api-key-input" className="mb-1.5 block text-[13px] font-bold text-[var(--ink)]">
              API Key
            </label>
            <div className="flex gap-2">
              <input
                id="droidforge-api-key-input"
                type={showKey ? 'text' : 'password'}
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder="Enter server API_KEY or leave blank"
                className="nb-input flex-1"
                autoComplete="off"
              />
              <button
                type="button"
                onClick={() => setShowKey((v) => !v)}
                aria-label={showKey ? 'Hide API key' : 'Show API key'}
                className="nb-btn nb-btn-secondary shrink-0 px-3"
              >
                {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 border-t-2 border-[var(--border-subtle)] pt-3">
            <button type="button" onClick={handleClear} className="nb-btn nb-btn-danger">
              Clear Key
            </button>
            <div className="flex items-center gap-2">
              <button type="button" onClick={onClose} className="nb-btn nb-btn-secondary">
                Cancel
              </button>
              <button type="submit" className="nb-btn nb-btn-primary">
                Save Key
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
};
