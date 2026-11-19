import type { InboxAssistantExchange } from '../types/inbox-assistant';

/**
 * The text a user copies to send with "the agent got this wrong".
 *
 * It is built field by field from a fixed list, never by copying an object, so
 * a field added to the saved record later cannot leak into a report by
 * accident. By default it holds only fixed words, counts, durations and
 * classes: no question, no answer, no mail, no address, no account id and no
 * search words. The search words are added only when the user asks for them,
 * because they are derived from the question.
 *
 * Saved data is read defensively: an older chat, or one written by a newer
 * build, must produce a smaller report, not an exception.
 */

type Json = Record<string, unknown>;

const WORD = /^[A-Za-z0-9_.:/-]{1,80}$/;

function object(value: unknown): Json | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Json : undefined;
}
function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined;
}
/** A fixed identifier (a class, a reason, a model id). Anything that looks like prose is dropped. */
function word(value: unknown): string | undefined {
  return typeof value === 'string' && WORD.test(value) ? value : undefined;
}
function flag(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}
function words(value: unknown): string[] {
  return Array.isArray(value) ? value.map(word).filter((item): item is string => item !== undefined).slice(0, 20) : [];
}
/** Free text the user opted to include. Bounded, and only ever strings. */
function texts(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').map(item => item.slice(0, 200)).slice(0, 20) : [];
}
/** `{ reason: count }` with identifier keys only. */
function tallies(value: unknown): Record<string, number> {
  const result: Record<string, number> = {};
  for (const [key, amount] of Object.entries(object(value) ?? {})) {
    const safeKey = word(key);
    const safeAmount = count(amount);
    if (safeKey && safeAmount !== undefined) result[safeKey] = safeAmount;
  }
  return result;
}
/** Drop keys whose value is undefined, so the report shows only what was recorded. */
function compact<T extends Json>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as Partial<T>;
}
function errorOf(value: unknown): Json | undefined {
  const error = object(value);
  return error ? compact({ name: word(error.name), code: word(error.code), status: count(error.status) }) : undefined;
}
function pass(value: unknown): Json | undefined {
  const result = object(value);
  return result ? compact({ format: word(result.format), factsReturned: count(result.factsReturned), factsVerified: count(result.factsVerified), rejected: tallies(result.rejected) }) : undefined;
}

export interface InboxAssistantDiagnosticsReportOptions {
  /** Add the search words. They come from the question, so this is the user's choice. */
  includeSearchWords?: boolean;
  appVersion?: string;
}

/** Whether there is anything worth copying for this answer. */
export function hasInboxAssistantDiagnostics(exchange: Pick<InboxAssistantExchange, 'diagnostics'>): boolean {
  return object(exchange.diagnostics)?.version === 1;
}

