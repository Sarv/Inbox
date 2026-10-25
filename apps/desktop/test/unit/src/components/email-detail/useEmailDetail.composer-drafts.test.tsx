// @vitest-environment happy-dom
import type { EmailRecord } from '@sarvinbox/core';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { EmailReaderOptions } from '../../../../../src/components/email-detail/reader-options';
import type { EmailDetailContext } from '../../../../../src/components/email-detail/types';
import { act, render, settle, typeInto, type Mounted } from '../../../../helpers/render';

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
vi.mock('../../../../../src/utils/compose-attachments', async importOriginal => ({
  ...await importOriginal<typeof import('../../../../../src/utils/compose-attachments')>(),
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
  activeAccountId: 'work',
  threadAccountId: 'work' as string | null,
  accounts: [{ id: 'work', email: 'me@example.test' }],
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
  viewAccountId: null as string | null,
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
let mountEditor = false;
let mountSavedEditor = false;
// Exercise the real autosave hook under the reader's conditional composer.
// Losing the reader context unmounts this editor and loses its live state.
const { useDraftAutosave } = await import('../../../../../src/hooks/useDraftAutosave');
const { useCompose } = await import('../../../../../src/components/useCompose');
function SavedEditorProbe() {
  const draft = latest?.inlineReplyDraft;
  const editor = useCompose({ initialDraft: draft });
  useDraftAutosave({ to: editor.to, cc: editor.cc, subject: editor.subject, body: editor.plainBody, htmlBody: editor.htmlBody,
    attachments: editor.attachments, initialDraftMessageId: draft?.draftMessageId, threadId: 't1', accountId: 'work' });
  return <textarea aria-label="Restored reply editor" value={editor.htmlBody} readOnly />;
}
function EditorProbe() {
  const [body, setBody] = useState('Opened draft');
  useDraftAutosave({
    to: 'bob@acme.example', subject: 'Re: Q3', body, htmlBody: `<p>${body}</p>`,
    initialDraftMessageId: '<editing@acme.example>', threadId: 't1', accountId: 'work',
  });
  return <textarea aria-label="Draft editor" value={body} onChange={event => setBody(event.target.value)} />;
}
function Harness({ options }: { options?: EmailReaderOptions } = {}) {
  latest = useEmailDetail(options);
  if (mountSavedEditor && latest?.showInlineReply) return <SavedEditorProbe key={latest.replyingToEmail?.id} />;
  return mountEditor && latest?.showInlineReply ? <EditorProbe key={latest.replyingToEmail?.id} /> : null;
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
  mountEditor = false;
  mountSavedEditor = false;
});
afterEach(() => {
  mounted?.unmount();
  mounted = undefined;
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('useEmailDetail — dashboard Reply all intent', () => {
  const options = (id = 1): EmailReaderOptions => ({ threadOnly: true, autoMarkRead: false,
    replyAllRequest: { id, accountId: 'work', emailId: 'b' } });
  const open = async (value = options()) => {
    state.viewAccountId = 'work';
    mounted = render(<Harness options={value} />);
    for (let i = 0; i < 5; i++) await settle();
  };

  it('opens the existing inline Reply all composer once without marking mail read or opening a second composer', async () => {
    await open();
    expect(ctx().showInlineReply).toBe(true);
    expect(ctx().inlineReplyMode).toBe('replyAll');
    expect(ctx().replyingToEmail?.id).toBe('b');
    expect(state.markAsRead).not.toHaveBeenCalled();
    expect(state.openCompose).not.toHaveBeenCalled();
    await run(() => ctx().handleCloseInlineReply());
    expect(ctx().showInlineReply).toBe(false);
    mounted!.rerender(<Harness options={options()} />); await settle();
    expect(ctx().showInlineReply).toBe(false);
    mounted!.rerender(<Harness options={options(2)} />); await settle();
    expect(ctx().showInlineReply).toBe(true);
    expect(ctx().inlineReplyMode).toBe('replyAll');
  });

  it('waits for the owning account and original body before seeding the quoted reply', async () => {
    state.threadAccountId = 'other';
    const middle = email({ ...A, id: 'unread-middle', messageId: '<unread-middle@example.test>', date: TEN_AM + 1800, tags: '|INBOX|' });
    state.threadEmails = [A, middle, { ...B, rawBody: '', cleanBody: '', hasBody: false }];
    state.emails = state.threadEmails;
    await open();
    expect(ctx().showInlineReply).toBe(false);
    state.threadAccountId = 'work';
    mounted!.rerender(<Harness options={options()} />); await settle();
    expect(ctx().showInlineReply).toBe(false);
    expect(ctx().expandedThreads.has(middle.id)).toBe(true);
    expect(ctx().expandedThreads.has('b')).toBe(false);
    expect(state.fetchEmailBody).toHaveBeenCalledWith('b');
    state.threadEmails = [A, { ...B, rawBody: '<p>Original full reply body</p>', cleanBody: 'Original full reply body', hasBody: true }];
    state.emails = state.threadEmails;
    mounted!.rerender(<Harness options={options()} />); await settle();
    expect(ctx().showInlineReply).toBe(true);
    expect(ctx().replyingToEmail?.rawBody).toBe('<p>Original full reply body</p>');
  });

  it('ignores an intent for another email selection even when its account matches', async () => {
    await open({ ...options(), replyAllRequest: { id: 1, accountId: 'work', emailId: 'other' } });
    expect(ctx().showInlineReply).toBe(false);
  });

  it('retains an existing saved draft while defaulting to Reply all', async () => {
    bridge.storedDraft = { messageId: '<saved@example.test>', toAddress: 'bob@acme.example', ccAddress: 'team@acme.example',
      subject: 'Re: Q3', rawBody: '<p>Previously written reply</p>', cleanBody: 'Previously written reply' };
    await open();
    expect(ctx().showInlineReply).toBe(true);
    expect(ctx().inlineReplyMode).toBe('replyAll');
    expect(ctx().inlineReplyDraft?.htmlContent).toContain('Previously written reply');
    expect(ctx().inlineReplyDraft?.draftMessageId).toBe('<saved@example.test>');
  });

  it('waits for a delayed saved draft lookup rather than showing an empty composer that is later replaced', async () => {
    let finish!: (value: unknown) => void;
    mountSavedEditor = true;
    window.electronAPI.drafts.save = vi.fn(async () => ({ success: true, messageId: '<unexpected-save@example.test>' }));
    window.electronAPI.drafts.findForThread = vi.fn(() => new Promise(resolve => { finish = resolve; })) as typeof window.electronAPI.drafts.findForThread;
    await open();
    expect(ctx().showInlineReply).toBe(false);
    expect(mounted!.byLabel('Restored reply editor')).toBeNull();
    await act(async () => finish({ success: true, data: { messageId: '<delayed@example.test>', toAddress: 'bob@acme.example',
      subject: 'Re: Q3', rawBody: '<p>Keep this saved reply</p>' } }));
    for (let i = 0; i < 5; i++) await settle();
    expect(ctx().showInlineReply).toBe(true);
    expect(ctx().inlineReplyMode).toBe('replyAll');
    expect(ctx().inlineReplyDraft?.htmlContent).toContain('Keep this saved reply');
    expect(ctx().inlineReplyDraft?.draftMessageId).toBe('<delayed@example.test>');
    expect((mounted!.byLabel('Restored reply editor') as HTMLTextAreaElement).value).toContain('Keep this saved reply');
    await vi.advanceTimersByTimeAsync(10_001);
    expect(window.electronAPI.drafts.save).not.toHaveBeenCalled();
  });

  it('ignores a late draft from another account even when the email IDs are identical', async () => {
    let finish!: (value: unknown) => void;
    window.electronAPI.drafts.findForThread = vi.fn()
      .mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
      .mockResolvedValue({ success: false }) as typeof window.electronAPI.drafts.findForThread;
    await open();
    state.viewAccountId = 'other';
    state.threadAccountId = 'other';
    state.threadEmails = [{ ...B, accountId: 'other', rawBody: '<p>Other account original</p>' }];
    state.emails = state.threadEmails;
    mounted!.rerender(<Harness options={{ ...options(), replyAllRequest: { id: 2, accountId: 'other', emailId: 'b' } }} />);
    for (let i = 0; i < 5; i++) await settle();
    expect(ctx().showInlineReply).toBe(true);
    expect(ctx().replyingToEmail?.accountId).toBe('other');
    await act(async () => finish({ success: true, data: { messageId: '<wrong-account@example.test>', toAddress: 'old@example.test',
      subject: 'Old account draft', rawBody: '<p>Wrong account saved reply</p>' } }));
    for (let i = 0; i < 5; i++) await settle();
    expect(ctx().replyingToEmail?.accountId).toBe('other');
    expect(ctx().inlineReplyDraft).toBeUndefined();
  });

  it('ignores an old lookup after the same conversation loads a newer reply target', async () => {
    let finish!: (value: unknown) => void;
    window.electronAPI.drafts.findForThread = vi.fn()
      .mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
      .mockResolvedValue({ success: false }) as typeof window.electronAPI.drafts.findForThread;
    await open();
    const newest = email({ ...B, id: 'newest', messageId: '<newest@example.test>', date: ELEVEN_AM + 3600 });
    state.threadEmails = [A, B, newest];
    state.emails = state.threadEmails;
    mounted!.rerender(<Harness options={options()} />);
    for (let i = 0; i < 5; i++) await settle();
    expect(ctx().replyingToEmail?.id).toBe('newest');
    await act(async () => finish({ success: true, data: { messageId: '<old-draft@example.test>', toAddress: 'old@example.test',
      rawBody: '<p>Outdated lookup</p>' } }));
    for (let i = 0; i < 5; i++) await settle();
    expect(ctx().replyingToEmail?.id).toBe('newest');
    expect(ctx().inlineReplyDraft).toBeUndefined();
  });
});

describe('useEmailDetail — the forward composer\'s seed', () => {
  it('opens the popup forward with the chosen original message\'s files and owning account', async () => {
    const original = email({
      ...A, hasAttachments: true, attachmentNames: '["letter.docx"]',
      attachmentSizes: '[14837]', accountId: 'original-account',
    } as Partial<EmailRecord> & { id: string; accountId: string });
    await mount();

    run(() => ctx().handleForward(original));

    expect(state.openCompose).toHaveBeenCalledWith('forward', expect.objectContaining({
      id: original.id, accountId: 'original-account', hasAttachments: true,
      attachmentNames: '["letter.docx"]', attachmentSizes: '[14837]',
    }));
  });

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

describe('useEmailDetail — editing a selected draft during autosave', () => {
  const draft = email({
    id: 'editing', messageId: '<editing@acme.example>', tags: '|Drafts|draft|',
    date: ELEVEN_AM + 60, cleanBody: 'Opened draft', rawBody: '<p>Opened draft</p>',
  });
  const openSelectedDraft = async () => {
    state = { ...state, selectedEmailId: draft.id, emails: [draft], threadEmails: [A, B, draft] };
    await mount();
    expect(ctx()?.showInlineReply).toBe(true);
    expect(ctx()?.replyingToEmail?.id).toBe(B.id);
  };

  it('resolves the selected draft from raw thread rows when a list refresh omits it', async () => {
    state = { ...state, selectedEmailId: draft.id, emails: [], threadEmails: [A, B, draft] };
    await mount();
    expect(ctx()).not.toBeNull();
    expect(ctx()?.showInlineReply).toBe(true);
    expect(ctx()?.threadEmails.map(e => e.id)).toEqual([A.id, B.id]);
  });

  it('keeps the same live editor through repeated save-then-delete replacements', async () => {
    mountEditor = true;
    let sequence = 0;
    const save = vi.fn(async (_draft: unknown) => ({ success: true, messageId: `<saved-${++sequence}@acme.example>` }));
    let finishUpload!: () => void;
    save.mockImplementationOnce(() => new Promise(resolve => {
      finishUpload = () => resolve({ success: true, messageId: `<saved-${++sequence}@acme.example>` });
    }));
    const remove = vi.fn(async () => {
      // The main-process drafts:removed event drops the superseded row from
      // every store view. The selected id deliberately does not change.
      state = { ...state, emails: [], threadEmails: [A, B] };
      mounted!.rerender(<Harness />);
      return { success: true };
    });
    Object.assign(window.electronAPI.drafts, { save, delete: remove });
    await openSelectedDraft();
    const seed = ctx().inlineReplyDraft;
    const editor = mounted!.byLabel('Draft editor') as HTMLTextAreaElement;
    typeInto(editor, 'Edited with AI polish');
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(save).toHaveBeenCalledOnce();
    expect(remove).not.toHaveBeenCalled();
    // Further edits during the upload belong to the live editor, not the
    // snapshot that was just sent to drafts.save.
    typeInto(editor, 'Kept typing during upload');
    await act(async () => { finishUpload(); });
    expect(remove).toHaveBeenCalledWith({ messageId: draft.messageId, accountId: 'work' });
    expect(ctx()).not.toBeNull();
    expect(ctx()?.showInlineReply).toBe(true);
    expect(ctx()?.inlineReplyDraft).toBe(seed);
    expect(ctx()?.replyingToEmail?.id).toBe(B.id);
    expect(ctx()?.threadMessageTotal).toBe(2);
    expect(mounted!.byLabel('Draft editor')).toBe(editor);
    expect(editor.value).toBe('Kept typing during upload');

    typeInto(editor, 'Kept typing after autosave');
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[1][0]).toMatchObject({ body: 'Kept typing after autosave' });
    expect(remove).toHaveBeenLastCalledWith({ messageId: '<saved-1@acme.example>', accountId: 'work' });
    expect(mounted!.byLabel('Draft editor')).toBe(editor);
  });

  it('reanchors to the real conversation when the editor closes after replacement', async () => {
    await openSelectedDraft();
    state = { ...state, emails: [], threadEmails: [A, B] };
    await rerender();
    expect(ctx()).not.toBeNull();
    run(() => ctx().handleCloseInlineReply());
    expect(state.selectEmail).toHaveBeenCalledWith(B.id);
    // A real selection change ends the retained draft and its composer.
    state = { ...state, selectedEmailId: B.id, emails: [A, B] };
    await rerender();
    expect(ctx()?.showInlineReply).toBe(false);
  });

  it.each(['selection', 'clear', 'account', 'unified-account'] as const)('drops the retained anchor on %s changes', async change => {
    await openSelectedDraft();
    state = { ...state, emails: [], threadEmails: [A, B] };
    await rerender();
    expect(ctx()).not.toBeNull();
    state = {
      ...state,
      ...(change === 'selection' ? { selectedEmailId: OTHER.id, threadEmails: [OTHER], loadingThread: true }
        : change === 'clear' ? { selectedEmailId: null }
          : change === 'unified-account' ? { viewAccountId: 'another-account', threadEmails: [] }
          : { activeAccountId: 'personal', threadEmails: [] }),
    };
    await rerender();
    if (change === 'selection') {
      expect(ctx()?.showInlineReply).toBe(false);
      expect(ctx()?.selectedEmailId).toBe(OTHER.id);
    } else {
      expect(ctx()).toBeNull();
    }
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
