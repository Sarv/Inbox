/**
 * Did the model's outputs keep everything one of Standard's segments showed?
 *
 * The AI view may add messages Standard missed, never lose text Standard had
 * (validate.ts). "Kept" is decided LINE BY LINE, not by a length share:
 *
 *   * A segment whose boundaries the library did not recognise (an Outlook
 *     chain in plain `<div>`s, a German "Am … schrieb" chain) is ONE segment
 *     holding several messages AND their attribution headers. The headers are
 *     boundary markers the model is told to drop, and in an Outlook chain they
 *     are half the text — a length share would reject every correct split.
 *     So the segment is read as lines, the attribution/header lines are set
 *     aside, and what is left is cut into BLOCKS: one block per message.
 *   * Every block must have a line the outputs kept (a message nobody kept is
 *     a skipped message), and every line of it must be kept, except what the
 *     model is told to drop: the trailing signature. A block's uncovered tail
 *     is allowed only when it reads as one — it opens with a sign-off line
 *     ("Thanks", "Best regards", "--", "Sent from my iPhone": the library's
 *     own `signOffPatterns`) or carries the library's strong signature
 *     evidence (a job title, two domains).
 *
 * So a message cut short (the model kept its first sentence), a skipped
 * message, and a message whose middle went missing all fail, while a correct
 * split of a header-heavy chain passes. The judgement errs toward "not kept",
 * whose cost is Standard's rendering, never lost text.
 */
import { hasStrongSignatureEvidence, HEADER_LABEL_PATTERN, HEADER_PATTERN, signOffPatterns } from '@sarv-in/email-chat-view/transform';
import { htmlToPlainText } from '@sarvinbox/core/html-text';
import { QUOTE_MARKERS } from '@sarvinbox/core/quoted-text';

import { normalizedContent } from '../../components/email-detail/chat-message-adapter';

/** One visual line of a Standard segment. */
export interface SegmentLine {
  /** The line's text, its `>` quote prefix removed. */
  raw: string;
  /** Its normalized text (the key the outputs are searched for). */
  key: string;
  /** An attribution or header line: a boundary marker, not message content. */
  header: boolean;
}

/**
 * A line shorter than this (normalized) proves nothing either way inside a
 * block that has kept lines — a lone name under a sign-off, "Hi,", "--" — and
 * is matched by accident in almost any output.
 */
const MIN_LINE_KEY_CHARS = 4;
/** The library's own ceiling for a signature block (`cutSignOff`, strong evidence). */
const MAX_SIGNATURE_CHARS = 900;

/** A line's key: normalized as a body is, without reading `<…>` in text as a tag. */
const lineKey = (text: string): string => normalizedContent(text.replace(/[<>]/g, ' '));

/** A line that opens (or is) a quoted message's attribution. */
function isMarkerLine(line: string): boolean {
  return HEADER_PATTERN.test(line) || QUOTE_MARKERS.some((marker) => marker.test(line));
}

/**
 * The segment's lines, with its attribution/header lines marked. A header
 * field line ("To: …", "Subject: …") counts as a header when it sits in a run
 * of two or more field lines, or directly under a marker line — alone, "To:
 * do list" is prose.
 */
export function segmentLines(html: string): SegmentLine[] {
  const lines = htmlToPlainText(html)
    .split('\n')
    .map((line) => line.replace(/^[\s>]+/, '').trim())
    .filter(Boolean)
    .map((raw): SegmentLine => ({ raw, key: lineKey(raw), header: isMarkerLine(raw) }));

  const isField = (line: SegmentLine | undefined) => !!line && HEADER_LABEL_PATTERN.test(line.raw);
  for (let start = 0; start < lines.length; start++) {
    if (!isField(lines[start]) || isField(lines[start - 1])) continue;
    let end = start;
    while (isField(lines[end + 1])) end++;
    if (end > start || lines[start - 1]?.header) {
      for (let at = start; at <= end; at++) lines[at]!.header = true;
    }
  }
  return lines;
}

/** Whether the lines the outputs did not keep, at the end of a block, are its signature. */
function isSignatureTail(tail: readonly SegmentLine[]): boolean {
  if (tail.every((line) => line.key.length < MIN_LINE_KEY_CHARS)) return true;
  const text = tail.map((line) => line.raw).join('\n');
  if (text.length > MAX_SIGNATURE_CHARS) return false;
  return signOffPatterns.some((pattern) => pattern.test(tail[0]!.raw)) || hasStrongSignatureEvidence(text);
}

/** Whether every message block of `lines` is kept by the output `keys` (see the module doc). */
export function keepsEveryLine(lines: readonly SegmentLine[], keys: readonly string[]): boolean {
  const blocks: SegmentLine[][] = [[]];
  for (const line of lines) {
    if (line.header) blocks.push([]);
    else blocks[blocks.length - 1]!.push(line);
  }
  const kept = (line: SegmentLine) => line.key !== '' && keys.some((key) => key.includes(line.key));

  for (const block of blocks) {
    if (!block.some((line) => line.key)) continue;
    const lastKept = block.map(kept).lastIndexOf(true);
    // A whole message nobody kept.
    if (lastKept < 0) return false;
    // A line lost from the middle.
    if (block.slice(0, lastKept).some((line) => line.key.length >= MIN_LINE_KEY_CHARS && !kept(line))) return false;
    const tail = block.slice(lastKept + 1);
    if (tail.length > 0 && !isSignatureTail(tail)) return false;
  }
  return true;
}
