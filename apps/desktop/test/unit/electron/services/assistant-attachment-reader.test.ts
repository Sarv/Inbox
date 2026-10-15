import { describe, expect, it, vi } from 'vitest';

import { AssistantAttachmentReader, type AssistantAttachmentReaderDependencies } from '../../../../electron/services/assistant-attachment-reader';
import { AttachmentOperationProtection, type DownloadScanner } from '../../../../electron/services/attachment-download-protection';

const ref = { accountId: 'work-account', emailId: 'sent-quote', filename: 'TCS.pdf' };
const evidence = { status: 'ready' as const, segments: [{ text: 'TCS INR 250000', locator: { kind: 'page' as const, page: 1, label: 'Page 1' } }], truncated: false };

function fixture(options: { scanner?: boolean; ready?: boolean } = {}) {
  const bytes = Buffer.from('private unscanned quote');
  const scanned = Buffer.from('private scanned quote');
  const dispose = vi.fn(() => scanned.fill(0));
  const scan = vi.fn(async (_id: string, _message: string, _account: string, _name: string, _options: { signal: AbortSignal }) => ({ content: scanned, assertCurrent: async () => {}, dispose }));
  const scanners: DownloadScanner[] = options.scanner ? [{ id: 'scanner', enabled: true, active: true, scanner: true, granted: true }] : [];
  const operations = new AttachmentOperationProtection({ scanners: () => scanners, scan, openSetup: vi.fn(), progress: vi.fn() });
  const owned = { read: vi.fn(async () => bytes), assertCurrent: vi.fn(async () => {}), size: 25 };
  const deps: AssistantAttachmentReaderDependencies = {
    resolve: vi.fn(async () => owned),
    operations: () => operations,
    scannerReady: vi.fn(async () => options.ready !== false),
    extract: vi.fn(async () => evidence),
  };
  return { reader: new AssistantAttachmentReader(deps), deps, owned, bytes, scanned, scan, dispose, operations };
}

describe('assistant attachment security gate', () => {
  it('prepares the owning account connection before a configured scanner downloads', async () => {
    const f = fixture({ scanner: true });
    const order: string[] = [];
    Object.assign(f.owned, { prepare: vi.fn(async () => { order.push('connect'); }) });
    f.scan.mockImplementation(async () => {
      order.push('scan');
      return { content: f.scanned, assertCurrent: async () => {}, dispose: f.dispose };
    });
    const activities: string[] = [];
    expect((await f.reader.read(ref, { onProgress: activity => activities.push(activity.message) })).status).toBe('ready');
    expect(order).toEqual(['connect', 'scan']);
    expect(activities).toContain('Extracting text from TCS.pdf');
    expect(f.owned.read).not.toHaveBeenCalled();
  });

  it('reads only the owned declared file and erases its private unscanned snapshot', async () => {
    const f = fixture();
    expect(await f.reader.read(ref)).toEqual({ ref, ...evidence });
    expect(f.deps.resolve).toHaveBeenCalledWith(ref);
    expect(f.owned.assertCurrent).toHaveBeenCalledTimes(3);
    expect(f.deps.extract).toHaveBeenCalledWith(ref.filename, f.bytes, expect.any(AbortSignal));
    expect(f.bytes.every(byte => byte === 0)).toBe(true);
  });

  it('uses the account-bound scanner receipt rather than raw cache or IMAP bytes', async () => {
    const f = fixture({ scanner: true });
    expect((await f.reader.read(ref)).status).toBe('ready');
    expect(f.owned.read).not.toHaveBeenCalled();
    expect(f.scan).toHaveBeenCalledWith('scanner', ref.emailId, ref.accountId, ref.filename, expect.any(Object));
    expect(f.deps.extract).toHaveBeenCalledWith(ref.filename, f.scanned, expect.any(AbortSignal));
    expect(f.dispose).toHaveBeenCalledOnce();
  });

  it('reports missing scanner setup without opening dialogs, fetching or parsing', async () => {
    const f = fixture({ scanner: true, ready: false });
    expect((await f.reader.read(ref)).status).toBe('blocked');
    expect(f.scan).not.toHaveBeenCalled();
    expect(f.owned.read).not.toHaveBeenCalled();
    expect(f.deps.extract).not.toHaveBeenCalled();
  });

  it('fails closed if attachment protection has not been installed', async () => {
    const f = fixture();
    f.deps.operations = () => undefined;
    expect((await f.reader.read(ref)).status).toBe('blocked');
    expect(f.owned.read).not.toHaveBeenCalled();
  });

  it('does not parse a missing attachment or fall back after an unknown account', async () => {
    const f = fixture();
    vi.mocked(f.deps.resolve).mockResolvedValueOnce(null).mockRejectedValueOnce(new Error('internal /Users/private/db-path'));
    expect((await f.reader.read(ref)).status).toBe('missing');
    const unavailable = await f.reader.read(ref);
    expect(unavailable.status).toBe('unavailable');
    expect(JSON.stringify(unavailable)).not.toContain('/Users/');
    expect(f.deps.extract).not.toHaveBeenCalled();
  });

  it('rejects oversized metadata and unsupported files before downloading', async () => {
    const f = fixture();
    f.owned.size = 50 * 1024 * 1024;
    expect((await f.reader.read(ref)).status).toBe('too_large');
    expect((await f.reader.read({ ...ref, filename: 'malware.exe' })).status).toBe('unsupported');
    expect(f.owned.read).not.toHaveBeenCalled();
  });

  it('rejects a source changed while extraction was running', async () => {
    const f = fixture();
    f.deps.extract = vi.fn(async () => {
      f.owned.assertCurrent.mockRejectedValue(new Error('account removed'));
      return evidence;
    });
    expect((await f.reader.read(ref)).status).toBe('blocked');
  });

  it('cancels an antivirus scan even before its consume callback starts', async () => {
    const controller = new AbortController();
    const f = fixture({ scanner: true });
    f.scan.mockImplementation(async (_a, _b, _c, _d, { signal }) => {
      await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }));
      throw new Error('unreachable');
    });
    const result = f.reader.read(ref, { signal: controller.signal });
    await vi.waitFor(() => expect(f.scan).toHaveBeenCalledOnce());
    controller.abort();
    expect((await result).status).toBe('cancelled');
    expect(f.deps.extract).not.toHaveBeenCalled();
  });
});
