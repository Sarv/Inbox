import { describe, it, expect, beforeEach, vi } from 'vitest';

import type { OAuthProviderId } from '../../../src/oauth/types';

// The provider registry is process-wide mutable state: initializeOAuth() writes
// client credentials and dev base URLs into it at startup, and every authorize /
// token / userinfo call reads it back. Two failure modes matter:
//  1. a caller mutating the object it got back and silently corrupting the
//     registry for every later sign-in;
//  2. setSarvBaseUrl() being called more than once (startup + settings change)
//     and losing URLs or the client credentials — which points the app at
//     production while the dev OAuth server holds the client registration.
// Each test re-imports the module so it starts from the pristine registry.

type ProvidersModule = typeof import('../../../src/oauth/providers');
let providers: ProvidersModule;

beforeEach(async () => {
  vi.resetModules();
  providers = await import('../../../src/oauth/providers');
});

describe('getOAuthProvider', () => {
  it('returns the requested provider with its endpoints and transport config', () => {
    const gmail = providers.getOAuthProvider('gmail');

    expect(gmail.id).toBe('gmail');
    expect(gmail.purpose).toBe('email');
    expect(gmail.tokenEndpoint).toBe('https://oauth2.googleapis.com/token');
    expect(gmail.tokenBodyFormat).toBe('form');
    expect(gmail.imap).toEqual({ host: 'imap.gmail.com', port: 993, secure: true });
    expect(gmail.scopes).toContain('https://mail.google.com/'); // required for IMAP XOAUTH2
  });

  // The production client_id must live in exactly ONE place. It used to be
  // duplicated in the desktop's oauth-service.ts; a rotation that updated one
  // copy but not the other would ship a build whose authorize request is
  // rejected with invalid_client while both files still looked right.
  it('ships Sarv configured out of the box with SARV_PRODUCTION_CLIENT_ID as the registry default', () => {
    expect(providers.SARV_PRODUCTION_CLIENT_ID).toMatch(/^client_[A-Za-z0-9_-]{16,}$/);
    expect(providers.getOAuthProvider('sarv').clientId).toBe(providers.SARV_PRODUCTION_CLIENT_ID);
    expect(providers.isOAuthProviderConfigured('sarv')).toBe(true);
  });

  // Sarv is the 'both' provider: the same session powers the LLM features and
  // the mailbox, and its token endpoint speaks JSON, not form encoding.
  it('returns Sarv as a JSON-body, purpose=both provider with api/edge/llm base URLs', () => {
    const sarv = providers.getOAuthProvider('sarv');

    expect(sarv.purpose).toBe('both');
    expect(sarv.tokenBodyFormat).toBe('json');
    expect(sarv.clientSecret).toBeUndefined(); // public client, PKCE only (RFC 8252)
    expect(sarv.authEndpoint).toBe('https://oauth.sarv.com/api/oauth/authorize');
    expect(sarv.apiBaseUrl).toBe('https://ai.sarv.com');
    expect(sarv.edgeBaseUrl).toBe('https://jpr1-ai-edge.sarv.com');
    expect(sarv.llmBaseUrl).toBe('https://jpr1-ai-edge.sarv.com/edge/v1/llm');
  });

  // MUTATION ISOLATION: callers pass provider configs around and some overwrite
  // fields locally (e.g. a per-account clientId). Handing out the live registry
  // object would leak that into every subsequent sign-in for all accounts.
  // NOTE: the copy is shallow — nested objects (scopes/imap/smtp) are shared;
  // only top-level reassignment is isolated today.
  it('returns a COPY: mutating the result cannot corrupt the registry', () => {
    const first = providers.getOAuthProvider('gmail');
    first.clientId = 'HIJACKED';
    first.clientSecret = 'HIJACKED';
    first.tokenEndpoint = 'https://evil.example/token';
    first.tokenBodyFormat = 'json';

    const second = providers.getOAuthProvider('gmail');
    expect(second.clientId).not.toBe('HIJACKED');
    expect(second.clientSecret).not.toBe('HIJACKED');
    expect(second.tokenEndpoint).toBe('https://oauth2.googleapis.com/token');
    expect(second.tokenBodyFormat).toBe('form');
    expect(second).not.toBe(first); // a fresh object each call
  });

  it('throws a named error for an unknown provider id', () => {
    expect(() => providers.getOAuthProvider('bogus' as OAuthProviderId)).toThrow(
      'Unknown OAuth provider: bogus',
    );
  });
});

