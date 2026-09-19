import { Readable } from 'stream';
import { finished } from 'stream/promises';

import { Splitter } from '@zone-eu/mailsplit';
import type { SplitterChunk } from '@zone-eu/mailsplit';

import { logger } from '../utils/logger';

import { base64DecodeCollapsed } from './body-structure';

/**
 * One named leaf part of a MIME message, as it travels — NOT decoded.
 *
 * `encodedLength` is the byte count of the part body before any
 * transfer-decoding, which is the only honest yardstick for judging what a
 * decoder produced from it. `raw` carries those bytes, and only for the part the
 * caller asked to collect: a message with a 20 MB attachment must not be turned
 * into 20 MB of garbage just to measure its parts.
 */
export interface RawMimePart {
  filename: string;
  /** Lower-cased Content-Transfer-Encoding, `''` when the part declares none. */
  encoding: string;
  encodedLength: number;
  raw: Buffer | null;
}

/**
 * Walk a raw MIME message and describe every leaf part that names a file.
 *
 * This exists because the server's own BODYSTRUCTURE cannot be trusted to carry
 * those names: one mailbox in the wild returns every parameter with its VALUE
 * missing — `("NAME" )`, `("FILENAME" )`, `("BOUNDARY" )` — and an ENVELOPE
 * stripped the same way (which is why `toIMAPMessage` already falls back to raw
 * headers for from/subject). Against such a message no lookup by filename can
 * ever match, so anything that needs a part's declared encoding or its true
 * length has to read the message itself.
 *
 * @param collectFilename when given, the bytes of the part with that name
 *                        (case-insensitive) are kept in `raw`; every other part
 *                        is measured and discarded.
 */
export async function readRawMimeParts(
  source: Buffer,
  collectFilename?: string,
): Promise<RawMimePart[]> {
  // Refuse anything but a Buffer HERE, synchronously, so the caller's try/catch
  // sees a rejected promise. Fed to the streams below, a non-Buffer chunk is
  // rejected by the splitter's write() — on Node 24 that throws inside pipe()
  // and lands in the same rejection, but on Node 22 it surfaces a tick later
  // as an UNCAUGHT exception that no caller can catch. CI (Node 22) failed the
  // whole core suite on exactly that while every test passed.
  if (!Buffer.isBuffer(source)) {
    throw new TypeError('readRawMimeParts: source must be a Buffer');
  }
  const wanted = collectFilename?.trim().toLowerCase();
  const parts: RawMimePart[] = [];
  let current: RawMimePart | null = null;
  // The one part being kept, and its pieces. Held separately from `current` so a
  // later part cannot displace them — the wanted part is rarely the last one.
  let collecting: RawMimePart | null = null;
  const collected: Buffer[] = [];

  const splitter = new Splitter();
  splitter.on('data', (chunk: SplitterChunk) => {
    if (chunk.type === 'node') {
      if (!chunk.filename) {
        current = null;
        return;
      }
      current = {
        filename: chunk.filename,
        encoding: (chunk.encoding || '').toLowerCase(),
        encodedLength: 0,
        raw: null,
      };
      parts.push(current);
      // Only the FIRST part with the wanted name is collected; the rest are
      // measured and thrown away.
      if (!collecting && wanted && current.filename.trim().toLowerCase() === wanted) {
        collecting = current;
      }
      return;
    }
    if (chunk.type === 'body' && current) {
      current.encodedLength += chunk.value.length;
      if (current === collecting) collected.push(chunk.value);
    }
  });

  // The stream is drained BEFORE anything reads a part: `finished` settles only
  // after the last body chunk has been handed to the listener above (and
  // rejects if the walk blows up), so no part is ever read half-measured.
  Readable.from([source]).pipe(splitter);
  await finished(splitter);

  if (collecting) (collecting as RawMimePart).raw = Buffer.concat(collected);
  return parts;
}

/**
 * Pair the parts named `filename` with each other in document order, so a
 * message carrying two attachments of the same name still lines up.
 */
function partsNamed(parts: readonly RawMimePart[], filename: string): RawMimePart[] {
  const want = filename.trim().toLowerCase();
  return parts.filter((p) => p.filename.trim().toLowerCase() === want);
}

/**
 * The bytes that ARE the attachment, given what a MIME parser made of it.
 *
 * mailparser believes Content-Transfer-Encoding. When a part declares `base64`
 * and carries raw text, a base64 decoder keeps only alphabet characters and
 * stops at the first `=`, so the attachment collapses: `<p><span style=` decodes
 * to SEVEN bytes. The file is then the part's raw body, byte for byte — which is
 * why this reads the message we already hold instead of asking the server for
 * the part again, a re-fetch that needs a part number the broken BODYSTRUCTURE
 * cannot supply (and a free socket, which a running sync does not leave).
 *
 * Returns `decoded` unchanged whenever the decode is plausible, the part cannot
 * be found, or the walk fails — a repair that cannot be made must never fail an
 * open that would otherwise have worked.
 */
export async function attachmentBytesFromSource(
  source: Buffer,
  filename: string,
  decoded: Buffer,
): Promise<Buffer> {
  let part: RawMimePart | undefined;
  try {
    part = partsNamed(await readRawMimeParts(source, filename), filename)[0];
  } catch (error) {
    logger.warn(`Could not read MIME parts for "${filename}": ${(error as Error)?.message ?? error}`);
    return decoded;
  }

  if (!part) return decoded;
  if (!base64DecodeCollapsed(part.encoding, part.encodedLength, decoded.length)) return decoded;
  if (!part.raw) return decoded;

  logger.warn(
    `Attachment "${filename}" declares ${part.encoding} but decoded to ${decoded.length} bytes ` +
      `from ${part.encodedLength} — serving the part's raw bytes instead`,
  );
  return part.raw;
}

/**
 * The sizes to STORE for a message's attachments: the decoded length, except
 * where that length contradicts the part it came from, in which case the raw
 * part length — the bytes the viewer ends up serving.
 *
 * Without this an attachment that lies about its encoding is listed at its junk
 * size ("7 B") for as long as the row lives, even once its content is repaired.
 * One walk for the whole list, not one per attachment.
 */
export async function attachmentSizesFromSource(
  source: Buffer,
  attachments: ReadonlyArray<{ name: string; size: number }>,
): Promise<number[]> {
  const decodedSizes = attachments.map((a) => a.size);
  if (attachments.length === 0) return decodedSizes;

  let parts: RawMimePart[];
  try {
    parts = await readRawMimeParts(source);
  } catch (error) {
    logger.warn(`Could not measure MIME parts: ${(error as Error)?.message ?? error}`);
    return decodedSizes;
  }

  // Consume matches in document order so duplicate filenames pair up rather
  // than every duplicate reading the first part's numbers.
  const remaining = new Map<string, RawMimePart[]>();
  for (const part of parts) {
    const key = part.filename.trim().toLowerCase();
    const bucket = remaining.get(key);
    if (bucket) bucket.push(part);
    else remaining.set(key, [part]);
  }

  return attachments.map((attachment, index) => {
    const part = remaining.get((attachment.name || '').trim().toLowerCase())?.shift();
    if (!part) return decodedSizes[index];
    return base64DecodeCollapsed(part.encoding, part.encodedLength, attachment.size)
      ? part.encodedLength
      : decodedSizes[index];
  });
}
