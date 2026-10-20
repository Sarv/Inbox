import type { BimiLookup, FaviconResult, FetchLike } from '@sarvinbox/core';
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The sender-identity IPC (CASA audit L-6), run through the REAL service and
 * its real wiring. Only the two library lookups, the network and the stores
 * are fake.
 *
 * What this protects: `identity:refresh` takes a domain straight from the
 * renderer. It used to force both lookups whatever the settings said, for
 * whatever string arrived, IP literals included. A renderer that is
 * compromised, or just wrong, could then make the main process fetch
 * https://10.0.0.5/ and its favicon, even with favicons switched off. The
 * wiring tests pin which network door each lookup goes through: the guarded
 * public-https-only fetch, never Chromium's unguarded one.
 */

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...a: unknown[]) => unknown>(),
  blobs: new Map<string, Buffer>(),
  store: null as unknown,
  lookupBimi: null as unknown as (domain: string, options: { fetch: FetchLike }) => Promise<BimiLookup>,
  discoverFavicon: null as unknown as (domain: string, options: { fetch: FetchLike }) => Promise<FaviconResult>,
  /** Options of every guarded fetch built, keyed by the fetch it returned. */
  fetchOptions: new Map<unknown, { timeoutMs: number; site?: string }>(),
  chromiumFetch: null as unknown as () => never,
}));

vi.mock('electron', () => ({
  ipcMain: { handle: (name: string, fn: (...a: unknown[]) => unknown) => h.handlers.set(name, fn) },
}));
vi.mock('../../../../electron/shared', () => ({
  getAllAccountRuntimes: () => [],
  getMainWindow: () => null,
  getStorage: () => null,
}));
vi.mock('../../../../electron/services/core-db', () => ({
  getCoreDb: () => { throw new Error('the core DB is not opened in tests'); },
  getBlob: (k: string) => h.blobs.get(k) ?? null,
  setBlob: (k: string, v: Buffer) => { h.blobs.set(k, v); },
}));
vi.mock('../../../../electron/services/domain-identity-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../electron/services/domain-identity-store')>()),
  getDomainIdentityStore: () => h.store,
}));
vi.mock('@sarvinbox/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@sarvinbox/core')>()),
  lookupBimi: (domain: string, options: { fetch: FetchLike }) => h.lookupBimi(domain, options),
  discoverFavicon: (domain: string, options: { fetch: FetchLike }) => h.discoverFavicon(domain, options),
}));
vi.mock('../../../../electron/services/sender-identity-fetch', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../../electron/services/sender-identity-fetch')>();
  return {
    ...real,
    senderIdentityFetch: (options: { timeoutMs: number; site?: string }) => {
      const fetch = real.senderIdentityFetch(options);
      h.fetchOptions.set(fetch, { timeoutMs: options.timeoutMs, site: options.site });
      return fetch;
    },
  };
});
vi.mock('../../../../electron/services/net-fetch', () => ({ chromiumFetch: () => h.chromiumFetch() }));

import { registerIdentityHandlers } from '../../../../electron/ipc/identity-handlers';
import { DomainIdentityStore } from '../../../../electron/services/domain-identity-store';
import { FETCH_TIMEOUT_MS, resetSenderIdentityPolicyCache } from '../../../../electron/services/sender-identity-service';

type Reply = { success: boolean; data?: unknown; error?: string };
const call = (channel: string, ...args: unknown[]) => h.handlers.get(channel)!({}, ...args) as Promise<Reply>;
const store = () => h.store as DomainIdentityStore;

const bimiNone: BimiLookup = {
  status: 'none', logo: null, organization: null, issuer: null, certificateExpires: null, dmarcPolicy: null, recordDomain: null, detail: 'no record',
};
const favicon: FaviconResult = { status: 'found', dataUri: 'data:image/png;base64,AAAA', source: 'root', detail: 'x' };

let bimiCalls: Array<{ domain: string; fetch: FetchLike }> = [];
let faviconCalls: Array<{ domain: string; fetch: FetchLike }> = [];

beforeEach(() => {
  h.handlers.clear();
  h.blobs.clear();
  // h.fetchOptions is never cleared: the BIMI fetch is built once, when the
  // service module loads.
  resetSenderIdentityPolicyCache();
  // One store for the whole file: the service singleton keeps the first one
  // it is given. It is emptied before each test instead.
  if (!h.store) h.store = new DomainIdentityStore(new Database(':memory:'));
  for (const row of store().list(1000)) store().forget(row.domain);
  bimiCalls = [];
  faviconCalls = [];
  h.lookupBimi = vi.fn(async (domain, options) => { bimiCalls.push({ domain, fetch: options.fetch }); return bimiNone; });
  h.discoverFavicon = vi.fn(async (domain, options) => { faviconCalls.push({ domain, fetch: options.fetch }); return favicon; });
  h.chromiumFetch = () => { throw new Error('the sender-identity lookups must not use Chromium’s unguarded fetch'); };
  registerIdentityHandlers();
});

