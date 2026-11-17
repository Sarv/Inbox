import { AI_REQUEST_TIMEOUT_CODE } from '@sarvinbox/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { inboxAssistantDegradedStages, inboxAssistantRunSummary } from '../../../../electron/services/inbox-assistant-diagnostics';
import type { InboxAssistantExchange, InboxAssistantRunDiagnostics, InboxAssistantUsage } from '../../../../src/types/inbox-assistant';
import { createAssistantHarness, promptEvidence, scriptedPurpose, NO_FACTS, type AssistantHarness, type ScriptedAI } from '../../../helpers/assistant-harness';

// A run's diagnostics are the only way to explain a bad answer afterwards: the
// user's machine cannot be reached and app.log must not hold mail. These tests
// run the real agent (see assistant-harness.ts) and read what it saved.

const QUOTE = 'Acme quotation Q-7: total INR 4,50,000 excluding GST.';
const PLAN = JSON.stringify({ queries: ['Acme', 'quotation'], entityTerms: ['Acme'], intent: 'all', quoteIntent: true, filters: {} });

/** A model that plans, then quotes the seeded sentence back exactly. */
const grounded: ScriptedAI = (prompt, purpose) => {
  if (purpose === 'plan') return PLAN;
  const source = promptEvidence(prompt).find(item => item.evidence.includes(QUOTE));
  return source ? JSON.stringify({ facts: [{ text: QUOTE, sourceIds: [source.id], quotes: [{ sourceId: source.id, text: QUOTE }] }] }) : NO_FACTS;
};

let harness: AssistantHarness;
beforeEach(async () => { harness = await createAssistantHarness({ ai: grounded }); });
afterEach(async () => { await harness.close(); });

async function seedQuote(accountId = 'primary'): Promise<void> {
  await harness.mail(accountId, `acme-${accountId}`, { id: `acme-quote-${accountId}`, sent: true, toAddress: 'buyer@acme.example',
    subject: 'Acme quotation Q-7', cleanBody: QUOTE, rawBody: `<p>${QUOTE}</p>` });
}

function saved(exchange: InboxAssistantExchange): InboxAssistantRunDiagnostics {
  const stored = harness.chat().exchanges.find(item => item.id === exchange.id)?.diagnostics;
  expect(stored, 'the saved exchange carries diagnostics').toBeDefined();
  return stored!;
}

async function failed(question: string): Promise<{ error: Error; diagnostics: InboxAssistantRunDiagnostics; exchange: InboxAssistantExchange }> {
  let error: unknown;
  try { await harness.ask(question); } catch (caught) { error = caught; }
  expect(error, 'the question is expected to fail').toBeInstanceOf(Error);
  const exchange = harness.chat().exchanges.at(-1)!;
  return { error: error as Error, diagnostics: exchange.diagnostics!, exchange };
}

