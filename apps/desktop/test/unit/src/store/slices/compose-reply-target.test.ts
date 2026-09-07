import { describe, it, expect, vi } from 'vitest';

// The slice pulls in `../helpers`, which reaches CategoryBadges (and through it
// the IPC bridge). The two pure functions under test touch none of it.
vi.mock('../../../../../src/components/email-list/CategoryBadges', () => ({
  clearCategoryBadgeCache: vi.fn(),
  applyEmailCategories: vi.fn(),
  getCachedCategorySlugs: vi.fn(() => []),
  warmCategoryDefs: vi.fn(),
}));

import {
  findReplyTarget,
  looksLikeMessageId,
  optimisticThreadId,
} from '../../../../../src/store/slices/compose-slice';

const row = (id: string, messageId?: string | null) => ({ id, messageId: messageId ?? null });

describe('looksLikeMessageId', () => {
  // Breaks: a Message-ID is handed to `emails.get`, which only understands row
  // ids — a guaranteed miss that logs a failure and resolves no parent.
  it('recognises an RFC Message-ID by its angle brackets', () => {
    expect(looksLikeMessageId('<CAF=abc123@mail.gmail.com>')).toBe(true);
    expect(looksLikeMessageId('  <spaced@example.com>  ')).toBe(true);
  });

  // Breaks: a genuine row id is mistaken for a Message-ID, so the DB fallback is
  // skipped and a reply to a message outside the loaded page loses its parent.
  it('does not mistake a row id for a Message-ID', () => {
    expect(looksLikeMessageId('m3k9x1-4f2a8b')).toBe(false);
    expect(looksLikeMessageId('bare@example.com')).toBe(false);
    expect(looksLikeMessageId('<unterminated')).toBe(false);
    expect(looksLikeMessageId('')).toBe(false);
  });
});

describe('findReplyTarget', () => {
  // Breaks: the popup composer's path. It passes `replyToEmail.id`, and if row
  // ids stop matching, every reply from the compose window loses its thread.
  it('matches a candidate by row id', () => {
    const emails = [row('a-1', '<one@x>'), row('b-2', '<two@x>')];
    expect(findReplyTarget(emails, 'b-2')?.id).toBe('b-2');
  });

  // Breaks: THE reported bug. InlineReply passes the parent's Message-ID, not
  // its row id; with no match the sent row is invented into a `local-thread-<ts>`
  // and the just-sent draft re-opens in the composer under the sent mail.
  it('matches a candidate by its RFC Message-ID', () => {
    const emails = [row('a-1', '<one@x>'), row('b-2', '<two@x>')];
    expect(findReplyTarget(emails, '<two@x>')?.id).toBe('b-2');
  });

  // Breaks: senders and stores disagree about angle brackets — some rows keep
  // them, some strip them. Comparing the raw strings misses half of real mail.
  it('compares Message-IDs bare, so brackets on either side do not matter', () => {
    expect(findReplyTarget([row('a-1', 'one@x')], '<one@x>')?.id).toBe('a-1');
    expect(findReplyTarget([row('a-1', '<one@x>')], 'one@x')?.id).toBe('a-1');
  });

  // Breaks: a reply whose parent is genuinely not loaded silently attaches to
  // the wrong message instead of falling through to the DB lookup.
  it('returns null when nothing matches', () => {
    expect(findReplyTarget([row('a-1', '<one@x>')], '<other@x>')).toBeNull();
  });

  // Breaks: the first render of a conversation (no thread loaded yet) throws on
  // an empty or absent candidate list and the send never happens.
  it('tolerates an empty, null or undefined candidate list', () => {
    expect(findReplyTarget([], '<one@x>')).toBeNull();
    expect(findReplyTarget(null, '<one@x>')).toBeNull();
    expect(findReplyTarget(undefined, '<one@x>')).toBeNull();
  });

  // Breaks: a row with no Message-ID (a local draft, an optimistic sent row)
  // matches an empty lookup key and becomes everyone's reply parent.
  it('never matches a row that has no Message-ID on an empty key', () => {
    expect(findReplyTarget([row('a-1', null)], '')).toBeNull();
    expect(findReplyTarget([row('a-1', null)], '   ')).toBeNull();
    expect(findReplyTarget([row('a-1', undefined)], '<>')).toBeNull();
  });

  // Breaks: the References header. The parent is resolved only to build
  // In-Reply-To/References; if the row that comes back is not the real parent,
  // the outgoing mail threads wrongly in every other client.
  it('returns the whole row, so References can be built from it', () => {
    const parent = { id: 'b-2', messageId: '<two@x>', references: '<zero@x> <one@x>' };
    expect(findReplyTarget([parent], '<two@x>')).toBe(parent);
  });
});

describe('optimisticThreadId', () => {
  // Breaks: THE reported bug. The optimistic sent row lands under an invented
  // `local-thread-<now>` id, becomes the newest row in the reading pane, and its
  // fabricated thread misses the "already handled" record — so the draft the
  // send is about to delete re-opens in the composer under the sent mail.
  it('places the sent row in the parent thread', () => {
    expect(optimisticThreadId({ id: 'b-2', threadId: 't-1' }, 'local-thread-9')).toBe('t-1');
  });

  // Breaks: replying to a mail that has never been threaded (a standalone
  // message) still invents a thread, splitting the reply away from its parent.
  it('falls back to the parent row id when the parent has no thread', () => {
    expect(optimisticThreadId({ id: 'b-2', threadId: null }, 'local-thread-9')).toBe('b-2');
    expect(optimisticThreadId({ id: 'b-2', threadId: '' }, 'local-thread-9')).toBe('b-2');
    expect(optimisticThreadId({ id: 'b-2' }, 'local-thread-9')).toBe('b-2');
  });

  // Breaks: a genuinely new compose (no parent) needs its own thread; reusing
  // anything shared here would merge unrelated mail into one conversation.
  it.each([
    ['no parent', null],
    ['an undefined parent', undefined],
  ])('keeps the fresh local thread for %s', (_case, parent) => {
    expect(optimisticThreadId(parent, 'local-thread-9')).toBe('local-thread-9');
  });

  // Breaks: a malformed parent row (neither id nor thread) yields an empty
  // thread id, and every such row collapses into one bogus conversation.
  it('never returns an empty thread id', () => {
    expect(optimisticThreadId({ id: '', threadId: '' }, 'local-thread-9')).toBe('local-thread-9');
  });
});
