import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import type { EmailRecord, FolderRecord } from '@sarvinbox/core';
import { SQLiteStorage } from '@sarvinbox/storage-node';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as fakeCoreDb from '../../../../electron/services/__testing__/fake-core-db';

/**
 * AI Assist (Settings → AI → Email Agent) is the ONE switch that lets the
 * main-process pipeline send new mail (sender, recipients, subject and the start
 * of the body) to the user's AI provider for sorting. The privacy policy tells
 * users that turning it off stops that, and Google's OAuth review checks the app
 * against the policy.
 *
 * These tests run the REAL pipeline service and the REAL agent IPC handlers
 * against two real account databases. Only the AI provider's network is
 * replaced, by a recorder, and AI Assist is toggled through the same IPC calls
 * the settings UI makes.
 *
 * What breaks if this file fails: mail keeps going to the AI provider after the
 * user turned AI Assist off (in any account, after a restart, or because the
 * stored switch could not be read), or sorting never comes back when they turn
 * it on again. Neither shows up as an error anywhere.
 */

const h = vi.hoisted(() => {
  // The storage migrations log every step at info; keep the run readable.
  process.env.SARV_LOG_LEVEL = 'warn';
  return {
    userData: '',
    handlers: new Map<string, (...args: any[]) => any>(),
    accounts: [] as Array<{ id: string; storage: any; engine?: any }>,
    /** Every request that reached the AI provider, with its full prompt text. */
    sent: [] as Array<{ url: string; prompt: string }>,
    /** A stand-in provider: records the request, answers "no categories" for each email in it. */
    provider: async (url: string, init?: RequestInit): Promise<Response> => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { messages?: Array<{ content: string }> };
      const prompt = (body.messages ?? []).map((m) => m.content).join('\n');
      h.sent.push({ url, prompt });
      const ids = [...prompt.matchAll(/\(ID: ([^)]+)\)/g)].map((m) => m[1]);
      const content = JSON.stringify(ids.map((emailId) => ({ emailId, categories: [], is_spam: false, confidence: 0.9, reasoning: 'test' })));
      return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  };
});

vi.mock('electron', () => ({
  app: { getPath: () => h.userData, getName: () => 'Sarv Inbox Test', isPackaged: false },
  ipcMain: {
    handle: (name: string, fn: (...args: any[]) => any) => { h.handlers.set(name, fn); },
    on: () => {},
    removeHandler: () => {},
  },
}));

vi.mock('../../../../electron/services/core-db', async () => await import('../../../../electron/services/__testing__/fake-core-db'));

vi.mock('../../../../electron/shared', () => {
  const byId = (id: string) => h.accounts.find((a) => a.id === id)?.storage ?? null;
  const holds = (storage: any, emailId: string) => !!storage?.db?.prepare('SELECT 1 FROM emails WHERE id = ?').get(emailId);
  return {
    getStorage: () => h.accounts[0]?.storage ?? null,
    requireStorage: () => h.accounts[0]?.storage,
    getAllAccountRuntimes: () => new Map(h.accounts.map((a) => [a.id, { storage: a.storage, syncEngine: a.engine }])),
    getAccountRuntime: (id: string) => (byId(id) ? { storage: byId(id) } : undefined),
    getStorageFor: (id: string) => byId(id),
    getCurrentAccountId: () => h.accounts[0]?.id ?? null,
    getSyncEngine: () => null,
    getSyncEngineFor: () => null,
    getSyncEngineForStorage: (storage: any) => h.accounts.find((account) => account.storage === storage)?.engine ?? null,
    getAccountIdForStorage: (s: any) => h.accounts.find((a) => a.storage === s)?.id ?? null,
    getMainWindow: () => null,
    getSmtpClient: () => null,
    findStorageForEmail: (emailId: string, hint?: string) => {
      if (hint && holds(byId(hint), emailId)) return byId(hint);
      return h.accounts.find((a) => holds(a.storage, emailId))?.storage ?? null;
    },
  };
});

// The provider is reached through chromiumFetch when the renderer hands main a
// config, and through global fetch when main restores the config from disk at
// launch. Both lead to the same recorder.
vi.mock('../../../../electron/services/net-fetch', () => ({
  chromiumFetch: (url: string, init?: RequestInit) => h.provider(url, init),
}));