describe('what a run saves about itself', () => {
  // Breaks: a verified answer leaves no record of how it was produced, so a later
  // wrong answer from the same question cannot be compared with a good one.
  it('records the route, a model plan, the search and the verified answer, and survives a reload from the store', async () => {
    await seedQuote();
    const exchange = await harness.ask('What did we quote Acme?');
    const diagnostics = saved(exchange);
    expect(diagnostics).toMatchObject({
      version: 1, route: 'search', outcome: 'verified',
      plan: { source: 'model', followUp: false, intent: 'all', quoteIntent: true, timeWindow: false, filters: [] },
      answer: { first: { format: 'valid', factsReturned: 1, factsVerified: 1, rejected: {} }, factsFinal: 1 },
    });
    expect(diagnostics.plan).not.toHaveProperty('failure');
    expect(diagnostics.answer).not.toHaveProperty('repair');
    expect(diagnostics).not.toHaveProperty('failure');
    expect(diagnostics.plan!.terms.queries).toContain('Acme');
    expect(diagnostics.plan!.queryCount).toBe(diagnostics.plan!.terms.queries.length);
    expect(diagnostics.durationMs).toBeGreaterThanOrEqual(0);
    expect(diagnostics.accounts!.map(account => [account.accountId, account.status])).toEqual([['primary', 'searched'], ['secondary', 'searched']]);
    const [primary, secondary] = diagnostics.accounts!;
    expect(primary).toMatchObject({ matchedMessages: 1, reviewedMessages: 1, evidenceItems: 1, missingBodies: 0, bodyDownloadFailures: 0, attachmentFailures: {} });
    expect(primary!.searches).toBeGreaterThan(0);
    expect(primary!.evidenceChars).toBeGreaterThan(QUOTE.length - 1);
    expect(secondary).toMatchObject({ matchedMessages: 0, reviewedMessages: 0, evidenceItems: 0, evidenceChars: 0 });
    // The run record and the exchange hold the same record, read back from SQLite.
    const run = harness.chat().runs!.find(item => item.requestId === exchange.requestId)!;
    expect(run.diagnostics).toEqual(diagnostics);
    expect(exchange.diagnostics).toEqual(diagnostics);
  });

  // Breaks: each call in "Answer usage" is an anonymous row, so nobody can tell
  // whether the cost and the failure belonged to planning, answering or a repair.
  it('labels every model call with the step that made it', async () => {
    await seedQuote();
    harness.ai = (prompt, purpose) => purpose === 'plan' ? PLAN
      : purpose === 'answer' ? JSON.stringify({ facts: [{ text: 'Acme was quoted INR 9,99,999.', sourceIds: ['S1'], quotes: [{ sourceId: 'S1', text: QUOTE }] }] })
        : grounded(prompt, purpose);
    const exchange = await harness.ask('What did we quote Acme?');
    expect(exchange.usage!.calls.map(call => call.purpose)).toEqual(['plan', 'answer', 'repair']);
    expect(harness.calls.map(call => call.purpose)).toEqual(['plan', 'answer', 'repair']);
    expect(exchange.usage!.calls.every(call => call.status === 'completed' && call.errorKind === undefined)).toBe(true);
  });

  // Breaks: asking the same thing again appends the second run's accounts to the
  // first run's record, so every count in the saved diagnostics is wrong.
  it('keeps each run its own record when a question is asked again', async () => {
    await seedQuote();
    const first = await harness.ask('What did we quote Acme?');
    const second = await harness.ask('What did we quote Acme?');
    const [a, b] = [saved(first), saved(second)];
    expect(a.accounts).toHaveLength(2);
    expect(b.accounts).toHaveLength(2);
    expect(b.accounts).not.toBe(a.accounts);
    expect(harness.chat().runs!.filter(run => run.diagnostics).map(run => run.diagnostics!.accounts!.length)).toEqual([2, 2]);
    expect(saved(first)).toEqual(a);
  });
});

describe('a planner that fails is recorded, not hidden', () => {
  const planFailure = async (fail: () => string): Promise<InboxAssistantRunDiagnostics> => {
    await seedQuote();
    const provider = harness.deps.callAI;
    harness.deps.callAI = (prompt, signal, onUsage, options) => scriptedPurpose(prompt) === 'plan'
      ? Promise.resolve().then(fail) : provider(prompt, signal, onUsage, options);
    return saved(await harness.ask('What did we quote Acme?'));
  };

  // Breaks: a rate limit or a timeout (it will pass by itself) and a rejected
  // API key (the user must fix it) leave the same trace, or none, and both look
  // like an ordinary answer built on the weaker keyword search.
  const failures: Array<[string, () => string, { failure: string; httpStatus?: number; failedField?: string }]> = [
    ['a rate limit', (): string => { throw Object.assign(new Error('Too many requests'), { status: 429 }); }, { failure: 'rate_limit', httpStatus: 429 }],
    ['a gateway outage', (): string => { throw Object.assign(new Error('Bad gateway'), { status: 502 }); }, { failure: 'upstream', httpStatus: 502 }],
    ['the provider call giving up after its own time limit', (): string => { throw Object.assign(new Error('AI request timed out'), { code: AI_REQUEST_TIMEOUT_CODE }); }, { failure: 'timeout' }],
    ['a dropped connection', (): string => { throw Object.assign(new Error('fetch failed'), { code: 'ECONNRESET' }); }, { failure: 'network' }],
    ['a rejected key', (): string => { throw Object.assign(new Error('Incorrect API key provided'), { status: 401 }); }, { failure: 'auth', httpStatus: 401 }],
    ['a reply that is not JSON', (): string => 'Sure! Here is the plan you asked for.', { failure: 'invalid_json' }],
    ['a reply with the wrong shape', (): string => JSON.stringify({ queries: [], entityTerms: [], intent: 'everything', quoteIntent: 'yes', filters: {} }), { failure: 'invalid_shape', failedField: 'queries' }],
    ];
  it.each(failures)('records %s as the reason the keyword fallback was used', async (_name, fail, expected) => {
    const diagnostics = await planFailure(fail);
    expect(diagnostics.plan).toMatchObject({ source: 'fallback', ...expected });
    if (!('httpStatus' in expected)) expect(diagnostics.plan).not.toHaveProperty('httpStatus');
    // The search still ran on the fallback and found the mail.
    expect(diagnostics.route).toBe('search');
    expect(diagnostics.accounts![0]!.matchedMessages).toBe(1);
    expect(inboxAssistantDegradedStages(diagnostics)).toContain(`plan_fallback:${expected.failure}${expected.failedField ? `/${expected.failedField}` : ''}`);
  });

  // Breaks: a planner failure reached through the real provider path loses its
  // class, or the failed call is saved with no reason beside its "failed" status.
  it('saves the failure class on the failed call itself, through the real provider path', async () => {
    await seedQuote();
    harness.ai = (prompt, purpose) => purpose === 'plan' ? { status: 401, body: JSON.stringify({ error: { message: 'Incorrect API key' } }) } : grounded(prompt, purpose);
    const exchange = await harness.ask('What did we quote Acme?');
    expect(saved(exchange).plan).toMatchObject({ source: 'fallback', failure: 'auth', httpStatus: 401 });
    const [plan, answer] = exchange.usage!.calls;
    expect(plan).toMatchObject({ purpose: 'plan', status: 'failed', errorKind: 'auth', httpStatus: 401 });
    expect(answer).toMatchObject({ purpose: 'answer', status: 'completed' });
    expect(answer).not.toHaveProperty('errorKind');
  });
});

