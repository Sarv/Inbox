// @vitest-environment happy-dom
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AssistantWorkspace } from '../../../../../src/components/assistant/AssistantWorkspace';
import { InboxAssistant } from '../../../../../src/components/assistant/InboxAssistant';
import type { ConfirmOptions } from '../../../../../src/components/ConfirmDialog';
import type { InboxAssistantActionMode, InboxAssistantActivity, InboxAssistantCancellation, InboxAssistantChat, InboxAssistantChatList, InboxAssistantChatSummary, InboxAssistantDraft, InboxAssistantDraftRequest, InboxAssistantExchange, InboxAssistantRequest, InboxAssistantResult, InboxAssistantRewind } from '../../../../../src/types/inbox-assistant';
import type { InboxAssistantReviewItem } from '../../../../../src/types/inbox-assistant-actions';
import type { InboxAgentChangeSet, InboxAgentChangeSetRequest, InboxAgentSettingChange, InboxAgentUndoRequest } from '../../../../../src/types/inbox-assistant-changes';
import { ACTION_MODE_DESCRIPTION } from '../../../../../src/utils/inbox-assistant-approval';
import { act, cleanup, fire, render, settle, toggle, typeInto } from '../../../../helpers/render';

const ok = <T,>(data: T): InboxAssistantResult<T> => ({ success: true, data });
const confirm = vi.hoisted(() => vi.fn(async (_options: ConfirmOptions) => true));
vi.mock('../../../../../src/store/confirm-service', () => ({ requestConfirm: confirm }));
const accounts = [{ id: 'work', email: 'rc@sarv.com', name: 'Work' }, { id: 'other', email: 'rc@other.example' }];
const source = {
  id: 'S1', kind: 'attachment' as const, accountId: 'other', accountEmail: 'rc@other.example', emailId: 'shared-email-id',
  subject: 'Revised TCS quotation', from: 'rc@other.example', to: ['buyer@tcs.example'], date: 1720000000,
  folder: 'Sent Items', sent: true, attachmentId: 'quote-file', filename: 'TCS-quote.xlsx', location: 'Pricing!B4', excerpt: 'Total: INR 2,50,000',
};
const activityListeners = new Set<(activity: InboxAssistantActivity) => void>();
const offActivity = vi.fn();
function exchange(id = 'exchange-1'): InboxAssistantExchange {
  return {
    id, chatId: 'chat-1', question: 'What quote did I send to TCS?', accountIds: ['work', 'other'], createdAt: 1720000000000,
    answer: {
      text: 'You sent a revised quote for INR 2,50,000 [S1].', sources: [source], warnings: [],
      coverage: accounts.map(account => ({ accountId: account.id, email: account.email, status: 'searched' as const, matchedMessages: 3, reviewedMessages: 3, missingBodies: 0, attachmentsRead: 1, attachmentsSkipped: 0, truncated: false, warnings: [] })),
    },
  };
}
/** An agent answer with one change-set card, pending or applied. */
function changeExchange(status: 'pending' | 'applied', action: InboxAgentChangeSet['action'] = 'mark_read'): InboxAssistantExchange {
  const now = Date.now();
  return { ...exchange('exchange-change'), changeSets: [{
    id: 'set-1', label: 'C1', action, summary: action === 'trash' ? 'Move 1 email to Trash' : 'Mark 1 email read', createdAt: now,
    approveBy: now + 60_000, undoBy: status === 'applied' ? now + 60_000 : 0, status,
    items: [{ id: 'c1-1', accountId: 'work', accountEmail: 'rc@sarv.com', emailId: 'mail-1', threadId: 'thread-1', subject: 'Weekend sale', from: 'shop@example.test', date: 1720000000, status: status === 'pending' ? 'pending' : 'applied' }],
  }] };
}
/** A pending change card with a second email, optionally protected. */
function twoEmailExchange(action: InboxAgentChangeSet['action'], protectedReason?: string): InboxAssistantExchange {
  const base = changeExchange('pending', action);
  const set = base.changeSets![0]!;
  return { ...base, changeSets: [{ ...set, summary: action === 'trash' ? 'Move 2 emails to Trash' : 'Mark 2 emails read', items: [set.items[0]!,
    { ...set.items[0]!, id: 'c1-2', emailId: 'mail-2', threadId: 'thread-2', subject: 'Quarterly invoice', ...(protectedReason ? { protectedReason } : {}) }] }] };
}
function chat(id = 'chat-1', exchanges: InboxAssistantExchange[] = []): InboxAssistantChat {
  return { id, title: id === 'chat-1' ? 'TCS quotations' : id === 'chat-2' ? 'Meeting follow-ups' : 'New conversation', createdAt: 1720000000000, updatedAt: 1720000000000, exchangeCount: exchanges.length, exchanges: exchanges.map(exchange => ({ ...exchange, chatId: id })) };
}
function summary(id = 'chat-1'): InboxAssistantChatSummary {
  const { exchanges: _exchanges, ...result } = chat(id);
  return result;
}
function reviewItem(id: string, over: Partial<InboxAssistantReviewItem> = {}): InboxAssistantReviewItem {
  return {
    id, accountId: 'work', accountEmail: 'owner@example.test', threadId: `thread-${id}`, emailId: `mail-${id}`,
    subject: `Unread ${id}`, from: 'sender@example.test', date: 1_720_000_000,
    unreadCount: 2, messageCount: 3, unreadEmailIds: [`mail-${id}`, `reply-${id}`], uncategorized: true, categories: [],
    recommendation: 'mark_read', reason: 'A routine update with no pending request.', confidence: 0.96,
    protectedReasons: [], bodyUnavailable: false, attachmentsUnknown: false, status: 'pending', ...over,
  };
}
function reviewExchange(over: Partial<InboxAssistantExchange> = {}): InboxAssistantExchange {
  return {
    ...exchange('review-exchange'), question: 'Review my unread emails and mark low-value conversations as read.',
    answer: { text: 'Review the recommendations below.', sources: [], coverage: [], warnings: [] },
    review: {
      id: 'review-snapshot', kind: 'unread', createdAt: Date.now(), expiresAt: Date.now() + 60_000,
      status: 'ready', accounts, truncated: false, coverage: [],
      items: [reviewItem('item-a'), reviewItem('item-b', { accountId: 'other', accountEmail: 'other@example.test', unreadCount: 1, unreadEmailIds: ['mail-item-b'] }),
        reviewItem('protected', { protectedReasons: ['Marked important by you'], recommendation: 'keep_unread' })],
    }, ...over,
  };
}
function reviewReceipt(original: InboxAssistantExchange, status: 'applied' | 'queued' | 'failed' | 'undone' = 'applied'): InboxAssistantExchange {
  return {
    ...original, answer: { ...original.answer, text: status === 'undone' ? 'The changed emails are unread again.' : status === 'failed' ? 'One message changed; another could not be marked read.' : 'Selected conversations were marked read.' },
    review: { ...original.review!, status: 'partial', items: original.review!.items.map(item => item.id === 'item-a' ? { ...item, status, undoAvailable: status !== 'undone' } : item) },
    reviewResult: { reviewId: original.review!.id, items: [{ itemId: 'item-a', accountId: 'work', threadId: 'thread-item-a', status,
      appliedIds: status === 'undone' ? [] : ['mail-item-a'], queuedIds: status === 'queued' ? ['mail-item-a'] : [], failedIds: status === 'failed' ? ['reply-item-a'] : [] }],
    appliedCount: status === 'undone' ? 0 : 1, queuedCount: status === 'queued' ? 1 : 0, failedCount: status === 'failed' ? 1 : 0, skippedCount: 0 },
  };
}
type ChatUpdate = { chatId: string; pinned?: boolean; actionMode?: InboxAssistantActionMode };
const api = {
  accounts: vi.fn(async () => ok(accounts)),
  history: vi.fn(async (): Promise<InboxAssistantResult<InboxAssistantExchange[]>> => ok([])),
  chats: vi.fn(async (): Promise<InboxAssistantResult<InboxAssistantChatList>> => ok({ chats: [summary(), summary('chat-2')], activeChatId: 'chat-1' })),
  chat: vi.fn(async (id: string): Promise<InboxAssistantResult<InboxAssistantChat>> => ok(chat(id))),
  createChat: vi.fn(async (): Promise<InboxAssistantResult<InboxAssistantChat>> => ok(chat('chat-new'))),
  renameChat: vi.fn(async ({ chatId, title }: { chatId: string; title: string }): Promise<InboxAssistantResult<InboxAssistantChatSummary>> => ok({ ...summary(chatId), title })),
  updateChat: vi.fn(async ({ chatId, ...changes }: ChatUpdate): Promise<InboxAssistantResult<InboxAssistantChatSummary>> => ok({ ...summary(chatId), ...changes })),
  deleteChat: vi.fn(async (chatId: string): Promise<InboxAssistantResult<InboxAssistantChatList>> => { const remaining = [summary(), summary('chat-2')].filter(chat => chat.id !== chatId); return ok({ chats: remaining, activeChatId: remaining[0]?.id ?? null }); }),
  rewindChat: vi.fn(async ({ chatId }: { chatId: string; exchangeId: string }): Promise<InboxAssistantResult<InboxAssistantRewind>> => ok({ chat: { ...chat(chatId), rewindAvailable: true }, question: exchange().question, accountIds: ['other'] })),
  restoreRewindChat: vi.fn(async ({ chatId }: { chatId: string }): Promise<InboxAssistantResult<InboxAssistantChat>> => ok(chat(chatId, [exchange()]))),
  draftEmail: vi.fn(async (request: InboxAssistantDraftRequest): Promise<InboxAssistantResult<InboxAssistantDraft>> => ok({ chatId: request.chatId, accountId: request.accountId, to: ['buyer@tcs.example'], cc: [], subject: 'TCS quotation follow-up', body: 'Hello, please review our quotation.' })),
  ask: vi.fn(async (request: InboxAssistantRequest): Promise<InboxAssistantResult<InboxAssistantExchange>> => ok({ ...exchange(), chatId: request.chatId })),
  changeSet: vi.fn(async (_request: InboxAgentChangeSetRequest): Promise<InboxAssistantResult<InboxAssistantExchange>> => ok(changeExchange('applied'))),
  cancel: vi.fn(async (requestId: string): Promise<InboxAssistantResult<InboxAssistantCancellation>> => ok({ requestId, cancelled: true })),
  clearHistory: vi.fn(async (): Promise<InboxAssistantResult<null>> => ok(null)),
  onActivity: vi.fn((listener: (activity: InboxAssistantActivity) => void) => {
    activityListeners.add(listener);
    return () => { activityListeners.delete(listener); offActivity(); };
  }),
};

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  confirm.mockReset();
  confirm.mockResolvedValue(true);
  activityListeners.clear();
  api.accounts.mockImplementation(async () => ok(accounts));
  api.history.mockImplementation(async () => ok([]));
  api.chats.mockImplementation(async () => ok({ chats: [summary(), summary('chat-2')], activeChatId: 'chat-1' }));
  api.chat.mockImplementation(async id => ok(chat(id)));
  api.createChat.mockImplementation(async () => ok(chat('chat-new')));
  api.renameChat.mockImplementation(async ({ chatId, title }) => ok({ ...summary(chatId), title }));
  api.updateChat.mockImplementation(async ({ chatId, ...changes }) => ok({ ...summary(chatId), ...changes }));
  api.deleteChat.mockImplementation(async chatId => { const remaining = [summary(), summary('chat-2')].filter(chat => chat.id !== chatId); return ok({ chats: remaining, activeChatId: remaining[0]?.id ?? null }); });
  api.rewindChat.mockImplementation(async ({ chatId }) => ok({ chat: { ...chat(chatId), rewindAvailable: true }, question: exchange().question, accountIds: ['other'] }));
  api.restoreRewindChat.mockImplementation(async ({ chatId }) => ok(chat(chatId, [exchange()])));
  api.draftEmail.mockImplementation(async request => ok({ chatId: request.chatId, accountId: request.accountId, to: ['buyer@tcs.example'], cc: [], subject: 'TCS quotation follow-up', body: 'Hello, please review our quotation.' }));
  api.ask.mockImplementation(async request => ok({ ...exchange(), chatId: request.chatId }));
  api.changeSet.mockReset().mockImplementation(async () => ok(changeExchange('applied')));
  api.cancel.mockImplementation(async requestId => ok({ requestId, cancelled: true }));
  api.clearHistory.mockImplementation(async () => ok(null));
  Object.assign(window, { electronAPI: { inboxAssistant: api } });
});
afterEach(cleanup);

function WorkspaceHarness() {
  const [section, setSection] = useState('assistant');
  return <><button onClick={() => setSection('mail')}>Open Inbox test</button><button onClick={() => setSection('settings')}>Open Settings test</button><button onClick={() => setSection('assistant')}>Open AI test</button>
    <AssistantWorkspace section={section} onOpenInbox={() => setSection('mail')} onOpenAssistant={() => setSection('assistant')}
      renderAssistant={props => <InboxAssistant initialView="conversation" {...props} />}><div>Mail and settings workspace</div></AssistantWorkspace></>;
}

