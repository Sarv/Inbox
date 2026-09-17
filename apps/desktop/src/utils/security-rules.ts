// Renderer-side cache of the user's link trust/block rules.
//
// The security level is computed synchronously while a message renders (see
// email-security.ts), so the rules it consults must already be in memory —
// the same reason image_allowed_senders is cached in helpers.ts. Loaded once
// per session, written through on every change, and re-fetched on account
// switch by whoever owns that lifecycle calling {@link reloadLinkRules}.

import { useEffect, useState } from 'react';

import { EMPTY_RULES, linkRuleKey, type LinkRuleSets } from './email-security';

export interface LinkRule {
  id: number;
  senderDomain: string;
  shownDomain: string;
  actualDomain: string;
  verdict: 'trust' | 'block';
  createdAt: number;
}

let rules: LinkRule[] = [];
let sets: LinkRuleSets = EMPTY_RULES;
let loaded = false;
let inflight: Promise<void> | null = null;
const listeners = new Set<() => void>();

const rebuild = () => {
  const trusted = new Set<string>();
  const blocked = new Set<string>();
  for (const r of rules) {
    (r.verdict === 'trust' ? trusted : blocked).add(linkRuleKey(r.senderDomain, r.shownDomain, r.actualDomain));
  }
  sets = { trusted, blocked };
  listeners.forEach((l) => l());
};

/** The current rule sets — synchronous, possibly empty before the first load. */
export const getLinkRuleSets = (): LinkRuleSets => sets;
export const getLinkRules = (): LinkRule[] => rules;

/** Fetch from the account DB. Coalesces concurrent callers into one request. */
export const reloadLinkRules = (): Promise<void> => {
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const res = await window.electronAPI.security?.listLinkRules?.();
      if (res?.success && Array.isArray(res.data)) rules = res.data as LinkRule[];
    } catch { /* best-effort: keep whatever we had */ }
    loaded = true;
    rebuild();
    inflight = null;
  })();
  return inflight;
};

/** Kick the initial load exactly once; safe to call from any render. */
export const ensureLinkRulesLoaded = (): void => {
  if (!loaded && !inflight) void reloadLinkRules();
};

/**
 * Record a verdict on one (sender, shown → actual) pair and apply it
 * immediately, so the banner the user just clicked disappears on the spot
 * rather than after the round-trip.
 */
export const addLinkRule = async (
  rule: Pick<LinkRule, 'senderDomain' | 'shownDomain' | 'actualDomain' | 'verdict'>,
): Promise<void> => {
  // Optimistic: an id of -1 marks a row the server has not numbered yet.
  rules = [...rules.filter((r) => !sameTuple(r, rule)), { ...rule, id: -1, createdAt: Math.floor(Date.now() / 1000) }];
  rebuild();
  try {
    await window.electronAPI.security?.addLinkRule?.(rule);
  } finally {
    await reloadLinkRules();
  }
};

export const removeLinkRule = async (id: number): Promise<void> => {
  rules = rules.filter((r) => r.id !== id);
  rebuild();
  try {
    await window.electronAPI.security?.removeLinkRule?.(id);
  } finally {
    await reloadLinkRules();
  }
};

const sameTuple = (a: Pick<LinkRule, 'senderDomain' | 'shownDomain' | 'actualDomain'>, b: typeof a) =>
  a.senderDomain.toLowerCase() === b.senderDomain.toLowerCase()
  && a.shownDomain.toLowerCase() === b.shownDomain.toLowerCase()
  && a.actualDomain.toLowerCase() === b.actualDomain.toLowerCase();

/** React binding: re-renders when the rules change. Triggers the initial load. */
export function useLinkRules(): { sets: LinkRuleSets; rules: LinkRule[] } {
  const [, tick] = useState(0);
  useEffect(() => {
    ensureLinkRulesLoaded();
    const l = () => tick((n) => n + 1);
    listeners.add(l);
    return () => { listeners.delete(l); };
  }, []);
  return { sets, rules };
}