describe('what the verifier did is recorded by reason', () => {
  const fact = (text: string, quote = QUOTE, sourceId = 'S1') => ({ text, sourceIds: [sourceId], quotes: [{ sourceId, text: quote }] });

  // Breaks: "Statements that could not be verified were left out" is all anyone
  // ever learns. Whether the model misquoted, invented a number or cited a source
  // that does not exist is lost, and those need different fixes.
  it('counts rejected facts by reason for the first reply and the repair separately', async () => {
    await seedQuote();
    harness.ai = (_prompt, purpose) => purpose === 'plan' ? PLAN : purpose === 'answer'
      ? JSON.stringify({ facts: [
        fact(QUOTE),
        fact('Acme was quoted INR 9,99,999.'),
        fact('Acme accepted.', 'Acme accepted the quotation in full.'),
        fact('Acme asked for a discount.', QUOTE, 'S9'),
        { text: 'No sources.', sourceIds: [], quotes: [] },
      ] })
      : JSON.stringify({ facts: [fact('The quotation reference is Q-7.', 'Acme quotation Q-7'), fact('Acme was quoted INR 1.', QUOTE)] });
    const diagnostics = saved(await harness.ask('What did we quote Acme?'));
    expect(diagnostics.answer).toEqual({
      first: { format: 'valid', factsReturned: 5, factsVerified: 1,
        rejected: { unsupported_number_or_currency: 1, missing_exact_quote: 1, unknown_source: 1, invalid_fact_shape: 1 } },
      repair: { reason: 'rejected_facts', sources: 1, factsRecovered: 1,
        pass: { format: 'valid', factsReturned: 2, factsVerified: 1, rejected: { unsupported_number_or_currency: 1 } } },
      factsFinal: 2,
    });
    expect(diagnostics.outcome).toBe('verified');
    expect(inboxAssistantDegradedStages(diagnostics)).toContain('facts_rejected(invalid_fact_shape:1,missing_exact_quote:1,unknown_source:1,unsupported_number_or_currency:1)');
  });

  // Breaks: a model that wraps its JSON in a sentence gets every fact thrown away
  // and the run looks the same as one where the model found nothing to say.
  it('tells a reply that broke the JSON contract from one that had no facts', async () => {
    await seedQuote();
    harness.ai = (_prompt, purpose) => purpose === 'plan' ? PLAN : 'Here is what I found: the quote was INR 4,50,000.';
    const malformed = saved(await harness.ask('What did we quote Acme?'));
    expect(malformed.answer).toEqual({
      first: { format: 'malformed', factsReturned: 0, factsVerified: 0, rejected: {} },
      repair: { reason: 'malformed', sources: 1, factsRecovered: 0, pass: { format: 'malformed', factsReturned: 0, factsVerified: 0, rejected: {} } },
      factsFinal: 0,
    });
    expect(malformed.outcome).toBe('related');
    expect(inboxAssistantDegradedStages(malformed)).toEqual(expect.arrayContaining(['answer_malformed', 'repair_malformed']));

    harness.ai = (_prompt, purpose) => purpose === 'plan' ? PLAN : NO_FACTS;
    const empty = saved(await harness.ask('What did we quote Acme?'));
    expect(empty.answer).toEqual({
      first: { format: 'valid', factsReturned: 0, factsVerified: 0, rejected: {} },
      repair: { reason: 'no_facts', sources: 1, factsRecovered: 0, pass: { format: 'valid', factsReturned: 0, factsVerified: 0, rejected: {} } },
      factsFinal: 0,
    });
    expect(inboxAssistantDegradedStages(empty)).toEqual([]);
  });

  // Breaks: "no answer" from a search that found nothing and "no answer" from a
  // model that was never asked are indistinguishable, so retrieval misses get
  // blamed on the model.
  it('records that no model was asked when the search found nothing', async () => {
    const exchange = await harness.ask('What did we quote Acme?');
    const diagnostics = saved(exchange);
    expect(diagnostics.answer).toEqual({ skipped: 'no_evidence', factsFinal: 0 });
    expect(diagnostics.outcome).toBe('no_evidence');
    expect(exchange.usage!.calls.map(call => call.purpose)).toEqual(['plan']);
  });
});

