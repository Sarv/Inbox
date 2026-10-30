import { afterEach, describe, expect, it, vi } from 'vitest';

import { attachmentScanNodes } from '../../../src/imap/attachment-scan-metadata';
import type { BodyStructure, IIMAPClient } from '../../../src/types/imap';

function fixture(headers: Record<string, string>) {
  const downloadPart = vi.fn(async (_uid: number, part: string, _options?: { maxBytes?: number }) => Buffer.from(headers[part] || 'Content-Type: text/plain\r\n\r\n'));
  const client = { downloadPart } as unknown as IIMAPClient;
  const structure = { type: 'multipart', subtype: 'mixed', parts: Object.keys(headers).map(part => ({
    type: 'application', subtype: 'pdf', part: part.replace(/\.MIME$/, ''), disposition: { type: 'attachment', params: {} },
  })) } as BodyStructure;
  return { client, downloadPart, structure };
}

afterEach(() => vi.restoreAllMocks());

describe('bounded exact MIME header recovery for scanning', () => {
  it('recovers a PDF name when server BODYSTRUCTURE omits parameter values', async () => {
    const { client, downloadPart, structure } = fixture({ '2.MIME': 'Content-Type: application/pdf; name="GeM-Bidding-10000604 (1).pdf"\r\nContent-Disposition: attachment; filename="GeM-Bidding-10000604 (1).pdf"\r\nContent-Transfer-Encoding: base64\r\n\r\n' });
    const [node] = await attachmentScanNodes(client, 42, structure);
    expect(node.part).toBe('2');
    expect(node.disposition?.params?.filename).toBe('GeM-Bidding-10000604 (1).pdf');
    expect(node.encoding).toBe('base64');
    expect(downloadPart).toHaveBeenCalledWith(42, '2.MIME', { maxBytes: 65536, signal: undefined, timeoutMs: expect.any(Number) });
  });

  it('uses MIME headers when stripped BODYSTRUCTURE values shift SIZE into the filename', async () => {
    const filename = '51_Letter_to_MSP_Akamai_Services_dt-27.10.2026.pdf';
    const { client, structure, downloadPart } = fixture({ '2.MIME': `Content-Type: application/pdf; name="${filename}"\r\nContent-Disposition: attachment; filename="${filename}"; size=334364\r\nContent-Transfer-Encoding: base64\r\n\r\n` });
    structure.parts![0].disposition = { type: 'attachment', params: { filename: 'SIZE', 'creation-date': 'MODIFICATION-DATE' } };
    const [node] = await attachmentScanNodes(client, 42, structure);
    expect(node.part).toBe('2');
    expect(node.disposition?.params?.filename).toBe(filename);
    expect(node.encoding).toBe('base64');
    expect(downloadPart.mock.calls.map(call => call[1])).toEqual(['2.MIME']);
  });

  it('does not mistake a real file named SIZE for malformed server metadata', async () => {
    const { client, structure } = fixture({ '2.MIME': 'Content-Disposition: attachment; filename="SIZE"\r\n\r\n' });
    structure.parts![0].disposition = { type: 'attachment', params: { filename: 'SIZE' } };
    expect((await attachmentScanNodes(client, 42, structure))[0].disposition?.params?.filename).toBe('SIZE');
  });

  it.each([
    ['filename="=?UTF-8?B?UsOpc3Vtw6kucGRm?="', 'Résumé.pdf'],
    ["filename*=UTF-8''R%C3%A9sum%C3%A9.pdf", 'Résumé.pdf'],
    ["filename*0*=UTF-8''R%C3%A9;\r\n filename*1*=sum%C3%A9.pdf", 'Résumé.pdf'],
  ])('decodes header parameters using the UI MIME parser: %s', async (parameter, expected) => {
    const { client, structure } = fixture({ '2.MIME': `Content-Disposition: attachment; ${parameter}\r\n\r\n` });
    expect((await attachmentScanNodes(client, 42, structure))[0].disposition?.params?.filename).toBe(expected);
  });

  it('finds attachment names even when disposition and type parameters were both omitted', async () => {
    const { client, structure } = fixture({ '2.MIME': 'Content-Disposition: attachment; filename="one.pdf"\r\n\r\n' });
    structure.parts![0].disposition = null;
    expect((await attachmentScanNodes(client, 42, structure))[0].disposition?.params?.filename).toBe('one.pdf');
  });

  it('recovers a single-root attachment from HEADER while retaining numeric part 1', async () => {
    const { client, downloadPart } = fixture({ HEADER: 'Content-Type: application/pdf\r\nContent-Disposition: attachment; filename="one.pdf"\r\n\r\n' });
    const structure = { type: 'application', subtype: 'pdf', disposition: { type: 'attachment', params: {} } } as BodyStructure;
    const [node] = await attachmentScanNodes(client, 42, structure);
    expect(node.part).toBe('1'); expect(node.disposition?.params?.filename).toBe('one.pdf');
    expect(downloadPart).toHaveBeenCalledWith(42, 'HEADER', expect.objectContaining({ maxBytes: 65536 }));
  });

  it('preserves the part-specific placeholder for a genuinely unnamed attachment', async () => {
    const { client, structure } = fixture({ '2.MIME': 'Content-Disposition: attachment\r\n\r\n' });
    expect((await attachmentScanNodes(client, 42, structure))[0].disposition?.params?.filename).toBe('Attachment 2');
  });

  it('preserves distinct duplicate filenames so the download preflight can reject ambiguity', async () => {
    const { client, structure } = fixture({
      '2.MIME': 'Content-Disposition: attachment; filename="same.pdf"\r\n\r\n',
      '3.MIME': 'Content-Disposition: attachment; filename="same.pdf"\r\n\r\n',
    });
    expect((await attachmentScanNodes(client, 42, structure)).map(n => [n.part, n.disposition?.params?.filename])).toEqual([['2', 'same.pdf'], ['3', 'same.pdf']]);
  });

  it('cannot hide duplicate MIME filenames behind different fabricated BODYSTRUCTURE names', async () => {
    const { client, structure } = fixture({
      '2.MIME': 'Content-Disposition: attachment; filename="same.pdf"\r\n\r\n',
      '3.MIME': 'Content-Disposition: attachment; filename="same.pdf"\r\n\r\n',
    });
    structure.parts![0].disposition!.params = { filename: 'same.pdf' };
    structure.parts![1].disposition!.params = { filename: 'SIZE' };
    expect((await attachmentScanNodes(client, 42, structure)).map(n => [n.part, n.disposition?.params?.filename])).toEqual([['2', 'same.pdf'], ['3', 'same.pdf']]);
  });

  it('keeps the complete filename privately and discards downloaded header buffers', async () => {
    const name = `${'a'.repeat(600)}.pdf`;
    const raw = Buffer.from(`Content-Disposition: attachment; filename="${name}"\r\n\r\n`);
    const { client, structure, downloadPart } = fixture({ '2.MIME': '' }); downloadPart.mockResolvedValue(raw);
    expect((await attachmentScanNodes(client, 42, structure))[0].disposition?.params?.filename).toBe(name);
    expect(raw.every(byte => byte === 0)).toBe(true);
  });

  it.each([null, Buffer.alloc(0), Buffer.from('Content-Disposition: attachment; filename="truncated'), Buffer.alloc(65537, 65)])('rejects missing, truncated, or oversized headers without a partial filename', async raw => {
    const { client, structure, downloadPart } = fixture({ '2.MIME': '' }); downloadPart.mockResolvedValue(raw as Buffer);
    await expect(attachmentScanNodes(client, 42, structure)).rejects.toThrow(/incomplete|exceed/);
    if (raw) expect(raw.every(byte => byte === 0)).toBe(true);
  });

  it('caps the total recovery byte budget and never reads another header after exhausting it', async () => {
    const { client, structure, downloadPart } = fixture(Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`${i + 1}.MIME`, ''])));
    downloadPart.mockImplementation(async () => Buffer.from(`X-Pad: ${'x'.repeat(65524)}\r\n\r\n`));
    await expect(attachmentScanNodes(client, 42, structure)).rejects.toThrow(/exceed/);
    expect(downloadPart).toHaveBeenCalledTimes(33);
    expect((downloadPart.mock.calls[32][2] as { maxBytes: number }).maxBytes).toBeLessThan(65536);
  });

  it('caps the part count and traversal before downloading anything', async () => {
    const { client, downloadPart, structure } = fixture({});
    structure.parts = Array.from({ length: 201 }, (_, i) => ({ type: 'application', subtype: 'pdf', part: String(i + 1) } as BodyStructure));
    await expect(attachmentScanNodes(client, 42, structure)).rejects.toThrow(/Too many/);
    structure.parts = Array.from({ length: 1001 }, () => ({} as BodyStructure));
    await expect(attachmentScanNodes(client, 42, structure)).rejects.toThrow(/Too many/);
    expect(downloadPart).not.toHaveBeenCalled();
  });

  it('rejects duplicate part handles instead of binding a name to an ambiguous part', async () => {
    const { client, downloadPart, structure } = fixture({ '2.MIME': '' }); structure.parts!.push(structure.parts![0]);
    await expect(attachmentScanNodes(client, 42, structure)).rejects.toThrow(/Duplicate/);
    expect(downloadPart).not.toHaveBeenCalled();
  });

  it('stops after cancellation and clears headers that arrive after cancellation', async () => {
    const controller = new AbortController(); const raw = Buffer.from('Content-Disposition: attachment; filename="one.pdf"\r\n\r\n');
    const { client, structure, downloadPart } = fixture({ '2.MIME': '', '3.MIME': '' });
    downloadPart.mockImplementation(async () => { controller.abort(); return raw; });
    await expect(attachmentScanNodes(client, 42, structure, controller.signal)).rejects.toThrow(/cancelled/);
    expect(downloadPart).toHaveBeenCalledTimes(1); expect(raw.every(byte => byte === 0)).toBe(true);
  });

  it('rejects a header operation that exceeds the shared recovery deadline', async () => {
    let now = 0; vi.spyOn(Date, 'now').mockImplementation(() => now);
    const { client, structure, downloadPart } = fixture({ '2.MIME': '', '3.MIME': '' });
    downloadPart.mockImplementation(async () => { now = 20_001; return Buffer.from('Content-Type: text/plain\r\n\r\n'); });
    await expect(attachmentScanNodes(client, 42, structure)).rejects.toThrow(/timed out/);
    expect(downloadPart).toHaveBeenCalledTimes(1);
  });
});
