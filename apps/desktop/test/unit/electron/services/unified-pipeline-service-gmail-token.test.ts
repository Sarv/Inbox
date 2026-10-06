import { addTag, GMAIL_CLASSIFICATION_CATEGORY_SLUGS, SARV_LABEL_PARENT } from '@sarvinbox/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Which Gmail mailbox each category-label pass writes to.
 *
 * Every pass walks the connected accounts and, for a Gmail account connected
 * over OAuth, calls the Gmail REST API with a token. That token must be THIS
 * account's own grant. The passes used to ask for a token with no address, and
 * got the FIRST Gmail grant on file, so with two Gmail accounts A and B:
 *   - provisioning and backfill created and coloured B's labels in A's mailbox,
 *   - renaming a category renamed A's label twice and B's never,
 *   - "Delete all Sarv Inbox labels" cleaned A and silently left B,
 *   - a background account's categorization used the ACTIVE account's grant.
 * The fix fails closed: an unknown address or no matching grant means plain
 * IMAP labels over the account's own connection, never another account's token.
 *
 * The fake models what matters. Each Gmail account has ONE label store, reached
 * over its own IMAP engine and over the REST API with its own token. A label
 * landing in the wrong store is the bug, whichever channel put it there.
 */

const h = vi.hoisted(() => ({
  runtimes: new Map<string, { storage: unknown; syncEngine: unknown; smtpClient: null }>(),
  grants: [] as Array<{ provider: string; email: string }>,
  /** Addresses whose token refresh currently fails (a network blip), and what it rejects with. */
  refreshFailing: new Map<string, unknown>(),
  /** The OAuth token store itself can't be read (e.g. no keyring on Linux). */
  grantStoreThrows: false,
  trace: false,
  log: { warn: [] as string[], trace: [] as string[] },
}));

vi.mock('electron', () => ({
  ipcMain: { handle: () => {}, on: () => {}, removeHandler: () => {} },
  app: { getPath: () => '/nonexistent', getName: () => 'Sarv Inbox Test', isPackaged: false },
}));

vi.mock('@sarvinbox/core', async () => {
  const actual = await vi.importActual<typeof import('@sarvinbox/core')>('@sarvinbox/core');
  const line = (args: unknown[]): string => args.map((a) => (a instanceof Error ? a.message : String(a))).join(' ');
  return {
    ...actual,
    createLogger: () => ({
      info: () => {}, error: () => {}, debug: () => {},
      warn: (...args: unknown[]) => { h.log.warn.push(line(args)); },
      trace: (...args: unknown[]) => { h.log.trace.push(line(args)); },
      isLevelEnabled: (level: string) => level === 'trace' && h.trace,
    }),
  };
});

// The runtime registry, as main keeps it: the pre-account default slot holds
// storage and an engine but maps to NO account id.
vi.mock('../../../../electron/shared', () => {
  const entries = () => [...h.runtimes.entries()];
  return {
    getAllAccountRuntimes: () => entries().filter(([id]) => id !== '__default__'),
    getAccountRuntime: (id: string) => h.runtimes.get(id),
    getAccountIdForStorage: (storage: unknown) => {
      const hit = entries().find(([, rt]) => rt.storage === storage);
      return hit && hit[0] !== '__default__' ? hit[0] : null;
    },
    getSyncEngineForStorage: (storage: unknown) =>
      entries().find(([, rt]) => rt.storage === storage)?.[1].syncEngine ?? null,
    getStorage: () => null,
    getSyncEngine: () => null,
    getMainWindow: () => null,
    getSmtpClient: () => null,
    findStorageForEmail: () => null,
  };
});

vi.mock('../../../../electron/services/core-db', async () => await import('../../../../electron/services/__testing__/fake-core-db'));
vi.mock('../../../../electron/services/accounts-runtime', () => ({ loadPrimaryAccountId: () => null }));
vi.mock('../../../../electron/services/imap-account-store', () => ({ loadImapAccount: async () => null }));

vi.mock('../../../../electron/services/oauth-token-store', () => ({
  listAccounts: async () => {
    if (h.grantStoreThrows) throw new Error('Stored tokens are encrypted but safeStorage is unavailable');
    return [...h.grants];
  },
  loadAccounts: async () => [...h.grants],
  getAccount: async () => null,
}));

// One token per grant, named after its owner so the fake Gmail API can tell
// whose mailbox a request reaches.
vi.mock('../../../../electron/services/oauth-service', () => ({
  attachOAuthBearer: (config: unknown) => config,
  getValidAccessToken: async (provider: string, email: string) => {
    const lc = email.toLowerCase();
    if (!h.grants.some((g) => g.provider === provider && g.email.toLowerCase() === lc)) {
      throw new Error(`No OAuth account for ${provider}:${email}`);
    }
    if (h.refreshFailing.has(lc)) throw h.refreshFailing.get(lc);
    return `token-for:${lc}`;
  },
}));

vi.mock('../../../../electron/ipc/agent-handlers', () => ({ logUserAction: () => {} }));
vi.mock('../../../../electron/ipc/draft-handlers', () => ({ saveDraftToIMAP: async () => undefined }));
vi.mock('../../../../electron/ipc/smtp-handlers', () => ({
  sendEmailFromMain: async () => undefined,
  appendSentCopy: async () => undefined,
}));
vi.mock('../../../../electron/services/agent-config-store', () => ({ loadAgentConfig: () => ({}) }));
vi.mock('../../../../electron/services/net-fetch', () => ({
  chromiumFetch: async () => { throw new Error('no network in tests'); },
}));
vi.mock('../../../../electron/services/notification-service', () => ({ notifyNewMail: () => {} }));
vi.mock('../../../../electron/services/pipeline-ai-config-store', () => ({
  savePipelineAIConfig: async () => undefined,
  loadPipelineAIConfigSync: () => null,
  clearPipelineAIConfig: async () => undefined,
}));