describe('a run that is only partly successful', () => {
  // Breaks: "This account could not be fully searched" with no cause. An index
  // error, a locked database and a missing mailbox all read the same, and the
  // account that did work is not shown to have worked.
  it('records the class of the failure for the one account that failed, and the full search of the other', async () => {
    await seedQuote('primary');
    await seedQuote('secondary');
    const storage = harness.mailbox('secondary').storage;
    storage.searchEmails = async () => { throw Object.assign(new Error('fts5: syntax error near "Acme"'), { name: 'SqliteError', code: 'SQLITE_ERROR' }); };
    const exchange = await harness.ask('What did we quote Acme?');
    const [primary, secondary] = saved(exchange).accounts!;
    expect(primary).toMatchObject({ accountId: 'primary', status: 'searched', matchedMessages: 1, evidenceItems: 1 });
    expect(primary).not.toHaveProperty('failure');
    expect(secondary).toMatchObject({ accountId: 'secondary', status: 'unavailable', failure: { name: 'SqliteError', code: 'SQLITE_ERROR' }, searches: 0, matchedMessages: 0, evidenceItems: 0 });
    expect(saved(exchange).outcome).toBe('verified');
    expect(inboxAssistantDegradedStages(saved(exchange))).toContain('accounts_unavailable(SqliteError:1)');
    expect(harness.logs.some(line => line.includes('[WARN] [InboxAssistant]') && line.includes('accounts_unavailable(SqliteError:1)'))).toBe(true);
  });

  // Breaks: "6 attachments were not read" with no reason: a password, a scan, a
  // size limit and a reader crash need different answers to the user.
  it('counts unread attachments by reason, including a reader that threw', async () => {
    const names = ['locked.pdf', 'scan.pdf', 'crash.xlsx'];
    await harness.mail('primary', 'acme-files', { id: 'acme-files-1', sent: true, toAddress: 'buyer@acme.example', subject: 'Acme quotation Q-7 documents',
      cleanBody: QUOTE, rawBody: `<p>${QUOTE}</p>`, hasAttachments: true, attachmentCount: 3, attachmentNames: JSON.stringify(names) });
    harness.deps.readAttachment = async ref => {
      if (ref.filename === 'crash.xlsx') throw new TypeError('Cannot read properties of undefined (reading "getPage")');
      return { ref, status: ref.filename === 'locked.pdf' ? 'password_protected' : 'scanned', segments: [], truncated: false };
    };
    const diagnostics = saved(await harness.ask('What did we quote Acme?'));
    expect(diagnostics.accounts![0]).toMatchObject({ attachmentsRead: 0, attachmentsSkipped: 3,
      attachmentFailures: { password_protected: 1, scanned: 1, 'threw:TypeError': 1 } });
    expect(inboxAssistantDegradedStages(diagnostics)).toContain('attachments_unread(password_protected:1,scanned:1,threw:TypeError:1)');
  });

  // Breaks: a body that could not be downloaded is counted as "missing" whether
  // the server refused it or the download itself failed, hiding a flaky connection.
  it('counts a body download that failed separately from a body that is simply absent', async () => {
    await harness.mail('primary', 'acme-nobody', { id: 'acme-nobody-1', sent: true, toAddress: 'buyer@acme.example', subject: 'Acme quotation Q-7',
      cleanBody: '', rawBody: '', hasBody: false });
    const open = harness.deps.openMailbox;
    harness.deps.openMailbox = async accountId => ({ ...await open(accountId), fetchBody: async () => { throw new Error('Connection closed'); } });
    const diagnostics = saved(await harness.ask('What did we quote Acme?'));
    expect(diagnostics.accounts![0]).toMatchObject({ missingBodies: 1, bodyDownloadFailures: 1 });
    expect(inboxAssistantDegradedStages(diagnostics)).toContain('body_downloads_failed:1');
  });

  // Breaks: when the answer call fails, the finished search is thrown away with
  // it and the saved question shows nothing about how far the run got.
  it('keeps the plan and the search on a run whose answer call failed, with the failing stage', async () => {
    await seedQuote();
    harness.ai = (_prompt, purpose) => purpose === 'plan' ? PLAN : { status: 403, body: JSON.stringify({ error: { message: 'forbidden' } }) };
    const { diagnostics, exchange } = await failed('What did we quote Acme?');
    expect(exchange.status).toBe('failed');
    expect(diagnostics).toMatchObject({ route: 'search', outcome: 'failed', plan: { source: 'model' },
      failure: { stage: 'answer', error: { name: 'AIProviderApiError', status: 403 } } });
    expect(diagnostics.accounts![0]).toMatchObject({ matchedMessages: 1, evidenceItems: 1 });
    expect(diagnostics).not.toHaveProperty('answer');
    expect(exchange.usage!.calls.at(-1)).toMatchObject({ purpose: 'answer', status: 'failed', httpStatus: 403 });
  });
});

