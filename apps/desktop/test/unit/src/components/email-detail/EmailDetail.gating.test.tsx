// @vitest-environment happy-dom
import type { EmailRecord } from '@sarvinbox/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { firstEmailFacts } from '../../../../../src/components/email-detail/ai-view-compose';
import { render, settle, toggle, type Mounted } from '../../../../helpers/render';

import { ELEVEN_AM, email } from './email-fixture';
import { ALICE_TEXT, LOOPED_AT, LOOPED_IN_BODY } from './looped-in-fixture';

/**
 * Whether the reading pane shows a card, a list or the chat — through the REAL
 * useEmailDetail and the one set of chat rules every site reads.
 *
 * What breaks if this file goes red: the card and the chat render together
 * (the same mail twice, two reply rows); a looped-in chain that quotes two or
 * more messages is left as a wall of quoted text because its markup trips a
 * "designed mail" regex; a reply quoting ONE message is reshaped into a chat
 * unasked, or is never offered the chat at all; or a designed newsletter that
 * quotes itself is offered a chat view it has no use for.
 */

// The pane's children stand in, each recording what it was handed.
const seen = {
  cardChatActive: [] as boolean[],
  chatViews: 0,
  threadLists: 0,
  prewarm: [] as boolean[],
};
vi.mock('../../../../../src/components/email-detail/EmailCard', () => ({
  // The real card hides itself on `chatViewActive` (className "hidden").
  EmailCard: ({ ctx }: { ctx: { chatViewActive: boolean } }) => {
    seen.cardChatActive.push(ctx.chatViewActive);
    return <div data-testid="email-card" data-hidden={String(ctx.chatViewActive)} />;
  },
}));
vi.mock('../../../../../src/components/email-detail/ThreadChatView', () => ({
  ThreadChatView: () => {
    seen.chatViews += 1;
    return <div data-testid="thread-chat-view" />;
  },
}));
vi.mock('../../../../../src/components/email-detail/ThreadList', () => ({
  ThreadList: () => {
    seen.threadLists += 1;
    return <div data-testid="thread-list" />;
  },
}));
vi.mock('../../../../../src/components/email-detail/chat-prewarm', () => ({
  useChatPrewarm: ({ enabled }: { enabled: boolean }) => {
    seen.prewarm.push(enabled);
  },
}));
vi.mock('../../../../../src/components/email-detail/EmailToolbar', () => ({ EmailToolbar: () => null }));
vi.mock('../../../../../src/components/email-detail/FollowUpBanner', () => ({ FollowUpBanner: () => null }));
vi.mock('../../../../../src/components/email-detail/ShowOriginalModal', () => ({ ShowOriginalModal: () => null }));
vi.mock('../../../../../src/components/email-detail/SignatureDetectionModal', () => ({
  SignatureDetectionModal: () => null,
}));
vi.mock('../../../../../src/components/ThreadSummary', () => ({ ThreadSummary: () => null }));
vi.mock('../../../../../src/components/LabelChips', () => ({ LabelChips: () => null }));
vi.mock('../../../../../src/components/InlineReply', () => ({ InlineReply: () => null }));
vi.mock('../../../../../src/components/InlineForward', () => ({ InlineForward: () => null }));

const PROVIDER = { id: 'p1', type: 'openai', model: 'gpt-x', name: 'P', apiKey: 'k', isDefault: true };
vi.mock('../../../../../src/services/ai-service', () => ({
  getDefaultProvider: () => PROVIDER,
  getAIHealth: () => ({ healthy: true, reason: '' }),
  getCurrentUserEmail: () => 'me@acme.example',
  buildPolishThreadContext: () => '',
  detectSignature: vi.fn(),
  makeAICompletion: vi.fn(),
  loadAIFeatures: () => [],
}));
// The reader's settings: conversation mode on, chat view opens by itself.
vi.mock('../../../../../src/services/ai-features', () => ({
  isConversationModeEnabled: () => true,
  isAutoChatViewEnabled: () => true,
  isAutoChatExtractEnabled: () => false,
}));
vi.mock('../../../../../src/services/image-cache', () => ({
  populateCacheFromHtml: vi.fn(),
  resolveRefsInHtml: (html: string) => html,
  registerImage: vi.fn(),
}));
vi.mock('../../../../../src/utils/compose-attachments', () => ({
  loadEmailAttachments: async () => [],
}));
vi.mock('../../../../../src/store/helpers', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  accountDisplayLabel: () => '',
}));

