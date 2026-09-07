// SQLiteStorage facade — lifecycle, initialization guards, and the non-email
// API groups (folders, threads, attachments, contacts/sender stats, signature
// patterns, filters, labels, the IMAP pending-operation queue and the SMTP
// outbox).
//
// Everything runs against a REAL SQLite file carrying the full production schema
// (schema.sql + every migration), so a wrong column name or predicate fails here
// rather than only in the app. Email reads/writes live in
// sqlite-storage-emails.test.ts; transaction/rollback guarantees in
// sqlite-storage-tx.test.ts.

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import Module from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { EmailRecord, FolderRecord, ThreadRecord } from '@sarvinbox/core';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import * as emailRepoModule from '../../src/repositories/email-repository';
import { TestDatabaseCtor } from '../../src/test-support/test-db';

// The facade builds its OWN connection (`new Database(...)` inside initialize()),
// so the module has to be redirected at the import boundary. TestDatabaseCtor is
// real SQLite either way — nothing about the SQL under test is stubbed.
vi.mock('better-sqlite3', () => ({ default: TestDatabaseCtor }));

// sqlite-storage.ts lazily pulls its tag helpers with CJS `require()` from inside
// an otherwise-ESM module. Bundled for Electron that resolves; under vitest the
// on-disk neighbour is a `.ts` file Node's require cannot resolve, so those paths
// would explode before reaching any SQL. Hand back the REAL module (imported
// normally above) so the production helpers still run.
const nodeModule = Module as unknown as { _load: (r: string, p: unknown, m: boolean) => unknown };
const originalModuleLoad = nodeModule._load;
nodeModule._load = function (request, parent, isMain) {
  if (request === './repositories/email-repository') return emailRepoModule;
  return originalModuleLoad.call(this, request, parent, isMain);
};

import { SQLiteStorage } from '../../src/sqlite-storage';

// ---------------------------------------------------------------------------
// Fixtures. Every timestamp is explicit — nothing may depend on the wall clock.
// ---------------------------------------------------------------------------

const T0 = 1_700_000_000;

function makeFolder(id: string, path: string, over: Partial<FolderRecord> = {}): FolderRecord {
  return {
    id,
    name: path.split('/').pop()!,
    path,
    parentId: null,
    uidValidity: 1,
    lastSyncUid: null,
    lastSyncTime: null,
    totalCount: 0,
    unreadCount: 0,
    specialUse: null,
    subscribed: true,
    createdAt: T0,
    updatedAt: T0,
    ...over,
  };
}

function makeEmail(over: Partial<EmailRecord> & { id: string }): EmailRecord {
  return {
    messageId: `<${over.id}@example.test>`,
    threadId: `thread-${over.id}`,
    folderId: 'f-inbox',
    uid: 1,
    tags: '|INBOX|',
    subject: `Subject ${over.id}`,
    fromAddress: 'sender@example.test',
    fromName: 'Sender',
    toAddress: 'me@example.test',
    toNames: null,
    ccAddress: null,
    ccNames: null,
    bccAddress: null,
    bccNames: null,
    replyTo: null,
    date: T0,
    receivedDate: T0,
    cleanBody: 'clean',
    rawBody: '<p>raw</p>',
    contentType: 'html',
    contentHash: `hash-${over.id}`,
    inReplyTo: null,
    references: null,
    priority: null,
    hasAttachments: false,
    attachmentCount: 0,
    attachmentNames: null,
    attachmentSizes: null,
    hasEmbedding: false,
    embeddingLastGenerated: null,
    createdAt: T0,
    updatedAt: T0,
    ...over,
  };
}

/** One temp dir + one initialized storage, shared by a describe block. Each
 *  initialize() replays all 67 migrations, so they are not free.
 *
 *  NOTE: vitest runs the hooks of a single suite in PARALLEL, so a describe must
 *  never register a second beforeAll to seed rows — it would race the one that
 *  opens the DB (and fail its foreign keys). Seeding goes through `seed`. */
function withStorage(seed?: (storage: SQLiteStorage) => Promise<void>): { get: () => SQLiteStorage; dir: () => string } {
  let dir = '';
  let storage: SQLiteStorage;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'sqlite-storage-'));
    storage = new SQLiteStorage({ dbPath: join(dir, 'mail.db') });
    await storage.initialize();
    if (seed) await seed(storage);
  });

  afterAll(async () => {
    await storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  return { get: () => storage, dir: () => dir };
}

// ===========================================================================
// Lifecycle
// ===========================================================================

// A double initialize() happens for real: several main-process code paths call
// ensureStorage() defensively. If the second call re-opened the connection it
// would leak the first handle AND drop the live ReadModelMaintainer, and the
// repositories cached against the old handle would write into a closed DB.
describe('SQLiteStorage lifecycle', () => {
  let dir: string;
  let dbPath: string;
  let storage: SQLiteStorage;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sqlite-storage-lifecycle-'));
    dbPath = join(dir, 'mail.db');
    storage = new SQLiteStorage({ dbPath });
  });

  afterEach(async () => {
    await storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates the DB file and reports initialized', async () => {
    expect(storage.isInitialized()).toBe(false);
    await storage.initialize();
    expect(storage.isInitialized()).toBe(true);
    expect(existsSync(dbPath)).toBe(true);
  });

  it('is idempotent — a second initialize() keeps the same live connection and data', async () => {
    await storage.initialize();
    await storage.syncFolders([makeFolder('f-inbox', 'INBOX')]);

    await storage.initialize(); // must be a no-op, not a reopen

    expect(storage.isInitialized()).toBe(true);
    // Reachable through the SAME cached repositories — proves the handle survived.
    expect((await storage.getFolders()).map((f) => f.path)).toEqual(['INBOX']);
  });

  it('close() tears down, and re-initializing the same file keeps the data', async () => {
    await storage.initialize();
    await storage.syncFolders([makeFolder('f-inbox', 'INBOX')]);
    await storage.close();

    expect(storage.isInitialized()).toBe(false);
    // Repositories were dropped with the connection: reads must refuse, not
    // dereference a closed handle.
    await expect(storage.getFolders()).rejects.toThrow('Storage not initialized');

    await storage.initialize();
    expect((await storage.getFolders()).map((f) => f.path)).toEqual(['INBOX']);
  });

  it('close() on a never-initialized storage is a no-op', async () => {
    await expect(storage.close()).resolves.toBeUndefined();
    await expect(storage.close()).resolves.toBeUndefined();
    expect(storage.isInitialized()).toBe(false);
  });

  it('getRepositories() exposes the eight repositories after init and refuses before', async () => {
    expect(() => storage.getRepositories()).toThrow('Storage not initialized');
    await storage.initialize();
    const repos = storage.getRepositories();
    expect(Object.keys(repos).sort()).toEqual(
      ['agent', 'ai', 'contact', 'email', 'folder', 'prompts', 'search', 'thread'],
    );
    // Cached, not rebuilt per call.
    expect(storage.getRepositories().email).toBe(repos.email);
  });
});

