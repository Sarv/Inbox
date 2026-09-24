import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Per-account runtime factory + the userData housekeeping around it.
 *
 * Pinned invariants:
 *   - DB filenames are DETERMINISTIC and hashed (same id -> same file, different
 *     id -> different file, no email in the name),
 *   - `sarvinbox.db` is only ever adopted by the RECORDED primary and never
 *     re-created,
 *   - the primary pointer migrates out of the legacy JSON file exactly once,
 *   - the orphan/stale sweeps only delete files they can prove are dead (known
 *     names, SQLite magic, stale mtime).
 */

const h = vi.hoisted(() => ({
  userData: '',
  dbKey: 'deadbeef',
  storages: [] as Array<{
    opts: Record<string, unknown>; initialized: boolean; closed: boolean; closeThrows: boolean;
    /** Listener the runtime attached for read-model badge repairs, if any. */
    folderCountsListener: ((folderPaths: string[]) => void) | null;
  }>,
  /** Every SyncEngine the runtime built, oldest first. */
  engines: [] as Array<{ reputationLookup: unknown }>,
  /** Every sendToWindow(channel, payload) the runtime made. */
  sent: [] as Array<[string, unknown]>,
  runtimes: new Map<string, { storage: unknown; syncEngine: unknown; smtpClient: unknown }>(),
  claimSucceeds: true,
  claimed: [] as string[],
  rekeyedRuntimes: [] as Array<[string, string]>,
  unregistered: [] as string[],
  secretsDeleted: [] as string[],
  secretsRekeyed: [] as Array<[string, string]>,
  secretsDeleteThrows: false,
}));

vi.mock('electron', () => ({
  app: { getPath: () => h.userData, getName: () => 'Sarv Inbox Test', isPackaged: false },
}));

vi.mock('@sarvinbox/core', async () => ({
  // The real reader of the blocklist settings: pure, and what decides whether
  // the stage below is built at all.
  readBlocklistPrefs: (await import('../../../../../../packages/core/src/utils/blocklist-prefs')).readBlocklistPrefs,
  createLogger: () => ({
    info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, trace: () => {},
  }),
  SyncEngine: class {
    storage: unknown;
    // Recorded, not ignored: every account's engine must be handed the shared
    // blocklist lookup, or that account's mail is scored on less evidence than
    // the rest without anything reporting it.
    reputationLookup: unknown = null;
    constructor(storage: unknown) { this.storage = storage; h.engines.push(this as never); }
    setReputationLookup(fn: unknown): void { this.reputationLookup = fn; }
  },
  // The blocklist stage itself. Blocklists are on by default (2026-09-23), so
  // every test here builds one; it answers "no opinion" and asks nobody.
  ReputationStage: class {
    constructor(public config: unknown) {}
    async assess(): Promise<null> { return null; }
  },
}));

// Async factory on purpose: the sweep needs the REAL shared-directory
// filename. Hard-coding it in the mock would let a rename in storage-node
// silently re-arm the delete that wiped the address book once already.
vi.mock('@sarvinbox/storage-node', async () => ({
  SHARED_CONTACTS_FILE: (await import('../../../../../../packages/storage-node/src/shared-contacts'))
    .SHARED_CONTACTS_FILE,
  SQLiteStorage: class {
    opts: Record<string, unknown>;
    entry: (typeof h.storages)[number];
    constructor(opts: Record<string, unknown>) {
      this.opts = opts;
      this.entry = { opts, initialized: false, closed: false, closeThrows: false, folderCountsListener: null };
      h.storages.push(this.entry);
    }
    async initialize(): Promise<void> { this.entry.initialized = true; }
    setFolderCountsListener(listener: ((folderPaths: string[]) => void) | null): void {
      this.entry.folderCountsListener = listener;
    }
    async close(): Promise<void> {
      if (this.entry.closeThrows) throw new Error('close failed');
      this.entry.closed = true;
    }
  },
}));

vi.mock('../../../../electron/services/db-key-store', () => ({ getDbEncryptionKey: () => h.dbKey }));

vi.mock('../../../../electron/services/core-db', async () => await import('../../../../electron/services/__testing__/fake-core-db'));

vi.mock('../../../../electron/services/secure-credential-store', () => ({
  deleteAccountSecrets: async (id: string) => {
    if (h.secretsDeleteThrows) throw new Error('vault locked');
    h.secretsDeleted.push(id);
  },
  rekeyAccountSecrets: async (oldId: string, newId: string) => {
    h.secretsRekeyed.push([oldId, newId]);
  },
}));

