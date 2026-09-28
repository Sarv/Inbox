import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { setOAuthClientId, setOAuthClientSecret } from '@sarvinbox/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// signOut deletes tokens on this device and revokes the grant at the provider.
// Breaks if: a provider outage leaves the refresh token on disk (local delete
// must not wait on the network), or Google revocation silently stops, so
// removed accounts keep live access to the mailbox.

const h = vi.hoisted(() => ({
  stored: new Map<string, { refreshToken: string }>(),
  removed: [] as string[],
}));

vi.mock('electron', () => ({
  shell: { openExternal: async () => {} },
  app: { getPath: () => join(tmpdir(), 'sarvinbox-test'), getName: () => 'Sarv Inbox Test', isPackaged: false },
}));
vi.mock('../../../../electron/services/oauth-token-store', () => ({
  getAccount: async (p: string, e: string) => h.stored.get(`${p}:${e}`) ?? null,
  removeAccount: async (p: string, e: string) => { h.removed.push(`${p}:${e}`); return h.stored.delete(`${p}:${e}`); },
  saveAccount: async () => {},
  listAccounts: async () => [],
}));

import { signOut } from '../../../../electron/services/oauth-service';

const realFetch = globalThis.fetch;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  h.stored.clear();
  h.removed.length = 0;
  fetchMock = vi.fn();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  setOAuthClientId('gmail', 'gid');
  setOAuthClientSecret('gmail', 'gsecret');
});
afterEach(() => {
  globalThis.fetch = realFetch;
  setOAuthClientId('gmail', '');
  setOAuthClientSecret('gmail', '');
});

describe('signOut', () => {
  // Happy path (Google): tokens gone locally, then the grant is revoked.
  it('deletes the tokens locally and revokes the Google grant with the refresh token', async () => {
    h.stored.set('gmail:me@gmail.com', { refreshToken: 'rt-g' });
    fetchMock.mockResolvedValueOnce(new Response('', { status: 200 }));

    const { revocation } = await signOut('gmail', 'me@gmail.com');

    expect(h.removed).toEqual(['gmail:me@gmail.com']); // done before revocation settles
    await expect(revocation).resolves.toBe('revoked');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://oauth2.googleapis.com/revoke');
    expect(new URLSearchParams(String(init.body)).get('token')).toBe('rt-g');
  });

  // Transient failure: the local delete still happened; outcome says so.
  it('keeps the local delete when revocation fails on the network', async () => {
    h.stored.set('gmail:me@gmail.com', { refreshToken: 'rt-g' });
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));

    const { revocation } = await signOut('gmail', 'me@gmail.com');

    await expect(revocation).resolves.toBe('failed');
    expect(h.stored.has('gmail:me@gmail.com')).toBe(false);
  });

  // Microsoft has no revocation endpoint: local delete only, no request.
  it('does not call the network for a provider without a revocation endpoint', async () => {
    h.stored.set('microsoft:me@outlook.com', { refreshToken: 'rt-m' });
    const { revocation } = await signOut('microsoft', 'me@outlook.com');
    await expect(revocation).resolves.toBe('unsupported');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // Idempotent re-run: signing out twice revokes once and doesn't throw.
  it('answers no-account when there is nothing stored', async () => {
    const { revocation } = await signOut('gmail', 'nobody@gmail.com');
    await expect(revocation).resolves.toBe('no-account');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
