import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AIChatRequest, AIChatResult, EmailRecord } from '@sarvinbox/core';
import { strToU8, zipSync } from 'fflate';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const draftGenerator = vi.hoisted(() => vi.fn());
vi.mock('../../../../electron/services/inbox-assistant-draft', () => ({ generateInboxAssistantDraft: draftGenerator }));

import { extractAssistantAttachment } from '../../../../electron/services/assistant-attachment-extractor';
import type { AssistantAttachmentResult } from '../../../../electron/services/assistant-attachment-types';
import { changeAssistantReadFlags } from '../../../../electron/services/assistant-mail-actions';
import { InboxAssistantService, type InboxAssistantServiceDeps } from '../../../../electron/services/inbox-assistant-service';
import type { InboxAssistantAccount, InboxAssistantAIUsage, InboxAssistantChat, InboxAssistantDraft, InboxAssistantDraftRequest, InboxAssistantExchange } from '../../../../src/types/inbox-assistant';
import { openTestAccount, type TestAccount } from '../../../helpers/account-storage';

const ACCOUNTS: InboxAssistantAccount[] = [
  { id: 'primary', email: 'rc@sarv.example' },
  { id: 'secondary', email: 'sales@sarv.example' },
];
const OLD_QUOTE = 'TCS quotation Q-104 revision 1. Total INR 100,000 excluding GST. Valid for 30 days.';
const NEW_QUOTE = 'TCS quotation Q-104 revision 2. Total INR 90,000 excluding GST. Valid for 15 days.';
const FILENAME = 'TCS-quotation-revision-2.xlsx';
const QUESTION = 'What quote did I send to TCS?';
const PLAN = JSON.stringify({ queries: ['TCS', 'quotation'], entityTerms: ['TCS'], intent: 'sent', quoteIntent: true, filters: {} });
const TEAM_DETAIL = 'Plan 30 concurrent sessions normally and 60 at peak. Production and DR each use four inference servers.';
const TEAM_COORDINATION = 'EPFO proposal coordination was acknowledged; the commercial attachment is not in this message.';
const TEAM_FORWARD = 'This forwards the earlier EPFO price bid sent to TCS; it is not a new submission or client acceptance.';
const TEAM_PRICE_FILE = 'EPFO-price-bid-final.xlsx';

/** Sanitized shape of the audited case: never copy real customer figures into fixtures. */
function teamPriceWorkbook(): Uint8Array {
  return zipSync(Object.fromEntries(Object.entries({
    'xl/workbook.xml': '<workbook xmlns:r="urn:rels"><sheets><sheet name="Cost Summary" r:id="r1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="r1" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/worksheets/sheet1.xml': '<worksheet><sheetData>'
      + '<row r="17"><c r="A17" t="inlineStr"><is><t>Total bid value including GST (INR)</t></is></c><c r="B17"><f>SUM(B12:B16)</f><v>2750000</v></c></row>'
      + '<row r="20"><c r="A20" t="inlineStr"><is><t>These are dummy evaluation quantities; payment uses actual consumption.</t></is></c></row>'
      + '</sheetData></worksheet>',
  }).map(([name, value]) => [name, strToU8(value)])));
}

async function seedTeamProposal(): Promise<void> {
  await primary.add('epfo-coordination-thread', {
    id: 'epfo-coordination', folderId: 'f-sent', tags: '|Sent|', fromAddress: ACCOUNTS[0]!.email,
    toAddress: 'buyer@tcs.example', subject: 'EPFO final proposal coordination', date: 1_788_220_800,
    cleanBody: TEAM_COORDINATION, rawBody: `<p>${TEAM_COORDINATION}</p>`,
  });
  await primary.add('epfo-team-thread', {
    id: 'epfo-technical-seed', fromAddress: 'vinay@integrator.example', toAddress: 'prakash@sarv.example',
    subject: 'EPFO technical proposal discussion', date: 1_789_430_400,
    cleanBody: 'Please send the revised deployment assumptions.', rawBody: '<p>Please send the revised deployment assumptions.</p>',
  });
  const introduction = 'Hi Vinay, this is the updated deployment sizing discussed in the earlier review. We have reviewed the working assumptions and are sending the revision below for your technical team to assess. ';
  await primary.add('epfo-team-thread', {
    id: 'epfo-latest', fromAddress: 'prakash@sarv.example', fromName: 'Prakash', toAddress: 'vinay@integrator.example',
    subject: 'Re: Updated sizing', date: 1_790_294_400,
    // Legacy imported rows may mark a body present while retaining only a
    // preview in cleanBody. The answer needs content beyond that preview.
    cleanBody: introduction.slice(0, 180), rawBody: `<p>${introduction}</p><p>${TEAM_DETAIL}</p>`, hasBody: true,
  });
  await primary.add('epfo-team-thread', {
    id: 'epfo-draft', folderId: 'f-drafts', tags: '|INBOX.Drafts|', fromAddress: 'prakash@sarv.example',
    subject: 'Re: EPFO unapproved draft', date: 1_792_022_400,
    cleanBody: 'UNAPPROVED DRAFT: quote INR 99999999.', rawBody: '<p>UNAPPROVED DRAFT: quote INR 99999999.</p>',
  });
  await primary.add('epfo-team-thread', {
    id: 'epfo-trash', folderId: 'f-trash', tags: '|Trash|', fromAddress: 'prakash@sarv.example',
    subject: 'Re: EPFO deleted offer', date: 1_792_022_401,
    cleanBody: 'DELETED OFFER: quote INR 88888888.', rawBody: '<p>DELETED OFFER: quote INR 88888888.</p>',
  });
  await primary.add('unrelated-tender-thread', {
    id: 'unrelated-latest', fromAddress: 'prakash@sarv.example', fromName: 'Prakash', toAddress: ACCOUNTS[0]!.email,
    subject: 'New ministry tender checklist', date: 1_792_022_400,
    cleanBody: 'UNRELATED CUSTOMER: a ministry tender checklist is ready.', rawBody: '<p>UNRELATED CUSTOMER: a ministry tender checklist is ready.</p>',
  });
  // Same message ID in another account must still resolve to that account's
  // attachment and provenance, rather than the technical reply above.
  await secondary.add('epfo-price-thread', {
    id: 'epfo-latest', fromAddress: 'prakash@sarv.example', fromName: 'Prakash', toAddress: ACCOUNTS[1]!.email,
    subject: 'Fwd: EPFO commercial price bid', date: 1_791_849_600,
    cleanBody: TEAM_FORWARD, rawBody: `<p>${TEAM_FORWARD}</p>`,
    hasAttachments: true, attachmentCount: 1, attachmentNames: JSON.stringify([TEAM_PRICE_FILE]),
  });
  await secondary.storage.insertAttachment({ id: 'epfo-price-attachment', emailId: 'epfo-latest', filename: TEAM_PRICE_FILE,
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', size: 500,
    filePath: '/fixture/EPFO-price-bid-final.xlsx', createdAt: 1_791_849_600 });
}

let dir: string;
let primary: TestAccount;
let secondary: TestAccount;
let saved: InboxAssistantExchange[];
let deps: InboxAssistantServiceDeps;
let service: InboxAssistantService;
let chats: Map<string, InboxAssistantChat>;
let activeChatId: string;

// Every typed question goes to the tool-using agent loop (runInboxAgent). The
// agent model is scripted below through `callAIChat`; the planner behind its
// deep_search is `callAI`. Everything between them (the service, the tools,
// retrieval over the real account databases, the fact check) is production code.

interface AnswerArgs { facts: unknown[]; message?: string }
let toolCallIds = 0;

function toolCall(name: string, args: Record<string, unknown>): AIChatResult {
  return { text: '', toolCalls: [{ id: `call-${++toolCallIds}`, name, arguments: JSON.stringify(args) }], finishReason: 'tool_calls' };
}

const answerWith = (args: AnswerArgs): AIChatResult => toolCall('answer', { ...args });

/** The agent's user message: earlier-chat context (if any) and the request. */
function agentPrompt(request: AIChatRequest): string {
  return request.messages.find(message => message.role === 'user')!.content;
}

/** The user's request as the agent received it. */
function userRequest(request: AIChatRequest): string {
  const prompt = agentPrompt(request);
  return prompt.slice(prompt.lastIndexOf('User request: ') + 'User request: '.length);
}

/** The latest tool result the agent was shown, or undefined on its first turn. */
function latestResult(request: AIChatRequest): string | undefined {
  return request.messages.filter(message => message.role === 'tool').at(-1)?.content;
}

/** Every agent turn's messages, as one text: what the provider was sent. */
function agentText(): string {
  return vi.mocked(deps.callAIChat).mock.calls.flatMap(([request]) => request.messages.map(message => message.content)).join('\n');
}

