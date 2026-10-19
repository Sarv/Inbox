import { beforeEach, describe, expect, it, vi } from 'vitest';

type HandlerResult = { success: boolean; data?: unknown; error?: string };
type Handler = (event: unknown, value?: unknown) => Promise<HandlerResult>;

const h = vi.hoisted(() => ({
  handlers: new Map<string, Handler>(),
  frame: {},
  sender: {} as { mainFrame?: object; send: ReturnType<typeof vi.fn>; isDestroyed: ReturnType<typeof vi.fn> },
  windowAvailable: true,
  current: 'active-account',
  registered: [{ id: 'active-account', email: 'rc@sarv.example' }, { id: 'sales-account', email: 'sales@sarv.example' }],
  registryError: false,
  storages: new Map<string, unknown>(),
  activeStorage: { getEmail: vi.fn(), getAttachments: vi.fn(), getFolder: vi.fn() },
  salesStorage: { getEmail: vi.fn(), getAttachments: vi.fn(), getFolder: vi.fn() },
  activeEngine: { bulkMarkAsRead: vi.fn(), bulkMarkAsUnread: vi.fn() },
  salesEngine: { bulkMarkAsRead: vi.fn(), bulkMarkAsUnread: vi.fn() },
  setReadFlag: vi.fn(), logUserAction: vi.fn(),
  requireStorage: vi.fn(),
  ensureRuntime: vi.fn(),
  serviceDeps: undefined as unknown as InboxAssistantServiceDeps,
  service: { accounts: vi.fn(), chats: vi.fn(), chat: vi.fn(), createChat: vi.fn(), renameChat: vi.fn(), updateChat: vi.fn(), deleteChat: vi.fn(), rewindChat: vi.fn(), restoreRewindChat: vi.fn(), draftEmail: vi.fn(), history: vi.fn(), ask: vi.fn(), applyReview: vi.fn(), cancel: vi.fn(), clearHistory: vi.fn() },
}));

vi.mock('electron', () => ({ ipcMain: { handle: (channel: string, handler: Handler) => h.handlers.set(channel, handler) } }));
vi.mock('@sarvinbox/core', async importOriginal => ({ ...await importOriginal<typeof import('@sarvinbox/core')>(), callAIWithRetry: vi.fn(), setEmailReadFlag: h.setReadFlag }));
vi.mock('../../../../electron/ipc/agent-handlers', () => ({ logUserAction: h.logUserAction }));
vi.mock('../../../../electron/shared', () => ({
  getMainWindow: () => h.windowAvailable ? { webContents: h.sender } : null,
  getCurrentAccountId: () => h.current,
  requireStorage: h.requireStorage,
  getStorageFor: (id: string) => h.storages.get(id) ?? null,
  getSyncEngineFor: (id: string) => id === 'sales-account' ? h.salesEngine : h.activeEngine,
  getSyncEngine: () => h.activeEngine,
  getAllAccountRuntimes: () => [],
}));
vi.mock('../../../../electron/services/accounts-runtime', () => ({ ensureAccountRuntime: h.ensureRuntime }));
vi.mock('../../../../electron/services/accounts-registry', () => ({
  readRegistryAccounts: () => { if (h.registryError) throw new Error('Account registry unavailable.'); return h.registered; },
  resolveAccountIdentity: () => ({ aliases: [] }),
}));
vi.mock('../../../../electron/services/assistant-attachment-reader', () => ({ readAssistantAttachment: vi.fn() }));
vi.mock('../../../../electron/services/assistant-mailbox-download', () => ({ fetchAssistantMessageBody: vi.fn() }));
vi.mock('../../../../electron/services/inbox-assistant-history', () => ({ inboxAssistantHistory: { read: vi.fn(), write: vi.fn() } }));
vi.mock('../../../../electron/services/unified-pipeline-service', () => ({ getPipelineAIConfig: vi.fn() }));
vi.mock('../../../../electron/services/inbox-assistant-service', () => ({
  InboxAssistantService: class {
    constructor(deps: InboxAssistantServiceDeps) { h.serviceDeps = deps; }
    accounts() { return h.service.accounts(); }
    chats() { return h.service.chats(); }
    chat(value: unknown) { return h.service.chat(value); }
    createChat() { return h.service.createChat(); }
    renameChat(value: unknown) { return h.service.renameChat(value); }
    updateChat(value: unknown) { return h.service.updateChat(value); }
    deleteChat(value: unknown) { return h.service.deleteChat(value); }
    rewindChat(value: unknown) { return h.service.rewindChat(value); }
    restoreRewindChat(value: unknown) { return h.service.restoreRewindChat(value); }
    draftEmail(value: unknown, progress: (activity: InboxAssistantActivity) => void) { return h.service.draftEmail(value, progress); }
    history() { return h.service.history(); }
    ask(value: unknown, progress: (activity: InboxAssistantActivity) => void) { return h.service.ask(value, progress); }
    applyReview(value: unknown) { return h.service.applyReview(value); }
    cancel(value: string) { return h.service.cancel(value); }
    clearHistory() { return h.service.clearHistory(); }
  },
}));

