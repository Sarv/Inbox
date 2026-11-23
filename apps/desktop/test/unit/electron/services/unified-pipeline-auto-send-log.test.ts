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
  getUnifiedPipeline,
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

/** A reply-worthy email (from a known sender unless `over` says otherwise), addressed to the user, with its pending reply decision. */
async function replyWorthy(
  id: string,
  over: { fromAddress?: string; confidence?: number; proposedAction?: 'reply' | 'reply_all'; toAddress?: string; ccAddress?: string } = {},
): Promise<void> {
  const fromAddress = over.fromAddress ?? 'boss@company.test';
  await account.add(T, {
    id, date: T0, subject: 'Budget', fromAddress, fromName: 'Boss', toAddress: over.toAddress ?? 'me@me.test',
    ...(over.ccAddress ? { ccAddress: over.ccAddress } : {}),
    rawBody: '<p>Me, can you approve the budget?</p>', cleanBody: 'Me, can you approve the budget?',
  });
  await account.storage.getRepositories().agent.saveDecision({
    id: `dec-${id}`, emailId: id, threadId: T, senderAddress: fromAddress, proposedAction: over.proposedAction ?? 'reply',
    proposedValue: null, confidence: over.confidence ?? 0.9, reasoning: '', status: 'pending', actualAction: null,
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

// What breaks if this block fails: the auto-draft and auto-send lines write
// the sender's address (or, for a malformed From, their display name, which the
// release log's address redaction cannot see) to app.log — info and warn, both
// kept in a release. Each line now carries the email id and what was decided;
// the mail itself is unchanged: skipped, held, sent or parked as before.
describe('auto-draft and auto-send — the sender stays out of the log', () => {
  /** Lowercase: the pipeline lowercases the address before it reaches a line. */
  const SENDER = 'sentinel-sender';
  const goodDraft = () => JSON.stringify({ subject: 'Re: Budget', body: 'Approved.', suggestedCc: [], reasoning: 'Direct ask' });

  // Breaks: 'malformed sender address "<display name>"' quotes the sender's name.
  it('skips a malformed sender by the shape of the address, not its text', async () => {
    await replyWorthy('m1', { fromAddress: `"${SENDER} Display Name` });

    await autoDraftReply('m1', account.storage);

    expect(h.llmCalls).toBe(0);
    expect(logs.containing(SENDER)).toEqual([]);
    expect(logs.containing('Skip auto-draft for m1 — malformed sender address (length 29, has @: false)')).toHaveLength(1);
  });

  // Breaks: 'no two-way history with automated-looking sender <address>'.
  it('skips an automated-looking cold sender without naming it', async () => {
    await replyWorthy('m2', { fromAddress: `noreply.${SENDER}@mailer.example` });

    await autoDraftReply('m2', account.storage);

    expect(h.llmCalls).toBe(0);
    expect(logs.containing(SENDER)).toEqual([]);
    expect(logs.containing('Skip auto-draft for m2 — no two-way history with an automated-looking sender')).toHaveLength(1);
  });

  // Breaks: 'cold sender (<address>) with only 0.6 confidence'.
  it('skips a cold sender at low confidence without naming it', async () => {
    await replyWorthy('m3', { fromAddress: `${SENDER}@company.example`, confidence: 0.6 });

    await autoDraftReply('m3', account.storage);

    expect(h.llmCalls).toBe(0);
    expect(logs.containing(SENDER)).toEqual([]);
    expect(logs.containing('Skip auto-draft for m3 — cold sender (no reply or send history) with only 0.6 confidence')).toHaveLength(1);
  });

  // Breaks: 'sender <address> matches neverAutoReplyTo' — the address, and that
  // the user listed it.
  it('holds a sender on neverAutoReplyTo back without naming it or the entry', async () => {
    await replyWorthy('m4', { fromAddress: `${SENDER}@blocked.example` });
    getUnifiedPipeline()!.updateConfig({ neverAutoReplyTo: ['blocked.example'] });
    h.draftAnswer = goodDraft();

    await autoDraftReply('m4', account.storage);

    expect(sendEmailFromMain).not.toHaveBeenCalled();
    expect(h.saves).toHaveLength(1);
    expect(logs.containing(SENDER)).toEqual([]);
    expect(logs.containing('blocked.example')).toEqual([]);
    expect(logs.containing('Auto-send skipped for m4 — sender matches neverAutoReplyTo')).toHaveLength(1);
  });

  // Breaks: test mode's 'would send reply for … (to=<address>, …)'.
  it('logs what test mode would send without the recipient', async () => {
    await replyWorthy('m5', { fromAddress: `${SENDER}@company.example` });
    getUnifiedPipeline()!.updateConfig({ testMode: true });
    h.draftAnswer = goodDraft();

    await autoDraftReply('m5', account.storage);

    expect(sendEmailFromMain).not.toHaveBeenCalled();
    expect(logs.containing(SENDER)).toEqual([]);
    expect(logs.containing('[test mode] would send reply for m5 (confidence=0.9) — saving to Drafts instead')).toHaveLength(1);
  });

  // Breaks: 'Auto-send FAILED for … (<the SMTP error>)' — a 550 reply quoting
  // the recipient, or the invalid-recipient check listing it. The draft still
  // falls back to Drafts.
  it('logs a failed auto-send by its kind, not the server reply', async () => {
    await replyWorthy('m6', { fromAddress: `${SENDER}@company.example` });
    h.smtp = { isConnected: () => true };
    vi.mocked(sendEmailFromMain).mockResolvedValue({
      success: false, transient: false, failure: 'EENVELOPE',
      error: `Can't send mail - all recipients were rejected: 550 5.1.1 <${SENDER}@company.example>: Recipient address rejected`,
    } as never);
    h.draftAnswer = goodDraft();

    await autoDraftReply('m6', account.storage);

    expect(sendEmailFromMain).toHaveBeenCalledTimes(1);
    expect(h.saves).toHaveLength(1);
    expect(logs.containing(SENDER)).toEqual([]);
    expect(logs.containing('Auto-send FAILED for m6 (EENVELOPE, transient=false) — falling back to Drafts')).toHaveLength(1);
  });

  // Breaks: a failure result with no kind (an older send path) logs nothing
  // useful, or falls back to quoting its text.
  it('logs a failed auto-send with no kind as unknown', async () => {
    await replyWorthy('m7', { fromAddress: `${SENDER}@company.example` });
    h.smtp = { isConnected: () => true };
    vi.mocked(sendEmailFromMain).mockResolvedValue({ success: false, transient: true, error: `Invalid recipient address(es): ${SENDER}` } as never);
    h.draftAnswer = goodDraft();

    await autoDraftReply('m7', account.storage);

    expect(logs.containing(SENDER)).toEqual([]);
    expect(logs.containing('Auto-send FAILED for m7 (unknown, transient=true) — falling back to Drafts')).toHaveLength(1);
  });

  // Breaks: 'Auto-SENT reply for … to <address>'.
  it('logs a sent auto-reply by its recipient count, not the recipient', async () => {
    await replyWorthy('m8', { fromAddress: `${SENDER}@company.example` });
    h.smtp = { isConnected: () => true };
    vi.mocked(sendEmailFromMain).mockResolvedValue({ success: true, messageId: '<sent-8@me.test>' } as never);
    h.draftAnswer = goodDraft();

    await autoDraftReply('m8', account.storage);

    expect(vi.mocked(sendEmailFromMain).mock.calls[0]![0]).toMatchObject({ to: [`${SENDER}@company.example`] });
    expect(logs.containing(SENDER)).toEqual([]);
    expect(logs.containing('Auto-SENT reply for m8 (1 to) messageId=<sent-8@me.test>')).toHaveLength(1);
  });

  // Breaks: the reply-all branch of the same line prints the Cc list (the
  // original To/Cc correspondents) instead of its count.
  it('logs a sent reply-all by its Cc count, not the Cc addresses', async () => {
    await replyWorthy('m9', {
      fromAddress: `${SENDER}@company.example`, proposedAction: 'reply_all',
      toAddress: `me@me.test, ${SENDER}-to@company.example`, ccAddress: `${SENDER}-cc@partner.example`,
    });
    h.smtp = { isConnected: () => true };
    vi.mocked(sendEmailFromMain).mockResolvedValue({ success: true, messageId: '<sent-9@me.test>' } as never);
    h.draftAnswer = goodDraft();

    await autoDraftReply('m9', account.storage);

    expect(vi.mocked(sendEmailFromMain).mock.calls[0]![0]).toMatchObject({
      to: [`${SENDER}@company.example`],
      cc: [`${SENDER}-to@company.example`.toLowerCase(), `${SENDER}-cc@partner.example`.toLowerCase()],
    });
    expect(logs.containing(SENDER)).toEqual([]);
    expect(logs.containing(SENDER.toLowerCase())).toEqual([]);
    expect(logs.containing('Auto-SENT reply for m9 (1 to, 2 cc) messageId=<sent-9@me.test>')).toHaveLength(1);
  });
});

describe('autoDraftReply — failures, as logged', () => {
  // Breaks: "IMAP draft save error for <id>:" logged the whole error, whose
  // message quotes the server's APPEND answer (the Drafts folder's name, the
  // draft text) — the error's kind is all that may reach app.log.
  it('logs a Drafts save that throws by its kind and code, never its text', async () => {
    await replyWorthy('e4');
    h.draftAnswer = JSON.stringify({ subject: 'Re: Budget', body: 'Approved.', suggestedCc: [], reasoning: 'Direct ask' });
    h.saveError = Object.assign(new Error(`APPEND "Clients/${SENTINEL}" refused: ${SENTINEL}`), { code: 'EAPPEND' });

    await autoDraftReply('e4', account.storage);

    expect(logs.containing(SENTINEL)).toEqual([]);
    const line = logs.containing('IMAP draft save error for e4:');
    expect(line).toHaveLength(1);
    expect(line[0]).toContain("code: 'EAPPEND'");
  });

  // Breaks: a failed save's returned error text (which can carry the
  // encryption library's message) is written after our own words.
  it('logs a refused Drafts save by the words before its detail only', async () => {
    await replyWorthy('e5');
    h.draftAnswer = JSON.stringify({ subject: 'Re: Budget', body: 'Approved.', suggestedCc: [], reasoning: 'Direct ask' });
    h.saveResult = { success: false, error: `The draft could not be encrypted, so it was not saved: key for ${SENTINEL} expired` };

    await autoDraftReply('e5', account.storage);

    expect(logs.containing(SENTINEL)).toEqual([]);
    expect(logs.containing('IMAP draft save failed for e5: The draft could not be encrypted, so it was not saved')).toHaveLength(1);
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
