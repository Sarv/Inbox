/**
 * The first-email split cache — its key, its validity rules and its retry
 * policy, as pure functions.
 *
 * The chat view's AI mode shows every message exactly as the Standard view
 * does, except the FIRST email of the thread: that one often carries a
 * looped-in recipient's whole earlier conversation as quoted history, and the
 * AI splits it into the messages it quotes. The result is cached one row per
 * thread (`first_email_splits`), and everything that decides whether a cached
 * row may be SHOWN, whether a run should START, and whether a result may
 * REPLACE what is stored lives here, so main (which writes) and the renderer
 * (which reads and runs) cannot disagree.
 *
 * The rules that matter, each pinned in first-split.test.ts:
 *
 *   * A row is only ever shown for the exact email and body it was computed
 *     from ({@link isFirstSplitCurrent}): same first email, same stored body
 *     bytes, same {@link FIRST_SPLIT_VERSION}. Anything else is a miss — a
 *     stale split would put another email's history in the first slot.
 *   * A failure never destroys a good split for the same key
 *     ({@link shouldReplace}).
 *   * Transient failures back off exponentially and stop after
 *     {@link FIRST_SPLIT_MAX_ATTEMPTS} ({@link nextFailureState}), so a broken
 *     provider cannot turn a 45-second scheduler into a retry storm.
 *
 * Times are Unix SECONDS throughout, matching the table's `unixepoch()`.
 * Zero-dependency beyond two pure core modules (and a type-only import of
 * `EmailRecord`, erased at build): aliased into the renderer as
 * `@sarvinbox/core/first-split`.
 */
import type { EmailRecord } from '../types/models';

import type { ConversationSender } from './conversation-membership';
import { fnv1aFingerprint } from './fnv1a';
import { messageIdKey } from './message-id';

/**
 * Bump when the prompt, the validation or the part shape changes: every
 * stored row then reads as a miss and is re-split once.
 */
export const FIRST_SPLIT_VERSION = 1;

/** After this many attempts, automatic runs stop; only a manual retry runs it. */
export const FIRST_SPLIT_MAX_ATTEMPTS = 5;

/** First retry delay, doubled per attempt. */
export const FIRST_SPLIT_BACKOFF_BASE_SECONDS = 300;

/** Ceiling on the retry delay (6 hours). */
export const FIRST_SPLIT_BACKOFF_CAP_SECONDS = 21_600;

/**
 * The stored outcome of a run.
 *
 *   * `ok` / `partial` — usable parts (`partial`: some regions fell back to
 *     Standard's own rendering of them).
 *   * `skipped` — the first email is not eligible for an automatic split
 *     (quotes fewer than two messages, or is bulk mail); recorded so the
 *     background job does not nominate it again.
 *   * `transient` — the provider failed in a way that may fix itself; retried
 *     on the backoff schedule.
 *   * `failed` — retrying will not help (a 4xx, a second bad answer in a row,
 *     a body too large to split); only a manual retry, or a provider change
 *     for a 4xx.
 */
export type FirstSplitStatus = 'ok' | 'partial' | 'skipped' | 'transient' | 'failed';

/**
 * Error kinds a run records: the transient `AIErrorKind`s, the model's answer
 * being empty or unparseable, a 4xx (`client`), no usable output (`unusable`),
 * and a body too large to split (`too_large`). Stored as free text; the policy
 * below reads the bad-answer kinds (`unparseable`, `unusable`) and `client`.
 */
export type FirstSplitErrorKind =
  | 'rate_limit' | 'upstream' | 'network' | 'timeout' | 'server' | 'unknown'
  | 'empty' | 'unparseable' | 'client' | 'unusable' | 'too_large';

/**
 * Identity of the input a split was computed from. Computed by MAIN only, from
 * the stored row: the renderer sees the body inflated (inline images put back
 * as `data:` URIs) or freshly streamed from IMAP, and a fingerprint of either
 * would never match the stored bytes.
 */
