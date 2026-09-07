import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  getOAuthProvider,
  isOAuthProviderConfigured,
  SARV_PRODUCTION_CLIENT_ID,
  setOAuthClientId,
} from '@sarvinbox/core';

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
 * Only electron and the token store are mocked — the rest of oauth-service is
 * the real module (no network path is entered here).
 */

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
const savedEnv: Partial<Record<SarvEnvKey, string | undefined>> = {};

beforeEach(() => {
  for (const k of SARV_ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of SARV_ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  // The registry is process-wide state shared by every test in this file.
  setOAuthClientId('sarv', SARV_PRODUCTION_CLIENT_ID);
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

  it('lets SARVINBOX_SARV_CLIENT_ID override the production id (dev / staging builds)', () => {
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