vi.mock('../../../../electron/shared', () => ({
  claimDefaultRuntime: (accountId: string) => {
    h.claimed.push(accountId);
    if (!h.claimSucceeds) return false;
    h.runtimes.set(accountId, { storage: { claimed: true }, syncEngine: {}, smtpClient: null });
    return true;
  },
  getAccountRuntime: (accountId: string) => h.runtimes.get(accountId),
  hasAccountRuntime: (accountId: string) => h.runtimes.has(accountId),
  registerAccountRuntime: (accountId: string, rt: { storage: unknown; syncEngine: unknown; smtpClient: unknown }) => {
    h.runtimes.set(accountId, rt);
  },
  rekeyRuntime: (oldId: string, newId: string) => { h.rekeyedRuntimes.push([oldId, newId]); },
  getAccountIdForStorage: (storage: unknown) => {
    for (const [accountId, runtime] of h.runtimes) if (runtime.storage === storage) return accountId;
    return null;
  },
  sendToWindow: (channel: string, payload: unknown) => { h.sent.push([channel, payload]); },
  unregisterRuntime: (accountId: string) => { h.unregistered.push(accountId); h.runtimes.delete(accountId); },
}));

import { SHARED_CONTACTS_FILE } from '../../../../../../packages/storage-node/src/shared-contacts';
import { resetFakeCoreDb, state as dbState } from '../../../../electron/services/__testing__/fake-core-db';
import {
  PRIMARY_DB_FILE,
  accountDbExists,
  accountInboxUnread,
  canResolveAccountRuntimes,
  cleanupOrphanedAccountDbs,
  cleanupStaleUserDataArtifacts,
  clearPrimaryAccountId,
  createAccountRuntime,
  dbFileForAccount,
  deleteAccountData,
  ensureAccountRuntime,
  isAccountUnderMaintenance,
  legacyDbExists,
  loadPrimaryAccountId,
  quiesceAccountRuntime,
  rekeyAccount,
  releaseAccountMaintenance,
  renameAccountDbFiles,
  savePrimaryAccountId,
} from '../../../../electron/services/accounts-runtime';

const SQLITE_MAGIC = Buffer.concat([Buffer.from('SQLite format 3\0', 'latin1'), Buffer.alloc(16)]);

const touch = (name: string, content: Buffer | string = 'x'): string => {
  const p = join(h.userData, name);
  writeFileSync(p, content);
  return p;
};

/** Push a file's mtime into the past so the stale-guard treats it as dead. */
const age = (name: string, ms: number): void => {
  const when = (Date.now() - ms) / 1000;
  utimesSync(join(h.userData, name), when, when);
};

beforeAll(() => {
  h.userData = mkdtempSync(join(tmpdir(), 'sarvinbox-runtime-'));
});

beforeEach(() => {
  resetFakeCoreDb();
  h.storages.length = 0;
  h.engines.length = 0;
  h.sent.length = 0;
  h.runtimes.clear();
  h.claimSucceeds = true;
  h.claimed.length = 0;
  h.rekeyedRuntimes.length = 0;
  h.unregistered.length = 0;
  h.secretsDeleted.length = 0;
  h.secretsRekeyed.length = 0;
  h.secretsDeleteThrows = false;
  h.dbKey = 'deadbeef';
  rmSync(h.userData, { recursive: true, force: true });
  mkdirSync(h.userData, { recursive: true });
});

afterAll(() => {
  rmSync(h.userData, { recursive: true, force: true });
});

describe('accountInboxUnread', () => {
  it('reads the INBOX folder by specialUse, then by a case-insensitive path', () => {
    expect(accountInboxUnread([
      { specialUse: '\\Inbox', unreadCount: 7 },
      { path: 'Archive', unreadCount: 99 },
    ])).toBe(7);
    expect(accountInboxUnread([{ path: 'INBOX', unreadCount: 3 }])).toBe(3);
    expect(accountInboxUnread([{ path: 'inbox', unreadCount: 4 }])).toBe(4);
  });

  it('never adds non-INBOX label/folder unread in', () => {
    expect(accountInboxUnread([
      { path: 'INBOX', unreadCount: 2 },
      { path: 'Work', unreadCount: 40 },
      { specialUse: '\\Junk', unreadCount: 500 },
    ])).toBe(2);
  });

  it('is 0 with no inbox, no count, or no folders at all', () => {
    expect(accountInboxUnread([{ path: 'Archive', unreadCount: 5 }])).toBe(0);
    expect(accountInboxUnread([{ path: 'INBOX' }])).toBe(0);
    expect(accountInboxUnread([])).toBe(0);
    expect(accountInboxUnread([{ specialUse: null, unreadCount: 1 }])).toBe(0);
  });
});

describe('dbFileForAccount', () => {
  it('is deterministic, hashed to 32 hex chars, and leaks no email', () => {
    const id = 'acct-user-example-com--imap-example-com';
    const file = dbFileForAccount(id);
    expect(file).toBe(dbFileForAccount(id));
    expect(file).toMatch(/^sarvinbox-[0-9a-f]{32}\.db$/);
    expect(file).not.toContain('user');
    expect(file).not.toContain('example');
  });

  it('maps distinct ids (same address, different host) to distinct files', () => {
    expect(dbFileForAccount('acct-a--imap.example.com'))
      .not.toBe(dbFileForAccount('acct-a--imap.gmail.com'));
  });

  it('is never the primary or core filename', () => {
    for (const id of ['acct-a', 'acct-b', '']) {
      expect([PRIMARY_DB_FILE, 'sarvinbox-core.db']).not.toContain(dbFileForAccount(id));
    }
  });
});

