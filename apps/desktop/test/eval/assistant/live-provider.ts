import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { AIProviderConfig } from '@sarvinbox/core';

import type { InboxAssistantAIPurpose, InboxAssistantExchange } from '../../../src/types/inbox-assistant';
import { scriptedPurpose, type AgentReply, type AssistantHarness } from '../../helpers/assistant-harness';

import type { EvalCase } from './cases';
import { createEvalHarness, squash } from './seed';

/**
 * The opt-in half of the evaluation: the same questions, asked of a REAL model
 * driving the real Inbox Agent.
 *
 * The deterministic run (agent-eval.test.ts) shows what the host does for a
 * model that calls the right tools. It cannot show what a particular model
 * actually does: whether it calls deep_search or guesses, whether it quotes
 * exactly, whether it needs the JSON protocol. This runs each retrieval case
 * through the production agent loop, tools, planner and provider call path
 * against the seeded mailbox only, and saves every model reply.
 *
 * The saved replies are then worth more than the run. Replayed in CI
 * (recordings.test.ts), the model's own turns drive the CURRENT host on the
 * same mailbox, so a recording is a fixture of what a real model really does:
 * a change to a tool, a result format or the grounding check that would turn
 * a real model's correct answer into a wrong one shows up there.
 *
 * Turns are recorded from the OpenAI-compatible wire format (OpenAI, Sarv,
 * custom and local endpoints). A Gemini run is scored but its turns are not
 * saved, so it has no replay.
 *
 * It never runs in CI and never gates anything. It prints counts.
 */

export interface LiveOutcome {
  /** The words that answer the question reached the model in a tool result. */
  needleShown: boolean;
  /** The words that answer the question are in the verified answer. */
  needleInAnswer: boolean;
  sourceStatus: string;
  /** The emails the answer cites, by id. */
  cited: string[];
  /** Tool calls by name, the answer excluded. */
  tools: Record<string, number>;
}

export interface LiveRecording {
  version: 2;
  case: string;
  run: number;
  model: string;
  recordedAt: string;
  question: string;
  needle: string;
  /** The model's turns in the agent loop, in order. Empty when they could not be read (Gemini wire format). */
  turns: AgentReply[];
  /** Its replies to the planner and the classifier, in order. */
  replies: Array<{ purpose: InboxAssistantAIPurpose; raw: string } | { purpose: InboxAssistantAIPurpose; status: number }>;
  outcome: LiveOutcome | null;
  /** The agent's own diagnostics for the run: protocol, steps, stop reason (content-free). */
  agent?: unknown;
  error?: string;
}

export interface LiveSummary {
  runs: number;
  planFromModel: number;
  planFallbackBy: Record<string, number>;
  usedDeepSearch: number;
  jsonProtocol: number;
  needleShown: number;
  needleInAnswer: number;
  verified: number;
  errors: number;
}

export function modelSlug(model: string): string {
  return model.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'model';
}

function tally(target: Record<string, number>, key: string, amount = 1): void {
  target[key] = (target[key] ?? 0) + amount;
}

interface WireMessage { role: string; content: string | null }

/** One request and response, read as the harness's scripted endpoint reads them. */
function readExchange(request: string, status: number, response: string): { kind: 'agent'; reply: AgentReply; messages: WireMessage[] } | { kind: 'ai'; purpose: InboxAssistantAIPurpose; reply: LiveRecording['replies'][number] } | undefined {
  let body: { messages?: WireMessage[] };
  try { body = JSON.parse(request) as typeof body; } catch { return undefined; }
  if (!Array.isArray(body.messages)) return undefined;
  const agent = typeof body.messages[0]?.content === 'string' && body.messages[0].content.startsWith('You are Inbox Agent inside');
  let message: { content?: string | null; tool_calls?: Array<{ function: { name: string; arguments: string } }> } | undefined;
  let finish: string | undefined;
  try {
    const parsed = JSON.parse(response) as { choices?: Array<{ message?: typeof message; finish_reason?: string }> };
    message = parsed.choices?.[0]?.message;
    finish = parsed.choices?.[0]?.finish_reason;
  } catch { /* An error body: only its status is kept. */ }
  if (agent) {
    // A provider's error body is its own text and may echo the prompt: keep the status only.
    const reply: AgentReply = status !== 200 || !message ? { status }
      : message.tool_calls?.length ? { tools: message.tool_calls.map(call => ({ name: call.function.name, arguments: call.function.arguments })), ...(message.content ? { text: message.content } : {}) }
        : { text: message.content ?? '', ...(finish && finish !== 'stop' ? { finish } : {}) };
    return { kind: 'agent', reply, messages: body.messages };
  }
  const purpose = scriptedPurpose(body.messages[1]?.content ?? '');
  return { kind: 'ai', purpose, reply: status === 200 && typeof message?.content === 'string' ? { purpose, raw: message.content } : { purpose, status } };
}

