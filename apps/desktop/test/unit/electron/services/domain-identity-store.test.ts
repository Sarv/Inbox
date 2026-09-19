import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../../electron/services/core-db', () => ({
  getCoreDb: () => { throw new Error('the core DB is not opened in tests'); },
}));

import {
  BIMI_ERROR_TTL_S,
  BIMI_TTL_S,
  DomainIdentityStore,
  FAVICON_ERROR_TTL_S,
  FAVICON_TTL_S,
  bimiIsStale,
  faviconIsStale,
} from '../../../../electron/services/domain-identity-store';

/**
 * The per-domain identity cache.
 *
 * What this protects: the avatar and the verified tick are drawn from these
 * rows, and the resolver decides from them whether to touch the network. A
 * BIMI write that wiped the favicon (or the reverse) would flicker avatars
 * every refresh; a staleness rule that never expired an error would hide a
 * brand's real logo behind one bad DNS moment for a week.
 */
const T0 = 1_760_000_000;
const verified = {
  status: 'verified' as const, logo: 'data:image/svg+xml;base64,AAAA', organization: 'Example Inc', issuer: 'Test Root',
  certificateExpires: T0 + 86_400, dmarcPolicy: 'reject' as const, recordDomain: 'brand.example', detail: 'ok',
};
const favicon = { status: 'found' as const, dataUri: 'data:image/png;base64,BBBB', source: 'root' as const, detail: 'brand.example/favicon.ico' };
const store = () => new DomainIdentityStore(new Database(':memory:'));

describe('DomainIdentityStore', () => {
  it('round-trips a BIMI answer and leaves the favicon half alone', () => {
    const s = store();
    s.upsertFavicon('brand.example', favicon, T0 - 10);
    s.upsertBimi('brand.example', verified, T0);
    expect(s.get('brand.example')).toMatchObject({
      domain: 'brand.example', bimiStatus: 'verified', bimiLogo: verified.logo, bimiOrganization: 'Example Inc',
      bimiIssuer: 'Test Root', bimiExpires: T0 + 86_400, dmarcPolicy: 'reject', bimiRecordDomain: 'brand.example',
      bimiCheckedAt: T0, favicon: favicon.dataUri, faviconStatus: 'found', faviconCheckedAt: T0 - 10, updatedAt: T0,
    });
  });

  it('round-trips a favicon answer and leaves the BIMI half alone', () => {
    const s = store();
    s.upsertBimi('brand.example', verified, T0);
    s.upsertFavicon('brand.example', { status: 'none', dataUri: null, source: null, detail: 'nothing' }, T0 + 5);
    expect(s.get('brand.example')).toMatchObject({ bimiStatus: 'verified', favicon: null, faviconStatus: 'none', faviconDetail: 'nothing', updatedAt: T0 + 5 });
  });

  // The key the renderer asks with comes from an address; case must not split it.
  it('normalises the domain key', () => {
    const s = store();
    s.upsertBimi(' Brand.Example ', verified, T0);
    expect(s.get('BRAND.EXAMPLE')?.domain).toBe('brand.example');
    expect(s.get('other.example')).toBeNull();
  });

  it('getMany returns only known domains, keyed lower-case', () => {
    const s = store();
    s.upsertBimi('a.example', verified, T0);
    const m = s.getMany(['A.example', 'b.example']);
    expect([...m.keys()]).toEqual(['a.example']);
    expect(s.getMany([]).size).toBe(0);
  });

  it('lists newest first and honours the limit', () => {
    const s = store();
    s.upsertBimi('old.example', verified, T0);
    s.upsertBimi('new.example', verified, T0 + 100);
    s.upsertBimi('mid.example', verified, T0 + 50);
    expect(s.list(2).map((r) => r.domain)).toEqual(['new.example', 'mid.example']);
  });

  it('forget drops the row so the next ask starts from nothing', () => {
    const s = store();
    s.upsertBimi('brand.example', verified, T0);
    s.forget('Brand.Example');
    expect(s.get('brand.example')).toBeNull();
  });
});

describe('staleness', () => {
  const row = (over: Record<string, unknown>) => ({
    domain: 'x', bimiStatus: null, bimiLogo: null, bimiOrganization: null, bimiIssuer: null, bimiExpires: null, bimiDetail: null,
    bimiRecordDomain: null, dmarcPolicy: null, bimiCheckedAt: null, favicon: null, faviconStatus: null, faviconDetail: null,
    faviconCheckedAt: null, updatedAt: T0, ...over,
  }) as Parameters<typeof bimiIsStale>[0];

  // Never checked is stale; so is a row with a timestamp but no status (a half write).
  it('treats a missing row, or an unstamped half, as stale', () => {
    expect(bimiIsStale(null, T0)).toBe(true);
    expect(bimiIsStale(row({ bimiCheckedAt: T0 }), T0)).toBe(true);
    expect(faviconIsStale(row({ faviconCheckedAt: T0 }), T0)).toBe(true);
  });

  it('holds a real answer for its TTL', () => {
    expect(bimiIsStale(row({ bimiStatus: 'none', bimiCheckedAt: T0 }), T0 + BIMI_TTL_S - 1)).toBe(false);
    expect(bimiIsStale(row({ bimiStatus: 'none', bimiCheckedAt: T0 }), T0 + BIMI_TTL_S + 1)).toBe(true);
    expect(faviconIsStale(row({ faviconStatus: 'found', faviconCheckedAt: T0 }), T0 + FAVICON_TTL_S - 1)).toBe(false);
    expect(faviconIsStale(row({ faviconStatus: 'found', faviconCheckedAt: T0 }), T0 + FAVICON_TTL_S + 1)).toBe(true);
  });

  // THE rule that keeps one bad DNS moment from hiding a logo for a week.
  it('retries an error after its short TTL', () => {
    expect(bimiIsStale(row({ bimiStatus: 'error', bimiCheckedAt: T0 }), T0 + BIMI_ERROR_TTL_S - 1)).toBe(false);
    expect(bimiIsStale(row({ bimiStatus: 'error', bimiCheckedAt: T0 }), T0 + BIMI_ERROR_TTL_S + 1)).toBe(true);
    expect(faviconIsStale(row({ faviconStatus: 'error', faviconCheckedAt: T0 }), T0 + FAVICON_ERROR_TTL_S + 1)).toBe(true);
  });
});
