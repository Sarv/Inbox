/**
 * Where somebody else's email begins.
 *
 * Anything from the first marker onward is quoted or forwarded content, not the
 * sender's own words. Two very different callers need exactly this cut and must
 * not drift apart: signature mining (which otherwise attributes the quoted
 * sender's phone number to whoever forwarded it) and bulk-mail classification
 * (which otherwise condemns a human reply for the tracking links of the
 * newsletter quoted underneath it — the longer the thread, the more certain the
 * misfire).
 *
 * The patterns are tuned against `html-to-text` output, where a reply chain is
 * routinely collapsed onto a single line, so none of them may assume the marker
 * sits alone on one.
 */

// Markers that introduce quoted/forwarded content from a *different*
// sender. Anything from the first hit onward is somebody else's email,
// not the contact's. Without this strip, the signature extractor walks
// to the bottom of the body and grabs whoever signed off last — usually
// the user's own quoted signature in a long reply chain.
export const QUOTE_MARKERS: RegExp[] = [
  // "On <date>, <name> <addr> wrote:" — do NOT anchor to end-of-line. HTML mail
  // converted to text routinely wraps this header across lines or leaves
  // trailing content on it, and an anchored pattern then misses it entirely.
  // The whole quoted chain (including the quoted sender's signature) survives
  // the strip, and their phone gets attributed to whoever forwarded it.
  // Bounded lazy span so this can't backtrack pathologically.
  /^On\b[\s\S]{0,300}?\bwrote:/m,
  // Same header, NOT anchored to a line start. html-to-text collapses a reply
  // chain onto one line ("... review this today. On Wed, Jul 29, 2026 at 12:05
  // PM, Bindu Yagnik <b@x.com> wrote: ..."), so the anchored patterns miss it
  // and the quoted sender's number is mined for the forwarder. Requires a
  // weekday or digit after "On" so prose like "he wrote:" stays safe.
  /\bOn\s+(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun|\d)[\s\S]{0,300}?\bwrote:/i,
  /^On\s.+\swrote:\s*$/m,
  /^On\s.+,\s.+\swrote:\s*$/m,
  // Outlook-style quoted header block. The existing From:+Sent:/Date: pair
  // misses the common From:+To:/Subject: ordering.
  /^From:\s*.+\n\s*(To|Subject|Cc):\s*/mi,
  /^Le\s.+\sa\s[ée]crit\s*:\s*$/m,
  /^Am\s.+\sschrieb\s.+:\s*$/m,
  /^El\s.+\sescribi[óo]:\s*$/m,
  /^-{2,}\s*Original Message\s*-{2,}\s*$/mi,
  /^_{20,}\s*$/m,
  /^-{2,}\s*Forwarded message\s*-{2,}/mi,
  /^Begin forwarded message:\s*$/mi,
  /^From:\s*.+\s*\n\s*Sent:\s*.+/mi,
  /^From:\s*.+\s*\n\s*Date:\s*.+/mi,
  /^>\s/m,
];

export function stripQuotedTail(plainText: string): string {
  if (!plainText) return '';
  let earliest = plainText.length;
  for (const rx of QUOTE_MARKERS) {
    rx.lastIndex = 0;
    const m = rx.exec(plainText);
    if (m && m.index < earliest) earliest = m.index;
  }
  return plainText.slice(0, earliest).trimEnd();
}
