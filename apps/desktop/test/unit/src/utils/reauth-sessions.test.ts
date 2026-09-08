import { describe, expect, it } from 'vitest';

import {
  addReauthSession,
  describeReauthSessions,
  findReauthSession,
  mergeReauthSnapshot,
  removeReauthSession,
  type ReauthSession,
} from '../../../../src/utils/reauth-sessions';

const session = (email: string, over: Partial<ReauthSession> = {}): ReauthSession => ({
  provider: 'sarv',
  email,
  reason: 'invalid_grant',
  since: '2026-09-08T00:00:00.000Z',
  ...over,
});

describe('reauth session list', () => {
  // Two accounts must both be tracked; collapsing them would leave one silently
  // unsynced while the banner claimed the other was the only problem.
  it('adds a new account', () => {
    const list = addReauthSession([session('a@example.com')], session('b@example.com'));
    expect(list.map((s) => s.email)).toEqual(['a@example.com', 'b@example.com']);
  });

  // A re-auth that fails again re-fires the event. Without dedupe the banner
  // would stack duplicate rows for one account.
  it('never duplicates an account, and refreshes its reason', () => {
    const list = addReauthSession(
      [session('a@example.com')],
      session('a@example.com', { reason: 'revoked' }),
    );
    expect(list).toHaveLength(1);
    expect(list[0].reason).toBe('revoked');
  });

  // Updating one account's reason must leave its siblings byte-for-byte alone —
  // rewriting them would reset the other account's recorded failure time.
  it('leaves the other accounts untouched when updating one', () => {
    const other = session('b@example.com', { reason: 'still broken' });
    const list = addReauthSession(
      [session('a@example.com'), other],
      session('a@example.com', { reason: 'revoked' }),
    );
    expect(list[1]).toBe(other);
  });

  // The same address can be signed in on two providers; treating them as one
  // would clear a live failure.
  it('treats the same email on a different provider as a different account', () => {
    const list = addReauthSession(
      [session('a@example.com')],
      session('a@example.com', { provider: 'gmail' }),
    );
    expect(list).toHaveLength(2);
  });

  // A repeat failure must not make an old problem look new.
  it('keeps the original since on a repeat', () => {
    const list = addReauthSession(
      [session('a@example.com')],
      session('a@example.com', { since: '2026-09-08T09:00:00.000Z' }),
    );
    expect(list[0].since).toBe('2026-09-08T00:00:00.000Z');
  });

  // If resolution didn't remove the entry the user would be told to sign in to
  // an account that already works.
  it('removes a resolved account and leaves the rest', () => {
    const list = removeReauthSession(
      [session('a@example.com'), session('b@example.com')],
      { provider: 'sarv', email: 'a@example.com' },
    );
    expect(list.map((s) => s.email)).toEqual(['b@example.com']);
  });

  // Resolving an account we never listed must be a no-op, not a crash.
  it('ignores a resolution for an account it does not hold', () => {
    const before = [session('a@example.com')];
    expect(removeReauthSession(before, { provider: 'sarv', email: 'x@example.com' })).toEqual(before);
  });

  // The mount-time pull is what covers a failure that happened before the
  // window existed — the whole reason the banner is not push-only.
  it('takes accounts from the pulled snapshot', () => {
    expect(mergeReauthSnapshot([], [session('a@example.com')]).map((s) => s.email))
      .toEqual(['a@example.com']);
  });

  // The pull is async. If it landed after a push it must not duplicate the
  // account the push already added.
  it('does not duplicate an account present in both the push and the snapshot', () => {
    const merged = mergeReauthSnapshot([session('a@example.com')], [session('a@example.com')]);
    expect(merged).toHaveLength(1);
  });

  // A failure pushed WHILE the pull was in flight is not in the snapshot;
  // dropping it would lose a live problem.
  it('keeps a push-only account the snapshot does not know about', () => {
    const merged = mergeReauthSnapshot([session('pushed@example.com')], [session('pulled@example.com')]);
    expect(merged.map((s) => s.email)).toEqual(['pulled@example.com', 'pushed@example.com']);
  });

  // An empty snapshot is authoritative for accounts it doesn't name only in the
  // sense that it adds nothing — it must not wipe a push that just arrived.
  it('an empty snapshot leaves pushed accounts alone', () => {
    expect(mergeReauthSnapshot([session('a@example.com')], [])).toHaveLength(1);
  });

  // The Accounts list said "Connected" for an account whose session was dead —
  // dismissing the banner left no way to find out. The row needs this lookup.
  it('finds the session for an account that needs re-auth', () => {
    const found = findReauthSession([session('a@example.com')], { provider: 'sarv', email: 'a@example.com' });
    expect(found?.email).toBe('a@example.com');
  });

  // The list stores the address as the user typed it; the token store holds
  // what the provider returned. A case mismatch must not hide the problem.
  it('matches the address case-insensitively', () => {
    expect(findReauthSession([session('a@example.com')], { provider: 'sarv', email: 'A@Example.COM' })).toBeDefined();
  });

  // A healthy account must not be flagged just because a sibling is broken.
  it('returns nothing for a healthy account', () => {
    expect(findReauthSession([session('a@example.com')], { provider: 'sarv', email: 'b@example.com' })).toBeUndefined();
  });

  // Same address on two providers: flagging the wrong row would send the user
  // to re-authenticate an account that works.
  it('does not match the same address on a different provider', () => {
    expect(findReauthSession([session('a@example.com')], { provider: 'gmail', email: 'a@example.com' })).toBeUndefined();
  });

  // A plain-IMAP row (or one saved before the provider was recorded) should
  // still show the problem rather than silently nothing.
  it('falls back to the address when the row has no provider', () => {
    expect(findReauthSession([session('a@example.com')], { email: 'a@example.com' })).toBeDefined();
  });

  // A row with no address cannot be matched to anything; guessing would flag
  // an arbitrary account.
  it('matches nothing for a row with no address', () => {
    expect(findReauthSession([session('a@example.com')], { provider: 'sarv', email: '' })).toBeUndefined();
  });

  // With several accounts signed in, unnamed copy leaves the user guessing
  // which mailbox stopped syncing.
  it.each([
    [[session('a@example.com')], 'Your session for a@example.com has expired.'],
    [
      [session('a@example.com'), session('b@example.com')],
      'Your sessions for a@example.com and b@example.com have expired.',
    ],
    [
      [session('a@example.com'), session('b@example.com'), session('c@example.com')],
      'Your sessions for a@example.com and 2 other accounts have expired.',
    ],
  ])('names the affected accounts (%#)', (sessions, expected) => {
    expect(describeReauthSessions(sessions)).toBe(expected);
  });

  // The banner is hidden when empty; the describer must not produce stray copy.
  it('says nothing when no account is broken', () => {
    expect(describeReauthSessions([])).toBe('');
  });
});
