// @vitest-environment happy-dom
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { cleanup, render, type Mounted } from '../../../helpers/render';

/**
 * The classic card's remote images, against the reader's live trust lists.
 *
 * What breaks if this file goes red — the two halves of the reported bug:
 *  - the first message opened after launch keeps its "Remote images blocked"
 *    banner for a sender the reader already allowed, because the allowlist
 *    warmed in the background and nothing re-rendered when it landed;
 *  - "Load images" on one message does not reach the other open messages from
 *    that sender (or reaches another account's), so the reader clicks it
 *    again, or images load in a mailbox that never approved them.
 */

// The categorized-mail gate reads the badge cache; not under test here.
vi.mock('../../../../src/components/email-list/CategoryBadges', () => ({
  getCachedCategorySlugs: () => [] as string[],
  warmCategoryDefs: vi.fn(),
  subscribeCategoryDefs: () => () => {},
  getCategoryDefsVersion: () => 0,
}));

const { SandboxedEmailBody } = await import('../../../../src/components/SandboxedEmailBody');
const { clearImageAllowedCache, emailedAddresses, isSenderImagesAllowed, notifyRemoteImageModeChanged } = await import('../../../../src/utils/remote-images');
const { resetTrustedSenders } = await import('../../../../src/utils/trusted-senders');
const { setActiveCacheAccount } = await import('../../../../src/utils/account-scoped-cache');
const { clearSenderIdentityCache } = await import('../../../../src/utils/sender-identity');

const HTML = '<p>Hello</p><img src="https://track.example.test/pixel.gif" alt="">';
const PASS = JSON.stringify({ spf: 'pass', dkim: 'pass', dmarc: 'pass', overall: 'pass' });

let allowed: Record<string, string[]>;
let releaseAllowlist: (() => void) | null;
let api: Record<string, Record<string, ReturnType<typeof vi.fn>>>;

const install = ({ deferAllowlist = false } = {}) => {
  api = {
    emails: {
      getImageAllowedSenders: vi.fn((accountId?: string) => {
        const answer = () => ({ success: true, data: [...(allowed[accountId ?? ''] ?? [])] });
        if (!deferAllowlist) return Promise.resolve(answer());
        return new Promise((resolve) => { releaseAllowlist = () => resolve(answer()); });
      }),
      allowImagesForSender: vi.fn(async (key: string, accountId?: string) => {
        (allowed[accountId ?? ''] ??= []).push(key);
        return { success: true };
      }),
      getEmailedAddresses: vi.fn(async () => ({ success: true, data: [] })),
    },
    spam: { listTrustedSenders: vi.fn(async () => ({ success: true, data: [] })) },
    identity: {
      getSender: vi.fn(async (address: string) => ({
        success: true,
        data: { address, domain: 'brand.test', bimi: { status: 'verified', logo: null, organization: 'Brand', issuer: 'MVA', detail: '', dmarcPolicy: 'reject', expires: null }, favicon: null, faviconStatus: null, contactPhoto: null, pending: false },
      })),
      onUpdated: vi.fn(),
    },
  };
  (window as unknown as { electronAPI: unknown }).electronAPI = api;
};

/** Choose a mode as another writer would, and say so — the parsed mode is kept
 *  in memory and re-read only when told the settings changed. */
const setMode = (mode: string) => {
  localStorage.setItem('sarvinbox-settings', JSON.stringify({ remoteImageMode: mode }));
  notifyRemoteImageModeChanged();
};

/** Let queued loads land and React re-render. */
const flush = async () => {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
};

const banners = (view: Mounted) => view.all('button').filter((b) => b.textContent === 'Load images');
const frames = (view: Mounted) => view.all('iframe') as HTMLIFrameElement[];
/** Whether a frame's CSP lets remote images through. */
const loadsRemote = (frame: HTMLIFrameElement) => /img-src [^;]*https:/.test(frame.srcdoc);

beforeEach(() => {
  allowed = {};
  releaseAllowlist = null;
  localStorage.clear();
  setMode('block');
  clearImageAllowedCache();
  emailedAddresses.clear();
  resetTrustedSenders();
  clearSenderIdentityCache();
  setActiveCacheAccount(null);
});

afterEach(() => {
  cleanup();
  setActiveCacheAccount(null);
});