// A method that runs its SQL against a null handle crashes the main process with
// an opaque "Cannot read properties of null". ensureInitialized() must convert
// every entry point into one recognisable error BEFORE touching the DB — that is
// what lets the IPC layer report "storage not ready" instead of dying.
describe('SQLiteStorage before initialize()', () => {
  const uninitialized = () => new SQLiteStorage({ dbPath: join(tmpdir(), 'never-created.db') });

  const asyncEntryPoints: Array<[string, (s: SQLiteStorage) => Promise<unknown>]> = [
    ['insertEmail', (s) => s.insertEmail(makeEmail({ id: 'x' }))],
    ['insertEmailBatch', (s) => s.insertEmailBatch([makeEmail({ id: 'x' })])],
    ['updateEmail', (s) => s.updateEmail('x', { tags: '||' })],
    ['bulkUpdateTags', (s) => s.bulkUpdateTags([{ id: 'x', tags: '||' }])],
    ['getEmail', (s) => s.getEmail('x')],
    ['getAllEmails', (s) => s.getAllEmails()],
    ['getEmailsBySection', (s) => s.getEmailsBySection('unread', { limit: 1, offset: 0 })],
    ['searchEmails', (s) => s.searchEmails({ query: 'hi' })],
    ['deleteEmail', (s) => s.deleteEmail('x')],
    ['syncFolders', (s) => s.syncFolders([])],
    ['getFolders', (s) => s.getFolders()],
    ['recalculateFolderCounts', (s) => s.recalculateFolderCounts()],
    ['upsertThread', (s) => s.upsertThread({ id: 't' } as ThreadRecord)],
    ['getThreads', (s) => s.getThreads({ limit: 1, offset: 0 })],
    ['getAttachments', (s) => s.getAttachments('x')],
    ['getStats', (s) => s.getStats()],
    ['vacuum', (s) => s.vacuum()],
    ['checkIntegrity', (s) => s.checkIntegrity()],
    ['upsertContact', (s) => s.upsertContact({ email: 'a@b.test' })],
    ['getContacts', (s) => s.getContacts({ limit: 1, offset: 0 })],
    ['getSenderStats', (s) => s.getSenderStats('a@b.test')],
    ['snoozeEmail', (s) => s.snoozeEmail('x', 1)],
    ['getSnoozedEmails', (s) => s.getSnoozedEmails()],
    ['getEmailAICategory', (s) => s.getEmailAICategory('x')],
    ['getAICategoryCounts', (s) => s.getAICategoryCounts()],
    ['getSpammers', (s) => s.getSpammers()],
    ['getFilterRules', (s) => s.getFilterRules()],
    ['getLabels', (s) => s.getLabels()],
    ['savePendingOperation', (s) => s.savePendingOperation({ type: 't', folderPath: 'INBOX', uid: 1, retryCount: 0 })],
    ['getPendingOperations', (s) => s.getPendingOperations()],
    ['getAllSends', (s) => s.getAllSends()],
    ['repairThreading', (s) => s.repairThreading()],
  ];

  it.each(asyncEntryPoints)('%s rejects with "Storage not initialized"', async (_name, call) => {
    await expect(call(uninitialized())).rejects.toThrow('Storage not initialized');
  });

  const syncEntryPoints: Array<[string, (s: SQLiteStorage) => unknown]> = [
    ['getSearchSuggestions', (s) => s.getSearchSuggestions('a')],
    ['getSenderContextBatch', (s) => s.getSenderContextBatch(['a@b.test'])],
    ['getThreadDepths', (s) => s.getThreadDepths(['t'])],
    ['getSenderRepetitionStats', (s) => s.getSenderRepetitionStats(['a@b.test'])],
    ['getPhoneMiningState', (s) => s.getPhoneMiningState()],
    ['getNewestEmailDateBySender', (s) => s.getNewestEmailDateBySender()],
    ['setPhoneMiningState', (s) => s.setPhoneMiningState('a@b.test', 1, {})],
    ['getEmailIdsWithoutBody', (s) => s.getEmailIdsWithoutBody()],
    ['getUnreadEmailIdsWithoutBody', (s) => s.getUnreadEmailIdsWithoutBody()],
    ['countUnreadEmailsWithoutBody', (s) => s.countUnreadEmailsWithoutBody()],
    ['countEmailsWithoutBody', (s) => s.countEmailsWithoutBody()],
    ['getSeedEmailIdsWithoutBody', (s) => s.getSeedEmailIdsWithoutBody()],
    ['getThreadSiblingsWithoutBody', (s) => s.getThreadSiblingsWithoutBody(['x'])],
    ['markBodiesUnfetchable', (s) => s.markBodiesUnfetchable(['x'])],
    ['getCategoryDefinitions', (s) => s.getCategoryDefinitions()],
    ['getEnabledCategoryDefinitions', (s) => s.getEnabledCategoryDefinitions()],
    ['upsertCategoryDefinition', (s) => s.upsertCategoryDefinition({ slug: 'x' })],
    ['deleteCategoryDefinition', (s) => s.deleteCategoryDefinition('x')],
    ['toggleCategoryDefinition', (s) => s.toggleCategoryDefinition('x', true)],
    ['saveEmailCategories', (s) => s.saveEmailCategories('x', [], false, '', 1, 1)],
    ['saveEmailCategoriesBatch', (s) => s.saveEmailCategoriesBatch([])],
    ['getDynamicCategoryCounts', (s) => s.getDynamicCategoryCounts()],
    ['getEmailCategoriesBatch', (s) => s.getEmailCategoriesBatch(['x'])],
    ['upsertCategoryBatch', (s) => s.upsertCategoryBatch([])],
    ['getEligibleEmailsForAI', (s) => s.getEligibleEmailsForAI()],
    ['incrementParseFailureCount', (s) => s.incrementParseFailureCount('x')],
    ['resetParseFailureCount', (s) => s.resetParseFailureCount('x')],
    ['getParseFailureCounts', (s) => s.getParseFailureCounts(3)],
    ['getChatViewBodyForEmail', (s) => s.getChatViewBodyForEmail('t', 'x')],
  ];

  it.each(syncEntryPoints)('%s throws "Storage not initialized"', (_name, call) => {
    expect(() => call(uninitialized())).toThrow('Storage not initialized');
  });
});

// The `key` option must never be the difference between "the app starts" and
// "the app can't read its own mail". Two shapes matter: a brand-new encrypted DB,
// and a legacy PLAINTEXT DB that gets rekeyed in place on first keyed open —
// the in-place migration is irreversible, so it has to leave every row readable.
//
// NOTE: the fallback SQLite engine used by these tests has NO cipher (see
// test-support/test-db.ts — `key=`/`rekey=` are inert pragmas there), so this
// asserts only that the keyed code path runs and preserves data. It does NOT
// prove at-rest encryption works.
describe('SQLiteStorage encryption config', () => {
  let dir: string;

  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'sqlite-storage-key-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('accepts a key on a brand-new DB and still round-trips rows', async () => {
    const storage = new SQLiteStorage({ dbPath: join(dir, 'enc.db'), key: 'a1b2c3d4', cacheSizeKb: 512 });
    await storage.initialize();
    await storage.syncFolders([makeFolder('f-inbox', 'INBOX')]);
    expect((await storage.getFolder('f-inbox'))?.path).toBe('INBOX');
    await storage.close();
  });

  it('rekeys an existing plaintext DB in place without losing rows', async () => {
    const dbPath = join(dir, 'legacy.db');
    const plain = new SQLiteStorage({ dbPath });
    await plain.initialize();
    await plain.syncFolders([makeFolder('f-inbox', 'INBOX'), makeFolder('f-sent', 'Sent')]);
    await plain.close();

    const keyed = new SQLiteStorage({ dbPath, key: "quo'te" }); // quote-escaping path
    await keyed.initialize();
    expect((await keyed.getFolders()).map((f) => f.path).sort()).toEqual(['INBOX', 'Sent']);
    await keyed.close();
  });
});

// ===========================================================================
// Stats & maintenance
// ===========================================================================

