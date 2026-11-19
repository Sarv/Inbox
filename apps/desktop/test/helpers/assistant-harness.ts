import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AIProviderConfig, EmailRecord } from '@sarvinbox/core';
import Database from 'better-sqlite3';
import { vi } from 'vitest';

import type { AssistantAttachmentResult } from '../../electron/services/assistant-attachment-types';
import type { AgentSettingStorage } from '../../electron/services/inbox-agent-setting-host';
import type { InboxAgentMailActions } from '../../electron/services/inbox-assistant-change-sets';
import type { InboxAssistantHistoryStore } from '../../electron/services/inbox-assistant-history';
import type { InboxAssistantService, InboxAssistantServiceDeps } from '../../electron/services/inbox-assistant-service';
import type { VerdictDeps } from '../../electron/services/spam-verdict-actions';
import type { InboxAssistantAccount, InboxAssistantAIPurpose, InboxAssistantChat, InboxAssistantExchange, InboxAssistantRequest } from '../../src/types/inbox-assistant';

import { openTestAccount, type TestAccount } from './account-storage';

/**
 * The REAL Inbox Agent, end to end, for tests that ask it questions.
 *
 * Everything between the question and the saved chat is production code: the
 * service, the planner, retrieval over real account databases (the built
 * storage-node facade), the verifier, the chat history store on a real SQLite
 * table, and the provider call path (`callInboxAssistantAI`, so usage
 * accounting and error classification are the real ones). Only two things are
 * replaced: the network, by a scripted endpoint, and attachment reading.
 *
 * Use it instead of hand-wiring `InboxAssistantServiceDeps` when a test's
 * subject is what a question does, not one module's contract.
 */

/** What the scripted model does with one call. */
export type ScriptedReply =
  | string
  /** The endpoint answers with this HTTP status (and optional body text). */
  | { status: number; body?: string }
  /** The call fails before any response, as the network or a timeout would. */
  | { throw: unknown }
  /** A reply with this finish reason, e.g. `length` with no text: a reasoning model out of budget. */
  | { content: string; finish: string };

export type ScriptedAI = (prompt: string, purpose: InboxAssistantAIPurpose) => ScriptedReply | Promise<ScriptedReply>;

/** One turn of the agent loop, as the provider received it (OpenAI wire format). */
export interface AgentTurn {
  /** 1-based count of agent calls so far in this harness. */
  call: number;
  messages: Array<{ role: string; content: string | null; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>; tool_call_id?: string }>;
  /** Tool names offered on this turn; empty in the JSON protocol. */
  tools: string[];
  /** The `reasoning_effort` the request carried, if any. */
  reasoningEffort?: string;
}

/** What the scripted agent model does with one turn. */
export type AgentReply =
  /** Call these tools (arguments as objects). */
  | { tools: Array<{ name: string; arguments: Record<string, unknown> | string }>; text?: string }
  /** Reply in prose (or, in the JSON protocol, the JSON text). */
  | { text: string; finish?: string }
  | { status: number; body?: string }
  | { throw: unknown };

export type ScriptedAgent = (turn: AgentTurn) => AgentReply | Promise<AgentReply>;

/** The latest tool or JSON-protocol result the agent model was shown, as text. */
export function lastToolResult(turn: AgentTurn): string {
  for (let index = turn.messages.length - 1; index >= 0; index--) {
    const message = turn.messages[index]!;
    if (message.role === 'tool' || (message.role === 'user' && (message.content ?? '').startsWith('Result T'))) return message.content ?? '';
  }
  return '';
}

type QueueAnswer = 'success' | 'queued' | 'failed';

/**
 * The sync engine behind the agent's mail changes (`mailActions: true`). The
 * local writes are the production ones (read flags, stars, moves, categories
 * on the real account database); only the server queue is this recorder.
 */
export interface HarnessEngine {
  /** Every queue call, in order. */
  ops: Array<{ accountId: string; op: string; path: string; uids: number[]; destination?: string }>;
  /** The queue's answer to each call. Default: 'success' (a move then gets a new UID at once, as a completed MOVE does). */
  answer: (op: string, accountId: string) => QueueAnswer;
  /** Spam verdicts that would go to the reputation service (when the user allows reports). Never sent. */
  reports: Array<{ accountId: string; verdict: 'spam' | 'ham' }>;
}

