/**
 * One AI split of a thread's first email: regions → chunks → one completion
 * per chunk → checked outputs → parts. Returns a typed outcome and writes
 * nothing (the store does the one save).
 *
 * The outcome's status is what the cache records, and the difference between
 * its failure kinds is the difference between retrying and not:
 *
 *   | failure                                              | outcome                     |
 *   |------------------------------------------------------|-----------------------------|
 *   | auth, credit, "No AI provider configured"            | `provider` — no row written |
 *   | rate limit, gateway, network, timeout, 5xx, unknown  | `transient`                 |
 *   | an empty or unparseable answer                       | `transient`                 |
 *   | another 4xx (the provider rejects the request)       | `failed` / `client`         |
 *   | an answer with no usable output                      | `transient` / `unusable`    |
 *   | a body with nothing to send (no AI call)             | `failed` / `unusable`       |
 *   | every region over budget (no AI call)                | `failed` / `too_large`      |
 *
 * An answer that parsed but left nothing usable is the model's (not
 * deterministic), so it gets one retry like an unparseable one — core's
 * `nextFailureState` makes the SECOND bad answer in a row `failed`.
 *
 * A provider-wide failure is not this thread's problem: recording it per
 * thread would mark every thread opened while the key was bad as failed (and
 * `makeAICompletion` already reports the provider unhealthy). A transient
 * failure in ANY chunk makes the whole run transient, with no parts kept — a
 * half-split first email stored as a success would never be retried.
 */
import type { ChatMessage } from '@sarv-in/email-chat-view';
import type { EmailRecord } from '@sarvinbox/core';
import { classifyAIError } from '@sarvinbox/core/ai-error';
import type { FirstSplitErrorKind, FirstSplitPart, FirstSplitRosterEntry } from '@sarvinbox/core/first-split';
import { createLogger } from '@sarvinbox/core/logger';

import { makeAICompletion } from '../ai-service';

import { buildSplitPrompt } from './prompt';
import { chunkRegions, splitRegions, type RegionOptions } from './regions';
import {
  buildParts,
  parseSplitResponse,
  validateChunkOutputs,
  type AcceptedOutput,
  type RejectReason,
} from './validate';

const log = createLogger('FirstSplit');

/** The completion call — `makeAICompletion`'s shape, injectable for tests. */
export type CompleteFn = (options: {
  systemPrompt: string;
  userPrompt: string;
  maxTokens?: number;
  responseFormat?: 'json_object';
  onStatus?: (status: string) => void;
}) => Promise<string>;

/** What one run splits. */
export interface SplitFirstEmailInput {
  /** The thread's first member, exactly as main returned it (`withSource`). */
  source: EmailRecord;
  /** The members' distinct senders. */
  roster: readonly FirstSplitRosterEntry[];
  /** Standard's turns carried by `source` (the library split of `[source]`, before dedupe). */
  standard: readonly ChatMessage[];
  /** Status text for the waiting UI ("AI provider busy — retrying in 8s"). */
  onStatus?: (status: string) => void;
}

export type SplitOutcomeStatus = 'ok' | 'partial' | 'transient' | 'failed' | 'provider';

/** The result of one run, for the store to save and log. */
export interface SplitOutcome {
  status: SplitOutcomeStatus;
  /** Present for `ok` / `partial`. */
  parts?: FirstSplitPart[];
  /** Why it did not succeed (absent for `ok` / `partial` / `provider`). */
  errorKind?: FirstSplitErrorKind;
  /** A provider-wide failure's reason, for the log. */
  reason?: string;
  /** Diagnostics for the one aggregate log line — counts, never bodies. */
  regions: number;
  chunks: number;
  fallbackRegions: number;
  aiParts: number;
  fallbackParts: number;
  rejected: Partial<Record<RejectReason, number>>;
}

export interface SplitDeps {
  complete?: CompleteFn;
  regionOptions?: RegionOptions;
  /** Unix seconds; stands in for an unreadable first-email date. */
  now?: () => number;
}