import { registerInboxAssistantHandlers } from '../../../../electron/ipc/inbox-assistant-handlers';
import { fetchAssistantMessageBody } from '../../../../electron/services/assistant-mailbox-download';
import type { InboxAssistantServiceDeps } from '../../../../electron/services/inbox-assistant-service';
import type { InboxAssistantActivity } from '../../../../src/types/inbox-assistant';

const trusted = () => ({ sender: h.sender, senderFrame: h.frame });
const call = (channel: string, value?: unknown, event: unknown = trusted()) => h.handlers.get(`inboxAssistant:${channel}`)!(event, value);
const ref = { accountId: 'sales-account', emailId: 'shared-email-id', filename: 'TCS-quotation.pdf' };

beforeEach(() => {
  vi.resetAllMocks();
  h.handlers.clear();
  h.sender = { mainFrame: h.frame, send: vi.fn(), isDestroyed: vi.fn(() => false) };
  h.windowAvailable = true;
  h.current = 'active-account';
  h.registered = [{ id: 'active-account', email: 'rc@sarv.example' }, { id: 'sales-account', email: 'sales@sarv.example' }];
  h.registryError = false;
  h.storages = new Map([['active-account', h.activeStorage], ['sales-account', h.salesStorage]]);
  h.requireStorage.mockReturnValue(h.activeStorage);
  h.ensureRuntime.mockResolvedValue(null);
  h.activeStorage.getEmail.mockResolvedValue({ id: ref.emailId, threadId: 'active-inbox-thread', folderId: 'inbox', attachmentNames: '[]' });
  h.salesStorage.getEmail.mockResolvedValue({ id: ref.emailId, threadId: 'sales-sent-thread', folderId: 'sent', tags: '|Sent|', attachmentNames: JSON.stringify([ref.filename]) });
  h.activeStorage.getAttachments.mockResolvedValue([]);
  h.salesStorage.getAttachments.mockResolvedValue([{ id: 'quote-file', filename: ref.filename }]);
  h.activeStorage.getFolder.mockResolvedValue({ path: 'INBOX' });
  h.salesStorage.getFolder.mockResolvedValue({ path: 'Sales/Sent' });
  h.activeEngine.bulkMarkAsRead.mockResolvedValue('success'); h.activeEngine.bulkMarkAsUnread.mockResolvedValue('success');
  h.salesEngine.bulkMarkAsRead.mockResolvedValue('queued'); h.salesEngine.bulkMarkAsUnread.mockResolvedValue('success');
  h.setReadFlag.mockResolvedValue(true);
  h.service.accounts.mockReturnValue(h.registered);
  h.service.history.mockReturnValue([]);
  h.service.ask.mockResolvedValue({ id: 'answer' });
  registerInboxAssistantHandlers();
});