/** A looped-in chain quoting three messages, inside designed markup (a
 *  stylesheet, a presentation table with a bgcolor) — what the old
 *  `isDesignedHtmlEmail` regex refused to open as chat. Sent by a person. */
const DESIGNED_LOOPED_IN = email({
  id: 'looped',
  date: LOOPED_AT,
  fromAddress: 'dan@acme.example',
  fromName: 'Dan Moss',
  tags: '|INBOX|read|',
  rawBody: [
    '<style>p { margin: 0 }</style>',
    '<table role="presentation" bgcolor="#ffffff"><tr><td>',
    LOOPED_IN_BODY,
    '</td></tr></table>',
  ].join(''),
});

/** A plain reply quoting ONE earlier message. */
const SINGLE_QUOTE = email({
  id: 'single',
  date: LOOPED_AT,
  fromAddress: 'dan@acme.example',
  fromName: 'Dan Moss',
  tags: '|INBOX|read|',
  rawBody: [
    '<div dir="ltr">Sounds good.</div>',
    '<div class="gmail_quote"><div dir="ltr" class="gmail_attr">',
    'On Tue, 3 Mar 2026 at 10:00, Alice Chen &lt;alice@acme.example&gt; wrote:<br></div>',
    `<blockquote class="gmail_quote"><div dir="ltr">${ALICE_TEXT}</div></blockquote></div>`,
  ].join(''),
});

/** A designed, machine-sent alert that quotes an earlier alert of its own. */
const BULK_ALERT = email({
  id: 'alert',
  date: LOOPED_AT,
  fromName: 'Sarv Digital',
  fromAddress: 'no-reply@digtalmarketing.in',
  tags: '|INBOX|bulk|read|',
  rawBody: [
    '<table width="600" bgcolor="#ffffff" role="presentation"><tr><td bgcolor="#2563eb">',
    '<h1>New Login Detected</h1><img src="https://cdn.example.test/logo.png" alt="logo">',
    '</td></tr></table>',
    '<div class="gmail_quote"><div dir="ltr" class="gmail_attr">',
    'On Tue, 3 Mar 2026 at 09:00, Sarv Digital &lt;no-reply@digtalmarketing.in&gt; wrote:<br>',
    '</div><blockquote class="gmail_quote">',
    '<div dir="ltr">A previous login was detected from another device in another city.</div>',
    '</blockquote></div>',
  ].join(''),
});

const baseState = (single: EmailRecord) => ({
  emails: [single],
  folders: [{ id: 'f1', path: 'INBOX', name: 'INBOX', specialUse: null }],
  selectedFolderId: 'f1',
  selectedEmailId: single.id as string | null,
  selectEmail: vi.fn(),
  threadEmails: [single] as EmailRecord[],
  threadAccountId: 'acct-a',
  loadingThread: false,
  markAsRead: vi.fn(async () => {}),
  deleteEmail: vi.fn(),
  archiveEmail: vi.fn(),
  bulkRemoveEmails: vi.fn(),
  moveToSpam: vi.fn(),
  moveFromSpam: vi.fn(),
  clearSelectedEmail: vi.fn(),
  manuallyMarkedUnreadId: null,
  openCompose: vi.fn(),
  editDraftInComposer: vi.fn(),
  searchResults: [],
  searchQuery: '',
  viewingAICategory: null,
  aiBoxActiveTab: null,
  setEmails: vi.fn(),
  fetchEmailBody: vi.fn(),
  loadingBodies: new Set<string>(),
  failedBodies: new Set<string>(),
  snoozeEmail: vi.fn(),
  unsnoozeEmail: vi.fn(),
  markAsStarred: vi.fn(),
  setEmailLabel: vi.fn(),
  restoreDraft: null,
  clearRestoreDraft: vi.fn(),
  pendingSend: [],
  viewAccountId: null,
  selectedVirtualFolder: null,
  accounts: [],
  pendingThreadEmailIds: [] as string[],
  showPendingThreadMessages: vi.fn(),
  dismissPendingThreadMessages: vi.fn(),
  getNavigationThreads: () => [],
  getNavigationTotalCount: () => 0,
  _accountIdFor: () => undefined,
});
let state = baseState(SINGLE_QUOTE);

