import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import type { EmailRecord, FolderRecord } from '@sarvinbox/core';
import { SQLiteStorage } from '@sarvinbox/storage-node';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as fakeCoreDb from '../../../../electron/services/__testing__/fake-core-db';

/**
 * CASA audit I-7: main refuses an AI provider address that is not HTTPS (plain
 * HTTP only to a model server on this computer). The background pipeline gets
 * its provider two ways — the renderer's `pipeline:setAIConfig` push and, after
 * a restart, the config it saved to disk (`restorePersistedAIConfig`, run
 * detached with `void`) — and both go through `prepareAIProviderConfig`, which
 * now throws for such an address.
 *
 * These run the REAL pipeline service against two real account databases;
 * only the AI provider's network is a recorder.
 *
 * What breaks if this file fails: new mail goes to a provider over plain HTTP;
 * a refused push leaves the PREVIOUS provider receiving mail the user moved
 * away from (or brings it back from disk); a refused restore becomes an
 * unhandled rejection in main; or the user is never told why AI stopped.
 */

const h = vi.hoisted(() => {
  process.env.SARV_LOG_LEVEL = 'warn';
  return {
    userData: '',
    handlers: new Map<string, (...args: any[]) => any>(),
    accounts: [] as Array<{ id: string; storage: any }>,
    /** Every request that reached any AI provider. */
    sent: [] as Array<{ url: string; prompt: string }>,
    /** Everything main told the renderer window. */
    toWindow: [] as Array<[string, any]>,
    /** What main restores from disk at launch. */
    persisted: null as Record<string, unknown> | null,
    /** The saved config cannot be read at all. */
    persistedUnreadable: false,
    /** provider:email of every OAuth sign-in on this device. */
    signedIn: new Set<string>(),
    /** The token store cannot be opened (a locked keychain). */
    tokenStoreLocked: false,
    /** The manual / timed categorization runs, which hold their own provider copy. */
    categorization: { stop: vi.fn(), stopAutoProcess: vi.fn() },
    savePipelineAIConfig: vi.fn(async (_config: unknown) => {}),
    clearPipelineAIConfig: vi.fn(async () => {}),
    resolveAiKey: vi.fn(async (_id: string, _url: string | undefined): Promise<any> => ({ status: 'found', key: 'vault-key' })),
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
  const window = {
    isDestroyed: () => false,
    webContents: { send: (channel: string, payload: unknown) => { h.toWindow.push([channel, payload]); } },
  };
  return {
    getStorage: () => h.accounts[0]?.storage ?? null,
    requireStorage: () => h.accounts[0]?.storage,
    getAllAccountRuntimes: () => new Map(h.accounts.map((a) => [a.id, { storage: a.storage, syncEngine: undefined }])),
    getAccountRuntime: (id: string) => (byId(id) ? { storage: byId(id) } : undefined),
    getStorageFor: (id: string) => byId(id),
    getCurrentAccountId: () => h.accounts[0]?.id ?? null,
    getSyncEngine: () => null,
    getSyncEngineFor: () => null,
    getSyncEngineForStorage: () => null,
    getAccountIdForStorage: (s: any) => h.accounts.find((a) => a.storage === s)?.id ?? null,
    getMainWindow: () => window,
    getAICategorizationService: () => h.categorization,
    getSmtpClient: () => null,
    findStorageForEmail: (emailId: string, hint?: string) => {
      if (hint && holds(byId(hint), emailId)) return byId(hint);
      return h.accounts.find((a) => holds(a.storage, emailId))?.storage ?? null;
    },
  };
});

vi.mock('../../../../electron/services/net-fetch', () => ({
  chromiumFetch: (url: string, init?: RequestInit) => h.provider(url, init),
}));
vi.mock('../../../../electron/services/pipeline-ai-config-store', () => ({
  savePipelineAIConfig: h.savePipelineAIConfig,
  loadPipelineAIConfigSync: () => {
    if (h.persistedUnreadable) throw new Error('core DB unreadable');
    return h.persisted;
  },
  clearPipelineAIConfig: h.clearPipelineAIConfig,
}));
vi.mock('../../../../electron/services/ai-secret-store', () => ({ resolveAiKey: h.resolveAiKey }));
vi.mock('../../../../electron/ipc/draft-handlers', () => ({
  newDraftMessageId: vi.fn(() => '<draft@example.test>'),
  saveDraftToIMAP: vi.fn(),
}));
vi.mock('../../../../electron/ipc/smtp-handlers', () => ({ sendEmailFromMain: vi.fn(), appendSentCopy: vi.fn() }));
vi.mock('../../../../electron/services/accounts-registry', () => ({
  readRegistryAccounts: () => [],
  // The contact refresh shares the pipeline's lifecycle and reads this.
  listRegistryAccounts: () => [],
  registryAccountEmail: () => 'me@example.test',
  resolveAccountEmail: () => 'me@example.test',
  resolveAccountIdentity: () => ({ email: 'me@example.test', name: 'Me' }),
}));
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
  getAccount: vi.fn(async (provider: string, email: string) => {
    if (h.tokenStoreLocked) throw new Error('Stored tokens are encrypted but safeStorage is unavailable');
    return h.signedIn.has(`${provider}:${email}`) ? { provider, email } : null;
  }),
  listAccounts: vi.fn(async () => []),
}));

