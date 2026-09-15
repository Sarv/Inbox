/**
 * The ONE definition of "this email is waiting for AI categorization".
 *
 * This file exists because there used to be three hand-written copies of that
 * predicate — the poll's backlog counter, the dashboard's "eligible right now"
 * tile, and the worker's own row selector — and they drifted apart. A row that
 * satisfied a *counter* but failed the *selector* was counted as pending
 * forever and never picked up by anything: the AI progress bar parked below
 * 100% with "N pending", no error, no retry, nothing in the log, because the
 * worker never saw the row at all.
 *
 * Every count, every tile and every worker query must be built from the
 * clauses below, so a future change to eligibility can only ever be made in
 * one place. If you are about to write `agent_status = 'pending'` in a new
 * query, use these instead.
 */

import { areBodyLengthsReady, fastHasBodyExpression, legacyHasBodyExpression } from './body-metrics';

/** Qualify a column with an optional table alias (`e.tags` vs `tags`). */
const col = (alias: string, name: string): string => (alias ? `${alias}.${name}` : name);

/**
 * Mailbox folders whose contents are never AI-categorized, across providers.
 *
 * Deleted and junk mail is self-evident. DRAFTS and SENT are here because they
 * are the user's OWN writing: categorising your own outbox tells you nothing,
 * and a priority score on a message you wrote yourself is meaningless.
 *
 * This list was previously written twice — here (as part of
 * {@link AGENT_EXCLUDED_TAGS}) and again as `excludeSpecialFolders` in
 * ai-repository, which the category CHIPS use — and the two disagreed. The
 * worker's copy was missing Drafts, Sent, Junk Email, Deleted Items and Sent
 * Items, so the pipeline spent LLM calls categorising mail the chips then
 * filtered straight back out: 140 drafts and sent messages in one real mailbox,
 * every result invisible. `Junk` had drifted the same way once before, in the
 * other direction.
 *
 * Provider spellings all live here together: Gmail prefixes with `[Gmail]/`,
 * Outlook says `Junk Email` / `Deleted Items` / `Sent Items`, IMAP-standard
 * servers say `Junk`.
 */
export const EXCLUDED_FOLDER_TAGS = [
  '|Spam|',
  '|Junk|',
  '|Junk Email|',
  '|Trash|',
  '|Deleted Items|',
  '|Drafts|',
  '|Sent|',
  '|Sent Items|',
  '|[Gmail]/Spam|',
  '|[Gmail]/Trash|',
  '|[Gmail]/Drafts|',
  '|[Gmail]/Sent Mail|',
] as const;

/**
 * Tags that permanently disqualify an email from AI categorization.
 *
 * `read` — the user already triaged it themselves, so spending an LLM call on
 * it is waste — plus every folder in {@link EXCLUDED_FOLDER_TAGS}.
 */
export const AGENT_EXCLUDED_TAGS = [
  '|read|',
  ...EXCLUDED_FOLDER_TAGS,
] as const;

/**
 * True when the email is in none of the never-categorized folders. Read state
 * is deliberately NOT considered: callers that page over a category view need
 * read mail too, and add their own `|read|` test when they want unread only.
 */
export function notInExcludedFolderClause(alias = ''): string {
  return EXCLUDED_FOLDER_TAGS
    .map((tag) => `instr(${col(alias, 'tags')}, '${tag}') = 0`)
    .join(' AND ');
}

/** True when the email carries none of the disqualifying tags. */
export function notExcludedByTagsClause(alias = ''): string {
  return AGENT_EXCLUDED_TAGS
    .map((tag) => `instr(${col(alias, 'tags')}, '${tag}') = 0`)
    .join(' AND ');
}

/** True when the email carries any of the disqualifying tags. */
export function excludedByTagsClause(alias = ''): string {
  return AGENT_EXCLUDED_TAGS
    .map((tag) => `instr(${col(alias, 'tags')}, '${tag}') > 0`)
    .join(' OR ');
}

