import http from 'node:http';

import type { AntivirusSetupStatus } from '@sarvinbox/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AntivirusOAuthService, runScannerLoopbackFlow, SARV_SCANNER_EXTENSION_ID, SARV_SCANNER_ORIGIN } from '../../../../electron/services/antivirus-oauth-service';

const EMPTY: AntivirusSetupStatus = { configured: false, enabled: false, endpoint: '', allowedAccountIds: [], allowBody: false,
  accounts: [{ id: 'account-a', email: 'a@example.test', name: 'Account A' }, { id: 'account-b', email: 'b@example.test', name: 'Account B' }] };
const VERIFIED: AntivirusSetupStatus = { ...EMPTY, endpoint: SARV_SCANNER_ORIGIN, operator: 'Sarv', region: 'India',
  privacyPolicyUrl: 'https://av.sarv.com/privacy', privacyTermsVersion: 'privacy-v1', scanPolicyVersion: 'clamav-v1',
  contentLifetimeSeconds: 300, resultLifetimeSeconds: 900, metadataRetentionSeconds: 2592000 };
const CONFIG = { authProvider: 'sarv', serviceMode: 'scanner', issuerUrl: 'https://oauth.sarv.com',
  clientId: 'client_uTgnwHY2tHHO6dhxyyqOeg', tokenAudience: '4bfb47a3-e893-4e63-8057-7cc5db2fde7e',
  discoveryUrl: '/ui/oauth/discovery', scopes: 'openid email profile' };
const DISCOVERY = { issuer: CONFIG.issuerUrl, authorization_endpoint: 'https://oauth.sarv.com/oauth/authorize', token_endpoint: '/ui/oauth/token' };
const ISSUED_ID = '00000000-0000-4000-8000-000000000000';
const SECRET = 'iv_' + 'a'.repeat(43);
const NOW = Date.parse('2026-10-05T10:00:00Z');
const response = (data: unknown, status = 200) => new Response(status === 204 ? null : JSON.stringify(data), { status });

function fixture() {
  const scan = { getTrustedSetup: vi.fn(async () => EMPTY), probe: vi.fn(async () => ({ challenge: 'synthetic-challenge', setup: VERIFIED })),
    configure: vi.fn(async () => ({ ...VERIFIED, configured: true, enabled: true, allowedAccountIds: ['account-a'] })) };
  const prepareExtension = vi.fn(async () => {});
  const assertAuthorized = vi.fn((id: string) => { if (!['account-a', 'account-b'].includes(id)) throw new Error('Mailbox unavailable'); });
  const assertSecureStorage = vi.fn();
  const openExternal = vi.fn(async () => {});
  const now = vi.fn(() => NOW);
  const urls: string[] = [];
  const loopback = vi.fn(async (authorize: (redirect: string) => string) => {
    urls.push(authorize('http://127.0.0.1:8080/auth/callback'));
    return { code: 'synthetic-code', redirectUri: 'http://127.0.0.1:8080/auth/callback' };
  });
  const requestFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    if (path === '/ui/config') return response(CONFIG);
    if (path === '/ui/oauth/discovery') return response(DISCOVERY);
    if (path === '/ui/oauth/token') return response({ access_token: 'synthetic-scanner-oauth-access', refresh_token: 'never-stored', token_type: 'Bearer' });
    if (path === '/api/v1/tokens' && init?.method === 'POST') return response({ id: ISSUED_ID, token: SECRET, expiresAt: new Date(NOW + 90 * 86400000).toISOString() }, 201);
    if (path === '/api/v1/tokens/' + ISSUED_ID) return response({}, 204);
    throw new Error('Unexpected request');
  });
  const service = new AntivirusOAuthService({ scanService: () => scan, prepareExtension, assertAuthorized, assertSecureStorage,
    openExternal, loopback, requestFetch: requestFetch as typeof fetch, now });
  return { service, scan, prepareExtension, assertAuthorized, assertSecureStorage, openExternal, loopback, requestFetch, urls, now };
}

afterEach(() => vi.restoreAllMocks());

