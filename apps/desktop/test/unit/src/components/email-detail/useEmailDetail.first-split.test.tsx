// @vitest-environment happy-dom
import type { EmailRecord } from '@sarvinbox/core';
import { firstMemberKeyOf, type FirstSplitGetResult, type FirstSplitRow } from '@sarvinbox/core/first-split';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { EmailDetailContext } from '../../../../../src/components/email-detail/types';
import { resetFirstSplitStoreForTests } from '../../../../../src/services/first-split/store';
import { act, render, settle, type Mounted } from '../../../../helpers/render';

import { splitRow } from './chat-context-fixture';
import { email, ME } from './email-fixture';
import { ALICE_TEXT, LOOPED_AT, loopedInEmail, loopedInParts, OUTLOOK_PLAIN_BODY } from './looped-in-fixture';

/**
 * The reading pane's wiring of the first email's split (`useEmailDetail`): the
 * rules every site reads, the account its cache calls name, the turns the
 * chat view shows, and the one reply-polish transcript.
 *
 * What breaks if this file goes red: the cache is read in the ACTIVE account
 * for a thread opened from another one (the same thread id lives in every
 * account), the chat view shows the AI list on the Standard half, the polish
 * transcript is rebuilt on every keystroke of an unrelated render, or it loses
 * the looped-in history the split recovered.
 */

const PROVIDER = { id: 'p1', type: 'openai', model: 'gpt-x', name: 'P', apiKey: 'k', isDefault: true };
const settings = { autoChatView: true };
// Unhealthy by default: nothing may start an AI run unless a test says so —
// only the "when the split runs by itself" block turns it on.
const health = { healthy: false };
// Every read of the AI settings (each one parses localStorage in the app).
const providerReads = { count: 0 };

