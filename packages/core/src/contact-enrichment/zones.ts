/**
 * Segment an email body into the zones that phone scoring cares about.
 *
 * The same digits mean different things depending on where they sit: a number
 * under a sign-off is the sender's, the identical number inside a quoted reply
 * belongs to whoever is quoted, and one in a legal footer belongs to nobody.
 * Flattening that into "text with numbers in it" is what made attribution
 * guesswork.
 *
 *   Zone 1 body        prose — weak unless explicitly labelled
 *   Zone 2 signature   the sender's own sign-off — strongest
 *   Zone 3 quoted      reply/forward history, credited to the quoted author
 *   Zone 4 disclaimer  legal boilerplate and system footers
 */

import { looksLikeDisclaimer, type PhoneZone } from './phone-scoring';
import { splitByAuthor } from './quote-attribution';
import { extractSignatureBlock, stripQuotedTail } from './signal-extractor';

export interface Zone {
  kind: PhoneZone;
  text: string;
  /** Whose text this is: the sender, or the author a quote header names. */
  author: string | null;
}

/**
 * Pluggable signature splitter: given a body, return its signature fragments.
 *
 * INJECTED rather than imported, because this module is shared with the
 * RENDERER. email-reply-parser is Node-only (it does `require('module')`) and
 * importing it here dragged that into the Vite bundle, which fails at load
 * with "Dynamic require of \"module\" is not supported" — a blank window.
 * Registering it from the main process keeps core browser-safe while the
 * node-side scan still gets the better parser.
 */
export type SignatureSplitter = (text: string) => string[];

let signatureSplitter: SignatureSplitter | null = null;

/** Install a signature splitter (main process only — see SignatureSplitter). */
export function setSignatureSplitter(fn: SignatureSplitter | null): void {
  signatureSplitter = fn;
}

/** Fragments from the injected splitter, or [] when none is installed. */
function signatureFragments(text: string): string[] {
  if (!signatureSplitter) return [];
  try {
    return signatureSplitter(text).map((f) => f.trim()).filter(Boolean);
  } catch {
    return []; // a splitter failure must never lose the whole email
  }
}

/**
 * Split `plainText` into zones.
 *
 * Quoted history is segmented first (it is the least ambiguous boundary), then
 * the sender's own portion is divided into signature / disclaimer / body.
 */
export function segmentZones(plainText: string, fromAddress: string): Zone[] {
  const text = plainText || '';
  if (!text.trim()) return [];

  const self = (fromAddress || '').toLowerCase().trim() || null;
  const zones: Zone[] = [];

  // Zone 3 — everything the sender did not write. splitByAuthor names the
  // author from each quote header, so these stay attributable.
  const segments = splitByAuthor(text, fromAddress);
  const ownText = stripQuotedTail(text);
  for (const seg of segments) {
    if (seg.author === self && seg.text.trim() === ownText.trim()) continue;
    if (seg.author === self) continue; // handled below as body/signature
    zones.push({ kind: 'quoted', text: seg.text, author: seg.author });
  }

  // Zone 4 — a disclaimer sits at the very end. Split it off before looking
  // for the signature, so boilerplate isn't mistaken for a sign-off.
  let rest = ownText;
  const lines = rest.split(/\r?\n/);
  let disclaimerFrom = -1;
  for (let i = lines.length - 1; i >= 0 && i > lines.length - 25; i--) {
    if (looksLikeDisclaimer(lines[i])) disclaimerFrom = i;
  }
  if (disclaimerFrom >= 0) {
    const disclaimer = lines.slice(disclaimerFrom).join('\n').trim();
    if (disclaimer) zones.push({ kind: 'disclaimer', text: disclaimer, author: self });
    rest = lines.slice(0, disclaimerFrom).join('\n');
  }

  // Zone 2 — the sender's signature, and Zone 1, whatever precedes it.
  //
  // email-reply-parser (GitHub's parser, ported) does this properly and, unlike
  // a "find the last delimiter" heuristic, returns EVERY signature fragment —
  // so an email carrying two sign-offs yields both, and each can be attributed
  // separately instead of the last one silently winning. It is used first, with
  // the local heuristics kept only for what it demonstrably misses: html-to-text
  // output that glues the sign-off into the prose ("…update.Regards,Bindu
  // Yagnik…"), where it reports no signature at all.
  const parsedSigs = signatureFragments(rest);
  if (parsedSigs.length > 0) {
    const firstAt = rest.indexOf(parsedSigs[0]);
    const body = firstAt > 0 ? rest.slice(0, firstAt) : '';
    if (body.trim()) zones.push({ kind: 'body', text: body, author: self });
    for (const frag of parsedSigs) {
      zones.push({ kind: 'signature', text: frag, author: self });
    }
    return zones;
  }

  const sig = extractSignatureBlock(rest);
  if (sig) {
    const at = rest.lastIndexOf(sig);
    const body = at > 0 ? rest.slice(0, at) : '';
    if (body.trim()) zones.push({ kind: 'body', text: body, author: self });
    zones.push({ kind: 'signature', text: sig, author: self });
  } else if (rest.trim()) {
    zones.push({ kind: 'body', text: rest, author: self });
  }

  return zones;
}