const ME = 'me@example.test';
const POLL_MS = 30_000;
const HTTPS = { type: 'openai', apiKey: 'test-key', model: 'test-model', baseUrl: 'https://provider.test/v1' };
const PLAIN_HTTP = { type: 'custom', apiKey: '', model: 'm', baseUrl: 'http://models.lan.example/v1' };
const HTTPS_REFUSED = /^AI provider address must use HTTPS/;

type Service = typeof import('../../../../electron/services/unified-pipeline-service');
type Core = typeof import('@sarvinbox/core');
interface Session { svc: Service; core: Core; ipc: (channel: string, ...args: unknown[]) => Promise<any> }

let running: Session | null = null;
let dir = '';
let uid = 0;
const rejections: unknown[] = [];
const onRejection = (reason: unknown) => { rejections.push(reason); };

function folder(now: number): FolderRecord {
  return {
    id: 'f-inbox', name: 'INBOX', path: 'INBOX', parentId: null, uidValidity: 1, lastSyncUid: null,
    lastSyncTime: null, totalCount: 0, unreadCount: 0, specialUse: '\\Inbox', subscribed: true,
    createdAt: now, updatedAt: now,
  } as FolderRecord;
}

function mail(id: string): EmailRecord {
  const now = Math.floor(Date.now() / 1000) + uid;
  return {
    id, messageId: `<${id}@example.test>`, threadId: `thread-${id}`, folderId: 'f-inbox', uid: ++uid, tags: '|INBOX|',
    subject: `Subject of ${id}`, fromAddress: 'sender@example.test', fromName: 'Sender', toAddress: ME, toNames: null,
    ccAddress: null, ccNames: null, bccAddress: null, bccNames: null, replyTo: null, date: now, receivedDate: now,
    cleanBody: `Private body text of ${id}`, rawBody: `<p>Private body text of ${id}</p>`, contentType: 'html',
    contentHash: `hash-${id}`, inReplyTo: null, references: null, priority: null, hasAttachments: false,
    attachmentCount: 0, attachmentNames: null, attachmentSizes: null, hasEmbedding: false,
    embeddingLastGenerated: null, createdAt: now, updatedAt: now,
  } as EmailRecord;
}

/** Start main with AI Assist on (an established install), so only the provider decides where mail goes. */
async function launch(): Promise<Session> {
  vi.resetModules();
  h.handlers.clear();
  fakeCoreDb.state.blobs.set('agent-config', Buffer.from(JSON.stringify({ enabled: true, backfillRequeuedAccounts: h.accounts.map((a) => a.id) }), 'utf8'));
  const store = await import('../../../../electron/services/agent-config-store');
  const { bootPipelineConfig } = await import('../../../../electron/services/pipeline-init-config');
  const svc = await import('../../../../electron/services/unified-pipeline-service');
  const core = await import('@sarvinbox/core');
  svc.initializeUnifiedPipeline(bootPipelineConfig(store.loadAgentConfig(), ME));
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

/** New mail lands in an account and its body is ready (the real-time trigger). */
async function deliver(s: Session, accountId: string, id: string): Promise<void> {
  const storage = h.accounts.find((a) => a.id === accountId)!.storage;
  await storage.insertEmail(mail(id));
  s.core.getEventBus().emit(s.core.createEvent.emailSynced(await storage.getEmail(id), 'INBOX', true));
  s.core.getEventBus().emit(s.core.createEvent.emailBodyReady(id));
}

/** Let every promise chain the pipeline started run out. */
async function settle(rounds = 300): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setImmediate(r));
}