// A provider IS connected in every test (main restores it from its own store at
// launch), so the only thing that can keep mail from being sent is AI Assist.
const PROVIDER = { type: 'openai', apiKey: 'test-key', model: 'test-model', baseUrl: 'https://provider.test/v1' };
vi.mock('../../../../electron/services/pipeline-ai-config-store', () => ({
  savePipelineAIConfig: vi.fn(async () => {}),
  loadPipelineAIConfigSync: () => PROVIDER,
  clearPipelineAIConfig: vi.fn(async () => {}),
}));

vi.mock('../../../../electron/ipc/draft-handlers', () => ({
  newDraftMessageId: vi.fn(() => '<draft@example.test>'),
  saveDraftToIMAP: vi.fn(),
}));
vi.mock('../../../../electron/ipc/smtp-handlers', () => ({ sendEmailFromMain: vi.fn(), appendSentCopy: vi.fn() }));
vi.mock('../../../../electron/services/accounts-registry', () => ({
  readRegistryAccounts: () => [],
  registryAccountEmail: () => 'me@example.test',
  resolveAccountEmail: () => 'me@example.test',
  resolveAccountIdentity: () => ({ email: 'me@example.test', name: 'Me' }),
}));
// account-target loads for real (the agent handlers' per-account backfill goes
// through openAccountStorages, which reads the faked shared runtimes); only its
// runtime-opening dependency is stubbed.
vi.mock('../../../../electron/services/accounts-runtime', () => ({ ensureAccountRuntime: vi.fn() }));
vi.mock('../../../../electron/services/ai-backlog-cap', () => ({ getAutoBacklogCap: () => 500 }));
vi.mock('../../../../electron/services/conversation-extraction-scheduler', () => ({ isAIProviderConfigured: () => false }));
vi.mock('../../../../electron/services/gmail-label-api', () => ({
  ensureGmailLabelColor: vi.fn(),
  renameGmailLabel: vi.fn(),
  deleteGmailLabelsUnder: vi.fn(),
}));
vi.mock('../../../../electron/services/notification-service', () => ({ notifyNewMail: vi.fn() }));
vi.mock('../../../../electron/services/oauth-service', () => ({
  attachOAuthBearer: (c: unknown) => c,
  getValidAccessToken: vi.fn(),
}));
vi.mock('../../../../electron/services/oauth-token-store', () => ({
  getAccount: vi.fn(async () => null),
  listAccounts: vi.fn(async () => []),
}));

const ME = 'me@example.test';
const MIRROR_KEY = 'agent-config';
const POLL_MS = 30_000;

type Service = typeof import('../../../../electron/services/unified-pipeline-service');
type Core = typeof import('@sarvinbox/core');

interface Session {
  svc: Service;
  core: Core;
  /** Invoke a main-process IPC handler the way the renderer does. */
  ipc: (channel: string, ...args: unknown[]) => Promise<unknown>;
}

let running: Session | null = null;
let dir = '';

function folder(now: number): FolderRecord {
  return {
    id: 'f-inbox', name: 'INBOX', path: 'INBOX', parentId: null, uidValidity: 1, lastSyncUid: null,
    lastSyncTime: null, totalCount: 0, unreadCount: 0, specialUse: '\\Inbox', subscribed: true,
    createdAt: now, updatedAt: now,
  } as FolderRecord;
}

let uid = 0;
function mail(id: string, subject: string): EmailRecord {
  const now = Math.floor(Date.now() / 1000) + uid;
  return {
    id, messageId: `<${id}@example.test>`, threadId: `thread-${id}`, folderId: 'f-inbox', uid: ++uid, tags: '|INBOX|',
    subject, fromAddress: 'sender@example.test', fromName: 'Sender', toAddress: ME, toNames: null,
    ccAddress: null, ccNames: null, bccAddress: null, bccNames: null, replyTo: null, date: now, receivedDate: now,
    cleanBody: `Private body text of ${subject}`, rawBody: `<p>Private body text of ${subject}</p>`, contentType: 'html',
    contentHash: `hash-${id}`, inReplyTo: null, references: null, priority: null, hasAttachments: false,
    attachmentCount: 0, attachmentNames: null, attachmentSizes: null, hasEmbedding: false,
    embeddingLastGenerated: null, createdAt: now, updatedAt: now,
  } as EmailRecord;
}

/** Write the main-side AI Assist mirror (what a previous session persisted). */
function seedMirror(text: string): void {
  fakeCoreDb.state.blobs.set(MIRROR_KEY, Buffer.from(text, 'utf8'));
}

