import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AgentDecision } from '@sarvinbox/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// What breaks if this file fails: the auto-drafter writing a reply where it
// must not — over a draft the user is already writing, into a thread that has
// moved on, or for an account whose mailbox and SMTP identity it does not
// hold — and Pipeline 1 stalling every multi-email thread for five seconds.
// Real account databases; the LLM is a fake behind the provider's fetch, and
// the Drafts save is observed, not performed.

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
  getSmtpClient: () => null,
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
      : JSON.stringify({ subject: 'Re: Budget', body: 'Thanks — approved.', suggestedCc: [], reasoning: 'direct ask' });
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
  }),
}));
vi.mock('../../../../electron/services/notification-service', () => ({ notifyNewMail: vi.fn() }));
vi.mock('../../../../electron/services/oauth-service', () => ({ attachOAuthBearer: vi.fn(), getValidAccessToken: vi.fn() }));
vi.mock('../../../../electron/services/oauth-token-store', () => ({ getAccount: vi.fn(), listAccounts: vi.fn(() => []) }));
vi.mock('../../../../electron/services/pipeline-ai-config-store', () => ({
  savePipelineAIConfig: vi.fn(), loadPipelineAIConfigSync: vi.fn(() => null), clearPipelineAIConfig: vi.fn(),
}));

import { sendEmailFromMain } from '../../../../electron/ipc/smtp-handlers';
import {
  SYSTEM_DISMISSAL_FEEDBACK,
  USER_HAS_DRAFT_FEEDBACK,
  autoDraftReply,
  autoDraftSkipReason,
  runPipeline1,
  setPipelineUserProfile,
  updatePipelineAIConfig,
} from '../../../../electron/services/unified-pipeline-service';
import { openTestAccount, type TestAccount } from '../../../helpers/account-storage';

const T0 = 1_780_000_000;
const T = 'thread-budget';

updatePipelineAIConfig({ type: 'openai', apiKey: 'test-key', model: 'test-model', baseUrl: 'http://llm.test/v1' } as never);
setPipelineUserProfile({ userEmail: 'me@me.test', userName: 'Me' });

let dir = '';
let account: TestAccount;
let other: TestAccount;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'auto-draft-gates-'));
  account = await openTestAccount(dir, 'active');
  other = await openTestAccount(dir, 'background');
  h.active = account.storage;
  h.storageQueue = [];
  h.ids = new Map<unknown, string>([[account.storage, 'acct-active'], [other.storage, 'acct-background']]);
  h.mainWindow = null;
  h.llmCalls = 0;
  h.onLlmCall = null;
  h.saves = [];
  h.onSave = null;
  h.saveResult = { success: true };
  h.saveError = null;
  vi.mocked(sendEmailFromMain).mockClear();
});

afterEach(async () => {
  await account.close();
  await other.close();
  rmSync(dir, { recursive: true, force: true });
});

/** A reply-worthy email from a known sender, addressed to the user, with its pending reply decision. */
async function replyWorthy(acct: TestAccount, id: string, date: number): Promise<void> {
  await acct.add(T, {
    id, date, subject: 'Budget', fromAddress: 'boss@company.test', fromName: 'Boss', toAddress: 'me@me.test',
    rawBody: '<p>Me, can you approve the budget?</p>', cleanBody: 'Me, can you approve the budget?',
  });
  await acct.storage.getRepositories().agent.saveDecision({
    id: `dec-${id}`, emailId: id, threadId: T, senderAddress: 'boss@company.test', proposedAction: 'reply',
    proposedValue: null, confidence: 0.9, reasoning: '', status: 'pending', actualAction: null,
    userFeedback: null, proposedAt: T0, resolvedAt: null, createdAt: T0,
  } as AgentDecision);
}

const decisionRow = (acct: TestAccount, id: string) =>
  (acct.storage as unknown as { db: { prepare: (sql: string) => { get: (...a: unknown[]) => unknown } } }).db
    .prepare('SELECT status, user_feedback AS feedback, draft_message_id AS draftKey, draft_body AS draftBody FROM agent_decisions WHERE id = ?')
    .get(id) as { status: string; feedback: string | null; draftKey: string | null; draftBody: string | null };

