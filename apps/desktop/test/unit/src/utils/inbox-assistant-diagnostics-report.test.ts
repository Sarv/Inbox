import { describe, expect, it } from 'vitest';

import type { InboxAssistantExchange, InboxAssistantRunDiagnostics, InboxAssistantUsage } from '../../../../src/types/inbox-assistant';
import { hasInboxAssistantDiagnostics, inboxAssistantDiagnosticsReport, inboxAssistantDiagnosticsSummary } from '../../../../src/utils/inbox-assistant-diagnostics-report';

// The copied report is the one thing that leaves the device, by the user's own
// hand. It must explain a bad answer and must not carry the user's mail.

const SECRET = 'SECRET';
const diagnostics: InboxAssistantRunDiagnostics = {
  version: 1, route: 'search', outcome: 'related', durationMs: 5120,
  plan: { source: 'fallback', failure: 'rate_limit', httpStatus: 429, followUp: true, intent: 'sent', quoteIntent: true, meetingIntent: false, invitationIntent: false,
    timeWindow: true, filters: ['after', 'from'], queryCount: 2, topicTermCount: 1, participantTermCount: 1, requiredGroupCount: 1,
    terms: { queries: [`${SECRET} customer`, 'quotation'], entityTerms: [`${SECRET} customer`], topicTerms: ['quotation'], participantTerms: [`${SECRET}@customer.example`],
      requiredTopicGroups: [[`${SECRET} customer`]], timeWindow: `${SECRET} last week` } },
  accounts: [
    { accountId: `${SECRET}-account-id`, status: 'searched', searches: 5, matchedMessages: 9, reviewedMessages: 7, evidenceItems: 8, evidenceChars: 21_000, missingBodies: 1,
      bodyDownloadFailures: 1, attachmentsRead: 1, attachmentsSkipped: 2, attachmentFailures: { password_protected: 1, 'threw:TypeError': 1 }, truncated: true, durationMs: 300 },
    { accountId: `${SECRET}-other-id`, status: 'unavailable', failure: { name: 'SqliteError', code: 'SQLITE_BUSY' }, searches: 0, matchedMessages: 0, reviewedMessages: 0,
      evidenceItems: 0, evidenceChars: 0, missingBodies: 0, bodyDownloadFailures: 0, attachmentsRead: 0, attachmentsSkipped: 0, attachmentFailures: {}, truncated: false, durationMs: 4 },
  ],
  answer: { first: { format: 'valid', factsReturned: 3, factsVerified: 1, rejected: { missing_exact_quote: 1, unsupported_number_or_currency: 1 } },
    repair: { reason: 'rejected_facts', sources: 3, factsRecovered: 1, pass: { format: 'valid', factsReturned: 1, factsVerified: 1, rejected: {} } }, factsFinal: 2 },
};
const usage = { currency: 'USD', tokenCountsComplete: true, costComplete: false, calls: [
  { id: `${SECRET}-call`, provider: 'openai', model: 'gpt-5-mini', status: 'failed', startedAt: 1_000, completedAt: 1_900, attempts: 3, tokenSource: 'unavailable', usageComplete: false, costComplete: false,
    purpose: 'plan', errorKind: 'rate_limit', httpStatus: 429 },
  { id: 'b', provider: 'openai', model: 'gpt-5-mini', status: 'completed', startedAt: 2_000, completedAt: 4_500, attempts: 1, inputTokens: 5_000, outputTokens: 300,
    tokenSource: 'provider', usageComplete: true, costComplete: false, purpose: 'answer' },
] } as InboxAssistantUsage;
const exchange: InboxAssistantExchange = {
  id: 'exchange', requestId: 'req-42', status: 'completed', question: `What did we quote ${SECRET}?`, accountIds: [`${SECRET}-account-id`], createdAt: 5,
  answer: { text: `${SECRET} answer text`, sourceStatus: 'related', coverage: [], warnings: [`${SECRET} warning`],
    sources: [{ id: 'S1', kind: 'message', accountId: `${SECRET}-account-id`, accountEmail: `${SECRET}@me.example`, emailId: `${SECRET}-mail`, subject: `${SECRET} subject`,
      from: `${SECRET}@x.example`, to: [], date: 1, folder: 'INBOX', sent: false, excerpt: `${SECRET} excerpt` }] },
  error: `${SECRET} provider said no`, diagnostics, usage,
};