// getStats drives the settings/diagnostics panel. On a fresh account it must
// report honest zeros (not NULLs that render as "NaN emails"), and the counts
// must track what is actually in the tables.
describe('SQLiteStorage stats and maintenance', () => {
  const ctx = withStorage();

  it('returns zeros (and a real db size) on an empty database', async () => {
    const stats = await ctx.get().getStats();
    expect(stats.totalEmails).toBe(0);
    expect(stats.totalThreads).toBe(0);
    expect(stats.totalFolders).toBe(0);
    expect(stats.totalAttachments).toBe(0);
    expect(stats.totalEmbeddings).toBe(0);
    expect(stats.attachmentsSize).toBe(0);
    expect(stats.lastSyncTime).toBeNull();
    expect(stats.databaseSize).toBeGreaterThan(0);
  });

  it('counts rows and reports the newest folder sync time', async () => {
    const storage = ctx.get();
    await storage.syncFolders([
      makeFolder('f-inbox', 'INBOX', { lastSyncTime: T0 }),
      makeFolder('f-sent', 'Sent', { lastSyncTime: T0 + 60 }),
    ]);
    await storage.insertEmail(makeEmail({ id: 's1' }));
    await storage.insertAttachment({
      id: 'att-1', emailId: 's1', filename: 'a.pdf', contentType: 'application/pdf',
      size: 12, filePath: '/tmp/a.pdf', createdAt: T0,
    });

    const stats = await storage.getStats();
    expect(stats.totalEmails).toBe(1);
    expect(stats.totalThreads).toBe(1);
    expect(stats.totalFolders).toBe(2);
    expect(stats.totalAttachments).toBe(1);
    expect(stats.lastSyncTime).toBe(T0 + 60);
  });

  it('vacuum() compacts without disturbing rows, and integrity_check passes', async () => {
    const storage = ctx.get();
    await storage.vacuum();
    expect(await storage.checkIntegrity()).toBe(true);
    expect((await storage.getEmail('s1'))?.id).toBe('s1');
  });
});

// ===========================================================================
// Folders
// ===========================================================================

