/**
 * The Sarv CAI catalog (LLM providers, models, zones) for the renderer's
 * pickers, fetched by main (`oauth:sarvCatalog`).
 *
 * The catalog needs the account's Sarv bearer, which is also the Sarv
 * mailbox's XOAUTH2 credential, so it never goes to the renderer (CASA I-2).
 * The renderer names the account and the list; main mints the bearer and sends
 * it only to its OWN configured Sarv API base URL — whatever URL the renderer
 * might send is ignored — with redirects refused (core `fetchSarvCatalog`).
 */
import {
  createLogger,
  fetchSarvCatalog,
  getOAuthProvider,
  toOneLine,
  type SarvCatalogKind,
  type SarvCatalogResult,
} from '@sarvinbox/core';

import { chromiumFetch } from './net-fetch';
import { getValidAccessToken } from './oauth-service';

const logger = createLogger('sarv-catalog');

/** What the renderer may ask for. Never a URL, never a token. */
export interface SarvCatalogIpcRequest {
  kind: SarvCatalogKind;
  /** The signed-in Sarv account whose catalog to read. */
  email: string;
  /** `models`: the backend whose models to list. */
  providerCode?: string;
  /** `providers` / `models`: scope to this zone. */
  zoneCode?: string;
}

const KINDS: ReadonlySet<string> = new Set<SarvCatalogKind>(['providers', 'models', 'zones']);

/** Catalog codes are short identifiers; anything else is not a real filter. */
const MAX_CODE_LENGTH = 200;

const isOptionalCode = (value: unknown): boolean =>
  value === undefined || (typeof value === 'string' && value.length <= MAX_CODE_LENGTH);

/** Cap server text for the log line. */
const forLog = (text: string): string => toOneLine(text.length > 300 ? `${text.slice(0, 300)}…` : text);

export async function fetchSarvCatalogForRenderer(request: unknown): Promise<SarvCatalogResult> {
  const r = request as Partial<SarvCatalogIpcRequest> | null | undefined;
  if (
    !r || typeof r !== 'object' || !KINDS.has(r.kind as string)
    || typeof r.email !== 'string' || r.email.trim() === ''
    || !isOptionalCode(r.providerCode) || !isOptionalCode(r.zoneCode)
  ) {
    return { ok: false, status: 0, code: 'invalid_request', message: 'Invalid Sarv catalog request.' };
  }
  const apiBaseUrl = getOAuthProvider('sarv').apiBaseUrl;
  if (!apiBaseUrl) {
    return { ok: false, status: 0, code: 'not_configured', message: 'Sarv AI is unavailable in this app configuration.' };
  }
  const kind = r.kind as SarvCatalogKind;
  const email = r.email;
  const result = await fetchSarvCatalog(
    { kind, providerCode: r.providerCode, zoneCode: r.zoneCode },
    {
      apiBaseUrl,
      fetchImpl: chromiumFetch,
      resolveBearer: (forceRefresh) => getValidAccessToken('sarv', email, forceRefresh),
    },
  );
  if (result.ok) {
    logger.info(`[SarvCatalog] ${kind} loaded`);
  } else {
    // Log the REASON, not just the status: a 403 here is three problems with
    // three fixes — `insufficient_scope` (the token lacks llm:view: sign in
    // again), `cai_account_required` (no CAI account behind the login) and an
    // org-gated zones lookup — and "the AI stopped working" is undiagnosable
    // from a bare status. The account is not logged.
    logger.warn(`[SarvCatalog] ${kind} failed: status=${result.status} code=${forLog(result.code)} — ${forLog(result.message)}`);
  }
  return result;
}
