import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'fs';
import * as fs from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The attachment IPC handlers and the disk cache underneath them.
 *
 * `getOrCacheAttachment` had no tests at all, yet every attachment path in the
 * app — save, forward-as-base64, open-in-system-app and now the in-app viewer —
 * funnels through it. The regressions guarded here are the ones that look like
 * working software: an attachment that silently re-downloads on every open, a
 * truncated file cached forever as a corrupt document, and (the security one)
 * an executable handed to `shell.openPath` on a single click.
 *
 * Real filesystem, real cache logic; only IMAP, storage and the Electron
 * dialogs are faked.
 */

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...a: any[]) => any>(),
  userData: '',
  storage: { getEmail: vi.fn(), getFolder: vi.fn(), updateEmail: vi.fn() },
  /** Storage of a NON-active account, reachable only via getStorageFor. */
  otherStorage: { getEmail: vi.fn(), getFolder: vi.fn(), updateEmail: vi.fn() },
  syncEngine: {
    isConnected: vi.fn(() => true),
    fetchAttachmentPart: vi.fn(),
    fetchAttachment: vi.fn(),
  },
  saveDialog: { canceled: false, filePath: '' },
  openPath: vi.fn(async (_filePath: string) => ''),
}));

vi.mock('electron', () => ({
  ipcMain: { handle: (name: string, fn: (...a: any[]) => any) => h.handlers.set(name, fn) },
  dialog: { showSaveDialog: async () => h.saveDialog },
  shell: { openPath: (p: string) => h.openPath(p) },
  app: { getPath: () => h.userData },
}));
vi.mock('../../../../electron/shared', () => ({
  requireStorage: () => h.storage,
  requireSyncEngine: () => h.syncEngine,
  getMainWindow: () => null,
  getSyncEngine: () => h.syncEngine,
  getStorageFor: (id: string) => (id === 'acct-2' ? h.otherStorage : null),
  getSyncEngineFor: () => h.syncEngine,
  getCurrentAccountId: () => 'acct-1',
}));
vi.mock('../../../../electron/services/body-prefetch-scheduler', () => ({
  deferBodyPrefetch: vi.fn(),
}));
vi.mock('../../../../electron/services/accounts-runtime', () => ({ ensureAccountRuntime: vi.fn() }));
vi.mock('../../../../electron/ipc/agent-handlers', () => ({ logUserAction: vi.fn() }));

import { registerEmailHandlers } from '../../../../electron/ipc/email-handlers';
import {
  ATTACHMENT_CACHE_MAX_BYTES,
  attachmentCacheDir,
  attachmentErrorMessage,
  getOrCacheAttachment,
  MAX_ATTACHMENT_BYTES,
  pruneAttachmentCache,
  resolveAttachmentFile,
} from '../../../../electron/services/attachment-cache';

const TMP = mkdtempSync(join(tmpdir(), 'attachment-handlers-'));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

const EMAIL_ID = 'email-1';
const FILENAME = 'report.pdf';
const BYTES = Buffer.from('%PDF-1.7 body');

/** The sync engine as `getOrCacheAttachment` wants it. */
const engine = () => h.syncEngine as unknown as Parameters<typeof getOrCacheAttachment>[4];

const cache = (emailId = EMAIL_ID) => attachmentCacheDir(emailId);
const cachedNames = (emailId = EMAIL_ID) =>
  existsSync(cache(emailId)) ? readdirSync(cache(emailId)) : [];

const download = () => h.handlers.get('emails:downloadAttachment')!;
const base64 = () => h.handlers.get('emails:getAttachmentBase64')!;
const preview = () => h.handlers.get('emails:previewAttachment')!;

