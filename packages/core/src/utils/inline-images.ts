/**
 * Inline `data:` image URIs in an email body: finding them, replacing them with
 * a short reference, and putting them back.
 *
 * ## Why this exists
 *
 * Measured on the live 26,198-email mailbox by a full read-only scan of every
 * body (Aug 2026):
 *
 *   - `emails` is 9.54 GB of a 10.4 GB database — 98.1% of the file.
 *   - `raw_body` accounts for 9.33 GB of that.
 *   - **94.6% of all body bytes are base64 `data:` image URIs** — 8.83 GB.
 *     The actual HTML is 0.50 GB.
 *   - Only 27.4% of bodies contain any image, but those bodies are enormous:
 *     3,532 emails (13.5%) hold 87% of the body bytes, and the largest single
 *     `raw_body` is 21 MB.
 *   - 12,392 image occurrences resolve to **1,086 distinct images** — a 10.7x
 *     dedup factor. They are logos and signature images repeated across
 *     thousands of marketing mails, stored in full once per email.
 *
 * So the mail database is not a mail database; it is an image store with some
 * text attached, and it stores the same few thousand images over and over.
 *
 * Two effects compound: content-addressed dedup takes 8.83 GB of URI bytes down
 * to 0.82 GB, and storing the bytes as binary rather than base64 removes a flat
 * 33% inflation, taking that to 0.62 GB. Body storage lands near 1.1 GB against
 * 9.33 GB today, with every original byte preserved exactly.
 *
 * Sampling was not enough to see this and nearly sent the design the wrong way:
 * a 558-body stratified sample measured the dedup factor at 1.1x, because a logo
 * appearing in 2,000 of 26,198 mails lands in a sparse sample about once. The
 * numbers above are from the full scan. If you revisit these figures, scan
 * everything.
 *
 * The third gain is not about size at all: multi-megabyte blobs leave the row
 * that every flag update, categorisation and sync rewrites.
 *
 * ## Where the images come from
 *
 * We are not the ones choosing to inline them. `simpleParser` returns
 * `parsed.html` with every `cid:` reference to a `related` part already replaced
 * by a base64 `data:` URI, and `message-processor.parseBody` stores that string
 * verbatim as `rawBody`. mailparser offers no option to turn that off. So a
 * mail whose sender attached a 2 MB photo by reference arrives as a 2.7 MB HTML
 * string, and we persist it that way. This module undoes that at the storage
 * boundary.
 *
 * ## Renderer-safe on purpose
 *
 * Pure string work, zero imports — no `node:crypto`, no database. Hashing and
 * persistence live in `@sarvinbox/storage-node` (`inline-image-store.ts`), which
 * is Node-only. Keeping the scan and the ref format here means the renderer can
 * recognise a ref without dragging the storage layer (and therefore
 * better-sqlite3) into its bundle — the exact class of import that causes the
 * "Dynamic require of stream" crash the renderer guard exists to prevent.
 */

/**
 * URI scheme for a stored inline image.
 *
 * Deliberately NOT `sarv-image:`, which the renderer's in-memory LLM image cache
 * (`apps/desktop/src/services/image-cache.ts`) already uses for a different job:
 * that one keeps base64 out of AI prompts for the lifetime of a window and is
 * rebuilt from `rawBody` on demand. These refs are DURABLE and are what
 * `rawBody` now contains. Two schemes so a ref can never be handed to the wrong
 * resolver and silently come back null.
 */
export const INLINE_IMAGE_SCHEME = 'sarv-inline';

/** A stored image is addressed by the hex content hash of its DECODED bytes. */
export const INLINE_IMAGE_HASH_CHARS = 32;

/**
 * Smallest `data:` URI worth relocating.
 *
 * A ref costs ~41 characters, so anything above a few hundred bytes is a win on
 * paper. The threshold is much higher than that on purpose: the full-mailbox
 * scan found NO images below 1 KB, so a lower bound buys nothing and a 1 KB
 * floor leaves 1x1 tracking pixels and tiny spacer GIFs exactly where they are.
 * Those render as part of the layout, they cost nothing to keep, and rewriting
 * them would mean touching almost every marketing email for no bytes back.
 */
