import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { NO_FACTS, promptConversations, promptEvidence, type AssistantHarness } from '../../helpers/assistant-harness';

import { EVAL_CASES, type EvalCase } from './cases';
import { KNOWN_GAPS } from './known-gaps';
import { createEvalHarness, squash } from './seed';

/**
 * Scores the real Inbox Agent on routing and retrieval, with no model.
 *
 * Every case runs through the real service against the seeded mailbox (see
 * assistant-harness.ts and mailbox.ts). The model is scripted two ways:
 *
 *   floor    the planner is refused, so the host's own keyword rules plan the
 *            search. This is what a user gets when the model's plan is
 *            unusable, and it needs no model to reproduce.
 *   ceiling  the planner returns the case's hand-written plan. A case that
 *            fails here is a host problem that no better model can fix.
 *
 * The answer model returns no facts in both, so only two things are scored:
 * the route the request took, and whether the words that answer the question
 * reached the answer prompt. Whether a real model then answers correctly is a
 * separate, opt-in run (live-provider.test.ts).
 *
 * What breaks if this goes red: a change to routing, planning, filtering,
 * ranking or excerpting has stopped a question that used to work from working.
 * The failing test is named after the question.
 */

type Mode = 'floor' | 'ceiling';
interface Outcome { route: string; routeOk: boolean; retrievalOk: boolean | null; problems: string[] }

let harness: AssistantHarness;
const scores = new Map<Mode, Array<{ item: EvalCase; outcome: Outcome }>>([['floor', []], ['ceiling', []]]);

/** A reviewer that keeps everything: these cases score the route, not the review. */
function keepEverything(prompt: string): string {
  return JSON.stringify({ recommendations: promptConversations(prompt).map(row => ({ id: row.id, recommendation: 'keep_unread', reason: 'Evaluation keeps everything.', confidence: 0.9 })) });
}

async function run(item: EvalCase, mode: Mode): Promise<Outcome> {
  harness.newChat();
  harness.ai = (prompt, purpose) => purpose === 'review' ? keepEverything(prompt)
    : purpose !== 'plan' ? NO_FACTS
      : mode === 'ceiling' && item.plan ? JSON.stringify(item.plan) : { status: 400 };
  if (item.after) {
    const { ask, cite } = item.after;
    const script = harness.ai;
    harness.ai = (prompt, purpose) => {
      const source = purpose === 'answer' ? promptEvidence(prompt).find(candidate => candidate.evidence.includes(cite)) : undefined;
      return source ? JSON.stringify({ facts: [{ text: cite, sourceIds: [source.id], quotes: [{ sourceId: source.id, text: cite }] }] }) : script(prompt, purpose);
    };
    const first = await harness.ask(ask).catch(() => undefined);
    harness.ai = script;
    if (first?.answer.sourceStatus !== 'verified') return { route: 'none', routeOk: false, retrievalOk: false, problems: [`the first question ("${ask}") was not answered, so the follow-up could not be tested`] };
  }
  harness.calls.length = 0;
  await harness.ask(item.ask).catch(() => undefined);
  const exchange = harness.chat().exchanges.at(-1);
  const route = exchange?.diagnostics?.route ?? 'none';
  const problems: string[] = [];
  const routeOk = route === item.route;
  if (!routeOk) problems.push(`took route "${route}", expected "${item.route}"`);
  let retrievalOk: boolean | null = null;
  if (item.gold) {
    const answerPrompt = harness.calls.find(call => call.purpose === 'answer')?.prompt;
    const evidence = answerPrompt ? squash(promptEvidence(answerPrompt).map(source => source.evidence).join('\n')) : '';
    retrievalOk = evidence.includes(item.gold.needle);
    if (!retrievalOk) {
      const accounts = exchange?.diagnostics?.accounts ?? [];
      const plan = exchange?.diagnostics?.plan;
      problems.push(`"${item.gold.needle}" (email ${item.gold.emailId}) did not reach the model: `
        + `${accounts.reduce((sum, account) => sum + account.matchedMessages, 0)} matched, ${accounts.reduce((sum, account) => sum + account.evidenceItems, 0)} excerpts`
        + (plan ? `; plan ${plan.source}, intent ${plan.intent}, follow-up ${plan.followUp}, required ${JSON.stringify(plan.terms.requiredTopicGroups)}, `
          + `window ${plan.terms.timeWindow ?? 'none'}, filters ${JSON.stringify(plan.filters)}, queries ${JSON.stringify(plan.terms.queries)}` : ''));
    }
  }
  return { route, routeOk, retrievalOk, problems };
}

beforeAll(async () => { harness = await createEvalHarness(); }, 120_000);
afterAll(async () => {
  await harness.close();
  // The scoreboard, for a human reading the run. The gate is each case's own test.
  for (const [mode, results] of scores) {
    if (!results.length) continue;
    const retrieval = results.filter(result => result.outcome.retrievalOk !== null);
    process.stdout.write(`[assistant-eval] ${mode.padEnd(7)} route ${results.filter(result => result.outcome.routeOk).length}/${results.length}`
      + `  retrieval ${retrieval.filter(result => result.outcome.retrievalOk).length}/${retrieval.length}`
      + `  known gaps ${results.filter(result => KNOWN_GAPS[result.item.id]?.[mode]).length}\n`);
  }
});

describe.each<Mode>(['floor', 'ceiling'])('Inbox Agent evaluation: %s', mode => {
  const cases = EVAL_CASES.filter(item => mode === 'floor' || item.plan);
  it.each(cases.map(item => [item.id, item] as const))('%s', async (_id, item) => {
    const outcome = await run(item, mode);
    scores.get(mode)!.push({ item, outcome });
    const gap = KNOWN_GAPS[item.id]?.[mode];
    if (gap) {
      expect(outcome.problems, `"${item.ask}" (${mode}) now passes. It is listed as a known gap (${gap}). Remove that entry from known-gaps.ts so the case is protected from now on.`).not.toEqual([]);
    } else {
      expect(outcome.problems, `"${item.ask}" (${mode})`).toEqual([]);
    }
  }, 60_000);
});

describe('the evaluation set itself', () => {
  // Breaks: a case is renamed or deleted and its known-gap entry lingers, or two
  // cases share an id, so a gap silently covers the wrong question.
  it('has unique case ids, and every known gap names an existing case and a mode that runs for it', () => {
    const ids = EVAL_CASES.map(item => item.id);
    expect(ids.filter((id, index) => ids.indexOf(id) !== index)).toEqual([]);
    for (const [id, gap] of Object.entries(KNOWN_GAPS)) {
      const item = EVAL_CASES.find(candidate => candidate.id === id);
      expect(item, `known gap "${id}" names no case`).toBeDefined();
      expect(Object.keys(gap).length, `known gap "${id}" lists no mode`).toBeGreaterThan(0);
      if (gap.ceiling) expect(item!.plan, `known gap "${id}" lists a ceiling gap but the case has no plan`).toBeDefined();
      for (const reason of Object.values(gap)) expect(String(reason).trim().length, `known gap "${id}" needs a reason`).toBeGreaterThan(10);
    }
  });
});