/** An install that has run with AI Assist before: its one-time inbox backfill is done. */
const established = (enabled: unknown) =>
  JSON.stringify({ enabled, backfillRequeuedAccounts: h.accounts.map((a) => a.id) });

function mirror(): Record<string, unknown> {
  return JSON.parse(fakeCoreDb.state.blobs.get(MIRROR_KEY)!.toString('utf8'));
}

/**
 * Start the main process: fresh module state (a new process), the launch config
 * built exactly as main.ts builds it, and the real agent IPC handlers.
 */
async function launch(): Promise<Session> {
  vi.resetModules();
  h.handlers.clear();
  const store = await import('../../../../electron/services/agent-config-store');
  const { bootPipelineConfig } = await import('../../../../electron/services/pipeline-init-config');
  const svc = await import('../../../../electron/services/unified-pipeline-service');
  const { registerAgentHandlers } = await import('../../../../electron/ipc/agent-handlers');
  const core = await import('@sarvinbox/core');
  svc.initializeUnifiedPipeline(bootPipelineConfig(store.loadAgentConfig(), ME));
  registerAgentHandlers();
  running = {
    svc,
    core,
    ipc: async (channel, ...args) => {
      const handler = h.handlers.get(channel);
      if (!handler) throw new Error(`no IPC handler registered for ${channel}`);
      return handler({}, ...args);
    },
  };
  return running;
}

function quit(): void {
  running?.svc.stopUnifiedPipeline();
  running = null;
}

/** New mail lands in an account. `event`: the body arrives and the real-time trigger fires. `poll`: only the 30s poll will find it. */
async function deliver(s: Session, accountId: string, id: string, via: 'event' | 'poll'): Promise<string> {
  const storage = h.accounts.find((a) => a.id === accountId)!.storage;
  const subject = `Subject of ${id}`;
  await storage.insertEmail(mail(id, subject));
  if (via === 'event') {
    const email = await storage.getEmail(id);
    s.core.getEventBus().emit(s.core.createEvent.emailSynced(email, 'INBOX', true));
    s.core.getEventBus().emit(s.core.createEvent.emailBodyReady(id));
  }
  return subject;
}

async function pollTick(): Promise<void> {
  await vi.advanceTimersByTimeAsync(POLL_MS);
}

/** Yield to the real event loop until `cond` holds (the pipeline's work is all promise-driven). */
async function until(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 2000; i++) {
    if (cond()) return;
    await new Promise((r) => setImmediate(r));
  }
  throw new Error(`timed out waiting for: ${what}`);
}

function row(accountId: string, id: string): { agent_status: string; ai_categories: string | null } {
  const storage = h.accounts.find((a) => a.id === accountId)!.storage;
  return storage.db.prepare('SELECT agent_status, ai_categories FROM emails WHERE id = ?').get(id);
}

/** The pipeline has made its decision about every one of these emails. */
const decided = (mails: Array<[string, string]>) => () => mails.every(([acct, id]) => row(acct, id)?.agent_status === 'done');

const sentSubjects = () => h.sent.map((r) => r.prompt);
const wasSent = (subject: string) => sentSubjects().some((p) => p.includes(subject));

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'pipeline-ai-assist-'));
  h.userData = dir;
  h.sent.length = 0;
  fakeCoreDb.resetFakeCoreDb();
  for (const id of ['acct-a', 'acct-b']) {
    const storage = new SQLiteStorage({ dbPath: join(dir, `${id}.db`), sharedContactsPath: join(dir, 'contacts.db'), accountId: id });
    await storage.initialize();
    await storage.syncFolders([folder(Math.floor(Date.now() / 1000))]);
    h.accounts.push({ id, storage });
  }
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) => h.provider(url, init));
  // Only the pipeline's own timers are faked, so the 30s poll can be stepped;
  // setImmediate stays real for `until`.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
});

afterEach(async () => {
  quit();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  for (const a of h.accounts) await a.storage.close();
  h.accounts.length = 0;
  rmSync(dir, { recursive: true, force: true });
});

