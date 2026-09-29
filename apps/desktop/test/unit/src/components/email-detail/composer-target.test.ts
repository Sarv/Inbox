import { describe, expect, it } from 'vitest';

import {
  composerDraftFor,
  type ComposerSeed,
} from '../../../../../src/components/email-detail/composer-target';

/**
 * Which composer an inline-composer seed is handed to.
 *
 * What breaks if this file goes red: a draft written for one message opens in
 * the composer for another — the reply goes to the first message's people, and
 * discarding it deletes a different reply's stored draft — or a draft is kept
 * from the very message it was written for, so that reply saves a second draft
 * and leaves the first in Drafts after the send. The chat view's hover icons
 * put any bubble's Reply one click from the one that is open.
 */
describe('composerDraftFor', () => {
  const draft = { to: 'carol@acme.example', draftMessageId: '<d1@acme.example>' };
  const seedForA: ComposerSeed<typeof draft> = { forEmailId: 'a', draft };

  // The seed's own message gets it — the same object, so a composer that
  // compares drafts sees no change on a repeated open.
  it('hands the seed to a composer on the message it was written for', () => {
    expect(composerDraftFor(seedForA, { id: 'a' })).toBe(draft);
  });

  // THE regression: an Undo-send draft for A, then Reply on bubble B, opened
  // B's composer holding A's draft.
  it('hands nothing to a composer on another message', () => {
    expect(composerDraftFor(seedForA, { id: 'b' })).toBeUndefined();
  });

  // Multi-account: one mail delivered to two of the reader's accounts is two
  // rows (All Inboxes folds them behind one). A seed's stored draft lives in
  // ONE account's mailbox, so the other copy's composer must not adopt it —
  // same Message-ID or not, the row is the target.
  it('treats the same mail in two accounts as two targets', () => {
    const inWork = { id: 'row-in-work', messageId: '<m1@acme.example>', accountId: 'work' };
    const inHome = { id: 'row-in-home', messageId: '<m1@acme.example>', accountId: 'home' };
    const seed = { forEmailId: inWork.id, draft };
    expect(composerDraftFor(seed, inHome)).toBeUndefined();
    expect(composerDraftFor(seed, inWork)).toBe(draft);
  });

  // No composer open: nothing to hand anything to.
  it('hands nothing when no composer is open', () => {
    expect(composerDraftFor(seedForA, null)).toBeUndefined();
    expect(composerDraftFor(seedForA, undefined)).toBeUndefined();
  });

  // No seed: the composer opens fresh.
  it('hands nothing when there is no seed', () => {
    expect(composerDraftFor(undefined, { id: 'a' })).toBeUndefined();
  });
});