beforeEach(() => {
  h.userData = mkdtempSync(join(TMP, 'ud-'));
  h.handlers.clear();
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
    const first = await getOrCacheAttachment(EMAIL_ID, 'INBOX', 42, FILENAME, engine());
    h.syncEngine.fetchAttachmentPart.mockClear();

    const second = await getOrCacheAttachment(EMAIL_ID, 'INBOX', 42, FILENAME, engine());

    expect(second).toBe(first);
    expect(h.syncEngine.fetchAttachmentPart).not.toHaveBeenCalled();
    expect(readFileSync(first)).toEqual(BYTES);
  });

  // Breaks: servers that can't resolve the BODY[part] for an attachment would
  // return an empty result and the user would get "no content" instead of the
  // (more expensive, but working) whole-message parse.
  it('falls back to the whole-message fetch when the MIME part is unresolvable', async () => {
    h.syncEngine.fetchAttachmentPart.mockResolvedValue(null);
    const whole = Buffer.from('whole-message bytes');
    h.syncEngine.fetchAttachment.mockResolvedValue({ content: whole });

    const filePath = await getOrCacheAttachment(EMAIL_ID, 'INBOX', 42, FILENAME, engine());

    expect(readFileSync(filePath)).toEqual(whole);
  });

  // Breaks: an oversized (or malicious) attachment fills the disk before the
  // 500 MB LRU prune — which only runs AFTER the write — ever gets a chance.
  it('refuses an attachment over the size cap and writes nothing', async () => {
    h.syncEngine.fetchAttachmentPart.mockResolvedValue({
      content: Buffer.alloc(MAX_ATTACHMENT_BYTES + 1),
    });

    await expect(
      getOrCacheAttachment(EMAIL_ID, 'INBOX', 42, FILENAME, engine()),
    ).rejects.toThrow(/over the 50 MB limit/);
    expect(cachedNames()).toEqual([]);
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
      getOrCacheAttachment(EMAIL_ID, 'INBOX', 42, FILENAME, engine()),
    ).rejects.toThrow(/interrupted/);
    expect(cachedNames()).toEqual([]); // no .partial left behind either

    renameSpy.mockRestore();
    const filePath = await getOrCacheAttachment(EMAIL_ID, 'INBOX', 42, FILENAME, engine());
    expect(readFileSync(filePath)).toEqual(BYTES);
  });

  // TRANSIENT failure. Breaks: an offline app answers with a confusing deep
  // error (or an empty file) instead of "not connected".
  it('reports a clean error when IMAP is not connected, and writes nothing', async () => {
    h.syncEngine.isConnected.mockReturnValue(false);

    await expect(
      getOrCacheAttachment(EMAIL_ID, 'INBOX', 42, FILENAME, engine()),
    ).rejects.toThrow('Not connected to IMAP');
    expect(cachedNames()).toEqual([]);
    expect(h.syncEngine.fetchAttachmentPart).not.toHaveBeenCalled();
  });

  // Breaks: a non-string argument from a misbehaving renderer throws deep inside
  // path handling instead of being rejected at the edge.
  it('rejects an empty or non-string request', async () => {
    await expect(getOrCacheAttachment('', 'INBOX', 42, FILENAME, engine())).rejects.toThrow(
      /non-empty strings/,
    );
    await expect(
      getOrCacheAttachment(EMAIL_ID, 'INBOX', 42, null as unknown as string, engine()),
    ).rejects.toThrow(/non-empty strings/);
  });

  // SECURITY. Breaks: a crafted attachment name escapes the per-email cache
  // directory and clobbers a file elsewhere in userData (db-key.bin, a DB).
  it('keeps a traversing filename inside the cache directory', async () => {
    const filePath = await getOrCacheAttachment(
      EMAIL_ID,
      'INBOX',
      42,
      '../../../db-key.bin',
      engine(),
    );

    expect(filePath.startsWith(cache())).toBe(true);
    expect(existsSync(join(h.userData, 'db-key.bin'))).toBe(false);
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
  // lookup always used the ACTIVE account's storage.
  it('reads the owning account when the request carries a non-active accountId', async () => {
    await resolveAttachmentFile({ emailId: EMAIL_ID, filename: FILENAME, accountId: 'acct-2' });

    expect(h.otherStorage.getEmail).toHaveBeenCalledWith(EMAIL_ID);
    expect(h.storage.getEmail).not.toHaveBeenCalled();
    // …and fetched from that account's folder, not the active account's.
    expect(h.syncEngine.fetchAttachmentPart).toHaveBeenCalledWith(EMAIL_ID, 'Archive', 7, FILENAME);
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

    expect(readFileSync(filePath)).toEqual(BYTES);
  });
});

