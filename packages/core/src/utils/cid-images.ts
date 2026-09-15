/**
 * Resolve `cid:` image references mailparser left behind.
 *
 * ## Why this exists
 *
 * A sender who embeds an image by reference writes `<img src="cid:logo@host">`
 * and ships the bytes as a `related` MIME part carrying `Content-ID: <logo@host>`.
 * `simpleParser` normally rewrites those references to base64 `data:` URIs for
 * us (see `inline-images.ts`, which exists to undo exactly that at the storage
 * boundary), so the app has never had any `cid:` handling of its own.
 *
 * But mailparser's rewrite is narrower than the format. `updateImageLinks` in
 * `mailparser/lib/mail-parser.js` only substitutes a part when
 * `/^image\/[\w]+$/i.test(contentType)` holds, so every one of these is skipped
 * and left in the HTML verbatim:
 *
 *   - `image/x-png`, `image/x-icon`, `image/vnd.microsoft.icon`, `image/svg+xml`
 *     — any subtype with a `-`, `+` or `.` in it,
 *   - a part typed `application/octet-stream` whose filename is plainly an image,
 *   - a reference whose Content-ID differs from the part's only by case or by
 *     percent-encoding.
 *
 * An unresolved `cid:` is not a visible failure anywhere: the body iframe's CSP
 * has no `cid:` source (it cannot have one — nothing would answer it), so the
 * image is blocked silently, the "remote images blocked" banner never fires
 * (it looks for `http(s):` only), and nothing reaches the log. The user sees one
 * broken image in a mail that renders perfectly in Gmail, which resolves a cid
 * against any part regardless of its declared type.
 *
 * This module closes that gap: the same substitution, with the type test
 * widened to the whole `image/*` tree and the reference matched the way real
 * senders write it. The output feeds the existing
 * `data:` → inline-image-blob-store pipeline unchanged.
 *
 * ## Why hand-written matching rather than a library
 *
 * The project rule is to prefer a mature library over bespoke regex, and the
 * mature library here IS mailparser — this is its job and we use it for the
 * 99% case. What is left is a patch over a documented gap in one function of
 * it, on a string that library already produced; no other package parses
 * "mailparser's output HTML" as an input. So the matching is kept tiny, pure,
 * and pinned by tests, and the character classes are all negated single
 * characters (linear time — no nesting, no backtracking, no ReDoS surface).
 *
 * ## Renderer-safe
 *
 * Pure string work, zero imports beyond a sibling helper. The Node-only base64
 * of a part's bytes is supplied by the caller as `toBase64`, so this file never
 * touches `Buffer` and can be reached from the renderer bundle.
 */

import { attachmentContentType } from './attachment-kind';

/**
 * One MIME part that a `cid:` reference could name.
 *
 * `toBase64` is a callback rather than a string because a message can carry
 * megabytes of parts that nothing references; base64 costs a full copy plus 33%,
 * and this way it is paid only for parts actually substituted into the HTML.
 */
export interface CidImagePart {
  /** The part's `Content-ID`, with or without the `<>` wrapper. */
  cid?: string | null;
  /** Declared MIME type, parameters included or not. */
  contentType?: string | null;
  /** Used only to recover the type when the sender declared a useless one. */
  filename?: string | null;
  /** Base64 of the part's decoded bytes. Called at most once, only if referenced. */
  toBase64: () => string;
}

/**
 * A `cid:` reference as senders actually write it.
 *
 * The leading group is the delimiter that opened the value — a quote, an `=`
 * for the unquoted `src=cid:x>` form, or the `(` of `url(cid:x)`. Requiring one
 * keeps the match inside an attribute or a CSS url() so a literal "cid:" in
 * prose is never rewritten. The value stops at any character that could end it,
 * which is what mailparser's own `[^'"\s]{1,256}` gets wrong: it swallows the
 * `>` of an unquoted attribute into the reference and then matches no part.
 */
