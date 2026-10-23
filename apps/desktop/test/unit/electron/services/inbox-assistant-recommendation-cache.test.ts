import { describe, expect, it } from 'vitest';

import { InboxAssistantRecommendationCache, inboxAssistantRecommendationFingerprint } from '../../../../electron/services/inbox-assistant-recommendation-cache';

const context = { accountId: 'a', accountEmail: 'owner@example.test', providerIdentity: 'provider:model:request-v1', policyVersion: 'triage-v1',
  members: [['one', 'exact-state-hash']] as Array<[string, string]>, content: 'Complete synthetic email content.' };
const decision = { recommendation: 'mark_read', confidence: 0.98, reason: 'Clearly unsolicited newsletter.' };
const key = (id: string) => inboxAssistantRecommendationFingerprint({ ...context, accountId: id });

describe('memory-only bounded Inbox Agent recommendation cache', () => {
  it('binds fingerprints to the exact account, provider, policy, source snapshot and complete input', () => {
    const original = inboxAssistantRecommendationFingerprint(context);
    expect(original).toMatch(/^[a-f0-9]{64}$/);
    expect(original).not.toContain(context.content);
    for (const change of [{ accountId: 'b' }, { accountEmail: 'new@example.test' }, { providerIdentity: 'provider:new-model:request-v1' },
      { policyVersion: 'triage-v2' }, { members: [['one', 'changed-state']] as Array<[string, string]> }, { content: `${context.content} Changed.` }]) {
      expect(inboxAssistantRecommendationFingerprint({ ...context, ...change })).not.toBe(original);
    }
  });

  it('evicts the least recently used entry without extending TTL on reads', () => {
    let now = 0; const cache = new InboxAssistantRecommendationCache({ maxEntries: 2, ttlMs: 100, now: () => now });
    cache.set(key('a'), decision); now = 10; cache.set(key('b'), decision);
    now = 50; expect(cache.get(key('a'))).toEqual(decision);
    cache.set(key('c'), decision);
    expect(cache.get(key('b'))).toBeUndefined();
    now = 100; expect(cache.get(key('a'))).toBeUndefined();
    expect(cache.get(key('c'))).toEqual(decision);
    now = 150; expect(cache.get(key('c'))).toBeUndefined();
  });

  it('returns independent copies and can discard every recommendation', () => {
    const cache = new InboxAssistantRecommendationCache(); const value = { ...decision };
    cache.set(key('a'), value); value.reason = 'Changed outside cache';
    const found = cache.get(key('a'))!; found.reason = 'Changed returned copy';
    expect(cache.get(key('a'))).toEqual(decision);
    cache.clear(); expect(cache.get(key('a'))).toBeUndefined();
  });

  it.each([
    { recommendation: 'needs_review' }, { recommendation: 'mark_unread' }, { confidence: 0.89 }, { confidence: Number.NaN },
    { confidence: 1.1 }, { reason: '' }, { reason: ' '.repeat(5) }, { reason: 'x'.repeat(801) },
  ])('never stores uncertain or invalid recommendations: %j', change => {
    const cache = new InboxAssistantRecommendationCache(); cache.set(key('a'), { ...decision, ...change });
    expect(cache.get(key('a'))).toBeUndefined();
  });

  it('caches high-confidence keep-unread decisions and rejects non-fingerprint keys', () => {
    const cache = new InboxAssistantRecommendationCache();
    cache.set(key('a'), { ...decision, recommendation: 'keep_unread' });
    expect(cache.get(key('a'))?.recommendation).toBe('keep_unread');
    cache.set('raw mail text', decision); expect(cache.get('raw mail text')).toBeUndefined();
  });

  it.each([{ ttlMs: 900_001 }, { ttlMs: 0 }, { maxEntries: 1001 }, { maxEntries: 0 }])('refuses unbounded cache configuration: %j', options => {
    expect(() => new InboxAssistantRecommendationCache(options)).toThrow('Invalid recommendation cache limits');
  });
});