describe('autoDraftSkipReason — the thread gates, in order', () => {
  // Breaks: KNOWN GAP, deliberately explicit. Auto-draft is ACTIVE-ACCOUNT
  // ONLY: its identity, Drafts save and auto-send SMTP client all resolve the
  // active account, so drafting for a background account would write into the
  // wrong mailbox or send from the wrong address. Not a claim that skipping is
  // the right product behaviour — per-account auto-draft is a follow-up.
  it("KNOWN GAP: a non-active account's storage is skipped explicitly", async () => {
    await replyWorthy(other, 'bg1', T0);
    expect(autoDraftSkipReason(other.storage, { id: 'bg1', threadId: T })).toBe('not-active-account');
    expect(autoDraftSkipReason(null, { id: 'bg1', threadId: T })).toBe('not-active-account');

    await autoDraftReply('bg1', other.storage);
    expect(h.llmCalls).toBe(0);
    expect(h.saves).toEqual([]);
    expect(decisionRow(other, 'dec-bg1')).toMatchObject({ status: 'pending', feedback: null });
  });

  // Breaks: a draft for a mid-thread message — somebody already answered it.
  it('skips when a newer MEMBER exists; a newer Trash copy does not count', async () => {
    await replyWorthy(account, 'e1', T0);
    await account.add(T, { id: 'binned', date: T0 + 60, tags: '|Trash|', folderId: 'f-trash' });
    expect(autoDraftSkipReason(account.storage, { id: 'e1', threadId: T })).toBeNull();

    await account.add(T, { id: 'reply', date: T0 + 120 });
    expect(autoDraftSkipReason(account.storage, { id: 'e1', threadId: T })).toBe('newer-member');
  });

  // Breaks: the newer-member gate counting the user's own draft as "somebody
  // answered" — a draft is caught by the live-draft gate instead, which also
  // resolves the decision.
  it("reports a newer draft as the user's draft, not as a newer message", async () => {
    await replyWorthy(account, 'e1', T0);
    await account.add(T, { id: 'd1', date: T0 + 60, tags: '|INBOX.Drafts|draft|', folderId: 'f-drafts' });
    expect(autoDraftSkipReason(account.storage, { id: 'e1', threadId: T })).toBe('user-has-draft');
  });

  // Breaks: the gate ORDER. With both a newer member and an older user draft,
  // the email is simply not the one to answer ('newer-member': left pending,
  // the newer email's own run decides). Checking the draft first would resolve
  // this decision as rejected 'user-has-draft' instead.
  it("checks newer-member BEFORE user-has-draft: an older user draft plus a newer member is 'newer-member'", async () => {
    await account.add(T, { id: 'user-draft', date: T0 - 60, tags: '|INBOX.Drafts|draft|', folderId: 'f-drafts' });
    await replyWorthy(account, 'e1', T0);
    await account.add(T, { id: 'reply', date: T0 + 120 });
    expect(autoDraftSkipReason(account.storage, { id: 'e1', threadId: T })).toBe('newer-member');

    await autoDraftReply('e1', account.storage);
    expect(h.llmCalls).toBe(0);
    expect(decisionRow(account, 'dec-e1')).toMatchObject({ status: 'pending', feedback: null });
  });

  // Breaks: an email without a thread id (never threaded yet) can never be
  // auto-drafted — there is no thread to hold a newer message or a draft.
  it('passes an email with no thread', async () => {
    expect(autoDraftSkipReason(account.storage, { id: 'x', threadId: null })).toBeNull();
  });
});