export function inboxAssistantDiagnosticsReport(
  exchange: Pick<InboxAssistantExchange, 'requestId' | 'status' | 'diagnostics' | 'usage' | 'answer'>,
  options: InboxAssistantDiagnosticsReportOptions = {},
): string {
  const diagnostics = object(exchange.diagnostics) ?? {};
  const plan = object(diagnostics.plan);
  const terms = object(plan?.terms);
  const answer = object(diagnostics.answer);
  const repair = object(answer?.repair);
  const failure = object(diagnostics.failure);
  const agent = object(diagnostics.agent);
  const accounts = Array.isArray(diagnostics.accounts) ? diagnostics.accounts.map(object).filter((item): item is Json => !!item) : undefined;
  const calls = Array.isArray(exchange.usage?.calls) ? exchange.usage.calls.map(object).filter((item): item is Json => !!item) : [];
  const report = compact({
    report: 'sarv-inbox-agent-diagnostics',
    version: 1,
    appVersion: word(options.appVersion),
    requestId: word(exchange.requestId),
    status: word(exchange.status),
    route: word(diagnostics.route),
    reviewKind: word(diagnostics.reviewKind),
    outcome: word(diagnostics.outcome),
    durationMs: count(diagnostics.durationMs),
    failure: failure ? compact({ stage: word(failure.stage), error: errorOf(failure.error) }) : undefined,
    plan: plan ? compact({
      source: word(plan.source), failure: word(plan.failure), failedField: word(plan.failedField), httpStatus: count(plan.httpStatus), followUp: flag(plan.followUp), intent: word(plan.intent),
      quoteIntent: flag(plan.quoteIntent), meetingIntent: flag(plan.meetingIntent), invitationIntent: flag(plan.invitationIntent), timeWindow: flag(plan.timeWindow),
      filters: words(plan.filters), queryCount: count(plan.queryCount), topicTermCount: count(plan.topicTermCount),
      participantTermCount: count(plan.participantTermCount), requiredGroupCount: count(plan.requiredGroupCount),
      searchWords: options.includeSearchWords && terms ? compact({
        queries: texts(terms.queries), entityTerms: texts(terms.entityTerms), topicTerms: texts(terms.topicTerms), participantTerms: texts(terms.participantTerms),
        requiredTopicGroups: Array.isArray(terms.requiredTopicGroups) ? terms.requiredTopicGroups.map(texts).slice(0, 12) : [],
        timeWindow: typeof terms.timeWindow === 'string' ? terms.timeWindow.slice(0, 200) : undefined,
      }) : undefined,
    }) : undefined,
    // Accounts are numbered, never named: an id or address identifies the user.
    agent: agent ? compact({
      mode: word(agent.mode), fallback: word(agent.fallback), reasoning: word(agent.reasoning), steps: count(agent.steps), toolCalls: tallies(agent.toolCalls),
      toolErrors: tallies(agent.toolErrors), nudges: count(agent.nudges), stop: word(agent.stop),
      changes: object(agent.changes) ? compact({ sets: count(object(agent.changes)!.sets), messages: count(object(agent.changes)!.messages), autoApplied: count(object(agent.changes)!.autoApplied) }) : undefined,
    }) : undefined,
    searchBroadened: Array.isArray(diagnostics.searchBroadened) ? words(diagnostics.searchBroadened) : undefined,
    accounts: accounts?.map((account, index) => compact({
      account: index + 1, status: word(account.status), failure: errorOf(account.failure), searches: count(account.searches),
      matchedMessages: count(account.matchedMessages), reviewedMessages: count(account.reviewedMessages), evidenceItems: count(account.evidenceItems),
      evidenceChars: count(account.evidenceChars), missingBodies: count(account.missingBodies), bodyDownloadFailures: count(account.bodyDownloadFailures),
      attachmentsRead: count(account.attachmentsRead), attachmentsSkipped: count(account.attachmentsSkipped), attachmentFailures: tallies(account.attachmentFailures),
      truncated: flag(account.truncated), durationMs: count(account.durationMs),
    })),
    answer: answer ? compact({
      skipped: word(answer.skipped), first: pass(answer.first),
      repair: repair ? compact({ reason: word(repair.reason), skipped: word(repair.skipped), sources: count(repair.sources), pass: pass(repair.pass), factsRecovered: count(repair.factsRecovered) }) : undefined,
      factsFinal: count(answer.factsFinal),
    }) : undefined,
    aiCalls: calls.map(call => compact({
      purpose: word(call.purpose), provider: word(call.provider), model: word(call.model), status: word(call.status), attempts: count(call.attempts),
      durationMs: count(typeof call.completedAt === 'number' && typeof call.startedAt === 'number' ? call.completedAt - call.startedAt : undefined),
      inputTokens: count(call.inputTokens), outputTokens: count(call.outputTokens), errorKind: word(call.errorKind), httpStatus: count(call.httpStatus),
    })),
    shown: compact({
      sourceStatus: word(exchange.answer?.sourceStatus), sources: count(exchange.answer?.sources?.length), warnings: count(exchange.answer?.warnings?.length),
    }),
  });
  return JSON.stringify(report, null, 2);
}

const REJECTION_LABELS: Record<string, string> = {
  invalid_fact_shape: 'not in the expected format',
  unknown_source: 'cited an email that was not provided',
  missing_exact_quote: 'quote not found in the email',
  unsupported_number_or_currency: 'number or currency not in the quote',
  personal_sent_attribution: 'said you sent a message you received',
};
const PLAN_FAILURE_LABELS: Record<string, string> = {
  invalid_json: 'the AI reply was not valid JSON', invalid_shape: 'the AI reply was not a usable search plan', too_large: 'the AI reply was too large',
  auth: 'the AI provider rejected the sign-in or key', credit: 'the AI provider is out of credit', rate_limit: 'the AI provider is rate-limiting requests',
  upstream: 'the AI provider is temporarily unavailable', network: 'the AI provider could not be reached', timeout: 'the AI provider timed out',
  server: 'the AI provider returned a server error', client: 'the AI provider rejected the request', cancelled: 'the request was stopped',
};

function rejectedText(rejected: Record<string, number>): string {
  return Object.entries(rejected).map(([reason, amount]) => `${amount} ${REJECTION_LABELS[reason] ?? reason.replace(/_/g, ' ')}`).join('; ');
}

const AGENT_TOOL_LABELS: Record<string, string> = {
  search_mail: 'searched mail', count_mail: 'counted mail', read_message: 'read emails', read_thread: 'read conversations',
  read_attachment: 'read attachments', deep_search: 'searched in depth', classify_messages: 'sorted emails',
  list_accounts: 'listed accounts', list_folders: 'listed folders', list_categories: 'listed categories',
  change_mail: 'prepared mail changes', undo_change: 'undid a change',
};