// Folder membership is stored as a path TAG on the email row, not a junction
// table. Every method here has to keep the tag set and the primary
// (folder_id, uid) pointer consistent — get that wrong and mail either vanishes
// from a folder view or is hard-deleted while it still lives in another folder.
describe('SQLiteStorage folder operations', () => {
  const ctx = withStorage(async (storage) => {
    await storage.syncFolders([
      makeFolder('f-inbox', 'INBOX', { specialUse: '\\Inbox', lastSyncTime: T0 }),
      makeFolder('f-arch', 'Archive'),
      makeFolder('f-trash', 'Trash', { specialUse: '\\Trash' }),
    ]);
  });

  it('syncFolders round-trips a folder and reads it back by id and by path', async () => {
    const storage = ctx.get();
    expect((await storage.getFolders()).map((f) => f.path).sort()).toEqual(['Archive', 'INBOX', 'Trash']);

    const byId = await storage.getFolder('f-inbox');
    expect(byId).toMatchObject({ id: 'f-inbox', path: 'INBOX', specialUse: '\\Inbox', subscribed: true });
    expect(await storage.getFolderByPath('INBOX')).toMatchObject({ id: 'f-inbox' });
  });

  it('unknown folder ids and paths read back as null instead of throwing', async () => {
    const storage = ctx.get();
    expect(await storage.getFolder('nope')).toBeNull();
    expect(await storage.getFolderByPath('No/Such/Path')).toBeNull();
    expect(await storage.getEmailFolders('nope')).toEqual([]);
    expect(await storage.getEmailWithFolders('<nobody@example.test>')).toBeNull();
    expect(await storage.getOldestUidInFolder('f-arch')).toBeNull();
    // No-op link/unlink against unknown ids must not throw either.
    await expect(storage.linkEmailToFolder('nope', 'f-inbox')).resolves.toBeUndefined();
    await expect(storage.unlinkEmailFromFolder('nope', 'f-inbox')).resolves.toBeUndefined();
    await expect(storage.updateEmailFolderFlags('nope', 'f-inbox', ['\\Seen'])).resolves.toBeUndefined();
    expect(await storage.unlinkOrDeleteEmailsFromFolder([], 'f-inbox')).toEqual({ unlinked: 0, deleted: 0 });
    expect(await storage.invalidateFolderMembership('nope')).toEqual({ unlinked: 0, deleted: 0 });
  });

  it('updateFolder persists sync state and delete removes the row', async () => {
    const storage = ctx.get();
    await storage.syncFolders([
      makeFolder('f-inbox', 'INBOX', { specialUse: '\\Inbox', lastSyncTime: T0 }),
      makeFolder('f-arch', 'Archive'),
      makeFolder('f-trash', 'Trash', { specialUse: '\\Trash' }),
      makeFolder('f-tmp', 'Temp'),
    ]);
    await storage.updateFolder('f-tmp', { lastSyncUid: 42, highestModseq: 99, subscribed: false });
    expect(await storage.getFolder('f-tmp')).toMatchObject({
      lastSyncUid: 42, highestModseq: 99, subscribed: false,
    });

    // An update with no recognised fields must not blow up on empty SET clauses.
    await expect(storage.updateFolder('f-tmp', {})).resolves.toBeUndefined();

    await storage.deleteFolder('f-tmp');
    expect(await storage.getFolder('f-tmp')).toBeNull();
  });

  it('links a second folder as a tag, reports both memberships, and unlinks again', async () => {
    const storage = ctx.get();
    await storage.insertEmail(makeEmail({ id: 'fl1', uid: 7 }));

    await storage.linkEmailToFolder('fl1', 'f-arch', 0);
    expect((await storage.getEmail('fl1'))!.tags).toContain('|Archive|');

    const folders = await storage.getEmailFolders('fl1');
    expect(folders.map((f) => f.folderId).sort()).toEqual(['f-arch', 'f-inbox']);
    // Only the PRIMARY folder carries the server uid.
    expect(folders.find((f) => f.folderId === 'f-inbox')!.uid).toBe(7);
    expect(folders.find((f) => f.folderId === 'f-arch')!.uid).toBeNull();

    const withFolders = await storage.getEmailWithFolders('<fl1@example.test>');
    expect(withFolders!.email.id).toBe('fl1');
    expect(withFolders!.folders.sort()).toEqual(['f-arch', 'f-inbox']);

    // Linking the PRIMARY folder with a fresh server uid refreshes it.
    await storage.linkEmailToFolder('fl1', 'f-inbox', 11);
    expect((await storage.getEmail('fl1'))!.uid).toBe(11);

    await storage.unlinkEmailFromFolder('fl1', 'f-arch');
    expect((await storage.getEmail('fl1'))!.tags).not.toContain('|Archive|');
    // Unlinking a folder the email is not in changes nothing.
    await storage.unlinkEmailFromFolder('fl1', 'f-arch');
    expect((await storage.getEmailFolders('fl1')).map((f) => f.folderId)).toEqual(['f-inbox']);
  });

  it('updateEmailFolderFlags replaces flag tags but keeps folder tags', async () => {
    const storage = ctx.get();
    await storage.insertEmail(makeEmail({ id: 'fl2', tags: '|INBOX|read|starred|' }));

    await storage.updateEmailFolderFlags('fl2', 'f-inbox', ['\\Seen']);
    const tags = (await storage.getEmail('fl2'))!.tags;
    expect(tags).toContain('|INBOX|');
    expect(tags).toContain('|read|');
    expect(tags).not.toContain('|starred|');
  });

  it('a vanished message keeps its row when another folder still holds it, and is deleted when none does', async () => {
    const storage = ctx.get();
    await storage.insertEmail(makeEmail({ id: 'mv1', tags: '|INBOX|Archive|', uid: 5 }));
    await storage.insertEmail(makeEmail({ id: 'mv2', tags: '|INBOX|' }));

    const result = await storage.unlinkOrDeleteEmailsFromFolder(['mv1', 'mv2'], 'f-inbox');
    expect(result).toEqual({ unlinked: 1, deleted: 1 });

    const survivor = await storage.getEmail('mv1');
    expect(survivor!.tags).not.toContain('|INBOX|');
    expect(survivor!.folderId).toBe('f-arch'); // primary repointed to the survivor
    expect(survivor!.uid).toBeNull();          // stale uid cleared for a clean re-sync
    expect(await storage.getEmail('mv2')).toBeNull();
  });

  it('invalidateFolderMembership re-keys every row tagged with the folder', async () => {
    const storage = ctx.get();
    await storage.insertEmail(makeEmail({ id: 'iv1', folderId: 'f-trash', tags: '|Trash|Archive|' }));
    await storage.insertEmail(makeEmail({ id: 'iv2', folderId: 'f-trash', tags: '|Trash|' }));

    expect(await storage.invalidateFolderMembership('f-trash')).toEqual({ unlinked: 1, deleted: 1 });
    expect((await storage.getEmail('iv1'))!.folderId).toBe('f-arch');
    expect(await storage.getEmail('iv2')).toBeNull();
  });

  it('exposes lightweight uid/tag projections and tag-based counts for the sync reconcile', async () => {
    const storage = ctx.get();
    await storage.syncFolders([
      makeFolder('f-inbox', 'INBOX', { specialUse: '\\Inbox', lastSyncTime: T0 }),
      makeFolder('f-arch', 'Archive'),
      makeFolder('f-trash', 'Trash', { specialUse: '\\Trash' }),
      makeFolder('f-rec', 'Recon'),
    ]);
    await storage.insertEmail(makeEmail({ id: 'rc1', folderId: 'f-rec', uid: 30, tags: '|Recon|' }));
    await storage.insertEmail(makeEmail({ id: 'rc2', folderId: 'f-rec', uid: 10, tags: '|Recon|read|' }));

    const uids = await storage.getEmailUidsInFolder('f-rec');
    expect(uids.map((u) => u.uid).sort((a, b) => a - b)).toEqual([10, 30]);

    const tagged = await storage.getEmailTagsInFolder('f-rec');
    expect(tagged.find((t) => t.id === 'rc2')!.tags).toContain('|read|');

    expect(await storage.getEmailIdsByFolderAndUids('f-rec', [10, 999])).toEqual([{ id: 'rc2', uid: 10 }]);
    expect((await storage.getEmailByFolderAndUid('f-rec', 30))!.id).toBe('rc1');
    expect(await storage.getEmailByFolderAndUid('f-rec', 999)).toBeNull();
    expect(await storage.getOldestUidInFolder('f-rec')).toBe(10);
    expect(await storage.countEmailsWithFolderTag('Recon')).toBe(2);
    expect(await storage.countEmailsWithFolderTag('Nope')).toBe(0);

    // getEmailsByFolderViaJunction is the legacy alias — same rows as getEmailsByFolder.
    const viaJunction = await storage.getEmailsByFolderViaJunction('f-rec', { limit: 10, offset: 0 });
    expect(viaJunction.map((e) => e.id).sort()).toEqual(['rc1', 'rc2']);
  });

  it('recalculateFolderCounts and the delta maintainers agree on unread counts', async () => {
    const storage = ctx.get();
    await storage.syncFolders([
      makeFolder('f-inbox', 'INBOX', { specialUse: '\\Inbox', lastSyncTime: T0 }),
      makeFolder('f-arch', 'Archive'),
      makeFolder('f-trash', 'Trash', { specialUse: '\\Trash' }),
      makeFolder('f-cnt', 'Counted'),
    ]);
    await storage.insertEmail(makeEmail({ id: 'ct1', folderId: 'f-cnt', threadId: 'th-ct1', tags: '|Counted|' }));
    await storage.insertEmail(makeEmail({ id: 'ct2', folderId: 'f-cnt', threadId: 'th-ct2', tags: '|Counted|starred|' }));

    await storage.recalculateFolderCounts(['Counted']);
    expect(await storage.getFolder('f-cnt')).toMatchObject({ totalCount: 2, unreadCount: 2 });

    // Flip one to read through the same path the mark-read handler uses.
    await storage.updateEmail('ct1', { tags: '|Counted|read|' });
    await storage.applyReadFlagToFolderCounts('ct1', true);
    expect((await storage.getFolder('f-cnt'))!.unreadCount).toBe(1);

    await storage.updateEmail('ct2', { tags: '|Counted|starred|read|' });
    await storage.applyReadFlagToFolderCountsBatch([{ emailId: 'ct2', nowRead: true }]);
    expect((await storage.getFolder('f-cnt'))!.unreadCount).toBe(0);

    // The scan-free deltas must match an authoritative full recount.
    await storage.recalculateFolderCounts();
    expect((await storage.getFolder('f-cnt'))!.unreadCount).toBe(0);

    expect(await storage.recalculateStarredCount()).toBe(1);
    // An empty flip batch is a no-op.
    await expect(storage.applyReadFlagToFolderCountsBatch([])).resolves.toBeUndefined();
  });

  it('deleteEmailsByFolder reports how many rows it removed', async () => {
    const storage = ctx.get();
    await storage.syncFolders([
      makeFolder('f-inbox', 'INBOX', { specialUse: '\\Inbox', lastSyncTime: T0 }),
      makeFolder('f-arch', 'Archive'),
      makeFolder('f-trash', 'Trash', { specialUse: '\\Trash' }),
      makeFolder('f-del', 'Deletable'),
    ]);
    await storage.insertEmail(makeEmail({ id: 'dl1', folderId: 'f-del', tags: '|Deletable|' }));
    await storage.insertEmail(makeEmail({ id: 'dl2', folderId: 'f-del', tags: '|Deletable|' }));

    expect(await storage.deleteEmailsByFolder('f-del')).toBe(2);
    expect(await storage.deleteEmailsByFolder('f-del')).toBe(0);
    expect(await storage.getEmail('dl1')).toBeNull();
  });

  // Clearing a folder must not destroy mail that lives in OTHER folders too — a
  // UIDVALIDITY change on a Gmail label used to wipe those rows out of every
  // folder they belonged to. Rows with another membership are UNLINKED (this
  // folder's tag dropped, primary repointed); only rows with nowhere else to
  // live are deleted. Both count toward the reported total.
  it('deleteEmailsByFolder unlinks multi-folder rows instead of destroying them', async () => {
    const storage = ctx.get();
    await storage.syncFolders([
      makeFolder('f-inbox', 'INBOX', { specialUse: '\\Inbox', lastSyncTime: T0 }),
      makeFolder('f-label', 'Label'),
    ]);
    await storage.insertEmail(makeEmail({ id: 'sole', folderId: 'f-label', tags: '|Label|' }));
    await storage.insertEmail(makeEmail({ id: 'shared', folderId: 'f-label', tags: '|Label|INBOX|' }));

    expect(await storage.deleteEmailsByFolder('f-label')).toBe(2);   // 1 deleted + 1 unlinked

    expect(await storage.getEmail('sole')).toBeNull();
    const shared = await storage.getEmail('shared');
    expect(shared).not.toBeNull();
    expect(shared!.tags).not.toContain('|Label|');
    expect(shared!.tags).toContain('|INBOX|');
    expect(shared!.folderId).toBe('f-inbox');                        // primary repointed
  });
});

// ===========================================================================
// Threads & attachments
// ===========================================================================

