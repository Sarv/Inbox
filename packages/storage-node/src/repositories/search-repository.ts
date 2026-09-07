// Search Repository — FTS5-powered full-text search with relevance ranking

import type { EmailRecord, SearchQuery } from '@sarvinbox/core';
import { createLogger } from '@sarvinbox/core';

import { applyFtsSchema, FTS_REBUILD_SQL } from '../fts-schema';

import { BaseRepository, type DatabaseAccessor } from './base-repository';
import { rawBodyLengthExpression } from './body-metrics';
import { cleanBodyExpression } from './body-storage';
import { THREAD_META_SHARED } from './thread-sql';

const logger = createLogger('search-repository');

/** Whitelisted sort columns (snake_case) — sortBy is interpolated into SQL */
const SEARCH_SORT_COLUMNS = new Set([
  'date', 'received_date', 'subject', 'from_address',
  'importance_score', 'priority_score', 'created_at', 'updated_at',
]);

/** Thread metadata subqueries — shared with email-repository via thread-sql. */
const THREAD_META = THREAD_META_SHARED;

/**
 * Repository for FTS5-powered search
 */
export class SearchRepository extends BaseRepository {
  private rowToRecord: (row: any) => EmailRecord;

  constructor(getDb: DatabaseAccessor, rowToRecord: (row: any) => EmailRecord) {
    super(getDb);
    this.rowToRecord = rowToRecord;
  }

  /**
   * Initialize FTS5 table and triggers. Called during migration.
   *
   * The DDL lives in `fts-schema.ts`, not here. This method used to carry its
   * own copy created with `CREATE TRIGGER IF NOT EXISTS`, which meant a database
   * missing one trigger got the PRE-relocation shape recreated at runtime,
   * behind migration 73's back — reading `emails.clean_body`, which is NULL once
   * a row's body has moved. Mail would keep arriving and quietly stop being
   * findable.
   */
  initializeFTS(): void {
    applyFtsSchema(this.db);
  }

  /**
   * Backfill FTS index from existing emails.
   *
   * Reads bodies through `email_bodies` (see FTS_REBUILD_SQL) — a rebuild off the
   * inline column would replace a working index with a body-less one on any
   * relocated database, which is the most destructive version of this bug: it
   * discards the index that was still correct.
   */
  rebuildIndex(): void {
    logger.info('[SearchRepo] Rebuilding FTS index...');
    // Delete all FTS data first
    try {
      this.db.exec(`DELETE FROM emails_fts;`);
    } catch {
      // Table may not exist yet
    }

    this.db.exec(FTS_REBUILD_SQL);

    const count = (this.db.prepare('SELECT COUNT(*) as cnt FROM emails_fts').get() as any).cnt;
    logger.info(`[SearchRepo] FTS index rebuilt with ${count} entries`);
  }

  /**
   * Check if FTS index is populated
   */
  isFTSPopulated(): boolean {
    try {
      const result = this.db.prepare('SELECT COUNT(*) as cnt FROM emails_fts').get() as any;
      return result.cnt > 0;
    } catch {
      return false;
    }
  }

  /** SQL fragment to exclude special folders */
  private getExcludeSpecialFolders(currentFolderPath?: string): string {
    const exclusions = [
      'Trash', 'Spam', 'Drafts', 'Sent',
      '[Gmail]/Trash', '[Gmail]/Spam', '[Gmail]/Drafts', '[Gmail]/Sent Mail',
      'Junk', 'Junk Email', 'Deleted Items', 'Sent Items',
    ];
    return exclusions
      .filter(f => f !== currentFolderPath)
      .map(f => `AND instr(emails.tags, '|${f}|') = 0`)
      .join('\n      ');
  }

  /**
   * Escape FTS5 query special characters.
   *
   * FTS5 parses these chars as operators/syntax: " ( ) : * . , { } [ ] ^ ~ +
   * plus AND/OR/NOT/NEAR keywords. LLM-generated queries (from the reply
   * drafter) frequently contain slashes, dashes, quotes, etc. — so we strip
   * everything that isn't alphanumeric or whitespace before wrapping each
   * remaining token as an exact-match phrase.
   */
  private escapeFTSQuery(query: string): string {
    const escaped = query
      .replace(/[^A-Za-z0-9\s]/g, ' ')   // strip punctuation / FTS operators
      .replace(/\bAND\b/gi, '')
      .replace(/\bOR\b/gi, '')
      .replace(/\bNOT\b/gi, '')
      .replace(/\bNEAR\b/gi, '')
      .replace(/\s+/g, ' ')
      .trim();

    if (!escaped) return '';

    const words = escaped.split(/\s+/).filter(w => w.length > 0);
    if (words.length === 0) return '';

    // PREFIX-match each token (FTS5 `term*`) joined with implicit AND, so a
    // partial word like "overt" matches "overtime"/"overtake" — what the search
    // suggestions already imply. Exact quoted phrases ("overt") only matched the
    // literal token and returned nothing for a partial word. Tokens are already
    // stripped to [A-Za-z0-9], so appending * can't inject an FTS operator.
    //
    // EXCEPT a single character, which is never prefixed. `a*` matches nearly
    // every token in the vocabulary, so at 100k emails FTS hands back a
    // candidate set of essentially the whole mailbox, which then has to be
    // sorted and have a page of bodies read off it — the one query shape here
    // that scales with mailbox size instead of with match count. A one-letter
    // prefix is also the least useful: it cannot narrow anything. Matching it
    // exactly keeps the query bounded to a single posting list.
    return words.map(w => (w.length > 1 ? `${w}*` : w)).join(' ');
  }

