import { transportOptInsOf } from '@sarvinbox/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  registered: true,
  suspended: false,
  storage: {} as { getEmail: ReturnType<typeof vi.fn>; getFolder: ReturnType<typeof vi.fn> },
  engine: {} as {
    isConnected: ReturnType<typeof vi.fn>; isConnectedWith: ReturnType<typeof vi.fn>; hasConnectionConfig: ReturnType<typeof vi.fn>; isConnecting: ReturnType<typeof vi.fn>;
    ensureConnection: ReturnType<typeof vi.fn>; connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn>; fetchBody: ReturnType<typeof vi.fn>;
  },
  secrets: vi.fn(),
  narrowTransport: vi.fn(),
  token: vi.fn(),
  account: { id: 'work', email: 'rc@example.test', imapConfig: { host: 'imap.example.test', port: 993, secure: true, username: 'rc@example.test' } as Record<string, unknown> },
}));

vi.mock('../../../../electron/shared', () => ({ getIsQuitting: () => false, getSystemSuspended: () => state.suspended }));
vi.mock('../../../../electron/services/account-target', () => ({
  requireTargetAccountId: (id: string) => { if (!state.registered || id !== 'work') throw new Error('unknown account'); return id; },
  requireAccountStorage: async (id: string) => { if (!state.registered || id !== 'work') throw new Error('unknown account'); return state.storage; },
  resolveNamedOrActiveAccountTarget: async () => ({ storage: state.storage, syncEngine: state.engine }),
}));
vi.mock('../../../../electron/services/accounts-registry', () => ({ readRegistryAccounts: () => state.registered ? [state.account] : [] }));
vi.mock('../../../../electron/services/secure-credential-store', () => ({
  getAccountSecrets: state.secrets,
  bindAccountSecretHost: vi.fn(), bindAccountSecretTransport: vi.fn(),
  narrowAccountSecretTransport: state.narrowTransport,
}));
vi.mock('../../../../electron/services/oauth-service', () => ({ attachImapBearer: (config: unknown) => config, getAccessTokenForMailHost: state.token }));

import { ensureAssistantMailboxConnection, fetchAssistantMessageBody } from '../../../../electron/services/assistant-mailbox-download';