import { resetFakeCoreDb } from '../../../../electron/services/__testing__/fake-core-db';
import { upsertRegistryAccount } from '../../../../electron/services/accounts-registry';
import { changeEmailCategory } from '../../../../electron/services/classification-actions';
import * as oauthService from '../../../../electron/services/oauth-service';
import {
  backfillCategoryLabels,
  mirrorCategoryLabels,
  provisionCategoryLabels,
  provisionCategoryLabelsOnConnect,
  removeAllCategoryLabels,
  renameCategoryLabelEverywhere,
  setCategoryLabelConfig,
  setPipelineUserProfile,
} from '../../../../electron/services/unified-pipeline-service';

// ---- The fake Gmail world ---------------------------------------------------

const API = 'https://gmail.googleapis.com/gmail/v1/users/me/labels';
const BEARER = 'Bearer token-for:';
const PARENT = SARV_LABEL_PARENT;
const label = (leaf: string): string => `${PARENT}/${leaf}`;

interface StoreLabel { id: string; name: string; color?: { backgroundColor: string; textColor: string } }

/** Each Gmail account's one label store, keyed by its address. */
const stores = new Map<string, StoreLabel[]>();
/** REST writes (POST / PATCH / DELETE) per store: a no-op re-run adds none. */
const restWrites = new Map<string, number>();
let nextLabelId = 0;

const newLabel = (name: string, color?: StoreLabel['color']): StoreLabel =>
  ({ id: `L${++nextLabelId}`, name, ...(color ? { color } : {}) });

const respond = (status: number, body?: unknown): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body ?? ''),
  }) as unknown as Response;

/** users.labels, scoped to the mailbox whose grant issued the bearer token. */
async function fakeGmailApi(url: string, init: RequestInit = {}): Promise<Response> {
  const auth = String((init.headers as Record<string, string> | undefined)?.Authorization ?? '');
  const owner = auth.startsWith(BEARER) ? auth.slice(BEARER.length) : '';
  const store = stores.get(owner);
  if (!store) return respond(401, { error: 'invalid token' });

  const method = init.method ?? 'GET';
  if (method === 'GET') return respond(200, { labels: store.map((l) => ({ ...l })) });

  restWrites.set(owner, (restWrites.get(owner) ?? 0) + 1);
  const body = init.body ? JSON.parse(String(init.body)) : {};
  if (method === 'POST') {
    if (store.some((l) => l.name.toLowerCase() === String(body.name).toLowerCase())) return respond(409, { error: 'exists' });
    const created = newLabel(body.name, body.color);
    store.push(created);
    return respond(200, created);
  }
  const idx = store.findIndex((l) => l.id === String(url).slice(API.length + 1));
  if (idx < 0) return respond(404, { error: 'not found' });
  if (method === 'PATCH') {
    Object.assign(store[idx], body);
    return respond(200, store[idx]);
  }
  store.splice(idx, 1); // DELETE
  return respond(204);
}

const DEFS = [
  { slug: 'invoices', name: 'Invoices', color: 'green', isEnabled: 1 },
  { slug: 'travel', name: 'Travel', color: 'blue', isEnabled: 1 },
];
const labelForSlug = (slug: string): string => label(DEFS.find((d) => d.slug === slug)!.name);

interface AccountOptions {
  id: string;
  email: string;
  /** 'oauth' = a Gmail grant exists for this address; 'password' = app-password login, no grant. */
  auth: 'oauth' | 'password';
  /** false = not a Gmail server: labels are plain IMAP folders or keywords there. */
  gmail?: boolean;
  /** false = the runtime is live but the registry has no row for it (address unknown). */
  inRegistry?: boolean;
  connected?: boolean;
  /** INBOX mail as [uid, category slug]. */
  mail?: Array<[number, string]>;
  /** Labels the account's store already holds. */
  seed?: string[];
}

type Account = ReturnType<typeof addAccount>;