  /**
   * Search emails using FTS5 with relevance ranking
   */
  search(query: SearchQuery): EmailRecord[] {
    const textQuery = query.query?.trim();
    const useFTS = textQuery && textQuery.length > 0;

    let sql: string;
    const params: any[] = [];

    if (useFTS) {
      const ftsQuery = this.escapeFTSQuery(textQuery);

      if (!ftsQuery) {
        // FTS query was empty after escaping, fall back to LIKE
        return this.searchWithLike(query);
      }

      // bm25 weights: email_id(0) > subject(10) > from_address(5) > from_name(3) > to(3) > cc(2) > attachments(2) > body(1)
      sql = `
        SELECT ${this.emailSelect()}, ${THREAD_META},
               bm25(emails_fts, 0, 10, 5, 3, 3, 2, 2, 1) as relevance_score
        FROM emails_fts
        JOIN emails ON emails.id = emails_fts.email_id
        WHERE emails_fts MATCH ?
      `;
      params.push(ftsQuery);
    } else {
      sql = `SELECT ${this.emailSelect()}, ${THREAD_META} FROM emails WHERE 1=1`;
    }

    // All folder/category/field/date/size filters (shared with count()).
    sql += this.appendFilters(query, params);

    // Sorting
    const sortBy = query.sortBy || 'date';
    if (useFTS && (sortBy === 'relevance' || sortBy === 'date')) {
      // For relevance sort, blend the field-weighted bm25 score with lightweight
      // importance signals — a local-client take on Gmail's LTR re-rank
      // (Score = relevance + importance − time-decay), minus the neural net.
      // bm25 is negative and lower = more relevant, so SUBTRACTING a boost pulls
      // starred/important/unread matches UP without ever overriding a much stronger
      // keyword match. Recency is only a TIE-BREAKER (never demotes a better match,
      // so a "W2 2023"-style navigational search still surfaces the old mail).
      if (sortBy === 'relevance') {
        sql += `
        ORDER BY (
          relevance_score
          - (CASE WHEN instr(emails.tags, '|starred|')   > 0 THEN 4.0 ELSE 0 END)
          - (CASE WHEN instr(emails.tags, '|important|') > 0 THEN 2.0 ELSE 0 END)
          - (CASE WHEN instr(emails.tags, '|read|')      = 0 THEN 1.0 ELSE 0 END)
        ) ASC, emails.date DESC`;
      } else {
        sql += ` ORDER BY emails.date DESC`;
      }
    } else {
      const { column, direction } = this.safeOrderBy(sortBy, query.sortOrder, SEARCH_SORT_COLUMNS, 'date');
      sql += ` ORDER BY emails.${column} ${direction}`;
    }

    // OFFSET without LIMIT is a SQLite syntax error, so an offset-only query threw
    // instead of paging. -1 is SQLite's "no limit".
    if (query.limit || query.offset) {
      sql += ` LIMIT ?`;
      params.push(query.limit ?? -1);
    }

    if (query.offset) {
      sql += ` OFFSET ?`;
      params.push(query.offset);
    }

    try {
      const rows = this.db.prepare(sql).all(...params) as any[];
      return rows.map(row => this.rowToRecord(row));
    } catch (error) {
      logger.error('[SearchRepo] FTS search failed, falling back to LIKE:', error);
      return this.searchWithLike(query);
    }
  }

