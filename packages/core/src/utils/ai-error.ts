// Classify an AI-provider failure into "the user must fix it" vs "it will
// likely fix itself." The single source of truth for deciding, after AI
// categorization stops mid-run, whether to surface a Fix banner (terminal) or
// silently auto-restart (transient). Built on the existing HTTP/network error
// predicates so there's one definition of each failure shape.

import {
  isAuthError,
  isConnectionError,
  isRateLimited,
  isUpstreamError,
} from '../imap/imap-errors';

export type AIErrorKind =
  | 'auth' // bad / expired API key or token
  | 'credit' // out of credits / billing needs attention
  | 'rate_limit' // provider throttling
  | 'upstream' // 502/503/504 gateway
  | 'network' // socket / DNS level
  | 'timeout'
  | 'server' // generic 5xx
  | 'client' // other 4xx (bad request) — won't fix by retrying
  | 'unknown';

export interface AIErrorInfo {
  kind: AIErrorKind;
  /**
   * true = the failure needs the user to act (invalid key, no credits, a 4xx);
   * auto-retrying is pointless, so show the Fix banner instead. false = a
   * transient/"our side" problem (network, gateway, rate limit) that should be
   * retried automatically.
   */
  terminal: boolean;
  status?: number;
  /** Short human message suitable for the "AI is inactive" banner. */
  reason: string;
}

const textOf = (err: unknown): string => {
  if (!err) return '';
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code;
    return `${err.message} ${typeof code === 'string' ? code : ''}`.toLowerCase();
  }
  return String(err).toLowerCase();
};

const statusOf = (err: unknown): number | undefined => {
  const s = (err as { status?: unknown; statusCode?: unknown })?.status
    ?? (err as { statusCode?: unknown })?.statusCode;
  return typeof s === 'number' ? s : undefined;
};

/**
 * Out-of-credits / billing failure — terminal even when the provider dresses it
 * up as a 429 (e.g. OpenAI's `insufficient_quota`). Distinct from a plain rate
 * limit, which IS transient.
 */
function isCreditError(err: unknown): boolean {
  if (statusOf(err) === 402) return true;
  const m = textOf(err);
  return (
    m.includes('insufficient_balance') ||
    m.includes('insufficient balance') ||
    m.includes('insufficient_quota') ||
    m.includes('insufficient funds') ||
    m.includes('exceeded your current quota') ||
    m.includes('payment required') ||
    m.includes('billing') ||
    m.includes('out of credit') ||
    m.includes('no credit') ||
    m.includes('add credit') ||
    m.includes('top up') ||
    m.includes('topup')
  );
}

export function classifyAIError(err: unknown): AIErrorInfo {
  const status = statusOf(err);
  const m = textOf(err);

  // --- Sarv CAI-specific terminal conditions: surface the provider's own,
  //     actionable guidance instead of a generic "auth failed". ---
  if (m.includes('cai_account_required') || m.includes('not linked to a cai')) {
    return {
      kind: 'auth',
      terminal: true,
      status,
      reason: "Your Sarv account isn't linked to a CAI organization yet. Sign in to CAI once to set it up, then re-test the provider.",
    };
  }
  if (m.includes('insufficient_scope') || m.includes('insufficient_role')) {
    return {
      kind: 'auth',
      terminal: true,
      status,
      reason: 'Your Sarv account lacks the required LLM access. Ask your CAI admin to grant it, then re-test the provider.',
    };
  }

  // --- Terminal: needs the user to act; auto-retry can't help. ---
  if (isCreditError(err)) {
    return {
      kind: 'credit',
      terminal: true,
      status,
      reason:
        'AI provider is out of credits (or billing needs attention). Add credits / update billing, then re-test the provider.',
    };
  }
  if (isAuthError(err) || status === 401 || status === 403) {
    return {
      kind: 'auth',
      terminal: true,
      status,
      reason:
        'AI authentication failed — your API key may be invalid or expired. Update it, then re-test the provider.',
    };
  }

  // --- Transient: will likely recover; keep retrying automatically. ---
  if (isRateLimited(err) || status === 429) {
    return { kind: 'rate_limit', terminal: false, status, reason: 'The AI provider is rate-limiting requests.' };
  }
  if (isUpstreamError(err)) {
    return {
      kind: 'upstream',
      terminal: false,
      status,
      reason: 'The AI provider is temporarily unavailable (gateway error).',
    };
  }
  if (isConnectionError(err)) {
    return { kind: 'network', terminal: false, status, reason: 'Could not reach the AI provider (network issue).' };
  }
  if (status === 408 || m.includes('timed out') || m.includes('timeout')) {
    return { kind: 'timeout', terminal: false, status, reason: 'The AI provider timed out.' };
  }
  if (typeof status === 'number' && status >= 500) {
    return { kind: 'server', terminal: false, status, reason: 'The AI provider returned a server error.' };
  }

  // --- Other 4xx (bad request, not found, unprocessable) — a request the
  //     provider will keep rejecting, so treat as terminal rather than loop. ---
  if (typeof status === 'number' && status >= 400 && status < 500) {
    return {
      kind: 'client',
      terminal: true,
      status,
      reason: `The AI provider rejected the request (HTTP ${status}). Check your provider settings.`,
    };
  }

  return {
    kind: 'unknown',
    terminal: false,
    status,
    reason: status ? `The AI provider request failed (HTTP ${status}).` : 'The AI provider request failed.',
  };
}