// emails.thread_id is a FK with ON DELETE CASCADE, so thread writes are the most
// dangerous surface in the schema: deleting a thread row takes its mail with it.
// These pin the round-trip and that cascade so nobody "cleans up" threads
// casually.
describe('SQLiteStorage thread and attachment operations', () => {
  const ctx = withStorage(async (storage) => {
    await storage.syncFolders([makeFolder('f-inbox', 'INBOX')]);
  });

  const thread = (id: string, over: Partial<ThreadRecord> = {}): ThreadRecord => ({
    id,
    subject: `Thread ${id}`,
    firstMessageId: `${id}-first`,
    lastMessageId: `${id}-last`,
    lastMessageDate: T0,
    messageCount: 1,
    participants: 'a@example.test',
    hasUnread: true,
    hasFlagged: false,
    labels: [],
    createdAt: T0,
    updatedAt: T0,
    ...over,
  });

  it('upsert → get → update → delete round-trips a thread', async () => {
    const storage = ctx.get();
    await storage.upsertThread(thread('t-a', { labels: ['work'] }));

    expect(await storage.getThread('t-a')).toMatchObject({
      id: 't-a', subject: 'Thread t-a', messageCount: 1, hasUnread: true, labels: ['work'],
    });

    // Upsert again — must UPDATE, not duplicate or throw on the PK.
    await storage.upsertThread(thread('t-a', { subject: 'Renamed', messageCount: 4, lastMessageDate: T0 + 10 }));
    expect(await storage.getThread('t-a')).toMatchObject({ subject: 'Renamed', messageCount: 4 });

    await storage.updateThread('t-a', { hasFlagged: true, labels: ['work', 'urgent'] });
    expect(await storage.getThread('t-a')).toMatchObject({ hasFlagged: true, labels: ['work', 'urgent'] });

    // No recognised fields → no SQL, no error.
    await expect(storage.updateThread('t-a', {})).resolves.toBeUndefined();

    await storage.deleteThread('t-a');
    expect(await storage.getThread('t-a')).toBeNull();
    expect(await storage.getThread('missing')).toBeNull();
  });

  it('getThreads paginates newest-first by last message date', async () => {
    const storage = ctx.get();
    await storage.upsertThread(thread('t-old', { lastMessageDate: T0 }));
    await storage.upsertThread(thread('t-new', { lastMessageDate: T0 + 100 }));

    const page = await storage.getThreads({ limit: 1, offset: 0 });
    expect(page.map((t) => t.id)).toEqual(['t-new']);
    expect((await storage.getThreads({ limit: 1, offset: 1 })).map((t) => t.id)).toEqual(['t-old']);
  });

  it('deleting a thread CASCADES to its emails (and rebuildThreads leaves mail intact)', async () => {
    const storage = ctx.get();
    await storage.insertEmail(makeEmail({ id: 'tc1', threadId: 'th-cascade' }));
    expect(await storage.getEmail('tc1')).not.toBeNull();

    const rebuilt = await storage.rebuildThreads();
    expect(rebuilt.emailsUpdated).toBeGreaterThanOrEqual(0);
    expect(await storage.getEmail('tc1')).not.toBeNull();

    const liveThreadId = (await storage.getEmail('tc1'))!.threadId;
    await storage.deleteThread(liveThreadId);
    expect(await storage.getEmail('tc1')).toBeNull();
  });

  it('attachments insert → list → delete, scoped to their email', async () => {
    const storage = ctx.get();
    await storage.insertEmail(makeEmail({ id: 'at1' }));
    await storage.insertAttachment({
      id: 'a-1', emailId: 'at1', filename: 'report.pdf', contentType: 'application/pdf',
      size: 2048, filePath: '/tmp/report.pdf', createdAt: T0,
    });
    await storage.insertAttachment({
      id: 'a-2', emailId: 'at1', filename: 'photo.png', contentType: 'image/png',
      size: 64, filePath: '/tmp/photo.png', createdAt: T0,
    });

    const list = await storage.getAttachments('at1');
    expect(list.map((a) => a.filename).sort()).toEqual(['photo.png', 'report.pdf']);
    expect(list.find((a) => a.id === 'a-1')).toMatchObject({ size: 2048, contentType: 'application/pdf' });
    expect(await storage.getAttachments('no-such-email')).toEqual([]);

    await storage.deleteAttachment('a-1');
    expect((await storage.getAttachments('at1')).map((a) => a.id)).toEqual(['a-2']);

    // Deleting the email cascades its remaining attachments away.
    await storage.deleteEmail('at1');
    expect(await storage.getAttachments('at1')).toEqual([]);
  });
});

// ===========================================================================
// Contacts, sender stats and signature patterns
// ===========================================================================