describe('createAccountRuntime', () => {
  it('opens the DB under userData with the shared encryption key', async () => {
    const rt = await createAccountRuntime('sarvinbox-abc.db');
    expect(h.storages[0].opts).toMatchObject({
      dbPath: join(h.userData, 'sarvinbox-abc.db'),
      readonly: false,
      verbose: false,
      key: 'deadbeef',
    });
    expect(h.storages[0].initialized).toBe(true);
    expect(rt.smtpClient).toBeNull();
    expect(rt.syncEngine).toBeTruthy();
  });

  // Every account's storage must be wired to push a badge refresh: the read
  // model repairs `folders.unread_count` in the background, and without this the
  // sidebar keeps rendering the stale number until something else happens to
  // reload folders — the "Inbox 7 over an empty list" report, one layer up.
  it('wires the read-model badge repair to a renderer refresh', async () => {
    const rt = await createAccountRuntime('sarvinbox-abc.db');
    h.runtimes.set('acct-owner', { storage: rt.storage, syncEngine: {}, smtpClient: null });

    expect(h.storages[0].folderCountsListener).toBeTypeOf('function');
    h.storages[0].folderCountsListener!(['INBOX']);

    expect(h.sent).toEqual([['folders:updated', { accountId: 'acct-owner' }]]);
  });

  it('gives the legacy primary DB the big page cache and everyone else the modest one', async () => {
    await createAccountRuntime(PRIMARY_DB_FILE);
    await createAccountRuntime('sarvinbox-other.db');
    expect(h.storages[0].opts.cacheSizeKb).toBe(32768);
    expect(h.storages[1].opts.cacheSizeKb).toBe(8192);
  });
});

describe('the primary-account pointer', () => {
  it('round-trips through the core DB', () => {
    expect(loadPrimaryAccountId()).toBeNull();
    savePrimaryAccountId('acct-a');
    expect(loadPrimaryAccountId()).toBe('acct-a');
    expect(canResolveAccountRuntimes()).toBe(true);
  });

  it('migrates the legacy primary-account.json exactly once, then deletes it', () => {
    touch('primary-account.json', JSON.stringify({ id: 'acct-legacy' }));
    expect(loadPrimaryAccountId()).toBe('acct-legacy');
    expect(existsSync(join(h.userData, 'primary-account.json'))).toBe(false);
    expect(dbState.meta.get('primary_account_id')).toBe('acct-legacy');
    // Second read comes from the DB (the file is gone).
    expect(loadPrimaryAccountId()).toBe('acct-legacy');
  });

  it('ignores a legacy file with no usable id and never invents one', () => {
    touch('primary-account.json', JSON.stringify({ id: 42 }));
    expect(loadPrimaryAccountId()).toBeNull();
    expect(dbState.meta.has('primary_account_id')).toBe(false);
    // The unparseable file is left in place for a human to inspect.
    expect(existsSync(join(h.userData, 'primary-account.json'))).toBe(true);

    touch('primary-account.json', 'not json at all');
    expect(loadPrimaryAccountId()).toBeNull();
  });

  it('is null when nothing has been recorded (fresh install)', () => {
    expect(loadPrimaryAccountId()).toBeNull();
    expect(canResolveAccountRuntimes()).toBe(false);
  });

  it('clear() forgets the pointer and removes any legacy file', () => {
    savePrimaryAccountId('acct-a');
    touch('primary-account.json', JSON.stringify({ id: 'acct-a' }));
    clearPrimaryAccountId();
    expect(dbState.meta.has('primary_account_id')).toBe(false);
    expect(existsSync(join(h.userData, 'primary-account.json'))).toBe(false);
    // Idempotent when the file is already gone.
    expect(() => clearPrimaryAccountId()).not.toThrow();
  });
});

describe('legacyDbExists / accountDbExists', () => {
  it('reports the legacy primary DB only when the file is on disk', () => {
    expect(legacyDbExists()).toBe(false);
    touch(PRIMARY_DB_FILE);
    expect(legacyDbExists()).toBe(true);
  });

  it('reports a per-account DB by its hashed filename, and is false for an empty id', () => {
    expect(accountDbExists('acct-a')).toBe(false);
    touch(dbFileForAccount('acct-a'));
    expect(accountDbExists('acct-a')).toBe(true);
    expect(accountDbExists('')).toBe(false);
  });
});

