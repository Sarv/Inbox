// @vitest-environment happy-dom
import type { ChatMessage } from '@sarv-in/email-chat-view';
import type { EmailRecord } from '@sarvinbox/core';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { cleanup, fire, render, type Mounted } from '../../../../helpers/render';

import { chatFieldsFor } from './chat-context-fixture';
import { ELEVEN_AM, email, TEN_AM } from './email-fixture';

/**
 * The chat view's per-bubble remote-image decision, against the reader's live
 * trust lists.
 *
 * What breaks if this file goes red: a bubble keeps its "Remote images
 * blocked" banner after the list that allows its sender has loaded (the
 * cold-cache half of the reported bug), or a sender the reader just allowed
 * on the card keeps the banner in the chat — the two renderers disagreeing
 * about one mail. It also pins that the chat decides a unified-view thread
 * against the account it was read from, and that "Load images" clicked on a
 * bubble is remembered (the other half of the reported bug: the library's
 * banner told nobody, so the sender was never saved).
 */

/** The props the app hands the chat library, as far as images go. */
interface ViewProps {
  messages: readonly ChatMessage[];
  blockRemoteImages?: boolean | ((message: ChatMessage) => boolean);
  onLoadRemoteImages?: (message: ChatMessage) => void;
}
/** The latest props the stand-in below was rendered with. */
let lastView: ViewProps | null = null;

// A stand-in for the chat library that shows what the app told it per bubble,
// and offers each bubble the library's own "Load images" button — which, like
// the library's, reports the click with the bubble's message.
vi.mock('@sarv-in/email-chat-view', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  MailChatView: (props: ViewProps) => {
    lastView = props;
    const { messages, blockRemoteImages, onLoadRemoteImages } = props;
    return (
      <div data-testid="chat-view">
        {messages.map((message) => (
          <div
            key={message.id}
            data-testid="bubble"
            data-message-id={message.id}
            data-from={message.fromAddress ?? ''}
            data-block={String(typeof blockRemoteImages === 'function' ? blockRemoteImages(message) : blockRemoteImages)}
          >
            <button type="button" data-testid="load-images" onClick={() => onLoadRemoteImages?.(message)}>
              Load images
            </button>
          </div>
        ))}
      </div>
    );
  },
}));
vi.mock('../../../../../src/components/email-detail/EmailMenu', () => ({ EmailMenu: () => null }));
vi.mock('../../../../../src/components/InlineReply', () => ({ InlineReply: () => null }));
vi.mock('../../../../../src/components/InlineForward', () => ({ InlineForward: () => null }));
vi.mock('../../../../../src/components/attachment-viewer/AttachmentViewer', () => ({ AttachmentViewer: () => null }));
vi.mock('../../../../../src/components/attachment-viewer/useAttachmentActions', () => ({
  useAttachmentActions: () => ({ saveCopy: vi.fn() }),
}));
vi.mock('../../../../../src/services/ai-service', () => ({ getCurrentUserEmail: () => 'me@acme.example' }));
vi.mock('../../../../../src/services/image-cache', () => ({ resolveRefsInHtml: (html: string) => html }));
vi.mock('../../../../../src/components/email-list/CategoryBadges', () => ({
  getCachedCategorySlugs: () => [] as string[],
  warmCategoryDefs: vi.fn(),
  subscribeCategoryDefs: () => () => {},
  getCategoryDefsVersion: () => 0,
}));

const storeState = {
  failedBodies: new Set<string>(),
  fetchEmailBody: vi.fn(),
  markMessageStarred: vi.fn(),
  clearSelectedEmail: vi.fn(),
  viewAccountId: null as string | null,
  // The loaded thread and the account it was read from (`paneAccountOf`).
  threadEmails: [] as EmailRecord[],
  threadAccountId: null as string | null,
};
vi.mock('../../../../../src/store/email-store', () => ({
  useEmailStore: Object.assign(
    (select: (state: typeof storeState) => unknown) => select(storeState),
    { getState: () => storeState, setState: vi.fn() },
  ),
}));

const { ThreadChatView } = await import('../../../../../src/components/email-detail/ThreadChatView');
const {
  clearImageAllowedCache,
  emailedAddresses,
  isSenderImagesAllowed,
  notifyRemoteImageModeChanged,
  PERSIST_RETRY_DELAYS_MS,
  rememberImagesAllowed,
} = await import('../../../../../src/utils/remote-images');
const { resetTrustedSenders } = await import('../../../../../src/utils/trusted-senders');
const { setActiveCacheAccount } = await import('../../../../../src/utils/account-scoped-cache');