  /**
   * The folder/category/field/date/size WHERE clause, shared by search(),
   * count() AND the LIKE fallback so all three agree on what a query means.
   * Appends to `params` and returns the SQL fragment (all conditions reference
   * the `emails` alias / FTS-joined `emails` table).
   *
   * The fallback used to hand-roll its own subset of these clauses and silently
   * dropped `cc`, `threadIds`, `noCategory` and `folderIds` — so the moment FTS
   * was unavailable, a scoped search quietly returned mail from outside its
   * scope. `likeOnly` is the only difference the fallback needs.
   */
  private appendFilters(
    query: SearchQuery,
    params: any[],
    options: { likeOnly?: boolean } = {},
  ): string {
    let sql = '';

    // Folder scoping
    if (query.folderPath) {
      sql += ` AND instr(emails.tags, '|' || ? || '|') > 0`;
      params.push(query.folderPath);
      sql += ` ${this.getExcludeSpecialFolders(query.folderPath)}`;
    } else if (query.scope === 'all' || (!query.folderPath && !query.folderIds?.length)) {
      sql += ` ${this.getExcludeSpecialFolders()}`;
    }

    // Legacy folderIds support
    if (query.folderIds && query.folderIds.length > 0) {
      for (const folderId of query.folderIds) {
        const folder = this.db.prepare('SELECT path FROM folders WHERE id = ?').get(folderId) as any;
        if (folder) {
          sql += ` AND instr(emails.tags, '|' || ? || '|') > 0`;
          params.push(folder.path);
        }
      }
    }

    // AI category filter
    if (query.aiCategory) {
      sql += ` AND instr(emails.tags, '|' || ? || '|') > 0`;
      params.push(query.aiCategory);
    }

    // "Unlabelled" — mail carrying NONE of the defined AI categories. Exclude
    // EVERY category slug (not just is_enabled=1): a disabled-but-tagged category
    // still renders a badge (badges read all slugs), so it counts as labelled.
    if (query.noCategory) {
      const slugs = (this.db.prepare('SELECT slug FROM ai_category_definitions').all() as { slug: string }[]).map((r) => r.slug);
      for (const slug of slugs) {
        sql += ` AND instr(emails.tags, '|' || ? || '|') = 0`;
        params.push(slug);
      }
    }

    if (query.threadIds && query.threadIds.length > 0) {
      sql += ` AND emails.thread_id IN (${query.threadIds.map(() => '?').join(',')})`;
      params.push(...query.threadIds);
    }

    if (query.from) {
      sql += ` AND (emails.from_address LIKE ? ESCAPE '\\' OR emails.from_name LIKE ? ESCAPE '\\')`;
      params.push(this.likeContains(query.from), this.likeContains(query.from));
    }

    if (query.to) {
      sql += ` AND emails.to_address LIKE ? ESCAPE '\\'`;
      params.push(this.likeContains(query.to));
    }

    if (query.cc) {
      sql += ` AND emails.cc_address LIKE ? ESCAPE '\\'`;
      params.push(this.likeContains(query.cc));
    }

    if (query.subject) {
      sql += ` AND emails.subject LIKE ? ESCAPE '\\'`;
      params.push(this.likeContains(query.subject));
    }

    if (query.hasAttachments !== undefined) {
      sql += ` AND emails.has_attachments = ?`;
      params.push(query.hasAttachments ? 1 : 0);
    }

    if (query.isUnread !== undefined) {
      sql += query.isUnread
        ? ` AND instr(emails.tags, '|read|') = 0`
        : ` AND instr(emails.tags, '|read|') > 0`;
    }

    if (query.isFlagged !== undefined) {
      sql += query.isFlagged
        ? ` AND instr(emails.tags, '|starred|') > 0`
        : ` AND instr(emails.tags, '|starred|') = 0`;
    }

    if (query.dateFrom) {
      sql += ` AND emails.date >= ?`;
      params.push(query.dateFrom);
    }

    if (query.dateTo) {
      sql += ` AND emails.date <= ?`;
      params.push(query.dateTo);
    }

    // doesntHave: exclude emails matching these terms. The LIKE fallback must not
    // reach into emails_fts — it exists for exactly the case where FTS is missing
    // or broken, and an exclusion that silently matches nothing would widen the
    // result set instead of narrowing it.
    if (query.doesntHave) {
      if (options.likeOnly) {
        for (const word of query.doesntHave.trim().split(/\s+/).filter(Boolean)) {
          sql += ` AND emails.subject NOT LIKE ? ESCAPE '\\' AND ${cleanBodyExpression()} NOT LIKE ? ESCAPE '\\'`;
          params.push(this.likeContains(word), this.likeContains(word));
        }
      } else {
        const negFts = this.escapeFTSQuery(query.doesntHave);
        if (negFts) {
          sql += ` AND emails.id NOT IN (
            SELECT email_id FROM emails_fts WHERE emails_fts MATCH ?
          )`;
          params.push(negFts);
        }
      }
    }

    // Size filters (use length of raw_body as proxy).
    //
    // `length(raw_body)` cannot use an index — a function on a column defeats
    // every one — so it reads the FULL body of every candidate row just to
    // compare a number. `raw_body_len` is that same number, stored, so once the
    // backfill has run this filter costs a single integer read. The expression
    // is chosen per database (never assumed) so results stay identical while
    // rows still have NULL lengths.
    const sizeExpr = rawBodyLengthExpression('emails', this.bodyLengthsReady());
    if (query.sizeMin) {
      sql += ` AND ${sizeExpr} >= ?`;
      params.push(query.sizeMin);
    }
    if (query.sizeMax) {
      sql += ` AND ${sizeExpr} <= ?`;
      params.push(query.sizeMax);
    }

    return sql;
  }

