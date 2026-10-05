// @vitest-environment happy-dom
import type { EmailRecord } from '@sarvinbox/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { EmailDetailContext } from '../../../../../src/components/email-detail/types';
import { act, render, settle, type Mounted } from '../../../../helpers/render';

import { ELEVEN_AM, email, TEN_AM } from './email-fixture';

/**
 * The reading pane's inline composers and the drafts they are seeded with.
 *
 * What breaks if this file goes red: a draft opens in a composer it was not
 * written for, or loses the composer it WAS written for. A seed — what Undo
 * send restored, or the draft auto-opened for the thread — carries one
 * message's recipients and the Message-ID of the stored draft its composer
 * replaces on save and deletes on send or discard. Handed to another message's
 * composer, the reply goes to the wrong people; dropped on the way back to its
 * own message, the reply writes a second draft and the first stays in Drafts
 * after the send. The forward's seed was never cleared at all: after one Undo
 * send, every later forward opened on those recipients. The chat view's hover
 * icons put every bubble's Reply one click away, so "a composer pointed at
 * another message" is now the common case.
 */

/** What the IPC bridge answers: by default no stored draft and no AI proposal,
 *  so nothing opens a composer by itself. A test may put one in. */
const bridge = {
  storedDraft: null as Record<string, unknown> | null,
  proposals: [] as Record<string, unknown>[],
};
beforeEach(() => {
  bridge.storedDraft = null;
  bridge.proposals = [];
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    drafts: {
      findForThread: async () =>
        bridge.storedDraft ? { success: true, data: bridge.storedDraft } : { success: false },
    },
    agent: { getProposals: async () => ({ success: true, data: bridge.proposals }) },
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
  // Chat view off, no AI: the composers are all this file is about.
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

/** Read, bodied rows: no auto-read, no body fetch, no draft in the thread. */
const A = email({ id: 'a', date: TEN_AM, tags: '|read|', rawBody: '<p>one</p>', cleanBody: 'one' });
const B = email({
  id: 'b',
  date: ELEVEN_AM,
  fromAddress: 'bob@acme.example',
  fromName: 'Bob Ray',
  tags: '|read|',
  rawBody: '<p>two</p>',
  cleanBody: 'two',
});
/** A different conversation, to switch to. */
const OTHER = email({ id: 'other', threadId: 't2', date: ELEVEN_AM, tags: '|read|', rawBody: '<p>x</p>' });

type Restore = {
  isInline: boolean;
  mode: 'reply' | 'replyAll' | 'forward';
  replyToEmail: EmailRecord;
  to: string;
  cc: string;
  htmlContent: string;
  attachments: unknown[];
  draftMessageId: string;
};

const baseState = () => ({
  emails: [A, B, OTHER],
  folders: [],
  selectedFolderId: 'INBOX',
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
  restoreDraft: null as Restore | null,
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

/** The hook, mounted: `ctx()` is the context from the latest render. */
let latest: EmailDetailContext | null = null;
function Harness() {
  latest = useEmailDetail();
  return null;
}
const ctx = () => latest!;

let mounted: Mounted | undefined;
const mount = async () => {
  mounted = render(<Harness />);
  // The draft auto-open is a chain of IPC round trips (stored draft, then AI
  // proposals, then the draft's files); let every one of them land.
  for (let i = 0; i < 5; i++) await settle();
};
const rerender = async () => {
  mounted!.rerender(<Harness />);
  await settle();
};
/** Call a context handler the way a click does, and let React re-render. */
const run = (fn: () => void) => act(fn);

const restored = (mode: Restore['mode'], replyToEmail: EmailRecord): Restore => ({
  isInline: true,
  mode,
  replyToEmail,
  to: 'carol@acme.example',
  cc: '',
  htmlContent: '<p>What I had written</p>',
  attachments: [],
  draftMessageId: '<restored@acme.example>',
});

beforeEach(() => {
  vi.useFakeTimers(); // the composers' scroll-and-focus retries
  state = baseState();
  latest = null;
});
afterEach(() => {
  mounted?.unmount();
  mounted = undefined;
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('useEmailDetail — the forward composer\'s seed', () => {
  // Precondition for the rest: Undo send reopens the forward with its draft.
  it('reopens a forward restored by Undo send with what was written', async () => {
    state.restoreDraft = restored('forward', A);
    await mount();
    expect(ctx().forwardingEmail?.id).toBe('a');
    expect(ctx().inlineForwardDraft?.to).toBe('carol@acme.example');
  });

  // THE regression: closing the forward left its draft behind, and the next
  // forward — of any message — opened on it.
  it('drops the draft when the forward closes', async () => {
    state.restoreDraft = restored('forward', A);
    await mount();
    run(() => ctx().handleCloseInlineForward());
    expect(ctx().showInlineForward).toBe(false);
    expect(ctx().inlineForwardDraft).toBeUndefined();

    // And it does not come back with the next forward of the same message.
    run(() => ctx().handleInlineForward(A));
    expect(ctx().forwardingEmail?.id).toBe('a');
    expect(ctx().inlineForwardDraft).toBeUndefined();
  });

  // A forward pointed at another message must not carry A's draft to it —
  // and pointed back at A, it gets A's draft back rather than a blank box.
  it('never hands the draft to another message\'s forward, and gives it back on its own', async () => {
    state.restoreDraft = restored('forward', A);
    await mount();
    run(() => ctx().handleInlineForward(B));
    expect(ctx().forwardingEmail?.id).toBe('b');
    expect(ctx().inlineForwardDraft).toBeUndefined();

    run(() => ctx().handleInlineForward(A));
    expect(ctx().inlineForwardDraft?.draftMessageId).toBe('<restored@acme.example>');
  });

  // Regression: a reply opened in between (it closes the forward) dropped the
  // restored forward, and the forward reopened on the same message blank —
  // saving a second draft beside the restored one, which then never went away.
  it('restores the draft when the forward returns to its own message after a reply', async () => {
    state.restoreDraft = restored('forward', A);
    await mount();
    run(() => ctx().handleReply(A, false));
    expect(ctx().showInlineForward).toBe(false);
    run(() => ctx().handleInlineForward(A));
    expect(ctx().inlineForwardDraft?.to).toBe('carol@acme.example');
    expect(ctx().inlineForwardDraft?.draftMessageId).toBe('<restored@acme.example>');
  });

  // Idempotent re-open: the shortcut pressed again on the SAME message keeps
  // what Undo send restored.
  it('keeps the draft when the forward is re-opened on the same message', async () => {
    state.restoreDraft = restored('forward', A);
    await mount();
    run(() => ctx().handleInlineForward(A));
    expect(ctx().inlineForwardDraft?.to).toBe('carol@acme.example');
  });

  // Switching conversations closes the composers; their seeds go with them.
  it('drops the draft when another conversation is opened', async () => {
    state.restoreDraft = restored('forward', A);
    await mount();
    state = { ...state, restoreDraft: null, selectedEmailId: 'other', threadEmails: [OTHER], loadingThread: true };
    await rerender();
    expect(ctx().showInlineForward).toBe(false);
    expect(ctx().inlineForwardDraft).toBeUndefined();
  });
});

describe('useEmailDetail — the reply composer\'s seed', () => {
  // The reply side of the same bug: a draft restored for A, then Reply on B
  // (one hover icon away in the chat), opened B's reply holding A's draft —
  // A's recipients, and A's stored draft to replace and delete.
  it('never hands a draft to another message\'s composer', async () => {
    state.restoreDraft = restored('reply', A);
    await mount();
    expect(ctx().inlineReplyDraft?.to).toBe('carol@acme.example');

    run(() => ctx().handleReply(B, false));
    expect(ctx().replyingToEmail?.id).toBe('b');
    expect(ctx().inlineReplyDraft).toBeUndefined();

    // Back on A, the draft is A's again.
    run(() => ctx().handleReply(A, false));
    expect(ctx().inlineReplyDraft?.draftMessageId).toBe('<restored@acme.example>');
  });

  it('drops the draft for Reply all on another message too', async () => {
    state.restoreDraft = restored('reply', A);
    await mount();
    run(() => ctx().handleReplyAll(B, false));
    expect(ctx().inlineReplyMode).toBe('replyAll');
    expect(ctx().inlineReplyDraft).toBeUndefined();
  });

  // Switching Reply to Reply all on the same message is not a new reply —
  // the restored text stays.
  it('keeps the draft when the reply stays on the same message', async () => {
    state.restoreDraft = restored('reply', A);
    await mount();
    run(() => ctx().handleReplyAll(A, false));
    expect(ctx().replyingToEmail?.id).toBe('a');
    expect(ctx().inlineReplyDraft?.to).toBe('carol@acme.example');
  });

  // Regression: Reply -> Forward -> Reply on the SAME message opened an empty
  // reply. It had lost the stored draft's Message-ID, so it autosaved a second
  // draft, and the Undo-send draft stayed in Drafts after the reply was sent.
  it('restores the draft when the reply returns to its own message', async () => {
    state.restoreDraft = restored('reply', A);
    await mount();
    run(() => ctx().handleInlineForward(A));
    expect(ctx().showInlineReply).toBe(false);
    expect(ctx().inlineForwardDraft).toBeUndefined(); // the reply's draft is not the forward's

    run(() => ctx().handleReply(A, false));
    expect(ctx().inlineReplyDraft?.to).toBe('carol@acme.example');
    expect(ctx().inlineReplyDraft?.draftMessageId).toBe('<restored@acme.example>');
  });

  // Idempotent re-open: the same message's Reply pressed twice hands the
  // composer the very same draft, not a copy that would look like a change.
  it('hands the same draft on a repeated open', async () => {
    state.restoreDraft = restored('reply', A);
    await mount();
    const first = ctx().inlineReplyDraft;
    run(() => ctx().handleReply(A, false));
    run(() => ctx().handleReply(A, false));
    expect(ctx().inlineReplyDraft).toBe(first);
  });

  // Closing is the one retarget that ends the seed: the box is gone, and its
  // draft was saved or deleted by the close. Even when the box open at the
  // time was another message's, the next reply starts fresh — Drafts, not the
  // pane, is where a kept draft lives after its composer closed.
  it('drops the draft when the reply closes, whichever message it was on', async () => {
    state.restoreDraft = restored('reply', A);
    await mount();
    run(() => ctx().handleReply(B, false));
    run(() => ctx().handleCloseInlineReply());
    run(() => ctx().handleReply(A, false));
    expect(ctx().inlineReplyDraft).toBeUndefined();
  });

  it('drops the draft when another conversation is opened', async () => {
    state.restoreDraft = restored('reply', A);
    await mount();
    state = { ...state, restoreDraft: null, selectedEmailId: 'other', threadEmails: [OTHER], loadingThread: true };
    await rerender();
    expect(ctx().showInlineReply).toBe(false);
    expect(ctx().inlineReplyDraft).toBeUndefined();
  });

  // The popup path never touches the inline seed.
  it('leaves the inline draft alone when replying in the popup', async () => {
    state.restoreDraft = restored('reply', A);
    await mount();
    run(() => ctx().handleReply(B, true));
    expect(state.openCompose).toHaveBeenCalledWith('reply', expect.objectContaining({ id: 'b' }));
    expect(ctx().replyingToEmail?.id).toBe('a');
    expect(ctx().inlineReplyDraft?.to).toBe('carol@acme.example');
  });
});

describe('useEmailDetail — the auto-opened draft', () => {
  /** B's reply, saved to Drafts by the AI pipeline. */
  const storedAIDraft = () => ({
    messageId: '<stored@acme.example>',
    toAddress: 'bob@acme.example',
    ccAddress: '',
    subject: 'Re: Q3',
    cleanBody: 'Sounds good.',
  });

  // Precondition: the thread opens with its stored draft on the newest message.
  it('opens the stored draft on the newest message', async () => {
    bridge.storedDraft = storedAIDraft();
    bridge.proposals = [{ id: 'decision-1', emailId: 'b', proposedAction: 'reply' }];
    await mount();
    expect(ctx().replyingToEmail?.id).toBe('b');
    expect(ctx().inlineReplyDraft?.draftMessageId).toBe('<stored@acme.example>');
    expect(ctx().inlineReplyDraft?.agentDecisionId).toBe('decision-1');
  });

  // THE regression (verified by probe before the fix): forward the newest
  // message ('f' or its hover icon), then Reply on it again — the reply came
  // back empty, without the stored draft's Message-ID or the AI decision it
  // answers. Sending it wrote a second message and left this draft in Drafts,
  // to auto-open next session on a thread already answered.
  it('restores the draft when the reply returns to its own message after a forward', async () => {
    bridge.storedDraft = storedAIDraft();
    bridge.proposals = [{ id: 'decision-1', emailId: 'b', proposedAction: 'reply' }];
    await mount();
    run(() => ctx().handleInlineForward());
    expect(ctx().forwardingEmail?.id).toBe('b');
    run(() => ctx().handleReply());
    expect(ctx().inlineReplyDraft?.draftMessageId).toBe('<stored@acme.example>');
    expect(ctx().inlineReplyDraft?.agentDecisionId).toBe('decision-1');
  });

  // And it never follows the reply to an older message.
  it('never hands the thread draft to a reply on an older message', async () => {
    bridge.storedDraft = storedAIDraft();
    await mount();
    run(() => ctx().handleReply(A, false));
    expect(ctx().replyingToEmail?.id).toBe('a');
    expect(ctx().inlineReplyDraft).toBeUndefined();
  });

  // KNOWN GAP, recorded rather than fixed here: the seed is the draft as it
  // was OPENED. When the reply is edited, its autosave writes a new draft and
  // deletes this one (a new Message-ID), but nothing reports that back to the
  // seed — so a reply reopened after a detour shows the opened text and
  // points at the Message-ID that autosave already deleted; its next save
  // then leaves the edited draft in Drafts. The composer does not report its
  // saves to the pane (InlineReply / useDraftAutosave). This was so before
  // the chat's hover icons too; the test pins only what the pane CAN see.
  it('KNOWN GAP: reopens the draft as it was opened, not as last autosaved', async () => {
    bridge.storedDraft = storedAIDraft();
    await mount();
    const opened = ctx().inlineReplyDraft;
    run(() => ctx().handleInlineForward());
    run(() => ctx().handleReply());
    expect(ctx().inlineReplyDraft).toBe(opened);
  });
});

describe('useEmailDetail — replies from the end-of-chat row', () => {
  // The row and the keyboard shortcuts pass no email: they answer the NEWEST
  // message of the thread, whichever row the reader selected.
  it('answers the newest message when no email is given', async () => {
    state.selectedEmailId = 'a';
    await mount();
    run(() => ctx().handleReply());
    expect(ctx().replyingToEmail?.id).toBe('b');
    run(() => ctx().handleInlineForward());
    expect(ctx().forwardingEmail?.id).toBe('b');
  });
});

describe('useEmailDetail — focusing an inline composer once it has mounted', () => {
  const REPLY_ID = 'inline-reply-compose';
  const FORWARD_ID = 'inline-forward-compose';
  /** A composer as InlineReply / InlineForward render it: `fieldHtml` is the field the pane focuses. */
  const plantComposer = (id: string, fieldHtml: string) => {
    const composer = document.createElement('div');
    composer.id = id;
    const scrolls = vi.fn();
    composer.scrollIntoView = scrolls;
    composer.innerHTML = fieldHtml;
    document.body.appendChild(composer);
    const focus = vi.spyOn(composer.firstElementChild as HTMLElement, 'focus');
    return { scrolls, focus };
  };
  /** How many times the pane went looking for the composer `id`. */
  const lookupsFor = (spy: { mock: { calls: unknown[][] } }, id: string) =>
    spy.mock.calls.filter(([asked]) => asked === id).length;
  afterEach(() => {
    // The getElementById spies, so one test's lookups never count in the next.
    vi.restoreAllMocks();
    document.getElementById(REPLY_ID)?.remove();
    document.getElementById(FORWARD_ID)?.remove();
  });

  // Reply must put the caret in the editor, or the reader's typing goes nowhere.
  it('scrolls to the reply composer and focuses its editor', async () => {
    await mount();
    const { scrolls, focus } = plantComposer(REPLY_ID, '<div class="ProseMirror" tabindex="0"></div>');
    run(() => ctx().handleReply(B, false));
    vi.advanceTimersByTime(100);
    expect(scrolls).toHaveBeenCalledExactlyOnceWith({ behavior: 'smooth', block: 'end' });
    expect(focus).toHaveBeenCalledOnce();
  });

  // Forward must land on its To field: that is the first thing a forward needs.
  it('scrolls to the forward composer and focuses its To field', async () => {
    await mount();
    const { scrolls, focus } = plantComposer(FORWARD_ID, '<input type="text" />');
    run(() => ctx().handleInlineForward(B));
    vi.advanceTimersByTime(100);
    expect(scrolls).toHaveBeenCalledExactlyOnceWith({ behavior: 'smooth', block: 'end' });
    expect(focus).toHaveBeenCalledOnce();
  });

  // Undo send reopens the reply, and the reader expects to carry on typing in it.
  it('focuses the reply editor that Undo send reopened', async () => {
    const { focus } = plantComposer(REPLY_ID, '<div contenteditable="true"></div>');
    state.restoreDraft = restored('reply', A);
    await mount();
    vi.advanceTimersByTime(100);
    expect(focus).toHaveBeenCalledOnce();
  });

  // Regression: Undo send of a FORWARD went looking for the reply composer,
  // which is not on screen, so the restored forward was never scrolled to or
  // focused and the reader's typing went nowhere.
  it('focuses the To field of a forward that Undo send reopened', async () => {
    const { scrolls, focus } = plantComposer(FORWARD_ID, '<input type="text" />');
    state.restoreDraft = restored('forward', A);
    await mount();
    vi.advanceTimersByTime(100);
    expect(scrolls).toHaveBeenCalledExactlyOnceWith({ behavior: 'smooth', block: 'end' });
    expect(focus).toHaveBeenCalledOnce();
  });

  // The composer mounts a beat after the click: a single early look would miss
  // it and leave the caret wherever it was.
  it('focuses a composer that mounts while the pane is still looking for it', async () => {
    await mount();
    run(() => ctx().handleReply(B, false));
    vi.advanceTimersByTime(100);
    const { focus } = plantComposer(REPLY_ID, '<div class="ProseMirror" tabindex="0"></div>');
    vi.advanceTimersByTime(150);
    expect(focus).toHaveBeenCalledOnce();
  });

  // The editor mounts inside the composer's box after the box itself: finding
  // the box with no editor yet must keep looking, not stop at the scroll.
  it('keeps looking until the editor mounts inside a composer already on screen', async () => {
    await mount();
    const composer = document.createElement('div');
    composer.id = REPLY_ID;
    composer.scrollIntoView = vi.fn();
    document.body.appendChild(composer);
    run(() => ctx().handleReply(B, false));
    vi.advanceTimersByTime(100);
    expect(composer.scrollIntoView).toHaveBeenCalledOnce();

    composer.innerHTML = '<div class="ProseMirror" tabindex="0"></div>';
    const focus = vi.spyOn(composer.firstElementChild as HTMLElement, 'focus');
    vi.advanceTimersByTime(150);
    expect(focus).toHaveBeenCalledOnce();
  });

  // A composer that never mounts must not be polled for forever: one look,
  // five retries 150 ms apart, then nothing.
  it('gives up after five retries when the composer never mounts', async () => {
    await mount();
    const lookups = vi.spyOn(document, 'getElementById');
    run(() => ctx().handleReply(B, false));
    vi.advanceTimersByTime(100 + 5 * 150);
    expect(lookupsFor(lookups, REPLY_ID)).toBe(6);
    vi.advanceTimersByTime(10_000);
    expect(lookupsFor(lookups, REPLY_ID)).toBe(6);
  });

  // The composer side of main's CI leak: retries outlived a closed pane and
  // went looking in a document that, at the end of a test file, was gone.
  it('stops looking when the pane closes first', async () => {
    await mount();
    run(() => ctx().handleReply(B, false));
    vi.advanceTimersByTime(100); // the first look: nothing there yet
    mounted!.unmount();
    mounted = undefined;
    const lookups = vi.spyOn(document, 'getElementById');
    vi.advanceTimersByTime(10_000);
    expect(lookupsFor(lookups, REPLY_ID)).toBe(0);
  });
});
