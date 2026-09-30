// @vitest-environment happy-dom
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { cleanup, render } from '../../../../helpers/render';

/**
 * "I trust this sender" on the warning banner.
 *
 * What this protects: the button is the user's one way to say "stop flagging
 * this sender". It must appear where trust would help (the name or the spam
 * score), store the address, clear the message through the view's own Not
 * spam, and make the banner go away. And it must NEVER be offered on a message
 * that failed authentication — that is what a forged copy of a trusted
 * address looks like, and one click must not wave it through.
 */

// A stateful stand-in for the main process: what was trusted is what is listed.
let stored: Array<{ email: string; createdAt: number }> = [];
const trustSender = vi.fn(async (address: string) => {
  stored = [{ email: address, createdAt: 1 }, ...stored];
  return { success: true };
});
const listTrustedSenders = vi.fn(async () => ({ success: true, data: stored }));

beforeEach(() => {
  (globalThis as unknown as { window: Window }).window.electronAPI = {
    spam: { trustSender, listTrustedSenders, untrustSender: vi.fn(), setUserVerdict: vi.fn() },
    security: { listLinkRules: async () => ({ success: true, data: [] }) },
  } as never;
});

afterEach(async () => {
  // Unmount before the environment is torn down; a mounted root left React work
  // queued that ran after `window` was gone ("window is not defined", CI red).
  cleanup();
  vi.clearAllMocks();
  stored = [];
  const { resetTrustedSenders } = await import('../../../../../src/utils/trusted-senders');
  resetTrustedSenders();
  document.body.innerHTML = '';
});

const { PhishingWarningBanner, clearAfterTrust } = await import('../../../../../src/components/email-detail/PhishingWarningBanner');

const PASS = JSON.stringify({ spf: 'pass', dkim: 'pass', dmarc: 'pass', overall: 'pass' });
const FAIL = JSON.stringify({ spf: 'fail', dkim: 'fail', dmarc: 'fail', overall: 'fail' });
const REASONS = JSON.stringify([
  { id: 'brand-impersonation', points: 3, detail: 'borrows the Axis Bank name' },
  { id: 'in-reply-to-self', points: 2, detail: 'reply to itself' },
]);

const banner = (over: Record<string, unknown> = {}) => (
  <PhishingWarningBanner
    emailId="e1"
    fromName="Axis Bank Alerts"
    fromAddress="alerts@unlisted-bank.example"
    authStatus={PASS}
    spamScore={5}
    spamReasons={REASONS}
    html="<p>AutoPay activated</p>"
    onTrusted={vi.fn()}
    {...over}
  />
);
const trustButton = (m: ReturnType<typeof render>) =>
  m.all('button').find((b) => b.textContent?.includes('I trust this sender')) ?? null;
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

describe('PhishingWarningBanner — I trust this sender', () => {
  // Regression: the reason it exists. Trusting stores the ADDRESS (not the
  // display name), clears the message through the view's own path, and the
  // banner disappears because the shield now honours the trust.
  it('trusts the address, clears the message, and the banner goes away', async () => {
    const onTrusted = vi.fn();
    const m = render(banner({ onTrusted }));
    await flush();
    expect(m.container.textContent).toContain('This message may not be from who it claims to be');

    await act(async () => { trustButton(m)!.click(); });
    await flush();

    expect(trustSender).toHaveBeenCalledWith('alerts@unlisted-bank.example', undefined);
    expect(onTrusted).toHaveBeenCalledTimes(1);
    expect(m.container.textContent).not.toContain('may not be from who it claims');
  });

  // Regression, the security edge: never a one-click bypass for a message
  // that failed authentication.
  it('is not offered on a message that failed authentication', async () => {
    const m = render(banner({ authStatus: FAIL, spamScore: 8 }));
    await flush();
    expect(m.container.textContent).toContain('may not be from who it claims');
    expect(trustButton(m)).toBeNull();
  });

  // Trust answers "who sent it". A warning that is only about a lying link
  // is not fixed by trusting the sender, so the button would mislead.
  it('is not offered when the warning is only about a link', async () => {
    const m = render(banner({
      fromName: 'Alice', fromAddress: 'alice@example.net', spamScore: 0, spamReasons: '[]',
      html: '<a href="https://evil.example/x">https://example.net</a>',
    }));
    await flush();
    expect(m.container.textContent).toContain('Be careful with this message');
    expect(trustButton(m)).toBeNull();
  });

  it('is not offered without the message or a way to clear it', async () => {
    const noId = render(banner({ emailId: undefined }));
    const noClear = render(banner({ onTrusted: undefined }));
    await flush();
    expect(trustButton(noId)).toBeNull();
    expect(trustButton(noClear)).toBeNull();
  });

  // A failed save must say so and leave the message alone — the user must not
  // believe a trust that was never stored.
  it('reports a failed save and does not clear the message', async () => {
    trustSender.mockImplementationOnce(async () => ({ success: false, error: 'db busy' }) as never);
    const onTrusted = vi.fn();
    const m = render(banner({ onTrusted }));
    await flush();

    await act(async () => { trustButton(m)!.click(); });
    await flush();

    expect(onTrusted).not.toHaveBeenCalled();
    expect(m.container.textContent).toContain('db busy');
  });
});