/** A connected account (Gmail unless `gmail: false`): runtime, registry row, grant and label store. */
function addAccount(opts: AccountOptions) {
  const email = opts.email.toLowerCase();
  const gmail = opts.gmail !== false;
  stores.set(email, (opts.seed ?? []).map((name) => newLabel(name)));
  if (opts.auth === 'oauth') h.grants.push({ provider: 'gmail', email });
  if (opts.inRegistry !== false) {
    upsertRegistryAccount({
      id: opts.id,
      email: opts.email,
      imapConfig: {
        host: gmail ? 'imap.gmail.com' : 'imap.example.com', port: 993, secure: true, username: opts.email,
        authMethod: opts.auth === 'oauth' ? 'oauth2' : 'password',
        ...(opts.auth === 'oauth' ? { oauthProvider: 'gmail' } : {}),
      },
      smtpConfig: null,
      smtpConfigured: false,
    });
  }

  const store = (): StoreLabel[] => stores.get(email)!;
  const has = (name: string): boolean => store().some((l) => l.name.toLowerCase() === name.toLowerCase());
  const ensure = (name: string): number => {
    if (has(name)) return 0;
    store().push(newLabel(name));
    return 1;
  };
  /** Labels each message carries on the server, by UID. */
  const messageLabels = new Map<number, Set<string>>();

  // The account's OWN IMAP connection: plain (uncoloured) labels in its own store.
  const queue = {
    isGmailCapable: () => gmail,
    ensureCategoryLabelsExist: vi.fn(async (cats: Array<{ name: string }>) =>
      cats.reduce((n, c) => n + ensure(label(c.name)), ensure(PARENT))),
    applyCategoryLabels: vi.fn(async (_folder: string, uid: number, op: { categories: Array<{ slug?: string; name: string }> }) => {
      const mirrorCategories = op.categories.filter((category) => !gmail || (category.slug !== 'important' && !(GMAIL_CLASSIFICATION_CATEGORY_SLUGS as readonly string[]).includes(category.slug ?? '')));
      if (mirrorCategories.length) ensure(PARENT);
      const on = messageLabels.get(uid) ?? new Set<string>();
      for (const c of mirrorCategories) { ensure(label(c.name)); on.add(label(c.name)); }
      messageLabels.set(uid, on);
      return 'success';
    }),
    removeGmailLabels: vi.fn(async (_folder: string, uid: number, names: string[]) => {
      for (const name of names) messageLabels.get(uid)?.delete(name);
    }),
    processQueue: vi.fn(async () => undefined),
    renameCategoryLabel: vi.fn(async (from: { name: string }, to: { name: string }) => {
      const target = store().find((l) => l.name === label(from.name));
      if (target && !has(label(to.name))) target.name = label(to.name);
    }),
    removeSarvInboxLabels: vi.fn(async () => {
      const keep = store().filter((l) => l.name !== PARENT && !l.name.startsWith(`${PARENT}/`));
      const removed = store().length - keep.length;
      store().splice(0, store().length, ...keep);
      return removed;
    }),
  };
  const engine = {
    connected: opts.connected ?? true,
    isConnected(): boolean { return this.connected; },
    operationQueue: queue,
  };

  const inbox = { id: `${opts.id}:inbox`, path: 'INBOX', specialUse: '\\Inbox' };
  const folders = gmail ? [inbox, { id: `${opts.id}:all`, path: '[Gmail]/All Mail', specialUse: '\\All' }] : [inbox];
  const emails = (opts.mail ?? []).map(([uid, slug]) =>
    ({ id: `${opts.id}:${uid}`, uid, folderId: inbox.id, tags: addTag('', slug) }));
  const markLabelDone = vi.fn();
  const storage = {
    getCategoryDefinitions: () => DEFS,
    getEmail: async (id: string) => emails.find((email) => email.id === id) ?? null,
    getFolders: async () => folders,
    getFolder: async (id: string) => folders.find((f) => f.id === id) ?? null,
    getEmailsByFolder: async (folderId: string, { limit }: { limit: number }) =>
      (folderId === inbox.id ? emails.slice(0, limit) : []),
    getRepositories: () => ({ agent: { markLabelDone } }),
  };
  h.runtimes.set(opts.id, { storage, syncEngine: engine, smtpClient: null });

  return {
    id: opts.id, email, engine, queue, storage, emails, messageLabels, markLabelDone,
    /** The labels this account's own mail should end up carrying. */
    mailLabels: (opts.mail ?? []).map(([, slug]) => labelForSlug(slug)),
  };
}

const names = (acct: Account): string[] => stores.get(acct.email)!.map((l) => l.name).sort();
const coloured = (acct: Account): string[] => stores.get(acct.email)!.filter((l) => l.color).map((l) => l.name).sort();
const writesTo = (acct: Account): number => restWrites.get(acct.email) ?? 0;
const sorted = (list: string[]): string[] => [...list].sort();

