import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => Promise<unknown>>(),
  activeId: 'active', registered: new Set<string>(), stores: new Map<string, unknown>(),
  active: { getRepositories: vi.fn(), getEmailsByIds: vi.fn() },
  cited: { getRepositories: vi.fn(), getEmailsByIds: vi.fn() },
  activeDecisions: vi.fn(), citedDecisions: vi.fn(),
  resolve: vi.fn(), requireActive: vi.fn(),
}));
vi.mock('electron', () => ({ ipcMain: { handle: (name: string, callback: (...args: unknown[]) => Promise<unknown>) => h.handlers.set(name, callback) } }));
vi.mock('../../../../electron/shared', () => ({ requireStorage: h.requireActive, getSyncEngine: () => null }));
vi.mock('../../../../electron/services/account-target', () => ({
  openAccountStorages: () => [], requireNamedOrActiveStorage: h.resolve,
  requireTargetAccountId: (id: string) => { if (!h.registered.has(id)) throw new Error('Proposal account unavailable'); return id; },
}));
vi.mock('../../../../electron/services/accounts-registry', () => ({ resolveAccountIdentity: vi.fn() }));
vi.mock('../../../../electron/services/agent-config-store', () => ({ saveAgentConfig: vi.fn(), loadAgentConfig: vi.fn() }));
vi.mock('../../../../electron/services/contact-classification-service', () => ({ refreshContactClassifications: vi.fn() }));
vi.mock('../../../../electron/services/thread-context', () => ({ buildThreadMessages: vi.fn() }));
vi.mock('../../../../electron/services/unified-pipeline-service', () => ({
  getIntelligence: vi.fn(), getUnifiedPipeline: vi.fn(), setPipelineUserProfile: vi.fn(), getPipelineAIConfig: vi.fn(),
}));

import { registerAgentHandlers } from '../../../../electron/ipc/agent-handlers';

beforeEach(() => {
  vi.resetAllMocks(); h.handlers.clear(); h.activeId = 'active';
  h.registered = new Set(['active', 'cited']); h.stores = new Map([['active', h.active], ['cited', h.cited]]);
  h.requireActive.mockImplementation(() => h.stores.get(h.activeId));
  h.resolve.mockImplementation(async (id?: string) => {
    const storage = h.stores.get(id ?? h.activeId);
    if (!storage) throw new Error('Proposal account unavailable');
    return storage;
  });
  h.active.getRepositories.mockReturnValue({ agent: { getPendingDecisions: h.activeDecisions } });
  h.cited.getRepositories.mockReturnValue({ agent: { getPendingDecisions: h.citedDecisions } });
  h.activeDecisions.mockResolvedValue([{ id: 'same-proposal', emailId: 'same-email', draftBody: 'Active account draft' }]);
  h.citedDecisions.mockResolvedValue([{ id: 'same-proposal', emailId: 'same-email', draftBody: 'Cited account draft' }]);
  h.active.getEmailsByIds.mockResolvedValue([{ id: 'same-email', subject: 'Active subject', fromAddress: 'active-sender@example.test' }]);
  h.cited.getEmailsByIds.mockResolvedValue([{ id: 'same-email', subject: 'Cited subject', fromAddress: 'cited-sender@example.test' }]);
  registerAgentHandlers();
});

const load = (accountId?: unknown) => h.handlers.get('agent:getProposals')!({}, accountId);

describe('agent proposal account ownership', () => {
  it('loads decisions and email metadata from the cited account despite colliding IDs', async () => {
    expect(await load('cited')).toEqual({ success: true, data: [{ id: 'same-proposal', emailId: 'same-email', draftBody: 'Cited account draft',
      subject: 'Cited subject', fromName: '', fromAddress: 'cited-sender@example.test' }] });
    expect(h.citedDecisions).toHaveBeenCalledOnce();
    expect(h.cited.getEmailsByIds).toHaveBeenCalledExactlyOnceWith(['same-email']);
    expect(h.activeDecisions).not.toHaveBeenCalled();
    expect(h.active.getEmailsByIds).not.toHaveBeenCalled();
    expect(h.requireActive).not.toHaveBeenCalled();
  });

  it('keeps the legacy active-account lookup and captures its storage across an active-account switch', async () => {
    h.activeDecisions.mockImplementation(async () => { h.activeId = 'cited'; return [{ id: 'legacy', emailId: 'same-email' }]; });
    expect(await load()).toMatchObject({ success: true, data: [expect.objectContaining({ id: 'legacy', subject: 'Active subject' })] });
    expect(h.active.getEmailsByIds).toHaveBeenCalledExactlyOnceWith(['same-email']);
    expect(h.cited.getEmailsByIds).not.toHaveBeenCalled();
  });

  it.each(['removed', '', null, 10, 'x'.repeat(501)])('refuses invalid/unregistered named accounts without reading active proposals: %j', async accountId => {
    expect(await load(accountId)).toMatchObject({ success: false });
    expect(h.activeDecisions).not.toHaveBeenCalled();
    expect(h.citedDecisions).not.toHaveBeenCalled();
  });

  it('rejects an account removed while its proposals were being read', async () => {
    h.citedDecisions.mockImplementation(async () => { h.registered.delete('cited'); return [{ id: 'old', emailId: 'same-email' }]; });
    expect(await load('cited')).toEqual({ success: false, error: 'Proposal account unavailable' });
    expect(h.cited.getEmailsByIds).not.toHaveBeenCalled();
    expect(h.active.getEmailsByIds).not.toHaveBeenCalled();
  });

  it('rejects a replacement account runtime while email metadata was being read', async () => {
    h.cited.getEmailsByIds.mockImplementation(async () => { h.stores.set('cited', h.active); return [{ id: 'same-email', subject: 'Stale subject' }]; });
    expect(await load('cited')).toEqual({ success: false, error: 'The proposal account changed while loading.' });
    expect(h.active.getEmailsByIds).not.toHaveBeenCalled();
  });
});
