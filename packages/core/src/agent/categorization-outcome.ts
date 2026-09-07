/**
 * What ONE categorization pass over one email concluded, and what the pipeline
 * should do about it.
 *
 * This lives here, as pure functions, because the branch it replaces was a
 * chain of `else if`s buried in the Electron main-process pipeline service —
 * untestable in practice, and the place where "AI categorization silently stops
 * at 98%" was decided. Every arm of that chain either finalizes the email or
 * leaves it `agent_status='pending'` for the 30s poll to retry, and a single
 * arm that retries forever is enough to park the progress bar for the life of
 * the mailbox. Getting the precedence between the arms right matters as much as
 * the arms themselves, so both are asserted in tests rather than reasoned about
 * in review.
 */

/** How many ATTEMPTED-and-failed passes one email gets before we stop retrying.
 *
 * Generous on purpose: at the pipeline's 30s poll cadence this is ~5 minutes of
 * continuous failure, so an ordinary connection blip or provider hiccup never
 * exhausts it, while a message the provider will never accept stops being
 * retried forever. Deliberately larger than {@link MAX_API_RETRIES}, which
 * counts a *deterministic* parse failure — a defect that repeats identically,
 * so there is no point retrying it many times. */
export const MAX_AGENT_FAILURES = 10;

/** The raw flags a categorization pass sets. */
export interface CategorizationPass {
  /** The LLM answered, but this email's entry was missing or unparseable. */
  parseFailed: boolean;
  /** The call was actually MADE and threw. */
  failed: boolean;
  /** No call was made at all this pass. */
  skipped: boolean;
  /** The skip was because the user turned AI Assist off (vs not ready yet). */
  aiDisabledByUser: boolean;
  /**
   * Whether an AI provider is configured ANYWHERE — live in memory OR persisted
   * on disk from a prior session. Distinguishes "no provider exists at all"
   * (nothing will ever categorize this — finalize) from "a provider exists but
   * isn't applied yet" (startup race / global pause — keep retrying). Optional:
   * when omitted, a skip is treated as the provider-exists (not-ready) case, so
   * only an explicit `false` triggers the no-provider finalize.
   */
  providerConfigured?: boolean;
}

export type CategorizationOutcome =
  /** Categorized. Clear the strike counters. */
  | 'success'
  /** LLM answered but garbled this email — deterministic, few retries. */
  | 'parse-failure'
  /** The call threw — usually transient, many retries. */
  | 'call-failure'
  /** AI is off by the user's choice. Nothing is coming; finalize now. */
  | 'ai-off'
  /**
   * AI Assist is on but NO provider is configured anywhere (none live, none
   * persisted). Like `ai-off`, nothing will ever categorize this — finalize with
   * the local score. Distinct from `ai-off` (an explicit toggle) so the give-up
   * reason is legible, and distinct from `not-ready` (a provider exists but is
   * temporarily unavailable) so a real outage still retries instead of giving up.
   */
  | 'no-provider'
  /** AI is on but not usable yet (config not pushed, or globally paused). */
  | 'not-ready';

/**
 * Reduce the pass flags to a single outcome.
 *
 * Precedence is the load-bearing part. `parseFailed` outranks `failed` because
 * the parse path has its own, much tighter retry budget: a deterministic defect
 * must not be handed the transient path's ten attempts. `aiDisabledByUser`
 * outranks a plain skip because the two need opposite treatment — one finalizes
 * the email, the other keeps it pending — and getting that pair backwards is
 * how mail ends up either permanently uncategorized or permanently pending.
 */
export function classifyCategorizationPass(pass: CategorizationPass): CategorizationOutcome {
  if (pass.parseFailed) return 'parse-failure';
  if (pass.failed) return 'call-failure';
  if (pass.skipped) {
    if (pass.aiDisabledByUser) return 'ai-off';
    // AI Assist is on but no call was made. If NO provider exists anywhere,
    // nothing will ever categorize this email — finalize it (like ai-off) rather
    // than leaving it pending to be re-selected, re-scored and re-logged every
    // poll for the life of the mailbox. A provider that merely isn't applied yet
    // (startup race / paused) is still 'not-ready' and keeps retrying.
    if (pass.providerConfigured === false) return 'no-provider';
    return 'not-ready';
  }
  return 'success';
}

/**
 * The strike budget for an outcome, or `null` when strikes do not apply.
 *
 * `not-ready` returns null on purpose, and this is the one rule most worth
 * stating out loud: AI being unavailable is a GLOBAL condition with its own
 * surfaced error banner. Charging every individual email a strike for it would
 * burn the entire mailbox's retry budget during a single outage and finalize
 * thousands of emails uncategorized — the opposite of the bug we are fixing,
 * and far harder to notice.
 */
export function strikeLimitFor(
  outcome: CategorizationOutcome,
  maxApiRetries: number,
): number | null {
  if (outcome === 'parse-failure') return maxApiRetries;
  if (outcome === 'call-failure') return MAX_AGENT_FAILURES;
  return null;
}

/** What the pipeline must do with the email after this pass. */
export type CategorizationAction =
  /** Write the result and stop revisiting the email. */
  | { type: 'finalize'; outcome: CategorizationOutcome }
  /** Leave it pending; the poll will try again. */
  | { type: 'retry'; outcome: CategorizationOutcome; strikes: number; limit: number | null };

/**
 * Decide finalize-vs-retry for a pass, given the email's strike count for that
 * outcome AFTER this pass has been counted.
 *
 * The invariant that makes the progress bar able to reach 100%: every outcome
 * either finalizes immediately, or retries under a finite limit that finalizes
 * once reached. No arm retries unboundedly — except `not-ready`, which is not
 * an email-level condition at all and resolves globally.
 */
export function decideCategorizationAction(
  outcome: CategorizationOutcome,
  strikes: number,
  maxApiRetries: number,
): CategorizationAction {
  if (outcome === 'success' || outcome === 'ai-off' || outcome === 'no-provider') {
    return { type: 'finalize', outcome };
  }
  const limit = strikeLimitFor(outcome, maxApiRetries);
  if (limit !== null && strikes >= limit) return { type: 'finalize', outcome };
  return { type: 'retry', outcome, strikes, limit };
}
