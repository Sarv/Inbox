/**
 * Weighted confidence scoring for phone-number candidates.
 *
 * Replaces boolean accept/reject with a score per candidate. Boolean rules kept
 * forcing a choice between losing a real number and admitting a wrong one:
 * every guard added to block one bad case silently cost information in dozens
 * of good ones. A score lets weak positives and weak negatives coexist and be
 * resolved at the end.
 *
 * Two stages, because the deciding evidence arrives at different times:
 *
 *   1. PER-EMAIL (this module): zone, surrounding labels, proximity to the
 *      sender's name and to a job title. Everything visible in one message.
 *   2. CROSS-SENDER (applyDomainSignals): how many distinct senders in the
 *      domain carry the number, and whether this sender uses it repeatedly.
 *      Only knowable after the whole mailbox is mined.
 *
 * Weights live in {@link PHONE_SCORE} so they are tunable in one place and
 * assertable in tests, rather than being spread through branches.
 */

import { looksLikeTitleLine } from './titles';

/** Where in the message a candidate was found. */
export type PhoneZone =
  | 'signature'  // the sender's own sign-off — highest intent
  | 'body'       // prose; only meaningful when explicitly labelled
  | 'quoted'     // inside a quoted reply — belongs to the quoted author
  | 'disclaimer'; // legal boilerplate / system footer

/** Tunable weights. Positive = more likely the sender's own direct line. */
export const PHONE_SCORE = {
  inSignature: 35,
  personalLabel: 25,       // "Mobile", "Direct", "Cell", "M:", WhatsApp
  nearSenderName: 20,      // sender's name within NAME_WINDOW chars
  nearJobTitle: 15,        // a title line adjacent — a human signature block
  uniqueToSender: 10,      // cross-sender: nobody else in the domain carries it
  orgLabel: -20,           // "Office", "Main", "HQ", "Switchboard"
  faxOrTollFree: -50,      // never a personal contact
  sharedAcrossSenders: -35, // cross-sender: >2 distinct senders in the domain
  inDisclaimer: -40,       // boilerplate footer
  inQuotedBlock: -30,      // someone else's block, unless re-attributed to them
  bottomOfBody: 15,        // contact details cluster at the end of a message
} as const;

/** Above this, a number is the sender's own direct line. */
export const DIRECT_THRESHOLD = 60;
/** At or above this (but below DIRECT), treat as a company/HQ number. */
export const COMPANY_THRESHOLD = 20;

/** Characters either side of a number searched for labels / names. */
const LABEL_WINDOW = 40;
/** Only a label this close to the number can be describing it. */
const LABEL_TIGHT = 18;
const NAME_WINDOW = 50;

const PERSONAL_LABEL = /\b(mobile|mob|cell|direct|dial|handy|whats\s?app|personal|m)\s*[:.-]?\s*$|\b(mobile|mob|cell|direct|handy|whatsapp|personal)\b/i;
const ORG_LABEL = /\b(office|tel|telephone|main|hq|head\s?office|switchboard|reception|support|landline|board)\b/i;
/**
 * html-to-text renders a link as `text [href]`, and signature mining keeps
 * hrefs ON, so a click-to-call button arrives as `Call me [tel:+919876543210]`.
 * ORG_LABEL matched the `tel` of that URI and docked the number 20 points for
 * being an office line — inverting the signal, because a `tel:` href is the
 * number the person put behind their own call button, and when the button has
 * no visible digits it is the ONLY place that number appears.
 *
 * Only the bracketed URI form is exempt. The WRITTEN label `Tel:` really does
 * mean the landline in most signatures and keeps its penalty.
 */