/** The in-memory change journal (see AssistantHarness.journal). */
export interface HarnessJournal { text: string | null; unreadable: boolean; read(): string | null; write(value: string): void }

export interface AssistantHarness {
  accounts: InboxAssistantAccount[];
  service: InboxAssistantService;
  history: InboxAssistantHistoryStore;
  deps: InboxAssistantServiceDeps;
  /** The chat `ask` uses. `newChat` replaces it. */
  chatId: string;
  /** Replace the scripted model at any time. */
  ai: ScriptedAI;
  /** Every model call made so far, in order. */
  calls: Array<{ purpose: InboxAssistantAIPurpose; prompt: string }>;
  /** Replace the scripted agent model at any time. Unset: typed questions take the fixed paths. */
  agent?: ScriptedAgent;
  /** Every agent-loop turn sent so far, in order. */
  agentTurns: AgentTurn[];
  /** Every line written through the logger or `console.*` since the harness was created. */
  logs: string[];
  /** Every read or unread change the agent made to mail, in order. Nothing is written to the mailbox. */
  readChanges: Array<{ accountId: string; emailIds: string[]; read: boolean; source?: string }>;
  /** The queue behind `mailActions: true`. */
  engine: HarnessEngine;
  /**
   * The change journal behind `mailActions: true` (the app keeps it in the core
   * database). `new InboxAssistantService(harness.deps)` reads it as the app
   * does after a restart; `unreadable` makes that read fail.
   */
  journal: HarnessJournal;
  /** Start a fresh chat, so a question is not read as a follow-up to the last one. */
  newChat(): string;
  mailbox(accountId: string): TestAccount;
  /** Insert one email. `sent: true` files it in Sent, from the account's own address. */
  mail(accountId: string, threadId: string, record: Partial<EmailRecord> & { id: string; sent?: boolean }): Promise<void>;
  /** Ask in the harness chat. Rejects exactly as the service does. */
  ask(question: string, over?: Partial<InboxAssistantRequest>): Promise<InboxAssistantExchange>;
  /** The chat as it is saved, read back through the history store. */
  chat(): InboxAssistantChat;
  close(): Promise<void>;
}

export const HARNESS_ACCOUNTS: InboxAssistantAccount[] = [
  { id: 'primary', email: 'rc@sarv.example' },
  { id: 'secondary', email: 'sales@sarv.example' },
];

/** Which step a prompt belongs to, from the prompt's own fixed opening. */
export function scriptedPurpose(prompt: string): InboxAssistantAIPurpose {
  if (prompt.startsWith('You plan')) return 'plan';
  if (prompt.startsWith('Classify each email')) return 'classify';
  if (prompt.includes('\nVALIDATION_REPAIR: ')) return 'repair';
  if (prompt.includes('UNTRUSTED_EVIDENCE_JSON: ')) return 'answer';
  return 'review';
}

/** The conversations an unread-review prompt asked the model to judge. */
export function promptConversations(prompt: string): Array<{ id: string }> {
  const marker = 'UNTRUSTED_CONVERSATIONS_JSON: ';
  const start = prompt.indexOf(marker);
  return start < 0 ? [] : JSON.parse(prompt.slice(start + marker.length).split('\n')[0]!) as Array<{ id: string }>;
}

/** The evidence a prompt actually carried, as the model would see it. */
export function promptEvidence(prompt: string): Array<{ id: string; evidence: string }> {
  const line = prompt.split('\n').find(value => value.startsWith('UNTRUSTED_EVIDENCE_JSON: '));
  return line ? JSON.parse(line.slice('UNTRUSTED_EVIDENCE_JSON: '.length)) as Array<{ id: string; evidence: string }> : [];
}

/** A model that answers with nothing: every search case can run without scripting an answer. */
export const NO_FACTS = '{"facts":[]}';

