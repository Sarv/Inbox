import { lastToolResult, type AgentReply, type AgentTurn, type AssistantHarness } from '../../helpers/assistant-harness';

import { BASE_MAILS, TRIAGE_MAILS, type Mail } from './mailbox';

/**
 * The requests that are not a mailbox question (cases.ts, ROUTING_CASES), as
 * tasks for the tool-using agent: what a competent model does with each (the
 * `steps`, written by hand like a case's `plan`), and what must then be true
 * of the mailbox and the cards (`check`). The agent has no router, so there is
 * no "floor" here: choosing the tools IS the model's job. What a task proves
 * is that the tools can do it, and that the host keeps its guarantees while
 * they do (nothing changes before approval, nothing outside what was found).
 *
 * The old router's `route` for each case is kept in cases.ts; a task's id is
 * that case's id.
 */

export type TaskStep = (turn: AgentTurn) => AgentReply;

export interface AgentTask {
  /** Ids that came from the model's own reading of a tool result (S…), resolved per turn. */
  steps: TaskStep[];
  /** What must be true after the run. Returns the problems, empty when it passed. */
  check(run: TaskRun): Promise<string[]> | string[];
  /** The classifier's labels, for tasks that classify: by email id. */
  classify?: (mail: Mail) => string;
}

export interface TaskRun {
  harness: AssistantHarness;
  /** Every tool result the model was shown, in order. */
  results: string[];
  /** Tool names the model was offered on its first turn. */
  offered: string[];
}

const step = (name: string, args: Record<string, unknown> = {}): TaskStep => () => ({ tools: [{ name, arguments: args }] });
const answer = (message: string): TaskStep => () => ({ tools: [{ name: 'answer', arguments: { facts: [], message } }] });
/** The S ids of the rows the last tool result listed. */
export const shownIds = (turn: AgentTurn): string[] => [...lastToolResult(turn).matchAll(/^(S\d+) \|/gm)].map(match => match[1]!);

const ALL_MAILS: readonly Mail[] = [...BASE_MAILS, ...TRIAGE_MAILS];
const sorted = (values: Iterable<string>) => [...values].sort();
const DISPOSABLE = sorted(TRIAGE_MAILS.filter(mail => mail.label === 'disposable').map(mail => mail.id));
const triage = (mail: Mail) => (TRIAGE_MAILS.find(item => item.id === mail.id)?.label === 'disposable' ? 'not_needed' : 'needs_user');

/** The run's one change set: its action, emails and status, or what is wrong. */
function oneSet(run: TaskRun, action: string, emailIds: string[]): string[] {
  const exchange = run.harness.chat().exchanges.at(-1);
  const sets = exchange?.changeSets ?? [];
  if (sets.length !== 1) return [`staged ${sets.length} change sets, expected 1`];
  const set = sets[0]!;
  const problems: string[] = [];
  if (set.action !== action) problems.push(`staged "${set.action}", expected "${action}"`);
  if (set.status !== 'pending') problems.push(`the change set is "${set.status}"; in "Ask for approval" it must wait`);
  const got = sorted(set.items.map(item => item.emailId));
  if (JSON.stringify(got) !== JSON.stringify(sorted(emailIds))) problems.push(`staged ${JSON.stringify(got)}, expected ${JSON.stringify(sorted(emailIds))}`);
  if (run.harness.engine.ops.length) problems.push(`the server was told to change mail before approval: ${JSON.stringify(run.harness.engine.ops)}`);
  return problems;
}

function noChange(run: TaskRun): string[] {
  const exchange = run.harness.chat().exchanges.at(-1);
  const problems: string[] = [];
  if (exchange?.changeSets?.length || exchange?.settingChanges?.length) problems.push('staged a change');
  if (run.harness.engine.ops.length) problems.push('changed mail on the server');
  return problems;
}

function chatOnly(expected: string[]): AgentTask {
  return {
    steps: [answer('I am Inbox Agent. I can search and answer questions about your mail, and change it with your approval.')],
    check: run => {
      const problems = noChange(run);
      if (run.results.length) problems.push(`called ${run.results.length} tools for a chat reply`);
      for (const tool of expected) if (!run.offered.includes(tool)) problems.push(`the model was not offered "${tool}", so it cannot say it can do that`);
      if (!run.harness.chat().exchanges.at(-1)?.answer.text.trim()) problems.push('no reply');
      return problems;
    },
  };
}

const review = (filters: Record<string, unknown>): AgentTask => ({
  steps: [
    step('search_mail', { unread: true, limit: 50, ...filters }),
    turn => ({ tools: [{ name: 'classify_messages', arguments: { ids: shownIds(turn), question: 'Does this email need the user?', labels: ['needs_user', 'not_needed'] } }] }),
    step('change_mail', { action: 'mark_read', from_result: 'T2', labels: ['not_needed'] }),
    answer('The emails that do not need you wait for your approval to be marked as read.'),
  ],
  classify: triage,
  check: run => oneSet(run, 'mark_read', DISPOSABLE),
});

const markSender = (filters: Record<string, unknown>, match: (mail: Mail) => boolean): AgentTask => ({
  steps: [
    step('search_mail', { unread: true, ...filters }),
    turn => ({ tools: [{ name: 'change_mail', arguments: { action: 'mark_read', ids: shownIds(turn) } }] }),
    answer('They wait for your approval.'),
  ],
  check: run => oneSet(run, 'mark_read', ALL_MAILS.filter(mail => mail.unread && match(mail)).map(mail => mail.id)),
});

