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

  /**
   * REGRESSION: builds from 2026-09-21 could not load the certificate library
   * and cached every brand with a certificate as an ordinary week-long "logo".
   * After the fix those rows must be re-checked within the hour, or the tick
   * stays off for up to a week. Both shapes the old builds wrote: the packaged
   * app (vite's stand-in module) and a dev run (Node's resolver).
   */
  it('keeps an answer recorded without the certificate library only as long as an error', () => {
    const missing = [
      "Certificate not verified: Verifying a BIMI certificate needs the optional peer dependency '@peculiar/x509', which is not installed. Add it (npm install @peculiar/x509) to enable Verified Mark Certificate checks; the logo lookup, the SVG check and the favicon lookup all work without it. (Could not resolve \"reflect-metadata\" imported by \"@sarv-in/mailguard\". Is it installed?)",
      "Certificate not verified: Verifying a BIMI certificate needs the optional peer dependency '@peculiar/x509', which is not installed. Add it (npm install @peculiar/x509) to enable Verified Mark Certificate checks; the logo lookup, the SVG check and the favicon lookup all work without it. (Cannot find package 'reflect-metadata' imported from /app/node_modules/@sarv-in/mailguard/dist/chunk-K5CZSXLG.js)",
    ];
    for (const bimiDetail of missing) {
      const unverifiable = row({ bimiStatus: 'logo', bimiDetail, bimiCheckedAt: T0 });
      expect(bimiIsStale(unverifiable, T0 + BIMI_ERROR_TTL_S - 1)).toBe(false);
      expect(bimiIsStale(unverifiable, T0 + BIMI_ERROR_TTL_S + 1)).toBe(true);
    }
  });

  // A certificate that was checked and failed is a real answer about the
  // brand: re-checking it hourly would hammer its server for nothing.
  it('keeps a certificate that was checked and refused for the full TTL', () => {
    const refused = row({
      bimiStatus: 'logo',
      bimiDetail: 'Certificate not verified: The logo the domain serves is not the one the certificate was issued for',
      bimiCheckedAt: T0,
    });
    expect(bimiIsStale(refused, T0 + BIMI_ERROR_TTL_S + 1)).toBe(false);
    expect(bimiIsStale(refused, T0 + BIMI_TTL_S + 1)).toBe(true);
  });
});