/** A few plain sentences for the activity panel. The copied report holds the detail. */
export function inboxAssistantDiagnosticsSummary(exchange: Pick<InboxAssistantExchange, 'diagnostics'>): string[] {
  const diagnostics = object(exchange.diagnostics);
  if (diagnostics?.version !== 1) return [];
  const lines: string[] = [];
  const plan = object(diagnostics.plan);
  if (plan?.source === 'model') lines.push('The AI planned the search.');
  if (plan?.source === 'fallback') {
    const failure = word(plan.failure);
    lines.push(`The search used keyword rules because AI planning failed${failure ? `: ${PLAN_FAILURE_LABELS[failure] ?? failure.replace(/_/g, ' ')}` : ''}.`);
  }
  const agent = object(diagnostics.agent);
  if (agent) {
    const steps = count(agent.steps) ?? 0;
    const used = Object.keys(tallies(agent.toolCalls)).map(name => AGENT_TOOL_LABELS[name]).filter((label): label is string => !!label);
    lines.push(`The AI worked in ${steps} ${steps === 1 ? 'step' : 'steps'}${used.length ? ` and ${[...new Set(used)].join(', ')}` : ''}.`);
    if (agent.fallback === 'tools_refused') lines.push('This AI model does not accept tools, so a simpler way of calling them was used.');
    if (agent.reasoning === 'off') lines.push('The AI model\'s reasoning was turned off, because it accepts tools only that way.');
    const errors = Object.values(tallies(agent.toolErrors)).reduce((sum, amount) => sum + amount, 0);
    if (errors) lines.push(`${errors} ${errors === 1 ? 'tool call was' : 'tool calls were'} refused or failed.`);
    if (agent.stop === 'step_limit') lines.push('It ran out of steps before it finished.');
    const changes = object(agent.changes);
    const sets = count(changes?.sets) ?? 0;
    if (sets) {
      const auto = count(changes?.autoApplied) ?? 0;
      lines.push(`It prepared ${sets} ${sets === 1 ? 'change' : 'changes'} to ${count(changes?.messages) ?? 0} emails${auto ? `, and applied ${auto} of those emails for you` : ''}.`);
    }
  }
  const broadened = Array.isArray(diagnostics.searchBroadened) ? diagnostics.searchBroadened : [];
  if (broadened.includes('required_topics')) lines.push('No email mentioned every topic in the question, so the closest matches were used.');
  if (broadened.includes('model_topics')) lines.push('No email matched the AI\'s search exactly, so emails mentioning its key names were used.');
  const accounts = Array.isArray(diagnostics.accounts) ? diagnostics.accounts.map(object).filter((item): item is Json => !!item) : [];
  if (accounts.length) {
    const total = (key: string) => accounts.reduce((sum, account) => sum + (count(account[key]) ?? 0), 0);
    lines.push(`${total('matchedMessages')} matching ${total('matchedMessages') === 1 ? 'email' : 'emails'} found; ${total('reviewedMessages')} read; ${total('evidenceItems')} ${total('evidenceItems') === 1 ? 'excerpt' : 'excerpts'} given to the AI.`);
    const downloads = total('bodyDownloadFailures');
    if (downloads) lines.push(`${downloads} email ${downloads === 1 ? 'download' : 'downloads'} failed.`);
  }
  const answer = object(diagnostics.answer);
  if (answer?.skipped === 'no_evidence') lines.push('The AI was not asked for an answer because the search found no email.');
  const first = object(answer?.first);
  if (first?.format === 'malformed') lines.push('The AI answer was not in the expected format, so none of it could be used.');
  else if (first) {
    const rejected = rejectedText(tallies(first.rejected));
    lines.push(`The AI gave ${count(first.factsReturned) ?? 0} ${count(first.factsReturned) === 1 ? 'statement' : 'statements'}; ${count(first.factsVerified) ?? 0} verified.${rejected ? ` Left out: ${rejected}.` : ''}`);
  }
  const repair = object(answer?.repair);
  if (repair?.skipped === 'no_relevant_sources') lines.push('No second attempt was made: none of the emails found was a close enough match.');
  else if (repair) {
    const second = object(repair.pass);
    lines.push(second?.format === 'malformed' ? 'A second attempt was also not in the expected format.'
      : `A second attempt recovered ${count(repair.factsRecovered) ?? 0} more ${count(repair.factsRecovered) === 1 ? 'statement' : 'statements'}.`);
  }
  const failure = object(diagnostics.failure);
  const stage = word(failure?.stage);
  if (stage) lines.push(`The run stopped with an error while ${({ route: 'reading the request', plan: 'planning the search', search: 'searching', answer: 'preparing the answer', review: 'reviewing mail', agent: 'working on the request' } as Record<string, string>)[stage] ?? stage}.`);
  return lines;
}
