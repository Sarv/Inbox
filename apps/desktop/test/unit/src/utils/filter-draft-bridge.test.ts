import { describe, it, expect, beforeEach } from 'vitest';

import type { PendingFilterDraft } from '../../../../src/utils/filter-draft-bridge';
import { consumePendingFilterDraft, setPendingFilterDraft } from '../../../../src/utils/filter-draft-bridge';

const draft = (name: string): PendingFilterDraft => ({
  name,
  matchType: 'all',
  conditions: [{ field: 'from', operator: 'contains', value: 'billing@' } as PendingFilterDraft['conditions'][number]],
});

// A module-level singleton (deliberately not a CustomEvent) so the Advanced
// Search panel can stash a draft and navigate to Settings → Filters without a
// mount-timing race. The consume-once contract is what keeps a stale draft from
// re-populating the form the next time the tab mounts.
describe('filter-draft-bridge', () => {
  beforeEach(() => {
    consumePendingFilterDraft(); // reset the module singleton between tests
  });

  it('returns null when nothing has been stashed', () => {
    expect(consumePendingFilterDraft()).toBeNull();
  });

  it('hands back the stashed draft on the first consume', () => {
    const d = draft('Billing');
    setPendingFilterDraft(d);
    expect(consumePendingFilterDraft()).toBe(d); // same object — conditions are passed by reference
  });

  it('CLEARS the draft after one consume (a second mount must not re-prefill)', () => {
    setPendingFilterDraft(draft('Billing'));
    consumePendingFilterDraft();
    expect(consumePendingFilterDraft()).toBeNull();
  });

  it('lets the newest stash win when set twice before a consume', () => {
    setPendingFilterDraft(draft('first'));
    setPendingFilterDraft(draft('second'));
    expect(consumePendingFilterDraft()?.name).toBe('second');
    expect(consumePendingFilterDraft()).toBeNull();
  });

  it('preserves matchType and conditions verbatim', () => {
    const d: PendingFilterDraft = { ...draft('Any-match'), matchType: 'any' };
    setPendingFilterDraft(d);
    const got = consumePendingFilterDraft();
    expect(got?.matchType).toBe('any');
    expect(got?.conditions).toHaveLength(1);
  });
});
