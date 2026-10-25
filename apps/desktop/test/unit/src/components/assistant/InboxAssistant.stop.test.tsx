// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { InboxAssistant } from '../../../../../src/components/assistant/InboxAssistant';
import type { InboxAssistantActivity, InboxAssistantCancellation, InboxAssistantChat, InboxAssistantExchange, InboxAssistantRequest, InboxAssistantResult } from '../../../../../src/types/inbox-assistant';
import { act, cleanup, fire, render, settle, typeInto } from '../../../../helpers/render';

const ok = <T,>(data: T): InboxAssistantResult<T> => ({ success: true, data });
const accounts = [{ id: 'work', email: 'owner@example.test', name: 'Work' }];
const listeners = new Set<(activity: InboxAssistantActivity) => void>();
const reviewQuestion = 'Review my unread emails and mark low-value conversations as read.';
const emptyChat: InboxAssistantChat = {
  id: 'review-chat', title: 'Unread review', createdAt: 1_720_000_000_000,
  updatedAt: 1_720_000_000_000, exchangeCount: 0, exchanges: [],
};
const { exchanges: _exchanges, ...summary } = emptyChat;
const api = {
  accounts: vi.fn(async () => ok(accounts)),
  chats: vi.fn(async () => ok({ chats: [summary], activeChatId: emptyChat.id })),
  chat: vi.fn(async () => ok(emptyChat)),
  ask: vi.fn<(_request: InboxAssistantRequest) => Promise<InboxAssistantResult<InboxAssistantExchange>>>(),
  cancel: vi.fn(async (requestId: string): Promise<InboxAssistantResult<InboxAssistantCancellation>> => ok({ requestId, cancelled: true })),
  onActivity: vi.fn((listener: (activity: InboxAssistantActivity) => void) => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }),
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function completedReview(): InboxAssistantExchange {
  return {
    id: 'completed-review', chatId: emptyChat.id, question: reviewQuestion,
    accountIds: ['work'], createdAt: 1_720_000_000_000,
    answer: { text: 'Unread review is ready.', sources: [], coverage: [], warnings: [] },
    review: {
      id: 'unread-snapshot', kind: 'unread', createdAt: Date.now(), expiresAt: Date.now() + 60_000,
      status: 'ready', accounts, items: [], coverage: [], truncated: false,
    },
  };
}

async function mount(compact = false) {
  const view = render(<InboxAssistant initialView="conversation" compact={compact} />);
  await settle();
  return view;
}

async function startReview(view: ReturnType<typeof render>) {
  typeInto(view.find('#inbox-assistant-question'), reviewQuestion);
  fire(view.byLabel('Ask Inbox Agent'), 'click');
  await settle();
  return api.ask.mock.calls[0]![0].requestId;
}

function reportProgress(requestId: string) {
  act(() => listeners.forEach(listener => listener({
    requestId, chatId: emptyChat.id, sequence: 1, at: Date.now(), stage: 'body',
    status: 'running', message: 'Reviewing 8 unread conversations',
  })));
}

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  listeners.clear();
  api.accounts.mockResolvedValue(ok(accounts));
  api.chats.mockResolvedValue(ok({ chats: [summary], activeChatId: emptyChat.id }));
  api.chat.mockResolvedValue(ok(emptyChat));
  api.ask.mockImplementation(() => new Promise(() => {}));
  api.cancel.mockImplementation(async requestId => ok({ requestId, cancelled: true }));
  Object.assign(window, { electronAPI: { inboxAssistant: api } });
});
afterEach(cleanup);

