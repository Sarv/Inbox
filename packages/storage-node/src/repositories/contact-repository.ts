// Contact Repository - Contact, sender stats, signature, and snooze operations

import { randomUUID } from 'crypto';

import type {
  ContactRecord,
  ContactEnrichment,
  ContactEnrichmentHistoryRecord,
  PaginationOptions,
  EmailRecord,
} from '@sarvinbox/core';
import { contactNameForAddress, isRoleAddress, parseAddressList, PUBLIC_DOMAINS } from '@sarvinbox/core';

import { SHARED } from '../shared-contacts';
import type { SenderStats, SignaturePattern } from '../sqlite-storage';

import { BaseRepository, type DatabaseAccessor } from './base-repository';

/*
 * The contact directory is SHARED across accounts and reached through the
 * ATTACHed `shared` schema, so every statement below names it explicitly.
 * A bare `contacts` would resolve against `main` first: if any account
 * database ever regained a local table of that name the query would silently
 * read it instead, and an empty address book looks exactly like a user who
 * has no contacts. Going through SHARED() keeps the schema name in one place
 * and makes every directory access greppable.
 *
 * `sender_stats`, `signature_patterns` and `emails` stay unqualified on
 * purpose -- those ARE per-account, and the joins below mix the two.
 */
const CONTACTS = SHARED('contacts');
const CONTACT_ACCOUNTS = SHARED('contact_accounts');
const ENRICHMENT_HISTORY = SHARED('contact_enrichment_history');

/** Provenance account id used when a storage was opened with no account. */
const UNKNOWN_ACCOUNT = 'unknown-account';

/** Best-effort platform label for a social URL (for the otherSocials blob). */
function socialPlatformOf(url: string): string {
  try {
    const h = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    if (h.includes('facebook') || h === 'fb.com') return 'facebook';
    if (h.includes('instagram')) return 'instagram';
    if (h.includes('youtube') || h === 'youtu.be') return 'youtube';
    if (h.includes('twitter') || h === 'x.com') return 'twitter';
    if (h.includes('threads')) return 'threads';
    if (h.includes('mastodon')) return 'mastodon';
    return h.split('.')[0] || 'web';
  } catch { return 'web'; }
}

/**
 * Candidate for enrichment: a contact that either has never been
 * enriched, or has received mail from the sender since the last run.
 * The scheduler iterates these one-by-one.
 */
export interface EnrichmentCandidate {
  id: string;
  email: string;
  kind: 'individual' | 'company';
  enrichedThroughEmailAt: number | null;
  newestEmailAt: number;
}

/**
 * The enrichment-candidate join. Exported so the query-plan regression test can
 * pin the REAL statement instead of a copy that could drift from it.
 *
 * `LOWER(e.from_address)` is written EXACTLY as `idx_emails_from_lower_date`
 * declares it — an expression index is only usable when the query's expression
 * matches the index's. Before that index existed this join scanned every email
 * once per contact: 2,222.9ms of blocked main thread on a 26k mailbox, re-run 3
 * seconds after every enrichment batch, i.e. a 2-second freeze every few
 * seconds for as long as a rotation ran. With the index: 3.4ms.
 *
 * Bound parameters, in order: the minimum re-enrich gap in seconds, then the
 * row limit.
 */
export const SQL_ENRICHMENT_CANDIDATES = `
      SELECT
        c.id AS id,
        c.email AS email,
        c.kind AS kind,
        c.enriched_through_email_at AS enriched_through_email_at,
        MAX(e.date) AS newest_email_at
      FROM ${CONTACTS} c
      INNER JOIN emails e ON LOWER(e.from_address) = LOWER(c.email)
      WHERE c.kind = 'individual'
      GROUP BY c.id
      HAVING
        c.enriched_through_email_at IS NULL
        OR MAX(e.date) > c.enriched_through_email_at + ?
      ORDER BY newest_email_at DESC
      LIMIT ?
`;

/** Columns callers may sort contacts by — anything else falls back to last_seen. */
const CONTACT_SORT_COLUMNS: ReadonlySet<string> = new Set([
  'last_seen',
  'first_seen',
  'name',
  'email',
  'email_count',
  'sent_count',
  'received_count',
  'created_at',
  'updated_at',
]);

/**
 * Write payload for applying LLM-derived enrichment to a contact.
 * Matches the shape the renderer sends back via IPC.
 */
export interface ApplyEnrichmentInput {
  contactId: string;
  enrichment: ContactEnrichment;
  kind?: 'individual' | 'company';
  mobileE164?: string | null;
  enrichedThroughEmailAt: number; // max(scanned emails' date)
  sourceEmailId?: string | null;
  source?: 'llm' | 'user';
}

export interface SenderContext {
  emailCount: number;      // total interactions
  sentCount: number;       // user sent to them (from contacts)
  receivedCount: number;   // received from them
  repliedCount: number;    // user replied to them (from sender_stats)
  sentToCount: number;     // user sent to them (from sender_stats)
  readCount: number;       // how many of their emails user actually opened
  deletedCount: number;    // how many of their emails user deleted
  lastReplied?: number;    // unix timestamp of last reply to this sender
  lastSentTo?: number;     // unix timestamp of last email sent to this sender
  isFavorite: boolean;
  isVip: boolean;
  isBlocked: boolean;
  tier: 'vip' | 'frequent' | 'known' | 'occasional' | 'first-time' | 'blocked';
  /**
   * Windowed stats for the last N days (default 90). Populated separately
   * from the lifetime counters so the categorization prompt can prefer
   * recent behavior over lifetime averages when there's enough signal.
   * A sender you corresponded with heavily 3 years ago but never since
   * should not be ranked the same as a current colleague.
   *
   * Absent when no per-window data exists (fresh sender or windowed
   * query disabled). Callers should fall back to the lifetime counters.
   */
  recent?: {
    windowDays: number;
    receivedCount: number;
    readCount: number;
    deletedCount: number;
    repliedCount: number;
  };
}

/**
 * Repository for contact-related operations
 */
export class ContactRepository extends BaseRepository {
  /**
   * @param getDb       the account's connection, with the directory attached.
   * @param accountKey  which mailbox this repository speaks for, recorded as
   *   contact provenance. A thunk rather than a value because the storage that
   *   owns this repository is constructed before its account is known, and a
   *   default rather than a required argument because a storage opened with no
   *   account behind it (the seeding script, the test fixtures) still has to
   *   work — it just cannot say whose contacts these are.
   */
  constructor(getDb: DatabaseAccessor, private readonly accountKey: () => string = () => UNKNOWN_ACCOUNT) {
    super(getDb);
  }

  /**
   * Record what THIS mailbox contributed to a directory row.
   *
   * The directory holds the union; this holds the parts. Without it the union
   * is a one-way door: disconnecting an account could only either leave its
   * counts fused into a total with no remaining source, or delete a shared
   * contact that another account still sees. It also answers "which of my
   * addresses does this person actually write to", which is the only way to
   * pick a from-address for a reply.
   *
   * Deltas, applied with the same arithmetic as the contact row itself, so the
   * two can never drift: a metadata-only upsert adds nothing.
   */
  private recordProvenanceSync(email: string, delta: {
    firstSeen: number; lastSeen: number;
    emailCount: number; sentCount: number; receivedCount: number;
  }): void {
    this.db.prepare(`
      INSERT INTO ${CONTACT_ACCOUNTS}
        (email, account_id, first_seen, last_seen, email_count, sent_count, received_count, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, unixepoch())
      ON CONFLICT(email, account_id) DO UPDATE SET
        first_seen     = MIN(COALESCE(first_seen, excluded.first_seen), excluded.first_seen),
        last_seen      = MAX(COALESCE(last_seen, 0), excluded.last_seen),
        email_count    = COALESCE(email_count, 0)    + excluded.email_count,
        sent_count     = COALESCE(sent_count, 0)     + excluded.sent_count,
        received_count = COALESCE(received_count, 0) + excluded.received_count,
        updated_at     = unixepoch()
    `).run(
      this.normalizeEmailKey(email),
      this.accountKey(),
      delta.firstSeen,
      delta.lastSeen,
      delta.emailCount,
      delta.sentCount,
      delta.receivedCount,
    );
  }

  // ========== Contact Operations ==========

