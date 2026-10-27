// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { InboxAssistant } from '../../../../../src/components/assistant/InboxAssistant';
import type { InboxAssistantChat, InboxAssistantChatSummary, InboxAssistantDashboard, InboxAssistantExchange, InboxAssistantRequest, InboxAssistantResult } from '../../../../../src/types/inbox-assistant';
import { act, cleanup, fire, render, settle, toggle, typeInto } from '../../../../helpers/render';

const ok = <T,>(data: T): InboxAssistantResult<T> => ({ success: true, data });
const accounts = [{ id: 'work', email: 'owner@example.test' }, { id: 'other', email: 'other@example.test' }];
const createdAt = Date.UTC(2026, 9, 24, 9);
const source = { id: 'dashboard-source', kind: 'message' as const, accountId: 'other', accountEmail: accounts[1]!.email,
  emailId: 'same-id-in-both-accounts', threadId: 'customer-thread', subject: 'Customer question', from: 'customer@example.test', to: [accounts[1]!.email],
  date: createdAt / 1000, folder: 'INBOX', sent: false, excerpt: 'Please confirm the delivery date.' };

function exchange(): InboxAssistantExchange {
  return { id: 'answer-1', chatId: 'chat-1', createdAt, question: 'Previous request', accountIds: ['other'],
    answer: { text: 'Previously saved answer.', sources: [], coverage: [], warnings: [] } };
}
function chat(id = 'chat-1'): InboxAssistantChat {
  return { id, title: id === 'chat-1' ? 'Existing delegated conversation' : 'New conversation', actionMode: id === 'chat-1' ? 'approve_for_me' : 'review',
    createdAt, updatedAt: createdAt, exchangeCount: id === 'chat-1' ? 1 : 0, exchanges: id === 'chat-1' ? [exchange()] : [] };
}
function summary(): InboxAssistantChatSummary {
  const { exchanges: _exchanges, ...value } = chat();
  return value;
}
function dashboard(): InboxAssistantDashboard {
  return { generatedAt: createdAt, accounts: accounts.map(account => ({ ...account, status: 'ready' as const })),
    counts: { unreadConversations: 7, uncategorizedUnreadConversations: 2, needsReplyConversations: 1 },
    needsReply: { total: 1, items: [source], truncated: false }, followUps: { total: 0, items: [], truncated: false },
    meetings: { status: 'ready', scope: 'local-only', timeZone: 'UTC', items: [{ eventId: 'meeting-1', occurrenceId: 'meeting-occurrence', startMs: createdAt + 3_600_000,
      endMs: createdAt + 7_200_000, title: 'Customer meeting', calendarName: 'Work calendar', allDay: false }] }, warnings: [] };
}

const api = {
  accounts: vi.fn(async () => ok(accounts)),
  chats: vi.fn(async () => ok({ chats: [summary()], activeChatId: 'chat-1' })),
  chat: vi.fn(async (id: string) => ok(chat(id))),
  createChat: vi.fn(async () => ok(chat('chat-new'))),
  dashboard: vi.fn(async (_request: { accountIds: string[] }) => ok(dashboard())),
  ask: vi.fn(async (_request: InboxAssistantRequest): Promise<InboxAssistantResult<InboxAssistantExchange>> => ok({ ...exchange(), chatId: 'chat-new' })),
  applyReview: vi.fn(),
  updateChat: vi.fn(),
  cancel: vi.fn(async (requestId: string) => ok({ requestId, cancelled: true })),
  onActivity: vi.fn(() => () => {}),
};

function button(view: ReturnType<typeof render>, label: string) {
  return view.all('button').find(element => element.textContent?.trim() === label) ?? null;
}

