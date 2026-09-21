/**
 * One-time passcode detection.
 *
 * Deliberately hand-rolled, against this repo's "prefer a mature library" rule,
 * and the exemption is worth stating: there is no maintained package for
 * extracting an OTP from arbitrary email text. The npm packages that exist
 * (`otp-extractor` and friends) are single-author, unmaintained for years, and
 * amount to one unanchored regex with none of the rejections below. Apple's
 * `@`-marker convention is an SMS format and absent from email. So the logic
 * lives here: small, pure, and covered by the test suite next to it.
 *
 * Every pattern is anchored with bounded quantifiers ({3,8}, never nested) so
 * matching stays linear in the input length — no ReDoS surface on text an
 * arbitrary sender controls. Input is capped before matching for the same
 * reason (see MAX_SCAN_CHARS).
 */

/** How much of the body is scanned. A code that appears past this is not a code
 *  the user was meant to find quickly — and an unbounded scan is a main-thread
 *  cost paid on every message. */
export const MAX_SCAN_CHARS = 2_000;

/** Below this, the candidate is more likely an order number or a year. */
export const MIN_CONFIDENCE = 0.55;

/** Default assumed validity when the mail does not say. Most providers use 10m. */
export const DEFAULT_EXPIRY_MS = 10 * 60 * 1000;

/** Words whose presence near a number makes it a passcode rather than a number. */
const KEYWORDS = [
  'verification code',
  'verification pin',
  'security code',
  'confirmation code',
  'authentication code',
  'authorization code',
  'one-time code',
  'one time code',
  'one-time password',
  'one time password',
  'one-time passcode',
  'single-use code',
  'login code',
  'log in code',
  'sign-in code',
  'sign in code',
  'access code',
  'passcode',
  'otp',
  '2fa',
  'two-factor',
  'two factor',
  'verify your',
  'verification',
  'your code',
  'code is',
  'code:',
  'pin is',
  'pin:',
] as const;

/** How far from a keyword a candidate can sit and still be credited to it. */
const KEYWORD_WINDOW = 60;

/** Digit run of a plausible passcode length. */
const PLAIN_CODE = /\b\d{4,8}\b/g;

/** Grouped digits as sent by Google and others: "123 456" / "123-456". */
const GROUPED_CODE = /\b(\d{3})[-\s](\d{3})\b/g;

/** Uppercase alphanumeric code, e.g. "G-4F7K2A". Must contain a digit. */
const ALNUM_CODE = /\b[A-Z0-9]{4,8}\b/g;

/** "expires in 10 minutes", "valid for 5 min", "within 30 seconds". */
const EXPIRY_PHRASE = /(?:expires?|valid|within|good for)[^.\n]{0,20}?(\d{1,3})\s*(second|sec|minute|min|hour|hr)/i;

/** Characters that make a neighbouring number something other than a passcode:
 *  money, percentages, URL and query components. */
const REJECT_BEFORE = new Set(['$', '£', '€', '₹', '¥', '#', '/', '=', '?', '&', '%', '+']);
const REJECT_AFTER = new Set(['%', '/', '=', '?', '&']);

/** '.' and ':' only disqualify a number when a digit sits on the far side of
 *  them — that is a decimal, a version or a clock time. A bare sentence-ending
 *  "code is 483920." is the commonest OTP wording there is and must survive. */
const DIGIT_JOINERS = new Set(['.', ':']);

export interface OtpDetection {
  /** The passcode, separators removed. */
  code: string;
  /** 0..1. Only detections at or above MIN_CONFIDENCE are returned. */
  confidence: number;
  /** Where it was found — a code in the subject is the strongest signal there is. */
  source: 'subject' | 'body';
  /** Milliseconds the code stays valid, from the mail's own wording when it says. */
  expiresInMs: number;
  /** True when the mail stated its own validity rather than us assuming the default. */
  expiryFromMail: boolean;
}

export interface OtpInput {
  subject?: string | null;
  body?: string | null;
}

interface Candidate {
  code: string;
  index: number;
  length: number;
  grouped: boolean;
  allDigits: boolean;
}

/** 1900-2099 read as a bare 4-digit number is far more often a year. */
function looksLikeYear(code: string): boolean {
  return /^(19|20)\d{2}$/.test(code);
}

function isDigit(character: string | undefined): boolean {
  return character !== undefined && character >= '0' && character <= '9';
}

/** Reject a candidate whose immediate neighbours make it a price, time, version
 *  or URL fragment rather than a code. */
function hasRejectingNeighbour(text: string, start: number, end: number): boolean {
  const before = start > 0 ? text[start - 1] : '';
  const after = end < text.length ? text[end] : '';
  if (before && REJECT_BEFORE.has(before)) return true;
  if (after && REJECT_AFTER.has(after)) return true;
  if (before && DIGIT_JOINERS.has(before) && isDigit(text[start - 2])) return true;
  if (after && DIGIT_JOINERS.has(after) && isDigit(text[end + 1])) return true;
  return false;
}

/** Distance in characters from a candidate to the nearest passcode keyword,
 *  or null when none sits within the window. */