describe('Inbox Agent trusted IPC and source ownership', () => {
  it('downloads the original when research identifies an incomplete nonempty preview', async () => {
    const mailbox = await h.serviceDeps.openMailbox('sales-account');
    const signal = new AbortController().signal;
    const original = { id: ref.emailId, cleanBody: 'preview', rawBody: '<p>Full commercial proposal</p>' };
    vi.mocked(fetchAssistantMessageBody).mockResolvedValue(original as never);
    const preview = { ...original, rawBody: '' };
    expect(await mailbox.fetchBody!(preview as never, {} as never, { signal })).toBe(original);
    expect(fetchAssistantMessageBody).toHaveBeenCalledExactlyOnceWith('sales-account', ref.emailId, signal, { force: true });
  });

  it.each(['accounts', 'chats', 'chat', 'createChat', 'renameChat', 'updateChat', 'deleteChat', 'rewindChat', 'restoreRewindChat', 'draftEmail', 'history', 'ask', 'applyReview', 'cancel', 'clearHistory', 'source'])('accepts %s only from the app main frame', async channel => {
    for (const event of [{ sender: h.sender, senderFrame: {} }, { sender: { mainFrame: h.frame }, senderFrame: h.frame }, {}]) {
      expect(await call(channel, ref, event)).toEqual({ success: false, error: 'Inbox Agent requests must come from the main app window.' });
    }
    h.windowAvailable = false;
    expect(await call(channel, ref)).toMatchObject({ success: false });
    for (const method of Object.values(h.service)) expect(method).not.toHaveBeenCalled();
    expect(h.salesStorage.getEmail).not.toHaveBeenCalled();
    expect(h.requireStorage).not.toHaveBeenCalled();
  });

  it('waits for cancellation acknowledgement and forwards rewind/restore only to the service', async () => {
    let finish!: () => void;
    h.service.cancel.mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve({ requestId: 'stop-1', cancelled: true }); }));
    const stopped = vi.fn();
    const pending = call('cancel', 'stop-1').then(stopped);
    await Promise.resolve();
    expect(stopped).not.toHaveBeenCalled();
    finish(); await pending;
    expect(stopped).toHaveBeenCalledWith({ success: true, data: { requestId: 'stop-1', cancelled: true } });
    const request = { chatId: 'chat-1', exchangeId: 'turn-1' };
    h.service.rewindChat.mockResolvedValue({ chat: { id: 'chat-1', exchanges: [] }, question: 'Original question', accountIds: ['sales-account'] });
    expect(await call('rewindChat', request)).toMatchObject({ success: true, data: { question: 'Original question' } });
    expect(h.service.rewindChat).toHaveBeenCalledExactlyOnceWith(request);
    h.service.restoreRewindChat.mockResolvedValue({ id: 'chat-1', exchanges: [{ id: 'turn-1' }] });
    expect(await call('restoreRewindChat', { chatId: 'chat-1' })).toMatchObject({ success: true, data: { exchanges: [{ id: 'turn-1' }] } });
  });

  it('forwards reviewed actions only through the validated service method', async () => {
    const request = { requestId: 'apply-1', chatId: 'chat-1', exchangeId: 'exchange-1', reviewId: 'review-1', itemIds: ['item-1'] };
    h.service.applyReview.mockResolvedValue({ id: 'exchange-1', reviewResult: { appliedCount: 1 } });
    expect(await call('applyReview', request)).toMatchObject({ success: true, data: { reviewResult: { appliedCount: 1 } } });
    expect(h.service.applyReview).toHaveBeenCalledExactlyOnceWith(request);
    h.service.applyReview.mockRejectedValueOnce(new Error('This review has expired.'));
    expect(await call('applyReview', request)).toEqual({ success: false, error: 'This review has expired.' });
  });

  it('saves a reviewed read flag through the owning account queue and logs only the matching storage', async () => {
    h.salesStorage.getEmail.mockResolvedValue({ id: ref.emailId, threadId: 'sales-thread', fromAddress: 'news@offers.example', folderId: 'sent', uid: 42, tags: '|Sent|' });
    expect(await h.serviceDeps.setRead!('sales-account', [ref.emailId], true)).toEqual({ appliedIds: [], queuedIds: [ref.emailId], failedIds: [] });
    expect(h.salesEngine.bulkMarkAsRead).toHaveBeenCalledExactlyOnceWith('Sales/Sent', [42]);
    expect(h.setReadFlag).toHaveBeenCalledExactlyOnceWith(h.salesStorage, ref.emailId, true, 'Inbox Agent read action');
    expect(h.logUserAction).toHaveBeenCalledExactlyOnceWith(ref.emailId, 'read', expect.objectContaining({ source: 'agent_approved', threadId: 'sales-thread' }), h.salesStorage);
    expect(h.activeEngine.bulkMarkAsRead).not.toHaveBeenCalled();
    expect(h.activeStorage.getEmail).not.toHaveBeenCalled();
    expect(h.requireStorage).not.toHaveBeenCalled();
  });

  it('does not change local flags or log success when the owner queue fails', async () => {
    h.salesStorage.getEmail.mockResolvedValue({ id: ref.emailId, folderId: 'sent', uid: 42, tags: '|Sent|' });
    h.salesEngine.bulkMarkAsRead.mockResolvedValueOnce('failed');
    expect(await h.serviceDeps.setRead!('sales-account', [ref.emailId], true)).toEqual({ appliedIds: [], queuedIds: [], failedIds: [ref.emailId] });
    expect(h.setReadFlag).not.toHaveBeenCalled();
    expect(h.logUserAction).not.toHaveBeenCalled();
    expect(h.activeEngine.bulkMarkAsRead).not.toHaveBeenCalled();
    expect(h.activeStorage.getEmail).not.toHaveBeenCalled();
  });

  it('rejects removed or unavailable mutation owners and refuses runtime replacement without using the active mailbox', async () => {
    h.registered = h.registered.filter(account => account.id !== 'sales-account');
    await expect(h.serviceDeps.setRead!('sales-account', [ref.emailId], true)).rejects.toThrow('no longer connected');
    h.registered.push({ id: 'sales-account', email: 'sales@sarv.example' });
    h.storages.delete('sales-account');
    await expect(h.serviceDeps.setRead!('sales-account', [ref.emailId], true)).rejects.toThrow('not available');
    h.ensureRuntime.mockResolvedValueOnce({ storage: h.salesStorage, syncEngine: h.salesEngine })
      .mockResolvedValueOnce({ storage: h.activeStorage, syncEngine: h.activeEngine });
    await expect(h.serviceDeps.setRead!('sales-account', [ref.emailId], true)).rejects.toThrow('changed');
    expect(h.setReadFlag).not.toHaveBeenCalled();
    expect(h.salesEngine.bulkMarkAsRead).not.toHaveBeenCalled();
    expect(h.activeEngine.bulkMarkAsRead).not.toHaveBeenCalled();
    expect(h.requireStorage).not.toHaveBeenCalled();
  });

  it('does not apply a local flag if its account is removed after the queue acknowledges', async () => {
    h.salesStorage.getEmail.mockResolvedValue({ id: ref.emailId, folderId: 'sent', uid: 42, tags: '|Sent|' });
    h.salesEngine.bulkMarkAsRead.mockImplementationOnce(async () => {
      h.registered = h.registered.filter(account => account.id !== 'sales-account');
      return 'queued';
    });
    expect(await h.serviceDeps.setRead!('sales-account', [ref.emailId], true)).toEqual({ appliedIds: [], queuedIds: [], failedIds: [ref.emailId] });
    expect(h.setReadFlag).not.toHaveBeenCalled();
    expect(h.logUserAction).not.toHaveBeenCalled();
    expect(h.activeStorage.getEmail).not.toHaveBeenCalled();
  });

  it('forwards questions and conversation commands through the validated service', async () => {
    const request = { requestId: 'ask-1', chatId: 'chat-1', question: 'What quote did I send to TCS?', accountIds: ['sales-account'] };
    expect(await call('accounts')).toEqual({ success: true, data: h.registered });
    expect(await call('history')).toEqual({ success: true, data: [] });
    expect(await call('ask', request)).toEqual({ success: true, data: { id: 'answer' } });
    expect(h.service.ask).toHaveBeenCalledExactlyOnceWith(request, expect.any(Function));
    await call('cancel', 'ask-1');
    expect(h.service.cancel).toHaveBeenCalledExactlyOnceWith('ask-1');
    await call('cancel', { requestId: 'ask-1' });
    expect(h.service.cancel).toHaveBeenCalledTimes(2);
    expect(h.service.cancel).toHaveBeenLastCalledWith({ requestId: 'ask-1' });
    expect(await call('clearHistory')).toEqual({ success: true, data: null });
    expect(h.service.clearHistory).toHaveBeenCalledOnce();
  });

  it('lists chat summaries and loads or renames only the explicitly selected chat', async () => {
    const summary = { id: 'chat-1', title: 'TCS quotation', createdAt: 1, updatedAt: 2, exchangeCount: 1 };
    const chat = { ...summary, exchanges: [] };
    h.service.chats.mockReturnValue({ chats: [summary], activeChatId: summary.id });
    h.service.chat.mockReturnValue(chat);
    h.service.createChat.mockReturnValue({ ...chat, id: 'chat-2', title: 'New chat', exchangeCount: 0 });
    h.service.renameChat.mockReturnValue({ ...summary, title: 'Final TCS quote' });
    expect(await call('chats')).toEqual({ success: true, data: { chats: [summary], activeChatId: summary.id } });
    expect(await call('chat', summary.id)).toEqual({ success: true, data: chat });
    expect(h.service.chat).toHaveBeenCalledExactlyOnceWith(summary.id);
    expect(await call('createChat')).toMatchObject({ success: true, data: { id: 'chat-2' } });
    expect(await call('renameChat', { chatId: summary.id, title: 'Final TCS quote' })).toMatchObject({ success: true, data: { title: 'Final TCS quote' } });
    expect(h.service.renameChat).toHaveBeenCalledExactlyOnceWith({ chatId: summary.id, title: 'Final TCS quote' });
    expect(h.service.history).not.toHaveBeenCalled();
  });

  it('pins, deletes and drafts only through their validated service methods', async () => {
    const update = { chatId: 'chat-1', pinned: true };
    h.service.updateChat.mockReturnValue({ id: 'chat-1', pinned: true });
    h.service.deleteChat.mockReturnValue({ chats: [], activeChatId: null });
    const draft = { requestId: 'draft-1', chatId: 'chat-1', accountId: 'sales-account', instructions: 'Ask for approval.' };
    h.service.draftEmail.mockResolvedValue({ ...draft, subject: 'Proposal', body: 'Please review.', to: [], cc: [] });
    expect(await call('updateChat', update)).toMatchObject({ success: true, data: { pinned: true } });
    expect(h.service.updateChat).toHaveBeenCalledExactlyOnceWith(update);
    expect(await call('deleteChat', 'chat-1')).toEqual({ success: true, data: { chats: [], activeChatId: null } });
    expect(h.service.deleteChat).toHaveBeenCalledExactlyOnceWith('chat-1');
    expect(await call('draftEmail', draft)).toMatchObject({ success: true, data: { subject: 'Proposal' } });
    expect(h.service.draftEmail).toHaveBeenCalledExactlyOnceWith(draft, expect.any(Function));
  });

  it('streams draft progress only to the requesting main frame', async () => {
    const activity: InboxAssistantActivity = { requestId: 'draft-1', chatId: 'chat-1', sequence: 1, at: 1, stage: 'context', status: 'running', message: 'Reviewing conversation' };
    h.service.draftEmail.mockImplementation(async (_request, report) => { report(activity); return {}; });
    await call('draftEmail', {});
    expect(h.sender.send).toHaveBeenCalledExactlyOnceWith('inboxAssistant:activity', activity);
    h.sender.send.mockClear();
    h.service.draftEmail.mockImplementation(async (_request, report) => { h.sender.mainFrame = {}; report(activity); return {}; });
    await call('draftEmail', {});
    expect(h.sender.send).not.toHaveBeenCalled();
  });

  it('streams activity only to the original trusted app frame while it still exists', async () => {
    const activity: InboxAssistantActivity = { requestId: 'ask-1', sequence: 1, at: 1000, stage: 'body', status: 'running', message: 'Downloading email body', accountId: 'sales-account' };
    h.service.ask.mockImplementation(async (_request, report) => { report(activity); return { id: 'answer' }; });
    await call('ask', { requestId: 'ask-1' });
    expect(h.sender.send).toHaveBeenCalledExactlyOnceWith('inboxAssistant:activity', activity);
    h.sender.send.mockClear();
    h.sender.isDestroyed.mockReturnValue(true);
    await call('ask', { requestId: 'ask-1' });
    expect(h.sender.send).not.toHaveBeenCalled();
    h.sender.isDestroyed.mockReturnValue(false);
    h.service.ask.mockImplementation(async (_request, report) => { h.sender.mainFrame = {}; report(activity); return { id: 'answer' }; });
    await call('ask', { requestId: 'ask-1' });
    expect(h.sender.send).not.toHaveBeenCalled();
  });

  it('resolves the exact cited Sent account despite a message ID collision in the active Inbox', async () => {
    expect(await call('source', ref)).toEqual({ success: true, data: { emailId: ref.emailId, threadId: 'sales-sent-thread', filename: ref.filename } });
    expect(h.salesStorage.getEmail).toHaveBeenCalledExactlyOnceWith(ref.emailId);
    expect(h.salesStorage.getAttachments).toHaveBeenCalledExactlyOnceWith(ref.emailId);
    expect(h.activeStorage.getEmail).not.toHaveBeenCalled();
    expect(h.requireStorage).not.toHaveBeenCalled();
  });

  it('accepts declared attachment rows when legacy attachmentNames is empty', async () => {
    h.salesStorage.getEmail.mockResolvedValue({ id: ref.emailId, threadId: 'sales-sent-thread', attachmentNames: '[]' });
    expect(await call('source', ref)).toMatchObject({ success: true });
  });

  it('resolves legacy comma-separated attachment names without an attachment row', async () => {
    h.salesStorage.getEmail.mockResolvedValue({ id: ref.emailId, threadId: 'sales-sent-thread', attachmentNames: `${ref.filename}, logo.png` });
    h.salesStorage.getAttachments.mockResolvedValue([]);
    expect(await call('source', ref)).toMatchObject({ success: true, data: { filename: ref.filename } });
  });

  it('rejects unknown accounts, unavailable mailboxes and missing source messages without an active fallback', async () => {
    expect(await call('source', { ...ref, accountId: 'unknown-account' })).toMatchObject({ success: false });
    expect(h.ensureRuntime).not.toHaveBeenCalled();
    h.storages.delete('sales-account');
    expect(await call('source', ref)).toMatchObject({ success: false });
    h.storages.set('sales-account', h.salesStorage);
    h.salesStorage.getEmail.mockResolvedValue(null);
    expect(await call('source', ref)).toEqual({ success: false, error: 'This source is no longer available in its original account.' });
    expect(h.activeStorage.getEmail).not.toHaveBeenCalled();
    expect(h.requireStorage).not.toHaveBeenCalled();
  });

  it('rejects a removed account even when its old runtime remains open', async () => {
    h.registered = h.registered.filter(account => account.id !== ref.accountId);
    expect(await call('source', ref)).toMatchObject({ success: false });
    expect(h.salesStorage.getEmail).not.toHaveBeenCalled();
    expect(h.requireStorage).not.toHaveBeenCalled();
  });

  it('does not resolve a filename that is absent from the cited message', async () => {
    expect(await call('source', { ...ref, filename: 'different-quote.pdf' })).toEqual({ success: false, error: 'This attachment is no longer available on the source message.' });
    expect(h.activeStorage.getAttachments).not.toHaveBeenCalled();
  });

  it.each([null, {}, { ...ref, accountId: '' }, { ...ref, emailId: '' }, { ...ref, filename: '' }, { ...ref, filename: 42 }])('rejects malformed source references before lookup: %j', async value => {
    expect(await call('source', value)).toMatchObject({ success: false });
    expect(h.salesStorage.getEmail).not.toHaveBeenCalled();
    expect(h.requireStorage).not.toHaveBeenCalled();
  });

  it('surfaces registry and service errors as failures instead of attempting another account', async () => {
    h.registryError = true;
    expect(await call('source', ref)).toEqual({ success: false, error: 'Account registry unavailable.' });
    h.service.ask.mockRejectedValue(new Error('Choose an AI provider.'));
    expect(await call('ask', {})).toEqual({ success: false, error: 'Choose an AI provider.' });
    expect(h.requireStorage).not.toHaveBeenCalled();
  });
});
