// @vitest-environment happy-dom
import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { setActiveCacheAccount } from '../../../../src/utils/account-scoped-cache';
import { LEVEL_RANK, type SecurityLevel } from '../../../../src/utils/email-security';
import { reloadLinkRules } from '../../../../src/utils/security-rules';
import { resetTrustedSenders } from '../../../../src/utils/trusted-senders';
import { useEmailSecurity } from '../../../../src/utils/use-email-security';
import { render, settle } from '../../../helpers/render';

/**
 * The one hook the shield, the phishing banner and the Unsubscribe button all
 * read the level from.
 *
 * What breaks if this goes red: those three disagree about the same message —
 * a red banner under a green shield, or an Unsubscribe button offered on mail
 * the banner calls dangerous — or a link the reader trusted keeps being flagged
 * because the assessment never re-ran when the rules arrived.
 */

const auth = (verdict: string) => JSON.stringify({ spf: verdict, dkim: verdict, dmarc: verdict, overall: verdict });
const DECEPTIVE = '<a href="https://producthunt.com/x">swat.io</a>';

const listLinkRules = vi.fn(async () => ({
  success: true,
  data: [{ id: 1, senderDomain: 'producthunt.com', shownDomain: 'swat.io', actualDomain: 'producthunt.com', verdict: 'trust', createdAt: 0 }],
}));
// Account B trusts the bank's alerts address; account A (the active one) does not.
const listTrustedSenders = vi.fn(async (accountId?: string) => ({
  success: true,
  data: accountId === 'acct-b' ? [{ email: 'alerts@unlisted-bank.example', createdAt: 1 }] : [],
}));
vi.stubGlobal('window', Object.assign(globalThis.window, { electronAPI: { security: { listLinkRules }, spam: { listTrustedSenders } } }));

const Probe = (props: Parameters<typeof useEmailSecurity>[0]) => {
  const { level } = useEmailSecurity(props);
  return <span data-level={level} />;
};

const levelOf = (view: ReturnType<typeof render>) => view.find('[data-level]')?.dataset.level as SecurityLevel;

describe('useEmailSecurity', () => {
  // Failed authentication is danger no matter what else the message says.
  it('reports danger for mail whose authentication failed', async () => {
    const view = render(<Probe fromAddress="billing@bank.example" authStatus={auth('fail')} html="<p>hi</p>" bodyLoaded />);
    expect(levelOf(view)).toBe('danger');
    await settle();
    view.unmount();
  });

  // The reader's "I trust this link" must clear the flag once the rules load,
  // not only on the next message opened.
  it('re-assesses when the reader’s link rules arrive', async () => {
    // The rules cache survives between tests and sessions. Start with no trust,
    // then deliver the trusted rule while the same message stays mounted.
    listLinkRules.mockResolvedValueOnce({ success: true, data: [] });
    await reloadLinkRules();
    const view = render(
      <Probe fromAddress="hello@producthunt.com" authStatus={auth('pass')} html={DECEPTIVE} bodyLoaded />,
    );
    expect(LEVEL_RANK[levelOf(view)]).toBeGreaterThanOrEqual(LEVEL_RANK.caution);

    await act(async () => { await reloadLinkRules(); });
    expect(listLinkRules).toHaveBeenCalledTimes(2);
    expect(LEVEL_RANK[levelOf(view)]).toBeLessThan(LEVEL_RANK.caution);
    view.unmount();
  });

  // Multi-account (All Inboxes): the shield took "trusted" from the ACTIVE
  // account's list, while the remote-image decision and "Trust this sender"
  // use the message's own account — so the same message was trusted in one
  // place and flagged in the other, and a banner never cleared after a trust.
  it("takes the sender's trust from the message's own account", async () => {
    setActiveCacheAccount('acct-a');
    const reasons = JSON.stringify([{ id: 'brand-impersonation', points: 3, detail: 'borrows the Axis Bank name' }]);
    const message = {
      fromName: 'Axis Bank Alerts', fromAddress: 'alerts@unlisted-bank.example', authStatus: auth('pass'),
      spamScore: 5, spamReasons: reasons, html: '<p>AutoPay activated</p>', bodyLoaded: true,
    };
    const inB = render(<Probe {...message} accountId="acct-b" />);
    const inActive = render(<Probe {...message} />);
    await settle();

    expect(listTrustedSenders).toHaveBeenCalledWith('acct-b');
    const levelIn = (view: ReturnType<typeof render>) =>
      (view.container.querySelector('[data-level]') as HTMLElement | null)?.dataset.level as SecurityLevel;
    expect(levelIn(inActive)).toBe('danger'); // A never trusted them
    expect(LEVEL_RANK[levelIn(inB)]).toBeLessThan(LEVEL_RANK.caution); // B did
    inB.unmount();
    inActive.unmount();
    resetTrustedSenders();
    setActiveCacheAccount(null);
  });
});
