/**
 * Attribute the parts of a reply chain to the people who actually wrote them.
 *
 * A quoted block is not just noise to be discarded — its header names the
 * author ("On Mon 12 May, Pooja Khatri <pkh@sarv.com> wrote:"). So the same
 * text that must NOT be credited to the forwarder is strong positive evidence
 * for the person named in the header.
 *
 * That matters because ownership decides which number ends up on a contact
 * card. Someone who sends few mails but is quoted constantly would otherwise
 * lose their own mobile to a colleague who quoted it more often. Counting each
 * quoted signature for its real author fixes both directions at once: the
 * forwarder stops accumulating a number that isn't theirs, and the owner
 * accumulates the evidence that proves it is.
 */

/**
 * Quote headers that introduce a block written by someone else, and from which
 * an author address can usually be recovered. Kept separate from the stripping
 * markers in signal-extractor: those only need to find WHERE quoting starts,
 * these additionally need to identify WHO.
 */
const ATTRIBUTED_HEADERS: RegExp[] = [
  // "On <date>, <Name> <addr> wrote:" — unanchored, since HTML-to-text wraps it.
  /^On\b[\s\S]{0,300}?\bwrote:/gim,
  // "From: <Name> <addr>" blocks (Outlook / forwarded message headers).
  /^From:[^\n]{0,300}/gim,
];

const EMAIL_IN_TEXT = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;

export interface AuthoredSegment {
  /** Lowercased address of whoever wrote this segment, or null if unknown. */
  author: string | null;
  text: string;
}

/**
 * Split a plain-text body into segments by author.
 *
 * The first segment is the sender's own writing. Each subsequent segment starts
 * at a quote header and is credited to the address named in that header — or
 * `null` when the header carries no address, in which case callers must treat
 * it as unattributable rather than assume it belongs to the sender.
 */
export function splitByAuthor(plainText: string, fromAddress: string): AuthoredSegment[] {
  const text = plainText || '';
  if (!text.trim()) return [];

  // Collect every quote-header position with the author it names.
  // `index` is where the segment BOUNDARY falls; `bodyStart` is where that
  // author's actual text begins. They differ by the header itself, and the
  // difference matters: leaving the header attached means the downstream
  // extractor sees a quote marker at position 0 and strips the entire segment,
  // yielding nothing at all.
  const marks: Array<{ index: number; bodyStart: number; author: string | null }> = [];
  for (const rx of ATTRIBUTED_HEADERS) {
    rx.lastIndex = 0;
    for (const m of text.matchAll(rx)) {
      if (m.index === undefined) continue;
      // Look at the header itself plus a little following text — the address
      // often lands on the wrapped continuation line.
      const window = text.slice(m.index, m.index + Math.max(m[0].length, 200));
      const found = window.match(EMAIL_IN_TEXT);
      marks.push({
        index: m.index,
        bodyStart: m.index + m[0].length,
        author: found ? found[0].toLowerCase() : null,
      });
    }
  }
  marks.sort((a, b) => a.index - b.index);

  const self = (fromAddress || '').toLowerCase().trim() || null;
  if (marks.length === 0) return [{ author: self, text }];

  const segments: AuthoredSegment[] = [];
  const head = text.slice(0, marks[0].index).trim();
  if (head) segments.push({ author: self, text: head });

  for (let i = 0; i < marks.length; i++) {
    const end = i + 1 < marks.length ? marks[i + 1].index : text.length;
    // Start AFTER the header, so the segment reads as that author's own mail.
    const body = text.slice(marks[i].bodyStart, end).trim();
    if (body) segments.push({ author: marks[i].author, text: body });
  }
  return segments;
}
