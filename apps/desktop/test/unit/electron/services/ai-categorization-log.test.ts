import { getLogLevel, setLogLevel, setLogSink } from '@sarvinbox/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { captureLogs, type CapturedLogs } from '../../../../../../packages/core/src/test-support/log-capture';
import { AICategorizationService, type AIProviderConfig } from '../../../../electron/services/ai-categorization-service';
import { emailRecord } from '../../../helpers/email-fixtures';

/**
 * What the standalone categorizer writes about an answer it could not use.
 * The model's answer is its reading of the user's mail (its reasoning names
 * people, amounts, subjects). The "No usable JSON" error line used to quote
 * its first 200 characters (got="…") and an invalid item was logged whole;
 * both reach a release app.log, and the same line is relayed to the renderer.
 *
 * What breaks if this file fails: model text about the user's mail reaches
 * app.log or the renderer relay, or a recoverable answer stops being used.
 */

const h = vi.hoisted(() => ({ fetch: vi.fn(), send: vi.fn(), answer: '', saved: [] as unknown[], eligibleFails: null as Error | null }));
const email = () => emailRecord({
  id: 'm1', fromAddress: 'vendor@example.com', toAddress: 'buyer@sarv.com', subject: 'Quote', tags: '|INBOX|',
  rawBody: '<p>Prices attached.</p>',
});
vi.mock('../../../../electron/shared', () => ({
  getMainWindow: () => ({ isDestroyed: () => false, webContents: { send: h.send } }),
  requireStorage: () => ({
    getEmail: async () => email(),
    getEligibleEmailsForAI: () => { if (h.eligibleFails) throw h.eligibleFails; return [email()]; },
    getFolders: async () => [{ path: 'INBOX' }],
    getFolder: async () => ({ path: 'INBOX' }),
    getEnabledCategoryDefinitions: () => [{ slug: 'needs_response', name: 'Needs Response', prompt: 'a request' }],
    getSenderContextBatch: () => ({}),
    getSenderRepetitionStats: () => ({ sameSubject: {}, totalEmails: 1 }),
    getThreadDepths: () => ({}),
    saveEmailCategoriesBatch: (batch: unknown[]) => { h.saved.push(...batch); return batch.length; },
    getRepositories: () => ({ prompts: { getContent: () => null } }),
  }),
}));
vi.mock('../../../../electron/services/net-fetch', () => ({ chromiumFetch: (...args: unknown[]) => h.fetch(...args) }));

const SENTINEL = 'SENTINEL-Payslip-Jane-Doe';
const run = () => new AICategorizationService().start(
  { type: 'openai', apiKey: 'k', model: 'm' } as any, 'realtime', { emailIds: ['m1'], userEmail: 'buyer@sarv.com' },
);
const PROVIDER: AIProviderConfig = { type: 'openai', apiKey: 'k', model: 'm' };
const bulk = () => new AICategorizationService().start(PROVIDER, 'bulk', { userEmail: 'buyer@sarv.com' });
/** Every line the service relayed to the renderer console. */
const relayed = () => h.send.mock.calls.filter(([channel]) => channel === 'ai-categorization:log').map(([, payload]) => JSON.stringify(payload));

let logs: CapturedLogs;
beforeEach(() => {
  h.fetch.mockReset().mockImplementation(async () =>
    new Response(JSON.stringify({ choices: [{ message: { content: h.answer } }] }), { status: 200 }));
  h.send.mockReset();
  h.saved = [];
  h.eligibleFails = null;
  logs = captureLogs({ setLogSink, setLogLevel, getLogLevel });
});
afterEach(() => { logs.stop(); });

function expectNoSentinel(): void {
  expect(logs.containing(SENTINEL)).toEqual([]);
  expect(relayed().filter((line) => line.includes(SENTINEL))).toEqual([]);
}

