import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { AIProviderConfig } from '@sarvinbox/core';

import {
  answerInboxAssistant, buildInboxAssistantAnswerPrompt, INBOX_ASSISTANT_OUTPUT_TOKENS, inboxAssistantAnswerPass, planInboxAssistantSearch,
} from '../../../electron/services/inbox-assistant-answer';
import { researchInboxAssistant } from '../../../electron/services/inbox-assistant-retrieval';
import { callInboxAssistantAI, INBOX_ASSISTANT_SYSTEM_PROMPT } from '../../../electron/services/inbox-assistant-usage';
import type {
  InboxAssistantAccountCoverage, InboxAssistantAIPurpose, InboxAssistantAnswerPassDiagnostics, InboxAssistantEvidence, InboxAssistantRunDiagnostics,
} from '../../../src/types/inbox-assistant';
import type { AssistantHarness } from '../../helpers/assistant-harness';

import type { EvalCase } from './cases';
import { NOW_MS, TIME_ZONE } from './mailbox';
import { squash } from './seed';

/**
 * The opt-in half of the evaluation: the same questions, asked of a REAL model.
 *
 * The deterministic run (assistant-eval.test.ts) shows what the host does with
 * a refused plan and with an ideal one. It cannot show what a particular model
 * actually returns: whether its plan is accepted, whether it quotes exactly,
 * how often the repair call is needed. This runs each search case through the
 * production plan, search and answer functions with the production system
 * prompt, output limits and provider call path, against the seeded mailbox
 * only, and saves every raw reply.
 *
 * The saved replies are then worth more than the run: replayed through the
 * verifier in CI (recordings.test.ts) they are fixtures of what real models
 * really write, which hand-written test replies are not.
 *
 * It never runs in CI and never gates anything. It prints counts.
 */

export interface LiveRecording {
  version: 1;
  case: string;
  run: number;
  model: string;
  recordedAt: string;
  /** Identifies the answer prompt's wording. A recording made under other wording is still a valid verifier fixture. */
  promptHash: string;
  question: string;
  needle: string;
  replies: Array<{ purpose: InboxAssistantAIPurpose; raw: string }>;
  /** Exactly what the verifier was given for the first answer, so a replay is exact. */
  sources: InboxAssistantEvidence[];
  coverage: InboxAssistantAccountCoverage[];
  diagnostics: InboxAssistantRunDiagnostics;
  /** What the verifier made of the first answer when it was recorded. */
  firstPass: InboxAssistantAnswerPassDiagnostics | null;
  /** The words that answer the question reached the model. */
  needleInEvidence: boolean;
  /** The words that answer the question are in a verified fact or its quotes. */
  needleInAnswer: boolean;
  error?: string;
}

export interface LiveSummary {
  runs: number;
  planFromModel: number;
  planFallbackBy: Record<string, number>;
  needleInEvidence: number;
  answersMalformed: number;
  factsReturned: number;
  factsVerified: number;
  rejectedBy: Record<string, number>;
  repairsRun: number;
  factsRecovered: number;
  needleInAnswer: number;
  errors: number;
}

export function inboxAssistantPromptHash(): string {
  return createHash('sha256').update(buildInboxAssistantAnswerPrompt('', [], [])).digest('hex').slice(0, 16);
}

export function modelSlug(model: string): string {
  return model.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'model';
}

function tally(target: Record<string, number>, key: string, amount = 1): void {
  target[key] = (target[key] ?? 0) + amount;
}

