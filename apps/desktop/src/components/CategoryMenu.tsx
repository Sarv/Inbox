import { Check, Tags } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { useEmailStore } from '../store/email-store';

import type { CategoryDefinition } from './aibox/types';
import { categorySelectionChanges } from './category-selection';
import { applyEmailCategories } from './email-list/CategoryBadges';
import { Tooltip } from './Tooltip';

interface CategoryMenuProps {
  emailId: string;
  accountId?: string;
  buttonClassName?: string;
  label?: string;
  showIcon?: boolean;
  onOpenChange?: (open: boolean) => void;
}

/** Manual assignment changes only the selected category, including independent Important. */
export function CategoryMenu({ emailId, accountId, buttonClassName, label, showIcon = true, onOpenChange }: CategoryMenuProps) {
  const [open, setOpen] = useState(false);
  const [definitions, setDefinitions] = useState<CategoryDefinition[]>([]);
  const [applied, setApplied] = useState<Set<string>>(new Set());
  const [pending, setPending] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [coords, setCoords] = useState({ top: -9999, left: -9999 });
  const menuRef = useRef<HTMLDivElement>(null);
  const ref = useRef<HTMLDivElement>(null);
  const generation = useRef(0);

  useEffect(() => { onOpenChange?.(open); }, [open, onOpenChange]);

  useEffect(() => {
    generation.current += 1;
    setSaving(false);
    if (!open) return;
    let active = true;
    setLoading(true);
    setLoaded(false);
    setDefinitions([]);
    setApplied(new Set());
    setPending(new Set());
    setError('');
    Promise.all([
      window.electronAPI.ai.getCategoryDefinitions(accountId),
      window.electronAPI.ai.getEmailCategoriesBatch([emailId], accountId),
    ]).then(([defs, categories]) => {
      if (!active) return;
      if (!defs.success || !categories.success) throw new Error(defs.error || categories.error || 'Unable to load categories.');
      const checked = new Set(categories.data?.[emailId] || []);
      setDefinitions((defs.data || []).filter((d) => d.isEnabled || checked.has(d.slug)));
      setApplied(checked);
      setPending(new Set(checked));
      setLoaded(true);
    }).catch((err: unknown) => {
      if (active) setError(err instanceof Error ? err.message : 'Unable to load categories.');
    }).finally(() => { if (active) setLoading(false); });
    const close = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node) && !menuRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => { active = false; document.removeEventListener('mousedown', close); };
  }, [open, emailId, accountId]);

  useLayoutEffect(() => {
    if (!open || !ref.current || !menuRef.current) return;
    const trigger = ref.current.getBoundingClientRect();
    const menu = menuRef.current.getBoundingClientRect();
    setCoords({
      left: Math.max(8, Math.min(trigger.left, window.innerWidth - 264)),
      top: trigger.bottom + menu.height + 4 <= window.innerHeight - 8
        ? trigger.bottom + 4 : Math.max(8, trigger.top - menu.height - 4),
    });
  }, [open, loading, error, definitions.length]);

  const save = async () => {
    const started = generation.current;
    setSaving(true);
    setError('');
    let current = new Set(applied);
    try {
      for (const { slug, on } of categorySelectionChanges(applied, pending)) {
        const result = await window.electronAPI.ai.setEmailCategory(emailId, slug, on, accountId);
        if (!result.success) throw new Error(result.error || 'Unable to change category.');
        current = new Set(result.data ?? (on ? [...current, slug] : [...current].filter((s) => s !== slug)));
        if (generation.current === started) {
          setApplied(new Set(current));
          applyEmailCategories(emailId, [...current]);
        }
      }
      void useEmailStore.getState().refreshCategoryCounts();
      if (generation.current === started) setOpen(false);
    } catch (err) {
      if (generation.current === started) setError(err instanceof Error ? err.message : 'Unable to change category.');
    } finally { if (generation.current === started) setSaving(false); }
  };

  const rows = [...definitions.map((d) => ({ slug: d.slug, name: d.name })),
    ...[...applied].filter((slug) => !definitions.some((d) => d.slug === slug)).map((slug) => ({ slug, name: slug }))];
  return (
    <div ref={ref} onClick={(event) => event.stopPropagation()} className="relative inline-flex items-center" onKeyDown={(event) => { if (event.key === 'Escape' && !saving) setOpen(false); }}>
      <Tooltip content="Categories" delayMs={40}>
        <button aria-label="Categories" aria-expanded={open} onClick={() => setOpen(!open)} disabled={saving}
          className={buttonClassName ?? 'p-2 rounded-md hover:bg-muted/50 text-muted-foreground hover:text-foreground'}>
          {showIcon && <Tags className="h-4 w-4 scale-125" strokeWidth={1.6} />}{label && <span>{label}</span>}
        </button>
      </Tooltip>
      {open && createPortal(<div ref={menuRef} style={coords} onClick={(event) => event.stopPropagation()} onKeyDown={(event) => { if (event.key === 'Escape' && !saving) setOpen(false); }} className="fixed z-[100] w-64 rounded-md border border-border bg-background shadow-lg p-2" role="dialog" aria-label="Assign categories">
        <p className="px-2 py-1 text-xs text-muted-foreground">Select categories. Important is independent.</p>
        {loading ? <p role="status" className="p-2 text-sm">Loading categories…</p> : <div className="max-h-64 overflow-y-auto">
          {rows.map(({ slug, name }) => <button key={slug} type="button" role="checkbox" aria-checked={pending.has(slug)} disabled={saving}
            className="w-full flex items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-muted/50"
            onClick={() => setPending((previous) => { const next = new Set(previous); next.has(slug) ? next.delete(slug) : next.add(slug); return next; })}>
            <span className="h-4 w-4 rounded border border-muted-foreground/40 flex items-center justify-center">{pending.has(slug) && <Check className="h-3 w-3" />}</span>
            <span>{name}</span>
          </button>)}
          {!rows.length && !error && <p className="p-2 text-sm text-muted-foreground">No categories available.</p>}
        </div>}
        {error && <p role="alert" className="p-2 text-sm text-destructive">{error}</p>}
        <div className="flex justify-end gap-2 border-t border-border pt-2 mt-2">
          <button disabled={saving} onClick={() => setOpen(false)} className="px-3 py-1 rounded hover:bg-muted/50">Cancel</button>
          <button disabled={!loaded || loading || saving || (!rows.length)} onClick={save} className="px-3 py-1 rounded bg-primary text-primary-foreground disabled:opacity-50">{saving ? 'Applying…' : 'Apply'}</button>
        </div>
      </div>, document.body)}
    </div>
  );
}