/** The excerpts a deep_search result showed, by source id. */
function shownSources(result: string): Array<{ id: string; text: string }> {
  return result.split('\n\n---\n\n').flatMap(block => {
    const id = /^Source: (S\d+)$/m.exec(block)?.[1];
    return id ? [{ id, text: block }] : [];
  });
}

/** An answer quoting each of `quotes` from the excerpt that shows it, as a grounded model would. */
function quoting(result: string, quotes: string[]): AnswerArgs {
  const shown = shownSources(result);
  return { facts: quotes.flatMap(quote => {
    const source = shown.find(item => item.text.includes(quote));
    return source ? [{ text: quote, sourceIds: [source.id], quotes: [{ sourceId: source.id, text: quote }] }] : [];
  }) };
}

/**
 * A competent agent model for a question about what mail says: one deep_search
 * (the user's request, or the self-contained `question` a model would write),
 * then an answer quoting what the search showed. Stateless, so parallel runs
 * in different chats each get their own two turns.
 */
function researcher(options: { question?: string; answer?: (result: string) => AnswerArgs } = {}) {
  return async (request: AIChatRequest): Promise<AIChatResult> => {
    const result = latestResult(request);
    if (result === undefined) return toolCall('deep_search', { question: options.question ?? userRequest(request) });
    return answerWith(options.answer ? options.answer(result) : quoting(result, [OLD_QUOTE, NEW_QUOTE]));
  };
}

/** Holds the agent's answer turn until `release`, so a test can act while a run is in flight. */
function holdAnswer(): { started: Promise<void>; release(): void } {
  const research = researcher();
  let started!: () => void;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const hold = { started: new Promise<void>(resolve => { started = resolve; }), release: () => release() };
  deps.callAIChat = vi.fn(async (request: AIChatRequest) => {
    if (latestResult(request) === undefined) return research(request);
    started();
    await gate;
    return research(request);
  });
  return hold;
}

function request(over: { requestId?: string; chatId?: string; question?: string; accountIds?: string[]; previousExchangeId?: string } = {}) {
  return { requestId: 'request-1', chatId: 'chat-main', question: QUESTION, accountIds: ACCOUNTS.map(account => account.id), ...over };
}

function readyAttachment(ref: { accountId: string; emailId: string; filename: string }): AssistantAttachmentResult {
  return { ref, status: 'ready', segments: [{ text: NEW_QUOTE, locator: { kind: 'sheet', label: 'Pricing, rows 1–8', sheet: 'Pricing', rowStart: 1, rowEnd: 8 } }], truncated: false };
}

function draftRequest(overrides: Partial<InboxAssistantDraftRequest> = {}): InboxAssistantDraftRequest {
  return { requestId: 'draft-request', chatId: 'chat-main', accountId: 'primary', ...overrides };
}

function preparedDraft(overrides: Partial<InboxAssistantDraft> = {}): InboxAssistantDraft {
  return { chatId: 'chat-main', accountId: 'primary', to: ['buyer@tcs.example'], cc: [], subject: 'TCS quotation follow-up', body: 'Please review the quotation discussed.', ...overrides };
}

function seedDraftConversation(turns = 3): InboxAssistantChat {
  const chat = chats.get('chat-main')!;
  chat.exchanges = Array.from({ length: turns }, (_, index) => ({
    id: `draft-context-${index}`, chatId: chat.id, question: index === 0 ? QUESTION : `What changed in revision ${index}?`,
    accountIds: ['primary', 'secondary'], createdAt: 1_000 + index,
    answer: { text: index === 0 ? OLD_QUOTE : NEW_QUOTE, sources: [], coverage: [], warnings: [] },
  }));
  chat.exchangeCount = turns;
  return chat;
}

async function seedQuotes(): Promise<void> {
  // Identical IDs really occur across separate IMAP accounts. They must never
  // collapse into one result or navigate to the active account accidentally.
  await primary.add('shared-thread', {
    id: 'shared-message', folderId: 'f-sent', tags: '|Sent|', fromAddress: ACCOUNTS[0]!.email,
    toAddress: 'buyer@tcs.example', subject: 'TCS quotation Q-104 revision 1', date: 1_791_000_000,
    cleanBody: OLD_QUOTE, rawBody: `<p>${OLD_QUOTE}</p>`,
  });
  await secondary.add('shared-thread', {
    id: 'shared-message', folderId: 'f-sent', tags: '|Sent|', fromAddress: ACCOUNTS[1]!.email,
    toAddress: 'buyer@tcs.example', subject: 'TCS quotation Q-104 revision 2', date: 1_791_600_000,
    // No amount is in the message body. The vertical slice only succeeds by
    // reading the actual attachment identified in this account's database.
    cleanBody: 'Please find our revised TCS quotation attached.', rawBody: '<p>Please find our revised TCS quotation attached.</p>',
    hasAttachments: true, attachmentCount: 1, attachmentNames: JSON.stringify([FILENAME]),
  });
  await secondary.storage.insertAttachment({ id: 'attachment-2', emailId: 'shared-message', filename: FILENAME, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', size: 500, filePath: '/fixture/TCS-quotation-revision-2.xlsx', createdAt: 1_791_600_000 });
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'inbox-assistant-service-'));
  primary = await openTestAccount(dir, 'primary');
  secondary = await openTestAccount(dir, 'secondary');
  saved = [];
  draftGenerator.mockReset().mockImplementation(async (chat: InboxAssistantChat, account: InboxAssistantAccount) => preparedDraft({ chatId: chat.id, accountId: account.id }));
  activeChatId = 'chat-main';
  chats = new Map([['chat-main', { id: 'chat-main', title: 'New chat', createdAt: 0, updatedAt: 0, exchangeCount: 0, exchanges: [] }]]);
  const load = (id: string, options?: { select?: boolean }) => {
    const chat = chats.get(id);
    if (!chat) throw new Error('Chat unavailable');
    if (options?.select !== false) activeChatId = id;
    return structuredClone(chat);
  };
  deps = {
    accounts: vi.fn(() => ACCOUNTS),
    openMailbox: vi.fn(async accountId => ({ storage: accountId === 'primary' ? primary.storage : secondary.storage, aliases: [] })),
    readAttachment: vi.fn(async ref => readyAttachment(ref)),
    // The one-shot prompts left with the fixed pipeline: only the deep_search planner calls this now.
    callAI: vi.fn(async prompt => {
      if (prompt.startsWith('You plan')) return PLAN;
      throw new Error('Unexpected one-shot prompt.');
    }),
    callAIChat: vi.fn(researcher()),
    history: {
      list: vi.fn(() => ({ chats: [...chats.values()].map(({ exchanges: _exchanges, ...summary }) => summary), activeChatId })),
      load: vi.fn(load),
      create: vi.fn(() => {
        const chat: InboxAssistantChat = { id: `chat-${chats.size}`, title: 'New chat', createdAt: Date.now(), updatedAt: Date.now(), exchangeCount: 0, exchanges: [] };
        chats.set(chat.id, chat); activeChatId = chat.id; return structuredClone(chat);
      }),
      rename: vi.fn((id, title) => { const chat = chats.get(id)!; chat.title = title; const { exchanges: _exchanges, ...summary } = chat; return structuredClone(summary); }),
      update: vi.fn((id, changes) => {
        const chat = chats.get(id); if (!chat) throw new Error('Chat unavailable');
        Object.assign(chat, changes); const { exchanges: _exchanges, ...summary } = chat; return structuredClone(summary);
      }),
      rewind: vi.fn(),
      restoreRewind: vi.fn(),
      delete: vi.fn(id => {
        if (!chats.has(id)) throw new Error('Chat unavailable');
        chats.delete(id); if (id === 'chat-main') saved = [];
        if (activeChatId === id) activeChatId = chats.keys().next().value ?? '';
        return { chats: [...chats.values()].map(({ exchanges: _exchanges, ...summary }) => summary), activeChatId: activeChatId || null };
      }),
      writeChat: vi.fn(chat => {
        const copy = structuredClone(chat); copy.exchangeCount = copy.exchanges.length;
        chats.set(copy.id, copy); if (copy.id === 'chat-main') saved = copy.exchanges;
      }),
      clear: vi.fn(id => {
        const chat = chats.get(id)!; chat.exchanges = []; chat.exchangeCount = 0;
        if (id === 'chat-main') saved = []; return structuredClone(chat);
      }),
      read: vi.fn(() => structuredClone(chats.get(activeChatId)!.exchanges)),
      write: vi.fn(exchanges => { const chat = chats.get(activeChatId)!; chat.exchanges = structuredClone(exchanges); if (activeChatId === 'chat-main') saved = chat.exchanges; }),
    },
  };
  service = new InboxAssistantService(deps);
});

