/**
 * Last-resort repair for a message whose DECLARED charset is a lie.
 *
 * ## The failure this fixes — and the one it does NOT
 *
 * These are two different bugs and it matters which is which:
 *
 *  - **We decoded wrongly.** The old fetch path turned the raw MIME source into
 *    a string with a plain UTF-8 decode before mailparser ever saw the message's
 *    `charset`, so every non-UTF-8 byte became U+FFFD at download time. That is
 *    fixed at the source (`imapflow-client` keeps the bytes losslessly as latin1)
 *    and is NOT what this module is for — bytes already destroyed that way are
 *    gone, and only a re-fetch recovers them (`body-reheal-scheduler`).
 *
 *  - **The SENDER declared wrongly.** A part says `charset=us-ascii` or
 *    `charset=utf-8` and then ships Windows-1252 bytes. Outlook and several older
 *    mail servers do this routinely. Here the pipeline is correct end to end and
 *    the library is doing exactly as it was told — mailparser skips decoding
 *    entirely for the ascii/utf-8 family (see its `mail-parser.js`, which only
 *    builds a decode stream for other charsets) and the bytes fall through a
 *    UTF-8 `toString()`. The result is the same `�`, from the opposite cause, and
 *    re-fetching cures nothing because the server's copy says the same lie.
 *
 * Only the second case is repairable locally, and only by ignoring what the
 * message claims and looking at the bytes.
 *
 * ## Why detection, and why it is safe here
 *
 * Charset detection is statistics, not fact — a short Windows-1252 body and a
 * short ISO-8859-1 body are frequently the same bytes. So it is never allowed to
 * override a declaration that WORKED: the caller runs the normal parse first and
 * only reaches this module when that parse already produced replacement
 * characters. From there the guess cannot make things worse, because the caller
 * keeps the re-parse only when it STRICTLY reduces the replacement-character
 * count. A wrong guess loses to the original and is discarded.
 *
 * `chardet` does the detection (the Node port of Mozilla's universalchardet) and
 * `iconv-lite` the decoding — both already the libraries underneath mailparser's
 * own charset handling, so this adds no second opinion about how to decode, only
 * about what to decode AS.
 */
import { analyse } from 'chardet';
import { decode, encodingExists } from 'iconv-lite';

/** U+FFFD — what a decoder emits for a byte sequence it cannot map. */
export const REPLACEMENT_CHAR = '�';

/**
 * How many candidate encodings are worth decoding the source as.
 *
 * `chardet.analyse` returns its guesses confidence-ordered and often a dozen
 * long; the tail is noise. Three bounds the work on a path that is already the
 * unhappy one, and in practice the real encoding is the first supported guess.
 */
const MAX_CANDIDATES = 3;

/**
 * Guesses worth nothing here. The source has ALREADY failed to decode as UTF-8 —
 * that is the only reason this module was called — so re-decoding it as UTF-8 or
 * ASCII reproduces the exact damage we are trying to undo.
 */
const UNICODE_FAMILY = /^(utf|ascii|usascii|unicode)/;

/**
 * Confidence below which a guess is not worth acting on.
 *
 * Deliberately a floor, not a threshold: almost ANY single-byte charset decodes
 * almost any byte without complaint, so the "did it reduce the damage" test the
 * caller applies cannot distinguish a good guess from a lucky one — the ranking
 * does that. This only rejects the guesses `chardet` itself scores as noise.
 */
const MIN_CONFIDENCE = 10;

/**
 * Cheap pre-test: does this text carry any replacement character at all?
 *
 * Every parsed body goes through this, so it must stay a native `includes` and
 * never a scan — {@link countReplacementChars} is the one that walks the string,
 * and it only runs once this has already said yes.
 */
export function hasReplacementChar(text: string | null | undefined): boolean {
  return !!text && text.includes(REPLACEMENT_CHAR);
}

/**
 * How many replacement characters a decoded body carries — the damage score the
 * caller compares before and after a re-decode.
 *
 * A COUNT, not a boolean, on purpose: a multipart message can have one part
 * mislabelled and another genuinely containing a `�` the sender typed. Requiring
 * the count to fall, rather than reach zero, lets the repairable part be repaired
 * without demanding perfection from a message that never had it.
 */
export function countReplacementChars(text: string | null | undefined): number {
  if (!text) return 0;
  let count = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 0xfffd) count += 1;
  }
  return count;
}

