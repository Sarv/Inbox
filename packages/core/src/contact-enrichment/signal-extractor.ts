/**
 * Signal extractor — pulls candidate phone numbers, URLs, social links,
 * and possible job titles out of email bodies (with a bias toward the
 * signature region). Pure regex/heuristics — no LLM here. The LLM takes
 * the extracted signals and classifies them (personal vs company,
 * which URL is LinkedIn, etc.) so we don't waste tokens on the grunt
 * work of pattern matching.
 */

import { findPhoneNumbersInText } from 'libphonenumber-js';

import { scoreCandidate } from './phone-scoring';
import { TITLE_REGEX } from './titles';

export interface ExtractedSignals {
  phones: string[];        // canonical E.164 as detected by libphonenumber
  /**
   * Per-number confidence, keyed by E.164. Additive alongside `phones` so
   * existing callers are untouched; the classifier uses it to prefer a
   * signature-and-label-backed number over one merely present in the body.
   */
  phoneScores?: Record<string, number>;
  urls: string[];          // all URLs (http/https)
  emails: string[];        // all email addresses mentioned
  linkedinUrls: string[];  // filtered: linkedin.com/in/…
  twitterUrls: string[];   // twitter.com / x.com
  githubUrls: string[];    // github.com
  otherSocials: string[];  // facebook, instagram, youtube, threads, etc.
  websites: string[];      // non-social http(s) URLs
  signatureBlock: string | null; // best-effort signature slice for LLM context
  titleCandidates: string[];     // lines that look like a title line
}

// Default region for national-format numbers (no + prefix) found inside a
// signature. This app's user base is India; matches the same 'IN' default used
// by the phone normalizer and the contact-card formatter.
const DEFAULT_PHONE_REGION = 'IN';

// HTML-stripped signatures often glue fields together with no whitespace
// ("Project Manager+91 9977553311www.sarv.com"). libphonenumber needs word
// boundaries to recognise a number, so insert a space wherever a letter abuts
// a digit or '+'. Purely for detection — the parsed number is unaffected.
function spaceOutDigitBoundaries(text: string): string {
  return text
    .replace(/([a-zA-Z])(\+|\d)/g, '$1 $2')
    .replace(/(\d)([a-zA-Z])/g, '$1 $2');
}