  /**
   * COUNT of ALL rows matching a search (no limit/offset) — the true "of N"
   * total for the paginator, computed over the whole mailbox, not just the
   * loaded page. Uses the exact same WHERE as search() via appendFilters.
   */
  count(query: SearchQuery): number {
    const textQuery = query.query?.trim();
    const useFTS = !!(textQuery && textQuery.length > 0);
    const params: any[] = [];
    let sql: string;

    if (useFTS) {
      const ftsQuery = this.escapeFTSQuery(textQuery!);
      if (!ftsQuery) return this.searchWithLike({ ...query, limit: undefined, offset: undefined }).length;
      sql = `SELECT COUNT(*) as cnt FROM emails_fts JOIN emails ON emails.id = emails_fts.email_id WHERE emails_fts MATCH ?`;
      params.push(ftsQuery);
    } else {
      sql = `SELECT COUNT(*) as cnt FROM emails WHERE 1=1`;
    }

    sql += this.appendFilters(query, params);

    try {
      const row = this.db.prepare(sql).get(...params) as { cnt: number } | undefined;
      return row?.cnt ?? 0;
    } catch (error) {
      logger.error('[SearchRepo] count failed, falling back to LIKE length:', error);
      return this.searchWithLike({ ...query, limit: undefined, offset: undefined }).length;
    }
  }

  /**
   * Fallback LIKE-based search, for when FTS5 is unavailable or its query is
   * empty after escaping. Same filters as the FTS path (one shared builder) —
   * only the free-text match differs: LIKE across the same fields FTS indexes.
   */
  private searchWithLike(query: SearchQuery): EmailRecord[] {
    let sql = `SELECT ${this.emailSelect()}, ${THREAD_META} FROM emails WHERE 1=1`;
    const params: any[] = [];

    sql += this.appendFilters(query, params, { likeOnly: true });

    // Free-text search over the same fields FTS indexes (subject, body, sender,
    // cc, attachment names) so a fallback result set looks like an FTS one.
    if (query.query?.trim()) {
      sql += ` AND (emails.subject LIKE ? ESCAPE '\\' OR ${cleanBodyExpression()} LIKE ? ESCAPE '\\' OR emails.from_name LIKE ? ESCAPE '\\'`
        + ` OR emails.from_address LIKE ? ESCAPE '\\' OR emails.cc_address LIKE ? ESCAPE '\\' OR emails.attachment_names LIKE ? ESCAPE '\\')`;
      const q = this.likeContains(query.query.trim());
      params.push(q, q, q, q, q, q);
    }

    const { column, direction } = this.safeOrderBy(query.sortBy, query.sortOrder, SEARCH_SORT_COLUMNS, 'date');
    sql += ` ORDER BY emails.${column} ${direction}`;

    // OFFSET without LIMIT is a SQLite syntax error, so an offset-only query threw
    // instead of paging. -1 is SQLite's "no limit".
    if (query.limit || query.offset) {
      sql += ` LIMIT ?`;
      params.push(query.limit ?? -1);
    }

    if (query.offset) {
      sql += ` OFFSET ?`;
      params.push(query.offset);
    }

    const rows = this.db.prepare(sql).all(...params) as any[];
    return rows.map(row => this.rowToRecord(row));
  }

  /**
   * Suggest search terms from FTS5 vocab table (prefix autocomplete)
   */
  suggestTerms(partial: string): string[] {
    if (!partial || partial.length < 2) return [];
    try {
      // Nothing else creates the vocab vtable — ensure it lazily (cheap:
      // it's a zero-copy view over the emails_fts index, no backfill).
      this.db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS emails_fts_vocab USING fts5vocab('emails_fts', 'row')`);

      // fts5vocab doesn't support MATCH — prefix lookup uses the range
      // form, which the vtable optimizes via term >=/< constraints.
      const prefix = partial.toLowerCase();
      const upperBound = prefix + String.fromCharCode(0xffff);
      const rows = this.db.prepare(`
        SELECT DISTINCT term FROM emails_fts_vocab
        WHERE term >= ? AND term < ?
        LIMIT 10
      `).all(prefix, upperBound) as { term: string }[];
      return rows.map(r => r.term);
    } catch {
      // emails_fts may not exist yet or query may fail
      return [];
    }
  }
}