vi.mock('../../../../../src/store/email-store', () => ({
  useEmailStore: Object.assign(
    (select?: (s: typeof state) => unknown) => (select ? select(state) : state),
    {
      getState: () => state,
      setState: (patch: Partial<typeof state>) => {
        state = { ...state, ...patch };
      },
    },
  ),
}));

const { EmailDetail } = await import('../../../../../src/components/email-detail/EmailDetail');

let mounted: Mounted | undefined;
const open = async (single: EmailRecord, extra: EmailRecord[] = []) => {
  state = baseState(single);
  state.threadEmails = [single, ...extra];
  state.emails = [single, ...extra];
  mounted = render(<EmailDetail />);
  for (let i = 0; i < 3; i++) await settle();
  return mounted;
};
const card = (view: Mounted) => view.container.querySelector('[data-testid="email-card"]');
const chat = (view: Mounted) => view.container.querySelector('[data-testid="thread-chat-view"]');
const list = (view: Mounted) => view.container.querySelector('[data-testid="thread-list"]');
const toggleButton = (view: Mounted, name: string) => view.container.querySelector(`[aria-label="${name}"]`);

beforeEach(() => {
  seen.cardChatActive.length = 0;
  seen.chatViews = 0;
  seen.threadLists = 0;
  seen.prewarm.length = 0;
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    drafts: { findForThread: async () => ({ success: false }) },
    agent: { getProposals: async () => ({ success: true, data: [] }) },
    // No cached split and no source: nothing runs here, this file is the gating.
    ai: { getFirstSplit: async () => ({ success: false, error: 'not in this test' }) },
  };
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  mounted?.unmount();
  mounted = undefined;
  vi.restoreAllMocks();
});

