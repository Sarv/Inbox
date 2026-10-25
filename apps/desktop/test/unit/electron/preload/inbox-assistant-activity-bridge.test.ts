import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ElectronAPI } from '../../../../electron/preload';
import type { InboxAssistantActivity } from '../../../../src/types/inbox-assistant';

const h = vi.hoisted(() => ({
  api: null as ElectronAPI | null,
  invoke: vi.fn(),
  listeners: new Map<string, (_event: unknown, payload: unknown) => void>(),
  remove: vi.fn(),
}));
vi.mock('@sentry/electron/preload', () => ({}));
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: (_key: string, api: ElectronAPI) => { h.api = api; } },
  ipcRenderer: {
    invoke: h.invoke,
    on: (channel: string, listener: (_event: unknown, payload: unknown) => void) => h.listeners.set(channel, listener),
    removeListener: (channel: string, listener: unknown) => { h.remove(channel, listener); h.listeners.delete(channel); },
  },
  webFrame: {},
}));

import '../../../../electron/preload';

beforeEach(() => { h.listeners.clear(); h.remove.mockReset(); h.invoke.mockReset().mockResolvedValue({ success: true }); });

describe('Inbox Agent activity bridge', () => {
  it('keeps the read-only overview on its own explicit account-scoped channel', async () => {
    await h.api!.inboxAssistant.dashboard({ accountIds: ['sales'] });
    expect(h.invoke).toHaveBeenCalledExactlyOnceWith('inboxAssistant:dashboard', { accountIds: ['sales'] });
  });
  it('keeps chat listing, individual loading, creation and renaming on their explicit channels', async () => {
    await h.api!.inboxAssistant.chats();
    await h.api!.inboxAssistant.chat('chat-2');
    await h.api!.inboxAssistant.createChat();
    await h.api!.inboxAssistant.renameChat({ chatId: 'chat-2', title: 'TCS final quote' });
    await h.api!.inboxAssistant.updateChat({ chatId: 'chat-2', pinned: true });
    await h.api!.inboxAssistant.deleteChat('chat-3');
    const draft = { requestId: 'draft-1', chatId: 'chat-2', accountId: 'sales', instructions: 'Request approval.' };
    await h.api!.inboxAssistant.draftEmail(draft);
    const question = { chatId: 'chat-2', requestId: 'request-1', question: 'Who received it?', accountIds: ['sales'] };
    await h.api!.inboxAssistant.ask(question);
    expect(h.invoke.mock.calls).toEqual([
      ['inboxAssistant:chats'], ['inboxAssistant:chat', 'chat-2'], ['inboxAssistant:createChat'],
      ['inboxAssistant:renameChat', { chatId: 'chat-2', title: 'TCS final quote' }],
      ['inboxAssistant:updateChat', { chatId: 'chat-2', pinned: true }], ['inboxAssistant:deleteChat', 'chat-3'],
      ['inboxAssistant:draftEmail', draft], ['inboxAssistant:ask', question],
    ]);
  });

  it('exposes observable activity without the privileged Electron event and detaches on cleanup', () => {
    const listener = vi.fn();
    const stop = h.api!.inboxAssistant.onActivity(listener);
    const activity: InboxAssistantActivity = { requestId: 'question-1', sequence: 3, at: 10, stage: 'attachment', status: 'running', message: 'Reading quotation.pdf' };
    h.listeners.get('inboxAssistant:activity')!({ sender: 'privileged Electron object' }, activity);
    expect(listener).toHaveBeenCalledExactlyOnceWith(activity);
    stop();
    expect(h.remove).toHaveBeenCalledExactlyOnceWith('inboxAssistant:activity', expect.any(Function));
    expect(h.listeners.has('inboxAssistant:activity')).toBe(false);
  });
});
