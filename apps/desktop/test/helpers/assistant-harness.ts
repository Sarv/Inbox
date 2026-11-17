import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AIProviderConfig, EmailRecord } from '@sarvinbox/core';
import Database from 'better-sqlite3';
import { vi } from 'vitest';

import type { AssistantAttachmentResult } from '../../electron/services/assistant-attachment-types';
import type { InboxAssistantHistoryStore } from '../../electron/services/inbox-assistant-history';
import type { InboxAssistantService, InboxAssistantServiceDeps } from '../../electron/services/inbox-assistant-service';
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
  | { throw: unknown };

export type ScriptedAI = (prompt: string, purpose: InboxAssistantAIPurpose) => ScriptedReply | Promise<ScriptedReply>;

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
  /** Every line written through the logger or `console.*` since the harness was created. */
  logs: string[];
  /** Every read or unread change the agent made to mail, in order. Nothing is written to the mailbox. */
  readChanges: Array<{ accountId: string; emailIds: string[]; read: boolean; source?: string }>;
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
  readAttachment?: InboxAssistantServiceDeps['readAttachment'];
  now?: () => number;
  timeZone?: string;
} = {}): Promise<AssistantHarness> {
  // The history store imports the Electron-bound core DB module for its default
  // database. Tests supply their own, so the import must never reach Electron.
  vi.doMock('../../electron/services/core-db', () => ({ getCoreDb: () => { throw new Error('Use the harness database.'); } }));
  const { createInboxAssistantHistoryStore } = await import('../../electron/services/inbox-assistant-history');
  const { InboxAssistantService: Service } = await import('../../electron/services/inbox-assistant-service');
  const { callInboxAssistantAI, INBOX_ASSISTANT_SYSTEM_PROMPT } = await import('../../electron/services/inbox-assistant-usage');

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
  const harness = {
    accounts, history, chatId, calls, logs, readChanges,
    // By default the planner is refused (a 400 is permanent, so nothing retries)
    // and the answer is empty: the host's own routing and retrieval, unaided.
    ai: options.ai ?? (prompt => scriptedPurpose(prompt) === 'plan' ? { status: 400 } : NO_FACTS),
  } as AssistantHarness;

  // A provider that is only a fetch: the production call path does the rest.
  const config: AIProviderConfig = {
    type: 'openai', apiKey: 'harness-key', model: 'harness-model', baseUrl: 'https://ai.invalid/v1',
    fetchImpl: (async (_input: unknown, init?: { body?: unknown }) => {
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> };
      const prompt = body.messages[1]!.content;
      const purpose = scriptedPurpose(prompt);
      calls.push({ purpose, prompt });
      const reply = await harness.ai(prompt, purpose);
      if (typeof reply === 'string') {
        return new Response(JSON.stringify({ model: 'harness-model', choices: [{ message: { content: reply } }],
          usage: { prompt_tokens: Math.ceil(prompt.length / 4), completion_tokens: Math.ceil(reply.length / 4) } }), { status: 200 });
      }
      if ('throw' in reply) throw reply.throw;
      return new Response(reply.body ?? JSON.stringify({ error: { message: 'scripted failure' } }), { status: reply.status });
    }) as unknown as typeof fetch,
  };

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
    history,
    setRead: async (accountId, emailIds, read, context) => {
      readChanges.push({ accountId, emailIds: [...emailIds], read, ...(context ? { source: context.source } : {}) });
      return { appliedIds: [...emailIds], queuedIds: [], failedIds: [] };
    },
    ...(options.now ? { now: options.now } : {}),
    timeZone: () => options.timeZone ?? 'Asia/Kolkata',
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