const CID_REF = /(["'(=])\s*cid:([^"'()\s<>]{1,256})/gi;

/** Cheap pre-test so the common mail (no leftover refs) costs one scan and no allocation. */
export function hasCidRefs(html: string | null | undefined): boolean {
  if (!html) return false;
  // `test` on a /g/ regex advances lastIndex; a fresh RegExp keeps this pure.
  return new RegExp(CID_REF.source, 'i').test(html);
}

/** `<logo@host>` / ` logo@host ` → `logo@host`, lowercased for lookup. */
function normalizeCid(cid: string): string {
  return cid.trim().replace(/^<|>$/g, '').toLowerCase();
}

/** Percent-decode a reference (RFC 2392 allows it); unparseable escapes stay literal. */
function decodeRef(ref: string): string {
  try {
    return decodeURIComponent(ref);
  } catch {
    return ref;
  }
}

/**
 * The `image/*` type to render this part as, or null if it isn't an image.
 *
 * Accepts the whole `image/` tree rather than mailparser's `image/[\w]+`, and
 * falls back to the filename's extension when the sender declared a container
 * type (`application/octet-stream` is the common one from Outlook).
 *
 * `image/svg+xml` is deliberately NOT accepted. An SVG is an active-content
 * document, and a `data:` URI carrying one lands in the email body's iframe —
 * the one place in the app that renders sender-authored markup. Such a part
 * stays an unresolved `cid:` and simply doesn't draw, which is what mailparser
 * already did with it. Rendering it safely is a bigger decision than this fix.
 */
function imageTypeOf(part: CidImagePart): string | null {
  const declared = (part.contentType || '').split(';')[0].trim().toLowerCase();
  if (declared === 'image/svg+xml') return null;
  if (declared.startsWith('image/') && declared.length > 'image/'.length) return declared;

  // Sender gave us nothing usable — ask the filename allow-list instead.
  const byName = part.filename ? attachmentContentType(part.filename) : '';
  if (byName === 'image/svg+xml') return null;
  return byName.startsWith('image/') ? byName : null;
}

/**
 * Replace every `cid:` reference in `html` that names an image part with that
 * part's bytes as a `data:` URI.
 *
 * Pure: returns a new string and never mutates `parts`. A reference naming no
 * part — or naming a non-image one — is left exactly as it was, because a
 * visible broken image is the honest rendering of a message whose own parts
 * don't line up, and rewriting it to something else would hide that forever.
 */
export function resolveCidImages(html: string, parts: readonly CidImagePart[]): string {
  if (!html || !parts.length || !hasCidRefs(html)) return html;

  // Built once per message, not per reference: a signature image repeated
  // twenty times in a quoted thread must not re-base64 its part twenty times.
  const byCid = new Map<string, CidImagePart>();
  for (const part of parts) {
    if (!part?.cid) continue;
    const key = normalizeCid(part.cid);
    // First part wins, matching mailparser: a duplicate Content-ID is a sender
    // bug and the first occurrence is the one its own rewrite would have used.
    if (key && !byCid.has(key)) byCid.set(key, part);
  }
  if (!byCid.size) return html;

  const dataUris = new Map<string, string>();

  return html.replace(CID_REF, (match, delimiter: string, ref: string) => {
    const key = normalizeCid(ref);
    const part = byCid.get(key) ?? byCid.get(normalizeCid(decodeRef(ref)));
    if (!part) return match;

    const cached = dataUris.get(key);
    if (cached) return `${delimiter}${cached}`;

    const mime = imageTypeOf(part);
    if (!mime) return match;

    let base64: string;
    try {
      base64 = part.toBase64();
    } catch {
      // A part whose bytes can't be read is a broken image, not a broken mail.
      return match;
    }
    if (!base64) return match;

    const uri = `data:${mime};base64,${base64}`;
    dataUris.set(key, uri);
    return `${delimiter}${uri}`;
  });
}
