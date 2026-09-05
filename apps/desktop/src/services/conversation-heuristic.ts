// Deterministic conversation splitter (NO AI).
//
// Turns a thread's emails — where the history is embedded as quoted replies
// inside one or more messages — into an ordered list of per-sender chat
// bubbles, the same shape the AI extractor produces (ConversationMessage).
// It parses the standard quoting structures every mail client emits:
//
//   • Gmail / Apple:  <div class="gmail_attr">On <date>, <name> <email> wrote:</div>
//                     <blockquote class="gmail_quote"> …that sender's message… </blockquote>
//                     (recursively nested — each level is one older message)
//   • Outlook:        "From: … Sent/Date: … To: …" header blocks
//   • Plain fallback: "On <date>, <name> wrote:" attribution lines
//
// Each segment is then cleaned by composable, provider-agnostic helpers:
// signature containers (Gmail/Outlook/Apple/Thunderbird/…), "-- " and mobile
// footers, and external-email / confidentiality banners are stripped; blank
// edges are trimmed so bubbles hug their text. Messages are de-duplicated
// across the thread (every reply quotes the same older messages) and sorted
// oldest -> newest.

import type { EmailRecord } from '@sarvinbox/core';
import { SIGNATURE_DELIMITERS } from '@sarvinbox/core/contact-enrichment';

import { collapseExcessBlankSpace, trimTrailingWindowed } from '../utils/email-html';
import { parseHumanDateToEpochSec } from '../utils/human-date';

import type { ConversationMessage } from './conversation-service';

/**
 * SAFE signature containers — specific id/class markers real clients emit for
 * the signature ONLY. Always removable; they never wrap body content.
 */
const SIG_SELECTORS_SAFE = [
  '#signature-block', '#clean-html',                      // Sarv
  '.gmail_signature', '[data-smartmail="gmail_signature"]', // Gmail
  '.moz-signature',                                        // Thunderbird
  '.AppleMailSignature', '#AppleMailSignature',            // Apple Mail
  '#ms-outlook-mobile-signature', '#outlook-signature',    // Outlook mobile
];

/**
 * GUARDED signature containers — broader markers that clients (esp. Outlook)
 * sometimes reuse to wrap real body content. Removed ONLY when short (a real
 * signature is small). This is what stops us eating a whole quoted history that
 * happens to sit in a `div[id*="signature"]`.
 */
const SIG_SELECTORS_GUARDED = [
  '#Signature', '#signature', 'div[id^="Signature"]',
  '.signature', 'div[class*="signature" i]', 'div[id*="signature" i]',
  'table.signature', '.sig',
];
/** Max characters for a GUARDED signature container to be treated as a signature. */
const SIG_GUARD_MAX_CHARS = 1200;

/** Trailing mobile/auto footers ("Sent from my iPhone", "Get Outlook for iOS"). */
const MOBILE_FOOTER_RE = /^(sent from my |get outlook for |sent via |sent from )/i;
/** RFC 3676 signature delimiter line ("-- "), and long underscore/dash rules. */
const SIG_DELIMITER_RE = /^(--|_{5,}|—{2,}|-{5,})\s*$/;

/**
 * Banner / disclaimer noise clients or gateways inject (external-sender
 * warnings, confidentiality footers). Only SHORT standalone lines that match
 * are dropped, so a real paragraph merely mentioning "confidential" survives.
 */
const BANNER_RE = /(external e-?mail|external sender|originated from outside|outside (of )?(the |your )?organi[sz]ation|caution\b|be cautious|do not (click|open)|unless you recognize the sender|you don'?t often get email from|some people who received this message don'?t often get|learn why this is important|this (e-?mail|message)\b.{0,80}\b(confidential|intended|privileged)|confidentiality notice|\bdisclaimer\b|intended (solely |only )?for the (use|addressee)|notify the sender|delete (it|this e-?mail)|\bconfidential\b)/i;
const BANNER_MAX_CHARS = 600;

/**
 * Legal footer OPENERS — unambiguous enough to remove the whole block even when
 * it's long (real disclaimers run several sentences), unlike the short weak
 * banners above. Anchored at the block start so prose that merely discusses a
 * disclaimer isn't touched.
 */
const DISCLAIMER_OPENER_RE = /^\s*(disclaimer\b|confidentiality (notice|statement|note)|this (e-?mail|message|communication|transmission)( and any (attachment|file)s?)?\s+(is|are|may|contains?)|the (information|contents?) (in|of|contained|transmitted)|this transmission (is|contains))/i;
const DISCLAIMER_MAX_CHARS = 2500;

/**
 * Trailing meeting-invite boilerplate (Teams/Webex join blocks) and the
 * forward/appointment separator Outlook prepends. Everything from the first
 * meeting-block line to the end is join plumbing, not conversation.
 */
const MEETING_BOILERPLATE_RE = /^(microsoft teams meeting|join on a video conferencing device|join the meeting now|meeting id:|_{5,}\s*(microsoft teams|join))/i;
/** Leading "-----Original Message-----" / "-----Original Appointment-----" markers. */
const FORWARD_MARKER_RE = /^\s*-{2,}\s*original (message|appointment)\s*-{2,}\s*$/i;