describe('ensureAccountRuntime', () => {
  it('returns an already-open runtime without touching the disk', async () => {
    const existing = { storage: { tag: 'open' }, syncEngine: {}, smtpClient: null };
    h.runtimes.set('acct-a', existing);
    await expect(ensureAccountRuntime('acct-a')).resolves.toBe(existing);
    expect(h.storages).toHaveLength(0);
  });

  it('refuses to guess while a legacy sarvinbox.db exists with no recorded owner', async () => {
    touch(PRIMARY_DB_FILE);
    await expect(ensureAccountRuntime('acct-a')).resolves.toBeNull();
    expect(h.storages).toHaveLength(0);
  });

  it('lets the recorded PRIMARY claim the already-open sarvinbox.db slot', async () => {
    touch(PRIMARY_DB_FILE);
    savePrimaryAccountId('acct-a');
    const rt = await ensureAccountRuntime('acct-a');
    expect(h.claimed).toEqual(['acct-a']);
    expect(h.storages).toHaveLength(0); // reused, not re-opened
    expect(rt).toBe(h.runtimes.get('acct-a'));
  });

  it('re-opens sarvinbox.db for the primary when the startup slot cannot be claimed', async () => {
    touch(PRIMARY_DB_FILE);
    savePrimaryAccountId('acct-a');
    h.claimSucceeds = false;
    const rt = await ensureAccountRuntime('acct-a');
    expect(h.storages[0].opts.dbPath).toBe(join(h.userData, PRIMARY_DB_FILE));
    expect(rt).toBe(h.runtimes.get('acct-a'));
  });

  // Regression: an account activated after the first one must still get the
  // blocklist lookup. It is attached at construction rather than pushed later,
  // so a missing call here means that account's mail is scored on strictly
  // less evidence than the rest, with nothing anywhere to report it.
  it('hands every account engine the shared blocklist lookup', async () => {
    await ensureAccountRuntime('acct-first');
    await ensureAccountRuntime('acct-second');

    expect(h.engines).toHaveLength(2);
    expect(h.engines.every((engine) => typeof engine.reputationLookup === 'function')).toBe(true);
    expect(h.engines[0].reputationLookup).toBe(h.engines[1].reputationLookup);
  });

  it('gives a NON-primary account its own hashed DB even when the legacy file exists', async () => {
    touch(PRIMARY_DB_FILE);
    savePrimaryAccountId('acct-primary');
    await ensureAccountRuntime('acct-second');
    expect(h.storages[0].opts.dbPath).toBe(join(h.userData, dbFileForAccount('acct-second')));
    expect(h.claimed).toEqual([]);
  });

  it('never (re)creates sarvinbox.db on a fresh install, even for the recorded primary', async () => {
    savePrimaryAccountId('acct-a'); // recorded, but no legacy file on disk
    await ensureAccountRuntime('acct-a');
    expect(h.storages[0].opts.dbPath).toBe(join(h.userData, dbFileForAccount('acct-a')));
  });

  it('proceeds with a per-id DB when there is no primary AND no legacy file', async () => {
    await ensureAccountRuntime('acct-fresh');
    expect(h.storages[0].opts.dbPath).toBe(join(h.userData, dbFileForAccount('acct-fresh')));
  });

  it('reuses a registered runtime whose storage is null by re-opening it', async () => {
    h.runtimes.set('acct-a', { storage: null, syncEngine: null, smtpClient: null });
    await ensureAccountRuntime('acct-a');
    expect(h.storages).toHaveLength(1);
  });
});

/**
 * The exclusive-maintenance hold.
 *
 * The regression, OBSERVED on a 9.8 GB account: a VACUUM closed the runtime and
 * started rebuilding the file, and 2.7 seconds into a 31-second rebuild a
 * background tick called `ensureAccountRuntime` and opened a SECOND handle on
 * it. That gave `database is locked` on the sync catch-up and the stuck-row
 * heal, and left a 1.7 GB WAL beside the rebuilt file because the rebuilding
 * connection was no longer the only one holding it. Closing a runtime does not
 * keep it closed; only the hold does.
 */