const context = (threadEmails: EmailRecord[]) =>
  new Proxy(
    {
      displayEmail: threadEmails[0],
      threadEmails,
      ...chatFieldsFor(threadEmails),
      showAIView: false,
      chatViewActive: true,
      showInlineReply: false,
      showInlineForward: false,
      replyingToEmail: null,
      forwardingEmail: null,
      inlineReplyDraft: null,
      inlineForwardDraft: undefined,
      inlineReplyMode: 'reply',
    } as Record<string, unknown>,
    { get: (target, key) => (key in target ? target[key as string] : vi.fn()) },
  ) as never;

const BANK = email({
  id: 'bank-1', date: TEN_AM, fromName: 'Axis Bank', fromAddress: 'alerts@axis.bank.in',
  messageId: '<b1@axis>', rawBody: '<p>Your statement</p><img src="https://track.example/p.gif">',
});
const ALICE = email({
  id: 'alice-1', date: ELEVEN_AM, fromAddress: 'alice@acme.example',
  messageId: '<a1@acme>', rawBody: '<p>Thanks!</p><img src="https://track.example/q.gif">',
});

let allowed: Record<string, string[]>;
let release: (() => void) | null;

const install = ({ defer = false } = {}) => {
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    emails: {
      getImageAllowedSenders: vi.fn((accountId?: string) => {
        const answer = () => ({ success: true, data: [...(allowed[accountId ?? ''] ?? [])] });
        return defer ? new Promise((resolve) => { release = () => resolve(answer()); }) : Promise.resolve(answer());
      }),
      allowImagesForSender: vi.fn(async (key: string, accountId?: string) => {
        (allowed[accountId ?? ''] ??= []).push(key);
        return { success: true };
      }),
      getEmailedAddresses: vi.fn(async () => ({ success: true, data: [] })),
    },
    spam: { listTrustedSenders: vi.fn(async () => ({ success: true, data: [] })) },
  };
};

const flush = async () => {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
};
const blockOf = (view: Mounted, id: string) =>
  view.find(`[data-testid="bubble"][data-message-id="${id}"]`)?.getAttribute('data-block');

beforeEach(() => {
  allowed = {};
  release = null;
  lastView = null;
  storeState.viewAccountId = null;
  storeState.threadEmails = [];
  storeState.threadAccountId = null;
  localStorage.clear();
  localStorage.setItem('sarvinbox-settings', JSON.stringify({ remoteImageMode: 'block' }));
  notifyRemoteImageModeChanged(); // the mode is read from memory once parsed
  clearImageAllowedCache();
  emailedAddresses.clear();
  resetTrustedSenders();
  setActiveCacheAccount(null);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  setActiveCacheAccount(null);
});

describe('ThreadChatView — remote images', () => {
  // The cold-cache bug, in the chat: the allowlist lands after the bubbles
  // rendered, and the allowed sender's bubble must flip without a remount.
  it('re-decides a bubble when the allowlist finishes loading', async () => {
    install({ defer: true });
    allowed[''] = ['alerts@axis.bank.in'];
    const view = render(<ThreadChatView ctx={context([BANK, ALICE])} />);
    await flush();
    expect(blockOf(view, 'bank-1')).toBe('true');

    await act(async () => { release?.(); });
    await flush();
    expect(blockOf(view, 'bank-1')).toBe('false');
    expect(blockOf(view, 'alice-1')).toBe('true');
  });

  // A sender allowed anywhere (the card's "Load images", the Security page)
  // takes effect on the chat's open bubbles immediately.
  it('applies a newly remembered sender to its open bubbles at once', async () => {
    install();
    const view = render(<ThreadChatView ctx={context([BANK, ALICE])} />);
    await flush();
    expect(blockOf(view, 'alice-1')).toBe('true');

    await act(async () => { rememberImagesAllowed('alice@acme.example'); });
    expect(blockOf(view, 'alice-1')).toBe('false');
    expect(blockOf(view, 'bank-1')).toBe('true');
  });

  // Multi-account: a unified-view thread read from account B is decided on
  // B's allowlist — A's allowance for the same sender does not apply.
  it("decides a unified-view thread against the account it was read from", async () => {
    install();
    allowed['acct-a'] = ['alerts@axis.bank.in'];
    setActiveCacheAccount('acct-a');
    storeState.viewAccountId = 'acct-b';
    const view = render(<ThreadChatView ctx={context([BANK, ALICE])} />);
    await flush();
    expect(blockOf(view, 'bank-1')).toBe('true');

    storeState.viewAccountId = 'acct-a';
    view.rerender(<ThreadChatView ctx={context([BANK, ALICE])} />);
    await flush();
    expect(blockOf(view, 'bank-1')).toBe('false');
  });

  // Breaks: selecting account B's copy of the open conversation (same thread
  // id) moves `viewAccountId` to B at once while the pane still shows A's
  // loaded rows — which were then judged, and remembered, against B's lists.
  // Loaded thread rows belong to the account they were read from.
  it('judges loaded thread rows by the account they were read from, not the live view account', async () => {
    install();
    allowed['acct-a'] = ['alerts@axis.bank.in'];
    setActiveCacheAccount('acct-a');
    storeState.threadEmails = [BANK, ALICE];
    storeState.threadAccountId = 'acct-a';
    storeState.viewAccountId = 'acct-b';
    const view = render(<ThreadChatView ctx={context([BANK, ALICE])} />);
    await flush();
    expect(blockOf(view, 'bank-1')).toBe('false');

    clickLoadImages(view, 'alice-1');
    expect(allowCalls().at(-1)).toEqual(['alice@acme.example', 'acct-a']);
  });
});