/** A phone number, and a website/email — a block with BOTH is unambiguously a signature card. */
const CONTACT_PHONE_RE = /\+?\d[\d ().-]{7,}\d/;
// No \b anchors: table cells concatenate without spaces (e.g. "…8623-14www.sarv.com"),
// so a word boundary before "www"/the email would fail to match.
const CONTACT_WEB_RE = /www\.[a-z0-9-]+\.[a-z]{2,}|https?:\/\/|[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;
/** Max text length for an image block to still count as a signature (not a real message). */
const IMAGE_SIG_MAX_CHARS = 400;

/** Quote wrappers whose descendants are OLDER messages (peeled separately). */
const QUOTE_SELECTORS = ['blockquote', '.gmail_quote', '.gmail_quote_container'];

export interface ParsedAttribution {
  name: string | null;
  email: string | null;
  date: number | null; // unix seconds
}

/**
 * Parse an attribution date in ANY of the shapes real clients emit
 * ("Thu, Jul 9, 2026 at 10:52 AM", "27 April 2026 18:31", "4/17/2026, 2:51:17 PM",
 * "27/04/26 03:55 PM"). Delegates to the shared DAY-FIRST parser so an
 * endian-ambiguous "07/08/2026" reads as 7 Aug (DD/MM) — the previous default
 * chrono parse read it as the US July 8, which is why the Standard (heuristic)
 * conversation view showed the wrong day while the AI view was correct.
 * Returns unix seconds, or null when nothing date-like is found.
 */
function parseLooseDate(raw: string | undefined | null): number | null {
  return parseHumanDateToEpochSec(raw);
}

/**
 * The tail of a timestamp — meridiem, timezone, or both — sitting at the START
 * of a captured name.
 *
 * The name captures below exclude digits and colons so the date can absorb the
 * whole timestamp, but "PM" and "IST" have neither, so a client that puts no
 * comma after the time (Outlook, several mobile clients) hands them to the name
 * instead. Anchored and repeated: "5:06 PM IST Ankur Dubey" gives up both.
 */
const LEADING_TIME_TAIL =
  /^(?:(?:[AP]\.?M\.?|GMT|UTC|IST|EST|EDT|PST|PDT|CST|CDT|CET|CEST|BST)\b[\s,]*)+/i;

/**
 * Parse an attribution date, taking back the time tail the name capture stole.
 *
 * Without this a "…at 5:06 PM Ankur Dubey <…>" line parses as 05:06 — the PM is
 * dropped on the floor with the rest of the name tidy-up — and the message
 * lands twelve hours early. In a chat view sorted by time that is not a
 * cosmetic error: an afternoon reply sorts ABOVE the morning message it was
 * answering, and the thread reads backwards.
 *
 * Only reattached to a date that actually ends in a time. "On 27 April 2026, PM
 * Sharma wrote:" is a person, not a meridiem, and appending it would turn a
 * date chrono parses into one it does not.
 */
function parseAttributionDate(date: string, nameBlob?: string | null): number | null {
  const trimmedDate = (date || '').trim();
  if (!/\d$/.test(trimmedDate)) return parseLooseDate(trimmedDate);
  const tail = (nameBlob || '').match(LEADING_TIME_TAIL)?.[0].replace(/[\s,]+$/, '');
  return parseLooseDate(tail ? `${trimmedDate} ${tail}` : trimmedDate);
}

/** First email address found in a blob, trimmed of trailing punctuation. */
function extractEmail(raw: string | undefined | null): string | null {
  const m = (raw || '').match(/[^\s<>,;:"']+@[^\s<>,;:"']+\.[^\s<>,;:"']+/);
  return m ? m[0].replace(/[.,;:>'"]+$/, '') : null;
}

/** Humanize an email local-part into a display name ("arun.iyer3" -> "Arun Iyer"). */
function deriveNameFromEmail(email: string | null): string | null {
  if (!email) return null;
  const local = email.split('@')[0].replace(/\d+/g, '');
  const words = local.split(/[._+-]+/).filter(Boolean);
  if (!words.length) return null;
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
}

/**
 * Tidy a captured attribution name: drop embedded <email> chunks and mangled
 * trailing domain remnants ("Arun Iyer partner.example>" — Outlook sometimes loses
 * the "<local@" of an address), strip a stray leading AM/PM/timezone token
 * (Gmail's "10:52 AM name" with no comma) and a trailing "via …" service
 * suffix. Falls back to a name derived from the email when nothing usable
 * remains, so a bubble never renders as "unknown".
 */
function cleanAttributionName(raw: string | undefined | null, email: string | null = null): string | null {
  const name = (raw || '')
    .replace(/<[^>]*>/g, ' ')                            // drop "<email>" chunks
    .replace(LEADING_TIME_TAIL, '')                      // "PM Ankur" -> "Ankur"; see parseAttributionDate
    .replace(/\s+via\s+.*$/i, '')                        // "Alice via Google Groups"
    .replace(/[\s,]*\b[\w-]+(?:\.[\w-]+)+>?\s*$/i, ' ')  // trailing domain remnant "partner.example>"
    .replace(/["'<>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return name || deriveNameFromEmail(email);
}

/** Parse a quote attribution line into sender + date. */
export function parseAttribution(text: string): ParsedAttribution | null {
  const t = (text || '').replace(/\s+/g, ' ').trim();
  if (!t) return null;

  // "On <date>, <name> <email> wrote:" — used by Gmail, Apple and Outlook, but
  // they punctuate differently: Gmail puts a comma after the time
  // ("…10:52 AM, mahesh kotak"), Outlook does not ("…11:02AM Madhav Sethi").
  // So we anchor on the NAME instead of the comma: the name is the run right
  // before <email> that has no digits or colons (dates/times always do, names
  // never do), which lets the date greedily absorb the whole timestamp either
  // way. A stray leading AM/PM (Gmail's "10:52 AM name" with no comma) is
  // trimmed off the name — and given back to the DATE by parseAttributionDate,
  // without which "5:06 PM Ankur" reads as 05:06 and sorts half a day early.
  let m = t.match(/^On\s+(.+?)[,\s]+([^<>@,\d:]+?)\s*<([^>\s]+@[^>\s]+)>\s*wrote:?/i);
  if (m) { const email = m[3].trim(); return { name: cleanAttributionName(m[2], email), email, date: parseAttributionDate(m[1], m[2]) }; }

  // Bare email, no angle brackets: "On 4/17/2026, 2:51:17 PM, arun.iyer3@partner.example wrote:".
  // Handles numeric-date Outlook/mobile lines AND emails containing digits
  // (which the name-based rule below deliberately excludes).
  m = t.match(/^On\s+(.+?)[,\s]+([^\s<>,]+@[^\s<>,]+)\s+wrote:?/i);
  if (m) { const email = extractEmail(m[2]); return { name: cleanAttributionName('', email), email, date: parseLooseDate(m[1]) }; }

  // Mangled address: "On <date> <name> domain> wrote:" — a client ate the
  // "<local@" of the address, leaving a bare "domain>" before "wrote:".
  m = t.match(/^On\s+(.+?)[,\s]+([^<>@,\d:]+?)\s+[\w.-]+\.\w{2,}>?\s*wrote:?/i);
  if (m) return { name: cleanAttributionName(m[2]), email: null, date: parseAttributionDate(m[1], m[2]) };

  // Name only, no address: "On <date>, <name> wrote:"
  m = t.match(/^On\s+(.+?)[,\s]+([^<>,\d:]+?)\s+wrote:?/i);
  if (m) return { name: cleanAttributionName(m[2]), email: null, date: parseAttributionDate(m[1], m[2]) };

  // Outlook: "From: <name> <email> Sent/Date: <date> To: …". Tolerant of
  // mangled addresses (Outlook can drop the "<local@" leaving "Name domain>"):
  // grab everything up to Sent/Date as the name blob, then pull the email out
  // of it if present and let cleanAttributionName tidy the remnant.
  m = t.match(/^From:\s*(.*?)\s*(?:Sent|Date):\s*(.+?)\s*(?:To:|Cc:|Subject:|$)/i);
  if (m) { const email = extractEmail(m[1]); return { name: cleanAttributionName(m[1], email), email, date: parseLooseDate(m[2]) }; }

  // Attribution with NO "wrote:" (Zoho `original-sender-line`, some mobile
  // clients): "On <date> <name> <email>". Requires a trailing email so a normal
  // sentence opening with "On …" can't be mistaken for an attribution.
  m = t.match(/^On\s+(.+?)[,\s]+([^<>@,\d:]+?)\s*<?([^\s<>,]+@[^\s<>,]+)>?\s*$/i);
  if (m) { const email = extractEmail(m[3]); return { name: cleanAttributionName(m[2], email), email, date: parseAttributionDate(m[1], m[2]) }; }

  return null;
}

/**
 * Remove `node` and everything AFTER it in document order, without touching
 * content before it. Walks up the ancestor chain removing following siblings
 * at each level (keeps the ancestors that also hold preceding content).
 */
function removeFromNodeOnward(node: Node, root: Node): void {
  let cur: Node | null = node;
  let first = true;
  while (cur && cur !== root && cur.parentNode) {
    while (cur.nextSibling) cur.parentNode.removeChild(cur.nextSibling);
    const parent: Node = cur.parentNode;
    if (first) { parent.removeChild(cur); first = false; }
    cur = parent;
  }
}

/** Remove elements matching any selector; optionally only when short (guarded). */
function removeBySelectors(root: Element, selectors: string[], maxChars = Infinity): void {
  for (const sel of selectors) {
    try {
      root.querySelectorAll(sel).forEach((el) => {
        if (el === root || el.contains(root)) return; // never remove the whole body
        if ((el.textContent || '').trim().length > maxChars) return; // too big to be this pattern
        el.remove();
      });
    } catch { /* invalid selector on this DOM — skip */ }
  }
}

/** Signature CONTAINERS: trusted markers always; broad markers only when short. */
function removeSignatureContainers(root: Element): void {
  removeBySelectors(root, SIG_SELECTORS_SAFE);
  removeBySelectors(root, SIG_SELECTORS_GUARDED, SIG_GUARD_MAX_CHARS);
}

/** Find the first standalone text LINE matching `predicate`; cut it + everything after. */
function cutFromMatchingLine(
  root: Element,
  predicate: (line: string) => boolean,
  maxLen: number,
): boolean {
  const doc = root.ownerDocument;
  if (!doc) return false;
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let n: Node | null;
  while ((n = walker.nextNode())) {
    const t = (n.textContent || '').replace(/\u00a0/g, ' ').trim();
    if (!t || t.length > maxLen) continue;
    if (predicate(t)) { removeFromNodeOnward(n, root); return true; }
  }
  return false;
}

/**
 * Flatten an element to TEXT with line structure preserved — `textContent`
 * glues `<div>a</div><div>b</div>` into "ab", which destroys exactly the line
 * boundaries a line-based reply parser needs.
 */
function domToText(root: Node): string {
  let out = '';
  const walk = (n: Node): void => {
    if (n.nodeType === 3) { out += (n.textContent || '').replace(/\u00a0/g, ' '); return; }
    if (n.nodeType !== 1) return;
    const el = n as Element;
    if (el.nodeName === 'BR') { out += '\n'; return; }
    const block = isBlockElement(el);
    if (block && out && !out.endsWith('\n')) out += '\n';
    Array.from(el.childNodes).forEach(walk);
    if (block && !out.endsWith('\n')) out += '\n';
  };
  walk(root);
  return out;
}

/** Longest signature line we'll anchor a cut on (a real sign-off line is short). */
const SIGN_OFF_MAX_LINE = 120;
/** A signature bigger than this is almost certainly a misfire — don't cut. */
const SIGN_OFF_MAX_CHARS = 600;
/** …nor may it be more than this share of the message. */
const SIGN_OFF_MAX_SHARE = 0.4;
/** Minimum message left standing after a cut ("Thanks, Alice" is not all sig). */
const SIGN_OFF_MIN_KEPT = 40;

/**
 * Everything from the LAST sign-off line onward.
 *
 * NOT email-reply-parser, deliberately. That library is what the contact miner
 * uses in the MAIN process, but it cannot run in the renderer: `regex.js` does a
 * bare `require("re2")` to pick up an optional native regex engine, and although
 * the call sits in a try/catch, a bundled renderer has no `require` at all — the
 * esbuild shim throws "Dynamic require of module is not supported" before the
 * catch can swallow it, blanking the window.
 *
 * Little is lost. Its signature rules are separators, "Sent from …", "Regards"
 * and "Cheers" — the first two we already cut in cutAtSignatureDelimiter /
 * cutAtMobileFooter, and all of them appear in SIGNATURE_DELIMITERS, which the
 * contact miner uses for this exact question and which core now shares. It has
 * no rule at all for a bare "Thanks", the sign-off most of this mailbox uses and
 * the one that left signature cards sitting in the bubbles.
 *
 * The LAST match, not the first: "Thanks for the quick turnaround" early in a
 * message would otherwise anchor the cut at the top and take everything.
 */
function signOffSignature(text: string): string | null {
  let cutAt = -1;
  for (const pattern of SIGNATURE_DELIMITERS) {
    // Patterns are module-level and some carry /g-adjacent flags; build a
    // global copy so lastIndex state can never leak between calls.
    const scan = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
    for (let m = scan.exec(text); m; m = scan.exec(text)) {
      if (m.index > cutAt) cutAt = m.index;
      if (m[0].length === 0) break; // zero-width match — cannot advance
    }
  }
  return cutAt < 0 ? null : text.slice(cutAt).trim() || null;
}

/** Job-title / role line, the kind a signature (never the body) carries. */
const SIG_TITLE_RE = /\b(engineer|developer|manager|director|founder|co-?founder|ceo|cto|coo|cfo|vp|consultant|analyst|architect|officer|executive|president|head\s+of|specialist|coordinator|administrator|lead|associate|designer|marketer|advocate|evangelist)\b/i;

/** Distinct web domains in a blob (sarv.com, wave.sarv.com, enquiry.ai …). */
function distinctDomainCount(text: string): number {
  const doms = new Set<string>();
  const re = /(?:www\.|https?:\/\/)?([a-z0-9-]+(?:\.[a-z0-9-]+)+)/gi;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const d = m[1].toLowerCase();
    if (/\.[a-z]{2,}$/.test(d) && !d.includes('@')) doms.add(d);
    if (m[0].length === 0) break;
  }
  return doms.size;
}

/**
 * Unambiguous signature evidence in a sign-off block: a job title, OR two-plus
 * distinct web domains (the "company | product | product" links strip Sarv/
 * corporate signatures emit). Present → let the cut run past the normal size /
 * share guards, since a short "here are the details" mail whose second half is a
 * full contact card is common and the card is definitely not the message.
 */
function hasStrongSignatureEvidence(sig: string): boolean {
  return SIG_TITLE_RE.test(sig) || distinctDomainCount(sig) >= 2;
}

/**
 * Cut the sender's sign-off block.
 *
 * The other rules here all need an explicit marker: an RFC-3676 "-- " line, a
 * known wrapper class, a graphical contact card. None of them can see the
 * ordinary "Thanks\n\nName\nTitle" sign-off that most people actually write,
 * which is why signatures kept showing up in chat bubbles. This finds where that
 * block starts and hands the position to the existing DOM cutter, so one code
 * path still owns "cut from here to the end".
 *
 * Guards keep a misfire from eating the message: the anchor line must be short,
 * the signature must be a minority of the text, and enough must remain (a
 * one-line "Thanks, Alice" reply is ALL sign-off and must survive). But when the
 * block carries UNAMBIGUOUS signature evidence — a job title or a multi-domain
 * links strip — the size/share limits are loosened, because such a block is
 * never the message even when it's half of a short note.
 */
function cutAtSignOff(root: Element): void {
  const text = domToText(root);
  if (!text.trim()) return;
  const signature = signOffSignature(text);
  if (!signature) return;
  const strong = hasStrongSignatureEvidence(signature);
  const maxChars = strong ? 900 : SIGN_OFF_MAX_CHARS;
  const maxShare = strong ? 0.8 : SIGN_OFF_MAX_SHARE;
  if (signature.length > maxChars) return;
  if (signature.length > text.trim().length * maxShare) return;

  const anchor = signature.split('\n').map((l) => l.trim()).find(Boolean);
  if (!anchor || anchor.length > SIGN_OFF_MAX_LINE) return;

  const kept = text.slice(0, text.indexOf(anchor));
  if (kept.replace(/\s+/g, '').length < SIGN_OFF_MIN_KEPT) return;

  cutFromMatchingLine(root, (t) => t === anchor, SIGN_OFF_MAX_LINE + 20);
}

/** RFC 3676 "-- " delimiter and long underscore/em-dash rules cut to the end. */
function cutAtSignatureDelimiter(root: Element): void {
  // maxLen is generous because SIG_DELIMITER_RE requires the WHOLE line to be
  // rule characters — a 60-underscore Outlook separator is still a delimiter.
  cutFromMatchingLine(root, (t) => SIG_DELIMITER_RE.test(t), 200);
}

/** Trailing "Sent from my …" mobile footers cut to the end. */
function cutAtMobileFooter(root: Element): void {
  cutFromMatchingLine(root, (t) => MOBILE_FOOTER_RE.test(t), 60);
}

/** Trailing Teams/Webex meeting-join boilerplate cut to the end. */
function cutAtMeetingBoilerplate(root: Element): void {
  cutFromMatchingLine(root, (t) => MEETING_BOILERPLATE_RE.test(t), 80);
}

/**
 * Remove standalone text LINES matching `predicate` WITHOUT cutting what
 * follows (unlike cutFromMatchingLine). Used for one-off markers such as
 * "-----Original Appointment-----" that sit inline above real content.
 */
function removeMatchingLines(root: Element, predicate: (line: string) => boolean, maxLen: number): void {
  const doc = root.ownerDocument;
  if (!doc) return;
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const victims: Node[] = [];
  let n: Node | null;
  while ((n = walker.nextNode())) {
    const t = (n.textContent || '').replace(/\s+/g, ' ').trim();
    if (t && t.length <= maxLen && predicate(t)) victims.push(n);
  }
  victims.forEach((v) => v.parentNode?.removeChild(v));
}

/** Drop leading "-----Original Message/Appointment-----" forward markers. */
function removeForwardMarkers(root: Element): void {
  removeMatchingLines(root, (t) => FORWARD_MARKER_RE.test(t), 60);
}

/**
 * Remove encoded-junk blobs — a long UNBROKEN base64 run (e.g. a base64-encoded
 * HTML part, key, or token that leaked into the body as text). The run must be
 * whitespace-free: real prose always has spaces within 60 chars, so it is never
 * matched; URLs/JWTs break on `.`/`:` which the charset excludes, so a link
 * can't be eaten either. Each blob line is its own text node, so removing the
 * matching text nodes clears the whole wall.
 */
function removeGibberishBlobs(root: Element): void {
  const doc = root.ownerDocument;
  if (!doc) return;
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const victims: Node[] = [];
  let n: Node | null;
  while ((n = walker.nextNode())) {
    if (/[A-Za-z0-9+/=]{60,}/.test(n.textContent || '')) victims.push(n);
  }
  victims.forEach((v) => v.parentNode?.removeChild(v));
}

/** A banner match on a SHORT text blob (guards against nuking real paragraphs). */
function isBannerText(text: string): boolean {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > 0 && t.length <= BANNER_MAX_CHARS && BANNER_RE.test(t);
}

/** True when this block's text is PURE banner: every non-empty leaf is a banner. */
function isPureBannerBlock(el: Element): boolean {
  const leaves = el.querySelectorAll('p, div, td, li, span, font');
  let sawBanner = false;
  for (const leaf of Array.from(leaves)) {
    if (leaf.querySelector('p, div, table, ul, ol, blockquote')) continue; // not a leaf
    const t = (leaf.textContent || '').replace(/\s+/g, ' ').trim();
    if (!t) continue;
    if (!isBannerText(t)) return false; // real content lives here — keep the block
    sawBanner = true;
  }
  // No leaf elements (e.g. <div>External Email…</div>) — judge the whole text.
  if (!sawBanner) return isBannerText(el.textContent || '');
  return true;
}

/** Remove blocks that BEGIN with a legal-disclaimer opener (long footers). */
function removeDisclaimers(root: Element): void {
  root.querySelectorAll('p, div, td, blockquote, span, font, tr, table').forEach((el) => {
    if (el === root || el.contains(root) || el.querySelector('blockquote')) return;
    const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
    if (t.length > 0 && t.length <= DISCLAIMER_MAX_CHARS && DISCLAIMER_OPENER_RE.test(t)) el.remove();
  });
  // Also handle a disclaimer that starts as a bare text line (no wrapper);
  // disclaimers are always trailing, so cutting to the end is safe.
  cutFromMatchingLine(root, (t) => DISCLAIMER_OPENER_RE.test(t), DISCLAIMER_MAX_CHARS);
}

/** Drop standalone banner/disclaimer noise (external-email, confidentiality). */
function removeBanners(root: Element): void {
  removeDisclaimers(root);
  // Pass 1 — warning BOXES: a whole <table>/<div> whose content is NOTHING but
  // banner text (Outlook wraps external-email warnings in a styled table). A
  // message that merely mentions "confidential" has a non-banner leaf, so it is
  // spared here; its banner line is handled by pass 2. Quote wrappers are never
  // touched so we can't drop an actual older message.
  root.querySelectorAll('table, div').forEach((el) => {
    if (el === root || el.contains(root) || el.querySelector('blockquote')) return;
    if (isPureBannerBlock(el)) el.remove();
  });
  // Pass 2 — leaf-ish LINES: a standalone p/span/font banner line inside an
  // otherwise-real block. Skip blocks with block children so we never cut a
  // real paragraph that merely mentions "confidential".
  root.querySelectorAll('p, div, td, blockquote, span, font').forEach((el) => {
    if (el.querySelector('p, div, table, ul, ol, blockquote')) return;
    if (isBannerText(el.textContent || '')) el.remove();
  });
  // Pass 3 — bare TEXT lines: a short banner sitting as a naked text node
  // between <br>s ("Acme Confidential", "External Email: …"). These have no
  // element of their own, so passes 1-2 miss them. Capped short so a real
  // sentence that merely mentions "confidential" is left alone. Removing them
  // also stabilizes the dedup key (a quoted copy and the original now match).
  removeMatchingLines(root, (t) => BANNER_RE.test(t), 80);
}

/**
 * A graphical signature card: an <img> plus SHORT text carrying BOTH a phone
 * number AND a website/email. Requiring both (not just one) is what keeps a
 * real short message that merely embeds a picture and a link from being
 * mistaken for a signature — a genuine sig card lists name/title/phone/site.
 */
function isContactCard(el: Element): boolean {
  // A logo image OR a <table> layout — the two shapes rich signatures use.
  // (A text-only sig with no image is still table-structured.)
  if (!el.querySelector('img') && el.tagName !== 'TABLE') return false;
  const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
  if (text.length > IMAGE_SIG_MAX_CHARS) return false;
  // Classic card: phone + site. OR a links strip with two+ distinct domains
  // (Sarv-style "sarv.com | deepcall.com | wave.sarv.com | enquiry.ai" — a
  // signature even without a phone number).
  return (CONTACT_PHONE_RE.test(text) && CONTACT_WEB_RE.test(text)) || distinctDomainCount(text) >= 2;
}

/** A block whose only real content is image(s) — e.g. a trailing brand-logo strip. */
function isImageOnlyBlock(el: Element): boolean {
  return !!el.querySelector('img') && (el.textContent || '').replace(/\s+/g, ' ').trim().length < 48;
}

/**
 * Strip graphical signatures that carry no class marker: contact cards (logo
 * image + name/title/phone/website, as Sarv/Outlook rich signatures emit) and
 * any brand-logo strip after them. A card is required to hold BOTH a phone and
 * a site, so it's unambiguously a signature — we remove every occurrence (they
 * recur at each quote level) rather than only the trailing one.
 */
function removeImageSignature(root: Element): void {
  const cards = Array.from(root.querySelectorAll('table, div')).filter((el) => {
    if (!el.parentNode || el === root || el.contains(root) || el.querySelector('blockquote')) return false;
    return isContactCard(el);
  });
  // Only the INNERMOST match. A short message whose wrapper <div> holds both the
  // text and the signature card matches isContactCard itself (it contains the
  // card's phone and website, and the whole thing is under the length cap), so
  // removing every match deleted the entire message — the card AND the words
  // above it. Dropping any candidate that contains another leaves just the card.
  cards
    .filter((el) => !cards.some((other) => other !== el && el.contains(other)))
    .forEach((el) => el.remove());
  // Brand-logo strips: a block with 2+ images and almost no text (e.g. a
  // "DeepCall | Deep Enrich | Workspace 365" footer row). These are signature
  // furniture, not content, and can sit above other quoted text, so remove them
  // wherever they appear — not only when trailing.
  Array.from(root.querySelectorAll('table, div, p')).forEach((el) => {
    if (!el.parentNode || el === root || el.querySelector('blockquote')) return;
    if (el.querySelectorAll('img').length >= 2 && (el.textContent || '').replace(/\s+/g, ' ').trim().length < 48) el.remove();
  });
  // Trim leftover trailing image-only blocks (brand-logo strips below the card).
  let last = root.lastElementChild;
  while (last && (isImageOnlyBlock(last) || isEmptyElement(last))) {
    const prev = last.previousElementSibling;
    last.remove();
    last = prev;
  }
}

/**
 * Provider-agnostic signature / banner / boilerplate stripping, composed from
 * the small pattern helpers above so each rule is independently testable and
 * easy to enrich as new provider patterns show up:
 *   - removeForwardMarkers:      "-----Original Message/Appointment-----" lines
 *   - removeSignatureContainers: known wrapper markers (Gmail/Outlook/Apple/…)
 *   - removeImageSignature:      graphical contact-card / brand-logo signatures
 *   - removeBanners:             external-email / confidentiality disclaimers
 *   - cutAtMeetingBoilerplate:   trailing Teams/Webex join blocks
 *   - cutAtSignatureDelimiter:   "-- " / long rule lines to end
 *   - cutAtMobileFooter:         "Sent from my …" to end
 */
function stripSignatures(root: Element): void {
  removeForwardMarkers(root);
  removeSignatureContainers(root);
  removeImageSignature(root);
  removeBanners(root);
  cutAtMeetingBoilerplate(root);
  cutAtSignatureDelimiter(root);
  cutAtMobileFooter(root);
  cutAtSignOff(root);
}

/**
 * The MINIMAL subset of the strip chain — only the rules that need an
 * unambiguous signature marker and never rewrite the document's structure.
 *
 * This is what a single-message body (no quote boundaries) gets. The full chain
 * unwraps blockquotes and indent divs and cuts on weak banner text, which is
 * what mangled designed notifications and made us render such bodies verbatim
 * instead — but "verbatim" also meant the sender's signature card stayed in the
 * bubble, logo strip and all. These four rules each require hard evidence (a
 * known wrapper class, a contact card carrying BOTH a phone and a website, an
 * RFC-3676 rule line, a "Sent from my …" footer, or a known sign-off line), so
 * they take the signature without touching the layout around it.
 */
function stripSignaturesMinimal(root: Element): void {
  removeSignatureContainers(root);
  removeImageSignature(root);
  cutAtSignatureDelimiter(root);
  cutAtMobileFooter(root);
  cutAtSignOff(root);
}

/** Drop leading/trailing empty blocks, <br> runs and &nbsp; so bubbles hug their text. */
function trimEmptyEdges(html: string): string {
  // Leading strip matches only at index 0 (no start-position scan) → linear.
  let out = html.replace(
    /^(?:\s|&nbsp;|<br\s*\/?>|<p>\s*<\/p>|<div>\s*<\/div>|<p>\s*&nbsp;\s*<\/p>|<div>\s*&nbsp;\s*<\/div>)+/gi,
    '',
  );
  // Trailing strip windowed: the `(?:…)+$` form scans every start position, so
  // on a large body it is O(n^2) (~200ms at 36KB, ~3.5s at 200KB) and would
  // stall extraction. Windowing keeps it linear and byte-identical. Single
  // pass matches the original (this alternation doesn't peel nested wrappers).
  out = trimTrailingWindowed(out, (tail) =>
    tail.replace(
      /(?:\s|&nbsp;|<br\s*\/?>|<p>\s*<\/p>|<div>\s*<\/div>|<p>\s*&nbsp;\s*<\/p>|<div>\s*&nbsp;\s*<\/div>)+$/i,
      '',
    ),
  );
  return out.replace(/(?:<br\s*\/?>\s*){3,}/gi, '<br><br>').trim();
}

/** An element that holds no visible content (no text, no media). */
function isEmptyElement(el: Element): boolean {
  if (el.querySelector('img, table, hr, video, svg, input, button')) return false;
  return !(el.textContent || '').trim();
}

/**
 * DOM-level trim of leading/trailing empties (whitespace text, <br>, empty
 * blocks) — recursing into the last/first element so nested trailing breaks
 * like `<p style="…">text<br></p><br><br>` are removed. This is what a string
 * regex can't reach and is why bubbles showed blank space after the message.
 */
function trimEdgeEmpties(root: Node): void {
  const stripEnd = (parent: Node): void => {
    let last = parent.lastChild;
    while (last) {
      if (last.nodeType === 3) { // text
        if ((last.textContent || '').trim()) break;
        const prev = last.previousSibling; last.parentNode?.removeChild(last); last = prev; continue;
      }
      if (last.nodeType === 1) { // element
        const el = last as Element;
        if (el.nodeName === 'BR' || isEmptyElement(el)) {
          const prev = last.previousSibling; el.remove(); last = prev; continue;
        }
        stripEnd(el); break; // last real element — trim its inner trailing empties
      }
      break;
    }
  };
  const stripStart = (parent: Node): void => {
    let first = parent.firstChild;
    while (first) {
      if (first.nodeType === 3) {
        if ((first.textContent || '').trim()) break;
        const next = first.nextSibling; first.parentNode?.removeChild(first); first = next; continue;
      }
      if (first.nodeType === 1) {
        const el = first as Element;
        if (el.nodeName === 'BR' || isEmptyElement(el)) {
          const next = first.nextSibling; el.remove(); first = next; continue;
        }
        stripStart(el); break;
      }
      break;
    }
  };
  stripStart(root);
  stripEnd(root);
}

/**
 * Clean ONE segment (in place): unwrap quote wrappers so the message text isn't
 * indented into oblivion, drop stray attribution lines, strip signatures, and
 * trim blank edges. Word/Outlook `mso`/inline styling is stripped downstream by
 * the bubble's SandboxedEmailBody(normalize), so we don't fight it here.
 */
function cleanFragmentHtml(node: Element): string {
  const unwrap = (el: Element): void => {
    while (el.firstChild) el.parentNode?.insertBefore(el.firstChild, el);
    el.remove();
  };
  node.querySelectorAll(QUOTE_SELECTORS.join(',')).forEach(unwrap);
  // Quote-INDENT wrappers: bare <div>s Outlook/Apple/Gmail use to draw a left
  // rule down quoted text (border-left + padding-left). We've already split the
  // quoted messages into their own bubbles, so a leftover indent bar is just
  // noise — unwrap it (keeping the content) unless the border is explicitly off.
  node.querySelectorAll('div[style*="border-left"]').forEach((el) => {
    if (/border-left\s*:\s*(?:none|0)/i.test(el.getAttribute('style') || '')) return;
    unwrap(el);
  });
  node.querySelectorAll('.gmail_attr').forEach((el) => el.remove());
  stripSignatures(node);
  removeGibberishBlobs(node);
  // Collapse INTERNAL blank-line blocks (empty <p>/<div>, usually "<p><br></p>"
  // that senders stack between lines) — they render as big vertical gaps in the
  // bubble. The bubble frame + normalized paragraph margins already separate
  // real paragraphs, so these add nothing but space. (trimEdgeEmpties only
  // handles the leading/trailing ones.)
  node.querySelectorAll('p, div').forEach((el) => { if (isEmptyElement(el)) el.remove(); });
  trimEdgeEmpties(node);
  // Shared with the raw single-email view — one implementation of "a run of
  // blank lines becomes one" rather than a second copy that drifts from it.
  return collapseExcessBlankSpace(trimEmptyEdges(node.innerHTML));
}

interface Segment { attribution: ParsedAttribution | null; html: string; }

/**
 * A quote boundary is either a Gmail `.gmail_attr` element or a header LINE —
 * Outlook "From: … Sent/Date: …" or plain "On … wrote:". Detected on element
 * text so it works whether the client used blockquotes, Word tables, or bare
 * `<p>`/`<div>` header blocks.
 */
const HEADER_RE = /^\s*(?:from:[\s\S]{0,400}?(?:sent|date):|on\b[\s\S]{1,220}?wrote\s*:)/i;

/**
 * Class markers clients wrap an attribution line in. These are boundaries even
 * without a trailing "wrote:" — Zoho's `original-sender-line` and Apple's
 * `moz-cite-prefix` render "On <date> <name> <email>" with no "wrote:", which
 * HEADER_RE alone would miss (leaving the entire quoted history in one bubble).
 */
const ATTR_MARKER_SELECTOR = '.original-sender-line, .gmail_attr, .moz-cite-prefix, .OutlookMessageHeader';

/**
 * A quote boundary described by DOM positions, so it works whether the
 * attribution is its own element (Gmail `.gmail_attr`, an Outlook header `<p>`)
 * OR just a `<br>`-delimited LINE sitting inside a block that also holds the
 * sender's sign-off (e.g. "Bindu Yagnik<br>On 27/04/26 …, Advik <…> wrote:").
 * `endBefore`/`startAfter` bracket the attribution line so it is excluded from
 * both the message above and the quoted message below.
 */
interface Boundary {
  endBefore: Node;  // previous segment ends before this node
  startAfter: Node; // quoted segment starts after this node
  ref: Node;        // position used for ordering + overlap removal (== endBefore)
  attribution: ParsedAttribution | null;
}

const BLOCK_TAGS = new Set(['DIV', 'P', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TD', 'BLOCKQUOTE', 'UL', 'OL', 'LI', 'HR']);
const isBlockElement = (n: Node): boolean => n.nodeType === 1 && BLOCK_TAGS.has(n.nodeName);

/**
 * From a visual-line-start node, gather the rest of the LINE: walk following
 * siblings, accumulating text, stopping at the first <br> (its terminator) or a
 * block element (line ends before it).
 */
function collectInlineLine(start: Node): { text: string; last: Node; terminator: Node | null } {
  let text = '';
  let last = start;
  let node: Node | null = start;
  let terminator: Node | null = null;
  while (node) {
    if (node.nodeName === 'BR') { terminator = node; break; }
    if (node !== start && isBlockElement(node)) break; // next block starts a new line
    text += node.textContent || '';
    last = node;
    node = node.nextSibling;
  }
  return { text, last, terminator };
}

/** First child of `el` that carries visible content (skips blank text nodes). */
function firstMeaningfulChild(el: Element): Node | null {
  let f = el.firstChild;
  while (f && f.nodeType === 3 && !(f.textContent || '').trim()) f = f.nextSibling;
  return f;
}

/** Start of a forwarded/Outlook header label line ("From:", "Sent:", "When:", …). */
const HEADER_START_RE = /^(from|to|cc|bcc|sent|date|subject|reply-to|importance|when|where)\s*:/i;

/**
 * Build the full attribution LINE beginning at `start`. An "On … wrote:" line
 * ends at its first <br>/block. An Outlook / calendar "From:" header spans
 * several <br>-separated label lines (From:/Sent:/To:/Subject:/When:/Where:),
 * so once the line opens with a header label we keep swallowing following label
 * lines into one logical line — which both detects the header AND lets the
 * whole block be consumed as the boundary (no header renders as a bubble).
 */
function collectAttributionLine(start: Node): { text: string; last: Node; terminator: Node | null } {
  let { text, last, terminator } = collectInlineLine(start);
  if (HEADER_START_RE.test(text.replace(/\s+/g, ' ').trim())) {
    while (terminator && terminator.nodeName === 'BR') {
      let next: Node | null = terminator.nextSibling;
      while (next && next.nodeType === 3 && !(next.textContent || '').trim()) next = next.nextSibling;
      if (!next || isBlockElement(next)) break;
      const line = collectInlineLine(next);
      if (!HEADER_START_RE.test(line.text.replace(/\s+/g, ' ').trim())) break;
      text += ` ${line.text}`;
      last = line.last;
      terminator = line.terminator;
    }
  }
  return { text, last, terminator };
}

/** Candidate visual-line-start nodes: first child of every block + node after each <br>. */
function lineStartNodes(body: Element): Node[] {
  const starts = new Set<Node>();
  body.querySelectorAll('div, p, td, li, blockquote, span, a, font').forEach((el) => {
    const f = firstMeaningfulChild(el);
    if (f && !isBlockElement(f)) starts.add(f);
  });
  body.querySelectorAll('br').forEach((br) => {
    let s: Node | null = br.nextSibling;
    while (s && s.nodeType === 3 && !(s.textContent || '').trim()) s = s.nextSibling;
    if (s && !isBlockElement(s)) starts.add(s);
  });
  return [...starts];
}

/**
 * Ordered, non-overlapping quote boundaries detected at LINE precision. Works
 * whether the attribution is its own element (Gmail `.gmail_attr`, an Outlook
 * header block), an inline "…wrote:" line after a <br> ("Bindu Yagnik<br>On …
 * wrote:"), or the leading line of a <div> that ALSO contains the quoted reply
 * (nested Outlook forwards) — the earlier element-only model dropped that last
 * case and leaked the quoted message into the parent bubble.
 */
function findBoundaries(body: Element): Boundary[] {
  const FOLLOWING = Node.DOCUMENT_POSITION_FOLLOWING;
  const CONTAINED = Node.DOCUMENT_POSITION_CONTAINED_BY;
  const cands: Boundary[] = [];
  for (const start of lineStartNodes(body)) {
    const { text, last, terminator } = collectAttributionLine(start);
    const line = text.replace(/\s+/g, ' ').trim();
    if (line.length < 8 || line.length > 2000) continue;
    const attr = parseAttribution(line);
    // A boundary is either a "wrote:"/Outlook header (HEADER_RE) OR a short
    // "On <date> <name> <email>" line with no "wrote:" (Zoho and some clients
    // omit it) — the latter only when it parses to a real date AND email, so a
    // prose sentence opening with "On …" can't masquerade as an attribution.
    const isAttribution = HEADER_RE.test(line) || (!!attr && !!attr.email && attr.date != null && line.length <= 160);
    if (!isAttribution) continue;
    cands.push({ endBefore: start, startAfter: terminator || last, ref: start, attribution: attr });
  }
  // Attribution-marker elements (Zoho/Apple/Outlook) are boundaries even without
  // a trailing "wrote:". Overlap removal below dedupes any that also matched as a
  // line above. The whole element is the attribution, so the quoted reply that
  // follows it becomes the next segment.
  body.querySelectorAll(ATTR_MARKER_SELECTOR).forEach((el) => {
    const line = (el.textContent || '').replace(/\s+/g, ' ').trim();
    if (line.length < 8 || line.length > 2000 || !/^\s*(?:on\b|from\s*:)/i.test(line)) return;
    cands.push({ endBefore: el, startAfter: el, ref: el, attribution: parseAttribution(line) });
  });
  // SHORT attribution-only elements whose full text matches HEADER_RE. Catches
  // attributions fragmented across nested inline/block children (e.g. mangled
  // markup where "…name <email> wrote:" got split so the "wrote:" lands in a
  // child block). Bounded to ≤240 chars so an element that ALSO wraps the quoted
  // reply (which line detection handles) is never swallowed here.
  body.querySelectorAll('div, p, td, span').forEach((el) => {
    const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
    if (t.length >= 8 && t.length <= 240 && HEADER_RE.test(t)) {
      cands.push({ endBefore: el, startAfter: el, ref: el, attribution: parseAttribution(t) });
    }
  });
  cands.sort((a, b) => (a.ref.compareDocumentPosition(b.ref) & FOLLOWING ? -1 : 1));
  // Keep a boundary only when it starts strictly AFTER the previous boundary's
  // consumed region (not before it and not nested inside it) — collapses the
  // duplicate anchors an ancestor+descendant line-start pair produces.
  const kept: Boundary[] = [];
  let lastEnd: Node | null = null;
  for (const b of cands) {
    if (lastEnd) {
      const pos = lastEnd.compareDocumentPosition(b.ref);
      if (!(pos & FOLLOWING) || pos & CONTAINED) continue;
    }
    kept.push(b);
    lastEnd = b.startAfter;
  }
  return kept;
}

/**
 * Split ONE email body into segments (newest first): the sender's own message,
 * then each embedded quoted message. Uses DOM Ranges between consecutive
 * boundaries, which extracts document-order content correctly whether the
 * quotes are nested (Gmail), a flat header-block chain (Outlook/Word), or an
 * inline "…wrote:" line sharing a block with the reply above it.
 */
function splitEmailBody(html: string): Segment[] {
  if (typeof DOMParser === 'undefined') return [{ attribution: null, html }];
  let doc: Document;
  try { doc = new DOMParser().parseFromString(html || '', 'text/html'); }
  catch { return [{ attribution: null, html }]; }
  const body = doc.body;

  // NB: signatures/banners are stripped PER SEGMENT in cleanFragmentHtml, never
  // up front — an up-front sweep would delete quoted headers and collapse the
  // thread back into a few bubbles. findBoundaries must see the full body first.
  const cleanRange = (range: Range): string => {
    const wrap = doc.createElement('div');
    wrap.appendChild(range.cloneContents());
    return cleanFragmentHtml(wrap);
  };

  const boundaries = findBoundaries(body);
  if (boundaries.length === 0) {
    // A standalone email with NO embedded quotes is not a conversation to split —
    // the whole body IS the one message. The FULL cleaner must not run over it:
    // unwrapping its blockquotes / indent divs and cutting on weak banner text
    // mangled and truncated designed notifications (e.g. a task-tracker update
    // whose comment sits in an inline-styled blockquote).
    //
    // But passing it through completely untouched was too far the other way —
    // the sender's signature card, logo strip and trailing blank space all
    // stayed in the bubble. So run only the MINIMAL, marker-required rules and
    // the blank-space collapse. Structure is preserved; heavy HTML still renders
    // as it arrived.
    const solo = doc.createElement('div');
    solo.innerHTML = html;
    stripSignaturesMinimal(solo);
    trimEdgeEmpties(solo);
    const cleaned = collapseExcessBlankSpace(trimEmptyEdges(solo.innerHTML));
    // Never let the minimal pass empty a message — fall back to the original.
    const hasText = cleaned.replace(/<[^>]*>/g, '').trim().length > 0;
    return [{ attribution: null, html: hasText ? cleaned : html }];
  }

  const segments: Segment[] = [];
  // Own message = everything before the first boundary's attribution line.
  const head = doc.createRange();
  head.selectNodeContents(body);
  try { head.setEndBefore(boundaries[0].endBefore); } catch { /* leave full */ }
  segments.push({ attribution: null, html: cleanRange(head) });

  // Each quoted message = content from after its header to the next header.
  boundaries.forEach((b, i) => {
    const r = doc.createRange();
    try {
      r.setStartAfter(b.startAfter);
      if (i + 1 < boundaries.length) r.setEndBefore(boundaries[i + 1].endBefore);
      else r.setEnd(body, body.childNodes.length);
    } catch { return; }
    segments.push({ attribution: b.attribution, html: cleanRange(r) });
  });

  return segments.filter((s) => s.html && s.html.replace(/<[^>]*>/g, '').trim().length > 0);
}

/**
 * Normalized text key for de-duplication (same message quoted across many
 * replies). Strips tags/entities then ALL non-alphanumerics, so cosmetic
 * differences between an original and its quoted copy — a trailing space, an
 * `@mention` rendered as plain text vs a link, `&nbsp;` vs space, punctuation
 * spacing — collapse to the same key and the copies merge into one bubble.
 */
function contentKey(html: string): string {
  return (html || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&[a-z]+;/gi, ' ')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .slice(0, 150);
}

/**
 * Build an ordered, de-duplicated conversation from a thread's emails without
 * any AI. Returns ConversationMessage[] (same shape the AI extractor emits) so
 * the existing chat bubble renderer can display it directly.
 */
export function buildDeterministicConversation(
  emails: EmailRecord[],
  _currentUserEmail: string,
): ConversationMessage[] {
  const sorted = [...emails].filter((e) => !(e.tags || '').includes('|draft|')).sort((a, b) => a.date - b.date);
  if (sorted.length === 0) return [];

  // Collect candidate messages from every email's segments. Each real email's
  // OWN segment (attribution === null) is authoritative for its sender/date.
  type Cand = { key: string; from: string; fromName: string | null; to: string; date: number; dateApprox: boolean; html: string; sourceId: string; real: boolean; order: number };
  const cands: Cand[] = [];
  let order = 0;

  for (const email of sorted) {
    const segs = splitEmailBody(email.rawBody || email.cleanBody || '');
    segs.forEach((seg, i) => {
      const isOwn = i === 0 && seg.attribution === null;
      const from = isOwn ? email.fromAddress : (seg.attribution?.email || seg.attribution?.name || 'unknown');
      const fromName = isOwn ? (email.fromName ?? null) : (seg.attribution?.name ?? null);
      const date = isOwn ? email.date : (seg.attribution?.date ?? 0);
      cands.push({
        key: contentKey(seg.html),
        from,
        fromName,
        to: email.toAddress || '',
        date,
        dateApprox: !isOwn && !seg.attribution?.date,
        html: seg.html,
        sourceId: email.id,
        real: isOwn,
        order: order++,
      });
    });
  }

  // De-dup by content key: a message QUOTED across many replies collapses to
  // one. A REAL (own-segment) email is authoritative and is ALWAYS kept — even
  // if its content key is empty or collides with another email — so a real
  // email can never silently vanish from the standard chat view (it stays
  // visible in the standard email view, and the two must not diverge). Only
  // quoted (non-real) segments collapse: dropped when their content already
  // appears in a real email or an earlier-kept quoted copy.
  const realKeys = new Set(cands.filter((c) => c.real && c.key).map((c) => c.key));
  const keptQuotedKeys = new Set<string>();
  const merged: Cand[] = [];
  for (const c of cands) {
    if (c.real) { merged.push(c); continue; }        // real own-segment → always keep
    if (!c.key) continue;                             // empty quoted noise → drop
    if (realKeys.has(c.key) || keptQuotedKeys.has(c.key)) continue; // quoted dup → collapse
    keptQuotedKeys.add(c.key);
    merged.push(c);
  }
  // Approximate missing dates from neighbours so ordering + date groups work.
  merged.sort((a, b) => (a.date || 0) - (b.date || 0) || a.order - b.order);
  let lastKnown = merged.find((m) => m.date > 0)?.date ?? Math.floor(Date.now() / 1000);
  for (const m of merged) {
    if (m.date > 0) lastKnown = m.date;
    else { m.date = lastKnown; m.dateApprox = true; }
  }
  merged.sort((a, b) => a.date - b.date || a.order - b.order);

  return merged.map((m, i) => ({
    id: m.real ? m.sourceId : `logical-${i}`,
    fromAddress: m.from,
    fromName: m.fromName,
    toAddress: m.to,
    date: m.date,
    dateApprox: m.dateApprox,
    body: m.html,
    isExtracted: !m.real,
    sourceEmailId: m.sourceId,
  }));
}