describe('Inbox Agent background workspace', () => {
  it('keeps the same running chat alive through navigation, hiding, progress, completion and reopening', async () => {
    let complete!: (value: InboxAssistantResult<InboxAssistantExchange>) => void;
    api.ask.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    const view = render(<WorkspaceHarness />); await settle();
    const input = view.find('#inbox-assistant-question');
    typeInto(input, 'Find the TCS quote'); fire(view.byLabel('Ask Inbox Agent'), 'click'); await settle();
    const requestId = api.ask.mock.calls[0]![0].requestId;
    fire(view.all('button').find(button => button.textContent === 'Open Inbox test')!, 'click'); await settle();
    expect(view.find('[data-assistant-layout]')?.getAttribute('data-assistant-layout')).toBe('pip');
    expect(view.find('#inbox-assistant-question')).toBe(input);
    fire(view.all('button').find(button => button.textContent === 'Open Settings test')!, 'click'); await settle();
    expect(view.find('[data-assistant-layout]')?.getAttribute('data-assistant-layout')).toBe('pip');
    fire(view.byLabel('Hide AI view'), 'click'); await settle();
    expect(view.find('[data-assistant-layout]')?.getAttribute('data-assistant-layout')).toBe('hidden');
    expect(api.cancel).not.toHaveBeenCalled();
    act(() => activityListeners.forEach(listener => listener({ requestId, chatId: 'chat-1', sequence: 1, at: Date.now(), stage: 'body', status: 'running', message: 'Downloading original email' })));
    await settle();
    expect(view.byLabel('Show running AI chat')?.textContent).toContain('Downloading original email');
    expect(view.find('[data-assistant-layout]')?.getAttribute('data-assistant-layout')).toBe('hidden');
    await act(async () => { complete(ok(exchange())); }); await settle();
    expect(view.find('.assistant-launcher')).toBeNull();
    // Startup and completion both fetch the active chat, including its durable run accounting.
    expect(api.chat.mock.calls.map(([id]) => id)).toEqual(['chat-1', 'chat-1']);
    expect(api.ask).toHaveBeenCalledTimes(1);
    expect(api.cancel).not.toHaveBeenCalled();
    fire(view.all('button').find(button => button.textContent === 'Open AI test')!, 'click'); await settle();
    expect(view.find('#inbox-assistant-question')).toBe(input);
    expect(view.container.textContent).toContain('You sent a revised quote');
    fire(view.byLabel('Inbox + AI split view'), 'click'); await settle();
    expect(view.find('[data-assistant-layout]')?.getAttribute('data-assistant-layout')).toBe('split');
    expect(view.find('#inbox-assistant-question')).toBe(input);
    fire(view.byLabel('Open full AI chat'), 'click'); await settle();
    expect(view.find('[data-assistant-layout]')?.getAttribute('data-assistant-layout')).toBe('full');
    expect(view.find('#inbox-assistant-question')).toBe(input);
    expect(api.cancel).not.toHaveBeenCalled();
  });

  it('can be stopped explicitly from the floating view without treating Hide as Stop', async () => {
    api.ask.mockImplementationOnce(() => new Promise(() => {}));
    const view = render(<WorkspaceHarness />); await settle();
    typeInto(view.find('#inbox-assistant-question'), 'Review unread mail'); fire(view.byLabel('Ask Inbox Agent'), 'click'); await settle();
    fire(view.byLabel('Float AI chat'), 'click'); await settle();
    expect(view.find('[data-assistant-layout]')?.getAttribute('data-assistant-layout')).toBe('pip');
    fire(view.byLabel('Stop answering'), 'click'); await settle();
    expect(api.cancel).toHaveBeenCalledExactlyOnceWith(api.ask.mock.calls[0]![0].requestId);
    expect(view.container.textContent).toContain('Stopped');
  });
});

async function mount(props = {}) {
  const view = render(<InboxAssistant initialView="conversation" {...props} />);
  await settle();
  return view;
}
function button(view: ReturnType<typeof render>, text: string) {
  return view.all('button').find(element => element.textContent?.trim() === text) ?? null;
}
/** The chat as main saves it once the latest question ends: its exchange carries what that run did. */
function savedAfterAsk(saved: Partial<InboxAssistantExchange>) {
  api.chat.mockImplementation(async id => {
    const requestId = api.ask.mock.calls.at(-1)?.[0].requestId;
    return ok(chat(id, id === 'chat-1' && requestId ? [{ ...exchange('exchange-failed'), question: 'Undo that', status: 'failed', ...saved, requestId }] : []));
  });
}
function submit(view: ReturnType<typeof render>, text = 'What quote did I send to TCS?') {
  typeInto(view.find('textarea'), text);
  fire(view.find('form'), 'submit');
}
function activity(sequence: number, message: string, over: Partial<InboxAssistantActivity> = {}): InboxAssistantActivity {
  return { requestId: api.ask.mock.calls[api.ask.mock.calls.length - 1]?.[0].requestId ?? 'historical-request', sequence, at: 1720000000000 + sequence * 1000, stage: 'search', status: 'running', message, ...over };
}
function emit(event: InboxAssistantActivity) {
  act(() => { for (const listener of activityListeners) listener(event); });
}