/** What a finished run shows: the same measure for a live run and its replay. */
export function liveOutcome(exchange: InboxAssistantExchange, shown: string[], needle: string): LiveOutcome {
  const tools: Record<string, number> = {};
  for (const [name, count] of Object.entries(exchange.diagnostics?.agent?.toolCalls ?? {})) if (name !== 'answer') tools[name] = count;
  return {
    needleShown: squash(shown.join('\n')).includes(needle),
    needleInAnswer: squash(exchange.answer.text).includes(needle),
    sourceStatus: exchange.answer.sourceStatus ?? 'none',
    cited: [...new Set(exchange.answer.sources.map(source => source.emailId))].sort(),
    tools,
  };
}

/** The tool results in the last request the model received: everything a tool showed it in this run. */
export function shownToModel(messages: WireMessage[]): string[] {
  return messages.filter(message => message.role === 'tool' || (message.role === 'user' && (message.content ?? '').startsWith('Result T'))).map(message => message.content ?? '');
}

export async function recordLiveProvider(options: {
  config: AIProviderConfig;
  cases: readonly EvalCase[];
  /** Models vary run to run: three runs show whether a result is stable. */
  runs: number;
  outDir: string;
  now?: () => Date;
}): Promise<{ summary: LiveSummary; recordings: LiveRecording[] }> {
  const dir = join(options.outDir, modelSlug(options.config.model));
  await mkdir(dir, { recursive: true });
  const summary: LiveSummary = { runs: 0, planFromModel: 0, planFallbackBy: {}, usedDeepSearch: 0, jsonProtocol: 0, needleShown: 0, needleInAnswer: 0, verified: 0, errors: 0 };
  const recordings: LiveRecording[] = [];
  let recording: LiveRecording | undefined;
  let lastMessages: WireMessage[] = [];
  const harness: AssistantHarness = await createEvalHarness(undefined, {
    provider: {
      config: options.config,
      onExchange: ({ request, status, response }) => {
        const read = readExchange(request, status, response);
        if (!read || !recording) return;
        if (read.kind === 'agent') { recording.turns.push(read.reply); lastMessages = read.messages; }
        else recording.replies.push(read.reply);
      },
    },
  });
  try {
    for (const item of options.cases) {
      if (!item.gold) continue;
      for (let run = 1; run <= options.runs; run++) {
        harness.newChat();
        lastMessages = [];
        recording = { version: 2, case: item.id, run, model: options.config.model, recordedAt: (options.now?.() ?? new Date()).toISOString(),
          question: item.ask, needle: item.gold.needle, turns: [], replies: [], outcome: null };
        try {
          const exchange = await harness.ask(item.ask);
          recording.outcome = liveOutcome(exchange, shownToModel(lastMessages), item.gold.needle);
          recording.agent = exchange.diagnostics?.agent;
          const plan = exchange.diagnostics?.plan;
          if (plan?.source === 'model') summary.planFromModel++;
          else if (plan) tally(summary.planFallbackBy, plan.failure ?? 'unknown');
          if (exchange.diagnostics?.agent?.mode === 'json') summary.jsonProtocol++;
        } catch (error) {
          // A provider failure is a result too. Only its class is kept: the message is the endpoint's own text.
          recording.error = error instanceof Error ? error.name : typeof error;
          summary.errors++;
        }
        // The Gemini wire format is not read: such a run has no turns and no replay.
        if (options.config.type === 'gemini') recording.turns = [];
        summary.runs++;
        if (recording.outcome?.tools.deep_search) summary.usedDeepSearch++;
        if (recording.outcome?.needleShown) summary.needleShown++;
        if (recording.outcome?.needleInAnswer) summary.needleInAnswer++;
        if (recording.outcome?.sourceStatus === 'verified') summary.verified++;
        recordings.push(recording);
        await writeFile(join(dir, `${item.id}.${run}.json`), `${JSON.stringify(recording, null, 2)}\n`);
      }
    }
  } finally {
    await harness.close();
  }
  return { summary, recordings };
}