describe('native scanner OAuth and private credential activation', () => {
  // Regression: email/AI OAuth tokens were reused for a separate scanner client or leaked through IPC.
  it('uses the dedicated scanner PKCE client, then creates and saves a credential only after actual privacy consent', async () => {
    const h = fixture();
    expect(await h.service.connect('account-a')).toEqual({ challenge: 'synthetic-challenge', setup: VERIFIED });
    expect(h.requestFetch.mock.calls.some(([url]) => String(url).endsWith('/api/v1/tokens'))).toBe(false);
    const authorization = new URL(h.urls[0]);
    expect(authorization.origin).toBe(CONFIG.issuerUrl);
    expect(authorization.searchParams.get('client_id')).toBe(CONFIG.clientId);
    expect(authorization.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:8080/auth/callback');
    expect(authorization.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorization.searchParams.get('scope')).toBe(CONFIG.scopes);
    expect(authorization.searchParams.get('nonce')).toBeTruthy();
    const exchange = h.requestFetch.mock.calls.find(([url]) => String(url).endsWith('/ui/oauth/token'))!;
    expect(JSON.parse(exchange[1]!.body as string)).toMatchObject({ grant_type: 'authorization_code', client_id: CONFIG.clientId, code: 'synthetic-code', code_verifier: expect.any(String) });
    expect((exchange[1]!.headers as Record<string, string>).Authorization).toBeUndefined();
    expect(h.scan.probe).toHaveBeenCalledWith(SARV_SCANNER_EXTENSION_ID, SARV_SCANNER_ORIGIN, 'synthetic-scanner-oauth-access');
    const result = await h.service.complete({ challenge: 'synthetic-challenge', accountId: 'account-a', attachmentConsent: true });
    expect(result).toMatchObject({ configured: true, enabled: true, allowedAccountIds: ['account-a'], allowBody: false });
    expect(JSON.stringify(result)).not.toContain(SECRET);
    const issue = h.requestFetch.mock.calls.find(([url]) => String(url).endsWith('/api/v1/tokens'))!;
    expect(JSON.parse(issue[1]!.body as string)).toEqual({ name: 'Sarv Inbox attachment scanning', expiresInDays: 90 });
    expect((issue[1]!.headers as Record<string, string>).Authorization).toBe('Bearer synthetic-scanner-oauth-access');
    expect(h.scan.probe).toHaveBeenLastCalledWith(SARV_SCANNER_EXTENSION_ID, SARV_SCANNER_ORIGIN, SECRET);
    expect(h.scan.configure).toHaveBeenCalledWith(SARV_SCANNER_EXTENSION_ID, { challenge: 'synthetic-challenge', allowedAccountIds: ['account-a'], allowBody: false, attachmentConsent: true, bodyConsent: false });
    await expect(h.service.complete({ challenge: 'synthetic-challenge', accountId: 'account-a', attachmentConsent: true })).rejects.toThrow(/Check scanner access/);
    for (const [url, init] of h.requestFetch.mock.calls) {
      expect(new URL(String(url)).origin).toBe(SARV_SCANNER_ORIGIN);
      expect(init?.redirect).toBe('error'); expect(init?.cache).toBe('no-store');
    }
  });

  // Regression: changing mailbox or bypassing the disclosure could authorize uploads for another account.
  it('rejects false consent, a stale challenge or a different account without issuing credentials', async () => {
    const h = fixture(); await h.service.connect('account-a');
    for (const input of [
      { challenge: 'synthetic-challenge', accountId: 'account-a', attachmentConsent: false },
      { challenge: 'wrong-challenge', accountId: 'account-a', attachmentConsent: true },
      { challenge: 'synthetic-challenge', accountId: 'account-b', attachmentConsent: true },
    ]) await expect(h.service.complete(input)).rejects.toThrow();
    expect(h.scan.configure).not.toHaveBeenCalled();
    expect(h.requestFetch.mock.calls.some(([url]) => String(url).includes('/api/v1/tokens'))).toBe(false);
    h.service.cancel();
    await expect(h.service.complete({ challenge: 'synthetic-challenge', accountId: 'account-a', attachmentConsent: true })).rejects.toThrow(/Check scanner access/);
  });

  // Regression: a stale disclosure review must not turn an expired pending OAuth session into permanent scanning access.
  it('expires pending approval and prevents concurrent or cancelled saving from duplicating credentials', async () => {
    const h = fixture(); await h.service.connect('account-a'); h.now.mockReturnValue(NOW + 300_000);
    await expect(h.service.complete({ challenge: 'synthetic-challenge', accountId: 'account-a', attachmentConsent: true })).rejects.toThrow(/Check scanner access/);
    h.now.mockReturnValue(NOW); await h.service.connect('account-a');
    let finish!: (response: Response) => void;
    h.requestFetch.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const saving = h.service.complete({ challenge: 'synthetic-challenge', accountId: 'account-a', attachmentConsent: true });
    await vi.waitFor(() => expect(finish).toBeDefined());
    await expect(h.service.connect('account-a')).rejects.toThrow(/Wait for scanner setup/);
    await expect(h.service.complete({ challenge: 'synthetic-challenge', accountId: 'account-a', attachmentConsent: true })).rejects.toThrow(/Check scanner access/);
    h.service.cancel();
    finish(response({ id: ISSUED_ID, token: SECRET, expiresAt: new Date(NOW + 86400000).toISOString() }, 201));
    expect(await saving).toMatchObject({ configured: true, enabled: true });
    expect(h.scan.configure).toHaveBeenCalledOnce();
  });

  // Regression: a server-selected issuer/client/endpoint could send scanner OAuth credentials to an unrelated service.
  it.each([
    { ...CONFIG, clientId: 'email-client' }, { ...CONFIG, authProvider: 'keycloak' },
    { ...CONFIG, serviceMode: 'admin' }, { ...CONFIG, tokenAudience: 'admin-audience' },
    { ...CONFIG, issuerUrl: 'https://attacker.test' }, { ...CONFIG, discoveryUrl: 'https://attacker.test/discovery' },
    { ...CONFIG, scopes: 'openid email profile admin' },
  ])('rejects mismatched public scanner configuration before opening a browser', async config => {
    const h = fixture(); h.requestFetch.mockResolvedValueOnce(response(config));
    await expect(h.service.connect('account-a')).rejects.toThrow(/not configured/);
    expect(h.loopback).not.toHaveBeenCalled(); expect(h.scan.probe).not.toHaveBeenCalled();
  });

  // Regression: untrusted discovery or malformed exchange responses must never appear connected.
  it.each([
    { ...DISCOVERY, issuer: 'https://evil.test' }, { ...DISCOVERY, authorization_endpoint: 'https://evil.test/auth' },
    { ...DISCOVERY, authorization_endpoint: 'https://oauth.sarv.com/auth?injected=true' },
    { ...DISCOVERY, token_endpoint: 'https://evil.test/token' },
  ])('rejects untrusted discovery endpoints', async discovery => {
    const h = fixture(); h.requestFetch.mockResolvedValueOnce(response(CONFIG)).mockResolvedValueOnce(response(discovery));
    await expect(h.service.connect('account-a')).rejects.toThrow(/not trusted/);
    expect(h.loopback).not.toHaveBeenCalled();
  });

  // Regression: malformed, empty or unsafe OAuth tokens must not reach scanner configuration.
  it.each([{ token_type: 'Bearer' }, { token_type: 'Basic', access_token: 'secret' }, { token_type: 'Bearer', access_token: 'has space' },
    { token_type: 'Bearer', access_token: 'a'.repeat(8193) }, { token_type: 'Bearer', access_token: 'bad\u0000token' }])('rejects unusable exchange credentials', async tokens => {
    const h = fixture(); h.requestFetch.mockResolvedValueOnce(response(CONFIG)).mockResolvedValueOnce(response(DISCOVERY)).mockResolvedValueOnce(response(tokens));
    await expect(h.service.connect('account-a')).rejects.toThrow(/no usable/);
    expect(h.scan.probe).not.toHaveBeenCalled();
  });

  // Regression: browser cancellation or an old callback could activate antivirus after the user chose Skip.
  it('cancels an in-flight browser sign-in and ignores a late callback without creating a token', async () => {
    const h = fixture(); let finish!: (value: { code: string; redirectUri: string }) => void;
    h.loopback.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const pending = h.service.connect('account-a');
    await vi.waitFor(() => expect(finish).toBeDefined());
    h.service.cancel(); finish({ code: 'late-code', redirectUri: 'http://127.0.0.1:8080/auth/callback' });
    await expect(pending).rejects.toThrow(/cancelled/);
    expect(h.requestFetch.mock.calls.some(([url]) => String(url).endsWith('/ui/oauth/token'))).toBe(false);
    expect(h.scan.configure).not.toHaveBeenCalled();
  });

  // Regression: starting over must replace the pending transaction and securely refuse a removed mailbox/keychain.
  it('checks mailbox, extension authorization and secure storage before any durable secret is issued', async () => {
    const h = fixture(); h.assertSecureStorage.mockImplementation(() => { throw new Error('Secure key store unavailable'); });
    await expect(h.service.connect('account-a')).rejects.toThrow(/Secure key store/);
    expect(h.prepareExtension).not.toHaveBeenCalled(); expect(h.requestFetch).not.toHaveBeenCalled();
    h.assertSecureStorage.mockReset(); await h.service.connect('account-a');
    h.assertAuthorized.mockImplementation(() => { throw new Error('Mailbox removed'); });
    await expect(h.service.complete({ challenge: 'synthetic-challenge', accountId: 'account-a', attachmentConsent: true })).rejects.toThrow(/Mailbox removed/);
    expect(h.scan.configure).not.toHaveBeenCalled();
  });

  // Regression: onboarding must not replace a scanner or silently discard consent for other accounts.
  it('preserves an existing configuration before connect and detects configuration changed before saving', async () => {
    const h = fixture(); h.scan.getTrustedSetup.mockResolvedValue({ ...EMPTY, configured: true });
    await expect(h.service.connect('account-a')).rejects.toThrow(/already configured/);
    expect(h.requestFetch).not.toHaveBeenCalled();
    h.scan.getTrustedSetup.mockResolvedValue(EMPTY); await h.service.connect('account-a');
    h.scan.getTrustedSetup.mockResolvedValue({ ...EMPTY, configured: true });
    await expect(h.service.complete({ challenge: 'synthetic-challenge', accountId: 'account-a', attachmentConsent: true })).rejects.toThrow(/setup changed/);
    expect(h.scan.configure).not.toHaveBeenCalled();
  });

  // Regression: policy changes or storage failures must not leave a newly created token in a failed app setup.
  it.each(['policy-change', 'vault-failure', 'removed-account', 'malformed-token'] as const)('revokes only the newly issued token when %s prevents activation', async reason => {
    const h = fixture(); await h.service.connect('account-a');
    if (reason === 'policy-change') h.scan.probe.mockResolvedValueOnce({ challenge: 'new-challenge', setup: { ...VERIFIED, privacyTermsVersion: 'changed' } });
    if (reason === 'vault-failure') h.scan.configure.mockRejectedValueOnce(new Error('Credential vault could not save'));
    if (reason === 'removed-account') h.scan.probe.mockImplementationOnce(async () => { h.assertAuthorized.mockImplementation(() => { throw new Error('Mailbox removed'); }); return { challenge: 'new-challenge', setup: VERIFIED }; });
    if (reason === 'malformed-token') h.requestFetch.mockResolvedValueOnce(response({ id: ISSUED_ID, token: 'bad-token', expiresAt: new Date(NOW + 1000).toISOString() }, 201));
    await expect(h.service.complete({ challenge: 'synthetic-challenge', accountId: 'account-a', attachmentConsent: true })).rejects.toThrow();
    expect(h.requestFetch).toHaveBeenCalledWith(SARV_SCANNER_ORIGIN + '/api/v1/tokens/' + ISSUED_ID, expect.objectContaining({ method: 'DELETE', headers: expect.objectContaining({ Authorization: 'Bearer synthetic-scanner-oauth-access' }) }));
    await expect(h.service.complete({ challenge: 'synthetic-challenge', accountId: 'account-a', attachmentConsent: true })).rejects.toThrow(/Check scanner access/);
  });

  // Regression: another setup can change during token issuance; it must remain intact and only the new token is revoked.
  it('preserves a scanner configured while OAuth activation was checking capabilities', async () => {
    const h = fixture(); await h.service.connect('account-a');
    h.scan.probe.mockImplementationOnce(async () => { h.scan.getTrustedSetup.mockResolvedValue({ ...EMPTY, configured: true }); return { challenge: 'new', setup: VERIFIED }; });
    await expect(h.service.complete({ challenge: 'synthetic-challenge', accountId: 'account-a', attachmentConsent: true })).rejects.toThrow(/setup changed/);
    expect(h.scan.configure).not.toHaveBeenCalled();
    expect(h.requestFetch).toHaveBeenLastCalledWith(SARV_SCANNER_ORIGIN + '/api/v1/tokens/' + ISSUED_ID, expect.objectContaining({ method: 'DELETE' }));
  });

  // Regression: failed credential cleanup must not pretend revocation succeeded or encourage issuing unlimited replacements.
  it('reports unconfirmed revocation and requires reviewing unused tokens before retry', async () => {
    const h = fixture(); await h.service.connect('account-a');
    h.scan.configure.mockRejectedValue(new Error('Vault failed'));
    h.requestFetch.mockResolvedValueOnce(response({ id: ISSUED_ID, token: SECRET, expiresAt: new Date(NOW + 86400000).toISOString() }, 201)).mockResolvedValueOnce(response({}, 503));
    await expect(h.service.complete({ challenge: 'synthetic-challenge', accountId: 'account-a', attachmentConsent: true })).rejects.toThrow(/revocation.*could not be confirmed/);
  });

  // Regression: deployment outages, rate limits, expired auth and oversize payloads must offer an honest retry error.
  it.each([401, 403, 409, 429, 500, 503])('surfaces scanner HTTP %s without reporting success', async status => {
    const h = fixture(); h.requestFetch.mockResolvedValueOnce(response({}, status));
    await expect(h.service.connect('account-a')).rejects.toThrow(/scanner|Scanner|Sarv/);
    expect(h.scan.configure).not.toHaveBeenCalled();
  });

  // Regression: returned bodies are attacker-controlled and must have byte/time bounds without leaking raw errors.
  it('rejects fetch failure, absent, truncated and oversized JSON bodies', async () => {
    for (const raw of [new Response(null), new Response('{unfinished'), new Response('x'.repeat(65537))]) {
      const h = fixture(); h.requestFetch.mockResolvedValueOnce(raw);
      await expect(h.service.connect('account-a')).rejects.toThrow(/sign-in response/);
    }
    const h = fixture(); h.requestFetch.mockRejectedValueOnce(new Error('Secret raw network content'));
    await expect(h.service.connect('account-a')).rejects.toThrow('Sarv Antivirus could not be reached');
  });
});

describe('exact scanner loopback callback', () => {
  // Regression: CSRF callbacks, wrong paths/methods or duplicated parameters could finish a different sign-in.
  it('keeps a wrong-state callback pending and consumes only the exact matching code once', async () => {
    const controller = new AbortController(); const statuses: number[] = [];
    const result = await runScannerLoopbackFlow(redirectUri => 'https://oauth.sarv.com/auth?redirect_uri=' + encodeURIComponent(redirectUri), 'synthetic-state', controller.signal, {
      port: 0, openExternal: async url => {
        const redirect = new URL(url).searchParams.get('redirect_uri')!;
        for (const [path, method] of [['/wrong', 'GET'], ['/auth/callback?state=wrong&code=bad', 'GET'], ['/auth/callback?state=synthetic-state&state=synthetic-state&code=bad', 'GET'], ['/auth/callback?state=synthetic-state&code=bad', 'POST']]) {
          statuses.push((await fetch(new URL(path, redirect), { method })).status);
        }
        const success = await fetch(redirect + '?state=synthetic-state&code=synthetic-code');
        expect(success.status).toBe(200); expect(await success.text()).not.toContain('synthetic-code');
      },
    });
    expect(statuses).toEqual([404, 400, 400, 404]);
    expect(result.code).toBe('synthetic-code');
    expect(result.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/);
  });

  // Regression: declined/incomplete callbacks and browser failures could leave a listener or endless spinner.
  it.each(['declined', 'missing-code', 'duplicate-code', 'open-failure', 'abort'] as const)('closes the listener for %s', async reason => {
    const controller = new AbortController(); let redirect = '';
    const pending = runScannerLoopbackFlow(value => { redirect = value; return value; }, 'synthetic-state', controller.signal, { port: 0, openExternal: async () => {
      if (reason === 'open-failure') throw new Error('Browser unavailable');
      if (reason === 'abort') { controller.abort(); return; }
      const query = reason === 'declined' ? 'error=access_denied' : reason === 'duplicate-code' ? 'code=a&code=b' : '';
      await fetch(redirect + '?state=synthetic-state&' + query);
    } });
    await expect(pending).rejects.toThrow(/cancelled|incomplete|could not open/);
    await expect(fetch(redirect)).rejects.toThrow();
  });

  // Regression: silently choosing another local callback would bypass the dedicated client's exact registration.
  it('reports a busy fixed callback port and never opens the sign-in browser', async () => {
    const server = http.createServer(); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port; const openExternal = vi.fn();
    try {
      await expect(runScannerLoopbackFlow(value => value, 'state', new AbortController().signal, { port, openExternal })).rejects.toThrow(/port 8080/);
      expect(openExternal).not.toHaveBeenCalled();
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });

  // Regression: a cancelled transaction must not reopen a browser or reserve a local port.
  it('rejects an already aborted transaction', async () => {
    const controller = new AbortController(); controller.abort(); const openExternal = vi.fn();
    await expect(runScannerLoopbackFlow(value => value, 'state', controller.signal, { port: 0, openExternal })).rejects.toThrow(/cancelled/);
    expect(openExternal).not.toHaveBeenCalled();
  });
});