describe('Inbox Agent', () => {
  it.each(['current', 'legacy'] as const)('distinguishes %s unverified related mail and exposes missing reads without opening Activity first', async version => {
    const incomplete = exchange();
    incomplete.answer = { ...incomplete.answer,
      text: 'I found related mail, but could not verify an answer from the available content. Open the sources to review them.',
      ...(version === 'current' ? { sourceStatus: 'related' as const } : {}),
      coverage: [{ ...incomplete.answer.coverage[0]!, missingBodies: 1, attachmentsSkipped: 2 }],
      warnings: ['Some AI statements were omitted because their source references or excerpts could not be verified.'] };
    api.chat.mockImplementation(async id => ok(chat(id, [incomplete])));
    const view = await mount();
    expect(view.byLabel('Related emails')?.textContent).toContain('Related emails to inspect');
    expect(view.byLabel('Answer sources')).toBeNull();
    const status = view.byLabel('Answer reading status')!;
    expect(status.textContent).toContain('Needs verification');
    expect(status.textContent).toContain('1 email body was unavailable');
    expect(status.textContent).toContain('2 attachments were not read');
    expect(status.textContent).toContain('Statements that could not be verified were left out');
    fire(button(view, 'View reading details'), 'click'); await settle();
    expect(view.find('aside')?.textContent).toContain('Notes and limitations');
  });

  it('keeps verified citations distinct from related emails without adding routine warnings', async () => {
    const verified = exchange();
    verified.answer.sourceStatus = 'verified';
    api.chat.mockImplementation(async id => ok(chat(id, [verified])));
    const view = await mount();
    expect(view.byLabel('Answer sources')).not.toBeNull();
    expect(view.byLabel('Related emails')).toBeNull();
    expect(view.byLabel('Answer reading status')).toBeNull();
  });

  it('shows actual account and search-limit gaps even when the cited facts are verified', async () => {
    const partial = exchange();
    partial.answer.sourceStatus = 'verified';
    partial.answer.coverage = [{ ...partial.answer.coverage[0]!, truncated: true },
      { ...partial.answer.coverage[0]!, accountId: 'offline', status: 'unavailable' }];
    api.chat.mockImplementation(async id => ok(chat(id, [partial])));
    const view = await mount();
    expect(view.byLabel('Answer sources')).not.toBeNull();
    expect(view.byLabel('Answer reading status')?.textContent).toContain('1 selected account could not be searched');
    expect(view.byLabel('Answer reading status')?.textContent).toContain('More matching emails may remain beyond the search limit');
    expect(view.byLabel('Answer reading status')?.textContent).not.toContain('Needs verification');
  });

  // Breaks: opening a new conversation cancels an approved change still running,
  // or its receipt lands in the new conversation instead of its own.
  it('keeps an approved change in its original chat when a new conversation is opened', async () => {
    api.chat.mockImplementation(async id => ok(chat(id, id === 'chat-1' ? [changeExchange('pending')] : [])));
    let finish!: (value: InboxAssistantResult<InboxAssistantExchange>) => void;
    api.changeSet.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const view = await mount();
    fire(button(view, 'Approve'), 'click'); await settle();
    fire(button(view, 'New conversation'), 'click'); await settle();
    expect(view.container.textContent).not.toContain('Mark 1 email read');
    expect(api.cancel).not.toHaveBeenCalled();
    await act(async () => finish(ok({ ...changeExchange('applied'), updatedAt: Date.now() })));
    await settle();
    expect(view.container.textContent).not.toContain('Applied · 1 email changed');
    fire(view.byLabel('Open conversation: TCS quotations'), 'click'); await settle();
    expect(view.container.textContent).toContain('Applied · 1 email changed');
    expect(api.changeSet).toHaveBeenCalledOnce();
    expect(api.cancel).not.toHaveBeenCalled();
  });

  // Breaks: a change still running when the window reopens loses its progress
  // or its Stop, or restoring it submits the mail change a second time.
  it('restores a running change\'s progress and Stop without submitting another mail action', async () => {
    const pending = changeExchange('pending');
    const run = { requestId: 'restored-action', chatId: 'chat-1', kind: 'action' as const, question: 'Mark 1 email read',
      accountIds: ['work', 'other'], exchangeId: pending.id, status: 'running' as const, startedAt: Date.now(), updatedAt: Date.now(),
      activities: [{ requestId: 'restored-action', chatId: 'chat-1', sequence: 1, at: Date.now(), stage: 'action' as const,
        status: 'running' as const, message: 'Marking 1 email read' }] };
    api.chats.mockResolvedValue(ok({ activeChatId: 'chat-1', chats: [{ ...summary(), activeRun: run }] }));
    api.chat.mockResolvedValue(ok({ ...chat('chat-1', [pending]), activeRun: run }));
    const view = await mount();
    expect(view.byLabel('View current activity')?.textContent).toContain('Marking 1 email read');
    expect(api.changeSet).not.toHaveBeenCalled();
    const stop = view.byLabel('Stop answering')!;
    expect(stop.closest('form')?.contains(view.find('#inbox-assistant-question'))).toBe(true);
    expect(view.all('button[aria-label="Stop answering"]')).toHaveLength(1);
    fire(stop, 'click'); await settle();
    expect(api.cancel).toHaveBeenCalledExactlyOnceWith('restored-action');
    expect(api.changeSet).not.toHaveBeenCalled();
  });

  // Breaks: a conversation saved before the unread review was retired loses its
  // answer, or still offers review buttons whose handler no longer exists.
  it('shows an earlier version\'s saved review as its answer and a note, with no review buttons', async () => {
    const saved = reviewReceipt(reviewExchange());
    api.chat.mockImplementation(async id => ok(chat(id, [saved, { ...reviewExchange({ id: 'pending-review', createdAt: saved.createdAt + 1 }), question: 'Review my uncategorized unread emails.' }])));
    const view = await mount();
    for (const question of [saved.question, 'Review my uncategorized unread emails.']) {
      const answer = view.byLabel(`Answer to ${question}`)!;
      expect(answer.querySelector('[role="note"]')?.textContent).toBe('Made by an earlier version of Inbox Agent. Its buttons are no longer available: ask again to review your mail.');
      expect(answer.querySelectorAll('input')).toHaveLength(0);
      expect([...answer.querySelectorAll('button')].map(element => element.textContent?.trim()).filter(text => /mark|review|undo|archive|trash|continue|selection|keep/i.test(text ?? ''))).toEqual([]);
    }
    expect(view.byLabel(`Answer to ${saved.question}`)?.textContent).toContain('Selected conversations were marked read.');
    expect(view.byLabel('Undo marked read: Unread item-a (owner@example.test)')).toBeNull();
    expect(view.byLabel('Move selected conversations to Trash')).toBeNull();
    expect(api.ask).not.toHaveBeenCalled();
    expect(api.changeSet).not.toHaveBeenCalled();
  });

  // Breaks: an earlier version's automatic-review batch renders its rows as live
  // checkboxes, or offers the review refresh that no longer exists.
  it('shows an earlier version\'s automatic batch collapsed, with only the note when expanded', async () => {
    const original = reviewExchange();
    const batch = reviewExchange({ id: 'automatic-batch-two', reviewBatch: { runId: 'automatic-request', number: 2 },
      createdAt: original.createdAt + 1, review: { ...original.review!, id: 'batch-two-review',
        items: Array.from({ length: 200 }, (_, index) => reviewItem(`batch-${index}`)) } });
    api.chat.mockImplementation(async id => ok(chat(id, [original, batch])));
    const view = await mount();
    const receipt = view.byLabel('Automatic review batch 2')!;
    expect(receipt.textContent).toContain('200 conversations reviewed');
    expect(receipt.querySelector('[role="note"]')).toBeNull();
    fire(receipt.querySelector('button'), 'click'); await settle();
    expect(receipt.querySelector('[role="note"]')?.textContent).toContain('Made by an earlier version of Inbox Agent');
    expect(receipt.querySelectorAll('input')).toHaveLength(0);
    expect(receipt.querySelectorAll('button')).toHaveLength(1);
    expect(api.ask).not.toHaveBeenCalled();
    expect(api.changeSet).not.toHaveBeenCalled();
  });

  it('keeps Stop locked until acknowledgement, suppresses stale progress and then permits editing the stopped question', async () => {
    let resolveCancel!: (value: InboxAssistantResult<InboxAssistantCancellation>) => void;
    let resolveAsk!: (value: InboxAssistantResult<InboxAssistantExchange>) => void;
    api.cancel.mockImplementationOnce(() => new Promise(resolve => { resolveCancel = resolve; }));
    api.ask.mockImplementationOnce(() => new Promise(resolve => { resolveAsk = resolve; }));
    const view = await mount();
    submit(view, 'Find the current customer quote.');
    const requestId = api.ask.mock.calls[0]![0].requestId;
    emit(activity(1, 'Reading quote sources'));
    fire(view.byLabel('Stop answering'), 'click');
    expect((view.byLabel('Stopping request') as HTMLButtonElement).disabled).toBe(true);
    expect(view.byLabel('View stopping activity')?.textContent).toContain('Stopping…');
    expect((view.find('#inbox-assistant-question') as HTMLTextAreaElement).readOnly).toBe(true);
    fire(view.find('form'), 'submit');
    expect(api.ask).toHaveBeenCalledOnce();
    emit(activity(2, 'Stale quote source', { requestId }));
    await act(async () => resolveCancel(ok({ requestId, cancelled: true })));
    expect(view.byLabel('Stopping request')).toBeNull();
    expect((view.find('#inbox-assistant-question') as HTMLTextAreaElement).readOnly).toBe(false);
    fire(view.byLabel('Edit question: Find the current customer quote.'), 'click');
    typeInto(view.find('#inbox-assistant-question'), 'Find the revised customer quote.');
    expect(api.rewindChat).not.toHaveBeenCalled();
    await act(async () => resolveAsk(ok(exchange())));
    expect(view.container.textContent).not.toContain('You sent a revised quote');
    expect((view.find('#inbox-assistant-question') as HTMLTextAreaElement).value).toBe('Find the revised customer quote.');
    fire(view.byLabel('View stopped activity'), 'click');
    expect(view.byLabel('Work timeline')?.textContent).toContain('Reading quote sources');
    expect(view.container.textContent).not.toContain('Stale quote source');
  });

  it('shows a failed stop and permits retry without starting another request before acknowledgement', async () => {
    api.ask.mockImplementationOnce(() => new Promise(() => {}));
    api.cancel.mockResolvedValueOnce({ success: false, error: 'Could not acknowledge Stop.' });
    const view = await mount();
    submit(view);
    const requestId = api.ask.mock.calls[0]![0].requestId;
    fire(view.byLabel('Stop answering'), 'click');
    await settle();
    expect(view.find('[role="alert"]')?.textContent).toContain('Could not acknowledge Stop.');
    expect((view.find('#inbox-assistant-question') as HTMLTextAreaElement).readOnly).toBe(true);
    fire(view.find('form'), 'submit');
    expect(api.ask).toHaveBeenCalledOnce();
    fire(view.byLabel('Retry stop'), 'click');
    await settle();
    expect(api.cancel).toHaveBeenNthCalledWith(2, requestId);
    expect((view.find('#inbox-assistant-question') as HTMLTextAreaElement).readOnly).toBe(false);
  });

  // Breaks: mail an "Approve for me" answer changed after Stop is hidden, the
  // newer question is lost, or the late result is shown as a fresh answer.
  it('retains a stopped answer\'s applied-change receipt without losing a newer question or treating the late result as a new answer', async () => {
    let resolveAsk!: (value: InboxAssistantResult<InboxAssistantExchange>) => void;
    api.ask.mockImplementationOnce(() => new Promise(resolve => { resolveAsk = resolve; }));
    const onMailChanged = vi.fn();
    const view = await mount({ onMailChanged });
    submit(view);
    fire(view.byLabel('Stop answering'), 'click');
    await settle();
    typeInto(view.find('#inbox-assistant-question'), 'Keep this next question.');
    await act(async () => resolveAsk(ok(changeExchange('applied'))));
    expect(view.container.textContent).toContain('Applied · 1 email changed');
    expect(button(view, 'Undo 1 email')).not.toBeNull();
    expect((view.find('#inbox-assistant-question') as HTMLTextAreaElement).value).toBe('Keep this next question.');
    expect(view.byLabel('View stopped activity')).not.toBeNull();
    expect(onMailChanged).toHaveBeenCalledOnce();
    expect(api.changeSet).not.toHaveBeenCalled();
  });

  it('opens an earlier question editor without changing history until Save and rewind succeeds', async () => {
    const first = exchange('first');
    first.question = 'Find the original quote.';
    const second = { ...exchange('second'), question: 'What changed in the revision?', accountIds: ['other'] };
    api.chat.mockImplementation(async id => ok(chat(id, [first, second])));
    api.rewindChat.mockResolvedValueOnce(ok({ chat: { ...chat('chat-1', [first]), rewindAvailable: true }, question: second.question, accountIds: ['other'] }));
    const onMailChanged = vi.fn();
    const onCloseSourcePane = vi.fn();
    const view = await mount({ onMailChanged, onCloseSourcePane });
    typeInto(view.find('#inbox-assistant-question'), 'Unsaved next question.');
    fire(view.byLabel(`Edit question: ${second.question}`), 'click');
    expect((view.byLabel('Edit question') as HTMLTextAreaElement).value).toBe(second.question);
    expect(view.container.textContent).toContain('Mail changes already made will remain.');
    typeInto(view.byLabel('Edit question'), 'Compare the revised price and scope.');
    expect(api.rewindChat).not.toHaveBeenCalled();
    expect(view.byLabel(`Answer to ${second.question}`)).not.toBeNull();
    fire(button(view, 'Save and rewind'), 'click');
    await settle();
    expect(api.rewindChat).toHaveBeenCalledExactlyOnceWith({ chatId: 'chat-1', exchangeId: 'second' });
    expect(view.byLabel(`Answer to ${first.question}`)).not.toBeNull();
    expect(view.byLabel(`Answer to ${second.question}`)).toBeNull();
    expect((view.find('#inbox-assistant-question') as HTMLTextAreaElement).value).toBe('Compare the revised price and scope.');
    expect(document.activeElement).toBe(view.find('#inbox-assistant-question'));
    expect(view.find('button[aria-controls="assistant-account-picker"]')?.textContent).toContain('1 of 2 accounts');
    expect(button(view, 'Restore previous conversation')).not.toBeNull();
    expect(onCloseSourcePane).toHaveBeenCalledOnce();
    expect(onMailChanged).not.toHaveBeenCalled();
    expect(api.changeSet).not.toHaveBeenCalled();
    expect(api.ask).not.toHaveBeenCalled();
    fire(view.find('form'), 'submit');
    await settle();
    expect(api.ask).toHaveBeenCalledExactlyOnceWith({ requestId: expect.any(String), chatId: 'chat-1', question: 'Compare the revised price and scope.', accountIds: ['other'], previousExchangeId: 'first' });
  });

  it('cancels editing locally and retains saved answers plus the unsent composer draft', async () => {
    const saved = exchange();
    api.chat.mockImplementation(async id => ok(chat(id, [saved])));
    const view = await mount();
    typeInto(view.find('#inbox-assistant-question'), 'My pending question.');
    fire(view.byLabel(`Edit question: ${saved.question}`), 'click');
    typeInto(view.byLabel('Edit question'), 'Do not keep this edit.');
    fire(button(view, 'Cancel edit'), 'click');
    expect(view.byLabel(`Answer to ${saved.question}`)).not.toBeNull();
    expect((view.find('#inbox-assistant-question') as HTMLTextAreaElement).value).toBe('My pending question.');
    expect(api.rewindChat).not.toHaveBeenCalled();
    expect(api.restoreRewindChat).not.toHaveBeenCalled();
  });

  it('keeps the original history and edited text when the host rejects rewind', async () => {
    const saved = changeExchange('applied');
    api.chat.mockImplementation(async id => ok(chat(id, [saved])));
    api.rewindChat.mockResolvedValueOnce({ success: false, error: 'The conversation is still stopping.' });
    const onMailChanged = vi.fn();
    const view = await mount({ onMailChanged });
    fire(view.byLabel(`Edit question: ${saved.question}`), 'click');
    typeInto(view.byLabel('Edit question'), 'Review only routine notifications.');
    fire(button(view, 'Save and rewind'), 'click');
    await settle();
    expect(view.find('[role="alert"]')?.textContent).toContain('still stopping');
    expect((view.byLabel('Edit question') as HTMLTextAreaElement).value).toBe('Review only routine notifications.');
    expect(view.container.textContent).toContain('Applied · 1 email changed');
    expect(button(view, 'Undo 1 email')).not.toBeNull();
    expect(onMailChanged).not.toHaveBeenCalled();
  });

  it('ignores a rewind response after switching chats and does not restore its question or account scope in the other chat', async () => {
    const saved = exchange();
    api.chat.mockImplementation(async id => ok(chat(id, id === 'chat-1' ? [saved] : [])));
    let resolveRewind!: (value: InboxAssistantResult<InboxAssistantRewind>) => void;
    api.rewindChat.mockImplementationOnce(() => new Promise(resolve => { resolveRewind = resolve; }));
    const view = await mount();
    fire(view.byLabel(`Edit question: ${saved.question}`), 'click');
    typeInto(view.byLabel('Edit question'), 'Private edited question.');
    fire(button(view, 'Save and rewind'), 'click');
    fire(view.byLabel('Open conversation: Meeting follow-ups'), 'click');
    await settle();
    await act(async () => resolveRewind(ok({ chat: { ...chat(), rewindAvailable: true }, question: saved.question, accountIds: ['other'] })));
    expect(view.find('h1')?.textContent).toBe('Meeting follow-ups');
    expect((view.find('#inbox-assistant-question') as HTMLTextAreaElement).value).toBe('');
    expect(view.container.textContent).not.toContain('Private edited question.');
    expect(button(view, 'All accounts (2)')).not.toBeNull();
    expect(button(view, 'Restore previous conversation')).toBeNull();
    expect((view.find('#inbox-assistant-question') as HTMLTextAreaElement).disabled).toBe(false);
  });

  it('restores a recoverable conversation including its action receipts without reversing or repeating mail changes', async () => {
    const saved = changeExchange('applied');
    api.chat.mockImplementation(async id => ok({ ...chat(id), rewindAvailable: true }));
    api.restoreRewindChat.mockResolvedValueOnce(ok({ ...chat('chat-1', [saved]), rewindAvailable: true }));
    const onMailChanged = vi.fn();
    const view = await mount({ onMailChanged });
    fire(button(view, 'Restore previous conversation'), 'click');
    await settle();
    expect(api.restoreRewindChat).toHaveBeenCalledExactlyOnceWith({ chatId: 'chat-1' });
    expect(view.container.textContent).toContain('Applied · 1 email changed');
    expect(button(view, 'Undo 1 email')).not.toBeNull();
    expect(api.changeSet).not.toHaveBeenCalled();
    expect(onMailChanged).not.toHaveBeenCalled();
    expect(api.ask).not.toHaveBeenCalled();
  });

  it('fills each action starter into the composer without running a search or mail action', async () => {
    const view = await mount();
    const choices = [
      ['Review unread', 'Review my unread emails and mark low-value conversations as read.'],
      ['Review uncategorized', 'Review my uncategorized unread emails.'],
      ['Find an answer', 'What quote did I send to TCS?'],
      ['Find what needs a reply', 'Which recent customer emails need a response?'],
    ];
    for (const [title, question] of choices) {
      const starter = view.all('button').find(element => element.textContent?.startsWith(title!))!;
      fire(starter, 'click');
      expect((view.find('textarea') as HTMLTextAreaElement).value).toBe(question);
      expect(document.activeElement).toBe(view.find('textarea'));
    }
    expect(api.ask).not.toHaveBeenCalled();
    expect(api.changeSet).not.toHaveBeenCalled();
    expect(api.updateChat).not.toHaveBeenCalled();
  });

  // Breaks: the control describes a scope other than the one the host enforces.
  // Changed on purpose: the description now comes from ACTION_MODE_DESCRIPTION.
  it('offers exactly two clearly named modes and defaults to asking for approval', async () => {
    const view = await mount();
    const select = view.byLabel('Action mode') as HTMLSelectElement;
    expect([...select.options].map(option => ({ value: option.value, label: option.text }))).toEqual([
      { value: 'review', label: 'Ask for approval' }, { value: 'approve_for_me', label: 'Approve for me' },
    ]);
    expect(select.value).toBe('review');
    expect(select.title).toBe(ACTION_MODE_DESCRIPTION.review);
    expect(api.updateChat).not.toHaveBeenCalled();
  });

  // Breaks: one click widens what the agent may change without a card, without the user seeing what it covers.
  it('asks before turning Approve for me on, naming what it covers; Cancel keeps Ask for approval and saves nothing', async () => {
    confirm.mockResolvedValueOnce(false);
    const view = await mount();
    const select = view.byLabel('Action mode') as HTMLSelectElement;
    act(() => { select.value = 'approve_for_me'; select.dispatchEvent(new Event('change', { bubbles: true })); });
    await settle();
    expect(confirm).toHaveBeenCalledOnce();
    const options = confirm.mock.calls[0]![0];
    expect(options).toEqual({ title: 'Let Inbox Agent change mail without asking?', message: ACTION_MODE_DESCRIPTION.approve_for_me, confirmLabel: 'Approve for me', destructive: false });
    for (const words of ['200', 'archive', 'Trash', 'filters', 'protected emails']) expect(options.message).toContain(words);
    expect(api.updateChat).not.toHaveBeenCalled();
    expect((view.byLabel('Action mode') as HTMLSelectElement).value).toBe('review');
    expect((view.byLabel('Action mode') as HTMLSelectElement).disabled).toBe(false);
    expect((view.find('textarea') as HTMLTextAreaElement).readOnly).toBe(false);
  });

  // Breaks: the confirmed choice is lost, or switching to the safer mode is gated behind a dialog.
  it('saves Approve for me once confirmed, and switches back to Ask for approval without asking', async () => {
    const view = await mount();
    const select = () => view.byLabel('Action mode') as HTMLSelectElement;
    act(() => { select().value = 'approve_for_me'; select().dispatchEvent(new Event('change', { bubbles: true })); });
    await settle();
    expect(confirm).toHaveBeenCalledOnce();
    expect(api.updateChat).toHaveBeenCalledExactlyOnceWith({ chatId: 'chat-1', actionMode: 'approve_for_me' });
    expect(select().value).toBe('approve_for_me');
    expect(select().title).toBe(ACTION_MODE_DESCRIPTION.approve_for_me);
    act(() => { select().value = 'review'; select().dispatchEvent(new Event('change', { bubbles: true })); });
    await settle();
    expect(confirm).toHaveBeenCalledOnce();
    expect(api.updateChat).toHaveBeenLastCalledWith({ chatId: 'chat-1', actionMode: 'review' });
    expect(select().value).toBe('review');
    expect(select().title).toBe(ACTION_MODE_DESCRIPTION.review);
  });

  // Breaks: consent given in a dialog opened for one conversation lands on another.
  it('changes no mode when another conversation is opened while the confirmation is open', async () => {
    let decide!: (value: boolean) => void;
    confirm.mockImplementationOnce(() => new Promise(resolve => { decide = resolve; }));
    const view = await mount();
    const select = () => view.byLabel('Action mode') as HTMLSelectElement;
    act(() => { select().value = 'approve_for_me'; select().dispatchEvent(new Event('change', { bubbles: true })); });
    expect(confirm).toHaveBeenCalledOnce();
    // The control stays locked while the question is open.
    expect(select().disabled).toBe(true);
    fire(view.byLabel('Open conversation: Meeting follow-ups'), 'click');
    await settle();
    await act(async () => decide(true));
    await settle();
    expect(api.updateChat).not.toHaveBeenCalled();
    expect(view.find('h1')?.textContent).toBe('Meeting follow-ups');
    expect(select().value).toBe('review');
    expect(select().disabled).toBe(false);
  });

  // Breaks: a confirmation answered after the assistant closed still changes the chat's mode.
  it('saves nothing when the assistant closes while the confirmation is open', async () => {
    let decide!: (value: boolean) => void;
    confirm.mockImplementationOnce(() => new Promise(resolve => { decide = resolve; }));
    const view = await mount();
    const select = view.byLabel('Action mode') as HTMLSelectElement;
    act(() => { select.value = 'approve_for_me'; select.dispatchEvent(new Event('change', { bubbles: true })); });
    view.unmount();
    await act(async () => decide(true));
    await settle();
    expect(api.updateChat).not.toHaveBeenCalled();
  });

  // Breaks: the confirmed mode is not kept across requests, or changing it drops the draft or account scope.
  // Changed on purpose: turning it on now confirms first, and the title is ACTION_MODE_DESCRIPTION.
  it('persists Approve for me across requests while retaining draft text and chosen account scope', async () => {
    let savedMode: InboxAssistantActionMode = 'review';
    api.updateChat.mockImplementation(async ({ chatId, ...changes }) => {
      if (changes.actionMode) savedMode = changes.actionMode;
      return ok({ ...summary(chatId), ...changes });
    });
    api.chats.mockImplementation(async () => ok({ chats: [{ ...summary(), actionMode: savedMode }, summary('chat-2')], activeChatId: 'chat-1' }));
    const view = await mount();
    fire(button(view, 'All accounts (2)'), 'click');
    toggle(view.all('input[type="checkbox"]')[0]!);
    typeInto(view.find('textarea'), 'Keep this unread review question.');
    const select = view.byLabel('Action mode') as HTMLSelectElement;
    act(() => { select.value = 'approve_for_me'; select.dispatchEvent(new Event('change', { bubbles: true })); });
    await settle();
    expect(api.updateChat).toHaveBeenCalledExactlyOnceWith({ chatId: 'chat-1', actionMode: 'approve_for_me' });
    expect((view.byLabel('Action mode') as HTMLSelectElement).value).toBe('approve_for_me');
    expect(confirm).toHaveBeenCalledOnce();
    expect((view.byLabel('Action mode') as HTMLSelectElement).title).toBe(ACTION_MODE_DESCRIPTION.approve_for_me);
    expect((view.find('textarea') as HTMLTextAreaElement).value).toBe('Keep this unread review question.');
    expect(view.find('button[aria-controls="assistant-account-picker"]')?.textContent).toContain('1 of 2 accounts');
    expect(api.chat).toHaveBeenCalledExactlyOnceWith('chat-1');
    expect(api.changeSet).not.toHaveBeenCalled();
    fire(view.find('form'), 'submit');
    await settle();
    expect(api.ask).toHaveBeenCalledExactlyOnceWith({ requestId: expect.any(String), chatId: 'chat-1', question: 'Keep this unread review question.', accountIds: ['other'] });
    expect((view.byLabel('Action mode') as HTMLSelectElement).value).toBe('approve_for_me');
    submit(view, 'Find another matching conversation.');
    await settle();
    expect(api.ask).toHaveBeenCalledTimes(2);
    expect((view.byLabel('Action mode') as HTMLSelectElement).value).toBe('approve_for_me');
    expect(api.updateChat).toHaveBeenCalledOnce();
  });

  // Breaks: a save error from one conversation's mode change shows in another, or locks its composer.
  // Changed on purpose: the save starts after the confirmation, so the test lets it resolve first.
  it('keeps a late action-mode save error in its original chat after switching', async () => {
    let resolveMode!: (value: InboxAssistantResult<InboxAssistantChatSummary>) => void;
    api.updateChat.mockImplementationOnce(() => new Promise(resolve => { resolveMode = resolve; }));
    const view = await mount();
    const select = view.byLabel('Action mode') as HTMLSelectElement;
    act(() => { select.value = 'approve_for_me'; select.dispatchEvent(new Event('change', { bubbles: true })); });
    await settle();
    expect(api.updateChat).toHaveBeenCalledOnce();
    fire(view.byLabel('Open conversation: Meeting follow-ups'), 'click');
    await settle();
    await act(async () => resolveMode({ success: false, error: 'Previous chat mode could not be saved.' }));
    expect(view.find('h1')?.textContent).toBe('Meeting follow-ups');
    expect(view.container.textContent).not.toContain('Previous chat mode could not be saved.');
    expect((view.byLabel('Action mode') as HTMLSelectElement).value).toBe('review');
    expect((view.find('textarea') as HTMLTextAreaElement).disabled).toBe(false);
  });

  // Breaks: a change applied for the user under "Approve for me" is not shown as
  // applied, leaves the mail list stale, or resets the mode.
  it('renders an already-applied ask receipt and refreshes mail counts while keeping Approve for me selected', async () => {
    const applied = changeExchange('applied');
    const saved = { ...applied, changeSets: [{ ...applied.changeSets![0]!, autoApplied: true }] };
    const mode: InboxAssistantActionMode = 'approve_for_me';
    api.chat.mockImplementation(async id => ok({ ...chat(id), actionMode: mode }));
    api.chats.mockImplementation(async () => ok({ chats: [{ ...summary(), actionMode: mode }, summary('chat-2')], activeChatId: 'chat-1' }));
    api.ask.mockImplementationOnce(async () => ok(saved));
    const onMailChanged = vi.fn();
    const view = await mount({ onMailChanged });
    expect((view.byLabel('Action mode') as HTMLSelectElement).value).toBe('approve_for_me');
    submit(view, saved.question);
    await settle();
    expect(onMailChanged).toHaveBeenCalledOnce();
    expect(view.container.textContent).toContain('Applied for you · 1 email changed');
    expect(button(view, 'Undo 1 email')).not.toBeNull();
    expect((view.byLabel('Action mode') as HTMLSelectElement).value).toBe('approve_for_me');
    expect(api.changeSet).not.toHaveBeenCalled();
  });

  // Breaks: a question that fails after the agent undid an earlier change, or
  // applied one, leaves the mail list showing mail in its old place (the
  // failed IPC result carries no exchange; main saved it).
  it.each<[string, Partial<InboxAssistantExchange>]>([
    ['undid an earlier change', { undoRequests: [undoRequest({ outcome: 'undone' })] }],
    ['applied a change', { changeSets: changeExchange('applied').changeSets }],
  ])('refreshes the mail list when a failed question %s', async (_name, saved) => {
    savedAfterAsk(saved);
    api.ask.mockImplementationOnce(async () => ({ success: false, error: 'The provider failed.' }));
    const onMailChanged = vi.fn();
    const view = await mount({ onMailChanged });
    submit(view, 'Undo that'); await settle();
    expect(onMailChanged).toHaveBeenCalledOnce();
  });

  // Breaks: every failed question refreshes the mail list although it changed nothing.
  it('leaves the mail list alone when a failed question changed nothing', async () => {
    savedAfterAsk({ changeSets: changeExchange('pending').changeSets });
    api.ask.mockImplementationOnce(async () => ({ success: false, error: 'The provider failed.' }));
    const onMailChanged = vi.fn();
    const view = await mount({ onMailChanged });
    submit(view, 'Archive these'); await settle();
    expect(api.chat.mock.calls.length).toBeGreaterThan(1);
    expect(onMailChanged).not.toHaveBeenCalled();
  });

  // Breaks: stopping a question after the agent applied a change leaves the mail list stale.
  it('refreshes the mail list when a stopped question had applied a change', async () => {
    let resolveAsk!: (value: InboxAssistantResult<InboxAssistantExchange>) => void;
    api.ask.mockImplementationOnce(() => new Promise(resolve => { resolveAsk = resolve; }));
    savedAfterAsk({ changeSets: changeExchange('applied').changeSets, status: 'stopped' });
    const onMailChanged = vi.fn();
    const view = await mount({ onMailChanged });
    submit(view, 'Archive these');
    fire(view.byLabel('Stop answering'), 'click'); await settle();
    await act(async () => resolveAsk({ success: false, error: 'Request cancelled.' }));
    await settle();
    expect(onMailChanged).toHaveBeenCalledOnce();
  });

  // Breaks: a Trash card skips its confirmation in either mode, a second click
  // opens a second dialog, or the confirmed change is not the rows the user chose.
  it.each(['review', 'approve_for_me'] as const)('requires a reversible Trash confirmation before approving a Trash card in %s mode', async actionMode => {
    api.chat.mockImplementation(async id => ok({ ...chat(id, id === 'chat-1' ? [changeExchange('pending', 'trash')] : []), actionMode }));
    let decide!: (value: boolean) => void;
    confirm.mockImplementationOnce(() => new Promise(resolve => { decide = resolve; }));
    const view = await mount();
    expect(confirm).not.toHaveBeenCalled();
    fire(button(view, 'Approve'), 'click');
    expect(confirm).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ title: 'Move selected emails to Trash?', confirmLabel: 'Move to Trash', destructive: true }));
    const message = confirm.mock.calls[0]![0].message as string;
    expect(message).toContain('Move 1 email to Trash?');
    expect(message).toMatch(/not permanently|restore/i);
    expect(api.changeSet).not.toHaveBeenCalled();
    fire(button(view, 'Approve'), 'click');
    expect(confirm).toHaveBeenCalledOnce();
    await act(async () => { decide(true); });
    await settle();
    expect(api.changeSet).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ chatId: 'chat-1', exchangeId: 'exchange-change', changeSetId: 'set-1', decision: 'approve', itemIds: ['c1-1'] }));
    expect(api.ask).not.toHaveBeenCalled();
    expect(api.updateChat).not.toHaveBeenCalled();
  });

  // Breaks: declining the Trash confirmation still moves mail, or resets the rows the user chose.
  it('does not move any mail or clear the explicit selection when Trash confirmation is rejected', async () => {
    api.chat.mockImplementation(async id => ok(chat(id, id === 'chat-1' ? [twoEmailExchange('trash')] : [])));
    confirm.mockResolvedValueOnce(false);
    const onMailChanged = vi.fn();
    const view = await mount({ onMailChanged });
    toggle(view.byLabel('Include: Quarterly invoice (rc@sarv.com)'));
    fire(button(view, 'Approve selected'), 'click');
    await settle();
    expect(confirm).toHaveBeenCalledOnce();
    expect(api.changeSet).not.toHaveBeenCalled();
    expect(onMailChanged).not.toHaveBeenCalled();
    expect((view.byLabel('Include: Weekend sale (rc@sarv.com)') as HTMLInputElement).checked).toBe(true);
    expect((view.byLabel('Include: Quarterly invoice (rc@sarv.com)') as HTMLInputElement).checked).toBe(false);
  });

  // Breaks: a protected email the user ticked is changed without the extra
  // confirmation, a second click opens a second dialog, or declining still changes mail.
  it('waits for protected-email approval and leaves mail untouched when approval is rejected', async () => {
    api.chat.mockImplementation(async id => ok(chat(id, id === 'chat-1' ? [twoEmailExchange('mark_read', 'Marked important by you')] : [])));
    let decide!: (value: boolean) => void;
    confirm.mockImplementationOnce(() => new Promise(resolve => { decide = resolve; }));
    const onMailChanged = vi.fn();
    const view = await mount({ onMailChanged });
    expect((view.byLabel('Include: Quarterly invoice (rc@sarv.com)') as HTMLInputElement).checked).toBe(false);
    toggle(view.byLabel('Include: Quarterly invoice (rc@sarv.com)'));
    fire(button(view, 'Approve'), 'click');
    expect(confirm).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ title: 'Include protected emails?', confirmLabel: 'Apply to selected', message: expect.stringContaining('1 of the 2 emails you selected is protected') }));
    expect(api.changeSet).not.toHaveBeenCalled();
    // Repeated clicks while the same approval is pending cannot start another action.
    fire(button(view, 'Approve'), 'click');
    expect(confirm).toHaveBeenCalledOnce();
    await act(async () => { decide(false); });
    expect(api.changeSet).not.toHaveBeenCalled();
    expect(onMailChanged).not.toHaveBeenCalled();
    expect((view.byLabel('Include: Quarterly invoice (rc@sarv.com)') as HTMLInputElement).checked).toBe(true);
  });

  // Breaks: an approved protected email is dropped from the change in either
  // mode, or a row the user left unticked is changed anyway.
  it.each(['review', 'approve_for_me'] as const)('requires and honors protected-email approval in %s mode, passing only the ticked rows', async actionMode => {
    api.chat.mockImplementation(async id => ok({ ...chat(id, id === 'chat-1' ? [twoEmailExchange('mark_read', 'Marked important by you')] : []), actionMode }));
    let decide!: (value: boolean) => void;
    confirm.mockImplementationOnce(() => new Promise(resolve => { decide = resolve; }));
    const view = await mount();
    expect((view.byLabel('Action mode') as HTMLSelectElement).value).toBe(actionMode);
    toggle(view.byLabel('Include: Weekend sale (rc@sarv.com)'));
    toggle(view.byLabel('Include: Quarterly invoice (rc@sarv.com)'));
    fire(button(view, 'Approve selected'), 'click');
    expect(confirm).toHaveBeenCalledOnce();
    expect(api.changeSet).not.toHaveBeenCalled();
    await act(async () => { decide(true); });
    await settle();
    expect(api.changeSet).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ chatId: 'chat-1', changeSetId: 'set-1', decision: 'approve', itemIds: ['c1-2'] }));
    expect(api.ask).not.toHaveBeenCalled();
    expect(api.updateChat).not.toHaveBeenCalled();
  });

  // Breaks: a refused approval is shown as done, refreshes the mail list, or loses the rows the user chose.
  it('keeps rejected action attempts pending, surfaces their error and does not claim mail changed', async () => {
    api.chat.mockImplementation(async id => ok(chat(id, id === 'chat-1' ? [changeExchange('pending')] : [])));
    api.changeSet.mockResolvedValueOnce({ success: false, error: 'These changes are no longer available. Ask again to prepare them fresh.' });
    const onMailChanged = vi.fn();
    const view = await mount({ onMailChanged });
    fire(button(view, 'Approve'), 'click');
    await settle();
    expect(view.find('[role="alert"]')?.textContent).toContain('These changes are no longer available.');
    expect(onMailChanged).not.toHaveBeenCalled();
    expect(view.container.textContent).toContain('Waiting for your approval. Nothing has changed yet.');
    expect(button(view, 'Undo 1 email')).toBeNull();
    expect((view.byLabel('Include: Weekend sale (rc@sarv.com)') as HTMLInputElement).checked).toBe(true);
  });

  // Breaks: switching chats cancels an approved change, or its receipt and
  // activity leak into the conversation the user switched to.
  it('keeps an action running on chat switching and retains its receipt in the originating chat', async () => {
    api.chat.mockImplementation(async id => ok(chat(id, id === 'chat-1' ? [changeExchange('pending')] : [])));
    let resolveAction!: (value: InboxAssistantResult<InboxAssistantExchange>) => void;
    api.changeSet.mockImplementationOnce(() => new Promise(resolve => { resolveAction = resolve; }));
    const onMailChanged = vi.fn();
    const view = await mount({ onMailChanged });
    fire(button(view, 'Approve'), 'click');
    const requestId = api.changeSet.mock.calls[0]![0].requestId;
    fire(view.byLabel('Open conversation: Meeting follow-ups'), 'click');
    await settle();
    expect(api.cancel).not.toHaveBeenCalled();
    const receipt = { ...changeExchange('applied'), updatedAt: Date.now() };
    receipt.answer.text = 'Old change receipt must remain in the original chat.';
    await act(async () => resolveAction(ok(receipt)));
    emit(activity(5, 'Old change action details', { requestId, chatId: 'chat-1', stage: 'action' }));
    expect(onMailChanged).toHaveBeenCalledOnce(); // Acknowledged writes still refresh global mailbox counts.
    expect(view.find('h1')?.textContent).toBe('Meeting follow-ups');
    expect(view.container.textContent).not.toContain('Old change receipt');
    expect(view.container.textContent).not.toContain('Old change action details');
    expect(view.container.textContent).not.toContain('Mark 1 email read');
    expect((view.find('textarea') as HTMLTextAreaElement).disabled).toBe(false);
    fire(view.byLabel('Open conversation: TCS quotations'), 'click');
    await settle();
    expect(view.container.textContent).toContain('Old change receipt must remain in the original chat.');
  });

  // Breaks: stopping an approved change hides what it already changed, loses the
  // newer question, or accepts activity that arrived after Stop.
  it('retains a confirmed partial receipt after cancelling in the same chat without accepting late activity', async () => {
    api.chat.mockImplementation(async id => ok(chat(id, id === 'chat-1' ? [twoEmailExchange('mark_read')] : [])));
    let resolveAction!: (value: InboxAssistantResult<InboxAssistantExchange>) => void;
    api.changeSet.mockImplementationOnce(() => new Promise(resolve => { resolveAction = resolve; }));
    const onMailChanged = vi.fn();
    const view = await mount({ onMailChanged });
    typeInto(view.find('textarea'), 'Keep my next question.');
    fire(button(view, 'Approve'), 'click');
    const requestId = api.changeSet.mock.calls[0]![0].requestId;
    emit(activity(1, 'First email changed', { requestId, chatId: 'chat-1', stage: 'action' }));
    fire(view.byLabel('Stop answering'), 'click');
    expect(api.cancel).toHaveBeenCalledWith(requestId);
    const applied = changeExchange('applied');
    const first = applied.changeSets![0]!.items[0]!;
    const partial = { ...applied, updatedAt: Date.now(), changeSets: [{ ...applied.changeSets![0]!, status: 'partial' as const,
      items: [first, { ...first, id: 'c1-2', emailId: 'mail-2', threadId: 'thread-2', subject: 'Quarterly invoice', status: 'failed' as const }] }] };
    await act(async () => resolveAction(ok(partial)));
    emit(activity(2, 'Late action activity', { requestId, chatId: 'chat-1', stage: 'action' }));
    expect(view.container.textContent).toContain('Applied · 1 email changed · 1 failed');
    expect(button(view, 'Undo 1 email')).not.toBeNull();
    expect(onMailChanged).toHaveBeenCalledOnce();
    expect((view.find('textarea') as HTMLTextAreaElement).value).toBe('Keep my next question.');
    fire(view.byLabel('View stopped activity'), 'click');
    expect(view.byLabel('Work timeline')?.textContent).toContain('First email changed');
    expect(view.container.textContent).not.toContain('Late action activity');
  });

  it('pins and unpins using summary updates without reading another chat or losing the current draft', async () => {
    const onCloseSourcePane = vi.fn();
    const view = await mount({ onCloseSourcePane });
    typeInto(view.find('textarea'), 'Keep this draft question.');
    fire(view.byLabel('Pin conversation: Meeting follow-ups'), 'click');
    await settle();
    expect(api.updateChat).toHaveBeenCalledExactlyOnceWith({ chatId: 'chat-2', pinned: true });
    expect(view.byLabel('Pinned conversations')?.textContent).toContain('Meeting follow-ups');
    expect(api.chat).toHaveBeenCalledExactlyOnceWith('chat-1');
    expect((view.find('textarea') as HTMLTextAreaElement).value).toBe('Keep this draft question.');
    expect(onCloseSourcePane).not.toHaveBeenCalled();
    fire(view.byLabel('Unpin conversation: Meeting follow-ups'), 'click');
    await settle();
    expect(api.updateChat).toHaveBeenLastCalledWith({ chatId: 'chat-2', pinned: false });
    expect(view.byLabel('Recent conversations')?.textContent).toContain('Meeting follow-ups');
  });

  it('waits for deletion confirmation and leaves inactive-chat context untouched', async () => {
    let decide!: (confirmed: boolean) => void;
    confirm.mockImplementationOnce(() => new Promise(resolve => { decide = resolve; }));
    const onCloseSourcePane = vi.fn();
    const view = await mount({ onCloseSourcePane, sourcePane: <div>Current email source</div> });
    typeInto(view.find('textarea'), 'Keep my current question.');
    fire(view.byLabel('Delete conversation: Meeting follow-ups'), 'click');
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ title: 'Delete conversation', destructive: true, message: expect.stringContaining('cannot be undone') }));
    expect(api.deleteChat).not.toHaveBeenCalled();
    expect(view.byLabel('Open conversation: Meeting follow-ups')).not.toBeNull();
    await act(async () => decide(true));
    expect(api.deleteChat).toHaveBeenCalledExactlyOnceWith('chat-2');
    expect(view.byLabel('Open conversation: Meeting follow-ups')).toBeNull();
    expect(view.find('h1')?.textContent).toBe('TCS quotations');
    expect((view.find('textarea') as HTMLTextAreaElement).value).toBe('Keep my current question.');
    expect(view.byLabel('Assistant email source')?.textContent).toContain('Current email source');
    expect(onCloseSourcePane).not.toHaveBeenCalled();
    expect(api.chat).toHaveBeenCalledExactlyOnceWith('chat-1');
  });

  it('leaves a conversation intact when its deletion is cancelled', async () => {
    confirm.mockResolvedValueOnce(false);
    const view = await mount();
    fire(view.byLabel('Delete conversation: TCS quotations'), 'click');
    await settle();
    expect(api.deleteChat).not.toHaveBeenCalled();
    expect(view.byLabel('Open conversation: TCS quotations')).not.toBeNull();
    expect(view.find('h1')?.textContent).toBe('TCS quotations');
  });

  it('selects the returned next conversation after deleting the active chat and creates only when none remain', async () => {
    const view = await mount();
    fire(view.byLabel('Delete conversation: TCS quotations'), 'click');
    await settle();
    expect(api.chat).toHaveBeenLastCalledWith('chat-2');
    expect(view.find('h1')?.textContent).toBe('Meeting follow-ups');
    expect(api.createChat).not.toHaveBeenCalled();
    api.deleteChat.mockImplementationOnce(async () => ok({ chats: [], activeChatId: null }));
    fire(view.byLabel('Delete conversation: Meeting follow-ups'), 'click');
    await settle();
    expect(api.createChat).toHaveBeenCalledOnce();
    expect(view.find('h1')?.textContent).toBe('New conversation');
    expect(api.clearHistory).not.toHaveBeenCalled();
  });

  it('restores persisted pin and deletion metadata on remount without loading other chat bodies', async () => {
    let stored = [summary(), summary('chat-2')];
    api.chats.mockImplementation(async () => ok({ chats: stored, activeChatId: 'chat-1' }));
    api.chat.mockImplementation(async id => ok({ ...chat(id), ...stored.find(item => item.id === id) }));
    api.updateChat.mockImplementation(async ({ chatId, pinned }) => {
      const updated = { ...summary(chatId), pinned };
      stored = stored.map(item => item.id === chatId ? updated : item);
      return ok(updated);
    });
    api.deleteChat.mockImplementation(async id => { stored = stored.filter(item => item.id !== id); return ok({ chats: stored, activeChatId: 'chat-1' }); });
    const view = await mount();
    fire(view.byLabel('Pin conversation: TCS quotations'), 'click');
    await settle();
    fire(view.byLabel('Delete conversation: Meeting follow-ups'), 'click');
    await settle();
    view.unmount();
    const restored = await mount();
    expect(restored.byLabel('Pinned conversations')?.textContent).toContain('TCS quotations');
    expect(restored.byLabel('Open conversation: Meeting follow-ups')).toBeNull();
    expect(api.chat.mock.calls.map(([id]) => id)).toEqual(['chat-1', 'chat-1']);
  });

  it('surfaces pin and deletion failures while retaining the affected conversation', async () => {
    api.updateChat.mockImplementationOnce(async () => ({ success: false, error: 'Pin could not be saved.' }));
    const view = await mount();
    fire(view.byLabel('Pin conversation: Meeting follow-ups'), 'click');
    await settle();
    expect(view.byLabel('Assistant chats')?.textContent).toContain('Pin could not be saved.');
    expect(view.byLabel('Recent conversations')?.textContent).toContain('Meeting follow-ups');
    api.deleteChat.mockImplementationOnce(async () => ({ success: false, error: 'Conversation could not be deleted.' }));
    fire(view.byLabel('Delete conversation: Meeting follow-ups'), 'click');
    await settle();
    expect(view.byLabel('Assistant chats')?.textContent).toContain('Conversation could not be deleted.');
    expect(view.byLabel('Open conversation: Meeting follow-ups')).not.toBeNull();
  });

  it('drafts from the saved full chat in the chosen sending account and hands plain text to the existing composer', async () => {
    const onOpenDraft = vi.fn();
    api.chat.mockImplementation(async id => ok(chat(id, [exchange('first'), exchange('second')])));
    const view = await mount({ onOpenDraft, defaultDraftAccountId: 'other' });
    fire(button(view, 'Draft email'), 'click');
    expect((view.byLabel('Draft sending account') as HTMLSelectElement).value).toBe('other');
    const select = view.byLabel('Draft sending account') as HTMLSelectElement;
    act(() => { select.value = 'work'; select.dispatchEvent(new Event('change', { bubbles: true })); });
    typeInto(view.byLabel('Draft instructions'), 'Summarize the discussion and ask for approval.');
    fire(view.byLabel('Draft from conversation'), 'submit');
    await settle();
    expect(api.draftEmail).toHaveBeenCalledExactlyOnceWith({ requestId: expect.any(String), chatId: 'chat-1', accountId: 'work', instructions: 'Summarize the discussion and ask for approval.' });
    expect(onOpenDraft).toHaveBeenCalledExactlyOnceWith({ chatId: 'chat-1', accountId: 'work', to: ['buyer@tcs.example'], cc: [], subject: 'TCS quotation follow-up', body: 'Hello, please review our quotation.' });
    expect(api.ask).not.toHaveBeenCalled();
    expect(view.container.textContent).not.toContain('Hello, please review our quotation.');
  });

  it('keeps an in-flight draft running on chat switching without opening its late result over another conversation', async () => {
    let resolveDraft!: (value: InboxAssistantResult<InboxAssistantDraft>) => void;
    api.chat.mockImplementation(async id => ok(chat(id, id === 'chat-1' ? [exchange()] : [])));
    api.draftEmail.mockImplementation(() => new Promise(resolve => { resolveDraft = resolve; }));
    const onOpenDraft = vi.fn();
    const view = await mount({ onOpenDraft });
    fire(button(view, 'Draft email'), 'click');
    fire(view.byLabel('Draft from conversation'), 'submit');
    expect(view.container.textContent).toContain('Preparing draft from conversation');
    const stop = view.byLabel('Stop drafting') as HTMLButtonElement;
    expect(stop).not.toBeNull();
    expect(stop.closest('form')?.contains(view.find('#inbox-assistant-question'))).toBe(true);
    expect(view.byLabel('Stop current work')).toBeNull();
    expect(view.byLabel('Current agent work')?.querySelectorAll('button')).toHaveLength(1);
    fire(view.byLabel('Open conversation: Meeting follow-ups'), 'click');
    await settle();
    expect(api.cancel).not.toHaveBeenCalled();
    await act(async () => resolveDraft(ok({ chatId: 'chat-1', accountId: 'work', to: [], cc: [], subject: 'Old draft', body: 'Old conversation content' })));
    expect(onOpenDraft).not.toHaveBeenCalled();
    expect(view.find('h1')?.textContent).toBe('Meeting follow-ups');
    expect(view.container.textContent).not.toContain('Old conversation content');
  });

  it('disables drafting for empty chats and reports draft failures without opening the composer', async () => {
    const onOpenDraft = vi.fn();
    const empty = await mount({ onOpenDraft });
    expect((button(empty, 'Draft email') as HTMLButtonElement).disabled).toBe(true);
    empty.unmount();
    api.chat.mockImplementation(async id => ok(chat(id, [exchange()])));
    api.draftEmail.mockImplementationOnce(async () => ({ success: false, error: 'Draft provider unavailable.' }));
    const view = await mount({ onOpenDraft });
    fire(button(view, 'Draft email'), 'click');
    fire(view.byLabel('Draft from conversation'), 'submit');
    await settle();
    expect(view.container.textContent).toContain('Draft provider unavailable.');
    expect(onOpenDraft).not.toHaveBeenCalled();
  });

  it('lists named conversations on the left and loads only the active chat', async () => {
    const view = await mount();
    expect(view.byLabel('Assistant chats')?.textContent).toContain('TCS quotations');
    expect(view.byLabel('Assistant chats')?.textContent).toContain('Meeting follow-ups');
    expect(view.byLabel('Open conversation: TCS quotations')?.getAttribute('aria-current')).toBe('page');
    expect(view.find('h1')?.textContent).toBe('TCS quotations');
    expect(api.chats).toHaveBeenCalledOnce();
    expect(api.chat).toHaveBeenCalledExactlyOnceWith('chat-1');
    expect(api.history).not.toHaveBeenCalled();
    expect(view.byLabel('Conversation messages')?.className).toContain('overflow-y-auto');
    expect(view.find('form')?.className).not.toContain('sticky');
  });

  it('creates the first conversation only when no stored chats exist', async () => {
    api.chats.mockImplementation(async () => ok({ chats: [], activeChatId: null }));
    const view = await mount();
    expect(api.createChat).toHaveBeenCalledOnce();
    expect(api.chat).not.toHaveBeenCalled();
    expect(view.byLabel('Open conversation: New conversation')?.getAttribute('aria-current')).toBe('page');
    submit(view, 'Find an invoice.');
    await settle();
    expect(api.ask).toHaveBeenCalledWith({ requestId: expect.any(String), chatId: 'chat-new', question: 'Find an invoice.', accountIds: ['work', 'other'] });
  });

  it('clears the previous chat immediately and ignores stale chat-loading responses', async () => {
    const first = exchange();
    api.chat.mockImplementation(async id => ok(chat(id, id === 'chat-1' ? [first] : [])));
    const view = await mount();
    let resolveSecond!: (value: InboxAssistantResult<InboxAssistantChat>) => void;
    api.chat.mockImplementation(id => id === 'chat-2' ? new Promise(resolve => { resolveSecond = resolve; }) : Promise.resolve(ok(chat(id, [first]))));
    fire(view.byLabel('Open conversation: Meeting follow-ups'), 'click');
    expect(view.container.textContent).not.toContain('You sent a revised quote');
    expect(view.container.textContent).toContain('Loading conversation…');
    fire(view.byLabel('Open conversation: TCS quotations'), 'click');
    await settle();
    const hidden = { ...exchange('hidden-reply'), question: 'Private meeting request', answer: { ...exchange().answer, text: 'Second chat response must stay hidden.' } };
    await act(async () => resolveSecond(ok(chat('chat-2', [hidden]))));
    expect(view.find('h1')?.textContent).toBe('TCS quotations');
    expect(view.container.textContent).toContain('You sent a revised quote');
    expect(view.container.textContent).not.toContain('Second chat response must stay hidden.');
    expect((view.find('textarea') as HTMLTextAreaElement).disabled).toBe(false);
  });

  it('allows choosing another chat while the initial chat is loading without leaving the composer locked', async () => {
    let resolveInitial!: (value: InboxAssistantResult<InboxAssistantChat>) => void;
    api.chat.mockImplementation(id => id === 'chat-1' ? new Promise(resolve => { resolveInitial = resolve; }) : Promise.resolve(ok(chat(id))));
    const view = await mount();
    fire(view.byLabel('Open conversation: Meeting follow-ups'), 'click');
    await settle();
    expect(view.find('h1')?.textContent).toBe('Meeting follow-ups');
    expect((view.find('textarea') as HTMLTextAreaElement).disabled).toBe(false);
    await act(async () => resolveInitial(ok(chat('chat-1', [exchange()]))));
    expect(view.find('h1')?.textContent).toBe('Meeting follow-ups');
    expect(view.container.textContent).not.toContain('You sent a revised quote');
    expect(view.container.textContent).not.toContain('Loading conversations…');
  });

  it('renames a conversation and updates its header and list without fetching other histories', async () => {
    const view = await mount();
    fire(view.byLabel('Rename conversation'), 'click');
    typeInto(view.byLabel('Conversation name'), 'TCS commercial proposal');
    fire(view.byLabel('Conversation name')?.closest('form') ?? null, 'submit');
    await settle();
    expect(api.renameChat).toHaveBeenCalledExactlyOnceWith({ chatId: 'chat-1', title: 'TCS commercial proposal' });
    expect(view.find('h1')?.textContent).toBe('TCS commercial proposal');
    expect(view.byLabel('Open conversation: TCS commercial proposal')).not.toBeNull();
    expect(api.chat).toHaveBeenCalledExactlyOnceWith('chat-1');
  });

  it('restores each chat draft and account scope and keeps follow-up context within its own chat', async () => {
    const first = exchange('tcs-context');
    api.chat.mockImplementation(async id => ok(chat(id, id === 'chat-1' ? [first] : [])));
    const view = await mount();
    fire(button(view, 'All accounts (2)'), 'click');
    toggle(view.all('input[type="checkbox"]')[0]!);
    typeInto(view.find('textarea'), 'What changed in that quotation?');
    fire(view.byLabel('Open conversation: Meeting follow-ups'), 'click');
    await settle();
    expect((view.find('textarea') as HTMLTextAreaElement).value).toBe('');
    expect(view.find('button[aria-controls="assistant-account-picker"]')?.textContent).toContain('All accounts (2)');
    submit(view, 'Find my meeting reply.');
    await settle();
    expect(api.ask).toHaveBeenLastCalledWith({ requestId: expect.any(String), chatId: 'chat-2', question: 'Find my meeting reply.', accountIds: ['work', 'other'] });
    fire(view.byLabel('Open conversation: TCS quotations'), 'click');
    await settle();
    expect((view.find('textarea') as HTMLTextAreaElement).value).toBe('What changed in that quotation?');
    expect(view.find('button[aria-controls="assistant-account-picker"]')?.textContent).toContain('1 of 2 accounts');
    fire(view.find('form'), 'submit');
    await settle();
    expect(api.ask).toHaveBeenLastCalledWith({ requestId: expect.any(String), chatId: 'chat-1', question: 'What changed in that quotation?', accountIds: ['other'], previousExchangeId: 'tcs-context' });
    // Only the selected chat is refreshed on each completion for its persisted run and usage records.
    expect(api.chat.mock.calls.map(([id]) => id)).toEqual(['chat-1', 'chat-2', 'chat-2', 'chat-1', 'chat-1']);
  });

  it('keeps a chat question running on switching and confines its answer and progress to its original conversation', async () => {
    let resolveFirst!: (value: InboxAssistantResult<InboxAssistantExchange>) => void;
    api.ask.mockImplementation(() => new Promise(resolve => { resolveFirst = resolve; }));
    const view = await mount();
    submit(view, 'First chat private question');
    const previousRequestId = api.ask.mock.calls[0]![0].requestId;
    emit(activity(1, 'Reading first chat evidence', { chatId: 'chat-1' }));
    fire(view.byLabel('Open conversation: Meeting follow-ups'), 'click');
    await settle();
    expect(api.cancel).not.toHaveBeenCalled();
    emit(activity(2, 'Late first chat evidence', { chatId: 'chat-1', requestId: previousRequestId }));
    await act(async () => resolveFirst(ok(exchange())));
    expect(view.find('h1')?.textContent).toBe('Meeting follow-ups');
    expect(view.container.textContent).not.toContain('First chat private question');
    expect(view.container.textContent).not.toContain('You sent a revised quote');
    expect(view.container.textContent).not.toContain('Late first chat evidence');
    expect(view.byLabel('View current activity')).toBeNull();
    fire(view.byLabel('Open conversation: TCS quotations'), 'click');
    await settle();
    expect(view.container.textContent).toContain('You sent a revised quote');
  });

  it('shows chat-load failures without retaining another chat answer and supports retry', async () => {
    api.chat.mockImplementation(async id => ok(chat(id, [exchange()])));
    const view = await mount();
    api.chat.mockImplementation(async () => ({ success: false, error: 'Conversation is unavailable.' }));
    fire(view.byLabel('Open conversation: Meeting follow-ups'), 'click');
    await settle();
    expect(view.container.textContent).not.toContain('You sent a revised quote');
    expect(view.find('[role="alert"]')?.textContent).toContain('Conversation is unavailable.');
    api.chat.mockImplementation(async id => ok(chat(id)));
    fire(button(view, 'Try again'), 'click');
    await settle();
    expect(view.find('h1')?.textContent).toBe('Meeting follow-ups');
    expect(view.find('[role="alert"]')).toBeNull();
  });

  it('keeps the provided mail reader inside the Assistant and closes it for activity or chat changes', async () => {
    const onCloseSourcePane = vi.fn();
    api.chat.mockImplementation(async id => ok(chat(id, [exchange()])));
    const view = await mount({ onCloseSourcePane });
    view.rerender(<InboxAssistant sourcePane={<section>Original email reader with Reply and Forward</section>} onCloseSourcePane={onCloseSourcePane} />);
    expect(view.byLabel('Assistant email source')?.textContent).toContain('Original email reader');
    fire(view.byLabel(`View activity for ${exchange().question}`), 'click');
    expect(onCloseSourcePane).toHaveBeenCalledOnce();
    view.rerender(<InboxAssistant onCloseSourcePane={onCloseSourcePane} />);
    expect(view.find('#assistant-activity-panel')).not.toBeNull();
    fire(view.byLabel('Open conversation: Meeting follow-ups'), 'click');
    await settle();
    expect(onCloseSourcePane).toHaveBeenCalledTimes(2);
    expect(view.find('#assistant-activity-panel')).toBeNull();
  });

  it('keeps IME composition and Shift+Enter from submitting the message', async () => {
    const view = await mount();
    typeInto(view.find('textarea'), 'Quotation question');
    fire(view.find('textarea'), 'keydown', { key: 'Enter', isComposing: true });
    fire(view.find('textarea'), 'keydown', { key: 'Enter', shiftKey: true });
    expect(api.ask).not.toHaveBeenCalled();
    fire(view.find('textarea'), 'keydown', { key: 'Enter' });
    await settle();
    expect(api.ask).toHaveBeenCalledOnce();
  });

  it('loads encrypted conversation history and defaults to every account', async () => {
    api.chat.mockImplementation(async id => ok(chat(id, [exchange()])));
    const view = await mount();
    expect(api.accounts).toHaveBeenCalledOnce();
    expect(api.history).not.toHaveBeenCalled();
    expect(api.chat).toHaveBeenCalledExactlyOnceWith('chat-1');
    expect(button(view, 'All accounts (2)')).not.toBeNull();
    expect(view.container.textContent).toContain('You sent a revised quote for INR 2,50,000');
    submit(view, 'What changed from the previous quote?');
    await settle();
    expect(api.ask).toHaveBeenCalledWith({ requestId: expect.any(String), chatId: 'chat-1', question: 'What changed from the previous quote?', accountIds: ['work', 'other'], previousExchangeId: 'exchange-1' });
    expect(localStorage.length).toBe(0);
  });

  it('searches the chosen accounts and renders account-qualified attachment and inline citation links', async () => {
    const onNavigateToSource = vi.fn();
    const view = await mount({ onNavigateToSource });
    fire(button(view, 'All accounts (2)'), 'click');
    toggle(view.all('input[type="checkbox"]')[0]!);
    expect(view.find('button[aria-controls="assistant-account-picker"]')?.textContent).toContain('1 of 2 accounts');
    submit(view);
    await settle();
    expect(api.ask).toHaveBeenCalledWith({ requestId: expect.any(String), chatId: 'chat-1', question: 'What quote did I send to TCS?', accountIds: ['other'] });
    expect(view.container.textContent).toContain('rc@other.example · Sent Items');
    expect(view.byLabel('Open source S1: TCS-quote.xlsx')?.textContent).toContain('2024');
    expect(view.container.textContent).toContain('TCS-quote.xlsx');
    expect(view.container.textContent).toContain('Pricing!B4');
    fire(view.byLabel('Open citation S1'), 'click');
    fire(view.byLabel('Open source S1: TCS-quote.xlsx'), 'click');
    expect(onNavigateToSource.mock.calls).toEqual([[source], [source]]);
  });

  it('keeps answers clean and reveals coverage warnings only in the activity sidebar', async () => {
    const saved = exchange();
    saved.answer.coverage[0] = { ...saved.answer.coverage[0]!, status: 'unavailable', missingBodies: 2, attachmentsSkipped: 1, truncated: true };
    saved.answer.warnings = ['This quote may have later revisions.'];
    api.chat.mockImplementation(async id => ok(chat(id, [saved])));
    const view = await mount();
    expect(view.find('aside')).toBeNull();
    expect(view.byLabel('Search limitations')).toBeNull();
    expect(view.container.textContent).not.toContain('This quote may have later revisions.');
    fire(view.byLabel(`View activity for ${saved.question}`), 'click');
    expect(view.find('aside')?.getAttribute('aria-labelledby')).toBe('assistant-activity-heading');
    expect(view.byLabel('Search limitations')?.textContent).toContain('rc@sarv.com could not be searched.');
    expect(view.byLabel('Search limitations')?.textContent).toContain('2 message bodies were unavailable.');
    expect(view.byLabel('Search limitations')?.textContent).toContain('1 attachments were not read.');
    expect(view.container.textContent).toContain('1 of 2 accounts searched');
    expect(view.container.textContent).toContain('This quote may have later revisions.');
    expect(view.container.textContent).toContain('search limits were reached');
  });

  it('renders mail and model HTML as text and only links valid source citations', async () => {
    const saved = exchange();
    saved.answer.text = '<img src=x onerror=alert(1)> [S1] [S99] <script>sendMail()</script>';
    api.chat.mockImplementation(async id => ok(chat(id, [saved])));
    const view = await mount({ onNavigateToSource: vi.fn() });
    expect(view.find('article img')).toBeNull();
    expect(view.find('script')).toBeNull();
    expect(view.container.textContent).toContain('<script>sendMail()</script>');
    expect(view.byLabel('Open citation S1')).not.toBeNull();
    expect(view.byLabel('Open citation S99')).toBeNull();
  });

  it('shows compact live progress and a right activity inspector with ordered observable work', async () => {
    api.ask.mockImplementation(() => new Promise(() => {}));
    const view = await mount();
    submit(view);
    emit(activity(1, 'Searching sent mail', { accountId: 'work' }));
    emit(activity(2, 'Reading quotation attachment', { stage: 'attachment', accountId: 'other', filename: 'TCS-quote.xlsx', detail: 'Pricing sheet' }));
    expect(view.byLabel('View current activity')?.textContent).toContain('Reading quotation attachment');
    expect(view.find('aside')).toBeNull();
    expect(view.container.textContent).not.toContain('Pricing sheet');
    fire(view.byLabel('View current activity'), 'click');
    expect(view.find('aside')?.className).toContain('fixed');
    expect(view.find('aside')?.className).toContain('right-0');
    expect(view.byLabel('Work timeline')?.querySelectorAll('li')).toHaveLength(2);
    expect(view.find('aside')?.textContent).toContain('Searching sent mail');
    expect(view.find('aside')?.textContent).toContain('Pricing sheet');
    expect(view.find('aside')?.textContent).toContain('rc@other.example');
    expect(document.activeElement).toBe(view.byLabel('Close activity'));
    fire(view.byLabel('Close activity'), 'keydown', { key: 'Escape' });
    expect(view.find('aside')).toBeNull();
    expect(document.activeElement).toBe(view.byLabel('View current activity'));
  });

  it('ignores foreign, duplicate and out-of-order progress events and late events after cancellation', async () => {
    api.ask.mockImplementation(() => new Promise(() => {}));
    const view = await mount();
    submit(view);
    emit(activity(1, 'Search started'));
    emit(activity(4, 'Newest accepted step'));
    emit(activity(2, 'Stale step'));
    emit(activity(4, 'Duplicate step'));
    emit(activity(99, 'Other request data', { requestId: 'foreign-request' }));
    emit(activity(100, 'Other chat data', { chatId: 'chat-2' }));
    fire(view.byLabel('Stop answering'), 'click');
    emit(activity(5, 'Late step after stop'));
    await settle();
    fire(view.byLabel('View stopped activity'), 'click');
    expect(view.byLabel('Work timeline')?.querySelectorAll('li')).toHaveLength(2);
    expect(view.find('aside')?.textContent).toContain('Stopped');
    expect(view.find('aside')?.textContent).toContain('Newest accepted step');
    for (const text of ['Stale step', 'Duplicate step', 'Other request data', 'Other chat data', 'Late step after stop']) expect(view.container.textContent).not.toContain(text);
  });

  it('restores saved activity for historical answers and replaces live progress with the returned timeline', async () => {
    const completed = exchange();
    completed.activities = [activity(1, 'Searched both accounts', { requestId: 'stored-request', status: 'done' }), activity(2, 'Answer ready', { requestId: 'stored-request', stage: 'complete', status: 'done' })];
    api.ask.mockImplementation(async () => ok(completed));
    const view = await mount();
    submit(view);
    await settle();
    fire(view.byLabel(`View activity for ${completed.question}`), 'click');
    expect(view.find('aside')?.textContent).toContain('Completed');
    expect(view.find('aside')?.textContent).toContain('Searched both accounts');
    expect(view.find('aside')?.textContent).toContain('Answer ready');
    view.unmount();
    api.chat.mockImplementation(async id => ok(chat(id, [completed])));
    const restored = await mount();
    expect(restored.find('aside')).toBeNull();
    fire(restored.byLabel(`View activity for ${completed.question}`), 'click');
    expect(restored.find('aside')?.textContent).toContain('Searched both accounts');
  });

  it('retains failed work for inspection and clears the inspector with a new conversation', async () => {
    api.ask.mockImplementation(async () => {
      emit(activity(1, 'Reading message body', { stage: 'body' }));
      return { success: false, error: 'Provider unavailable.' };
    });
    const view = await mount();
    submit(view);
    await settle();
    fire(view.byLabel('View failed activity'), 'click');
    expect(view.find('aside')?.textContent).toContain('Failed');
    expect(view.find('aside')?.textContent).toContain('Reading message body');
    expect(view.find('aside')?.textContent).toContain('Provider unavailable.');
    fire(button(view, 'New conversation'), 'click');
    await settle();
    expect(view.find('aside')).toBeNull();
    expect(view.byLabel('View failed activity')).toBeNull();
    expect(view.find('[role="alert"]')).toBeNull();
  });

  it('bounds the live timeline to the latest 400 activity events', async () => {
    api.ask.mockImplementation(() => new Promise(() => {}));
    const view = await mount();
    submit(view);
    act(() => {
      for (let sequence = 1; sequence <= 405; sequence++) {
        const event = activity(sequence, `Step ${sequence}`);
        for (const listener of activityListeners) listener(event);
      }
    });
    fire(view.byLabel('View current activity'), 'click');
    const steps = view.byLabel('Work timeline')?.querySelectorAll('li');
    expect(steps).toHaveLength(400);
    expect(steps?.[0]?.textContent).toContain('Step 6');
    expect(steps?.[399]?.textContent).toContain('Step 405');
  });

  it('allows cancellation and ignores a late answer after stopping', async () => {
    let resolve!: (value: InboxAssistantResult<InboxAssistantExchange>) => void;
    api.ask.mockImplementation(() => new Promise(done => { resolve = done; }));
    const view = await mount();
    submit(view);
    expect(view.container.textContent).toContain('Preparing email search');
    fire(view.byLabel('Stop answering'), 'click');
    expect(api.cancel).toHaveBeenCalledWith(api.ask.mock.calls[0]?.[0].requestId);
    await act(async () => resolve(ok(exchange())));
    expect(view.container.textContent).not.toContain('You sent a revised quote');
    expect((view.find('textarea') as HTMLTextAreaElement).value).toBe('What quote did I send to TCS?');
  });

  it('creates a new conversation without clearing older chats or reusing their follow-up context', async () => {
    api.chat.mockImplementation(async id => ok(chat(id, [exchange()])));
    const view = await mount();
    fire(button(view, 'New conversation'), 'click');
    await settle();
    expect(api.createChat).toHaveBeenCalledOnce();
    expect(api.clearHistory).not.toHaveBeenCalled();
    expect(view.byLabel('Open conversation: TCS quotations')).not.toBeNull();
    expect(view.container.textContent).not.toContain('You sent a revised quote');
    submit(view, 'Find my latest invoice.');
    await settle();
    expect(api.ask).toHaveBeenCalledWith({ requestId: expect.any(String), chatId: 'chat-new', question: 'Find my latest invoice.', accountIds: ['work', 'other'] });
  });

  it('shows a saved preflight failure once without empty token panels', async () => {
    const message = 'This request needs a supported review scope. No mail was changed.';
    let failed: InboxAssistantExchange | undefined;
    api.chat.mockImplementation(async id => ok(chat(id, failed ? [failed] : [])));
    api.ask.mockImplementationOnce(async request => {
      failed = { ...exchange(), id: 'failed-review', requestId: request.requestId, question: request.question,
        status: 'failed', error: message, answer: { ...exchange().answer, text: message, sources: [] }, usage: undefined };
      return { success: false, error: message };
    });
    const view = await mount();
    submit(view, 'Review my unread emails.'); await settle();
    expect(view.all('[role="alert"]')).toHaveLength(1);
    expect(view.find('[role="alert"]')?.textContent).toContain(message);
    expect(view.byLabel('Answer usage')).toBeNull();
    expect(view.byLabel('Conversation usage')).toBeNull();
    expect(api.changeSet).not.toHaveBeenCalled();
  });

  it('preserves older chats when creating fails and displays ask errors without losing the question', async () => {
    api.chat.mockImplementation(async id => ok(chat(id, [exchange()])));
    api.createChat.mockImplementation(async () => ({ success: false, error: 'Could not save conversation.' }));
    const view = await mount();
    fire(button(view, 'New conversation'), 'click');
    await settle();
    expect(view.find('[role="alert"]')?.textContent).toContain('Could not save conversation.');
    expect(view.byLabel('Open conversation: TCS quotations')).not.toBeNull();
    fire(view.byLabel('Open conversation: TCS quotations'), 'click');
    await settle();
    expect(view.container.textContent).toContain('You sent a revised quote');
    api.ask.mockImplementation(async () => ({ success: false, error: 'Enable AI Assist and select a provider.' }));
    submit(view, 'What is the revision?');
    await settle();
    expect(view.find('[role="alert"]')?.textContent).toContain('Enable AI Assist');
    expect((view.find('textarea') as HTMLTextAreaElement).value).toBe('What is the revision?');
  });

  it('requires an account and never submits an empty question', async () => {
    const view = await mount();
    fire(view.find('form'), 'submit');
    expect(api.ask).not.toHaveBeenCalled();
    fire(button(view, 'All accounts (2)'), 'click');
    for (const checkbox of view.all('input[type="checkbox"]')) toggle(checkbox);
    submit(view);
    expect(api.ask).not.toHaveBeenCalled();
    expect((view.byLabel('Ask Inbox Agent') as HTMLButtonElement).disabled).toBe(true);
    expect(view.container.textContent).toContain('Choose at least one account.');
  });

  it('retries initial failures and shows a helpful state when no accounts exist', async () => {
    api.accounts.mockRejectedValueOnce(new Error('Account registry unavailable.'));
    const view = await mount();
    expect(view.find('[role="alert"]')?.textContent).toContain('Account registry unavailable.');
    api.accounts.mockImplementation(async () => ok([]));
    fire(button(view, 'Try again'), 'click');
    await settle();
    expect(view.container.textContent).toContain('Connect an email account');
    expect((view.find('textarea') as HTMLTextAreaElement).disabled).toBe(true);
  });

  it('leaves an active main-process request running when its renderer unmounts', async () => {
    api.ask.mockImplementation(() => new Promise(() => {}));
    const view = await mount();
    submit(view);
    view.unmount();
    expect(api.cancel).not.toHaveBeenCalled();
    expect(offActivity).toHaveBeenCalledOnce();
  });
});