/**
 * Does `candidate` still contain everything `primary` decoded SUCCESSFULLY?
 *
 * The one hole a replacement-character count cannot see. Transcoding rewrites
 * the WHOLE source, so a multipart message with one mislabelled part and one
 * honest UTF-8 part gets its honest part double-encoded (`é` → `Ã©`) — which
 * produces no `�` at all and therefore scores as an improvement, while quietly
 * ruining text that was correct.
 *
 * So the count is not the test; preservation is. Everything the first parse got
 * right — every run of characters between the replacement characters — must
 * still appear in the re-parse, in order. Only the damaged spots may differ,
 * which is precisely the repair being asked for. A single-byte charset leaves
 * ASCII byte-for-byte identical, so a genuinely mislabelled body passes this
 * trivially; the mixed-charset message fails it and keeps its original parse.
 *
 * It also rules out content LOSS for free: a re-parse that dropped the body
 * would score a perfect zero replacement characters and preserve nothing.
 */
export function preservesDecodedText(primary: string, candidate: string): boolean {
  let searchFrom = 0;
  for (const segment of primary.split(REPLACEMENT_CHAR)) {
    if (segment.length === 0) continue; // adjacent/leading damage — nothing to check
    const found = candidate.indexOf(segment, searchFrom);
    if (found < 0) return false;
    searchFrom = found + segment.length;
  }
  return true;
}

/** A source re-encoded as real UTF-8, and the charset that turned out to be. */
export interface TranscodedSource {
  /** The encoding `chardet` settled on, for the log line. */
  readonly charset: string;
  /** The whole message source, re-encoded as UTF-8. */
  readonly bytes: Buffer;
}

/**
 * Is this source already well-formed UTF-8?
 *
 * The `fatal` decoder is the exact test needed: it throws on a malformed byte
 * sequence but accepts an ENCODED U+FFFD (`EF BF BD`) as the perfectly legal
 * character it is. That distinguishes the two ways a body ends up showing `�` —
 * bytes that could not be decoded, versus a replacement character the sender
 * genuinely sent (a forwarded mail that was already mojibake, most often).
 */
function isWellFormedUtf8(source: Buffer): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(source);
    return true;
  } catch {
    return false;
  }
}

/**
 * Re-encode a raw MIME source from its DETECTED encoding into real UTF-8.
 *
 * The whole source is transcoded, not the offending part alone, because
 * mailparser owns the MIME walk and there is no supported seam to hand it
 * corrected bytes for one part. That is safe in the way that matters: a
 * quoted-printable or base64 part is pure ASCII and survives any 8-bit
 * transcode byte-for-byte, so only the raw 8-bit parts — exactly the broken
 * ones — change at all. It is NOT safe for a binary-transfer-encoded part, which
 * is why the caller takes only the BODIES from the re-parse and keeps every
 * attachment from the original.
 *
 * Returns null when there is nothing better to try: a source that is already
 * well-formed UTF-8, no guess, a Unicode-family guess (see
 * {@link UNICODE_FAMILY}), an encoding `iconv-lite` cannot decode (ISO-2022-JP
 * among them — mailparser carries its own decoder for those), or a guess that
 * itself decodes to replacement characters, which proves it wrong without any
 * need to re-parse.
 */
export function transcodeDetectedCharset(source: Buffer): TranscodedSource | null {
  // A source that IS valid UTF-8 has no mislabelled 8-bit bytes to rescue, so
  // any `�` in the parsed body was sent as one. Re-decoding such a source as a
  // single-byte charset would turn a correct body into mojibake while honestly
  // reporting fewer replacement characters — the one way this repair could do
  // damage, and the reason it is refused before detection even runs.
  if (isWellFormedUtf8(source)) return null;

  let candidates: ReadonlyArray<{ name: string; confidence: number }>;
  try {
    candidates = analyse(source);
  } catch {
    return null; // detection is best-effort; a failure just means no repair
  }

  let tried = 0;
  for (const candidate of candidates) {
    if (tried >= MAX_CANDIDATES) break;
    if (candidate.confidence < MIN_CONFIDENCE) break; // ranked list — the rest are worse
    const normalized = candidate.name.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (UNICODE_FAMILY.test(normalized)) continue;
    if (!encodingExists(candidate.name)) continue;
    tried += 1;
    try {
      const text = decode(source, candidate.name);
      if (text.includes(REPLACEMENT_CHAR)) continue;
      return { charset: candidate.name, bytes: Buffer.from(text, 'utf8') };
    } catch {
      continue; // a decoder that throws is simply not this message's encoding
    }
  }
  return null;
}