describe('PhishingWarningBanner — another account\'s message', () => {
  afterEach(async () => {
    const { setActiveCacheAccount } = await import('../../../../../src/utils/account-scoped-cache');
    setActiveCacheAccount(null);
  });

  // Multi-account (All Inboxes): the banner checked the ACTIVE account's
  // trusted senders while "Trust this sender" wrote to the message's own
  // account — so after the click the banner never cleared, and a sender
  // trusted only in the active account lifted the warning off another
  // account's mail. It reads and writes the message's account.
  it("checks and trusts in the message's own account, not the active one", async () => {
    const { setActiveCacheAccount } = await import('../../../../../src/utils/account-scoped-cache');
    setActiveCacheAccount('acct-a');
    const byAccount: Record<string, Array<{ email: string; createdAt: number }>> = {
      'acct-a': [{ email: 'alerts@unlisted-bank.example', createdAt: 1 }],
      'acct-b': [],
    };
    listTrustedSenders.mockImplementation((async (accountId?: string) => ({ success: true, data: byAccount[accountId ?? 'acct-a'] })) as never);
    trustSender.mockImplementation((async (address: string, accountId?: string) => {
      byAccount[accountId ?? 'acct-a'] = [{ email: address, createdAt: 2 }, ...byAccount[accountId ?? 'acct-a']];
      return { success: true };
    }) as never);

    const m = render(banner({ accountId: 'acct-b' }));
    await flush();
    // Trusted in A says nothing about B's mail: the warning stays.
    expect(m.container.textContent).toContain('may not be from who it claims');

    await act(async () => { trustButton(m)!.click(); });
    await flush();
    expect(trustSender).toHaveBeenCalledWith('alerts@unlisted-bank.example', 'acct-b');
    expect(m.container.textContent).not.toContain('may not be from who it claims');
    listTrustedSenders.mockReset();
    listTrustedSenders.mockImplementation(async () => ({ success: true, data: stored }));
    trustSender.mockReset();
    trustSender.mockImplementation(async (address: string) => {
      stored = [{ email: address, createdAt: 1 }, ...stored];
      return { success: true };
    });
  });
});

describe('clearAfterTrust', () => {
  // In the Spam folder the message must leave it through the view's own Not
  // spam (which updates the list); anywhere else it stays put and only loses
  // its spam verdict — moving an INBOX message "to INBOX" would be nonsense.
  it('uses the view\'s Not spam in Spam, and the verdict alone elsewhere', async () => {
    const handleNotSpam = vi.fn(async () => {});
    await clearAfterTrust({ isInSpam: true, handleNotSpam }, 'e1', 'acct');
    expect(handleNotSpam).toHaveBeenCalledTimes(1);
    expect(window.electronAPI.spam.setUserVerdict).not.toHaveBeenCalled();

    await clearAfterTrust({ isInSpam: false, handleNotSpam }, 'e2', 'acct');
    expect(window.electronAPI.spam.setUserVerdict).toHaveBeenCalledWith('e2', 'ham', 'acct');
    expect(handleNotSpam).toHaveBeenCalledTimes(1);
  });
});
