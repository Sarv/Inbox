// @vitest-environment happy-dom
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AssistantWorkspace } from '../../../../../src/components/assistant/AssistantWorkspace';
import { InboxAssistant } from '../../../../../src/components/assistant/InboxAssistant';
import type { ConfirmOptions } from '../../../../../src/components/ConfirmDialog';
import type { InboxAssistantActionMode, InboxAssistantActivity, InboxAssistantCancellation, InboxAssistantChat, InboxAssistantChatList, InboxAssistantChatSummary, InboxAssistantDraft, InboxAssistantDraftRequest, InboxAssistantExchange, InboxAssistantRequest, InboxAssistantResult, InboxAssistantReviewActionRequest, InboxAssistantRewind } from '../../../../../src/types/inbox-assistant';
import type { InboxAssistantReviewItem } from '../../../../../src/types/inbox-assistant-actions';
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
  applyReview: vi.fn(async (_request: InboxAssistantReviewActionRequest): Promise<InboxAssistantResult<InboxAssistantExchange>> => ok(reviewReceipt(reviewExchange()))),
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
  api.applyReview.mockReset().mockImplementation(async () => ok(reviewReceipt(reviewExchange())));
  api.cancel.mockImplementation(async requestId => ok({ requestId, cancelled: true }));
  api.clearHistory.mockImplementation(async () => ok(null));
  Object.assign(window, { electronAPI: { inboxAssistant: api } });
});
afterEach(cleanup);