describe('exclusive maintenance holds', () => {
  // The hold lives in module state, so a test that leaves one set would wedge
  // every test after it. Clear both ids whatever the test did.
  afterEach(() => {
    releaseAccountMaintenance('acct-a');
    releaseAccountMaintenance('acct-b');
  });

  // Breaks: the whole guard. Anything that reopens accounts races the rebuild.
  it('refuses to reopen a held account', async () => {
    await quiesceAccountRuntime('acct-a', 'compact', { hold: true });

    await expect(ensureAccountRuntime('acct-a')).resolves.toBeNull();
    expect(h.storages).toHaveLength(0);
    expect(isAccountUnderMaintenance('acct-a')).toBe(true);
  });

  // Breaks: one account's maintenance freezes every OTHER account too — on a
  // multi-account setup the rest of the app stops working for ten minutes.
  it('holds only the account being worked on', async () => {
    await quiesceAccountRuntime('acct-a', 'compact', { hold: true });

    await expect(ensureAccountRuntime('acct-b')).resolves.not.toBeNull();
    expect(isAccountUnderMaintenance('acct-b')).toBe(false);
  });

  // Breaks: the hold outlives the work and the account can never be opened
  // again for the life of the process — a mailbox that vanished until restart.
  it('reopens normally once the hold is released', async () => {
    await quiesceAccountRuntime('acct-a', 'compact', { hold: true });
    releaseAccountMaintenance('acct-a');

    await expect(ensureAccountRuntime('acct-a')).resolves.not.toBeNull();
    expect(h.storages).toHaveLength(1);
  });

  // Breaks: an ordinary quiesce (account switch, shutdown) would wedge the
  // account shut. Only callers that ask for the hold get it.
  it('does NOT hold when the caller did not ask for one', async () => {
    await quiesceAccountRuntime('acct-a', 'switch');

    expect(isAccountUnderMaintenance('acct-a')).toBe(false);
    await expect(ensureAccountRuntime('acct-a')).resolves.not.toBeNull();
  });

  // Breaks: a reopen that lands between the close and the unlink recreates the
  // database file for an account the user just deleted — a blank mailbox that
  // comes back from the dead.
  it('holds the account across a delete and releases it afterwards', async () => {
    const rt = { storage: { tag: 'open' }, syncEngine: {}, smtpClient: null };
    h.runtimes.set('acct-a', rt);

    await deleteAccountData('acct-a');

    expect(h.unregistered).toContain('acct-a');
    // Released: re-adding the same address resolves to the same id, and it must
    // not be permanently unopenable.
    expect(isAccountUnderMaintenance('acct-a')).toBe(false);
  });

  // Breaks: a vault failure mid-delete strands the id marked forever.
  it('releases the delete hold even when the secrets wipe throws', async () => {
    h.secretsDeleteThrows = true;

    await deleteAccountData('acct-a');

    expect(isAccountUnderMaintenance('acct-a')).toBe(false);
  });
});

describe('renameAccountDbFiles', () => {
  it('moves the main DB and its WAL sidecars to the new id hash', () => {
    const oldFile = dbFileForAccount('old');
    touch(oldFile, 'db');
    touch(`${oldFile}-wal`, 'wal');
    touch(`${oldFile}-shm`, 'shm');

    expect(renameAccountDbFiles('old', 'new')).toBe(true);
    const newFile = dbFileForAccount('new');
    expect(readFileSync(join(h.userData, newFile), 'utf8')).toBe('db');
    expect(existsSync(join(h.userData, `${newFile}-wal`))).toBe(true);
    expect(existsSync(join(h.userData, `${newFile}-shm`))).toBe(true);
    expect(existsSync(join(h.userData, oldFile))).toBe(false);
  });

  it('no-ops when the ids match, the source is absent, or the target already exists', () => {
    expect(renameAccountDbFiles('same', 'same')).toBe(false);
    expect(renameAccountDbFiles('missing', 'new')).toBe(false);

    touch(dbFileForAccount('old'), 'old-db');
    touch(dbFileForAccount('new'), 'new-db');
    expect(renameAccountDbFiles('old', 'new')).toBe(false);
    expect(readFileSync(join(h.userData, dbFileForAccount('new')), 'utf8')).toBe('new-db');
  });

  it('leaves an existing sidecar at the destination untouched', () => {
    const oldFile = dbFileForAccount('old');
    const newFile = dbFileForAccount('new');
    touch(oldFile, 'db');
    touch(`${oldFile}-wal`, 'old-wal');
    touch(`${newFile}-wal`, 'kept-wal');
    expect(renameAccountDbFiles('old', 'new')).toBe(true);
    expect(readFileSync(join(h.userData, `${newFile}-wal`), 'utf8')).toBe('kept-wal');
  });

  // POSIX-only: a read-only directory makes renameSync fail. Windows uses ACLs,
  // where chmod is a no-op, so the failure can't be provoked the same way.
  it.skipIf(process.platform === 'win32')(
    'THROWS on a failed main-DB move so the caller aborts the id change (old DB intact)',
    () => {
      const oldFile = dbFileForAccount('old');
      touch(oldFile, 'db');
      chmodSync(h.userData, 0o500); // read + execute, no write
      try {
        expect(() => renameAccountDbFiles('old', 'new')).toThrow();
        expect(existsSync(join(h.userData, oldFile))).toBe(true);
      } finally {
        chmodSync(h.userData, 0o700);
      }
    },
  );
});