export const MIN_INLINE_IMAGE_CHARS = 1024;

/**
 * The FIXED part of an inline image URI: `data:image/<subtype>;base64,`.
 *
 * The payload is deliberately NOT part of this pattern, and that is the whole
 * point. The obvious version of this regex ends in a greedy character class
 * (`([A-Za-z0-9+/=\s]{16,})`), which is linear in TIME but not in STACK: V8's
 * regex engine matches a quantified class against the native stack, so on a
 * multi-megabyte payload `RegExp.exec` itself throws
 * `RangeError: Maximum call stack size exceeded`. Measured on a production mailbox at
 * 8.8 GB of base64 — a 200 KB payload matches fine, so a unit test with a
 * synthetic image passes happily while every large image in the mailbox throws.
 *
 * So the payload is consumed by {@link scanPayloadEnd}, a plain forward scan:
 * no backtracking, no engine stack, and the same character set. Only the small
 * bounded prefix goes through the regex engine.
 */
const DATA_IMAGE_PREFIX_RE = /data:(image\/[a-z0-9.+-]{1,40});base64,/gi;

/** Shortest payload worth calling an image at all — below this it is a fragment. */
const MIN_BASE64_PAYLOAD_CHARS = 16;

/**
 * Advance past a base64 payload, starting at `from`.
 *
 * Accepts the base64 alphabet plus whitespace — legal inside an HTML attribute
 * and in CSS `url(...)`, and what real senders use to wrap long values. It
 * accepts neither `"`, `'`, `)` nor `>`, so the scan can never run past the end
 * of the attribute the URI lives in.
 *
 * Returns the index one past the payload and whether any whitespace was seen, so
 * the caller can skip the strip entirely in the common unwrapped case.
 */
function scanPayloadEnd(html: string, from: number): { end: number; hadWhitespace: boolean } {
  let cursor = from;
  let hadWhitespace = false;
  for (; cursor < html.length; cursor += 1) {
    const code = html.charCodeAt(cursor);
    const isBase64Char =
      (code >= 65 && code <= 90) || // A-Z
      (code >= 97 && code <= 122) || // a-z
      (code >= 48 && code <= 57) || // 0-9
      code === 43 || // +
      code === 47 || // /
      code === 61; // =
    if (isBase64Char) continue;
    // Space, tab, CR, LF, form feed, vertical tab.
    if (code === 32 || (code >= 9 && code <= 13)) {
      hadWhitespace = true;
      continue;
    }
    break;
  }
  return { end: cursor, hadWhitespace };
}

/** One `data:` image URI found in a body, as a half-open range over the source. */
export interface FoundDataImage {
  /** Index of the `d` in `data:`. */
  readonly start: number;
  /** Index one past the last character of the URI. */
  readonly end: number;
  /** Lower-cased MIME type, e.g. `image/png`. */
  readonly mime: string;
  /** Base64 payload with all whitespace removed. */
  readonly base64: string;
  /** Length in characters of the whole URI as it appears in the source. */
  readonly length: number;
}

/** `sarv-inline:<hash>` — what replaces a relocated `data:` URI in the body. */
export function makeInlineImageRef(hash: string): string {
  return `${INLINE_IMAGE_SCHEME}:${hash}`;
}

/** Matches a ref written by {@link makeInlineImageRef}. */
const INLINE_IMAGE_REF_RE = new RegExp(
  `${INLINE_IMAGE_SCHEME}:([0-9a-f]{${INLINE_IMAGE_HASH_CHARS}})`,
  'g',
);

/**
 * Cheap pre-test before running any ref machinery.
 *
 * Every read path calls this on every body, so it has to be an `indexOf`, not a
 * regex: a body with no refs (a plain-text mail, a header-only row, any mail
 * that predates this change) must cost one substring search and nothing else.
 */
export function hasInlineImageRefs(html: string): boolean {
  return html.length > 0 && html.includes(`${INLINE_IMAGE_SCHEME}:`);
}

