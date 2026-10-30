import { describe, expect, it, vi } from 'vitest';

import { SyncEngine } from '../../../src/imap/sync-engine';
import type { BodyStructure } from '../../../src/types/imap';

const structure = (): BodyStructure => ({ type: 'multipart', subtype: 'mixed', parts: [
  { type: 'text', subtype: 'plain', part: '1' },
  { type: 'application', subtype: 'octet-stream', part: '2', encoding: '7bit', size: 9, disposition: { type: 'attachment', params: { filename: 'same.txt' } } },
  { type: 'application', subtype: 'octet-stream', part: '3', encoding: '7bit', size: 10, disposition: { type: 'attachment', params: { filename: 'same.txt' } } },
] } as BodyStructure);

function fixture() {
  const textHeaders = () => Buffer.from('Content-Type: text/plain\r\n\r\n');
  const attachmentHeaders = (encoding = '7bit') => Buffer.from(`Content-Type: application/octet-stream\r\nContent-Disposition: attachment; filename="same.txt"\r\nContent-Transfer-Encoding: ${encoding}\r\n\r\n`);
  const contentDownload = (content: Buffer, encoding = '7bit') => async (_uid: number, part: string) => part.endsWith('.MIME')
    ? part === '1.MIME' ? textHeaders() : attachmentHeaders(encoding) : content;
  const client = { selectFolder: vi.fn(async () => undefined), fetchMessagesByUID: vi.fn(async () => [{ bodyStructure: structure() }]),
    downloadPart: vi.fn(async (_uid: number, part: string, _options?: unknown) => part.endsWith('.MIME')
      ? part === '1.MIME' ? textHeaders() : attachmentHeaders() : Buffer.from('synthetic')), downloadPartRaw: vi.fn(), fetchSource: vi.fn() };
  const engine = new SyncEngine({} as any);
  vi.spyOn(engine, 'isConnected').mockReturnValue(true); vi.spyOn(engine, 'isSyncing').mockReturnValue(false);
  vi.spyOn(engine as any, 'reselectMonitoredFolder').mockResolvedValue(undefined);
  (engine as any).connectionPool = null; (engine as any).connectionManager = { client };
  return { engine, client, contentDownload };
}