/** An agent answer with one setting-change card. */
function settingExchange(status: InboxAgentSettingChange['status']): InboxAssistantExchange {
  const now = Date.now();
  return { ...exchange('exchange-setting'), settingChanges: [{
    id: 'setting-1', label: 'R1', kind: 'block_sender', accountId: 'work', accountEmail: 'rc@sarv.com', summary: 'Block news@shop.test',
    details: ['Their new mail goes to Spam.'], createdAt: now, approveBy: now + 60_000, undoBy: status === 'applied' ? now + 60_000 : 0, status,
    existing: { text: 'Also move their emails here to Spam', count: 3, protectedCount: 0, ...(status === 'applied' ? { result: '3 emails changed' } : {}) },
    ...(status === 'applied' ? { existingApplied: true } : {}),
  }] };
}

describe('Inbox Agent setting-change cards', () => {
  // Breaks: a setting card's approval never reaches the host, loses the user's existing-mail choice, or its Undo is not offered.
  it('sends the approval with the existing-mail choice, shows the receipt, and undoes', async () => {
    const onMailChanged = vi.fn();
    api.chat.mockImplementation(async id => ok(chat(id, id === 'chat-1' ? [settingExchange('pending')] : [])));
    api.changeSet.mockImplementation(async () => ok(settingExchange('applied')));
    const view = await mount({ onMailChanged });
    expect(view.container.textContent).toContain('Block news@shop.test');
    const box = view.all('input').find(input => (input as HTMLInputElement).type === 'checkbox') as HTMLInputElement;
    toggle(box);
    fire(button(view, 'Approve'), 'click'); await settle();
    expect(api.changeSet).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ chatId: 'chat-1', exchangeId: 'exchange-setting', changeSetId: 'setting-1', decision: 'approve', includeExisting: true }));
    expect(api.changeSet.mock.calls[0]![0].itemIds).toBeUndefined();
    expect(confirm).not.toHaveBeenCalled();
    expect(onMailChanged).toHaveBeenCalledOnce();
    expect(view.container.textContent).toContain('Saved · 3 emails changed');
    fire(button(view, 'Undo'), 'click'); await settle();
    expect(api.changeSet.mock.calls[1]![0]).toMatchObject({ decision: 'undo' });
    expect(api.changeSet.mock.calls[1]![0].includeExisting).toBeUndefined();
  });

  // Breaks: approving without the tick sends "include existing" anyway.
  it('approves without existing mail unless ticked, and cancels', async () => {
    api.chat.mockImplementation(async id => ok(chat(id, id === 'chat-1' ? [settingExchange('pending')] : [])));
    api.changeSet.mockImplementation(async () => ok(settingExchange('pending')));
    const view = await mount();
    fire(button(view, 'Approve'), 'click'); await settle();
    expect(api.changeSet.mock.calls[0]![0].includeExisting).toBeUndefined();
    fire(button(view, 'Cancel'), 'click'); await settle();
    expect(api.changeSet.mock.calls[1]![0]).toMatchObject({ decision: 'cancel', changeSetId: 'setting-1' });
  });
});

