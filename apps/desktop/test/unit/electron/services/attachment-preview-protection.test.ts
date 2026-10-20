import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { buildAttachmentUrl, parseAttachmentUrl } from '@sarvinbox/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AttachmentError, MAX_ATTACHMENT_BYTES } from '../../../../electron/services/attachment-cache';
import {
  AttachmentOperationProtection,
  type AttachmentOperationDependencies,
  type DownloadScanner,
} from '../../../../electron/services/attachment-download-protection';
import {
  AttachmentPreviewProtection,
  getAttachmentPreviewProtection,
  setAttachmentPreviewProtection,
} from '../../../../electron/services/attachment-preview-protection';

/**
 * Stands in for the sealed attachment cache (CASA M-7): an entry on disk is
 * never the attachment's plaintext, and only the `readLegacy` dependency turns
 * it back into the bytes. So any test below that finds the plaintext in a file
 * proves a private copy was written; finding the cache entry's path handed to
 * the OS would hand it ciphertext.
 */
const SEALED = 'sealed-for-test:';
function sealForTest(content: string): Buffer {
  return Buffer.from(SEALED + Buffer.from(content).toString('base64'));
}
const CACHED_PLAINTEXT = '%PDF decrypted cache document';

const directories: string[] = [];
const controllers: AttachmentPreviewProtection[] = [];
afterEach(async () => {
  for (const controller of controllers.splice(0)) await controller.dispose();
  for (const directory of directories.splice(0))
    await fs.rm(directory, { recursive: true, force: true });
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function fixture(options: { enabled?: boolean; ttlMs?: number; now?: () => number } = {}) {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'inbox-preview-test-'));
  directories.push(root);
  let scanners: DownloadScanner[] =
    options.enabled === false
      ? []
      : [{ id: 'clamav-scan', enabled: true, active: true, granted: true, scanner: true }];
  const receipts: Array<{
    content: Buffer;
    assertCurrent: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
  }> = [];
  const deps: AttachmentOperationDependencies = {
    scanners: () => scanners,
    scan: vi.fn(async (_id, _message, _account, _name, request) => {
      const content = Buffer.from('%PDF exact synthetic clean document');
      const receipt = {
        content,
        assertCurrent: vi.fn(async () => {}),
        dispose: vi.fn(() => content.fill(0)),
      };
      receipts.push(receipt);
      request.onProgress('scanning');
      return receipt;
    }),
    openSetup: vi.fn(),
    progress: vi.fn(),
  };
  const operations = new AttachmentOperationProtection(deps);
  // The cache lives outside `root`: `root` holds only the private copies, so a
  // test can assert it is empty after a failure.
  const cacheDir = await fs.mkdtemp(path.join(tmpdir(), 'inbox-preview-cache-'));
  directories.push(cacheDir);
  const cacheFile = path.join(cacheDir, 'sealed-entry');
  await fs.writeFile(cacheFile, sealForTest(CACHED_PLAINTEXT));
  const resolveLegacy = vi.fn(async () => cacheFile);
  // Every plaintext buffer the decrypting reader handed out, so tests can prove
  // it was wiped once the operation was done with it.
  const decrypted: Buffer[] = [];
  const readLegacy = vi.fn(async (file: string, signal: AbortSignal) => {
    signal.throwIfAborted();
    const stored = await fs.readFile(file, 'utf8');
    if (!stored.startsWith(SEALED))
      throw new AttachmentError('The attachment could not be read. Try again.', 500);
    const plaintext = Buffer.from(stored.slice(SEALED.length), 'base64');
    decrypted.push(plaintext);
    return plaintext;
  });
  const openPath = vi.fn(async (_file: string) => '');
  const preview = new AttachmentPreviewProtection({
    operations,
    resolveLegacy,
    readLegacy,
    openPath,
    temporaryRoot: () => root,
    ttlMs: options.ttlMs,
    now: options.now,
  });
  controllers.push(preview);
  const ref = { emailId: 'message-b', accountId: 'account-b', filename: 'document.pdf' };
  const prepare = (requestId?: string) =>
    preview.preparePreview(ref.emailId, ref.accountId, ref.filename, requestId);
  const read = (url: string, signal?: AbortSignal) =>
    preview.contentForRequest(parseAttachmentUrl(url)!, url, signal);
  const open = (requestId?: string) =>
    preview.openPreview(ref.emailId, ref.accountId, ref.filename, requestId);
  return {
    root,
    cacheDir,
    cacheFile,
    decrypted,
    deps,
    operations,
    resolveLegacy,
    readLegacy,
    openPath,
    preview,
    receipts,
    ref,
    prepare,
    read,
    open,
    scanners: (value: DownloadScanner[]) => {
      scanners = value;
    },
  };
}