// The contacts/sender_stats tables back the people sidebar and every "is this
// sender important" heuristic. Counters must ACCUMULATE (never overwrite) and
// firstSeen must never drift forward, or an older folder syncing late would
// rewrite a contact's history.
describe('SQLiteStorage contact and sender-stat operations', () => {
  const ctx = withStorage(async (storage) => {
    await storage.syncFolders([makeFolder('f-inbox', 'INBOX'), makeFolder('f-sent', 'Sent', { specialUse: '\\Sent' })]);
  });

  it('upsertContact creates, then accumulates counts and keeps the earliest firstSeen', async () => {
    const storage = ctx.get();
    const created = await storage.upsertContact({
      email: 'Alice@Example.test', name: 'Alice', receivedCount: 1, firstSeen: T0, lastSeen: T0,
    });
    expect(created.email).toBe('alice@example.test'); // normalized
    expect(created.receivedCount).toBe(1);

    const again = await storage.upsertContact({
      email: 'alice@example.test', receivedCount: 2, firstSeen: T0 - 500, lastSeen: T0 + 500,
    });
    expect(again.receivedCount).toBe(3);
    expect(again.firstSeen).toBe(T0 - 500);
    expect(again.lastSeen).toBe(T0 + 500);

    const stored = await storage.getContactByEmail('alice@example.test');
    expect(stored).toMatchObject({ name: 'Alice', receivedCount: 3, emailCount: 2 });
    expect(await storage.getContact(stored!.id)).toMatchObject({ email: 'alice@example.test' });
  });

  it('lists, searches, counts, updates and deletes contacts', async () => {
    const storage = ctx.get();
    await storage.upsertContact({ email: 'bob@example.test', name: 'Bob Builder', firstSeen: T0, lastSeen: T0 });

    const all = await storage.getContacts({ limit: 50, offset: 0 });
    expect(all.map((c) => c.email)).toContain('bob@example.test');
    const searched = await storage.getContacts({ limit: 50, offset: 0, search: 'Builder' });
    expect(searched.map((c) => c.email)).toEqual(['bob@example.test']);
    expect(await storage.getContactsCount('Builder')).toBe(1);
    expect(await storage.getContactsCount('nobody-here')).toBe(0);

    const bob = (await storage.getContactByEmail('bob@example.test'))!;
    await storage.updateContact(bob.id, { displayName: 'Bob', isFavorite: true, organization: 'Acme' });
    expect(await storage.getContact(bob.id)).toMatchObject({ displayName: 'Bob', isFavorite: true, organization: 'Acme' });

    await storage.deleteContact(bob.id);
    expect(await storage.getContact(bob.id)).toBeNull();
    expect(await storage.getContactByEmail('nobody@example.test')).toBeNull();
    expect(await storage.getContact('no-such-id')).toBeNull();
  });

  it('extractContactsFromEmail records the sender for a received message', async () => {
    const storage = ctx.get();
    await storage.extractContactsFromEmail(
      makeEmail({ id: 'ex1', fromAddress: 'carol@example.test', fromName: 'Carol', date: T0 }),
      'received',
    );
    expect(await storage.getContactByEmail('carol@example.test')).toMatchObject({ name: 'Carol' });
  });

  it('sender stats accumulate deltas, expose domain rollups, and support absolute rewrites', async () => {
    const storage = ctx.get();
    await storage.upsertSenderStats({ email: 'dave@corp.test', receivedCount: 2, readCount: 1, eventDate: T0 });
    await storage.upsertSenderStats({ email: 'dave@corp.test', receivedCount: 3, eventDate: T0 + 10 });

    const stats = await storage.getSenderStats('dave@corp.test');
    expect(stats).toMatchObject({ email: 'dave@corp.test', domain: 'corp.test', receivedCount: 5, readCount: 1 });
    expect(await storage.getSenderStats('nobody@corp.test')).toBeNull();
    expect((await storage.getSenderStatsByDomain('corp.test')).map((s) => s.email)).toEqual(['dave@corp.test']);

    // Absolute (idempotent) write — the reconciler's "set to the truth" path.
    await storage.setSenderStatsCounts([{
      email: 'dave@corp.test', receivedCount: 9, readCount: 4, deletedCount: 1, repliedCount: 2, sentToCount: 3,
    }]);
    expect(await storage.getSenderStats('dave@corp.test')).toMatchObject({
      receivedCount: 9, readCount: 4, deletedCount: 1, repliedCount: 2, sentToCount: 3,
    });
    // Re-applying the same absolute values must not double them.
    await storage.setSenderStatsCounts([{
      email: 'dave@corp.test', receivedCount: 9, readCount: 4, deletedCount: 1, repliedCount: 2, sentToCount: 3,
    }]);
    expect((await storage.getSenderStats('dave@corp.test'))!.receivedCount).toBe(9);
  });

  it('VIP and blocked flags round-trip through the sender lists', async () => {
    const storage = ctx.get();
    await storage.upsertSenderStats({ email: 'vip@corp.test', receivedCount: 1, eventDate: T0 });
    await storage.upsertSenderStats({ email: 'spam@corp.test', receivedCount: 1, eventDate: T0 });

    await storage.setSenderVip('vip@corp.test', true);
    await storage.setSenderBlocked('spam@corp.test', true);
    expect((await storage.getVipSenders()).map((s) => s.email)).toEqual(['vip@corp.test']);
    expect((await storage.getBlockedSenders()).map((s) => s.email)).toEqual(['spam@corp.test']);

    await storage.setSenderVip('vip@corp.test', false);
    expect(await storage.getVipSenders()).toEqual([]);
  });

  it('derives sender engagement, context, repetition and thread depth from the mail itself', async () => {
    const storage = ctx.get();
    await storage.insertEmail(makeEmail({
      id: 'sg1', threadId: 'th-sg', fromAddress: 'erin@corp.test', subject: 'Weekly digest', tags: '|INBOX|read|',
    }));
    await storage.insertEmail(makeEmail({
      id: 'sg2', threadId: 'th-sg', fromAddress: 'erin@corp.test', subject: 'Weekly digest',
      inReplyTo: '<sg1@example.test>', tags: '|INBOX|',
    }));

    expect(await storage.getSenderEngagement('erin@corp.test')).toMatchObject({ received: 2, read: 1, deleted: 0 });
    expect(storage.getThreadDepths(['th-sg'])).toEqual({ 'th-sg': 2 });
    expect(storage.getThreadDepths([])).toEqual({});
    expect(storage.getThreadDepths(['no-such-thread'])).toEqual({});

    // A subject-less message must be counted, not crash the stats build.
    await storage.insertEmail(makeEmail({
      id: 'sg3', threadId: 'th-sg3', fromAddress: 'erin@corp.test', subject: null, tags: '|INBOX|',
    }));

    const repetition = storage.getSenderRepetitionStats(['Erin@corp.test']);
    expect(repetition.sameSubject['erin@corp.test']['Weekly digest']).toBe(2);
    expect(repetition.sameSubject['erin@corp.test']['']).toBe(1);
    expect(repetition.totalEmails).toBeGreaterThanOrEqual(2);
    expect(storage.getSenderRepetitionStats([])).toEqual({ sameSubject: {}, totalEmails: 0 });

    const context = storage.getSenderContextBatch(['erin@corp.test']);
    expect(Object.keys(context)).toContain('erin@corp.test');
  });

  it('phone-mining state and the newest-email-per-sender index round-trip', async () => {
    const storage = ctx.get();
    // The mining watermark lives ON the contact row, so the contact must exist —
    // the scan skips senders it has already mined through.
    await storage.upsertContact({ email: 'erin@corp.test', firstSeen: T0, lastSeen: T0 });
    storage.setPhoneMiningState('erin@corp.test', T0 + 5, { '+15550001111': 3 });
    const state = storage.getPhoneMiningState();
    expect(state.get('erin@corp.test')).toEqual({ through: T0 + 5, phones: { '+15550001111': 3 } });
    expect(storage.getNewestEmailDateBySender().get('erin@corp.test')).toBe(T0);
  });

  it('enrichment candidates track the watermark and drop out once enriched past it', async () => {
    const storage = ctx.get();
    // 'erin@corp.test' has inbound mail dated T0 (inserted above) and a contact
    // row, so it is enrichable. A watermark ahead of that mail must retire it —
    // otherwise the enricher re-processes the same signatures forever.
    const erin = (await storage.getContactByEmail('erin@corp.test'))!;
    expect((await storage.getContactEnrichmentCandidates({ limit: 50 })).map((c) => c.email))
      .toContain('erin@corp.test');

    await storage.recordContactEnrichmentWatermark(erin.id, T0 + 1);
    expect((await storage.getContactEnrichmentCandidates({ limit: 50 })).map((c) => c.email))
      .not.toContain('erin@corp.test');
  });

  it('applyContactEnrichment writes the signature-mined profile and its history row', async () => {
    const storage = ctx.get();
    const contact = await storage.upsertContact({ email: 'grace@acme-corp.test', firstSeen: T0, lastSeen: T0 });

    const updated = await storage.applyContactEnrichment({
      contactId: contact.id,
      enrichment: {
        fullName: 'Grace Hopper', designation: 'Rear Admiral', companyName: 'Acme Corp',
        companyDomain: 'acme-corp.test', linkedinUrl: 'https://li.test/grace',
      },
      kind: 'individual',
      mobileE164: '+15550003333',
      enrichedThroughEmailAt: T0 + 100,
      source: 'llm',
    });

    expect(updated).toMatchObject({
      organization: 'Acme Corp', title: 'Rear Admiral', mobileE164: '+15550003333',
      enrichedThroughEmailAt: T0 + 100, enrichmentSource: 'llm',
    });
    // A person identity is minted so later rows for the same human can converge.
    expect(updated.personId).toBeTruthy();
    // The audit trail is what lets the UI say "previously at ..." after a job change.
    const history = await storage.getContactEnrichmentHistory(contact.id);
    expect(history[0]).toMatchObject({ organization: 'Acme Corp', designation: 'Rear Admiral', effectiveTo: null });
  });

  it('unknown ids return empty collections instead of throwing', async () => {
    const storage = ctx.get();
    // These run on a schedule from the main process — a throw here would take
    // the enrichment/avatar loops down on any stale id.
    expect(await storage.getContactEnrichmentHistory('no-such-contact')).toEqual([]);
    expect(await storage.getContactsRelatedByPerson('no-such-contact')).toEqual([]);
    expect(await storage.getRecentInboundEmailsForContact('nobody@example.test')).toEqual([]);
  });

  it('avatar review states gate the background discovery queue', async () => {
    const storage = ctx.get();
    const contact = await storage.upsertContact({ email: 'frank@corp.test', firstSeen: T0, lastSeen: T0 });
    await storage.applyPhoneClassification('frank@corp.test', '+15550002222', null, 'https://li.test/frank');
    await storage.applyPersonalUrls('frank@corp.test', { twitter: 'https://x.test/frank', socials: [] });
    await storage.applyCompanyUrls('corp.test', { website: 'https://corp.test', socials: [] });
    await storage.applyLinkedInUrl('frank@corp.test', 'https://li.test/frank2');

    // Never-probed contacts are queued for a photo lookup…
    const staleBefore = Math.floor(Date.now() / 1000) + 3600;
    expect((await storage.getContactsNeedingAvatar(100, staleBefore)).map((c) => c.email))
      .toContain('frank@corp.test');

    // …and every review state (pending/confirmed/rejected) takes them out again,
    // so the queue can't re-suggest a photo the user already judged.
    await storage.setContactAvatarCandidate(contact.id, 'data:image/png;base64,AAA');
    expect(await storage.getContact(contact.id)).toMatchObject({ avatarStatus: 'pending' });
    expect((await storage.getContactsNeedingAvatar(100, staleBefore)).map((c) => c.email))
      .not.toContain('frank@corp.test');

    await storage.confirmContactAvatar(contact.id);
    expect(await storage.getContact(contact.id)).toMatchObject({ avatarStatus: 'confirmed' });

    await storage.rejectContactAvatar(contact.id);
    expect(await storage.getContact(contact.id)).toMatchObject({ avatarStatus: 'rejected', avatarUrl: null });

    await storage.markContactAvatarChecked(contact.id);
    expect((await storage.getContact(contact.id))!.avatarCheckedAt).not.toBeNull();
  });

  it('signature patterns: save, look up by email and selector, count, delete and clear', async () => {
    const storage = ctx.get();
    await storage.saveSignaturePattern({
      email: 'gina@corp.test', htmlSelector: 'div.gmail_signature', confidence: 'high', sampleHtml: '<div>Gina</div>',
    });
    await storage.saveSignaturePattern({
      email: 'hank@corp.test', htmlSelector: 'table.sig', confidence: 'low',
    });

    expect(await storage.getSignaturePatternByEmail('gina@corp.test')).toMatchObject({
      htmlSelector: 'div.gmail_signature', confidence: 'high',
    });
    expect(await storage.getSignaturePatternBySelector('table.sig')).toMatchObject({ email: 'hank@corp.test' });
    expect(await storage.getSignaturePatternBySelector('nope')).toBeNull();
    expect(await storage.getSignaturePatternByEmail('nobody@corp.test')).toBeNull();
    expect(await storage.getSignaturePatternsCount()).toBe(2);
    expect((await storage.getSignaturePatterns({ limit: 1, offset: 0 })).length).toBe(1);

    await storage.deleteSignaturePatternByEmail('gina@corp.test');
    expect(await storage.getSignaturePatternByEmail('gina@corp.test')).toBeNull();
    // Deleting by an address with no pattern is a silent no-op.
    await expect(storage.deleteSignaturePatternByEmail('nobody@corp.test')).resolves.toBeUndefined();

    const remaining = (await storage.getSignaturePatterns())[0];
    await storage.deleteSignaturePattern(remaining.id);
    expect(await storage.getSignaturePatternsCount()).toBe(0);

    await storage.saveSignaturePattern({ email: 'ivy@corp.test', htmlSelector: 'p.sig', confidence: 'medium' });
    await storage.clearSignaturePatterns();
    expect(await storage.getSignaturePatterns()).toEqual([]);
  });
});