describe('autoDraftReply', () => {
  // Breaks: nothing — the happy path every gate test compares against; and
  // the draft's Message-ID recorded, so the agent's own draft never blocks
  // the thread's next auto-draft.
  it('drafts, saves to Drafts, and records the draft Message-ID on the decision', async () => {
    await replyWorthy(account, 'e1', T0);

    await autoDraftReply('e1', account.storage);

    expect(h.llmCalls).toBe(2);
    expect(h.saves).toHaveLength(1);
    expect(h.saves[0].draft).toMatchObject({ to: 'boss@company.test', inReplyTo: '<e1@test.example>', threadId: T });
    expect(h.saves[0].messageId).toBe('<Agent-Draft-1@Host.Test>');
    expect(decisionRow(account, 'dec-e1')).toMatchObject({ status: 'auto', draftKey: 'agent-draft-1@host.test' });
    expect(account.storage.getRepositories().agent.agentDraftKeysForThread(T)).toEqual(['agent-draft-1@host.test']);
  });

  // Breaks: the Drafts save resolving "whichever account is active at SAVE
  // time" — EmailRecord rows carry no accountId, so the old
  // `email.accountId` was always undefined. The account is named explicitly.
  it('names the account captured at the gate in the Drafts save', async () => {
    await replyWorthy(account, 'e1', T0);
    await autoDraftReply('e1', account.storage);
    expect(h.saves[0].draft.accountId).toBe('acct-active');

    // On the pre-account default slot (no id yet) nothing is named; the late
    // gate has just confirmed that slot is still the active one.
    h.ids.delete(account.storage);
    await replyWorthy(account, 'e2', T0 + 600);
    await autoDraftReply('e2', account.storage);
    expect(h.saves).toHaveLength(2);
    expect(h.saves[1].draft.accountId).toBeUndefined();
  });

  // Breaks: a transient state made permanent. saveDraftToIMAP writes the local
  // draft row BEFORE its IMAP append; with the Message-ID recorded only after
  // the save returned, an auto-draft for a newer email in the thread running
  // its gates inside that window read the agent's own draft as the user's and
  // rejected that email's decision as 'user-has-draft' for good.
  it("records the draft's Message-ID BEFORE the save, so the agent's local draft row is never the user's", async () => {
    await replyWorthy(account, 'e1', T0);
    let liveDuringSave: boolean | null = null;
    h.onSave = async (messageId) => {
      // The local mirror row, as the real save writes it before the append.
      await account.add(T, { id: 'agent-local', date: T0 + 5, tags: '|INBOX.Drafts|draft|', folderId: 'f-drafts', messageId });
      liveDuringSave = account.storage.hasLiveUserDraft(T);
    };

    await autoDraftReply('e1', account.storage);

    expect(liveDuringSave).toBe(false);
    expect(account.storage.hasLiveUserDraft(T)).toBe(false);
  });

  // Breaks: auto-draft writes a reply over one the user already started —
  // the old gate only looked at the NEWEST row, so an older draft was missed.
  it("skips on an OLDER live user draft and resolves the decision as 'user-has-draft'", async () => {
    await account.add(T, { id: 'user-draft', date: T0 - 60, tags: '|INBOX.Drafts|draft|', folderId: 'f-drafts' });
    await replyWorthy(account, 'e1', T0);

    await autoDraftReply('e1', account.storage);

    expect(h.llmCalls).toBe(0);
    expect(h.saves).toEqual([]);
    expect(decisionRow(account, 'dec-e1')).toMatchObject({ status: 'rejected', feedback: USER_HAS_DRAFT_FEEDBACK });
  });

  // Breaks: the 'user-has-draft' resolution counted as the USER dismissing a
  // draft, so once the user sends their reply, the thread's next email is
  // never auto-drafted for 14 days.
  it("a later email's dismissal gate ignores the 'user-has-draft' resolution", async () => {
    expect(SYSTEM_DISMISSAL_FEEDBACK).toContain(USER_HAS_DRAFT_FEEDBACK);
    await account.add(T, { id: 'user-draft', date: T0 - 60, tags: '|INBOX.Drafts|draft|', folderId: 'f-drafts' });
    await replyWorthy(account, 'e1', T0);
    await autoDraftReply('e1', account.storage);
    expect(decisionRow(account, 'dec-e1').feedback).toBe(USER_HAS_DRAFT_FEEDBACK);

    // The user sent their draft (it is now a Sent copy); the boss answers.
    account.run("UPDATE emails SET tags = '|Sent|draft|', folder_id = 'f-sent' WHERE id = 'user-draft'");
    await replyWorthy(account, 'e2', T0 + 600);
    await autoDraftReply('e2', account.storage);

    expect(h.saves).toHaveLength(1);
    expect(decisionRow(account, 'dec-e2').status).toBe('auto');
  });

  // Breaks: a discarded draft, or the agent's own earlier draft, blocks every
  // later auto-draft in the thread.
  it("proceeds when the only draft is in Trash or is the agent's own recorded draft", async () => {
    await account.add(T, { id: 'trashed-draft', date: T0 - 60, tags: '|Trash|draft|', folderId: 'f-trash' });
    await account.add(T, {
      id: 'agent-draft', date: T0 - 30, tags: '|INBOX.Drafts|draft|', folderId: 'f-drafts', messageId: '<Old-Agent@Host>',
    });
    const agent = account.storage.getRepositories().agent;
    await agent.saveDecision({
      id: 'dec-old', emailId: 'trashed-draft', threadId: T, senderAddress: null, proposedAction: 'reply', proposedValue: null,
      confidence: 0.9, reasoning: '', status: 'auto', actualAction: null, userFeedback: null, proposedAt: T0 - 100,
      resolvedAt: null, createdAt: T0 - 100,
    } as AgentDecision);
    agent.recordDecisionDraftMessageId('dec-old', '<Old-Agent@Host>');
    await replyWorthy(account, 'e1', T0);

    await autoDraftReply('e1', account.storage);

    expect(h.saves).toHaveLength(1);
    expect(decisionRow(account, 'dec-e1').status).toBe('auto');
  });

  // Breaks: a gate that cannot be answered (an unreadable folder list) falls
  // through to drafting — doubt must resolve to "do not write a reply".
  it('skips when the thread gates cannot be checked', async () => {
    await replyWorthy(account, 'e1', T0);
    const storage = account.storage as unknown as { hasNewerMember: () => boolean };
    const real = storage.hasNewerMember;
    storage.hasNewerMember = () => { throw new Error('folders table unreadable'); };
    try {
      await autoDraftReply('e1', account.storage);
    } finally {
      storage.hasNewerMember = real;
    }
    expect(h.llmCalls).toBe(0);
    expect(decisionRow(account, 'dec-e1')).toMatchObject({ status: 'pending' });
  });

  // Breaks: a draft for a message somebody already answered (through the
  // real entry point, not just the gate function).
  it('does not draft, and leaves the decision alone, when a newer member exists', async () => {
    await replyWorthy(account, 'e1', T0);
    await account.add(T, { id: 'answer', date: T0 + 60 });
    await autoDraftReply('e1', account.storage);
    expect(h.llmCalls).toBe(0);
    expect(decisionRow(account, 'dec-e1')).toMatchObject({ status: 'pending', feedback: null });
  });

  // Breaks: widening the system-feedback exclusion swallowed the gate itself —
  // the USER's own dismissal (no feedback marker) must still stop auto-drafts.
  it("still honours the user's own recent dismissal in the thread", async () => {
    await replyWorthy(account, 'e0', T0 - 600);
    // As agent:resolveProposal records the user's own dismissal: no action, no feedback marker.
    await account.storage.getRepositories().agent.updateDecisionStatus('dec-e0', 'rejected', null, null);
    await replyWorthy(account, 'e1', T0);
    await autoDraftReply('e1', account.storage);
    expect(h.llmCalls).toBe(0);
    expect(decisionRow(account, 'dec-e1').status).toBe('pending');
  });

  // Breaks: a draft written for an email that does not exist in this
  // account, or one the pipeline never proposed a reply for.
  it('does nothing for an unknown email, or one without a pending reply decision', async () => {
    await autoDraftReply('no-such-email', account.storage);
    await account.add(T, { id: 'plain', date: T0 });
    await autoDraftReply('plain', account.storage);
    expect(h.llmCalls).toBe(0);
    expect(h.saves).toEqual([]);
  });

  // Breaks: a failed bookkeeping write loses the draft — the reply is still
  // saved; only the later gate loses the marker (the old behaviour).
  it('still saves the draft when recording its Message-ID fails', async () => {
    await replyWorthy(account, 'e1', T0);
    const agent = account.storage.getRepositories().agent as unknown as { recordDecisionDraftMessageId: () => boolean };
    const real = agent.recordDecisionDraftMessageId;
    agent.recordDecisionDraftMessageId = () => { throw new Error('database is locked'); };
    try {
      await autoDraftReply('e1', account.storage);
    } finally {
      agent.recordDecisionDraftMessageId = real;
    }
    expect(h.saves).toHaveLength(1);
    expect(decisionRow(account, 'dec-e1')).toMatchObject({ status: 'auto', draftKey: null });
  });

  // Breaks: a key recorded ahead of a save that then failed names a draft
  // that never existed; the decision keeps its body for "Needs your review".
  it('clears the recorded Message-ID when the save fails or throws', async () => {
    h.saveResult = { success: false, error: 'Drafts folder not found' };
    await replyWorthy(account, 'e1', T0);
    await autoDraftReply('e1', account.storage);
    expect(h.saves).toHaveLength(1);
    expect(decisionRow(account, 'dec-e1')).toMatchObject({ status: 'pending', draftKey: null, draftBody: 'Thanks — approved.' });

    h.saveResult = { success: true };
    h.saveError = new Error('MIME build failed');
    await autoDraftReply('e1', account.storage);
    expect(h.saves).toHaveLength(2);
    expect(decisionRow(account, 'dec-e1')).toMatchObject({ status: 'pending', draftKey: null });
  });

  // Breaks: a failing bookkeeping write around a failed save (the key could
  // not be recorded, or not cleared) turning into a crash of the pipeline.
  it('survives failing to record, or to clear, the key around a failed save', async () => {
    h.saveResult = { success: false, error: 'Drafts folder not found' };
    await replyWorthy(account, 'e1', T0);
    const agent = account.storage.getRepositories().agent as unknown as {
      recordDecisionDraftMessageId: () => boolean; clearDecisionDraftMessageId: () => boolean;
    };
    const realRecord = agent.recordDecisionDraftMessageId;
    const realClear = agent.clearDecisionDraftMessageId;
    try {
      // Not recorded: nothing to clear.
      agent.recordDecisionDraftMessageId = () => { throw new Error('database is locked'); };
      await expect(autoDraftReply('e1', account.storage)).resolves.toBeUndefined();
      expect(decisionRow(account, 'dec-e1')).toMatchObject({ status: 'pending', draftKey: null });

      // Recorded, but the clear fails: the dangling key names no row.
      agent.recordDecisionDraftMessageId = realRecord;
      agent.clearDecisionDraftMessageId = () => { throw new Error('database is locked'); };
      await expect(autoDraftReply('e1', account.storage)).resolves.toBeUndefined();
      expect(decisionRow(account, 'dec-e1')).toMatchObject({ status: 'pending', draftKey: 'agent-draft-1@host.test' });
    } finally {
      agent.recordDecisionDraftMessageId = realRecord;
      agent.clearDecisionDraftMessageId = realClear;
    }
    expect(h.saves).toHaveLength(2);
  });

  // Breaks: KNOWN LIMITATION, the conservative direction, deliberately named.
  // The draft Message-ID column arrived with v97: an agent draft saved before
  // it has no recorded key, so it reads as the USER's draft and blocks the
  // thread's auto-draft (never the reverse — a user's draft read as the
  // agent's and drafted over).
  it("KNOWN LIMITATION: an agent draft saved before v97 (no draft_message_id) counts as the user's draft", async () => {
    await account.add(T, { id: 'old-agent-draft', date: T0 - 60, tags: '|INBOX.Drafts|draft|', folderId: 'f-drafts' });
    await account.storage.getRepositories().agent.saveDecision({
      id: 'dec-pre-v97', emailId: 'old-agent-draft', threadId: T, senderAddress: null, proposedAction: 'reply',
      proposedValue: null, confidence: 0.9, reasoning: '', status: 'auto', actualAction: null,
      userFeedback: 'draft saved to Drafts folder', proposedAt: T0 - 100, resolvedAt: T0 - 100, createdAt: T0 - 100,
    } as AgentDecision);
    await replyWorthy(account, 'e1', T0);

    await autoDraftReply('e1', account.storage);

    expect(h.llmCalls).toBe(0);
    expect(decisionRow(account, 'dec-e1')).toMatchObject({ status: 'rejected', feedback: USER_HAS_DRAFT_FEEDBACK });
  });
});