describe('Inbox Agent change-set cards', () => {
  // Breaks: approving a card never reaches the host, or the mail list keeps showing the old state.
  it('sends the approval for the selected rows, shows the receipt and refreshes mail', async () => {
    const onMailChanged = vi.fn();
    api.chat.mockImplementation(async id => ok(chat(id, id === 'chat-1' ? [changeExchange('pending')] : [])));
    const view = await mount({ onMailChanged });
    expect(view.container.textContent).toContain('Waiting for your approval. Nothing has changed yet.');
    fire(button(view, 'Approve'), 'click'); await settle();
    expect(api.changeSet).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ chatId: 'chat-1', exchangeId: 'exchange-change', changeSetId: 'set-1', decision: 'approve', itemIds: ['c1-1'] }));
    expect(confirm).not.toHaveBeenCalled();
    expect(onMailChanged).toHaveBeenCalledOnce();
    expect(view.container.textContent).toContain('Applied · 1 email changed');
    fire(button(view, 'Undo 1 email'), 'click'); await settle();
    expect(api.changeSet.mock.calls[1]![0]).toMatchObject({ decision: 'undo' });
    expect(api.changeSet.mock.calls[1]![0].itemIds).toBeUndefined();
  });

  // Breaks: opening a card's email decides the card, or opens a different message.
  it('opens a card\'s email in the reader without deciding the card', async () => {
    const onMailChanged = vi.fn();
    const onNavigateToSource = vi.fn();
    api.chat.mockImplementation(async id => ok(chat(id, id === 'chat-1' ? [changeExchange('pending')] : [])));
    const view = await mount({ onMailChanged, onNavigateToSource });
    fire(view.byLabel('Open email: Weekend sale (rc@sarv.com)'), 'click');
    expect(onNavigateToSource).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ accountId: 'work', emailId: 'mail-1', threadId: 'thread-1' }));
    expect(api.changeSet).not.toHaveBeenCalled();
    expect(onMailChanged).not.toHaveBeenCalled();
  });

  // Breaks: approving a Trash change skips the confirmation the mail view always asks for.
  it('asks before moving approved emails to Trash, and changes nothing when declined', async () => {
    api.chat.mockImplementation(async id => ok(chat(id, id === 'chat-1' ? [changeExchange('pending', 'trash')] : [])));
    confirm.mockResolvedValueOnce(false);
    const view = await mount();
    fire(button(view, 'Approve'), 'click'); await settle();
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ title: 'Move selected emails to Trash?', destructive: true }));
    expect(api.changeSet).not.toHaveBeenCalled();
  });

  // Breaks: a host refusal (an expired card) disappears silently.
  it('shows the host\'s refusal and leaves mail alone', async () => {
    const onMailChanged = vi.fn();
    api.chat.mockImplementation(async id => ok(chat(id, id === 'chat-1' ? [changeExchange('pending')] : [])));
    api.changeSet.mockResolvedValueOnce({ success: false, error: 'These changes are no longer available. Ask again to prepare them fresh.' });
    const view = await mount({ onMailChanged });
    fire(button(view, 'Cancel'), 'click'); await settle();
    expect(api.changeSet).toHaveBeenCalledWith(expect.objectContaining({ decision: 'cancel' }));
    expect(view.container.textContent).toContain('These changes are no longer available.');
    expect(onMailChanged).not.toHaveBeenCalled();
  });

  // Breaks: mail changed by "Approve for me" during an answer stays stale in the mail list.
  it('refreshes mail after an answer that applied changes, and not after one that only staged them', async () => {
    const onMailChanged = vi.fn();
    const view = await mount({ onMailChanged });
    api.ask.mockImplementationOnce(async request => ok({ ...changeExchange('pending'), chatId: request.chatId }));
    submit(view, 'Mark the sale read'); await settle();
    expect(onMailChanged).not.toHaveBeenCalled();
    api.ask.mockImplementationOnce(async request => ok({ ...changeExchange('applied'), id: 'exchange-applied', chatId: request.chatId }));
    submit(view, 'Mark the sale read'); await settle();
    expect(onMailChanged).toHaveBeenCalledOnce();
  });
});