async function until(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 2000; i++) {
    if (cond()) return;
    await new Promise((r) => setImmediate(r));
  }
  throw new Error(`timed out waiting for: ${what}`);
}

const wasSent = (id: string) => h.sent.some((r) => r.prompt.includes(`Subject of ${id}`));
const refusalsShown = () => h.toWindow.filter(([channel, p]) => channel === 'ai-categorization:error' && p?.terminal && HTTPS_REFUSED.test(p.reason));

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'pipeline-ai-endpoint-'));
  h.userData = dir;
  h.sent.length = 0;
  h.toWindow.length = 0;
  h.persisted = null;
  h.persistedUnreadable = false;
  h.signedIn.clear();
  h.tokenStoreLocked = false;
  h.categorization.stop.mockClear();
  h.categorization.stopAutoProcess.mockClear();
  h.savePipelineAIConfig.mockClear();
  h.clearPipelineAIConfig.mockClear();
  h.resolveAiKey.mockReset().mockResolvedValue({ status: 'found', key: 'vault-key' });
  rejections.length = 0;
  process.on('unhandledRejection', onRejection);
  fakeCoreDb.resetFakeCoreDb();
  for (const id of ['acct-a', 'acct-b']) {
    const storage = new SQLiteStorage({ dbPath: join(dir, `${id}.db`), sharedContactsPath: join(dir, 'contacts.db'), accountId: id });
    await storage.initialize();
    await storage.syncFolders([folder(Math.floor(Date.now() / 1000))]);
    h.accounts.push({ id, storage });
  }
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) => h.provider(url, init));
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
});

afterEach(async () => {
  running?.svc.stopUnifiedPipeline();
  running = null;
  process.off('unhandledRejection', onRejection);
  vi.useRealTimers();
  vi.unstubAllGlobals();
  for (const a of h.accounts) await a.storage.close();
  h.accounts.length = 0;
  rmSync(dir, { recursive: true, force: true });
});