describe('autoDraftReply — the gates again before the reply leaves (the LLM takes seconds)', () => {
  // Breaks: THE mid-draft account switch. The entry guard ran once; after the
  // LLM calls, the Drafts save (no account named) and auto-send's SMTP client
  // followed whichever account was active by then — account A's reply written
  // into B's Drafts with A's thread id, or sent from B's address.
  it('drops the draft — no save, no send — when the user switched account during the LLM call', async () => {
    await replyWorthy(account, 'e1', T0);
    h.onLlmCall = (call) => { if (call === 2) h.active = other.storage; };

    await autoDraftReply('e1', account.storage);

    expect(h.llmCalls).toBe(2);
    expect(h.saves).toEqual([]);
    expect(sendEmailFromMain).not.toHaveBeenCalled();
    // Left pending with its body: not the user rejecting anything.
    expect(decisionRow(account, 'dec-e1')).toMatchObject({ status: 'pending', feedback: null, draftBody: 'Thanks — approved.' });
  });

  // Breaks: the same switch landing during the auto-send attempt (a failed
  // SMTP round-trip) — the fallback Drafts save must check again.
  it('checks again before the Drafts save', async () => {
    await replyWorthy(account, 'e1', T0);
    // The switch lands after the pre-send check has read the active account.
    h.onLlmCall = (call) => {
      if (call !== 2) return;
      h.storageQueue = [account.storage];
      h.active = other.storage;
    };

    await autoDraftReply('e1', account.storage);

    expect(h.saves).toEqual([]);
    expect(decisionRow(account, 'dec-e1')).toMatchObject({ status: 'pending', feedback: null });
  });

  // Breaks: the agent writes over a reply the user started WHILE it was
  // drafting — the entry gate had passed.
  it("drops the draft and resolves the decision as 'user-has-draft' when the user started a draft meanwhile", async () => {
    await replyWorthy(account, 'e1', T0);
    h.onLlmCall = async (call) => {
      if (call === 2) await account.add(T, { id: 'late-draft', date: T0 + 30, tags: '|INBOX.Drafts|draft|', folderId: 'f-drafts' });
    };

    await autoDraftReply('e1', account.storage);

    expect(h.saves).toEqual([]);
    expect(decisionRow(account, 'dec-e1')).toMatchObject({ status: 'rejected', feedback: USER_HAS_DRAFT_FEEDBACK });
  });

  // Breaks: a failing status write after the late user-draft stop crashing
  // the pipeline (the draft is still NOT saved).
  it('still drops the draft when resolving the late user-draft stop fails', async () => {
    await replyWorthy(account, 'e1', T0);
    const agent = account.storage.getRepositories().agent as unknown as { updateDecisionStatus: () => Promise<void> };
    const real = agent.updateDecisionStatus;
    h.onLlmCall = async (call) => {
      if (call !== 2) return;
      await account.add(T, { id: 'late-draft', date: T0 + 30, tags: '|INBOX.Drafts|draft|', folderId: 'f-drafts' });
      agent.updateDecisionStatus = async () => { throw new Error('database is locked'); };
    };
    try {
      await expect(autoDraftReply('e1', account.storage)).resolves.toBeUndefined();
    } finally {
      agent.updateDecisionStatus = real;
    }
    expect(h.saves).toEqual([]);
    expect(decisionRow(account, 'dec-e1')).toMatchObject({ status: 'pending', feedback: null });
  });

  // Breaks: a draft for a message somebody answered while the LLM was busy.
  it('drops the draft, leaving the decision pending, when a newer message arrived meanwhile', async () => {
    await replyWorthy(account, 'e1', T0);
    h.onLlmCall = async (call) => {
      if (call === 2) await account.add(T, { id: 'late-reply', date: T0 + 90 });
    };

    await autoDraftReply('e1', account.storage);

    expect(h.saves).toEqual([]);
    expect(decisionRow(account, 'dec-e1')).toMatchObject({ status: 'pending', feedback: null });
  });

  // Breaks: a gate that cannot be answered after the LLM falls through to
  // saving — doubt must resolve to "do not write a reply".
  it('drops the draft when the gates cannot be checked any more', async () => {
    await replyWorthy(account, 'e1', T0);
    const storage = account.storage as unknown as { hasNewerMember: () => boolean };
    const real = storage.hasNewerMember;
    h.onLlmCall = (call) => {
      if (call === 2) storage.hasNewerMember = () => { throw new Error('database is locked'); };
    };
    try {
      await autoDraftReply('e1', account.storage);
    } finally {
      storage.hasNewerMember = real;
    }
    expect(h.saves).toEqual([]);
    expect(decisionRow(account, 'dec-e1')).toMatchObject({ status: 'pending', feedback: null });
  });
});