/** Every distinct image hash referenced by a body, in first-appearance order. */
export function findInlineImageRefs(html: string): string[] {
  if (!hasInlineImageRefs(html)) return [];
  const seen = new Set<string>();
  INLINE_IMAGE_REF_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = INLINE_IMAGE_REF_RE.exec(html)) !== null) seen.add(match[1]);
  return [...seen];
}

/**
 * Every base64 `data:` image URI in `html` that is at least `minChars` long.
 *
 * Returns ranges rather than a rewritten string so the caller can hash the
 * payloads, persist them, and only then decide what to substitute — without
 * scanning twice or reassembling the body more than once.
 */
export function findDataImages(
  html: string,
  minChars: number = MIN_INLINE_IMAGE_CHARS,
): FoundDataImage[] {
  if (!html || !html.includes('base64,')) return [];
  const found: FoundDataImage[] = [];
  DATA_IMAGE_PREFIX_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = DATA_IMAGE_PREFIX_RE.exec(html)) !== null) {
    const payloadStart = match.index + match[0].length;
    const { end: scanned, hadWhitespace } = scanPayloadEnd(html, payloadStart);
    // Resume AFTER the payload, never inside it: re-entering the payload would
    // rescan megabytes per image and could match a `data:` sequence that is
    // itself image bytes.
    DATA_IMAGE_PREFIX_RE.lastIndex = scanned;

    // Trailing whitespace is part of the payload scan but not of the URI;
    // excluding it keeps the replaced range tight so the surrounding markup (the
    // closing quote, a CSS `)`) is never disturbed.
    let end = scanned;
    if (hadWhitespace) {
      while (end > payloadStart) {
        const code = html.charCodeAt(end - 1);
        if (code !== 32 && !(code >= 9 && code <= 13)) break;
        end -= 1;
      }
    }

    const raw = html.slice(payloadStart, end);
    const base64 = hadWhitespace ? raw.replace(/\s+/g, '') : raw;
    if (base64.length < MIN_BASE64_PAYLOAD_CHARS) continue;
    const length = end - match.index;
    if (length < minChars) continue;
    found.push({
      start: match.index,
      end,
      mime: match[1].toLowerCase(),
      base64,
      length,
    });
  }
  return found;
}

/**
 * Replace non-overlapping ranges in one pass.
 *
 * Ranges must be sorted and disjoint, which is what {@link findDataImages}
 * returns by construction (a global regex cannot produce overlapping matches).
 * Built by slicing rather than repeated `String.replace` because the payloads are
 * megabytes: a replace-per-image would copy the whole body once per image, which
 * on a 21 MB mail with 40 images is 840 MB of copying.
 */
export function replaceRanges(
  source: string,
  ranges: ReadonlyArray<{ start: number; end: number; replacement: string }>,
): string {
  if (ranges.length === 0) return source;
  const parts: string[] = [];
  let cursor = 0;
  for (const { start, end, replacement } of ranges) {
    if (start < cursor) continue; // defensive: never emit overlapping output
    parts.push(source.slice(cursor, start), replacement);
    cursor = end;
  }
  parts.push(source.slice(cursor));
  return parts.join('');
}

/**
 * Put stored images back into a body, turning refs into `data:` URIs again.
 *
 * `resolve` returns null for a hash the store no longer holds; that ref is left
 * exactly as it is rather than replaced with a placeholder. A ref that reaches
 * the renderer unresolved renders as a broken image — visible, diagnosable, and
 * recoverable once the blob is restored — whereas substituting a 1x1 transparent
 * pixel would make a missing image indistinguishable from a deliberate one.
 */
export function restoreInlineImages(
  html: string,
  resolve: (hash: string) => { mime: string; base64: string } | null,
): string {
  if (!hasInlineImageRefs(html)) return html;
  const ranges: Array<{ start: number; end: number; replacement: string }> = [];
  INLINE_IMAGE_REF_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = INLINE_IMAGE_REF_RE.exec(html)) !== null) {
    const resolved = resolve(match[1]);
    if (!resolved) continue;
    ranges.push({
      start: match.index,
      end: match.index + match[0].length,
      replacement: `data:${resolved.mime};base64,${resolved.base64}`,
    });
  }
  return replaceRanges(html, ranges);
}
