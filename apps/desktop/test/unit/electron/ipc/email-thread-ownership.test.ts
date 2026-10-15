import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => Promise<unknown>>(),
  active: { getEmailsByThread: vi.fn(), getEmail: vi.fn() },
  cited: { getEmailsByThread: vi.fn(), getEmail: vi.fn() },
  registered: true,
  changed: false,
  strict: vi.fn(),
  lenient: vi.fn(),
}));
vi.mock('electron', () => ({ ipcMain: { handle: (name: string, handler: (...args: unknown[]) => Promise<unknown>) => h.handlers.set(name, handler) }, dialog: {}, shell: {}, app: { getPath: () => '/tmp' } }));
vi.mock('../../../../electron/shared', () => ({
  requireStorage: () => h.active, requireSyncEngine: vi.fn(), getMainWindow: () => null,
  getSyncEngine: () => null, getStorageFor: vi.fn(), getSyncEngineFor: vi.fn(), getCurrentAccountId: () => 'active',
}));
vi.mock('../../../../electron/services/body-prefetch-scheduler', () => ({ deferBodyPrefetch: vi.fn() }));
vi.mock('../../../../electron/services/accounts-runtime', () => ({ ensureAccountRuntime: vi.fn() }));
vi.mock('../../../../electron/ipc/agent-handlers', () => ({ logUserAction: vi.fn() }));
vi.mock('../../../../electron/services/account-target', () => ({
  resolveAccountTarget: h.lenient,
  resolveNamedOrActiveAccountTarget: h.strict,
  requireTargetAccountId: (id: string) => { if (id !== 'cited' || !h.registered) throw new Error('Source account unavailable'); return id; },
}));

import { registerEmailHandlers } from '../../../../electron/ipc/email-handlers';

beforeEach(() => {
  vi.resetAllMocks();
  h.handlers.clear(); h.registered = true; h.changed = false;
  h.active.getEmailsByThread.mockResolvedValue([{ id: 'same-id', account: 'wrong-active-account' }]);
  h.cited.getEmailsByThread.mockResolvedValue([{ id: 'same-id', account: 'cited-account' }]);
  h.active.getEmail.mockResolvedValue(null); h.cited.getEmail.mockResolvedValue(null);
  h.lenient.mockResolvedValue({ storage: h.active, syncEngine: null });
  h.strict.mockImplementation(async (id?: string) => ({ storage: id === undefined || h.changed ? h.active : h.cited, syncEngine: null }));
  registerEmailHandlers();
});

const load = (accountId?: string) => h.handlers.get('emails:thread')!({}, 'same-thread', accountId);

describe('source thread mailbox ownership', () => {
  it('loads the cited account despite colliding IDs in the active inbox', async () => {
    expect(await load('cited')).toEqual({ success: true, data: [{ id: 'same-id', account: 'cited-account' }] });
    expect(h.cited.getEmailsByThread).toHaveBeenCalledExactlyOnceWith('same-thread');
    expect(h.active.getEmailsByThread).not.toHaveBeenCalled();
    expect(h.lenient).not.toHaveBeenCalled();
  });

  it('preserves the unnamed active-mailbox path', async () => {
    expect(await load()).toMatchObject({ success: true });
    expect(h.active.getEmailsByThread).toHaveBeenCalledExactlyOnceWith('same-thread');
  });

  it('opens legacy unthreaded messages only from the cited account', async () => {
    h.cited.getEmailsByThread.mockResolvedValue([]);
    h.cited.getEmail.mockResolvedValue({ id: 'same-thread', threadId: '', account: 'cited-account' });
    expect(await load('cited')).toEqual({ success: true, data: [{ id: 'same-thread', threadId: '', account: 'cited-account' }] });
    expect(h.active.getEmail).not.toHaveBeenCalled();
    h.cited.getEmail.mockResolvedValue({ id: 'same-thread', threadId: 'different-thread' });
    expect(await load('cited')).toEqual({ success: true, data: [] });
  });

  it('rejects removed accounts and a source changed during loading', async () => {
    h.registered = false;
    expect(await load('cited')).toMatchObject({ success: false });
    expect(h.active.getEmailsByThread).not.toHaveBeenCalled();
    h.registered = true;
    h.cited.getEmailsByThread.mockImplementation(async () => { h.changed = true; return [{ id: 'same-id' }]; });
    expect(await load('cited')).toEqual({ success: false, error: 'The thread account changed while loading.' });
    expect(h.active.getEmailsByThread).not.toHaveBeenCalled();
  });
});