// Breaks: an in-app PDF/media/text viewer renders unscanned cache bytes or leaks another mailbox's receipt.
describe('protected in-app attachment previews', () => {
  it('prepares only the exact clean retained bytes and erases them when the viewer closes', async () => {
    const f = await fixture();
    const url = await f.prepare('preview-1');
    expect(new URL(url).searchParams.get('preview')).toBeTruthy();
    expect(await f.read(url)).toBe(f.receipts[0].content);
    expect(f.deps.scan).toHaveBeenCalledWith(
      'clamav-scan',
      'message-b',
      'account-b',
      'document.pdf',
      expect.any(Object)
    );
    expect(f.resolveLegacy).not.toHaveBeenCalled();
    expect(f.deps.progress).toHaveBeenCalledWith('preview-1', 'scanning');
    expect(f.preview.releasePreview(url)).toBe(true);
    expect(f.preview.releasePreview(url)).toBe(false);
    expect(f.receipts[0].content.every((byte) => byte === 0)).toBe(true);
    await expect(f.read(url)).rejects.toMatchObject({ status: 403 });
  });

  it.each(['threat', 'incomplete coverage', 'offline', 'digest mismatch'])(
    'returns no viewer URL after %s',
    async (reason) => {
      const f = await fixture();
      vi.mocked(f.deps.scan).mockRejectedValue(new Error(reason));
      await expect(f.prepare()).rejects.toThrow(reason);
      expect(f.resolveLegacy).not.toHaveBeenCalled();
    }
  );

  it('never lets a missing, empty or unknown lease fall back to cached mail while AV is enabled', async () => {
    const f = await fixture();
    const url = buildAttachmentUrl(f.ref);
    for (const target of [url, `${url}&preview=`, `${url}&preview=unknown`])
      await expect(f.read(target)).rejects.toMatchObject({ status: 403 });
    expect(f.resolveLegacy).not.toHaveBeenCalled();
  });

  it.each([
    'account',
    'email',
    'filename',
    'origin',
    'extra-query',
    'duplicate-query',
    'fragment',
    'credentials',
  ])('refuses a lease with a modified %s', async (change) => {
    const f = await fixture();
    const prepared = await f.prepare();
    const url = new URL(prepared);
    if (change === 'account') url.searchParams.set('account', 'account-other');
    if (change === 'email') url.pathname = '/message-other/document.pdf';
    if (change === 'filename') url.pathname = '/message-b/other.pdf';
    if (change === 'origin') url.host = 'other';
    if (change === 'extra-query') url.searchParams.set('bypass', 'true');
    if (change === 'duplicate-query') url.searchParams.append('preview', 'other');
    if (change === 'fragment') url.hash = 'other';
    if (change === 'credentials') url.username = 'other';
    await expect(f.preview.contentForRequest(f.ref, url.toString())).rejects.toMatchObject({
      status: 403,
    });
    expect(await f.read(prepared)).toBe(f.receipts[0].content);
  });

  it('rejects malformed URLs, mismatched release URLs and duplicate account fields', async () => {
    const f = await fixture();
    const url = await f.prepare();
    await expect(f.preview.contentForRequest(f.ref, 'not a URL')).rejects.toMatchObject({
      status: 403,
    });
    await expect(f.read(`${url}&account=other`)).rejects.toMatchObject({ status: 403 });
    expect(() => f.preview.releasePreview('not a URL')).toThrow(/Preview blocked/);
    expect(() => f.preview.releasePreview(url.replace('message-b', 'message-other'))).toThrow(
      /Preview blocked/
    );
  });

  it('erases a receipt on consent revocation and still refuses its URL after scanning is disabled', async () => {
    const f = await fixture();
    const url = await f.prepare();
    f.receipts[0].assertCurrent.mockRejectedValue(new Error('account approval removed'));
    await expect(f.read(url)).rejects.toMatchObject({ status: 403 });
    expect(f.receipts[0].dispose).toHaveBeenCalledOnce();
    f.scanners([]);
    await expect(f.read(url)).rejects.toMatchObject({ status: 403 });
  });

  it('erases a receipt when the extension loses activation or permission', async () => {
    const f = await fixture();
    const url = await f.prepare();
    f.scanners([
      { id: 'clamav-scan', enabled: true, active: false, granted: false, scanner: true },
    ]);
    await expect(f.read(url)).rejects.toMatchObject({ status: 403 });
    expect(f.receipts[0].dispose).toHaveBeenCalledOnce();
  });

  it('expires and erases leases without a later request', async () => {
    const f = await fixture({ ttlMs: 10 });
    const url = await f.prepare();
    await vi.waitFor(() => expect(f.receipts[0].dispose).toHaveBeenCalledOnce());
    await expect(f.read(url)).rejects.toMatchObject({ status: 403 });
  });

  it('prunes a past deadline and caps configured TTL at five minutes', async () => {
    let now = 1000;
    const f = await fixture({ ttlMs: 900_000, now: () => now });
    const url = await f.prepare();
    now += 300_001;
    await expect(f.read(url)).rejects.toMatchObject({ status: 403 });
    expect(f.receipts[0].dispose).toHaveBeenCalledOnce();
  });

  it('bounds retained previews and releases a slot idempotently', async () => {
    const f = await fixture();
    const urls = await Promise.all(Array.from({ length: 4 }, () => f.prepare()));
    await expect(f.prepare()).rejects.toThrow(/Too many/);
    expect(f.deps.scan).toHaveBeenCalledTimes(4);
    f.preview.releasePreview(urls[0]);
    expect(await f.prepare()).toContain('preview=');
    await f.preview.dispose();
    expect(f.receipts.every((receipt) => receipt.content.every((byte) => byte === 0))).toBe(true);
  });

  it('rechecks the retained limit when parallel scans finish after a fifth viewer started', async () => {
    const f = await fixture();
    let release!: () => void;
    await Promise.all(Array.from({ length: 3 }, () => f.prepare()));
    const original = vi.mocked(f.deps.scan).getMockImplementation()!;
    vi.mocked(f.deps.scan).mockImplementationOnce(async (...args) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return original(...args);
    });
    const late = f.prepare();
    await f.prepare();
    release();
    await expect(late).rejects.toThrow(/Too many/);
    expect(f.receipts[4].dispose).toHaveBeenCalledOnce();
  });

  it('refuses a close or TTL expiry occurring during an awaited consent check', async () => {
    const f = await fixture();
    const url = await f.prepare();
    let finish!: () => void;
    f.receipts[0].assertCurrent.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        })
    );
    const pending = f.read(url);
    f.preview.releasePreview(url);
    finish();
    await expect(pending).rejects.toMatchObject({ status: 403 });
  });

  it('propagates protocol cancellation without destroying a valid media lease', async () => {
    const f = await fixture();
    const url = await f.prepare();
    const abort = new AbortController();
    f.receipts[0].assertCurrent.mockImplementationOnce(() => new Promise<void>(() => {}));
    const pending = f.read(url, abort.signal);
    abort.abort(new Error('range request cancelled'));
    await expect(pending).rejects.toThrow('range request cancelled');
    expect(f.receipts[0].dispose).not.toHaveBeenCalled();
    expect(await f.read(url)).toBe(f.receipts[0].content);
    await expect(f.read(url, abort.signal)).rejects.toThrow('range request cancelled');
  });

  it('cancels a late clean preparation and erases its receipt without yielding a URL', async () => {
    const f = await fixture();
    let finish!: () => void;
    const original = vi.mocked(f.deps.scan).getMockImplementation()!;
    vi.mocked(f.deps.scan).mockImplementation(async (...args) => {
      const receipt = await original(...args);
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return receipt;
    });
    const pending = f.prepare('cancel-view');
    await vi.waitFor(() => expect(typeof finish).toBe('function'));
    f.operations.cancel('cancel-view');
    finish();
    await expect(pending).rejects.toThrow('Download cancelled.');
    expect(f.receipts[0].dispose).toHaveBeenCalledOnce();
    expect(f.resolveLegacy).not.toHaveBeenCalled();
  });

  it('cancels pending scans and refuses future operations during shutdown', async () => {
    const f = await fixture();
    let signal: AbortSignal | undefined;
    vi.mocked(f.deps.scan).mockImplementation(
      (_id, _message, _account, _name, options) =>
        new Promise((_resolve, reject) => {
          signal = options.signal;
          options.signal.addEventListener('abort', () => reject(new Error('Download cancelled.')), {
            once: true,
          });
        })
    );
    const pending = f.prepare('shutdown-view');
    await f.preview.dispose();
    expect(signal?.aborted).toBe(true);
    await expect(pending).rejects.toThrow('Download cancelled.');
    await expect(f.prepare()).rejects.toMatchObject({ status: 403 });
    await expect(f.open()).rejects.toMatchObject({ status: 403 });
    await expect(f.read(buildAttachmentUrl(f.ref))).rejects.toMatchObject({ status: 403 });
    expect(f.resolveLegacy).not.toHaveBeenCalled();
    expect(await fs.readdir(f.root)).toEqual([]);
  });

  it('preserves legacy views only without AV and rechecks enablement after a late cache fetch', async () => {
    const f = await fixture({ enabled: false });
    const url = await f.prepare();
    expect(await f.read(url)).toBeUndefined();
    expect(f.preview.releasePreview(url)).toBe(false);
    f.resolveLegacy.mockImplementation(async () => {
      f.scanners([
        { id: 'clamav-scan', enabled: true, active: true, granted: true, scanner: true },
      ]);
      return '/synthetic/cache.pdf';
    });
    await expect(f.prepare()).rejects.toThrow(/Retry the download/);
    expect(f.deps.scan).not.toHaveBeenCalled();
  });

  it('rejects inline executable/document types before reading or scanning', async () => {
    const f = await fixture();
    for (const name of ['run.exe', 'report.docx', 'invoice.html'])
      await expect(f.preview.preparePreview('message', 'account', name)).rejects.toMatchObject({
        status: 403,
      });
    expect(f.deps.scan).not.toHaveBeenCalled();
    expect(f.resolveLegacy).not.toHaveBeenCalled();
  });
});

