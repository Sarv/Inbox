import type { BimiLookup, FaviconResult } from '@sarvinbox/core';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  blobs: new Map<string, Buffer>(),
  runtimes: [] as Array<[string, { storage: unknown; syncEngine: null; smtpClient: null }]>,
  sent: [] as Array<{ channel: string; payload: unknown }>,
}));

vi.mock('../../../../electron/shared', () => ({
  getAllAccountRuntimes: () => h.runtimes,
  getMainWindow: () => ({ isDestroyed: () => false, webContents: { send: (channel: string, payload: unknown) => h.sent.push({ channel, payload }) } }),
  getStorage: () => null,
}));
vi.mock('../../../../electron/services/core-db', () => ({
  getCoreDb: () => { throw new Error('the core DB is not opened in tests'); },
  getBlob: (k: string) => h.blobs.get(k) ?? null,
  setBlob: (k: string, v: Buffer) => { h.blobs.set(k, v); },
}));
vi.mock('../../../../electron/services/net-fetch', () => ({ chromiumFetch: vi.fn() }));

import { DomainIdentityStore } from '../../../../electron/services/domain-identity-store';
import {
  SenderIdentityService,
  getSenderIdentityPolicy,
  identityFromRow,
  normalizeSenderIdentityPolicy,
  resetSenderIdentityPolicyCache,
  senderDomain,
  senderIdentityTick,
  setSenderIdentityPolicy,
  type SenderIdentityPolicy,
} from '../../../../electron/services/sender-identity-service';

/**
 * The sender-identity resolver: what the renderer is told about a sender, and
 * when the network is touched.
 *
 * What this protects: an avatar that reaches for the network per message is a
 * tracking pixel we built ourselves; a lookup that never records its failure
 * loops hot on every render; a policy switch that keeps showing cached logos
 * is a privacy setting that lies. Each is pinned here with a fake store,
 * fake lookups and a fake clock.
 */
const T0 = 1_760_000_000;
const none = (detail = 'no record'): BimiLookup => ({
  status: 'none', logo: null, organization: null, issuer: null, certificateExpires: null, dmarcPolicy: null, recordDomain: null, detail,
});
const verified = (): BimiLookup => ({
  status: 'verified', logo: 'data:image/svg+xml;base64,AAAA', organization: 'Example Inc', issuer: 'Test Root',
  certificateExpires: T0 + 86_400, dmarcPolicy: 'reject', recordDomain: 'brand.example', detail: 'ok',
});
const found = (): FaviconResult => ({ status: 'found', dataUri: 'data:image/png;base64,BBBB', source: 'root', detail: 'x' });

function harness(over: Partial<{ policy: SenderIdentityPolicy; maxConcurrent: number }> = {}) {
  let clock = T0;
  const store = new DomainIdentityStore(new Database(':memory:'));
  const lookupBimi = vi.fn(async (_d: string) => none());
  const discoverFavicon = vi.fn(async (_d: string) => found());
  const onUpdated = vi.fn();
  const policy = over.policy ?? { logos: true, favicons: true };
  const svc = new SenderIdentityService({
    store, lookupBimi, discoverFavicon, policy: () => policy, now: () => clock, onUpdated, maxConcurrent: over.maxConcurrent,
  });
  return { svc, store, lookupBimi, discoverFavicon, onUpdated, advance: (s: number) => { clock += s; } };
}

beforeEach(() => { h.blobs.clear(); h.runtimes = []; h.sent = []; resetSenderIdentityPolicyCache(); });
afterEach(() => { vi.restoreAllMocks(); });

describe('senderDomain', () => {
  it('takes the lower-cased domain of an address, and nothing from an address without one', () => {
    expect(senderDomain('A@Mail.Example')).toBe('mail.example');
    expect(senderDomain('nope')).toBeNull();
    expect(senderDomain('x@localhost')).toBeNull(); // no dot: nothing to look up
    expect(senderDomain(null)).toBeNull();
  });
});

describe('policy', () => {
  it('normalises, persists and reloads; garbage means the defaults', () => {
    expect(normalizeSenderIdentityPolicy({ logos: false })).toEqual({ logos: false, favicons: true });
    expect(normalizeSenderIdentityPolicy('junk')).toEqual({ logos: true, favicons: true });
    setSenderIdentityPolicy({ logos: false, favicons: false });
    resetSenderIdentityPolicyCache();
    expect(getSenderIdentityPolicy()).toEqual({ logos: false, favicons: false });
  });
});

