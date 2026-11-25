import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { scriptedPurpose, type AssistantHarness } from '../../helpers/assistant-harness';

import { RETRIEVAL_CASES, type EvalCase } from './cases';
import { formatLiveSummary, liveProviderFromEnv, loadRecordings, modelSlug, recordLiveProvider, replayRecording, type LiveRecording } from './live-provider';
import { createEvalHarness } from './seed';

/**
 * The provider evaluation (see live-provider.ts).
 *
 * The first block always runs: it drives the recorder against an
 * OpenAI-compatible endpoint on this machine, so the code that talks to a real
 * provider is exercised on every push without one. The second block talks to
 * the provider named in the environment and is skipped unless it is named:
 *
 *   ASSISTANT_EVAL_MODEL=gpt-5-mini ASSISTANT_EVAL_API_KEY=... pnpm eval:assistant:live
 *
 * See docs/TESTING.md, "Inbox Agent evaluation".
 */

let harness: AssistantHarness;
beforeAll(async () => { harness = await createEvalHarness(undefined, { agent: () => ({ text: 'unused' }) }); }, 120_000);
afterAll(async () => { await harness.close(); });

const byId = (...ids: string[]) => ids.map(id => RETRIEVAL_CASES.find(item => item.id === id)!);

interface WireBody { messages: Array<{ role: string; content: string | null }>; tools?: unknown[]; max_completion_tokens?: number }