  /**
   * Upsert contact - update if exists, create if new
   */
  async upsert(contact: Partial<ContactRecord> & { email: string }): Promise<ContactRecord> {
    return this.upsertSync(contact);
  }

  /**
   * Synchronous core of {@link upsert}. Contains only synchronous
   * better-sqlite3 calls so it can run inside a `db.transaction(() => …)`
   * (whose callback must not await). The async `upsert` just delegates here.
   */
  upsertSync(contact: Partial<ContactRecord> & { email: string }): ContactRecord {
    const now = this.now();
    const existing = this.getByEmailSync(contact.email);

    if (existing) {
      // MAX/MIN guards: older folders syncing later must not regress
      // lastSeen or leave firstSeen too new.
      const updates: Partial<ContactRecord> = {
        lastSeen: Math.max(existing.lastSeen || 0, contact.lastSeen || now),
      };
      if (contact.firstSeen && contact.firstSeen < (existing.firstSeen || Infinity)) {
        updates.firstSeen = contact.firstSeen;
      }
      // Only count an email when the caller is recording one —
      // metadata-only upserts must not inflate emailCount.
      if ((contact.sentCount || 0) + (contact.receivedCount || 0) > 0) {
        updates.emailCount = (existing.emailCount || 0) + 1;
      }

      if (contact.name && !existing.name) {
        updates.name = contact.name;
      }
      if (contact.sentCount !== undefined) {
        updates.sentCount = (existing.sentCount || 0) + contact.sentCount;
      }
      if (contact.receivedCount !== undefined) {
        updates.receivedCount = (existing.receivedCount || 0) + contact.receivedCount;
      }

      this.updateSync(existing.id, updates);
      this.recordProvenanceSync(contact.email, {
        firstSeen: updates.firstSeen ?? existing.firstSeen ?? now,
        lastSeen: updates.lastSeen ?? now,
        emailCount: updates.emailCount === undefined ? 0 : 1,
        sentCount: contact.sentCount || 0,
        receivedCount: contact.receivedCount || 0,
      });
      return { ...existing, ...updates };
    } else {
      const newContact: ContactRecord = {
        id: randomUUID(),
        email: this.normalizeEmailKey(contact.email),
        name: contact.name || null,
        displayName: contact.displayName || null,
        avatarUrl: contact.avatarUrl || null,
        avatarStatus: contact.avatarStatus ?? null,
        avatarCheckedAt: contact.avatarCheckedAt ?? null,
        organization: contact.organization || null,
        title: contact.title || null,
        phone: contact.phone || null,
        firstSeen: contact.firstSeen || now,
        lastSeen: contact.lastSeen || now,
        emailCount: 1,
        sentCount: contact.sentCount || 0,
        receivedCount: contact.receivedCount || 0,
        isFavorite: contact.isFavorite || false,
        notes: contact.notes || null,
        tags: contact.tags || [],
        metadata: contact.metadata || {},
        createdAt: now,
        updatedAt: now,
      };

      // Role/generic mailboxes (info@, no-reply@, sales@, hr@, accounts@…)
      // are an organization's functional mailbox, not a person. Type them
      // 'automated' up front so the UI/agent never treat them as humans
      // and the enrichment path never gives them a person identity. A
      // later agent/user classification can still override this.
      const roleType = isRoleAddress(newContact.email) ? 'automated' : null;

      this.db.prepare(`
        INSERT INTO ${CONTACTS} (
          id, email, name, display_name, avatar_url, organization, title, phone,
          first_seen, last_seen, email_count, sent_count, received_count,
          is_favorite, notes, tags, metadata, contact_type, contact_type_source
        ) VALUES (
          @id, @email, @name, @displayName, @avatarUrl, @organization, @title, @phone,
          @firstSeen, @lastSeen, @emailCount, @sentCount, @receivedCount,
          @isFavorite, @notes, @tags, @metadata, @contactType, @contactTypeSource
        )
      `).run({
        id: newContact.id,
        email: newContact.email,
        name: newContact.name,
        displayName: newContact.displayName,
        avatarUrl: newContact.avatarUrl,
        organization: newContact.organization,
        title: newContact.title,
        phone: newContact.phone,
        firstSeen: newContact.firstSeen,
        lastSeen: newContact.lastSeen,
        emailCount: newContact.emailCount,
        sentCount: newContact.sentCount,
        receivedCount: newContact.receivedCount,
        isFavorite: newContact.isFavorite ? 1 : 0,
        notes: newContact.notes,
        tags: JSON.stringify(newContact.tags),
        metadata: JSON.stringify(newContact.metadata),
        contactType: roleType,
        contactTypeSource: roleType ? 'heuristic' : null,
      });

      this.recordProvenanceSync(newContact.email, {
        firstSeen: newContact.firstSeen,
        lastSeen: newContact.lastSeen,
        emailCount: newContact.emailCount,
        sentCount: newContact.sentCount,
        receivedCount: newContact.receivedCount,
      });

      return newContact;
    }
  }

  /**
   * Get contact by email
   */
  async getByEmail(email: string): Promise<ContactRecord | null> {
    return this.getByEmailSync(email);
  }

  /** Synchronous core of {@link getByEmail} — callable inside a transaction. */
  getByEmailSync(email: string): ContactRecord | null {
    const row = this.db
      .prepare(`SELECT * FROM ${CONTACTS} WHERE email = ?`)
      .get(this.normalizeEmailKey(email)) as any;

    return row ? this.rowToContactRecord(row) : null;
  }

  /**
   * The agent-facing contact type for one address, or `'unknown'`.
   *
   * A single-column read that the pipeline calls once per email, so it stays
   * out of {@link getByEmail} (which hydrates the whole row and its JSON
   * blobs). It lives here rather than in the pipeline so the directory's
   * schema qualification is applied in exactly one place.
   */
  getContactTypeSync(email: string): string {
    const row = this.db
      .prepare(`SELECT contact_type FROM ${CONTACTS} WHERE email = ?`)
      .get(this.normalizeEmailKey(email)) as { contact_type?: string } | undefined;
    return row?.contact_type || 'unknown';
  }

  /**
   * Get contact by ID
   */
  async get(id: string): Promise<ContactRecord | null> {
    const row = this.db
      .prepare(`SELECT * FROM ${CONTACTS} WHERE id = ?`)
      .get(id) as any;

    return row ? this.rowToContactRecord(row) : null;
  }

  /**
   * Get contacts with pagination, search, and optional contact-type filter.
   *
   * The `contactType` filter narrows to rows where the agent (or the user,
   * via manual edit) set `contact_type = ?`. Pass `"unknown"` to match
   * contacts that are either explicitly 'unknown' or have no type set yet
   * (NULL) — otherwise a freshly-scanned address book returns zero rows
   * because auto-classification hasn't run.
   */
  async getAll(options: PaginationOptions & { search?: string; contactType?: string }): Promise<ContactRecord[]> {
    const sortBy = options.sortBy || 'last_seen';
    const { column: sortColumn, direction: sortDirection } = this.safeOrderBy(
      options.sortBy, options.sortOrder, CONTACT_SORT_COLUMNS, 'last_seen'
    );
    const now = this.now();

    const { where, params: filterParams } = this.buildListWhere(options);

    let sql: string;
    const params: any[] = [];

    if (sortBy === 'relevance') {
      sql = `
        SELECT *,
          ((sent_count * 3 + received_count) * (1.0 / (1.0 + (? - last_seen) / 2592000.0))) as relevance_score
        FROM ${CONTACTS}
      `;
      params.push(now);
      sql += where;
      params.push(...filterParams);
      sql += ` ORDER BY relevance_score ${sortDirection}`;
    } else {
      sql = `SELECT * FROM ${CONTACTS}`;
      sql += where;
      params.push(...filterParams);
      sql += ` ORDER BY ${sortColumn} ${sortDirection}`;
    }

    sql += ' LIMIT ? OFFSET ?';
    params.push(options.limit, options.offset);

    const rows = this.db.prepare(sql).all(...params) as any[];
    return rows.map(row => this.rowToContactRecord(row));
  }

  /**
   * Get contacts count (matches the same filters as getAll).
   */
  async getCount(search?: string, contactType?: string): Promise<number> {
    const { where, params } = this.buildListWhere({ search, contactType });
    const sql = `SELECT COUNT(*) as count FROM ${CONTACTS}` + where;
    const row = this.db.prepare(sql).get(...params) as any;
    return row.count;
  }

