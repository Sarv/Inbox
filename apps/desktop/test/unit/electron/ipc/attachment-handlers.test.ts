import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import * as fs from 'fs';
import { tmpdir } from 'os';
import { basename, dirname, join, relative, sep } from 'path';

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The attachment IPC handlers and the disk cache underneath them.
 *
 * `getOrCacheAttachment` had no tests at all, yet every attachment path in the
 * app — save, forward-as-base64, open-in-system-app and now the in-app viewer —
 * funnels through it. The regressions guarded here are the ones that look like
 * working software: an attachment that silently re-downloads on every open, a
 * truncated file cached forever as a corrupt document, and (the security ones)
 * an executable handed to `shell.openPath` on a single click, and attachments
 * lying on disk in plaintext (CASA M-7: the cache is sealed and per account, so
 * every read here goes through `readCachedAttachment`, never a raw file read).
 *
 * Real filesystem, real cache logic, real sealing; only IMAP, storage, the DB
 * key and the Electron dialogs are faked.
 */

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...a: any[]) => any>(),
  userData: '',
  /** What `getDbEncryptionKey` answers — the store derives both its keys from it. */
  dbKey: 'k'.repeat(64),
  storage: { getEmail: vi.fn(), getFolder: vi.fn(), updateEmail: vi.fn() },
  /** Storage of a NON-active account, reachable only via getStorageFor. */
  otherStorage: { getEmail: vi.fn(), getFolder: vi.fn(), updateEmail: vi.fn() },
  syncEngine: {
    isConnected: vi.fn(() => true),
    fetchAttachmentPart: vi.fn(),
    fetchAttachment: vi.fn(),
    getCalendarIcs: vi.fn(),
  },
  saveDialog: { canceled: false, filePath: '' },
  openPath: vi.fn(async (_filePath: string) => ''),
  frame: {},
  webContents: { mainFrame: {} as object, send: vi.fn() },
  manager: null as any,
  scannerSetup: vi.fn(),
  missingSetupAssert: vi.fn(),
  warning: vi.fn(),
  scanDownload: vi.fn(),
  openScannerSetup: vi.fn(),
  scanAssertCurrent: vi.fn(),
  scanDispose: vi.fn(),
}));
h.webContents.mainFrame = h.frame;

vi.mock('electron', () => ({
  ipcMain: { handle: (name: string, fn: (...a: any[]) => any) => h.handlers.set(name, fn) },
  dialog: { showSaveDialog: async () => h.saveDialog },
  shell: { openPath: (p: string) => h.openPath(p) },
  app: { getPath: () => h.userData },
}));
vi.mock('../../../../electron/shared', () => ({
  requireStorage: () => h.storage,
  requireSyncEngine: () => h.syncEngine,
  getMainWindow: () => ({ webContents: h.webContents, isDestroyed: () => false }),
  getExtensionManager: () => h.manager,
  getSyncEngine: () => h.syncEngine,
  getStorageFor: (id: string) => (id === 'acct-2' ? h.otherStorage : null),
  getSyncEngineFor: () => h.syncEngine,
  getCurrentAccountId: () => 'acct-1',
}));
vi.mock('../../../../electron/services/db-key-store', () => ({
  getDbEncryptionKey: () => h.dbKey,
}));
vi.mock('../../../../electron/services/body-prefetch-scheduler', () => ({
  deferBodyPrefetch: vi.fn(),
}));
vi.mock('../../../../electron/services/accounts-runtime', () => ({ ensureAccountRuntime: vi.fn() }));
vi.mock('../../../../electron/services/accounts-registry', () => ({
  readRegistryAccounts: () => [{ id: 'acct-1' }, { id: 'acct-2' }],
}));
vi.mock('../../../../electron/services/antivirus-scan-service', () => ({
  getAntivirusScanService: () => ({
    getAttachmentSetupRequirement: async (extensionId: string, accountId: string) => {
      const setup = await h.scannerSetup(extensionId, accountId);
      return setup.configured && setup.allowedAccountIds.includes(accountId) ? undefined : { assertCurrent: h.missingSetupAssert };
    },
    scanAttachmentForDownload: h.scanDownload,
    openSetup: h.openScannerSetup,
  }),
}));
vi.mock('../../../../electron/services/attachment-unscanned-warning', () => ({
  confirmUnscannedAttachment: h.warning,
}));
vi.mock('../../../../electron/ipc/agent-handlers', () => ({ logUserAction: vi.fn() }));

import { registerEmailHandlers } from '../../../../electron/ipc/email-handlers';
import {
  accountAttachmentDir,
  ATTACHMENT_CACHE_MAX_BYTES,
  attachmentErrorMessage,
  cachedAttachmentSize,
  getOrCacheAttachment,
  legacyAttachmentCacheRoot,
  legacyAttachmentDir,
  MAX_ATTACHMENT_BYTES,
  pruneAttachmentCache,
  readCachedAttachment,
  resetAttachmentStoreKeys,
  resolveAttachmentFile,
  seedAttachmentCache,
  storeCachedAttachment,
} from '../../../../electron/services/attachment-cache';

const TMP = mkdtempSync(join(tmpdir(), 'attachment-handlers-'));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

/** The active account in this harness, and the other registered one. */
const ACTIVE = 'acct-1';
const OTHER = 'acct-2';
const EMAIL_ID = 'email-1';
const FILENAME = 'report.pdf';
const BYTES = Buffer.from('%PDF-1.7 body');
const CALENDAR_ICS = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:synthetic@example.invalid\r\nDTSTART:20261005T090000Z\r\nSUMMARY:Synthetic\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';
const UNREADABLE = 'The attachment could not be read. Try again.';

/** The sync engine as `getOrCacheAttachment` wants it. */
const engine = () => h.syncEngine as unknown as Parameters<typeof getOrCacheAttachment>[5];

const storeRoot = () => join(h.userData, 'attachment-store');
const previewRoot = () => join(h.userData, 'attachment-previews');
const GENERATION_MARKER = '.cache-generation';

/** Every file under `dir`, recursively. */
function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

/** Every file cached for one account (temp files included). The email and file
 *  names on disk are keyed hashes, so tests count entries and read them back
 *  through the API rather than look a name up. */
const cachedFiles = (accountId = ACTIVE) => walk(accountAttachmentDir(accountId));
/** Every entry in the sealed store, whichever account, bar the generation marker. */
const storeFiles = () => walk(storeRoot()).filter((file) => basename(file) !== GENERATION_MARKER);
/** The private copies handed to other apps. */
const previewCopies = () => walk(previewRoot());
const isInside = (dir: string, file: string) => file.startsWith(dir + sep);

/**
 * The store must not give away what it holds: no plaintext name (account,
 * email or file) in any path, and no plaintext bytes in any file. `contents`
 * should be long enough that a chance match in ciphertext is impossible.
 */
function expectStoreHidesPlaintext(names: string[], contents: Buffer[]) {
  const files = walk(storeRoot());
  expect(files.length).toBeGreaterThan(0); // an empty store would pass vacuously
  for (const file of files) {
    const shown = relative(h.userData, file);
    for (const name of names) expect(shown, `a path names "${name}"`).not.toContain(name);
    const onDisk = readFileSync(file);
    for (const content of contents) expect(onDisk.includes(content), `${shown} holds plaintext`).toBe(false);
  }
}

/** Step past the 5-minute prune throttle so an explicit prune actually runs. The
 *  offset grows, because each run records the (faked) time it ran at. */
let clockOffset = 0;
async function pruneNow() {
  clockOffset += 10 * 60 * 1000;
  const at = Date.now() + clockOffset;
  vi.useFakeTimers();
  vi.setSystemTime(at);
  try {
    await pruneAttachmentCache();
  } finally {
    vi.useRealTimers();
  }
}

const download = () => h.handlers.get('emails:downloadAttachment')!;
const base64 = () => h.handlers.get('emails:getAttachmentBase64')!;
const preview = () => h.handlers.get('emails:previewAttachment')!;
const downloadEvent = () => ({ sender: h.webContents, senderFrame: h.frame });

function enableScanner(options: { active?: boolean; granted?: boolean; manifest?: boolean } = {}) {
  h.manager = {
    getRegistry: () => ({
      getAll: () => [{ id: 'clamav-scan', enabled: true, grantedPermissions: options.granted === false ? [] : ['security:scan-attachments'] }],
      getLoaded: () => options.manifest === false ? undefined : { manifest: { permissions: ['security:scan-attachments'] } },
    }),
    getHost: () => ({ isActive: () => options.active !== false }),
  };
}