export interface FirstSplitKey {
  threadId: string;
  /** {@link firstMemberKeyOf} the thread's first conversation member. */
  firstKey: string;
  /** That email's row id — how composition finds it; NOT part of validity. */
  firstEmailId: string;
  /** {@link sourceFingerprintOf} its stored raw body. */
  fingerprint: string;
}

/** One message recovered from the first email. Ids are not stored; composition derives them. */
export interface FirstSplitPart {
  /** `own` — what the first email's sender wrote; `quote` — a message it quotes. */
  role: 'own' | 'quote';
  fromAddress: string;
  fromName: string | null;
  /** Unix seconds, never 0 — a quote with no date gets an approximate one. */
  date: number;
  /** True when {@link date} was estimated rather than read from the attribution. */
  dateApprox: boolean;
  /** Cleaned HTML of the message body. */
  body: string;
  /** True when this part is Standard's rendering of a region the AI did not cover. */
  fallback: boolean;
}

/** One `first_email_splits` row, camel-cased. */
export interface FirstSplitRow {
  threadId: string;
  firstKey: string;
  firstEmailId: string;
  sourceFingerprint: string;
  splitVersion: number;
  status: FirstSplitStatus;
  quoteCount: number | null;
  /** JSON array of {@link FirstSplitPart}; non-null exactly when status is ok/partial. */
  parts: string | null;
  errorKind: string | null;
  attempts: number;
  /** Unix seconds; set only on `transient` rows. */
  nextRetryAt: number | null;
  /** Provider signature the run used. */
  modelUsed: string | null;
  updatedAt: number;
}

/**
 * The first email's identity: its Message-ID in lookup form, or `id:<row id>`
 * when it has none. Message-ID first because the row id is local — a resync
 * that re-creates the row keeps the same message, and the same split.
 */
export function firstMemberKeyOf(email: { id: string; messageId?: string | null }): string {
  return messageIdKey(email.messageId) || `id:${email.id}`;
}

/** Fingerprint of a first email's STORED raw body (`len:fnv1a32hex`). Main only. */
export function sourceFingerprintOf(storedRawBody: string | null | undefined): string {
  return fnv1aFingerprint(storedRawBody ?? '');
}

/** Build the key for a thread's first member and its stored raw body. */
export function firstSplitKeyFor(
  threadId: string,
  first: { id: string; messageId?: string | null },
  storedRawBody: string | null | undefined,
): FirstSplitKey {
  return {
    threadId,
    firstKey: firstMemberKeyOf(first),
    firstEmailId: first.id,
    fingerprint: sourceFingerprintOf(storedRawBody),
  };
}

/**
 * Was this row computed from exactly the current first email, body and split
 * version? Says nothing about whether the row is a SUCCESS — see
 * {@link isUsableSplit}.
 */
export function isFirstSplitCurrent(
  row: Pick<FirstSplitRow, 'threadId' | 'firstKey' | 'sourceFingerprint' | 'splitVersion'> | null | undefined,
  key: FirstSplitKey | null | undefined,
): boolean {
  return !!row && !!key
    && row.threadId === key.threadId
    && row.splitVersion === FIRST_SPLIT_VERSION
    && row.firstKey === key.firstKey
    && row.sourceFingerprint === key.fingerprint;
}

const isNonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '';

function isValidPart(value: unknown): value is FirstSplitPart {
  if (!value || typeof value !== 'object') return false;
  const part = value as Record<string, unknown>;
  return (part.role === 'own' || part.role === 'quote')
    && typeof part.fromAddress === 'string'
    && (part.fromName === null || typeof part.fromName === 'string')
    && typeof part.date === 'number' && Number.isFinite(part.date) && part.date > 0
    && typeof part.dateApprox === 'boolean'
    && isNonEmptyString(part.body)
    && typeof part.fallback === 'boolean';
}