const URL_REGEX = /https?:\/\/[^\s<>"']+/gi;

/**
 * Conference / meeting dial-in context.
 *
 * Calendar invites carry real, valid phone numbers that belong to the
 * conferencing provider, not the organiser — a mailbox full of Google Calendar
 * invites otherwise hands every attendee a US dial-in as their "personal"
 * number. Matched against the text AROUND a candidate, so only numbers in that
 * context are dropped.
 */
const CONFERENCE_CONTEXT = /\b(join\s+by\s+phone|more\s+phone\s+numbers|dial[\s-]?in|meeting\s*id|passcode|conference\s*(id|bridge)|pin\s*[:#]|tel\.meet|meet\.google|zoom\.us|teams\.microsoft|webex)\b/i;
const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

/**
 * Reject obviously-non-personal numbers that the regex still lets
 * through: toll-free / customer-care prefixes, malformed long runs,
 * and out-of-range lengths.
 */
function isLikelyPersonalPhone(raw: string, nationalNumber?: string): boolean {
  const digits = raw.replace(/\D/g, '');
  if (digits.length < 8 || digits.length > 15) return false;
  // Toll-free prefixes are properties of the NATIONAL number. Testing them
  // against E.164 silently never matched: libphonenumber turns "1800 123 4567"
  // into "+9118001234567", whose digits start "91", so every ^1800 rule missed
  // and support hotlines were recorded as people's personal numbers.
  const national = (nationalNumber || digits).replace(/\D/g, '');
  // Length is deliberately loose: real toll-free lines are printed in many
  // groupings ("1800-12345-6001" is 13 digits), and a fixed 10-11 window let
  // them through to be scored as though they were someone's mobile.
  if (/^(1800|1860|1300|1900)\d{4,}$/.test(national)) return false;
  if (/^1(800|888|877|866|855|844|833|822|811)\d{7}$/.test(national)) return false;
  if (digits.startsWith('00') && digits.length > 14) return false;
  return true;
}

const SOCIAL_HOSTS: Record<string, 'linkedin' | 'twitter' | 'github' | 'other'> = {
  'linkedin.com': 'linkedin',
  'www.linkedin.com': 'linkedin',
  'twitter.com': 'twitter',
  'x.com': 'twitter',
  'github.com': 'github',
  'facebook.com': 'other',
  'www.facebook.com': 'other',
  'instagram.com': 'other',
  'www.instagram.com': 'other',
  'youtube.com': 'other',
  'www.youtube.com': 'other',
  'threads.net': 'other',
  'mastodon.social': 'other',
  'medium.com': 'other',
  'bsky.app': 'other',
};

/**
 * Where a signature BEGINS. Exported because the chat view needs the same
 * answer and cannot get it from email-reply-parser: that library is node-only
 * (see the note on the root barrel's signature-splitter-node export), and even
 * where it does run it recognises separators, "Sent from …", "Regards" and
 * "Cheers" but has no rule for a bare "Thanks" — the sign-off most of this
 * mailbox uses. Both sides read these patterns rather than keeping a second
 * list in the renderer that drifts from this one.
 */
export const SIGNATURE_DELIMITERS = [
  // Leading whitespace is ALLOWED. html-to-text indents the `-- ` separator
  // ("    --"), and anchoring to column 0 meant the standard signature marker
  // went unrecognised on exactly the HTML mail that needs it most — no
  // signature block, so the sender's own number was never found.
  /^\s*--+\s*$/m,                            // standard `-- ` delimiter
  /^\s*—+\s*$/m,                             // em dash
  /^\s*___+\s*$/m,                           // underscores
  /^Sent from my (iPhone|iPad|Android)/mi,   // mobile
  // Sign-offs. Trailing punctuation is OPTIONAL and unrestricted: real mail is
  // full of "Regards!", "Thanks :)", "Best -" and the comma-only patterns
  // matched none of them. When no delimiter matches there is no signature
  // block, and extractSignals then falls back to mining the WHOLE body — which
  // is how a title line went missing and a quoted number got picked up.
  /^(Best|Kind|Warm)\s+regards?\b[!.,:;)\s-]*$/mi,
  // Combined sign-offs: "Thanks & Regards", "Thanks and Regards", "Thank you &
  // Regards", "Thanks, Regards" — extremely common and previously unmatched, so
  // the whole signature card sat in the bubble.
  /^(Thanks?|Thank you|Best|Kind|Warm)\s*(&|and|n|,)\s*regards?\b[!.,:;)\s-]*$/mi,
  /^(Thanks|Thank you|Regards|Sincerely|Cheers|Best|Br|Rgds)\b[!.,:;)\s-]*$/mi,
  /^(Yours (sincerely|faithfully|truly))\b[!.,:;)\s-]*$/mi,
];

// Markers that introduce quoted/forwarded content from a *different*
// sender. Anything from the first hit onward is somebody else's email,
// not the contact's. Without this strip, the signature extractor walks
// to the bottom of the body and grabs whoever signed off last — usually
// the user's own quoted signature in a long reply chain.
const QUOTE_MARKERS: RegExp[] = [
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



/**
 * Slice the signature region out of a plain-text body. Returns the
 * original text if no delimiter is found — the LLM can still search
 * the full body, just at some token cost.
 */
export function extractSignatureBlock(plainText: string): string | null {
  if (!plainText) return null;
  const lines = plainText.split(/\r?\n/);
  let cutIndex = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (SIGNATURE_DELIMITERS.some((rx) => rx.test(lines[i]))) {
      cutIndex = i;
      break;
    }
  }
  if (cutIndex >= 0) {
    // Trim at ~30 lines below the delimiter — enough for verbose sigs,
    // bounded so we don't drag in the whole body.
    return lines.slice(cutIndex, cutIndex + 30).join('\n').trim() || null;
  }

  // No line-based delimiter. html-to-text frequently collapses the whole
  // sign-off onto one line ("…update.Regards,Bindu YagnikSales Manager+91…"),
  // where a line-anchored pattern can never match. Look for a sign-off token
  // ANYWHERE in the tail and slice from there — recovering a signature that
  // would otherwise be invisible.
  const tail = plainText.slice(-1500);
  const glued = /(?:thanks\s*(?:&|and)\s*regards|thanks|thank you|regards|sincerely|cheers|best regards|kind regards|warm regards|best|rgds)\s*[,:;!.-]?\s*(?=[A-Z])/gi;
  let last = -1;
  for (const m of tail.matchAll(glued)) if (m.index !== undefined) last = m.index;
  if (last >= 0) {
    const block = tail.slice(last).trim();
    if (block) return block;
  }
  return null;
}