describe('identity:refresh', () => {
  // Breaks if "Refresh" on the Security page stops re-running the lookups,
  // or stops returning the row it just wrote.
  it('re-runs both lookups for a valid domain and returns the fresh row', async () => {
    const reply = await call('identity:refresh', 'brand.example');
    expect(reply.success).toBe(true);
    expect(reply.data).toMatchObject({ domain: 'brand.example', bimiStatus: 'none', faviconStatus: 'found', favicon: favicon.dataUri });
    expect(bimiCalls.map((c) => c.domain)).toEqual(['brand.example']);
    expect(faviconCalls.map((c) => c.domain)).toEqual(['brand.example']);
  });

  // Breaks if either lookup goes back to Chromium's unguarded fetch, or if a
  // favicon fetch is bound to the sender's own site again (adversarial
  // review): a mail domain that redirects to its brand (facebookmail.com →
  // facebook.com, icon on a CDN) would lose its icon for a month, for no
  // gain — every hop is already held to public https.
  it('gives both lookups the same guarded fetch, bound to no site', async () => {
    await call('identity:refresh', 'mail.brand.example');
    expect(h.fetchOptions.get(faviconCalls[0].fetch)).toEqual({ timeoutMs: FETCH_TIMEOUT_MS });
    expect(bimiCalls[0].fetch).toBe(faviconCalls[0].fetch);
  });

  // Breaks if the fetch handed to the lookups can still reach a private
  // address. This checks the real transport behind the wiring, not a stub.
  it('hands the lookups a fetch that refuses private addresses', async () => {
    await call('identity:refresh', 'brand.example');
    const refusedFavicon = await faviconCalls[0].fetch('https://127.0.0.1/favicon.ico');
    const refusedBimi = await bimiCalls[0].fetch('https://192.168.1.1/logo.svg');
    expect(refusedFavicon).toMatchObject({ ok: false, status: 0 });
    expect(refusedBimi).toMatchObject({ ok: false, status: 0 });
    // Off-site hosts are allowed now, but only over https.
    expect(await faviconCalls[0].fetch('http://cdn.example/icon.png')).toMatchObject({ ok: false, status: 0 });
  });

  // Breaks if a forced refresh fetches a favicon the reader switched off.
  it('honours "favicons off": BIMI only', async () => {
    await call('identity:setPolicy', { logos: true, favicons: false, gravatar: false });
    expect((await call('identity:refresh', 'brand.example')).success).toBe(true);
    expect(bimiCalls).toHaveLength(1);
    expect(faviconCalls).toHaveLength(0);
  });

  // Breaks if a forced refresh fetches a BIMI logo the reader switched off.
  it('honours "logos off": favicon only', async () => {
    await call('identity:setPolicy', { logos: false, favicons: true, gravatar: false });
    await call('identity:refresh', 'brand.example');
    expect(bimiCalls).toHaveLength(0);
    expect(faviconCalls).toHaveLength(1);
  });

  // Breaks if a refresh with both lookups off touches the network at all.
  // It still answers with whatever is cached.
  it('looks nothing up with both off, and answers with the cached row', async () => {
    await call('identity:setPolicy', { logos: false, favicons: false, gravatar: false });
    store().upsertFavicon('brand.example', favicon, 1_760_000_000);
    const reply = await call('identity:refresh', 'brand.example');
    expect(reply).toMatchObject({ success: true, data: { domain: 'brand.example', faviconStatus: 'found' } });
    expect(bimiCalls).toHaveLength(0);
    expect(faviconCalls).toHaveLength(0);
  });

  // Breaks if the renderer can name an IP literal, a host with a port, a
  // single label or a non-string, and get it looked up.
  it.each([['10.0.0.5'], ['127.0.0.1'], ['[::1]'], ['::ffff:127.0.0.1'], ['brand.example:8080'], ['brand.example/x'], ['localhost'], [''], [42], [null], [{ domain: 'brand.example' }]])(
    'refuses %j without looking anything up',
    async (raw) => {
      const reply = await call('identity:refresh', raw);
      expect(reply).toEqual({ success: false, error: 'Not a domain that can be looked up' });
      expect(bimiCalls).toHaveLength(0);
      expect(faviconCalls).toHaveLength(0);
    },
  );

  // Breaks if the domain is looked up as typed instead of as the cache keys
  // it. The row returned would then be a different one from the row written.
  it('normalises the domain before looking it up', async () => {
    const reply = await call('identity:refresh', '  Brand.Example. ');
    expect(bimiCalls.map((c) => c.domain)).toEqual(['brand.example']);
    expect(reply.data).toMatchObject({ domain: 'brand.example' });
  });

  // Breaks if a failure inside the handler escapes as a rejected IPC call
  // instead of a { success: false } reply the page can show.
  it('answers a failure as an error reply', async () => {
    vi.spyOn(store(), 'get').mockImplementationOnce(() => { throw new Error('core DB closed'); });
    expect(await call('identity:refresh', 'brand.example')).toEqual({ success: false, error: 'core DB closed' });
  });
});

describe('identity:getSender', () => {
  // Breaks if a message "from" an IP-literal domain starts a lookup when it
  // is displayed. It must show no picture and fetch nothing.
  it('starts no lookup for an address at an IP literal', async () => {
    const reply = await call('identity:getSender', 'x@[10.0.0.5]');
    expect(reply).toMatchObject({ success: true, data: { domain: null, pending: false } });
    await new Promise((r) => setTimeout(r, 0));
    expect(bimiCalls).toHaveLength(0);
    expect(faviconCalls).toHaveLength(0);
  });

  // Breaks if an ordinary sender stops getting a background lookup.
  it('queues the lookups for an ordinary sender', async () => {
    const reply = await call('identity:getSender', 'news@brand.example');
    expect(reply).toMatchObject({ success: true, data: { domain: 'brand.example', pending: true } });
    await vi.waitFor(() => expect(faviconCalls).toHaveLength(1));
  });
});