describe('the diagnostics report a user copies', () => {
  // Breaks: a user pastes the report into a support message and has sent their
  // question, an email address, an account id or mail text without knowing.
  it('holds no question, answer, mail, address, account id or search word by default', () => {
    const report = inboxAssistantDiagnosticsReport(exchange, { appVersion: '1.5.0' });
    expect(report).not.toContain(SECRET);
    expect(JSON.parse(report)).toEqual({
      report: 'sarv-inbox-agent-diagnostics', version: 1, appVersion: '1.5.0', requestId: 'req-42', status: 'completed',
      route: 'search', outcome: 'related', durationMs: 5120,
      plan: { source: 'fallback', failure: 'rate_limit', httpStatus: 429, followUp: true, intent: 'sent', quoteIntent: true, meetingIntent: false, invitationIntent: false,
        timeWindow: true, filters: ['after', 'from'], queryCount: 2, topicTermCount: 1, participantTermCount: 1, requiredGroupCount: 1 },
      accounts: [
        { account: 1, status: 'searched', searches: 5, matchedMessages: 9, reviewedMessages: 7, evidenceItems: 8, evidenceChars: 21_000, missingBodies: 1, bodyDownloadFailures: 1,
          attachmentsRead: 1, attachmentsSkipped: 2, attachmentFailures: { password_protected: 1, 'threw:TypeError': 1 }, truncated: true, durationMs: 300 },
        { account: 2, status: 'unavailable', failure: { name: 'SqliteError', code: 'SQLITE_BUSY' }, searches: 0, matchedMessages: 0, reviewedMessages: 0, evidenceItems: 0,
          evidenceChars: 0, missingBodies: 0, bodyDownloadFailures: 0, attachmentsRead: 0, attachmentsSkipped: 0, attachmentFailures: {}, truncated: false, durationMs: 4 },
      ],
      answer: { first: { format: 'valid', factsReturned: 3, factsVerified: 1, rejected: { missing_exact_quote: 1, unsupported_number_or_currency: 1 } },
        repair: { reason: 'rejected_facts', sources: 3, factsRecovered: 1, pass: { format: 'valid', factsReturned: 1, factsVerified: 1, rejected: {} } }, factsFinal: 2 },
      aiCalls: [
        { purpose: 'plan', provider: 'openai', model: 'gpt-5-mini', status: 'failed', attempts: 3, durationMs: 900, errorKind: 'rate_limit', httpStatus: 429 },
        { purpose: 'answer', provider: 'openai', model: 'gpt-5-mini', status: 'completed', attempts: 1, durationMs: 2_500, inputTokens: 5_000, outputTokens: 300 },
      ],
      shown: { sourceStatus: 'related', sources: 1, warnings: 1 },
    });
  });

  // Breaks: the opt-in adds nothing (the developer cannot see what was searched),
  // or adds more than the search words.
  it('adds the search words, and only those, when the user asks for them', () => {
    const report = JSON.parse(inboxAssistantDiagnosticsReport(exchange, { includeSearchWords: true })) as { plan: { searchWords: unknown }; accounts: unknown[] };
    expect(report.plan.searchWords).toEqual({
      queries: [`${SECRET} customer`, 'quotation'], entityTerms: [`${SECRET} customer`], topicTerms: ['quotation'], participantTerms: [`${SECRET}@customer.example`],
      requiredTopicGroups: [[`${SECRET} customer`]], timeWindow: `${SECRET} last week`,
    });
    const { plan: _plan, ...rest } = report;
    expect(JSON.stringify(rest)).not.toContain(SECRET);
  });

  // Breaks: a chat saved by an older or newer build, or a damaged record, throws
  // in the activity panel instead of producing a smaller report. Or prose that
  // ended up in a field meant for an identifier is copied out.
  it('reads a damaged or foreign record field by field without throwing, dropping anything that is not a plain identifier or count', () => {
    const damaged = { ...exchange, requestId: undefined, status: undefined, usage: { calls: [null, 'x', { purpose: `${SECRET} purpose with spaces`, model: 7, attempts: -1, startedAt: 'a', completedAt: 5 }] },
      answer: undefined, diagnostics: {
        version: 1, route: `route ${SECRET}`, outcome: 5, durationMs: 'slow', failure: { stage: 'answer', error: { name: `Failed for ${SECRET}`, code: 'ok_code', status: 403 } },
        plan: { source: 'model', filters: ['from', `bad ${SECRET}`, 3], terms: 'not an object', queryCount: -4 },
        accounts: [null, 'x', { status: 'searched', attachmentFailures: { [`bad key ${SECRET}`]: 1, good: 2, negative: -1 }, failure: 'boom' }],
        answer: { first: 'x', repair: { reason: 'malformed', pass: { format: 'malformed', rejected: [1, 2] } }, factsFinal: 1.4 },
      } } as unknown as InboxAssistantExchange;
    const report = inboxAssistantDiagnosticsReport(damaged, { includeSearchWords: true, appVersion: `${SECRET} build` });
    expect(report).not.toContain(SECRET);
    expect(JSON.parse(report)).toEqual({
      report: 'sarv-inbox-agent-diagnostics', version: 1,
      failure: { stage: 'answer', error: { code: 'ok_code', status: 403 } },
      plan: { source: 'model', filters: ['from'] },
      accounts: [{ account: 1, status: 'searched', attachmentFailures: { good: 2 } }],
      answer: { repair: { reason: 'malformed', pass: { format: 'malformed', rejected: {} } }, factsFinal: 1 },
      aiCalls: [{}], shown: {},
    });
    for (const nothing of [{}, { diagnostics: undefined }, { diagnostics: null }, { diagnostics: 'x' }, { diagnostics: [] }] as unknown as InboxAssistantExchange[]) {
      expect(JSON.parse(inboxAssistantDiagnosticsReport(nothing))).toEqual({ report: 'sarv-inbox-agent-diagnostics', version: 1, aiCalls: [], shown: {} });
      expect(hasInboxAssistantDiagnostics(nothing)).toBe(false);
      expect(inboxAssistantDiagnosticsSummary(nothing)).toEqual([]);
    }
    expect(hasInboxAssistantDiagnostics({ diagnostics: { version: 2 } } as unknown as InboxAssistantExchange)).toBe(false);
    expect(hasInboxAssistantDiagnostics(exchange)).toBe(true);
  });
});

