import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The enabled AI-category slug cache (CategoryBadges), as the synchronous
 * readers see it — the list filters and remote images "From categorized mail".
 *
 * What breaks if this file goes red: an open message's images blink off and
 * back on after every sync that brings mail (the cache used to be BLANKED on
 * each clear, which reads as "nothing is categorized"), or an open message
 * never learns that the slugs it was waiting for have loaded.
 */

type Defs = Array<{ slug: string; isEnabled: boolean }>;
let defs: Defs;
let getCategoryDefinitions: ReturnType<typeof vi.fn>;

/** A fresh copy of the module: its cache is module state. */
const load = async () => {
  vi.resetModules();
  return import('../../../../../src/components/email-list/CategoryBadges');
};
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  defs = [
    { slug: 'work', isEnabled: true },
    { slug: 'finance', isEnabled: true },
    { slug: 'old', isEnabled: false },
  ];
  getCategoryDefinitions = vi.fn(async () => ({ success: true, data: defs.map((d) => ({ ...d })) }));
  (globalThis as any).window = { electronAPI: { ai: { getCategoryDefinitions } } };
});

afterEach(() => {
  delete (globalThis as any).window;
});

describe('category definitions cache', () => {
  // Breaks: the cold-open half of the image bug — slugs that load after a
  // message rendered must tell it, so categorized mail re-decides.
  it('notifies subscribers when the enabled slugs first load', async () => {
    const m = await load();
    const listener = vi.fn();
    m.subscribeCategoryDefs(listener);
    expect(m.getCachedCategorySlugs()).toEqual([]);
    m.warmCategoryDefs();
    await settle();
    expect(m.getCachedCategorySlugs()).toEqual(['work', 'finance']); // disabled ones excluded
    expect(listener).toHaveBeenCalledTimes(1);
    expect(m.getCategoryDefsVersion()).toBe(1);
  });

  // Breaks: every sync that brings new mail blanked the slugs for one round
  // trip — list filters showed the wrong mail and an open message's images
  // flickered. A clear now keeps answering with the previous slugs while it
  // re-reads them.
  it('keeps answering with the previous slugs across a clear, and re-reads them', async () => {
    const m = await load();
    m.warmCategoryDefs();
    await settle();
    const listener = vi.fn();
    m.subscribeCategoryDefs(listener);

    m.clearCategoryBadgeCache();
    expect(m.getCachedCategorySlugs()).toEqual(['work', 'finance']); // stale, not blank — and this read re-asks
    await settle();
    expect(getCategoryDefinitions).toHaveBeenCalledTimes(2);
    expect(listener).not.toHaveBeenCalled(); // nothing changed: no re-render churn
  });

  // Breaks: a category the reader added or disabled never reaches the readers.
  it('notifies when a re-read changes the slugs', async () => {
    const m = await load();
    m.warmCategoryDefs();
    await settle();
    const listener = vi.fn();
    const off = m.subscribeCategoryDefs(listener);

    defs.push({ slug: 'social', isEnabled: true });
    m.clearCategoryBadgeCache();
    m.warmCategoryDefs();
    await settle();
    expect(m.getCachedCategorySlugs()).toEqual(['work', 'finance', 'social']);
    expect(listener).toHaveBeenCalledTimes(1);
    off();
  });

  // Transient failure: a failed read leaves the last good slugs in place and
  // is retried on the next ask — it never reads as "no categories".
  it('keeps the last good slugs when a re-read fails, and retries on the next ask', async () => {
    const m = await load();
    m.warmCategoryDefs();
    await settle();
    getCategoryDefinitions.mockRejectedValueOnce(new Error('ipc gone'));
    m.clearCategoryBadgeCache();
    m.warmCategoryDefs();
    await settle();
    expect(getCategoryDefinitions).toHaveBeenCalledTimes(2);
    // Still the last good answer — and, still stale, this ask re-reads.
    expect(m.getCachedCategorySlugs()).toEqual(['work', 'finance']);
    await settle();
    expect(getCategoryDefinitions).toHaveBeenCalledTimes(3);

    // An unsuccessful (not thrown) answer is a failure too.
    getCategoryDefinitions.mockResolvedValueOnce({ success: false });
    m.clearCategoryBadgeCache();
    m.warmCategoryDefs();
    await settle();
    expect(m.getCachedCategorySlugs()).toEqual(['work', 'finance']);
  });

  // Breaks: an account switch threw out of selectAccount because warming the
  // slugs dereferenced a missing bridge synchronously.
  it('never throws synchronously when the bridge is missing, and retries later', async () => {
    const m = await load();
    (globalThis as any).window = { electronAPI: {} };
    expect(() => m.warmCategoryDefs()).not.toThrow();
    await settle();
    expect(m.getCachedCategorySlugs()).toEqual([]);
    (globalThis as any).window = { electronAPI: { ai: { getCategoryDefinitions } } };
    m.warmCategoryDefs();
    await settle();
    expect(m.getCachedCategorySlugs()).toEqual(['work', 'finance']);
  });
});