/**
 * Categorization runs off cleanBody OR rawBody. An HTML-only mail (empty
 * clean_body, common for marketing sends) carries its content in raw_body, so
 * gating on clean_body alone strands such mail. Threshold is > 0, not > 10, to
 * match the worker's own runtime gate — a legit short unread ("Call me") must
 * be processed, not left as permanent backlog.
 *
 * `bodyLengthsReady` selects HOW the same question is answered. See
 * `body-metrics.ts` for the measurements and the NULL contract; the short
 * version is that reading the bodies costs a walk of each row's overflow chain,
 * while the length columns can be answered from a covering index — but only
 * once the backfill has proven no row still has NULL lengths. It defaults to
 * `false` so a call site that has not been taught about the columns keeps
 * today's correct-but-slow behaviour rather than silently mis-answering.
 */
export function hasBodyClause(alias = '', bodyLengthsReady = false): string {
  return bodyLengthsReady ? fastHasBodyExpression(alias) : legacyHasBodyExpression(alias);
}

/**
 * Inverse of {@link hasBodyClause} — the body has not been downloaded yet.
 *
 * Both forms are total (never NULL), which matters because this one is used to
 * FINALIZE rows: a three-valued result would make `NOT` yield NULL and quietly
 * change which rows the stuck-heal picks up.
 */
export function missingBodyClause(alias = '', bodyLengthsReady = false): string {
  return `NOT ${hasBodyClause(alias, bodyLengthsReady)}`;
}

/**
 * Bounds eligibility to the N most-recent emails by date, so background
 * auto-processing never reaches into a historical backlog of lakhs. Takes one
 * bound parameter (the cap). Always compares against the unaliased `emails`
 * table in the subquery, which is correct even when the outer query is
 * aliased.
 */
export function recentWindowClause(alias = ''): string {
  return `${col(alias, 'date')} >= (SELECT MIN(date) FROM (SELECT date FROM emails ORDER BY date DESC LIMIT ?))`;
}

/**
 * Options for the composite eligibility clauses.
 *
 * `recentWindow` folds {@link recentWindowClause} in at the RIGHT POSITION
 * rather than leaving the caller to append it. It consumes one bound parameter,
 * and because the window text now sits ahead of any `LIMIT ?`, the existing
 * `[recentWindow, limit]` bind order is unchanged.
 */
export interface EligibilityOptions {
  /** Bound the clause to the N most-recent emails (one `?` parameter). */
  recentWindow?: boolean;
  /**
   * Answer the has-body test from `clean_body_len`/`raw_body_len` instead of the
   * bodies themselves. Only safe once this DB's backfill has completed — pass
   * `areBodyLengthsReady(db)`, never a literal `true`.
   */
  bodyLengthsReady?: boolean;
}

/**
 * Term order is a PERFORMANCE contract, not a style choice.
 *
 * SQLite evaluates the AND terms of a WHERE clause in the order they are
 * written, so the cheapest, most selective test must come first and the
 * expensive one last. {@link hasBodyClause} is by far the most expensive test
 * in this file: `emails` stores the bodies inline, so `LENGTH(TRIM(clean_body))`
 * has to read the whole value plus its overflow chain (SQLite's length-only
 * shortcut applies to BLOBs, not TEXT). Status equality and the date window are
 * header-only by comparison.
 *
 * Measured 2026-08-26 on a 26,184-email mailbox: the extraction backlog count
 * took 400.9ms with the body test first and 62.2ms with the window ahead of it —
 * the same rows, the same result, purely the order. That count runs on the
 * 30-second pipeline poll, on the main thread.
 *
 * Anything appended by a caller lands AFTER the body test and undoes this, which
 * is why the window is an option here instead.
 */
function eligibilityTerms(terms: Array<string | false>): string {
  return terms.filter((term): term is string => term !== false).join('\n        AND ');
}

/**
 * THE eligibility predicate: an email the AI worker can actually pick up and
 * categorize right now. Counters and selectors alike must use this, so the
 * number on screen can never disagree with the work being done.
 *
 * Note `extraction_status = 'done'`: extraction is phase 1, categorization is
 * phase 2. A row still awaiting extraction is not yet the agent's to process.
 */