export async function recordLiveProvider(options: {
  harness: AssistantHarness;
  config: AIProviderConfig;
  cases: readonly EvalCase[];
  /** Local models vary run to run: three runs show whether a result is stable. */
  runs: number;
  outDir: string;
  now?: () => Date;
}): Promise<{ summary: LiveSummary; recordings: LiveRecording[] }> {
  const { harness, config } = options;
  const dir = join(options.outDir, modelSlug(config.model));
  await mkdir(dir, { recursive: true });
  const summary: LiveSummary = { runs: 0, planFromModel: 0, planFallbackBy: {}, needleInEvidence: 0, answersMalformed: 0, factsReturned: 0,
    factsVerified: 0, rejectedBy: {}, repairsRun: 0, factsRecovered: 0, needleInAnswer: 0, errors: 0 };
  const recordings: LiveRecording[] = [];
  for (const item of options.cases) {
    if (!item.gold) continue;
    for (let run = 1; run <= options.runs; run++) {
      const replies: LiveRecording['replies'] = [];
      const callAI = async (prompt: string, purpose: InboxAssistantAIPurpose = 'answer'): Promise<string> => {
        const raw = await callInboxAssistantAI({ ...config, maxOutputTokens: INBOX_ASSISTANT_OUTPUT_TOKENS[purpose === 'plan' ? 'plan' : 'answer'] },
          INBOX_ASSISTANT_SYSTEM_PROMPT, prompt);
        replies.push({ purpose, raw });
        return raw;
      };
      const diagnostics: InboxAssistantRunDiagnostics = { version: 1, route: 'search' };
      const recording: LiveRecording = { version: 1, case: item.id, run, model: config.model, recordedAt: (options.now?.() ?? new Date()).toISOString(),
        promptHash: inboxAssistantPromptHash(), question: item.ask, needle: item.gold.needle, replies, sources: [], coverage: [], diagnostics,
        firstPass: null, needleInEvidence: false, needleInAnswer: false };
      try {
        const plan = await planInboxAssistantSearch(item.ask, callAI, { nowMs: NOW_MS, timeZone: TIME_ZONE, diagnostics });
        const research = await researchInboxAssistant(harness.accounts, plan, harness.deps, undefined, { diagnostics });
        recording.sources = research.evidence.map(source => ({ ...source, dateTimeZone: TIME_ZONE }));
        recording.coverage = research.coverage;
        recording.needleInEvidence = squash(recording.sources.map(source => source.text).join('\n')).includes(item.gold.needle);
        const grounded = await answerInboxAssistant(item.ask, recording.sources, research.coverage, callAI, undefined, plan.scope, diagnostics);
        const first = replies.find(reply => reply.purpose === 'answer');
        recording.firstPass = first ? inboxAssistantAnswerPass(first.raw, recording.sources, research.coverage) : null;
        recording.needleInAnswer = squash(grounded.facts.flatMap(fact => [fact.text, ...fact.quotes.map(quote => quote.text)]).join('\n')).includes(item.gold.needle);
      } catch (error) {
        // A provider failure is a result too. Only its class is kept: the message is the endpoint's own text.
        recording.error = error instanceof Error ? error.name : typeof error;
        summary.errors++;
      }
      summary.runs++;
      if (diagnostics.plan?.source === 'model') summary.planFromModel++;
      else if (diagnostics.plan) tally(summary.planFallbackBy, diagnostics.plan.failure ?? 'unknown');
      if (recording.needleInEvidence) summary.needleInEvidence++;
      const answer = diagnostics.answer;
      if (answer?.first?.format === 'malformed') summary.answersMalformed++;
      for (const pass of [answer?.first, answer?.repair?.pass]) {
        if (!pass) continue;
        summary.factsReturned += pass.factsReturned;
        for (const [reason, amount] of Object.entries(pass.rejected)) tally(summary.rejectedBy, reason, amount);
      }
      summary.factsVerified += answer?.factsFinal ?? 0;
      if (answer?.repair && !answer.repair.skipped) { summary.repairsRun++; summary.factsRecovered += answer.repair.factsRecovered; }
      if (recording.needleInAnswer) summary.needleInAnswer++;
      recordings.push(recording);
      await writeFile(join(dir, `${item.id}.${run}.json`), `${JSON.stringify(recording, null, 2)}\n`);
    }
  }
  return { summary, recordings };
}

/** Counts, not percentages: fifty cases cannot resolve a small difference. */
export function formatLiveSummary(model: string, summary: LiveSummary): string {
  const reasons = (values: Record<string, number>) => Object.entries(values).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key} ${value}`).join(', ') || 'none';
  return [
    `[assistant-eval:live] ${model}: ${summary.runs} runs`,
    `  plan accepted from the model   ${summary.planFromModel}/${summary.runs}   (fallback because: ${reasons(summary.planFallbackBy)})`,
    `  answer reached the model       ${summary.needleInEvidence}/${summary.runs}`,
    `  answer in a verified statement ${summary.needleInAnswer}/${summary.runs}`,
    `  statements returned ${summary.factsReturned}, verified ${summary.factsVerified}   (rejected because: ${reasons(summary.rejectedBy)})`,
    `  replies that broke the JSON contract ${summary.answersMalformed}; repair calls ${summary.repairsRun}, statements recovered ${summary.factsRecovered}`,
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

/** What the verifier makes of a recording's first answer NOW. Compare with `firstPass`. */
export function replayRecording(recording: LiveRecording): InboxAssistantAnswerPassDiagnostics | null {
  const first = recording.replies.find(reply => reply.purpose === 'answer');
  return first ? inboxAssistantAnswerPass(first.raw, recording.sources, recording.coverage) : null;
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
