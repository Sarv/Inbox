// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { InboxAssistant, type InboxAssistantViewState } from '../../../../../src/components/assistant/InboxAssistant';
import type { ConfirmOptions } from '../../../../../src/components/ConfirmDialog';
import type { InboxAssistantChat, InboxAssistantExchange, InboxAssistantRequest, InboxAssistantResult } from '../../../../../src/types/inbox-assistant';
import { act, cleanup, fire, render, settle, toggle, typeInto } from '../../../../helpers/render';

const confirm = vi.hoisted(() => vi.fn<(_options: ConfirmOptions) => Promise<boolean>>());
vi.mock('../../../../../src/store/confirm-service', () => ({ requestConfirm: confirm }));
const ok = <T,>(data: T): InboxAssistantResult<T> => ({ success: true, data });
const accounts = [{ id: 'work', email: 'owner@example.test' }];
const stored = new Map<string, InboxAssistantChat>();
const state = vi.fn<(_state: InboxAssistantViewState) => void>();
const latest = () => state.mock.calls.at(-1)![0];

function chat(id: string, exchanges: InboxAssistantExchange[] = []): InboxAssistantChat {
  return { id, title: id === 'chat-a' ? 'Original conversation' : 'Other conversation', createdAt: 1, updatedAt: 1, exchangeCount: exchanges.length, exchanges };
}
function savedReview(): InboxAssistantExchange {
  return {
    id: 'exchange-a', chatId: 'chat-a', question: 'Review my unread emails', accountIds: ['work'], createdAt: Date.now(), status: 'completed',
    answer: { text: 'Review is ready.', sources: [], coverage: [], warnings: [] },
    review: {
      id: 'review-a', kind: 'unread', createdAt: Date.now(), expiresAt: Date.now() + 60_000, status: 'ready', accounts, coverage: [], truncated: false,
      items: [{ id: 'keep', accountId: 'work', accountEmail: 'owner@example.test', threadId: 'thread-a', emailId: 'email-a', subject: 'Important report',
        from: 'sender@example.test', date: 1_720_000_000, unreadCount: 1, messageCount: 1, unreadEmailIds: ['email-a'], uncategorized: false, categories: [],
        recommendation: 'keep_unread', reason: 'A business report.', confidence: 0.99, protectedReasons: [], bodyUnavailable: false,
        attachmentsUnknown: false, manualSelectionAllowed: true, mailActionsAllowed: true, status: 'pending' }],
    },
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const api = {
  accounts: vi.fn(async () => ok(accounts)),
  chats: vi.fn(async () => ok({ chats: [...stored.values()].map(({ exchanges: _exchanges, ...summary }) => summary), activeChatId: 'chat-a' })),
  chat: vi.fn(async (id: string) => ok(stored.get(id)!)),
  ask: vi.fn<(_request: InboxAssistantRequest) => Promise<InboxAssistantResult<InboxAssistantExchange>>>(),
  applyReview: vi.fn(async () => ok(savedReview())),
  onActivity: vi.fn(() => () => {}),
};
beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  stored.clear();
  stored.set('chat-a', chat('chat-a', [savedReview()]));
  stored.set('chat-b', chat('chat-b'));
  confirm.mockReset();
  api.ask.mockReset();
  api.applyReview.mockReset().mockImplementation(async () => ok(savedReview()));
  Object.assign(window, { electronAPI: { inboxAssistant: api } });
});
afterEach(cleanup);
async function mount() {
  const view = render(<InboxAssistant initialView="conversation" onStateChange={state} />);
  await settle();
  return view;
}
function selectReport(view: ReturnType<typeof render>) {
  toggle(view.byLabel('Select conversation: Important report (owner@example.test)'));
}
function textButton(view: ReturnType<typeof render>, text: string) {
  return view.all('button').find(button => button.textContent?.trim() === text) ?? null;
}