beforeEach(() => {
  h.userData = mkdtempSync(join(TMP, 'ud-'));
  h.dbKey = 'k'.repeat(64);
  resetAttachmentStoreKeys();
  h.handlers.clear();
  h.manager = null;
  h.webContents.send.mockClear();
  h.scannerSetup.mockReset().mockResolvedValue({ configured: true, allowedAccountIds: ['acct-1', 'acct-2'] });
  h.missingSetupAssert.mockReset().mockResolvedValue(undefined);
  h.warning.mockReset().mockResolvedValue('cancel');
  h.scanAssertCurrent.mockReset().mockResolvedValue(undefined);
  h.scanDispose.mockReset(); h.openScannerSetup.mockReset().mockResolvedValue(undefined);
  h.scanDownload.mockReset().mockImplementation(async (_id, _email, _account, _name, options) => {
    const content = Buffer.from('scanner verified bytes');
    options.onProgress('scanning');
    return { content, assertCurrent: h.scanAssertCurrent, dispose: () => { content.fill(0); h.scanDispose(); } };
  });
  h.storage.getEmail.mockReset().mockResolvedValue({
    id: EMAIL_ID,
    folderId: 'f1',
    uid: 42,
    attachmentNames: JSON.stringify([FILENAME]),
  });
  h.storage.getFolder.mockReset().mockResolvedValue({ path: 'INBOX' });
  h.storage.updateEmail.mockReset().mockResolvedValue(undefined);
  h.otherStorage.getEmail.mockReset().mockResolvedValue({
    id: EMAIL_ID,
    folderId: 'f9',
    uid: 7,
    attachmentNames: JSON.stringify([FILENAME]),
  });
  h.otherStorage.getFolder.mockReset().mockResolvedValue({ path: 'Archive' });
  h.otherStorage.updateEmail.mockReset().mockResolvedValue(undefined);
  h.syncEngine.isConnected.mockReset().mockReturnValue(true);
  h.syncEngine.fetchAttachmentPart.mockReset().mockResolvedValue({ content: BYTES });
  h.syncEngine.fetchAttachment.mockReset().mockResolvedValue({ content: BYTES });
  h.syncEngine.getCalendarIcs.mockReset().mockResolvedValue(CALENDAR_ICS);
  h.saveDialog = { canceled: false, filePath: join(TMP, 'saved-copy.pdf') };
  h.openPath.mockReset().mockResolvedValue('');
  vi.spyOn(console, 'error').mockImplementation(() => {});
  registerEmailHandlers();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('getOrCacheAttachment', () => {
  // Breaks: every open of the same attachment re-downloads it from IMAP — slow,
  // and on a metered/large mailbox visibly so. The cache exists for this.
  it('serves a second request from disk without touching IMAP', async () => {
    const first = await getOrCacheAttachment(ACTIVE, EMAIL_ID, 'INBOX', 42, FILENAME, engine());
    h.syncEngine.fetchAttachmentPart.mockClear();

    const second = await getOrCacheAttachment(ACTIVE, EMAIL_ID, 'INBOX', 42, FILENAME, engine());

    expect(second).toBe(first);
    expect(h.syncEngine.fetchAttachmentPart).not.toHaveBeenCalled();
    expect(await readCachedAttachment(first)).toEqual(BYTES);
  });

  // Breaks: servers that can't resolve the BODY[part] for an attachment would
  // return an empty result and the user would get "no content" instead of the
  // (more expensive, but working) whole-message parse.
  it('falls back to the whole-message fetch when the MIME part is unresolvable', async () => {
    h.syncEngine.fetchAttachmentPart.mockResolvedValue(null);
    const whole = Buffer.from('whole-message bytes');
    h.syncEngine.fetchAttachment.mockResolvedValue({ content: whole });

    const filePath = await getOrCacheAttachment(ACTIVE, EMAIL_ID, 'INBOX', 42, FILENAME, engine());

    expect(await readCachedAttachment(filePath)).toEqual(whole);
  });

  // Breaks: an oversized (or malicious) attachment fills the disk before the
  // 500 MB LRU prune — which only runs AFTER the write — ever gets a chance.
  it('refuses an attachment over the size cap and writes nothing', async () => {
    h.syncEngine.fetchAttachmentPart.mockResolvedValue({
      content: Buffer.alloc(MAX_ATTACHMENT_BYTES + 1),
    });

    await expect(
      getOrCacheAttachment(ACTIVE, EMAIL_ID, 'INBOX', 42, FILENAME, engine()),
    ).rejects.toThrow(/over the 50 MB limit/);
    expect(cachedFiles()).toEqual([]);
  });

  // TRANSIENT failure. Breaks: a connection blip during the fetch leaves a
  // truncated file at the cached path, which passes the `access` check forever
  // after — the attachment is then permanently a corrupt document with no way
  // to refresh it. Temp-then-rename is what makes the retry work.
  it('leaves no partial file when the write is interrupted, and a retry succeeds', async () => {
    const renameSpy = vi
      .spyOn(fs.promises, 'rename')
      .mockRejectedValueOnce(new Error('EIO: interrupted'));

    await expect(
      getOrCacheAttachment(ACTIVE, EMAIL_ID, 'INBOX', 42, FILENAME, engine()),
    ).rejects.toThrow(/interrupted/);
    expect(cachedFiles()).toEqual([]); // no .partial left behind either

    renameSpy.mockRestore();
    const filePath = await getOrCacheAttachment(ACTIVE, EMAIL_ID, 'INBOX', 42, FILENAME, engine());
    expect(await readCachedAttachment(filePath)).toEqual(BYTES);
  });

  // TRANSIENT failure. Breaks: an offline app answers with a confusing deep
  // error (or an empty file) instead of "not connected".
  it('reports a clean error when IMAP is not connected, and writes nothing', async () => {
    h.syncEngine.isConnected.mockReturnValue(false);

    await expect(
      getOrCacheAttachment(ACTIVE, EMAIL_ID, 'INBOX', 42, FILENAME, engine()),
    ).rejects.toThrow('Not connected to IMAP');
    expect(cachedFiles()).toEqual([]);
    expect(h.syncEngine.fetchAttachmentPart).not.toHaveBeenCalled();
  });

  // Breaks: a non-string argument from a misbehaving renderer throws deep inside
  // path handling instead of being rejected at the edge.
  it('rejects an empty or non-string request', async () => {
    await expect(getOrCacheAttachment(ACTIVE, '', 'INBOX', 42, FILENAME, engine())).rejects.toThrow(
      /non-empty strings/,
    );
    await expect(
      getOrCacheAttachment(ACTIVE, EMAIL_ID, 'INBOX', 42, null as unknown as string, engine()),
    ).rejects.toThrow(/non-empty strings/);
  });

  // SECURITY. Breaks: a crafted attachment name escapes the account's cache
  // directory and clobbers a file elsewhere in userData (db-key.bin, a DB).
  it('keeps a traversing filename inside the cache directory', async () => {
    const filePath = await getOrCacheAttachment(
      ACTIVE,
      EMAIL_ID,
      'INBOX',
      42,
      '../../../db-key.bin',
      engine(),
    );

    expect(isInside(accountAttachmentDir(ACTIVE), filePath)).toBe(true);
    expect(existsSync(join(h.userData, 'db-key.bin'))).toBe(false);
  });

  // Breaks: mail opened before any account is registered (no account id yet)
  // lands in a real account's folder — served to, and removed with, that account.
  it('keeps the pre-account default slot apart from every account', async () => {
    const filePath = await getOrCacheAttachment(null, EMAIL_ID, 'INBOX', 42, FILENAME, engine());

    expect(isInside(storeRoot(), filePath)).toBe(true);
    expect(isInside(accountAttachmentDir(ACTIVE), filePath)).toBe(false);
    expect(isInside(accountAttachmentDir(OTHER), filePath)).toBe(false);
    expect(await readCachedAttachment(filePath)).toEqual(BYTES);
  });
});

/**
 * The store at rest (CASA M-7).
 *
 * An attachment on disk must be as protected as the mail it came from: sealed
 * with a key derived from the DB key, kept per account, and named so a listing
 * reveals nothing. A file that will not open is never served — it is removed
 * and fetched afresh.
 */
describe('the sealed store', () => {
  const SECRET_NAME = 'salary-review-2026.pdf';
  const SECRET = Buffer.from('%PDF-1.7 CONFIDENTIAL salary figures for the whole team');

  // Breaks: attachments sit on disk in plaintext again — anyone who can read
  // userData (a backup, another local user, malware) reads the mail's files, or
  // learns from a directory listing who was sent what.
  it('stores neither the bytes nor any name in plaintext, and reads back exactly', async () => {
    h.storage.getEmail.mockResolvedValue({
      id: EMAIL_ID, folderId: 'f1', uid: 42, attachmentNames: JSON.stringify([SECRET_NAME]),
    });
    h.syncEngine.fetchAttachmentPart.mockResolvedValue({ content: SECRET });

    const { filePath } = await resolveAttachmentFile({ emailId: EMAIL_ID, filename: SECRET_NAME });

    expect(readFileSync(filePath).includes(SECRET)).toBe(false);
    expectStoreHidesPlaintext(
      [SECRET_NAME, 'salary', EMAIL_ID, ACTIVE],
      [SECRET, Buffer.from('CONFIDENTIAL')],
    );
    expect(await readCachedAttachment(filePath)).toEqual(SECRET);
    expect(await cachedAttachmentSize(filePath)).toBe(SECRET.length);
  });

  // MULTI-ACCOUNT. Breaks: two accounts holding the same message (same id, same
  // attachment name — a mail sent to both of your addresses, or ids that collide
  // across servers) share one cache entry, so one account is served the other's
  // bytes, and removing either account takes the other's attachments with it.
  it('gives two accounts with the same email id and file name separate entries', async () => {
    const OTHER_BYTES = Buffer.from('%PDF-1.7 the second account\'s own copy');
    h.syncEngine.fetchAttachmentPart.mockImplementation(async (_id: string, folder: string) => ({
      content: folder === 'Archive' ? OTHER_BYTES : BYTES,
    }));

    const mine = await resolveAttachmentFile({ emailId: EMAIL_ID, filename: FILENAME });
    const theirs = await resolveAttachmentFile({ emailId: EMAIL_ID, filename: FILENAME, accountId: OTHER });

    expect(mine.filePath).not.toBe(theirs.filePath);
    expect(isInside(accountAttachmentDir(ACTIVE), mine.filePath)).toBe(true);
    expect(isInside(accountAttachmentDir(OTHER), theirs.filePath)).toBe(true);
    expect(await readCachedAttachment(mine.filePath)).toEqual(BYTES);
    expect(await readCachedAttachment(theirs.filePath)).toEqual(OTHER_BYTES);

    // …and once both are cache hits, each account's request still answers with
    // its own bytes.
    h.syncEngine.fetchAttachmentPart.mockClear();
    expect(await base64()({}, EMAIL_ID, FILENAME)).toEqual({ success: true, base64: BYTES.toString('base64') });
    expect(await base64()({}, EMAIL_ID, FILENAME, OTHER)).toEqual({
      success: true, base64: OTHER_BYTES.toString('base64'),
    });
    expect(h.syncEngine.fetchAttachmentPart).not.toHaveBeenCalled();
    expectStoreHidesPlaintext([ACTIVE, OTHER, EMAIL_ID, FILENAME], [BYTES, OTHER_BYTES]);
  });

  // Breaks: an entry that will not open (bit rot, a crash mid-write by some other
  // tool, a plaintext file from older code left in its place) is either served as
  // garbage, or fails on every open forever because nothing ever replaces it.
  it.each([
    ['damaged on disk', (file: string) => {
      const sealed = readFileSync(file);
      sealed[sealed.length - 1]! ^= 0xff;
      writeFileSync(file, sealed);
    }],
    ['replaced by plaintext', (file: string) => writeFileSync(file, BYTES)],
    ['truncated', (file: string) => fs.truncateSync(file, 10)],
  ])('discards an entry %s, asks to try again, and the next request refetches', async (_label, spoil) => {
    const filePath = await getOrCacheAttachment(ACTIVE, EMAIL_ID, 'INBOX', 42, FILENAME, engine());
    spoil(filePath);

    await expect(readCachedAttachment(filePath)).rejects.toMatchObject({ status: 500, message: UNREADABLE });
    expect(existsSync(filePath)).toBe(false);

    h.syncEngine.fetchAttachmentPart.mockClear();
    const again = await getOrCacheAttachment(ACTIVE, EMAIL_ID, 'INBOX', 42, FILENAME, engine());
    expect(again).toBe(filePath);
    expect(h.syncEngine.fetchAttachmentPart).toHaveBeenCalledOnce();
    expect(await readCachedAttachment(again)).toEqual(BYTES);
  });

  // The same, end to end. Breaks: the user is shown a raw crypto error (or a
  // garbage attachment) instead of "try again" — and trying again fails too.
  it('answers an unreadable entry with "try again" over IPC, and the retry works', async () => {
    const { filePath } = await resolveAttachmentFile({ emailId: EMAIL_ID, filename: FILENAME });
    writeFileSync(filePath, BYTES); // plaintext where a sealed entry belongs

    expect(await base64()({}, EMAIL_ID, FILENAME)).toEqual({ success: false, error: UNREADABLE });
    expect(await base64()({}, EMAIL_ID, FILENAME)).toEqual({ success: true, base64: BYTES.toString('base64') });
    expect(h.syncEngine.fetchAttachmentPart).toHaveBeenCalledTimes(2);
  });

  // SECURITY. Breaks: the seal does not bind an entry to its email and file, so
  // a sealed file copied into another attachment's slot is served as that
  // attachment.
  it('refuses an entry moved into another attachment\'s slot', async () => {
    h.syncEngine.fetchAttachmentPart.mockImplementation(async (emailId: string) => ({
      content: Buffer.from(`bytes of ${emailId}`),
    }));
    const mine = await getOrCacheAttachment(ACTIVE, EMAIL_ID, 'INBOX', 42, FILENAME, engine());
    const other = await getOrCacheAttachment(ACTIVE, 'email-2', 'INBOX', 43, FILENAME, engine());

    copyFileSync(mine, other);

    await expect(readCachedAttachment(other)).rejects.toMatchObject({ status: 500, message: UNREADABLE });
    expect(await readCachedAttachment(mine)).toEqual(Buffer.from(`bytes of ${EMAIL_ID}`));
  });

  // Breaks: after the DB key is replaced (its keychain entry lost, a new key
  // minted), entries sealed under the old key are served as garbage, or fail on
  // every open, instead of being fetched again under the new key.
  it('never opens an entry sealed under a previous DB key, and refetches under the current one', async () => {
    const old = await getOrCacheAttachment(ACTIVE, EMAIL_ID, 'INBOX', 42, FILENAME, engine());
    h.dbKey = 'j'.repeat(64);
    resetAttachmentStoreKeys();

    await expect(readCachedAttachment(old)).rejects.toMatchObject({ status: 500, message: UNREADABLE });
    expect(existsSync(old)).toBe(false);

    h.syncEngine.fetchAttachmentPart.mockClear();
    const fresh = await getOrCacheAttachment(ACTIVE, EMAIL_ID, 'INBOX', 42, FILENAME, engine());
    expect(h.syncEngine.fetchAttachmentPart).toHaveBeenCalledOnce();
    expect(await readCachedAttachment(fresh)).toEqual(BYTES);
  });

  // Changed deliberately (CASA M-7): the cap applies where it did before the
  // cache was sealed — to a warning-approved snapshot read without scanning —
  // and is checked BEFORE the file is read. Breaks: a huge entry is read into
  // memory for an unscanned snapshot.
  it('refuses a bounded read of an entry over the cap, before reading it', async () => {
    const filePath = await getOrCacheAttachment(ACTIVE, EMAIL_ID, 'INBOX', 42, FILENAME, engine());
    fs.truncateSync(filePath, MAX_ATTACHMENT_BYTES + 1024); // sparse: reports the size, occupies nothing
    const read = vi.spyOn(fs.promises, 'readFile');

    await expect(readCachedAttachment(filePath, MAX_ATTACHMENT_BYTES)).rejects.toMatchObject({ status: 413 });
    expect(read).not.toHaveBeenCalled();
  });

  // A draft's own attachment may be larger than a fetch is allowed to be (it
  // was written by seedAttachmentCache, not fetched). Breaks: such a draft
  // attachment can never be opened, saved or forwarded again.
  it('reads a large draft attachment when no bound is asked for', async () => {
    const big = Buffer.alloc(MAX_ATTACHMENT_BYTES + 1, 7);
    await seedAttachmentCache(ACTIVE, 'draft-big', [{ filename: 'video.mov', content: big }]);
    h.storage.getEmail.mockResolvedValue({ id: 'draft-big', folderId: 'f1', uid: 0, attachmentNames: JSON.stringify(['video.mov']) });

    const { filePath } = await resolveAttachmentFile({ emailId: 'draft-big', filename: 'video.mov' });
    const read = await readCachedAttachment(filePath);
    expect(read.length).toBe(big.length);
    expect(read.equals(big)).toBe(true);
  });
});

describe('resolveAttachmentFile', () => {
  // SECURITY. Breaks: the caller picks the filename, so any file already cached
  // under this email id can be read back — an arbitrary-read primitive into the
  // cache. The declared-names check is the only thing standing in the way.
  it('refuses a filename the email does not declare', async () => {
    await expect(
      resolveAttachmentFile({ emailId: EMAIL_ID, filename: 'someone-elses.pdf' }),
    ).rejects.toMatchObject({ status: 403, message: 'Attachment not found on this email' });
  });

  // Breaks: a malformed request from a misbehaving renderer throws out of the
  // resolver instead of being answered with a status the caller can report.
  it('rejects a request missing an emailId or a filename', async () => {
    await expect(resolveAttachmentFile({ emailId: '', filename: FILENAME })).rejects.toMatchObject({
      status: 400,
    });
    await expect(
      resolveAttachmentFile({ emailId: EMAIL_ID, filename: null as unknown as string }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('reports 404 for an unknown email and for a row with no folder/uid', async () => {
    h.storage.getEmail.mockResolvedValue(null);
    await expect(
      resolveAttachmentFile({ emailId: EMAIL_ID, filename: FILENAME }),
    ).rejects.toMatchObject({ status: 404, message: 'Email not found' });

    h.storage.getEmail.mockResolvedValue({
      id: EMAIL_ID,
      folderId: 'f1',
      uid: null,
      attachmentNames: JSON.stringify([FILENAME]),
    });
    await expect(
      resolveAttachmentFile({ emailId: EMAIL_ID, filename: FILENAME }),
    ).rejects.toMatchObject({ status: 404 });
  });

  // MULTI-ACCOUNT. Breaks: in the unified All Inboxes view every attachment on a
  // non-active account's message failed with "Email not found", because the
  // lookup always used the ACTIVE account's storage — and now also: its file
  // would be cached in the ACTIVE account's folder.
  it('reads the owning account when the request carries a non-active accountId', async () => {
    const { filePath } = await resolveAttachmentFile({ emailId: EMAIL_ID, filename: FILENAME, accountId: OTHER });

    expect(h.otherStorage.getEmail).toHaveBeenCalledWith(EMAIL_ID);
    expect(h.storage.getEmail).not.toHaveBeenCalled();
    // …and fetched from that account's folder, not the active account's.
    expect(h.syncEngine.fetchAttachmentPart).toHaveBeenCalledWith(EMAIL_ID, 'Archive', 7, FILENAME);
    expect(isInside(accountAttachmentDir(OTHER), filePath)).toBe(true);
  });

  // Breaks: legacy rows store attachment names comma-separated rather than as a
  // JSON array; reading only the JSON form makes every old message's
  // attachments un-openable.
  it('accepts a legacy comma-separated attachmentNames row', async () => {
    h.storage.getEmail.mockResolvedValue({
      id: EMAIL_ID,
      folderId: 'f1',
      uid: 42,
      attachmentNames: `other.txt, ${FILENAME}`,
    });

    const { filePath } = await resolveAttachmentFile({ emailId: EMAIL_ID, filename: FILENAME });

    expect(await readCachedAttachment(filePath)).toEqual(BYTES);
  });
});

describe('emails:previewAttachment', () => {
  // SECURITY — the user's constraint: never open a file type that can harm the
  // system. `shell.openPath` asks the OS to LAUNCH the file, so an .exe/.sh/.js
  // would run with the user's privileges on one click. The renderer already
  // hides these, but main must not trust the renderer to be the only gate.
  it('refuses to launch a type outside the allow-list, without calling the shell', async () => {
    for (const name of ['setup.exe', 'run.sh', 'app.js', 'macro.vbs', 'invoice.html']) {
      const result = await preview()(downloadEvent(), EMAIL_ID, name);
      expect(result, name).toEqual({
        success: false,
        error: 'This file type cannot be opened from Sarv Inbox',
      });
    }
    expect(h.openPath).not.toHaveBeenCalled();
  });

  // SECURITY. Breaks: "invoice.pdf.exe" — the OS launches by the LAST extension,
  // so that is what the gate must classify on.
  it('refuses a double extension by its real (last) extension', async () => {
    expect(await preview()(downloadEvent(), EMAIL_ID, 'invoice.pdf.exe')).toMatchObject({ success: false });
    expect(h.openPath).not.toHaveBeenCalled();
  });

  // Breaks: with the antivirus off, the OS app is handed the sealed cache entry
  // (it shows garbage, or "damaged file") — or a launch failure is reported as
  // success and the user is left waiting for a window that never opens.
  // Changed deliberately (CASA M-7): the cache is sealed, so the OS now gets a
  // private plaintext copy under attachment-previews named after the attachment,
  // never the cache path; a copy that failed to open is not left behind.
  it('hands an allow-listed file to the OS as a private copy and reports a launch failure', async () => {
    let opened = '';
    let openedBytes: Buffer | undefined;
    h.openPath.mockImplementation(async (file: string) => {
      opened = file;
      openedBytes = readFileSync(file);
      return '';
    });
    expect(await preview()(downloadEvent(), EMAIL_ID, FILENAME)).toEqual({ success: true });
    expect(isInside(previewRoot(), opened)).toBe(true);
    expect(basename(opened)).toBe(FILENAME); // the OS picks the app by this extension
    expect(openedBytes).toEqual(BYTES);

    h.openPath.mockImplementation(async (file: string) => {
      opened = file;
      return 'No application is registered';
    });
    expect(await preview()(downloadEvent(), EMAIL_ID, FILENAME)).toEqual({
      success: false,
      error: 'No application is registered',
    });
    expect(existsSync(opened)).toBe(false);
  });

  // MULTI-ACCOUNT, at the IPC edge rather than inside the resolver.
  it('honours accountId', async () => {
    await preview()(downloadEvent(), EMAIL_ID, FILENAME, 'acct-2');

    expect(h.otherStorage.getEmail).toHaveBeenCalledWith(EMAIL_ID);
  });
});

// Breaks: PDFs/docs bypass the scan gate through either viewer preparation or OS opening IPC.
describe('trusted attachment preview scan handlers', () => {
  const prepare = () => h.handlers.get('emails:prepareAttachmentPreview')!;
  const release = () => h.handlers.get('emails:releaseAttachmentPreview')!;

  it('requires the trusted main frame for preview preparation, release and OS open', async () => {
    const foreign = { sender: h.webContents, senderFrame: {} };
    for (const result of [await prepare()(foreign, EMAIL_ID, FILENAME), await release()(foreign, 'sarv-attachment://attachment/email-1/report.pdf'),
      await preview()(foreign, EMAIL_ID, FILENAME)]) {
      expect(result).toEqual({ success: false, error: 'Attachment downloads must be requested from Sarv Inbox.' });
    }
    expect(h.scanDownload).not.toHaveBeenCalled(); expect(h.storage.getEmail).not.toHaveBeenCalled(); expect(h.openPath).not.toHaveBeenCalled();
  });

  it('prepares a bound opaque URL for the owning account and releases retained clean bytes on close', async () => {
    enableScanner(); const result = await prepare()(downloadEvent(), EMAIL_ID, FILENAME, 'acct-2', 'view-request');
    expect(result.success).toBe(true); expect(result.url).toContain('account=acct-2'); expect(result.url).toContain('preview=');
    expect(h.scanDownload).toHaveBeenCalledWith('clamav-scan', EMAIL_ID, 'acct-2', FILENAME, expect.any(Object));
    expect(h.scanDispose).not.toHaveBeenCalled(); expect(h.syncEngine.fetchAttachmentPart).not.toHaveBeenCalled();
    expect(await release()(downloadEvent(), result.url)).toEqual({ success: true }); expect(h.scanDispose).toHaveBeenCalledOnce();
    expect(await release()(downloadEvent(), 'malformed URL')).toMatchObject({ success: false });
  });

  it('returns a usable legacy viewer URL when the scanner is absent', async () => {
    const result = await prepare()(downloadEvent(), EMAIL_ID, FILENAME);
    expect(result).toEqual({ success: true, url: 'sarv-attachment://attachment/email-1/report.pdf?account=acct-1' });
    expect(h.scanDownload).not.toHaveBeenCalled(); expect(h.syncEngine.fetchAttachmentPart).toHaveBeenCalledOnce();
  });

  it('writes and opens exact clean bytes instead of the legacy cache, using the owning account', async () => {
    enableScanner(); let opened = '';
    h.openPath.mockImplementation(async file => { opened = file; expect(readFileSync(file, 'utf8')).toBe('scanner verified bytes'); return ''; });
    expect(await preview()(downloadEvent(), EMAIL_ID, FILENAME, 'acct-2', 'open-request')).toEqual({ success: true });
    expect(opened.startsWith(join(h.userData, 'attachment-previews'))).toBe(true);
    expect(h.scanDownload).toHaveBeenCalledWith('clamav-scan', EMAIL_ID, 'acct-2', FILENAME, expect.any(Object));
    expect(h.scanDispose).toHaveBeenCalledOnce(); expect(h.syncEngine.fetchAttachmentPart).not.toHaveBeenCalled();
  });

  it('blocks both viewers after threat, incomplete coverage or missing scanner setup', async () => {
    enableScanner();
    for (const reason of ['Download blocked: ClamAV detected a threat.', 'Download blocked: the attachment could not be fully scanned.']) {
      h.scanDownload.mockRejectedValue(new Error(reason));
      expect(await prepare()(downloadEvent(), EMAIL_ID, FILENAME)).toEqual({ success: false, error: reason });
      expect(await preview()(downloadEvent(), EMAIL_ID, FILENAME)).toEqual({ success: false, error: reason });
    }
    h.scannerSetup.mockResolvedValue({ configured: false, allowedAccountIds: [] });
    expect(await prepare()(downloadEvent(), EMAIL_ID, FILENAME)).toMatchObject({ success: false });
    expect(h.warning).toHaveBeenCalled(); expect(h.openScannerSetup).not.toHaveBeenCalled();
    expect(h.openPath).not.toHaveBeenCalled(); expect(h.syncEngine.fetchAttachmentPart).not.toHaveBeenCalled();
  });

  it('uses the same trusted cancellation endpoint for a pending viewer scan', async () => {
    enableScanner(); let observed: AbortSignal | undefined;
    h.scanDownload.mockImplementation((_id, _message, _account, _filename, options) => new Promise((_resolve, reject) => {
      observed = options.signal; options.signal.addEventListener('abort', () => reject(new Error('Download cancelled.')), { once: true });
    }));
    const pending = prepare()(downloadEvent(), EMAIL_ID, FILENAME, 'acct-2', 'view-cancel');
    await vi.waitFor(() => expect(observed).toBeDefined());
    expect(await h.handlers.get('emails:cancelAttachmentDownload')!(downloadEvent(), 'view-cancel')).toEqual({ success: true, data: { cancelled: true } });
    expect(await pending).toEqual({ success: false, error: 'Download cancelled.' });
    expect(h.openPath).not.toHaveBeenCalled();
  });

  it('refuses removed accounts before either viewer reads mail', async () => {
    expect(await prepare()(downloadEvent(), EMAIL_ID, FILENAME, 'removed')).toMatchObject({ success: false });
    expect(await preview()(downloadEvent(), EMAIL_ID, FILENAME, 'removed')).toMatchObject({ success: false });
    expect(h.storage.getEmail).not.toHaveBeenCalled(); expect(h.scanDownload).not.toHaveBeenCalled();
  });
});

// Breaks: generated calendar files bypass protected document opening by launching unscanned message-derived bytes.
describe('protected calendar import', () => {
  const calendar = () => h.handlers.get('emails:openCalendarInvite')!;

  // Changed deliberately (CASA M-7): the invite is written as a private copy
  // under attachment-previews, no longer into the cache, so "wrote nothing" now
  // means neither place holds a file.
  it('blocks generated calendar imports while a scanner is enabled before reading or writing mail', async () => {
    enableScanner();
    expect(await calendar()(downloadEvent(), EMAIL_ID, 'acct-2')).toEqual({
      success: false, error: 'Calendar import blocked: save or open the calendar attachment after scanning it.',
    });
    expect(h.storage.getEmail).not.toHaveBeenCalled(); expect(h.otherStorage.getEmail).not.toHaveBeenCalled();
    expect(h.openPath).not.toHaveBeenCalled(); expect(h.scanDownload).not.toHaveBeenCalled();
    expect(previewCopies()).toEqual([]); expect(storeFiles()).toEqual([]);
  });

  // Breaks: "Add to calendar" with no scanner stops working, or leaves the
  // invite (message content) behind in the attachment cache.
  // Changed deliberately (CASA M-7): the calendar app is handed a private copy
  // under attachment-previews/preview-*/calendar-event.ics, not a file in the
  // attachment cache — which now holds no calendar-event.ics at all.
  it('requires the trusted main frame and preserves legacy import without an enabled scanner', async () => {
    expect(await calendar()({ sender: h.webContents, senderFrame: {} }, EMAIL_ID)).toEqual({
      success: false, error: 'Attachment downloads must be requested from Sarv Inbox.',
    });
    h.storage.getEmail.mockResolvedValue({ id: EMAIL_ID, calendarIcs: CALENDAR_ICS });
    let opened = '';
    let body = '';
    h.openPath.mockImplementation(async (file: string) => {
      opened = file;
      body = readFileSync(file, 'utf8');
      return '';
    });

    expect(await calendar()(downloadEvent(), EMAIL_ID)).toEqual({ success: true });

    expect(isInside(previewRoot(), opened)).toBe(true);
    expect(basename(opened)).toBe('calendar-event.ics');
    expect(body).toContain('SUMMARY:Synthetic');
    expect(body.endsWith('\r\n')).toBe(true);
    expect(storeFiles()).toEqual([]);
    expect(walk(h.userData).filter((file) => basename(file) === 'calendar-event.ics')).toEqual([opened]);
  });

  it('allows a generated calendar only after missing setup is explicitly accepted, using the owning account', async () => {
    enableScanner(); h.scannerSetup.mockResolvedValue({ configured: false, allowedAccountIds: [] });
    h.warning.mockResolvedValue('continue');
    h.otherStorage.getEmail.mockResolvedValue({ id: EMAIL_ID, calendarIcs: CALENDAR_ICS });
    expect(await calendar()(downloadEvent(), EMAIL_ID, 'acct-2')).toEqual({ success: true, notScanned: true });
    expect(h.scannerSetup).toHaveBeenCalledWith('clamav-scan', 'acct-2');
    expect(h.warning).toHaveBeenCalledWith(
      { messageId: EMAIL_ID, accountId: 'acct-2', filename: 'calendar-event.ics', action: 'calendar' },
      expect.any(AbortSignal), expect.any(Function)
    );
    expect(h.otherStorage.getEmail).toHaveBeenCalledWith(EMAIL_ID); expect(h.storage.getEmail).not.toHaveBeenCalled();
    expect(h.scanDownload).not.toHaveBeenCalled(); expect(h.openPath).toHaveBeenCalledOnce();
  });

  it('blocks a generated calendar when setup changes after the warning', async () => {
    enableScanner(); h.scannerSetup.mockResolvedValue({ configured: false, allowedAccountIds: [] });
    h.warning.mockImplementation(async () => { h.missingSetupAssert.mockRejectedValue(new Error('Antivirus setup changed. Try again.')); return 'continue'; });
    expect(await calendar()(downloadEvent(), EMAIL_ID, 'acct-2')).toMatchObject({ success: false, error: 'Antivirus setup changed. Try again.' });
    expect(h.otherStorage.getEmail).not.toHaveBeenCalled(); expect(h.openPath).not.toHaveBeenCalled();
  });

  it.each([true, false])('guards calendar fallback reads and opens after missing setup with backfill failure=%s', async failedBackfill => {
    enableScanner(); h.scannerSetup.mockResolvedValue({ configured: false, allowedAccountIds: [] }); h.warning.mockResolvedValue('continue');
    if (failedBackfill) h.otherStorage.updateEmail.mockRejectedValue(new Error('Transient storage failure'));
    expect(await calendar()(downloadEvent(), EMAIL_ID, 'acct-2')).toEqual({ success: true, notScanned: true });
    expect(h.syncEngine.getCalendarIcs).toHaveBeenCalledWith(EMAIL_ID, 'Archive', 7);
    expect(h.otherStorage.updateEmail).toHaveBeenCalledWith(EMAIL_ID, { calendarIcs: CALENDAR_ICS.trim() });
    expect(h.missingSetupAssert.mock.calls.length).toBeGreaterThan(6); expect(h.scanDownload).not.toHaveBeenCalled();
  });

  // Changed deliberately (CASA M-7): "wrote nothing" now checks the private-copy
  // folder (where the invite would be written) as well as the cache.
  it('rechecks setup after a calendar fallback read and before writing or opening the generated file', async () => {
    enableScanner(); h.scannerSetup.mockResolvedValue({ configured: false, allowedAccountIds: [] }); h.warning.mockResolvedValue('continue');
    h.syncEngine.getCalendarIcs.mockImplementation(async () => {
      h.missingSetupAssert.mockRejectedValue(new Error('Antivirus setup changed. Try again.')); return CALENDAR_ICS;
    });
    expect(await calendar()(downloadEvent(), EMAIL_ID, 'acct-2')).toEqual({ success: false, error: 'Antivirus setup changed. Try again.' });
    expect(h.openPath).not.toHaveBeenCalled();
    expect(previewCopies()).toEqual([]); expect(storeFiles()).toEqual([]);
  });

  it('preserves calendar missing-message, missing-invite and OS-handler errors after warning acceptance', async () => {
    enableScanner(); h.scannerSetup.mockResolvedValue({ configured: false, allowedAccountIds: [] }); h.warning.mockResolvedValue('continue');
    expect(await calendar()(downloadEvent(), '')).toEqual({ success: false, error: 'Invalid emailId' });
    h.storage.getEmail.mockResolvedValue(null);
    expect(await calendar()(downloadEvent(), EMAIL_ID)).toEqual({ success: false, error: 'Email not found' });
    h.storage.getEmail.mockResolvedValue({ id: EMAIL_ID });
    expect(await calendar()(downloadEvent(), EMAIL_ID)).toEqual({ success: false, error: 'No calendar invite found for this email' });
    h.storage.getEmail.mockResolvedValue({ id: EMAIL_ID, calendarIcs: CALENDAR_ICS }); h.openPath.mockResolvedValue('No calendar app');
    expect(await calendar()(downloadEvent(), EMAIL_ID)).toEqual({ success: false, error: 'No calendar app', noHandler: true });
  });
});

// Breaks: optional setup is mistaken for an offline/threat bypass, or explicit bypass is presented as a clean scan.
describe('per-action missing antivirus setup warnings', () => {
  const prepare = () => h.handlers.get('emails:prepareAttachmentPreview')!;

  it('allows an explicit unscanned save and warns again for the same cached file', async () => {
    enableScanner(); h.scannerSetup.mockResolvedValue({ configured: false, allowedAccountIds: [] }); h.warning.mockResolvedValue('continue');
    const target = join(h.userData, 'unscanned.pdf'); h.saveDialog = { canceled: false, filePath: target };
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(await download()(downloadEvent(), EMAIL_ID, FILENAME, 'acct-2')).toEqual({ success: true, filePath: target, notScanned: true });
      expect(readFileSync(target)).toEqual(BYTES);
    }
    expect(h.warning).toHaveBeenCalledTimes(2); expect(h.scannerSetup).toHaveBeenCalledWith('clamav-scan', 'acct-2');
    expect(h.warning).toHaveBeenCalledWith(
      { messageId: EMAIL_ID, accountId: 'acct-2', filename: FILENAME, action: 'download' },
      expect.any(AbortSignal), expect.any(Function)
    );
    expect(h.storage.getEmail).not.toHaveBeenCalled(); expect(h.scanDownload).not.toHaveBeenCalled(); expect(h.openScannerSetup).not.toHaveBeenCalled();
  });

  it('allows one unapproved account action without changing scanner consent or scanning another account', async () => {
    enableScanner(); h.scannerSetup.mockResolvedValue({ configured: true, allowedAccountIds: ['acct-1'] }); h.warning.mockResolvedValue('continue');
    expect(await download()(downloadEvent(), EMAIL_ID, FILENAME, 'acct-2')).toMatchObject({ success: true, notScanned: true });
    expect(h.otherStorage.getEmail).toHaveBeenCalled(); expect(h.storage.getEmail).not.toHaveBeenCalled(); expect(h.scanDownload).not.toHaveBeenCalled();
  });

  it('returns a bound unscanned viewer lease and opens an OS document from a private unscanned snapshot', async () => {
    enableScanner(); h.scannerSetup.mockResolvedValue({ configured: false, allowedAccountIds: [] }); h.warning.mockResolvedValue('continue');
    const viewed = await prepare()(downloadEvent(), EMAIL_ID, FILENAME, 'acct-2');
    expect(viewed).toMatchObject({ success: true, notScanned: true }); expect(viewed.url).toContain('preview='); expect(viewed.url).toContain('account=acct-2');
    const opened = await preview()(downloadEvent(), EMAIL_ID, FILENAME, 'acct-2');
    expect(opened).toEqual({ success: true, notScanned: true });
    const file = h.openPath.mock.calls[0]![0]; expect(file.startsWith(join(h.userData, 'attachment-previews'))).toBe(true);
    expect(readFileSync(file)).toEqual(BYTES); expect(h.warning).toHaveBeenCalledTimes(2); expect(h.scanDownload).not.toHaveBeenCalled();
    expect(h.warning.mock.calls.map(([target]) => target.action)).toEqual(['view', 'open']);
  });

  it.each(['cancel', 'setup'] as const)('reads no bytes for warning choice %s, opening setup only when requested', async response => {
    enableScanner(); h.scannerSetup.mockResolvedValue({ configured: false, allowedAccountIds: [] }); h.warning.mockResolvedValue(response);
    expect(await download()(downloadEvent(), EMAIL_ID, FILENAME)).toEqual({ success: false, error: 'Download cancelled.' });
    expect(await prepare()(downloadEvent(), EMAIL_ID, FILENAME)).toEqual({ success: false, error: 'Download cancelled.' });
    expect(await preview()(downloadEvent(), EMAIL_ID, FILENAME)).toEqual({ success: false, error: 'Download cancelled.' });
    expect(h.openScannerSetup).toHaveBeenCalledTimes(response === 'setup' ? 3 : 0);
    expect(h.storage.getEmail).not.toHaveBeenCalled(); expect(h.scanDownload).not.toHaveBeenCalled(); expect(h.openPath).not.toHaveBeenCalled();
  });

  it.each(['Download blocked: ClamAV detected a threat.', 'Download blocked: the attachment could not be fully scanned.',
    'Download blocked: scanning failed. Try again when the scanner is available.'])('offers no warning for configured scan failure: %s', async error => {
    enableScanner(); h.scanDownload.mockRejectedValue(new Error(error));
    expect(await download()(downloadEvent(), EMAIL_ID, FILENAME)).toEqual({ success: false, error });
    expect(await prepare()(downloadEvent(), EMAIL_ID, FILENAME)).toEqual({ success: false, error });
    expect(h.warning).not.toHaveBeenCalled(); expect(h.syncEngine.fetchAttachmentPart).not.toHaveBeenCalled();
  });

  it('does not interpret unreadable configuration or an inactive scanner as missing setup', async () => {
    enableScanner(); h.scannerSetup.mockRejectedValue(new Error('Secure scanner storage unavailable'));
    expect(await download()(downloadEvent(), EMAIL_ID, FILENAME)).toMatchObject({ success: false }); expect(h.warning).not.toHaveBeenCalled();
    enableScanner({ active: false }); h.scannerSetup.mockResolvedValue({ configured: false, allowedAccountIds: [] });
    expect(await prepare()(downloadEvent(), EMAIL_ID, FILENAME)).toMatchObject({ success: false }); expect(h.warning).not.toHaveBeenCalled();
    expect(h.scanDownload).not.toHaveBeenCalled(); expect(h.syncEngine.fetchAttachmentPart).not.toHaveBeenCalled();
  });

  it('does not mark a cancelled destination or failed OS open as an unscanned success', async () => {
    enableScanner(); h.scannerSetup.mockResolvedValue({ configured: false, allowedAccountIds: [] }); h.warning.mockResolvedValue('continue');
    h.saveDialog = { canceled: true, filePath: '' };
    expect(await download()(downloadEvent(), EMAIL_ID, FILENAME)).toEqual({ success: false, error: 'Save cancelled' });
    h.openPath.mockResolvedValue('No application is registered');
    expect(await preview()(downloadEvent(), EMAIL_ID, FILENAME)).toEqual({ success: false, error: 'No application is registered' });
  });

  it('cancels a pending custom warning through the trusted cancellation endpoint and ignores late Continue', async () => {
    enableScanner(); h.scannerSetup.mockResolvedValue({ configured: false, allowedAccountIds: [] });
    let finish!: (result: 'continue') => void;
    h.warning.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const pending = prepare()(downloadEvent(), EMAIL_ID, FILENAME, 'acct-2', 'warning-cancel');
    await vi.waitFor(() => expect(h.warning).toHaveBeenCalled());
    expect(await h.handlers.get('emails:cancelAttachmentDownload')!(downloadEvent(), 'warning-cancel')).toEqual({ success: true, data: { cancelled: true } });
    expect(await pending).toEqual({ success: false, error: 'Download cancelled.' });
    finish('continue'); await Promise.resolve();
    expect(h.otherStorage.getEmail).not.toHaveBeenCalled(); expect(h.scanDownload).not.toHaveBeenCalled();
  });
});

describe('emails:downloadAttachment', () => {

  // Breaks: Save writes the sealed ciphertext (or nothing) to the user's chosen
  // file instead of the attachment — the cached source is not readable as-is,
  // so the copy must decrypt, on the first save and on a cache hit alike.
  it('copies the cached file to the chosen path', async () => {
    const target = join(TMP, 'chosen.pdf');
    h.saveDialog = { canceled: false, filePath: target };

    const result = await download()(downloadEvent(), EMAIL_ID, FILENAME);

    expect(result).toEqual({ success: true, filePath: target });
    expect(readFileSync(target)).toEqual(BYTES);
    expect(readFileSync(cachedFiles()[0]!)).not.toEqual(BYTES); // the source was sealed

    rmSync(target);
    expect(await download()(downloadEvent(), EMAIL_ID, FILENAME)).toEqual({ success: true, filePath: target });
    expect(readFileSync(target)).toEqual(BYTES);
    expect(h.syncEngine.fetchAttachmentPart).toHaveBeenCalledOnce();
  });

  // Breaks: the renderer distinguishes a cancelled dialog from a real failure by
  // this exact string — changing it turns "user changed their mind" into a
  // logged error, which is how real errors get ignored.
  it('reports a cancelled dialog as "Save cancelled"', async () => {
    h.saveDialog = { canceled: true, filePath: '' };

    expect(await download()(downloadEvent(), EMAIL_ID, FILENAME)).toEqual({
      success: false,
      error: 'Save cancelled',
    });
  });

  // Breaks: a failure surfaces as an unhandled rejection (no result at all)
  // rather than a message the UI can show.
  it('returns the error message rather than throwing', async () => {
    h.storage.getEmail.mockResolvedValue(null);

    expect(await download()(downloadEvent(), EMAIL_ID, FILENAME)).toEqual({
      success: false,
      error: 'Email not found',
    });
  });

  it('honours accountId', async () => {
    await download()(downloadEvent(), EMAIL_ID, FILENAME, 'acct-2');

    expect(h.otherStorage.getEmail).toHaveBeenCalledWith(EMAIL_ID);
  });

  // Breaks: an untrusted extension frame reads mail or initiates a destination write through the app IPC.
  it('rejects requests from an extension frame before reading or opening a save dialog', async () => {
    const result = await download()({ sender: h.webContents, senderFrame: {} }, EMAIL_ID, FILENAME);
    expect(result).toEqual({ success: false, error: 'Attachment downloads must be requested from Sarv Inbox.' });
    expect(h.storage.getEmail).not.toHaveBeenCalled(); expect(h.scanDownload).not.toHaveBeenCalled();
  });

  // Breaks: a removed account silently downloads an identically named attachment from the active account.
  it('rejects an unavailable explicit account instead of downloading from the active account', async () => {
    const result = await download()(downloadEvent(), EMAIL_ID, FILENAME, 'removed-account');
    expect(result.success).toBe(false); expect(h.storage.getEmail).not.toHaveBeenCalled();
  });

  // Breaks: the saved attachment differs from the scanned bytes or the scan reads the wrong mailbox.
  it('uses the owning account and saves the exact protected bytes without another IMAP fetch', async () => {
    enableScanner(); const target = join(h.userData, 'scanned.txt'); h.saveDialog = { canceled: false, filePath: target };
    expect(await download()(downloadEvent(), EMAIL_ID, FILENAME, 'acct-2', 'request-scanned')).toEqual({ success: true, filePath: target });
    expect(h.scanDownload).toHaveBeenCalledWith('clamav-scan', EMAIL_ID, 'acct-2', FILENAME, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(readFileSync(target, 'utf8')).toBe('scanner verified bytes');
    expect(h.syncEngine.fetchAttachmentPart).not.toHaveBeenCalled(); expect(h.otherStorage.getEmail).not.toHaveBeenCalled();
    expect(h.scanDispose).toHaveBeenCalledOnce();
    expect(h.webContents.send.mock.calls).toEqual([
      ['emails:attachmentDownloadProgress', { requestId: 'request-scanned', phase: 'downloading' }],
      ['emails:attachmentDownloadProgress', { requestId: 'request-scanned', phase: 'scanning' }],
      ['emails:attachmentDownloadProgress', { requestId: 'request-scanned', phase: 'saving' }],
    ]);
  });

  // Breaks: a missing setup silently bypasses AV instead of requiring an explicit per-file warning.
  it('defaults to cancellation for an enabled but unconfigured scanner', async () => {
    enableScanner(); h.scannerSetup.mockResolvedValue({ configured: false, allowedAccountIds: [] });
    const result = await download()(downloadEvent(), EMAIL_ID, FILENAME);
    expect(result).toEqual({ success: false, error: 'Download cancelled.' });
    expect(h.warning).toHaveBeenCalledOnce(); expect(h.openScannerSetup).not.toHaveBeenCalled();
    expect(h.scanDownload).not.toHaveBeenCalled(); expect(h.syncEngine.fetchAttachmentPart).not.toHaveBeenCalled();
  });

  // Breaks: revoking permission or losing a manifest accidentally turns off the mandatory gate.
  it('blocks a recognized scanner even if permission is revoked and its manifest failed to load', async () => {
    enableScanner({ granted: false, manifest: false });
    const result = await download()(downloadEvent(), EMAIL_ID, FILENAME);
    expect(result.success).toBe(false); expect(h.openScannerSetup).toHaveBeenCalledWith('clamav-scan');
    expect(h.scanDownload).not.toHaveBeenCalled(); expect(h.syncEngine.fetchAttachmentPart).not.toHaveBeenCalled();
  });

  // Breaks: an extension frame can cancel another user's host-owned download operation.
  it('authorizes cancellation from the trusted main frame only', async () => {
    const cancel = h.handlers.get('emails:cancelAttachmentDownload')!;
    expect(await cancel({ sender: h.webContents, senderFrame: {} }, 'request-1')).toEqual({ success: false, error: 'Attachment downloads must be requested from Sarv Inbox.' });
    expect(await cancel(downloadEvent(), 'request-1')).toEqual({ success: true, data: { cancelled: false } });
  });
});

describe('emails:getAttachmentBase64', () => {
  // Breaks: forwarding an attachment re-attaches corrupt bytes — the encoding is
  // the wire format the compose path re-attaches from — or, with the cache
  // sealed, the ciphertext itself: the handler must decrypt, on a fresh fetch
  // and on a cache hit alike.
  it('returns the decrypted bytes base64-encoded', async () => {
    const result = await base64()({}, EMAIL_ID, FILENAME);

    expect(result).toEqual({ success: true, base64: BYTES.toString('base64') });
    expect(readFileSync(cachedFiles()[0]!)).not.toEqual(BYTES); // what is on disk is sealed

    h.syncEngine.fetchAttachmentPart.mockClear();
    expect(await base64()({}, EMAIL_ID, FILENAME)).toEqual(result);
    expect(h.syncEngine.fetchAttachmentPart).not.toHaveBeenCalled();
  });

  it('honours accountId and reports failures as a message', async () => {
    await base64()({}, EMAIL_ID, FILENAME, 'acct-2');
    expect(h.otherStorage.getEmail).toHaveBeenCalledWith(EMAIL_ID);

    h.storage.getEmail.mockResolvedValue(null);
    expect(await base64()({}, EMAIL_ID, FILENAME)).toEqual({
      success: false,
      error: 'Email not found',
    });
  });
});

describe('the cache directory', () => {
  // SECURITY. Breaks: a crafted emailId ("../..") escapes the cache root, so the
  // per-email directory becomes a write primitive anywhere under userData.
  // Changed deliberately (CASA M-7): attachmentCacheDir is gone — the store
  // names every folder and file by a hash — so this proves containment for the
  // store's entry path and account folder, and for the one path still derived
  // from the raw id: the old plaintext folder an unsynced draft is adopted from.
  it('keeps a traversing emailId inside the cache root', async () => {
    const filePath = await getOrCacheAttachment(ACTIVE, '../../escape', 'INBOX', 42, FILENAME, engine());

    expect(isInside(accountAttachmentDir(ACTIVE), filePath)).toBe(true);
    expect(isInside(storeRoot(), accountAttachmentDir('../../escape'))).toBe(true);
    expect(isInside(legacyAttachmentCacheRoot(), legacyAttachmentDir('../../escape'))).toBe(true);
    expect(existsSync(join(h.userData, 'escape'))).toBe(false);
  });

  // Breaks: cached mail content becomes world-readable on a shared macOS/Linux
  // box. (A no-op on Windows, which uses ACLs — asserted only where modes mean
  // something.)
  it.skipIf(process.platform === 'win32')('writes cached attachments 0o600 in 0o700 folders', async () => {
    const filePath = await getOrCacheAttachment(ACTIVE, EMAIL_ID, 'INBOX', 42, FILENAME, engine());

    expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
    expect(fs.statSync(dirname(filePath)).mode & 0o777).toBe(0o700);
    expect(fs.statSync(accountAttachmentDir(ACTIVE)).mode & 0o777).toBe(0o700);
  });
});

describe('pruneAttachmentCache', () => {
  /** A sparse file in the store's account/email/file layout: it REPORTS `bytes`
   *  to stat but occupies no disk, so the 500 MB cap can be crossed in a test
   *  without writing 500 MB. Changed deliberately (CASA M-7): the store is one
   *  level deeper (per account), and the cap spans every account. */
  function sparse(accountId: string, emailDir: string, bytes: number, ageMs: number): string {
    const dir = join(accountAttachmentDir(accountId), emailDir);
    mkdirSync(dir, { recursive: true });
    const filePath = join(dir, 'cached.bin');
    writeFileSync(filePath, '');
    fs.truncateSync(filePath, bytes);
    const seconds = (Date.now() - ageMs) / 1000;
    fs.utimesSync(filePath, seconds, seconds);
    return filePath;
  }

  // Breaks: the cache grew without limit — every attachment ever opened stayed
  // on disk forever. This is what bounds it, oldest-first across every account,
  // and only as far as it has to go.
  it('evicts least-recently-used files until back under the cap, and no further', async () => {
    const share = Math.ceil(ATTACHMENT_CACHE_MAX_BYTES * 0.3);
    const oldest = sparse(ACTIVE, 'email-old', share, 90_000);
    const middle = sparse(OTHER, 'email-mid', share, 60_000);
    const recent = sparse(ACTIVE, 'email-recent', share, 30_000);
    const newest = sparse(OTHER, 'email-new', share * 2, 0);

    await pruneNow(); // 1.5x the cap on disk

    expect(existsSync(oldest)).toBe(false);
    expect(existsSync(middle)).toBe(false);
    expect(existsSync(recent)).toBe(true); // dropping below the cap stopped it here
    expect(existsSync(newest)).toBe(true);
    // …and an emptied per-email directory goes with its file, so the tree
    // doesn't accumulate stubs.
    expect(existsSync(dirname(oldest))).toBe(false);
    expect(existsSync(dirname(middle))).toBe(false);
    expect(existsSync(dirname(recent))).toBe(true);
  });

  // Breaks: a cache under its cap gets pruned anyway, so the next open of a
  // recently-read attachment re-downloads it.
  it('deletes nothing while under the cap', async () => {
    const keep = sparse(ACTIVE, 'email-1', 1024, 0);

    await pruneNow();

    expect(existsSync(keep)).toBe(true);
  });

  // Breaks: one unreadable entry (a stray directory, a file deleted mid-scan)
  // aborts the whole prune, so the cache never shrinks again.
  it('skips entries it cannot account for and prunes the rest', async () => {
    const share = Math.ceil(ATTACHMENT_CACHE_MAX_BYTES * 0.6);
    const oldest = sparse(ACTIVE, 'email-old', share, 90_000);
    const newest = sparse(OTHER, 'email-new', share, 0);
    // A nested directory where a cached file would be, a per-email entry that is
    // a plain file rather than a directory, and the same at the account level.
    mkdirSync(join(dirname(newest), 'nested'), { recursive: true });
    writeFileSync(join(accountAttachmentDir(ACTIVE), 'stray'), 'not an email directory');
    writeFileSync(join(storeRoot(), 'stray'), 'not an account directory');

    await pruneNow();

    expect(existsSync(oldest)).toBe(false);
    expect(existsSync(newest)).toBe(true);
  });

  // Breaks: a first run (or a wiped userData) throws out of a best-effort
  // maintenance path instead of simply having nothing to do.
  it('does nothing when the cache directory does not exist', async () => {
    await expect(pruneNow()).resolves.toBeUndefined();
  });

  // Breaks: housekeeping runs on every single attachment open, re-scanning the
  // whole tree each time — a stall while the user is just reading mail.
  it('does no work again within the throttle window', async () => {
    const over = sparse(ACTIVE, 'email-1', ATTACHMENT_CACHE_MAX_BYTES * 2, 0);
    await pruneNow();
    expect(existsSync(over)).toBe(false);

    const again = sparse(ACTIVE, 'email-2', ATTACHMENT_CACHE_MAX_BYTES * 2, 0);
    await pruneAttachmentCache(); // immediately after — throttled
    expect(existsSync(again)).toBe(true);
  });
});

describe('attachmentErrorMessage', () => {
  // Breaks: an unexpected failure reaches the UI as "[object Object]" or an
  // empty string, so the user is told nothing at all.
  it('passes an AttachmentError through and describes anything else', async () => {
    const known = await resolveAttachmentFile({ emailId: EMAIL_ID, filename: 'nope.pdf' }).catch(
      (error) => attachmentErrorMessage(error),
    );

    expect(known).toBe('Attachment not found on this email');
    expect(attachmentErrorMessage(new Error('disk on fire'))).toBe('disk on fire');
    expect(attachmentErrorMessage(undefined)).toBe('Attachment could not be read');
  });
});

/**
 * The cache generation.
 *
 * A cached attachment is trusted on existence alone, so bytes written by buggy
 * code are served forever and nothing about the file says it is wrong. The real
 * case: a part that lied about being base64 decoded to 7 junk bytes, those 7
 * bytes were cached, and every later open was a cache hit on them — the fix to
 * the fetch path could not reach mail that had already been opened once.
 *
 * Changed deliberately (CASA M-7): the generation now governs the sealed
 * `attachment-store` root (the old plaintext `attachment-cache` is handled by the
 * legacy adoption/migration instead), and its entries live at hashed paths.
 */
describe('the cache generation', () => {
  const marker = () => join(storeRoot(), GENERATION_MARKER);
  const STALE = Buffer.from('7 junk bytes from the old decoder');

  /**
   * Leave a validly sealed STALE entry for EMAIL_ID/FILENAME exactly where an
   * earlier run of an OLDER generation would have, under that generation's
   * marker. Sealed in a scratch userData first — the hashed names and the seal
   * depend only on the key and the ids, not on where userData is — because this
   * test's own store must not have run its once-per-process generation check
   * yet. Valid, so only the generation check stands between it and the user.
   */
  async function seedOlderGeneration(content: Buffer): Promise<string> {
    const real = h.userData;
    h.userData = mkdtempSync(join(TMP, 'earlier-'));
    let earlier: string;
    let entry: string;
    let current: number;
    try {
      h.syncEngine.fetchAttachmentPart.mockResolvedValueOnce({ content });
      earlier = await getOrCacheAttachment(ACTIVE, EMAIL_ID, 'INBOX', 42, FILENAME, engine());
      entry = relative(storeRoot(), earlier);
      current = Number(readFileSync(marker(), 'utf8'));
    } finally {
      h.userData = real;
    }
    const target = join(storeRoot(), entry);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(earlier, target);
    writeFileSync(marker(), String(current - 1));
    h.syncEngine.fetchAttachmentPart.mockClear();
    return target;
  }

  // Breaks: the 7-byte file cached before the lying-encoding fix keeps being
  // served, so the attachment stays corrupt no matter how well the fetch path
  // is repaired. Only a generation bump can reach data already on disk.
  it('discards a cache written by an older generation and re-fetches', async () => {
    const stale = await seedOlderGeneration(STALE);

    const filePath = await getOrCacheAttachment(ACTIVE, EMAIL_ID, 'INBOX', 42, FILENAME, engine());

    expect(filePath).toBe(stale); // the stale entry sat exactly where this open looked
    expect(await readCachedAttachment(filePath)).toEqual(BYTES);
    expect(h.syncEngine.fetchAttachmentPart).toHaveBeenCalled();
  });

  // Breaks: the generation check degenerates into "wipe the cache on every
  // open", which is the same as having no cache — every attachment re-downloads.
  it('keeps a cache already at the current generation', async () => {
    // Let the code itself stamp the current generation, so this does not pin the
    // number — only that a matching one is honoured.
    await getOrCacheAttachment(ACTIVE, EMAIL_ID, 'INBOX', 42, FILENAME, engine());
    await storeCachedAttachment(ACTIVE, EMAIL_ID, FILENAME, STALE);
    h.syncEngine.fetchAttachmentPart.mockClear();

    const filePath = await getOrCacheAttachment(ACTIVE, EMAIL_ID, 'INBOX', 42, FILENAME, engine());

    // Local migration/seeding writes a separate slot; it must neither evict
    // nor replace a complete server-backed entry in the current generation.
    expect(await readCachedAttachment(filePath)).toEqual(BYTES);
    const localPath = await getOrCacheAttachment(ACTIVE, EMAIL_ID, 'INBOX', 0, FILENAME, null);
    expect(await readCachedAttachment(localPath)).toEqual(STALE);
    expect(h.syncEngine.fetchAttachmentPart).not.toHaveBeenCalled();
  });

  // Breaks: the clear happens once per process, so a second attachment opened
  // after the first would wipe the file the first just fetched.
  it('clears once, not on every attachment', async () => {
    const stale = await seedOlderGeneration(STALE);

    const first = await getOrCacheAttachment(ACTIVE, EMAIL_ID, 'INBOX', 42, FILENAME, engine());
    await getOrCacheAttachment(ACTIVE, 'email-2', 'INBOX', 43, 'other.pdf', engine());

    expect(first).toBe(stale);
    expect(existsSync(first)).toBe(true);
    expect(await readCachedAttachment(first)).toEqual(BYTES);
  });

  // Breaks: the marker is treated as an account directory, so the scan throws
  // or counts it — and a cleared cache immediately re-clears on the next open.
  it('leaves the marker alone when the cache is pruned', async () => {
    const filePath = await getOrCacheAttachment(ACTIVE, EMAIL_ID, 'INBOX', 42, FILENAME, engine());

    await pruneNow();

    expect(existsSync(marker())).toBe(true);
    expect(cachedFiles()).toEqual([filePath]);
    h.syncEngine.fetchAttachmentPart.mockClear();
    expect(await getOrCacheAttachment(ACTIVE, EMAIL_ID, 'INBOX', 42, FILENAME, engine())).toBe(filePath);
    expect(h.syncEngine.fetchAttachmentPart).not.toHaveBeenCalled();
  });

  // Breaks: a read-only or otherwise unclearable cache dir turns every
  // attachment open into a hard failure, which is far worse than a stale cache.
  it('still serves the attachment when the cache cannot be cleared', async () => {
    const stale = await seedOlderGeneration(STALE);
    vi.spyOn(fs.promises, 'rm').mockRejectedValueOnce(new Error('EPERM'));

    const filePath = await getOrCacheAttachment(ACTIVE, EMAIL_ID, 'INBOX', 42, FILENAME, engine());

    expect(filePath).toBe(stale);
    expect(existsSync(filePath)).toBe(true);
    await expect(readCachedAttachment(filePath)).resolves.toBeInstanceOf(Buffer);
  });
});

/**
 * The size recorded against the email vs the bytes actually on disk.
 *
 * The stored size comes from parsing the message at import, so an attachment
 * whose part lied about its encoding was recorded at its collapsed decode length
 * — listed as "7 B" on the message and in the viewer header while the real file
 * is a kilobyte. Import runs once per message, so repairing the fetch does not
 * repair that number for mail already in the mailbox. (The file on disk is
 * sealed, so these also prove the PLAINTEXT size is what gets recorded, not the
 * sealed file's.)
 */
describe('stored attachment size reconciliation', () => {
  const withSizes = (sizes: number[], names: string[] = [FILENAME]) => {
    h.storage.getEmail.mockResolvedValue({
      id: EMAIL_ID,
      folderId: 'f1',
      uid: 42,
      attachmentNames: JSON.stringify(names),
      attachmentSizes: JSON.stringify(sizes),
    });
  };

  // Breaks: the attachment keeps showing "7 B" forever even once its content is
  // correct — which is exactly how the user spotted the bug.
  it('corrects a stored size that disagrees with the cached file', async () => {
    withSizes([7]);

    await resolveAttachmentFile({ emailId: EMAIL_ID, filename: FILENAME });

    expect(h.storage.updateEmail).toHaveBeenCalledWith(EMAIL_ID, {
      attachmentSizes: JSON.stringify([BYTES.length]),
    });
  });

  // Breaks: every open writes to the database for no reason — a write per
  // attachment view, on a path that should be read-only once settled.
  it('writes nothing when the stored size is already right', async () => {
    withSizes([BYTES.length]);

    await resolveAttachmentFile({ emailId: EMAIL_ID, filename: FILENAME });

    expect(h.storage.updateEmail).not.toHaveBeenCalled();
  });

  // Breaks: opening one attachment overwrites its siblings' sizes with junk,
  // turning a single wrong number into several.
  it('corrects only the attachment that was opened', async () => {
    withSizes([7, 4096], [FILENAME, 'sibling.pdf']);

    await resolveAttachmentFile({ emailId: EMAIL_ID, filename: FILENAME });

    expect(h.storage.updateEmail).toHaveBeenCalledWith(EMAIL_ID, {
      attachmentSizes: JSON.stringify([BYTES.length, 4096]),
    });
  });

  // Breaks: a legacy row (no sizes yet) or a mismatched array gets a
  // half-written sizes array from whichever attachment happened to be opened,
  // which then looks populated and stops the import path from filling it in.
  it('leaves a missing or mismatched sizes array for the import path', async () => {
    h.storage.getEmail.mockResolvedValue({
      id: EMAIL_ID, folderId: 'f1', uid: 42,
      attachmentNames: JSON.stringify([FILENAME, 'sibling.pdf']),
      attachmentSizes: null,
    });
    await resolveAttachmentFile({ emailId: EMAIL_ID, filename: FILENAME });
    expect(h.storage.updateEmail).not.toHaveBeenCalled();

    withSizes([7], [FILENAME, 'sibling.pdf']); // parallel array, wrong length
    await resolveAttachmentFile({ emailId: EMAIL_ID, filename: FILENAME });
    expect(h.storage.updateEmail).not.toHaveBeenCalled();
  });

  // Breaks: a failed size write fails the whole open, so a cosmetic number turns
  // into "this attachment cannot be read".
  it('still returns the file when the size write fails', async () => {
    withSizes([7]);
    h.storage.updateEmail.mockRejectedValue(new Error('db is busy'));

    const { filePath } = await resolveAttachmentFile({ emailId: EMAIL_ID, filename: FILENAME });

    expect(existsSync(filePath)).toBe(true);
  });

  // Breaks: a file at a cache path that is not sealed data (damaged, or left by
  // an older build) has its size written onto the email before anything
  // checked it — the list then shows a wrong size.
  it('does not take a size from a file that is not sealed data', async () => {
    h.storage.getEmail.mockResolvedValue({
      id: EMAIL_ID, folderId: 'f1', uid: 42,
      attachmentNames: JSON.stringify([FILENAME]),
      attachmentSizes: JSON.stringify([BYTES.length]),
    });
    const { filePath } = await resolveAttachmentFile({ emailId: EMAIL_ID, filename: FILENAME });
    h.storage.updateEmail.mockClear();
    fs.writeFileSync(filePath, 'not sealed: an older build left this here, and it is long');

    await resolveAttachmentFile({ emailId: EMAIL_ID, filename: FILENAME });

    expect(h.storage.updateEmail).not.toHaveBeenCalled();
  });

  // Breaks: the non-active account's row is read but the ACTIVE account's row is
  // written — corrupting a different mailbox's metadata from All Inboxes.
  it('writes back to the account that owns the message', async () => {
    h.otherStorage.getEmail.mockResolvedValue({
      id: EMAIL_ID, folderId: 'f9', uid: 7,
      attachmentNames: JSON.stringify([FILENAME]),
      attachmentSizes: JSON.stringify([7]),
    });

    await resolveAttachmentFile({ emailId: EMAIL_ID, filename: FILENAME, accountId: 'acct-2' });

    expect(h.otherStorage.updateEmail).toHaveBeenCalled();
    expect(h.storage.updateEmail).not.toHaveBeenCalled();
  });
});

describe('seedAttachmentCache (a locally-saved draft\'s files)', () => {
  const localDraft = () => h.storage.getEmail.mockResolvedValue({
    id: EMAIL_ID, folderId: 'f1', uid: 0, attachmentNames: JSON.stringify([FILENAME]),
  });

  // Breaks: a draft saved offline (no server copy, uid 0) reopens without its
  // attachments, because the only place they exist is this cache.
  it('serves a seeded file for a row that has no UID yet, without touching IMAP', async () => {
    localDraft();
    await seedAttachmentCache(ACTIVE, EMAIL_ID, [{ filename: FILENAME, content: BYTES }]);

    const { filePath } = await resolveAttachmentFile({ emailId: EMAIL_ID, filename: FILENAME });

    expect(await readCachedAttachment(filePath)).toEqual(BYTES);
    expect(h.syncEngine.fetchAttachmentPart).not.toHaveBeenCalled();
    expect(h.syncEngine.fetchAttachment).not.toHaveBeenCalled();
  });

  // Breaks: a UID-less miss asks IMAP for uid 0 — fetching some other message's
  // part, or hanging — instead of failing plainly.
  it('refuses a UID-less row whose file was never seeded', async () => {
    localDraft();

    await expect(
      resolveAttachmentFile({ emailId: EMAIL_ID, filename: FILENAME }),
    ).rejects.toMatchObject({ status: 404 });
    expect(h.syncEngine.fetchAttachmentPart).not.toHaveBeenCalled();
  });

  // MULTI-ACCOUNT. Breaks: a draft's files seeded for one account are served for
  // another account's row with the same id — one mailbox reading another's draft.
  it('keeps a seeded file to the account that saved the draft', async () => {
    localDraft();
    await seedAttachmentCache(OTHER, EMAIL_ID, [{ filename: FILENAME, content: BYTES }]);

    await expect(
      resolveAttachmentFile({ emailId: EMAIL_ID, filename: FILENAME }),
    ).rejects.toMatchObject({ status: 404 });
    expect(cachedFiles(OTHER)).toHaveLength(1);
    expect(cachedFiles(ACTIVE)).toEqual([]);
  });

  // SECURITY. Breaks: a draft attachment named "../../escape.bin" is written
  // outside its account's store, clobbering app files.
  // Changed deliberately (CASA M-7): names on disk are keyed hashes now, so the
  // proof is that the one file written sits in the account's folder, no file
  // named escape.bin exists anywhere, and that name still reads its bytes back.
  it('keeps a traversal filename inside the email\'s cache dir', async () => {
    await seedAttachmentCache(ACTIVE, EMAIL_ID, [{ filename: '../../escape.bin', content: BYTES }]);

    const files = cachedFiles();
    expect(files).toHaveLength(1);
    expect(walk(h.userData).filter((file) => basename(file) === 'escape.bin')).toEqual([]);
    expect(existsSync(join(h.userData, 'escape.bin'))).toBe(false);
    expect(existsSync(join(TMP, 'escape.bin'))).toBe(false);
    const back = await getOrCacheAttachment(ACTIVE, EMAIL_ID, 'Drafts', 0, '../../escape.bin', null);
    expect(back).toBe(files[0]);
    expect(await readCachedAttachment(back)).toEqual(BYTES);
  });

  // Breaks: seeding leaves a `.partial` temp beside the file, which the cache
  // then counts and serves forever — or seeds the draft's files in plaintext.
  // Changed deliberately (CASA M-7): names are hashed, so this counts the files
  // and reads each back by its real name instead of listing the names.
  it('leaves only the finished files behind', async () => {
    const A = Buffer.from('draft attachment A: the first seeded file');
    const B = Buffer.from('draft attachment B: the second seeded file');
    await seedAttachmentCache(ACTIVE, EMAIL_ID, [
      { filename: 'a.txt', content: A },
      { filename: 'b.txt', content: B },
    ]);

    const files = cachedFiles();
    expect(files).toHaveLength(2);
    expect(files.filter((file) => file.endsWith('.partial'))).toEqual([]);
    for (const [name, content] of [['a.txt', A], ['b.txt', B]] as const) {
      const filePath = await getOrCacheAttachment(ACTIVE, EMAIL_ID, 'Drafts', 0, name, null);
      expect(await readCachedAttachment(filePath)).toEqual(content);
    }
    expectStoreHidesPlaintext(['a.txt', 'b.txt', EMAIL_ID, ACTIVE], [A, B]);
  });
});

/**
 * An unsynced draft (uid 0) saved by a build that cached attachments in
 * PLAINTEXT at userData/attachment-cache/<emailId>/<name>. Its files exist
 * nowhere else — not on the server, not in the sealed store — so the first open
 * must adopt them: seal them in and remove the plaintext.
 */
describe('an unsynced draft cached in plaintext by an older build', () => {
  const LEGACY = Buffer.from('draft attachment saved in plaintext by an older build');
  const legacyFile = () => join(legacyAttachmentDir(EMAIL_ID), FILENAME);

  /** The old cache as an upgraded install has it — its own generation marker
   *  included, which the new store's generation check must leave alone. */
  function plantLegacy() {
    mkdirSync(legacyAttachmentDir(EMAIL_ID), { recursive: true });
    writeFileSync(legacyFile(), LEGACY);
    writeFileSync(join(legacyAttachmentCacheRoot(), GENERATION_MARKER), '2');
  }

  beforeEach(() => {
    h.storage.getEmail.mockResolvedValue({
      id: EMAIL_ID, folderId: 'f1', uid: 0, attachmentNames: JSON.stringify([FILENAME]),
    });
  });

  // Breaks: after the upgrade an offline-saved draft reopens without its
  // attachment (its only copy is the old plaintext cache), or the plaintext
  // stays on disk forever beside the sealed copy — or the new store's first-run
  // generation stamp wipes the old cache before the draft could be adopted.
  it('serves it, seals it into the account store, and removes the plaintext', async () => {
    plantLegacy();

    const { filePath } = await resolveAttachmentFile({ emailId: EMAIL_ID, filename: FILENAME });

    expect(isInside(accountAttachmentDir(ACTIVE), filePath)).toBe(true);
    expect(await readCachedAttachment(filePath)).toEqual(LEGACY);
    expect(existsSync(legacyFile())).toBe(false);
    expect(h.syncEngine.fetchAttachmentPart).not.toHaveBeenCalled();
    expect(h.syncEngine.fetchAttachment).not.toHaveBeenCalled();
    expectStoreHidesPlaintext([FILENAME, EMAIL_ID, ACTIVE], [LEGACY]);
  });

  // IDEMPOTENT RE-RUN. Breaks: the second open — the plaintext already gone —
  // finds nothing and the draft loses its attachment after one view.
  it('keeps serving the sealed copy on later opens', async () => {
    plantLegacy();
    const first = await resolveAttachmentFile({ emailId: EMAIL_ID, filename: FILENAME });

    const second = await resolveAttachmentFile({ emailId: EMAIL_ID, filename: FILENAME });

    expect(second.filePath).toBe(first.filePath);
    expect(await readCachedAttachment(second.filePath)).toEqual(LEGACY);
    expect(cachedFiles()).toHaveLength(1);
  });

  // TRANSIENT failure. Breaks: an interrupted adoption (disk full, quit
  // mid-write) deletes the plaintext before its sealed copy exists — losing the
  // only copy of an unsynced draft's attachment.
  it('keeps the plaintext when sealing it is interrupted, and a retry adopts it', async () => {
    plantLegacy();
    const renameSpy = vi
      .spyOn(fs.promises, 'rename')
      .mockRejectedValueOnce(new Error('EIO: interrupted'));

    await expect(
      resolveAttachmentFile({ emailId: EMAIL_ID, filename: FILENAME }),
    ).rejects.toThrow(/interrupted/);
    expect(readFileSync(legacyFile())).toEqual(LEGACY);
    expect(cachedFiles()).toEqual([]); // no sealed copy, no .partial

    renameSpy.mockRestore();
    const { filePath } = await resolveAttachmentFile({ emailId: EMAIL_ID, filename: FILENAME });
    expect(await readCachedAttachment(filePath)).toEqual(LEGACY);
    expect(existsSync(legacyFile())).toBe(false);
  });

  // SECURITY. Breaks: a crafted emailId points the adoption outside the old
  // cache folder, so an app file (the DB key) is read into the store — and then
  // DELETED as "adopted plaintext".
  it('never adopts, or deletes, a file outside the old cache folder', async () => {
    const appFile = join(h.userData, 'db-key.bin');
    writeFileSync(appFile, 'not an attachment');

    for (const emailId of ['..', '../', '../..', '.']) {
      await expect(
        getOrCacheAttachment(ACTIVE, emailId, 'Drafts', 0, 'db-key.bin', null),
      ).rejects.toMatchObject({ status: 404 });
    }

    expect(readFileSync(appFile, 'utf8')).toBe('not an attachment');
    expect(cachedFiles()).toEqual([]);
  });
});
