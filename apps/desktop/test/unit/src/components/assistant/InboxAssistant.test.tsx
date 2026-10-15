// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { InboxAssistant } from '../../../../../src/components/assistant/InboxAssistant';
import type { InboxAssistantActivity, InboxAssistantChat, InboxAssistantChatList, InboxAssistantChatSummary, InboxAssistantDraft, InboxAssistantDraftRequest, InboxAssistantExchange, InboxAssistantRequest, InboxAssistantResult } from '../../../../../src/types/inbox-assistant';
import { act, cleanup, fire, render, settle, toggle, typeInto } from '../../../../helpers/render';

const ok = <T,>(data: T): InboxAssistantResult<T> => ({ success: true, data });
const confirm = vi.hoisted(() => vi.fn(async () => true));
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
const api = {
  accounts: vi.fn(async () => ok(accounts)),
  history: vi.fn(async (): Promise<InboxAssistantResult<InboxAssistantExchange[]>> => ok([])),
  chats: vi.fn(async (): Promise<InboxAssistantResult<InboxAssistantChatList>> => ok({ chats: [summary(), summary('chat-2')], activeChatId: 'chat-1' })),
  chat: vi.fn(async (id: string): Promise<InboxAssistantResult<InboxAssistantChat>> => ok(chat(id))),
  createChat: vi.fn(async (): Promise<InboxAssistantResult<InboxAssistantChat>> => ok(chat('chat-new'))),
  renameChat: vi.fn(async ({ chatId, title }: { chatId: string; title: string }): Promise<InboxAssistantResult<InboxAssistantChatSummary>> => ok({ ...summary(chatId), title })),
  updateChat: vi.fn(async ({ chatId, pinned }: { chatId: string; pinned: boolean }): Promise<InboxAssistantResult<InboxAssistantChatSummary>> => ok({ ...summary(chatId), pinned })),
  deleteChat: vi.fn(async (chatId: string): Promise<InboxAssistantResult<InboxAssistantChatList>> => { const remaining = [summary(), summary('chat-2')].filter(chat => chat.id !== chatId); return ok({ chats: remaining, activeChatId: remaining[0]?.id ?? null }); }),
  draftEmail: vi.fn(async (request: InboxAssistantDraftRequest): Promise<InboxAssistantResult<InboxAssistantDraft>> => ok({ chatId: request.chatId, accountId: request.accountId, to: ['buyer@tcs.example'], cc: [], subject: 'TCS quotation follow-up', body: 'Hello, please review our quotation.' })),
  ask: vi.fn(async (request: InboxAssistantRequest): Promise<InboxAssistantResult<InboxAssistantExchange>> => ok({ ...exchange(), chatId: request.chatId })),
  cancel: vi.fn(async () => {}),
  clearHistory: vi.fn(async (): Promise<InboxAssistantResult<null>> => ok(null)),
  onActivity: vi.fn((listener: (activity: InboxAssistantActivity) => void) => {
    activityListeners.add(listener);
    return () => { activityListeners.delete(listener); offActivity(); };
  }),
};

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  confirm.mockResolvedValue(true);
  activityListeners.clear();
  api.accounts.mockImplementation(async () => ok(accounts));
  api.history.mockImplementation(async () => ok([]));
  api.chats.mockImplementation(async () => ok({ chats: [summary(), summary('chat-2')], activeChatId: 'chat-1' }));
  api.chat.mockImplementation(async id => ok(chat(id)));
  api.createChat.mockImplementation(async () => ok(chat('chat-new')));
  api.renameChat.mockImplementation(async ({ chatId, title }) => ok({ ...summary(chatId), title }));
  api.updateChat.mockImplementation(async ({ chatId, pinned }) => ok({ ...summary(chatId), pinned }));
  api.deleteChat.mockImplementation(async chatId => { const remaining = [summary(), summary('chat-2')].filter(chat => chat.id !== chatId); return ok({ chats: remaining, activeChatId: remaining[0]?.id ?? null }); });
  api.draftEmail.mockImplementation(async request => ok({ chatId: request.chatId, accountId: request.accountId, to: ['buyer@tcs.example'], cc: [], subject: 'TCS quotation follow-up', body: 'Hello, please review our quotation.' }));
  api.ask.mockImplementation(async request => ok({ ...exchange(), chatId: request.chatId }));
  api.cancel.mockImplementation(async () => {});
  api.clearHistory.mockImplementation(async () => ok(null));
  Object.assign(window, { electronAPI: { inboxAssistant: api } });
});
afterEach(cleanup);

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

  it('cancels an in-flight draft on chat switching and never opens a late draft for another conversation', async () => {
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
    expect(api.cancel).toHaveBeenCalledWith(api.draftEmail.mock.calls[0]![0].requestId);
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
    // A completed answer refreshes summaries, not every conversation's contents.
    expect(api.chat.mock.calls.map(([id]) => id)).toEqual(['chat-1', 'chat-2', 'chat-1']);
  });

  it('cancels a chat question on switching and rejects its late answer and progress events', async () => {
    let resolveFirst!: (value: InboxAssistantResult<InboxAssistantExchange>) => void;
    api.ask.mockImplementation(() => new Promise(resolve => { resolveFirst = resolve; }));
    const view = await mount();
    submit(view, 'First chat private question');
    const previousRequestId = api.ask.mock.calls[0]![0].requestId;
    emit(activity(1, 'Reading first chat evidence', { chatId: 'chat-1' }));
    fire(view.byLabel('Open conversation: Meeting follow-ups'), 'click');
    await settle();
    expect(api.cancel).toHaveBeenCalledWith(previousRequestId);
    emit(activity(2, 'Late first chat evidence', { chatId: 'chat-1', requestId: previousRequestId }));
    await act(async () => resolveFirst(ok(exchange())));
    expect(view.find('h1')?.textContent).toBe('Meeting follow-ups');
    expect(view.container.textContent).not.toContain('First chat private question');
    expect(view.container.textContent).not.toContain('You sent a revised quote');
    expect(view.container.textContent).not.toContain('Late first chat evidence');
    expect(view.byLabel('View current activity')).toBeNull();
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

  it('cancels an active request when leaving the page', async () => {
    api.ask.mockImplementation(() => new Promise(() => {}));
    const view = await mount();
    submit(view);
    view.unmount();
    expect(api.cancel).toHaveBeenCalledWith(api.ask.mock.calls[0]?.[0].requestId);
    expect(offActivity).toHaveBeenCalledOnce();
  });
});