describe('independent durable Inbox Agent runs', () => {
  // Breaks: Stop cancels the wrong chat's run, a late provider reply revives a stopped run, or usage is billed twice or to the wrong question.
  it('keeps separate questions and provider accounting across chat switches, exact Stop, and a late provider response', async () => {
    await seedQuotes();
    const releases: Array<() => void> = [];
    let aiCalls = 0;
    // Agent turns and deep_search planner calls bill through the same run ledger.
    const bill = (onUsage?: (usage: InboxAssistantAIUsage) => void) => {
      const call = ++aiCalls;
      const usage: InboxAssistantAIUsage = { id: `usage-${call}`, provider: 'fixture', model: 'fixture-model', status: 'completed', startedAt: 10, completedAt: 20,
        attempts: 1, inputTokens: call * 10, outputTokens: call, tokenSource: 'provider', usageComplete: true,
        estimatedCostUsd: call / 100, costComplete: true };
      onUsage?.(usage); onUsage?.(usage); // A duplicate callback must not double bill the display.
    };
    deps.callAI = vi.fn(async (_prompt, _signal, onUsage) => {
      bill(onUsage);
      await new Promise<void>(resolve => { releases.push(resolve); });
      return PLAN;
    });
    const research = researcher();
    deps.callAIChat = vi.fn(async (chatRequest: AIChatRequest, _signal: AbortSignal, onUsage?: (usage: InboxAssistantAIUsage) => void) => {
      bill(onUsage);
      return research(chatRequest);
    });
    // Run 1: an agent turn (usage-1), then its deep_search planner (usage-2) is held.
    const first = service.ask(request());
    const stopped = expect(first).rejects.toThrow(/cancel/i);
    expect(service.chat('chat-main')).toMatchObject({ activeRun: { requestId: 'request-1', kind: 'question', status: 'running', question: QUESTION },
      exchanges: [expect.objectContaining({ question: QUESTION, status: 'running', requestId: 'request-1' })] });
    await expect(service.ask(request({ requestId: 'same-chat-overlap' }))).rejects.toThrow('still running');
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    // Run 2, in another chat: an agent turn (usage-3), its planner (usage-4) held, then the answer turn (usage-5).
    const other = service.createChat();
    const second = service.ask(request({ chatId: other.id, requestId: 'request-other' }));
    expect(service.chats().chats.filter(chat => chat.activeRun)).toHaveLength(2);
    expect(activeChatId).toBe(other.id);
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    expect(await service.cancel('request-1')).toEqual({ requestId: 'request-1', cancelled: true });
    await stopped;
    expect(service.chats().chats.find(chat => chat.id === other.id)?.activeRun?.requestId).toBe('request-other');
    releases[1]!();
    const completed = await second;
    expect(completed.status).toBe('completed');
    expect(completed.answer.text).toContain(NEW_QUOTE);
    expect(completed.usage).toMatchObject({ inputTokens: 120, outputTokens: 12, tokenCountsComplete: true, costComplete: true });
    expect(completed.usage?.estimatedCostUsd).toBeCloseTo(0.12, 10);
    expect(completed.usage?.calls.map(call => call.id)).toEqual(['usage-3', 'usage-4', 'usage-5']);
    // The stopped run's planner answers late: nothing about either chat may change.
    releases[0]!();
    await new Promise(resolve => setImmediate(resolve));
    expect(activeChatId).toBe(other.id);
    expect(chats.get('chat-main')?.exchanges).toEqual([expect.objectContaining({ status: 'stopped', answer: expect.objectContaining({ text: '' }), usage: expect.objectContaining({ inputTokens: 30, outputTokens: 3 }) })]);
    expect(chats.get('chat-main')?.runs?.[0]).toMatchObject({ status: 'stopped', usage: { calls: [expect.objectContaining({ id: 'usage-1' }), expect.objectContaining({ id: 'usage-2' })] } });
    expect(service.chats().chats.some(chat => chat.activeRun)).toBe(false);
  });

  // Breaks: a question whose provider call fails vanishes, or its work is lost from the chat it was asked in.
  it('leaves a failed question and its last observed work in its original chat', async () => {
    deps.callAIChat = vi.fn(async () => { throw new Error('Synthetic provider failure'); });
    const failed = request({ question: 'Review unread emails before October' });
    await expect(service.ask(failed)).rejects.toThrow('Synthetic provider failure');
    expect(saved).toEqual([expect.objectContaining({ requestId: failed.requestId, question: failed.question, status: 'failed', error: expect.stringContaining('Synthetic provider failure') })]);
    expect(saved[0]!.activities?.length).toBeGreaterThan(0);
    expect(chats.get('chat-main')?.runs?.[0]).toMatchObject({ status: 'failed', question: failed.question });
    expect(service.chat('chat-main').activeRun).toBeUndefined();
  });

  // Breaks: a run interrupted by a restart shows as running forever, or is silently re-run (and re-billed) on load.
  it('restores orphan running records as stopped without rerunning them or changing the selected chat', () => {
    const original = chats.get('chat-main')!;
    original.exchanges = [{ id: 'interrupted', requestId: 'lost-run', question: QUESTION, accountIds: ['primary'], createdAt: 1, status: 'running', answer: { text: '', sources: [], coverage: [], warnings: [] } }];
    original.runs = [{ requestId: 'lost-run', chatId: original.id, kind: 'question', exchangeId: 'interrupted', question: QUESTION, accountIds: ['primary'], startedAt: 1, updatedAt: 2, status: 'running', activities: [] }];
    const restarted = new InboxAssistantService(deps);
    const restored = restarted.chat(original.id);
    expect(restored).toMatchObject({ exchanges: [{ status: 'stopped', error: expect.stringContaining('restarted') }], runs: [{ status: 'stopped' }] });
    expect(restored.activeRun).toBeUndefined();
    expect(deps.callAI).not.toHaveBeenCalled();
    expect(deps.callAIChat).not.toHaveBeenCalled();
    expect(deps.openMailbox).not.toHaveBeenCalled();
    expect(chats.get(original.id)?.runs?.[0]?.status).toBe('stopped');
  });

  // Breaks: a draft in one chat blocks or is lost when another chat asks a question meanwhile.
  it('lets a draft finish in the background while another chat answers, retaining the draft in the origin run', async () => {
    seedDraftConversation();
    let finish!: (draft: InboxAssistantDraft) => void;
    draftGenerator.mockReturnValueOnce(new Promise<InboxAssistantDraft>(resolve => { finish = resolve; }));
    const pending = service.draftEmail(draftRequest());
    const other = service.createChat();
    await service.ask(request({ chatId: other.id, requestId: 'other-question' }));
    expect(service.chats().chats.find(chat => chat.id === 'chat-main')?.activeRun).toMatchObject({ kind: 'draft', requestId: 'draft-request' });
    finish(preparedDraft());
    await expect(pending).resolves.toEqual(preparedDraft());
    expect(activeChatId).toBe(other.id);
    expect(chats.get('chat-main')?.runs?.at(-1)).toMatchObject({ kind: 'draft', status: 'completed', draft: preparedDraft() });
  });
});