beforeEach(() => {
  resetFakeCoreDb();
  h.runtimes.clear();
  h.grants = [];
  h.refreshFailing.clear();
  h.grantStoreThrows = false;
  h.trace = false;
  h.log.warn = [];
  h.log.trace = [];
  stores.clear();
  restWrites.clear();
  nextLabelId = 0;
  vi.stubGlobal('fetch', fakeGmailApi);
  setCategoryLabelConfig({ enabled: true, folderMode: 'copy' });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---- The four per-account passes ---------------------------------------------

interface Pass {
  name: string;
  /** What every account's store holds before the pass. */
  seed: string[];
  run: () => Promise<unknown>;
  /** What the account's store must hold afterwards. */
  expected: (acct: Account) => string[];
  /** Labels the pass colours through the Gmail API; none for rename and delete. */
  colouredViaApi: (acct: Account) => string[];
}

const PASSES: Pass[] = [
  {
    name: 'provisionCategoryLabels',
    seed: [],
    run: () => provisionCategoryLabels(),
    expected: () => [PARENT, label('Invoices'), label('Travel')],
    colouredViaApi: () => [label('Invoices'), label('Travel')],
  },
  {
    name: 'backfillCategoryLabels',
    seed: [],
    run: () => backfillCategoryLabels(50),
    expected: (acct) => [PARENT, ...acct.mailLabels],
    colouredViaApi: (acct) => acct.mailLabels,
  },
  {
    name: 'renameCategoryLabelEverywhere',
    seed: [PARENT, label('Invoices'), 'Work'],
    run: () => renameCategoryLabelEverywhere('Invoices', 'Bills'),
    expected: () => [PARENT, label('Bills'), 'Work'],
    colouredViaApi: () => [],
  },
  {
    name: 'removeAllCategoryLabels',
    seed: [PARENT, label('Invoices'), label('Travel'), 'Work'],
    run: () => removeAllCategoryLabels(),
    expected: () => ['Work'],
    colouredViaApi: () => [],
  },
];

/** A (the first grant on file) and B, both Gmail; each has mail in one category. */
function twoGmailAccounts(pass: Pass, b: Partial<AccountOptions> = {}): { a: Account; b: Account } {
  const a = addAccount({ id: 'acct-a', email: 'a@gmail.com', auth: 'oauth', seed: pass.seed, mail: [[101, 'invoices']] });
  const bAcct = addAccount({ id: 'acct-b', email: 'b@gmail.com', auth: 'oauth', seed: pass.seed, mail: [[201, 'travel']], ...b });
  return { a, b: bAcct };
}

describe.each(PASSES)('$name with two Gmail accounts', (pass) => {
  // The reported bug: B's pass took the FIRST grant on file, so its labels were
  // created, renamed or deleted in A's mailbox and B's own never changed.
  it("applies each account's change to its OWN mailbox", async () => {
    const { a, b } = twoGmailAccounts(pass);
    await pass.run();
    expect(names(a)).toEqual(sorted(pass.expected(a)));
    expect(names(b)).toEqual(sorted(pass.expected(b)));
    expect(coloured(a)).toEqual(sorted(pass.colouredViaApi(a)));
    expect(coloured(b)).toEqual(sorted(pass.colouredViaApi(b)));
  });

  // The 20 s / 60 s provisioning retries and a second "Apply to recent mail"
  // re-run every pass: a re-run must not duplicate, recreate or re-delete.
  it('is idempotent: a re-run changes nothing and makes no Gmail API writes', async () => {
    const { a, b } = twoGmailAccounts(pass);
    await pass.run();
    const before = { a: names(a), b: names(b), writesA: writesTo(a), writesB: writesTo(b) };
    await pass.run();
    expect({ a: names(a), b: names(b), writesA: writesTo(a), writesB: writesTo(b) }).toEqual(before);
    expect(names(b)).toEqual(sorted(pass.expected(b)));
  });

  // A transient refresh failure (network blip) must degrade to plain IMAP
  // labels on B's own connection, never borrow A's grant, and must not stick:
  // the next pass after the refresh recovers uses B's own token.
  it("a failing token refresh for B falls back to B's own IMAP, then recovers", async () => {
    const { a, b } = twoGmailAccounts(pass);
    h.refreshFailing.set(b.email, new Error('token refresh failed: ETIMEDOUT'));
    await pass.run();
    expect(names(a)).toEqual(sorted(pass.expected(a)));
    expect(names(b)).toEqual(sorted(pass.expected(b)));
    expect(coloured(b)).toEqual([]);
    expect(writesTo(b)).toBe(0);
    expect(h.log.warn.some((l) => l.includes('token fetch failed for b@gmail.com'))).toBe(true);

    h.refreshFailing.clear();
    await pass.run();
    expect(names(a)).toEqual(sorted(pass.expected(a)));
    expect(names(b)).toEqual(sorted(pass.expected(b)));
    expect(coloured(b)).toEqual(sorted(pass.colouredViaApi(b)));
  });

  // An offline account is left for a later pass. It must not be handled through
  // another account's token, and it must catch up once it connects.
  it('skips an offline account and catches it up once it connects', async () => {
    const { a, b } = twoGmailAccounts(pass, { connected: false });
    await pass.run();
    expect(names(a)).toEqual(sorted(pass.expected(a)));
    expect(names(b)).toEqual(sorted(pass.seed));
    expect(writesTo(b)).toBe(0);

    b.engine.connected = true;
    await pass.run();
    expect(names(b)).toEqual(sorted(pass.expected(b)));
    expect(names(a)).toEqual(sorted(pass.expected(a)));
  });

  // Fail closed: an app-password Gmail account has no grant of its own. The old
  // fallback handed it the first grant on file (A's), so its pass acted on A.
  it("gives an app-password Gmail account plain IMAP labels, never A's grant", async () => {
    const { a, b } = twoGmailAccounts(pass, { auth: 'password' });
    await pass.run();
    expect(names(a)).toEqual(sorted(pass.expected(a)));
    expect(names(b)).toEqual(sorted(pass.expected(b)));
    expect(coloured(b)).toEqual([]);
  });

  // Fail closed: a runtime with no registry row has no known address. A missing
  // address must mean "no token", not "the first grant on file".
  it('gives an account with no registry address plain IMAP labels', async () => {
    const { a, b } = twoGmailAccounts(pass, { inRegistry: false });
    await pass.run();
    expect(names(a)).toEqual(sorted(pass.expected(a)));
    expect(names(b)).toEqual(sorted(pass.expected(b)));
    expect(coloured(b)).toEqual([]);
    expect(writesTo(b)).toBe(0);
  });

  // The everyday setup: a non-Gmail account (sarv.com active) next to a Gmail
  // one. Each gets the pass on its own server, and only the Gmail account's
  // own grant touches the Gmail API.
  it('handles a non-Gmail account over its own IMAP next to a Gmail one', async () => {
    const { a, b: other } = twoGmailAccounts(pass, { email: 'rc@example.com', auth: 'password', gmail: false });
    await pass.run();
    expect(names(a)).toEqual(sorted(pass.expected(a)));
    expect(coloured(a)).toEqual(sorted(pass.colouredViaApi(a)));
    expect(names(other)).toEqual(sorted(pass.expected(other)));
    expect(coloured(other)).toEqual([]);
    expect(writesTo(other)).toBe(0);
  });
});

describe('what the passes report', () => {
  // The provisioning log and the Settings result count what was created; with
  // the shared token B's pass found A's labels already there and reported 0.
  it('provisionCategoryLabels counts both mailboxes', async () => {
    twoGmailAccounts(PASSES[0]);
    // Per account: the parent plus two categories.
    expect(await provisionCategoryLabels()).toEqual({ accounts: 2, created: 6 });
  });

  // The Settings "Delete all Sarv Inbox labels" result: with the shared token it
  // reported only A's removals while B's labels stayed on the server.
  it('removeAllCategoryLabels counts what it removed from each mailbox', async () => {
    twoGmailAccounts(PASSES[3]);
    // Per account: the parent plus two category labels; 'Work' is not ours.
    expect(await removeAllCategoryLabels()).toEqual({ accounts: 2, removed: 6 });
  });

  // One label per mail across both accounts, each on its own server.
  it('backfillCategoryLabels labels each mail on its own account', async () => {
    const { a, b } = twoGmailAccounts(PASSES[1]);
    expect(await backfillCategoryLabels(50)).toEqual({ accounts: 2, labeled: 2 });
    expect([...a.messageLabels.get(101)!]).toEqual([label('Invoices')]);
    expect([...b.messageLabels.get(201)!]).toEqual([label('Travel')]);
  });
});

describe('provisionCategoryLabelsOnConnect', () => {
  // The connect trigger provisions ONE account; with the shared token a
  // background account's connect provisioned the first mailbox instead.
  it("provisions the connecting account's own mailbox and leaves the other alone", async () => {
    const a = addAccount({ id: 'acct-a-connect', email: 'a@gmail.com', auth: 'oauth' });
    const b = addAccount({ id: 'acct-b-connect', email: 'b@gmail.com', auth: 'oauth' });
    provisionCategoryLabelsOnConnect(b.id);
    await vi.waitFor(() => expect(coloured(b)).toEqual([label('Invoices'), label('Travel')]));
    expect(names(b)).toEqual([PARENT, label('Invoices'), label('Travel')]);
    expect(names(a)).toEqual([]);
    expect(writesTo(a)).toBe(0);
  });
});

describe('single Gmail account (behaviour unchanged)', () => {
  // The common one-account setup must still get coloured labels through the
  // Gmail API with its own grant, not plain IMAP labels.
  it('provisions coloured labels through the Gmail API', async () => {
    const only = addAccount({ id: 'acct-only', email: 'only@gmail.com', auth: 'oauth' });
    expect(await provisionCategoryLabels()).toEqual({ accounts: 1, created: 3 });
    expect(names(only)).toEqual([PARENT, label('Invoices'), label('Travel')]);
    expect(coloured(only)).toEqual([label('Invoices'), label('Travel')]);
    expect(only.queue.ensureCategoryLabelsExist).not.toHaveBeenCalled();
  });

  // A grant stored under a differently-cased address is still that account's.
  it('matches its grant case-insensitively', async () => {
    const only = addAccount({ id: 'acct-only', email: 'Only@Gmail.com', auth: 'oauth' }); // registry keeps this casing
    h.grants = [{ provider: 'gmail', email: 'ONLY@gmail.com' }];
    await provisionCategoryLabels();
    expect(coloured(only)).toEqual([label('Invoices'), label('Travel')]);
  });
});

describe('when the grant store cannot be read', () => {
  // An unreadable OAuth store (e.g. Linux with no keyring) must not throw into
  // the pass: every account falls back to plain labels on its own connection.
  it('falls back to plain IMAP labels on every account', async () => {
    const { a, b } = twoGmailAccounts(PASSES[0]);
    h.grantStoreThrows = true;
    expect(await provisionCategoryLabels()).toEqual({ accounts: 2, created: 6 });
    expect(names(a)).toEqual([PARENT, label('Invoices'), label('Travel')]);
    expect(names(b)).toEqual([PARENT, label('Invoices'), label('Travel')]);
    expect(coloured(a)).toEqual([]);
    expect(coloured(b)).toEqual([]);
    expect(h.log.warn.some((l) => l.includes('resolveGmailToken error'))).toBe(true);
  });
});

describe('token trace logging', () => {
  // With SARV_LOG_LEVEL=trace, the trace must say whose grant each account got,
  // or why it got none, so a wrong-mailbox report can be diagnosed from app.log.
  it("names each account's own grant, or why there is none", async () => {
    h.trace = true;
    addAccount({ id: 'acct-a', email: 'a@gmail.com', auth: 'oauth' });
    addAccount({ id: 'acct-b', email: 'b@gmail.com', auth: 'password' });
    addAccount({ id: 'acct-c', email: 'c@gmail.com', auth: 'oauth', inRegistry: false });
    addAccount({ id: 'acct-d', email: 'd@gmail.com', auth: 'oauth' });
    h.refreshFailing.set('d@gmail.com', new Error('token refresh failed: ETIMEDOUT'));
    const legacy = addAccount({
      id: '__default__', email: 'legacy@gmail.com', auth: 'oauth', inRegistry: false, mail: [[301, 'invoices']],
    });
    await provisionCategoryLabels();
    await mirrorCategoryLabels(legacy.storage, legacy.emails[0], ['invoices']);
    expect(h.log.trace).toEqual(expect.arrayContaining([
      expect.stringContaining('token=yes (a@gmail.com)'),
      expect.stringContaining('no gmail OAuth grant for b@gmail.com'),
      expect.stringContaining('no address for acct=acct-c'),
      expect.stringContaining('token=no (d@gmail.com)'),
      expect.stringContaining('no address for acct=default'),
    ]));
    expect(h.log.trace.some((l) => l.includes('token=yes') && !l.includes('(a@gmail.com)'))).toBe(false);
  });
});

// ---- The categorization path -------------------------------------------------

describe('mirrorCategoryLabels (a freshly categorized mail)', () => {
  // The mirror used the pipeline's profile address, which is the ACTIVE
  // account, so a background Gmail account's mail was labelled through the
  // active account's grant. With a non-Gmail profile (e.g. sarv.com) it fell
  // back to the first grant on file. B's own grant in every case.
  it.each(['a@gmail.com', 'rc@sarv.com'])(
    "labels a background account's mail with its own grant (profile address %j)",
    async (profile) => {
      const a = addAccount({ id: 'acct-a', email: 'a@gmail.com', auth: 'oauth' });
      const b = addAccount({ id: 'acct-b', email: 'b@gmail.com', auth: 'oauth', mail: [[201, 'travel']] });
      setPipelineUserProfile({ userEmail: profile });
      await mirrorCategoryLabels(b.storage, b.emails[0], ['travel']);
      expect(names(b)).toEqual([PARENT, label('Travel')]);
      expect(coloured(b)).toEqual([label('Travel')]);
      expect([...b.messageLabels.get(201)!]).toEqual([label('Travel')]);
      expect(b.markLabelDone).toHaveBeenCalledWith(b.emails[0].id);
      expect(names(a)).toEqual([]);
      expect(writesTo(a)).toBe(0);
    },
  );

  // Every re-categorization and every drain tick mirrors again: a repeat must
  // leave the mailbox as it is and make no Gmail API writes.
  it('is idempotent across repeated mirrors of the same mail', async () => {
    const b = addAccount({ id: 'acct-b', email: 'b@gmail.com', auth: 'oauth', mail: [[201, 'travel']] });
    await mirrorCategoryLabels(b.storage, b.emails[0], ['travel']);
    const writes = writesTo(b);
    await mirrorCategoryLabels(b.storage, b.emails[0], ['travel']);
    expect(names(b)).toEqual([PARENT, label('Travel')]);
    expect(writesTo(b)).toBe(writes);
  });

  // Fail closed on the hot path too: no grant of its own means plain labels on
  // the account's own connection, never the other account's grant.
  it("labels an app-password Gmail account over its own IMAP, never A's grant", async () => {
    setPipelineUserProfile({ userEmail: 'a@gmail.com' });
    const a = addAccount({ id: 'acct-a', email: 'a@gmail.com', auth: 'oauth' });
    const b = addAccount({ id: 'acct-b', email: 'b@gmail.com', auth: 'password', mail: [[201, 'travel']] });
    await mirrorCategoryLabels(b.storage, b.emails[0], ['travel']);
    expect(names(b)).toEqual([PARENT, label('Travel')]);
    expect(coloured(b)).toEqual([]);
    expect(names(a)).toEqual([]);
  });

  // Transient: a failed refresh labels plain for now; the next mirror after
  // the refresh recovers colours the label with B's own grant. The refresh
  // here rejects with a bare string, not an Error, and the warning must still
  // say whose token failed and why.
  it('falls back to plain labels while the refresh fails, then colours on recovery', async () => {
    const a = addAccount({ id: 'acct-a', email: 'a@gmail.com', auth: 'oauth' });
    const b = addAccount({ id: 'acct-b', email: 'b@gmail.com', auth: 'oauth', mail: [[201, 'travel']] });
    h.refreshFailing.set(b.email, 'ETIMEDOUT');
    await mirrorCategoryLabels(b.storage, b.emails[0], ['travel']);
    expect(names(b)).toEqual([PARENT, label('Travel')]);
    expect(coloured(b)).toEqual([]);
    expect(h.log.warn.some((l) => l.includes('token fetch failed for b@gmail.com') && l.includes('ETIMEDOUT'))).toBe(true);

    h.refreshFailing.clear();
    await mirrorCategoryLabels(b.storage, b.emails[0], ['travel']);
    expect(coloured(b)).toEqual([label('Travel')]);
    expect(names(a)).toEqual([]);
  });

  // A non-Gmail account's mail is labelled on its own server over IMAP; it has
  // no Gmail grant to use and must not reach the Gmail account's mailbox.
  it("labels a non-Gmail account's mail over its own IMAP, with no grant", async () => {
    const a = addAccount({ id: 'acct-a', email: 'a@gmail.com', auth: 'oauth' });
    const other = addAccount({ id: 'acct-x', email: 'rc@example.com', auth: 'password', gmail: false, mail: [[401, 'travel']] });
    await mirrorCategoryLabels(other.storage, other.emails[0], ['travel']);
    expect(names(other)).toEqual([PARENT, label('Travel')]);
    expect([...other.messageLabels.get(401)!]).toEqual([label('Travel')]);
    expect(other.queue.removeGmailLabels).not.toHaveBeenCalled();
    expect(names(a)).toEqual([]);
    expect(writesTo(a)).toBe(0);
  });

  // The pre-account default slot has an engine but no account id, so its
  // owner is unknown: plain labels on its own engine, no grant used at all.
  // A is then the SOLE registry account, so the lenient identity resolver
  // (sole-account fallback) would have picked A's grant here.
  it('uses no grant for mail in the unclaimed default slot', async () => {
    const a = addAccount({ id: 'acct-a', email: 'a@gmail.com', auth: 'oauth' });
    const legacy = addAccount({
      id: '__default__', email: 'legacy@gmail.com', auth: 'oauth', inRegistry: false, mail: [[301, 'invoices']],
    });
    await mirrorCategoryLabels(legacy.storage, legacy.emails[0], ['invoices']);
    expect(names(legacy)).toEqual([PARENT, label('Invoices')]);
    expect(coloured(legacy)).toEqual([]);
    expect(writesTo(legacy)).toBe(0);
    expect(names(a)).toEqual([]);
    expect(writesTo(a)).toBe(0);
  });
});

const classificationDeferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};

describe('automatic mirrors respect explicit category mutations', () => {
  it('ignores a stale mirror whose message no longer has an identity', async () => {
    const b = addAccount({ id: 'acct-b', email: 'b@gmail.com', auth: 'oauth' });
    await mirrorCategoryLabels(b.storage, {}, ['travel']);
    expect(b.queue.applyCategoryLabels).not.toHaveBeenCalled();
    expect(b.markLabelDone).not.toHaveBeenCalled();
  });

  // Regression: linked localized Spam is still provider Spam while its primary mailbox is INBOX.
  it('skips a linked localized Junk message despite a previous ham verdict', async () => {
    const b = addAccount({ id: 'acct-b', email: 'b@gmail.com', auth: 'oauth', mail: [[201, 'travel']] });
    const row = b.emails[0] as any;
    row.tags = '|INBOX|[Gmail]/Correo no deseado|spam|'; row.spamUserVerdict = 'ham';
    const folders = await b.storage.getFolders();
    vi.spyOn(b.storage, 'getFolders').mockResolvedValue([...folders, { id: 'junk', path: '[Gmail]/Correo no deseado', specialUse: '\\Junk' }]);
    await mirrorCategoryLabels(b.storage, row, ['travel']);
    expect(b.queue.applyCategoryLabels).not.toHaveBeenCalled();
    expect(writesTo(b)).toBe(0);
  });

  it('finishes a token-paused mirror before a later explicit clear, leaving the clear last', async () => {
    const b = addAccount({ id: 'acct-b', email: 'b@gmail.com', auth: 'oauth', mail: [[201, 'travel']] });
    const entered = classificationDeferred();
    const release = classificationDeferred();
    const token = vi.spyOn(oauthService, 'getValidAccessToken').mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      return `token-for:${b.email}`;
    });
    const row = b.emails[0] as any;
    const storage = Object.assign(b.storage, {
      setEmailManualCategories: (_id: string, categories: string[]) => {
        row.tags = categories.map((category) => `|${category}`).join('') + '|';
        row.manualCategories = [...categories];
      },
    });
    const manualEngine = {
      assertManualCategorySync: vi.fn(),
      markImportant: vi.fn(async () => 'success' as const),
      setCategorySelection: vi.fn(async (_path: string, uid: number, data: { remove: Array<{ name: string }>; apply: Array<{ name: string }> }) => {
        const labels = b.messageLabels.get(uid) ?? new Set<string>();
        data.remove.forEach((category) => labels.delete(label(category.name)));
        data.apply.forEach((category) => labels.add(label(category.name)));
        b.messageLabels.set(uid, labels);
        return 'success' as const;
      }),
    };
    try {
      const mirror = mirrorCategoryLabels(storage, row, ['travel']);
      await entered.promise;
      const clear = changeEmailCategory(storage, manualEngine, row.id, 'travel', false);
      await Promise.resolve();
      expect(manualEngine.setCategorySelection).not.toHaveBeenCalled();
      release.resolve();
      await Promise.all([mirror, clear]);
      expect(b.queue.applyCategoryLabels.mock.invocationCallOrder[0]).toBeLessThan(manualEngine.setCategorySelection.mock.invocationCallOrder[0]);
      expect([...b.messageLabels.get(201)!]).toEqual([]);
      expect(row.manualCategories).toEqual([]);
      await mirrorCategoryLabels(storage, row, ['travel']); // a queued/stale AI result cannot put it back
      expect(b.queue.applyCategoryLabels).toHaveBeenCalledOnce();
    } finally { token.mockRestore(); }
  });

  it.each(['manual-clear', 'provider', 'unknown', 'spam', 'missing', 'moved', 'folder-moved'])('rechecks %s state after awaited Gmail colours and does not finalize a skipped mirror', async (state) => {
    const b = addAccount({ id: 'acct-b', email: 'b@gmail.com', auth: 'oauth', mail: [[201, 'travel']] });
    const row = b.emails[0] as any;
    const getEmail = vi.spyOn(b.storage, 'getEmail');
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      if (state === 'manual-clear') row.manualCategories = [];
      else if (state === 'provider') row.serverCategories = ['invoices'];
      else if (state === 'unknown') row.gmailCategoriesPending = true;
      else if (state === 'spam') row.tags = '|spam|';
      else if (state === 'missing') getEmail.mockResolvedValue(null);
      else if (state === 'folder-moved') row.folderId = 'different-folder';
      else row.uid = 999;
      return fakeGmailApi(url, init);
    });
    await mirrorCategoryLabels(b.storage, { ...row }, ['travel']);
    expect(b.queue.applyCategoryLabels).not.toHaveBeenCalled();
    expect(b.queue.removeGmailLabels).not.toHaveBeenCalled();
    expect(b.markLabelDone).not.toHaveBeenCalled();
  });

  it.each(['provider', 'spam'])('rechecks %s protection before stale-label removal after an awaited apply', async (state) => {
    const b = addAccount({ id: 'acct-b', email: 'b@gmail.com', auth: 'oauth', mail: [[201, 'travel']] });
    b.queue.applyCategoryLabels.mockImplementationOnce(async () => {
      if (state === 'provider') (b.emails[0] as any).serverCategories = ['invoices'];
      else (b.emails[0] as any).tags = '|spam|';
      return 'success';
    });
    await mirrorCategoryLabels(b.storage, b.emails[0], ['travel']);
    expect(b.queue.applyCategoryLabels).toHaveBeenCalledOnce();
    expect(b.queue.removeGmailLabels).not.toHaveBeenCalled();
    expect(b.markLabelDone).not.toHaveBeenCalled();
  });

  it.each(['manual', 'provider', 'unknown', 'spam', 'missing', 'moved'])('skips already %s mail before Gmail or IMAP writes', async (state) => {
    const b = addAccount({ id: 'acct-b', email: 'b@gmail.com', auth: 'oauth', mail: [[201, 'travel']] });
    const row = b.emails[0] as any;
    const stale = { ...row };
    if (state === 'manual') row.manualCategories = [];
    else if (state === 'provider') row.serverCategories = ['invoices'];
    else if (state === 'unknown') row.gmailCategoriesPending = true;
    else if (state === 'spam') row.tags = '|spam|';
    else if (state === 'missing') vi.spyOn(b.storage, 'getEmail').mockResolvedValue(null);
    else row.folderId = 'different-folder';
    await mirrorCategoryLabels(b.storage, stale, ['travel']);
    expect(writesTo(b)).toBe(0);
    expect(b.queue.applyCategoryLabels).not.toHaveBeenCalled();
    expect(b.queue.removeGmailLabels).not.toHaveBeenCalled();
    expect(b.markLabelDone).not.toHaveBeenCalled();
  });
});

