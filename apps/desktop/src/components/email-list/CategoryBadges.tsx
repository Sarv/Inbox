import { Tag } from 'lucide-react';
import { memo, useEffect, useMemo, useState, useRef } from 'react';

import { ICON_MAP, COLOR_MAP } from '../aibox/types';
import type { CategoryDefinition } from '../aibox/types';

// Cache category definitions so we don't re-fetch per row
let cachedDefs: CategoryDefinition[] | null = null;
let defsPromise: Promise<CategoryDefinition[]> | null = null;

function loadDefs(): Promise<CategoryDefinition[]> {
  if (cachedDefs) return Promise.resolve(cachedDefs);
  if (defsPromise) return defsPromise;
  defsPromise = window.electronAPI.ai.getCategoryDefinitions().then(result => {
    if (result.success && result.data) {
      cachedDefs = (result.data as CategoryDefinition[]).filter(d => d.isEnabled);
    } else {
      defsPromise = null; // Allow retry on next call
    }
    return cachedDefs || [];
  }).catch(() => {
    defsPromise = null; // Allow retry on next call
    return [];
  });
  return defsPromise;
}

/**
 * Enabled AI-category slugs, synchronously, from the module cache (populated by
 * the badge components on first render). Returns [] until loaded — callers that
 * gate on "is this mail AI-categorized" (e.g. remote-image auto-load) treat an
 * empty set as "unknown → don't auto-load", which is the safe default and
 * self-corrects once the list has rendered once (defs load early).
 */
export function getCachedCategorySlugs(): string[] {
  return cachedDefs ? cachedDefs.map((d) => d.slug) : [];
}

// Kick off a load if nothing has yet, so the slug cache is warm for the gate
// even before any badge renders. Fire-and-forget; safe to call repeatedly.
export function warmCategoryDefs(): void {
  void loadDefs();
}

// Batch category loading — collect email IDs and fetch in one call
const pendingIds = new Set<string>();
let batchTimer: ReturnType<typeof setTimeout> | null = null;
let batchCache: Record<string, string[]> = {};
let batchListeners: (() => void)[] = [];

// Cap the badge cache. It's cleared wholesale on sync/categorization events,
// but between those it accumulates one entry per distinct email scrolled past
// — unbounded over a long session on a large mailbox. Evict oldest (Record
// preserves insertion order) beyond the cap; a re-scrolled row simply
// re-requests. Entries are small string arrays, so the window can be generous.
const MAX_BATCH_CACHE = 2000;

function requestCategories(emailId: string, cb: () => void): string[] | null {
  if (batchCache[emailId] !== undefined) return batchCache[emailId];
  pendingIds.add(emailId);
  batchListeners.push(cb);
  if (!batchTimer) {
    batchTimer = setTimeout(flushBatch, 50);
  }
  return null;
}

async function flushBatch(retryAttempt = 0) {
  batchTimer = null;
  const ids = Array.from(pendingIds);
  const listeners = [...batchListeners];
  pendingIds.clear();
  batchListeners = [];
  if (ids.length === 0) return;
  try {
    const result = await window.electronAPI.ai.getEmailCategoriesBatch(ids);
    if (result.success && result.data) {
      for (const id of ids) {
        batchCache[id] = result.data[id] || [];
      }
      const keys = Object.keys(batchCache);
      if (keys.length > MAX_BATCH_CACHE) {
        for (const stale of keys.slice(0, keys.length - MAX_BATCH_CACHE)) {
          delete batchCache[stale];
        }
      }
      listeners.forEach(cb => cb());
    } else {
      retryBatch(ids, listeners, retryAttempt);
    }
  } catch {
    retryBatch(ids, listeners, retryAttempt);
  }
}

function retryBatch(ids: string[], listeners: (() => void)[], attempt: number) {
  if (attempt < 3) {
    const delay = [500, 1000, 2000][attempt];
    for (const id of ids) pendingIds.add(id);
    batchListeners.push(...listeners);
    batchTimer = setTimeout(() => flushBatch(attempt + 1), delay);
  } else {
    // Give up after max retries — notify with empty so component doesn't hang
    listeners.forEach(cb => cb());
  }
}

// Clear cache when AI processing finishes (to pick up new categories)
export function clearCategoryBadgeCache() {
  batchCache = {};
  cachedDefs = null;
  defsPromise = null;
}

// Live per-email subscribers. CategoryBadges is otherwise non-reactive (it only
// fetches on mount), so when the background pipeline categorizes an email we
// push the fresh categories straight into the cache AND notify any MOUNTED
// badge for that email — so the tag appears instantly, for any account, with no
// refresh or remount.
const badgeSubscribers = new Map<string, Set<(cats: string[]) => void>>();

/** Update an email's categories in-place and re-render its mounted badge. */
export function applyEmailCategories(emailId: string, categories: string[]): void {
  if (!emailId) return;
  batchCache[emailId] = Array.isArray(categories) ? categories : [];
  const subs = badgeSubscribers.get(emailId);
  if (subs) subs.forEach(cb => { try { cb(batchCache[emailId]); } catch { /* ignore */ } });
}

interface CategoryBadgesProps {
  emailId: string;
  compact?: boolean;
}

export const CategoryBadges = memo(function CategoryBadges({ emailId, compact = false }: CategoryBadgesProps) {
  const [categories, setCategories] = useState<string[] | null>(null);
  const [defs, setDefs] = useState<CategoryDefinition[]>(cachedDefs || []);
  const mountedRef = useRef(true);

  // Precompute a slug -> definition lookup once per defs change instead of
  // scanning the whole defs array for every badge on every render.
  const defBySlug = useMemo(() => new Map(defs.map(d => [d.slug, d])), [defs]);

  useEffect(() => {
    mountedRef.current = true;
    loadDefs().then(d => { if (mountedRef.current) setDefs(d); });

    const cached = requestCategories(emailId, () => {
      if (mountedRef.current) {
        setCategories(batchCache[emailId] || []);
      }
    });
    if (cached !== null) setCategories(cached);

    // Subscribe so a live categorization event updates this badge in place.
    let subs = badgeSubscribers.get(emailId);
    if (!subs) { subs = new Set(); badgeSubscribers.set(emailId, subs); }
    const onLiveUpdate = (cats: string[]) => { if (mountedRef.current) setCategories(cats); };
    subs.add(onLiveUpdate);

    return () => {
      mountedRef.current = false;
      const s = badgeSubscribers.get(emailId);
      if (s) { s.delete(onLiveUpdate); if (s.size === 0) badgeSubscribers.delete(emailId); }
    };
  }, [emailId]);

  if (!categories || categories.length === 0) return null;

  return (
    <span className="flex items-center gap-0.5 flex-shrink-0">
      {categories.map(slug => {
        const def = defBySlug.get(slug);
        const Icon = def ? (ICON_MAP[def.icon] || Tag) : Tag;
        const colorSet = def ? (COLOR_MAP[def.color] || COLOR_MAP.blue) : COLOR_MAP.blue;
        return (
          <span
            key={slug}
            className={`inline-flex items-center gap-0.5 ${compact ? 'p-0.5' : 'px-1.5 py-0.5'} rounded text-[10px] font-medium border ${colorSet.bg} ${colorSet.border} ${colorSet.text}`}
            title={def?.name || slug}
          >
            <Icon className="h-2.5 w-2.5" />
            {!compact && <span className="leading-none">{def?.name || slug}</span>}
          </span>
        );
      })}
    </span>
  );
});