describe('rekeyAccount', () => {
  it('moves the DB, the vault, the primary pointer and the in-memory runtime', async () => {
    touch(dbFileForAccount('old'), 'db');
    savePrimaryAccountId('old');
    await rekeyAccount('old', 'new');
    expect(existsSync(join(h.userData, dbFileForAccount('new')))).toBe(true);
    expect(h.secretsRekeyed).toEqual([['old', 'new']]);
    expect(loadPrimaryAccountId()).toBe('new');
    expect(h.rekeyedRuntimes).toEqual([['old', 'new']]);
  });

  it('does NOT rename the DB file while the account is open', async () => {
    touch(dbFileForAccount('old'), 'db');
    h.runtimes.set('old', { storage: {}, syncEngine: {}, smtpClient: null });
    await rekeyAccount('old', 'new');
    expect(existsSync(join(h.userData, dbFileForAccount('old')))).toBe(true);
    expect(existsSync(join(h.userData, dbFileForAccount('new')))).toBe(false);
    // The vault + runtime still move.
    expect(h.secretsRekeyed).toEqual([['old', 'new']]);
  });

  it('leaves a primary pointer for a DIFFERENT account alone', async () => {
    savePrimaryAccountId('someone-else');
    await rekeyAccount('old', 'new');
    expect(loadPrimaryAccountId()).toBe('someone-else');
  });

  it('no-ops on empty or identical ids', async () => {
    await rekeyAccount('', 'new');
    await rekeyAccount('old', '');
    await rekeyAccount('same', 'same');
    expect(h.secretsRekeyed).toEqual([]);
    expect(h.rekeyedRuntimes).toEqual([]);
  });
});

describe('deleteAccountData', () => {
  const runtimeWith = (over: Record<string, unknown> = {}) => {
    const calls: { shuttingDown: number; disconnected: number; closeCalled?: boolean } = {
      shuttingDown: 0,
      disconnected: 0,
    };
    const rt = {
      storage: { close: async () => { calls.closeCalled = true; } } as unknown as Record<string, unknown>,
      syncEngine: {
        getClient: () => ({ setShuttingDown: () => { calls.shuttingDown += 1; } }),
        disconnect: async () => { calls.disconnected += 1; },
      },
      smtpClient: null,
      ...over,
    };
    return { rt, calls };
  };

  it('disconnects IMAP, closes the DB, unregisters, deletes files + secrets', async () => {
    const { rt, calls } = runtimeWith();
    h.runtimes.set('acct-a', rt);
    const file = dbFileForAccount('acct-a');
    touch(file);
    touch(`${file}-wal`);
    touch(`${file}-shm`);

    await deleteAccountData('acct-a');

    expect(calls.shuttingDown).toBe(1);
    expect(calls.disconnected).toBe(1);
    expect(calls.closeCalled).toBe(true);
    expect(h.unregistered).toEqual(['acct-a']);
    expect(existsSync(join(h.userData, file))).toBe(false);
    expect(existsSync(join(h.userData, `${file}-wal`))).toBe(false);
    expect(existsSync(join(h.userData, `${file}-shm`))).toBe(false);
    expect(h.secretsDeleted).toEqual(['acct-a']);
  });

  it('deletes sarvinbox.db and clears the pointer when the PRIMARY is removed', async () => {
    savePrimaryAccountId('acct-primary');
    touch(PRIMARY_DB_FILE);
    await deleteAccountData('acct-primary');
    expect(existsSync(join(h.userData, PRIMARY_DB_FILE))).toBe(false);
    expect(loadPrimaryAccountId()).toBeNull();
  });

  it('no-ops on an empty id', async () => {
    await deleteAccountData('');
    expect(h.secretsDeleted).toEqual([]);
  });

  it('works with no open runtime at all', async () => {
    touch(dbFileForAccount('acct-gone'));
    await deleteAccountData('acct-gone');
    expect(existsSync(join(h.userData, dbFileForAccount('acct-gone')))).toBe(false);
    expect(h.secretsDeleted).toEqual(['acct-gone']);
  });

  it('is best-effort: a failing disconnect / close / vault delete still wipes the data', async () => {
    h.runtimes.set('acct-a', {
      storage: { close: async () => { throw new Error('close failed'); } },
      syncEngine: {
        getClient: () => { throw new Error('no client'); },
        disconnect: async () => { throw new Error('disconnect failed'); },
      },
      smtpClient: null,
    });
    h.secretsDeleteThrows = true;
    touch(dbFileForAccount('acct-a'));
    await expect(deleteAccountData('acct-a')).resolves.toBeUndefined();
    expect(existsSync(join(h.userData, dbFileForAccount('acct-a')))).toBe(false);
  });

  it('tolerates a runtime whose engine exposes neither getClient nor disconnect', async () => {
    h.runtimes.set('acct-a', { storage: null, syncEngine: {}, smtpClient: null });
    await expect(deleteAccountData('acct-a')).resolves.toBeUndefined();
  });

  it('warns but continues when a DB file cannot be unlinked', async () => {
    // A directory in place of the DB file → unlinkSync throws, and the sweep
    // must not propagate it.
    mkdirSync(join(h.userData, dbFileForAccount('acct-a')));
    await expect(deleteAccountData('acct-a')).resolves.toBeUndefined();
    expect(existsSync(join(h.userData, dbFileForAccount('acct-a')))).toBe(true);
  });
});