/**
 * Parse a stored `parts` column, or `null` when it cannot be shown: malformed
 * JSON, not an array, empty, a part of the wrong shape, a BLANK body, or more
 * than one `own` part (both would take the first email's own id).
 *
 * Null rather than "the good parts": a row that is partly unreadable is a row
 * whose split cannot be trusted, and the first slot then shows Standard's
 * rendering — nothing is stripped.
 */
export function parseFirstSplitParts(json: string | null | undefined): FirstSplitPart[] | null {
  if (typeof json !== 'string' || json === '') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return null;
  if (!parsed.every(isValidPart)) return null;
  if (parsed.filter((part) => part.role === 'own').length > 1) return null;
  return parsed;
}

/** May this row be SHOWN for this key? Current, a success, and its parts readable. */
export function isUsableSplit(row: FirstSplitRow | null | undefined, key: FirstSplitKey | null | undefined): boolean {
  return !!row
    && isFirstSplitCurrent(row, key)
    && (row.status === 'ok' || row.status === 'partial')
    && parseFirstSplitParts(row.parts) !== null;
}

/**
 * What the cache says about this thread right now.
 *
 *   * `usable` — show it; no AI.
 *   * `miss` — no row for this key (none, stale, another version, unreadable
 *     parts): an automatic run may start.
 *   * `skipped` — ineligible last time it was looked at; an on-open run may
 *     still start when the chat rules say this email is eligible now.
 *   * `due` — a transient failure whose retry time has come.
 *   * `retry-later` — a transient failure still backing off.
 *   * `failed` — permanent, or out of automatic attempts: manual only.
 *   * `failed-retryable` — failed with a 4xx under a DIFFERENT provider than
 *     the one configured now; the new provider deserves one try.
 */
export type FirstSplitState =
  | 'usable' | 'skipped' | 'failed' | 'failed-retryable' | 'retry-later' | 'due' | 'miss';

/** Failure kinds a provider change can plausibly fix (a 4xx is the provider's verdict on the request). */
const PROVIDER_DEPENDENT_FAILURES: ReadonlySet<string> = new Set(['client']);

export function firstSplitStateFor(
  row: FirstSplitRow | null | undefined,
  key: FirstSplitKey | null | undefined,
  now: number,
  providerSig?: string | null,
): FirstSplitState {
  if (!row || !isFirstSplitCurrent(row, key)) return 'miss';
  switch (row.status) {
    case 'ok':
    case 'partial':
      return parseFirstSplitParts(row.parts) !== null ? 'usable' : 'miss';
    case 'skipped':
      return 'skipped';
    case 'transient':
      if (row.attempts >= FIRST_SPLIT_MAX_ATTEMPTS) return 'failed';
      return row.nextRetryAt === null || row.nextRetryAt <= now ? 'due' : 'retry-later';
    case 'failed':
      return PROVIDER_DEPENDENT_FAILURES.has(row.errorKind ?? '')
        && !!providerSig && !!row.modelUsed && row.modelUsed !== providerSig
        ? 'failed-retryable'
        : 'failed';
    default:
      // An unknown status (a newer build's row read by an older one) is not
      // something this build can show or reason about.
      return 'miss';
  }
}

/** Retry delay after the `attempt`-th consecutive failure: 300 s doubling, capped at 6 h. */
export function firstSplitBackoffSeconds(attempt: number): number {
  const n = Math.max(1, Math.floor(attempt));
  // 2^(n-1) overflows nothing that matters: the cap is reached at n = 8.
  return Math.min(FIRST_SPLIT_BACKOFF_BASE_SECONDS * 2 ** (n - 1), FIRST_SPLIT_BACKOFF_CAP_SECONDS);
}

