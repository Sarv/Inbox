import { Plus, X } from 'lucide-react';
import { useState } from 'react';

import { addAlias, aliasesOf } from '../../store/identities';
import { Tooltip } from '../Tooltip';

interface AliasEditorProps {
  /** The account's own (primary) address — always shown, never editable. */
  accountEmail: string;
  /** The account's stored identities (own address + aliases); aliases derived. */
  identities?: string[];
  /** Persist the new alias list (extra addresses only; the store re-normalises). */
  onChange: (aliases: string[]) => void;
}

/**
 * Manage an account's send-as aliases: the primary address is pinned and shown
 * first, extra aliases are listed with a remove control, and a validated input
 * adds new ones. All validation lives in the pure `addAlias` helper so this stays
 * a thin form.
 */
export function AliasEditor({ accountEmail, identities, onChange }: AliasEditorProps) {
  const aliases = aliasesOf(accountEmail, identities);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);

  const commitAdd = () => {
    const result = addAlias(accountEmail, aliases, draft);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setError(null);
    setDraft('');
    onChange(result.aliases);
  };

  const removeAlias = (alias: string) => {
    onChange(aliases.filter((existing) => existing !== alias));
  };

  return (
    <div className="space-y-3">
      <div>
        <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">Send-as addresses</h3>
        <p className="text-xs text-muted-foreground mt-1">
          Extra addresses you can send as from this account. The recipient sees the chosen address; delivery still uses this account.
        </p>
      </div>

      <ul className="space-y-1.5">
        {/* Primary — always present, cannot be removed. */}
        <li className="flex items-center justify-between gap-2 rounded-md border border-border bg-muted/30 px-3 py-2 text-sm">
          <span className="truncate">{accountEmail}</span>
          <span className="text-xs text-muted-foreground shrink-0">Primary</span>
        </li>
        {aliases.map((alias) => (
          <li key={alias} className="flex items-center justify-between gap-2 rounded-md border border-border px-3 py-2 text-sm">
            <span className="truncate">{alias}</span>
            <Tooltip content="Remove alias" delayMs={40}>
              <button
                type="button"
                aria-label={`Remove alias ${alias}`}
                onClick={() => removeAlias(alias)}
                className="p-1 rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10 shrink-0"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </Tooltip>
          </li>
        ))}
      </ul>

      <div className="flex items-start gap-2">
        <div className="flex-1">
          <input
            type="email"
            value={draft}
            onChange={(e) => { setDraft(e.target.value); if (error) setError(null); }}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commitAdd(); } }}
            placeholder="alias@example.com"
            aria-label="New send-as address"
            aria-invalid={!!error}
            className="w-full px-3 py-2 bg-background border border-input rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          />
          {error && <p className="text-xs text-destructive mt-1">{error}</p>}
        </div>
        <Tooltip content="Add alias" delayMs={40}>
          <button
            type="button"
            aria-label="Add alias"
            onClick={commitAdd}
            className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium bg-primary text-primary-foreground rounded-md hover:bg-primary/90 transition-colors shrink-0"
          >
            <Plus className="h-4 w-4" /> Add
          </button>
        </Tooltip>
      </div>
    </div>
  );
}