describe('cleanupOrphanedAccountDbs', () => {
  it('keeps the legacy primary and the core DB', () => {
    touch(PRIMARY_DB_FILE);
    touch('sarvinbox-core.db');
    expect(cleanupOrphanedAccountDbs()).toEqual([]);
    expect(existsSync(join(h.userData, PRIMARY_DB_FILE))).toBe(true);
    expect(existsSync(join(h.userData, 'sarvinbox-core.db'))).toBe(true);
  });

  it('removes raw-named legacy per-account DBs (with sidecars) — always orphans', () => {
    touch('sarvinbox-acct-advik-d-sarv-com.db');
    touch('sarvinbox-acct-advik-d-sarv-com.db-wal');
    expect(cleanupOrphanedAccountDbs()).toEqual(['sarvinbox-acct-advik-d-sarv-com.db']);
    expect(existsSync(join(h.userData, 'sarvinbox-acct-advik-d-sarv-com.db'))).toBe(false);
    expect(existsSync(join(h.userData, 'sarvinbox-acct-advik-d-sarv-com.db-wal'))).toBe(false);
  });

  // Regression, and a real data loss: `sarvinbox-contacts.db` is the SHARED
  // contact directory, not an account DB. The sweep matched it as a raw-named
  // legacy orphan and deleted it — with its sidecars — on the first boot after
  // the unified directory shipped, taking the whole address book (954 contacts
  // here) with it.
  it('keeps the shared contact directory', () => {
    touch(SHARED_CONTACTS_FILE);
    touch(`${SHARED_CONTACTS_FILE}-wal`);
    expect(cleanupOrphanedAccountDbs()).toEqual([]);
    expect(existsSync(join(h.userData, SHARED_CONTACTS_FILE))).toBe(true);
    expect(existsSync(join(h.userData, `${SHARED_CONTACTS_FILE}-wal`))).toBe(true);
  });

  // Regression: the sweep used to delete every `sarvinbox-*.db` it did not
  // recognise. An unrecognised name is far more likely to be a store added
  // since this code was written (the contact directory was exactly that) than
  // a stale one, so it must be LEFT ALONE — deleting is not the safe default.
  it('leaves an unrecognised sarvinbox DB alone instead of assuming it is an orphan', () => {
    touch('sarvinbox-calendar.db');
    touch('sarvinbox-calendar.db-shm');
    expect(cleanupOrphanedAccountDbs()).toEqual([]);
    expect(existsSync(join(h.userData, 'sarvinbox-calendar.db'))).toBe(true);
    expect(existsSync(join(h.userData, 'sarvinbox-calendar.db-shm'))).toBe(true);
  });

  it('KEEPS every hashed DB when no authoritative keep-set is supplied', () => {
    const live = dbFileForAccount('acct-live');
    touch(live);
    age(live, 24 * 60 * 60 * 1000);
    expect(cleanupOrphanedAccountDbs()).toEqual([]);
    expect(existsSync(join(h.userData, live))).toBe(true);
  });

  it('removes a hashed DB that is absent from the keep-set AND stale', () => {
    const kept = dbFileForAccount('acct-kept');
    const orphan = dbFileForAccount('acct-orphan');
    touch(kept);
    touch(orphan);
    age(kept, 24 * 60 * 60 * 1000);
    age(orphan, 24 * 60 * 60 * 1000);

    expect(cleanupOrphanedAccountDbs({ keepAccountIds: ['acct-kept'] })).toEqual([orphan]);
    expect(existsSync(join(h.userData, kept))).toBe(true);
    expect(existsSync(join(h.userData, orphan))).toBe(false);
  });

  it('never removes a RECENTLY-written hashed DB, even if the keep-set omits it', () => {
    const busy = dbFileForAccount('acct-busy');
    touch(busy);
    expect(cleanupOrphanedAccountDbs({ keepAccountIds: ['acct-other'] })).toEqual([]);
    expect(existsSync(join(h.userData, busy))).toBe(true);
  });

  it('honors a custom staleAfterMs', () => {
    const orphan = dbFileForAccount('acct-orphan');
    touch(orphan);
    age(orphan, 5_000);
    expect(cleanupOrphanedAccountDbs({ keepAccountIds: ['acct-other'], staleAfterMs: 60_000 })).toEqual([]);
    expect(cleanupOrphanedAccountDbs({ keepAccountIds: ['acct-other'], staleAfterMs: 1_000 })).toEqual([orphan]);
  });

  // THE DATA-LOSS REGRESSION. An empty keep-set used to be treated as gospel —
  // "no accounts exist, so every hashed DB is an orphan" — and a registry read
  // that FAILED returned exactly that empty list. A native-module load failure
  // therefore deleted two live mailboxes on startup. A registry claiming zero
  // accounts while hashed per-account DBs sit on disk is a contradiction, and
  // the safe reading of a contradiction is "delete nothing".
  it('KEEPS every hashed DB when the keep-set is EMPTY, however stale', () => {
    const live = dbFileForAccount('acct-live');
    const other = dbFileForAccount('acct-other');
    touch(live);
    touch(other);
    age(live, 30 * 24 * 60 * 60 * 1000);
    age(other, 30 * 24 * 60 * 60 * 1000);

    // staleAfterMs: 0 removes the last-resort mtime guard too — the removal path
    // passes exactly this, so the keep-set is the ONLY thing standing between an
    // unreadable registry and every mailbox on the machine.
    expect(cleanupOrphanedAccountDbs({ keepAccountIds: [], staleAfterMs: 0 })).toEqual([]);
    expect(existsSync(join(h.userData, live))).toBe(true);
    expect(existsSync(join(h.userData, other))).toBe(true);
  });

  // The guard must not turn into "never clean anything": a REAL keep-set still
  // sweeps a stale orphan, or the leak this function exists to fix comes back.
  it('still removes a stale orphan once the keep-set is genuinely populated', () => {
    const kept = dbFileForAccount('acct-kept');
    const orphan = dbFileForAccount('acct-orphan');
    touch(kept);
    touch(orphan);
    age(orphan, 24 * 60 * 60 * 1000);
    expect(cleanupOrphanedAccountDbs({ keepAccountIds: ['acct-kept'], staleAfterMs: 0 })).toEqual([orphan]);
    expect(existsSync(join(h.userData, kept))).toBe(true);
  });

  it('removes an oldest-scheme plaintext `acct-*` DB only when it really is SQLite', () => {
    touch('acct-advik-d-sarv-com', SQLITE_MAGIC);
    touch('acct-not-a-database', 'just some text');
    expect(cleanupOrphanedAccountDbs()).toEqual(['acct-advik-d-sarv-com']);
    expect(existsSync(join(h.userData, 'acct-not-a-database'))).toBe(true);
  });

  it('ignores unrelated files and a directory that looks like an account DB', () => {
    touch('some-other-file.txt');
    touch('acct-with_bad_chars', SQLITE_MAGIC);
    mkdirSync(join(h.userData, 'acct-dir'));
    expect(cleanupOrphanedAccountDbs()).toEqual([]);
    expect(existsSync(join(h.userData, 'some-other-file.txt'))).toBe(true);
  });

  it('tolerates an unremovable plaintext orphan', () => {
    // `acct-dirdb` passes the name test; make it a non-empty directory so the
    // SQLite magic read fails → it is skipped rather than deleted.
    mkdirSync(join(h.userData, 'acct-dirdb'));
    expect(cleanupOrphanedAccountDbs()).toEqual([]);
    expect(existsSync(join(h.userData, 'acct-dirdb'))).toBe(true);
  });

  it('returns [] when userData cannot be read', () => {
    rmSync(h.userData, { recursive: true, force: true });
    expect(cleanupOrphanedAccountDbs()).toEqual([]);
    mkdirSync(h.userData, { recursive: true });
  });
});