describe('runPipeline1 — no renderer round-trip, no wait', () => {
  afterEach(() => vi.useRealTimers());

  // Breaks: the 5-second-per-email stall (a renderer extraction request and a
  // 5x1s poll), and marking the email done in the WRONG account's database.
  it("marks extraction done on the email's own storage at once, sending nothing and leaving no timer", async () => {
    vi.useFakeTimers();
    const send = vi.fn();
    h.mainWindow = { webContents: { send } };
    await other.add(T, { id: 'bg1', date: T0 });
    await other.add(T, { id: 'bg2', date: T0 + 60 });
    const pending = () => other.storage.getRepositories().agent.getEmailsPendingExtraction(10).map((e: { id: string }) => e.id);
    expect(pending()).toContain('bg2');

    await runPipeline1('bg2', other.storage);

    expect(pending()).not.toContain('bg2');
    expect(pending()).toContain('bg1');
    expect(send).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  // Breaks: Pipeline 1 throwing (and taking Pipeline 2 with it) when an
  // account is closed or its write fails.
  it('does nothing without a storage, and survives a failing write', async () => {
    await expect(runPipeline1('x', null)).resolves.toBeUndefined();
    const broken = { getRepositories: () => ({ agent: { markExtractionDone: () => { throw new Error('disk full'); } } }) };
    await expect(runPipeline1('x', broken)).resolves.toBeUndefined();
  });
});
