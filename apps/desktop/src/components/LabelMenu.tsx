import type { Label } from '@sarvinbox/core';
import { Tag as TagIcon, Check, Plus, Search } from 'lucide-react';
import { useState, useRef, useEffect, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';

import { useEmailStore } from '../store/email-store';
import { buildLabelTree, flattenLabelTree } from '../utils/label-tree';

import { NewLabelDialog } from './NewLabelDialog';
import { Tooltip } from './Tooltip';

interface LabelMenuProps {
  /** Label names currently applied (checked). */
  applied: Set<string>;
  onToggle: (name: string, on: boolean) => void;
  buttonClassName?: string;
  /** Owning account of the target message. In the unified "All Inboxes" view this
   *  can differ from the active account; the picker then shows THAT account's
   *  labels (labels are per-account). Omit for normal single-account views. */
  accountId?: string;
}

const MENU_WIDTH = 264;

/**
 * Icon button + popover checklist of the user's labels. Reused by the email
 * detail toolbar and the bulk-action bar. Multi-select: clicking a row toggles
 * that label and leaves the popover open so several can be applied in one go.
 * The popover renders in a portal with viewport-clamped fixed positioning so it
 * never opens off-screen when the trigger sits near an edge.
 */
export function LabelMenu({ applied, onToggle, buttonClassName, accountId }: LabelMenuProps) {
  const storeLabels = useEmailStore((s) => s.labels);
  const activeAccountId = useEmailStore((s) => s.activeAccountId);
  // When the target message belongs to a non-active account (unified view), show
  // THAT account's labels — loaded on demand — instead of the active account's.
  const isForeign = !!accountId && accountId !== activeAccountId;
  const [foreignLabels, setForeignLabels] = useState<Label[]>([]);
  const labels = isForeign ? foreignLabels : storeLabels;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(null);
  // Staged selection: checkboxes edit `pending`, and Apply commits the diff
  // against `applied` in one go — so several labels can be (un)checked first.
  const [pending, setPending] = useState<Set<string>>(new Set());
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const openMenu = () => { setPending(new Set(applied)); setOpen(true); };

  const applyChanges = () => {
    const names = new Set<string>([...labels.map((l) => l.name), ...applied, ...pending]);
    names.forEach((name) => {
      const was = applied.has(name);
      const now = pending.has(name);
      if (was !== now) onToggle(name, now);
    });
    setOpen(false);
  };

  const togglePending = (name: string) =>
    setPending((prev) => {
      const next = new Set(prev);
      next.has(name) ? next.delete(name) : next.add(name);
      return next;
    });

  // Close on outside click — the button and the portal menu both count as inside.
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

  // Load the foreign account's labels on demand when the picker opens for a
  // message from a non-active account (unified view).
  const loadForeignLabels = () => {
    if (!isForeign || !accountId) return;
    window.electronAPI.labels.list(accountId).then((res) => {
      if (res?.success && res.data) setForeignLabels(res.data as Label[]);
    }).catch(() => { /* best effort */ });
  };
  useEffect(() => {
    if (open && isForeign) loadForeignLabels();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, isForeign, accountId]);

  // Indented rows (parents before children) so nested labels read as a tree.
  const rows = flattenLabelTree(buildLabelTree(labels));
  const q = query.trim().toLowerCase();
  const filtered = q ? rows.filter(({ node }) => node.path.toLowerCase().includes(q)) : rows;

  // Position the portal menu below the trigger, clamped/flipped to the viewport
  // — fixes the menu opening off-screen when the trigger sits near an edge.
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
  }, [open, filtered.length, query]);

  return (
    // inline-flex (not a plain block div) so the icon lines up with the other
    // Tooltip-wrapped toolbar buttons.
    <div className="inline-flex items-center">
      <Tooltip content="Label" delayMs={40}>
        <button
          ref={btnRef}
          onClick={() => (open ? setOpen(false) : openMenu())}
          className={buttonClassName ?? 'p-2 rounded-md hover:bg-muted/50 text-muted-foreground hover:text-foreground transition-colors'}
          aria-label="Label"
        >
          <TagIcon className="h-4 w-4" />
        </button>
      </Tooltip>

      {open && createPortal(
        <div
          ref={menuRef}
          className="fixed z-[100] rounded-md border border-border bg-background shadow-lg overflow-hidden"
          style={{ top: coords?.top ?? -9999, left: coords?.left ?? -9999, width: MENU_WIDTH }}
        >
          {/* Filter */}
          <div className="p-2 border-b border-border">
            <div className="flex items-center gap-2 px-2 py-1.5 rounded bg-muted/50">
              <Search className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Escape') setOpen(false); }}
                placeholder="Filter labels"
                className="flex-1 min-w-0 bg-transparent text-sm focus:outline-none"
              />
            </div>
          </div>

          {/* Checklist */}
          <div className="max-h-64 overflow-y-auto p-1">
            {filtered.length === 0 ? (
              <div className="px-3 py-2 text-xs text-muted-foreground">
                {labels.length === 0 ? 'No labels yet.' : 'No matching labels.'}
              </div>
            ) : (
              filtered.map(({ node, depth }) => {
                const indent = { paddingLeft: `${depth * 14 + 8}px` };
                // Container segment with no label of its own — a non-applyable header.
                if (!node.label) {
                  return (
                    <div
                      key={node.path}
                      className="flex items-center gap-2 pr-2 py-1 text-xs text-muted-foreground truncate"
                      style={indent}
                    >
                      <TagIcon className="h-3 w-3 shrink-0" />
                      <span className="truncate">{node.name}</span>
                    </div>
                  );
                }
                const on = pending.has(node.label.name);
                return (
                  <button
                    key={node.label.id}
                    onClick={() => togglePending(node.label!.name)}
                    className="w-full flex items-center gap-2 pr-2 py-1.5 rounded text-sm hover:bg-muted/50 text-left"
                    style={indent}
                  >
                    <span className={`h-4 w-4 rounded border flex items-center justify-center shrink-0 ${on ? 'bg-primary border-primary' : 'border-muted-foreground/40'}`}>
                      {on && <Check className="h-3 w-3 text-primary-foreground" />}
                    </span>
                    <span className="h-2.5 w-2.5 rounded-full shrink-0" style={{ backgroundColor: node.label.color }} />
                    <span className="flex-1 truncate">{node.name}</span>
                  </button>
                );
              })
            )}
          </div>

          {/* Create on the go */}
          <button
            onClick={() => setShowCreate(true)}
            className="w-full flex items-center gap-2 px-3 py-2 border-t border-border text-sm text-primary hover:bg-muted/50 text-left"
          >
            <Plus className="h-4 w-4 shrink-0" /> Create new label
          </button>

          {/* Apply the staged selection */}
          <div className="flex items-center justify-end gap-2 px-2 py-2 border-t border-border">
            <button
              onClick={() => setOpen(false)}
              className="px-3 py-1.5 rounded-md text-sm font-medium hover:bg-muted/50 transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={applyChanges}
              className="px-3 py-1.5 rounded-md text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
            >
              Apply
            </button>
          </div>
        </div>,
        document.body
      )}

      {showCreate && (
        <NewLabelDialog
          labels={labels}
          accountId={isForeign ? accountId : undefined}
          onClose={() => setShowCreate(false)}
          onCreated={(name) => { setPending((prev) => new Set(prev).add(name)); if (isForeign) loadForeignLabels(); }}
        />
      )}
    </div>
  );
}
