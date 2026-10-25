// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { InboxAssistant, type InboxAssistantProps } from '../../../../../src/components/assistant/InboxAssistant';
import type { InboxAssistantActivity, InboxAssistantChat, InboxAssistantDraft, InboxAssistantExchange, InboxAssistantRequest, InboxAssistantResult, InboxAssistantRunRecord, InboxAssistantUsage } from '../../../../../src/types/inbox-assistant';
import { act, cleanup, fire, render, settle, typeInto } from '../../../../helpers/render';

const NOW = Date.UTC(2026, 9, 19, 10);
const accounts = [{ id: 'account-a', email: 'owner@example.test' }];
const listeners = new Set<(activity: InboxAssistantActivity) => void>();
const stored = new Map<string, InboxAssistantChat>();
const ok = <T,>(data: T): InboxAssistantResult<T> => ({ success: true, data });
function chat(id: string): InboxAssistantChat {
  return { id, title: id === 'chat-a' ? 'First conversation' : 'Second conversation', createdAt: NOW, updatedAt: NOW, exchangeCount: 0, exchanges: [] };
}
function answer(request: InboxAssistantRequest, text: string) {
  return { id: `exchange-${request.chatId}`, requestId: request.requestId, chatId: request.chatId, question: request.question,
    accountIds: request.accountIds, status: 'completed' as const, createdAt: NOW,
    answer: { text, sources: [], coverage: [], warnings: [] } };
}
function usage(id: string, inputTokens = 100, outputTokens = 20): InboxAssistantUsage {
  return { calls: [{ id, provider: 'Example provider', model: 'fixture-model', status: 'completed', startedAt: NOW, completedAt: NOW + 100,
    attempts: 1, inputTokens, outputTokens, tokenSource: 'provider', usageComplete: true, costComplete: true, estimatedCostUsd: 0.002 }],
  inputTokens, outputTokens, tokenCountsComplete: true, estimatedCostUsd: 0.002, costComplete: true, currency: 'USD' };
}
function run(over: Partial<InboxAssistantRunRecord> = {}): InboxAssistantRunRecord {
  return { requestId: 'restored-request', chatId: 'chat-a', kind: 'question', question: 'Find the current quotation', accountIds: ['account-a'],
    status: 'running', startedAt: NOW, updatedAt: NOW, activities: [{ requestId: 'restored-request', chatId: 'chat-a', sequence: 1, at: NOW,
      stage: 'body', status: 'running', message: 'Reading the original quotation' }], ...over };
}
function deferred<T>() {
  let resolve!: (result: InboxAssistantResult<T>) => void;
  const promise = new Promise<InboxAssistantResult<T>>(done => { resolve = done; });
  return { promise, resolve };
}
const api = {
  accounts: vi.fn(async () => ok(accounts)),
  chats: vi.fn(async () => ok({ chats: [...stored.values()].map(({ exchanges: _exchanges, runs: _runs, usage: _usage, ...summary }) => summary), activeChatId: 'chat-a' })),
  chat: vi.fn(async (id: string) => ok(stored.get(id)!)),
  createChat: vi.fn(async () => { const value = chat('chat-b'); stored.set(value.id, value); return ok(value); }),
  ask: vi.fn(async (request: InboxAssistantRequest): Promise<InboxAssistantResult<InboxAssistantExchange>> => ok(answer(request, 'Completed answer'))),
  cancel: vi.fn(async (requestId: string) => ok({ requestId, cancelled: true })),
  draftEmail: vi.fn(async (): Promise<InboxAssistantResult<InboxAssistantDraft>> => ok({ chatId: 'chat-a', accountId: 'account-a', to: [], cc: [], subject: 'Saved draft', body: 'Saved draft body' })),
  onActivity: vi.fn((listener: (activity: InboxAssistantActivity) => void) => { listeners.add(listener); return () => listeners.delete(listener); }),
};
beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  listeners.clear();
  stored.clear();
  stored.set('chat-a', chat('chat-a'));
  api.ask.mockReset().mockImplementation(async request => ok(answer(request, 'Completed answer')));
  api.chat.mockReset().mockImplementation(async id => ok(stored.get(id)!));
  api.draftEmail.mockReset().mockImplementation(async () => ok({ chatId: 'chat-a', accountId: 'account-a', to: [], cc: [], subject: 'Saved draft', body: 'Saved draft body' }));
  api.cancel.mockReset().mockImplementation(async requestId => ok({ requestId, cancelled: true }));
  Object.assign(window, { electronAPI: { inboxAssistant: api } });
});
afterEach(() => { cleanup(); vi.useRealTimers(); });
async function mount(props: InboxAssistantProps = {}) { const view = render(<InboxAssistant initialView="conversation" {...props} />); await settle(); return view; }
function button(view: ReturnType<typeof render>, text: string) { return view.all('button').find(value => value.textContent?.trim() === text) ?? null; }
function ask(view: ReturnType<typeof render>, question: string) { typeInto(view.find('#inbox-assistant-question'), question); fire(view.byLabel('Ask Inbox Agent'), 'click'); }
function progress(requestId: string, chatId: string, message: string, sequence = 1) {
  act(() => { for (const listener of listeners) listener({ requestId, chatId, sequence, at: NOW, stage: 'body', status: 'running', message }); });
}