// ===========================================================================
// Filter rules & labels
// ===========================================================================

// Filter rules run in priority order on every incoming message; labels are the
// tag vocabulary the UI colours. Both are user-authored data that must survive a
// restart exactly as entered — a lost condition silently stops filtering mail.
describe('SQLiteStorage filter rules and labels', () => {
  const ctx = withStorage();

  it('creates, lists, updates, reorders and deletes filter rules', async () => {
    const storage = ctx.get();
    expect(await storage.getFilterRules()).toEqual([]);

    const first = await storage.createFilterRule({
      name: 'Invoices',
      conditions: [{ field: 'subject', operator: 'contains', value: 'invoice' }],
      actions: [{ type: 'applyLabel', value: 'Finance' }],
    });
    const second = await storage.createFilterRule({
      name: 'Newsletters',
      enabled: false,
      matchType: 'any',
      conditions: [{ field: 'from', operator: 'endsWith', value: '@news.test' }],
      actions: [{ type: 'markRead' }],
      stopProcessing: true,
    });

    expect(first).toMatchObject({ name: 'Invoices', enabled: true, matchType: 'all', stopProcessing: false });
    expect(second.conditions).toEqual([{ field: 'from', operator: 'endsWith', value: '@news.test' }]);
    expect((await storage.getFilterRules()).length).toBe(2);
    // A disabled rule must be excluded from the evaluation list.
    expect((await storage.getEnabledFilterRules()).map((r) => r.id)).toEqual([first.id]);

    const updated = await storage.updateFilterRule(second.id, { enabled: true, name: 'News' });
    expect(updated).toMatchObject({ enabled: true, name: 'News' });
    expect(await storage.updateFilterRule('no-such-rule', { name: 'x' })).toBeNull();

    await storage.reorderFilterRules([second.id, first.id]);
    expect((await storage.getFilterRules()).map((r) => r.id)).toEqual([second.id, first.id]);

    await storage.deleteFilterRule(first.id);
    expect((await storage.getFilterRules()).map((r) => r.id)).toEqual([second.id]);
  });

  it('creates, updates and deletes labels, recording the server-sync flag', async () => {
    const storage = ctx.get();
    expect(await storage.getLabels()).toEqual([]);

    const local = await storage.createLabel({ name: 'Personal', color: '#2563eb' });
    const mirrored = await storage.createLabel({ name: 'Work' }, true);
    expect(local).toMatchObject({ name: 'Personal', color: '#2563eb', syncedToServer: false });
    expect(mirrored.syncedToServer).toBe(true);

    expect(await storage.updateLabel(local.id, { color: '#ff0000' })).toMatchObject({ color: '#ff0000' });
    expect(await storage.updateLabel('no-such-label', { color: '#000000' })).toBeNull();

    await storage.deleteLabel(local.id);
    expect((await storage.getLabels()).map((l) => l.name)).toEqual(['Work']);
  });
});

// Editing a category definition changes what `has_category` derives to without
// touching any email row, so the facade enqueues the affected threads itself. That
// enqueue is best-effort bookkeeping — if it fails, the user's category edit must
// still be saved (the periodic drain converges anyway).
describe('SQLiteStorage category-definition edits survive a broken read-model queue', () => {
  let dir: string;
  let storage: SQLiteStorage;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'sqlite-storage-dirty-'));
    storage = new SQLiteStorage({ dbPath: join(dir, 'mail.db') });
    await storage.initialize();
    // Remove the queue the enqueue writes into, simulating any failure of that
    // best-effort step.
    (storage as unknown as { db: { exec: (sql: string) => unknown } }).db
      .exec('DROP TRIGGER IF EXISTS emails_read_model_dirty_insert; DROP TABLE read_model_dirty');
  });

  afterEach(async () => {
    await storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('still saves and deletes the definition', () => {
    expect(() => storage.upsertCategoryDefinition({ slug: 'receipts', name: 'Receipts' })).not.toThrow();
    expect(storage.getCategoryDefinitions().map((d) => d.slug)).toContain('receipts');

    expect(storage.deleteCategoryDefinition('receipts')).toBe(true);
    expect(storage.getCategoryDefinitions().map((d) => d.slug)).not.toContain('receipts');
  });
});

// ===========================================================================
// Pending operations (IMAP queue) & pending sends (SMTP outbox)
// ===========================================================================