/**
 * Signature splitter shared with zones.ts, injected by the main process so this
 * module stays browser-safe. See contact-enrichment/zones.ts.
 */
let injectedSplitter: ((text: string) => string[]) | null = null;

/** Install the signature splitter used by extractSignals (main process only). */
export function setExtractorSignatureSplitter(fn: ((text: string) => string[]) | null): void {
  injectedSplitter = fn;
}

/**
 * The trailing region of a body, used when no signature could be identified.
 *
 * Contact details live at the END of an email. Treating the tail as a
 * low-confidence signature lets national-format numbers ("|| 9988776655") be
 * recognised, which the body pass deliberately cannot do — outside a signature
 * it requires an international prefix, so a sender whose sign-off has no
 * delimiter used to lose their number entirely.
 */
function tailZone(plainText: string): string {
  const lines = plainText.split(/\r?\n/).filter((l) => l.trim());
  return lines.slice(-12).join('\n').slice(-800);
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

export function extractSignals(
  plainText: string,
  fromAddress?: string,
): ExtractedSignals {
  // Strip quoted/forwarded content first so we don't mis-attribute a
  // quoted user signature (with their phone number) to the contact.
  const text = stripQuotedTail(plainText || '');

  // The sender's signature is NOT always above the quoted history. Replying
  // inline or bottom-posting (and much html-to-text output) puts it at the very
  // bottom, below the quotes — and stripQuotedTail cuts from the first quote
  // marker onward, taking that signature with it. Every one of those senders
  // silently lost their number.
  //
  // email-reply-parser segments by fragment rather than by position, so it
  // finds a trailing signature and still marks the quoted parts as quoted. Use
  // it against the FULL text when installed; the positional heuristics below
  // remain the fallback for the glued shapes it does not recognise.
  let sig: string | null = null;
  if (injectedSplitter) {
    try {
      const frags = injectedSplitter(plainText || '').map((f) => f.trim()).filter(Boolean);
      // Use EVERY signature fragment, not just the last.
      //
      // "Last one wins" assumed the sender's own sign-off is outermost. In a
      // bottom-posted chain it is not: their signature can sit above an older
      // one, and picking the last silently dropped their number while keeping a
      // colleague's. Mining all of them makes each a CANDIDATE; ownership in the
      // classifier decides whose it is, which is the layer equipped to know.
      if (frags.length > 0) sig = frags.join('\n');
    } catch {
      sig = null;
    }
  }
  if (!sig) sig = extractSignatureBlock(text);

  // If the surviving "signature" mentions only emails on a domain other
  // than the From: domain, it's likely a foreign signature that escaped
  // the quote-strip. Drop it.
  if (sig && fromAddress) {
    const self = fromAddress.toLowerCase().trim();
    const fromDomain = (self.split('@')[1] || '').trim();
    if (fromDomain) {
      const sigEmails = (sig.match(EMAIL_REGEX) || []).map((e) => e.toLowerCase());
      // Substring test, NOT array equality. html-to-text glues fields together
      // ("Pooja KhatriCBOpkh@sarv.com"), and the address regex then captures
      // the run of preceding letters too — yielding "khatricbopkh@sarv.com".
      // Compared as a whole address that is a DIFFERENT person, so the
      // colleague guard below rejected the sender's own signature and their
      // number vanished. Their address is still present as a substring.
      const mentionsSelf = sig.toLowerCase().includes(self);
      const hasSelfEmail = mentionsSelf || sigEmails.some((e) => e.split('@')[1] === fromDomain);
      const hasOtherDomain = sigEmails.some((e) => e.split('@')[1] !== fromDomain);
      if (sigEmails.length > 0 && !hasSelfEmail && hasOtherDomain) {
        sig = null;
      }
      // Same-domain colleague's signature. The cross-domain test above can't see
      // this case: a quoted reply from a co-worker carries addresses on the
      // SENDER'S OWN domain, so the guard passed and their signature was mined
      // as this sender's. That is how one person's mobile ends up recorded
      // against several colleagues, which then makes the phone classifier read
      // it as a shared/org line and discard it as nobody's direct number.
      // If the block names addresses on our domain but never the sender's own,
      // it belongs to someone else.
      if (sig && sigEmails.length > 0 && !mentionsSelf) {
        const sameDomainOthers = sigEmails.filter(
          (e) => e.split('@')[1] === fromDomain && e !== self,
        );
        if (sameDomainOthers.length > 0) sig = null;
      }
    }
  }
  // PROXIMITY, not a blanket ban. Rejecting an entire body because it mentions
  // one outside address throws away the sender's own number too — the kind of
  // hard rule that loses far more than it protects. Instead, note where each
  // foreign address SITS, and drop only the numbers printed next to one, which
  // is what an outside party's pasted contact block looks like.
  const foreignAt: number[] = (() => {
    const dom = (fromAddress || '').toLowerCase().split('@')[1]?.trim();
    if (!dom) return [];
    const out: number[] = [];
    for (const m of text.matchAll(EMAIL_REGEX)) {
      const d = m[0].toLowerCase().split('@')[1];
      if (d && d !== dom && m.index !== undefined) out.push(m.index);
    }
    return out;
  })();
  const NEAR = 120;
  const nextToForeignAddress = (idx: number): boolean =>
    foreignAt.some((f) => Math.abs(f - idx) <= NEAR);

  // Signature first (highest signal); then the TAIL when no signature was
  // identified — contact details live at the end, and the tail is parsed with a
  // region so bare national numbers are recognised; then the whole body, where
  // only internationally-prefixed numbers count.
  const tail = sig ? null : tailZone(text);
  const sources = sig ? [sig, text] : [tail as string, text];
  const seenPhones = new Set<string>();
  const seenUrls = new Set<string>();
  const seenEmails = new Set<string>();
  const titleCandidates: string[] = [];

  const phones: string[] = [];
  const phoneScores: Record<string, number> = {};
  const urls: string[] = [];
  const emails: string[] = [];

  for (const src of sources) {
    // Three zones, in descending confidence:
    //   signature  -> parsed WITH a region, so bare national numbers count
    //   tail       -> same, when no signature could be identified at all
    //   whole body -> no region, so only +/00-prefixed numbers count, keeping
    //                 order and reference IDs out
    //
    // Everything found here is a CANDIDATE. Whose number it is gets decided by
    // the classifier (the sender must own it — their count must be the domain
    // maximum) and by quote attribution, which credits a quoted block to the
    // author named in its header. Discarding candidates at this stage to avoid
    // a wrong attribution costs every sender whose sign-off we cannot parse,
    // which is a far larger loss than the one it prevents.
    const isSignature = src === sig;
    const useRegion = isSignature || src === tail;
    const spaced = spaceOutDigitBoundaries(src);
    const detected = useRegion
      ? findPhoneNumbersInText(spaced, DEFAULT_PHONE_REGION)
      : findPhoneNumbersInText(spaced);
    for (const match of detected) {
      const { number } = match;
      const e164 = number.number; // canonical E.164, e.g. "+919977553311"
      if (!isLikelyPersonalPhone(e164, number.nationalNumber)) continue;
      // TAIL ZONE ONLY. A signature is trusted to contain phone numbers, so
      // anything there is kept. The tail is just "the end of some email" and
      // will happily surface an order or invoice number, so a BARE number
      // (no international prefix) additionally has to look like a subscriber
      // line — for the IN default that means 10 digits starting 6-9, which
      // "order 4029381746" is not. Signature recall is untouched.
      // Conference dial-in sitting in a calendar invite — provider's number,
      // not the sender's. Checked in every zone: invites have no signature, so
      // the tail guard alone never sees them.
      const ctxFrom = Math.max(0, (match.startsAt ?? 0) - 90);
      const ctxTo = Math.min(spaced.length, (match.endsAt ?? 0) + 90);
      if (CONFERENCE_CONTEXT.test(spaced.slice(ctxFrom, ctxTo))) continue;

      if (src === tail) {
        const raw = spaced.slice(match.startsAt ?? 0, match.endsAt ?? 0);
        const national = String(number.nationalNumber || '');
        if (!raw.includes('+') && !/^[6-9]\d{9}$/.test(national)) continue;
      }
      // Sitting right next to an outside party's address = their contact
      // block, not the sender's. Only the numbers actually adjacent to one are
      // dropped; the rest of the body still contributes.
      if (!isSignature && nextToForeignAddress(match.startsAt ?? 0)) continue;
      if (!seenPhones.has(e164)) {
        seenPhones.add(e164);
        phones.push(e164);
      }
      // Confidence for this occurrence. Keep the BEST seen: the same number can
      // appear in prose and again in the signature, and the signature is what
      // it should be judged on.
      const scored = scoreCandidate(
        {
          e164,
          display: e164,
          source: spaced,
          index: match.startsAt ?? 0,
          zone: isSignature ? 'signature' : (src === tail ? 'body' : 'body'),
          relativePosition: spaced.length ? (match.startsAt ?? 0) / spaced.length : 0,
        },
        { fromAddress: fromAddress || '' },
      );
      const value = scored.vetoed ? Number.NEGATIVE_INFINITY : scored.score;
      if (phoneScores[e164] === undefined || value > phoneScores[e164]) {
        phoneScores[e164] = value;
      }
    }
    for (const match of src.matchAll(URL_REGEX)) {
      const u = match[0].replace(/[,.);]+$/, '');
      if (!seenUrls.has(u)) {
        seenUrls.add(u);
        urls.push(u);
      }
    }
    for (const match of src.matchAll(EMAIL_REGEX)) {
      const e = match[0].toLowerCase();
      if (!seenEmails.has(e)) {
        seenEmails.add(e);
        emails.push(e);
      }
    }
  }

  const linkedinUrls: string[] = [];
  const twitterUrls: string[] = [];
  const githubUrls: string[] = [];
  const otherSocials: string[] = [];
  const websites: string[] = [];
  for (const url of urls) {
    const host = hostOf(url);
    const cls = SOCIAL_HOSTS[host];
    if (cls === 'linkedin') linkedinUrls.push(url);
    else if (cls === 'twitter') twitterUrls.push(url);
    else if (cls === 'github') githubUrls.push(url);
    else if (cls === 'other') otherSocials.push(url);
    else websites.push(url);
  }

  if (sig) {
    for (const line of sig.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (trimmed.length > 120) continue; // too long to be a title line
      if (TITLE_REGEX.test(trimmed)) titleCandidates.push(trimmed);
    }
  }

  return {
    phones,
    urls,
    emails,
    linkedinUrls,
    twitterUrls,
    githubUrls,
    otherSocials,
    websites,
    signatureBlock: sig,
    phoneScores,
    titleCandidates,
  };
}