function keywordDistance(lowered: string, index: number): number | null {
  let best: number | null = null;
  for (const keyword of KEYWORDS) {
    let from = Math.max(0, index - KEYWORD_WINDOW - keyword.length);
    for (;;) {
      const at = lowered.indexOf(keyword, from);
      if (at === -1 || at > index + KEYWORD_WINDOW) break;
      const end = at + keyword.length;
      // Distance is zero when the candidate sits inside or immediately after
      // the keyword ("code: 123456"), otherwise the gap on whichever side.
      const distance = index >= end ? index - end : Math.max(0, at - index);
      if (best === null || distance < best) best = distance;
      from = at + 1;
    }
  }
  return best !== null && best <= KEYWORD_WINDOW ? best : null;
}

function collectCandidates(text: string): Candidate[] {
  const candidates: Candidate[] = [];
  const seen = new Set<number>();

  // Grouped form first: "123 456" should win as one 6-digit code rather than
  // register as two rejected 3-digit runs.
  for (const match of text.matchAll(GROUPED_CODE)) {
    const index = match.index ?? 0;
    const raw = match[0];
    if (hasRejectingNeighbour(text, index, index + raw.length)) continue;
    candidates.push({
      code: match[1] + match[2],
      index,
      length: raw.length,
      grouped: true,
      allDigits: true,
    });
    for (let i = index; i < index + raw.length; i++) seen.add(i);
  }

  for (const match of text.matchAll(PLAIN_CODE)) {
    const index = match.index ?? 0;
    if (seen.has(index)) continue;
    if (hasRejectingNeighbour(text, index, index + match[0].length)) continue;
    candidates.push({
      code: match[0],
      index,
      length: match[0].length,
      grouped: false,
      allDigits: true,
    });
  }

  for (const match of text.matchAll(ALNUM_CODE)) {
    const index = match.index ?? 0;
    const raw = match[0];
    // A run of only digits was already collected above; a run of only letters
    // is a word (ACCOUNT, VERIFY), not a code.
    if (!/\d/.test(raw) || !/[A-Z]/.test(raw)) continue;
    if (hasRejectingNeighbour(text, index, index + raw.length)) continue;
    candidates.push({
      code: raw,
      index,
      length: raw.length,
      grouped: false,
      allDigits: false,
    });
  }

  return candidates;
}

function scoreCandidate(
  candidate: Candidate,
  lowered: string,
  inSubject: boolean
): number {
  const distance = keywordDistance(lowered, candidate.index);
  // No keyword anywhere near it: this is just a number in an email.
  if (distance === null) return 0;

  let score = 0.35;
  score += 0.35 * (1 - distance / KEYWORD_WINDOW);
  if (inSubject) score += 0.15;
  if (candidate.grouped) score += 0.1;
  if (candidate.code.length === 6) score += 0.15;
  else if (candidate.code.length >= 4 && candidate.code.length <= 8) score += 0.05;
  if (candidate.allDigits) score += 0.05;
  if (looksLikeYear(candidate.code)) score -= 0.4;

  return Math.max(0, Math.min(1, score));
}

/** Read the mail's own stated validity, e.g. "expires in 10 minutes". */
export function parseStatedExpiry(text: string): number | null {
  const match = EXPIRY_PHRASE.exec(text);
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const unit = match[2].toLowerCase();
  const multiplier = unit.startsWith('sec') ? 1_000 : unit.startsWith('hour') || unit.startsWith('hr') ? 3_600_000 : 60_000;
  return amount * multiplier;
}

/**
 * Find the one-time passcode in a message, or null when there isn't one.
 *
 * The subject is scanned first and wins ties: "123456 is your Sarv code" is the
 * strongest form of this mail there is, and it is also the one that arrives
 * before the body has been fetched.
 */
export function detectOtpCode(input: OtpInput): OtpDetection | null {
  const subject = (input.subject ?? '').slice(0, MAX_SCAN_CHARS);
  const body = (input.body ?? '').slice(0, MAX_SCAN_CHARS);

  const sources: Array<{ text: string; source: 'subject' | 'body' }> = [
    { text: subject, source: 'subject' },
    { text: body, source: 'body' },
  ];

  let best: { detection: OtpDetection } | null = null;

  for (const { text, source } of sources) {
    if (!text) continue;
    const lowered = text.toLowerCase();
    for (const candidate of collectCandidates(text)) {
      const confidence = scoreCandidate(candidate, lowered, source === 'subject');
      if (confidence < MIN_CONFIDENCE) continue;
      if (best && best.detection.confidence >= confidence) continue;
      best = {
        detection: {
          code: candidate.code,
          confidence,
          source,
          expiresInMs: DEFAULT_EXPIRY_MS,
          expiryFromMail: false,
        },
      };
    }
  }

  if (!best) return null;

  // Validity is usually stated in the body even when the code is in the subject.
  const stated = parseStatedExpiry(subject) ?? parseStatedExpiry(body);
  if (stated !== null) {
    best.detection.expiresInMs = stated;
    best.detection.expiryFromMail = true;
  }

  return best.detection;
}