describe('Inbox Agent independent chat runs', () => {
  it.each(['first', 'second'] as const)('starts a new conversation while another works and keeps answers separate when the %s chat finishes first', async finishesFirst => {
    const first = deferred<ReturnType<typeof answer>>();
    const second = deferred<ReturnType<typeof answer>>();
    api.ask.mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise);
    const view = await mount();
    ask(view, 'Find the supplier quote');
    const firstRequest = api.ask.mock.calls[0]![0];
    progress(firstRequest.requestId, 'chat-a', 'Reading the supplier attachment');
    fire(button(view, 'New conversation'), 'click'); await settle();
    expect(view.find('h1')?.textContent).toBe('Second conversation');
    expect((view.find('#inbox-assistant-question') as HTMLTextAreaElement).disabled).toBe(false);
    expect(view.byLabel('Background agent work')?.textContent).toContain('First conversation');
    ask(view, 'Find my next meeting');
    const secondRequest = api.ask.mock.calls[1]![0];
    expect(secondRequest.chatId).toBe('chat-b');
    expect(secondRequest.requestId).not.toBe(firstRequest.requestId);
    if (finishesFirst === 'first') {
      await act(async () => first.resolve(ok(answer(firstRequest, 'The supplier quote is attached.')))); await settle();
      expect(view.byLabel('Stop answering')).not.toBeNull();
      expect((view.find('#inbox-assistant-question') as HTMLTextAreaElement).disabled).toBe(true);
      await act(async () => second.resolve(ok(answer(secondRequest, 'The meeting is on Wednesday.')))); await settle();
      typeInto(view.find('#inbox-assistant-question'), 'Keep this follow-up in the second chat.');
    } else {
      await act(async () => second.resolve(ok(answer(secondRequest, 'The meeting is on Wednesday.')))); await settle();
      typeInto(view.find('#inbox-assistant-question'), 'Keep this follow-up in the second chat.');
      await act(async () => first.resolve(ok(answer(firstRequest, 'The supplier quote is attached.')))); await settle();
    }
    expect(view.container.textContent).toContain('The meeting is on Wednesday.');
    expect(view.container.textContent).not.toContain('The supplier quote is attached.');
    expect((view.find('#inbox-assistant-question') as HTMLTextAreaElement).value).toBe('Keep this follow-up in the second chat.');
    fire(view.byLabel('Open conversation: First conversation'), 'click'); await settle();
    expect(view.container.textContent).toContain('The supplier quote is attached.');
    expect(view.container.textContent).not.toContain('The meeting is on Wednesday.');
    fire(view.byLabel('Open conversation: Second conversation'), 'click'); await settle();
    expect(view.container.textContent).toContain('The meeting is on Wednesday.');
    expect((view.find('#inbox-assistant-question') as HTMLTextAreaElement).value).toBe('Keep this follow-up in the second chat.');
    expect(api.cancel).not.toHaveBeenCalled();
  });

  it('restores background progress and stops only the active chat while another request keeps working', async () => {
    const first = deferred<ReturnType<typeof answer>>();
    const second = deferred<ReturnType<typeof answer>>();
    api.ask.mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise);
    const view = await mount();
    ask(view, 'First question');
    const firstRequest = api.ask.mock.calls[0]![0];
    fire(button(view, 'New conversation'), 'click'); await settle();
    ask(view, 'Second question');
    const secondRequest = api.ask.mock.calls[1]![0];
    progress(firstRequest.requestId, 'chat-a', 'Reading first chat sources');
    progress(secondRequest.requestId, 'chat-b', 'Reading second chat sources');
    fire(view.byLabel('Open conversation: First conversation'), 'click'); await settle();
    expect(view.byLabel('View current activity')?.textContent).toContain('Reading first chat sources');
    fire(view.byLabel('View current activity'), 'click');
    expect(view.byLabel('Work timeline')?.textContent).toContain('Reading first chat sources');
    expect(view.byLabel('Work timeline')?.textContent).not.toContain('Reading second chat sources');
    fire(view.byLabel('Stop answering'), 'click'); await settle();
    expect(api.cancel).toHaveBeenCalledExactlyOnceWith(firstRequest.requestId);
    fire(view.byLabel('Open conversation: Second conversation'), 'click'); await settle();
    expect(view.byLabel('View current activity')?.textContent).toContain('Reading second chat sources');
    expect(view.byLabel('Stop answering')).not.toBeNull();
    await act(async () => second.resolve(ok(answer(secondRequest, 'Second answer completed.')))); await settle();
    await act(async () => first.resolve(ok(answer(firstRequest, 'Stopped answer must stay hidden.')))); await settle();
    expect(view.container.textContent).toContain('Second answer completed.');
    expect(view.container.textContent).not.toContain('Stopped answer must stay hidden.');
    expect(api.cancel).toHaveBeenCalledOnce();
  });

  it('reattaches to a persisted running chat and polls its final result without starting another request', async () => {
    vi.useFakeTimers();
    const restored = run();
    stored.set('chat-a', { ...chat('chat-a'), activeRun: restored, runs: [restored] });
    const view = await mount();
    expect(view.byLabel('View current activity')?.textContent).toContain('Reading the original quotation');
    expect(view.byLabel('Stop answering')).not.toBeNull();
    expect((view.find('#inbox-assistant-question') as HTMLTextAreaElement).disabled).toBe(true);
    const completed = answer({ requestId: restored.requestId, chatId: restored.chatId, question: restored.question, accountIds: restored.accountIds }, 'Recovered final answer.');
    stored.set('chat-a', { ...chat('chat-a'), exchanges: [completed], runs: [{ ...restored, status: 'completed' }], exchangeCount: 1 });
    await act(async () => { await vi.advanceTimersByTimeAsync(1_500); }); await settle();
    expect(api.chat).toHaveBeenCalledTimes(2);
    expect(view.container.textContent).toContain('Recovered final answer.');
    expect(view.byLabel('Stop answering')).toBeNull();
    expect((view.find('#inbox-assistant-question') as HTMLTextAreaElement).disabled).toBe(false);
    expect(api.ask).not.toHaveBeenCalled();
    expect(api.cancel).not.toHaveBeenCalled();
  });

  it('stops a restored main-process run using its original request ID without starting another ask', async () => {
    const restored = run();
    stored.set('chat-a', { ...chat('chat-a'), activeRun: restored, runs: [restored] });
    const view = await mount();
    fire(view.byLabel('Stop answering'), 'click'); await settle();
    expect(api.cancel).toHaveBeenCalledExactlyOnceWith(restored.requestId);
    expect(api.ask).not.toHaveBeenCalled();
    expect((view.find('#inbox-assistant-question') as HTMLTextAreaElement).disabled).toBe(false);
  });

  it('replaces a locally completed answer’s usage with newer canonical accounting from the saved chat', async () => {
    const pendingAnswer = deferred<InboxAssistantExchange>();
    const refreshedChat = deferred<InboxAssistantChat>();
    api.ask.mockImplementationOnce(() => pendingAnswer.promise);
    const view = await mount();
    api.chat.mockImplementationOnce(() => refreshedChat.promise);
    ask(view, 'Check the latest quotation');
    const request = api.ask.mock.calls[0]![0];
    const completed: InboxAssistantExchange = { ...answer(request, 'The quotation is ready.'), updatedAt: NOW + 100, usage: usage('initial-accounting', 100, 20) };
    await act(async () => pendingAnswer.resolve(ok(completed))); await settle();
    let article = view.byLabel('Answer to Check the latest quotation')!;
    expect(article.querySelector('[aria-label="Input tokens: 100"]')).not.toBeNull();
    expect(api.chat).toHaveBeenCalledTimes(2);
    const canonical: InboxAssistantExchange = { ...completed, updatedAt: NOW + 200, usage: usage('canonical-accounting', 300, 90) };
    const savedChat = { ...chat('chat-a'), exchanges: [canonical], exchangeCount: 1, usage: canonical.usage };
    stored.set('chat-a', savedChat);
    await act(async () => refreshedChat.resolve(ok(savedChat))); await settle();
    article = view.byLabel('Answer to Check the latest quotation')!;
    expect(article.querySelector('[aria-label="Input tokens: 300"]')).not.toBeNull();
    expect(article.querySelector('[aria-label="Output tokens: 90"]')).not.toBeNull();
    expect(article.querySelector('[aria-label="Input tokens: 100"]')).toBeNull();
    expect(view.byLabel('Conversation usage')?.querySelector('[aria-label="Input tokens: 300"]')).not.toBeNull();
    fire(button(view, 'New conversation'), 'click'); await settle();
    fire(view.byLabel('Open conversation: First conversation'), 'click'); await settle();
    expect(view.byLabel('Answer to Check the latest quotation')?.querySelector('[aria-label="Input tokens: 300"]')).not.toBeNull();
    expect(api.ask).toHaveBeenCalledOnce();
  });

  it('shows persisted failed and stopped questions with their saved activity and separate answer and conversation usage', async () => {
    const failedRequest = { requestId: 'failed-request', chatId: 'chat-a', question: 'Failed quotation search', accountIds: ['account-a'] };
    const stoppedRequest = { ...failedRequest, requestId: 'stopped-request', question: 'Stopped meeting search' };
    const failedUsage = usage('failed-call', 120, 30);
    failedUsage.calls[0]!.status = 'failed';
    const stoppedUsage = usage('stopped-call', 80, 10);
    stoppedUsage.calls[0]!.status = 'cancelled';
    const failed = { ...answer(failedRequest, ''), status: 'failed' as const, error: 'Provider could not finish.', usage: failedUsage,
      activities: [{ ...run().activities[0]!, requestId: failedRequest.requestId, message: 'Downloaded supplier message' }] };
    const stopped = { ...answer(stoppedRequest, ''), id: 'stopped-exchange', status: 'stopped' as const, usage: stoppedUsage };
    stored.set('chat-a', { ...chat('chat-a'), exchanges: [failed, stopped], exchangeCount: 2,
      usage: { ...usage('total', 200, 40), calls: [...failedUsage.calls, ...stoppedUsage.calls], estimatedCostUsd: 0.004 } });
    const view = await mount();
    const failedArticle = view.byLabel('Answer to Failed quotation search')!;
    const stoppedArticle = view.byLabel('Answer to Stopped meeting search')!;
    expect(failedArticle.textContent).toContain('Provider could not finish.');
    expect(stoppedArticle.textContent).toContain('Stopped. Your question and activity have been saved.');
    expect(failedArticle.querySelector('[aria-label="Input tokens: 120"]')).not.toBeNull();
    expect(stoppedArticle.querySelector('[aria-label="Input tokens: 80"]')).not.toBeNull();
    const totals = view.byLabel('Conversation usage')!;
    expect(totals.querySelector('[aria-label="Input tokens: 200"]')).not.toBeNull();
    expect(totals.querySelector('[aria-label="Output tokens: 40"]')).not.toBeNull();
    expect(totals.textContent).toContain('2 recorded AI calls');
    fire(view.byLabel('View activity for Failed quotation search'), 'click');
    expect(view.byLabel('Work timeline')?.textContent).toContain('Downloaded supplier message');
    expect(view.find('#assistant-activity-panel')?.textContent).toContain('Failed');
    expect(api.ask).not.toHaveBeenCalled();
  });

  it('keeps a completed background draft in its original chat until explicitly opened there', async () => {
    const initial = chat('chat-a');
    const completedQuestion = answer({ requestId: 'earlier-request', chatId: 'chat-a', question: 'Summarize the quotation', accountIds: ['account-a'] }, 'Earlier answer');
    stored.set('chat-a', { ...initial, exchangeCount: 1, exchanges: [completedQuestion] });
    const pending = deferred<InboxAssistantDraft>();
    api.draftEmail.mockImplementationOnce(() => pending.promise);
    const onOpenDraft = vi.fn();
    const view = await mount({ onOpenDraft });
    fire(button(view, 'Draft email'), 'click'); fire(view.byLabel('Draft from conversation'), 'submit');
    fire(button(view, 'New conversation'), 'click'); await settle();
    const draft = { chatId: 'chat-a', accountId: 'account-a', to: ['recipient@example.test'], cc: [], subject: 'Quotation follow-up', body: 'Please review the attached quotation.' };
    stored.set('chat-a', { ...initial, exchangeCount: 1, exchanges: [completedQuestion], runs: [run({ requestId: 'draft-request', kind: 'draft', question: 'Draft email from conversation', status: 'completed', draft, usage: usage('draft-call') })] });
    await act(async () => pending.resolve(ok(draft))); await settle();
    expect(onOpenDraft).not.toHaveBeenCalled();
    expect(view.find('h1')?.textContent).toBe('Second conversation');
    fire(view.byLabel('Open conversation: First conversation'), 'click'); await settle();
    expect(view.byLabel('Drafts and mail actions')?.textContent).toContain('Draft email from conversation');
    fire(button(view, 'Open draft'), 'click');
    expect(onOpenDraft).toHaveBeenCalledExactlyOnceWith(draft);
    expect(api.cancel).not.toHaveBeenCalled();
  });
});