  /**
   * Compose WHERE clause + params for list/count queries. Shared so the
   * two queries can't drift on filter semantics.
   */
  private buildListWhere(opts: { search?: string; contactType?: string }): { where: string; params: any[] } {
    const clauses: string[] = [];
    const params: any[] = [];

    if (opts.search) {
      clauses.push('(email LIKE ? OR name LIKE ? OR display_name LIKE ?)');
      const term = `%${opts.search}%`;
      params.push(term, term, term);
    }

    if (opts.contactType) {
      if (opts.contactType === 'unknown') {
        // Include NULLs so fresh/unclassified contacts show up when the
        // user picks "Unknown" from the filter.
        clauses.push("(contact_type = 'unknown' OR contact_type IS NULL)");
      } else {
        clauses.push('contact_type = ?');
        params.push(opts.contactType);
      }
    }

    const where = clauses.length > 0 ? ' WHERE ' + clauses.join(' AND ') : '';
    return { where, params };
  }

  /**
   * Update contact
   */
  async update(id: string, updates: Partial<ContactRecord>): Promise<void> {
    this.updateSync(id, updates);
  }

  /** Synchronous core of {@link update} — callable inside a transaction. */
  updateSync(id: string, updates: Partial<ContactRecord>): void {
    const { setClauses, params } = this.buildUpdateClauses(updates, {
      boolFields: ['isFavorite'],
      jsonFields: ['tags', 'metadata'],
    });

    if (setClauses.length === 0) return;

    params.id = id;
    this.db.prepare(`
      UPDATE ${CONTACTS}
      SET ${setClauses.join(', ')}
      WHERE id = @id
    `).run(params);
  }

  /**
   * Delete a contact from the directory — for EVERY account, not just this one.
   *
   * The row is shared now, so this is the user saying "I don't want this person
   * in my address book", not "this mailbox no longer sees them". The provenance
   * rows go with it: leaving them behind would make the next sync from any
   * account resurrect the contact with the old counts fused back in.
   *
   * Sourced from the row itself rather than from the caller's idea of the
   * address, and a no-op when the row is already gone — so a delete can never
   * take provenance with it on a mistaken id.
   */
  async delete(id: string): Promise<void> {
    const row = this.db
      .prepare(`SELECT email FROM ${CONTACTS} WHERE id = ?`)
      .get(id) as { email?: string } | undefined;
    if (!row?.email) return;

    this.db.transaction(() => {
      this.db.prepare(`DELETE FROM ${CONTACTS} WHERE id = ?`).run(id);
      this.db.prepare(`DELETE FROM ${CONTACT_ACCOUNTS} WHERE email = ?`).run(row.email);
    })();
  }

  /**
   * Check if email should be excluded from contacts
   */
  isExcludedEmail(email: string): boolean {
    const lowered = this.normalizeEmailKey(email);
    // Only exclude truly non-deliverable system addresses
    const excludePatterns = ['mailer-daemon', 'postmaster'];
    return !lowered.includes('@') || excludePatterns.some(pattern => lowered.includes(pattern));
  }

  /**
   * Extract contacts from email
   */
  async extractFromEmail(email: EmailRecord, direction: 'sent' | 'received'): Promise<void> {
    this.extractFromEmailSync(email, direction);
  }

  /**
   * Synchronous core of {@link extractFromEmail} — callable inside a
   * transaction so a whole batch's contact extraction commits once.
   */
  extractFromEmailSync(email: EmailRecord, direction: 'sent' | 'received'): void {
    const emailDate = email.date || this.now();
    const contacts: Array<{ email: string; name: string | null; direction: 'sent' | 'received' }> = [];

    if (direction === 'received') {
      if (email.fromAddress) {
        contacts.push({ email: email.fromAddress, name: email.fromName, direction: 'received' });
      }
    } else {
      // M4 fix: rely solely on the display name that parseAddressList extracts
      // inline from the To/Cc header. The old positional `toNames[i]` fallback
      // naive-split `email.toNames` on "," — which shreds a display name that
      // legally contains a comma (`"VIP, Client",Bob`) and then mis-aligns with
      // the parsed addresses. The parser already surfaces inline names safely.
      if (email.toAddress) {
        parseAddressList(email.toAddress).forEach(({ name, address }) => {
          if (address) contacts.push({ email: address, name: name || null, direction: 'sent' });
        });
      }
      if (email.ccAddress) {
        parseAddressList(email.ccAddress).forEach(({ name, address }) => {
          if (address) contacts.push({ email: address, name: name || null, direction: 'sent' });
        });
      }
    }

    for (const contact of contacts) {
      if (this.isExcludedEmail(contact.email)) continue;

      this.upsertSync({
        email: contact.email,
        // A machine mailbox never wears the name of the human the notification
        // happens to be about — see contactNameForAddress.
        name: contactNameForAddress(contact.email, contact.name),
        firstSeen: emailDate,
        lastSeen: emailDate,
        sentCount: contact.direction === 'sent' ? 1 : 0,
        receivedCount: contact.direction === 'received' ? 1 : 0,
      });
    }
  }

  // ========== Sender Stats Operations ==========

  /**
   * Get sender stats by email
   */
  async getSenderStats(email: string): Promise<SenderStats | null> {
    return this.getSenderStatsSync(email);
  }

  /** Synchronous core of {@link getSenderStats} — callable inside a transaction. */
  getSenderStatsSync(email: string): SenderStats | null {
    const row = this.db
      .prepare('SELECT * FROM sender_stats WHERE email = ?')
      .get(this.normalizeEmailKey(email)) as any;

    return row ? this.rowToSenderStats(row) : null;
  }

  /**
   * Distinct sender domains, most recently heard from first — the queue the
   * sender-identity lookups (BIMI logo, favicon) work through, so the domains
   * the user actually sees get resolved first.
   */
  async getRecentSenderDomains(limit: number): Promise<string[]> {
    const rows = this.db
      .prepare(
        `SELECT domain FROM sender_stats
         WHERE domain IS NOT NULL AND domain != ''
         GROUP BY domain
         ORDER BY MAX(COALESCE(last_received, first_seen)) DESC
         LIMIT ?`,
      )
      .all(Math.max(1, Math.floor(limit))) as Array<{ domain: string }>;
    return rows.map((r) => r.domain.toLowerCase());
  }

  /**
   * Get sender stats by domain
   */
  async getSenderStatsByDomain(domain: string): Promise<SenderStats[]> {
    const rows = this.db
      .prepare('SELECT * FROM sender_stats WHERE domain = ?')
      .all(domain.toLowerCase().trim()) as any[];

    return rows.map(row => this.rowToSenderStats(row));
  }

  /**
   * SET engagement counters to absolute values (as opposed to
   * {@link upsertSenderStats}, which ADDS to them).
   *
   * For a full re-scan, which reads every email and therefore knows the true
   * totals. The additive path made re-scanning cumulative: each press of "Scan"
   * stacked another complete pass onto the stored values, so counters climbed
   * without bound and reached impossible states (read_count above
   * received_count). Writing absolutes makes a scan idempotent — run it twice
   * and the numbers are the same.
   *
   * Only the five scan-derived counters are touched. Reputation, VIP/blocked,
   * auth counts and first_seen are owned by other paths and left alone.
   * Chunked + yielding: a large mailbox can produce thousands of addresses and
   * better-sqlite3 is synchronous.
   */
  async setSenderStatsCounts(
    entries: Array<{
      email: string;
      receivedCount: number; readCount: number; deletedCount: number;
      repliedCount: number; sentToCount: number;
    }>,
  ): Promise<void> {
    if (entries.length === 0) return;
    const CHUNK = 500;
    for (let i = 0; i < entries.length; i += CHUNK) {
      const chunk = entries.slice(i, i + CHUNK);
      this.db.transaction(() => {
        for (const e of chunk) {
          const email = this.normalizeEmailKey(e.email);
          if (!email) continue;
          // Seed the row (and its domain/first_seen) if this sender is new,
          // then state the counters absolutely.
          this.upsertSenderStatsSync({ email });
          this.db.prepare(
            `UPDATE sender_stats
                SET received_count = ?, read_count = ?, deleted_count = ?,
                    replied_count = ?, sent_to_count = ?
              WHERE email = ?`,
          ).run(
            e.receivedCount, e.readCount, e.deletedCount,
            e.repliedCount, e.sentToCount, email,
          );
        }
      })();
      if (i + CHUNK < entries.length) {
        await new Promise((resolve) => setImmediate(resolve));
      }
    }
  }

