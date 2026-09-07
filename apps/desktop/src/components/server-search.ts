// Pure decision helpers for the local-first → server search escalation. Kept
// framework-free so the "when do we reach past the local index to the server?"
// rules are unit-testable without a store or IPC.

/**
 * Whether a parsed search query carries a term an IMAP SERVER SEARCH can honour
 * (text / header / date / size) — as opposed to local-only concepts (aiCategory,
 * labels, has:attachment). Server escalation is pointless without one. Mirrors
 * core's `hasServerSearchableCriteria`, kept here so the renderer needn't drag in
 * the core IMAP module, and shared by the store (escalation gate) and the list
 * (whether to offer the button) so the two can never disagree.
 */
export function hasServerSearchableParsedQuery(parsed: unknown): boolean {
  if (!parsed || typeof parsed !== 'object') return false;
  const query = parsed as Record<string, unknown>;
  const textQuery = query.textQuery;
  return Boolean(
    (typeof textQuery === 'string' && textQuery.trim()) ||
      query.from ||
      query.to ||
      query.cc ||
      query.subject ||
      query.dateFrom ||
      query.dateTo ||
      query.sizeMin ||
      query.sizeMax,
  );
}

export interface AutoEscalateParams {
  /** Does the query carry a text/header/date term the server can act on? A pure
   *  flag/category filter is fully answered locally — never escalate it. */
  hasServerSearchableTerms: boolean;
  /** Rows the local search returned for the page we just loaded. */
  localResultCount: number;
  /** One page size (getEmailsPerPage()). "Thin" = didn't even fill a page. */
  pageSize: number;
  /** Which page we just loaded — only the FIRST page auto-escalates. */
  page: number;
  /** Whether a server search already ran for this exact query. */
  alreadyRanServer: boolean;
  /** Unified ("All Inboxes") fans out across accounts and has no single folder
   *  to SEARCH — server escalation is single-account/single-folder only. */
  isUnifiedView: boolean;
}

/**
 * Decide whether to AUTOMATICALLY escalate to a server search after a local
 * page load. Conservative on purpose: only the first page, only when local came
 * back thin, only for queries the server can actually help with, and never twice
 * for the same query. The explicit "Search server" button bypasses all of this.
 */
export function shouldAutoEscalateToServer(params: AutoEscalateParams): boolean {
  const {
    hasServerSearchableTerms,
    localResultCount,
    pageSize,
    page,
    alreadyRanServer,
    isUnifiedView,
  } = params;
  if (!hasServerSearchableTerms) return false;
  if (isUnifiedView) return false;
  if (page !== 0) return false;
  if (alreadyRanServer) return false;
  return localResultCount < pageSize;
}

/**
 * Whether the manual "Search server" affordance should be offered at all. Shown
 * whenever a server-searchable query is active in a single-account/folder view —
 * so the user can force a server sweep even when local returned a full page.
 */
export function canOfferServerSearch(params: {
  hasServerSearchableTerms: boolean;
  isUnifiedView: boolean;
}): boolean {
  return params.hasServerSearchableTerms && !params.isUnifiedView;
}

/**
 * One-line human summary of a completed server search, for the status chip.
 * `null` when nothing meaningful happened (kept quiet rather than noisy).
 */
export function describeServerSearchResult(result: {
  skipped: boolean;
  matched: number;
  inserted: number;
} | null): string | null {
  if (!result || result.skipped) return null;
  if (result.inserted > 0) {
    return `Found ${result.inserted} more on the server`;
  }
  if (result.matched > 0) return 'All server matches already downloaded';
  return 'No more matches on the server';
}