// Breaks: accepting one warning exposes raw URLs, another account, or mutable cache bytes.
describe('missing-setup preview continuation', () => {
  async function missingSetup(options: { ttlMs?: number } = {}) {
    const f = await fixture(options);
    // A sealed cache entry (see sealForTest); only readLegacy yields its bytes.
    const file = path.join(f.cacheDir, 'local.pdf');
    await fs.writeFile(file, sealForTest('%PDF warning-approved local bytes'));
    f.resolveLegacy.mockResolvedValue(file);
    const assertMissing = vi.fn(async () => {});
    f.deps.checkSetup = vi.fn(async () => ({ assertCurrent: assertMissing }));
    f.deps.confirmUnscanned = vi.fn(async () => 'continue' as const);
    return { ...f, file, assertMissing };
  }

  it('retains an opaque local snapshot, marks it unscanned, and erases it on close without uploading', async () => {
    const f = await missingSetup();
    const flag = vi.fn();
    const url = await f.preview.preparePreview(
      f.ref.emailId,
      f.ref.accountId!,
      f.ref.filename,
      'warned-view',
      flag
    );
    expect(new URL(url).searchParams.get('preview')).toBeTruthy();
    expect(flag).toHaveBeenCalledOnce();
    expect(f.deps.confirmUnscanned).toHaveBeenCalledWith(
      {
        messageId: f.ref.emailId,
        accountId: f.ref.accountId,
        filename: f.ref.filename,
        action: 'view',
      },
      expect.any(AbortSignal),
      expect.any(Function)
    );
    const bytes = (await f.read(url))!;
    expect(bytes.toString()).toBe('%PDF warning-approved local bytes');
    // The warning-approved snapshot is bounded like a fetch (CASA M-7 kept the cap).
    expect(f.readLegacy).toHaveBeenCalledWith(f.file, expect.any(AbortSignal), MAX_ATTACHMENT_BYTES);
    await fs.writeFile(f.file, sealForTest('cache changed after warning'));
    expect((await f.read(url))!.toString()).toBe('%PDF warning-approved local bytes');
    expect(f.deps.scan).not.toHaveBeenCalled();
    for (const forged of [
      buildAttachmentUrl(f.ref),
      url.replace('account-b', 'account-other'),
      `${url}&bypass=true`,
    ]) {
      await expect(f.read(forged)).rejects.toMatchObject({ status: 403 });
    }
    f.preview.releasePreview(url);
    expect(bytes.every((byte) => byte === 0)).toBe(true);
    await expect(f.read(url)).rejects.toMatchObject({ status: 403 });
  });

  // Breaks: opening Office documents shows the preview/download wording instead of the host action.
  it('labels an OS open warning with Open anyway', async () => {
    const f = await missingSetup();
    await f.open();
    expect(f.deps.confirmUnscanned).toHaveBeenCalledWith(
      {
        messageId: f.ref.emailId,
        accountId: f.ref.accountId,
        filename: f.ref.filename,
        action: 'open',
      },
      expect.any(AbortSignal),
      expect.any(Function)
    );
  });

  it('requires a fresh warning on every preview and never renders after Cancel', async () => {
    const f = await missingSetup();
    const first = await f.prepare();
    f.preview.releasePreview(first);
    const second = await f.prepare();
    expect(second).not.toBe(first);
    expect(f.deps.confirmUnscanned).toHaveBeenCalledTimes(2);
    vi.mocked(f.deps.confirmUnscanned!).mockResolvedValue('cancel');
    await expect(f.prepare()).rejects.toThrow('Download cancelled.');
    expect(f.resolveLegacy).toHaveBeenCalledTimes(2);
  });

  it('invalidates the local lease if setup changes, even if scanning is later disabled', async () => {
    const f = await missingSetup();
    const url = await f.prepare();
    const bytes = (await f.read(url))!;
    f.assertMissing.mockRejectedValue(new Error('configuration changed'));
    await expect(f.read(url)).rejects.toMatchObject({ status: 403 });
    expect(bytes.every((byte) => byte === 0)).toBe(true);
    f.scanners([]);
    await expect(f.read(url)).rejects.toMatchObject({ status: 403 });
  });

  it('erases local leases at their deadline and never falls back to cached bytes', async () => {
    const f = await missingSetup({ ttlMs: 10 });
    const url = await f.prepare();
    const bytes = (await f.read(url))!;
    await vi.waitFor(() => expect(bytes.every((byte) => byte === 0)).toBe(true));
    await expect(f.read(url)).rejects.toMatchObject({ status: 403 });
  });

  it('does not retain a URL if setup changes during the local cache read', async () => {
    const f = await missingSetup();
    f.resolveLegacy.mockImplementation(async () => {
      f.assertMissing.mockRejectedValue(new Error('setup changed'));
      return f.file;
    });
    await expect(f.prepare()).rejects.toThrow(/setup changed/);
    expect(f.deps.scan).not.toHaveBeenCalled();
  });

  it('cleans an unscanned buffer when the final snapshot check fails after reading', async () => {
    const f = await missingSetup();
    let checks = 0;
    f.assertMissing.mockImplementation(async () => {
      if (++checks === 4) throw new Error('setup changed after read');
    });
    await expect(f.prepare()).rejects.toThrow(/setup changed after read/);
    await expect(f.read(buildAttachmentUrl(f.ref))).rejects.toMatchObject({ status: 403 });
    // The decrypted snapshot it read is wiped, not left for the GC.
    expect(f.decrypted).toHaveLength(1);
    expect(f.decrypted[0].every((byte) => byte === 0)).toBe(true);
  });

  it('copies local unscanned bytes privately for the OS and removes them during shutdown', async () => {
    const f = await missingSetup();
    const flag = vi.fn();
    let openedFile = '';
    f.openPath.mockImplementation(async (file) => {
      openedFile = file;
      expect(file).not.toBe(f.file);
      expect(await fs.readFile(file, 'utf8')).toBe('%PDF warning-approved local bytes');
      return '';
    });
    await f.preview.openPreview(
      f.ref.emailId,
      f.ref.accountId!,
      f.ref.filename,
      'warned-open',
      flag
    );
    expect(flag).toHaveBeenCalledOnce();
    expect(f.deps.scan).not.toHaveBeenCalled();
    // The decrypted bytes held in memory for the copy are wiped once it is written.
    expect(f.decrypted.at(-1)!.every((byte) => byte === 0)).toBe(true);
    await f.preview.dispose();
    await expect(fs.stat(openedFile)).rejects.toThrow();
    // Changed deliberately (CASA M-7): the cache entry is sealed now, so "the
    // source is left untouched" compares its sealed form, not the plaintext.
    expect(await fs.readFile(f.file)).toEqual(sealForTest('%PDF warning-approved local bytes'));
  });

  it('never launches a local OS copy if its missing-setup authorization changes before opening', async () => {
    const f = await missingSetup();
    let checks = 0;
    f.assertMissing.mockImplementation(async () => {
      if (++checks === 5) throw new Error('setup changed');
    });
    await expect(f.open()).rejects.toThrow(/setup changed/);
    expect(f.openPath).not.toHaveBeenCalled();
    expect((await fs.readdir(f.root)).filter((name) => name.startsWith('preview-'))).toEqual([]);
  });
});

