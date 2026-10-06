// @vitest-environment happy-dom
import type { EmailRecord } from '@sarvinbox/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { EmailDetailContext } from '../../../../../src/components/email-detail/types';
import { render, settle, type Mounted } from '../../../../helpers/render';

import { ELEVEN_AM, email, ME, TEN_AM } from './email-fixture';

/**
 * Which rows of the open thread the reading pane treats as the CONVERSATION.
 *
 * What breaks if this file goes red: the reading pane stops using the one
 * membership predicate main counts, drafts and schedules by. Then a draft that
 * came back from an IMAP sync tagged only with its provider Drafts path
 * (`|INBOX.Drafts|`) renders as a message the reader seems to have SENT, a
 * deleted draft reappears, a trashed copy shows as a live reply, the thread
 * header's count disagrees with the list row's "(N)", or the anchor card is an
 * undated row posing as the thread's first email.
 */

beforeEach(() => {
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    drafts: { findForThread: async () => ({ success: false }) },
    agent: { getProposals: async () => ({ success: true, data: [] }) },
    ai: { getFirstSplit: async () => ({ success: false }) },
  };
});

vi.mock('../../../../../src/services/ai-service', () => ({
  getDefaultProvider: () => null,
  getAIHealth: () => ({ healthy: true, reason: '' }),
  getCurrentUserEmail: (fallback: string) => fallback,
  buildPolishThreadContext: () => '',
  detectSignature: vi.fn(),
  makeAICompletion: vi.fn(),
  loadAIFeatures: () => [],
}));
vi.mock('../../../../../src/services/ai-features', () => ({
  // Chat view off, no AI: membership is all this file is about.
  isConversationModeEnabled: () => false,
  isAutoChatViewEnabled: () => false,
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

/** The account's folders, with the provider paths a Dovecot server uses. */
const FOLDERS = [
  { id: 'f1', path: 'INBOX', name: 'INBOX', specialUse: null },
  { id: 'f2', path: 'INBOX.Drafts', name: 'Drafts', specialUse: '\\Drafts' },
  { id: 'f3', path: 'INBOX.Sent', name: 'Sent', specialUse: '\\Sent' },
];

const A = email({ id: 'a', date: TEN_AM, tags: '|INBOX|read|', rawBody: '<p>one</p>', cleanBody: 'one' });
const B = email({
  id: 'b',
  date: ELEVEN_AM,
  fromAddress: 'bob@acme.example',
  tags: '|INBOX|read|',
  rawBody: '<p>two</p>',
  cleanBody: 'two',
});

const baseState = () => ({
  emails: [A, B],
  folders: FOLDERS,
  selectedFolderId: 'f1',
  selectedEmailId: 'b' as string | null,
  selectEmail: vi.fn(),
  threadEmails: [A, B] as EmailRecord[],
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
  for (let i = 0; i < 3; i++) await settle();
};
const idsOf = (rows: Array<{ id: string }>) => rows.map((row) => row.id);

beforeEach(() => {
  vi.useFakeTimers();
  state = baseState();
  latest = null;
});
afterEach(() => {
  mounted?.unmount();
  mounted = undefined;
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('useEmailDetail — the conversation is its members', () => {
  // THE regression: an IMAP-synced draft carries only its folder path, and
  // only the account's folder roles say `INBOX.Drafts` is a Drafts folder.
  it('leaves a provider-path draft out of the conversation', async () => {
    const draft = email({ id: 'd', date: ELEVEN_AM + 60, fromAddress: ME, tags: '|INBOX.Drafts|', rawBody: '<p>draft</p>' });
    state.threadEmails = [A, B, draft];
    await mount();
    expect(idsOf(ctx().threadEmails)).toEqual(['a', 'b']);
    expect(ctx().threadMessageTotal).toBe(2);
  });

  // Deleting a draft used to MAKE IT APPEAR: in Trash it was no longer a live
  // draft and fell through the filter as an ordinary message.
  it('leaves a deleted draft out, and a Trash copy of a message too', async () => {
    const trashedDraft = email({ id: 'd', date: ELEVEN_AM + 60, tags: '|Trash|draft|', rawBody: '<p>x</p>' });
    const trashedCopy = email({ id: 't', date: ELEVEN_AM + 120, tags: '|[Gmail]/Trash|', rawBody: '<p>y</p>' });
    state.threadEmails = [A, B, trashedDraft, trashedCopy];
    await mount();
    expect(idsOf(ctx().threadEmails)).toEqual(['a', 'b']);
  });

  // A sent copy with a stale `|draft|` tag in the account's own Sent path is
  // the reader's reply — hiding it erases their side of the conversation.
  it('keeps a sent copy in the account’s Sent path that still carries a draft tag', async () => {
    const sent = email({ id: 's', date: ELEVEN_AM + 60, fromAddress: ME, tags: '|INBOX.Sent|draft|', rawBody: '<p>sent</p>' });
    state.threadEmails = [A, B, sent];
    await mount();
    expect(idsOf(ctx().threadEmails)).toEqual(['a', 'b', 's']);
  });

  // The anchor card is the FIRST member in the one conversation order — an
  // undated row (date 0) sorted first under `a.date - b.date` and became the
  // card, while main's "first email" was the earliest dated one.
  it('anchors the card on the first member, never an undated row', async () => {
    const undated = email({ id: 'u', date: 0, tags: '|INBOX|read|', rawBody: '<p>?</p>' });
    state.threadEmails = [undated, A, B];
    await mount();
    expect(ctx().displayEmail?.id).toBe('a');
  });

  // Reply (the default target) must answer the NEWEST message in the same one
  // order as the card. Two members at the same second: a `b.date - a.date`
  // sort kept input order, so the reply target was the card itself — Reply
  // answered the first email.
  it('replies to the newest member, not the card, for a same-second pair', async () => {
    const first = email({ id: 'p', date: TEN_AM, tags: '|INBOX|read|', rawBody: '<p>1</p>' });
    const second = email({ id: 'q', date: TEN_AM, tags: '|INBOX|read|', rawBody: '<p>2</p>' });
    state.emails = [first, second];
    state.selectedEmailId = 'q';
    state.threadEmails = [first, second];
    await mount();
    expect(ctx().displayEmail?.id).toBe('p');
    ctx().handleReply();
    await settle();
    expect(ctx().replyingToEmail?.id).toBe('q');
  });

  // An undated row (no/unparseable Date:) is never the reply target over a
  // dated one — with `b.date - a.date` a null date made the comparator NaN.
  it('never makes an undated row the reply target', async () => {
    const undated = email({ id: 'u', date: 0, tags: '|INBOX|read|', rawBody: '<p>?</p>' });
    state.threadEmails = [A, undated, B];
    await mount();
    ctx().handleReply();
    await settle();
    expect(ctx().replyingToEmail?.id).toBe('b');
  });

  // The auto-expand anchor is the CARD. With a separate date sort an undated
  // unread row sorted first and was taken for the anchor: a READ card opened
  // expanded, and the unread undated row — rendered LAST — was never
  // expanded or scrolled to, so the reader could miss an unread message.
  it('auto-expands an unread undated row and keeps a read card collapsed', async () => {
    const undatedUnread = email({ id: 'u', date: 0, tags: '|INBOX|', rawBody: '<p>?</p>' });
    const unreadB = { ...B, tags: '|INBOX|' };
    state.emails = [A, unreadB, undatedUnread];
    state.threadEmails = [undatedUnread, A, unreadB];
    await mount();
    expect(ctx().displayEmail?.id).toBe('a');
    expect(ctx().mainEmailExpanded).toBe(false);
    expect([...ctx().expandedThreads].sort()).toEqual(['b', 'u']);
  });

  // All read: the newest DATED member other than the card is expanded — not
  // an undated row that merely sorts last.
  it('expands the newest dated member when the whole thread is read', async () => {
    const undated = email({ id: 'u', date: 0, tags: '|INBOX|read|', rawBody: '<p>?</p>' });
    state.threadEmails = [undated, A, B];
    await mount();
    expect(ctx().mainEmailExpanded).toBe(false);
    expect([...ctx().expandedThreads]).toEqual(['b']);
  });

  // The card is the only dated member: the newest dated member IS the card,
  // so the expand target is the last card ThreadList renders (the undated
  // row) — not the card's own id, which would leave every card collapsed.
  it('expands the last rendered card when the card is the only dated member', async () => {
    const undated = email({ id: 'u', date: 0, tags: '|INBOX|read|', rawBody: '<p>?</p>' });
    state.emails = [A, undated];
    state.selectedEmailId = 'a';
    state.threadEmails = [undated, A];
    await mount();
    expect(ctx().displayEmail?.id).toBe('a');
    expect([...ctx().expandedThreads]).toEqual(['u']);
  });

  // A thread that is ALL junk (the reader is in Spam) is still a conversation.
  it('shows an all-junk thread rather than an empty one', async () => {
    const spamA = email({ id: 'sa', date: TEN_AM, tags: '|Spam|', rawBody: '<p>1</p>' });
    const spamB = email({ id: 'sb', date: ELEVEN_AM, tags: '|Spam|', rawBody: '<p>2</p>' });
    state.emails = [spamA, spamB];
    state.selectedEmailId = 'sb';
    state.threadEmails = [spamA, spamB];
    await mount();
    expect(idsOf(ctx().threadEmails)).toEqual(['sa', 'sb']);
  });
});

describe('useEmailDetail — scrolling the expanded card into view', () => {
  /** A thread card as ThreadList renders it, recording every scroll it is asked for. */
  const plantCard = (emailId: string) => {
    const card = document.createElement('div');
    card.id = `thread-${emailId}`;
    const scrolls = vi.fn();
    card.scrollIntoView = scrolls;
    document.body.appendChild(card);
    return scrolls;
  };
  afterEach(() => {
    document.querySelectorAll('[id^="thread-"]').forEach((card) => card.remove());
  });

  // Opening a read thread must still bring its newest message into view.
  it('scrolls to the newest message of a read thread once its card has rendered', async () => {
    const scrolls = plantCard('b');
    await mount();
    expect(scrolls).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(scrolls).toHaveBeenCalledExactlyOnceWith({ behavior: 'smooth', block: 'center' });
  });

  // Opening a thread with unread replies must bring the first unread one into view.
  it('scrolls to the first unread message of a thread', async () => {
    const unreadB = { ...B, tags: '|INBOX|' };
    state.emails = [A, unreadB];
    state.threadEmails = [A, unreadB];
    const scrolls = plantCard('b');
    await mount();
    vi.advanceTimersByTime(100);
    expect(scrolls).toHaveBeenCalledExactlyOnceWith({ behavior: 'smooth', block: 'center' });
  });

  // A reply that folds into the open thread must be scrolled to, or it lands
  // collapsed below the fold and the reader never sees it arrive.
  it('scrolls to a message that folds into the open thread', async () => {
    await mount();
    vi.advanceTimersByTime(100);
    const C = email({ id: 'c', date: ELEVEN_AM + 60, tags: '|INBOX|read|', rawBody: '<p>three</p>' });
    const scrolls = plantCard('c');
    state.threadEmails = [A, B, C];
    mounted!.rerender(<Harness />);
    await settle();
    vi.advanceTimersByTime(100);
    expect(scrolls).toHaveBeenCalledExactlyOnceWith({ behavior: 'smooth', block: 'center' });
  });

  // THE regression (main's CI, PR #54): the 100 ms scroll outlived the pane.
  // Fired after a test file's DOM was torn down, it threw "document is not
  // defined" and failed a run in which every assertion had passed; in the app
  // it scrolled a pane that was no longer there.
  it('drops the pending scroll when the pane closes first', async () => {
    const scrolls = plantCard('b');
    await mount();
    mounted!.unmount();
    mounted = undefined;
    vi.advanceTimersByTime(1_000);
    expect(scrolls).not.toHaveBeenCalled();
  });

  // Same leak, the folded-in-message path.
  it('drops the pending scroll to a folded-in message when the pane closes first', async () => {
    await mount();
    vi.advanceTimersByTime(100);
    const C = email({ id: 'c', date: ELEVEN_AM + 60, tags: '|INBOX|read|', rawBody: '<p>three</p>' });
    const scrolls = plantCard('c');
    state.threadEmails = [A, B, C];
    mounted!.rerender(<Harness />);
    await settle();
    mounted!.unmount();
    mounted = undefined;
    vi.advanceTimersByTime(1_000);
    expect(scrolls).not.toHaveBeenCalled();
  });
});