describe('emails:previewAttachment', () => {
  // SECURITY — the user's constraint: never open a file type that can harm the
  // system. `shell.openPath` asks the OS to LAUNCH the file, so an .exe/.sh/.js
  // would run with the user's privileges on one click. The renderer already
  // hides these, but main must not trust the renderer to be the only gate.
  it('refuses to launch a type outside the allow-list, without calling the shell', async () => {
    for (const name of ['setup.exe', 'run.sh', 'app.js', 'macro.vbs', 'invoice.html']) {
      const result = await preview()({}, EMAIL_ID, name);
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
    expect(await preview()({}, EMAIL_ID, 'invoice.pdf.exe')).toMatchObject({ success: false });
    expect(h.openPath).not.toHaveBeenCalled();
  });

  it('hands an allow-listed file to the OS and reports a launch failure', async () => {
    expect(await preview()({}, EMAIL_ID, FILENAME)).toEqual({ success: true });
    expect(h.openPath).toHaveBeenCalledWith(join(cache(), FILENAME));

    h.openPath.mockResolvedValue('No application is registered');
    expect(await preview()({}, EMAIL_ID, FILENAME)).toEqual({
      success: false,
      error: 'No application is registered',
    });
  });

  // MULTI-ACCOUNT, at the IPC edge rather than inside the resolver.
  it('honours accountId', async () => {
    await preview()({}, EMAIL_ID, FILENAME, 'acct-2');

    expect(h.otherStorage.getEmail).toHaveBeenCalledWith(EMAIL_ID);
  });
});

describe('emails:downloadAttachment', () => {
  it('copies the cached file to the chosen path', async () => {
    const target = join(TMP, 'chosen.pdf');
    h.saveDialog = { canceled: false, filePath: target };

    const result = await download()({}, EMAIL_ID, FILENAME);

    expect(result).toEqual({ success: true, filePath: target });
    expect(readFileSync(target)).toEqual(BYTES);
  });

  // Breaks: the renderer distinguishes a cancelled dialog from a real failure by
  // this exact string — changing it turns "user changed their mind" into a
  // logged error, which is how real errors get ignored.
  it('reports a cancelled dialog as "Save cancelled"', async () => {
    h.saveDialog = { canceled: true, filePath: '' };

    expect(await download()({}, EMAIL_ID, FILENAME)).toEqual({
      success: false,
      error: 'Save cancelled',
    });
  });

  // Breaks: a failure surfaces as an unhandled rejection (no result at all)
  // rather than a message the UI can show.
  it('returns the error message rather than throwing', async () => {
    h.storage.getEmail.mockResolvedValue(null);

    expect(await download()({}, EMAIL_ID, FILENAME)).toEqual({
      success: false,
      error: 'Email not found',
    });
  });

  it('honours accountId', async () => {
    await download()({}, EMAIL_ID, FILENAME, 'acct-2');

    expect(h.otherStorage.getEmail).toHaveBeenCalledWith(EMAIL_ID);
  });
});

describe('emails:getAttachmentBase64', () => {
  // Breaks: forwarding an attachment re-attaches corrupt bytes — the encoding is
  // the wire format the compose path re-attaches from.
  it('returns the cached bytes base64-encoded', async () => {
    const result = await base64()({}, EMAIL_ID, FILENAME);

    expect(result).toEqual({ success: true, base64: BYTES.toString('base64') });
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
  it('keeps a traversing emailId inside the cache root', () => {
    const root = join(h.userData, 'attachment-cache');

    expect(attachmentCacheDir('../../escape').startsWith(root)).toBe(true);
  });

  // Breaks: cached mail content becomes world-readable on a shared macOS/Linux
  // box. (A no-op on Windows, which uses ACLs — asserted only where modes mean
  // something.)
  it.skipIf(process.platform === 'win32')('writes cached attachments 0o600', async () => {
    const filePath = await getOrCacheAttachment(EMAIL_ID, 'INBOX', 42, FILENAME, engine());

    expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
  });
});

describe('pruneAttachmentCache', () => {
  /** A sparse file: it REPORTS `bytes` to stat but occupies no disk, so the
   *  500 MB cap can be crossed in a test without writing 500 MB. */
  function sparse(emailId: string, bytes: number, ageMs: number): string {
    const dir = attachmentCacheDir(emailId);
    fs.mkdirSync(dir, { recursive: true });
    const filePath = join(dir, 'cached.bin');
    fs.writeFileSync(filePath, '');
    fs.truncateSync(filePath, bytes);
    const seconds = (Date.now() - ageMs) / 1000;
    fs.utimesSync(filePath, seconds, seconds);
    return filePath;
  }

  /** Step past the 5-minute throttle so an explicit prune actually runs. The
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

  // Breaks: the cache grew without limit — every attachment ever opened stayed
  // on disk forever. This is what bounds it, oldest-first and only as far as it
  // has to go.
  it('evicts least-recently-used files until back under the cap, and no further', async () => {
    const share = Math.ceil(ATTACHMENT_CACHE_MAX_BYTES * 0.3);
    const oldest = sparse('email-old', share, 90_000);
    const middle = sparse('email-mid', share, 60_000);
    const recent = sparse('email-recent', share, 30_000);
    const newest = sparse('email-new', share * 2, 0);

    await pruneNow(); // 1.5x the cap on disk

    expect(existsSync(oldest)).toBe(false);
    expect(existsSync(middle)).toBe(false);
    expect(existsSync(recent)).toBe(true); // dropping below the cap stopped it here
    expect(existsSync(newest)).toBe(true);
    // …and an emptied per-email directory goes with its file, so the tree
    // doesn't accumulate stubs.
    expect(existsSync(attachmentCacheDir('email-old'))).toBe(false);
    expect(existsSync(attachmentCacheDir('email-recent'))).toBe(true);
  });

  // Breaks: a cache under its cap gets pruned anyway, so the next open of a
  // recently-read attachment re-downloads it.
  it('deletes nothing while under the cap', async () => {
    const keep = sparse('email-1', 1024, 0);

    await pruneNow();

    expect(existsSync(keep)).toBe(true);
  });

  // Breaks: one unreadable entry (a stray directory, a file deleted mid-scan)
  // aborts the whole prune, so the cache never shrinks again.
  it('skips entries it cannot account for and prunes the rest', async () => {
    const share = Math.ceil(ATTACHMENT_CACHE_MAX_BYTES * 0.6);
    const oldest = sparse('email-old', share, 90_000);
    sparse('email-new', share, 0);
    // A nested directory where a cached file would be, and a per-email entry
    // that is a plain file rather than a directory.
    fs.mkdirSync(join(attachmentCacheDir('email-new'), 'nested'), { recursive: true });
    fs.writeFileSync(join(h.userData, 'attachment-cache', 'stray'), 'not a directory');

    await pruneNow();

    expect(existsSync(oldest)).toBe(false);
  });

  // Breaks: a first run (or a wiped userData) throws out of a best-effort
  // maintenance path instead of simply having nothing to do.
  it('does nothing when the cache directory does not exist', async () => {
    await expect(pruneNow()).resolves.toBeUndefined();
  });

  // Breaks: housekeeping runs on every single attachment open, re-scanning the
  // whole tree each time — a stall while the user is just reading mail.
  it('does no work again within the throttle window', async () => {
    const over = sparse('email-1', ATTACHMENT_CACHE_MAX_BYTES * 2, 0);
    await pruneNow();
    expect(existsSync(over)).toBe(false);

    const again = sparse('email-2', ATTACHMENT_CACHE_MAX_BYTES * 2, 0);
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
 */
describe('the cache generation', () => {
  const root = () => join(h.userData, 'attachment-cache');
  const marker = () => join(root(), '.cache-generation');
  const STALE = Buffer.from('7 junk bytes from the old decoder');

  /** Put a file in the cache exactly where a previous generation left one. */
  const seedCached = (generation: string) => {
    fs.mkdirSync(cache(), { recursive: true });
    fs.writeFileSync(join(cache(), FILENAME), STALE);
    fs.writeFileSync(marker(), generation);
  };

  // Breaks: the 7-byte file cached before the lying-encoding fix keeps being
  // served, so the attachment stays corrupt no matter how well the fetch path
  // is repaired. Only a generation bump can reach data already on disk.
  it('discards a cache written by an older generation and re-fetches', async () => {
    seedCached('1');

    const filePath = await getOrCacheAttachment(EMAIL_ID, 'INBOX', 42, FILENAME, engine());

    expect(readFileSync(filePath)).toEqual(BYTES);
    expect(h.syncEngine.fetchAttachmentPart).toHaveBeenCalled();
  });

  // Breaks: the generation check degenerates into "wipe the cache on every
  // open", which is the same as having no cache — every attachment re-downloads.
  it('keeps a cache already at the current generation', async () => {
    // Let the code itself stamp the current generation, so this does not pin the
    // number — only that a matching one is honoured.
    await getOrCacheAttachment(EMAIL_ID, 'INBOX', 42, FILENAME, engine());
    fs.writeFileSync(join(cache(), FILENAME), STALE);
    h.syncEngine.fetchAttachmentPart.mockClear();

    const filePath = await getOrCacheAttachment(EMAIL_ID, 'INBOX', 42, FILENAME, engine());

    expect(readFileSync(filePath)).toEqual(STALE);
    expect(h.syncEngine.fetchAttachmentPart).not.toHaveBeenCalled();
  });

  // Breaks: the clear happens once per process, so a second attachment opened
  // after the first would wipe the file the first just fetched.
  it('clears once, not on every attachment', async () => {
    seedCached('1');

    const first = await getOrCacheAttachment(EMAIL_ID, 'INBOX', 42, FILENAME, engine());
    await getOrCacheAttachment('email-2', 'INBOX', 43, 'other.pdf', engine());

    expect(existsSync(first)).toBe(true);
    expect(readFileSync(first)).toEqual(BYTES);
  });

  // Breaks: the marker is treated as a per-email directory, so the scan throws
  // or counts it — and a cleared cache immediately re-clears on the next open.
  it('leaves the marker alone when the cache is pruned', async () => {
    await getOrCacheAttachment(EMAIL_ID, 'INBOX', 42, FILENAME, engine());

    await pruneAttachmentCache();

    expect(existsSync(marker())).toBe(true);
    expect(cachedNames()).toEqual([FILENAME]);
  });

  // Breaks: a read-only or otherwise unclearable cache dir turns every
  // attachment open into a hard failure, which is far worse than a stale cache.
  it('still serves the attachment when the cache cannot be cleared', async () => {
    seedCached('1');
    vi.spyOn(fs.promises, 'rm').mockRejectedValueOnce(new Error('EPERM'));

    const filePath = await getOrCacheAttachment(EMAIL_ID, 'INBOX', 42, FILENAME, engine());

    expect(existsSync(filePath)).toBe(true);
  });
});

/**
 * The size recorded against the email vs the bytes actually on disk.
 *
 * The stored size comes from parsing the message at import, so an attachment
 * whose part lied about its encoding was recorded at its collapsed decode length
 * — listed as "7 B" on the message and in the viewer header while the real file
 * is a kilobyte. Import runs once per message, so repairing the fetch does not
 * repair that number for mail already in the mailbox.
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
