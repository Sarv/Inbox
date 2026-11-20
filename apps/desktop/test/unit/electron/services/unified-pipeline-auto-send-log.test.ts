import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { getLogLevel, setLogLevel, setLogSink, type AgentDecision } from '@sarvinbox/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// What breaks if this file fails: the auto-send gate's "drafter signaled
// fallback" line writes the drafter's reasoning to app.log (info, kept in a
// release). The reasoning is the model's account of the email being answered
// whenever it wrote it; the line now carries a fixed label. Or the gate stops
// holding a salvage body back from SMTP. Real account database, the real
// pipeline with auto-reply on; the LLM is a fake behind the provider's fetch,
// and the Drafts save and the SMTP send are observed, not performed.

const h = vi.hoisted(() => ({
  active: null as unknown,
  /** getStorage() answers from here first (one per call), then `active`. */
  storageQueue: [] as unknown[],
  ids: new Map<unknown, string>(),
  mainWindow: null as unknown,
  llmCalls: 0,
  /** Runs inside each fake LLM call — the window in which the world can change. */
  onLlmCall: null as null | ((call: number) => void | Promise<void>),
  saves: [] as Array<{ draft: Record<string, unknown>; messageId: string | undefined }>,
  /** Runs inside the Drafts save, after the local row would exist. */
  onSave: null as null | ((messageId: string | undefined) => void | Promise<void>),
  saveResult: { success: true } as Record<string, unknown>,
  saveError: null as Error | null,
  nextDraftId: '<Agent-Draft-1@Host.Test>',
  /** The drafter's answer (the second LLM call of each draft). */
  draftAnswer: '',
  /** What getSmtpClient() answers: null (not connected) unless a test connects it. */
  smtp: null as unknown,
}));

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }));
vi.mock('../../../../electron/shared', () => ({
  getStorage: () => (h.storageQueue.length > 0 ? h.storageQueue.shift() : h.active),
  getAllAccountRuntimes: () => [],
  getAccountRuntime: () => undefined,
  getSyncEngine: () => null,
  getSyncEngineForStorage: () => null,
  getAccountIdForStorage: (storage: unknown) => h.ids.get(storage) ?? null,
  getMainWindow: () => h.mainWindow,
  getSmtpClient: () => h.smtp,
  findStorageForEmail: () => null,
}));
vi.mock('../../../../electron/ipc/agent-handlers', () => ({ logUserAction: vi.fn() }));
// The Drafts save, observed: the caller's own Message-ID comes in through the
// options argument and goes back out on success, as the real one does.
vi.mock('../../../../electron/ipc/draft-handlers', () => ({
  newDraftMessageId: vi.fn(() => h.nextDraftId),
  saveDraftToIMAP: vi.fn(async (draft: Record<string, unknown>, options?: { messageId?: string }) => {
    h.saves.push({ draft, messageId: options?.messageId });
    if (h.onSave) await h.onSave(options?.messageId);
    if (h.saveError) throw h.saveError;
    return h.saveResult.success ? { ...h.saveResult, messageId: options?.messageId } : h.saveResult;
  }),
}));
vi.mock('../../../../electron/ipc/smtp-handlers', () => ({ sendEmailFromMain: vi.fn(), appendSentCopy: vi.fn() }));
vi.mock('../../../../electron/services/accounts-registry', () => ({
  resolveAccountEmail: () => 'me@me.test',
  resolveAccountIdentity: () => ({ email: 'me@me.test', name: 'Me', aliases: ['me@me.test'] }),
}));
vi.mock('../../../../electron/services/agent-config-store', () => ({ loadAgentConfig: vi.fn(async () => null) }));
vi.mock('../../../../electron/services/ai-backlog-cap', () => ({ getAutoBacklogCap: () => 500 }));
vi.mock('../../../../electron/services/core-db', () => ({ getMeta: () => null, setMeta: vi.fn() }));
vi.mock('../../../../electron/services/gmail-label-api', () => ({
  ensureGmailLabelColor: vi.fn(), renameGmailLabel: vi.fn(), deleteGmailLabelsUnder: vi.fn(),
}));
// The provider's fetch: every LLM call of the drafter lands here.
vi.mock('../../../../electron/services/net-fetch', () => ({
  chromiumFetch: vi.fn(async () => {
    h.llmCalls += 1;
    if (h.onLlmCall) await h.onLlmCall(h.llmCalls);
    const content = h.llmCalls % 2 === 1
      ? JSON.stringify({ needs_search: false, email_searches: [], web_searches: [], ready_to_draft: true })
      : h.draftAnswer;
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
  }),
}));
vi.mock('../../../../electron/services/notification-service', () => ({ notifyNewMail: vi.fn() }));
vi.mock('../../../../electron/services/oauth-service', () => ({ attachOAuthBearer: vi.fn(), getValidAccessToken: vi.fn() }));
vi.mock('../../../../electron/services/oauth-token-store', () => ({ getAccount: vi.fn(), listAccounts: vi.fn(() => []) }));
vi.mock('../../../../electron/services/pipeline-ai-config-store', () => ({
  savePipelineAIConfig: vi.fn(), loadPipelineAIConfigSync: vi.fn(() => null), clearPipelineAIConfig: vi.fn(),
}));

