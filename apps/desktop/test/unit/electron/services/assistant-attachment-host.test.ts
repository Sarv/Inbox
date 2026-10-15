import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  registry: new Set<string>(),
  stores: new Map<string, { getEmail: ReturnType<typeof vi.fn>; getFolder: ReturnType<typeof vi.fn>; getAttachments: ReturnType<typeof vi.fn> }>(),
  engines: new Map<string, { isConnected: ReturnType<typeof vi.fn>; fetchAttachmentPart: ReturnType<typeof vi.fn>; fetchAttachment: ReturnType<typeof vi.fn> }>(),
}));

vi.mock('../../../../electron/shared', () => ({ getExtensionManager: () => undefined }));
vi.mock('../../../../electron/services/account-target', () => ({
  requireTargetAccountId: (accountId: string) => { if (!state.registry.has(accountId)) throw new Error('unknown account'); return accountId; },
  requireAccountStorage: async (accountId: string) => { if (!state.registry.has(accountId)) throw new Error('unknown account'); return state.stores.get(accountId); },
  resolveNamedOrActiveAccountTarget: async (accountId: string) => ({ storage: state.stores.get(accountId), syncEngine: state.engines.get(accountId) }),
}));
vi.mock('../../../../electron/services/antivirus-scan-service', () => ({ getAntivirusScanService: vi.fn() }));
vi.mock('../../../../electron/services/assistant-mailbox-download', () => ({
  ensureAssistantMailboxConnection: async (accountId: string) => {
    if (!state.registry.has(accountId)) throw new Error('unknown account');
    return { storage: state.stores.get(accountId), syncEngine: state.engines.get(accountId) };
  },
  fetchAssistantMessageBody: vi.fn(),
}));

import { resolveOwnedAssistantAttachment } from '../../../../electron/services/assistant-attachment-host';

beforeEach(() => {
  state.registry.clear(); state.stores.clear(); state.engines.clear();
  for (const account of ['account-a', 'account-b']) {
    state.registry.add(account);
    state.stores.set(account, {
      getEmail: vi.fn(async () => ({ id: 'same-id', folderId: `${account}-sent`, uid: account === 'account-a' ? 31 : 74, attachmentNames: '["quote.pdf"]', attachmentSizes: '[100]' })),
      getFolder: vi.fn(async () => ({ path: account === 'account-a' ? 'Sent' : '[Gmail]/Sent Mail' })),
      getAttachments: vi.fn(async () => []),
    });
    state.engines.set(account, {
      isConnected: vi.fn(() => true),
      fetchAttachmentPart: vi.fn(async () => ({ content: Buffer.from(`quotation from ${account}`) })),
      fetchAttachment: vi.fn(),
    });
  }
});

describe('assistant attachment account ownership', () => {
  it('accepts a unique owned attachment row when legacy message filename metadata is missing', async () => {
    const store = state.stores.get('account-a')!;
    store.getEmail.mockResolvedValue({ id: 'same-id', folderId: 'account-a-sent', uid: 31, attachmentNames: null, attachmentSizes: null });
    store.getAttachments.mockResolvedValue([{ id: 'attachment-1', emailId: 'same-id', filename: 'quote.pdf', size: 812 }]);
    const owned = await resolveOwnedAssistantAttachment({ accountId: 'account-a', emailId: 'same-id', filename: 'quote.pdf' });
    expect(owned?.size).toBe(812);
    expect(String(await owned!.read(new AbortController().signal))).toBe('quotation from account-a');
    store.getAttachments.mockResolvedValue([{ id: 'wrong-owner', emailId: 'another-email', filename: 'quote.pdf', size: 812 }]);
    await expect(owned!.assertCurrent()).rejects.toThrow('source changed');
    expect(await resolveOwnedAssistantAttachment({ accountId: 'account-a', emailId: 'same-id', filename: 'quote.pdf' })).toBeNull();
  });

  it('keeps identical message IDs and filenames in different accounts separate', async () => {
    const a = await resolveOwnedAssistantAttachment({ accountId: 'account-a', emailId: 'same-id', filename: 'quote.pdf' });
    const b = await resolveOwnedAssistantAttachment({ accountId: 'account-b', emailId: 'same-id', filename: 'quote.pdf' });
    expect(String(await a!.read(new AbortController().signal))).toBe('quotation from account-a');
    expect(String(await b!.read(new AbortController().signal))).toBe('quotation from account-b');
    expect(state.engines.get('account-a')!.fetchAttachmentPart).toHaveBeenCalledWith('same-id', 'Sent', 31, 'quote.pdf');
    expect(state.engines.get('account-b')!.fetchAttachmentPart).toHaveBeenCalledWith('same-id', '[Gmail]/Sent Mail', 74, 'quote.pdf');
  });

  it('rejects unknown accounts, undeclared filenames and duplicate MIME filenames', async () => {
    await expect(resolveOwnedAssistantAttachment({ accountId: 'removed', emailId: 'same-id', filename: 'quote.pdf' })).rejects.toThrow();
    expect(await resolveOwnedAssistantAttachment({ accountId: 'account-a', emailId: 'same-id', filename: '../../private.txt' })).toBeNull();
    state.stores.get('account-a')!.getEmail.mockResolvedValue({ folderId: 'a', uid: 31, attachmentNames: '["quote.pdf","quote.pdf"]' });
    expect(await resolveOwnedAssistantAttachment({ accountId: 'account-a', emailId: 'same-id', filename: 'quote.pdf' })).toBeNull();
  });

  it('checks registry membership again before fetch and never falls back to another account', async () => {
    const owned = await resolveOwnedAssistantAttachment({ accountId: 'account-b', emailId: 'same-id', filename: 'quote.pdf' });
    state.registry.delete('account-b');
    await expect(owned!.read(new AbortController().signal)).rejects.toThrow('unknown account');
    expect(state.engines.get('account-a')!.fetchAttachmentPart).not.toHaveBeenCalled();
    expect(state.engines.get('account-b')!.fetchAttachmentPart).not.toHaveBeenCalled();
  });

  it('withholds data when an account is removed during an attachment fetch', async () => {
    state.engines.get('account-b')!.fetchAttachmentPart.mockImplementation(async () => {
      state.registry.delete('account-b');
      return { content: Buffer.from('must not expose this') };
    });
    const owned = await resolveOwnedAssistantAttachment({ accountId: 'account-b', emailId: 'same-id', filename: 'quote.pdf' });
    await expect(owned!.read(new AbortController().signal)).rejects.toThrow('unknown account');
  });
});
