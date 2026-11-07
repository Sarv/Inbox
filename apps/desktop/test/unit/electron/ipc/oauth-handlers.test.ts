import { setLogSink } from '@sarvinbox/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Changed deliberately (CASA I-2): this file used to pin `oauth:getAccessToken`,
 * the one IPC channel that handed a live bearer to the renderer, limited to
 * Sarv. The channel is gone: the Sarv token is also the Sarv mailbox's XOAUTH2
 * credential (email:read/send/delete), so no token reaches the renderer at all.
 * Its allow-list, crafted-id, log-injection, refresh, permanent/transient and
 * multi-account cases moved to where the token is now used —
 * ai-provider-proxy-oauth.test.ts (AI requests) and
 * sarv-catalog-service.test.ts (the catalog).
 *
 * What this file pins now: the channel stays deleted, and its replacement for
 * the catalog (`oauth:sarvCatalog`) answers plain data, refuses a malformed
 * request before the token store is read, and is covered by the IPC sender
 * guard like every other handler.
 *
 * Only the token store, the network gate and `fetch` are faked.
 */

type StoredAccount = Record<string, unknown> & { provider: string; email: string };
type Handler = (...args: unknown[]) => unknown;

const h = vi.hoisted(() => {
  const handlers = new Map<string, Handler>();
  const noop = () => undefined;
  return {
    handlers,
    accounts: [] as StoredAccount[],
    chromiumFetch: vi.fn(),
    // Shaped like ipcMain so the real sender guard can wrap it.
    ipcMain: {
      handle: (n: string, fn: Handler) => { handlers.set(n, fn); },
      handleOnce: (n: string, fn: Handler) => { handlers.set(n, fn); },
      on: noop, once: noop, addListener: noop, prependListener: noop,
      prependOnceListener: noop, removeListener: noop, off: noop,
    },
  };
});

vi.mock('electron', () => ({
  ipcMain: h.ipcMain,
  shell: { openExternal: async () => {} },
}));

// The catalog's network call; never reached by the cases here.
vi.mock('../../../../electron/services/net-fetch', () => ({ chromiumFetch: h.chromiumFetch }));

// Sign-in, sign-out and proactive refresh belong to the other oauth:* handlers.
vi.mock('../../../../electron/services/oauth-refresh-scheduler', () => ({
  rescheduleOAuthAccount: vi.fn(),
  signOutOAuthAccount: vi.fn(),
}));

vi.mock('../../../../electron/services/network-readiness', () => ({
  waitForNetworkReady: async () => true,
}));

vi.mock('../../../../electron/services/oauth-token-store', () => {
  const same = (a: StoredAccount, provider: unknown, email: string) =>
    a.provider === provider && a.email.toLowerCase() === email.toLowerCase();
  return {
    getAccount: vi.fn(async (provider: unknown, email: string) =>
      h.accounts.find((a) => same(a, provider, email)) ?? null),
    saveAccount: vi.fn(async (next: StoredAccount) => {
      h.accounts = h.accounts.map((a) => (same(a, next.provider, next.email) ? next : a));
    }),
    removeAccount: vi.fn(async () => false),
    listAccounts: vi.fn(async () => [...h.accounts]),
  };
});

import { registerOAuthHandlers } from '../../../../electron/ipc/oauth-handlers';
import { getAccount } from '../../../../electron/services/oauth-token-store';
import { installIpcSenderGuard, type IpcMainLike } from '../../../../electron/utils/ipc-sender-guard';

const nowSec = () => Math.floor(Date.now() / 1000);
const APP_URL = 'file:///Applications/Sarv%20Inbox.app/Contents/Resources/app.asar/dist/index.html';

/** A signed-in account whose access token has an hour of life left. */
const liveAccount = (provider: string, email: string, accessToken: string): StoredAccount => ({
  provider,
  email,
  accessToken,
  refreshToken: `rt-${email}`,
  accessExpiresAt: nowSec() + 3_600,
  scopes: [],
  createdAt: nowSec() - 86_400,
  updatedAt: nowSec() - 60,
});

