import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { lastToolResult, NO_FACTS, type AgentReply, type AgentTurn, type AssistantHarness } from '../../helpers/assistant-harness';

import { AGENT_TASKS, type TaskStep } from './agent-tasks';
import { EVAL_CASES, ROUTING_CASES, type EvalCase } from './cases';
import { KNOWN_GAPS } from './known-gaps';
import { BASE_MAILS, TRIAGE_MAILS } from './mailbox';
import { createEvalHarness, squash } from './seed';

/**
 * Scores the Inbox Agent on the evaluation set, with no model.
 *
 * Every case runs through the real service and agent loop against the seeded
 * mailbox (see assistant-harness.ts and mailbox.ts). Since Phase 3b
 * (docs/INBOX_AGENT_HARNESS.md) the agent is the only path, and this replaced
 * the old router's evaluation with the same questions and the same gaps:
 *
 *   Questions about mail (a `gold` answer): the model asks deep_search the
 *   question as the user typed it, then answers by quoting the gold words from
 *   whichever excerpt shows them. Scored twice, as before: `floor` with the
 *   planner refused (host keyword rules), `ceiling` with the case's ideal plan.
 *   A follow-up's ceiling is the question made self-contained (SELF_CONTAINED).
 *   A case passes when the gold words reached the model in a tool result AND
 *   the answer kept them as a verified fact citing the gold email, so the
 *   grounding check is scored too.
 *
 *   Everything else (ROUTING_CASES): a task in agent-tasks.ts, the tool calls a
 *   competent model makes and what must then hold. Ceiling only: the agent has
 *   no router, so choosing tools is the model's job.
 *
 * What breaks if this goes red: a change to the agent's tools, its grounding
 * or a host guarantee has stopped a request that used to work from working.
 */

type Mode = 'floor' | 'ceiling';

/**
 * A follow-up as a competent model passes it to deep_search: self-contained,
 * with what "it" refers to spelled out (the tool's description asks for that).
 * Their ceiling run uses this question with the planner still refused.
 */
const SELF_CONTAINED: Record<string, string> = {
  'followup-validity': 'What is the validity of the quotation we sent to Thermax?',
  'followup-when': 'When did we send the quotation to Thermax?',
  'followup-hinglish': 'What is the validity of the quotation we sent to Thermax?',
};

let harness: AssistantHarness;
let script: (turn: AgentTurn) => AgentReply = () => ({ tools: [{ name: 'answer', arguments: { facts: [], message: 'idle' } }] });
const tally = new Map<string, { passed: number; total: number }>();

/** The excerpt id (S…) whose block shows `needle`, in the last tool result. */
function excerptShowing(turn: AgentTurn, needle: string): string | undefined {
  for (const block of lastToolResult(turn).split('\n\n---\n\n')) {
    if (squash(block).includes(needle)) return /\b(S\d+)\b/.exec(block)?.[1];
  }
  return undefined;
}

/** deep_search the question, then answer by quoting `needle` from the excerpt that shows it. */
function searchAndQuote(question: string, needle: string): Array<(turn: AgentTurn) => AgentReply> {
  return [
    () => ({ tools: [{ name: 'deep_search', arguments: { question } }] }),
    turn => {
      const id = excerptShowing(turn, needle);
      return { tools: [{ name: 'answer', arguments: id
        ? { facts: [{ text: needle, sourceIds: [id], quotes: [{ sourceId: id, text: needle }] }] }
        : { facts: [], message: 'I could not find it.' } }] };
    },
  ];
}

function play(steps: Array<(turn: AgentTurn) => AgentReply>): void {
  let index = 0;
  script = turn => steps[Math.min(index++, steps.length - 1)]!(turn);
}

const toolResults = (turns: AgentTurn[]) => {
  const last = turns.at(-1);
  return last ? last.messages.filter(message => message.role === 'tool').map(message => message.content ?? '') : [];
};

async function scoreQuestion(item: EvalCase, mode: Mode): Promise<string[]> {
  harness.newChat();
  harness.ai = (_prompt, purpose) => purpose !== 'plan' ? NO_FACTS : mode === 'ceiling' && item.plan ? JSON.stringify(item.plan) : { status: 400 };
  const question = mode === 'ceiling' ? SELF_CONTAINED[item.id] ?? item.ask : item.ask;
  let previous: string | undefined;
  if (item.after) {
    play(searchAndQuote(item.after.ask, item.after.cite));
    const first = await harness.ask(item.after.ask).catch(() => undefined);
    previous = first?.id;
    if (first?.answer.sourceStatus !== 'verified') return [`the first question ("${item.after.ask}") was not answered, so the follow-up could not be tested`];
  }
  const gold = item.gold!;
  play(searchAndQuote(question, gold.needle));
  harness.agentTurns.length = 0;
  // A follow-up names the message it follows, as the app's composer does.
  const exchange = await harness.ask(item.ask, previous ? { previousExchangeId: previous } : {}).catch(error => { throw new Error(`"${item.ask}" failed: ${(error as Error).message}`); });
  const shown = squash(toolResults(harness.agentTurns).join('\n'));
  const problems: string[] = [];
  if (!shown.includes(gold.needle)) problems.push(`"${gold.needle}" (email ${gold.emailId}) did not reach the model`);
  else if (!exchange.answer.sources.some(source => source.emailId === gold.emailId) || exchange.answer.sourceStatus !== 'verified') {
    problems.push(`the answer quoting "${gold.needle}" was not kept as a verified fact citing ${gold.emailId} (status ${exchange.answer.sourceStatus}, cites ${exchange.answer.sources.map(source => source.emailId).join(', ') || 'nothing'})`);
  }
  return problems;
}