describe('Inbox Agent visible review Stop', () => {
  it.each([false, true])('keeps a labelled Stop outside the scrolling chat until cancellation is acknowledged (compact=%s)', async compact => {
    const cancellation = deferred<InboxAssistantResult<InboxAssistantCancellation>>();
    api.cancel.mockReturnValueOnce(cancellation.promise);
    const view = await mount(compact);
    expect(view.byLabel('Stop current work')).toBeNull();

    const requestId = await startReview(view);
    reportProgress(requestId);
    const messages = view.byLabel('Conversation messages')!;
    const stop = view.byLabel('Stop current work') as HTMLButtonElement;
    expect(stop).not.toBeNull();
    expect(stop.textContent?.trim()).toBe('Stop');
    expect(stop.disabled).toBe(false);
    expect(messages.contains(stop)).toBe(false);
    messages.scrollTop = 0;
    fire(messages, 'scroll');
    expect(view.byLabel('Stop current work')).toBe(stop);

    fire(stop, 'click');
    expect(api.cancel).toHaveBeenCalledExactlyOnceWith(requestId);
    expect(stop.textContent).toContain('Stopping…');
    expect(stop.disabled).toBe(true);
    fire(stop, 'click');
    expect(api.cancel).toHaveBeenCalledOnce();
    expect((view.find('#inbox-assistant-question') as HTMLTextAreaElement).disabled).toBe(true);

    await act(async () => cancellation.resolve(ok({ requestId, cancelled: true })));
    expect(view.byLabel('Stop current work')).toBeNull();
    expect((view.find('#inbox-assistant-question') as HTMLTextAreaElement).disabled).toBe(false);
    expect(view.container.textContent).toContain('Stopped');
  });

  it('removes the running Stop after a completed review while retaining the review', async () => {
    const result = deferred<InboxAssistantResult<InboxAssistantExchange>>();
    api.ask.mockReturnValueOnce(result.promise);
    const view = await mount(true);
    await startReview(view);
    expect(view.byLabel('Stop current work')).not.toBeNull();

    await act(async () => result.resolve(ok(completedReview())));
    await settle();
    expect(view.byLabel('Stop current work')).toBeNull();
    expect(view.container.textContent).toContain('Unread review is ready.');
    expect(api.cancel).not.toHaveBeenCalled();
  });

  it('can stop from the activity overlay without needing to uncover the compact chat', async () => {
    const cancellation = deferred<InboxAssistantResult<InboxAssistantCancellation>>();
    api.cancel.mockReturnValueOnce(cancellation.promise);
    const view = await mount(true);
    const requestId = await startReview(view);
    reportProgress(requestId);
    fire(view.byLabel('View current activity'), 'click');
    const panel = view.find('#assistant-activity-panel')!;
    const stop = view.byLabel('Stop work from activity') as HTMLButtonElement;
    expect(panel.contains(stop)).toBe(true);
    expect(stop.textContent?.trim()).toBe('Stop');
    fire(stop, 'click');
    expect(api.cancel).toHaveBeenCalledExactlyOnceWith(requestId);
    expect(stop.disabled).toBe(true);
    expect((view.byLabel('Stop current work') as HTMLButtonElement).disabled).toBe(true);
    fire(view.byLabel('Stop current work'), 'click');
    expect(api.cancel).toHaveBeenCalledOnce();

    await act(async () => cancellation.resolve(ok({ requestId, cancelled: true })));
    expect(view.byLabel('Stop work from activity')).toBeNull();
    expect(panel.textContent).toContain('Stopped');
  });

  it('can stop while a compact email source covers the chat without closing the email', async () => {
    const view = render(<InboxAssistant initialView="conversation" compact sourcePane={<div>Thread email preview</div>} />);
    await settle();
    const requestId = await startReview(view);
    const preview = view.byLabel('Assistant email source')!;
    const stop = view.byLabel('Stop work from email') as HTMLButtonElement;
    expect(preview.contains(stop)).toBe(true);
    expect(stop.textContent?.trim()).toBe('Stop');
    fire(stop, 'click');
    await settle();
    expect(api.cancel).toHaveBeenCalledExactlyOnceWith(requestId);
    expect(view.byLabel('Stop work from email')).toBeNull();
    expect(view.byLabel('Stop current work')).toBeNull();
    expect(preview.textContent).toContain('Thread email preview');
  });

  it('offers a visible retry after failed cancellation and keeps cancelling the same review', async () => {
    api.cancel.mockResolvedValueOnce({ success: false, error: 'Stop could not be confirmed.' });
    const view = await mount(true);
    const requestId = await startReview(view);
    fire(view.byLabel('Stop current work'), 'click');
    await settle();
    const retry = view.byLabel('Stop current work') as HTMLButtonElement;
    expect(retry.textContent).toContain('Retry stop');
    expect(retry.disabled).toBe(false);
    expect(view.container.textContent).toContain('Stop could not be confirmed.');
    fire(retry, 'click');
    await settle();
    expect(api.cancel).toHaveBeenNthCalledWith(2, requestId);
    expect(view.byLabel('Stop current work')).toBeNull();
    expect(api.ask).toHaveBeenCalledOnce();
  });
});