/** Counts, not percentages: fifty cases cannot resolve a small difference. */
export function formatLiveSummary(model: string, summary: LiveSummary): string {
  const reasons = (values: Record<string, number>) => Object.entries(values).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key} ${value}`).join(', ') || 'none';
  return [
    `[assistant-eval:live] ${model}: ${summary.runs} runs`,
    `  plan accepted from the model   ${summary.planFromModel}/${summary.runs}   (fallback because: ${reasons(summary.planFallbackBy)})`,
    `  called deep_search             ${summary.usedDeepSearch}/${summary.runs}   (JSON protocol: ${summary.jsonProtocol})`,
    `  answer reached the model       ${summary.needleShown}/${summary.runs}`,
    `  answer in the verified reply   ${summary.needleInAnswer}/${summary.runs}   (replies with verified sources: ${summary.verified})`,
    `  runs that failed outright      ${summary.errors}`,
  ].join('\n');
}

/** Every recording under `root`, in a stable order. A missing folder is no recordings. */
export async function loadRecordings(root: string): Promise<Array<{ file: string; recording: LiveRecording }>> {
  const models = await readdir(root, { withFileTypes: true }).catch(() => []);
  const result: Array<{ file: string; recording: LiveRecording }> = [];
  for (const model of models.filter(entry => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    for (const name of (await readdir(join(root, model.name))).filter(file => file.endsWith('.json')).sort()) {
      result.push({ file: `${model.name}/${name}`, recording: JSON.parse(await readFile(join(root, model.name, name), 'utf8')) as LiveRecording });
    }
  }
  return result;
}

/**
 * Drive the current host with a recording's model turns and replies, on the
 * same seeded mailbox, and measure the outcome as the live run did. Null for a
 * recording with nothing to replay (no turns, or a run that failed).
 */
export async function replayRecording(harness: AssistantHarness, recording: LiveRecording): Promise<LiveOutcome | null> {
  if (recording.version !== 2 || !recording.turns.length || !recording.outcome) return null;
  let turn = 0;
  harness.newChat();
  harness.agentTurns.length = 0;
  // Past the recorded turns the replay answers with nothing, so it ends rather than loops.
  harness.agent = () => recording.turns[turn++] ?? { tools: [{ name: 'answer', arguments: { facts: [] } }] };
  const queues = new Map<string, LiveRecording['replies']>();
  for (const reply of recording.replies) queues.set(reply.purpose, [...(queues.get(reply.purpose) ?? []), reply]);
  harness.ai = (_prompt, purpose) => {
    const next = queues.get(purpose)?.shift();
    return !next ? { status: 400 } : 'raw' in next ? next.raw : { status: next.status };
  };
  const exchange = await harness.ask(recording.question);
  return liveOutcome(exchange, shownToModel(harness.agentTurns.at(-1)?.messages ?? []), recording.needle);
}

/** The provider to evaluate, from the environment. Undefined when the run was not asked for. */
export function liveProviderFromEnv(env: Record<string, string | undefined>): { config: AIProviderConfig; runs: number } | undefined {
  const model = env.ASSISTANT_EVAL_MODEL?.trim();
  if (!model) return undefined;
  const type = env.ASSISTANT_EVAL_TYPE?.trim() === 'gemini' ? 'gemini' : 'openai';
  const runs = Number(env.ASSISTANT_EVAL_RUNS);
  return {
    config: { type, model, apiKey: env.ASSISTANT_EVAL_API_KEY ?? '', ...(env.ASSISTANT_EVAL_BASE_URL?.trim() ? { baseUrl: env.ASSISTANT_EVAL_BASE_URL.trim() } : {}) },
    runs: Number.isInteger(runs) && runs >= 1 && runs <= 5 ? runs : 1,
  };
}