/** The model answered, but nothing usable came of it (see {@link nextFailureState}). */
const BAD_ANSWER_KINDS: ReadonlySet<string> = new Set<FirstSplitErrorKind>(['unparseable', 'unusable']);
const isBadAnswer = (kind: string | null | undefined): boolean => BAD_ANSWER_KINDS.has(kind ?? '');

/** What a failed run writes: its status, attempt count and next retry time. */
export interface FirstSplitFailureState {
  status: 'transient' | 'failed';
  attempts: number;
  nextRetryAt: number | null;
}

/**
 * The failure bookkeeping for a run that did not produce parts.
 *
 *   * Attempts count the CONSECUTIVE transient failures for the same key: they
 *     continue only from a current `transient` row, and restart at 1 after
 *     anything else — a new key (another first email or a changed body is a
 *     new problem), or a `failed`/`skipped`/success row. So a manual "Try
 *     again" on a failed row that then hits a network blip is an ordinary
 *     first transient failure, retried automatically, rather than inheriting
 *     the failed row's count and reading as out of attempts at once.
 *   * A transient failure retries after {@link firstSplitBackoffSeconds}.
 *   * A BAD ANSWER — `unparseable`, or `unusable` (it parsed, but no output
 *     survived the checks) — is given ONE retry (models are not
 *     deterministic); only a SECOND bad answer in a row becomes `failed` —
 *     the answer is not going to improve on its own, and every retry is a
 *     paid call. A rate limit or a timeout followed by one bad answer is two
 *     different transient problems, not a verdict. (An `unusable` found
 *     BEFORE any AI call — a body with nothing to send — is deterministic and
 *     arrives as `failed` already.)
 *   * A permanent failure has no retry time.
 */
export function nextFailureState(
  previous: FirstSplitRow | null | undefined,
  key: FirstSplitKey,
  outcome: { status: 'transient' | 'failed'; errorKind: FirstSplitErrorKind | null },
  now: number,
): FirstSplitFailureState {
  const continuing = !!previous && isFirstSplitCurrent(previous, key) && previous.status === 'transient';
  const attempts = continuing ? previous.attempts + 1 : 1;
  if (outcome.status === 'failed') return { status: 'failed', attempts, nextRetryAt: null };
  if (isBadAnswer(outcome.errorKind) && continuing && isBadAnswer(previous.errorKind)) {
    return { status: 'failed', attempts, nextRetryAt: null };
  }
  return { status: 'transient', attempts, nextRetryAt: now + firstSplitBackoffSeconds(attempts) };
}

/**
 * May an incoming result overwrite the stored row? The one guard against a
 * failed or lesser re-run destroying a good split.
 *
 *   * No stored row, or one for a different key (another first email, a
 *     changed body, an older version): always — the stored row is dead.
 *   * `ok` replaces anything.
 *   * `partial` replaces anything except a usable `ok`.
 *   * `skipped`, `transient`, `failed` never replace a usable split; the
 *     caller reports the write as kept.
 */
export function shouldReplace(
  existing: FirstSplitRow | null | undefined,
  key: FirstSplitKey,
  incoming: FirstSplitStatus,
): boolean {
  if (!existing || !isFirstSplitCurrent(existing, key)) return true;
  if (incoming === 'ok') return true;
  const existingUsable = isUsableSplit(existing, key);
  if (incoming === 'partial') return !(existingUsable && existing.status === 'ok');
  return !existingUsable;
}

/**
 * Do two keys name the same split INPUT — same thread, same first email, same
 * stored body? The row id (`firstEmailId`) is deliberately not compared: a
 * resync that re-creates the row keeps the message, its body and its split.
 */
export function isSameFirstSplitKey(
  a: FirstSplitKey | null | undefined,
  b: FirstSplitKey | null | undefined,
): boolean {
  return !!a && !!b
    && a.threadId === b.threadId
    && a.firstKey === b.firstKey
    && a.fingerprint === b.fingerprint;
}