export function agentEligibleClause(alias = '', options: EligibilityOptions = {}): string {
  return eligibilityTerms([
    `${col(alias, 'agent_status')} = 'pending'`,
    `${col(alias, 'extraction_status')} = 'done'`,
    options.recentWindow === true && recentWindowClause(alias),
    notExcludedByTagsClause(alias),
    // Last, always — see eligibilityTerms.
    hasBodyClause(alias, options.bodyLengthsReady),
  ]);
}

/**
 * Rows counted as `agent_status='pending'` that {@link agentEligibleClause}
 * can never select — the limbo that froze the progress bar. Two shapes reach
 * it, and they need opposite treatment:
 *
 *  - **Disqualified**: carries an excluded tag. Will never be categorized by
 *    design, so it should be finalized immediately rather than counted.
 *  - **Body-less**: no body downloaded yet. Phase 1 skips it (it selects
 *    `extraction_status='pending'` AND a non-empty body) and phase 2 skips it
 *    too, so nothing advances it until the body arrives — and per the
 *    body-fetch failure modes, some never do.
 *
 * Deliberately NOT limbo: a row with a body still awaiting extraction. Phase 1
 * selects exactly that and will move it along on the next tick.
 */
export function agentStuckClause(alias = '', options: EligibilityOptions = {}): string {
  return [
    `${col(alias, 'agent_status')} = 'pending'`,
    `(${excludedByTagsClause(alias)} OR ${missingBodyClause(alias, options.bodyLengthsReady)})`,
  ].join('\n        AND ');
}

/**
 * Phase 1 (conversation extraction) has the SAME counted-vs-selectable split,
 * and it bites harder: extraction is the gate in front of categorization, so a
 * row stuck here never even reaches phase 2. The worker selects
 * `extraction_status='pending'` AND a real body, while the poll's counter was a
 * bare `extraction_status='pending'` — every body-less row was counted as
 * backlog that nothing could ever drain.
 *
 * Note this deliberately does NOT exclude read/spam/trash. Extraction is cheap
 * and tag-blind; the disqualification happens at the phase-2 gate. Adding tags
 * here would re-create the drift in the opposite direction — a row the counter
 * skipped but the selector still picked up.
 */
export function extractionEligibleClause(alias = '', options: EligibilityOptions = {}): string {
  return eligibilityTerms([
    `${col(alias, 'extraction_status')} = 'pending'`,
    options.recentWindow === true && recentWindowClause(alias),
    // Last, always — see eligibilityTerms.
    hasBodyClause(alias, options.bodyLengthsReady),
  ]);
}

/**
 * Phase-1 limbo: counted as pending extraction, unselectable by phase 1. Only
 * one shape reaches it — no body — and it is healed on the same age rule as
 * the phase-2 case: left alone while the download may still land, finalized
 * once it is old enough that the body is never coming.
 */
export function extractionStuckClause(alias = '', options: EligibilityOptions = {}): string {
  return [
    `${col(alias, 'extraction_status')} = 'pending'`,
    missingBodyClause(alias, options.bodyLengthsReady),
  ].join('\n        AND ');
}

/** Every count the AI dashboard's "processing breakdown" panel shows. */
export interface ProcessingBreakdown {
  total: number;
  withBody: number;
  noBody: number;
  readSkipped: number;
  aiProcessed: number;
  eligibleNow: number;
  unreadWithBody: number;
  unreadNoBody: number;
  /**
   * The AGENT pipeline's backlog — priority scoring, actions and drafts. A
   * separate pipeline from categorization, keyed on `agent_status` rather than
   * `ai_processed_at`, and until this row existed it was invisible: the panel
   * sat at "100% complete, 0 pending" for an hour while the agent worked
   * through 252 emails, because the bar only ever measured the OTHER pipeline.
   */
  agentPending: number;
  agentDone: number;
}

