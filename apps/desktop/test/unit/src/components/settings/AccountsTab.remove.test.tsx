// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AccountsTab } from '../../../../../src/components/settings/AccountsTab';
import { defaultSettings } from '../../../../../src/components/settings/types';
import { cleanup, fire, render, settle, type Mounted } from '../../../../helpers/render';

/**
 * Settings → Accounts → Remove account (CASA audit I-6).
 *
 * Google and Sarv let an app revoke its own access. The remove dialog must say,
 * per provider, what removal does about the sign-in — Google: revoked;
 * Sarv: ended at Sarv, and AI stops if it runs on that sign-in; Microsoft: not
 * possible for an app, with the two pages where the user can do it; password:
 * password deleted — and if a revocation did not go through, say so afterwards.
 *
 * What breaks if this file fails: an Outlook user believes removing the account
 * revoked Sarv Inbox's access (it cannot), a Google user whose revocation
 * failed offline is never told the app is still listed in their Google account,
 * or the Microsoft/Google links stop opening.
 */

const h = vi.hoisted(() => ({
  state: {} as Record<string, any>,
  removeAccountById: vi.fn(),
  openExternal: vi.fn(async () => ({ success: true })),
}));

vi.mock('../../../../../src/store/email-store', () => {
  const useEmailStore = Object.assign(() => h.state, { getState: () => h.state });
  return { useEmailStore };
});
vi.mock('../../../../../src/hooks/useOAuthSignIn', () => ({
  useOAuthSignIn: () => ({ pending: null, start: vi.fn(), cancel: vi.fn() }),
}));
vi.mock('../../../../../src/hooks/useReauthSessions', () => ({ useReauthSessions: () => [] }));

const account = (id: string, email: string, imapConfig: Record<string, unknown>) => ({
  id, email, imapConfig: { host: 'imap.example', port: 993, username: email, ...imapConfig }, smtpConfig: null, smtpConfigured: false,
});
const ACCOUNTS = {
  gmail: account('g', 'me@gmail.com', { authMethod: 'oauth2', oauthProvider: 'gmail' }),
  microsoft: account('m', 'me@outlook.com', { authMethod: 'oauth2', oauthProvider: 'microsoft' }),
  sarv: account('s', 'me@sarv.com', { authMethod: 'oauth2', oauthProvider: 'sarv' }),
  password: account('p', 'me@example.org', { authMethod: 'password', password: 'x' }),
};

let view: Mounted;

function mount(which: keyof typeof ACCOUNTS): Mounted {
  const target = ACCOUNTS[which];
  h.state = {
    connected: false, imapConfig: null, connect: vi.fn(), disconnect: vi.fn(), connectionStatus: 'disconnected',
    smtpConfigured: false, smtpConfig: null, accounts: [target], activeAccountId: 'other',
    selectAccount: vi.fn(async () => {}), removeAccountById: h.removeAccountById, removeSmtp: vi.fn(),
    setAccountIdentities: vi.fn(), deletingAccountIds: [], accountActionError: null,
  };
  view = render(<AccountsTab settings={defaultSettings} updateSetting={vi.fn()} />);
  return view;
}

const buttonWithText = (text: string) => view.all('button').find((b) => b.textContent?.trim() === text) ?? null;

/** Open the account's details, then its Remove confirmation. */
async function openRemoveDialog(which: keyof typeof ACCOUNTS): Promise<HTMLElement> {
  mount(which);
  await settle();
  fire(view.all('button').find((b) => b.textContent?.includes(ACCOUNTS[which].email))!, 'click');
  fire(view.byLabel('Remove account')!, 'click');
  const dialog = view.all('[role="dialog"]').find((d) => d.textContent?.includes('Remove account?'));
  expect(dialog).toBeTruthy();
  return dialog!;
}

const note = (dialog: HTMLElement) => dialog.querySelector('[data-testid="removal-access-note"]')?.textContent ?? '';

beforeEach(() => {
  h.removeAccountById.mockReset().mockResolvedValue('revoked');
  h.openExternal.mockClear();
  window.electronAPI = {
    oauth: { listProviders: vi.fn(async () => ({ success: true, data: [] })) },
    imap: { getSavedConfig: vi.fn(async () => ({ success: false })), clearSavedConfig: vi.fn() },
    app: { openExternal: h.openExternal },
  } as unknown as typeof window.electronAPI;
});
afterEach(() => { cleanup(); document.body.innerHTML = ''; });

