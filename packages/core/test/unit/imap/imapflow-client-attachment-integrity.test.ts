import { createHash } from 'node:crypto';

import { ImapFlow } from 'imapflow';
import { describe, expect, it, vi } from 'vitest';

import { ImapFlowClient } from '../../../src/imap/imapflow-client';

// Exercise the installed ImapFlow decoder/downloader, not a replacement MIME
// implementation. The fake only supplies responses at the server boundary.
function server(file: Buffer, ignoreOffsets: boolean) {
  const encoded = Buffer.from(file.toString('base64').match(/.{1,76}/g)!.join('\r\n'));
  const messageSize = encoded.length + 512;
  const windows: Array<{ start: number; maxLength: number }> = [];
  const mime = Buffer.from('Content-Type: application/pdf\r\nContent-Disposition: attachment; filename="synthetic.pdf"\r\nContent-Transfer-Encoding: base64\r\n\r\n');
  type Window = { start: number; maxLength: number };
  const transport = {
    usable: true, mailbox: { path: 'INBOX' }, id: 'synthetic-only', _openDownloads: 0,
    autoidle: vi.fn(), log: { warn: vi.fn(), error: vi.fn() },
    download: vi.fn(),
    fetchOne: vi.fn(async (_uid: string, query: { bodyParts?: Array<string | Window> }) => {
      const window = query.bodyParts?.find((part): part is Window => typeof part === 'object');
      if (!window) return { uid: 42, size: messageSize };
      windows.push({ start: window.start, maxLength: window.maxLength });
      // A broken server restarts at zero for later windows, even when its
      // response length is plausible. This restarts a PDF at decoded byte
      // 47,892 after a normal 64 KiB encoded window.
      const start = ignoreOffsets ? 0 : window.start;
      const length = Math.max(0, Math.min(window.maxLength, encoded.length - window.start));
      return { uid: 42, size: messageSize, bodyParts: new Map([
        ['2', encoded.subarray(start, start + length)], ['2.mime', mime],
      ]) };
    }),
  };
  transport.download.mockImplementation((...args: Parameters<ImapFlow['download']>) => ImapFlow.prototype.download.apply(transport as unknown as ImapFlow, args));
  const client = new ImapFlowClient();
  const internals = client as unknown as { connectionState: string; client: typeof transport };
  internals.connectionState = 'authenticated'; internals.client = transport;
  return { client, transport, windows, messageSize };
}

function syntheticPdf(): Buffer {
  // Deterministic binary payload, with an actual PDF header/trailer. No user
  // content is needed to reproduce the boundary corruption.
  const body = Buffer.alloc(129012 - 15);
  for (let i = 0; i < body.length; i++) body[i] = (i * 17 + (i >>> 8)) & 255;
  return Buffer.concat([Buffer.from('%PDF-1.4\n'), body, Buffer.from('%%EOF\n')]);
}

const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

describe('attachment MIME download integrity', () => {
  it('reproduces silent chunk corruption with the library default and a server ignoring offsets', async () => {
    const original = syntheticPdf(); const { transport, windows } = server(original, true);
    const download = await transport.download('42', '2', { uid: true });
    const chunks: Buffer[] = []; for await (const chunk of download.content) chunks.push(chunk);
    const broken = Buffer.concat(chunks);
    expect(windows.map(window => window.start)).toEqual([0, 65536, 131072]);
    expect(broken.indexOf('%PDF-', 1)).toBe(47892);
    expect(broken.includes('%%EOF')).toBe(false);
    expect(digest(broken)).not.toBe(digest(original));
  });

  it.each([false, true])('preserves complete PDF bytes with ignoreOffsets=%s using the shared attachment path', async ignoreOffsets => {
    const original = syntheticPdf(); const { client, windows, messageSize, transport } = server(original, ignoreOffsets);
    const result = await client.downloadPart(42, '2');
    expect(result?.length).toBe(original.length);
    expect(digest(result!)).toBe(digest(original));
    expect(windows).toEqual([{ start: 0, maxLength: messageSize + 1 }]);
    expect(transport.fetchOne).toHaveBeenNthCalledWith(1, '42', { uid: true, size: true }, { uid: true });
  });

  it('preserves the same bytes through the bounded scanner path', async () => {
    const original = syntheticPdf(); const { client, windows } = server(original, true);
    const result = await client.downloadPart(42, '2', { maxBytes: original.length, timeoutMs: 1000 });
    expect(digest(result!)).toBe(digest(original));
    expect(windows).toHaveLength(1); expect(windows[0].start).toBe(0);
  });

  it('rejects actual decoded bytes over the scanner cap instead of returning a truncated file', async () => {
    const original = syntheticPdf(); const { client, windows } = server(original, true);
    await expect(client.downloadPart(42, '2', { maxBytes: original.length - 1 })).rejects.toThrow(/byte limit/);
    expect(windows).toHaveLength(1); expect(windows[0].start).toBe(0);
  });
});