describe('Inbox Agent email draft orchestration', () => {
  it('drafts the entire requested chat with the explicit sender, retaining its run without selecting the chat', async () => {
    const origin = seedDraftConversation();
    const before = structuredClone(origin);
    const other = service.createChat();
    const activities: unknown[] = [];
    const result = await service.draftEmail(draftRequest({ accountId: 'secondary', instructions: '  Send a concise follow-up.  ' }), activity => activities.push(activity));
    expect(draftGenerator).toHaveBeenCalledExactlyOnceWith(before, ACCOUNTS[1], 'Send a concise follow-up.', expect.any(Function), expect.any(AbortSignal), undefined);
    expect(result).toEqual(preparedDraft({ accountId: 'secondary' }));
    expect(activeChatId).toBe(other.id);
    expect(chats.get('chat-main')?.exchanges).toEqual(before.exchanges);
    expect(chats.get('chat-main')?.runs).toEqual([expect.objectContaining({ kind: 'draft', status: 'completed', draft: preparedDraft({ accountId: 'secondary' }) })]);
    expect(deps.history.load).toHaveBeenCalledWith('chat-main', { select: false });
    expect(deps.history.writeChat).toHaveBeenCalled();
    expect(deps.history.write).not.toHaveBeenCalled();
    expect(deps.openMailbox).not.toHaveBeenCalled();
    expect(deps.readAttachment).not.toHaveBeenCalled();
    expect(activities).toEqual([
      expect.objectContaining({ stage: 'context', status: 'done', requestId: 'draft-request', chatId: 'chat-main', sequence: 1 }),
      expect.objectContaining({ stage: 'answer', status: 'running', sequence: 2 }),
      expect.objectContaining({ stage: 'complete', status: 'done', sequence: 3 }),
    ]);
  });

  it('forwards provider calls through the configured cancellation-aware callback', async () => {
    seedDraftConversation();
    vi.mocked(deps.callAI).mockResolvedValue('synthetic validated output');
    draftGenerator.mockImplementationOnce(async (_chat, _account, _instructions, callAI: (prompt: string) => Promise<string>) => {
      await callAI('Prepare this conversation draft'); return preparedDraft();
    });
    await service.draftEmail(draftRequest());
    expect(deps.callAI).toHaveBeenCalledExactlyOnceWith('Prepare this conversation draft', expect.any(AbortSignal), expect.any(Function));
  });

  it.each([null, [], {}, { ...draftRequest(), unknown: 'value' }, { ...draftRequest(), requestId: '../invalid' },
    { ...draftRequest(), chatId: '../invalid' }, { ...draftRequest(), accountId: '' },
    { ...draftRequest(), instructions: 10 }, { ...draftRequest(), instructions: 'x'.repeat(4_001) },
  ])('rejects malformed draft request %j before invoking AI', async value => {
    await expect(service.draftEmail(value)).rejects.toThrow();
    expect(draftGenerator).not.toHaveBeenCalled();
    expect(deps.callAI).not.toHaveBeenCalled();
  });

  it('rejects empty chats and unknown sender accounts', async () => {
    await expect(service.draftEmail(draftRequest())).rejects.toThrow('Ask Inbox Agent');
    seedDraftConversation();
    await expect(service.draftEmail(draftRequest({ accountId: 'removed' }))).rejects.toThrow('no longer connected');
    expect(draftGenerator).not.toHaveBeenCalled();
  });

  it('fails explicitly when any original exchange account has been removed instead of drafting a partial conversation', async () => {
    seedDraftConversation();
    vi.mocked(deps.accounts).mockReturnValue([ACCOUNTS[0]!]);
    await expect(service.draftEmail(draftRequest())).rejects.toThrow('Reconnect it before drafting the whole conversation');
    expect(draftGenerator).not.toHaveBeenCalled();
  });

  it('also requires connected ownership for every cited source account', async () => {
    const chat = seedDraftConversation(1);
    chat.exchanges[0]!.accountIds = ['primary'];
    chat.exchanges[0]!.answer.sources = [{ id: 'S1', kind: 'message', accountId: 'removed-source', accountEmail: 'removed@example.test',
      emailId: 'source-mail', subject: 'Quotation', from: 'removed@example.test', to: [], date: 1_000, folder: 'Sent', sent: true, excerpt: 'Earlier quotation.' }];
    await expect(service.draftEmail(draftRequest())).rejects.toThrow('no longer connected');
    expect(draftGenerator).not.toHaveBeenCalled();
  });

  it.each(['cancel', 'clear', 'delete'] as const)('cannot return a late draft after %s', async action => {
    seedDraftConversation();
    let finish!: (draft: InboxAssistantDraft) => void;
    draftGenerator.mockReturnValueOnce(new Promise<InboxAssistantDraft>(resolve => { finish = resolve; }));
    const pending = service.draftEmail(draftRequest());
    const rejected = expect(pending).rejects.toThrow(/cancel|abort|deleted/i);
    const writesBeforeStop = vi.mocked(deps.history.writeChat).mock.calls.length;
    if (action === 'cancel') service.cancel('draft-request');
    else if (action === 'clear') service.clearHistory();
    else service.deleteChat('chat-main');
    finish(preparedDraft());
    await rejected;
    if (action === 'cancel') expect(chats.get('chat-main')?.runs?.at(-1)).toMatchObject({ kind: 'draft', status: 'stopped' });
    else expect(deps.history.writeChat).toHaveBeenCalledTimes(writesBeforeStop);
    expect(deps.history.write).not.toHaveBeenCalled();
  });

  it('shares the running slot with questions and other drafts, then releases it after cancellation', async () => {
    seedDraftConversation();
    let finish!: (draft: InboxAssistantDraft) => void;
    draftGenerator.mockReturnValueOnce(new Promise<InboxAssistantDraft>(resolve => { finish = resolve; }));
    const pending = service.draftEmail(draftRequest());
    const rejected = expect(pending).rejects.toThrow();
    await expect(service.ask(request())).rejects.toThrow('still running');
    await expect(service.draftEmail(draftRequest({ requestId: 'another-draft' }))).rejects.toThrow('still running');
    service.cancel('draft-request'); finish(preparedDraft()); await rejected;
    await expect(service.draftEmail(draftRequest({ requestId: 'next-draft' }))).resolves.toEqual(preparedDraft());
  });

  it.each(['primary', 'secondary'])('revalidates account %s before returning a draft', async removed => {
    seedDraftConversation();
    let finish!: (draft: InboxAssistantDraft) => void;
    draftGenerator.mockReturnValueOnce(new Promise<InboxAssistantDraft>(resolve => { finish = resolve; }));
    const pending = service.draftEmail(draftRequest());
    vi.mocked(deps.accounts).mockReturnValue(ACCOUNTS.filter(account => account.id !== removed));
    finish(preparedDraft());
    await expect(pending).rejects.toThrow('no longer connected');
  });

  it('rejects changed conversation contents while allowing rename, pin and selection changes', async () => {
    seedDraftConversation();
    let finish!: (draft: InboxAssistantDraft) => void;
    draftGenerator.mockReturnValueOnce(new Promise<InboxAssistantDraft>(resolve => { finish = resolve; }));
    const pending = service.draftEmail(draftRequest());
    service.renameChat({ chatId: 'chat-main', title: 'Pricing review' });
    service.updateChat({ chatId: 'chat-main', pinned: true });
    const other = service.createChat();
    finish(preparedDraft());
    await expect(pending).resolves.toEqual(preparedDraft());
    expect(activeChatId).toBe(other.id);

    draftGenerator.mockReturnValueOnce(new Promise<InboxAssistantDraft>(resolve => { finish = resolve; }));
    const changed = service.draftEmail(draftRequest({ requestId: 'changed-draft' }));
    chats.get('chat-main')!.exchanges[0]!.id = 'replaced-turn';
    finish(preparedDraft());
    await expect(changed).rejects.toThrow('conversation changed');
  });

  it('rejects a helper result bound to a different chat or sending account', async () => {
    seedDraftConversation();
    draftGenerator.mockResolvedValueOnce(preparedDraft({ chatId: 'other-chat' }));
    await expect(service.draftEmail(draftRequest())).rejects.toThrow('did not match');
  });
});