describe('SandboxedEmailBody — remote images', () => {
  // THE cold-cache bug: the allowlist arrives AFTER the message rendered. The
  // open message must re-decide when it lands, not keep the banner until the
  // reader navigates away and back.
  it('re-renders an open message when the allowlist finishes loading', async () => {
    install({ deferAllowlist: true });
    allowed[''] = ['boss@x.test'];
    const view = render(<SandboxedEmailBody html={HTML} remoteImagesFrom={{ fromAddress: 'boss@x.test', tags: '|INBOX|' }} />);
    await flush();
    expect(banners(view)).toHaveLength(1);
    expect(loadsRemote(frames(view)[0])).toBe(false);

    await act(async () => { releaseAllowlist?.(); });
    await flush();
    expect(banners(view)).toHaveLength(0);
    expect(loadsRemote(frames(view)[0])).toBe(true);
  });

  // The other half: "Load images" remembers the sender, and every OTHER open
  // message from that sender loads at once — without its own click.
  it('applies "Load images" to every open message from that sender immediately', async () => {
    install();
    const view = render(
      <>
        <SandboxedEmailBody html={HTML} remoteImagesFrom={{ fromAddress: 'alerts@axis.bank.in' }} />
        <SandboxedEmailBody html={`${HTML}<p>2</p>`} remoteImagesFrom={{ fromAddress: 'Axis <ALERTS@axis.bank.in>' }} />
        <SandboxedEmailBody html={`${HTML}<p>3</p>`} remoteImagesFrom={{ fromAddress: 'someone@else.test' }} />
      </>,
    );
    await flush();
    expect(banners(view)).toHaveLength(3);

    await act(async () => { banners(view)[0].click(); });
    await flush();
    expect(api.emails.allowImagesForSender).toHaveBeenCalledWith('alerts@axis.bank.in', undefined);
    const [clicked, sameSender, other] = frames(view);
    expect(loadsRemote(clicked)).toBe(true);
    expect(loadsRemote(sameSender)).toBe(true);
    expect(loadsRemote(other)).toBe(false);
    expect(banners(view)).toHaveLength(1);
  });

  // Multi-account: "Load images" on account A's message (unified view) is
  // remembered in A — B's copy of mail from the same sender stays blocked.
  it("remembers in the message's own account and leaves other accounts blocked", async () => {
    install();
    setActiveCacheAccount('acct-a');
    const view = render(
      <>
        <SandboxedEmailBody html={HTML} remoteImagesFrom={{ fromAddress: 'boss@x.test', accountId: 'acct-b' }} />
        <SandboxedEmailBody html={`${HTML}<p>2</p>`} remoteImagesFrom={{ fromAddress: 'boss@x.test', accountId: 'acct-a' }} />
      </>,
    );
    await flush();
    await act(async () => { banners(view)[0].click(); });
    await flush();
    expect(api.emails.allowImagesForSender).toHaveBeenCalledWith('boss@x.test', 'acct-b');
    const [inB, inA] = frames(view);
    expect(loadsRemote(inB)).toBe(true);
    expect(loadsRemote(inA)).toBe(false);
    expect(allowed['acct-b']).toEqual(['boss@x.test']);
    expect(allowed['acct-a']).toBeUndefined();
  });

  // Trusted senders only: a verified brand's identity lookup lands after render —
  // the message must pick it up then, and a spoof of that brand must not.
  it("loads a verified brand's mail once its identity lands, but never a spoof of it", async () => {
    install();
    setMode('trusted');
    const view = render(
      <>
        <SandboxedEmailBody html={HTML} remoteImagesFrom={{ fromAddress: 'news@brand.test', authStatus: PASS }} />
        <SandboxedEmailBody html={`${HTML}<p>2</p>`} remoteImagesFrom={{ fromAddress: 'news@brand.test', authStatus: JSON.stringify({ dmarc: 'fail', overall: 'fail' }) }} />
      </>,
    );
    await flush();
    await flush();
    const [real, spoof] = frames(view);
    expect(loadsRemote(real)).toBe(true);
    expect(loadsRemote(spoof)).toBe(false);
  });

  // Breaks: a mode chosen elsewhere (the Security page, another window of the
  // app) leaves open messages decided under the old mode.
  it('re-decides open messages when the mode changes', async () => {
    install();
    const { saveRemoteImageMode } = await import('../../../../src/utils/remote-images');
    const view = render(<SandboxedEmailBody html={HTML} remoteImagesFrom={{ fromAddress: 'a@x.test' }} />);
    await flush();
    expect(loadsRemote(frames(view)[0])).toBe(false);

    await act(async () => { saveRemoteImageMode('always'); });
    expect(loadsRemote(frames(view)[0])).toBe(true);

    // Written by another window: only the storage event says so.
    localStorage.setItem('sarvinbox-settings', JSON.stringify({ remoteImageMode: 'block' }));
    await act(async () => {
      const storageEvent = new StorageEvent('storage');
      Object.defineProperty(storageEvent, 'key', { value: 'sarvinbox-settings' });
      window.dispatchEvent(storageEvent);
    });
    expect(loadsRemote(frames(view)[0])).toBe(false);
  });

  // Breaks: "Load images" on a forgery remembers the forged From — and the
  // allowlist outranks every guard, so every later forgery of that address
  // would load its tracking pixels in every mode. The clicked message still
  // shows its images this once; nothing is remembered.
  it('loads a Spam or failed-authentication message once without remembering its sender', async () => {
    install();
    const failed = JSON.stringify({ spf: 'fail', dkim: 'fail', dmarc: 'fail', overall: 'fail' });
    const view = render(
      <>
        <SandboxedEmailBody html={HTML} remoteImagesFrom={{ fromAddress: 'alerts@axis.bank.in', authStatus: failed }} />
        <SandboxedEmailBody html={`${HTML}<p>2</p>`} remoteImagesFrom={{ fromAddress: 'alerts@axis.bank.in', tags: '|[Gmail]/Spam|' }} />
        <SandboxedEmailBody html={`${HTML}<p>3</p>`} remoteImagesFrom={{ fromAddress: 'alerts@axis.bank.in', authStatus: PASS }} />
      </>,
    );
    await flush();
    await act(async () => { banners(view)[0].click(); });
    await act(async () => { banners(view)[0].click(); }); // the Spam one, now first
    await flush();
    const [spoof, spam, genuine] = frames(view);
    expect(loadsRemote(spoof)).toBe(true);
    expect(loadsRemote(spam)).toBe(true);
    expect(loadsRemote(genuine)).toBe(false);
    expect(api.emails.allowImagesForSender).not.toHaveBeenCalled();
    expect(isSenderImagesAllowed('alerts@axis.bank.in')).toBe(false);
  });

  // The app's own content (signatures, quotes, previews) never asks the trust
  // lists — no IPC — and always renders its images.
  it('does not consult the trust lists for content the app itself wrote', async () => {
    install();
    const view = render(<SandboxedEmailBody html={HTML} blockRemoteImages={false} />);
    await flush();
    expect(api.emails.getImageAllowedSenders).not.toHaveBeenCalled();
    expect(loadsRemote(frames(view)[0])).toBe(true);
    expect(banners(view)).toHaveLength(0);
  });
});
