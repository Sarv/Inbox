/**
 * Per-domain sender identity — BIMI standing and favicon — cached in the core DB.
 *
 * Both are properties of a DOMAIN, not of an account or a message, so they
 * live in the main-owned core DB and are looked up once for every account.
 * The renderer never fetches anything: it reads these rows (as `data:` URIs)
 * and the resolver in sender-identity-service.ts refreshes them in the
 * background. Freshness is decided here so every caller agrees on it:
 *
 *   - a BIMI answer (verified / logo / declined / none / invalid) is good for a
 *     week; a lookup that ERRORED (DNS down, fetch failed) for an hour, so a
 *     flaky network cannot hide a real logo for a week;
 *   - a favicon for a month; a failed attempt, again, for an hour.
 *
 * NULL `*_checked_at` means "never looked up", which is distinct from "looked
 * up and found nothing" — the shield says so.
 */
import type { BimiLookup, BimiStatus, FaviconResult, FaviconStatus } from '@sarvinbox/core';
import type Database from 'better-sqlite3';

import { getCoreDb } from './core-db';

const DAY = 24 * 60 * 60;
/** Seconds a BIMI answer stays fresh. */
export const BIMI_TTL_S = 7 * DAY;
/** Seconds before a failed BIMI lookup is retried. */
export const BIMI_ERROR_TTL_S = 60 * 60;
/** Seconds a favicon answer stays fresh. */
export const FAVICON_TTL_S = 30 * DAY;
/** Seconds before a failed favicon attempt is retried. */
export const FAVICON_ERROR_TTL_S = 60 * 60;

export interface DomainIdentityRow {
  domain: string;
  bimiStatus: BimiStatus | null;
  /** `data:image/svg+xml;base64,…` when the domain publishes a usable logo. */
  bimiLogo: string | null;
  bimiOrganization: string | null;
  bimiIssuer: string | null;
  /** Unix seconds; the Verified Mark Certificate's expiry. */
  bimiExpires: number | null;
  bimiDetail: string | null;
  bimiRecordDomain: string | null;
  dmarcPolicy: string | null;
  /** Unix seconds; NULL = never looked up. */
  bimiCheckedAt: number | null;
  /** `data:<type>;base64,…` when found. */
  favicon: string | null;
  faviconStatus: FaviconStatus | null;
  faviconDetail: string | null;
  faviconCheckedAt: number | null;
  updatedAt: number;
}

