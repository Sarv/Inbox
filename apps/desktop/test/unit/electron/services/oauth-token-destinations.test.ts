import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A mail or AI bearer is minted in main for a config the RENDERER sent — host,
 * baseUrl and oauthProvider included. The renderer also renders untrusted email
 * HTML and hosts extension panels, so it must not be able to choose where the
 * user's Gmail (restricted-scope) or Sarv token goes. These pin that every
 * token-attaching path in oauth-service refuses a destination that is not the
 * provider's own, and does so BEFORE the token store is read.
 *
 * Only the token store, the network gate and the logger are faked; the guard,
 * the provider registry and the token path are the real ones.
 */

const h = vi.hoisted(() => ({
  getAccount: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('electron', () => ({
  shell: { openExternal: async () => {} },
  app: { getPath: () => '/tmp/sarvinbox-test', getName: () => 'Sarv Inbox Test', isPackaged: false },
}));
vi.mock('../../../../electron/services/oauth-token-store', () => ({
  getAccount: h.getAccount,
  saveAccount: async () => {},
  removeAccount: async () => false,
  listAccounts: async () => [],
}));
vi.mock('../../../../electron/services/network-readiness', () => ({
  waitForNetworkReady: async () => true,
}));
vi.mock('@sarvinbox/core', async (orig) => ({
  ...(await orig<typeof import('@sarvinbox/core')>()),
  createLogger: () => ({ info: vi.fn(), warn: h.warn, error: vi.fn(), debug: vi.fn() }),
}));

import {
  attachImapBearer,
  attachOAuthBearer,
  getAccessTokenForMailHost,
} from '../../../../electron/services/oauth-service';

const NOW_SEC = Math.floor(Date.now() / 1000);
const liveAccount = (provider: string, email: string) => ({
  provider,
  email,
  accessToken: `${provider}-token`,
  refreshToken: 'rt',
  accessExpiresAt: NOW_SEC + 3_600,
  scopes: [],
  updatedAt: NOW_SEC - 60,
});

beforeEach(() => {
  h.getAccount.mockReset().mockImplementation(async (provider: string, email: string) => liveAccount(provider, email));
  h.warn.mockReset();
});

describe('getAccessTokenForMailHost', () => {
  // Breaks: Gmail / Outlook accounts stop connecting once the guard ships.
  it('returns the token for the provider\'s own IMAP and SMTP hosts', async () => {
    await expect(getAccessTokenForMailHost('gmail', 'me@gmail.com', 'imap', 'imap.gmail.com')).resolves.toBe('gmail-token');
    await expect(getAccessTokenForMailHost('gmail', 'me@gmail.com', 'smtp', 'smtp.gmail.com')).resolves.toBe('gmail-token');
    await expect(getAccessTokenForMailHost('microsoft', 'me@outlook.com', 'smtp', 'smtp.office365.com')).resolves.toBe('microsoft-token');
    await expect(getAccessTokenForMailHost('sarv', 'me@sarv.com', 'imap', 'imap.sarv.com')).resolves.toBe('sarv-token');
  });

  // THE leak. Breaks: a renderer-chosen server receives the user's Gmail token.
  it('refuses a foreign host before reading the token store, with a terminal code and a security log', async () => {
    const err = await getAccessTokenForMailHost('gmail', 'me@gmail.com', 'imap', 'imap.evil.example').catch((e) => e);
    expect(err).toMatchObject({ code: 'TOKEN_DESTINATION_REFUSED' });
    expect(String(err.message)).toContain('imap.evil.example');
    expect(h.getAccount).not.toHaveBeenCalled();
    expect(h.warn).toHaveBeenCalledWith(expect.stringContaining('Refused a gmail token for IMAP host "imap.evil.example"'));
  });

  // Breaks: a missing host is treated as "no restriction".
  it('refuses a missing host', async () => {
    await expect(getAccessTokenForMailHost('gmail', 'me@gmail.com', 'smtp', undefined)).rejects.toMatchObject({
      code: 'TOKEN_DESTINATION_REFUSED',
      message: expect.stringContaining('an unspecified host'),
    });
    expect(h.getAccount).not.toHaveBeenCalled();
  });

  // Multi-account: two signed-in providers. Breaks: account A's token can be
  // pointed at account B's provider (presented to, and logged by, a third party).
  it('refuses another provider\'s server even when both accounts are signed in', async () => {
    await expect(getAccessTokenForMailHost('gmail', 'me@gmail.com', 'smtp', 'smtp.office365.com')).rejects.toMatchObject({
      code: 'TOKEN_DESTINATION_REFUSED',
    });
    await expect(getAccessTokenForMailHost('microsoft', 'me@outlook.com', 'imap', 'imap.gmail.com')).rejects.toMatchObject({
      code: 'TOKEN_DESTINATION_REFUSED',
    });
    expect(h.getAccount).not.toHaveBeenCalled();
  });

  // Breaks: the 401 recovery path (forceRefresh) loses its flag through the guard.
  it('forwards forceRefresh to the real token path', async () => {
    // A live token would be returned as-is without forceRefresh; with it, the
    // refresher runs — and with no fetch available here, it fails. Reaching the
    // refresher at all proves the flag got through.
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed'); }));
    try {
      await expect(getAccessTokenForMailHost('gmail', 'me@gmail.com', 'imap', 'imap.gmail.com', true)).rejects.toBeTruthy();
      expect(h.getAccount).toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('attachImapBearer', () => {
  const base = { host: 'imap.gmail.com', port: 993, secure: true, username: 'me@gmail.com', authMethod: 'oauth2' as const };

  // Breaks: the pool / reconnect resolver for a legitimate account stops minting.
  it('attaches a resolver that mints for the provider\'s own IMAP host', async () => {
    const cfg = attachImapBearer({ ...base, oauthProvider: 'gmail' } as never);
    await expect(cfg.resolveBearer!()).resolves.toBe('gmail-token');
  });

  // Breaks: the connect proceeds and the pool later presents the token to the
  // foreign host on every reconnect.
  it('throws up front for a foreign IMAP host, without reading the store', () => {
    expect(() => attachImapBearer({ ...base, host: 'imap.evil.example', oauthProvider: 'gmail' } as never)).toThrow(
      expect.objectContaining({ code: 'TOKEN_DESTINATION_REFUSED' }),
    );
    expect(h.getAccount).not.toHaveBeenCalled();
  });

  // Breaks: password accounts on custom servers start failing the guard.
  it('leaves password-auth and provider-less configs untouched', () => {
    const pw = { ...base, host: 'mail.example.org', authMethod: 'password' as const, password: 'x' };
    expect(attachImapBearer(pw as never)).toBe(pw);
    const noProvider = { ...base, host: 'mail.example.org' };
    expect(attachImapBearer(noProvider as never)).toBe(noProvider);
  });
});

describe('attachOAuthBearer — AI provider configs', () => {
  const sarvConfig = {
    type: 'sarv',
    model: 'm',
    apiKey: '',
    authMethod: 'oauth' as const,
    oauthProvider: 'sarv' as const,
    oauthEmail: 'me@sarv.com',
    baseUrl: 'https://jpr1-ai-edge.sarv.com/edge/v1/llm',
  };

  // Breaks: Sarv AI stops authenticating.
  it('attaches a Sarv resolver for a Sarv AI endpoint', async () => {
    const cfg = attachOAuthBearer(sarvConfig) as typeof sarvConfig & { resolveBearer?: () => Promise<string> };
    await expect(cfg.resolveBearer!()).resolves.toBe('sarv-token');
    expect(h.warn).not.toHaveBeenCalled();
  });

  // THE second leak: the renderer names a mail provider for an AI config.
  // Breaks: main POSTs the user's Gmail token to the config's baseUrl.
  it('refuses a mail provider\'s token for an AI endpoint, even a Sarv one', () => {
    for (const oauthProvider of ['gmail', 'microsoft', 'yahoo']) {
      const cfg = attachOAuthBearer({ ...sarvConfig, oauthProvider } as never) as { resolveBearer?: unknown };
      expect(cfg.resolveBearer).toBeUndefined();
    }
    expect(h.warn).toHaveBeenCalledWith(expect.stringContaining('Refused a gmail token for AI endpoint'));
  });

  // Breaks: the Sarv token (with its email:* scopes) goes to a renderer-chosen server.
  it.each([
    'https://evil.example/v1',
    'https://api.openai.com/v1',
    undefined, // falls through to the OpenAI default endpoint
  ])('refuses a Sarv token for AI endpoint %j', (baseUrl) => {
    const cfg = attachOAuthBearer({ ...sarvConfig, baseUrl }) as { resolveBearer?: unknown };
    expect(cfg.resolveBearer).toBeUndefined();
    expect(h.warn).toHaveBeenCalledTimes(1);
  });

  // Breaks: API-key providers (OpenAI, Gemini, custom) get wrapped or logged.
  it('passes API-key configs through untouched and silently', () => {
    const apiKey = { type: 'openai', model: 'gpt', apiKey: 'sk-x', baseUrl: 'https://api.openai.com/v1' };
    expect(attachOAuthBearer(apiKey)).toBe(apiKey);
    expect(h.warn).not.toHaveBeenCalled();
  });
});