// This queue is the durability boundary for every optimistic action: if a row is
// lost or a dead-lettered row leaks back into the live queue, the user either
// sees an action silently revert or the app retries a permanently-failing IMAP
// command forever.
describe('SQLiteStorage pending operations queue', () => {
  const ctx = withStorage();

  afterEach(async () => { await ctx.get().clearPendingOperations(); });

  it('saves, lists, retries, dead-letters and prunes operations', async () => {
    const storage = ctx.get();
    expect(await storage.getPendingOperations()).toEqual([]);
    expect(await storage.getPendingOperationCounts()).toEqual({ pending: 0, failed: 0 });

    const id = await storage.savePendingOperation({
      type: 'markRead', folderPath: 'INBOX', uid: 5, data: { seen: true }, retryCount: 0,
    });
    expect(id).toBeGreaterThan(0);

    const ops = await storage.getPendingOperations();
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ id, type: 'markRead', folderPath: 'INBOX', uid: 5, status: 'pending', retryCount: 0 });
    expect(ops[0].data).toEqual({ seen: true }); // JSON payload survives the round-trip

    await storage.updatePendingOperationStatus(id, 'executing');
    await storage.updatePendingOperationRetry(id, 2);
    expect((await storage.getPendingOperations())[0]).toMatchObject({ status: 'executing', retryCount: 2 });

    // In-flight ops guard the optimistic value against server-wins reconcile.
    expect(await storage.getPendingOperationUidsByFolder('INBOX')).toEqual([5]);

    await storage.markPendingOperationFailed(id, 'NO permission denied', {
      attemptedCommand: 'UID STORE 5 +FLAGS (\\Seen)', serverResponse: 'NO [CANNOT]',
    });
    // A dead-lettered op must NOT reload into the live queue…
    expect(await storage.getPendingOperations()).toEqual([]);
    // …and must stop protecting the optimistic value.
    expect(await storage.getPendingOperationUidsByFolder('INBOX')).toEqual([]);
    expect(await storage.getPendingOperationCounts()).toEqual({ pending: 0, failed: 1 });

    const failed = await storage.getFailedOperations();
    expect(failed[0]).toMatchObject({
      id, status: 'failed', lastError: 'NO permission denied', serverResponse: 'NO [CANNOT]',
    });
    expect(failed[0].data).toEqual({ seen: true }); // the payload survives dead-lettering

    // A failure recorded without diagnostics reads back as explicit nulls.
    const bare = await storage.savePendingOperation({ type: 'move', folderPath: 'INBOX', uid: 6, retryCount: 0 });
    await storage.markPendingOperationFailed(bare, 'timeout');
    const bareRow = (await storage.getFailedOperations()).find((f) => f.id === bare)!;
    expect(bareRow).toMatchObject({ lastError: 'timeout', attemptedCommand: null, serverResponse: null, data: null });

    // A user Retry re-arms it as pending with a cleared retry count.
    await storage.resetFailedOperation(id);
    expect((await storage.getPendingOperations())[0]).toMatchObject({ status: 'pending', retryCount: 0 });

    await storage.deletePendingOperation(id);
    expect(await storage.getPendingOperations()).toEqual([]);
  });

  it('batch-saves, batch-deletes, and treats empty batches as no-ops', async () => {
    const storage = ctx.get();
    const ids = await storage.savePendingOperationsBatch([
      { type: 'move', folderPath: 'INBOX', uid: 1, retryCount: 0 },
      { type: 'move', folderPath: 'INBOX', uid: 2, data: { to: 'Archive' }, retryCount: 1 },
    ]);
    expect(ids).toHaveLength(2);
    expect((await storage.getPendingOperations()).map((o) => o.uid).sort()).toEqual([1, 2]);

    expect(await storage.savePendingOperationsBatch([])).toEqual([]);
    await expect(storage.deletePendingOperationsBatch([])).resolves.toBeUndefined();

    await storage.deletePendingOperationsBatch(ids);
    expect(await storage.getPendingOperations()).toEqual([]);
  });

  it('re-saving the same (type, folderPath, uid) replaces rather than duplicating', async () => {
    const storage = ctx.get();
    await storage.savePendingOperation({ type: 'markRead', folderPath: 'INBOX', uid: 9, retryCount: 0 });
    await storage.savePendingOperation({ type: 'markRead', folderPath: 'INBOX', uid: 9, retryCount: 3 });

    const ops = await storage.getPendingOperations();
    expect(ops).toHaveLength(1);
    expect(ops[0].retryCount).toBe(3);
  });

  it('deleteFailedOperations clears only the dead-letter rows', async () => {
    const storage = ctx.get();
    const keep = await storage.savePendingOperation({ type: 'markRead', folderPath: 'INBOX', uid: 20, retryCount: 0 });
    const drop = await storage.savePendingOperation({ type: 'markRead', folderPath: 'INBOX', uid: 21, retryCount: 0 });
    await storage.markPendingOperationFailed(drop, 'boom');

    expect(await storage.deleteFailedOperations()).toBe(1);
    expect((await storage.getPendingOperations()).map((o) => o.id)).toEqual([keep]);
    expect(await storage.deleteFailedOperations()).toBe(0);
  });
});

// The outbox owns mail the user believes is sent. The invariants that matter:
// an undo only works while the send is still HELD, and once SMTP accepted the
// message it can never be re-sent — only appended to Sent.
describe('SQLiteStorage pending sends (outbox)', () => {
  const ctx = withStorage();

  // cancelHeldSend compares the hold against Date.now(), so the clock is pinned
  // to the fixture epoch. ONLY Date is faked — the ReadModelMaintainer's
  // setInterval/setImmediate must keep running on the real timer queue.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0 * 1000);
  });

  afterEach(async () => {
    await ctx.get().clearPendingSends();
    vi.useRealTimers();
  });

  it('holds a send for the undo window and cancels it only while still held', async () => {
    const storage = ctx.get();
    const now = T0;
    const held = await storage.savePendingSend({ to: 'a@example.test', subject: 'Hi' }, now + 30);

    // Held sends are not due yet.
    expect(await storage.getDueSends(now)).toEqual([]);
    expect((await storage.getAllSends())[0]).toMatchObject({ id: held, status: 'pending', nextRetryAt: now + 30 });

    expect(await storage.cancelHeldSend(held)).toBe(true);
    expect(await storage.getAllSends()).toEqual([]);
    // Cancelling something that is no longer held (or never existed) reports false.
    expect(await storage.cancelHeldSend(held)).toBe(false);
  });

  it('clearSendHold releases the hold so the drain picks the send up', async () => {
    const storage = ctx.get();
    const id = await storage.savePendingSend({ to: 'b@example.test' }, T0 + 30);
    await storage.clearSendHold(id);

    const due = await storage.getDueSends(T0);
    expect(due.map((s) => s.id)).toEqual([id]);
    expect(due[0].payload).toEqual({ to: 'b@example.test' });
    // Undo is too late once the hold is gone.
    expect(await storage.cancelHeldSend(id)).toBe(false);
  });

  it('once SMTP accepted, the send leaves the send path and only awaits the Sent append', async () => {
    const storage = ctx.get();
    const id = await storage.savePendingSend({ to: 'c@example.test' });
    expect((await storage.getDueSends(T0)).map((s) => s.id)).toEqual([id]);

    await storage.markSendAppendPending(id, 'From: me\r\n\r\nbody', '<sent-1@example.test>');

    expect(await storage.getDueSends(T0)).toEqual([]); // never re-sent
    const appendPending = await storage.getAppendPendingSends();
    expect(appendPending[0]).toMatchObject({
      id, status: 'append_pending', smtpAccepted: true, sentAppendPending: true,
      rawMime: 'From: me\r\n\r\nbody', messageId: '<sent-1@example.test>',
    });

    await storage.deletePendingSend(id);
    expect(await storage.getAllSends()).toEqual([]);
  });

  it('records retry attempts, dead-letters, resets, and reports counts', async () => {
    const storage = ctx.get();
    const id = await storage.savePendingSend({ to: 'd@example.test' });

    await storage.updatePendingSendAttempt(id, 1, 'ETIMEDOUT', T0 + 60);
    expect((await storage.getAllSends())[0]).toMatchObject({ retryCount: 1, lastError: 'ETIMEDOUT', nextRetryAt: T0 + 60 });
    expect(await storage.getDueSends(T0)).toEqual([]);
    expect(await storage.getDueSends(T0 + 60)).toHaveLength(1);

    await storage.updatePendingSendStatus(id, 'executing');
    expect((await storage.getAllSends())[0].status).toBe('executing');

    await storage.markPendingSendFailed(id, '550 rejected');
    expect(await storage.getPendingSendCounts()).toEqual({ pending: 0, failed: 1 });

    await storage.resetPendingSend(id);
    expect(await storage.getPendingSendCounts()).toEqual({ pending: 1, failed: 0 });
    expect((await storage.getAllSends())[0].nextRetryAt).toBeNull();

    await storage.markPendingSendFailed(id, '550 rejected');
    expect(await storage.deleteFailedSends()).toBe(1);
    expect(await storage.deleteFailedSends()).toBe(0);
    expect(await storage.getPendingSendCounts()).toEqual({ pending: 0, failed: 0 });
  });
});