describe('runs that are not a search', () => {
  // Breaks: the eval set and the log cannot tell which path handled a request,
  // so a question that was wrongly refused looks like a search that found nothing.
  it('records a capability reply, a host refusal and a review as their own routes with no plan', async () => {
    const capability = saved(await harness.ask('What can you do?'));
    expect(capability).toMatchObject({ route: 'capability', outcome: 'capability' });
    expect(capability).not.toHaveProperty('plan');

    const refused = await failed('Mark them as read');
    expect(refused.diagnostics).toMatchObject({ route: 'refused', outcome: 'refused' });
    expect(refused.diagnostics).not.toHaveProperty('failure');
    expect(refused.exchange.status).toBe('failed');

    const review = saved(await harness.ask('Review my unread emails'));
    expect(review).toMatchObject({ route: 'review', reviewKind: 'unread', outcome: 'review' });
    expect(review).not.toHaveProperty('plan');

    await harness.mail('primary', 'bbb', { id: 'bbb-1', fromAddress: 'noreply@bigbluebutton.example', subject: 'BigBlueButton session recording' });
    const command = saved(await harness.ask('Mark all BigBlueButton emails as read', { reviewOnly: true }));
    expect(command).toMatchObject({ route: 'mail_command', reviewKind: 'mark_read', outcome: 'review' });
    expect(harness.calls).toEqual([]);
  });

  // Breaks: pressing Stop is saved as a failure with a planner error, so the
  // record blames the provider for something the user chose to do.
  it('records a stopped run as stopped, with no failure and no planner fallback', async () => {
    await seedQuote();
    let release!: () => void;
    const planning = new Promise<void>(resolve => { release = resolve; });
    let started!: () => void;
    const reached = new Promise<void>(resolve => { started = resolve; });
    harness.ai = async (_prompt, purpose) => { if (purpose === 'plan') { started(); await planning; } return PLAN; };
    const asking = harness.ask('What did we quote Acme?', { requestId: 'stop-me' }).catch((error: unknown) => error);
    await reached;
    const cancelled = harness.service.cancel('stop-me');
    release();
    expect(await cancelled).toEqual({ requestId: 'stop-me', cancelled: true });
    expect(await asking).toBeInstanceOf(Error);
    const exchange = harness.chat().exchanges.at(-1)!;
    expect(exchange.status).toBe('stopped');
    expect(exchange.diagnostics).toMatchObject({ route: 'search', outcome: 'stopped' });
    expect(exchange.diagnostics).not.toHaveProperty('failure');
    expect(exchange.diagnostics).not.toHaveProperty('plan');
    expect(exchange.usage?.calls.every(call => call.errorKind === undefined) ?? true).toBe(true);
    expect(harness.logs.some(line => line.includes('run=stop-me') && line.includes('status=stopped') && line.includes('outcome=stopped'))).toBe(true);
    expect(harness.logs.some(line => line.includes('run=stop-me degraded'))).toBe(false);
  });
});

