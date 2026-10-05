import http from 'node:http';

import { generatePkcePair, generateState, type AntivirusSetupStatus } from '@sarvinbox/core';

import type { AntivirusScanService } from './antivirus-scan-service';
import { hasControlCharacters, object } from './antivirus-transport';

export const SARV_SCANNER_ORIGIN = 'https://av.sarv.com';
export const SARV_SCANNER_EXTENSION_ID = 'clamav-scan';
const ISSUER = 'https://oauth.sarv.com';
const CLIENT_ID = 'client_uTgnwHY2tHHO6dhxyyqOeg';
const AUDIENCE = '4bfb47a3-e893-4e63-8057-7cc5db2fde7e';
const CALLBACK_PATH = '/auth/callback';
const TRANSACTION_MS = 300_000;
const cancelled = () => new Error('Antivirus sign-in was cancelled. You can retry or skip for now.');

interface LoopbackDependencies {
  openExternal(url: string): Promise<unknown>;
  /** Tests use an ephemeral port; production always uses the existing registered port. */
  port?: number;
}

/** The scanner client has an exact registered callback, unlike the email client's /cb listener. */
export function runScannerLoopbackFlow(
  authorization: (redirectUri: string) => string,
  state: string,
  signal: AbortSignal,
  dependencies: LoopbackDependencies,
): Promise<{ code: string; redirectUri: string }> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(cancelled()); return; }
    let settled = false;
    let redirectUri = '';
    const server = http.createServer((request, response) => {
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader('Referrer-Policy', 'no-referrer');
      response.setHeader('Content-Type', 'text/plain; charset=utf-8');
      response.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
      let callback: URL;
      try { callback = new URL(request.url || '/', redirectUri); }
      catch { response.writeHead(400).end('Invalid callback.'); return; }
      if (request.method !== 'GET' || callback.pathname !== CALLBACK_PATH) {
        response.writeHead(404).end('Not found.'); return;
      }
      if (callback.searchParams.getAll('state').length !== 1 || callback.searchParams.get('state') !== state) {
        response.writeHead(400).end('This sign-in request is not recognised. Return to Inbox.'); return;
      }
      if (callback.searchParams.has('error')) {
        response.writeHead(200).end('Antivirus sign-in was declined. Return to Inbox to retry or skip.');
        finish(cancelled()); return;
      }
      const code = callback.searchParams.get('code');
      if (callback.searchParams.getAll('code').length !== 1 || !code || code.length > 2048 || hasControlCharacters(code)) {
        response.writeHead(400).end('The sign-in callback was incomplete. Return to Inbox.');
        finish(new Error('Antivirus sign-in returned an incomplete callback. Please retry.')); return;
      }
      response.writeHead(200).end('Antivirus sign-in received. Return to Sarv Inbox to review scanner access.');
      finish(undefined, code);
    });
    const finish = (error?: Error, code?: string) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      server.close();
      if (error) { server.closeAllConnections(); reject(error); }
      else resolve({ code: code!, redirectUri });
    };
    const abort = () => finish(cancelled());
    signal.addEventListener('abort', abort, { once: true });
    server.once('error', error => finish(new Error((error as NodeJS.ErrnoException).code === 'EADDRINUSE'
      ? 'Antivirus sign-in needs local port 8080. Stop the service using that port, then retry, or skip for now.'
      : 'The secure antivirus callback could not start. Retry or skip for now.')));
    server.listen(dependencies.port ?? 8080, '127.0.0.1', () => {
      if (settled) { server.close(); return; }
      const address = server.address();
      if (!address || typeof address === 'string') { finish(new Error('The antivirus callback could not start.')); return; }
      redirectUri = `http://127.0.0.1:${address.port}${CALLBACK_PATH}`;
      try { void dependencies.openExternal(authorization(redirectUri)).catch(() => finish(new Error('The sign-in browser could not open. Retry or skip for now.'))); }
      catch { finish(new Error('The sign-in browser could not open. Retry or skip for now.')); }
    });
  });
}

interface ScannerOAuthDependencies {
  scanService(): Pick<AntivirusScanService, 'getTrustedSetup' | 'probe' | 'configure'>;
  prepareExtension(): Promise<void>;
  assertAuthorized(accountId: string): void;
  assertSecureStorage(): void;
  openExternal(url: string): Promise<unknown>;
  requestFetch?: typeof fetch;
  loopback?: typeof runScannerLoopbackFlow;
  now?: () => number;
}

type Probe = { challenge: string; setup: AntivirusSetupStatus };
interface Pending {
  challenge: string;
  accountId: string;
  accessToken: string;
  expires: number;
  setup: AntivirusSetupStatus;
}