/** A pointing word with nothing to point at: the host refuses ids the run never showed. */
const unscoped: AgentTask = {
  steps: [step('change_mail', { action: 'mark_read', ids: ['S1', 'S2'] }), answer('Which emails do you mean?')],
  check: run => {
    const problems = noChange(run);
    if (!/Not email ids from this conversation's results/.test(run.results[0] ?? '')) problems.push(`the host accepted ids no tool showed: ${run.results[0]?.slice(0, 200)}`);
    return problems;
  },
};

const unreadCount = ALL_MAILS.filter(mail => mail.unread).length;

export const AGENT_TASKS: Record<string, AgentTask> = {
  'review-unread': review({}),
  'review-unread-polite': review({}),
  'review-unread-hinglish': review({}),
  'review-uncategorized': review({ category: 'none' }),
  'mark-sender-read': markSender({ from: 'LinkedIn' }, mail => /linkedin/i.test(mail.from.join(' '))),
  'mark-sender-read-hinglish': markSender({ from: 'LinkedIn' }, mail => /linkedin/i.test(mail.from.join(' '))),
  'mark-phrase-read': markSender({ text: 'SaaS Weekly' }, mail => /SaaS Weekly/.test(`${mail.subject} ${mail.from.join(' ')} ${mail.body}`)),
  'mark-pronoun': unscoped,
  'mark-all': unscoped,
  'mark-the-rest': unscoped,
  'what-can-you-do': chatOnly(['search_mail', 'change_mail', 'create_filter', 'change_sender']),
  'thanks': chatOnly([]),
  'namaste': chatOnly([]),
  'who-are-you': chatOnly([]),
  'categorize': {
    steps: [
      step('list_categories'),
      step('search_mail', { category: 'none', unread: true, limit: 50 }),
      turn => ({ tools: [{ name: 'change_mail', arguments: { action: 'add_category', category: 'important', ids: shownIds(turn).slice(0, 2) } }] }),
      answer('Two emails wait for your approval to be filed.'),
    ],
    check: run => {
      const set = run.harness.chat().exchanges.at(-1)?.changeSets?.[0];
      const problems: string[] = [];
      if (!/no categories|\(/.test(run.results[0] ?? '')) problems.push('list_categories showed nothing');
      if (set?.action !== 'add_category' || set.items.length !== 2 || set.status !== 'pending') problems.push(`expected 2 emails waiting to be categorized, got ${JSON.stringify(set && { action: set.action, items: set.items.length, status: set.status })}`);
      if (run.harness.engine.ops.length) problems.push('changed mail before approval');
      return problems;
    },
  },
  'archive-newsletters': {
    steps: [
      step('search_mail', { text: 'newsletter', limit: 50 }),
      turn => ({ tools: [{ name: 'classify_messages', arguments: { ids: shownIds(turn), question: 'Is this a newsletter?', labels: ['newsletter', 'other'] } }] }),
      step('change_mail', { action: 'archive', from_result: 'T2', labels: ['newsletter'] }),
      answer('The newsletters wait for your approval to be archived.'),
    ],
    classify: mail => (/newsletter|digest|unsubscribe/i.test(`${mail.subject} ${mail.from.join(' ')}`) && mail.folder === 'inbox' ? 'newsletter' : 'other'),
    check: run => {
      const set = run.harness.chat().exchanges.at(-1)?.changeSets?.[0];
      const problems: string[] = [];
      if (set?.action !== 'archive' || !set.items.length || set.status !== 'pending') problems.push(`expected newsletters waiting to be archived, got ${JSON.stringify(set && { action: set.action, items: set.items.length, status: set.status })}`);
      if (set?.items.some(item => !/newsletter|digest|weekly|unsubscribe/i.test(`${item.subject} ${item.from}`))) problems.push('staged an email that is not a newsletter');
      if (run.harness.engine.ops.length) problems.push('changed mail before approval');
      return problems;
    },
  },
  'star-this': markStar(),
  'count-unread': {
    steps: [step('count_mail', { unread: true }), answer('See the count above.')],
    check: run => (new RegExp(`\\b${unreadCount}\\b`).test(run.results[0] ?? '') ? noChange(run) : [`count_mail did not show ${unreadCount}: ${run.results[0]?.slice(0, 200)}`]),
  },
  'starred-list': {
    steps: [step('search_mail', { starred: true }), answer('Those are your starred emails.')],
    check: run => (/\b0\b|no (?:matching )?(?:email|mail)/i.test(run.results[0] ?? '') ? noChange(run) : [`the starred listing was not empty: ${run.results[0]?.slice(0, 200)}`]),
  },
  'draft-reply': {
    steps: [answer('I cannot write drafts yet.')],
    check: run => (run.offered.includes('create_draft') ? noChange(run) : ['no tool writes a draft (Phase 4)']),
  },
};

function markStar(): AgentTask {
  return {
    steps: [
      step('search_mail', { from: 'Anita', limit: 1 }),
      turn => ({ tools: [{ name: 'change_mail', arguments: { action: 'star', ids: shownIds(turn) } }] }),
      answer('Starring it waits for your approval.'),
    ],
    check: run => {
      const set = run.harness.chat().exchanges.at(-1)?.changeSets?.[0];
      const problems: string[] = [];
      if (set?.action !== 'star' || set.items.length !== 1 || !/anita/i.test(set.items[0]!.from)) problems.push(`expected Anita's latest email waiting to be starred, got ${JSON.stringify(set && { action: set.action, items: set.items.map(item => item.from) })}`);
      if (run.harness.engine.ops.length) problems.push('changed mail before approval');
      return problems;
    },
  };
}