// ─────────────────────── "Load images" on a bubble ─────────────────────────

const BANK_LATER = email({
  id: 'bank-2', date: ELEVEN_AM + 1800, fromName: 'Axis Bank', fromAddress: 'alerts@axis.bank.in',
  messageId: '<b2@axis>', rawBody: '<p>A debit of 500</p><img src="https://track.example/r.gif">',
});

/** Bob's reply, quoting Alice: two bubbles, and only Bob's is a mail of its own. */
const CARRIER = email({
  id: 'carrier',
  date: ELEVEN_AM,
  fromName: 'Bob Ray',
  fromAddress: 'bob@acme.example',
  rawBody: [
    '<div dir="ltr">Attached, as promised.<img src="https://track.example/s.gif"></div>',
    '<div class="gmail_quote">',
    '<div dir="ltr" class="gmail_attr">',
    'On Tue, 3 Mar 2026 at 10:00, Alice Chen &lt;alice@acme.example&gt; wrote:<br>',
    '</div>',
    '<blockquote class="gmail_quote"><div dir="ltr">Could you send over the',
    ' signed copy before Friday? Legal need it for the review.</div></blockquote>',
    '</div>',
  ].join(''),
});

const clickLoadImages = (view: Mounted, id: string) =>
  fire(view.find(`[data-testid="bubble"][data-message-id="${id}"] [data-testid="load-images"]`), 'click');
const allowCalls = () =>
  (window.electronAPI.emails.allowImagesForSender as unknown as ReturnType<typeof vi.fn>).mock.calls;