describe('EmailDetail — which surface a single email gets', () => {
  // Preconditions: the fixtures ARE what their names say, by the real facts.
  it('uses fixtures the facts classify as named', () => {
    expect(firstEmailFacts(DESIGNED_LOOPED_IN, 1)).toMatchObject({ kind: 'known', asSent: false, quoteCount: 3 });
    expect(firstEmailFacts(SINGLE_QUOTE, 1)).toMatchObject({ kind: 'known', asSent: false, quoteCount: 1 });
    expect(firstEmailFacts(BULK_ALERT, 1)).toMatchObject({ kind: 'known', asSent: true });
  });

  // Decision 3: a looped-in chain quoting 2+ messages opens in chat by itself
  // — designed markup or not (the as-sent rule replaced the regex) — and the
  // card and the chat never render together.
  it('opens a designed, non-bulk looped-in email quoting 2+ messages as chat, and hides the card', async () => {
    const view = await open(DESIGNED_LOOPED_IN);
    expect(chat(view)).not.toBeNull();
    expect(card(view)!.getAttribute('data-hidden')).toBe('true');
    expect(toggleButton(view, 'Chat view')!.getAttribute('aria-pressed')).toBe('true');
  });

  // Decision 2: ONE quoted message — the toggle is offered, the email stays a
  // card until the reader picks Chat; then it is the chat, card hidden.
  it('offers chat for a single-quote email and keeps it a card until toggled', async () => {
    const view = await open(SINGLE_QUOTE);
    expect(chat(view)).toBeNull();
    // A single email in the List view IS its card — no one-item list under it.
    expect(list(view)).toBeNull();
    expect(card(view)!.getAttribute('data-hidden')).toBe('false');
    expect(toggleButton(view, 'List view')!.getAttribute('aria-pressed')).toBe('true');
    // Offered and not showing: the chat split is warmed in the background.
    expect(seen.prewarm.at(-1)).toBe(true);

    toggle(toggleButton(view, 'Chat view'));
    await settle();
    expect(chat(view)).not.toBeNull();
    expect(card(view)!.getAttribute('data-hidden')).toBe('true');
    expect(seen.prewarm.at(-1)).toBe(false);

    toggle(toggleButton(view, 'List view'));
    await settle();
    expect(chat(view)).toBeNull();
    expect(card(view)!.getAttribute('data-hidden')).toBe('false');
  });

  // Designed bulk mail that quotes itself is shown as sent: no toggle, no chat.
  it('offers no toggle for as-sent bulk mail', async () => {
    const view = await open(BULK_ALERT);
    expect(list(view)).toBeNull();
    expect(toggleButton(view, 'Chat view')).toBeNull();
    expect(toggleButton(view, 'List view')).toBeNull();
    expect(chat(view)).toBeNull();
    expect(card(view)!.getAttribute('data-hidden')).toBe('false');
    expect(seen.prewarm.every((enabled) => !enabled)).toBe(true);
  });

  // The switch is two icon buttons: named for assistive tech, pressed state
  // saying which is on.
  it('exposes the List/Chat buttons by name', async () => {
    const view = await open(SINGLE_QUOTE);
    expect(toggleButton(view, 'List view')!.tagName).toBe('BUTTON');
    expect(toggleButton(view, 'Chat view')!.tagName).toBe('BUTTON');
  });
});

describe('EmailDetail — while a thread loads', () => {
  // The list row already says the thread holds several messages: chat
  // pre-shows (a spinner in its place, the card hidden) instead of flashing
  // the card and then snapping to chat.
  it('pre-shows the chat for a known multi-message thread, spinner in its place', async () => {
    state = baseState(SINGLE_QUOTE);
    state.emails = [{ ...SINGLE_QUOTE, threadMessageCount: 3 } as EmailRecord];
    state.threadEmails = [];
    state.loadingThread = true;
    mounted = render(<EmailDetail />);
    for (let i = 0; i < 3; i++) await settle();
    expect(card(mounted)!.getAttribute('data-hidden')).toBe('true');
    expect(mounted.container.querySelector('.animate-spin')).not.toBeNull();
    expect(chat(mounted)).toBeNull();
  });

  // …and never for a single email: its card stays, no spinner under it.
  it('keeps a single email a card while it loads', async () => {
    state = baseState(SINGLE_QUOTE);
    state.threadEmails = [];
    state.loadingThread = true;
    mounted = render(<EmailDetail />);
    for (let i = 0; i < 3; i++) await settle();
    expect(card(mounted)!.getAttribute('data-hidden')).toBe('false');
    expect(mounted.container.querySelector('.animate-spin')).toBeNull();
  });
});

describe('EmailDetail — a real thread', () => {
  const REPLY = email({
    id: 'reply',
    date: ELEVEN_AM + 86_400 * 2,
    fromAddress: 'bob@acme.example',
    fromName: 'Bob Ray',
    tags: '|INBOX|read|',
    rawBody: '<p>Got it.</p>',
  });

  // Two members: chat is offered and — with the chat setting on — it IS the
  // reading surface; the list is not mounted beside it.
  it('reads a two-message thread in chat with the setting on, never beside the list', async () => {
    const view = await open(SINGLE_QUOTE, [REPLY]);
    expect(chat(view)).not.toBeNull();
    expect(list(view)).toBeNull();
    expect(card(view)!.getAttribute('data-hidden')).toBe('true');

    toggle(toggleButton(view, 'List view'));
    await settle();
    expect(chat(view)).toBeNull();
    expect(list(view)).not.toBeNull();
  });
});
