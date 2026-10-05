import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { buildAttachmentUrl, parseAttachmentUrl } from '@sarvinbox/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

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
  const resolveLegacy = vi.fn(async () => '/synthetic/legacy.pdf');
  const openPath = vi.fn(async (_file: string) => '');
  const preview = new AttachmentPreviewProtection({
    operations,
    resolveLegacy,
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
    deps,
    operations,
    resolveLegacy,
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
    const file = path.join(f.root, 'local.pdf');
    await fs.writeFile(file, '%PDF warning-approved local bytes');
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
    await fs.writeFile(f.file, 'cache changed after warning');
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
    await f.preview.dispose();
    await expect(fs.stat(openedFile)).rejects.toThrow();
    expect(await fs.readFile(f.file, 'utf8')).toBe('%PDF warning-approved local bytes');
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

  it('bounds completed private copies and reserves capacity during parallel launches', async () => {
    const f = await fixture();
    await Promise.all(Array.from({ length: 3 }, () => f.open()));
    let finish!: () => void;
    f.openPath.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = () => resolve('');
        })
    );
    const pending = f.open();
    await vi.waitFor(() => expect(f.openPath).toHaveBeenCalledTimes(4));
    await expect(f.open()).rejects.toThrow(/Too many/);
    finish();
    await pending;
    await expect(f.open()).rejects.toThrow(/Too many/);
    expect(await fs.readdir(f.root)).toHaveLength(4);
  });

  it('preserves no-AV OS opening and rejects unsafe types before touching mail', async () => {
    const f = await fixture({ enabled: false });
    await f.open();
    expect(f.openPath).toHaveBeenCalledWith('/synthetic/legacy.pdf');
    expect(f.deps.scan).not.toHaveBeenCalled();
    await expect(
      f.preview.openPreview('message', 'account', 'invoice.pdf.exe')
    ).rejects.toMatchObject({ status: 403 });
    expect(f.resolveLegacy).toHaveBeenCalledOnce();
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