// ---------------------------------------------------------------------------
// The IPC contract (`ai:firstSplit:*`). Main owns the key and the writes; the
// renderer runs the AI. Declared here, beside the rules, so both processes
// type the same shapes (the renderer imports this module through its alias).
// ---------------------------------------------------------------------------

/** What the renderer asks main to store after a run (`ai:firstSplit:save`). */
export interface FirstSplitSaveRequest {
  /**
   * The key the run's input was read under — main's own `current`, returned
   * by `ai:firstSplit:get`. Main recomputes it inside the write and refuses
   * the save (`stale`) when the first email or its stored body has changed
   * since, so a run can never cache a split of an email that is no longer
   * first.
   */
  key: FirstSplitKey;
  status: FirstSplitStatus;
  /** Required (and non-empty) for `ok`/`partial`; ignored otherwise. */
  parts?: FirstSplitPart[] | null;
  errorKind?: string | null;
  /** How many earlier messages the first email quotes, when known. */
  quoteCount?: number | null;
  /** Provider signature the run used. */
  modelUsed?: string | null;
}

/**
 * Why a save wrote nothing:
 *
 *   * `stale` — the first email, or its stored body, changed during the run;
 *   * `kept` — a failure or a skip would have replaced a usable split for the
 *     same key ({@link shouldReplace});
 *   * `invalid` — the payload itself is malformed (a success without readable
 *     parts, an unknown status).
 */
export type FirstSplitSaveReason = 'stale' | 'kept' | 'invalid';

export interface FirstSplitSaveResult {
  applied: boolean;
  reason?: FirstSplitSaveReason;
  /**
   * The status actually stored when `applied`. It can differ from the request:
   * a second `unparseable` answer in a row is stored as `failed`
   * ({@link nextFailureState}).
   */
  status?: FirstSplitStatus;
}

/** Main's view of the thread right now: the key plus what the eligibility rules read. */
export interface FirstSplitCurrent extends FirstSplitKey {
  /** How many conversation members the thread has (drafts and Trash copies excluded). */
  memberCount: number;
  /** How many distinct sender addresses among those members. */
  distinctSenders: number;
}

/**
 * One distinct sender among the members — the split's name-to-address lookup.
 * The membership module's {@link ConversationSender}: main builds the roster
 * with `conversationSenders`, and `FirstSplitCurrent.distinctSenders` is its
 * length.
 */
export type FirstSplitRosterEntry = ConversationSender;

/** `ai:firstSplit:get`'s answer. */
export interface FirstSplitGetResult {
  /** The stored row, whatever key it was computed for (the caller checks). */
  row: FirstSplitRow | null;
  /** Null when the thread has no member (it is gone, or holds only drafts). */
  current: FirstSplitCurrent | null;
  /** With `withSource`: the FIRST MEMBER's record — exactly what a run splits. */
  source?: EmailRecord | null;
  /** With `withSource`: the members' distinct senders. */
  roster?: FirstSplitRosterEntry[];
}

/**
 * What clearing one account's cache removed. The table also holds bookkeeping
 * rows — `skipped` (the scheduler looked and found no quoted history),
 * `transient` and `failed` — which are not splits: counting them as splits
 * would tell the user hundreds were cleared when only a handful existed.
 */
export interface FirstSplitClearCounts {
  /** Every row removed, bookkeeping included. */
  removed: number;
  /** Of those, the SAVED SPLITS — `ok` or `partial` rows. */
  splits: number;
}

/** `ai:firstSplit:clearAll`'s answer. */
export interface FirstSplitClearAllResult {
  /** Rows removed across every account that could be cleared, bookkeeping rows included. */
  cleared: number;
  /** Of `cleared`, the saved splits (`ok`/`partial`) — the number the user is told. */
  splits: number;
  /**
   * Accounts whose cache could NOT be cleared. Reported, never counted as 0:
   * an account that failed and an account with nothing cached are the same
   * number and opposite facts.
   */
  failedAccounts: string[];
}