describe('standalone categorizer — what reaches the log', () => {
  // Breaks: 'No usable JSON in response [...] got="<answer>"' quotes the model.
  it('logs an unusable answer by its salvage counts only, here and in the relay', async () => {
    h.answer = `The email from Jane about ${SENTINEL} is a payslip; I would not categorize it.`;

    await run();

    expectNoSentinel();
    expect(h.saved).toEqual([]);
    const [line] = logs.containing('No usable JSON');
    expect(line).toMatch(/\[inputLen=\d+ attempted=0 closed=0 parsed=0 truncated=false reachedEnd=false\]$/);
    expect(relayed().some((payload) => payload.includes('No usable JSON'))).toBe(true);
  });

  // Breaks: '[AICategorizationService] Skipping invalid item:' prints the item
  // (util.inspect), whose reasoning is about the email; the valid item must
  // still be saved.
  it('logs an invalid item by its shape and still saves the valid one', async () => {
    h.answer = JSON.stringify([
      { reasoning: `${SENTINEL} has no id`, categories: [] },
      { emailId: 'm1', categories: ['needs_response'], is_spam: false, confidence: 0.9, reasoning: SENTINEL },
    ]);

    await run();

    expectNoSentinel();
    expect(h.saved).toHaveLength(1);
    expect(logs.containing('Skipping an invalid item: object keys=[categories,reasoning]')).toHaveLength(1);
    expect(logs.containing('Salvaged 1/2 valid items')).toHaveLength(1);
  });

  // Breaks: a truncated answer (transient: the model hit its token limit)
  // logs the broken object, or its salvaged objects are dropped.
  it('logs a truncated answer as counts and uses the objects that arrived', async () => {
    h.answer = `[{"emailId":"m1","categories":["needs_response"],"reasoning":"${SENTINEL}"},{"emailId":"m2","reasoning":"${SENTINEL} cut`;

    await run();

    expectNoSentinel();
    expect(h.saved).toHaveLength(1);
    expect(logs.containing('Whole-array parse failed; salvaged 1 object(s) [inputLen=')).toHaveLength(1);
    expect(logs.containing('response was TRUNCATED mid-object')).toHaveLength(1);
  });

  // Breaks: a complete answer with one malformed object (not a truncation) is
  // reported as truncated, logs the bad object, or loses the good one.
  it('logs a salvage of a complete answer as counts, without the truncation warning', async () => {
    h.answer = `[{"emailId":"m1","categories":["needs_response"],"reasoning":"${SENTINEL}"},{"emailId":m2 ${SENTINEL}}]`;

    await run();

    expectNoSentinel();
    expect(h.saved).toHaveLength(1);
    expect(logs.containing('Whole-array parse failed; salvaged 1 object(s) [inputLen=')).toHaveLength(1);
    expect(logs.containing('truncated=false')).toHaveLength(1);
    expect(logs.containing('response was TRUNCATED')).toEqual([]);
  });

  // Breaks: an array buried in reasoning prose is lost, or the prose is logged
  // on the way to recovering it.
  it('recovers an array buried in prose, logging counts only', async () => {
    h.answer = `analysis of ${SENTINEL}: ["needs_response"] — done`;

    await run();

    expectNoSentinel();
    expect(logs.containing('Recovered array via bracket-match after salvage failed [inputLen=')).toHaveLength(1);
  });

  // Breaks: a bare object answer is logged whole instead of by its type.
  it('logs a non-array answer by its type', async () => {
    h.answer = JSON.stringify({ emailId: 'm1', reasoning: SENTINEL });

    await run();

    expectNoSentinel();
    expect(logs.containing('Response is not an array — got: object')).toHaveLength(1);
  });
});

