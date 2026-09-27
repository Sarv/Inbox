import { describe, expect, it, vi } from 'vitest';

// What breaks if this suite goes red: an inline reply or forward opened from
// All Inboxes goes out from (and drafts into) whichever account is active
// instead of the mailbox the mail arrived in — and nothing on screen says so.

vi.mock('../../../../src/store/email-store', () => ({ useEmailStore: vi.fn() }));

const { resolveInlineSendingAccount } = await import('../../../../src/hooks/useInlineSendingAccount');

const work = { id: 'work', email: 'me@work.com' } as any;
const home = { id: 'home', email: 'me@home.com' } as any;
const base = { viewAccountId: null, activeAccountId: 'home', isUnifiedView: false, accounts: [work, home] };

describe('resolveInlineSendingAccount', () => {
  // Breaks: THE forward bug — a merged All Inboxes row's own account was ignored.
  it("sends from the mail's own account", () => {
    expect(resolveInlineSendingAccount({ ...base, emailAccountId: 'work' }).accountId).toBe('work');
  });

  // Breaks: mail loaded through a thread carries no accountId; without the
  // opened view's account it falls back to the active one — the wrong mailbox.
  it('falls back to the account the mail was opened from', () => {
    expect(resolveInlineSendingAccount({ ...base, viewAccountId: 'work' }).accountId).toBe('work');
  });

  // Breaks: a normal single-account open would be pinned to some stale account.
  it('leaves it to the active account when neither is known', () => {
    expect(resolveInlineSendingAccount(base).accountId).toBeUndefined();
  });

  // Breaks: sending from a non-active mailbox with no From bar to say so.
  it('shows the From bar in All Inboxes for another account', () => {
    const { fromAccount } = resolveInlineSendingAccount({ ...base, isUnifiedView: true, emailAccountId: 'work' });
    expect(fromAccount).toBe(work);
  });

  // Breaks: a redundant From bar on every ordinary reply/forward.
  it('hides the From bar for the active account, and outside All Inboxes', () => {
    expect(resolveInlineSendingAccount({ ...base, isUnifiedView: true, emailAccountId: 'home' }).fromAccount).toBeNull();
    expect(resolveInlineSendingAccount({ ...base, emailAccountId: 'work' }).fromAccount).toBeNull();
    // An account id no longer in the list (removed mid-session) shows no bar rather than throwing.
    expect(resolveInlineSendingAccount({ ...base, isUnifiedView: true, emailAccountId: 'gone' }).fromAccount).toBeNull();
  });
});