/** A later answer in which the agent undid, or asked the user to undo, earlier cards. */
function undoExchange(requests: InboxAgentUndoRequest[], id = 'exchange-undo'): InboxAssistantExchange {
  return { ...exchange(id), question: 'Undo that', answer: { ...exchange().answer, text: 'Its Undo is below your answer.', sources: [] }, undoRequests: requests };
}
const undoRequest = (over: Partial<InboxAgentUndoRequest> = {}): InboxAgentUndoRequest => ({
  kind: 'change_set', id: 'set-1', exchangeId: 'exchange-change', label: 'C1', summary: 'Mark 1 email read', outcome: 'waiting', ...over,
});
const buttonIn = (scope: HTMLElement, text: string) => [...scope.querySelectorAll('button')].find(element => element.textContent?.trim() === text) ?? null;

// The agent's undo of an earlier change puts that change's own card under its
// answer, with only its Undo. A regression here is a card that cannot undo,
// an Undo sent for the wrong exchange (and refused), or a stale mail list.
describe('Inbox Agent undo requests', () => {
  // Breaks: the request card cannot undo, or sends the new exchange's id and is refused.
  it('puts an earlier card the agent asked to undo under its answer, and undoes it through the earlier exchange on the user\'s click', async () => {
    const onMailChanged = vi.fn();
    const onNavigateToSource = vi.fn();
    const requests = [undoRequest(), undoRequest({ kind: 'setting', id: 'setting-1', exchangeId: 'exchange-setting', label: 'R1', summary: 'Block news@shop.test' })];
    api.chat.mockImplementation(async id => ok(chat(id, id === 'chat-1' ? [changeExchange('applied'), settingExchange('applied'), undoExchange(requests)] : [])));
    const view = await mount({ onMailChanged, onNavigateToSource });
    const later = () => view.byLabel('Answer to Undo that')!;
    // Its emails still open in the reader, without deciding anything.
    fire(later().querySelector('[aria-label="Open email: Weekend sale (rc@sarv.com)"]') as HTMLElement, 'click');
    expect(onNavigateToSource).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ accountId: 'work', emailId: 'mail-1' }));
    expect(later().textContent).toContain('Mark 1 email read');
    expect(later().textContent).toContain('Block news@shop.test');
    expect(later().textContent!.match(/Inbox Agent asked to undo this\. Nothing changes until you click Undo\./g)).toHaveLength(2);
    expect(later().querySelectorAll('input[type="checkbox"]')).toHaveLength(0);
    expect(buttonIn(later(), 'Approve')).toBeNull();
    fire(buttonIn(later(), 'Undo 1 email'), 'click'); await settle();
    expect(api.changeSet).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ chatId: 'chat-1', exchangeId: 'exchange-change', changeSetId: 'set-1', decision: 'undo' }));
    expect(api.changeSet.mock.calls[0]![0].itemIds).toBeUndefined();
    expect(onMailChanged).toHaveBeenCalledOnce();
    fire(buttonIn(later(), 'Undo'), 'click'); await settle();
    expect(api.changeSet.mock.calls[1]![0]).toMatchObject({ chatId: 'chat-1', exchangeId: 'exchange-setting', changeSetId: 'setting-1', decision: 'undo' });
    expect(api.changeSet.mock.calls[1]![0].includeExisting).toBeUndefined();
  });

  // Breaks: mail the agent put back still shows as archived until a manual refresh.
  it('refreshes the mail list when the agent undid an earlier change for the user', async () => {
    const onMailChanged = vi.fn();
    api.chat.mockImplementation(async id => ok(chat(id, id === 'chat-1' ? [changeExchange('applied')] : [])));
    const view = await mount({ onMailChanged });
    api.ask.mockImplementationOnce(async request => ok({ ...undoExchange([undoRequest()]), chatId: request.chatId }));
    submit(view, 'Undo that'); await settle();
    expect(onMailChanged).not.toHaveBeenCalled();
    api.ask.mockImplementationOnce(async request => ok({ ...undoExchange([undoRequest({ outcome: 'undone' })], 'exchange-undone'), chatId: request.chatId }));
    submit(view, 'Undo that'); await settle();
    expect(onMailChanged).toHaveBeenCalledOnce();
    expect(view.container.textContent).toContain('Undone for you.');
  });

  // Breaks: an undo request for a card that is gone crashes the answer or shows a dead button.
  it('says a change can no longer be undone when its card is gone', async () => {
    const requests = [undoRequest({ exchangeId: 'exchange-gone' }), undoRequest({ kind: 'setting', id: 'setting-9', label: 'R1', summary: 'Block news@shop.test' })];
    api.chat.mockImplementation(async id => ok(chat(id, id === 'chat-1' ? [changeExchange('applied'), undoExchange(requests)] : [])));
    const view = await mount();
    const later = view.byLabel('Answer to Undo that')!;
    expect(later.textContent).toContain('Mark 1 email read: this can no longer be undone from here.');
    expect(later.textContent).toContain('Block news@shop.test: this can no longer be undone from here.');
    expect([...later.querySelectorAll('button')].some(element => /Undo/.test(element.textContent ?? ''))).toBe(false);
  });
});