import { captureLogs, type CapturedLogs } from '../../../../../../packages/core/src/test-support/log-capture';
import { sendEmailFromMain } from '../../../../electron/ipc/smtp-handlers';
import {
  autoDraftReply,
  drafterFallbackLabel,
  initializeUnifiedPipeline,
  setPipelineUserProfile,
  stopUnifiedPipeline,
  updatePipelineAIConfig,
} from '../../../../electron/services/unified-pipeline-service';
import { openTestAccount, type TestAccount } from '../../../helpers/account-storage';

const T0 = 1_780_000_000;
const T = 'thread-budget';
const SENTINEL = 'SENTINEL-Acme-invoice-Q204';

updatePipelineAIConfig({ type: 'openai', apiKey: 'test-key', model: 'test-model', baseUrl: 'http://llm.test/v1' } as never);
setPipelineUserProfile({ userEmail: 'me@me.test', userName: 'Me' });

let dir = '';
let account: TestAccount;
let logs: CapturedLogs;

beforeEach(async () => {
  // The pipeline's poll and backfill intervals must not run against a closed
  // database after the test; they are faked and cleared on stop.
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  dir = mkdtempSync(join(tmpdir(), 'auto-send-log-'));
  account = await openTestAccount(dir, 'active');
  h.active = account.storage;
  h.storageQueue = [];
  h.ids = new Map<unknown, string>([[account.storage, 'acct-active']]);
  h.llmCalls = 0;
  h.onLlmCall = null;
  h.saves = [];
  h.onSave = null;
  h.saveResult = { success: true };
  h.saveError = null;
  h.smtp = null;
  vi.mocked(sendEmailFromMain).mockReset();
  initializeUnifiedPipeline({ autoReply: true, autoActThreshold: 0.5, userEmail: 'me@me.test' } as never);
  logs = captureLogs({ setLogSink, setLogLevel, getLogLevel });
});

afterEach(async () => {
  logs.stop();
  stopUnifiedPipeline();
  vi.clearAllTimers();
  vi.useRealTimers();
  await account.close();
  rmSync(dir, { recursive: true, force: true });
});

/** A reply-worthy email from a known sender, addressed to the user, with its pending reply decision. */
async function replyWorthy(id: string): Promise<void> {
  await account.add(T, {
    id, date: T0, subject: 'Budget', fromAddress: 'boss@company.test', fromName: 'Boss', toAddress: 'me@me.test',
    rawBody: '<p>Me, can you approve the budget?</p>', cleanBody: 'Me, can you approve the budget?',
  });
  await account.storage.getRepositories().agent.saveDecision({
    id: `dec-${id}`, emailId: id, threadId: T, senderAddress: 'boss@company.test', proposedAction: 'reply',
    proposedValue: null, confidence: 0.9, reasoning: '', status: 'pending', actualAction: null,
    userFeedback: null, proposedAt: T0, resolvedAt: null, createdAt: T0,
  } as AgentDecision);
}