describe('ThreadChatView — "Load images" on a bubble', () => {
  // The reported bug: clicking the chat bubble's own "Load images" was told to
  // nobody, so only that bubble loaded and the sender was never saved. It must
  // be remembered like the card's click: the sender's OTHER bubbles in the open
  // thread load at once, and someone else's stay blocked.
  it("remembers the bubble's sender, so that sender's other bubbles load at once", async () => {
    install();
    const view = render(<ThreadChatView ctx={context([BANK, ALICE, BANK_LATER])} />);
    await flush();
    expect(blockOf(view, 'bank-2')).toBe('true');

    clickLoadImages(view, 'bank-1');

    expect(allowCalls()).toEqual([['alerts@axis.bank.in', undefined]]);
    expect(blockOf(view, 'bank-1')).toBe('false');
    expect(blockOf(view, 'bank-2')).toBe('false');
    expect(blockOf(view, 'alice-1')).toBe('true');
  });

  // Persisted, not just cached: after a relaunch (the renderer cache gone) the
  // sender's NEXT mail auto-loads from the stored list — "future mail".
  it("makes the sender's future mail auto-load after the cache is gone", async () => {
    install();
    const view = render(<ThreadChatView ctx={context([BANK, ALICE])} />);
    await flush();
    clickLoadImages(view, 'bank-1');
    await flush();
    expect(allowed['']).toEqual(['alerts@axis.bank.in']);

    cleanup();
    clearImageAllowedCache();
    const next = render(<ThreadChatView ctx={context([BANK_LATER])} />);
    await flush();
    expect(blockOf(next, 'bank-2')).toBe('false');
  });

  // Multi-account: a unified-view thread read from account B saves the click in
  // B — never the active account A — and a row that names its own account saves
  // it there. Saved in the wrong account, the allowance would widen A's trust
  // and B's banner would come back.
  it("saves the click in the message's own account, never the active one", async () => {
    install();
    setActiveCacheAccount('acct-a');
    storeState.viewAccountId = 'acct-b';
    const view = render(<ThreadChatView ctx={context([BANK, ALICE])} />);
    await flush();

    clickLoadImages(view, 'bank-1');
    await flush();
    expect(allowCalls()).toEqual([['alerts@axis.bank.in', 'acct-b']]);
    expect(isSenderImagesAllowed('alerts@axis.bank.in', 'acct-b')).toBe(true);
    expect(isSenderImagesAllowed('alerts@axis.bank.in', 'acct-a')).toBe(false);
    expect(allowed['acct-a']).toBeUndefined();

    cleanup();
    const own = { ...ALICE, accountId: 'acct-c' } as EmailRecord;
    const second = render(<ThreadChatView ctx={context([own])} />);
    await flush();
    clickLoadImages(second, 'alice-1');
    expect(allowCalls().at(-1)).toEqual(['alice@acme.example', 'acct-c']);
  });

  // A bubble recovered from a quote shows Alice, but its bytes arrived in Bob's
  // mail. Remembering Bob would trust a sender the reader never clicked on;
  // remembering Alice would trust one whose mail was never looked at. The click
  // loads that bubble (the library's part) and remembers nothing.
  it('remembers nothing for a bubble recovered from a quote', async () => {
    install();
    const view = render(<ThreadChatView ctx={context([CARRIER])} />);
    await flush();
    const quoted = view.all('[data-testid="bubble"]').find((el) => el.getAttribute('data-message-id') !== 'carrier')!;
    expect(quoted.getAttribute('data-from')).toBe('alice@acme.example');

    clickLoadImages(view, quoted.getAttribute('data-message-id')!);
    await flush();
    expect(allowCalls()).toEqual([]);
    expect(blockOf(view, 'carrier')).toBe('true');

    // The carrier's own bubble IS Bob's mail: that click is remembered.
    clickLoadImages(view, 'carrier');
    expect(allowCalls()).toEqual([['bob@acme.example', undefined]]);
  });

  // Breaks: a forged From is remembered. The allowlist outranks every guard, so
  // a click on a message in Spam, or on one that failed its sender check,
  // would make every later forgery of that address load its tracking pixels —
  // in every mode. The click loads that bubble (the library's part) and
  // remembers nothing.
  it('remembers nothing for a message in Spam or one that failed its sender check', async () => {
    install();
    const failed = JSON.stringify({ spf: 'fail', dkim: 'fail', dmarc: 'fail', overall: 'fail' });
    const spoof = { ...BANK, authStatus: failed } as EmailRecord;
    const junk = { ...BANK_LATER, tags: '|INBOX.Junk|' } as EmailRecord;
    const view = render(<ThreadChatView ctx={context([spoof, junk])} />);
    await flush();

    clickLoadImages(view, 'bank-1');
    clickLoadImages(view, 'bank-2');
    await flush();
    expect(allowCalls()).toEqual([]);
    expect(isSenderImagesAllowed('alerts@axis.bank.in')).toBe(false);
  });

  // A message whose source mail is not in the thread (no carrier at all) has
  // no sender to remember: nothing is written, and nothing throws.
  it('remembers nothing for a bubble with no mail behind it', async () => {
    install();
    render(<ThreadChatView ctx={context([BANK])} />);
    await flush();
    const ghost = { ...lastView!.messages[0]!, id: 'ghost', sourceId: 'not-in-thread' } as ChatMessage;

    expect(() => act(() => lastView!.onLoadRemoteImages!(ghost))).not.toThrow();
    expect(allowCalls()).toEqual([]);
  });

  // Permanent failure: a click main never stores is withdrawn from the open
  // bubbles too, instead of loading that sender's mail for the session while
  // the database never heard of it (only the clicked bubble keeps its images —
  // the library's own state).
  it('puts the other bubbles back behind the banner when the click is never stored', async () => {
    install();
    const allow = window.electronAPI.emails.allowImagesForSender as unknown as ReturnType<typeof vi.fn>;
    allow.mockResolvedValue({ success: false, error: 'Storage not initialized' });
    const view = render(<ThreadChatView ctx={context([BANK, BANK_LATER])} />);
    await flush();
    vi.useFakeTimers();

    clickLoadImages(view, 'bank-1');
    expect(blockOf(view, 'bank-2')).toBe('false');

    await act(async () => { await vi.advanceTimersByTimeAsync(PERSIST_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0)); });
    expect(allow).toHaveBeenCalledTimes(1 + PERSIST_RETRY_DELAYS_MS.length);
    expect(blockOf(view, 'bank-2')).toBe('true');
  });

  // Transient failure: a blip on the first write is retried, and the sender's
  // bubbles stay loaded once the retry lands — a busy database must not lose
  // the reader's choice.
  it('keeps the allowance when a retry stores it after a transient failure', async () => {
    install();
    const allow = window.electronAPI.emails.allowImagesForSender as unknown as ReturnType<typeof vi.fn>;
    allow.mockResolvedValueOnce({ success: false, error: 'busy' });
    const view = render(<ThreadChatView ctx={context([BANK, BANK_LATER])} />);
    await flush();
    vi.useFakeTimers();

    clickLoadImages(view, 'bank-1');
    await act(async () => { await vi.advanceTimersByTimeAsync(PERSIST_RETRY_DELAYS_MS[0]!); });
    expect(allow).toHaveBeenCalledTimes(2);
    expect(allowed['']).toEqual(['alerts@axis.bank.in']);
    expect(blockOf(view, 'bank-2')).toBe('false');
  });
});
