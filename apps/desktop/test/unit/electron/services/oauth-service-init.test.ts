import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  getOAuthProvider,
  isOAuthProviderConfigured,
  isSarvAIEndpointAllowed,
  SARV_PRODUCTION_CLIENT_ID,
  setOAuthClientId,
  setOAuthClientSecret,
  setSarvBaseUrl,
} from '@sarvinbox/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `initializeOAuth()` — the Sarv client_id it installs at startup.
 *
 * The production client_id lives in ONE place: the core provider definition
 * (`SARV_PRODUCTION_CLIENT_ID` in @sarvinbox/core). The desktop layer used to
 * carry its own copy; a rotation that touched one copy but not the other would
 * ship a build whose authorize request fails with invalid_client while both
 * files still looked right. These tests pin that the desktop reads the id back
 * from core instead of re-declaring it, and that the env override still wins.
 *
 * Only electron, the token store and the logger are mocked — the rest of
 * oauth-service is the real module (no network path is entered here).
 */

/** Every line the service logs, each with its extra arguments serialised. */
const h = vi.hoisted(() => ({ logged: [] as Array<{ level: string; line: string }> }));
vi.mock('@sarvinbox/core', async (importOriginal) => {
  const record = (level: string) => (...args: unknown[]) => {
    h.logged.push({ level, line: args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ') });
  };
  return {
    ...(await importOriginal<typeof import('@sarvinbox/core')>()),
    createLogger: () => ({ info: record('info'), warn: record('warn'), error: record('error'), debug: record('debug') }),
  };
});

vi.mock('electron', () => ({
  shell: { openExternal: async () => {} },
  app: { getPath: () => join(tmpdir(), 'sarvinbox-test'), getName: () => 'Sarv Inbox Test', isPackaged: false },
}));

vi.mock('../../../../electron/services/oauth-token-store', () => ({
  getAccount: async () => null,
  saveAccount: async () => {},
  removeAccount: async () => false,
  listAccounts: async () => [],
}));

import { initializeOAuth } from '../../../../electron/services/oauth-service';

// Every Sarv env knob initializeOAuth() reads — cleared per test so a developer's
// shell (dev OAuth server, rotated id) can't leak into the assertions.
const SARV_ENV_KEYS = [
  'SARVINBOX_SARV_CLIENT_ID',
  'SARVINBOX_SARV_CLIENT_SECRET',
  'SARVINBOX_SARV_OAUTH_BASE_URL',
  'SARVINBOX_SARV_API_BASE_URL',
  'SARVINBOX_SARV_EDGE_BASE_URL',
] as const;
type SarvEnvKey = (typeof SARV_ENV_KEYS)[number];

/** The core definition's own default — captured before any test touches the registry. */
const coreDefaultClientId = getOAuthProvider('sarv').clientId;
/** Likewise the built-in Sarv endpoints and secret a release build must keep. */
const coreDefaultSarv = { ...getOAuthProvider('sarv') };
const savedEnv: Partial<Record<SarvEnvKey, string | undefined>> = {};

beforeEach(() => {
  h.logged = [];
  for (const k of SARV_ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  // A dev build unless a test says otherwise — never whatever the shell has.
  vi.stubEnv('SARVINBOX_BUILD_MODE', 'development');
});

afterEach(() => {
  for (const k of SARV_ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  vi.unstubAllEnvs();
  // The registry is process-wide state shared by every test in this file.
  setOAuthClientId('sarv', SARV_PRODUCTION_CLIENT_ID);
  setOAuthClientSecret('sarv', coreDefaultSarv.clientSecret as string);
  setSarvBaseUrl({
    oauthBase: coreDefaultSarv.authEndpoint.replace(/\/api\/oauth\/authorize$/, ''),
    apiBase: coreDefaultSarv.apiBaseUrl,
    edgeBase: coreDefaultSarv.edgeBaseUrl,
  });
});

describe('initializeOAuth — Sarv client_id', () => {
  it('keeps the production client_id from the core provider definition when no env override is set', () => {
    // Regression: an empty or desktop-only default would leave a distributed
    // build unable to sign in against oauth.sarv.com ("not configured").
    initializeOAuth();

    const sarv = getOAuthProvider('sarv');
    expect(sarv.clientId).toBe(SARV_PRODUCTION_CLIENT_ID);
    expect(coreDefaultClientId).toBe(SARV_PRODUCTION_CLIENT_ID); // core's own default IS the constant
    expect(sarv.clientId).toMatch(/^client_/);
    expect(isOAuthProviderConfigured('sarv')).toBe(true);
  });

  it('lets SARVINBOX_SARV_CLIENT_ID override the production id (dev builds)', () => {
    // Regression: a dev build pointed at a localhost OAuth server would present
    // the production registration and be rejected with invalid_client.
    process.env.SARVINBOX_SARV_CLIENT_ID = 'client_dev_override';

    initializeOAuth();

    expect(getOAuthProvider('sarv').clientId).toBe('client_dev_override');
  });

  it('treats an EMPTY env override as unset and keeps the production id', () => {
    // `SARVINBOX_SARV_CLIENT_ID=` left in a shell profile must not blank the id
    // and break sign-in for the packaged app.
    process.env.SARVINBOX_SARV_CLIENT_ID = '';

    initializeOAuth();

    expect(getOAuthProvider('sarv').clientId).toBe(SARV_PRODUCTION_CLIENT_ID);
  });

  it('re-init without the env var restores the production id even after an override was applied', () => {
    // Regression: deriving the fallback from the CURRENT registry value (instead
    // of the constant) would make a re-init keep a stale override — the first
    // version of this de-duplication did exactly that. The fallback must be the
    // pristine constant, so the outcome depends only on the env at call time.
    process.env.SARVINBOX_SARV_CLIENT_ID = 'client_dev_override';
    initializeOAuth();
    initializeOAuth();
    expect(getOAuthProvider('sarv').clientId).toBe('client_dev_override');

    delete process.env.SARVINBOX_SARV_CLIENT_ID;
    initializeOAuth();
    expect(getOAuthProvider('sarv').clientId).toBe(SARV_PRODUCTION_CLIENT_ID);
  });

  it('carries no client_id literal of its own — the id has a single source in core', () => {
    // Regression: re-adding `const SARV_PRODUCTION_CLIENT_ID = 'client_…'` to the
    // desktop service recreates the two-copies drift this file exists to prevent.
    const src = readFileSync(new URL('../../../../electron/services/oauth-service.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/['"`]client_[A-Za-z0-9_-]{16,}['"`]/);
  });
});

describe('initializeOAuth — Microsoft client_id', () => {
  // Regression: without this the "Sign in with Outlook" option stays
  // "not configured" even though the release build carries the id.
  it('applies SARVINBOX_MICROSOFT_CLIENT_ID and leaves Microsoft unconfigured without it', () => {
    const prev = process.env.SARVINBOX_MICROSOFT_CLIENT_ID;
    try {
      delete process.env.SARVINBOX_MICROSOFT_CLIENT_ID;
      setOAuthClientId('microsoft', '');
      initializeOAuth();
      expect(isOAuthProviderConfigured('microsoft')).toBe(false);

      process.env.SARVINBOX_MICROSOFT_CLIENT_ID = 'ms-app-id';
      initializeOAuth();
      expect(getOAuthProvider('microsoft').clientId).toBe('ms-app-id');
    } finally {
      if (prev === undefined) delete process.env.SARVINBOX_MICROSOFT_CLIENT_ID;
      else process.env.SARVINBOX_MICROSOFT_CLIENT_ID = prev;
      setOAuthClientId('microsoft', '');
    }
  });
});

/** Values an attacker who controls the launch environment would pick. */
const HOSTILE: Record<SarvEnvKey, string> = {
  SARVINBOX_SARV_OAUTH_BASE_URL: 'https://login.evil.example',
  SARVINBOX_SARV_API_BASE_URL: 'https://api.evil.example',
  SARVINBOX_SARV_EDGE_BASE_URL: 'https://edge.evil.example',
  SARVINBOX_SARV_CLIENT_ID: 'client_attacker_registration',
  SARVINBOX_SARV_CLIENT_SECRET: 'attacker-secret-value',
};
const setHostileEnv = () => {
  for (const k of SARV_ENV_KEYS) process.env[k] = HOSTILE[k];
};

/** The parts of the Sarv provider an override could move. */
const sarvDestinations = () => {
  const p = getOAuthProvider('sarv');
  return {
    authEndpoint: p.authEndpoint,
    tokenEndpoint: p.tokenEndpoint,
    userInfoEndpoint: p.userInfoEndpoint,
    apiBaseUrl: p.apiBaseUrl,
    edgeBaseUrl: p.edgeBaseUrl,
    llmBaseUrl: p.llmBaseUrl,
    clientId: p.clientId,
    clientSecret: p.clientSecret,
  };
};

describe('initializeOAuth — Sarv environment overrides in a release build', () => {
  beforeEach(() => {
    vi.stubEnv('SARVINBOX_BUILD_MODE', 'production');
  });

  // Breaks: a shipped app takes its OAuth server, AI endpoints and client from
  // whoever launched it — a shell profile or launch agent could send the
  // consent page and the authorization code to their own server, and (because
  // the token-destination check trusts the configured bases) have main hand
  // them the user's Sarv bearer.
  it('ignores every Sarv override and keeps the built-in endpoints and client', () => {
    setHostileEnv();

    initializeOAuth();

    expect(sarvDestinations()).toEqual({
      authEndpoint: coreDefaultSarv.authEndpoint,
      tokenEndpoint: coreDefaultSarv.tokenEndpoint,
      userInfoEndpoint: coreDefaultSarv.userInfoEndpoint,
      apiBaseUrl: coreDefaultSarv.apiBaseUrl,
      edgeBaseUrl: coreDefaultSarv.edgeBaseUrl,
      llmBaseUrl: coreDefaultSarv.llmBaseUrl,
      clientId: SARV_PRODUCTION_CLIENT_ID,
      clientSecret: coreDefaultSarv.clientSecret,
    });
    expect(coreDefaultSarv.authEndpoint).toMatch(/^https:\/\/oauth\.sarv\.com\//);
    expect(isSarvAIEndpointAllowed(`${HOSTILE.SARVINBOX_SARV_EDGE_BASE_URL}/edge/v1/llm`)).toBe(false);
    expect(isSarvAIEndpointAllowed(HOSTILE.SARVINBOX_SARV_API_BASE_URL)).toBe(false);
  });

  // Breaks: an ignored override goes unnoticed (someone debugging "my staging
  // URL does nothing" has no clue why), is logged once per variable, or its
  // VALUE reaches app.log — a client secret written to a log file.
  it('names the ignored overrides in one warning, never their values', () => {
    setHostileEnv();

    initializeOAuth();

    const warnings = h.logged.filter((l) => l.level === 'warn');
    expect(warnings).toHaveLength(1);
    for (const name of SARV_ENV_KEYS) expect(warnings[0].line).toContain(name);
    for (const { line } of h.logged) {
      for (const value of Object.values(HOSTILE)) expect(line).not.toContain(value);
    }
  });

  // Breaks: a release build warns on every launch for a variable nobody set
  // (or one left empty in a profile, which a dev build treats as unset too).
  it('says nothing when no override is set, or only empty ones', () => {
    initializeOAuth();
    process.env.SARVINBOX_SARV_OAUTH_BASE_URL = '';
    initializeOAuth();

    expect(h.logged.filter((l) => l.level === 'warn')).toEqual([]);
    expect(getOAuthProvider('sarv').authEndpoint).toBe(coreDefaultSarv.authEndpoint);
  });
});

describe('initializeOAuth — Sarv environment overrides in a dev build', () => {
  // Breaks: the release-build gate catches dev builds too, and `scripts/dev.sh`
  // (which exports these to point at localhost) silently signs in against
  // production instead.
  it('applies every Sarv override, without the release-build warning', () => {
    setHostileEnv();

    initializeOAuth();

    const sarv = getOAuthProvider('sarv');
    expect(sarv.authEndpoint).toBe(`${HOSTILE.SARVINBOX_SARV_OAUTH_BASE_URL}/api/oauth/authorize`);
    expect(sarv.apiBaseUrl).toBe(HOSTILE.SARVINBOX_SARV_API_BASE_URL);
    expect(sarv.edgeBaseUrl).toBe(HOSTILE.SARVINBOX_SARV_EDGE_BASE_URL);
    expect(sarv.clientId).toBe(HOSTILE.SARVINBOX_SARV_CLIENT_ID);
    expect(sarv.clientSecret).toBe(HOSTILE.SARVINBOX_SARV_CLIENT_SECRET);
    expect(h.logged.filter((l) => l.level === 'warn')).toEqual([]);
  });
});
