// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { InboxAssistant, type InboxAssistantViewState } from '../../../../../src/components/assistant/InboxAssistant';
import type { ConfirmOptions } from '../../../../../src/components/ConfirmDialog';
import type { InboxAssistantChat, InboxAssistantExchange, InboxAssistantRequest, InboxAssistantResult } from '../../../../../src/types/inbox-assistant';
import type { InboxAgentChangeSet, InboxAgentChangeSetRequest } from '../../../../../src/types/inbox-assistant-changes';
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
/** A saved answer with one change card: two emails, the second protected (unticked until the user ticks it). */
function savedChange(action: InboxAgentChangeSet['action'] = 'trash', status: InboxAgentChangeSet['status'] = 'pending'): InboxAssistantExchange {
  const now = Date.now();
  const item = { accountId: 'work', accountEmail: 'owner@example.test', from: 'sender@example.test', date: 1_720_000_000, status: 'pending' as const };
  return {
    id: 'exchange-a', chatId: 'chat-a', question: 'Tidy my inbox', accountIds: ['work'], createdAt: now, status: 'completed',
    answer: { text: 'I prepared a change for you to approve.', sources: [], coverage: [], warnings: [] },
    changeSets: [{ id: 'set-a', label: 'C1', action, summary: action === 'trash' ? 'Move 2 emails to Trash' : 'Mark 2 emails read', createdAt: now,
      approveBy: status === 'pending' ? now + 60_000 : now - 1, undoBy: 0, status,
      items: [{ ...item, id: 'routine', emailId: 'email-a', threadId: 'thread-a', subject: 'Weekly digest' },
        { ...item, id: 'report', emailId: 'email-b', threadId: 'thread-b', subject: 'Important report', protectedReason: 'Marked important by you' }] }],
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
  changeSet: vi.fn<(_request: InboxAgentChangeSetRequest) => Promise<InboxAssistantResult<InboxAssistantExchange>>>(),
  onActivity: vi.fn(() => () => {}),
};
beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  stored.clear();
  stored.set('chat-a', chat('chat-a', [savedChange()]));
  stored.set('chat-b', chat('chat-b'));
  confirm.mockReset();
  api.ask.mockReset();
  api.changeSet.mockReset().mockImplementation(async () => ok(savedChange()));
  Object.assign(window, { electronAPI: { inboxAssistant: api } });
});
afterEach(cleanup);
async function mount() {
  const view = render(<InboxAssistant initialView="conversation" onStateChange={state} />);
  await settle();
  return view;
}
function selectReport(view: ReturnType<typeof render>) {
  toggle(view.byLabel('Include: Important report (owner@example.test)'));
}
function textButton(view: ReturnType<typeof render>, text: string) {
  return view.all('button').find(button => button.textContent?.trim() === text) ?? null;
}

