import { describe, expect, it } from 'vitest';

import { messageAccountOf, paneAccountOf } from '../../../../src/utils/pane-account';

/**
 * Which account a reading-pane message belongs to.
 *
 * What breaks if this file goes red: the shield, the warning banner and the
 * remote-image decision ask a different account about the same message — a
 * sender trusted (or allowed images) in one account vouches for another
 * account's mail, and "Trust this sender" / "Load images" are saved to the
 * wrong database.
 */
describe('paneAccountOf', () => {
  // Breaks: selecting account B's copy of the open conversation (the same
  // thread id) moves `viewAccountId` to B at once, while the loaded rows are
  // still A's until the new thread lands — they were judged against B.
  it('answers the account the loaded thread was read from, not the live view account', () => {
    expect(paneAccountOf({ threadEmails: [{}], threadAccountId: 'acct-a', viewAccountId: 'acct-b' })).toBe('acct-a');
  });

  // With no thread loaded, the open message is the list row: its view account.
  it('falls back to the view account without a loaded thread, or a thread with no stamp', () => {
    expect(paneAccountOf({ threadEmails: [], threadAccountId: 'acct-a', viewAccountId: 'acct-b' })).toBe('acct-b');
    expect(paneAccountOf({ threadEmails: [{}], threadAccountId: null, viewAccountId: 'acct-b' })).toBe('acct-b');
    expect(paneAccountOf({})).toBeNull();
  });
});

describe('messageAccountOf', () => {
  // Breaks: a unified-view row that names its own account is asked about the
  // pane's instead.
  it("prefers the row's own account, then the pane's, else none (the active one)", () => {
    expect(messageAccountOf({ accountId: 'acct-c' }, 'acct-a')).toBe('acct-c');
    expect(messageAccountOf({}, 'acct-a')).toBe('acct-a');
    expect(messageAccountOf(null)).toBeNull();
  });
});