describe('native Gmail categories do not create app mirrors', () => {
  // Regression: ignored Gmail native tabs must not be used when mirroring the app's Social classification.
  it('colors and keeps an app Social mirror separately from native categories', async () => {
    const b = addAccount({ id: 'acct-b', email: 'b@gmail.com', auth: 'oauth', mail: [[201, 'travel']] });
    vi.spyOn(b.storage, 'getCategoryDefinitions').mockReturnValue([{ slug: 'social', name: 'Social', color: '#123456', isEnabled: 1 }]);
    await mirrorCategoryLabels(b.storage, b.emails[0], ['social']);
    expect(names(b)).toEqual([PARENT, label('Social')]);
    expect(coloured(b)).toEqual([label('Social')]);
    expect([...b.messageLabels.get(201)!]).toEqual([label('Social')]);
    expect(b.queue.removeGmailLabels).not.toHaveBeenCalled();
  });

  it.each([{ slugs: ['important'] }, { slugs: ['promotions'] }])('queues native intent and removes old native mirrors for %j', async ({ slugs }) => {
    const b = addAccount({ id: 'acct-b', email: 'b@gmail.com', auth: 'oauth', mail: [[201, 'travel']] });
    const definitions = slugs.map((slug) => ({ slug, name: slug, color: '#123456', isEnabled: 1 }));
    vi.spyOn(b.storage, 'getCategoryDefinitions').mockReturnValue(definitions);
    await mirrorCategoryLabels(b.storage, b.emails[0], slugs);
    expect(writesTo(b)).toBe(0);
    expect(b.queue.applyCategoryLabels).toHaveBeenCalledWith('INBOX', 201, expect.objectContaining({ categories: definitions.map(({ slug, name }) => ({ slug, name })) }));
    expect(b.queue.removeGmailLabels).toHaveBeenCalledWith('INBOX', 201, slugs.map(label));
  });

  it('colors custom mirrors while retaining native intent and removing old native mirrors', async () => {
    const b = addAccount({ id: 'acct-b', email: 'b@gmail.com', auth: 'oauth', mail: [[201, 'travel']] });
    vi.spyOn(b.storage, 'getCategoryDefinitions').mockReturnValue([...DEFS, { slug: 'important', name: 'Important', color: '#123456', isEnabled: 1 }]);
    await mirrorCategoryLabels(b.storage, b.emails[0], ['important', 'travel']);
    expect(coloured(b)).toEqual([label('Travel')]);
    expect(names(b)).not.toContain(label('Important'));
    expect(b.queue.applyCategoryLabels).toHaveBeenCalledWith('INBOX', 201, expect.objectContaining({ categories: [{ slug: 'important', name: 'Important' }, { slug: 'travel', name: 'Travel' }] }));
    expect(b.queue.removeGmailLabels).toHaveBeenCalledWith('INBOX', 201, expect.arrayContaining([label('Important')]));
    expect(b.queue.removeGmailLabels.mock.calls[0][2]).not.toContain(label('Travel'));
  });
});
