// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';

import {
  pendingSendThreadKeys,
  shouldSuppressDraftAutoOpen,
  threadKeysOf,
} from '../../../../../src/components/email-detail/utils';

const row = (id: string, threadId?: string | null) => ({ id, threadId: threadId ?? null });

describe('threadKeysOf', () => {
  // Breaks: the auto-open suppression is checked against one key while
  // handleCloseInlineReply recorded another, so a just-sent draft re-opens in
  // the composer underneath the mail the user has already sent.
  it('collects the thread of the newest row, the selected row and the conversation', () => {
    const keys = threadKeysOf([row('a-1', 't-new'), row('b-2', 't-sel'), row('c-3', 't-conv')]);

    expect(keys).toEqual(expect.arrayContaining(['t-new', 't-sel', 't-conv']));
  });

  // Breaks: the same thread id is compared repeatedly on every render of a long
  // conversation — pure waste on a hot path.
  it('deduplicates repeated thread ids', () => {
    const keys = threadKeysOf([row('a-1', 't-1'), row('a-1', 't-1'), row('b-2', 't-1'), row('c-3', 't-1')]);

    expect(keys).toEqual(['t-1']);
  });

  // Breaks: an optimistic sent row is inserted before it has been threaded, so
  // it carries no threadId; skipping it drops the very row whose arrival
  // re-triggers the auto-open effect.
  it('falls back to the row id when a row has no thread of its own', () => {
    expect(threadKeysOf([row('a-1', null)])).toEqual(['a-1']);
    expect(threadKeysOf([row('a-1', '')])).toEqual(['a-1']);
  });

  // Breaks: the first render — before a thread has loaded — throws inside the
  // effect and the reading pane never mounts.
  it('tolerates null and undefined inputs', () => {
    expect(threadKeysOf(null)).toEqual([]);
    expect(threadKeysOf(undefined)).toEqual([]);
    expect(threadKeysOf([null, undefined])).toEqual([]);
  });

  // Breaks: a row with neither id nor thread contributes an empty-string key,
  // which then matches any other empty key and suppresses a legitimate draft.
  it('never emits an empty key', () => {
    expect(threadKeysOf([{}, {}])).toEqual([]);
  });
});

describe('pendingSendThreadKeys', () => {
  // Breaks: the send's thread isn't recognised, so the draft the outbox is
  // about to delete re-opens during the undo window — the original bug.
  it('reads the thread from the draft cleanup record', () => {
    expect(pendingSendThreadKeys({ draftCleanup: { threadId: 't-1' } })).toEqual(['t-1']);
  });

  // Breaks: a first reply has no cleanup thread yet; without the reply target
  // the in-flight send goes unrecognised and its draft comes back.
  it('falls back to the thread of the email being replied to', () => {
    expect(pendingSendThreadKeys({ draft: { replyToEmail: row('a-1', 't-2') } })).toEqual(['t-2']);
  });

  // Breaks: keys from the two sources are reported twice and the caller does
  // redundant comparisons on every render.
  it('merges both sources without duplicates', () => {
    const keys = pendingSendThreadKeys({
      draftCleanup: { threadId: 't-1' },
      draft: { replyToEmail: row('a-1', 't-1') },
    });

    expect(keys).toEqual(['t-1']);
  });

  // Breaks: with no send in flight this must be empty — a non-empty result here
  // would suppress EVERY thread's draft permanently.
  it.each([
    ['no pending send', null],
    ['an undefined pending send', undefined],
    ['a pending send carrying neither source', {}],
  ])('returns no keys for %s', (_case, pendingSend) => {
    expect(pendingSendThreadKeys(pendingSend)).toEqual([]);
  });
});

describe('shouldSuppressDraftAutoOpen', () => {
  // Breaks: the user closes a draft and it immediately re-opens itself.
  it('suppresses a thread the user already dismissed', () => {
    expect(shouldSuppressDraftAutoOpen(['t-1'], new Set(['t-1']), [])).toBe(true);
  });

  // Breaks: the just-sent draft reappears under the sent mail during the undo
  // window — the regression this whole helper exists for.
  it('suppresses a thread with a send still in its undo window', () => {
    expect(shouldSuppressDraftAutoOpen(['t-1'], new Set(), ['t-1'])).toBe(true);
  });

  // Breaks: matching on ANY key rather than this thread's would silence every
  // other conversation's saved draft while one unrelated send is in flight.
  it('leaves an unrelated thread alone while another thread is sending', () => {
    expect(shouldSuppressDraftAutoOpen(['t-2'], new Set(['t-3']), ['t-1'])).toBe(false);
  });

  // Breaks: a view identified by several keys (unthreaded optimistic row plus
  // its parent) escapes suppression when only one of them was recorded.
  it('suppresses when ANY of the view keys matches', () => {
    expect(shouldSuppressDraftAutoOpen(['a-1', 't-1'], new Set(['t-1']), [])).toBe(true);
  });

  // Breaks: the effect throws on a render where no send has ever been made.
  it.each([
    ['a null sending list', null],
    ['an undefined sending list', undefined],
  ])('treats %s as nothing in flight', (_case, sending) => {
    expect(shouldSuppressDraftAutoOpen(['t-1'], new Set(), sending)).toBe(false);
  });
});