const TEL_URI_HREF = /\[\s*(?:tel|callto)\s*:\s*$/i;
// Verified against libphonenumber: most ID-shaped strings (ISO dates,
// timestamps, tracking codes, "Ref: 2024-9812-4412", "Meeting ID: 842 1928
// 3311") are already rejected as invalid numbers. These are the labels whose
// values DO parse as plausible phone numbers and therefore need a veto —
// "Invoice INV-2026-004512" and "PIN 4821 9930 11" both do.
const NEGATIVE_LABEL = /\b(fax|f\s*:|reg(istration)?\.?\s*no|tax\s*id|vat|gst(in)?|ein|po\s*box|cin|udyam|invoice|inv\s*no|order(\s*(id|no|number))?|ref(erence)?|ticket|tracking|awb|otp|account\s*(no|number)|imei|meeting\s*id|passcode|pass\s*code|pin|conference\s*id|webinar\s*id|dial[\s-]?in\s*(pin|code))\b/i;
const TOLL_FREE_LABEL = /\b(toll[\s-]?free|1[\s-]?800|0800|1800|1860)\b/i;

/** Legal/system boilerplate that should never yield a personal number. */
const DISCLAIMER_MARKERS = [
  /confidential(ity)?\s+(notice|information)/i,
  /this\s+(e-?mail|message)\s+(and\s+any\s+attachments\s+)?(is|are|may\s+be)\s+(confidential|privileged|intended)/i,
  /if\s+you\s+(are\s+not|have\s+received)\s+the\s+intended/i,
  /unsubscribe|manage\s+preferences|view\s+in\s+browser/i,
  /do\s+not\s+reply\s+to\s+this/i,
  /registered\s+office|company\s+registration|vat\s+no/i,
];

export interface PhoneCandidate {
  e164: string;
  display: string;
  /** Text the number was found in. */
  source: string;
  /** Index of the number within `source`. */
  index: number;
  zone: PhoneZone;
  /**
   * Where the number sits in the unquoted body, 0 (start) to 1 (end). Contact
   * details cluster at the bottom, so a number in the final fifth is far more
   * likely to be a real contact than one mid-paragraph.
   */
  relativePosition?: number;
  /** For quoted zones: the address the quote header names, if known. */
  attributedTo?: string | null;
}

export interface ScoredPhone extends PhoneCandidate {
  score: number;
  /**
   * Hard exclusion, independent of score. A fax line, registration number or
   * toll-free hotline is not this person's contact number at ANY score — as a
   * mere -50 it is outweighed by ordinary signature signals (+35 in signature,
   * +20 name nearby, +15 title adjacent nets positive), which is exactly the
   * false positive the label exists to prevent.
   */
  vetoed: boolean;
  /** Human-readable contributions, for debugging and for explaining a result. */
  reasons: string[];
}

/** True when `text` around `index` reads like legal/system boilerplate. */
export function looksLikeDisclaimer(text: string): boolean {
  return DISCLAIMER_MARKERS.some((rx) => rx.test(text));
}

/** The window of text immediately around a candidate. */
function contextOf(source: string, index: number, width: number): { before: string; after: string } {
  return {
    before: source.slice(Math.max(0, index - width), index),
    after: source.slice(index, Math.min(source.length, index + width)),
  };
}

/**
 * Name fragments worth matching against, derived from an address when no
 * display name is known. "meghna.k@sarv.com" -> ["meghna", "k"]; short or
 * numeric fragments are dropped so "pkh" doesn't match arbitrary prose.
 */
export function nameTokensFor(fromAddress: string, displayName?: string | null): string[] {
  const out = new Set<string>();
  for (const part of (displayName || '').split(/\s+/)) {
    const t = part.trim().toLowerCase();
    if (t.length >= 3) out.add(t);
  }
  const local = (fromAddress || '').split('@')[0] || '';
  for (const part of local.split(/[._\-+]/)) {
    const t = part.trim().toLowerCase();
    if (t.length >= 3 && !/^\d+$/.test(t)) out.add(t);
  }
  return [...out];
}

/**
 * Score one candidate from the evidence visible inside a single email.
 * Cross-sender signals are added later by {@link applyDomainSignals}.
 */
export function scoreCandidate(
  c: PhoneCandidate,
  opts: { fromAddress: string; displayName?: string | null },
): ScoredPhone {
  const reasons: string[] = [];
  let score = 0;
  let vetoed = false;

  const add = (delta: number, why: string) => {
    score += delta;
    reasons.push(`${delta >= 0 ? '+' : ''}${delta} ${why}`);
  };

  if (c.zone === 'signature') add(PHONE_SCORE.inSignature, 'in signature');
  else if (c.zone === 'disclaimer') add(PHONE_SCORE.inDisclaimer, 'in disclaimer');
  else if (c.zone === 'quoted') add(PHONE_SCORE.inQuotedBlock, 'in quoted block');

  const { before } = contextOf(c.source, c.index, LABEL_WINDOW);
  // A label only describes the number it IMMEDIATELY precedes. Scanning the
  // whole neighbourhood meant one "1800-12345-6001" in a compact signature
  // vetoed the personal mobile and the switchboard printed beside it — every
  // Sarv contact lost both. Only the last few characters before the number
  // count, and the toll-free DIGITS are handled by isLikelyPersonalPhone.
  //
  // The window also stops at the START OF THE LINE. A label describes the
  // number printed beside it ("Office: +91 ..."), so it is always on the same
  // line; what sits on the line ABOVE is the person's name and job title. Let
  // the window run past the newline and a title is read as a label — "Bhupesh
  // Chugh\nVP Support\n+91 94145 11220" matched ORG_LABEL on the `Support` of
  // his TITLE and docked his own mobile 20 points, which dropped it below a
  // vendor's number he had forwarded once. Every "... Support", "Head of
  // Sales", "Office Manager" signature had the same hole.
  const lineBefore = before.slice(before.lastIndexOf('\n') + 1);
  const immediatelyBefore = lineBefore.slice(-LABEL_TIGHT);

  if (NEGATIVE_LABEL.test(immediatelyBefore) || TOLL_FREE_LABEL.test(immediatelyBefore)) {
    add(PHONE_SCORE.faxOrTollFree, 'fax / toll-free / registration id');
    vetoed = true;
  }
  if (PERSONAL_LABEL.test(immediatelyBefore)) add(PHONE_SCORE.personalLabel, 'personal label');
  if (ORG_LABEL.test(immediatelyBefore) && !TEL_URI_HREF.test(immediatelyBefore)) {
    add(PHONE_SCORE.orgLabel, 'org label');
  }

  // Bottom-of-body bonus. Only for prose: a signature already scores for its
  // zone, and a disclaimer sits at the bottom by definition, so applying it
  // there would reward exactly the wrong thing.
  if (c.zone === 'body' && (c.relativePosition ?? 0) >= 0.8) {
    add(PHONE_SCORE.bottomOfBody, 'bottom of body');
  }

  const nameWindow = contextOf(c.source, c.index, NAME_WINDOW);
  const nameHay = `${nameWindow.before} ${nameWindow.after}`.toLowerCase();
  const tokens = nameTokensFor(opts.fromAddress, opts.displayName);
  if (tokens.some((t) => nameHay.includes(t))) add(PHONE_SCORE.nearSenderName, 'sender name nearby');

  // A job title on the line above or below marks a human signature block
  // rather than an automated footer.
  const lines = c.source.split(/\r?\n/);
  let offset = 0;
  let lineIdx = 0;
  for (let i = 0; i < lines.length; i++) {
    if (offset + lines[i].length >= c.index) { lineIdx = i; break; }
    offset += lines[i].length + 1;
  }
  const neighbours = [lines[lineIdx - 1], lines[lineIdx], lines[lineIdx + 1]].filter(Boolean) as string[];
  if (neighbours.some(looksLikeTitleLine)) add(PHONE_SCORE.nearJobTitle, 'job title adjacent');

  return { ...c, score, vetoed, reasons };
}

/** Cross-sender counts for one normalized number within a domain. */
export interface DomainPhoneStats {
  /** Distinct sender addresses in the domain whose mail carried it. */
  distinctSenders: number;
  /** Times THIS sender's mail carried it. */
  ownCount: number;
}

/**
 * Fold in the signals that only the whole-mailbox pass can see: a number on
 * more than two colleagues' mail is a switchboard, and one nobody else carries
 * is personal.
 */
export function applyDomainSignals(scored: ScoredPhone, stats: DomainPhoneStats): ScoredPhone {
  const reasons = [...scored.reasons];
  let score = scored.score;
  if (stats.distinctSenders > 2) {
    score += PHONE_SCORE.sharedAcrossSenders;
    reasons.push(`${PHONE_SCORE.sharedAcrossSenders} shared across ${stats.distinctSenders} senders`);
  } else if (stats.distinctSenders === 1) {
    score += PHONE_SCORE.uniqueToSender;
    reasons.push(`+${PHONE_SCORE.uniqueToSender} unique to this sender`);
  }
  return { ...scored, score, reasons };
}

export type PhoneClass = 'direct' | 'company' | 'rejected';

/** Final verdict for a fully-scored candidate. */
export function classifyScore(score: number, vetoed = false): PhoneClass {
  if (vetoed) return 'rejected';
  if (score > DIRECT_THRESHOLD) return 'direct';
  if (score >= COMPANY_THRESHOLD) return 'company';
  return 'rejected';
}

/** Verdict for a candidate, honouring its veto. Prefer this over classifyScore. */
export function classifyPhone(scored: ScoredPhone): PhoneClass {
  return classifyScore(scored.score, scored.vetoed);
}