describe('pipeline:setAIConfig refuses a plain-HTTP provider on another computer', () => {
  // THE finding, through the renderer's push. Multi-account: neither account's
  // new mail may go to the refused address, nor to the provider used before.
  it('answers with the HTTPS reason, drops the provider in use, and sends no mail anywhere', async () => {
    h.persisted = { ...HTTPS };
    const s = await launch();
    await until(() => s.svc.getPipelineAIConfig() !== null, 'the saved provider to be restored');
    await deliver(s, 'acct-a', 'before');
    await until(() => wasSent('before'), 'mail to reach the working provider');

    const result = await s.ipc('pipeline:setAIConfig', PLAIN_HTTP);

    // Breaks: the refusal throws raw over IPC, or claims success.
    expect(result).toEqual({ success: false, error: expect.stringMatching(HTTPS_REFUSED) });
    // Breaks: the provider the user switched away from keeps getting mail.
    expect(s.svc.getPipelineAIConfig()).toBeNull();
    // Breaks: the user is never told why AI stopped (the Fix banner's channel).
    expect(refusalsShown()).toHaveLength(1);
    expect(h.toWindow).toContainEqual(['ai:pipeline-status', expect.objectContaining({ available: false })]);
    // Breaks: the refused config is saved, or the previous one comes back after a restart.
    expect(h.savePipelineAIConfig).not.toHaveBeenCalledWith(expect.objectContaining({ baseUrl: PLAIN_HTTP.baseUrl }));
    expect(h.clearPipelineAIConfig).toHaveBeenCalled();

    h.sent.length = 0;
    await deliver(s, 'acct-a', 'after-a');
    await deliver(s, 'acct-b', 'after-b');
    await vi.advanceTimersByTimeAsync(POLL_MS);
    await settle();
    expect(h.sent).toEqual([]);
    expect(rejections).toEqual([]);
  });

  // Idempotent re-run: the renderer's self-heal re-pushes the same config when
  // it hears "unavailable". Breaks: a refusal loop, or a re-push that succeeds.
  it('refuses the same config again on a re-push, without a second availability edge', async () => {
    const s = await launch();
    await expect(s.ipc('pipeline:setAIConfig', PLAIN_HTTP)).resolves.toMatchObject({ success: false });
    await expect(s.ipc('pipeline:setAIConfig', PLAIN_HTTP)).resolves.toMatchObject({ success: false });
    expect(s.svc.getPipelineAIConfig()).toBeNull();
    expect(h.toWindow.filter(([channel]) => channel === 'ai:pipeline-status')).toHaveLength(1);
    expect(rejections).toEqual([]);
  });

  // A refusal is about that address, not a latch. Breaks: fixing the address
  // (or switching provider) does not bring AI back.
  it('takes a corrected HTTPS config straight after a refusal', async () => {
    const s = await launch();
    await s.ipc('pipeline:setAIConfig', PLAIN_HTTP);
    await expect(s.ipc('pipeline:setAIConfig', HTTPS)).resolves.toEqual({ success: true });
    expect(s.svc.getPipelineAIConfig()).toMatchObject({ baseUrl: HTTPS.baseUrl });
    await deliver(s, 'acct-b', 'fixed');
    await until(() => wasSent('fixed'), 'mail to reach the corrected provider');
    expect(h.sent.every((r) => r.url.startsWith('https://provider.test/'))).toBe(true);
  });

  // A model server on this computer stays usable. Breaks: local Ollama/LM Studio users lose AI.
  it('accepts plain HTTP to this computer', async () => {
    const s = await launch();
    const local = { type: 'custom', apiKey: '', model: 'm', baseUrl: 'http://localhost:11434/v1' };
    await expect(s.ipc('pipeline:setAIConfig', local)).resolves.toEqual({ success: true });
    expect(s.svc.getPipelineAIConfig()).toMatchObject({ baseUrl: local.baseUrl });
    expect(refusalsShown()).toEqual([]);
  });

  // An unexpected failure preparing the config (not a refusal) used to escape
  // as a raw IPC rejection. Breaks: the renderer's push throws instead of
  // getting { success: false }.
  it('reports any other failure to prepare the config as a failed result', async () => {
    const s = await launch();
    // A config whose address cannot be read stands in for "prepare failed".
    const exploding = { ...HTTPS, get baseUrl(): string { throw new Error('config unreadable'); } };
    await expect(s.ipc('pipeline:setAIConfig', exploding)).resolves.toEqual({ success: false, error: 'config unreadable' });
    expect(refusalsShown()).toEqual([]);
  });
});

describe('restoring the saved provider at launch', () => {
  // The restore runs detached (`void`). Breaks: an older build's saved
  // plain-HTTP provider becomes an unhandled rejection in main, or is used.
  it('refuses a saved plain-HTTP provider without an unhandled rejection, and tells the user', async () => {
    h.persisted = { ...PLAIN_HTTP };
    const s = await launch();
    await settle();
    expect(s.svc.getPipelineAIConfig()).toBeNull();
    expect(refusalsShown()).toHaveLength(1);
    await deliver(s, 'acct-a', 'restored');
    await vi.advanceTimersByTimeAsync(POLL_MS);
    await settle();
    expect(h.sent).toEqual([]);
    expect(rejections).toEqual([]);
  });

  // Partial/interrupted run: the restore is still waiting on the key vault
  // when the renderer pushes a provider main refuses. Breaks: the restore
  // finishes afterwards and the OLD provider gets mail again.
  it('does not bring the saved provider back over a refused push that arrived meanwhile', async () => {
    let release!: (value: unknown) => void;
    h.resolveAiKey.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    h.persisted = { type: 'openai', apiKey: '', providerId: 'p1', model: 'm', baseUrl: 'https://provider.test/v1' };
    const s = await launch();
    await until(() => h.resolveAiKey.mock.calls.length > 0, 'the restore to ask the vault');

    await s.ipc('pipeline:setAIConfig', PLAIN_HTTP);
    release({ status: 'found', key: 'vault-key' });
    await settle();

    expect(s.svc.getPipelineAIConfig()).toBeNull();
    await deliver(s, 'acct-a', 'raced');
    await vi.advanceTimersByTimeAsync(POLL_MS);
    await settle();
    expect(h.sent).toEqual([]);
  });

  // A transient vault failure during the restore is not a refusal. Breaks:
  // a locked keychain at launch turns into an unhandled rejection or a banner
  // saying the address is insecure.
  it('treats an unreadable vault as no key, not as a refusal', async () => {
    h.resolveAiKey.mockRejectedValueOnce(new Error('keychain locked'));
    h.persisted = { type: 'openai', apiKey: '', providerId: 'p1', model: 'm', baseUrl: 'https://provider.test/v1' };
    const s = await launch();
    await until(() => s.svc.getPipelineAIConfig() !== null, 'the saved provider to be restored');
    expect(refusalsShown()).toEqual([]);
    expect(rejections).toEqual([]);
  });
});

