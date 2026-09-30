// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Security } from '../../../../../src/components/security/Security';
import { resetTrustedSenders } from '../../../../../src/utils/trusted-senders';
import { act, fire, render, settle, type Mounted } from '../../../../helpers/render';

/**
 * Security → Spam: the reader's own verdicts.
 *
 * What breaks if this file goes red: reporting a message as spam here also
 * withdraws its sender's trust in main, but the trusted-sender list on this
 * very page (and the copy the shield and 'trusted' remote images read) kept
 * the sender until a restart — their other mail still counted as trusted.
 */

let mounted: Mounted | null = null;
let trusted: Array<{ email: string; createdAt: number }>;

const mount = async (verdictResult: { success: boolean }) => {
  trusted = [{ email: 'promo@shop.example', createdAt: 1 }];
  const setUserVerdict = vi.fn(async () => {
    if (verdictResult.success) trusted = []; // main untrusts the reported sender
    return verdictResult;
  });
  const listTrustedSenders = vi.fn(async () => ({ success: true, data: trusted }));
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    spam: {
      listJudged: async () => ({
        success: true,
        data: [{
          id: 'e1', subject: 'Deals', fromAddress: 'promo@shop.example', fromName: null, date: 1_770_000_000,
          folderPath: 'INBOX', tags: '|INBOX|', spamScore: 4, spamReasons: '[]', spamUserVerdict: null,
        }],
      }),
      onReputationProgress: () => () => {},
      setUserVerdict,
      listTrustedSenders,
      untrustSender: vi.fn(),
    },
  };
  mounted = render(<Security initialTab="spam" />);
  await settle();
  return { setUserVerdict, listTrustedSenders };
};

afterEach(() => {
  mounted?.unmount();
  mounted = null;
  resetTrustedSenders();
  document.body.innerHTML = '';
});

describe('Security → Spam — reporting a sender', () => {
  // Breaks: the reported sender stays in the trusted list (and trusted) until restart.
  it('re-reads the trusted senders once the report is stored', async () => {
    const { setUserVerdict, listTrustedSenders } = await mount({ success: true });
    expect(mounted!.container.textContent).toContain('promo@shop.example');
    const before = listTrustedSenders.mock.calls.length;

    await act(async () => { fire(mounted!.byLabel('Spam'), 'click'); });
    await settle();

    expect(setUserVerdict).toHaveBeenCalledWith('e1', 'spam');
    expect(listTrustedSenders.mock.calls.length).toBeGreaterThan(before);
  });

  // A report main refused changed nothing — trust included.
  it('re-reads nothing when the report was refused', async () => {
    const { listTrustedSenders } = await mount({ success: false });
    const before = listTrustedSenders.mock.calls.length;

    await act(async () => { fire(mounted!.byLabel('Spam'), 'click'); });
    await settle();

    expect(listTrustedSenders.mock.calls.length).toBe(before);
  });
});