const fetchMock = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  h.handlers.clear();
  h.accounts = [];
  vi.stubGlobal('fetch', fetchMock);
  setLogSink(() => {});
  for (const method of ['log', 'warn', 'error'] as const) {
    vi.spyOn(console, method).mockImplementation(() => {});
  }
  registerOAuthHandlers();
});

afterEach(() => {
  setLogSink(null);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('no access token reaches the renderer', () => {
  // THE I-2 regression: breaks if any channel that hands the renderer a bearer
  // comes back — for Sarv or for any other provider.
  it('registers no oauth:getAccessToken channel, nor any other token channel', () => {
    expect(h.handlers.has('oauth:getAccessToken')).toBe(false);
    expect([...h.handlers.keys()].filter((channel) => /token/i.test(channel))).toEqual([]);
  });

  // Breaks if a refactor drops the catalog channel the pickers now depend on.
  it('registers the catalog channel and the remaining oauth:* channels', () => {
    expect([...h.handlers.keys()].sort()).toEqual([
      'oauth:cancel', 'oauth:listAccounts', 'oauth:listProviders', 'oauth:listReauthRequired',
      'oauth:sarvCatalog', 'oauth:signOut', 'oauth:startFlow',
    ]);
  });

  // Breaks if listAccounts starts carrying token material to the renderer.
  it('lists accounts without any token', async () => {
    h.accounts.push(liveAccount('sarv', 'me@sarv.com', 'sarv-live-token'));
    const res = await h.handlers.get('oauth:listAccounts')!({});
    expect(res).toMatchObject({ success: true, data: [{ provider: 'sarv', email: 'me@sarv.com' }] });
    expect(JSON.stringify(res)).not.toMatch(/live-token|rt-me/);
  });
});

describe('oauth:sarvCatalog', () => {
  // Breaks: a malformed request reaches the token store (and so can start a
  // refresh on the renderer's behalf), or an Error crosses IPC instead of data.
  it('answers a malformed request with plain data, before reading the token store', async () => {
    h.accounts.push(liveAccount('sarv', 'me@sarv.com', 'sarv-live-token'));
    await expect(h.handlers.get('oauth:sarvCatalog')!({}, { kind: 'wallet', email: 'me@sarv.com' })).resolves.toEqual({
      ok: false, status: 0, code: 'invalid_request', message: 'Invalid Sarv catalog request.',
    });
    expect(getAccount).not.toHaveBeenCalled();
    expect(h.chromiumFetch).not.toHaveBeenCalled();
  });

  // Breaks: the catalog channel, carrying the user's Sarv token to the
  // network, is answered for a sender other than the app window (an email
  // frame, an extension panel). The guard wraps ipcMain itself, so this proves
  // the new channel is covered like every other handler.
  it('is refused by the IPC sender guard for a sender that is not the app window', async () => {
    const original = { ...h.ipcMain };
    const appWebContents = {};
    const mainWindow = { isDestroyed: () => false, webContents: appWebContents };
    try {
      installIpcSenderGuard(h.ipcMain as unknown as IpcMainLike, { mainWindow: () => mainWindow, appUrl: () => APP_URL });
      h.handlers.clear();
      registerOAuthHandlers();
      h.accounts.push(liveAccount('sarv', 'me@sarv.com', 'sarv-live-token'));
      const request = { kind: 'zones', email: 'me@sarv.com' };
      const emailFrame = { sender: appWebContents, senderFrame: { url: 'about:srcdoc', parent: {} } };

      expect(() => h.handlers.get('oauth:sarvCatalog')!(emailFrame, request)).toThrow('Refused IPC "oauth:sarvCatalog"');
      expect(getAccount).not.toHaveBeenCalled();
      expect(h.chromiumFetch).not.toHaveBeenCalled();

      // The app window itself still gets an answer.
      h.chromiumFetch.mockResolvedValue(new Response('[]', { status: 200 }));
      const appFrame = { sender: appWebContents, senderFrame: { url: APP_URL, parent: null } };
      await expect(h.handlers.get('oauth:sarvCatalog')!(appFrame, request)).resolves.toEqual({ ok: true, body: [] });
    } finally {
      Object.assign(h.ipcMain, original);
    }
  });
});