afterEach(async () => {
  await Promise.all([primary.close(), secondary.close()]);
  await rm(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('Inbox Agent with real account databases', () => {
  // Breaks: a greeting the agent answered without reading mail becomes the
  // "topic" of the next question, so a new search is narrowed to "hello".
  it.each(['Hello', 'Help'])('keeps %s out of the next quotation research scope', async question => {
    const research = researcher();
    deps.callAIChat = vi.fn(async (chatRequest: AIChatRequest) => userRequest(chatRequest) === question
      ? answerWith({ facts: [], message: 'Ask me about your mail, for example what you sent to a customer.' }) : research(chatRequest));
    const guidance = await service.ask(request({ question }));
    expect(guidance.answer.sources).toEqual([]);
    expect(guidance.answer.coverage).toEqual([]);
    await seedQuotes();
    vi.mocked(deps.callAIChat).mockClear();
    const result = await service.ask(request({ requestId: 'after-guidance', question: 'Find the latest quotation I sent', previousExchangeId: guidance.id }));
    expect(result.answer.sourceStatus).toBe('verified');
    expect(result.answer.text).toContain(NEW_QUOTE);
    expect(result.activities?.some(item => item.stage === 'context')).toBe(false);
    expect(agentText()).not.toContain('Earlier in this chat');
  });

  // Breaks: mail that was read but supports no verified fact is presented as an answer.
  it('labels relevant originals as unverified when no grounded facts survive, rather than reporting Answer ready', async () => {
    await seedQuotes();
    deps.callAIChat = vi.fn(researcher({ answer: () => ({ facts: [] }) }));
    const result = await service.ask(request());
    expect(result.answer.sourceStatus).toBe('related');
    expect(result.answer.sources.length).toBeGreaterThan(0);
    expect(result.answer.sources.length).toBeLessThanOrEqual(6);
    expect(result.answer.text).toContain('could not verify an answer');
    expect(result.activities?.at(-1)).toMatchObject({ stage: 'complete', status: 'warning', message: 'Related emails found; answer not verified' });
    // Merely related emails are never called cited.
    expect(result.activities?.at(-1)?.detail).not.toContain('cited');
    expect(result.diagnostics?.outcome).toBe('related');
  });

  // Breaks: a broken calendar preference or a bad timezone setting stops unrelated email questions.
  it('continues email research when calendar preferences cannot be read and an optional timezone is invalid', async () => {
    await seedQuotes();
    deps.timeZone = () => 'invalid/timezone';
    deps.calendar = { preferences: vi.fn(() => { throw new Error('Calendar preferences unavailable'); }), availability: vi.fn() };
    const result = await service.ask(request());
    expect(result.answer.sourceStatus).toBe('verified');
    expect(result.answer.text).toContain(NEW_QUOTE);
    expect(deps.calendar.preferences).toHaveBeenCalledOnce();
    expect(deps.calendar.availability).not.toHaveBeenCalled();
  });

  // Breaks: "today" is read in UTC instead of the user's timezone (in the
  // search or in the excerpt's date the model reads), a failed planner leaves
  // no search at all, or the earlier quotation leaks into a new meeting question.
  it('preserves local today and a new meeting topic after a quotation, even when Gemma planning fails', async () => {
    await seedQuotes();
    const first = await service.ask(request());
    const invitationBody = 'You are invited to our project review. Please join the meeting using the link below.';
    await primary.add('local-day-invite', { id: 'local-day-invite', subject: 'Invitation: Project review meeting',
      fromAddress: 'organizer@partner.example', date: Date.parse('2026-10-22T18:45:00Z') / 1000,
      cleanBody: invitationBody, rawBody: `<p>${invitationBody}</p>` });
    await primary.add('yesterday-invite', { id: 'yesterday-invite', subject: 'Invitation: Earlier project review meeting',
      fromAddress: 'organizer@partner.example', date: Date.parse('2026-10-22T18:00:00Z') / 1000,
      cleanBody: invitationBody, rawBody: `<p>${invitationBody}</p>` });
    await primary.add('pricing-after-meeting', { id: 'pricing-after-meeting', subject: 'Re: Commercial pricing escalation',
      fromAddress: 'customer@partner.example', date: Date.parse('2026-10-23T04:00:00Z') / 1000,
      cleanBody: 'Following up after our meeting. Please send written pricing for the channels.',
      rawBody: '<p>Following up after our meeting. Please send written pricing for the channels.</p>' });
    deps.now = () => Date.parse('2026-10-23T10:00:00Z');
    deps.timeZone = () => 'Asia/Kolkata';
    deps.callAI = vi.fn(async () => { throw new Error('Synthetic malformed Gemma planning response'); });
    let searched = '';
    deps.callAIChat = vi.fn(researcher({ answer: result => {
      searched = result;
      const source = shownSources(result).find(item => item.text.includes(invitationBody));
      return { facts: source ? [{ text: 'A project review invitation was received today.', sourceIds: [source.id],
        quotes: [{ sourceId: source.id, text: 'Subject: Invitation: Project review meeting' }, { sourceId: source.id, text: invitationBody }] }] : [] };
    } }));
    const result = await service.ask(request({ requestId: 'meeting-followup', question: 'is any meetings invite today', previousExchangeId: first.id }));
    expect(result.answer.sourceStatus).toBe('verified');
    expect(result.answer.sources.map(source => source.emailId)).toEqual(['local-day-invite']);
    expect(result.answer.text).toContain('received today');
    expect(result.answer.sources[0]).not.toHaveProperty('dateTimeZone');
    // What deep_search showed the agent: today's invitation (local day), nothing from yesterday or the quotation.
    expect(shownSources(searched)).toHaveLength(1);
    expect(searched).toContain('Local date/time (Asia/Kolkata): 2026-10-23T00:15:00+05:30');
    expect(searched).not.toContain('Earlier project review meeting');
    expect(searched).not.toContain('TCS quotation');
    expect(searched).not.toContain('Commercial pricing escalation');
    const system = vi.mocked(deps.callAIChat).mock.calls.at(-1)![0].messages[0]!.content;
    expect(system).toContain('Today is 2026-10-23 (Asia/Kolkata)');
    expect(result.activities?.at(-1)).toMatchObject({ status: 'done', message: 'Answer verified against sources' });
    expect(vi.mocked(deps.callAI).mock.calls[0]![3]).toEqual({ maxOutputTokens: 1_600 });
  });

  // Breaks: "mark these unread" changes mail before the user approves it,
  // misses a match in another account (same message id) or in Sent, changes
  // other emails of the same thread or an unsent draft; Undo does not put the
  // flags back.
  // KNOWN GAP (reported, not pinned): the retired mark-read command also matched
  // a term found only in the raw body (cleanBody a short preview); the agent's
  // search_mail does not, so the other account's match is named in its subject here.
  it('marks BigBlueButton mail unread across real account databases, including Sent, only after approval and without changing other members', async () => {
    const readTags = '|INBOX|read|';
    await primary.add('mixed-bbb', { id: 'shared-bbb', tags: readTags, fromAddress: 'updates@bigbluebutton.example', subject: 'BigBlueButton release' });
    await primary.add('mixed-bbb', { id: 'unrelated-sibling', tags: readTags, subject: 'Other supplier update' });
    await secondary.add('mixed-bbb', { id: 'shared-bbb', tags: readTags, subject: 'BigBlueButton deployment update' });
    await primary.add('sent-bbb', { id: 'sent-bbb', tags: '|Sent|read|', folderId: 'f-sent', subject: 'BigBlueButton follow-up' });
    await primary.add('unread-bbb', { id: 'unread-bbb', tags: '|INBOX|', subject: 'BigBlueButton unread notice' });
    await primary.add('draft-bbb', { id: 'draft-bbb', tags: '|INBOX.Drafts|read|', folderId: 'f-drafts', subject: 'BigBlueButton unsent draft' });
    const queue = { bulkMarkAsRead: vi.fn(async () => 'queued' as const), bulkMarkAsUnread: vi.fn(async () => 'queued' as const) };
    const unused = vi.fn(async () => { throw new Error('Not part of this request.'); });
    const setRead = vi.fn(async (accountId: string, ids: string[], read: boolean) => changeAssistantReadFlags({
      storage: accountId === 'primary' ? primary.storage : secondary.storage, engine: queue, assertCurrent: async () => {},
    }, ids, read));
    deps.mailActions = { setRead, setStarred: unused, move: unused, restore: unused, setCategory: unused, setLabel: unused,
      createLabel: unused, dropLabel: unused, setSnooze: unused, spamVerdict: unused, revertSpamVerdict: unused };
    let staged = '';
    let searchedRows = '';
    deps.callAIChat = vi.fn(async (chatRequest: AIChatRequest) => {
      const result = latestResult(chatRequest);
      if (result === undefined) return toolCall('search_mail', { text: 'BigBlueButton', limit: 20 });
      if (!result.includes('Change set')) {
        // The emails the search showed, as the model would pass them on.
        return toolCall('change_mail', { action: 'mark_unread', ids: [...result.matchAll(/^(S\d+) \|/gm)].map(match => match[1]) });
      }
      staged = result;
      searchedRows = chatRequest.messages.filter(message => message.role === 'tool')[0]!.content;
      return answerWith({ facts: [], message: 'I prepared the BigBlueButton emails to mark as unread; they wait for your approval.' });
    });
    const result = await service.ask(request({ question: 'mark all bigbluebutton email unread' }));
    expect(searchedRows).not.toContain('unsent draft');
    expect(staged).toContain('NOT applied');
    expect(setRead).not.toHaveBeenCalled();
    const [set] = result.changeSets!;
    expect(set).toMatchObject({ action: 'mark_unread', status: 'pending' });
    const targets = set!.items.filter(item => item.status === 'pending').map(item => [item.accountId, item.emailId]);
    expect(targets).toEqual(expect.arrayContaining([['primary', 'shared-bbb'], ['secondary', 'shared-bbb'], ['primary', 'sent-bbb']]));
    expect(targets).toHaveLength(3);
    expect(staged).toContain('1 left out: already unread.');
    const decision = { requestId: 'bbb-action', chatId: 'chat-main', exchangeId: result.id, changeSetId: set!.id };
    await service.decideChangeSet({ ...decision, decision: 'approve' });
    expect((await primary.storage.getEmail('shared-bbb'))!.tags).not.toContain('|read|');
    expect((await secondary.storage.getEmail('shared-bbb'))!.tags).not.toContain('|read|');
    expect((await primary.storage.getEmail('sent-bbb'))!.tags).not.toContain('|read|');
    expect((await primary.storage.getEmail('unrelated-sibling'))!.tags).toContain('|read|');
    expect((await primary.storage.getEmail('draft-bbb'))!.tags).toContain('|read|');
    await service.decideChangeSet({ ...decision, requestId: 'bbb-undo', decision: 'undo' });
    expect((await primary.storage.getEmail('shared-bbb'))!.tags).toContain('|read|');
    expect((await secondary.storage.getEmail('shared-bbb'))!.tags).toContain('|read|');
    expect((await primary.storage.getEmail('unread-bbb'))!.tags).not.toContain('|read|');
  });

  // Breaks: pinning a chat loads its whole history or pays for AI.
  it('updates chat pin metadata without loading messages or calling AI', () => {
    expect(service.updateChat({ chatId: 'chat-main', pinned: true })).toMatchObject({ id: 'chat-main', pinned: true });
    expect(service.updateChat({ chatId: 'chat-main', pinned: false })).toMatchObject({ pinned: false });
    expect(deps.history.load).not.toHaveBeenCalled();
    expect(deps.callAI).not.toHaveBeenCalled();
    expect(deps.callAIChat).not.toHaveBeenCalled();
    expect(service.chats().chats).toHaveLength(1);
  });

  // Breaks: a malformed or extra setting is written to the conversation store.
  it.each([null, [], {}, { chatId: 'chat-main' }, { chatId: 'chat-main', pinned: 'yes' },
    { chatId: 'chat-main', archived: true }, { chatId: 'chat-main', pinned: true, title: 'Unrequested rename' },
    { chatId: '../invalid', pinned: true }, { chatId: 'chat-main', pinned: undefined },
    { chatId: 'chat-main', pinned: true, archived: null },
  ])('rejects invalid chat metadata update %j', value => {
    expect(() => service.updateChat(value)).toThrow('conversation setting');
    expect(deps.history.update).not.toHaveBeenCalled();
  });

  // Breaks: pinning a chat that no longer exists recreates it.
  it('rejects metadata updates for unknown chats', () => {
    expect(() => service.updateChat({ chatId: 'missing-chat', pinned: true })).toThrow('unavailable');
  });

  // Breaks: deleting one chat removes another, or a malformed id reaches the store.
  it('deletes only the requested chat and rejects invalid deletion requests', () => {
    const other = service.createChat();
    expect(service.deleteChat('chat-main')).toMatchObject({ activeChatId: other.id, chats: [expect.objectContaining({ id: other.id })] });
    expect(chats.has(other.id)).toBe(true);
    expect(() => service.deleteChat('../invalid')).toThrow('Invalid');
    expect(() => service.deleteChat({ chatId: other.id })).toThrow('Invalid');
    expect(() => service.deleteChat('missing-chat')).toThrow('unavailable');
  });

  // Breaks: an agent answer arriving after its chat was deleted brings the deleted conversation back.
  it('cancels a deleted chat run so its late answer cannot recreate the conversation', async () => {
    await seedQuotes();
    const hold = holdAnswer();
    const pending = service.ask(request());
    const rejected = expect(pending).rejects.toThrow('deleted');
    await hold.started;
    const other = service.createChat();
    service.deleteChat('chat-main');
    const writesBeforeLateAnswer = vi.mocked(deps.history.writeChat).mock.calls.length;
    hold.release();
    await rejected;
    expect(chats.has('chat-main')).toBe(false);
    expect(chats.get(other.id)?.exchanges).toEqual([]);
    expect(deps.history.writeChat).toHaveBeenCalledTimes(writesBeforeLateAnswer);
  });

  // Breaks: listing chats loads every conversation's messages.
  it('lists named chats without loading their messages and loads only a requested chat', () => {
    const created = service.createChat();
    expect(service.chats().chats).toHaveLength(2);
    expect(deps.history.load).not.toHaveBeenCalled();
    expect(service.chat(created.id)).toMatchObject({ id: created.id, title: 'New chat', exchanges: [] });
    expect(deps.history.load).toHaveBeenCalledExactlyOnceWith(created.id);
    expect(service.renameChat({ chatId: created.id, title: 'TCS pricing' })).toMatchObject({ title: 'TCS pricing' });
  });

  // Breaks: a question for a missing chat, or a follow-up pointing into another chat, reaches the provider.
  it('rejects unknown chats and cross-chat previous messages before starting AI research', async () => {
    await expect(service.ask(request({ chatId: 'missing-chat' }))).rejects.toThrow('unavailable');
    expect(deps.callAI).not.toHaveBeenCalled();
    expect(deps.callAIChat).not.toHaveBeenCalled();
    await seedQuotes();
    const first = await service.ask(request());
    const secondChat = service.createChat();
    vi.mocked(deps.callAI).mockClear();
    vi.mocked(deps.callAIChat).mockClear();
    await expect(service.ask(request({ chatId: secondChat.id, previousExchangeId: first.id }))).rejects.toThrow('does not belong');
    expect(deps.callAI).not.toHaveBeenCalled();
    expect(deps.callAIChat).not.toHaveBeenCalled();
    expect(service.chat('chat-main').exchanges).toHaveLength(1);
    expect(service.chat(secondChat.id).exchanges).toEqual([]);
  });

  // Breaks: an answer that finishes after the user switched chats lands in the
  // chat now on screen, or is lost when that other chat is cleared.
  it('persists a late completion into its original chat after switching, renaming and clearing another chat', async () => {
    await seedQuotes();
    const hold = holdAnswer();
    const pending = service.ask(request());
    await hold.started;
    const other = service.createChat();
    service.renameChat({ chatId: 'chat-main', title: 'Original TCS discussion' });
    service.clearHistory();
    hold.release();
    const completed = await pending;
    expect(completed.chatId).toBe('chat-main');
    expect(completed.answer.text).toContain(NEW_QUOTE);
    expect(completed.activities?.every(activity => activity.chatId === 'chat-main')).toBe(true);
    expect(service.chats().activeChatId).toBe(other.id);
    expect(chats.get('chat-main')).toMatchObject({ title: 'Original TCS discussion', exchangeCount: 1 });
    expect(chats.get('chat-main')?.exchanges[0]?.id).toBe(completed.id);
    expect(chats.get(other.id)?.exchanges).toEqual([]);
  });

  // Breaks: a question in a new empty chat is answered with another chat's conversation as context.
  it('does not use another chat as follow-up memory after a new empty chat is selected', async () => {
    await seedQuotes();
    await service.ask(request());
    const other = service.createChat();
    vi.mocked(deps.callAIChat).mockClear();
    const answer = await service.ask(request({ chatId: other.id, requestId: 'new-chat-question', question: 'What quotation did I send to TCS?' }));
    expect(vi.mocked(deps.callAIChat).mock.calls.every(([chatRequest]) => !agentPrompt(chatRequest).includes('Earlier in this chat'))).toBe(true);
    expect(answer.chatId).toBe(other.id);
    expect(chats.get('chat-main')?.exchanges).toHaveLength(1);
    expect(chats.get(other.id)?.exchanges).toHaveLength(1);
  });

  // Breaks: identical message ids in two accounts collapse into one source, a
  // link opens the wrong account's email, or an attachment-only figure is missed.
  it('answers from Sent-only mail and an attachment across accounts with colliding message IDs', async () => {
    await seedQuotes();
    const beforePrimary = await primary.storage.getEmail('shared-message');
    const getPrimary = vi.spyOn(primary.storage, 'getEmail');
    const getSecondary = vi.spyOn(secondary.storage, 'getEmail');
    const result = await service.ask(request());
    expect(result.answer.text).toContain(OLD_QUOTE);
    expect(result.answer.text).toContain(NEW_QUOTE);
    expect(getPrimary).toHaveBeenCalledWith('shared-message');
    expect(getSecondary).toHaveBeenCalledWith('shared-message');
    expect(result.answer.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({ accountId: 'primary', emailId: 'shared-message', sent: true, folder: 'Sent', kind: 'message' }),
      expect.objectContaining({ accountId: 'secondary', emailId: 'shared-message', sent: true, folder: 'Sent', kind: 'attachment', attachmentId: 'attachment-2', filename: FILENAME, location: 'Pricing, rows 1–8' }),
    ]));
    expect(new Set(result.answer.sources.map(source => source.id)).size).toBe(2);
    expect(deps.readAttachment).toHaveBeenCalledWith({ accountId: 'secondary', emailId: 'shared-message', filename: FILENAME }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(result.answer.coverage).toEqual(expect.arrayContaining([
      expect.objectContaining({ accountId: 'primary', status: 'searched', reviewedMessages: 1 }),
      expect.objectContaining({ accountId: 'secondary', status: 'searched', reviewedMessages: 1, attachmentsRead: 1 }),
    ]));
    expect(saved).toEqual([result]);
    expect(result.answer.sources.every(source => !('text' in source))).toBe(true);
    expect(await primary.storage.getEmail('shared-message')).toEqual(beforePrimary);
  });

  // Breaks: an account the user deselected is still searched, or its mail is shown.
  it('honors explicit account scope and never reads the unselected account or attachment', async () => {
    await seedQuotes();
    const result = await service.ask(request({ accountIds: ['primary'] }));
    expect(result.answer.text).toContain(OLD_QUOTE);
    expect(result.answer.text).not.toContain(NEW_QUOTE);
    expect(deps.openMailbox).toHaveBeenCalledExactlyOnceWith('primary');
    expect(deps.readAttachment).not.toHaveBeenCalled();
    expect(agentText()).not.toContain(ACCOUNTS[1]!.email);
    expect(result.answer.sources.every(source => source.accountId === 'primary')).toBe(true);
    expect(result.answer.coverage.map(account => account.accountId)).toEqual(['primary']);
  });

  // Breaks: the progress the user watches is out of order, lost on reload, or
  // the answer is padded with routine coverage boilerplate.
  it('reports observable work in order, saves it with the answer and omits routine coverage boilerplate', async () => {
    await seedQuotes();
    const progress = vi.fn();
    const result = await service.ask(request(), progress);
    const activities = progress.mock.calls.map(([activity]) => activity);
    expect(activities.length).toBeGreaterThanOrEqual(3);
    expect(activities.map(activity => activity.sequence)).toEqual(activities.map((_activity, index) => index + 1));
    expect(activities.every(activity => activity.requestId === 'request-1' && Number.isFinite(activity.at))).toBe(true);
    expect(activities[0]).toMatchObject({ stage: 'search', status: 'running' });
    expect(activities.at(-1)).toMatchObject({ stage: 'complete', status: 'done', message: 'Answer verified against sources' });
    expect(result.activities).toEqual(activities);
    expect(saved[0]?.activities).toEqual(activities);
    expect(result.answer.warnings.join(' ')).not.toContain('Trash, Spam and unsent drafts are excluded');
    expect(result.answer.text).not.toMatch(/limited to|limited coverage|thinking/i);
  });

  // Breaks: a Sent email whose body was never downloaded is skipped, or a
  // Trash copy, an unsent draft or a received lookalike is quoted as "what I sent".
  it('hydrates missing sent bodies and excludes Trash, drafts and received lookalikes', async () => {
    await primary.add('hydrated-thread', { id: 'hydrated-quote', subject: 'TCS quotation needing download', folderId: 'f-sent', tags: '|Sent|', fromAddress: ACCOUNTS[0]!.email, cleanBody: '', rawBody: '' });
    for (const [id, folderId, tags, fromAddress] of [
      ['trash-quote', 'f-trash', '|Trash|', ACCOUNTS[0]!.email],
      ['draft-quote', 'f-drafts', '|INBOX.Drafts|draft|', ACCOUNTS[0]!.email],
      ['inbound-quote', 'f-inbox', '|INBOX|', 'buyer@tcs.example'],
    ]) await primary.add(id!, { id: id!, subject: 'TCS quotation unrelated', folderId, tags, fromAddress, cleanBody: 'Unsent or received TCS quote INR 999,999.' });
    const fetchBody = vi.fn(async (email: EmailRecord) => ({ ...email, cleanBody: OLD_QUOTE, rawBody: `<p>${OLD_QUOTE}</p>` }));
    deps.openMailbox = vi.fn(async () => ({ storage: primary.storage, aliases: [], fetchBody }));
    const result = await service.ask(request({ accountIds: ['primary'] }));
    expect(fetchBody).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: 'hydrated-quote' }), expect.objectContaining({ path: 'Sent' }), expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(result.answer.text).toContain(OLD_QUOTE);
    expect(agentText()).not.toContain('999,999');
    expect(result.answer.sources.map(source => source.emailId)).toEqual(['hydrated-quote']);
    expect(result.answer.coverage[0]).toMatchObject({ reviewedMessages: 1, missingBodies: 0 });
  });

  // Breaks: a locked account or an unreadable attachment is silently treated
  // as searched, or its contents are invented.
  it('reports unavailable accounts and unreadable attachments without inventing their details', async () => {
    await seedQuotes();
    deps.openMailbox = vi.fn(async accountId => {
      if (accountId === 'primary') throw new Error('Fixture account locked');
      return { storage: secondary.storage, aliases: [] };
    });
    deps.readAttachment = vi.fn(async (ref): Promise<AssistantAttachmentResult> => ({ ref, status: 'password_protected', segments: [], truncated: false, message: 'This attachment is password protected' }));
    const result = await service.ask(request());
    expect(result.answer.text).not.toContain('90,000');
    expect(result.answer.text).toContain('could not verify an answer');
    expect(result.answer.coverage).toEqual([
      expect.objectContaining({ accountId: 'primary', status: 'unavailable' }),
      expect.objectContaining({ accountId: 'secondary', status: 'searched', attachmentsRead: 0, attachmentsSkipped: 1 }),
    ]);
    expect(result.answer.warnings.join(' ')).toContain('Unavailable accounts');
    expect(result.answer.warnings.join(' ')).toContain('password protected');
    expect(result.answer.sources.every(source => source.accountId === 'secondary' && source.kind === 'message')).toBe(true);
  });

  // Breaks: a question naming a disconnected account opens mailboxes or pays for AI first.
  it('rejects unknown account IDs before opening any mailbox or calling AI', async () => {
    await expect(service.ask(request({ accountIds: ['primary', 'not-connected'] }))).rejects.toThrow('no longer connected');
    expect(deps.openMailbox).not.toHaveBeenCalled();
    expect(deps.callAI).not.toHaveBeenCalled();
    expect(deps.callAIChat).not.toHaveBeenCalled();
    expect(deps.history.writeChat).not.toHaveBeenCalled();
  });

  // Breaks: after Stop or Clear, the agent's late answer is still saved or
  // still reported, or the chat cannot ask again.
  it.each(['cancel', 'clear'] as const)('cannot persist a late answer after %s', async action => {
    await seedQuotes();
    const hold = holdAnswer();
    const progress = vi.fn();
    const pending = service.ask(request(), progress);
    const failed = expect(pending).rejects.toThrow(/cancelled|aborted/i);
    await hold.started;
    if (action === 'clear') service.clearHistory();
    else service.cancel('request-1');
    const eventsBeforeLateAnswer = progress.mock.calls.length;
    const writesBeforeLateAnswer = vi.mocked(deps.history.writeChat).mock.calls.length;
    hold.release();
    await failed;
    expect(progress).toHaveBeenCalledTimes(eventsBeforeLateAnswer);
    if (action === 'cancel') {
      expect(saved).toEqual([expect.objectContaining({ question: QUESTION, status: 'stopped', answer: expect.objectContaining({ text: '' }) })]);
      expect(chats.get('chat-main')?.runs?.at(-1)).toMatchObject({ status: 'stopped' });
    } else {
      expect(saved).toEqual([]);
      expect(deps.history.writeChat).toHaveBeenCalledTimes(writesBeforeLateAnswer);
    }
    expect(deps.history.clear).toHaveBeenCalledTimes(action === 'clear' ? 1 : 0);
    deps.callAIChat = vi.fn(researcher());
    const next = await service.ask(request({ requestId: 'request-2', accountIds: ['primary'] }));
    expect(next.answer.text).toContain(OLD_QUOTE);
  });

  // Breaks: a follow-up loses what "it" refers to, or narrowing the accounts
  // still shows the agent the excluded account's earlier answer or address.
  it('retains follow-up topic across scope changes without exposing excluded account answers or sources', async () => {
    await seedQuotes();
    const first = await service.ask(request());
    vi.mocked(deps.callAIChat).mockClear();
    await service.ask(request({ requestId: 'follow-up', question: 'What changed in the revised quote?', previousExchangeId: first.id }));
    expect(vi.mocked(deps.callAIChat).mock.calls.every(([chatRequest]) => agentPrompt(chatRequest).includes('Earlier in this chat'))).toBe(true);
    expect(agentPrompt(vi.mocked(deps.callAIChat).mock.calls[0]![0])).toContain(QUESTION);
    vi.mocked(deps.callAIChat).mockClear();
    vi.mocked(deps.callAI).mockClear();
    await service.ask(request({ requestId: 'scoped-question', question: 'Who received it?', accountIds: ['primary'], previousExchangeId: first.id }));
    const prompts = vi.mocked(deps.callAIChat).mock.calls.map(([chatRequest]) => agentPrompt(chatRequest));
    expect(prompts.every(prompt => prompt.includes('Earlier in this chat'))).toBe(true);
    expect(prompts[0]).toContain(QUESTION);
    const sent = [agentText(), ...vi.mocked(deps.callAI).mock.calls.map(([prompt]) => prompt)].join(' ');
    expect(sent).not.toContain(NEW_QUOTE);
    expect(sent).not.toContain(ACCOUNTS[1]!.email);
  });

  // Breaks: a restart loses the earlier turns a vague follow-up depends on, or
  // the follow-up is answered from the earlier answer text instead of the mail.
  // A vague follow-up also reopens the earlier answer's sources and keeps its
  // topic (protected in the evaluation: followup-* at the floor); this test
  // covers a model that spells its question out.
  it('retains multiple earlier turns after recreating the service, and the self-contained follow-up search reaches the original sources', async () => {
    await seedQuotes();
    const first = await service.ask(request());
    const secondQuestion = 'Which was the latest revision?';
    const second = await service.ask(request({ requestId: 'second-turn', question: secondQuestion, previousExchangeId: first.id }));
    // The store is durable; a fresh service must reconstruct context rather
    // than depend on renderer state or a provider's temporary chat session.
    const restarted = new InboxAssistantService(deps);
    vi.mocked(deps.callAI).mockClear();
    deps.callAIChat = vi.fn(researcher({ question: 'How long was the TCS quotation Q-104 valid?' }));
    const getPrimary = vi.spyOn(primary.storage, 'getEmail');
    const getSecondary = vi.spyOn(secondary.storage, 'getEmail');
    const third = await restarted.ask(request({ requestId: 'third-turn', question: 'How long was it valid?', previousExchangeId: second.id }));
    const prompt = agentPrompt(vi.mocked(deps.callAIChat).mock.calls[0]![0]);
    expect(prompt).toContain(QUESTION);
    expect(prompt).toContain(secondQuestion);
    expect(getPrimary).toHaveBeenCalledWith('shared-message');
    expect(getSecondary).toHaveBeenCalledWith('shared-message');
    expect(third.answer.text).toContain(NEW_QUOTE);
    expect(third.answer.sources).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'attachment', filename: FILENAME, accountId: 'secondary' })]));
    expect(third.activities).toEqual(expect.arrayContaining([expect.objectContaining({ stage: 'context', status: 'done' })]));
  });

  // Breaks: "my team sent it, find what Prakash submitted" drops the customer
  // and finds an unrelated Prakash email, reads only a body preview, misses the
  // thread's attachment in another account, or quotes a draft or Trash.
  // The earlier customer (EPFO), participant and intent carry into the
  // follow-up's plan, so a planner that answers only "Prakash, latest
  // submission" still finds the EPFO thread.
  it('keeps a corrective team follow-up on the customer and joins full thread bodies with qualified attachment evidence', async () => {
    await seedTeamProposal();
    const extracted = await extractAssistantAttachment({ filename: TEAM_PRICE_FILE, bytes: teamPriceWorkbook() });
    expect(extracted.status).toBe('ready');
    const total = extracted.segments.find(segment => segment.text.includes('2750000'))!;
    const qualification = extracted.segments.find(segment => segment.text.includes('dummy evaluation quantities'))!;
    expect(total.locator).toMatchObject({ sheet: 'Cost Summary', cellRange: 'A17:B17' });
    vi.mocked(deps.readAttachment).mockImplementation(async ref => ({ ...extracted, ref }));
    const prompts: string[] = [];
    let planned = 0;
    vi.mocked(deps.callAI).mockImplementation(async prompt => {
      prompts.push(prompt);
      if (planned++ === 0) return JSON.stringify({ queries: ['EPFO'], entityTerms: ['EPFO'], intent: 'sent', quoteIntent: true, filters: {} });
      // A forgetful plan for the follow-up: the customer comes from the chat.
      return JSON.stringify({ queries: ['Prakash', 'latest submission'], entityTerms: ['Prakash'], intent: 'all', quoteIntent: true, filters: {} });
    });
    const quotes = [TEAM_COORDINATION, TEAM_DETAIL, TEAM_FORWARD, total.text, qualification.text];
    let searched = '';
    deps.callAIChat = vi.fn(researcher({ answer: result => { searched = result; return quoting(result, quotes); } }));
    const first = await service.ask(request({ question: 'Check about EPFO final proposal I personally sent.' }));
    expect(first.answer.text).toContain(TEAM_COORDINATION);
    expect(first.answer.sources).toEqual([expect.objectContaining({ emailId: 'epfo-coordination', accountId: 'primary', sent: true })]);
    prompts.length = 0;
    const beforePrimary = await primary.storage.getEmail('epfo-latest');
    const beforeSecondary = await secondary.storage.getEmail('epfo-latest');
    const expand = vi.spyOn(primary.storage, 'getEmailsByThread');
    vi.mocked(deps.callAIChat).mockClear();
    deps.callAIChat = vi.fn(researcher({ question: 'What did Prakash from my team last submit for the EPFO final proposal?',
      answer: result => { searched = result; return quoting(result, quotes); } }));
    const followUp = await new InboxAssistantService(deps).ask(request({
      requestId: 'team-follow-up', question: 'this is send by my team members so find what Prakash submit last', previousExchangeId: first.id,
    }));

    expect(agentPrompt(vi.mocked(deps.callAIChat).mock.calls[0]![0])).toContain('Check about EPFO final proposal I personally sent.');
    expect(prompts[0]).toContain('EPFO');
    expect(expand).toHaveBeenCalledWith('epfo-team-thread');
    expect(searched).toContain(TEAM_DETAIL);
    expect(searched).not.toContain('UNRELATED CUSTOMER');
    expect(searched).not.toContain('UNAPPROVED DRAFT');
    expect(searched).not.toContain('DELETED OFFER');
    expect(followUp.answer.text).toContain(TEAM_DETAIL);
    expect(followUp.answer.text).toContain(TEAM_FORWARD);
    expect(followUp.answer.text).toContain('2750000');
    expect(followUp.answer.text).toContain('dummy evaluation quantities');
    expect(followUp.answer.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({ accountId: 'primary', emailId: 'epfo-latest', threadId: 'epfo-team-thread',
        from: 'prakash@sarv.example', sent: false, kind: 'message', excerpt: expect.stringContaining('30 concurrent sessions') }),
      expect.objectContaining({ accountId: 'secondary', emailId: 'epfo-latest', threadId: 'epfo-price-thread',
        kind: 'attachment', filename: TEAM_PRICE_FILE, attachmentId: 'epfo-price-attachment', location: 'Cost Summary!A17:B17', sent: false }),
    ]));
    expect(followUp.answer.sources.every(source => !['epfo-draft', 'epfo-trash', 'unrelated-latest'].includes(source.emailId))).toBe(true);
    expect(deps.readAttachment).toHaveBeenCalledWith({ accountId: 'secondary', emailId: 'epfo-latest', filename: TEAM_PRICE_FILE },
      expect.objectContaining({ allowSecurityPrompt: true, signal: expect.any(AbortSignal) }));
    expect(followUp.answer.warnings.join(' ')).toMatch(/formulas were not recalculated/i);
    expect(await primary.storage.getEmail('epfo-latest')).toEqual(beforePrimary);
    expect(await secondary.storage.getEmail('epfo-latest')).toEqual(beforeSecondary);
  });

  // Breaks: "what did I personally send" shows the agent team members' submissions or another account's mail.
  it('keeps explicit personal Sent and account scope when customer threads also contain team submissions', async () => {
    await seedTeamProposal();
    vi.mocked(deps.callAI).mockImplementation(async () => JSON.stringify({
      queries: ['EPFO'], entityTerms: ['EPFO'], topicTerms: ['EPFO'], intent: 'sent', quoteIntent: true, filters: {},
    }));
    let searched = '';
    deps.callAIChat = vi.fn(researcher({ answer: result => { searched = result; return quoting(result, [TEAM_COORDINATION]); } }));
    const result = await service.ask(request({ question: 'What EPFO proposal did I personally send?', accountIds: ['primary'] }));
    expect(result.answer.text).toContain(TEAM_COORDINATION);
    expect(deps.openMailbox).toHaveBeenCalledExactlyOnceWith('primary');
    expect(deps.readAttachment).not.toHaveBeenCalled();
    expect(searched).not.toContain(TEAM_DETAIL);
    expect(searched).not.toContain(TEAM_FORWARD);
    expect(searched).not.toContain('2750000');
    expect(result.answer.sources).toEqual([expect.objectContaining({ accountId: 'primary', emailId: 'epfo-coordination', sent: true })]);
  });

  // Breaks: "what we sent" (the team, not only me) is narrowed to my own Sent folder and misses the team's submission.
  it.each(['Find EPFO proposal details in both sent and received mail.', 'check aabout epfo final propsal we send'])('includes personal Sent and team conversations for collective research: %s', async question => {
    await seedTeamProposal();
    vi.mocked(deps.callAI).mockImplementation(async () => JSON.stringify({ queries: ['EPFO'], entityTerms: ['EPFO'], intent: 'sent', quoteIntent: true, filters: {} }));
    deps.callAIChat = vi.fn(researcher({ answer: result => quoting(result, [TEAM_COORDINATION, TEAM_DETAIL]) }));
    const result = await service.ask(request({ question, accountIds: ['primary'] }));
    expect(result.answer.text).toContain(TEAM_COORDINATION);
    expect(result.answer.text).toContain(TEAM_DETAIL);
    expect(result.answer.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({ emailId: 'epfo-coordination', sent: true }),
      expect.objectContaining({ emailId: 'epfo-latest', sent: false }),
    ]));
  });
});