function WorkspaceHarness() {
  const [section, setSection] = useState('assistant');
  return <><button onClick={() => setSection('mail')}>Open Inbox test</button><button onClick={() => setSection('settings')}>Open Settings test</button>
    <AssistantWorkspace section={section} onOpenInbox={() => setSection('mail')} onOpenAssistant={() => setSection('assistant')}
      renderAssistant={props => <InboxAssistant {...props} />}><div>Mail and settings workspace</div></AssistantWorkspace></>;
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
    expect(view.byLabel('Show AI chat')).not.toBeNull();
    // Startup and completion both fetch the active chat, including its durable run accounting.
    expect(api.chat.mock.calls.map(([id]) => id)).toEqual(['chat-1', 'chat-1']);
    expect(api.ask).toHaveBeenCalledTimes(1);
    expect(api.cancel).not.toHaveBeenCalled();
    fire(view.byLabel('Show AI chat'), 'click'); await settle();
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
  const view = render(<InboxAssistant {...props} />);
  await settle();
  return view;
}
function button(view: ReturnType<typeof render>, text: string) {
  return view.all('button').find(element => element.textContent?.trim() === text) ?? null;
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
  it('starts automatic review explicitly without forwarding manual selections, shows live progress and stops the exact run', async () => {
    const onMailChanged = vi.fn();
    const reviewed = reviewExchange();
    api.chat.mockImplementation(async id => ok(chat(id, id === 'chat-1' ? [reviewed] : [])));
    let finish!: (value: InboxAssistantResult<InboxAssistantExchange>) => void;
    api.applyReview.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const view = await mount({ onMailChanged });
    expect(api.applyReview).not.toHaveBeenCalled();
    fire(button(view, 'Clear selection'), 'click');
    fire(button(view, 'Mark recommended & continue'), 'click'); await settle();
    const request = api.applyReview.mock.calls[0]![0];
    expect(request).toMatchObject({ chatId: 'chat-1', exchangeId: reviewed.id, reviewId: reviewed.review!.id, itemIds: [], autoContinue: true });
    expect(request.manualSelection).toBeUndefined();
    expect(confirm).not.toHaveBeenCalled();
    const automation = { reviewId: reviewed.review!.id, status: 'running' as const, batchesReviewed: 2,
      reviewedConversations: 400, markedConversations: 32, markedEmails: 35, queuedEmails: 2, maxBatches: 10, maxAICalls: 20 };
    emit({ requestId: request.requestId, chatId: 'chat-1', sequence: 1, at: Date.now(), stage: 'action', status: 'running',
      message: 'Automatic unread review · Batch 2', reviewAutomation: automation }); await settle();
    expect(view.byLabel('Automatic unread review')?.textContent).toContain('400 conversations reviewed');
    expect(view.byLabel('Automatic unread review')?.textContent).toContain('35 emails marked as read');
    expect(view.byLabel('Automatic unread review')?.textContent).toContain('2 emails queued for sync');
    expect(onMailChanged).toHaveBeenCalledOnce();
    emit({ requestId: request.requestId, chatId: 'chat-1', sequence: 2, at: Date.now(), stage: 'action', status: 'running',
      message: 'Preparing another batch', reviewAutomation: automation }); await settle();
    expect(onMailChanged).toHaveBeenCalledOnce();
    emit({ requestId: request.requestId, chatId: 'chat-1', sequence: 3, at: Date.now(), stage: 'action', status: 'running',
      message: 'Another receipt saved', reviewAutomation: { ...automation, markedEmails: 36 } }); await settle();
    expect(onMailChanged).toHaveBeenCalledTimes(2);
    fire(view.byLabel('Stop automatic review'), 'click'); await settle();
    expect(api.cancel).toHaveBeenCalledExactlyOnceWith(request.requestId);
    await act(async () => finish(ok({ ...reviewReceipt(reviewed), updatedAt: Date.now(), review: { ...reviewed.review!, automation: { ...automation, status: 'stopped' } } })));
    await settle();
    expect(api.applyReview).toHaveBeenCalledOnce();
  });

  it('keeps automatic batches in their original chat when a new conversation is opened', async () => {
    const reviewed = reviewExchange();
    api.chat.mockImplementation(async id => ok(chat(id, id === 'chat-1' ? [reviewed] : [])));
    let finish!: (value: InboxAssistantResult<InboxAssistantExchange>) => void;
    api.applyReview.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const view = await mount();
    fire(button(view, 'Mark recommended & continue'), 'click'); await settle();
    const request = api.applyReview.mock.calls[0]![0];
    fire(button(view, 'New conversation'), 'click'); await settle();
    expect(view.container.textContent).not.toContain('Unread mail review');
    expect(api.cancel).not.toHaveBeenCalled();
    const automation = { reviewId: reviewed.review!.id, status: 'completed' as const, batchesReviewed: 3,
      reviewedConversations: 450, markedConversations: 42, markedEmails: 48, queuedEmails: 0, maxBatches: 10, maxAICalls: 20 };
    emit({ requestId: request.requestId, chatId: 'chat-1', sequence: 1, at: Date.now(), stage: 'action', status: 'done',
      message: 'Automatic unread review finished', reviewAutomation: automation });
    await act(async () => finish(ok({ ...reviewReceipt(reviewed), updatedAt: Date.now(), review: { ...reviewed.review!, automation } })));
    await settle();
    expect(view.container.textContent).not.toContain('450 conversations reviewed');
    fire(view.byLabel('Open conversation: TCS quotations'), 'click'); await settle();
    expect(view.byLabel('Automatic unread review')?.textContent).toContain('450 conversations reviewed');
    expect(api.applyReview).toHaveBeenCalledOnce();
    expect(api.cancel).not.toHaveBeenCalled();
  });

  it('restores automatic progress and Stop without submitting another mail action', async () => {
    const reviewed = reviewExchange();
    const automation = { reviewId: reviewed.review!.id, status: 'running' as const, batchesReviewed: 2,
      reviewedConversations: 250, markedConversations: 21, markedEmails: 24, queuedEmails: 1, maxBatches: 10, maxAICalls: 20 };
    const run = { requestId: 'restored-automatic', chatId: 'chat-1', kind: 'action' as const, question: 'Automatic unread review',
      accountIds: ['work', 'other'], exchangeId: reviewed.id, status: 'running' as const, startedAt: Date.now(), updatedAt: Date.now(),
      activities: [{ requestId: 'restored-automatic', chatId: 'chat-1', sequence: 1, at: Date.now(), stage: 'action' as const,
        status: 'running' as const, message: 'Automatic unread review · Batch 2', reviewAutomation: automation }] };
    api.chats.mockResolvedValue(ok({ activeChatId: 'chat-1', chats: [{ ...summary(), activeRun: run }] }));
    api.chat.mockResolvedValue(ok({ ...chat('chat-1', [reviewed]), activeRun: run }));
    const view = await mount();
    expect(view.byLabel('Automatic unread review')?.textContent).toContain('250 conversations reviewed');
    expect(api.applyReview).not.toHaveBeenCalled();
    fire(view.byLabel('Stop automatic review'), 'click'); await settle();
    expect(api.cancel).toHaveBeenCalledExactlyOnceWith('restored-automatic');
  });

  it('loads automatic batch rows only when expanded and refreshes using the original review request', async () => {
    const original = reviewExchange();
    const batch = reviewExchange({ id: 'automatic-batch-two', reviewBatch: { runId: 'automatic-request', number: 2 },
      createdAt: original.createdAt + 1, review: { ...original.review!, id: 'batch-two-review',
        items: Array.from({ length: 200 }, (_, index) => reviewItem(`batch-${index}`)) } });
    api.chat.mockImplementation(async id => ok(chat(id, [original, batch])));
    const view = await mount();
    const receipt = view.byLabel('Automatic review batch 2')!;
    expect(receipt.textContent).toContain('200 conversations reviewed');
    expect(receipt.querySelectorAll('input[type="checkbox"]')).toHaveLength(0);
    fire(receipt.querySelector('button'), 'click'); await settle();
    expect(receipt.querySelectorAll('input[type="checkbox"]')).toHaveLength(200);
    fire([...receipt.querySelectorAll('button')].find(value => value.textContent === 'Refresh review')!, 'click'); await settle();
    expect(api.ask.mock.calls[0]![0]).toMatchObject({ question: original.question, reviewKind: 'unread', reviewOnly: true });
    expect(api.applyReview).not.toHaveBeenCalled();
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
    expect((view.find('#inbox-assistant-question') as HTMLTextAreaElement).disabled).toBe(true);
    fire(view.find('form'), 'submit');
    expect(api.ask).toHaveBeenCalledOnce();
    emit(activity(2, 'Stale quote source', { requestId }));
    await act(async () => resolveCancel(ok({ requestId, cancelled: true })));
    expect(view.byLabel('Stopping request')).toBeNull();
    expect((view.find('#inbox-assistant-question') as HTMLTextAreaElement).disabled).toBe(false);
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
    expect((view.find('#inbox-assistant-question') as HTMLTextAreaElement).disabled).toBe(true);
    fire(view.find('form'), 'submit');
    expect(api.ask).toHaveBeenCalledOnce();
    fire(view.byLabel('Retry stop'), 'click');
    await settle();
    expect(api.cancel).toHaveBeenNthCalledWith(2, requestId);
    expect((view.find('#inbox-assistant-question') as HTMLTextAreaElement).disabled).toBe(false);
  });

  it('retains a stopped automatic-action receipt without losing a newer question or treating the late result as a new answer', async () => {
    let resolveAsk!: (value: InboxAssistantResult<InboxAssistantExchange>) => void;
    api.ask.mockImplementationOnce(() => new Promise(resolve => { resolveAsk = resolve; }));
    const onMailChanged = vi.fn();
    const view = await mount({ onMailChanged });
    const saved = reviewExchange();
    submit(view, saved.question);
    fire(view.byLabel('Stop answering'), 'click');
    await settle();
    typeInto(view.find('#inbox-assistant-question'), 'Keep this next question.');
    await act(async () => resolveAsk(ok(reviewReceipt(saved, 'failed'))));
    expect(view.container.textContent).toContain('One message changed; another could not be marked read.');
    expect(view.byLabel('Undo marked read: Unread item-a (owner@example.test)')).not.toBeNull();
    expect((view.find('#inbox-assistant-question') as HTMLTextAreaElement).value).toBe('Keep this next question.');
    expect(view.byLabel('View stopped activity')).not.toBeNull();
    expect(onMailChanged).toHaveBeenCalledOnce();
    expect(api.applyReview).not.toHaveBeenCalled();
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
    expect(api.applyReview).not.toHaveBeenCalled();
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
    const saved = reviewReceipt(reviewExchange());
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
    expect(view.container.textContent).toContain('Selected conversations were marked read.');
    expect(view.byLabel('Undo marked read: Unread item-a (owner@example.test)')).not.toBeNull();
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
    const saved = reviewReceipt(reviewExchange());
    api.chat.mockImplementation(async id => ok({ ...chat(id), rewindAvailable: true }));
    api.restoreRewindChat.mockResolvedValueOnce(ok({ ...chat('chat-1', [saved]), rewindAvailable: true }));
    const onMailChanged = vi.fn();
    const view = await mount({ onMailChanged });
    fire(button(view, 'Restore previous conversation'), 'click');
    await settle();
    expect(api.restoreRewindChat).toHaveBeenCalledExactlyOnceWith({ chatId: 'chat-1' });
    expect(view.container.textContent).toContain('Selected conversations were marked read.');
    expect(view.byLabel('Undo marked read: Unread item-a (owner@example.test)')).not.toBeNull();
    expect(api.applyReview).not.toHaveBeenCalled();
    expect(onMailChanged).not.toHaveBeenCalled();
    expect(api.ask).not.toHaveBeenCalled();
  });

  it('fills each action starter into the composer without running a search or mail action', async () => {
    const view = await mount();
    const choices = [
      ['Review unread', 'Review my unread emails and mark low-value conversations as read.'],
      ['Check uncategorized', 'Review my uncategorized unread emails.'],
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
    expect(api.applyReview).not.toHaveBeenCalled();
    expect(api.updateChat).not.toHaveBeenCalled();
  });

  it('offers exactly two clearly named modes and defaults to asking for approval', async () => {
    const view = await mount();
    const select = view.byLabel('Action mode') as HTMLSelectElement;
    expect([...select.options].map(option => ({ value: option.value, label: option.text }))).toEqual([
      { value: 'review', label: 'Ask for approval' }, { value: 'approve_for_me', label: 'Approve for me' },
    ]);
    expect(select.value).toBe('review');
    expect(select.title).toContain('before mail changes');
    expect(api.updateChat).not.toHaveBeenCalled();
  });

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
    expect((view.byLabel('Action mode') as HTMLSelectElement).title).toContain('until changed');
    expect((view.find('textarea') as HTMLTextAreaElement).value).toBe('Keep this unread review question.');
    expect(view.find('button[aria-controls="assistant-account-picker"]')?.textContent).toContain('1 of 2 accounts');
    expect(api.chat).toHaveBeenCalledExactlyOnceWith('chat-1');
    expect(api.applyReview).not.toHaveBeenCalled();
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

  it('keeps a late action-mode save error in its original chat after switching', async () => {
    let resolveMode!: (value: InboxAssistantResult<InboxAssistantChatSummary>) => void;
    api.updateChat.mockImplementationOnce(() => new Promise(resolve => { resolveMode = resolve; }));
    const view = await mount();
    const select = view.byLabel('Action mode') as HTMLSelectElement;
    act(() => { select.value = 'approve_for_me'; select.dispatchEvent(new Event('change', { bubbles: true })); });
    fire(view.byLabel('Open conversation: Meeting follow-ups'), 'click');
    await settle();
    await act(async () => resolveMode({ success: false, error: 'Previous chat mode could not be saved.' }));
    expect(view.find('h1')?.textContent).toBe('Meeting follow-ups');
    expect(view.container.textContent).not.toContain('Previous chat mode could not be saved.');
    expect((view.byLabel('Action mode') as HTMLSelectElement).value).toBe('review');
    expect((view.find('textarea') as HTMLTextAreaElement).disabled).toBe(false);
  });

  it('renders an already-applied ask receipt and refreshes mail counts while keeping Approve for me selected', async () => {
    const saved = reviewExchange();
    const mode: InboxAssistantActionMode = 'approve_for_me';
    api.chat.mockImplementation(async id => ok({ ...chat(id), actionMode: mode }));
    api.chats.mockImplementation(async () => ok({ chats: [{ ...summary(), actionMode: mode }, summary('chat-2')], activeChatId: 'chat-1' }));
    api.ask.mockImplementationOnce(async () => ok(reviewReceipt(saved)));
    const onMailChanged = vi.fn();
    const view = await mount({ onMailChanged });
    expect((view.byLabel('Action mode') as HTMLSelectElement).value).toBe('approve_for_me');
    submit(view, saved.question);
    await settle();
    expect(onMailChanged).toHaveBeenCalledOnce();
    expect(view.container.textContent).toContain('Selected conversations were marked read.');
    expect(view.byLabel('Undo marked read: Unread item-a (owner@example.test)')).not.toBeNull();
    expect((view.byLabel('Action mode') as HTMLSelectElement).value).toBe('approve_for_me');
    expect(api.applyReview).not.toHaveBeenCalled();
  });

  it.each(['applied', 'queued', 'failed'] as const)('applies selected review tokens, renders a %s receipt and routes available undo through the original exchange', async status => {
    const saved = reviewExchange();
    api.chat.mockImplementation(async id => ok(chat(id, [saved])));
    api.applyReview.mockImplementationOnce(async () => ok(reviewReceipt(saved, status)));
    api.applyReview.mockImplementationOnce(async () => ok(reviewReceipt(saved, 'undone')));
    const onMailChanged = vi.fn();
    const onNavigateToSource = vi.fn();
    const view = await mount({ onMailChanged, onNavigateToSource });
    fire(view.byLabel('Open conversation: Unread item-a (owner@example.test)'), 'click');
    expect(onNavigateToSource).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: 'item-a', accountId: 'work', emailId: 'mail-item-a', threadId: 'thread-item-a' }));
    expect(api.applyReview).not.toHaveBeenCalled();
    expect(onMailChanged).not.toHaveBeenCalled();
    toggle(view.byLabel('Select conversation: Unread item-b (other@example.test)'));
    expect(view.container.textContent).toContain('1 conversation selected · 2 unread emails');
    fire(button(view, 'Mark selected as read'), 'click');
    await settle();
    expect(api.applyReview).toHaveBeenCalledExactlyOnceWith({ requestId: expect.any(String), chatId: 'chat-1', exchangeId: 'review-exchange', reviewId: 'review-snapshot', itemIds: ['item-a'] });
    expect(view.container.textContent).toContain(status === 'failed' ? 'One message changed; another could not be marked read.' : 'Selected conversations were marked read.');
    expect(onMailChanged).toHaveBeenCalledOnce();
    fire(view.byLabel('Undo marked read: Unread item-a (owner@example.test)'), 'click');
    await settle();
    expect(api.applyReview).toHaveBeenLastCalledWith({ requestId: expect.any(String), chatId: 'chat-1', exchangeId: 'review-exchange', reviewId: 'review-snapshot', itemIds: ['item-a'], undo: true });
    expect(api.applyReview.mock.calls[1]![0].requestId).not.toBe(api.applyReview.mock.calls[0]![0].requestId);
    expect(view.container.textContent).toContain('The changed emails are unread again.');
    expect(view.byLabel('Undo marked read: Unread item-a (owner@example.test)')).toBeNull();
    expect(onMailChanged).toHaveBeenCalledTimes(2);
    expect(api.ask).not.toHaveBeenCalled();
  });

  it('archives an explicitly selected kept-unread conversation using its exact snapshot without applying a read action first', async () => {
    const saved = reviewExchange();
    saved.review!.items = [
      reviewItem('recommended', { mailActionsAllowed: true }),
      reviewItem('keep', { recommendation: 'keep_unread', manualSelectionAllowed: true, mailActionsAllowed: true }),
      reviewItem('unselected', { recommendation: 'keep_unread', manualSelectionAllowed: true, mailActionsAllowed: true }),
    ];
    api.chat.mockImplementation(async id => ok(chat(id, [saved])));
    api.applyReview.mockImplementationOnce(async () => ok(saved));
    const onMailChanged = vi.fn();
    const view = await mount({ onMailChanged });
    fire(button(view, 'Clear selection'), 'click');
    fire(button(view, 'Keep unread 2'), 'click');
    toggle(view.byLabel('Select conversation: Unread keep (owner@example.test)'));
    expect(api.applyReview).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
    fire(view.byLabel('Archive selected conversations'), 'click');
    await settle();
    expect(confirm).not.toHaveBeenCalled();
    expect(api.applyReview).toHaveBeenCalledExactlyOnceWith({ requestId: expect.any(String), chatId: 'chat-1', exchangeId: saved.id,
      reviewId: saved.review!.id, itemIds: ['keep'], manualSelection: true, action: 'archive' });
    expect(api.ask).not.toHaveBeenCalled();
  });

  it.each(['review', 'approve_for_me'] as const)('requires a reversible Trash confirmation for selected conversations in %s mode', async actionMode => {
    const saved = reviewExchange();
    saved.review!.items = [
      reviewItem('keep', { recommendation: 'keep_unread', manualSelectionAllowed: true, mailActionsAllowed: true }),
      reviewItem('unselected', { recommendation: 'keep_unread', manualSelectionAllowed: true, mailActionsAllowed: true }),
    ];
    api.chat.mockImplementation(async id => ok({ ...chat(id, [saved]), actionMode }));
    api.applyReview.mockImplementationOnce(async () => ok(saved));
    let decide!: (value: boolean) => void;
    confirm.mockImplementationOnce(() => new Promise(resolve => { decide = resolve; }));
    const view = await mount();
    fire(button(view, 'Keep unread 2'), 'click');
    toggle(view.byLabel('Select conversation: Unread keep (owner@example.test)'));
    expect(confirm).not.toHaveBeenCalled();
    fire(view.byLabel('Move selected conversations to Trash'), 'click');
    expect(confirm).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ title: 'Move selected conversations to Trash?', confirmLabel: 'Move to Trash', destructive: true,
      message: expect.stringContaining('Trash') }));
    const message = confirm.mock.calls[0]![0].message as string;
    expect(message).toMatch(/1 selected conversation|1 conversation/);
    expect(message).toContain('3 emails');
    expect(message).toContain('1 account');
    expect(message).toMatch(/not permanently|not.*permanent|recover|restore/i);
    expect(api.applyReview).not.toHaveBeenCalled();
    fire(view.byLabel('Move selected conversations to Trash'), 'click');
    expect(confirm).toHaveBeenCalledOnce();
    await act(async () => { decide(true); });
    await settle();
    expect(api.applyReview).toHaveBeenCalledExactlyOnceWith({ requestId: expect.any(String), chatId: 'chat-1', exchangeId: saved.id,
      reviewId: saved.review!.id, itemIds: ['keep'], manualSelection: true, action: 'trash' });
    expect(api.ask).not.toHaveBeenCalled();
    expect(api.updateChat).not.toHaveBeenCalled();
  });

  it('does not move any mail or clear the explicit selection when Trash confirmation is rejected', async () => {
    const saved = reviewExchange();
    saved.review!.items = [reviewItem('keep', { recommendation: 'keep_unread', manualSelectionAllowed: true, mailActionsAllowed: true })];
    api.chat.mockImplementation(async id => ok(chat(id, [saved])));
    confirm.mockResolvedValueOnce(false);
    const onMailChanged = vi.fn();
    const view = await mount({ onMailChanged });
    fire(button(view, 'Keep unread 1'), 'click');
    toggle(view.byLabel('Select conversation: Unread keep (owner@example.test)'));
    fire(view.byLabel('Move selected conversations to Trash'), 'click');
    await settle();
    expect(confirm).toHaveBeenCalledOnce();
    expect(api.applyReview).not.toHaveBeenCalled();
    expect(onMailChanged).not.toHaveBeenCalled();
    expect((view.byLabel('Select conversation: Unread keep (owner@example.test)') as HTMLInputElement).checked).toBe(true);
  });

  it('does not move mail after a review expires while Trash confirmation is open', async () => {
    const saved = reviewExchange();
    saved.review!.items = [reviewItem('keep', { recommendation: 'keep_unread', manualSelectionAllowed: true, mailActionsAllowed: true })];
    api.chat.mockImplementation(async id => ok(chat(id, [saved])));
    let decide!: (value: boolean) => void;
    confirm.mockImplementationOnce(() => new Promise(resolve => { decide = resolve; }));
    const view = await mount();
    fire(button(view, 'Keep unread 1'), 'click');
    toggle(view.byLabel('Select conversation: Unread keep (owner@example.test)'));
    fire(view.byLabel('Move selected conversations to Trash'), 'click');
    const now = vi.spyOn(Date, 'now').mockReturnValue(saved.review!.expiresAt);
    try { await act(async () => { decide(true); }); }
    finally { now.mockRestore(); }
    expect(api.applyReview).not.toHaveBeenCalled();
    expect(view.find('[role="alert"]')?.textContent).toContain('This review has expired. Refresh it');
  });

  it('waits for manual recommendation-override approval and leaves mail untouched when approval is rejected', async () => {
    const saved = reviewExchange();
    saved.review!.items = [reviewItem('protected', { recommendation: 'keep_unread', protectedReasons: ['Marked important by you'], manualSelectionAllowed: true })];
    api.chat.mockImplementation(async id => ok(chat(id, [saved])));
    let decide!: (value: boolean) => void;
    confirm.mockImplementationOnce(() => new Promise(resolve => { decide = resolve; }));
    const onMailChanged = vi.fn();
    const view = await mount({ onMailChanged });
    fire(view.all('button').find(element => element.textContent?.startsWith('Keep unread'))!, 'click');
    toggle(view.byLabel('Select conversation: Unread protected (owner@example.test)'));
    fire(button(view, 'Mark selected as read'), 'click');
    expect(confirm).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ title: 'Override agent recommendation?', confirmLabel: 'Mark selected as read', message: expect.stringContaining('2 unread emails in 1 selected conversation') }));
    expect(api.applyReview).not.toHaveBeenCalled();
    // Repeated clicks while the same approval is pending cannot start another action.
    fire(button(view, 'Mark selected as read'), 'click');
    expect(confirm).toHaveBeenCalledOnce();
    await act(async () => { decide(false); });
    expect(api.applyReview).not.toHaveBeenCalled();
    expect(onMailChanged).not.toHaveBeenCalled();
    expect((view.byLabel('Select conversation: Unread protected (owner@example.test)') as HTMLInputElement).checked).toBe(true);
  });

  it.each(['review', 'approve_for_me'] as const)('requires and honors explicit override approval in %s mode, passing only the manually selected review IDs', async actionMode => {
    const saved = reviewExchange();
    saved.review!.items = [
      reviewItem('protected', { recommendation: 'keep_unread', protectedReasons: ['Marked important by you'], manualSelectionAllowed: true }),
      reviewItem('uncertain', { recommendation: 'needs_review', confidence: 0.4, manualSelectionAllowed: true }),
      reviewItem('not-selected', { recommendation: 'keep_unread', manualSelectionAllowed: true }),
    ];
    api.chat.mockImplementation(async id => ok({ ...chat(id, [saved]), actionMode }));
    api.applyReview.mockImplementationOnce(async () => ok(saved));
    let decide!: (value: boolean) => void;
    confirm.mockImplementationOnce(() => new Promise(resolve => { decide = resolve; }));
    const view = await mount();
    expect((view.byLabel('Action mode') as HTMLSelectElement).value).toBe(actionMode);
    fire(view.all('button').find(element => element.textContent?.startsWith('Keep unread'))!, 'click');
    toggle(view.byLabel('Select conversation: Unread protected (owner@example.test)'));
    fire(view.all('button').find(element => element.textContent?.startsWith('Needs review'))!, 'click');
    toggle(view.byLabel('Select conversation: Unread uncertain (owner@example.test)'));
    fire(button(view, 'Mark selected as read'), 'click');
    expect(confirm).toHaveBeenCalledOnce();
    expect(api.applyReview).not.toHaveBeenCalled();
    await act(async () => { decide(true); });
    await settle();
    expect(api.applyReview).toHaveBeenCalledExactlyOnceWith({ requestId: expect.any(String), chatId: 'chat-1', exchangeId: saved.id, reviewId: saved.review!.id, itemIds: ['protected', 'uncertain'], manualSelection: true });
    expect(api.ask).not.toHaveBeenCalled();
    expect(api.updateChat).not.toHaveBeenCalled();
  });

  it('does not submit an override whose review expires while confirmation is open', async () => {
    const saved = reviewExchange();
    saved.review!.items = [reviewItem('protected', { recommendation: 'keep_unread', manualSelectionAllowed: true })];
    api.chat.mockImplementation(async id => ok(chat(id, [saved])));
    let decide!: (value: boolean) => void;
    confirm.mockImplementationOnce(() => new Promise(resolve => { decide = resolve; }));
    const view = await mount();
    fire(view.all('button').find(element => element.textContent?.startsWith('Keep unread'))!, 'click');
    toggle(view.byLabel('Select conversation: Unread protected (owner@example.test)'));
    fire(button(view, 'Mark selected as read'), 'click');
    const now = vi.spyOn(Date, 'now').mockReturnValue(saved.review!.expiresAt);
    await act(async () => { decide(true); });
    now.mockRestore();
    expect(api.applyReview).not.toHaveBeenCalled();
    expect(view.find('[role="alert"]')?.textContent).toContain('This review has expired. Refresh it');
  });

  it('refreshes an expired review through a fresh scoped question rather than applying stale tokens', async () => {
    const saved = reviewExchange();
    saved.review = { ...saved.review!, accounts: [accounts[0]!], items: saved.review!.items.filter(item => item.accountId === 'work'), status: 'expired', kind: 'uncategorized', expiresAt: Date.now() - 1 };
    api.chat.mockImplementation(async id => ok({ ...chat(id, [saved]), actionMode: 'approve_for_me' }));
    const view = await mount();
    fire(view.find('button[aria-controls="assistant-account-picker"]'), 'click');
    toggle(view.find('#assistant-account-picker input[type="checkbox"]'));
    expect(view.find('button[aria-controls="assistant-account-picker"]')?.textContent).toContain('1 of 2 accounts');
    expect((button(view, 'Mark selected as read') as HTMLButtonElement).disabled).toBe(true);
    fire(button(view, 'Refresh review'), 'click');
    await settle();
    expect(api.ask).toHaveBeenCalledExactlyOnceWith({ requestId: expect.any(String), chatId: 'chat-1', question: saved.question, accountIds: ['work'], previousExchangeId: saved.id, reviewKind: 'uncategorized', reviewOnly: true });
    expect(api.applyReview).not.toHaveBeenCalled();
  });

  it('requests the next review batch using the saved host review instead of applying its selected tokens', async () => {
    const saved = reviewExchange();
    saved.review = { ...saved.review!, accounts: [accounts[0]!], items: saved.review!.items.filter(item => item.accountId === 'work'), kind: 'uncategorized', truncated: true,
      coverage: [{ accountId: 'work', email: accounts[0]!.email, status: 'reviewed', reviewedThreads: 2, scannedThreads: 40, truncated: true, hasMore: true, warnings: [] }] };
    api.chat.mockImplementation(async id => ok({ ...chat(id, [saved]), actionMode: 'approve_for_me' }));
    const onMailChanged = vi.fn();
    const view = await mount({ onMailChanged });
    fire(view.find('button[aria-controls="assistant-account-picker"]'), 'click');
    toggle(view.find('#assistant-account-picker input[type="checkbox"]'));
    expect(view.find('button[aria-controls="assistant-account-picker"]')?.textContent).toContain('1 of 2 accounts');
    fire(button(view, 'Review next batch'), 'click');
    await settle();
    expect(api.ask).toHaveBeenCalledExactlyOnceWith({ requestId: expect.any(String), chatId: 'chat-1', question: saved.question,
      accountIds: ['work'], previousExchangeId: saved.id, reviewKind: 'uncategorized', continueReviewId: 'review-snapshot', reviewOnly: true });
    expect(api.applyReview).not.toHaveBeenCalled();
    expect(onMailChanged).not.toHaveBeenCalled();
  });

  it('keeps rejected action attempts pending, surfaces their error and does not claim mail changed', async () => {
    const saved = reviewExchange();
    api.chat.mockImplementation(async id => ok(chat(id, [saved])));
    api.applyReview.mockImplementationOnce(async () => ({ success: false, error: 'Review snapshot expired. Refresh it first.' }));
    const onMailChanged = vi.fn();
    const view = await mount({ onMailChanged });
    fire(button(view, 'Mark selected as read'), 'click');
    await settle();
    expect(view.find('[role="alert"]')?.textContent).toContain('Review snapshot expired.');
    expect(onMailChanged).not.toHaveBeenCalled();
    expect(view.byLabel('Undo marked read: Unread item-a (owner@example.test)')).toBeNull();
    expect((view.byLabel('Select conversation: Unread item-a (owner@example.test)') as HTMLInputElement).checked).toBe(true);
  });

  it('keeps an action running on chat switching and retains its receipt in the originating chat', async () => {
    const saved = reviewExchange();
    api.chat.mockImplementation(async id => ok(chat(id, id === 'chat-1' ? [saved] : [])));
    let resolveAction!: (value: InboxAssistantResult<InboxAssistantExchange>) => void;
    api.applyReview.mockImplementationOnce(() => new Promise(resolve => { resolveAction = resolve; }));
    const onMailChanged = vi.fn();
    const view = await mount({ onMailChanged });
    fire(button(view, 'Mark selected as read'), 'click');
    const requestId = api.applyReview.mock.calls[0]![0].requestId;
    fire(view.byLabel('Open conversation: Meeting follow-ups'), 'click');
    await settle();
    expect(api.cancel).not.toHaveBeenCalled();
    const receipt = reviewReceipt(saved);
    receipt.answer.text = 'Old review receipt must remain in the original chat.';
    await act(async () => resolveAction(ok(receipt)));
    emit(activity(5, 'Old review action details', { requestId, chatId: 'chat-1', stage: 'action' }));
    expect(onMailChanged).toHaveBeenCalledOnce(); // Acknowledged writes still refresh global mailbox counts.
    expect(view.find('h1')?.textContent).toBe('Meeting follow-ups');
    expect(view.container.textContent).not.toContain('Old review receipt');
    expect(view.container.textContent).not.toContain('Old review action details');
    expect(view.container.textContent).not.toContain('Unread mail review');
    expect((view.find('textarea') as HTMLTextAreaElement).disabled).toBe(false);
    fire(view.byLabel('Open conversation: TCS quotations'), 'click');
    await settle();
    expect(view.container.textContent).toContain('Old review receipt must remain in the original chat.');
  });

  it('retains a confirmed partial receipt after cancelling in the same chat without accepting late activity', async () => {
    const saved = reviewExchange();
    api.chat.mockImplementation(async id => ok(chat(id, [saved])));
    let resolveAction!: (value: InboxAssistantResult<InboxAssistantExchange>) => void;
    api.applyReview.mockImplementationOnce(() => new Promise(resolve => { resolveAction = resolve; }));
    const onMailChanged = vi.fn();
    const view = await mount({ onMailChanged });
    typeInto(view.find('textarea'), 'Keep my next question.');
    fire(button(view, 'Mark selected as read'), 'click');
    const requestId = api.applyReview.mock.calls[0]![0].requestId;
    emit(activity(1, 'First conversation changed', { requestId, chatId: 'chat-1', stage: 'action' }));
    fire(view.byLabel('Stop answering'), 'click');
    expect(api.cancel).toHaveBeenCalledWith(requestId);
    await act(async () => resolveAction(ok(reviewReceipt(saved, 'failed'))));
    emit(activity(2, 'Late action activity', { requestId, chatId: 'chat-1', stage: 'action' }));
    expect(view.container.textContent).toContain('One message changed; another could not be marked read.');
    expect(view.byLabel('Undo marked read: Unread item-a (owner@example.test)')).not.toBeNull();
    expect(onMailChanged).toHaveBeenCalledOnce();
    expect((view.find('textarea') as HTMLTextAreaElement).value).toBe('Keep my next question.');
    fire(view.byLabel('View stopped activity'), 'click');
    expect(view.byLabel('Work timeline')?.textContent).toContain('First conversation changed');
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
    expect(view.byLabel('Stop drafting')).not.toBeNull();
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
    expect(button(view, 'New conversation')?.className).toContain('rounded-full');
    expect(view.byLabel('Conversation messages')?.className).toContain('overflow-y-auto');
    expect(view.find('textarea')?.className).toContain('resize-none');
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
