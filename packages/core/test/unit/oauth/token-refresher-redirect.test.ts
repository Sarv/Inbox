import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { isTerminalOAuthError } from '../../../src/oauth/oauth-errors';
import { exchangeCodeForTokens, refreshAccessToken } from '../../../src/oauth/token-refresher';
import { OAuthError, type OAuthProviderConfig } from '../../../src/oauth/types';

// The real fetch against two loopback servers (no outside network): the token
// endpoint answers 307 / 308 pointing at a second server. Breaks if the
// request is followed — fetch re-POSTs the same body on a 307/308, so the
// refresh token (or the authorization code and its PKCE verifier) would reach
// whatever host the Location names.

interface Received { method?: string; body: string }

function listen(handler: (req: IncomingMessage, body: string) => { status: number; headers?: Record<string, string>; body?: string }): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        const answer = handler(req, body);
        res.writeHead(answer.status, answer.headers);
        res.end(answer.body ?? '');
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

let servers: Server[] = [];
let elsewhere: Received[];
let elsewhereUrl: string;

beforeEach(async () => {
  elsewhere = [];
  const target = await listen((req, body) => {
    elsewhere.push({ method: req.method, body });
    return { status: 200, headers: { 'content-type': 'application/json' }, body: '{"access_token":"stolen","expires_in":60}' };
  });
  servers.push(target.server);
  elsewhereUrl = target.url;
  // The module logs the refusal; keep the test output quiet.
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(async () => {
  await Promise.all(servers.map((s) => new Promise((resolve) => s.close(resolve))));
  servers = [];
  vi.restoreAllMocks();
});

async function redirectingProvider(status: 307 | 308): Promise<OAuthProviderConfig> {
  const endpoint = await listen(() => ({ status, headers: { location: `${elsewhereUrl}/token` } }));
  servers.push(endpoint.server);
  return {
    id: 'gmail',
    label: 'Gmail',
    purpose: 'email',
    clientId: 'client-abc',
    clientSecret: 'secret-xyz',
    authEndpoint: `${endpoint.url}/auth`,
    tokenEndpoint: `${endpoint.url}/token`,
    userInfoEndpoint: `${endpoint.url}/userinfo`,
    scopes: ['https://mail.google.com/'],
    tokenBodyFormat: 'form',
  };
}

describe('token requests never follow a redirect', () => {
  it.each([307, 308] as const)('a refresh answered %i sends the refresh token nowhere else', async (status) => {
    const provider = await redirectingProvider(status);

    const err = await refreshAccessToken({ provider, refreshToken: 'RT-SENTINEL' }).catch((e) => e);

    expect(elsewhere).toEqual([]);
    expect(err).toBeInstanceOf(OAuthError);
    expect(err.code).toBe('TOKEN_REFRESH_NETWORK_ERROR');
    expect(err.message).not.toContain('RT-SENTINEL');
    // Transient, not "signed out": a misrouted endpoint says nothing about the token.
    expect(isTerminalOAuthError(err)).toBe(false);
  });

  it('a code exchange answered 307 sends the code and verifier nowhere else', async () => {
    const provider = await redirectingProvider(307);

    const err = await exchangeCodeForTokens({
      provider,
      code: 'CODE-SENTINEL',
      codeVerifier: 'VERIFIER-SENTINEL',
      redirectUri: 'http://127.0.0.1:41234/callback',
    }).catch((e) => e);

    expect(elsewhere).toEqual([]);
    expect(err).toBeInstanceOf(OAuthError);
    expect(err.code).toBe('TOKEN_EXCHANGE_NETWORK_ERROR');
  });
});
