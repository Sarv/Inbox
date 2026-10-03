import { describe, expect, it, vi } from 'vitest';

import { SyncEngine } from '../../../src/imap/sync-engine';
import type { BodyStructure } from '../../../src/types/imap';

const structure = (): BodyStructure => ({ type: 'multipart', subtype: 'mixed', parts: [
  { type: 'text', subtype: 'plain', part: '1' },
  { type: 'application', subtype: 'octet-stream', part: '2', encoding: '7bit', size: 9, disposition: { type: 'attachment', params: { filename: 'same.txt' } } },
  { type: 'application', subtype: 'octet-stream', part: '3', encoding: '7bit', size: 10, disposition: { type: 'attachment', params: { filename: 'same.txt' } } },
] } as BodyStructure);

function fixture() {
  const client = { selectFolder: vi.fn(async () => undefined), fetchMessagesByUID: vi.fn(async () => [{ bodyStructure: structure() }]),
    downloadPart: vi.fn(async (_uid: number, _part: string, _options?: unknown) => Buffer.from('synthetic')), downloadPartRaw: vi.fn(), fetchSource: vi.fn() };
  const engine = new SyncEngine({} as any);
  vi.spyOn(engine, 'isConnected').mockReturnValue(true); vi.spyOn(engine, 'isSyncing').mockReturnValue(false);
  vi.spyOn(engine as any, 'reselectMonitoredFolder').mockResolvedValue(undefined);
  (engine as any).connectionPool = null; (engine as any).connectionManager = { client };
  return { engine, client };
}

describe('exact MIME attachment antivirus source', () => {
  it('discovers distinct exact parts when filenames are identical, without downloading content', async () => {
    const { engine, client } = fixture();
    expect(await engine.listAttachmentScanParts('INBOX', 42)).toEqual([
      { partId: '2', filename: 'same.txt', byteLength: null }, { partId: '3', filename: 'same.txt', byteLength: null },
    ]);
    expect(client.fetchMessagesByUID).toHaveBeenCalledWith([42], { fetchHeaders: false, fetchBody: false, fetchBodyStructure: true });
    expect(client.downloadPart).not.toHaveBeenCalled(); expect(client.fetchSource).not.toHaveBeenCalled();
  });

  it('downloads the selected duplicate filename by exact part number with the byte cap', async () => {
    const { engine, client } = fixture();
    expect((await engine.fetchAttachmentScanPart('INBOX', 42, '3', 'same.txt', 128)).toString()).toBe('synthetic');
    expect(client.downloadPart).toHaveBeenCalledWith(42, '3', { maxBytes: 128, signal: undefined, timeoutMs: 90_000 });
    expect(client.downloadPartRaw).not.toHaveBeenCalled();
  });

  it('fails when a MIME part changes name instead of silently scanning another attachment', async () => {
    const { engine, client } = fixture();
    await expect(engine.fetchAttachmentScanPart('INBOX', 42, '3', 'changed.txt', 128)).rejects.toThrow(/changed/);
    expect(client.downloadPart).not.toHaveBeenCalled();
  });

  it('refuses a collapsed misdeclared base64 decode, clears it, and never fetches the whole mail', async () => {
    const { engine, client } = fixture(); const bodyStructure = structure(); bodyStructure.parts![2].encoding = 'base64'; bodyStructure.parts![2].size = 400;
    client.fetchMessagesByUID.mockResolvedValue([{ bodyStructure }]); const bad = Buffer.alloc(7, 65); client.downloadPart.mockResolvedValue(bad);
    await expect(engine.fetchAttachmentScanPart('INBOX', 42, '3', 'same.txt', 128)).rejects.toThrow(/encoding/);
    expect(bad.every(byte => byte === 0)).toBe(true); expect(client.downloadPartRaw).not.toHaveBeenCalled(); expect(client.fetchSource).not.toHaveBeenCalled();
  });

  it('refuses missing, zero-byte, oversized, or invalid part selection', async () => {
    const { engine, client } = fixture();
    await expect(engine.fetchAttachmentScanPart('INBOX', 42, '3/path', 'same.txt', 128)).rejects.toThrow(/cannot be scanned/);
    await expect(engine.fetchAttachmentScanPart('INBOX', 42, '7', 'same.txt', 128)).rejects.toThrow(/unavailable/);
    client.downloadPart.mockResolvedValue(Buffer.alloc(0)); await expect(engine.fetchAttachmentScanPart('INBOX', 42, '3', 'same.txt', 128)).rejects.toThrow(/empty/);
    client.downloadPart.mockResolvedValue(Buffer.alloc(129)); await expect(engine.fetchAttachmentScanPart('INBOX', 42, '3', 'same.txt', 128)).rejects.toThrow(/exceeds/);
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
    expect(client.downloadPart).not.toHaveBeenCalled(); expect(client.fetchMessagesByUID).not.toHaveBeenCalled();
  });
});