describe('AI Assist off: new mail is not sent to the AI provider', () => {
  // The settings UI sends both: agent:setConfig carries every AI Assist setting
  // (at launch and on each change), agent:setEnabled the switch alone.
  it.each([
    ['agent:setConfig', { enabled: false }],
    ['agent:setEnabled', false],
  ])('switching it off with %s stops new mail in EVERY account, by event and by poll', async (channel, arg) => {
    seedMirror(established(true));
    const s = await launch();
    await s.ipc(channel, arg);

    const mails: Array<[string, string]> = [['acct-a', 'a-event'], ['acct-b', 'b-event'], ['acct-a', 'a-poll'], ['acct-b', 'b-poll']];
    for (const [acct, id] of mails) await deliver(s, acct, id, id.endsWith('event') ? 'event' : 'poll');
    await pollTick();
    await until(decided(mails), 'the pipeline to finish with all four emails');

    // Breaks: the switch is ignored and mail content reaches the provider.
    expect(h.sent).toEqual([]);
    // Breaks: the emails are left pending, to be sent later without the user
    // turning AI Assist on (they are finalized with the local score only).
    for (const [acct, id] of mails) expect(row(acct, id).ai_categories).toBeNull();
    // Breaks: "off" is not written through, so the next launch forgets it.
    expect(mirror().enabled).toBe(false);
  });
});