describe('SenderIdentityService.getForAddress', () => {
  it('answers a first ask from an empty cache as pending, and queues both lookups once', async () => {
    const { svc, lookupBimi, discoverFavicon, onUpdated } = harness();
    const first = svc.getForAddress('a@brand.example', 'data:photo');
    expect(first).toMatchObject({ domain: 'brand.example', bimi: null, favicon: null, contactPhoto: 'data:photo', pending: true });

    await svc.refresh('brand.example'); // joins the queued lookup
    expect(lookupBimi).toHaveBeenCalledTimes(1);
    expect(discoverFavicon).toHaveBeenCalledTimes(1);
    expect(onUpdated).toHaveBeenCalledWith('brand.example');

    const second = svc.getForAddress('a@brand.example');
    expect(second).toMatchObject({ pending: false, bimi: { status: 'none' }, favicon: found().dataUri, faviconStatus: 'found' });
    expect(lookupBimi).toHaveBeenCalledTimes(1); // served from cache
  });

  it('returns nothing to look up for an address without a domain', () => {
    const { svc, lookupBimi } = harness();
    expect(svc.getForAddress('not-an-address')).toMatchObject({ domain: null, bimi: null, favicon: null, pending: false });
    expect(lookupBimi).not.toHaveBeenCalled();
  });

  // THE hot-loop guard: a failed lookup is a recorded answer with a short
  // life, not a hole the next render falls into again.
  it('records a thrown lookup as an error and retries it only after the short TTL', async () => {
    const { svc, store, lookupBimi, advance } = harness();
    lookupBimi.mockRejectedValueOnce(new Error('SERVFAIL'));
    svc.getForAddress('a@brand.example');
    await svc.refresh('brand.example');
    expect(store.get('brand.example')).toMatchObject({ bimiStatus: 'error', bimiDetail: expect.stringContaining('SERVFAIL') });

    advance(30 * 60);
    expect(svc.getForAddress('a@brand.example').pending).toBe(false);
    expect(lookupBimi).toHaveBeenCalledTimes(1);

    advance(31 * 60);
    lookupBimi.mockResolvedValueOnce(verified());
    expect(svc.getForAddress('a@brand.example').pending).toBe(true);
    await svc.refresh('brand.example');
    expect(store.get('brand.example')?.bimiStatus).toBe('verified');
  });

  // Off means off: no fetch, and nothing already cached is shown either.
  it('under a policy that turns a feature off, neither fetches nor shows it', async () => {
    const { svc, store, lookupBimi, discoverFavicon } = harness({ policy: { logos: false, favicons: false } });
    store.upsertBimi('brand.example', verified(), T0);
    store.upsertFavicon('brand.example', found(), T0);
    const id = svc.getForAddress('a@brand.example');
    expect(id).toMatchObject({ bimi: null, favicon: null, faviconStatus: null, pending: false });
    expect(lookupBimi).not.toHaveBeenCalled();
    expect(discoverFavicon).not.toHaveBeenCalled();
  });

  it('refreshes only the half that is stale', async () => {
    const { svc, store, lookupBimi, discoverFavicon } = harness();
    store.upsertBimi('brand.example', verified(), T0);
    svc.getForAddress('a@brand.example');
    await svc.refresh('brand.example');
    expect(lookupBimi).not.toHaveBeenCalled();
    expect(discoverFavicon).toHaveBeenCalledTimes(1);
  });
});

