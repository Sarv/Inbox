// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';

import { LEVEL_RANK, type SecurityLevel } from '../../../../src/utils/email-security';
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
vi.stubGlobal('window', Object.assign(globalThis.window, { electronAPI: { security: { listLinkRules } } }));

const Probe = (props: Parameters<typeof useEmailSecurity>[0]) => {
  const { level } = useEmailSecurity(props);
  return <span data-level={level} />;
};

const levelOf = (view: ReturnType<typeof render>) => view.find('[data-level]')?.dataset.level as SecurityLevel;

describe('useEmailSecurity', () => {
  // Failed authentication is danger no matter what else the message says.
  it('reports danger for mail whose authentication failed', () => {
    const view = render(<Probe fromAddress="billing@bank.example" authStatus={auth('fail')} html="<p>hi</p>" bodyLoaded />);
    expect(levelOf(view)).toBe('danger');
    view.unmount();
  });

  // The reader's "I trust this link" must clear the flag once the rules load,
  // not only on the next message opened.
  it('re-assesses when the reader’s link rules arrive', async () => {
    const view = render(
      <Probe fromAddress="hello@producthunt.com" authStatus={auth('pass')} html={DECEPTIVE} bodyLoaded />,
    );
    await settle();

    expect(listLinkRules).toHaveBeenCalled();
    expect(LEVEL_RANK[levelOf(view)]).toBeLessThan(LEVEL_RANK.caution);
    view.unmount();
  });
});