export async function createAssistantHarness(options: {
  accounts?: InboxAssistantAccount[];
  ai?: ScriptedAI;
  /** Turn the agent loop on, with this scripted model. */
  agent?: ScriptedAgent;
  readAttachment?: InboxAssistantServiceDeps['readAttachment'];
  now?: () => number;
  timeZone?: string;
  /** Give the agent its write tools, over the real account databases and a recording queue. */
  mailActions?: boolean;
} = {}): Promise<AssistantHarness> {
  // The history store imports the Electron-bound core DB module for its default
  // database. Tests supply their own, so the import must never reach Electron.
  vi.doMock('../../electron/services/core-db', () => ({ getCoreDb: () => { throw new Error('Use the harness database.'); } }));
  const { createInboxAssistantHistoryStore } = await import('../../electron/services/inbox-assistant-history');
  const { InboxAssistantService: Service } = await import('../../electron/services/inbox-assistant-service');
  const { callInboxAssistantAI, callInboxAssistantChat, INBOX_ASSISTANT_SYSTEM_PROMPT } = await import('../../electron/services/inbox-assistant-usage');
  const { changeAssistantReadFlags, changeAssistantStarFlags } = await import('../../electron/services/assistant-mail-actions');
  const { changeAssistantMailLocation } = await import('../../electron/services/assistant-mail-moves');
  const { changeEmailCategory } = await import('../../electron/services/classification-actions');
  const { createAgentSettingActions } = await import('../../electron/services/inbox-agent-setting-host');
  const { createInboxAgentChangeJournal } = await import('../../electron/services/inbox-assistant-change-journal');
  const { agentSpamVerdicts, createAgentLabel, dropAgentLabel, labelAgentEmails, revertAgentSpamVerdicts, snoozeAgentEmails } = await import('../../electron/services/inbox-agent-mail-actions');

  const accounts = options.accounts ?? HARNESS_ACCOUNTS;
  const dir = await mkdtemp(join(tmpdir(), 'assistant-harness-'));
  const mailboxes = new Map<string, TestAccount>();
  for (const account of accounts) mailboxes.set(account.id, await openTestAccount(dir, account.id));
  const db = new Database(':memory:');
  db.exec('CREATE TABLE core_blobs(key TEXT PRIMARY KEY, data BLOB NOT NULL, updated_at INTEGER NOT NULL)');
  const history = createInboxAssistantHistoryStore(() => db);
  const chatId = history.create().id;

  const logs: string[] = [];
  const render = (value: unknown): string => typeof value === 'string' ? value
    : value instanceof Error ? `${value.name}: ${value.message}\n${value.stack ?? ''}` : JSON.stringify(value) ?? String(value);
  const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map(level =>
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { logs.push(args.map(render).join(' ')); }));

  const calls: AssistantHarness['calls'] = [];
  const readChanges: AssistantHarness['readChanges'] = [];
  let requests = 0;
  const agentTurns: AgentTurn[] = [];
  const engine: HarnessEngine = { ops: [], answer: () => 'success', reports: [] };
  // The change journal the app keeps in the core database, here in memory: a
  // service built again from these deps is the app after a restart.
  const journal: HarnessJournal = { text: null, unreadable: false,
    read() { if (this.unreadable) throw new Error('locked'); return this.text; }, write(value: string) { this.text = value; } };

  const harness = {
    accounts, history, chatId, calls, logs, readChanges, agentTurns, agent: options.agent, engine, journal,
    // By default the planner is refused (a 400 is permanent, so nothing retries)
    // and the answer is empty: the host's own routing and retrieval, unaided.
    ai: options.ai ?? (prompt => scriptedPurpose(prompt) === 'plan' ? { status: 400 } : NO_FACTS),
  } as AssistantHarness;

  // A provider that is only a fetch: the production call path does the rest.
  const config: AIProviderConfig = {
    type: 'openai', apiKey: 'harness-key', model: 'harness-model', baseUrl: 'https://ai.invalid/v1',
    fetchImpl: (async (_input: unknown, init?: { body?: unknown }) => {
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content: string }>; tools?: Array<{ function: { name: string } }>; reasoning_effort?: string };
      if (body.messages[0]?.role === 'system' && body.messages[0].content.startsWith('You are Inbox Agent inside')) {
        const turn: AgentTurn = { call: agentTurns.length + 1, messages: body.messages as AgentTurn['messages'], tools: (body.tools ?? []).map(tool => tool.function.name),
          ...(body.reasoning_effort ? { reasoningEffort: body.reasoning_effort } : {}) };
        agentTurns.push(turn);
        if (!harness.agent) throw new Error('The agent loop ran without a scripted agent model.');
        const reply = await harness.agent(turn);
        if ('throw' in reply) throw reply.throw;
        if ('status' in reply) return new Response(reply.body ?? JSON.stringify({ error: { message: 'scripted failure' } }), { status: reply.status });
        const size = Math.ceil(JSON.stringify(body).length / 4);
        const message = 'tools' in reply
          ? { content: reply.text ?? null, tool_calls: reply.tools.map((call, index) => ({ id: `call-${turn.call}-${index + 1}`, type: 'function',
            function: { name: call.name, arguments: typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments) } })) }
          : { content: reply.text };
        return new Response(JSON.stringify({ model: 'harness-model', choices: [{ message, finish_reason: 'tools' in reply ? 'tool_calls' : reply.finish ?? 'stop' }],
          usage: { prompt_tokens: size, completion_tokens: 20 } }), { status: 200 });
      }
      const prompt = body.messages[1]!.content;
      const purpose = scriptedPurpose(prompt);
      calls.push({ purpose, prompt });
      const reply = await harness.ai(prompt, purpose);
      if (typeof reply === 'string') {
        return new Response(JSON.stringify({ model: 'harness-model', choices: [{ message: { content: reply } }],
          usage: { prompt_tokens: Math.ceil(prompt.length / 4), completion_tokens: Math.ceil(reply.length / 4) } }), { status: 200 });
      }
      if ('throw' in reply) throw reply.throw;
      if ('finish' in reply) {
        return new Response(JSON.stringify({ model: 'harness-model', choices: [{ message: { content: reply.content }, finish_reason: reply.finish }],
          usage: { prompt_tokens: Math.ceil(prompt.length / 4), completion_tokens: 1_000 } }), { status: 200 });
      }
      return new Response(reply.body ?? JSON.stringify({ error: { message: 'scripted failure' } }), { status: reply.status });
    }) as unknown as typeof fetch,
  };

  let nextUid = 90_000;
  /** The production mail actions over one harness account, with `engine` as its server queue. */
  const target = (accountId: string) => {
    const mailbox = mailboxes.get(accountId);
    if (!mailbox) throw new Error('Unknown harness account.');
    const queue = (op: string, path: string, uids: number[], destination?: string): QueueAnswer => {
      engine.ops.push({ accountId, op, path, uids: [...uids], ...(destination ? { destination } : {}) });
      return engine.answer(op, accountId);
    };
    return {
      storage: mailbox.storage,
      engine: {
        bulkMarkAsRead: async (path: string, uids: number[]) => queue('read', path, uids),
        bulkMarkAsUnread: async (path: string, uids: number[]) => queue('unread', path, uids),
        bulkStar: async (path: string, uids: number[]) => queue('star', path, uids),
        bulkUnstar: async (path: string, uids: number[]) => queue('unstar', path, uids),
        move: async (path: string, uid: number, destination: string, emailId?: string) => {
          const answer = queue('move', path, [uid], destination);
          // A completed MOVE maps the row to its new UID in the destination.
          if (answer === 'success' && emailId) await mailbox.storage.updateEmail(emailId, { uid: ++nextUid });
          return answer;
        },
        isConnected: () => false,
        fetchUidByMessageId: async () => null,
        assertManualCategorySync: () => {},
        moveToSpam: async (path: string, uid: number) => queue('spam', path, [uid]),
        markImportant: async (path: string, uid: number, on: boolean) => queue(on ? 'important' : 'unimportant', path, [uid]),
        setCategorySelection: async (path: string, uid: number) => queue('category', path, [uid]),
      },
      assertCurrent: async () => {},
    };
  };
  const harnessMailActions = (): InboxAgentMailActions => ({
    setRead: (accountId, ids, read) => changeAssistantReadFlags(target(accountId), ids, read),
    setStarred: (accountId, ids, starred) => changeAssistantStarFlags(target(accountId), ids, starred),
    move: (accountId, ids, to) => changeAssistantMailLocation(target(accountId), ids, to),
    // Production restores through restoreEmailsFromTrash (email-handlers), which
    // needs a live IMAP pool; here it is the same move back to Inbox.
    restore: (accountId, ids) => changeAssistantMailLocation(target(accountId), ids, { folderId: 'f-inbox' }),
    setCategory: async (accountId, ids, slug, on) => {
      const receipt = { appliedIds: [] as string[], queuedIds: [] as string[], failedIds: [] as string[] };
      const { storage, engine: queue } = target(accountId);
      for (const id of ids) {
        try {
          const result = await changeEmailCategory(storage, queue, id, slug, on);
          (result.syncStatus === 'queued' ? receipt.queuedIds : receipt.appliedIds).push(id);
        } catch { receipt.failedIds.push(id); }
      }
      return receipt;
    },
    // The app's own label, snooze and spam writes (inbox-agent-mail-actions.ts).
    setLabel: (accountId, ids, name, on) => labelAgentEmails(target(accountId), ids, name, on),
    createLabel: (accountId, name) => createAgentLabel(target(accountId), name),
    dropLabel: (accountId, name) => dropAgentLabel(target(accountId), name),
    setSnooze: (accountId, ids, until) => snoozeAgentEmails(target(accountId), ids, until),
    spamVerdict: (accountId, ids, verdict) => agentSpamVerdicts(target(accountId), verdictDeps(accountId), ids, verdict),
    revertSpamVerdict: (accountId, rows) => revertAgentSpamVerdicts(target(accountId), verdictDeps(accountId), rows),
  });
  /** A verdict's server queue is the recording engine; reports to the reputation service are recorded, never sent. */
  const verdictDeps = (accountId: string): VerdictDeps => {
    const { storage, engine: queue } = target(accountId);
    return { storage: storage as unknown as VerdictDeps['storage'], queue: { moveToSpam: queue.moveToSpam, move: (path, uid, destination) => queue.move(path, uid, destination) },
      report: report => engine.reports.push({ accountId, verdict: report.verdict }) };
  };

  // The app's own settings writes over the real account databases (inbox-agent-setting-host.ts).
  const harnessSettingActions = () => createAgentSettingActions(async accountId => {
    const { storage, assertCurrent } = target(accountId);
    return { storage: storage as unknown as AgentSettingStorage, assertCurrent };
  });

  const deps: InboxAssistantServiceDeps = {
    accounts: () => accounts,
    openMailbox: async accountId => {
      const mailbox = mailboxes.get(accountId);
      if (!mailbox) throw new Error('Unknown harness account.');
      return { storage: mailbox.storage, aliases: [] };
    },
    readAttachment: options.readAttachment ?? (async ref => ({ ref, status: 'unavailable', segments: [], truncated: false } satisfies AssistantAttachmentResult)),
    callAI: (prompt, signal, onUsage, callOptions) => callInboxAssistantAI(
      callOptions?.maxOutputTokens === undefined ? config : { ...config, maxOutputTokens: callOptions.maxOutputTokens },
      INBOX_ASSISTANT_SYSTEM_PROMPT, prompt, signal, onUsage),
    callAIChat: (request, signal, onUsage) => callInboxAssistantChat(config, request, signal, onUsage),
    agentHarness: () => harness.agent !== undefined,
    history,
    setRead: async (accountId, emailIds, read, context) => {
      readChanges.push({ accountId, emailIds: [...emailIds], read, ...(context ? { source: context.source } : {}) });
      return { appliedIds: [...emailIds], queuedIds: [], failedIds: [] };
    },
    ...(options.now ? { now: options.now } : {}),
    timeZone: () => options.timeZone ?? 'Asia/Kolkata',
    ...(options.mailActions ? { mailActions: harnessMailActions(), settingActions: harnessSettingActions(), changeJournal: createInboxAgentChangeJournal(journal) } : {}),
  };
  harness.deps = deps;
  harness.service = new Service(deps);
  harness.mailbox = accountId => {
    const mailbox = mailboxes.get(accountId);
    if (!mailbox) throw new Error(`No harness account "${accountId}".`);
    return mailbox;
  };
  harness.mail = async (accountId, threadId, { sent, ...record }) => {
    const account = accounts.find(item => item.id === accountId)!;
    await harness.mailbox(accountId).add(threadId, {
      ...(sent ? { folderId: 'f-sent', tags: '|Sent|', fromAddress: account.email } : { toAddress: account.email }),
      ...record,
    });
  };
  harness.ask = (question, over = {}) => harness.service.ask({
    requestId: `harness-request-${++requests}`, chatId: harness.chatId, question, accountIds: accounts.map(account => account.id), ...over,
  });
  harness.chat = () => history.load(harness.chatId, { select: false });
  harness.newChat = () => { harness.chatId = history.create().id; return harness.chatId; };
  harness.close = async () => {
    for (const spy of spies) spy.mockRestore();
    for (const mailbox of mailboxes.values()) await mailbox.close();
    db.close();
    await rm(dir, { recursive: true, force: true });
    vi.doUnmock('../../electron/services/core-db');
  };
  return harness;
}