export function ensureDomainIdentitySchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS domain_identity (
      domain              TEXT PRIMARY KEY,
      bimi_status         TEXT,
      bimi_logo           TEXT,
      bimi_organization   TEXT,
      bimi_issuer         TEXT,
      bimi_expires        INTEGER,
      bimi_detail         TEXT,
      bimi_record_domain  TEXT,
      dmarc_policy        TEXT,
      bimi_checked_at     INTEGER,
      favicon             TEXT,
      favicon_status      TEXT,
      favicon_detail      TEXT,
      favicon_checked_at  INTEGER,
      updated_at          INTEGER NOT NULL
    );
  `);
}

/** Does the BIMI half of this row need (re)fetching at `nowSec`? */
export function bimiIsStale(row: DomainIdentityRow | null, nowSec: number): boolean {
  if (!row || row.bimiCheckedAt == null || !row.bimiStatus) return true;
  const ttl = row.bimiStatus === 'error' ? BIMI_ERROR_TTL_S : BIMI_TTL_S;
  return nowSec - row.bimiCheckedAt > ttl;
}

/** Does the favicon half of this row need (re)fetching at `nowSec`? */
export function faviconIsStale(row: DomainIdentityRow | null, nowSec: number): boolean {
  if (!row || row.faviconCheckedAt == null || !row.faviconStatus) return true;
  const ttl = row.faviconStatus === 'error' ? FAVICON_ERROR_TTL_S : FAVICON_TTL_S;
  return nowSec - row.faviconCheckedAt > ttl;
}

interface Raw {
  domain: string;
  bimi_status: string | null; bimi_logo: string | null; bimi_organization: string | null; bimi_issuer: string | null;
  bimi_expires: number | null; bimi_detail: string | null; bimi_record_domain: string | null; dmarc_policy: string | null;
  bimi_checked_at: number | null;
  favicon: string | null; favicon_status: string | null; favicon_detail: string | null; favicon_checked_at: number | null;
  updated_at: number;
}

const toRow = (r: Raw): DomainIdentityRow => ({
  domain: r.domain,
  bimiStatus: (r.bimi_status as BimiStatus | null) ?? null,
  bimiLogo: r.bimi_logo ?? null,
  bimiOrganization: r.bimi_organization ?? null,
  bimiIssuer: r.bimi_issuer ?? null,
  bimiExpires: r.bimi_expires ?? null,
  bimiDetail: r.bimi_detail ?? null,
  bimiRecordDomain: r.bimi_record_domain ?? null,
  dmarcPolicy: r.dmarc_policy ?? null,
  bimiCheckedAt: r.bimi_checked_at ?? null,
  favicon: r.favicon ?? null,
  faviconStatus: (r.favicon_status as FaviconStatus | null) ?? null,
  faviconDetail: r.favicon_detail ?? null,
  faviconCheckedAt: r.favicon_checked_at ?? null,
  updatedAt: r.updated_at,
});

export const normalizeDomain = (domain: string): string => domain.trim().toLowerCase();

export class DomainIdentityStore {
  constructor(private readonly db: Database.Database) {
    ensureDomainIdentitySchema(db);
  }

  get(domain: string): DomainIdentityRow | null {
    const r = this.db.prepare('SELECT * FROM domain_identity WHERE domain = ?').get(normalizeDomain(domain)) as Raw | undefined;
    return r ? toRow(r) : null;
  }

  getMany(domains: string[]): Map<string, DomainIdentityRow> {
    const out = new Map<string, DomainIdentityRow>();
    if (domains.length === 0) return out;
    const keys = [...new Set(domains.map(normalizeDomain))];
    const rows = this.db
      .prepare(`SELECT * FROM domain_identity WHERE domain IN (${keys.map(() => '?').join(',')})`)
      .all(...keys) as Raw[];
    for (const r of rows) out.set(r.domain, toRow(r));
    return out;
  }

  /** Record a BIMI answer. Leaves the favicon half untouched. */
  upsertBimi(domain: string, lookup: BimiLookup, checkedAtSec: number): void {
    this.db.prepare(`
      INSERT INTO domain_identity (domain, bimi_status, bimi_logo, bimi_organization, bimi_issuer, bimi_expires,
        bimi_detail, bimi_record_domain, dmarc_policy, bimi_checked_at, updated_at)
      VALUES (@domain, @status, @logo, @organization, @issuer, @expires, @detail, @recordDomain, @dmarcPolicy, @checkedAt, @checkedAt)
      ON CONFLICT(domain) DO UPDATE SET
        bimi_status = excluded.bimi_status, bimi_logo = excluded.bimi_logo,
        bimi_organization = excluded.bimi_organization, bimi_issuer = excluded.bimi_issuer,
        bimi_expires = excluded.bimi_expires, bimi_detail = excluded.bimi_detail,
        bimi_record_domain = excluded.bimi_record_domain, dmarc_policy = excluded.dmarc_policy,
        bimi_checked_at = excluded.bimi_checked_at, updated_at = excluded.updated_at
    `).run({
      domain: normalizeDomain(domain),
      status: lookup.status,
      logo: lookup.logo,
      organization: lookup.organization,
      issuer: lookup.issuer,
      expires: lookup.certificateExpires,
      detail: lookup.detail,
      recordDomain: lookup.recordDomain,
      dmarcPolicy: lookup.dmarcPolicy,
      checkedAt: checkedAtSec,
    });
  }

  /** Record a favicon answer. Leaves the BIMI half untouched. */
  upsertFavicon(domain: string, result: FaviconResult, checkedAtSec: number): void {
    this.db.prepare(`
      INSERT INTO domain_identity (domain, favicon, favicon_status, favicon_detail, favicon_checked_at, updated_at)
      VALUES (@domain, @favicon, @status, @detail, @checkedAt, @checkedAt)
      ON CONFLICT(domain) DO UPDATE SET
        favicon = excluded.favicon, favicon_status = excluded.favicon_status,
        favicon_detail = excluded.favicon_detail, favicon_checked_at = excluded.favicon_checked_at,
        updated_at = excluded.updated_at
    `).run({
      domain: normalizeDomain(domain),
      favicon: result.dataUri,
      status: result.status,
      detail: result.detail,
      checkedAt: checkedAtSec,
    });
  }

  /** Newest first — what the Security page lists. */
  list(limit = 200): DomainIdentityRow[] {
    const rows = this.db.prepare('SELECT * FROM domain_identity ORDER BY updated_at DESC LIMIT ?').all(Math.max(1, limit)) as Raw[];
    return rows.map(toRow);
  }

  /** Drop everything cached for a domain; the next message from it looks it up afresh. */
  forget(domain: string): void {
    this.db.prepare('DELETE FROM domain_identity WHERE domain = ?').run(normalizeDomain(domain));
  }
}

let singleton: DomainIdentityStore | null = null;

/** The store on the core DB (lazy; the core DB is opened on first use). */
export function getDomainIdentityStore(): DomainIdentityStore {
  if (!singleton) singleton = new DomainIdentityStore(getCoreDb());
  return singleton;
}