/**
 * The same Sarv sign-in runs the mailbox AND AI, and removing the mailbox ends it
 * (tracker item 6). Main reports "no AI", and the renderer answers by re-pushing
 * its default provider, which during the removal is still the removed Sarv one.
 *
 * What breaks if this block fails: AI Assist is left broken and silent. The
 * pipeline holds a dead session and reports AI as available while every call
 * fails; or a removed provider keeps receiving new mail until the next restart;
 * or removing ONE Sarv account stops AI running on another.
 */
describe('the sign-in behind the AI provider is removed', () => {
  const SARV = (email: string) => ({
    type: 'sarv', apiKey: '', model: 'm', baseUrl: 'https://jpr1-ai-edge.sarv.com/edge/v1/llm',
    authMethod: 'oauth', oauthProvider: 'sarv', oauthEmail: email,
  });
  const ONE = 'one@sarv.test';
  const TWO = 'two@sarv.test';
  const statuses = () => h.toWindow.filter(([channel]) => channel === 'ai:pipeline-status').map(([, p]) => p.available);
  const onProvider = async (email: string) => {
    h.signedIn.add(`sarv:${email}`);
    const s = await launch();
    await expect(s.ipc('pipeline:setAIConfig', SARV(email))).resolves.toEqual({ success: true });
    h.toWindow.length = 0;
    h.savePipelineAIConfig.mockClear();
    return s;
  };

  // The removal itself. Breaks: the pipeline goes on calling a dead session.
  it('drops the live provider, forgets the saved one and says AI is unavailable', async () => {
    const s = await onProvider(ONE);
    h.persisted = SARV(ONE);
    h.signedIn.delete(`sarv:${ONE}`);

    await expect(s.svc.disablePipelineAIIfProviderRemoved()).resolves.toBe(true);

    expect(s.svc.getPipelineAIConfig()).toBeNull();
    expect(h.clearPipelineAIConfig).toHaveBeenCalled();
    expect(statuses()).toEqual([false]);
  });

  // THE silent case, in the order it really happens. Breaks: main takes the dead
  // config back, reports AI as available, and every categorization then fails.
  it('refuses the renderer\'s re-push of the removed provider, and stays unavailable', async () => {
    const s = await onProvider(ONE);
    h.signedIn.delete(`sarv:${ONE}`);
    await s.svc.disablePipelineAIIfProviderRemoved();

    const answer = await s.ipc('pipeline:setAIConfig', SARV(ONE));

    expect(answer).toEqual({ success: false, error: expect.stringContaining('sign-in was removed') });
    expect(s.svc.getPipelineAIConfig()).toBeNull();
    expect(h.savePipelineAIConfig).not.toHaveBeenCalled();
    // Exactly one edge: no flip back to available, and no loop of re-pushes.
    expect(statuses()).toEqual([false]);
    // The renderer ignores the answer. Breaks: a provider still listed there with
    // no sign-in behind it shows no sign of a problem, and raises no Fix banner.
    expect(h.toWindow).toContainEqual(['ai-categorization:error', expect.objectContaining({
      terminal: true, reason: expect.stringContaining('sign-in was removed'),
    })]);

    await deliver(s, 'acct-a', 'after-removal');
    await vi.advanceTimersByTimeAsync(POLL_MS);
    await settle();
    expect(h.sent).toEqual([]);
    expect(rejections).toEqual([]);
  });

  // Breaks: refusing once latches AI off, so signing in again does not bring it back.
  it('takes the provider again after the user signs in again', async () => {
    const s = await onProvider(ONE);
    h.signedIn.delete(`sarv:${ONE}`);
    await s.svc.disablePipelineAIIfProviderRemoved();
    await s.ipc('pipeline:setAIConfig', SARV(ONE));

    h.signedIn.add(`sarv:${ONE}`);
    await expect(s.ipc('pipeline:setAIConfig', SARV(ONE))).resolves.toEqual({ success: true });

    expect(s.svc.getPipelineAIConfig()).toMatchObject({ oauthEmail: ONE });
    expect(statuses()).toEqual([false, true]);
  });

  // The live config is what calls the provider. Breaks: a saved copy that cannot
  // be read, or was already cleared, hides that the live one is dead.
  it.each([
    ['cannot be read', () => { h.persistedUnreadable = true; }],
    ['is gone already', () => { h.persisted = null; }],
  ])('drops a dead live provider when the saved copy %s', async (_what, arrange) => {
    const s = await onProvider(ONE);
    arrange();
    h.signedIn.delete(`sarv:${ONE}`);

    await expect(s.svc.disablePipelineAIIfProviderRemoved()).resolves.toBe(true);
    expect(s.svc.getPipelineAIConfig()).toBeNull();
    expect(statuses()).toEqual([false]);
  });

  // Multi-account. Breaks: removing one Sarv account stops AI running on another.
  it('leaves AI alone when a different Sarv account is removed', async () => {
    const s = await onProvider(ONE);
    h.persisted = SARV(ONE);
    h.signedIn.add(`sarv:${TWO}`);
    h.signedIn.delete(`sarv:${TWO}`);

    await expect(s.svc.disablePipelineAIIfProviderRemoved()).resolves.toBe(false);

    expect(s.svc.getPipelineAIConfig()).toMatchObject({ oauthEmail: ONE });
    expect(h.clearPipelineAIConfig).not.toHaveBeenCalled();
    expect(statuses()).toEqual([]);
  });

  // Breaks: an API-key provider the user moved to is dropped because an old saved
  // Sarv config went stale, or that stale config comes back at the next launch.
  it('clears a stale saved Sarv config without touching a live API-key provider', async () => {
    const s = await launch();
    await s.ipc('pipeline:setAIConfig', HTTPS);
    h.toWindow.length = 0;
    h.persisted = SARV(ONE);

    await expect(s.svc.disablePipelineAIIfProviderRemoved()).resolves.toBe(true);

    expect(s.svc.getPipelineAIConfig()).toMatchObject({ type: 'openai' });
    expect(h.clearPipelineAIConfig).toHaveBeenCalled();
    expect(statuses()).toEqual([]);
  });

  // A locked keychain: unknown is not gone. Breaks: a transient lock is read as
  // the sign-in being removed, and AI is switched off for it.
  it('changes nothing while the token store cannot be read', async () => {
    const s = await onProvider(ONE);
    h.tokenStoreLocked = true;

    await expect(s.svc.disablePipelineAIIfProviderRemoved()).rejects.toThrow('safeStorage is unavailable');
    expect(s.svc.getPipelineAIConfig()).toMatchObject({ oauthEmail: ONE });
    expect(h.clearPipelineAIConfig).not.toHaveBeenCalled();

    await expect(s.ipc('pipeline:setAIConfig', SARV(ONE))).resolves.toEqual({ success: true });
    expect(s.svc.getPipelineAIConfig()).toMatchObject({ oauthEmail: ONE });
  });

  // AI Assist is the one switch and removal must not touch it. Breaks: connecting
  // a provider later finds sorting turned off by a removal nobody asked to do that.
  it('does not change the AI Assist setting', async () => {
    const s = await onProvider(ONE);
    const before = fakeCoreDb.state.blobs.get('agent-config');
    h.signedIn.delete(`sarv:${ONE}`);
    await s.svc.disablePipelineAIIfProviderRemoved();
    await s.ipc('pipeline:setAIConfig', SARV(ONE));
    expect(fakeCoreDb.state.blobs.get('agent-config')).toEqual(before);
  });

  // Removing the last provider, in Settings or with its account. The privacy
  // policy says this stops AI. Breaks: new mail keeps going to the removed
  // provider until the next restart.
  it('stops sending as soon as the renderer reports no provider', async () => {
    const s = await launch();
    await s.ipc('pipeline:setAIConfig', HTTPS);
    h.toWindow.length = 0;

    await expect(s.ipc('pipeline:clearAIConfig')).resolves.toEqual({ success: true });

    expect(s.svc.getPipelineAIConfig()).toBeNull();
    expect(h.clearPipelineAIConfig).toHaveBeenCalled();
    expect(statuses()).toEqual([false]);
    // The manual and timed runs hold their own copy of the provider.
    expect(h.categorization.stop).toHaveBeenCalled();
    expect(h.categorization.stopAutoProcess).toHaveBeenCalled();
    await deliver(s, 'acct-a', 'after-forget');
    await vi.advanceTimersByTimeAsync(POLL_MS);
    await settle();
    expect(h.sent).toEqual([]);
  });

  // The renderer says this on every launch of an install with no provider. Breaks:
  // a banner on launch before the 30 s grace period, for nothing having changed.
  it('says nothing when there was no provider to forget', async () => {
    const s = await launch();
    await s.ipc('pipeline:clearAIConfig');
    expect(statuses()).toEqual([]);
  });

  // Breaks: a push still reading the vault lands after "no provider" and the
  // removed provider receives mail again, live and after every restart.
  it('does not let a push still under way bring the provider back', async () => {
    const vault = { release: () => {} };
    h.resolveAiKey.mockImplementationOnce(() => new Promise((resolve) => {
      vault.release = () => resolve({ status: 'found', key: 'vault-key' });
    }));
    const s = await launch();
    const push = s.ipc('pipeline:setAIConfig', { ...HTTPS, apiKey: '', providerId: 'p1' });
    await until(() => h.resolveAiKey.mock.calls.length === 1, 'the push to reach the vault');

    await s.ipc('pipeline:clearAIConfig');
    vault.release();

    await expect(push).resolves.toEqual({ success: true, superseded: true });
    expect(s.svc.getPipelineAIConfig()).toBeNull();
    expect(h.savePipelineAIConfig).not.toHaveBeenCalled();
  });

  // Two pushes racing: the later one is what the renderer wants now.
  it('keeps the newer push when an older one finishes last', async () => {
    const vault = { release: () => {} };
    h.resolveAiKey.mockImplementationOnce(() => new Promise((resolve) => {
      vault.release = () => resolve({ status: 'found', key: 'vault-key' });
    }));
    const s = await launch();
    const older = s.ipc('pipeline:setAIConfig', { ...HTTPS, model: 'older', apiKey: '', providerId: 'p1' });
    await until(() => h.resolveAiKey.mock.calls.length === 1, 'the older push to reach the vault');
    await s.ipc('pipeline:setAIConfig', { ...HTTPS, model: 'newer' });
    vault.release();
    await older;
    expect(s.svc.getPipelineAIConfig()).toMatchObject({ model: 'newer' });
  });

  // Breaks: a saved provider still being restored comes back right after the
  // renderer said there is none.
  it('does not let a restore in progress bring the provider back', async () => {
    // No key in the saved config: the restore waits on the vault for it.
    h.persisted = { ...HTTPS, apiKey: '', providerId: 'p1' };
    const vault = { release: () => {} };
    h.resolveAiKey.mockImplementationOnce(() => new Promise((resolve) => {
      vault.release = () => resolve({ status: 'found', key: 'vault-key' });
    }));
    const s = await launch();
    await until(() => h.resolveAiKey.mock.calls.length === 1, 'the restore to reach the vault');

    await s.ipc('pipeline:clearAIConfig');
    vault.release();
    await settle();

    expect(s.svc.getPipelineAIConfig()).toBeNull();
  });
});