describe('exact MIME attachment antivirus source', () => {
  it('discovers distinct exact parts when filenames are identical, without downloading content', async () => {
    const { engine, client } = fixture();
    expect(await engine.listAttachmentScanParts('INBOX', 42)).toEqual([
      { partId: '2', filename: 'same.txt', byteLength: null }, { partId: '3', filename: 'same.txt', byteLength: null },
    ]);
    expect(client.fetchMessagesByUID).toHaveBeenCalledWith([42], { discoverCategories: false, fetchHeaders: false, fetchBody: false, fetchBodyStructure: true });
    expect(client.downloadPart.mock.calls.every(call => call[1].endsWith('.MIME'))).toBe(true);
    expect(client.fetchSource).not.toHaveBeenCalled();
  });

  it('downloads the selected duplicate filename by exact part number with the byte cap', async () => {
    const { engine, client } = fixture();
    expect((await engine.fetchAttachmentScanPart('INBOX', 42, '3', 'same.txt', 128)).toString()).toBe('synthetic');
    expect(client.downloadPart).toHaveBeenCalledWith(42, '3', { maxBytes: 128, signal: undefined, timeoutMs: 90_000 });
    expect(client.downloadPartRaw).not.toHaveBeenCalled();
  });

  it('recovers the reported 107 KB PDF from stripped metadata and revalidates its exact part before reading', async () => {
    const { engine, client } = fixture();
    const filename = 'GeM-Bidding-10000604 (1).pdf';
    const bodyStructure = structure(); bodyStructure.parts = [bodyStructure.parts![1]];
    bodyStructure.parts[0].disposition = { type: 'attachment', params: {} };
    bodyStructure.parts[0].size = 107 * 1024;
    const content = Buffer.alloc(107 * 1024, 65); content.write('%PDF-1.7');
    client.fetchMessagesByUID.mockResolvedValue([{ bodyStructure }]);
    client.downloadPart.mockImplementation(async (_uid, part) => part === '2.MIME'
      ? Buffer.from(`Content-Type: application/pdf\r\nContent-Disposition: attachment; filename="${filename}"\r\nContent-Transfer-Encoding: 7bit\r\n\r\n`)
      : Buffer.from(content));
    expect(await engine.listAttachmentScanParts('INBOX', 42)).toEqual([{ partId: '2', filename, byteLength: null }]);
    expect(client.downloadPart.mock.calls.map(call => call[1])).toEqual(['2.MIME']);
    expect(await engine.fetchAttachmentScanPart('INBOX', 42, '2', filename, 128 * 1024)).toEqual(content);
    expect(client.downloadPart.mock.calls.map(call => call[1])).toEqual(['2.MIME', '2.MIME', '2']);
    expect(client.fetchSource).not.toHaveBeenCalled(); expect(client.downloadPartRaw).not.toHaveBeenCalled();
    expect(client.fetchMessagesByUID.mock.calls.every(call => call[1].fetchBody === false)).toBe(true);
  });

  it('rejects MIME filename changes on the next read even when BODYSTRUCTURE keeps its old name', async () => {
    const { engine, client } = fixture(); const bodyStructure = structure(); bodyStructure.parts = [bodyStructure.parts![1]];
    bodyStructure.parts[0].disposition = { type: 'attachment', params: { filename: 'before.pdf' } };
    client.fetchMessagesByUID.mockResolvedValue([{ bodyStructure }]);
    client.downloadPart.mockImplementation(async () => Buffer.from('Content-Disposition: attachment; filename="before.pdf"\r\n\r\n'));
    expect((await engine.listAttachmentScanParts('INBOX', 42))[0].filename).toBe('before.pdf');
    client.downloadPart.mockImplementation(async () => Buffer.from('Content-Disposition: attachment; filename="after.pdf"\r\n\r\n'));
    await expect(engine.fetchAttachmentScanPart('INBOX', 42, '2', 'before.pdf', 128)).rejects.toThrow(/changed/);
    expect(client.downloadPart.mock.calls.every(call => call[1] === '2.MIME')).toBe(true);
  });

  it('lists and revalidates a forwarded PDF when BODYSTRUCTURE lies about its filename', async () => {
    const { engine, client } = fixture();
    const filename = '51_Letter_to_MSP_Akamai_Services_dt-27.10.2026.pdf';
    const bodyStructure = structure(); bodyStructure.parts = [bodyStructure.parts![1]];
    bodyStructure.parts[0].disposition = { type: 'attachment', params: { filename: 'SIZE', 'creation-date': 'MODIFICATION-DATE' } };
    bodyStructure.parts[0].encoding = 'base64'; bodyStructure.parts[0].size = 457554;
    const content = Buffer.alloc(333942, 65); content.write('%PDF-1.7');
    client.fetchMessagesByUID.mockResolvedValue([{ bodyStructure }]);
    client.downloadPart.mockImplementation(async (_uid, part) => part === '2.MIME'
      ? Buffer.from(`Content-Type: application/pdf; name="${filename}"\r\nContent-Disposition: attachment; filename="${filename}"; size=334364\r\nContent-Transfer-Encoding: base64\r\n\r\n`)
      : Buffer.from(content));
    expect(await engine.listAttachmentScanParts('INBOX', 42)).toEqual([{ partId: '2', filename, byteLength: null }]);
    const downloaded = await engine.fetchAttachmentScanPart('INBOX', 42, '2', filename, 512 * 1024);
    expect(downloaded.equals(content)).toBe(true);
    expect(client.downloadPart.mock.calls.map(call => call[1])).toEqual(['2.MIME', '2.MIME', '2']);
    expect(client.fetchSource).not.toHaveBeenCalled(); expect(client.downloadPartRaw).not.toHaveBeenCalled();
  });

  it('validates even complete named BODYSTRUCTURE attachments against their MIME headers', async () => {
    const { engine, client } = fixture(); const bodyStructure = structure(); bodyStructure.parts = bodyStructure.parts!.slice(1);
    client.fetchMessagesByUID.mockResolvedValue([{ bodyStructure }]);
    expect(await engine.listAttachmentScanParts('INBOX', 42)).toHaveLength(2);
    expect(client.downloadPart.mock.calls.map(call => call[1])).toEqual(['2.MIME', '3.MIME']);
    expect(client.fetchSource).not.toHaveBeenCalled();
  });

  it('fails when a MIME part changes name instead of silently scanning another attachment', async () => {
    const { engine, client } = fixture();
    await expect(engine.fetchAttachmentScanPart('INBOX', 42, '3', 'changed.txt', 128)).rejects.toThrow(/changed/);
    expect(client.downloadPart.mock.calls.every(call => call[1].endsWith('.MIME'))).toBe(true);
  });

  it('refuses a collapsed misdeclared base64 decode, clears it, and never fetches the whole mail', async () => {
    const { engine, client, contentDownload } = fixture(); const bodyStructure = structure(); bodyStructure.parts![2].encoding = 'base64'; bodyStructure.parts![2].size = 400;
    client.fetchMessagesByUID.mockResolvedValue([{ bodyStructure }]); const bad = Buffer.alloc(7, 65); client.downloadPart.mockImplementation(contentDownload(bad, 'base64'));
    await expect(engine.fetchAttachmentScanPart('INBOX', 42, '3', 'same.txt', 128)).rejects.toThrow(/encoding/);
    expect(bad.every(byte => byte === 0)).toBe(true); expect(client.downloadPartRaw).not.toHaveBeenCalled(); expect(client.fetchSource).not.toHaveBeenCalled();
  });

  it.each(['BASE64 (mail gateway)', 'base64; x=gateway'])('keeps the short-base64 refusal when MIME transfer encoding is %s', async (encoding) => {
    const { engine, client, contentDownload } = fixture();
    const bodyStructure = structure(); bodyStructure.parts![2].encoding = 'base64'; bodyStructure.parts![2].size = 400;
    client.fetchMessagesByUID.mockResolvedValue([{ bodyStructure }]);
    const bad = Buffer.alloc(7, 65);
    client.downloadPart.mockImplementation(contentDownload(bad, encoding));
    await expect(engine.fetchAttachmentScanPart('INBOX', 42, '3', 'same.txt', 128)).rejects.toThrow(/encoding/);
    expect(bad.every(byte => byte === 0)).toBe(true);
    expect(client.downloadPartRaw).not.toHaveBeenCalled(); expect(client.fetchSource).not.toHaveBeenCalled();
  });

  // The libbase64 1.3.1 regression on this path: text mislabelled base64 now
  // decodes to just over half its size (34 of 64), past the old "under half"
  // refusal. Breaks if that slides back: the scan passes 34 junk bytes while the
  // open path serves the raw text it never inspected.
  it('refuses the just-over-half decode libbase64 1.3.1 makes of mislabelled text', async () => {
    const { engine, client, contentDownload } = fixture(); const bodyStructure = structure(); bodyStructure.parts![2].encoding = 'base64'; bodyStructure.parts![2].size = 64;
    client.fetchMessagesByUID.mockResolvedValue([{ bodyStructure }]); const bad = Buffer.alloc(34, 0xa6); client.downloadPart.mockImplementation(contentDownload(bad, 'base64'));
    await expect(engine.fetchAttachmentScanPart('INBOX', 42, '3', 'same.txt', 128)).rejects.toThrow(/encoding/);
    expect(bad.every(byte => byte === 0)).toBe(true); expect(client.downloadPartRaw).not.toHaveBeenCalled();
  });

  // Breaks if padding on a tiny file reads as a short decode: a 1-byte file is
  // "AQ==" (25%) and a 10-byte one 16 characters (62%), and both would be
  // refused as uninspectable — the old "under half" test refused the first.
  it('scans a tiny genuine base64 part instead of refusing it', async () => {
    const { engine, client, contentDownload } = fixture(); const bodyStructure = structure(); bodyStructure.parts![2].encoding = 'base64';
    for (const [declared, file] of [[4, Buffer.from('A')], [16, Buffer.from('0123456789')]] as const) {
      bodyStructure.parts![2].size = declared;
      client.fetchMessagesByUID.mockResolvedValue([{ bodyStructure }]); client.downloadPart.mockImplementation(contentDownload(Buffer.from(file), 'base64'));
      expect(await engine.fetchAttachmentScanPart('INBOX', 42, '3', 'same.txt', 128)).toEqual(file);
    }
  });

  it('refuses missing, zero-byte, oversized, or invalid part selection', async () => {
    const { engine, client, contentDownload } = fixture();
    await expect(engine.fetchAttachmentScanPart('INBOX', 42, '3/path', 'same.txt', 128)).rejects.toThrow(/cannot be scanned/);
    await expect(engine.fetchAttachmentScanPart('INBOX', 42, '7', 'same.txt', 128)).rejects.toThrow(/unavailable/);
    client.downloadPart.mockImplementation(contentDownload(Buffer.alloc(0))); await expect(engine.fetchAttachmentScanPart('INBOX', 42, '3', 'same.txt', 128)).rejects.toThrow(/empty/);
    client.downloadPart.mockImplementation(contentDownload(Buffer.alloc(129))); await expect(engine.fetchAttachmentScanPart('INBOX', 42, '3', 'same.txt', 128)).rejects.toThrow(/exceeds/);
  });

  it('does not compete with a syncing primary connection or use an offline socket', async () => {
    const { engine, client } = fixture(); vi.mocked(engine.isSyncing).mockReturnValue(true);
    await expect(engine.listAttachmentScanParts('INBOX', 42)).rejects.toThrow(/syncing/);
    vi.mocked(engine.isConnected).mockReturnValue(false);
    await expect(engine.fetchAttachmentScanPart('INBOX', 42, '3', 'same.txt', 128)).rejects.toThrow(/cannot be scanned/);
    expect(client.fetchMessagesByUID).not.toHaveBeenCalled();
  });

  it('does not fetch or upload a part after cancellation', async () => {
    const { engine, client } = fixture(); const controller = new AbortController(); controller.abort();
    await expect(engine.fetchAttachmentScanPart('INBOX', 42, '3', 'same.txt', 128, controller.signal)).rejects.toThrow(/cancelled/);
    await expect(engine.listAttachmentScanParts('INBOX', 42, controller.signal)).rejects.toThrow(/cancelled/);
    expect(client.downloadPart).not.toHaveBeenCalled(); expect(client.fetchMessagesByUID).not.toHaveBeenCalled();
  });
});