describe('remove dialog — what happens to the sign-in', () => {
  // Breaks: a Google user isn't told access is revoked as part of removal.
  it('Google: says Sarv Inbox revokes its access', async () => {
    const dialog = await openRemoveDialog('gmail');
    expect(note(dialog)).toBe('Sarv Inbox also revokes its access to this Google account.');
  });

  // THE finding. Breaks: an Outlook user believes removal revoked access, or
  // cannot reach the pages where they can revoke it themselves.
  it('Microsoft: says apps cannot revoke, and opens both consent pages', async () => {
    const dialog = await openRemoveDialog('microsoft');
    expect(note(dialog)).toContain("Microsoft doesn't let apps revoke their own access");
    expect(note(dialog)).not.toMatch(/revokes its access/);
    const links = [...dialog.querySelectorAll('[data-testid="removal-access-note"] button')] as HTMLElement[];
    expect(links.map((l) => l.textContent)).toEqual(['account.live.com/consent/Manage', 'myapps.microsoft.com']);
    for (const link of links) fire(link, 'click');
    expect(h.openExternal.mock.calls).toEqual([['https://account.live.com/consent/Manage'], ['https://myapps.microsoft.com']]);
    // Following a link is not confirming the removal.
    expect(h.removeAccountById).not.toHaveBeenCalled();
  });

  // Breaks: the dialog understates what removal now does at Sarv.
  it('Sarv: says the sign-in is ended at Sarv and its tokens deleted', async () => {
    const dialog = await openRemoveDialog('sarv');
    expect(note(dialog)).toBe('Sarv Inbox also ends this sign-in at Sarv and deletes its tokens from this device.');
  });

  // The one Sarv session is mailbox AND AI. Breaks: someone removes the mailbox
  // not knowing it also stops their AI provider.
  it('Sarv: warns that AI stops too when an AI provider runs on this sign-in', async () => {
    localStorage.setItem('sarvinbox-ai-settings', JSON.stringify({ providers: [
      { id: 'p', type: 'sarv', name: 'Sarv AI', apiKey: '', model: 'm', authMethod: 'oauth', oauthProvider: 'sarv', oauthEmail: 'ME@sarv.com', isDefault: true },
    ] }));
    try {
      const dialog = await openRemoveDialog('sarv');
      expect(note(dialog)).toContain('Your AI provider uses this sign-in, so it stops too.');
    } finally {
      localStorage.removeItem('sarvinbox-ai-settings');
    }
  });

  // Multi-account. Breaks: the warning appears for a Sarv mailbox whose removal
  // leaves the AI provider (which runs on ANOTHER Sarv sign-in) untouched.
  it('Sarv: does not warn when AI runs on a different sign-in', async () => {
    localStorage.setItem('sarvinbox-ai-settings', JSON.stringify({ providers: [
      { id: 'p', type: 'sarv', name: 'Sarv AI', apiKey: '', model: 'm', authMethod: 'oauth', oauthProvider: 'sarv', oauthEmail: 'other@sarv.com', isDefault: true },
    ] }));
    try {
      const dialog = await openRemoveDialog('sarv');
      expect(note(dialog)).not.toContain('Your AI provider');
    } finally {
      localStorage.removeItem('sarvinbox-ai-settings');
    }
  });

  // Breaks: a password account's dialog talks about revocation or sign-in tokens.
  it('password account: says the saved password is deleted', async () => {
    const dialog = await openRemoveDialog('password');
    expect(note(dialog)).toBe('Its saved password is deleted from this device.');
  });
});

describe('after removing — Google revocation that did not go through', () => {
  const confirm = async (dialog: HTMLElement) => {
    fire([...dialog.querySelectorAll('button')].find((b) => b.textContent?.includes('Remove'))!, 'click');
    await settle();
  };
  const notice = () => view.find('[role="status"]');

  // Offline / Google unreachable. Breaks: the user is never told Sarv Inbox
  // still has access to their Google account, or can't open the page to fix it.
  it('tells the user and links Google\'s permissions page', async () => {
    h.removeAccountById.mockResolvedValue('failed');
    await confirm(await openRemoveDialog('gmail'));
    expect(h.removeAccountById).toHaveBeenCalledWith('g');
    expect(notice()?.textContent).toContain("me@gmail.com was removed, but Sarv Inbox couldn't revoke its access at Google.");
    fire(buttonWithText('myaccount.google.com/permissions')!, 'click');
    expect(h.openExternal).toHaveBeenCalledWith('https://myaccount.google.com/permissions');
    fire(view.byLabel('Dismiss')!, 'click');
    expect(notice()).toBeNull();
  });

  // Offline / Sarv unreachable. Breaks: the user is told nothing while the grant
  // may still be live at Sarv, or the notice claims it was revoked.
  it('tells the user Sarv did not confirm', async () => {
    h.removeAccountById.mockResolvedValue('failed');
    await confirm(await openRemoveDialog('sarv'));
    expect(h.removeAccountById).toHaveBeenCalledWith('s');
    expect(notice()?.textContent).toContain("me@sarv.com was removed and its sign-in deleted from this device, but Sarv Inbox couldn't confirm that Sarv ended it.");
    fire(view.byLabel('Dismiss')!, 'click');
    expect(notice()).toBeNull();
  });

  // Breaks: a notice is raised for a revocation that worked, for a shared grant
  // that was deliberately kept, or for a provider that can't revoke at all.
  it.each([
    ['gmail', 'revoked'],
    ['gmail', 'skipped'],
    ['microsoft', 'failed'],
    ['sarv', 'revoked'],
    ['sarv', 'skipped'],
    ['password', undefined],
  ] as const)('shows nothing for %s with outcome %s', async (which, outcome) => {
    h.removeAccountById.mockResolvedValue(outcome);
    await confirm(await openRemoveDialog(which));
    expect(notice()).toBeNull();
  });
});