describe('cleanupStaleUserDataArtifacts', () => {
  it('removes a stale draft-debug.log but keeps a freshly-written one', () => {
    touch('draft-debug.log');
    expect(cleanupStaleUserDataArtifacts()).toEqual([]);
    age('draft-debug.log', 2 * 60 * 60 * 1000);
    expect(cleanupStaleUserDataArtifacts()).toEqual(['draft-debug.log']);
    expect(existsSync(join(h.userData, 'draft-debug.log'))).toBe(false);
  });

  it('removes orphaned bundle-id temp files (dev and release prefixes) when stale', () => {
    touch('.com.sarv.sarvinbox.abc123');
    touch('.com.sarv.sarvinbox.dev.def456');
    touch('.com.sarv.other.xyz');
    age('.com.sarv.sarvinbox.abc123', 2 * 60 * 60 * 1000);
    age('.com.sarv.sarvinbox.dev.def456', 2 * 60 * 60 * 1000);
    age('.com.sarv.other.xyz', 2 * 60 * 60 * 1000);

    expect(cleanupStaleUserDataArtifacts().sort()).toEqual([
      '.com.sarv.sarvinbox.abc123',
      '.com.sarv.sarvinbox.dev.def456',
    ]);
    expect(existsSync(join(h.userData, '.com.sarv.other.xyz'))).toBe(true);
  });

  it('keeps a temp file the OS may still be writing', () => {
    touch('.com.sarv.sarvinbox.fresh');
    expect(cleanupStaleUserDataArtifacts()).toEqual([]);
  });

  it('is a no-op when nothing is there', () => {
    expect(cleanupStaleUserDataArtifacts()).toEqual([]);
  });

  it('warns but continues when a stale artifact cannot be removed', () => {
    mkdirSync(join(h.userData, 'draft-debug.log'));
    writeFileSync(join(h.userData, 'draft-debug.log', 'inner'), 'x');
    age('draft-debug.log', 2 * 60 * 60 * 1000);
    expect(cleanupStaleUserDataArtifacts()).toEqual([]);
    expect(existsSync(join(h.userData, 'draft-debug.log'))).toBe(true);
  });

  it('tolerates an unreadable userData directory', () => {
    rmSync(h.userData, { recursive: true, force: true });
    expect(cleanupStaleUserDataArtifacts()).toEqual([]);
    mkdirSync(h.userData, { recursive: true });
  });
});