describe('Inbox Agent workspace state', () => {
  it('does not turn saved actionable recommendations or expired history into attention', async () => {
    const view = await mount();
    expect(latest()).toMatchObject({ chatId: 'chat-a', running: false, attentionId: null, status: 'Ready' });
    expect(state.mock.calls.every(([value]) => !value.attentionId)).toBe(true);
    fire(view.byLabel('Open conversation: Other conversation'), 'click'); await settle();
    const expired = savedReview();
    expired.review!.status = 'expired';
    expired.review!.expiresAt = Date.now() - 1;
    stored.set('chat-a', chat('chat-a', [expired]));
    fire(view.byLabel('Open conversation: Original conversation'), 'click'); await settle();
    expect(latest()).toMatchObject({ chatId: 'chat-a', running: false, attentionId: null, status: 'Ready' });
  });

  it('reports only the live Trash confirmation and clears it on cancellation', async () => {
    const first = deferred<boolean>();
    confirm.mockReturnValueOnce(first.promise);
    const view = await mount();
    selectReport(view);
    fire(view.byLabel('Move selected conversations to Trash'), 'click');
    const attention = latest().attentionId;
    expect(attention).toEqual(expect.any(String));
    expect(latest()).toMatchObject({ chatId: 'chat-a', title: 'Original conversation', running: false, requestId: null, status: 'Awaiting your approval' });
    fire(view.byLabel('Move selected conversations to Trash'), 'click');
    expect(confirm).toHaveBeenCalledOnce();
    expect(latest().attentionId).toBe(attention);
    await act(async () => first.resolve(false)); await settle();
    expect(latest()).toMatchObject({ running: false, attentionId: null, status: 'Ready' });
    expect(api.applyReview).not.toHaveBeenCalled();

    const second = deferred<boolean>();
    confirm.mockReturnValueOnce(second.promise);
    fire(view.byLabel('Move selected conversations to Trash'), 'click');
    expect(latest().attentionId).toEqual(expect.any(String));
    expect(latest().attentionId).not.toBe(attention);
    await act(async () => second.resolve(false));
  });

  it('keeps a pending approval attached to its original conversation when another chat opens', async () => {
    const decision = deferred<boolean>();
    confirm.mockReturnValueOnce(decision.promise);
    const view = await mount();
    selectReport(view);
    fire(view.byLabel('Move selected conversations to Trash'), 'click');
    const attention = latest().attentionId;
    fire(view.byLabel('Open conversation: Other conversation'), 'click'); await settle();
    expect(view.find('h1')?.textContent).toBe('Other conversation');
    expect(latest()).toMatchObject({ chatId: 'chat-a', title: 'Original conversation', attentionId: attention, status: 'Awaiting your approval' });
    await act(async () => decision.resolve(true)); await settle();
    expect(latest()).toMatchObject({ chatId: 'chat-b', title: 'Other conversation', running: false, attentionId: null, status: 'Ready' });
    expect(api.applyReview).not.toHaveBeenCalled();
  });

  it('clears approval attention if an unrelated app confirmation replaces its dialog', async () => {
    const service = await vi.importActual<typeof import('../../../../../src/store/confirm-service')>('../../../../../src/store/confirm-service');
    confirm.mockImplementationOnce(service.requestConfirm);
    const view = await mount();
    selectReport(view);
    fire(view.byLabel('Move selected conversations to Trash'), 'click');
    expect(latest()).toMatchObject({ attentionId: expect.any(String), status: 'Awaiting your approval' });
    let unrelated!: Promise<boolean>;
    await act(async () => { unrelated = service.requestConfirm({ title: 'Delete event?', message: 'Unrelated calendar confirmation.' }); });
    await settle();
    expect(service.useConfirmStore.getState().current?.title).toBe('Delete event?');
    expect(latest()).toMatchObject({ running: false, attentionId: null, status: 'Ready' });
    expect(api.applyReview).not.toHaveBeenCalled();
    service.useConfirmStore.getState().resolve(true);
    await expect(unrelated).resolves.toBe(true);
    expect(api.applyReview).not.toHaveBeenCalled();
  });

  it('clears override approval attention before the approved mail action runs', async () => {
    const decision = deferred<boolean>();
    const action = deferred<InboxAssistantResult<InboxAssistantExchange>>();
    confirm.mockReturnValueOnce(decision.promise);
    api.applyReview.mockReturnValueOnce(action.promise);
    const view = await mount();
    selectReport(view);
    fire(textButton(view, 'Mark selected as read'), 'click');
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ title: 'Override agent recommendation?' }));
    expect(latest()).toMatchObject({ running: false, attentionId: expect.any(String), status: 'Awaiting your approval' });
    await act(async () => decision.resolve(true)); await settle();
    expect(api.applyReview).toHaveBeenCalledOnce();
    expect(latest()).toMatchObject({ running: true, attentionId: null, status: 'Marking selected conversations as read' });
    await act(async () => action.resolve(ok(savedReview()))); await settle();
    expect(latest()).toMatchObject({ running: false, attentionId: null, status: 'Ready' });
  });

  it('reports the actual background run identity instead of the selected idle chat', async () => {
    const answer = deferred<InboxAssistantResult<InboxAssistantExchange>>();
    api.ask.mockReturnValueOnce(answer.promise);
    const view = await mount();
    typeInto(view.find('#inbox-assistant-question'), 'Find the current quote');
    fire(view.byLabel('Ask Inbox Agent'), 'click'); await settle();
    const request = api.ask.mock.calls[0]![0];
    fire(view.byLabel('Open conversation: Other conversation'), 'click'); await settle();
    expect(view.find('h1')?.textContent).toBe('Other conversation');
    expect(latest()).toMatchObject({ chatId: 'chat-a', title: 'Original conversation', requestId: request.requestId, running: true, attentionId: null, status: '1 chat working in background' });
    await act(async () => answer.resolve(ok({ ...savedReview(), requestId: request.requestId }))); await settle();
    expect(latest()).toMatchObject({ chatId: 'chat-b', title: 'Other conversation', requestId: null, running: false, attentionId: null, status: 'Ready' });
  });
});
