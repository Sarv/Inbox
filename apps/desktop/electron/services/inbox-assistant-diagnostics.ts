import type { InboxAssistantRunDiagnostics, InboxAssistantRunStatus, InboxAssistantUsage } from '../../src/types/inbox-assistant';

/**
 * The app.log side of a run's diagnostics.
 *
 * app.log is plaintext on disk and feeds crash-report breadcrumbs, while the
 * chat it describes is encrypted. So these lines are built ONLY from ids,
 * fixed words, counts and durations taken from the diagnostics record. Never
 * add the question, a search word, a filename, an address, model output or a
 * caught error's message here. The full record, including the search words,
 * stays in the encrypted chat store.
 */

function counts(values: Record<string, number | undefined>): string {
  const entries = Object.entries(values).filter((entry): entry is [string, number] => typeof entry[1] === 'number' && entry[1] > 0);
  return entries.length ? entries.sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}:${value}`).join(',') : 'none';
}

function tally<T>(items: readonly T[], key: (item: T) => string): Record<string, number> {
  const result: Record<string, number> = {};
  for (const item of items) result[key(item)] = (result[key(item)] ?? 0) + 1;
  return result;
}

function sum<T>(items: readonly T[], pick: (item: T) => number): number {
  return items.reduce((total, item) => total + pick(item), 0);
}

/** Steps that completed in a weaker way than intended. An empty list is a clean run. */
export function inboxAssistantDegradedStages(diagnostics: InboxAssistantRunDiagnostics, usage?: InboxAssistantUsage): string[] {
  const degraded: string[] = [];
  if (diagnostics.plan?.source === 'fallback') degraded.push(`plan_fallback:${diagnostics.plan.failure ?? 'unknown'}`);
  const accounts = diagnostics.accounts ?? [];
  const unavailable = accounts.filter(account => account.status === 'unavailable');
  if (unavailable.length) degraded.push(`accounts_unavailable(${counts(tally(unavailable, account => account.failure?.name ?? 'unknown'))})`);
  const bodyFailures = sum(accounts, account => account.bodyDownloadFailures);
  if (bodyFailures) degraded.push(`body_downloads_failed:${bodyFailures}`);
  const attachmentFailures: Record<string, number> = {};
  for (const account of accounts) for (const [reason, count] of Object.entries(account.attachmentFailures)) attachmentFailures[reason] = (attachmentFailures[reason] ?? 0) + count;
  if (Object.keys(attachmentFailures).length) degraded.push(`attachments_unread(${counts(attachmentFailures)})`);
  const answer = diagnostics.answer;
  if (answer?.first?.format === 'malformed') degraded.push('answer_malformed');
  if (answer?.first && Object.keys(answer.first.rejected).length) degraded.push(`facts_rejected(${counts(answer.first.rejected)})`);
  if (answer?.repair?.pass?.format === 'malformed') degraded.push('repair_malformed');
  if (answer?.repair?.skipped) degraded.push(`repair_skipped:${answer.repair.skipped}`);
  const failedCalls = (usage?.calls ?? []).filter(call => call.status === 'failed');
  if (failedCalls.length) degraded.push(`ai_calls_failed(${counts(tally(failedCalls, call => `${call.purpose ?? 'call'}:${call.errorKind ?? 'unknown'}`))})`);
  return degraded;
}

/** One line per run. Content-free by construction: see the note at the top of this file. */
export function inboxAssistantRunSummary(requestId: string, status: InboxAssistantRunStatus,
  diagnostics: InboxAssistantRunDiagnostics, usage?: InboxAssistantUsage): string {
  const parts = [`run=${requestId}`, `status=${status}`, `route=${diagnostics.route ?? 'none'}`, `outcome=${diagnostics.outcome ?? 'none'}`,
    `ms=${diagnostics.durationMs ?? 0}`];
  if (diagnostics.reviewKind) parts.push(`review=${diagnostics.reviewKind}`);
  if (diagnostics.failure) parts.push(`failed_at=${diagnostics.failure.stage}`, `error=${diagnostics.failure.error.name}`
    + `${diagnostics.failure.error.code ? `/${diagnostics.failure.error.code}` : ''}${diagnostics.failure.error.status ? `/${diagnostics.failure.error.status}` : ''}`);
  const plan = diagnostics.plan;
  if (plan) parts.push(`plan=${plan.source}${plan.failure ? `:${plan.failure}` : ''}${plan.httpStatus ? `/${plan.httpStatus}` : ''}`,
    `queries=${plan.queryCount}`, `followup=${plan.followUp ? 1 : 0}`);
  if (diagnostics.searchBroadened?.length) parts.push(`broadened=${diagnostics.searchBroadened.join('+')}`);
  const accounts = diagnostics.accounts;
  if (accounts) parts.push(`accounts=${accounts.length}`, `unavailable=${accounts.filter(account => account.status === 'unavailable').length}`,
    `searches=${sum(accounts, account => account.searches)}`, `matched=${sum(accounts, account => account.matchedMessages)}`,
    `reviewed=${sum(accounts, account => account.reviewedMessages)}`,
    `evidence=${sum(accounts, account => account.evidenceItems)}/${sum(accounts, account => account.evidenceChars)}`);
  const calls = usage?.calls ?? [];
  if (calls.length) parts.push(`ai_calls=${calls.length}`, `ai_failed=${calls.filter(call => call.status === 'failed').length}`);
  const answer = diagnostics.answer;
  if (answer?.skipped) parts.push(`answer=skipped:${answer.skipped}`);
  if (answer?.first) parts.push(`facts=${answer.factsFinal}/${answer.first.factsReturned + (answer.repair?.pass?.factsReturned ?? 0)}`,
    `rejected=${counts(answer.first.rejected)}`);
  if (answer?.repair) parts.push(`repair=${answer.repair.skipped ? `skipped:${answer.repair.skipped}` : answer.repair.reason}`, `recovered=${answer.repair.factsRecovered}`);
  return parts.join(' ');
}
