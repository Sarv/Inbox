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
  ATTACHMENT_CACHE_MAX_BYTES,
  attachmentCacheDir,
  attachmentErrorMessage,
  getOrCacheAttachment,
  MAX_ATTACHMENT_BYTES,
  pruneAttachmentCache,
  resolveAttachmentFile,
  seedAttachmentCache,
} from '../../../../electron/services/attachment-cache';

const TMP = mkdtempSync(join(tmpdir(), 'attachment-handlers-'));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

const EMAIL_ID = 'email-1';
const FILENAME = 'report.pdf';
const BYTES = Buffer.from('%PDF-1.7 body');
const CALENDAR_ICS = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:synthetic@example.invalid\r\nDTSTART:20261005T090000Z\r\nSUMMARY:Synthetic\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';

/** The sync engine as `getOrCacheAttachment` wants it. */
const engine = () => h.syncEngine as unknown as Parameters<typeof getOrCacheAttachment>[4];

const cache = (emailId = EMAIL_ID) => attachmentCacheDir(emailId);
const cachedNames = (emailId = EMAIL_ID) =>
  existsSync(cache(emailId)) ? readdirSync(cache(emailId)) : [];

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

  it('hands an allow-listed file to the OS and reports a launch failure', async () => {
    expect(await preview()(downloadEvent(), EMAIL_ID, FILENAME)).toEqual({ success: true });
    expect(h.openPath).toHaveBeenCalledWith(join(cache(), FILENAME));

    h.openPath.mockResolvedValue('No application is registered');
    expect(await preview()(downloadEvent(), EMAIL_ID, FILENAME)).toEqual({
      success: false,
      error: 'No application is registered',
    });
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

  it('blocks generated calendar imports while a scanner is enabled before reading or writing mail', async () => {
    enableScanner();
    expect(await calendar()(downloadEvent(), EMAIL_ID, 'acct-2')).toEqual({
      success: false, error: 'Calendar import blocked: save or open the calendar attachment after scanning it.',
    });
    expect(h.storage.getEmail).not.toHaveBeenCalled(); expect(h.otherStorage.getEmail).not.toHaveBeenCalled();
    expect(h.openPath).not.toHaveBeenCalled(); expect(cachedNames()).toEqual([]); expect(h.scanDownload).not.toHaveBeenCalled();
  });

  it('requires the trusted main frame and preserves legacy import without an enabled scanner', async () => {
    expect(await calendar()({ sender: h.webContents, senderFrame: {} }, EMAIL_ID)).toEqual({
      success: false, error: 'Attachment downloads must be requested from Sarv Inbox.',
    });
    h.storage.getEmail.mockResolvedValue({ id: EMAIL_ID, calendarIcs: CALENDAR_ICS });
    expect(await calendar()(downloadEvent(), EMAIL_ID)).toEqual({ success: true });
    expect(h.openPath).toHaveBeenCalledWith(join(cache(), 'calendar-event.ics'));
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

  it('rechecks setup after a calendar fallback read and before writing or opening the generated file', async () => {
    enableScanner(); h.scannerSetup.mockResolvedValue({ configured: false, allowedAccountIds: [] }); h.warning.mockResolvedValue('continue');
    h.syncEngine.getCalendarIcs.mockImplementation(async () => {
      h.missingSetupAssert.mockRejectedValue(new Error('Antivirus setup changed. Try again.')); return CALENDAR_ICS;
    });
    expect(await calendar()(downloadEvent(), EMAIL_ID, 'acct-2')).toEqual({ success: false, error: 'Antivirus setup changed. Try again.' });
    expect(h.openPath).not.toHaveBeenCalled(); expect(cachedNames()).toEqual([]);
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

  it('copies the cached file to the chosen path', async () => {
    const target = join(TMP, 'chosen.pdf');
    h.saveDialog = { canceled: false, filePath: target };

    const result = await download()(downloadEvent(), EMAIL_ID, FILENAME);

    expect(result).toEqual({ success: true, filePath: target });
    expect(readFileSync(target)).toEqual(BYTES);
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

describe('seedAttachmentCache (a locally-saved draft\'s files)', () => {
  const localDraft = () => h.storage.getEmail.mockResolvedValue({
    id: EMAIL_ID, folderId: 'f1', uid: 0, attachmentNames: JSON.stringify([FILENAME]),
  });

  // Breaks: a draft saved offline (no server copy, uid 0) reopens without its
  // attachments, because the only place they exist is this cache.
  it('serves a seeded file for a row that has no UID yet, without touching IMAP', async () => {
    localDraft();
    await seedAttachmentCache(EMAIL_ID, [{ filename: FILENAME, content: BYTES }]);

    const { filePath } = await resolveAttachmentFile({ emailId: EMAIL_ID, filename: FILENAME });

    expect(readFileSync(filePath)).toEqual(BYTES);
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

  // SECURITY. Breaks: a draft attachment named "../../db-key.bin" is written
  // outside the email's cache dir, clobbering app files.
  it('keeps a traversal filename inside the email\'s cache dir', async () => {
    await seedAttachmentCache(EMAIL_ID, [{ filename: '../../escape.bin', content: BYTES }]);

    expect(cachedNames()).toEqual(['escape.bin']);
    expect(existsSync(join(h.userData, 'escape.bin'))).toBe(false);
  });

  // Breaks: seeding leaves a `.partial` temp beside the file, which the cache
  // then counts and serves forever.
  it('leaves only the finished files behind', async () => {
    await seedAttachmentCache(EMAIL_ID, [
      { filename: 'a.txt', content: Buffer.from('a') },
      { filename: 'b.txt', content: Buffer.from('b') },
    ]);

    expect(cachedNames().sort()).toEqual(['a.txt', 'b.txt']);
  });
});