/** How a thrown completion error maps onto an outcome. */
export function classifySplitError(error: unknown): {
  status: 'provider' | 'transient' | 'failed';
  errorKind?: FirstSplitErrorKind;
  reason: string;
} {
  const message = error instanceof Error ? error.message : String(error ?? '');
  if (/no ai provider configured/i.test(message)) {
    return { status: 'provider', reason: 'No AI provider configured' };
  }
  const info = classifyAIError(error);
  if (info.kind === 'auth' || info.kind === 'credit') return { status: 'provider', reason: info.reason };
  if (info.kind === 'client') return { status: 'failed', errorKind: 'client', reason: info.reason };
  return { status: 'transient', errorKind: info.kind, reason: info.reason };
}

/** The current time in Unix seconds — the first-split feature's one clock. */
export const nowSeconds = (): number => Math.floor(Date.now() / 1000);

/** Split the first email. Never throws; every failure is an outcome. */
export async function splitFirstEmail(input: SplitFirstEmailInput, deps: SplitDeps = {}): Promise<SplitOutcome> {
  const complete = deps.complete ?? makeAICompletion;
  const { source } = input;
  const base: SplitOutcome = {
    status: 'failed',
    regions: 0,
    chunks: 0,
    fallbackRegions: 0,
    aiParts: 0,
    fallbackParts: 0,
    rejected: {},
  };

  const sentAt = source.date > 0 ? new Date(source.date * 1000) : undefined;
  const regions = splitRegions(source.rawBody, { sentAt, ...deps.regionOptions });
  if (!regions) return { ...base, errorKind: 'unusable' };
  const plan = chunkRegions(regions);
  const outcome: SplitOutcome = {
    ...base,
    regions: regions.length,
    chunks: plan.chunks.length,
    fallbackRegions: plan.fallbackRegions.length,
  };
  if (plan.tooLarge) return { ...outcome, errorKind: 'too_large' };
  if (plan.chunks.length === 0) return { ...outcome, errorKind: 'unusable' };

  const carrier = {
    fromAddress: source.fromAddress || '',
    fromName: source.fromName,
    toAddress: source.toAddress,
    date: source.date,
  };
  const accepted: AcceptedOutput[] = [];
  let truncated = false;

  for (const [index, chunk] of plan.chunks.entries()) {
    const prompt = buildSplitPrompt(chunk, carrier);
    let response: string;
    try {
      response = await complete({ ...prompt, responseFormat: 'json_object', onStatus: input.onStatus });
    } catch (error) {
      const failure = classifySplitError(error);
      log.trace(`chunk ${index + 1}/${plan.chunks.length} threw kind=${failure.errorKind ?? failure.status}`);
      return { ...outcome, status: failure.status, errorKind: failure.errorKind, reason: failure.reason };
    }
    if (!response || !response.trim()) return { ...outcome, status: 'transient', errorKind: 'empty' };
    const parsed = parseSplitResponse(response);
    if (!parsed) return { ...outcome, status: 'transient', errorKind: 'unparseable' };
    if (parsed.truncated) truncated = true;
    const checked = validateChunkOutputs(parsed.messages, chunk, {
      truncated: parsed.truncated,
      parser: deps.regionOptions?.parser,
    });
    accepted.push(...checked.accepted);
    for (const reason of checked.rejected) outcome.rejected[reason] = (outcome.rejected[reason] ?? 0) + 1;
    log.trace(
      `chunk ${index + 1}/${plan.chunks.length} regions=${chunk.regions.map((region) => region.index).join(',')}`
      + ` chars=${chunk.chars} outputs=${parsed.messages.length} accepted=${checked.accepted.length}`
      + `${parsed.truncated ? ' truncated' : ''}`,
    );
  }

  const built = buildParts({
    accepted,
    standard: input.standard,
    first: source,
    roster: input.roster,
    truncated,
    nowSeconds: (deps.now ?? nowSeconds)(),
    registerImage: deps.regionOptions?.registerImage,
    parser: deps.regionOptions?.parser,
  });
  const counted = { ...outcome, aiParts: built.aiParts, fallbackParts: built.fallbackParts };
  if (built.status === 'failed') return { ...counted, status: 'transient', errorKind: built.errorKind };
  return { ...counted, status: built.status, parts: built.parts };
}