// Breaks: Open in app launches unscanned/refetched bytes, exposes failed staging, or leaves clean copies forever.
describe('protected OS attachment previews', () => {
  it('opens only a private copy of exact scanned bytes and removes it on shutdown', async () => {
    const f = await fixture();
    let file = '';
    f.openPath.mockImplementation(async (value) => {
      file = value;
      expect(await fs.readFile(value, 'utf8')).toBe('%PDF exact synthetic clean document');
      return '';
    });
    await f.open('os-preview');
    expect(file.startsWith(f.root + path.sep)).toBe(true);
    expect(f.resolveLegacy).not.toHaveBeenCalled();
    expect(f.receipts[0].dispose).toHaveBeenCalledOnce();
    if (process.platform !== 'win32') expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    await f.preview.dispose();
    await expect(fs.access(file)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('cleans expired private files and old interrupted-process entries without removing unrelated files', async () => {
    const f = await fixture({ ttlMs: 10 });
    await fs.mkdir(path.join(f.root, 'preview-stale'));
    await fs.writeFile(path.join(f.root, 'unrelated.txt'), 'keep');
    await f.open();
    await vi.waitFor(async () => expect(await fs.readdir(f.root)).toEqual(['unrelated.txt']));
  });

  it.each(['threat', 'incomplete', 'scanner unavailable'])(
    'does not write or launch after %s',
    async (reason) => {
      const f = await fixture();
      vi.mocked(f.deps.scan).mockRejectedValue(new Error(reason));
      await expect(f.open()).rejects.toThrow(reason);
      expect(f.openPath).not.toHaveBeenCalled();
      expect(await fs.readdir(f.root)).toEqual([]);
    }
  );

  it('cleans a failed launch and a receipt revoked while the OS is opening it', async () => {
    const f = await fixture();
    f.openPath.mockResolvedValueOnce('No application registered');
    await expect(f.open()).rejects.toThrow('No application registered');
    expect(await fs.readdir(f.root)).toEqual([]);
    f.openPath.mockImplementation(async () => {
      f.receipts.at(-1)!.assertCurrent.mockRejectedValue(new Error('consent revoked'));
      return '';
    });
    await expect(f.open()).rejects.toThrow('consent revoked');
    expect(await fs.readdir(f.root)).toEqual([]);
  });

  it('cleans cancellation during a pending OS launch and a later retry succeeds', async () => {
    const f = await fixture();
    f.openPath.mockImplementationOnce(async () => {
      f.operations.cancel('cancel-os');
      return '';
    });
    await expect(f.open('cancel-os')).rejects.toThrow('Download cancelled.');
    expect(await fs.readdir(f.root)).toEqual([]);
    await f.open('retry-os');
    expect(f.openPath).toHaveBeenCalledTimes(2);
  });

  // Changed deliberately (CASA M-7): every Open now leaves a private copy (the
  // sealed cache has no plaintext file to hand over), so opened copies have
  // their own, wider cap of 16 (was the previews' 4). In-memory viewer leases
  // keep their cap of 4, checked at the end.
  it('bounds completed private copies and reserves capacity during parallel launches', async () => {
    const f = await fixture();
    // Sequential: the operation layer separately allows only 4 in flight.
    for (let i = 0; i < 15; i++) await f.open();
    let finish!: () => void;
    f.openPath.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = () => resolve('');
        })
    );
    const pending = f.open();
    await vi.waitFor(() => expect(f.openPath).toHaveBeenCalledTimes(16));
    await expect(f.open()).rejects.toMatchObject({ status: 429, message: expect.stringMatching(/Too many/) });
    finish();
    await pending;
    await expect(f.open()).rejects.toMatchObject({ status: 429 });
    expect(await fs.readdir(f.root)).toHaveLength(16);
    expect(f.openPath).toHaveBeenCalledTimes(16);
    // The in-memory viewer bound is separate and still 4.
    await Promise.all(Array.from({ length: 4 }, () => f.prepare()));
    await expect(f.prepare()).rejects.toThrow(/Too many attachment previews. Close a viewer/);
  });

  // Changed deliberately (CASA M-7): without AV, Open used to hand the OS the
  // cache path itself. The cache is sealed now, so the OS gets a private 0600
  // copy of the DECRYPTED bytes — never the cache path — removed on shutdown.
  it('preserves no-AV OS opening through a private decrypted copy and rejects unsafe types before touching mail', async () => {
    const f = await fixture({ enabled: false });
    let copy = '';
    f.openPath.mockImplementation(async (file) => {
      copy = file;
      expect(await fs.readFile(file, 'utf8')).toBe(CACHED_PLAINTEXT);
      return '';
    });
    await f.open();
    expect(f.openPath).toHaveBeenCalledOnce();
    expect(f.openPath).not.toHaveBeenCalledWith(f.cacheFile);
    expect(copy.startsWith(f.root + path.sep)).toBe(true);
    if (process.platform !== 'win32') expect((await fs.stat(copy)).mode & 0o777).toBe(0o600);
    // With scanning off the file is the user's to open whatever its size: unbounded.
    expect(f.readLegacy).toHaveBeenCalledWith(f.cacheFile, expect.any(AbortSignal), undefined);
    expect(f.decrypted.at(-1)!.every((byte) => byte === 0)).toBe(true);
    expect(f.deps.scan).not.toHaveBeenCalled();
    await expect(
      f.preview.openPreview('message', 'account', 'invoice.pdf.exe')
    ).rejects.toMatchObject({ status: 403 });
    expect(f.resolveLegacy).toHaveBeenCalledOnce();
    await f.preview.dispose();
    await expect(fs.access(copy)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  // Breaks: a damaged/foreign cache entry (or one the reader refuses) is still
  // handed to an app, or leaves a half-made private copy behind.
  it('opens nothing without AV when the cache entry cannot be decrypted', async () => {
    const f = await fixture({ enabled: false });
    await fs.writeFile(f.cacheFile, 'not sealed: plaintext from an older build');
    await expect(f.open()).rejects.toMatchObject({
      status: 500,
      message: 'The attachment could not be read. Try again.',
    });
    expect(f.openPath).not.toHaveBeenCalled();
    expect(await fs.readdir(f.root)).toEqual([]);
  });

  // Breaks: AV switched on while an unscanned cache entry was being decrypted
  // still launches it, or leaves its plaintext in memory or on disk.
  it('opens nothing without AV when scanning is enabled during the cache read', async () => {
    const f = await fixture({ enabled: false });
    const original = f.readLegacy.getMockImplementation()!;
    f.readLegacy.mockImplementationOnce(async (file, signal) => {
      const plaintext = await original(file, signal);
      f.scanners([{ id: 'clamav-scan', enabled: true, active: true, granted: true, scanner: true }]);
      return plaintext;
    });
    await expect(f.open()).rejects.toThrow(/Retry the download/);
    expect(f.openPath).not.toHaveBeenCalled();
    expect(f.decrypted[0].every((byte) => byte === 0)).toBe(true);
    expect(await fs.readdir(f.root)).toEqual([]);
  });

  // Breaks: a no-AV launch the OS refuses leaves the decrypted copy on disk
  // (it would never be tracked for removal).
  it('removes the decrypted copy when the OS cannot open it without AV', async () => {
    const f = await fixture({ enabled: false });
    f.openPath.mockResolvedValueOnce('No application registered');
    await expect(f.open()).rejects.toThrow('No application registered');
    expect(await fs.readdir(f.root)).toEqual([]);
    expect(f.decrypted[0].every((byte) => byte === 0)).toBe(true);
  });

  it('retries a failed private-root initialization without opening partial bytes', async () => {
    const f = await fixture();
    await fs.rm(f.root, { recursive: true });
    await fs.writeFile(f.root, 'temporarily unavailable');
    await expect(f.open()).rejects.toThrow();
    expect(f.openPath).not.toHaveBeenCalled();
    await fs.rm(f.root);
    await fs.mkdir(f.root);
    await f.open();
    expect(f.openPath).toHaveBeenCalledOnce();
  });

  // Breaks: Open's cleanup and slot release are skipped on the no-AV path, so a
  // copy outlives its TTL or a slot leaks per open until the cap locks Open out.
  it('removes a no-AV private copy after its TTL and frees its slot', async () => {
    const f = await fixture({ enabled: false, ttlMs: 10 });
    await f.open();
    await vi.waitFor(async () => expect(await fs.readdir(f.root)).toEqual([]));
    for (let i = 0; i < 16; i++) await f.open();
    expect(f.openPath).toHaveBeenCalledTimes(17);
  });

  it('exposes the initialized singleton and disposes its predecessor', async () => {
    const f = await fixture();
    const next = await fixture();
    const url = await f.prepare();
    setAttachmentPreviewProtection(f.preview);
    expect(getAttachmentPreviewProtection()).toBe(f.preview);
    setAttachmentPreviewProtection(next.preview);
    expect(getAttachmentPreviewProtection()).toBe(next.preview);
    await expect(f.read(url)).rejects.toMatchObject({ status: 403 });
  });
});

// Breaks: the calendar invite (bytes that are no attachment of their own) is
// opened from a file left in the attachment cache, kept forever, readable by
// others, or launched after its request was cancelled.
describe('openTemporaryCopy', () => {
  const INVITE = 'BEGIN:VCALENDAR\r\nSUMMARY:Synthetic planning\r\nEND:VCALENDAR\r\n';

  function operation(overrides: { signal?: AbortSignal; assertCurrent?: () => Promise<void> } = {}) {
    return {
      signal: overrides.signal ?? new AbortController().signal,
      assertCurrent: vi.fn(overrides.assertCurrent ?? (async () => {})),
    };
  }

  // Breaks: the invite is opened from somewhere other than a fresh private copy.
  it('writes a private 0600 copy of the bytes, opens it, and removes it on shutdown', async () => {
    const f = await fixture();
    let opened = '';
    f.openPath.mockImplementation(async (file) => {
      opened = file;
      expect(await fs.readFile(file, 'utf8')).toBe(INVITE);
      return '';
    });
    const op = operation();
    await expect(
      f.preview.openTemporaryCopy('calendar-event.ics', Buffer.from(INVITE), op)
    ).resolves.toBe('');
    expect(path.dirname(path.dirname(opened))).toBe(f.root);
    expect(path.basename(path.dirname(opened))).toMatch(/^preview-/);
    expect(path.basename(opened)).toBe('calendar-event.ics');
    if (process.platform !== 'win32') expect((await fs.stat(opened)).mode & 0o777).toBe(0o600);
    // Checked before the write, after it, and after the launch.
    expect(op.assertCurrent).toHaveBeenCalledTimes(3);
    await f.preview.dispose();
    await expect(fs.access(opened)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readdir(f.root)).toEqual([]);
  });

  // Breaks: the invite copy outlives the TTL the other opened copies get.
  it('removes the copy after the TTL', async () => {
    const f = await fixture({ ttlMs: 10 });
    await f.preview.openTemporaryCopy('calendar-event.ics', Buffer.from(INVITE), operation());
    expect(f.openPath).toHaveBeenCalledOnce();
    await vi.waitFor(async () => expect(await fs.readdir(f.root)).toEqual([]));
  });

  // Breaks: "no calendar app" is reported as success (the caller shows its
  // no-handler hint from this text), or the refused copy stays on disk.
  it('returns the openPath error text and leaves no file when the OS cannot open it', async () => {
    const f = await fixture();
    f.openPath.mockResolvedValueOnce('No application knows how to open .ics');
    await expect(
      f.preview.openTemporaryCopy('calendar-event.ics', Buffer.from(INVITE), operation())
    ).resolves.toBe('No application knows how to open .ics');
    expect(await fs.readdir(f.root)).toEqual([]);
    // A refused launch holds no slot: the next one still opens.
    await expect(
      f.preview.openTemporaryCopy('calendar-event.ics', Buffer.from(INVITE), operation())
    ).resolves.toBe('');
  });

  // Breaks: a request that went stale after the copy was written (account
  // removed, consent revoked) still launches it, or leaves the written copy.
  it('launches nothing and removes the written copy when the request is no longer current', async () => {
    const f = await fixture();
    let checks = 0;
    const op = operation({
      assertCurrent: async () => {
        if (++checks === 2) throw new Error('request no longer current');
      },
    });
    await expect(
      f.preview.openTemporaryCopy('calendar-event.ics', Buffer.from(INVITE), op)
    ).rejects.toThrow('request no longer current');
    expect(f.openPath).not.toHaveBeenCalled();
    expect(await fs.readdir(f.root)).toEqual([]);
  });

  // Breaks: cancelling while the OS is still launching leaves the copy behind
  // with nothing tracking it for removal.
  it('removes the copy when the request is cancelled during the launch', async () => {
    const f = await fixture();
    const abort = new AbortController();
    f.openPath.mockImplementationOnce(() => {
      abort.abort(new Error('Download cancelled.'));
      return new Promise<string>(() => {});
    });
    await expect(
      f.preview.openTemporaryCopy('calendar-event.ics', Buffer.from(INVITE), operation({ signal: abort.signal }))
    ).rejects.toThrow('Download cancelled.');
    expect(await fs.readdir(f.root)).toEqual([]);
  });

  // Breaks: a hostile name escapes the private folder.
  it('keeps a traversal filename inside its private folder', async () => {
    const f = await fixture();
    await f.preview.openTemporaryCopy('../../escape.ics', Buffer.from(INVITE), operation());
    const opened = f.openPath.mock.calls[0][0];
    expect(path.dirname(path.dirname(opened))).toBe(f.root);
    expect(path.relative(f.root, opened).startsWith('..')).toBe(false);
    expect(await fs.readdir(path.dirname(f.root))).not.toContain('escape.ics');
  });

  // Breaks: invites get their own unbounded budget beside attachment opens, or
  // keep opening after shutdown.
  it('shares the open-copy cap with attachment opens and refuses after shutdown', async () => {
    const f = await fixture();
    for (let i = 0; i < 16; i++)
      await f.preview.openTemporaryCopy('calendar-event.ics', Buffer.from(INVITE), operation());
    await expect(
      f.preview.openTemporaryCopy('calendar-event.ics', Buffer.from(INVITE), operation())
    ).rejects.toMatchObject({ status: 429 });
    await expect(f.open()).rejects.toMatchObject({ status: 429 });
    expect(f.openPath).toHaveBeenCalledTimes(16);
    await f.preview.dispose();
    expect(await fs.readdir(f.root)).toEqual([]);
    await expect(
      f.preview.openTemporaryCopy('calendar-event.ics', Buffer.from(INVITE), operation())
    ).rejects.toMatchObject({ status: 403 });
    expect(f.openPath).toHaveBeenCalledTimes(16);
  });
});