describe('provider and manual classification avoids redundant AI', () => {
  // Regression: realtime events must honor provider Spam even when the polling SQL already excludes it.
  it('keeps provider Spam out of event categorization and still checks the next ordinary email', async () => {
    seedMirror(established(true));
    const s = await launch();
    const storage = h.accounts[0].storage;
    const spam = mail('provider-spam', 'Provider junk subject');
    spam.tags = '|INBOX|spam|';
    await storage.insertEmail(spam);
    s.core.getEventBus().emit(s.core.createEvent.emailSynced(spam, 'INBOX', true));
    s.core.getEventBus().emit(s.core.createEvent.emailBodyReady(spam.id));
    await deliver(s, 'acct-a', 'ordinary-after-spam', 'event');
    await until(() => wasSent('Subject of ordinary-after-spam'), 'ordinary email to be categorized');
    expect(wasSent(spam.subject || '')).toBe(false);
    expect((await storage.getEmail(spam.id)).tags).toContain('|spam|');
    expect(row('acct-a', spam.id).ai_categories).toBeNull();
  });

  // Regression: the current model's own Spam verdict must finalize, without relabeling or notifying Junk.
  it('finalizes ordinary mail newly classified as Spam by the current AI call', async () => {
    seedMirror(established(true));
    const s = await launch();
    const storage = h.accounts[0].storage;
    const done = vi.spyOn(storage.getRepositories().agent, 'markAgentDone');
    const originalProvider = h.provider;
    const provider = vi.spyOn(h, 'provider').mockImplementationOnce(async (url, init) => {
      const response = await originalProvider(url, init);
      const payload = await response.json();
      const verdict = JSON.parse(payload.choices[0].message.content);
      for (const result of verdict) result.is_spam = true;
      payload.choices[0].message.content = JSON.stringify(verdict);
      return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    try {
      await deliver(s, 'acct-a', 'new-ai-spam', 'event');
      await until(() => done.mock.calls.some(([id]) => id === 'new-ai-spam'), 'the current Spam verdict to finalize');
      expect(wasSent('Subject of new-ai-spam')).toBe(true);
      expect((await storage.getEmail('new-ai-spam')).tags).toContain('|spam|');
    } finally { provider.mockRestore(); done.mockRestore(); }
  });

  // Regression: a message moved to Spam or deleted during AI must not receive the stale verdict's finalization.
  it.each(['spam', 'missing'])('drops a late desktop verdict after an in-flight %s change', async (state) => {
    seedMirror(established(true));
    const s = await launch();
    const storage = h.accounts[0].storage;
    const done = vi.spyOn(storage.getRepositories().agent, 'markAgentDone');
    const originalProvider = h.provider;
    const provider = vi.spyOn(h, 'provider').mockImplementationOnce(async (url, init) => {
      if (state === 'spam') await storage.updateEmail('late-verdict', { tags: '|INBOX|spam|' });
      else await storage.deleteEmail('late-verdict');
      return originalProvider(url, init);
    });
    try {
      await deliver(s, 'acct-a', 'late-verdict', 'event');
      await until(() => wasSent('Subject of late-verdict'), 'the original AI request to return');
      await pollTick();
      expect(done.mock.calls.some(([id]) => id === 'late-verdict')).toBe(false);
      const current = await storage.getEmail('late-verdict');
      if (state === 'spam') {
        expect(current.tags).toContain('|spam|');
        expect(row('acct-a', 'late-verdict').ai_categories).toBeNull();
      } else expect(current).toBeNull();
    } finally { provider.mockRestore(); done.mockRestore(); }
  });

  // Regression: native Gmail Important retains its marker while the remaining email goes through AI.
  it('categorizes a Gmail Important message without stripping its native flag', async () => {
    seedMirror(established(true));
    const s = await launch();
    const storage = h.accounts[0].storage;
    const email = mail('gmail-important', 'Native important subject');
    email.gmailImportant = true; email.tags = '|INBOX|important|';
    await storage.insertEmail(email);
    s.core.getEventBus().emit(s.core.createEvent.emailSynced(email, 'INBOX', true));
    await until(decided([['acct-a', email.id]]), 'Gmail Important categorization');
    expect(wasSent(email.subject || '')).toBe(true);
    expect((await storage.getEmail(email.id)).tags).toContain('|important|');
  });

  async function put(s: Session, accountId: string, id: string, serverCategories?: string[], manualCategories?: string[], messageId?: string, gmailCategoriesPending?: boolean): Promise<void> {
    const storage = h.accounts.find((a) => a.id === accountId)!.storage;
    const email = mail(id, `Subject of ${id}`);
    email.serverCategories = serverCategories;
    email.manualCategories = manualCategories;
    email.gmailCategoriesPending = gmailCategoriesPending;
    if (messageId) email.messageId = messageId;
    email.tags = `|INBOX|starred|${(manualCategories ?? serverCategories ?? []).join('|')}${(manualCategories ?? serverCategories ?? []).length ? '|' : ''}`;
    await storage.insertEmail(email);
    s.core.getEventBus().emit(s.core.createEvent.emailSynced(email, 'INBOX', true));
  }

  // Regression: native Promotions/Important must stay categorized locally in every account without classification cost, even after restart.
  it('retains Gmail Promotions, Sarv Important and explicit unlabelled choices across restart', async () => {
    seedMirror(established(true));
    let s = await launch();
    const { notifyNewMail } = await import('../../../../electron/services/notification-service');
    vi.mocked(notifyNewMail).mockClear();
    await put(s, 'acct-a', 'gmail-native', ['promotions']);
    await put(s, 'acct-b', 'sarv-native', ['important']);
    await put(s, 'acct-b', 'user-empty', ['promotions'], []);
    await until(decided([['acct-a', 'gmail-native'], ['acct-b', 'sarv-native'], ['acct-b', 'user-empty']]), 'classified mail to finalize');
    expect(h.sent).toEqual([]);
    expect(notifyNewMail).toHaveBeenCalledWith(expect.objectContaining({ emailId: 'sarv-native', categories: ['important'] }));
    for (const [acct, id] of [['acct-a', 'gmail-native'], ['acct-b', 'sarv-native'], ['acct-b', 'user-empty']]) expect(row(acct, id).ai_categories).toBeNull();
    quit();
    s = await launch();
    await pollTick();
    expect(h.sent).toEqual([]);
    expect((await h.accounts[0].storage.getEmail('gmail-native')).serverCategories).toEqual(['promotions']);
    expect((await h.accounts[1].storage.getEmail('user-empty')).manualCategories).toEqual([]);
  });

  // Regression: INBOX/Seen/Starred and removed server classifications cannot silently suppress useful AI categorization.
  it('classifies ordinary mail and resumes after the server removes its category', async () => {
    seedMirror(established(true));
    const s = await launch();
    await put(s, 'acct-a', 'star-only', []);
    await put(s, 'acct-b', 'later-removal', ['promotions']);
    await until(decided([['acct-a', 'star-only'], ['acct-b', 'later-removal']]), 'initial processing');
    expect(wasSent('Subject of star-only')).toBe(true);
    expect(wasSent('Subject of later-removal')).toBe(false);
    h.accounts[1].storage.setServerCategories('later-removal', []);
    await pollTick();
    await until(() => wasSent('Subject of later-removal'), 'removed classification to reach AI');
    await until(decided([['acct-b', 'later-removal']]), 'removed classification to finalize');
    expect((await h.accounts[1].storage.getEmail('later-removal')).tags).not.toContain('|promotions|');
  });

  // Regression: server refresh received during an outstanding AI call must win rather than becoming a stale mirrored AI result.
  it('rechecks provider authority before saving an in-flight result', async () => {
    seedMirror(established(true));
    const s = await launch();
    const originalProvider = h.provider;
    const spy = vi.spyOn(h, 'provider').mockImplementationOnce(async (url, init) => {
      h.accounts[0].storage.setServerCategories('race', ['promotions']);
      return originalProvider(url, init);
    });
    try {
      await put(s, 'acct-a', 'race');
      await until(decided([['acct-a', 'race']]), 'in-flight classification to finalize');
      expect(row('acct-a', 'race').ai_categories).toBeNull();
      expect((await h.accounts[0].storage.getEmail('race')).tags).toContain('|promotions|');
    } finally { spy.mockRestore(); }
  });

  // Regression: linked-account AI propagation must not overwrite a provider's classification with a different account's guess.
  it('does not spread a sibling AI verdict onto provider-classified mail', async () => {
    seedMirror(established(true));
    const s = await launch();
    const messageId = '<same-message@test>';
    const source = mail('linked-source', 'AI source');
    source.messageId = messageId;
    source.tags = '|INBOX|important|';
    await h.accounts[0].storage.insertEmail(source);
    h.accounts[0].storage.db.prepare("UPDATE emails SET extraction_status = 'done', agent_status = 'done', ai_categories = '|important|' WHERE id = ?").run(source.id);
    await put(s, 'acct-b', 'linked-target', ['promotions'], undefined, messageId);
    await until(decided([['acct-b', 'linked-target']]), 'provider target to finalize');
    await pollTick();
    expect((await h.accounts[1].storage.getEmail('linked-target')).tags).toContain('|promotions|');
    expect(row('acct-b', 'linked-target').ai_categories).toBeNull();
    expect(h.sent).toEqual([]);
  });

  // Regression: unknown native categories must remain pending across restart and recover after sync, without AI failure strikes or calls during the outage.
  it('defers unknown Gmail categories across restart and resumes once discovery succeeds', async () => {
    seedMirror(established(true));
    const first = await launch();
    await put(first, 'acct-a', 'unknown-gmail', [], undefined, undefined, true);
    await until(() => h.accounts[0].storage.db.prepare('SELECT extraction_status FROM emails WHERE id = ?').get('unknown-gmail').extraction_status === 'done', 'unknown email local extraction');
    await pollTick();
    expect(row('acct-a', 'unknown-gmail').agent_status).toBe('pending');
    expect(h.sent).toEqual([]);
    quit();
    await launch();
    await pollTick();
    expect(h.sent).toEqual([]);
    await h.accounts[0].storage.updateEmail('unknown-gmail', { gmailCategoriesPending: false });
    await pollTick();
    await until(decided([['acct-a', 'unknown-gmail']]), 'successful discovery to resume classification');
    expect(wasSent('Subject of unknown-gmail')).toBe(true);
  });

  // Regression: server metadata can arrive while another account holds the shared AI request queue; queued mail must recheck before spending tokens.
  it.each(['provider', 'pending discovery'])('rechecks %s received while waiting behind another account', async (state) => {
    seedMirror(established(true));
    const s = await launch();
    const originalProvider = h.provider;
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let started = false;
    const provider = vi.spyOn(h, 'provider').mockImplementationOnce(async (url, init) => {
      started = true;
      await held;
      return originalProvider(url, init);
    });
    try {
      await put(s, 'acct-a', 'queue-blocker');
      await until(() => started, 'the first account to hold the provider request');
      const target: SQLiteStorage = h.accounts[1].storage;
      const getEmail = target.getEmail.bind(target);
      let targetRead = 0;
      const reads = vi.spyOn(target, 'getEmail').mockImplementation(async (id: string) => {
        const email = await getEmail(id);
        if (id === 'queued-target') targetRead += 1;
        return email;
      });
      await put(s, 'acct-b', 'queued-target');
      await until(() => targetRead >= 2, 'the second account to enter processing');
      await new Promise((resolve) => setImmediate(resolve));
      if (state === 'provider') target.setServerCategories('queued-target', ['promotions']);
      else await target.updateEmail('queued-target', { gmailCategoriesPending: true });
      release();
      await until(decided([['acct-a', 'queue-blocker']]), 'the first request to complete');
      if (state === 'provider') await until(decided([['acct-b', 'queued-target']]), 'the provider-classified queued mail to finalize');
      else await pollTick();
      expect(wasSent('Subject of queued-target')).toBe(false);
      expect(row('acct-b', 'queued-target').ai_categories).toBeNull();
      if (state === 'pending discovery') expect(row('acct-b', 'queued-target').agent_status).toBe('pending');
      reads.mockRestore();
    } finally { release(); provider.mockRestore(); }
  });

  // Regression: manual choices already have a native operation; AI label retries must not compete with it or mirror provider guesses/unknown state.
  it('drains AI labels while retiring manual/provider mirrors and waiting for unknown native state', async () => {
    seedMirror(established(true));
    const s = await launch();
    const storage = h.accounts[0].storage;
    const apply = vi.fn(async (_path: string, _uid: number, _data: { categories: Array<{ slug: string }> }) => 'success');
    h.accounts[0].engine = { isConnected: () => true, operationQueue: {
      applyCategoryLabels: apply, ensureCategoryLabelsExist: vi.fn(async () => 0), isGmailCapable: () => false,
    } };
    for (const id of ['manual-label', 'manual-important', 'provider-label', 'unknown-label', 'ai-label']) {
      await storage.insertEmail(mail(id, id));
      storage.db.prepare("UPDATE emails SET extraction_status = 'done', agent_status = 'done', label_status = 'pending' WHERE id = ?").run(id);
    }
    storage.setEmailManualCategories('manual-label', ['finance']);
    storage.setEmailManualCategories('manual-important', ['important']);
    storage.setEmailManualCategories('manual-important', []);
    storage.setServerCategories('provider-label', ['promotions']);
    // Simulate a stale mirror left pending before the native toggle superseded it.
    storage.db.prepare("UPDATE emails SET agent_status = 'done', label_status = 'pending' WHERE id IN ('manual-label', 'manual-important', 'provider-label')").run();
    storage.db.prepare("UPDATE emails SET ai_categories = '|important|' WHERE id = 'manual-important'").run();
    await storage.updateEmail('unknown-label', { gmailCategoriesPending: true });
    storage.db.prepare("UPDATE emails SET ai_categories = '|invoice|' WHERE id IN ('unknown-label', 'ai-label')").run();
    const unknown = await storage.getEmail('unknown-label');
    await s.svc.mirrorCategoryLabels(storage, unknown, ['invoice']);
    expect(apply).not.toHaveBeenCalled();
    await pollTick();
    const labels = (id: string) => storage.db.prepare('SELECT label_status FROM emails WHERE id = ?').get(id).label_status;
    await until(() => labels('manual-label') === 'done' && labels('ai-label') === 'done', 'eligible label retries to complete');
    expect(labels('provider-label')).toBe('done');
    expect(labels('manual-important')).toBe('done');
    expect((await storage.getEmail('manual-important')).tags).not.toContain('|important|');
    expect(labels('unknown-label')).toBe('pending');
    expect(apply.mock.calls.map(([, , data]) => data.categories.map((category: { slug: string }) => category.slug))).toEqual([['invoice']]);
    expect(h.sent).toEqual([]);
  });

  // Regression: a real AI verdict may propagate across accounts only when the other copy has no provider/user authority or unknown Gmail state.
  it.each(['provider', 'pending discovery', 'spam', 'linked spam', 'unclassified'])('protects an existing %s sibling during AI propagation', async (state) => {
    seedMirror(established(true));
    const s = await launch();
    const target = h.accounts[1].storage;
    const messageId = '<propagated-message@test>';
    const sibling = mail('propagation-target', 'Target copy');
    sibling.messageId = messageId;
    sibling.serverCategories = state === 'provider' ? ['promotions'] : null;
    sibling.gmailCategoriesPending = state === 'pending discovery';
    sibling.tags = state === 'provider' ? '|INBOX|promotions|' : state === 'spam' ? '|INBOX|spam|' : '|INBOX|';
    if (state === 'linked spam') {
      await target.syncFolders([folder(Math.floor(Date.now() / 1000)), { ...folder(Math.floor(Date.now() / 1000)), id: 'linked-junk', name: 'Correo no deseado', path: '[Gmail]/Correo no deseado', specialUse: '\\Junk' }]);
      sibling.tags = '|INBOX|[Gmail]/Correo no deseado|spam|'; sibling.spamUserVerdict = 'ham';
    }
    await target.insertEmail(sibling);
    target.db.prepare("UPDATE emails SET extraction_status = 'done', agent_status = 'done' WHERE id = ?").run(sibling.id);
    const originalProvider = h.provider;
    const provider = vi.spyOn(h, 'provider').mockImplementationOnce(async (url, init) => {
      const response = await originalProvider(url, init);
      const payload = await response.json();
      const verdict = JSON.parse(payload.choices[0].message.content);
      for (const result of verdict) result.categories = ['invoice'];
      payload.choices[0].message.content = JSON.stringify(verdict);
      return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    try {
      await put(s, 'acct-a', 'propagation-source', undefined, undefined, messageId);
      await until(decided([['acct-a', 'propagation-source']]), 'the source AI verdict to save');
      expect(h.sent).toHaveLength(1);
      expect(row('acct-a', 'propagation-source').ai_categories).toBe('|invoice|');
      const current = await target.getEmail(sibling.id);
      if (state === 'unclassified') {
        expect(current.tags).toContain('|invoice|');
        expect(row('acct-b', sibling.id).ai_categories).toBe('|invoice|');
      } else {
        expect(current.tags).toBe(sibling.tags);
        expect(row('acct-b', sibling.id).ai_categories).toBeNull();
      }
    } finally { provider.mockRestore(); }
  });
});

describe('AI Assist on again: sorting resumes', () => {
  // Breaks: turning AI Assist back on does not bring sorting back, in one
  // account or in all of them.
  it('sends new mail from every account once it is switched back on', async () => {
    seedMirror(established(false));
    const s = await launch();
    await deliver(s, 'acct-a', 'a-while-off', 'event');
    await until(decided([['acct-a', 'a-while-off']]), 'the email that arrived while off');
    expect(h.sent).toEqual([]);

    await s.ipc('agent:setEnabled', true);
    const aEvent = await deliver(s, 'acct-a', 'a-after', 'event');
    const bEvent = await deliver(s, 'acct-b', 'b-after', 'event');
    const bPoll = await deliver(s, 'acct-b', 'b-after-poll', 'poll');
    await pollTick();
    await until(() => [aEvent, bEvent, bPoll].every(wasSent), 'each new email to reach the provider');
    await until(decided([['acct-a', 'a-after'], ['acct-b', 'b-after'], ['acct-b', 'b-after-poll']]), 'the pipeline to finish');

    // What is sent is what the policy lists: sender, recipient, subject, body.
    const prompt = sentSubjects().find((p) => p.includes(aEvent))!;
    expect(prompt).toContain('sender@example.test');
    expect(prompt).toContain(ME);
    expect(prompt).toContain(`Private body text of ${aEvent}`);
    expect(mirror().enabled).toBe(true);
  });
});

describe('AI Assist across a restart', () => {
  // Breaks: a restart forgets "off" and the pipeline sends new mail at launch,
  // before the renderer has re-sent the user's settings.
  it('stays off after a restart', async () => {
    seedMirror(established(true));
    const first = await launch();
    await first.ipc('agent:setEnabled', false);
    quit();

    const s = await launch();
    const mails: Array<[string, string]> = [['acct-a', 'a-event'], ['acct-b', 'b-poll']];
    await deliver(s, 'acct-a', 'a-event', 'event');
    await deliver(s, 'acct-b', 'b-poll', 'poll');
    await pollTick();
    await until(decided(mails), 'the pipeline to finish with both emails');
    expect(h.sent).toEqual([]);
  });

  // Breaks: a restart forgets "on" — the control that proves the test above
  // could have seen a request.
  it('stays on after a restart', async () => {
    seedMirror(established(false));
    const first = await launch();
    await first.ipc('agent:setEnabled', true);
    quit();

    const s = await launch();
    const subject = await deliver(s, 'acct-b', 'b-event', 'event');
    await until(() => wasSent(subject), 'the new email to reach the provider');
    await until(decided([['acct-b', 'b-event']]), 'the pipeline to finish');
  });
});

describe('an unreadable stored AI Assist switch fails closed', () => {
  // Each one is a mirror that did not survive storage intact. Reading any of
  // them as "on" sends the user's mail on a switch nobody can see the state of.
  it.each([
    ['broken JSON', '{"enabled":tru'],
    ['null', 'null'],
    ['an array', '[true]'],
    ['enabled as the string "true"', '{"enabled":"true"}'],
    ['enabled as the string "false"', '{"enabled":"false"}'],
    ['enabled as a number', '{"enabled":1}'],
  ])('%s: nothing is sent at launch', async (_label, text) => {
    seedMirror(text);
    const s = await launch();
    const mails: Array<[string, string]> = [['acct-a', 'a-event'], ['acct-b', 'b-poll']];
    await deliver(s, 'acct-a', 'a-event', 'event');
    await deliver(s, 'acct-b', 'b-poll', 'poll');
    await pollTick();
    await until(decided(mails), 'the pipeline to finish with both emails');
    expect(h.sent).toEqual([]);
  });
});