/**
 * Merge signals across multiple emails — dedupe and rank by how often
 * a value appears (recurring values are almost always real contact
 * info; a one-off mention of a number in email body is not).
 */
export function mergeSignals(perEmail: ExtractedSignals[]): ExtractedSignals {
  const mergedScores: Record<string, number> = {};
  const counts: Record<string, Map<string, number>> = {
    phones: new Map(),
    urls: new Map(),
    emails: new Map(),
    linkedinUrls: new Map(),
    twitterUrls: new Map(),
    githubUrls: new Map(),
    otherSocials: new Map(),
    websites: new Map(),
  };
  const titleCandidates = new Set<string>();
  let signatureBlock: string | null = null;

  const arrayKeys: Array<keyof typeof counts & keyof ExtractedSignals> = [
    'phones', 'urls', 'emails', 'linkedinUrls', 'twitterUrls',
    'githubUrls', 'otherSocials', 'websites',
  ];
  for (const s of perEmail) {
    for (const key of arrayKeys) {
      for (const v of s[key] as string[]) {
        counts[key].set(v, (counts[key].get(v) || 0) + 1);
      }
    }
    for (const t of s.titleCandidates) titleCandidates.add(t);
    for (const [k, v] of Object.entries(s.phoneScores || {})) {
      if (mergedScores[k] === undefined || v > mergedScores[k]) mergedScores[k] = v;
    }
    if (!signatureBlock && s.signatureBlock) signatureBlock = s.signatureBlock;
  }

  const rankDesc = (m: Map<string, number>) =>
    [...m.entries()].sort((a, b) => b[1] - a[1]).map(([v]) => v);

  return {
    phones: rankDesc(counts.phones),
    phoneScores: mergedScores,
    urls: rankDesc(counts.urls),
    emails: rankDesc(counts.emails),
    linkedinUrls: rankDesc(counts.linkedinUrls),
    twitterUrls: rankDesc(counts.twitterUrls),
    githubUrls: rankDesc(counts.githubUrls),
    otherSocials: rankDesc(counts.otherSocials),
    websites: rankDesc(counts.websites),
    signatureBlock,
    titleCandidates: [...titleCandidates],
  };
}