describe('a search that was broadened', () => {
  // Breaks: an answer built from the closest matches, rather than mail about
  // everything the question named, is indistinguishable from a normal one in
  // the panel and in a copied report.
  it('is said in the panel and carried in the report', () => {
    const broadened = { ...exchange, diagnostics: { ...diagnostics, searchBroadened: ['required_topics' as const, 'model_topics' as const] } };
    expect(inboxAssistantDiagnosticsSummary(broadened).slice(1, 3)).toEqual([
      'No email mentioned every topic in the question, so the closest matches were used.',
      'No email matched the AI\'s search exactly, so emails mentioning its key names were used.']);
    expect(JSON.parse(inboxAssistantDiagnosticsReport(broadened))).toMatchObject({ searchBroadened: ['required_topics', 'model_topics'] });
    // A value from another build that is not a list is left out, not copied.
    expect(JSON.parse(inboxAssistantDiagnosticsReport({ ...exchange, diagnostics: { ...diagnostics, searchBroadened: 'required_topics' as never } }))).not.toHaveProperty('searchBroadened');
    expect(inboxAssistantDiagnosticsSummary(exchange).join(' ')).not.toContain('closest matches');
  });
});

describe('the plain-language summary in the activity panel', () => {
  // Breaks: the panel shows reason codes, or says nothing about why an answer
  // was weak, so the user cannot tell a search problem from an AI problem.
  it('says in plain words how the search was planned, what was found, and what was left out', () => {
    expect(inboxAssistantDiagnosticsSummary(exchange)).toEqual([
      'The search used keyword rules because AI planning failed: the AI provider is rate-limiting requests.',
      '9 matching emails found; 7 read; 8 excerpts given to the AI.',
      '1 email download failed.',
      'The AI gave 3 statements; 1 verified. Left out: 1 quote not found in the email; 1 number or currency not in the quote.',
      'A second attempt recovered 1 more statement.',
    ]);
    expect(inboxAssistantDiagnosticsSummary(exchange).join(' ')).not.toContain(SECRET);
  });

  // Breaks: one of the less common endings (nothing found, a malformed reply, a
  // skipped retry, a hard failure, an unknown reason) renders as "undefined".
  it('covers every other way a run can end', () => {
    const of = (value: Partial<InboxAssistantRunDiagnostics>) => inboxAssistantDiagnosticsSummary({ diagnostics: { version: 1, ...value } });
    const plan = { ...diagnostics.plan!, source: 'model' as const };
    const account = { ...diagnostics.accounts![0]!, matchedMessages: 1, reviewedMessages: 1, evidenceItems: 1, bodyDownloadFailures: 2 };
    expect(of({ plan, accounts: [account], answer: { skipped: 'no_evidence', factsFinal: 0 } })).toEqual([
      'The AI planned the search.', '1 matching email found; 1 read; 1 excerpt given to the AI.', '2 email downloads failed.',
      'The AI was not asked for an answer because the search found no email.']);
    expect(of({ answer: { first: { format: 'malformed', factsReturned: 0, factsVerified: 0, rejected: {} },
      repair: { reason: 'malformed', sources: 2, factsRecovered: 0, pass: { format: 'malformed', factsReturned: 0, factsVerified: 0, rejected: {} } }, factsFinal: 0 } })).toEqual([
      'The AI answer was not in the expected format, so none of it could be used.', 'A second attempt was also not in the expected format.']);
    expect(of({ answer: { first: { format: 'valid', factsReturned: 1, factsVerified: 0, rejected: { some_new_reason: 1 } as never },
      repair: { reason: 'rejected_facts', skipped: 'no_relevant_sources', sources: 0, factsRecovered: 0 }, factsFinal: 0 } })).toEqual([
      'The AI gave 1 statement; 0 verified. Left out: 1 some new reason.', 'No second attempt was made: none of the emails found was a close enough match.']);
    expect(of({ answer: { first: { format: 'valid', factsReturned: 2, factsVerified: 2, rejected: {} }, repair: { reason: 'no_facts', sources: 1, factsRecovered: 2,
      pass: { format: 'valid', factsReturned: 2, factsVerified: 2, rejected: {} } }, factsFinal: 4 } })).toEqual([
      'The AI gave 2 statements; 2 verified.', 'A second attempt recovered 2 more statements.']);
    expect(of({ plan: { ...plan, source: 'fallback', failure: 'brand_new_kind' } })).toEqual(['The search used keyword rules because AI planning failed: brand new kind.']);
    expect(of({ plan: { ...plan, source: 'fallback', failure: undefined } })).toEqual(['The search used keyword rules because AI planning failed.']);
    for (const [stage, words] of [['route', 'reading the request'], ['plan', 'planning the search'], ['search', 'searching'], ['answer', 'preparing the answer'], ['review', 'reviewing mail']] as const) {
      expect(of({ failure: { stage, error: { name: 'Error' } } })).toEqual([`The run stopped with an error while ${words}.`]);
    }
    expect(of({ route: 'capability', outcome: 'capability' })).toEqual([]);
    // A damaged record with the counts missing reads as zero, never "undefined".
    const damaged = { accounts: [{}, null], answer: { first: { format: 'valid' }, repair: { reason: 'no_facts', pass: {} } }, failure: { stage: 'some_new_stage' } };
    expect(of(damaged as never)).toEqual([
      '0 matching emails found; 0 read; 0 excerpts given to the AI.',
      'The AI gave 0 statements; 0 verified.', 'A second attempt recovered 0 more statements.',
      'The run stopped with an error while some_new_stage.']);
  });
});