/**
 * The dashboard's breakdown, built from the SAME clauses the worker selects on
 * so the panel cannot quietly disagree with it about what "has a body" or "is
 * skippable" means.
 *
 * `unreadWithBody` / `unreadNoBody` carry the folder exclusions deliberately.
 * Without them they counted unread mail in Trash, Spam and Junk — mail the user
 * will never open — so the row the UI labels "eligible pool" described messages
 * that could never become eligible, and it did not fall as mail was read.
 * Reported from the field with ~1,000 unread in Trash against ~358 in the
 * inbox: three quarters of the number was deleted mail that had never been
 * opened, so reading made no visible difference to it.
 *
 * Lives here rather than in the IPC handler so it can be tested against a real
 * migrated database instead of only through Electron.
 *
 * @param db an open, migrated database
 */
export function processingBreakdown(
  db: { prepare: (sql: string) => { get: (...params: unknown[]) => unknown } },
  options: { recentWindow?: number } = {},
): ProcessingBreakdown {
  const get = (sql: string): number => ((db.prepare(sql).get() as { n: number })?.n || 0);
  const getWith = (sql: string, params: unknown[]): number =>
    ((db.prepare(sql).get(...params) as { n: number })?.n || 0);
  // How far back the background poll may reach — the user's "AI Processing
  // Limit". 0 means "no window", matching getEmailsPendingAgent.
  const recentWindow = Math.max(0, Math.floor(options.recentWindow ?? 0));

  // Whether the has-body test can be answered from the length columns
  // (index-servable) or must read every body. Read from THIS database rather
  // than assumed: a mailbox whose background backfill has not finished still
  // has NULL lengths, and reading a NULL as "no body" would make the breakdown
  // claim the entire mailbox is unprocessable.
  const ready = areBodyLengthsReady(db as never);

  return {
    total: get(`SELECT COUNT(*) AS n FROM emails`),
    withBody: get(`SELECT COUNT(*) AS n FROM emails WHERE ${hasBodyClause('', ready)}`),
    noBody: get(`SELECT COUNT(*) AS n FROM emails WHERE ${missingBodyClause('', ready)}`),
    readSkipped: get(`SELECT COUNT(*) AS n FROM emails WHERE instr(tags,'|read|') > 0`),
    aiProcessed: get(`SELECT COUNT(*) AS n FROM emails WHERE ai_processed_at IS NOT NULL`),
    // Bulk-run eligibility: what "Process More" could take on. Keyed on
    // ai_processed_at rather than agent_status — this asks "never AI-processed",
    // not "queued for the background poll".
    eligibleNow: get(`
      SELECT COUNT(*) AS n FROM emails
      WHERE ai_processed_at IS NULL
        AND ${hasBodyClause('', ready)}
        AND ${notExcludedByTagsClause()}
    `),
    unreadWithBody: get(`
      SELECT COUNT(*) AS n FROM emails
      WHERE ${hasBodyClause('', ready)}
        AND ${notExcludedByTagsClause()}
    `),
    unreadNoBody: get(`
      SELECT COUNT(*) AS n FROM emails
      WHERE ${missingBodyClause('', ready)}
        AND ${notExcludedByTagsClause()}
    `),
    // The agent pipeline's own backlog, measured with the SAME clause its
    // worker selects on — including the recent-window cap, so the number
    // reflects what the poll can actually reach rather than what merely
    // exists. Without the window a user whose cap is 500 would watch a count
    // that never moves, which is the bug this whole panel keeps reproducing.
    agentPending: recentWindow > 0
      ? getWith(
        `SELECT COUNT(*) AS n FROM emails e
         WHERE ${agentEligibleClause('e', { recentWindow: true, bodyLengthsReady: ready })}`,
        [recentWindow],
      )
      : get(`
        SELECT COUNT(*) AS n FROM emails e
        WHERE ${agentEligibleClause('e', { bodyLengthsReady: ready })}
      `),
    agentDone: get(`SELECT COUNT(*) AS n FROM emails WHERE agent_status = 'done'`),
  };
}