  /**
   * Upsert sender stats. `eventDate` is the email's own date — pass it
   * when backfilling so last_received/last_replied/last_sent_to reflect
   * the mail, not the wall clock. Defaults to now for live actions.
   */
  async upsertSenderStats(stats: {
    email: string;
    receivedCount?: number;
    repliedCount?: number;
    sentToCount?: number;
    readCount?: number;
    deletedCount?: number;
    authPass?: boolean;
    eventDate?: number;
  }): Promise<SenderStats> {
    return this.upsertSenderStatsSync(stats);
  }

  /**
   * Synchronous core of {@link upsertSenderStats} — callable inside a
   * transaction so a batch's sender-stat updates commit once.
   */
  upsertSenderStatsSync(stats: {
    email: string;
    receivedCount?: number;
    repliedCount?: number;
    sentToCount?: number;
    readCount?: number;
    deletedCount?: number;
    authPass?: boolean;
    eventDate?: number;
  }): SenderStats {
    const now = this.now();
    const when = stats.eventDate ?? now;
    const email = this.normalizeEmailKey(stats.email);
    const domain = email.split('@')[1] || '';
    const existing = this.getSenderStatsSync(email);

    if (existing) {
      const updates: any = {};

      if (stats.receivedCount !== undefined) {
        updates.received_count = existing.receivedCount + stats.receivedCount;
        updates.last_received = Math.max(existing.lastReceived || 0, when);
      }
      if (stats.repliedCount !== undefined) {
        updates.replied_count = existing.repliedCount + stats.repliedCount;
        updates.last_replied = Math.max(existing.lastReplied || 0, when);
      }
      if (stats.sentToCount !== undefined) {
        updates.sent_to_count = existing.sentToCount + stats.sentToCount;
        updates.last_sent_to = Math.max(existing.lastSentTo || 0, when);
      }
      if (when < (existing.firstSeen || Infinity)) {
        updates.first_seen = when;
      }
      if (stats.readCount !== undefined) {
        updates.read_count = Math.max(0, existing.readCount + stats.readCount);
      }
      if (stats.deletedCount !== undefined) {
        updates.deleted_count = Math.max(0, existing.deletedCount + stats.deletedCount);
      }
      if (stats.authPass !== undefined) {
        if (stats.authPass) {
          updates.auth_pass_count = existing.authPassCount + 1;
        } else {
          updates.auth_fail_count = existing.authFailCount + 1;
        }
      }

      if (Object.keys(updates).length > 0) {
        const setClauses = Object.keys(updates).map(k => `${k} = ?`).join(', ');
        const values = Object.values(updates);
        this.db.prepare(`UPDATE sender_stats SET ${setClauses} WHERE email = ?`).run(...values, email);
      }

      return { ...existing, ...this.snakeToCamelObject(updates) };
    } else {
      const id = randomUUID();

      this.db.prepare(`
        INSERT INTO sender_stats (
          id, email, domain, received_count, replied_count, sent_to_count, read_count, deleted_count,
          first_seen, last_received, last_replied, last_sent_to,
          auth_pass_count, auth_fail_count
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id, email, domain,
        stats.receivedCount || 0, stats.repliedCount || 0, stats.sentToCount || 0,
        stats.readCount || 0, stats.deletedCount || 0,
        when,
        stats.receivedCount ? when : null,
        stats.repliedCount ? when : null,
        stats.sentToCount ? when : null,
        stats.authPass === true ? 1 : 0,
        stats.authPass === false ? 1 : 0
      );

      return {
        id, email, domain,
        receivedCount: stats.receivedCount || 0,
        repliedCount: stats.repliedCount || 0,
        sentToCount: stats.sentToCount || 0,
        readCount: stats.readCount || 0,
        deletedCount: stats.deletedCount || 0,
        firstSeen: when,
        lastReceived: stats.receivedCount ? when : null,
        lastReplied: stats.repliedCount ? when : null,
        lastSentTo: stats.sentToCount ? when : null,
        reputationScore: 0, isVip: false, isBlocked: false,
        authPassCount: stats.authPass === true ? 1 : 0,
        authFailCount: stats.authPass === false ? 1 : 0,
        createdAt: now, updatedAt: now,
      };
    }
  }

  /**
   * Set sender VIP status
   */
  async setSenderVip(email: string, isVip: boolean): Promise<void> {
    this.db.prepare('UPDATE sender_stats SET is_vip = ? WHERE email = ?')
      .run(isVip ? 1 : 0, this.normalizeEmailKey(email));
  }

  /**
   * Set sender blocked status
   */
  async setSenderBlocked(email: string, isBlocked: boolean): Promise<void> {
    this.db.prepare('UPDATE sender_stats SET is_blocked = ? WHERE email = ?')
      .run(isBlocked ? 1 : 0, this.normalizeEmailKey(email));
  }

  /**
   * Get VIP senders
   */
  async getVipSenders(): Promise<SenderStats[]> {
    const rows = this.db.prepare('SELECT * FROM sender_stats WHERE is_vip = 1').all() as any[];
    return rows.map(row => this.rowToSenderStats(row));
  }

  /**
   * Get blocked senders
   */
  async getBlockedSenders(): Promise<SenderStats[]> {
    const rows = this.db.prepare('SELECT * FROM sender_stats WHERE is_blocked = 1').all() as any[];
    return rows.map(row => this.rowToSenderStats(row));
  }

  // ========== Signature Pattern Operations ==========

  /**
   * Save signature pattern
   */
  async saveSignaturePattern(pattern: {
    email: string;
    htmlSelector: string;
    sampleHtml?: string;
    emailId?: string;
    confidence: 'high' | 'medium' | 'low';
  }): Promise<SignaturePattern> {
    const now = this.now();
    const id = randomUUID();
    const email = this.normalizeEmailKey(pattern.email);

    const existing = await this.getSignaturePatternByEmail(email);
    if (existing) {
      const emailIds = existing.emailIds;
      if (pattern.emailId && !emailIds.includes(pattern.emailId)) {
        emailIds.push(pattern.emailId);
      }

      this.db.prepare(`
        UPDATE signature_patterns
        SET html_selector = ?, sample_html = ?, email_ids = ?, confidence = ?, usage_count = usage_count + 1, last_used = ?
        WHERE email = ?
      `).run(pattern.htmlSelector, pattern.sampleHtml || existing.sampleHtml, JSON.stringify(emailIds), pattern.confidence, now, email);

      return { ...existing, htmlSelector: pattern.htmlSelector, emailIds, lastUsed: now };
    }

    const emailIds = pattern.emailId ? [pattern.emailId] : [];
    this.db.prepare(`
      INSERT INTO signature_patterns (id, email, html_selector, sample_html, email_ids, confidence, usage_count, last_used)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, email, pattern.htmlSelector, pattern.sampleHtml || null, JSON.stringify(emailIds), pattern.confidence, 1, now);

    return {
      id, email, htmlSelector: pattern.htmlSelector, sampleHtml: pattern.sampleHtml || null,
      emailIds, confidence: pattern.confidence, usageCount: 1, lastUsed: now, createdAt: now,
    };
  }

  /**
   * Get signature pattern by email
   */
  async getSignaturePatternByEmail(email: string): Promise<SignaturePattern | null> {
    const row = this.db
      .prepare('SELECT * FROM signature_patterns WHERE email = ?')
      .get(this.normalizeEmailKey(email)) as any;

    return row ? this.rowToSignaturePattern(row) : null;
  }

  /**
   * Get all signature patterns
   */
  async getSignaturePatterns(options?: { limit?: number; offset?: number }): Promise<SignaturePattern[]> {
    let sql = 'SELECT * FROM signature_patterns ORDER BY last_used DESC';
    const params: any[] = [];

    // SQLite rejects OFFSET without LIMIT ("near \"OFFSET\": syntax error"), so
    // `{ offset: 20 }` alone threw instead of paging. -1 is SQLite's "no limit",
    // which is what a caller asking only for an offset means.
    if (options?.limit || options?.offset) {
      sql += ' LIMIT ?';
      params.push(options?.limit ?? -1);
    }
    if (options?.offset) {
      sql += ' OFFSET ?';
      params.push(options.offset);
    }

    const rows = this.db.prepare(sql).all(...params) as any[];
    return rows.map(row => this.rowToSignaturePattern(row));
  }

  /**
   * Delete signature pattern
   */
  async deleteSignaturePattern(id: string): Promise<void> {
    this.db.prepare('DELETE FROM signature_patterns WHERE id = ?').run(id);
  }

  // Snooze operations moved to sqlite-storage.ts (uses tags on emails table directly)

  // ========== Sender Context Batch ==========

  /**
   * Get sender context for a batch of email addresses.
   * Joins contacts and sender_stats tables for a complete picture.
   */
  getSenderContextBatch(emails: string[]): Record<string, SenderContext> {
    if (emails.length === 0) return {};

    const placeholders = emails.map(() => '?').join(', ');
    const lowered = emails.map(e => e.toLowerCase().trim());

    // SQLite doesn't support FULL OUTER JOIN, so use LEFT JOIN + UNION for sender_stats-only rows
    const rows = this.db.prepare(`
      SELECT
        c.email as email,
        COALESCE(c.email_count, 0) as email_count,
        COALESCE(c.sent_count, 0) as c_sent_count,
        COALESCE(c.received_count, 0) as c_received_count,
        COALESCE(c.is_favorite, 0) as is_favorite,
        COALESCE(ss.replied_count, 0) as replied_count,
        COALESCE(ss.sent_to_count, 0) as sent_to_count,
        COALESCE(ss.read_count, 0) as read_count,
        COALESCE(ss.deleted_count, 0) as deleted_count,
        COALESCE(ss.is_vip, 0) as is_vip,
        COALESCE(ss.is_blocked, 0) as is_blocked,
        ss.last_replied as last_replied,
        ss.last_sent_to as last_sent_to
      FROM ${CONTACTS} c
      LEFT JOIN sender_stats ss ON LOWER(ss.email) = LOWER(c.email)
      WHERE LOWER(c.email) IN (${placeholders})
      UNION ALL
      SELECT
        ss2.email as email,
        0 as email_count,
        0 as c_sent_count,
        COALESCE(ss2.received_count, 0) as c_received_count,
        0 as is_favorite,
        COALESCE(ss2.replied_count, 0) as replied_count,
        COALESCE(ss2.sent_to_count, 0) as sent_to_count,
        COALESCE(ss2.read_count, 0) as read_count,
        COALESCE(ss2.deleted_count, 0) as deleted_count,
        COALESCE(ss2.is_vip, 0) as is_vip,
        COALESCE(ss2.is_blocked, 0) as is_blocked,
        ss2.last_replied as last_replied,
        ss2.last_sent_to as last_sent_to
      FROM sender_stats ss2
      WHERE LOWER(ss2.email) IN (${placeholders})
        AND NOT EXISTS (SELECT 1 FROM ${CONTACTS} c2 WHERE LOWER(c2.email) = LOWER(ss2.email))
    `).all(...lowered, ...lowered) as any[];

    const result: Record<string, SenderContext> = {};

    for (const row of rows) {
      const email = (row.email || '').toLowerCase();
      const isFavorite = row.is_favorite === 1;
      const isVip = row.is_vip === 1;
      const isBlocked = row.is_blocked === 1;
      const sentCount = row.c_sent_count || 0;
      const receivedCount = row.c_received_count || 0;

      let tier: SenderContext['tier'];
      if (isBlocked) {
        tier = 'blocked';
      } else if (isVip || isFavorite) {
        tier = 'vip';
      } else if (sentCount >= 5) {
        tier = 'frequent';
      } else if (receivedCount >= 5) {
        tier = 'known';
      } else if (receivedCount >= 2) {
        tier = 'occasional';
      } else {
        tier = 'first-time';
      }

      result[email] = {
        emailCount: row.email_count || 0,
        sentCount,
        receivedCount,
        repliedCount: row.replied_count || 0,
        sentToCount: row.sent_to_count || 0,
        readCount: row.read_count || 0,
        deletedCount: row.deleted_count || 0,
        lastReplied: row.last_replied || undefined,
        lastSentTo: row.last_sent_to || undefined,
        isFavorite,
        isVip,
        isBlocked,
        tier,
      };
    }

    // Fill in missing entries as first-time
    for (const email of lowered) {
      if (!result[email]) {
        result[email] = {
          emailCount: 0, sentCount: 0, receivedCount: 0,
          repliedCount: 0, sentToCount: 0, readCount: 0, deletedCount: 0,
          isFavorite: false, isVip: false, isBlocked: false,
          tier: 'first-time',
        };
      }
    }

    // Windowed (90d) stats — cheap enough to run in one pass over
    // user_action_log + emails with an IN filter on the caller-supplied
    // address list. Aggregated into result[email].recent so the prompt
    // builder can prefer recent behavior over lifetime averages.
    try {
      const WINDOW_DAYS = 90;
      const since = Math.floor(Date.now() / 1000) - WINDOW_DAYS * 86400;

      // Received (from emails table by from_address)
      const recvRows = this.db.prepare(`
        SELECT LOWER(from_address) AS email, COUNT(*) AS received
        FROM emails
        WHERE LOWER(from_address) IN (${placeholders})
          AND date >= ?
        GROUP BY LOWER(from_address)
      `).all(...lowered, since) as { email: string; received: number }[];

      // Actions (from user_action_log by sender_address + action_type)
      const actRows = this.db.prepare(`
        SELECT sender_address AS email, action_type AS action, COUNT(*) AS n
        FROM user_action_log
        WHERE sender_address IN (${placeholders})
          AND timestamp >= ?
        GROUP BY sender_address, action_type
      `).all(...lowered, since) as { email: string; action: string; n: number }[];

      const recvMap = new Map<string, number>();
      for (const r of recvRows) recvMap.set(r.email, r.received || 0);

      const byEmail = new Map<string, { read: number; deleted: number; replied: number }>();
      for (const a of actRows) {
        const e = (a.email || '').toLowerCase();
        const cur = byEmail.get(e) || { read: 0, deleted: 0, replied: 0 };
        if (a.action === 'read') cur.read += a.n;
        else if (a.action === 'delete') cur.deleted += a.n;
        else if (a.action === 'reply') cur.replied += a.n;
        byEmail.set(e, cur);
      }

      for (const email of lowered) {
        const rec = byEmail.get(email);
        const received = recvMap.get(email) || 0;
        // Only attach `recent` when there's at least one windowed signal —
        // avoids noisy "recent: 0/0/0" for every first-time sender.
        if (received > 0 || rec) {
          result[email].recent = {
            windowDays: WINDOW_DAYS,
            receivedCount: received,
            readCount: rec?.read || 0,
            deletedCount: rec?.deleted || 0,
            repliedCount: rec?.replied || 0,
          };
        }
      }
    } catch {
      // Windowed stats are best-effort. Lifetime counters still flow.
    }

    return result;
  }

  // ========== Row Converters ==========

  private rowToContactRecord(row: any): ContactRecord {
    return {
      id: row.id, email: row.email, name: row.name, displayName: row.display_name,
      avatarUrl: row.avatar_url, avatarStatus: row.avatar_status ?? null, avatarCheckedAt: row.avatar_checked_at ?? null,
      organization: row.organization, title: row.title, phone: row.phone,
      firstSeen: row.first_seen, lastSeen: row.last_seen, emailCount: row.email_count,
      sentCount: row.sent_count, receivedCount: row.received_count, isFavorite: row.is_favorite === 1,
      notes: row.notes, tags: this.parseJsonField(row.tags, []), metadata: this.parseJsonField(row.metadata, {}),
      // Agent classification columns (may be null on contacts that haven't been classified yet)
      contactType: row.contact_type || null,
      contactTypeConfidence: typeof row.contact_type_confidence === 'number' ? row.contact_type_confidence : null,
      contactTypeSource: row.contact_type_source || null,
      // Enrichment columns (v39). `kind` is NOT NULL with default 'individual'
      // so older rows read back fine; the rest are nullable on untouched rows.
      kind: (row.kind === 'company' ? 'company' : 'individual'),
      personId: row.person_id || null,
      companyContactId: row.company_contact_id || null,
      mobileE164: row.mobile_e164 || null,
      enrichment: row.enrichment ? (this.parseJsonField(row.enrichment, null) as ContactEnrichment | null) : null,
      enrichedThroughEmailAt: typeof row.enriched_through_email_at === 'number' ? row.enriched_through_email_at : null,
      enrichmentSource: (row.enrichment_source === 'user' || row.enrichment_source === 'llm') ? row.enrichment_source : null,
      createdAt: row.created_at, updatedAt: row.updated_at,
    };
  }

  // ========== Enrichment Operations ==========

  /**
   * Contacts eligible for automated enrichment. Eligibility is
   * data-driven: a contact qualifies when it has received mail more
   * recently than the last enrichment watermark, OR has never been
   * enriched and has any incoming mail. The 90-day re-enrich cadence
   * in the scheduler is checked against `enriched_through_email_at`,
   * NOT `Date.now()`, so untouched-but-stale contacts aren't re-run.
   *
   * Only `kind = 'individual'` is returned — auto-synthesized company
   * rows don't have signatures to mine.
   */
  async getEnrichmentCandidates(opts: {
    minAgeDays?: number;    // e.g. 90 — only re-enrich if last run is this old
    limit?: number;
  } = {}): Promise<EnrichmentCandidate[]> {
    const minAgeSec = (opts.minAgeDays ?? 0) * 86400;
    const limit = opts.limit ?? 1000;

    const rows = this.db.prepare(SQL_ENRICHMENT_CANDIDATES).all(minAgeSec, limit) as Array<{
      id: string;
      email: string;
      kind: string;
      enriched_through_email_at: number | null;
      newest_email_at: number;
    }>;

    return rows.map((r) => ({
      id: r.id,
      email: r.email,
      kind: (r.kind === 'company' ? 'company' : 'individual'),
      enrichedThroughEmailAt: r.enriched_through_email_at,
      newestEmailAt: r.newest_email_at,
    }));
  }

  /**
   * Find contact rows with a matching normalized mobile number. Used
   * by the identity resolver — if two contact rows share a mobile,
   * they're the same human and should share a `person_id`.
   */
  async findContactsByMobile(mobileE164: string, excludeContactId?: string): Promise<ContactRecord[]> {
    const rows = excludeContactId
      ? this.db.prepare(`SELECT * FROM ${CONTACTS} WHERE mobile_e164 = ? AND id != ?`).all(mobileE164, excludeContactId)
      : this.db.prepare(`SELECT * FROM ${CONTACTS} WHERE mobile_e164 = ?`).all(mobileE164);
    return (rows as any[]).map((row) => this.rowToContactRecord(row));
  }

  /**
   * Find-or-create a company contact for a given domain. Called during
   * enrichment when the LLM identifies the employer — we synthesize a
   * `kind='company'` row keyed on the domain so individuals can link
   * to it via `company_contact_id`. The synthetic email is
   * `company@<domain>`; we don't ever send mail to that address.
   */
  async upsertCompany(params: {
    domain: string;
    name?: string | null;
    website?: string | null;
  }): Promise<ContactRecord> {
    return this.upsertCompanySync(params);
  }

  /**
   * Synchronous core of upsertCompany so applyEnrichment can call it
   * from inside a better-sqlite3 transaction (which must not await).
   */
  private upsertCompanySync(params: {
    domain: string;
    name?: string | null;
    website?: string | null;
  }): ContactRecord {
    const domain = params.domain.toLowerCase().trim();
    const syntheticEmail = `company@${domain}`;

    // Prefer lookup by synthetic email (exact match) — any pre-existing
    // company with that key is the right target.
    const existingRow = this.db.prepare(`SELECT * FROM ${CONTACTS} WHERE email = ?`).get(syntheticEmail) as any;
    if (existingRow) {
      const existing = this.rowToContactRecord(existingRow);
      if (params.name && !existing.organization) {
        this.db.prepare(`UPDATE ${CONTACTS} SET organization = ? WHERE id = ?`).run(params.name, existing.id);
        return { ...existing, organization: params.name };
      }
      return existing;
    }

    const now = this.now();
    const id = randomUUID();
    const enrichment: ContactEnrichment = {
      companyName: params.name || null,
      companyDomain: domain,
      companyWebsite: params.website || null,
    };

    this.db.prepare(`
      INSERT INTO ${CONTACTS} (
        id, email, name, organization, first_seen, last_seen,
        email_count, sent_count, received_count,
        is_favorite, tags, metadata,
        kind, enrichment, enrichment_source, enriched_through_email_at,
        created_at, updated_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?, 0, 0, 0, 0, '[]', '{}', 'company', ?, 'llm', ?, ?, ?
      )
    `).run(
      id, syntheticEmail, params.name || domain, params.name || null,
      now, now, JSON.stringify(enrichment), now, now, now,
    );

    const createdRow = this.db.prepare(`SELECT * FROM ${CONTACTS} WHERE id = ?`).get(id) as any;
    if (!createdRow) throw new Error('Failed to create company contact');
    return this.rowToContactRecord(createdRow);
  }

  /**
   * Apply enrichment results to a contact: merges the enrichment blob,
   * resolves identity via mobile, links to or creates a company row,
   * and appends a history record. Runs inside a single transaction so
   * the history row and the current-state update can't drift.
   */
  async applyEnrichment(input: ApplyEnrichmentInput): Promise<ContactRecord> {
    const now = this.now();
    const contact = await this.get(input.contactId);
    if (!contact) throw new Error(`Contact not found: ${input.contactId}`);

    const source = input.source ?? 'llm';
    const enrichment = input.enrichment;

    // Role/generic mailboxes (info@, sales@, hr@, accounts@…) are a
    // company's functional address, never a person — so they must never
    // acquire a person_id or a personal mobile (which would merge every
    // colleague who shares the company switchboard into one "person").
    // Company-level enrichment (domain/org/history) still proceeds.
    const isRole = isRoleAddress(contact.email);
    const newMobile = isRole ? null : (input.mobileE164 ?? contact.mobileE164 ?? null);

    // Resolve async lookups up front — the write transaction below must
    // be synchronous (better-sqlite3).
    const mobileMatches = newMobile ? await this.findContactsByMobile(newMobile, contact.id) : [];

    this.db.transaction(() => {
      // --- Identity resolution: if mobile matches another contact, they
      // share a person_id. Pick whichever non-null id already exists, or
      // mint a fresh one. Role mailboxes never get a person identity.
      let personId: string | null = isRole ? null : (contact.personId ?? null);
      if (newMobile) {
        const existingPersonId = mobileMatches.find((m) => m.personId)?.personId ?? null;
        personId = personId || existingPersonId || randomUUID();

        // Backfill person_id onto any matches missing it so the whole
        // group reconverges on a single id.
        for (const m of mobileMatches) {
          if (!m.personId) {
            this.db.prepare(`UPDATE ${CONTACTS} SET person_id = ?, updated_at = ? WHERE id = ?`)
              .run(personId, now, m.id);
          }
        }
      }

      // --- Company linkage: if LLM gave us a company domain, find-or-create
      // the company contact and link.
      // Guard against a hallucinated free/public provider (e.g. the LLM
      // returning companyDomain: "gmail.com"). Treating a public mail
      // domain as a company would link every Gmail/Outlook/… sender into
      // one synthetic "company" and mark them all as colleagues. Enforced
      // here (server-side, authoritative) — not just in the prompt.
      const companyDomain =
        enrichment.companyDomain && PUBLIC_DOMAINS.has(enrichment.companyDomain.toLowerCase())
          ? null
          : (enrichment.companyDomain ?? null);
      // Persist the sanitized value so the stored blob/history never keeps a
      // free-provider domain either.
      enrichment.companyDomain = companyDomain;
      let companyContactId: string | null = contact.companyContactId ?? null;
      if (companyDomain) {
        const company = this.upsertCompanySync({
          domain: companyDomain,
          name: enrichment.companyName,
          website: enrichment.companyWebsite,
        });
        companyContactId = company.id;
      }

      // --- Close out any open history row if the company or designation
      // changed (job switch).
      const prevOpen = this.db.prepare(`
        SELECT * FROM ${ENRICHMENT_HISTORY}
        WHERE contact_id = ? AND effective_to IS NULL
        ORDER BY effective_from DESC LIMIT 1
      `).get(contact.id) as any;

      const designation = enrichment.designation ?? contact.title ?? null;
      const organization = enrichment.companyName ?? contact.organization ?? null;

      const isJobSwitch =
        prevOpen &&
        (
          prevOpen.company_contact_id !== companyContactId ||
          (prevOpen.designation || null) !== (designation || null) ||
          (prevOpen.organization || null) !== (organization || null)
        );

      if (prevOpen && isJobSwitch) {
        this.db.prepare(`UPDATE ${ENRICHMENT_HISTORY} SET effective_to = ? WHERE id = ?`)
          .run(now, prevOpen.id);
      }

      // --- Insert new history row if this is the first enrichment or a change.
      if (!prevOpen || isJobSwitch) {
        this.db.prepare(`
          INSERT INTO ${ENRICHMENT_HISTORY}
            (id, contact_id, person_id, enrichment, company_contact_id,
             designation, organization, effective_from, source, source_email_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          randomUUID(), contact.id, personId,
          JSON.stringify(enrichment), companyContactId,
          designation, organization,
          input.enrichedThroughEmailAt, source, input.sourceEmailId ?? null,
        );
      } else {
        // Same employer/role — just refresh the snapshot on the open row.
        this.db.prepare(`
          UPDATE ${ENRICHMENT_HISTORY}
          SET enrichment = ?, effective_from = ?
          WHERE id = ?
        `).run(JSON.stringify(enrichment), input.enrichedThroughEmailAt, prevOpen.id);
      }

      // --- Update current-state columns on the contact row. `title` and
      // `organization` mirror the enrichment so the existing UI surfaces
      // them without knowing about the blob.
      // `name` comes from the From display name, which is often absent — the
      // contact is then stuck showing a capitalised local part ("Pkh") while
      // every mail they send signs off with their real name. Adopt the
      // signature name, but ONLY over a placeholder: an empty name, or one that
      // is just the local part. A genuine display name the sender chose for
      // themselves always wins over the LLM's reading of a signature.
      const localPart = (contact.email.split('@')[0] || '').toLowerCase();
      const currentName = (contact.name || '').trim();
      const nameIsPlaceholder =
        currentName === '' ||
        currentName.toLowerCase() === localPart ||
        currentName.toLowerCase() === this.normalizeEmailKey(contact.email);
      const signatureName = (enrichment.fullName || '').trim();
      const newName = nameIsPlaceholder && signatureName ? signatureName : null;

      this.db.prepare(`
        UPDATE ${CONTACTS} SET
          kind = COALESCE(?, kind),
          person_id = ?,
          company_contact_id = ?,
          mobile_e164 = ?,
          enrichment = ?,
          enriched_through_email_at = ?,
          enrichment_source = ?,
          name = COALESCE(?, name),
          title = COALESCE(?, title),
          organization = COALESCE(?, organization),
          phone = COALESCE(?, phone),
          updated_at = ?
        WHERE id = ?
      `).run(
        input.kind ?? null,
        personId,
        companyContactId,
        newMobile,
        JSON.stringify(enrichment),
        input.enrichedThroughEmailAt,
        source,
        newName,
        designation,
        organization,
        enrichment.companyPhone || enrichment.personalPhone || null,
        now,
        contact.id,
      );
    })();

    const updated = await this.get(contact.id);
    if (!updated) throw new Error('Contact vanished during enrichment');
    return updated;
  }

  /**
   * Record an enrichment attempt that produced no change. Bumps the
   * watermark so the scheduler doesn't re-scan the same emails next
   * tick. Written as an UPDATE only — no history row.
   */
  async recordEnrichmentWatermark(contactId: string, throughEmailAt: number): Promise<void> {
    const now = this.now();
    this.db.prepare(`
      UPDATE ${CONTACTS} SET enriched_through_email_at = ?, updated_at = ?
      WHERE id = ?
    `).run(throughEmailAt, now, contactId);
  }

  // ========== Confirm-gated avatars ==========

  /** Store a discovered candidate photo (a data: URI) awaiting user review. */
  async setAvatarCandidate(contactId: string, dataUri: string): Promise<void> {
    const now = this.now();
    this.db.prepare(`
      UPDATE ${CONTACTS} SET avatar_url = ?, avatar_status = 'pending', avatar_checked_at = ?, updated_at = ?
      WHERE id = ?
    `).run(dataUri, now, now, contactId);
  }

  /** User approved the candidate — show it everywhere. */
  async confirmAvatar(contactId: string): Promise<void> {
    const now = this.now();
    this.db.prepare(`
      UPDATE ${CONTACTS} SET avatar_status = 'confirmed', updated_at = ?
      WHERE id = ?
    `).run(now, contactId);
  }

  /**
   * Record that discovery checked this contact but found NO photo — stamps
   * avatar_checked_at (status stays NULL) so it's skipped until it goes stale
   * and gets one more chance later.
   */
  async markAvatarChecked(contactId: string): Promise<void> {
    const now = this.now();
    this.db.prepare(`UPDATE ${CONTACTS} SET avatar_checked_at = ?, updated_at = ? WHERE id = ?`)
      .run(now, now, contactId);
  }

  /** User declined — drop the photo, keep initials, and don't re-suggest it. */
  async rejectAvatar(contactId: string): Promise<void> {
    const now = this.now();
    this.db.prepare(`
      UPDATE ${CONTACTS} SET avatar_url = NULL, avatar_status = 'rejected', avatar_checked_at = ?, updated_at = ?
      WHERE id = ?
    `).run(now, now, contactId);
  }

  /**
   * Contacts that still need a background avatar lookup: never checked
   * (avatar_status IS NULL) and either never probed or probed before
   * `staleBefore`. Excludes confirmed/rejected/pending. (Used by Phase-2 discovery.)
   */
  async getContactsNeedingAvatar(limit: number, staleBefore: number): Promise<ContactRecord[]> {
    const rows = this.db.prepare(`
      SELECT * FROM ${CONTACTS}
      WHERE avatar_status IS NULL
        AND email IS NOT NULL AND email != ''
        AND (avatar_checked_at IS NULL OR avatar_checked_at < ?)
      ORDER BY last_seen DESC
      LIMIT ?
    `).all(staleBefore, limit) as any[];
    return rows.map((r) => this.rowToContactRecord(r));
  }

  /**
   * History for a contact — newest first. Includes closed rows so the
   * UI can render a "previously at …" timeline.
   */
  async getEnrichmentHistory(contactId: string): Promise<ContactEnrichmentHistoryRecord[]> {
    const rows = this.db.prepare(`
      SELECT * FROM ${ENRICHMENT_HISTORY}
      WHERE contact_id = ?
      ORDER BY effective_from DESC
    `).all(contactId) as any[];

    return rows.map((r) => ({
      id: r.id,
      contactId: r.contact_id,
      personId: r.person_id || null,
      enrichment: this.parseJsonField(r.enrichment, {}) as ContactEnrichment,
      companyContactId: r.company_contact_id || null,
      designation: r.designation || null,
      organization: r.organization || null,
      effectiveFrom: r.effective_from,
      effectiveTo: r.effective_to || null,
      source: (r.source === 'user' ? 'user' : 'llm'),
      sourceEmailId: r.source_email_id || null,
      createdAt: r.created_at,
    }));
  }

  /**
   * Contact rows that share a `person_id` with the given contact.
   * Excludes the contact itself. Used to show the "also known as" /
   * "previous emails" section on the detail view when someone has
   * changed jobs.
   */
  async getRelatedByPerson(contactId: string): Promise<ContactRecord[]> {
    const row = this.db.prepare(`SELECT person_id FROM ${CONTACTS} WHERE id = ?`).get(contactId) as any;
    if (!row?.person_id) return [];
    const rows = this.db.prepare(`
      SELECT * FROM ${CONTACTS} WHERE person_id = ? AND id != ?
    `).all(row.person_id, contactId) as any[];
    return rows.map((r) => this.rowToContactRecord(r));
  }

  /**
   * Recent received emails from a contact, used as the LLM enrichment
   * source. Returns raw EmailRecord shape so the caller can feed
   * subject/body/html into signature regexing.
   */
  async getRecentInboundEmails(email: string, limit = 20): Promise<EmailRecord[]> {
    const rows = this.db.prepare(`
      SELECT ${this.emailSelect()} FROM emails
      WHERE LOWER(from_address) = LOWER(?)
      ORDER BY date DESC
      LIMIT ?
    `).all(email, limit) as any[];
    // Delegate row→record conversion to storage-level helper by returning
    // the shape the AgentRepository already consumes. Callers accept the
    // raw row via an "as EmailRecord" when they only need a few fields.
    return rows as unknown as EmailRecord[];
  }

  /**
   * Newest inbound email date already mined for each contact, plus the numbers
   * that mining produced. Lets a scan skip contacts with no newer mail while
   * still feeding their numbers into the domain-wide frequency test.
   */
  getPhoneMiningState(): Map<string, { through: number; phones: Record<string, number> }> {
    const rows = this.db.prepare(
      `SELECT LOWER(email) AS email, phones_mined_through, phones_mined
         FROM ${CONTACTS}
        WHERE phones_mined_through IS NOT NULL`,
    ).all() as Array<{ email: string; phones_mined_through: number; phones_mined: string | null }>;
    const out = new Map<string, { through: number; phones: Record<string, number> }>();
    for (const r of rows) {
      let phones: Record<string, number> = {};
      try { if (r.phones_mined) phones = JSON.parse(r.phones_mined); } catch { phones = {}; }
      out.set(r.email, { through: r.phones_mined_through, phones });
    }
    return out;
  }

  /** Newest email date per sender address — drives the incremental skip. */
  getNewestEmailDateBySender(): Map<string, number> {
    const rows = this.db.prepare(
      'SELECT LOWER(from_address) AS email, MAX(date) AS newest FROM emails WHERE from_address IS NOT NULL GROUP BY LOWER(from_address)',
    ).all() as Array<{ email: string; newest: number }>;
    return new Map(rows.map((r) => [r.email, r.newest || 0]));
  }

  /** Record what mining saw for a contact, so the next scan can skip them. */
  setPhoneMiningState(email: string, through: number, phones: Record<string, number>): void {
    this.db.prepare(
      `UPDATE ${CONTACTS} SET phones_mined_through = ?, phones_mined = ? WHERE LOWER(email) = LOWER(?)`,
    ).run(through, JSON.stringify(phones), email);
  }

  /**
   * Merge deterministically-classified phones into a contact's enrichment blob
   * (companyPhone = shared office line, personalPhone = the person's own
   * number). Written by the cross-domain phone classifier during a scan; these
   * fields are authoritative, so the LLM enricher preserves them rather than
   * overwriting with its own guess.
   */
  applyPhoneClassification(
    email: string,
    officePhone: string | null,
    directPhone: string | null,
    linkedinUrl: string | null = null,
  ): void {
    const row = this.db
      .prepare(`SELECT id, enrichment, phone FROM ${CONTACTS} WHERE LOWER(email) = LOWER(?)`)
      .get(email) as { id: string; enrichment: string | null; phone: string | null } | undefined;
    if (!row) return;
    let enrichment: Record<string, unknown> = {};
    try { if (row.enrichment) enrichment = JSON.parse(row.enrichment); } catch { enrichment = {}; }
    // The classifier is authoritative for phones — fully OWN both fields,
    // writing null when it found nothing. Otherwise a stale value (an old
    // LLM guess, a wrong number) would linger when the new result is null.
    enrichment.companyPhone = officePhone || null;
    enrichment.personalPhone = directPhone || null;
    // LinkedIn is ADDITIVE — only set when the scan found a profile, so we
    // never clobber an existing (LLM-found) URL with null.
    if (linkedinUrl) enrichment.linkedinUrl = linkedinUrl;
    const phone = directPhone || officePhone || null;
    this.db
      .prepare(`UPDATE ${CONTACTS} SET enrichment = ?, phone = ?, updated_at = ? WHERE id = ?`)
      .run(JSON.stringify(enrichment), phone, Math.floor(Date.now() / 1000), row.id);
  }

  /**
   * Set a contact's LinkedIn profile URL WITHOUT touching phone fields — for a
   * contact the scan found a LinkedIn for but no phone (applyPhoneClassification
   * would otherwise null out their phones).
   */
  applyLinkedInUrl(email: string, url: string): void {
    if (!url) return;
    const row = this.db
      .prepare(`SELECT id, enrichment FROM ${CONTACTS} WHERE LOWER(email) = LOWER(?)`)
      .get(email) as { id: string; enrichment: string | null } | undefined;
    if (!row) return;
    let enrichment: Record<string, unknown> = {};
    try { if (row.enrichment) enrichment = JSON.parse(row.enrichment); } catch { enrichment = {}; }
    enrichment.linkedinUrl = url;
    this.db
      .prepare(`UPDATE ${CONTACTS} SET enrichment = ?, updated_at = ? WHERE id = ?`)
      .run(JSON.stringify(enrichment), Math.floor(Date.now() / 1000), row.id);
  }

  /** Merge PERSONAL (sender-unique) Twitter/website/social URLs into a contact's
   *  enrichment. Additive — only sets a field when a value was found. Written by
   *  the cross-domain URL classifier (classifyDomainUrls). */
  applyPersonalUrls(email: string, urls: { twitter?: string | null; website?: string | null; socials?: string[] }): void {
    this.mergeUrlsIntoEnrichment('LOWER(email) = LOWER(?)', [email], urls);
  }

  /** Merge ORG (domain-shared) URLs onto the per-domain company record — the one
   *  place org-level social/web links live (each member's card inherits them).
   *  Creates the company row if it doesn't exist yet. */
  applyCompanyUrls(domain: string, urls: { twitter?: string | null; website?: string | null; socials?: string[] }): void {
    const d = (domain || '').toLowerCase().trim();
    if (!d) return;
    if (!urls.twitter && !urls.website && !(urls.socials && urls.socials.length)) return;
    const company = this.upsertCompanySync({ domain: d, website: urls.website ?? null });
    this.mergeUrlsIntoEnrichment('id = ?', [company.id], urls);
  }

  private mergeUrlsIntoEnrichment(
    whereClause: string,
    params: unknown[],
    urls: { twitter?: string | null; website?: string | null; socials?: string[] },
  ): void {
    const row = this.db
      .prepare(`SELECT id, enrichment FROM ${CONTACTS} WHERE ${whereClause}`)
      .get(...params) as { id: string; enrichment: string | null } | undefined;
    if (!row) return;
    let e: Record<string, any> = {};
    try { if (row.enrichment) e = JSON.parse(row.enrichment); } catch { e = {}; }
    if (urls.twitter) e.twitterUrl = urls.twitter;
    if (urls.website) e.companyWebsite = urls.website;
    if (urls.socials && urls.socials.length) {
      const existing: Array<{ platform: string; url: string }> = Array.isArray(e.otherSocials) ? e.otherSocials : [];
      const seen = new Set(existing.map((s) => s.url));
      for (const url of urls.socials) {
        if (seen.has(url)) continue;
        seen.add(url);
        existing.push({ platform: socialPlatformOf(url), url });
      }
      e.otherSocials = existing;
    }
    this.db
      .prepare(`UPDATE ${CONTACTS} SET enrichment = ?, updated_at = ? WHERE id = ?`)
      .run(JSON.stringify(e), Math.floor(Date.now() / 1000), row.id);
  }

  private rowToSenderStats(row: any): SenderStats {
    return {
      id: row.id, email: row.email, domain: row.domain, receivedCount: row.received_count,
      repliedCount: row.replied_count, sentToCount: row.sent_to_count,
      readCount: row.read_count || 0, deletedCount: row.deleted_count || 0,
      firstSeen: row.first_seen,
      lastReceived: row.last_received, lastReplied: row.last_replied, lastSentTo: row.last_sent_to,
      reputationScore: row.reputation_score, isVip: row.is_vip === 1, isBlocked: row.is_blocked === 1,
      authPassCount: row.auth_pass_count, authFailCount: row.auth_fail_count,
      createdAt: row.created_at, updatedAt: row.updated_at,
    };
  }

  private rowToSignaturePattern(row: any): SignaturePattern {
    return {
      id: row.id, email: row.email, htmlSelector: row.html_selector, sampleHtml: row.sample_html,
      emailIds: this.parseJsonField(row.email_ids, []), confidence: row.confidence,
      usageCount: row.usage_count, lastUsed: row.last_used, createdAt: row.created_at,
    };
  }

}
