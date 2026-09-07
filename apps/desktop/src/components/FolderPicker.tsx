import { Search } from 'lucide-react';
import type { ReactNode } from 'react';
import { useState, useRef, useEffect, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';

import { useEmailStore } from '../store/email-store';

import { Tooltip } from './Tooltip';

const MENU_WIDTH = 264;

interface FolderPickerProps {
  /** Called with the chosen folder id; the popover then closes. */
  onPick: (folderId: string) => void;
  /** Tooltip + aria label, e.g. "Move to folder" / "Copy to folder". */
  title: string;
  /** Trigger icon. */
  icon: ReactNode;
  /** Placeholder in the filter box. */
  placeholder?: string;
  /** Hide this folder from the list (e.g. the current folder — no point moving to self). */
  excludeFolderId?: string | null;
  buttonClassName?: string;
}

/**
 * Icon button + single-select popover of the account's folders — the picker
 * behind the Move / Copy toolbar and bulk-bar actions. Single-select (unlike the
 * multi-select LabelMenu it's modelled on): clicking a folder fires `onPick` and
 * closes. Portal + viewport-clamped fixed positioning so it never opens
 * off-screen near an edge.
 */
export function FolderPicker({ onPick, title, icon, placeholder, excludeFolderId, buttonClassName }: FolderPickerProps) {
  const folders = useEmailStore((s) => s.folders);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close on outside click — button and portal both count as inside.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (btnRef.current?.contains(t) || menuRef.current?.contains(t)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  // Clear the filter whenever the menu closes.
  useEffect(() => { if (!open) setQuery(''); }, [open]);

  const q = query.trim().toLowerCase();
  const rows = (folders as Array<{ id: string; path: string; name: string }>)
    .filter((f) => f.id !== excludeFolderId)
    .filter((f) => (q ? (f.path || f.name || '').toLowerCase().includes(q) : true))
    .slice()
    .sort((a, b) => (a.path || a.name).localeCompare(b.path || b.name));

  // Position the portal below the trigger, clamped/flipped to the viewport.
  useLayoutEffect(() => {
    if (!open || !btnRef.current || !menuRef.current) return;
    const b = btnRef.current.getBoundingClientRect();
    const m = menuRef.current.getBoundingClientRect();
    const pad = 8;
    let left = Math.min(b.right - MENU_WIDTH, window.innerWidth - MENU_WIDTH - pad);
    left = Math.max(pad, left);
    let top = b.bottom + 4;
    if (top + m.height > window.innerHeight - pad) {
      top = Math.max(pad, b.top - m.height - 4);
    }
    setCoords({ top, left });
  }, [open, rows.length, query]);

  const pick = (folderId: string) => { onPick(folderId); setOpen(false); };

  return (
    <div className="inline-flex items-center">
      <Tooltip content={title} delayMs={40}>
        <button
          ref={btnRef}
          onClick={() => setOpen((o) => !o)}
          className={buttonClassName ?? 'p-2 rounded-md hover:bg-muted/50 text-muted-foreground hover:text-foreground transition-colors'}
          aria-label={title}
        >
          {icon}
        </button>
      </Tooltip>

      {open && createPortal(
        <div
          ref={menuRef}
          className="fixed z-[100] rounded-md border border-border bg-background shadow-lg overflow-hidden"
          style={{ top: coords?.top ?? -9999, left: coords?.left ?? -9999, width: MENU_WIDTH }}
        >
          <div className="p-2 border-b border-border">
            <div className="flex items-center gap-2 px-2 py-1.5 rounded bg-muted/50">
              <Search className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Escape') setOpen(false); }}
                placeholder={placeholder ?? 'Filter folders'}
                className="flex-1 min-w-0 bg-transparent text-sm focus:outline-none"
              />
            </div>
          </div>

          <div className="max-h-64 overflow-y-auto p-1">
            {rows.length === 0 ? (
              <div className="px-3 py-2 text-xs text-muted-foreground">
                {folders.length === 0 ? 'No folders.' : 'No matching folders.'}
              </div>
            ) : (
              rows.map((f) => (
                <button
                  key={f.id}
                  onClick={() => pick(f.id)}
                  className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-sm hover:bg-muted/50 text-left"
                  title={f.path}
                >
                  <span className="flex-1 truncate">{f.path || f.name}</span>
                </button>
              ))
            )}
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