describe('Inbox Agent workspace state', () => {
  // Breaks: a saved card waiting for approval, or an expired one, is reported as
  // needing the user's attention although no dialog is open.
  it('does not turn saved actionable recommendations or expired history into attention', async () => {
    const view = await mount();
    expect(latest()).toMatchObject({ chatId: 'chat-a', running: false, attentionId: null, status: 'Ready' });
    expect(state.mock.calls.every(([value]) => !value.attentionId)).toBe(true);
    fire(view.byLabel('Open conversation: Other conversation'), 'click'); await settle();
    stored.set('chat-a', chat('chat-a', [savedChange('trash', 'expired')]));
    fire(view.byLabel('Open conversation: Original conversation'), 'click'); await settle();
    expect(latest()).toMatchObject({ chatId: 'chat-a', running: false, attentionId: null, status: 'Ready' });
  });

  // Breaks: the workspace reports attention for a confirmation that is no longer
  // open, or a repeated click opens a second Trash dialog.
  it('reports only the live Trash confirmation and clears it on cancellation', async () => {
    const first = deferred<boolean>();
    confirm.mockReturnValueOnce(first.promise);
    const view = await mount();
    fire(textButton(view, 'Approve selected'), 'click');
    const attention = latest().attentionId;
    expect(attention).toEqual(expect.any(String));
    expect(latest()).toMatchObject({ chatId: 'chat-a', title: 'Original conversation', running: false, requestId: null, status: 'Awaiting your approval' });
    fire(textButton(view, 'Approve selected'), 'click');
    expect(confirm).toHaveBeenCalledOnce();
    expect(latest().attentionId).toBe(attention);
    await act(async () => first.resolve(false)); await settle();
    expect(latest()).toMatchObject({ running: false, attentionId: null, status: 'Ready' });
    expect(api.changeSet).not.toHaveBeenCalled();

    const second = deferred<boolean>();
    confirm.mockReturnValueOnce(second.promise);
    fire(textButton(view, 'Approve selected'), 'click');
    expect(latest().attentionId).toEqual(expect.any(String));
    expect(latest().attentionId).not.toBe(attention);
    await act(async () => second.resolve(false));
  });

  // Breaks: a confirmation opened in one chat is reported under another, or
  // confirming it after switching chats changes mail from the wrong conversation.
  it('keeps a pending approval attached to its original conversation when another chat opens', async () => {
    const decision = deferred<boolean>();
    confirm.mockReturnValueOnce(decision.promise);
    const view = await mount();
    fire(textButton(view, 'Approve selected'), 'click');
    const attention = latest().attentionId;
    fire(view.byLabel('Open conversation: Other conversation'), 'click'); await settle();
    expect(view.find('h1')?.textContent).toBe('Other conversation');
    expect(latest()).toMatchObject({ chatId: 'chat-a', title: 'Original conversation', attentionId: attention, status: 'Awaiting your approval' });
    await act(async () => decision.resolve(true)); await settle();
    expect(latest()).toMatchObject({ chatId: 'chat-b', title: 'Other conversation', running: false, attentionId: null, status: 'Ready' });
    expect(api.changeSet).not.toHaveBeenCalled();
  });

  // Breaks: an unrelated confirmation that replaced the Trash dialog leaves the
  // agent reporting attention, or approving it moves the agent's mail.
  it('clears approval attention if an unrelated app confirmation replaces its dialog', async () => {
    const service = await vi.importActual<typeof import('../../../../../src/store/confirm-service')>('../../../../../src/store/confirm-service');
    confirm.mockImplementationOnce(service.requestConfirm);
    const view = await mount();
    fire(textButton(view, 'Approve selected'), 'click');
    expect(latest()).toMatchObject({ attentionId: expect.any(String), status: 'Awaiting your approval' });
    let unrelated!: Promise<boolean>;
    await act(async () => { unrelated = service.requestConfirm({ title: 'Delete event?', message: 'Unrelated calendar confirmation.' }); });
    await settle();
    expect(service.useConfirmStore.getState().current?.title).toBe('Delete event?');
    expect(latest()).toMatchObject({ running: false, attentionId: null, status: 'Ready' });
    expect(api.changeSet).not.toHaveBeenCalled();
    service.useConfirmStore.getState().resolve(true);
    await expect(unrelated).resolves.toBe(true);
    expect(api.changeSet).not.toHaveBeenCalled();
  });

  // Breaks: the protected-email confirmation still reports attention while the
  // approved change runs, so the workspace shows both at once.
  it('clears override approval attention before the approved mail action runs', async () => {
    stored.set('chat-a', chat('chat-a', [savedChange('mark_read')]));
    const decision = deferred<boolean>();
    const action = deferred<InboxAssistantResult<InboxAssistantExchange>>();
    confirm.mockReturnValueOnce(decision.promise);
    api.changeSet.mockReturnValueOnce(action.promise);
    const view = await mount();
    selectReport(view);
    fire(textButton(view, 'Approve'), 'click');
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ title: 'Include protected emails?' }));
    expect(latest()).toMatchObject({ running: false, attentionId: expect.any(String), status: 'Awaiting your approval' });
    await act(async () => decision.resolve(true)); await settle();
    expect(api.changeSet).toHaveBeenCalledOnce();
    expect(latest()).toMatchObject({ running: true, attentionId: null, status: 'Mark 2 emails read' });
    await act(async () => action.resolve(ok(savedChange('mark_read', 'applied')))); await settle();
    expect(latest()).toMatchObject({ running: false, attentionId: null, status: 'Ready' });
  });

  // Breaks: the workspace reports the idle chat the user is looking at instead
  // of the chat whose question is still running in the background.
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
    await act(async () => answer.resolve(ok({ ...savedChange(), requestId: request.requestId }))); await settle();
    expect(latest()).toMatchObject({ chatId: 'chat-b', title: 'Other conversation', requestId: null, running: false, attentionId: null, status: 'Ready' });
  });
});