vi.mock('../../../../../src/services/ai-service', () => ({
  getDefaultProvider: () => {
    providerReads.count += 1;
    return PROVIDER;
  },
  getAIHealth: () => ({ healthy: health.healthy, reason: 'test' }),
  getCurrentUserEmail: () => 'me@acme.example',
  buildPolishThreadContext: (args: { entries: Array<{ sender: string; body: string }> }) =>
    args.entries.map((entry) => `[${entry.sender}] ${entry.body.replace(/<[^>]+>/g, '')}`).join('\n\n'),
  detectSignature: vi.fn(),
  makeAICompletion: vi.fn(),
  loadAIFeatures: () => [],
}));
vi.mock('../../../../../src/services/ai-features', () => ({
  isConversationModeEnabled: () => true,
  isAutoChatViewEnabled: () => settings.autoChatView,
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

/** An Outlook chain in plain <div>s: Standard shows it as ONE bubble (the
 *  library sees no boundary), the split recovers the messages it quotes. */
const FIRST = loopedInEmail({ tags: '|INBOX|read|', rawBody: OUTLOOK_PLAIN_BODY });
const REPLY = email({
  id: 'e2',
  date: LOOPED_AT + 3600,
  fromName: 'Bob Ray',
  fromAddress: 'bob@acme.example',
  tags: '|INBOX|read|',
  rawBody: '<p>Thanks Dan, I will bring the forecast.</p>',
});

/** The key fields of `first`'s stored row, as main would write them. */
const rowKeyOf = (first: EmailRecord) => ({
  threadId: first.threadId,
  firstKey: firstMemberKeyOf(first),
  firstEmailId: first.id,
  sourceFingerprint: 'fp',
});

/** Main's answer for `first`: its current key, and whatever row it holds (a miss for none). */
const answerFor = (first: EmailRecord, row: FirstSplitRow | null, memberCount = 2): FirstSplitGetResult => ({
  row,
  current: {
    threadId: first.threadId,
    firstKey: firstMemberKeyOf(first),
    firstEmailId: first.id,
    fingerprint: 'fp',
    memberCount,
    distinctSenders: memberCount,
  },
});

/** Main's answer for FIRST: its key, and (optionally) a usable split of it. */
const answer = (usable: boolean): FirstSplitGetResult =>
  answerFor(FIRST, usable ? splitRow(loopedInParts(), rowKeyOf(FIRST)) : null);

/** A stored transient failure for FIRST that falls due at `nextRetryAt` (unix seconds). */
const transientRow = (nextRetryAt: number): FirstSplitRow => splitRow([], {
  ...rowKeyOf(FIRST),
  status: 'transient',
  parts: null,
  quoteCount: null,
  errorKind: 'network',
  attempts: 1,
  nextRetryAt,
});

/** A plain reply quoting ONE earlier message: offered the chat, split only on demand. */
const SINGLE_QUOTE = email({
  id: 'single',
  threadId: 'ts',
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

/** The split runs the store starts: each begins with main's source read (`withSource`). */
const runsStarted = () =>
  getFirstSplit.mock.calls.filter((call) => (call[2] as { withSource?: boolean } | undefined)?.withSource).length;

let getFirstSplit: ReturnType<typeof vi.fn>;
const baseState = () => ({
  emails: [FIRST, REPLY],
  folders: [{ id: 'f1', path: 'INBOX', name: 'INBOX', specialUse: null }],
  selectedFolderId: 'f1',
  selectedEmailId: 'e2' as string | null,
  selectEmail: vi.fn(),
  threadEmails: [FIRST, REPLY] as EmailRecord[],
  threadAccountId: 'acct-b' as string | null,
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
  viewAccountId: 'acct-b',
  getNavigationThreads: () => [],
  getNavigationTotalCount: () => 0,
  _accountIdFor: () => undefined,
});
let state = baseState();

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

const { useEmailDetail } = await import(
  '../../../../../src/components/email-detail/hooks/useEmailDetail'
);

let latest: EmailDetailContext | null = null;
function Harness() {
  latest = useEmailDetail();
  return null;
}
const ctx = () => latest!;

let mounted: Mounted | undefined;
const mount = async () => {
  mounted = render(<Harness />);
  for (let i = 0; i < 4; i++) await settle();
};

beforeEach(() => {
  resetFirstSplitStoreForTests();
  state = baseState();
  settings.autoChatView = true;
  health.healthy = false;
  latest = null;
  getFirstSplit = vi.fn(async () => ({ success: true, data: answer(true) }));
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    drafts: { findForThread: async () => ({ success: false }) },
    agent: { getProposals: async () => ({ success: true, data: [] }) },
    ai: { getFirstSplit },
  };
});
afterEach(() => {
  mounted?.unmount();
  mounted = undefined;
});

describe('useEmailDetail — the first email\'s split', () => {
  // I7: the cache is read in the account the thread was LOADED from — here a
  // non-active account opened from the unified view.
  it('reads the cache with the thread\'s account', async () => {
    await mount();
    expect(getFirstSplit).toHaveBeenCalledWith('acct-b', FIRST.threadId, undefined);
    expect(ctx().firstEmail?.id).toBe('e1');
    expect(ctx().firstSplit.usable).toBe(true);
  });

  // No stamped account: no cache call at all (never "the active one").
  it('makes no cache call without a thread account', async () => {
    state.threadAccountId = null;
    await mount();
    expect(getFirstSplit).not.toHaveBeenCalled();
    expect(ctx().firstSplit.state).toBe('unknown');
  });

  // A single email that quotes nothing (a newsletter, an OTP) is never
  // offered the chat, so its split is never read: no IPC for it. A single
  // looped-in email IS offered (on demand), so its cache is read.
  it('reads the cache only for a thread offered the chat view', async () => {
    const plain = email({ id: 'n1', threadId: 'tn', tags: '|INBOX|read|', rawBody: '<p>Your code is 123456.</p>' });
    state.threadEmails = [plain];
    state.emails = [plain];
    state.selectedEmailId = 'n1';
    await mount();
    expect(ctx().chatRules.offerChat).toBe(false);
    expect(getFirstSplit).not.toHaveBeenCalled();

    mounted!.unmount();
    mounted = undefined;
    state = baseState();
    state.threadEmails = [FIRST];
    state.emails = [FIRST];
    state.selectedEmailId = 'e1';
    await mount();
    expect(ctx().chatRules.offerChat).toBe(true);
    expect(getFirstSplit).toHaveBeenCalledWith('acct-b', FIRST.threadId, undefined);
  });

  // Standard's turns are always there for the chat; the AI turns are the
  // first email's slot replaced — later emails untouched.
  it('hands the chat Standard\'s turns and the AI composition', async () => {
    await mount();
    expect(ctx().chatRules.chatActive).toBe(true);
    expect(ctx().chatRules.showAiToggle).toBe(true);
    const standardIds = ctx().standardTurns!.turns.map((turn) => turn.id);
    const aiIds = ctx().aiTurns!.map((turn) => turn.id);
    expect(aiIds).toEqual(['e1#ai1', 'e1#ai2', 'e1#ai3', 'e1', 'e2']);
    expect(standardIds).toContain('e2');
    // The later reply is Standard's own object.
    const standardReply = ctx().standardTurns!.turns.find((turn) => turn.id === 'e2');
    expect(ctx().aiTurns!.find((turn) => turn.id === 'e2')).toBe(standardReply);
  });

  // The List view with no composer open: nothing splits the thread for the
  // chat (it is not on screen), and no transcript is built.
  it('builds no Standard turns and no transcript in the List view with no composer', async () => {
    settings.autoChatView = false;
    await mount();
    expect(ctx().chatRules.chatActive).toBe(false);
    expect(ctx().standardTurns).toBeNull();
    expect(ctx().aiTurns).toBeNull();
    expect(ctx().polishThreadContext).toBe('');
  });

  // Reply polish: built only while a composer is open, from the AI
  // composition when a usable split exists — the looped-in history as the
  // messages it quotes, newest last.
  it('builds the polish transcript from the AI composition once a reply opens', async () => {
    await mount();
    expect(ctx().polishThreadContext).toBe('');
    act(() => ctx().handleReply());
    await settle();
    const transcript = ctx().polishThreadContext;
    // Each quoted message under its own sender — not one wall under Dan's name.
    expect(transcript).toContain(`[Alice Chen] ${ALICE_TEXT}`);
    expect(transcript).toContain('[Carol Diaz] ');
    expect(transcript.split('\n\n').at(-1)).toContain('bring the forecast');
    expect(transcript.split(ALICE_TEXT)).toHaveLength(2);
  });

  // …and from Standard's turns without a split, in the List view too.
  it('builds it from Standard\'s turns without a split, list view included', async () => {
    settings.autoChatView = false;
    getFirstSplit.mockImplementation(async () => ({ success: true, data: answer(false) }));
    await mount();
    act(() => ctx().handleReply());
    await settle();
    expect(ctx().standardTurns).not.toBeNull();
    expect(ctx().aiTurns).toBeNull();
    const transcript = ctx().polishThreadContext;
    expect(transcript).toContain('bring the forecast');
    // Standard's one bubble for the chain: its history under Dan's name.
    expect(transcript).not.toContain('[Alice Chen]');
    expect(transcript).toContain(ALICE_TEXT);
  });

  // The pane re-renders on every store change during a sync. Reading the AI
  // settings (a localStorage parse) on each of those renders is main-thread
  // work that grows with the sync, so they are read once per opened email and
  // once per cache answer — not per render.
  it('does not re-read the AI settings on re-renders of the same email', async () => {
    await mount();
    const before = providerReads.count;
    for (let i = 0; i < 5; i++) mounted!.rerender(<Harness />);
    await settle();
    expect(providerReads.count).toBe(before);
    // A different email is read afresh.
    state = { ...state, selectedEmailId: 'e1' };
    mounted!.rerender(<Harness />);
    expect(providerReads.count).toBeGreaterThan(before);
  });

  // The toggle is an explicit choice: chat on (on Standard), chat off.
  it('switches chat on and off, opening chat on Standard', async () => {
    settings.autoChatView = false;
    await mount();
    act(() => ctx().setShowAIView(true));
    act(() => ctx().handleChatViewToggle(true));
    await settle();
    expect(ctx().chatViewActive).toBe(true);
    expect(ctx().showAIView).toBe(false);
    act(() => ctx().handleChatViewToggle(false));
    await settle();
    expect(ctx().chatViewActive).toBe(false);
  });

  // The reply target and the first email are members, never the reader's own
  // unsent draft (I6).
  it('never takes a draft as the first email', async () => {
    const draft = email({ id: 'd0', date: LOOPED_AT - 86_400, fromAddress: ME, tags: '|draft|', rawBody: '<p>draft</p>' });
    state.threadEmails = [draft, FIRST, REPLY];
    await mount();
    expect(ctx().firstEmail?.id).toBe('e1');
    expect(ctx().standardTurns!.turns.some((turn) => turn.id === 'd0')).toBe(false);
  });
});

describe('useEmailDetail — when the first email\'s split runs by itself', () => {
  beforeEach(() => {
    health.healthy = true;
    // No split stored yet: a state that wants a run.
    getFirstSplit.mockImplementation(async () => ({ success: true, data: answerFor(FIRST, null) }));
  });

  // Decision 4: the List view spends no AI. If the pane handed the split the
  // chat SETTING (or `true`) instead of the rules' `chatActive`, every
  // looped-in thread opened in the List view would start a paid AI run.
  it('starts no run in the List view, and exactly one once the reader switches to chat', async () => {
    settings.autoChatView = false;
    await mount();
    expect(ctx().chatRules.autoRunAI).toBe(true);
    expect(ctx().chatRules.chatActive).toBe(false);
    expect(ctx().firstSplit.state).toBe('miss');
    expect(runsStarted()).toBe(0);

    act(() => ctx().handleChatViewToggle(true));
    for (let i = 0; i < 4; i++) await settle();
    expect(ctx().chatRules.chatActive).toBe(true);
    expect(runsStarted()).toBe(1);
  });

  // Decision 2: a reply quoting ONE earlier message is offered the chat, but
  // its split runs only when the reader asks. If the pane passed `true` (or
  // the provider's presence) as `autoRunAI`, every reply-with-quote opened in
  // chat would spend AI unasked.
  it('never splits a single-quote email by itself, even with chat on — only on "Process now"', async () => {
    state.threadEmails = [SINGLE_QUOTE];
    state.emails = [SINGLE_QUOTE];
    state.selectedEmailId = SINGLE_QUOTE.id;
    getFirstSplit.mockImplementation(async () => ({ success: true, data: answerFor(SINGLE_QUOTE, null, 1) }));
    await mount();
    act(() => ctx().handleChatViewToggle(true));
    for (let i = 0; i < 4; i++) await settle();
    expect(ctx().chatRules.eligibility).toBe('on_demand');
    expect(ctx().chatRules.chatActive).toBe(true);
    expect(ctx().chatRules.autoRunAI).toBe(false);
    expect(ctx().firstSplit.state).toBe('miss');
    expect(runsStarted()).toBe(0);

    await act(async () => {
      await ctx().firstSplit.run();
    });
    await settle();
    expect(runsStarted()).toBe(1);
  });

  // Decision 4, with nothing selected: a folder click (or Follow-ups, or an
  // account switch) clears the selection but keeps the thread in the store,
  // and the pane stays mounted. A transient failure falling due then must not
  // start an AI run — or even a cache read — for a thread nobody is reading.
  it('neither reads nor runs for a thread left in the store after the selection is cleared', async () => {
    state.selectedEmailId = null;
    getFirstSplit.mockImplementation(async () => ({ success: true, data: answerFor(FIRST, transientRow(1)) }));
    await mount();
    expect(ctx()).toBeNull();
    expect(getFirstSplit).not.toHaveBeenCalled();
  });

  // The same, as it happens: the thread was open with a transient failure
  // backing off, the reader clicked a folder, and the retry fell due. The
  // re-render that notices must not start the retry.
  it('does not start a retry that falls due after the reader left the thread', async () => {
    const later = Math.floor(Date.now() / 1000) + 300;
    getFirstSplit.mockImplementation(async () => ({ success: true, data: answerFor(FIRST, transientRow(later)) }));
    await mount();
    expect(ctx().chatRules.chatActive).toBe(true);
    expect(ctx().firstSplit.state).toBe('retry-later');
    expect(runsStarted()).toBe(0);

    // The folder click: selection cleared, the thread stays in the store.
    state = { ...state, selectedEmailId: null };
    mounted!.rerender(<Harness />);
    for (let i = 0; i < 4; i++) await settle();
    // The retry time passes; the next store update re-renders the pane, which
    // is when a `retry-later` row is recomputed as `due`.
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime((later + 1) * 1000);
      mounted!.rerender(<Harness />);
      for (let i = 0; i < 4; i++) await settle();
    } finally {
      vi.useRealTimers();
    }
    expect(runsStarted()).toBe(0);
  });
});