beforeEach(() => {
  state.registered = true; state.suspended = false;
  let connected = false;
  let configured = false;
  state.account.imapConfig = { host: 'imap.example.test', port: 993, secure: true, username: 'rc@example.test' };
  state.secrets.mockReset().mockResolvedValue({ imap: {
    password: 'synthetic-secret', host: 'imap.example.test', allowInsecureTLS: false, allowPlaintext: false,
  } });
  state.narrowTransport.mockReset().mockResolvedValue(undefined);
  state.token.mockReset().mockResolvedValue('synthetic-token');
  state.storage = {
    getEmail: vi.fn(async () => ({ id: 'quote', folderId: 'sent-folder', uid: 0, cleanBody: null, rawBody: null, attachmentNames: null })),
    getFolder: vi.fn(async () => ({ path: 'Sent' })),
  };
  state.engine = {
    isConnected: vi.fn(() => connected), hasConnectionConfig: vi.fn(() => configured), isConnecting: vi.fn(() => false),
    ensureConnection: vi.fn(async () => { connected = true; return true; }),
    connect: vi.fn(async () => { connected = true; configured = true; }),
    isConnectedWith: vi.fn((config: unknown) => state.engine.connect.mock.calls.some(([value]) => value === config)),
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
      host: 'imap.example.test', username: 'rc@example.test', password: 'synthetic-secret',
      allowInsecureTLS: false,
    }));
    expect(transportOptInsOf(state.engine.connect.mock.calls[0][0])).toEqual({ allowInsecureTLS: false, allowPlaintext: false });
    expect(state.engine.connect.mock.calls[0][0]).not.toHaveProperty('tlsOptions');
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
    state.account.imapConfig = { ...state.account.imapConfig, host: 'imap.gmail.com', authMethod: 'oauth2', oauthProvider: 'gmail' };
    await ensureAssistantMailboxConnection('work');
    expect(state.token).toHaveBeenCalledWith('gmail', 'rc@example.test', 'imap', 'imap.gmail.com');
    expect(state.engine.connect).toHaveBeenCalledWith(expect.objectContaining({ accessToken: 'synthetic-token' }));
    expect(state.secrets).not.toHaveBeenCalled();
  });

  it('does not dial when the host-bound OAuth guard refuses the registry host', async () => {
    state.account.imapConfig = { ...state.account.imapConfig, host: 'imap.foreign.test', authMethod: 'oauth2', oauthProvider: 'gmail' };
    state.token.mockRejectedValue(new Error('A gmail sign-in can only be used with gmail mail servers'));
    await expect(ensureAssistantMailboxConnection('work')).rejects.toThrow('only be used');
    expect(state.token).toHaveBeenCalledExactlyOnceWith('gmail', 'rc@example.test', 'imap', 'imap.foreign.test');
    expect(state.engine.connect).not.toHaveBeenCalled();
    expect(state.secrets).not.toHaveBeenCalled();
  });

  it('requires an OAuth provider instead of silently trying a saved password', async () => {
    state.account.imapConfig = { ...state.account.imapConfig, authMethod: 'oauth2' };
    await expect(ensureAssistantMailboxConnection('work')).rejects.toThrow('OAuth provider');
    expect(state.engine.connect).not.toHaveBeenCalled();
    expect(state.secrets).not.toHaveBeenCalled();
  });

  it('uses the real foreground vault host binding rather than a legacy alias password alone', async () => {
    state.account.imapConfig = { ...state.account.imapConfig, host: 'imap.foreign.test' };
    await expect(ensureAssistantMailboxConnection('work')).rejects.toThrow('Re-enter your password');
    expect(state.engine.connect).not.toHaveBeenCalled();
  });

  it.each([
    { allowInsecureTLS: true, message: 'without checking' },
    { security: 'none', secure: false, port: 143, message: 'without encryption' },
  ])('refuses to send a saved password over a newly relaxed transport ($message)', async ({ message, ...patch }) => {
    state.account.imapConfig = { ...state.account.imapConfig, ...patch };
    await expect(ensureAssistantMailboxConnection('work')).rejects.toThrow(message);
    expect(state.engine.connect).not.toHaveBeenCalled();
  });

  it('preserves an explicitly saved self-signed opt-in while applying the bound password', async () => {
    state.account.imapConfig = { ...state.account.imapConfig, allowInsecureTLS: true };
    state.secrets.mockResolvedValue({ imap: { password: 'synthetic-secret', host: 'imap.example.test', allowInsecureTLS: true, allowPlaintext: false } });
    await ensureAssistantMailboxConnection('work');
    expect(state.engine.connect).toHaveBeenCalledWith(expect.objectContaining({ password: 'synthetic-secret', allowInsecureTLS: true }));
    expect(transportOptInsOf(state.engine.connect.mock.calls[0][0])).toEqual({ allowInsecureTLS: true, allowPlaintext: false });
    expect(state.narrowTransport).not.toHaveBeenCalled();
  });

  it('narrows unused saved transport relaxations only after this exact configuration connected', async () => {
    state.secrets.mockResolvedValue({ imap: { password: 'synthetic-secret', host: 'imap.example.test', allowInsecureTLS: true, allowPlaintext: true } });
    await ensureAssistantMailboxConnection('work');
    expect(state.narrowTransport).toHaveBeenCalledExactlyOnceWith('work', 'imap', 'synthetic-secret', ['allowInsecureTLS', 'allowPlaintext']);
    expect(state.engine.isConnectedWith).toHaveBeenCalledWith(state.engine.connect.mock.calls[0][0]);
  });

  it('does not narrow transport for a concurrent connection that used another configuration', async () => {
    state.secrets.mockResolvedValue({ imap: { password: 'synthetic-secret', host: 'imap.example.test', allowInsecureTLS: true, allowPlaintext: true } });
    state.engine.isConnectedWith.mockReturnValue(false);
    await ensureAssistantMailboxConnection('work');
    expect(state.narrowTransport).not.toHaveBeenCalled();
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
    state.secrets.mockImplementation(async () => { state.registered = false; return { imap: {
      password: 'synthetic-secret', host: 'imap.example.test', allowInsecureTLS: false, allowPlaintext: false,
    } }; });
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
