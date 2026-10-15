import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  registered: true,
  suspended: false,
  storage: {} as { getEmail: ReturnType<typeof vi.fn>; getFolder: ReturnType<typeof vi.fn> },
  engine: {} as {
    isConnected: ReturnType<typeof vi.fn>; hasConnectionConfig: ReturnType<typeof vi.fn>; isConnecting: ReturnType<typeof vi.fn>;
    ensureConnection: ReturnType<typeof vi.fn>; connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn>; fetchBody: ReturnType<typeof vi.fn>;
  },
  secrets: vi.fn(),
  token: vi.fn(),
  account: { id: 'work', imapConfig: { host: 'imap.example.test', port: 993, secure: true, username: 'rc@example.test' } as Record<string, unknown> },
}));

vi.mock('../../../../electron/shared', () => ({ getIsQuitting: () => false, getSystemSuspended: () => state.suspended }));
vi.mock('../../../../electron/services/account-target', () => ({
  requireTargetAccountId: (id: string) => { if (!state.registered || id !== 'work') throw new Error('unknown account'); return id; },
  requireAccountStorage: async (id: string) => { if (!state.registered || id !== 'work') throw new Error('unknown account'); return state.storage; },
  resolveNamedOrActiveAccountTarget: async () => ({ storage: state.storage, syncEngine: state.engine }),
}));
vi.mock('../../../../electron/services/accounts-registry', () => ({ readRegistryAccounts: () => state.registered ? [state.account] : [] }));
vi.mock('../../../../electron/services/secure-credential-store', () => ({ getAccountSecrets: state.secrets }));
vi.mock('../../../../electron/services/oauth-service', () => ({ attachImapBearer: (config: unknown) => config, getValidAccessToken: state.token }));

import { ensureAssistantMailboxConnection, fetchAssistantMessageBody } from '../../../../electron/services/assistant-mailbox-download';

beforeEach(() => {
  state.registered = true; state.suspended = false;
  let connected = false;
  let configured = false;
  state.account.imapConfig = { host: 'imap.example.test', port: 993, secure: true, username: 'rc@example.test' };
  state.secrets.mockReset().mockResolvedValue({ imap: { password: 'synthetic-secret' } });
  state.token.mockReset().mockResolvedValue('synthetic-token');
  state.storage = {
    getEmail: vi.fn(async () => ({ id: 'quote', folderId: 'sent-folder', uid: 0, cleanBody: null, rawBody: null, attachmentNames: null })),
    getFolder: vi.fn(async () => ({ path: 'Sent' })),
  };
  state.engine = {
    isConnected: vi.fn(() => connected), hasConnectionConfig: vi.fn(() => configured), isConnecting: vi.fn(() => false),
    ensureConnection: vi.fn(async () => { connected = true; return true; }),
    connect: vi.fn(async () => { connected = true; configured = true; }),
    disconnect: vi.fn(async () => { connected = false; }),
    fetchBody: vi.fn(async (_emailId, _folder, _uid, options) => {
      options?.onStart?.();
      state.storage.getEmail.mockResolvedValue({ id: 'quote', folderId: 'sent-folder', uid: 82, cleanBody: 'TCS quotation attached', rawBody: '<p>TCS quotation attached</p>', attachmentNames: '["TCS.pdf"]' });
      return { rawBody: '<p>TCS quotation attached</p>', cleanBody: 'TCS quotation attached', contentType: 'text/html', source: 'synthetic' };
    }),
  };
});

describe('automatic account-safe assistant downloads', () => {
  it('connects a fresh non-active account with its own vault credentials and preserves TLS validation', async () => {
    await ensureAssistantMailboxConnection('work');
    expect(state.engine.connect).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      host: 'imap.example.test', username: 'rc@example.test', password: 'synthetic-secret', tlsOptions: expect.objectContaining({ rejectUnauthorized: true }),
    }));
    expect(state.engine.ensureConnection).not.toHaveBeenCalled();
  });

  it('reuses the existing reconnect ladder without retrying known-rejected credentials', async () => {
    state.engine.hasConnectionConfig.mockReturnValue(true);
    state.engine.ensureConnection.mockResolvedValue(false);
    await expect(ensureAssistantMailboxConnection('work')).rejects.toThrow('could not reconnect');
    await expect(ensureAssistantMailboxConnection('work')).rejects.toThrow('try again shortly');
    expect(state.engine.ensureConnection).toHaveBeenCalledOnce();
    expect(state.engine.connect).not.toHaveBeenCalled();
    expect(state.secrets).not.toHaveBeenCalled();
    expect(state.engine.disconnect).not.toHaveBeenCalled();
  });

  it('refreshes OAuth credentials for the account being downloaded', async () => {
    state.account.imapConfig = { ...state.account.imapConfig, authMethod: 'oauth2', oauthProvider: 'gmail' };
    await ensureAssistantMailboxConnection('work');
    expect(state.token).toHaveBeenCalledWith('gmail', 'rc@example.test');
    expect(state.engine.connect).toHaveBeenCalledWith(expect.objectContaining({ accessToken: 'synthetic-token' }));
    expect(state.secrets).not.toHaveBeenCalled();
  });

  it('downloads zero-UID messages through the normal queue and returns newly discovered attachments', async () => {
    const result = await fetchAssistantMessageBody('work', 'quote');
    expect(state.engine.fetchBody).toHaveBeenCalledWith('quote', 'Sent', 0, expect.objectContaining({ onStart: expect.any(Function) }));
    expect(result).toMatchObject({ uid: 82, cleanBody: 'TCS quotation attached', attachmentNames: '["TCS.pdf"]' });
  });

  it('does not connect if body content is already cached', async () => {
    state.storage.getEmail.mockResolvedValue({ cleanBody: 'Stored quotation', rawBody: null });
    expect(await fetchAssistantMessageBody('work', 'quote')).toMatchObject({ cleanBody: 'Stored quotation' });
    expect(state.engine.connect).not.toHaveBeenCalled();
    expect(state.secrets).not.toHaveBeenCalled();
  });

  it('rejects removed accounts before connecting or exposing downloaded content', async () => {
    state.secrets.mockImplementation(async () => { state.registered = false; return { imap: { password: 'synthetic-secret' } }; });
    await expect(ensureAssistantMailboxConnection('work')).rejects.toThrow('unknown account');
    expect(state.engine.connect).not.toHaveBeenCalled();
    expect(state.engine.fetchBody).not.toHaveBeenCalled();
  });

  it('stops the consumer on cancellation without closing another caller’s existing socket', async () => {
    const controller = new AbortController();
    let finish: ((value: boolean) => void) | undefined;
    state.engine.hasConnectionConfig.mockReturnValue(true);
    state.engine.ensureConnection.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const result = ensureAssistantMailboxConnection('work', controller.signal);
    await vi.waitFor(() => expect(state.engine.ensureConnection).toHaveBeenCalledOnce());
    controller.abort(new Error('Search cancelled'));
    await expect(result).rejects.toThrow('Search cancelled');
    state.engine.isConnected.mockReturnValue(true);
    finish?.(true);
    expect(state.engine.disconnect).not.toHaveBeenCalled();
  });
});
