// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { InboxAssistant } from '../../../../../src/components/assistant/InboxAssistant';
import type { InboxAssistantActionMode, InboxAssistantChat, InboxAssistantChatSummary, InboxAssistantExchange, InboxAssistantRequest, InboxAssistantResult } from '../../../../../src/types/inbox-assistant';
import { act, cleanup, fire, render, settle, toggle, typeInto } from '../../../../helpers/render';

const ok = <T,>(data: T): InboxAssistantResult<T> => ({ success: true, data });
const accounts = [{ id: 'work', email: 'owner@example.test', name: 'Work' }, { id: 'personal', email: 'personal@example.test', name: 'Personal' }];
function chat(id = 'chat-1'): InboxAssistantChat {
  return { id, title: id === 'chat-1' ? 'Supplier quotations' : 'New conversation', createdAt: 1_720_000_000_000, updatedAt: 1_720_000_000_000, exchangeCount: 0, exchanges: [] };
}
function summary(id = 'chat-1'): InboxAssistantChatSummary {
  const { exchanges: _exchanges, ...result } = chat(id);
  return result;
}
const api = {
  accounts: vi.fn(async () => ok(accounts)),
  chats: vi.fn(async () => ok({ chats: [summary()], activeChatId: 'chat-1' })),
  chat: vi.fn(async (id: string) => ok(chat(id))),
  createChat: vi.fn(async () => ok(chat('chat-new'))),
  updateChat: vi.fn(async ({ chatId, actionMode }: { chatId: string; actionMode?: InboxAssistantActionMode }) => ok({ ...summary(chatId), actionMode })),
  ask: vi.fn(async (request: InboxAssistantRequest): Promise<InboxAssistantResult<InboxAssistantExchange>> => ok({
    id: 'answer-1', chatId: request.chatId, question: request.question, accountIds: request.accountIds, createdAt: Date.now(),
    answer: { text: 'The matching conversation is available.', sources: [], coverage: [], warnings: [] },
  })),
  applyReview: vi.fn(),
  cancel: vi.fn(async (requestId: string) => ok({ requestId, cancelled: true })),
  onActivity: vi.fn(() => () => {}),
};

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  Object.assign(window, { electronAPI: { inboxAssistant: api } });
});
afterEach(cleanup);

async function mount() {
  const view = render(<InboxAssistant compact />);
  await settle();
  return view;
}

describe('compact Inbox Agent controls', () => {
  it('keeps one conversation heading and opens and closes its history drawer', async () => {
    const view = await mount();
    expect(view.all('h1')).toHaveLength(1);
    expect(view.find('h1')?.textContent).toBe('Supplier quotations');
    const history = view.byLabel('Show conversations');
    expect(history?.getAttribute('aria-expanded')).toBe('false');
    fire(history, 'click');
    expect(history?.getAttribute('aria-expanded')).toBe('true');
    fire(view.byLabel('Close conversations'), 'click');
    expect(history?.getAttribute('aria-expanded')).toBe('false');
  });

  it('lets users choose accounts directly and sends only the chosen account scope', async () => {
    const view = await mount();
    const scope = view.byLabel('Accounts to search');
    expect(scope?.closest('nav')).toBeNull();
    expect(view.byLabel('Show conversations')?.getAttribute('aria-expanded')).toBe('false');
    fire(scope, 'click');
    const picker = view.find('fieldset');
    expect(picker?.querySelector('legend')?.textContent).toBe('Accounts to search');
    const checkboxes = [...picker!.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
    expect(checkboxes).toHaveLength(2);
    expect(checkboxes.every(checkbox => checkbox.checked)).toBe(true);
    toggle(checkboxes[0]!);
    fire(checkboxes[1]!, 'keydown', { key: 'Escape' });
    expect(view.find('#assistant-account-picker')).toBeNull();
    expect(scope?.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(scope);
    typeInto(view.find('#inbox-assistant-question'), 'Find the latest supplier quote.');
    fire(view.byLabel('Ask Inbox Agent'), 'click');
    await settle();
    expect(api.ask).toHaveBeenCalledExactlyOnceWith({ requestId: expect.any(String), chatId: 'chat-1', question: 'Find the latest supplier quote.', accountIds: ['personal'] });
    expect(view.byLabel('Show conversations')?.getAttribute('aria-expanded')).toBe('false');
  });

  it('starts a new conversation without opening history', async () => {
    const view = await mount();
    const create = view.byLabel('New conversation');
    expect(create?.closest('nav')).toBeNull();
    fire(create, 'click');
    await settle();
    expect(api.createChat).toHaveBeenCalledOnce();
    expect(view.find('h1')?.textContent).toBe('New conversation');
    expect(view.byLabel('Show conversations')?.getAttribute('aria-expanded')).toBe('false');
  });

  it('retains the two approval modes without applying mail when the mode changes', async () => {
    const view = await mount();
    const mode = view.byLabel('Action mode') as HTMLSelectElement;
    expect(mode.value).toBe('review');
    expect([...mode.options].map(option => option.text)).toEqual(['Ask for approval', 'Approve for me']);
    act(() => { mode.value = 'approve_for_me'; mode.dispatchEvent(new Event('change', { bubbles: true })); });
    await settle();
    expect(api.updateChat).toHaveBeenCalledExactlyOnceWith({ chatId: 'chat-1', actionMode: 'approve_for_me' });
    expect(mode.value).toBe('approve_for_me');
    expect(api.ask).not.toHaveBeenCalled();
    expect(api.applyReview).not.toHaveBeenCalled();
  });

  it('retains the question draft and account selection when moving between compact and full layouts', async () => {
    const view = await mount();
    const input = view.find('#inbox-assistant-question');
    typeInto(input, 'Compare the supplier quotations.');
    fire(view.byLabel('Accounts to search'), 'click');
    toggle(view.find('input[type="checkbox"]'));
    fire(view.byLabel('Close account picker'), 'click');
    view.rerender(<InboxAssistant compact={false} />);
    await settle();
    expect(view.find('#inbox-assistant-question')).toBe(input);
    expect((input as HTMLTextAreaElement).value).toBe('Compare the supplier quotations.');
    view.rerender(<InboxAssistant compact />);
    await settle();
    expect(view.find('#inbox-assistant-question')).toBe(input);
    expect((input as HTMLTextAreaElement).value).toBe('Compare the supplier quotations.');
    expect(view.byLabel('Accounts to search')?.textContent).toContain('personal@example.test');
    expect(api.chat).toHaveBeenCalledExactlyOnceWith('chat-1');
    expect(api.ask).not.toHaveBeenCalled();
    expect(api.cancel).not.toHaveBeenCalled();
  });
});