describe('setOAuthClientId / setOAuthClientSecret', () => {
  // initializeOAuth() injects credentials from env at startup; if they didn't
  // stick in the registry the Gmail option stays greyed out as "not configured".
  it('persists the client id and secret into the registry', () => {
    providers.setOAuthClientId('gmail', 'id-from-env');
    providers.setOAuthClientSecret('gmail', 'secret-from-env');

    const gmail = providers.getOAuthProvider('gmail');
    expect(gmail.clientId).toBe('id-from-env');
    expect(gmail.clientSecret).toBe('secret-from-env');
  });

  // microsoft/yahoo are spread-derived from the Gmail template, so a shared
  // object would make configuring one configure all three.
  it('scopes credentials to ONE provider (microsoft/yahoo/gmail stay independent)', () => {
    providers.setOAuthClientId('microsoft', 'ms-id');

    expect(providers.getOAuthProvider('microsoft').clientId).toBe('ms-id');
    expect(providers.getOAuthProvider('gmail').clientId).toBe('');
    expect(providers.getOAuthProvider('yahoo').clientId).toBe('');
  });

  it('throws for an unknown provider id instead of silently creating an entry', () => {
    expect(() => providers.setOAuthClientId('nope' as OAuthProviderId, 'x')).toThrow(
      'Unknown OAuth provider: nope',
    );
    expect(() => providers.setOAuthClientSecret('nope' as OAuthProviderId, 'x')).toThrow(
      'Unknown OAuth provider: nope',
    );
  });
});

describe('isOAuthProviderConfigured', () => {
  // This gates whether the sign-in button is offered at all. A provider with no
  // clientId would send an authorize request that 400s in the browser.
  it('is false until a clientId is set, and true afterwards', () => {
    expect(providers.isOAuthProviderConfigured('gmail')).toBe(false);

    providers.setOAuthClientId('gmail', 'id');

    expect(providers.isOAuthProviderConfigured('gmail')).toBe(true);
  });

  it('is true for Sarv out of the box (client id is registered in source)', () => {
    expect(providers.isOAuthProviderConfigured('sarv')).toBe(true);
  });

  it('is false — not a throw — for an unknown id, and for a cleared clientId', () => {
    expect(providers.isOAuthProviderConfigured('bogus' as OAuthProviderId)).toBe(false);

    providers.setOAuthClientId('sarv', '');
    expect(providers.isOAuthProviderConfigured('sarv')).toBe(false);
  });
});

describe('listOAuthProviders', () => {
  it('lists every registered provider exactly once', () => {
    const ids = providers.listOAuthProviders().map((p) => p.id);

    expect(ids).toEqual(['gmail', 'microsoft', 'yahoo', 'sarv']);
  });

  // The account UIs iterate this list; if it handed out live objects, rendering
  // code that normalises a field would rewrite the registry.
  it('returns copies, so mutating a listed entry cannot corrupt the registry', () => {
    const listed = providers.listOAuthProviders();
    for (const p of listed) p.clientId = 'HIJACKED';

    expect(providers.listOAuthProviders().every((p) => p.clientId !== 'HIJACKED')).toBe(true);
    expect(providers.getOAuthProvider('sarv').clientId).not.toBe('HIJACKED');
  });

  it('reflects credentials set through the setters', () => {
    providers.setOAuthClientId('yahoo', 'yahoo-id');

    expect(providers.listOAuthProviders().find((p) => p.id === 'yahoo')?.clientId).toBe('yahoo-id');
  });
});

