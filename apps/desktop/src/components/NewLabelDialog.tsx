import type { Label } from '@sarvinbox/core';
import { useEffect, useState } from 'react';

import { LABEL_COLORS } from '../config/label-colors';
import { useEmailStore } from '../store/email-store';

import { LabelColorPicker } from './LabelColorPicker';

interface NewLabelDialogProps {
  /** Existing labels — used to populate the "Nest under" parent select. */
  labels: Label[];
  /** Preselected parent path when opened from a nested context. */
  defaultParent?: string;
  /** Create the label in this account's DB (unified view — labels are
   *  per-account). Omit to create in the active account. */
  accountId?: string;
  onClose: () => void;
  /** Called with the created label's full slash-path after a successful create. */
  onCreated?: (name: string) => void;
}

/**
 * Gmail-style "New label" modal: color dropdown + name + optional "Nest under"
 * parent. Reusable wherever a label can be created (currently the apply-label
 * menu). Creates via the labels API, refreshes the shared store, then reports
 * the new full name so the caller can apply it.
 */
export function NewLabelDialog({ labels, defaultParent = '', accountId, onClose, onCreated }: NewLabelDialogProps) {
  const loadLabels = useEmailStore((s) => s.loadLabels);
  const [name, setName] = useState('');
  const [color, setColor] = useState(LABEL_COLORS[0]);
  const [nest, setNest] = useState(!!defaultParent);
  const [parent, setParent] = useState(defaultParent);
  const [syncToServer, setSyncToServer] = useState(false); // opt-in; default local-only
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const canCreate = !!name.trim() && !(nest && !parent) && !busy;

  const create = async () => {
    const leaf = name.trim();
    if (!leaf || (nest && !parent) || busy) return;
    // Nesting is slash-delimited (Gmail-style): "Parent/Child".
    const fullName = nest && parent ? `${parent}/${leaf}` : leaf;
    setBusy(true);
    setError(null);
    try {
      const res = await window.electronAPI.labels.create({ name: fullName, color, syncToServer }, accountId);
      if (res.success) {
        // Only refresh the shared (active-account) store when creating for the
        // active account; foreign-account creates are refreshed by the caller.
        if (!accountId) await loadLabels();
        onCreated?.(fullName);
        onClose();
      } else {
        setError(res.error || 'Could not create label');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="w-full max-w-sm rounded-lg border border-border bg-background p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-base font-semibold mb-3">New label</h3>

        <label className="block text-sm text-muted-foreground mb-1.5">Please enter a new label name:</label>
        <div className="flex items-center gap-2">
          {/* Color picker shown before the name; previews the label's initial */}
          <LabelColorPicker value={color} onChange={setColor} initial={name.trim().charAt(0).toUpperCase()} />
          <input
            autoFocus
            type="text"
            value={name}
            onChange={(e) => { setName(e.target.value); setError(null); }}
            onKeyDown={(e) => { if (e.key === 'Enter' && canCreate) create(); }}
            placeholder="Label name"
            className="flex-1 min-w-0 px-3 py-2 border border-border rounded-md bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
          />
        </div>

        {labels.length > 0 && (
          <div className="mt-4">
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={nest} onChange={(e) => setNest(e.target.checked)} />
              Nest label under:
            </label>
            <select
              value={parent}
              onChange={(e) => setParent(e.target.value)}
              disabled={!nest}
              className="mt-2 w-full px-2 py-2 border border-border rounded-md bg-background text-sm disabled:opacity-50"
            >
              <option value="">(choose parent)</option>
              {labels.map((l) => (
                <option key={l.id} value={l.name}>{l.name}</option>
              ))}
            </select>
          </div>
        )}

        <div className="mt-4">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={syncToServer} onChange={(e) => setSyncToServer(e.target.checked)} />
            Show in webmail
          </label>
          <p className="mt-1 text-xs text-muted-foreground">
            Also create this label on the mail server, so it appears in your provider's webmail — not just here.
          </p>
        </div>

        {error && <p className="text-xs text-destructive mt-2">{error}</p>}

        <div className="mt-5 flex justify-end gap-2">
          <button
            onClick={onClose}
            className="px-3 py-1.5 rounded-md text-sm font-medium text-primary hover:bg-muted/50 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={create}
            disabled={!canCreate}
            className="px-4 py-1.5 rounded-md text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-colors"
          >
            Create
          </button>
        </div>
      </div>
    </div>
  );
}