async function scoreTask(id: string, item: EvalCase): Promise<string[]> {
  const task = AGENT_TASKS[id];
  if (!task) return [`no agent task is written for "${id}"`];
  harness.newChat();
  harness.engine.ops.length = 0;
  harness.ai = prompt => {
    if (!task.classify) return NO_FACTS;
    const items = JSON.parse(prompt.split('UNTRUSTED_EMAILS_JSON: ')[1]!) as Array<{ id: string; text: string }>;
    return JSON.stringify({ results: items.map(row => {
      const mail = [...BASE_MAILS, ...TRIAGE_MAILS].find(candidate => row.text.includes(candidate.subject));
      return { id: row.id, label: mail ? task.classify!(mail) : 'unsure', reason: 'Evaluation label.' };
    }) });
  };
  play(task.steps as TaskStep[]);
  harness.agentTurns.length = 0;
  await harness.ask(item.ask).catch(error => { throw new Error(`"${item.ask}" failed: ${(error as Error).message}`); });
  return task.check({ harness, results: toolResults(harness.agentTurns), offered: harness.agentTurns[0]?.tools ?? [] });
}

function gate(id: string, mode: Mode, ask: string, problems: string[]): void {
  const key = `${mode}`;
  const score = tally.get(key) ?? { passed: 0, total: 0 };
  score.total++;
  if (!problems.length) score.passed++;
  tally.set(key, score);
  const gap = KNOWN_GAPS[id]?.[mode];
  if (gap) expect(problems, `"${ask}" (${mode}) now passes. It is listed as a known gap (${gap}). Remove that entry from known-gaps.ts so the case is protected from now on.`).not.toEqual([]);
  else expect(problems, `"${ask}" (${mode})`).toEqual([]);
}

beforeAll(async () => { harness = await createEvalHarness(undefined, { agent: turn => script(turn) }); }, 120_000);
afterAll(async () => {
  await harness.close();
  for (const [mode, score] of tally) process.stdout.write(`[assistant-eval] ${mode.padEnd(7)} ${score.passed}/${score.total}  known gaps ${Object.values(KNOWN_GAPS).filter(gap => gap[mode as Mode]).length}\n`);
});

const QUESTIONS = EVAL_CASES.filter(item => item.gold);
const TASKS = ROUTING_CASES;

describe.each<Mode>(['floor', 'ceiling'])('Inbox Agent evaluation, questions: %s', mode => {
  const cases = QUESTIONS.filter(item => mode === 'floor' || item.plan || SELF_CONTAINED[item.id]);
  it.each(cases.map(item => [item.id, item] as const))('%s', async (id, item) => {
    gate(id, mode, item.ask, await scoreQuestion(item, mode));
  }, 60_000);
});

describe('Inbox Agent evaluation, tasks: ceiling', () => {
  it.each(TASKS.map(item => [item.id, item] as const))('%s', async (id, item) => {
    gate(id, 'ceiling', item.ask, await scoreTask(id, item));
  }, 60_000);
});

describe('the evaluation set itself', () => {
  // Breaks: a routing case is added with no agent task, or a gap entry outlives its case.
  it('has a task for every routing case, and every known gap names a case and a mode that runs', () => {
    expect(TASKS.map(item => item.id).filter(id => !AGENT_TASKS[id])).toEqual([]);
    for (const [id, gap] of Object.entries(KNOWN_GAPS)) {
      const item = EVAL_CASES.find(candidate => candidate.id === id);
      expect(item, `known gap "${id}" names no case`).toBeDefined();
      if (gap.floor) expect(item!.gold, `known gap "${id}" lists a floor gap but tasks run at the ceiling only`).toBeDefined();
      if (gap.ceiling && item!.gold) expect(item!.plan ?? SELF_CONTAINED[id], `known gap "${id}" lists a ceiling gap but the case has no ceiling run`).toBeDefined();
      for (const reason of Object.values(gap)) expect(String(reason).trim().length).toBeGreaterThan(10);
    }
  });
});