describe('setSarvBaseUrl', () => {
  const DEV_OAUTH = 'http://localhost:8880';

  it('rewrites all three Sarv surfaces (oauth endpoints, api, edge + llm)', () => {
    providers.setSarvBaseUrl({
      oauthBase: DEV_OAUTH,
      apiBase: 'http://localhost:8881',
      edgeBase: 'http://localhost:8882',
    });

    const sarv = providers.getOAuthProvider('sarv');
    expect(sarv.authEndpoint).toBe(`${DEV_OAUTH}/api/oauth/authorize`);
    expect(sarv.tokenEndpoint).toBe(`${DEV_OAUTH}/api/oauth/token`);
    expect(sarv.userInfoEndpoint).toBe(`${DEV_OAUTH}/api/oauth/userinfo`);
    expect(sarv.apiBaseUrl).toBe('http://localhost:8881');
    expect(sarv.edgeBaseUrl).toBe('http://localhost:8882');
    expect(sarv.llmBaseUrl).toBe('http://localhost:8882/edge/v1/llm');
  });

  // Called once at startup and again whenever the dev-server setting changes.
  // Rebuilding from the production defaults on the second call would silently
  // point token refreshes at prod while the client id only exists in dev.
  it('is IDEMPOTENT: calling it twice with the same URLs changes nothing', () => {
    const urls = { oauthBase: DEV_OAUTH, apiBase: 'http://localhost:8881', edgeBase: 'http://localhost:8882' };
    providers.setSarvBaseUrl(urls);
    const afterFirst = providers.getOAuthProvider('sarv');

    providers.setSarvBaseUrl(urls);

    expect(providers.getOAuthProvider('sarv')).toEqual(afterFirst);
  });

  // The real-world sequence: full set at startup, then a partial update. Every
  // URL the second call omits must survive, not snap back to production.
  it('a PARTIAL second call keeps the previously-set URLs it does not mention', () => {
    providers.setSarvBaseUrl({
      oauthBase: DEV_OAUTH,
      apiBase: 'http://localhost:8881',
      edgeBase: 'http://localhost:8882',
    });

    providers.setSarvBaseUrl({ apiBase: 'http://localhost:9999' });

    const sarv = providers.getOAuthProvider('sarv');
    expect(sarv.apiBaseUrl).toBe('http://localhost:9999'); // updated
    expect(sarv.authEndpoint).toBe(`${DEV_OAUTH}/api/oauth/authorize`); // oauthBase recovered
    expect(sarv.tokenEndpoint).toBe(`${DEV_OAUTH}/api/oauth/token`);
    expect(sarv.edgeBaseUrl).toBe('http://localhost:8882'); // untouched
    expect(sarv.llmBaseUrl).toBe('http://localhost:8882/edge/v1/llm');
  });

  it('setting ONLY the oauthBase leaves api/edge URLs alone', () => {
    providers.setSarvBaseUrl({ apiBase: 'http://localhost:8881', edgeBase: 'http://localhost:8882' });

    providers.setSarvBaseUrl({ oauthBase: DEV_OAUTH });

    const sarv = providers.getOAuthProvider('sarv');
    expect(sarv.tokenEndpoint).toBe(`${DEV_OAUTH}/api/oauth/token`);
    expect(sarv.apiBaseUrl).toBe('http://localhost:8881');
    expect(sarv.edgeBaseUrl).toBe('http://localhost:8882');
  });

  it('an empty call is a no-op that preserves the production defaults', () => {
    const before = providers.getOAuthProvider('sarv');

    providers.setSarvBaseUrl({});

    expect(providers.getOAuthProvider('sarv')).toEqual(before);
  });

  // Credentials are injected from env BEFORE the dev URL swap; rebuilding the
  // provider must carry them over or every Sarv sign-in fails with
  // invalid_client after the first setSarvBaseUrl call.
  it('preserves clientId/clientSecret set via the setters across a rebuild', () => {
    providers.setOAuthClientId('sarv', 'client_rotated');
    providers.setOAuthClientSecret('sarv', 'sarv-secret');

    providers.setSarvBaseUrl({ oauthBase: DEV_OAUTH });
    providers.setSarvBaseUrl({ apiBase: 'http://localhost:8881' });

    const sarv = providers.getOAuthProvider('sarv');
    expect(sarv.clientId).toBe('client_rotated');
    expect(sarv.clientSecret).toBe('sarv-secret');
    expect(sarv.tokenEndpoint).toBe(`${DEV_OAUTH}/api/oauth/token`);
  });

  it('keeps the rebuilt Sarv entry listed and configured', () => {
    providers.setSarvBaseUrl({ oauthBase: DEV_OAUTH });

    expect(providers.listOAuthProviders().map((p) => p.id)).toEqual(['gmail', 'microsoft', 'yahoo', 'sarv']);
    expect(providers.isOAuthProviderConfigured('sarv')).toBe(true);
  });

  it('does not touch the other providers', () => {
    const gmailBefore = providers.getOAuthProvider('gmail');

    providers.setSarvBaseUrl({ oauthBase: DEV_OAUTH, apiBase: 'http://x', edgeBase: 'http://y' });

    expect(providers.getOAuthProvider('gmail')).toEqual(gmailBefore);
  });

  // The oauthBase is recovered by stripping the /api/oauth/authorize suffix, so
  // a base URL that itself contains a path (a reverse-proxied mount) must round
  // trip rather than collapse to the host.
  it('recovers a path-mounted oauthBase intact on a later partial call', () => {
    providers.setSarvBaseUrl({ oauthBase: 'https://gw.example.com/sarv-oauth' });

    providers.setSarvBaseUrl({ edgeBase: 'http://localhost:8882' });

    expect(providers.getOAuthProvider('sarv').authEndpoint).toBe(
      'https://gw.example.com/sarv-oauth/api/oauth/authorize',
    );
  });
});