describe('a run that hits the five-minute limit', () => {
  afterEach(() => { vi.useRealTimers(); });

  // Breaks: the agent's own time limit is saved as an anonymous "Error", so a
  // provider that hangs cannot be told from any other failure in the record.
  it('is recorded as the agent\'s timeout, at the stage that was running', async () => {
    await seedQuote();
    // A provider that never answers and never fails by itself.
    harness.deps.callAI = () => new Promise<string>(() => {});
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const asking = harness.ask('What did we quote Acme?', { requestId: 'too-slow' }).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(300_000);
    const error = await asking;
    vi.useRealTimers();
    expect(error).toMatchObject({ message: expect.stringContaining('Search took too long') as unknown, code: 'ASSISTANT_TIMEOUT' });
    const exchange = harness.chat().exchanges.at(-1)!;
    expect(exchange.status).toBe('failed');
    expect(exchange.diagnostics).toMatchObject({ route: 'search', outcome: 'failed', failure: { stage: 'plan', error: { name: 'Error', code: 'ASSISTANT_TIMEOUT' } } });
    // The interrupted plan call is not also reported as a planner failure.
    expect(exchange.diagnostics).not.toHaveProperty('plan');
    expect(harness.logs.some(line => line.includes('run=too-slow') && line.includes('failed_at=plan') && line.includes('error=Error/ASSISTANT_TIMEOUT'))).toBe(true);
  });
});

describe('nothing from the mail, the question or an error reaches app.log', () => {
  const CANARY = { question: 'Zylophant', body: 'kestrel-body-7731', fts: 'fts-token-5512', provider: 'provider-body-9034', attachment: 'attachment-path-2287', model: 'model-reply-6645', file: 'margin-sheet-4410' };
  const everyCanary = Object.values(CANARY);

  // Breaks: app.log is plaintext on disk and feeds crash reports, while the chat
  // is encrypted. One `logger.warn(..., error)` or one logged query string puts
  // mail content, search words or a provider's response body in the open.
  it('logs a full degraded run using only ids, fixed words and counts', async () => {
    const bodyText = `${CANARY.question} quotation total INR 4,50,000. ${CANARY.body}`;
    await harness.mail('primary', 'canary', { id: 'canary-1', sent: true, toAddress: 'buyer@zylophant.example', subject: `${CANARY.question} quotation`,
      cleanBody: bodyText, rawBody: `<p>${bodyText}</p>`, hasAttachments: true, attachmentCount: 1, attachmentNames: JSON.stringify([`${CANARY.file}.xlsx`]) });
    await harness.mail('secondary', 'canary-2', { id: 'canary-2', subject: `${CANARY.question} follow up`, cleanBody: bodyText, rawBody: `<p>${bodyText}</p>` });
    harness.mailbox('secondary').storage.searchEmails = async () => { throw new Error(`fts5: syntax error near "${CANARY.fts}"`); };
    harness.deps.readAttachment = async () => { throw new Error(`ENOENT: no such file /Users/someone/${CANARY.attachment}.xlsx`); };
    harness.ai = (_prompt, purpose) => purpose === 'plan' ? { status: 401, body: JSON.stringify({ error: { message: `Invalid key for ${CANARY.provider}` } }) }
      : purpose === 'answer' ? `The answer is ${CANARY.model}` : JSON.stringify({ facts: [{ text: `${CANARY.model} was quoted INR 1.`, sourceIds: ['S1'], quotes: [{ sourceId: 'S1', text: `${CANARY.question} quotation total INR 4,50,000.` }] }] });

    const exchange = await harness.ask(`What did we quote ${CANARY.question}?`);
    const diagnostics = saved(exchange);

    // The run really was degraded at every stage this test claims to cover.
    expect(diagnostics.plan).toMatchObject({ source: 'fallback', failure: 'auth' });
    expect(diagnostics.accounts![0]!.attachmentFailures).toEqual({ 'threw:Error': 1 });
    expect(diagnostics.accounts![1]).toMatchObject({ status: 'unavailable', failure: { name: 'Error' } });
    expect(diagnostics.answer!.first!.format).toBe('malformed');
    expect(diagnostics.answer!.repair!.pass!.rejected).toEqual({ unsupported_number_or_currency: 1 });
    expect(harness.calls.some(call => call.prompt.includes(CANARY.body))).toBe(true);

    const assistantLines = harness.logs.filter(line => line.includes('[InboxAssistant]'));
    expect(assistantLines.some(line => line.includes('[INFO]') && line.includes(`run=${exchange.requestId}`))).toBe(true);
    expect(assistantLines.some(line => line.includes('[WARN]') && line.includes('degraded: plan_fallback:auth'))).toBe(true);
    for (const canary of everyCanary) {
      expect(harness.logs.filter(line => line.toLowerCase().includes(canary.toLowerCase())), `log lines containing "${canary}"`).toEqual([]);
    }
    for (const account of harness.accounts) {
      expect(assistantLines.filter(line => line.includes(account.email) || line.includes(`=${account.id}`)), `log lines naming ${account.id}`).toEqual([]);
    }

    // The saved record keeps the search words, and only the search words, as content.
    const { terms, ...planWithoutTerms } = diagnostics.plan!;
    expect(JSON.stringify(terms)).toContain(CANARY.question);
    const contentFree = JSON.stringify({ ...diagnostics, plan: planWithoutTerms, usage: exchange.usage });
    for (const canary of everyCanary) expect(contentFree.toLowerCase(), `saved diagnostics containing "${canary}"`).not.toContain(canary.toLowerCase());
  });

  // Breaks: a hard failure logs the thrown error, whose message is the provider's
  // own response body.
  it('logs a failed run by its error class and status, never its message', async () => {
    await harness.mail('primary', 'canary', { id: 'canary-1', sent: true, toAddress: 'buyer@zylophant.example', subject: `${CANARY.question} quotation`, cleanBody: `${CANARY.question} quotation ${CANARY.body}`, rawBody: `<p>${CANARY.question} quotation ${CANARY.body}</p>` });
    harness.ai = (_prompt, purpose) => purpose === 'plan' ? { status: 400 } : { status: 402, body: JSON.stringify({ error: { message: `Wallet empty for ${CANARY.provider}` } }) };
    const { error, exchange } = await failed(`What did we quote ${CANARY.question}?`);
    expect(error.message.length).toBeGreaterThan(0);
    const line = harness.logs.find(item => item.includes('[InboxAssistant]') && item.includes(`run=${exchange.requestId}`))!;
    expect(line).toContain('status=failed');
    expect(line).toContain('failed_at=answer');
    expect(line).toMatch(/error=AIProviderApiError(?:\/[a-z_]+)?\/402/);
    for (const canary of everyCanary) expect(harness.logs.filter(item => item.toLowerCase().includes(canary.toLowerCase()))).toEqual([]);
    expect(harness.logs.filter(item => item.includes(error.message))).toEqual([]);
  });
});