describe('recording a provider run', () => {
  let server: Server;
  let baseUrl: string;
  let outDir: string;
  /** What the local endpoint does with one request. */
  let respond: (body: WireBody) => { status: number; message?: Record<string, unknown> };
  const requests: Array<{ authorization?: string; agent: boolean; tools: number; purpose: string }> = [];

  beforeAll(async () => {
    server = createServer((request, response) => {
      let raw = '';
      request.on('data', chunk => { raw += String(chunk); });
      request.on('end', () => {
        const body = JSON.parse(raw) as WireBody;
        const agent = (body.messages[0]?.content ?? '').startsWith('You are Inbox Agent inside');
        requests.push({ authorization: request.headers.authorization, agent, tools: body.tools?.length ?? 0, purpose: agent ? 'agent' : scriptedPurpose(body.messages[1]?.content ?? '') });
        const result = respond(body);
        response.writeHead(result.status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(result.status === 200
          ? { model: 'local-eval-model', choices: [{ message: result.message, finish_reason: result.message?.tool_calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } }
          : { error: { message: 'PRIVATE provider detail', code: 'invalid_api_key' } }));
      });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
    outDir = await mkdtemp(join(tmpdir(), 'assistant-eval-recordings-'));
  });
  afterAll(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(outDir, { recursive: true, force: true });
  });

  const asked = (body: WireBody, cases: EvalCase[]) => cases.find(item => body.messages.some(message => message.role === 'user' && (message.content ?? '').includes(item.ask)))!;
  const shown = (body: WireBody) => body.messages.filter(message => message.role === 'tool').map(message => message.content ?? '');
  const toolCall = (name: string, args: Record<string, unknown>) => ({ content: null, tool_calls: [{ id: `call-${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
  /** Answer with `claim`, quoting `needle` from the excerpt that shows it. */
  const quoting = (body: WireBody, needle: string, claim = needle) => {
    const block = shown(body).join('\n\n---\n\n').split('\n\n---\n\n').find(item => item.replace(/\s+/g, ' ').includes(needle));
    const id = block && /\b(S\d+)\b/.exec(block)?.[1];
    return toolCall('answer', id ? { facts: [{ text: claim, sourceIds: [id], quotes: [{ sourceId: id, text: needle }] }] } : { facts: [], message: 'Not found.' });
  };

  // Breaks: the opt-in run measures something other than the app (another
  // system prompt or tool set, a hand-rolled request), or saves recordings that
  // cannot be replayed, so its numbers and its fixtures describe nothing real.
  it('drives the production agent, saves every model turn, counts the outcome, and replays to the same outcome', async () => {
    const [thermax, gst, board] = byId('thermax-quotation-sent', 'gst-notice-deadline', 'board-meeting-when');
    const cases = [thermax!, gst!, board!];
    const plans: Record<string, unknown> = { [thermax!.ask]: thermax!.plan, [gst!.ask]: gst!.plan };
    respond = body => {
      const purpose = scriptedPurpose(body.messages[1]?.content ?? '');
      const agentTurn = (body.messages[0]?.content ?? '').startsWith('You are Inbox Agent inside');
      if (!agentTurn) {
        const planned = cases.find(item => (body.messages[1]?.content ?? '').includes(item.ask));
        return purpose === 'plan' && planned && plans[planned.ask] ? { status: 200, message: { content: JSON.stringify(plans[planned.ask]) } } : { status: 401 };
      }
      const item = asked(body, cases);
      // Thermax: an exact quote. GST: the right email, a date the email does not
      // contain. Board meeting: a sentence first (the loop asks again), then a quote.
      if (!shown(body).length) {
        if (item === board && !body.messages.some(message => message.role === 'assistant')) return { status: 200, message: { content: 'Let me look into that.' } };
        return { status: 200, message: toolCall('deep_search', { question: item.ask }) };
      }
      return { status: 200, message: item === gst ? quoting(body, gst!.gold!.needle, 'The reply is due by 25 November 2026.') : quoting(body, item.gold!.needle) };
    };
    const { summary, recordings } = await recordLiveProvider({
      config: { type: 'openai', model: 'Local Eval/Model:1', apiKey: 'local-eval-key', baseUrl }, cases, runs: 1, outDir,
      now: () => new Date('2026-11-12T00:00:00Z'),
    });

    expect(summary).toEqual({ runs: 3, planFromModel: 2, planFallbackBy: { auth: 1 }, usedDeepSearch: 3, jsonProtocol: 0, needleShown: 3, needleInAnswer: 2, verified: 2, errors: 0 });
    // The production agent loop with its tools, and the key as a bearer.
    expect(requests.filter(request => request.agent).every(request => request.tools > 10)).toBe(true);
    expect(requests.every(request => request.authorization === 'Bearer local-eval-key')).toBe(true);

    const dir = join(outDir, 'local-eval-model-1');
    expect((await readdir(dir)).sort()).toEqual(['board-meeting-when.1.json', 'gst-notice-deadline.1.json', 'thermax-quotation-sent.1.json']);
    const saved = JSON.parse(await readFile(join(dir, 'gst-notice-deadline.1.json'), 'utf8')) as LiveRecording;
    expect(saved).toMatchObject({ version: 2, case: 'gst-notice-deadline', run: 1, model: 'Local Eval/Model:1', recordedAt: '2026-11-12T00:00:00.000Z',
      question: gst!.ask, needle: gst!.gold!.needle, outcome: { needleShown: true, needleInAnswer: false, tools: { deep_search: 1 } } });
    // The unsupported date earned the one correction the loop allows; the endpoint repeated itself.
    expect(saved.turns.map(turn => 'tools' in turn ? turn.tools.map(call => call.name).join() : 'text')).toEqual(['deep_search', 'answer', 'answer']);
    expect(saved.replies.map(reply => reply.purpose)).toEqual(['plan']);
    const board1 = recordings.find(recording => recording.case === 'board-meeting-when')!;
    expect(board1.turns[0]).toEqual({ text: 'Let me look into that.' });
    expect(board1.replies).toEqual([{ purpose: 'plan', status: 401 }]);
    // Nothing of the provider's own error text or the key is kept.
    for (const recording of recordings) expect(JSON.stringify(recording)).not.toMatch(/PRIVATE provider detail|local-eval-key/);

    // Every recording, replayed through the current host, ends as it did live.
    const loaded = await loadRecordings(outDir);
    expect(loaded.map(item => item.file)).toEqual(['local-eval-model-1/board-meeting-when.1.json', 'local-eval-model-1/gst-notice-deadline.1.json', 'local-eval-model-1/thermax-quotation-sent.1.json']);
    for (const { recording } of loaded) expect(await replayRecording(harness, recording)).toEqual(recording.outcome);

    expect(formatLiveSummary('local', summary)).toBe([
      '[assistant-eval:live] local: 3 runs',
      '  plan accepted from the model   2/3   (fallback because: auth 1)',
      '  called deep_search             3/3   (JSON protocol: 0)',
      '  answer reached the model       3/3',
      '  answer in the verified reply   2/3   (replies with verified sources: 2)',
      '  runs that failed outright      0',
    ].join('\n'));
  }, 120_000);

  // Breaks: one provider outage aborts the whole run and loses every result
  // gathered so far, or its response body (which can echo the prompt) is saved.
  it('records a run whose model call fails as a failed run, by error class, and carries on', async () => {
    const [thermax, gst] = byId('thermax-quotation-sent', 'gst-notice-deadline');
    respond = body => {
      if (!(body.messages[0]?.content ?? '').startsWith('You are Inbox Agent inside')) return { status: 400 };
      const item = asked(body, [thermax!, gst!]);
      if (item === thermax) return { status: 403 };
      return { status: 200, message: shown(body).length ? quoting(body, gst!.gold!.needle) : toolCall('deep_search', { question: gst!.ask }) };
    };
    const { summary, recordings } = await recordLiveProvider({
      config: { type: 'openai', model: 'failing', apiKey: 'k', baseUrl }, cases: [thermax!, { id: 'no-gold', ask: 'thanks', route: 'capability' }, gst!], runs: 2, outDir,
    });
    expect(summary).toMatchObject({ runs: 4, errors: 2, planFromModel: 0, planFallbackBy: { client: 2 }, needleInAnswer: 2, needleShown: 2 });
    expect(recordings.map(recording => [recording.case, recording.run, recording.error])).toEqual([
      ['thermax-quotation-sent', 1, 'AIProviderApiError'], ['thermax-quotation-sent', 2, 'AIProviderApiError'], ['gst-notice-deadline', 1, undefined], ['gst-notice-deadline', 2, undefined]]);
    expect(recordings[0]!.outcome).toBeNull();
    expect(recordings[0]!.turns).toEqual([{ status: 403 }]);
    expect(await replayRecording(harness, recordings[0]!)).toBeNull();
    expect(JSON.stringify(recordings)).not.toContain('PRIVATE provider detail');
    expect(formatLiveSummary('failing', { ...summary, planFallbackBy: {} })).toContain('(fallback because: none)');
  }, 120_000);

  // Breaks: a typo in an environment variable starts a paid run against the
  // wrong endpoint, or the run starts in CI where no provider was asked for.
  it('reads the provider from the environment and stays off unless a model is named', async () => {
    expect(liveProviderFromEnv({})).toBeUndefined();
    expect(liveProviderFromEnv({ ASSISTANT_EVAL_MODEL: '  ', ASSISTANT_EVAL_API_KEY: 'k' })).toBeUndefined();
    expect(liveProviderFromEnv({ ASSISTANT_EVAL_MODEL: 'gpt-5-mini', ASSISTANT_EVAL_API_KEY: 'k' })).toEqual({ config: { type: 'openai', model: 'gpt-5-mini', apiKey: 'k' }, runs: 1 });
    expect(liveProviderFromEnv({ ASSISTANT_EVAL_MODEL: 'gemma3', ASSISTANT_EVAL_BASE_URL: ' http://localhost:11434/v1 ', ASSISTANT_EVAL_RUNS: '3' }))
      .toEqual({ config: { type: 'openai', model: 'gemma3', apiKey: '', baseUrl: 'http://localhost:11434/v1' }, runs: 3 });
    expect(liveProviderFromEnv({ ASSISTANT_EVAL_MODEL: 'gemini-2.5-flash', ASSISTANT_EVAL_TYPE: 'gemini', ASSISTANT_EVAL_RUNS: '99' })?.config.type).toBe('gemini');
    for (const runs of ['99', '0', '2.5', 'many']) expect(liveProviderFromEnv({ ASSISTANT_EVAL_MODEL: 'm', ASSISTANT_EVAL_RUNS: runs })?.runs).toBe(1);
    expect(modelSlug('accounts/Fireworks/models/Llama v3.1')).toBe('accounts-fireworks-models-llama-v3.1');
    expect(modelSlug('///')).toBe('model');
    expect(await loadRecordings(join(outDir, 'does-not-exist'))).toEqual([]);
  });
});

const live = liveProviderFromEnv(process.env);
describe.skipIf(!live)('live provider run (opt-in, never in CI)', () => {
  it('asks the configured provider every retrieval question and saves its turns', async () => {
    const { summary } = await recordLiveProvider({ config: live!.config, cases: RETRIEVAL_CASES, runs: live!.runs, outDir: join(__dirname, 'recorded') });
    process.stdout.write(`${formatLiveSummary(live!.config.model, summary)}\n`);
    expect(summary.runs).toBe(RETRIEVAL_CASES.length * live!.runs);
  }, 3_600_000);
});
