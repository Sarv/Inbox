import { Headers } from '@zone-eu/mailsplit';
import libmime from 'libmime';

import type { BodyStructure, IIMAPClient } from '../types/imap';

const MAX_PARTS = 200;
const MAX_HEADER_BYTES = 64 * 1024;
const MAX_TOTAL_HEADER_BYTES = 2 * 1024 * 1024;
const METADATA_TIMEOUT_MS = 20_000;

function decodedName(value: string | undefined): string {
  if (!value) return '';
  try { return libmime.decodeWords(value).trim(); }
  catch { return value.trim(); }
}

/**
 * Some servers omit BODYSTRUCTURE parameter values or shift the next key into
 * a filename (for example "SIZE"). Resolve names from the bounded MIME headers,
 * even when BODYSTRUCTURE supplies a name, retaining exact numeric part handles.
 * Never fetch message/attachment bodies here. Repeat this resolution before a scan.
 */
export async function attachmentScanNodes(
  client: IIMAPClient,
  uid: number,
  structure: BodyStructure | undefined,
  signal?: AbortSignal,
): Promise<BodyStructure[]> {
  const pending = structure ? [structure] : [];
  const candidates: BodyStructure[] = [];
  const seen = new Set<string>();
  const singleRoot = !!structure && !structure.part && !structure.parts?.length;
  let visited = 0;
  while (pending.length) {
    const original = pending.pop()!;
    // IMAP addresses a single-node message body as part 1/TEXT, and its MIME
    // headers as HEADER rather than 1.MIME. The numeric identity stays 1.
    const node = singleRoot && original === structure ? { ...original, part: '1' } : original;
    if (++visited > 1000) throw new Error('Too many MIME parts to inspect safely');
    if ((node.parts?.length ?? 0) + pending.length + visited > 1000) throw new Error('Too many MIME parts to inspect safely');
    pending.push(...(node.parts ?? []).slice().reverse());
    if (!node.part || !/^\d+(\.\d+)*$/.test(node.part)) continue;
    const filename = node.disposition?.params?.filename || node.params?.name;
    if (node.parts?.length && !filename && node.disposition?.type?.toLowerCase() !== 'attachment') continue;
    if (seen.has(node.part)) throw new Error('Duplicate MIME part handles cannot be inspected');
    seen.add(node.part);
    candidates.push(node);
    if (candidates.length > MAX_PARTS) throw new Error('Too many MIME parts to inspect safely');
  }

  const result: BodyStructure[] = [];
  const deadline = Date.now() + METADATA_TIMEOUT_MS;
  let totalBytes = 0;
  for (const node of candidates) {
    if (signal?.aborted) throw new Error('Attachment scan cancelled');
    // An unnamed text node may still contain an attachment name that the server
    // stripped. Inspect its MIME header too, so an incomplete structure cannot
    // silently hide a second attachment with the same filename.
    if (!client.downloadPart) throw new Error('Attachment MIME headers are unavailable');
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0 || totalBytes >= MAX_TOTAL_HEADER_BYTES) throw new Error('Attachment metadata exceeds the inspection limit');
    const maxBytes = Math.min(MAX_HEADER_BYTES, MAX_TOTAL_HEADER_BYTES - totalBytes);
    const headerPart = singleRoot && node.part === '1' ? 'HEADER' : `${node.part}.MIME`;
    const raw = await client.downloadPart(uid, headerPart, { maxBytes, signal, timeoutMs: remainingMs });
    try {
      if (signal?.aborted) throw new Error('Attachment scan cancelled');
      if (Date.now() >= deadline) throw new Error('Attachment metadata inspection timed out');
      if (!raw?.length || raw.length > maxBytes || !/\r?\n\r?\n$/.test(raw.toString('latin1'))) {
        throw new Error('Attachment MIME headers are incomplete or exceed the inspection limit');
      }
      totalBytes += raw.length;
      const headers = new Headers(raw);
      const disposition = libmime.parseHeaderValue(headers.getFirst('content-disposition'));
      const contentType = libmime.parseHeaderValue(headers.getFirst('content-type'));
      const recovered = decodedName(disposition.params.filename || contentType.params.name || contentType.params.filename);
      const kind = (disposition.value || '').trim().toLowerCase();
      if (recovered || kind === 'attachment') {
        result.push({ ...node,
          // Match ImapFlow's transfer decoder, including legal MIME comments,
          // so the short-base64 refusal examines the encoding actually decoded.
          encoding: libmime.parseHeaderValue(headers.getFirst('content-transfer-encoding')).value.replace(/\(.*\)/g, '').trim().toLowerCase(),
          disposition: { type: kind || 'attachment', params: { filename: recovered || `Attachment ${node.part}` } },
        });
      }
    } finally { raw?.fill(0); }
  }
  return result;
}