describe('the one-line run summary', () => {
  const diagnostics: InboxAssistantRunDiagnostics = {
    version: 1, route: 'search', outcome: 'verified', durationMs: 8421,
    plan: { source: 'fallback', failure: 'rate_limit', httpStatus: 429, followUp: true, intent: 'all', quoteIntent: false, meetingIntent: false, invitationIntent: false,
      timeWindow: false, filters: [], queryCount: 3, topicTermCount: 1, participantTermCount: 0, requiredGroupCount: 0,
      terms: { queries: ['SECRET-QUERY'], entityTerms: ['SECRET-ENTITY'], topicTerms: [], participantTerms: [], requiredTopicGroups: [['SECRET-GROUP']], timeWindow: 'SECRET-WINDOW' } },
    accounts: [
      { accountId: 'SECRET-ACCOUNT', status: 'searched', searches: 4, matchedMessages: 20, reviewedMessages: 12, evidenceItems: 14, evidenceChars: 30_000, missingBodies: 1,
        bodyDownloadFailures: 1, attachmentsRead: 2, attachmentsSkipped: 3, attachmentFailures: { too_large: 2 }, truncated: true, durationMs: 900 },
      { accountId: 'SECRET-OTHER', status: 'unavailable', failure: { name: 'SqliteError', code: 'SQLITE_BUSY' }, searches: 1, matchedMessages: 0, reviewedMessages: 0,
        evidenceItems: 0, evidenceChars: 0, missingBodies: 0, bodyDownloadFailures: 0, attachmentsRead: 0, attachmentsSkipped: 0, attachmentFailures: { too_large: 1, scanned: 1 }, truncated: false, durationMs: 5 },
    ],
    answer: { first: { format: 'valid', factsReturned: 6, factsVerified: 3, rejected: { missing_exact_quote: 2, unknown_source: 1 } },
      repair: { reason: 'rejected_facts', sources: 4, factsRecovered: 1, pass: { format: 'valid', factsReturned: 2, factsVerified: 1, rejected: { missing_exact_quote: 1 } } }, factsFinal: 4 },
  };
  const usage = { calls: [
    { id: '1', status: 'failed', purpose: 'plan', errorKind: 'rate_limit' }, { id: '2', status: 'completed', purpose: 'answer' }, { id: '3', status: 'completed', purpose: 'repair' },
  ] } as unknown as InboxAssistantUsage;

  // Breaks: the line a developer greps for loses a number, or gains a field that
  // carries content (an account id, a search word).
  it('reports totals across accounts and leaves out every content field', () => {
    const line = inboxAssistantRunSummary('req-1', 'completed', diagnostics, usage);
    expect(line).toBe('run=req-1 status=completed route=search outcome=verified ms=8421 plan=fallback:rate_limit/429 queries=3 followup=1 '
      + 'accounts=2 unavailable=1 searches=5 matched=20 reviewed=12 evidence=14/30000 ai_calls=3 ai_failed=1 facts=4/8 '
      + 'rejected=missing_exact_quote:2,unknown_source:1 repair=rejected_facts recovered=1');
    expect(line).not.toMatch(/SECRET/);
    expect(inboxAssistantDegradedStages(diagnostics, usage)).toEqual([
      'plan_fallback:rate_limit', 'accounts_unavailable(SqliteError:1)', 'body_downloads_failed:1', 'attachments_unread(scanned:1,too_large:3)',
      'facts_rejected(missing_exact_quote:2,unknown_source:1)', 'ai_calls_failed(plan:rate_limit:1)',
    ]);
    expect(inboxAssistantDegradedStages(diagnostics, usage).join(' ')).not.toMatch(/SECRET/);
  });

  // Breaks: a run that never reached a search (a capability reply, a refusal, a
  // review) prints "undefined" fields or throws while being logged.
  it('summarises runs that have no plan, no accounts and no answer', () => {
    expect(inboxAssistantRunSummary('req-2', 'completed', { version: 1, route: 'capability', outcome: 'capability', durationMs: 2 }))
      .toBe('run=req-2 status=completed route=capability outcome=capability ms=2');
    expect(inboxAssistantRunSummary('req-3', 'failed', { version: 1 })).toBe('run=req-3 status=failed route=none outcome=none ms=0');
    expect(inboxAssistantRunSummary('req-4', 'completed', { version: 1, route: 'review', reviewKind: 'unread', outcome: 'review', durationMs: 40 }))
      .toBe('run=req-4 status=completed route=review outcome=review ms=40 review=unread');
    expect(inboxAssistantRunSummary('req-5', 'failed', { version: 1, route: 'search', outcome: 'failed', durationMs: 9,
      failure: { stage: 'search', error: { name: 'TypeError' } } })).toBe('run=req-5 status=failed route=search outcome=failed ms=9 failed_at=search error=TypeError');
    expect(inboxAssistantRunSummary('req-6', 'completed', { version: 1, route: 'search', outcome: 'no_evidence', durationMs: 3, accounts: [],
      answer: { skipped: 'no_evidence', factsFinal: 0 } })).toBe('run=req-6 status=completed route=search outcome=no_evidence ms=3 '
      + 'accounts=0 unavailable=0 searches=0 matched=0 reviewed=0 evidence=0/0 answer=skipped:no_evidence');
    expect(inboxAssistantDegradedStages({ version: 1 })).toEqual([]);
    // An older record whose unavailable account has no failure recorded.
    expect(inboxAssistantDegradedStages({ version: 1, accounts: [{ ...diagnostics.accounts![1]!, failure: undefined, attachmentFailures: {} }] }))
      .toEqual(['accounts_unavailable(unknown:1)']);
    expect(inboxAssistantDegradedStages({ version: 1, plan: { ...diagnostics.plan!, failure: undefined },
      answer: { first: { format: 'valid', factsReturned: 0, factsVerified: 0, rejected: {} }, repair: { reason: 'no_facts', skipped: 'no_relevant_sources', sources: 0, factsRecovered: 0 }, factsFinal: 0 } },
    { calls: [{ id: '1', status: 'failed' }] } as unknown as InboxAssistantUsage))
      .toEqual(['plan_fallback:unknown', 'repair_skipped:no_relevant_sources', 'ai_calls_failed(call:unknown:1)']);
    expect(inboxAssistantRunSummary('req-7', 'completed', { version: 1, route: 'search', outcome: 'related', durationMs: 1,
      answer: { first: { format: 'valid', factsReturned: 0, factsVerified: 0, rejected: {} }, repair: { reason: 'no_facts', skipped: 'no_relevant_sources', sources: 0, factsRecovered: 0 }, factsFinal: 0 } }))
      .toBe('run=req-7 status=completed route=search outcome=related ms=1 facts=0/0 rejected=none repair=skipped:no_relevant_sources recovered=0');
  });

  // Breaks: app.log says only that a plan was unusable, so a planner
  // regression cannot be told apart by field without raw model output.
  it('names the unusable plan field in the run line and the degraded stages', () => {
    const plan = { ...diagnostics.plan!, failure: 'invalid_shape', failedField: 'filters' as const, httpStatus: undefined };
    expect(inboxAssistantRunSummary('req-8', 'completed', { version: 1, plan })).toContain(' plan=fallback:invalid_shape/filters ');
    expect(inboxAssistantDegradedStages({ version: 1, plan })).toEqual(['plan_fallback:invalid_shape/filters']);
  });
});