// A provider that refuses a request answers with a body, and the service
// throws `API request failed: <status> - <body>`. That body can quote the
// prompt, which is the user's mail. Both the per-email line (bulk) and the
// whole-run line (realtime) used to carry it: 300 characters of it, and the
// whole error with its stack.
describe('standalone categorizer — a provider error in the log', () => {
  const refuse = () => h.fetch.mockImplementation(async () =>
    new Response(`{"error":{"message":"Invalid prompt near: ${SENTINEL} wrote about the payslip"}}`, { status: 400 }));

  // Breaks: 'Email <id> LLM call failed: API request failed: 400 - {…body…}'
  // puts the provider's body in app.log and in the renderer relay.
  it('logs a failed call in a bulk run by its HTTP status and error class', async () => {
    refuse();

    await bulk();

    expectNoSentinel();
    expect(h.saved).toEqual([]);
    expect(logs.containing('LLM call failed:')).toEqual([
      '[ERROR] [ai-categorization-service] [AICategorizationService] Email m1 LLM call failed: HTTP 400 {"name":"Error","status":400}',
    ]);
    expect(relayed().some((payload) => payload.includes('LLM call failed: HTTP 400'))).toBe(true);
  });

  // Breaks: 'Processing error:' (a run that failed outside one email's call,
  // here the database read of the backlog) prints the error whole.
  it('logs a failed bulk run by the error class and code only', async () => {
    h.eligibleFails = Object.assign(new Error(`no such column near "${SENTINEL}"`), { code: 'SQLITE_ERROR' });

    await bulk();

    expect(logs.containing(SENTINEL)).toEqual([]);
    expect(logs.containing('Processing error:')).toEqual([
      "[ERROR] [ai-categorization-service] [AICategorizationService] Processing error: { name: 'Error', code: 'SQLITE_ERROR' }",
    ]);
  });

  // Breaks: the same failure is relayed to the renderer as the error's
  // message ('no such column near "<mail text>"'), which the renderer logs with
  // console.error into a release app.log. The relay must name it by one token
  // and stay non-terminal, so no Fix banner is raised for a database failure.
  it('relays a failed bulk run to the renderer by its cause only, as a non-terminal error', async () => {
    h.eligibleFails = Object.assign(new Error(`no such column near "${SENTINEL}"`), { code: 'SQLITE_ERROR' });

    await bulk();

    const errors = h.send.mock.calls.filter(([channel]) => channel === 'ai-categorization:error').map(([, payload]) => payload);
    expect(errors).toEqual([{
      message: 'AI categorization failed (SQLITE_ERROR)', terminal: false, kind: undefined, status: undefined,
      reason: 'AI categorization failed (SQLITE_ERROR)',
    }]);
    expect(JSON.stringify(h.send.mock.calls)).not.toContain(SENTINEL);
    // The run still ends: the renderer's spinner is cleared by the completion event.
    expect(h.send.mock.calls.some(([channel]) => channel === 'ai-categorization:complete')).toBe(true);
  });

  // Breaks: 'Auto-tick error:' (the 30-second timer's check for a backlog,
  // which reads the same eligible-emails query before any run starts) prints
  // the error whole, so its mail text reaches app.log on the first tick and on
  // every tick after it while the failure lasts.
  it('logs a failed auto-process tick by the error class and code only, on every tick', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    h.eligibleFails = Object.assign(new Error(`no such column near "${SENTINEL}"`), { code: 'SQLITE_ERROR' });
    const service = new AICategorizationService();
    const expected = "[ERROR] [ai-categorization-service] [AICategorizationService] Auto-tick error: { name: 'Error', code: 'SQLITE_ERROR' }";
    try {
      service.startAutoProcess(PROVIDER, { userEmail: 'buyer@sarv.com' });
      await vi.waitFor(() => expect(logs.containing('Auto-tick error:')).toEqual([expected]));

      await vi.advanceTimersByTimeAsync(30_000);
      await vi.waitFor(() => expect(logs.containing('Auto-tick error:')).toEqual([expected, expected]));
    } finally {
      service.stopAutoProcess();
      vi.useRealTimers();
    }

    expectNoSentinel();
    // A failed check starts no run, so nothing reaches the provider.
    expect(h.fetch).not.toHaveBeenCalled();
  });

  // Breaks: an error with no machine code (a plain throw quoting mail text)
  // falls back to its message in the relay instead of its class.
  it('relays a failure without a code by its class', async () => {
    h.eligibleFails = new TypeError(`Cannot read properties of ${SENTINEL}`);

    await bulk();

    const errors = h.send.mock.calls.filter(([channel]) => channel === 'ai-categorization:error').map(([, payload]) => payload.message);
    expect(errors).toEqual(['AI categorization failed (TypeError)']);
    expect(JSON.stringify(h.send.mock.calls)).not.toContain(SENTINEL);
  });

  // Breaks: 'Realtime processing failed:' prints the error whole (its message
  // is the provider's body).
  it('logs a failed realtime run by the error class and status only', async () => {
    refuse();

    await run();

    expectNoSentinel();
    expect(h.saved).toEqual([]);
    expect(logs.containing('Realtime processing failed:')).toEqual([
      "[ERROR] [ai-categorization-service] [AICategorizationService] Realtime processing failed: { name: 'Error', status: 400 }",
    ]);
  });
});
