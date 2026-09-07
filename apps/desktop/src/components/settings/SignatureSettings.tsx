import { Plus, Pencil, Trash2 } from 'lucide-react';
import { useState } from 'react';

import { useEmailStore } from '../../store/email-store';
import { accountDisplayLabel } from '../../store/helpers';
import { SignatureEditor } from '../SignatureEditor';
import { Tooltip } from '../Tooltip';

import type { AppSettings, EmailSignature } from './types';

interface SignatureSettingsProps {
  settings: AppSettings;
  updateSetting: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void;
}

const newId = () =>
  (typeof crypto !== 'undefined' && 'randomUUID' in crypto)
    ? crypto.randomUUID()
    : `sig-${Date.now()}-${Math.round(performance.now())}`;

/**
 * Multiple named signatures with a default for new emails and a default for
 * reply/forward (Gmail-style). Each signature is edited in the fidelity editor
 * (SignatureEditor) so pasted table/flex layouts stay intact.
 */
export function SignatureSettings({ settings, updateSetting }: SignatureSettingsProps) {
  const signatures = settings.signatures;
  const [selectedId, setSelectedId] = useState<string>(() => signatures[0]?.id || '');
  const [editingNameId, setEditingNameId] = useState<string | null>(null);
  const [nameDraft, setNameDraft] = useState('');

  const selected = signatures.find((s) => s.id === selectedId) || signatures[0];
  const setSignatures = (next: EmailSignature[]) => updateSetting('signatures', next);

  // Per-account signature overrides (Gmail vs Sarv, etc.). Only meaningful with
  // more than one account.
  const accounts = useEmailStore((s) => s.accounts);
  const accountSignatures = settings.accountSignatures || {};
  const setAccountSig = (accountId: string, context: 'new' | 'reply', sigId: string) => {
    const entry = { ...(accountSignatures[accountId] || {}), [context]: sigId || undefined };
    updateSetting('accountSignatures', { ...accountSignatures, [accountId]: entry });
  };

  const createSignature = () => {
    const id = newId();
    setSignatures([...signatures, { id, name: `Signature ${signatures.length + 1}`, html: '' }]);
    setSelectedId(id);
    // The first signature becomes the default for both contexts.
    if (signatures.length === 0) {
      updateSetting('defaultSignatureNew', id);
      updateSetting('defaultSignatureReply', id);
    }
  };

  const updateHtml = (id: string, html: string) =>
    setSignatures(signatures.map((s) => (s.id === id ? { ...s, html } : s)));

  const commitName = (id: string) => {
    const name = nameDraft.trim();
    setEditingNameId(null);
    if (name) setSignatures(signatures.map((s) => (s.id === id ? { ...s, name } : s)));
  };

  const remove = (id: string) => {
    const next = signatures.filter((s) => s.id !== id);
    setSignatures(next);
    if (settings.defaultSignatureNew === id) updateSetting('defaultSignatureNew', next[0]?.id || '');
    if (settings.defaultSignatureReply === id) updateSetting('defaultSignatureReply', next[0]?.id || '');
    if (selectedId === id) setSelectedId(next[0]?.id || '');
  };

  return (
    <div className="pb-6">
      <h3 className="text-sm font-semibold mb-4 text-muted-foreground uppercase tracking-wider">
        Signature
      </h3>

      <div className="py-3">
        <label className="flex items-center gap-2 cursor-pointer mb-3">
          <input
            type="checkbox"
            checked={settings.signatureEnabled}
            onChange={(e) => updateSetting('signatureEnabled', e.target.checked)}
            className="w-4 h-4 rounded"
          />
          <span className="font-medium">Enable signature</span>
        </label>

        {settings.signatureEnabled && (
          signatures.length === 0 ? (
            <button
              onClick={createSignature}
              className="flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-md text-sm font-medium hover:bg-primary/90"
            >
              <Plus className="h-4 w-4" /> Create signature
            </button>
          ) : (
            <div className="space-y-4">
              <div className="flex gap-4">
                {/* Signature list */}
                <div className="w-56 shrink-0 space-y-1">
                  {signatures.map((s) => (
                    <div
                      key={s.id}
                      onClick={() => setSelectedId(s.id)}
                      className={`group flex items-center gap-1 rounded-md px-2 py-1.5 cursor-pointer ${s.id === selected?.id ? 'bg-accent' : 'hover:bg-accent/50'}`}
                    >
                      {editingNameId === s.id ? (
                        <input
                          autoFocus
                          value={nameDraft}
                          onChange={(e) => setNameDraft(e.target.value)}
                          onKeyDown={(e) => { if (e.key === 'Enter') commitName(s.id); if (e.key === 'Escape') setEditingNameId(null); }}
                          onBlur={() => commitName(s.id)}
                          onClick={(e) => e.stopPropagation()}
                          className="flex-1 min-w-0 px-1 py-0.5 border border-border rounded bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                        />
                      ) : (
                        <span className="flex-1 min-w-0 truncate text-sm">{s.name}</span>
                      )}
                      <Tooltip content="Rename" delayMs={40}>
                        <button
                          onClick={(e) => { e.stopPropagation(); setEditingNameId(s.id); setNameDraft(s.name); }}
                          className="p-1 rounded text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-foreground hover:bg-muted/50"
                          aria-label="Rename signature"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                      </Tooltip>
                      <Tooltip content="Delete" delayMs={40}>
                        <button
                          onClick={(e) => { e.stopPropagation(); remove(s.id); }}
                          className="p-1 rounded text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-destructive hover:bg-destructive/10"
                          aria-label="Delete signature"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </Tooltip>
                    </div>
                  ))}
                  <button
                    onClick={createSignature}
                    className="w-full flex items-center gap-2 px-2 py-1.5 text-sm text-primary hover:bg-accent/50 rounded-md"
                  >
                    <Plus className="h-4 w-4" /> Create new
                  </button>
                </div>

                {/* Editor for the selected signature */}
                <div className="flex-1 min-w-0">
                  {selected ? (
                    <SignatureEditor
                      key={selected.id}
                      value={selected.html}
                      onChange={(html) => updateHtml(selected.id, html)}
                    />
                  ) : (
                    <div className="text-sm text-muted-foreground">Select a signature to edit.</div>
                  )}
                </div>
              </div>

              {/* Per-context defaults */}
              <div className="flex flex-wrap gap-6 border-t border-border pt-4">
                <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  For new emails use
                  <select
                    value={settings.defaultSignatureNew}
                    onChange={(e) => updateSetting('defaultSignatureNew', e.target.value)}
                    className="px-2 py-1.5 bg-background border border-border rounded text-sm normal-case font-normal tracking-normal text-foreground"
                  >
                    <option value="">No signature</option>
                    {signatures.map((s) => (
                      <option key={s.id} value={s.id}>{s.name}</option>
                    ))}
                  </select>
                </label>
                <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  On reply/forward use
                  <select
                    value={settings.defaultSignatureReply}
                    onChange={(e) => updateSetting('defaultSignatureReply', e.target.value)}
                    className="px-2 py-1.5 bg-background border border-border rounded text-sm normal-case font-normal tracking-normal text-foreground"
                  >
                    <option value="">No signature</option>
                    {signatures.map((s) => (
                      <option key={s.id} value={s.id}>{s.name}</option>
                    ))}
                  </select>
                </label>
              </div>

              {/* Per-account overrides — pick a signature per mailbox so a reply
                  from Gmail can differ from one from another account. "Use
                  default" falls back to the global choices above. */}
              {accounts.length > 1 && (
                <div className="border-t border-border pt-4 space-y-3">
                  <div className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Per-account signatures</div>
                  {accounts.map((a) => {
                    const ov = accountSignatures[a.id] || {};
                    return (
                      <div key={a.id} className="flex flex-wrap items-center gap-4">
                        <span className="flex items-center gap-2 w-80 min-w-0" title={accountDisplayLabel(accounts, a.id)}>
                          <span className="h-2.5 w-2.5 rounded-full shrink-0" style={{ backgroundColor: a.color ?? '#2563eb' }} />
                          <span className="text-sm truncate">{accountDisplayLabel(accounts, a.id)}</span>
                        </span>
                        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                          New
                          <select
                            value={ov.new ?? ''}
                            onChange={(e) => setAccountSig(a.id, 'new', e.target.value)}
                            className="px-2 py-1 bg-background border border-border rounded text-sm text-foreground"
                          >
                            <option value="">Use default</option>
                            {signatures.map((s) => (<option key={s.id} value={s.id}>{s.name}</option>))}
                          </select>
                        </label>
                        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                          Reply
                          <select
                            value={ov.reply ?? ''}
                            onChange={(e) => setAccountSig(a.id, 'reply', e.target.value)}
                            className="px-2 py-1 bg-background border border-border rounded text-sm text-foreground"
                          >
                            <option value="">Use default</option>
                            {signatures.map((s) => (<option key={s.id} value={s.id}>{s.name}</option>))}
                          </select>
                        </label>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )
        )}
      </div>
    </div>
  );
}