const disclosure = (setup: AntivirusSetupStatus): string => JSON.stringify([
  setup.endpoint, setup.operator, setup.region, setup.privacyPolicyUrl, setup.privacyTermsVersion,
  setup.scanPolicyVersion, setup.metadataRetentionSeconds, setup.contentLifetimeSeconds, setup.resultLifetimeSeconds,
]);

/** Scanner-only PKCE credentials remain in main; durable API credentials use the existing encrypted scanner vault. */
export class AntivirusOAuthService {
  private active: AbortController | null = null;
  private pending: Pending | null = null;
  private completing = false;
  constructor(private dependencies: ScannerOAuthDependencies) {}
  private now(): number { return this.dependencies.now?.() ?? Date.now(); }

  cancel(): void {
    // Saving is an explicit atomic action. The renderer disables navigation until it returns.
    if (this.completing) return;
    this.active?.abort();
    this.active = null;
    this.pending = null;
  }

  private assertLive(controller: AbortController, accountId: string): void {
    if (this.active !== controller || controller.signal.aborted) throw cancelled();
    this.dependencies.assertAuthorized(accountId);
  }

  private async request(path: string, init: RequestInit = {}, credential?: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    if (!['/ui/config', '/ui/oauth/discovery', '/ui/oauth/token', '/api/v1/tokens'].includes(path) &&
      !/^\/api\/v1\/tokens\/[a-f0-9-]{36}$/.test(path)) throw new Error('The scanner sign-in request is invalid.');
    let response: Response;
    try {
      response = await (this.dependencies.requestFetch ?? fetch)(SARV_SCANNER_ORIGIN + path, {
        ...init, redirect: 'error', cache: 'no-store',
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
        headers: { Accept: 'application/json', ...(init.body ? { 'Content-Type': 'application/json' } : {}),
          ...(credential ? { Authorization: `Bearer ${credential}` } : {}) },
      });
    } catch { throw signal?.aborted ? cancelled() : new Error('Sarv Antivirus could not be reached. Retry or skip for now.'); }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new Error(response.status === 409 ? 'Your scanner account has reached its token limit. Revoke an unused token in av.sarv.com, then retry.'
        : response.status === 401 || response.status === 403 ? 'Scanner access was denied or expired. Sign in again or skip for now.'
          : response.status === 429 ? 'The scanner sign-in service is busy. Retry shortly or skip for now.'
            : 'Sarv Antivirus is unavailable or is not configured for this connection. Retry or skip for now.');
    }
    if (response.status === 204) return {};
    const reader = response.body?.getReader();
    if (!reader) throw new Error('The scanner returned no sign-in response. Retry or skip for now.');
    const chunks: Uint8Array[] = []; let bytes = 0;
    try {
      for (;;) {
        const part = await reader.read(); if (part.done) break;
        bytes += part.value.length;
        if (bytes > 65536) { await reader.cancel(); throw new Error(); }
        chunks.push(part.value);
      }
      return object(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    } catch { throw new Error('The scanner returned an incomplete sign-in response. Retry or skip for now.'); }
  }

  async connect(accountId: string): Promise<Probe> {
    if (this.completing) throw new Error('Wait for scanner setup to finish.');
    this.cancel();
    this.dependencies.assertSecureStorage();
    const controller = new AbortController();
    this.active = controller;
    const timeout = setTimeout(() => controller.abort(), TRANSACTION_MS);
    timeout.unref();
    try {
      await this.dependencies.prepareExtension();
      this.assertLive(controller, accountId);
      const previous = await this.dependencies.scanService().getTrustedSetup(SARV_SCANNER_EXTENSION_ID);
      if (previous.configured) throw new Error('A scanner is already configured. Keep its connection, or update its approved accounts in Extensions settings.');
      const config = await this.request('/ui/config', {}, undefined, controller.signal);
      if (config.authProvider !== 'sarv' || config.serviceMode !== 'scanner' || config.issuerUrl !== ISSUER ||
        config.clientId !== CLIENT_ID || config.tokenAudience !== AUDIENCE || config.discoveryUrl !== '/ui/oauth/discovery' ||
        config.scopes !== 'openid email profile') throw new Error('Sarv Antivirus OAuth is not configured for this app. Retry after the server is configured, or skip for now.');
      const scopes = config.scopes;
      const discovery = await this.request('/ui/oauth/discovery', {}, undefined, controller.signal);
      const authorization = new URL(typeof discovery.authorization_endpoint === 'string' ? discovery.authorization_endpoint : 'about:blank');
      if (discovery.issuer !== ISSUER || authorization.origin !== ISSUER || authorization.username || authorization.password ||
        authorization.search || authorization.hash || discovery.token_endpoint !== '/ui/oauth/token') {
        throw new Error('The scanner sign-in configuration is not trusted. Retry or skip for now.');
      }
      const state = generateState();
      const nonce = generateState();
      const pkce = generatePkcePair();
      const result = await (this.dependencies.loopback ?? runScannerLoopbackFlow)(redirectUri => {
        const url = new URL(authorization);
        for (const [key, value] of Object.entries({ client_id: CLIENT_ID, redirect_uri: redirectUri,
          response_type: 'code', response_mode: 'query', scope: scopes, state, nonce,
          code_challenge: pkce.challenge, code_challenge_method: pkce.method })) url.searchParams.set(key, value);
        return url.href;
      }, state, controller.signal, { openExternal: this.dependencies.openExternal });
      this.assertLive(controller, accountId);
      const tokens = await this.request('/ui/oauth/token', { method: 'POST', body: JSON.stringify({
        grant_type: 'authorization_code', client_id: CLIENT_ID, redirect_uri: result.redirectUri,
        code: result.code, code_verifier: pkce.verifier,
      }) }, undefined, controller.signal);
      if (typeof tokens.token_type !== 'string' || tokens.token_type.toLowerCase() !== 'bearer' || typeof tokens.access_token !== 'string' ||
        !tokens.access_token || tokens.access_token.length > 8192 || /\s/.test(tokens.access_token) || hasControlCharacters(tokens.access_token)) {
        throw new Error('The scanner returned no usable scanner access token. Retry or skip for now.');
      }
      // The scanner verifies this dedicated client's signed token, audience and access before returning capabilities.
      const probe = await this.dependencies.scanService().probe(SARV_SCANNER_EXTENSION_ID, SARV_SCANNER_ORIGIN, tokens.access_token);
      this.assertLive(controller, accountId);
      this.pending = { challenge: probe.challenge, accountId, accessToken: tokens.access_token,
        expires: this.now() + TRANSACTION_MS, setup: probe.setup };
      return probe;
    } catch (error) {
      if (this.active === controller) this.pending = null;
      throw error;
    } finally {
      clearTimeout(timeout);
      if (this.active === controller) this.active = null;
    }
  }

