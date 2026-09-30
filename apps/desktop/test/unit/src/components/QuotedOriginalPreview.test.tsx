// @vitest-environment happy-dom
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { cleanup, render, type Mounted } from '../../../helpers/render';

/**
 * The "Original Message" under a reply or forward being written.
 *
 * What breaks if this file goes red: opening the composer on a message fetches
 * that message's tracking pixels whatever the reader chose — it rendered with
 * blocking off, so even "Block remote images" told the sender the reply was
 * being written. The quote now follows the one remote-image decision, with the
 * original's own account.
 */

vi.mock('../../../../src/components/email-list/CategoryBadges', () => ({
  getCachedCategorySlugs: () => [] as string[],
  warmCategoryDefs: vi.fn(),
  subscribeCategoryDefs: () => () => {},
  getCategoryDefsVersion: () => 0,
}));
const storeState = { threadEmails: [] as unknown[], threadAccountId: null as string | null, viewAccountId: null as string | null };
vi.mock('../../../../src/store/email-store', () => ({
  useEmailStore: (select: (state: typeof storeState) => unknown) => select(storeState),
}));

const { QuotedOriginalPreview } = await import('../../../../src/components/QuotedOriginalPreview');
const { clearImageAllowedCache, notifyRemoteImageModeChanged } = await import('../../../../src/utils/remote-images');
const { setActiveCacheAccount } = await import('../../../../src/utils/account-scoped-cache');

const HTML = '<p>On Monday, Axis wrote:</p><img src="https://track.example.test/pixel.gif" alt="">';
const ORIGINAL = { fromAddress: 'alerts@axis.bank.in', tags: '|INBOX|', authStatus: null };

let allowed: Record<string, string[]>;
const setMode = (mode: string) => {
  localStorage.setItem('sarvinbox-settings', JSON.stringify({ remoteImageMode: mode }));
  notifyRemoteImageModeChanged();
};
const flush = async () => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); }); };
const loadsRemote = (view: Mounted) => /img-src [^;]*https:/.test((view.find('iframe') as HTMLIFrameElement).srcdoc);

beforeEach(() => {
  allowed = {};
  storeState.threadEmails = [];
  storeState.threadAccountId = null;
  storeState.viewAccountId = null;
  localStorage.clear();
  clearImageAllowedCache();
  setActiveCacheAccount(null);
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    emails: {
      getImageAllowedSenders: vi.fn(async (accountId?: string) => ({ success: true, data: allowed[accountId ?? ''] ?? [] })),
      getEmailedAddresses: vi.fn(async () => ({ success: true, data: [] })),
    },
    spam: { listTrustedSenders: vi.fn(async () => ({ success: true, data: [] })) },
  };
});
afterEach(() => { cleanup(); setActiveCacheAccount(null); });

describe('QuotedOriginalPreview', () => {
  // Breaks: the quote loads the original's pixels under "Block".
  it('blocks the original\'s remote images when the reader chose "Block"', async () => {
    setMode('block');
    const view = render(<QuotedOriginalPreview html={HTML} original={ORIGINAL} />);
    await flush();
    expect(loadsRemote(view)).toBe(false);
    expect(view.container.textContent).toContain('Original Message');
  });

  // Breaks: the quote stops following the reader's choices — "Always load",
  // or a sender they allowed in the original's own account.
  it("loads them when the reader's choice would load the original itself", async () => {
    setMode('always');
    const always = render(<QuotedOriginalPreview html={HTML} original={ORIGINAL} compact />);
    await flush();
    expect(loadsRemote(always)).toBe(true);
    cleanup();

    setMode('block');
    allowed['acct-b'] = ['alerts@axis.bank.in'];
    storeState.viewAccountId = 'acct-b'; // the original is account B's (All Inboxes)
    const allowedInB = render(<QuotedOriginalPreview html={HTML} original={ORIGINAL} />);
    await flush();
    expect(loadsRemote(allowedInB)).toBe(true);
  });
});
