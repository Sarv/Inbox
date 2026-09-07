/**
 * Sarv API error type + the ONE parser for Sarv error responses.
 *
 * Every Sarv surface the app talks to — the edge LLM gateway (chat
 * completions) and the OAuth-mounted discovery/wallet endpoints — reports
 * failures with the same JSON shape, so both paths classify them here. This
 * lives in `utils` (framework-agnostic, no Node/Electron/agent imports) so the
 * `agent` and `oauth` modules can share it without either depending on the
 * other.
 */

export type SarvErrorCode =
  | 'invalid_token'        // 401 — access token expired or bad
  | 'cai_account_required' // 403 — user never linked oauth → CAI
  | 'insufficient_scope'   // 403 — app asked for too little at /authorize
  | 'insufficient_role'    // 403 — user's CAI role forbids this action
  | 'insufficient_balance' // 402 — wallet empty
  | 'rate_limit_exceeded'  // 429
  | 'upstream_error';      // anything else

export class SarvApiError extends Error {
  readonly status: number;
  readonly code: SarvErrorCode;
  readonly retryAfterSec?: number;
  readonly detail?: unknown;

  constructor(
    message: string,
    opts: { status: number; code: SarvErrorCode; retryAfterSec?: number; detail?: unknown },
  ) {
    super(message);
    this.name = 'SarvApiError';
    this.status = opts.status;
    this.code = opts.code;
    this.retryAfterSec = opts.retryAfterSec;
    this.detail = opts.detail;
  }
}

/** Codes the app actually branches on; anything else falls back to the status map. */
const KNOWN_CODES: ReadonlySet<SarvErrorCode> = new Set<SarvErrorCode>([
  'invalid_token',
  'cai_account_required',
  'insufficient_scope',
  'insufficient_role',
  'insufficient_balance',
  'rate_limit_exceeded',
]);

/** Parse a non-2xx response from the Sarv edge / oauth surface and return a
 * ``SarvApiError`` tagged with one of the documented error codes. Handlers
 * should branch on ``err.code`` to decide what to do:
 *
 *   invalid_token         → refresh; if refresh fails, re-authorize
 *   cai_account_required  → send user to CAI onboarding
 *   insufficient_scope    → re-authorize with broader scopes
 *   insufficient_role     → show "contact your CAI admin" (app can't fix)
 *   insufficient_balance  → link to wallet top-up
 *   rate_limit_exceeded   → back off, honor Retry-After
 *
 * Falls back to ``upstream_error`` if the body is not JSON-shaped or the
 * ``error`` field is absent — non-Sarv providers (Gemini, a proxy's HTML error
 * page) land there by design, which keeps caller-side type discrimination
 * uniform.
 */
export async function parseSarvApiError(response: Response): Promise<SarvApiError> {
  const raw = await response.text().catch(() => '');
  let body: any = undefined;
  try { body = JSON.parse(raw); } catch { /* not JSON */ }

  // FastAPI HTTPException wraps the payload in { detail: { error, message } }.
  const payload = body?.detail ?? body;
  const errCode: string | undefined =
    (typeof payload === 'object' && payload && typeof payload.error === 'string')
      ? payload.error
      : undefined;

  const code: SarvErrorCode = (errCode && KNOWN_CODES.has(errCode as SarvErrorCode))
    ? (errCode as SarvErrorCode)
    : (response.status === 401 ? 'invalid_token'
      : response.status === 402 ? 'insufficient_balance'
      : response.status === 429 ? 'rate_limit_exceeded'
      : 'upstream_error');

  const retryAfterHeader = response.headers.get('retry-after');
  const retryAfterSec = retryAfterHeader ? Number(retryAfterHeader) || undefined : undefined;

  // Prefer the server's own message. Otherwise name the status and, when there
  // IS a body, quote a truncated slice of it — that snippet is what identifies
  // an HTML proxy interstitial in the log. Omitted entirely for an empty body
  // so the message never ends in a dangling colon.
  const snippet = raw.trim().slice(0, 200);
  const message =
    (typeof payload === 'object' && payload && typeof payload.message === 'string')
      ? payload.message
      : `Sarv API ${response.status}${snippet ? `: ${snippet}` : ''}`;

  return new SarvApiError(message, { status: response.status, code, retryAfterSec, detail: payload });
}