describe('tryAutoSendReply — the drafter-fallback gate, as logged', () => {
  // Breaks: 'drafter signaled fallback ("<reasoning>")' quotes the model's
  // reasoning; or a reply whose reasoning marks a skipped draft is SENT.
  it('holds a skipped draft back from SMTP and logs a fixed label', async () => {
    await replyWorthy('e1');
    h.draftAnswer = JSON.stringify({ subject: 'Re: Budget', body: 'Approved.', suggestedCc: [], reasoning: `Draft skipped: ${SENTINEL} needs a human` });

    await autoDraftReply('e1', account.storage);

    expect(sendEmailFromMain).not.toHaveBeenCalled();
    expect(h.saves).toHaveLength(1);
    expect(logs.containing(SENTINEL)).toEqual([]);
    expect(logs.containing('Auto-send skipped for e1 — drafter signaled fallback (skipped)')).toHaveLength(1);
  });

  // Breaks: an answer the drafter could not parse (its prose becomes the body)
  // is sent, or its fixed reasoning is replaced by the prose in the log.
  it('holds a parse-failed draft back and logs it as parse-failed', async () => {
    await replyWorthy('e2');
    h.draftAnswer = `Sure — about ${SENTINEL}, the budget is approved.`;

    await autoDraftReply('e2', account.storage);

    expect(sendEmailFromMain).not.toHaveBeenCalled();
    expect(h.saves).toHaveLength(1);
    expect(logs.containing(SENTINEL)).toEqual([]);
    expect(logs.containing('Auto-send skipped for e2 — drafter signaled fallback (parse-failed)')).toHaveLength(1);
  });
});

describe('tryAutoSendReply — an ordinary draft', () => {
  // Breaks: splitting the gate's regex into drafterFallbackLabel made an
  // ordinary reasoning read as a fallback, so no reply is auto-sent any more
  // (it parks in Drafts instead); or the send line quotes the reasoning.
  it('sends a draft whose reasoning is not a fallback, and logs no reasoning', async () => {
    await replyWorthy('e3');
    h.smtp = { isConnected: () => true };
    vi.mocked(sendEmailFromMain).mockResolvedValue({ success: true, messageId: '<sent-1@me.test>' } as never);
    h.draftAnswer = JSON.stringify({ subject: 'Re: Budget', body: 'Approved.', suggestedCc: [], reasoning: `Direct ask about ${SENTINEL}` });

    await autoDraftReply('e3', account.storage);

    expect(sendEmailFromMain).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendEmailFromMain).mock.calls[0]![0]).toMatchObject({ to: ['boss@company.test'], body: expect.stringContaining('Approved.') });
    expect(h.saves).toEqual([]);
    expect(logs.containing(SENTINEL)).toEqual([]);
    expect(logs.containing('drafter signaled fallback')).toEqual([]);
    expect(logs.containing('Auto-SENT reply for e3')).toHaveLength(1);
  });
});

describe('drafterFallbackLabel', () => {
  // Breaks: the gate stops recognising either fallback ReplyDrafter writes, or
  // starts flagging an ordinary reasoning as one.
  it('labels the two drafter fallbacks and nothing else', () => {
    expect(drafterFallbackLabel('Direct draft (JSON parse failed)')).toBe('parse-failed');
    expect(drafterFallbackLabel('Draft skipped — unparseable JSON-shaped response')).toBe('skipped');
    expect(drafterFallbackLabel('draft SKIPPED by the model')).toBe('skipped');
    expect(drafterFallbackLabel(`direct ask about ${SENTINEL}`)).toBeNull();
    expect(drafterFallbackLabel('')).toBeNull();
  });
});