describe('SenderIdentityService.refresh', () => {
  it('is single-flight per domain: concurrent asks share one lookup', async () => {
    const { svc, lookupBimi, onUpdated } = harness();
    svc.getForAddress('a@brand.example');
    svc.getForAddress('b@brand.example');
    const p = svc.refresh('brand.example');
    await Promise.all([p, svc.refresh('brand.example')]);
    expect(lookupBimi).toHaveBeenCalledTimes(1);
    expect(onUpdated).toHaveBeenCalledTimes(1);
  });

  it('bounds how many domains resolve at once', async () => {
    const { svc, lookupBimi } = harness({ maxConcurrent: 1 });
    const gates = new Map<string, () => void>();
    lookupBimi.mockImplementation((d: string) => new Promise<BimiLookup>((resolve) => { gates.set(d, () => resolve(none())); }));
    const p1 = svc.refresh('a.example', { bimi: true });
    const p2 = svc.refresh('b.example', { bimi: true });
    await new Promise((r) => setTimeout(r, 0));
    expect([...gates.keys()]).toEqual(['a.example']); // b waits for a slot
    gates.get('a.example')!();
    await p1;
    await new Promise((r) => setTimeout(r, 0));
    expect(gates.has('b.example')).toBe(true);
    gates.get('b.example')!();
    await p2;
    expect(svc.inFlightCount).toBe(0);
  });

  it('records a thrown favicon discovery as an error too', async () => {
    const { svc, store, discoverFavicon } = harness();
    discoverFavicon.mockRejectedValueOnce(new Error('ECONNRESET'));
    await svc.refresh('brand.example', { favicon: true });
    expect(store.get('brand.example')).toMatchObject({ faviconStatus: 'error', faviconDetail: expect.stringContaining('ECONNRESET') });
  });

  it('survives an onUpdated listener that throws (a renderer that is gone)', async () => {
    const { svc, onUpdated } = harness();
    onUpdated.mockImplementation(() => { throw new Error('window destroyed'); });
    await expect(svc.refresh('brand.example')).resolves.toBeUndefined();
  });
});

describe('SenderIdentityService.refreshStale', () => {
  it('refreshes only stale domains, up to the limit, and nothing with both features off', async () => {
    const { svc, store, lookupBimi } = harness();
    store.upsertBimi('fresh.example', verified(), T0);
    store.upsertFavicon('fresh.example', found(), T0);
    const n = await svc.refreshStale(['fresh.example', 'a.example', 'b.example', 'c.example'], 2);
    expect(n).toBe(2);
    expect(lookupBimi.mock.calls.map((c) => c[0])).toEqual(['a.example', 'b.example']);

    const off = harness({ policy: { logos: false, favicons: false } });
    expect(await off.svc.refreshStale(['a.example'], 5)).toBe(0);
  });
});

describe('identityFromRow', () => {
  it('shapes a row for the renderer and hides the halves the policy turned off', () => {
    const store = new DomainIdentityStore(new Database(':memory:'));
    store.upsertBimi('brand.example', verified(), T0);
    store.upsertFavicon('brand.example', found(), T0);
    const row = store.get('brand.example');
    const all = identityFromRow('a@brand.example', 'brand.example', row, { logos: true, favicons: true }, null, false);
    expect(all.bimi).toMatchObject({ status: 'verified', organization: 'Example Inc', issuer: 'Test Root', logo: verified().logo, dmarcPolicy: 'reject', expires: T0 + 86_400 });
    expect(all.favicon).toBe(found().dataUri);
    const logosOnly = identityFromRow('a@brand.example', 'brand.example', row, { logos: true, favicons: false }, 'data:photo', true);
    expect(logosOnly).toMatchObject({ favicon: null, faviconStatus: null, contactPhoto: 'data:photo', pending: true });
    expect(logosOnly.bimi?.status).toBe('verified');
  });
});

describe('senderIdentityTick', () => {
  it('gathers the most recent sender domains from every account and refreshes the stale ones', async () => {
    const { svc, lookupBimi } = harness();
    h.runtimes = [
      ['acct-1', { storage: { getRecentSenderDomains: async () => ['a.example', 'b.example'] }, syncEngine: null, smtpClient: null }],
      ['acct-2', { storage: { getRecentSenderDomains: async () => ['b.example', 'c.example'] }, syncEngine: null, smtpClient: null }],
      ['acct-3', { storage: { getRecentSenderDomains: async () => { throw new Error('db locked'); } }, syncEngine: null, smtpClient: null }],
    ];
    expect(await senderIdentityTick(svc)).toBe(3);
    expect(lookupBimi.mock.calls.map((c) => c[0]).sort()).toEqual(['a.example', 'b.example', 'c.example']);
  });

  it('does nothing when both features are off', async () => {
    setSenderIdentityPolicy({ logos: false, favicons: false });
    const { svc, lookupBimi } = harness();
    h.runtimes = [['acct-1', { storage: { getRecentSenderDomains: async () => ['a.example'] }, syncEngine: null, smtpClient: null }]];
    expect(await senderIdentityTick(svc)).toBe(0);
    expect(lookupBimi).not.toHaveBeenCalled();
  });
});