beforeEach(() => {
  vi.clearAllMocks();
  api.accounts.mockImplementation(async () => ok(accounts));
  api.chats.mockImplementation(async () => ok({ chats: [summary()], activeChatId: 'chat-1' }));
  api.chat.mockImplementation(async id => ok(chat(id)));
  api.createChat.mockImplementation(async () => ok(chat('chat-new')));
  api.dashboard.mockImplementation(async () => ok(dashboard()));
  api.ask.mockImplementation(async request => ok({ ...exchange(), chatId: request.chatId }));
  api.cancel.mockImplementation(async requestId => ok({ requestId, cancelled: true }));
  Object.assign(window, { electronAPI: { inboxAssistant: api } });
});
afterEach(cleanup);

describe('Inbox Agent overview integration', () => {
  it('lands in the full overview with all accounts without sending an AI request or changing mail', async () => {
    const view = render(<InboxAssistant />); await settle();
    expect(view.find('h1')?.textContent).toBe('Inbox overview');
    expect(view.byLabel('Inbox overview')).not.toBeNull();
    expect(api.dashboard).toHaveBeenCalledExactlyOnceWith({ accountIds: ['other', 'work'] });
    expect(api.chat).toHaveBeenCalledExactlyOnceWith('chat-1');
    expect(view.find('#inbox-assistant-question')).toBeNull();
    expect(view.byLabel('Saved needs-reply conversations: 1')).not.toBeNull();
    expect(api.ask).not.toHaveBeenCalled();
    expect(api.applyReview).not.toHaveBeenCalled();
    expect(api.updateChat).not.toHaveBeenCalled();
  });

  it('creates a fresh review-mode conversation with the overview scope and prefills a guided task without sending it', async () => {
    const view = render(<InboxAssistant />); await settle();
    fire(button(view, 'All accounts (2)'), 'click');
    toggle(view.find('#assistant-account-picker input[type="checkbox"]')); await settle();
    expect(api.dashboard).toHaveBeenLastCalledWith({ accountIds: ['other'] });
    fire(button(view, 'Review unread'), 'click'); await settle();
    expect(api.createChat).toHaveBeenCalledOnce();
    const input = view.find('#inbox-assistant-question') as HTMLTextAreaElement;
    expect(input.value).toBe('Review my unread emails and mark low-value conversations as read.');
    expect((view.byLabel('Action mode') as HTMLSelectElement).value).toBe('review');
    expect(api.ask).not.toHaveBeenCalled();
    expect(api.applyReview).not.toHaveBeenCalled();
    expect(api.updateChat).not.toHaveBeenCalled();
    const preparedQuestion = input.value;
    fire(view.byLabel('Ask Inbox Agent'), 'click'); await settle();
    expect(api.ask).toHaveBeenCalledExactlyOnceWith({ requestId: expect.any(String), chatId: 'chat-new', question: preparedQuestion, accountIds: ['other'] });
  });

  it('keeps overview scope separate from an existing conversation draft and restores the original draft without reloading its body', async () => {
    const view = render(<InboxAssistant initialView="conversation" />); await settle();
    const originalQuestion = 'Keep my unsent request.';
    typeInto(view.find('#inbox-assistant-question'), originalQuestion);
    fire(view.byLabel('Open Inbox overview'), 'click'); await settle();
    fire(button(view, 'All accounts (2)'), 'click');
    toggle(view.all('#assistant-account-picker input[type="checkbox"]')[1]!); await settle();
    expect(api.dashboard).toHaveBeenLastCalledWith({ accountIds: ['work'] });
    fire(view.byLabel('Open conversations'), 'click'); await settle();
    expect((view.find('#inbox-assistant-question') as HTMLTextAreaElement).value).toBe(originalQuestion);
    expect((view.byLabel('Action mode') as HTMLSelectElement).value).toBe('approve_for_me');
    fire(view.byLabel('Ask Inbox Agent'), 'click'); await settle();
    expect(api.ask).toHaveBeenCalledWith(expect.objectContaining({ chatId: 'chat-1', accountIds: ['other'], question: originalQuestion }));
    expect(api.chat).toHaveBeenCalledTimes(2); // Initial load and final receipt refresh only.
  });

  it('forwards dashboard source and calendar identities through existing navigation callbacks without mail actions', async () => {
    const onNavigateToSource = vi.fn(); const onOpenCalendarEvent = vi.fn();
    const view = render(<InboxAssistant onNavigateToSource={onNavigateToSource} onOpenCalendarEvent={onOpenCalendarEvent} sourcePane={<div>Existing email reader</div>} />); await settle();
    fire(view.byLabel('Open email: Customer question (other@example.test)'), 'click');
    expect(onNavigateToSource).toHaveBeenCalledExactlyOnceWith(source);
    expect(view.byLabel('Assistant email source')?.textContent).toContain('Existing email reader');
    fire(view.byLabel('Open calendar event: Customer meeting'), 'click');
    expect(onOpenCalendarEvent).toHaveBeenCalledExactlyOnceWith({ eventId: 'meeting-1', startMs: createdAt + 3_600_000, occurrenceId: 'meeting-occurrence' });
    expect(api.ask).not.toHaveBeenCalled(); expect(api.applyReview).not.toHaveBeenCalled();
  });

  it('uses Reply all as the default needs-reply action and keeps Open email separate', async () => {
    const onReplyToSource = vi.fn(); const onNavigateToSource = vi.fn();
    const view = render(<InboxAssistant onReplyToSource={onReplyToSource} onNavigateToSource={onNavigateToSource} />); await settle();
    fire(view.byLabel('Reply all: Customer question (other@example.test)'), 'click');
    expect(onReplyToSource).toHaveBeenCalledExactlyOnceWith(source);
    expect(onNavigateToSource).not.toHaveBeenCalled();
    fire(view.byLabel('Open email: Customer question (other@example.test)'), 'click');
    expect(onNavigateToSource).toHaveBeenCalledExactlyOnceWith(source);
    expect(api.ask).not.toHaveBeenCalled();
    expect(api.applyReview).not.toHaveBeenCalled();
  });

  it('keeps a request running in Overview and offers cancellation through activity when the composer is hidden', async () => {
    let finish!: (value: InboxAssistantResult<InboxAssistantExchange>) => void;
    api.ask.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const view = render(<InboxAssistant initialView="conversation" />); await settle();
    typeInto(view.find('#inbox-assistant-question'), 'Find a quote.');
    fire(view.byLabel('Ask Inbox Agent'), 'click'); await settle();
    const requestId = api.ask.mock.calls[0]![0].requestId;
    fire(view.byLabel('Open Inbox overview'), 'click'); await settle();
    expect(api.cancel).not.toHaveBeenCalled();
    expect(view.byLabel('Inbox overview')).not.toBeNull();
    expect(view.find('#inbox-assistant-question')).toBeNull();
    expect(view.byLabel('Stop answering')).toBeNull();
    expect(view.byLabel('Stop current work')).toBeNull();
    const workBar = view.byLabel('Current agent work')!;
    expect(workBar.querySelectorAll('button')).toHaveLength(1);
    fire(view.byLabel('View current activity'), 'click');
    const activity = view.find('#assistant-activity-panel')!;
    const stop = view.byLabel('Stop work from activity')!;
    expect(activity.contains(stop)).toBe(true);
    fire(stop, 'click'); await settle();
    expect(api.cancel).toHaveBeenCalledExactlyOnceWith(requestId);
    await act(async () => finish(ok(exchange()))); await settle();
    expect(view.find('h1')?.textContent).toBe('Inbox overview');
    expect(api.applyReview).not.toHaveBeenCalled();
  });

  it('defaults compact embeds to the conversation and preserves an explicit initial view', async () => {
    const view = render(<InboxAssistant compact />); await settle();
    expect(view.find('#inbox-assistant-question')).not.toBeNull();
    expect(api.dashboard).not.toHaveBeenCalled();
    view.unmount();
    const overview = render(<InboxAssistant compact initialView="overview" />); await settle();
    expect(overview.byLabel('Inbox overview')).not.toBeNull();
    expect(api.dashboard).toHaveBeenCalledOnce();
  });
});
