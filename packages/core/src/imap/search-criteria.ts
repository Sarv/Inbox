import type { SearchCriteria } from '../types/imap';

/**
 * The renderer's parsed-query shape (what `ai:search` / `_loadSearchPage`
 * dispatch to the DB). Only the fields an IMAP SERVER SEARCH can honour are
 * declared here — the rest (aiCategory, labels, noCategory, hasAttachments…)
 * are local-only concepts the server knows nothing about.
 */
export interface ParsedSearchQuery {
  textQuery?: string;
  from?: string;
  to?: string;
  cc?: string;
  subject?: string;
  /** true = only unread. false/undefined = don't constrain (a search for read
   *  mail is rare and IMAP `seen` would exclude unread — keep it opt-in). */
  isUnread?: boolean;
  isFlagged?: boolean;
  /** Epoch milliseconds — the inclusive lower bound (mapped to IMAP SINCE). */
  dateFrom?: number;
  /** Epoch milliseconds — the exclusive upper bound (mapped to IMAP BEFORE). */
  dateTo?: number;
  /** Bytes. */
  sizeMin?: number;
  sizeMax?: number;
}

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

/**
 * Translate a renderer parsed query into an IMAP `SearchCriteria` for a
 * server-side UID SEARCH. Pure: no I/O, no clock — a caller passes the already
 * parsed query and gets back exactly the criteria the server can act on.
 *
 * Dates arrive as epoch-ms (how the DB stores them) and become `Date`s because
 * that's what imapflow's SearchObject wants; `dateFrom`→SINCE, `dateTo`→BEFORE.
 * Fields the server has no equivalent for are simply dropped, never guessed.
 */
export function buildImapSearchCriteria(query: ParsedSearchQuery): SearchCriteria {
  const criteria: SearchCriteria = {};

  if (isNonEmptyString(query.textQuery)) criteria.text = query.textQuery.trim();
  if (isNonEmptyString(query.from)) criteria.from = query.from.trim();
  if (isNonEmptyString(query.to)) criteria.to = query.to.trim();
  if (isNonEmptyString(query.cc)) criteria.cc = query.cc.trim();
  if (isNonEmptyString(query.subject)) criteria.subject = query.subject.trim();

  if (query.isUnread === true) criteria.unseen = true;
  if (query.isFlagged === true) criteria.flagged = true;

  if (isFiniteNumber(query.dateFrom)) criteria.since = new Date(query.dateFrom);
  if (isFiniteNumber(query.dateTo)) criteria.before = new Date(query.dateTo);

  if (isFiniteNumber(query.sizeMin) && query.sizeMin > 0) criteria.larger = query.sizeMin;
  if (isFiniteNumber(query.sizeMax) && query.sizeMax > 0) criteria.smaller = query.sizeMax;

  return criteria;
}

/**
 * True when the criteria carry at least one constraint worth a server round-trip.
 * A query that reduces to nothing (or to only a flag like `unseen`) is fully
 * answered by the local index — escalating it would just re-fetch the whole
 * folder. Server search earns its cost only for text/header/date/size terms the
 * local FTS index might not yet cover.
 */
export function hasServerSearchableCriteria(criteria: SearchCriteria): boolean {
  return Boolean(
    criteria.text ||
      criteria.from ||
      criteria.to ||
      criteria.cc ||
      criteria.subject ||
      criteria.since ||
      criteria.before ||
      criteria.larger ||
      criteria.smaller,
  );
}