  async complete(input: { challenge: string; accountId: string; attachmentConsent: boolean }): Promise<AntivirusSetupStatus> {
    const pending = this.pending;
    if (this.completing || !pending || pending.challenge !== input.challenge || pending.accountId !== input.accountId || pending.expires <= this.now()) {
      throw new Error('Check scanner access again before enabling antivirus.');
    }
    if (input.attachmentConsent !== true) throw new Error('Review the scanner privacy terms and approve sharing attachments first.');
    this.dependencies.assertSecureStorage();
    this.dependencies.assertAuthorized(input.accountId);
    this.completing = true;
    let issuedId: string | undefined;
    try {
      if ((await this.dependencies.scanService().getTrustedSetup(SARV_SCANNER_EXTENSION_ID)).configured) {
        throw new Error('Scanner setup changed. Keep the existing connection or review it in Extensions settings.');
      }
      const issued = await this.request('/api/v1/tokens', { method: 'POST', body: JSON.stringify({ name: 'Sarv Inbox attachment scanning', expiresInDays: 90 }) }, pending.accessToken);
      if (typeof issued.id === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(issued.id)) issuedId = issued.id;
      if (!issuedId || typeof issued.token !== 'string' || !/^iv_[A-Za-z0-9_-]{43}$/.test(issued.token) ||
        typeof issued.expiresAt !== 'string' || !Number.isFinite(Date.parse(issued.expiresAt)) || Date.parse(issued.expiresAt) <= this.now()) {
        throw new Error('The scanner did not issue a valid scanning credential. Please retry sign-in.');
      }
      const fresh = await this.dependencies.scanService().probe(SARV_SCANNER_EXTENSION_ID, SARV_SCANNER_ORIGIN, issued.token);
      if (disclosure(fresh.setup) !== disclosure(pending.setup)) throw new Error('The scanner privacy or scan policy changed. Sign in and review its terms again.');
      this.dependencies.assertAuthorized(input.accountId);
      if ((await this.dependencies.scanService().getTrustedSetup(SARV_SCANNER_EXTENSION_ID)).configured) {
        throw new Error('Scanner setup changed. Keep the existing connection or review it in Extensions settings.');
      }
      const setup = await this.dependencies.scanService().configure(SARV_SCANNER_EXTENSION_ID, { challenge: fresh.challenge,
        allowedAccountIds: [input.accountId], allowBody: false, attachmentConsent: true, bodyConsent: false });
      issuedId = undefined; // The durable token is now owned by the encrypted scanner configuration.
      return setup;
    } catch (error) {
      if (issuedId) {
        try { await this.request(`/api/v1/tokens/${issuedId}`, { method: 'DELETE' }, pending.accessToken); }
        catch { throw new Error('Antivirus setup failed, and revocation of the new credential could not be confirmed. Review unused tokens at av.sarv.com before retrying.'); }
      }
      throw error;
    } finally {
      this.pending = null;
      this.completing = false;
    }
  }
}
