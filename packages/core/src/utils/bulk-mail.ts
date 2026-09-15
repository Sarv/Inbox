/**
 * Bulk / notification mail vs. a real person's message.
 *
 * One predicate, because three places were about to answer this question and a
 * mail client that disagrees with itself about what a message IS renders it two
 * different ways on two screens. It replaces the renderer's
 * `utils/email-classification.ts`, which scored the same idea but never had a
 * caller, and it reuses `isNoReplyAddress` from `role-address.ts` instead of
 * carrying a fourth no-reply regex — that detector already knows the suffix
 * spellings (`pullrequests-reply@`, `drive-shares-dm-noreply@`) a prefix
 * pattern cannot see.
 *
 * The strongest signal is the one already on the row: `detectBulk()` reads
 * `List-Id` / `List-Unsubscribe` / `Precedence` at sync time and the result is
 * stored as the `|bulk|` tag. Those headers are what a bulk sender is REQUIRED
 * to set, so nothing derived from the body beats them.
 *
 * A weighted score rather than a single rule, so one weak hit — a corporate
 * signature that happens to say "unsubscribe" — cannot misfile a human reply.
 * Only signals a person's mail client essentially never produces carry enough
 * weight to decide on their own.
 *
 * DELIBERATELY NOT scored: "designed/heavy HTML" and "low text-to-HTML ratio".
 * Both fire on ordinary long Outlook mail (huge markup, inline styles, layout
 * tables for a one-line reply) and misflagged real replies as automated.
 */
import { isNoReplyAddress } from './role-address';
import { hasTag } from './tags';

export interface BulkMailInput {
  /** The stored `|a|b|c|` tag string. `|bulk|` is the header verdict. */
  tags?: string | null;
  /** Sender address, for the no-reply / machine-mailbox check. */
  fromAddress?: string | null;
  /** Message-ID header, for the ESP-domain check. */
  messageId?: string | null;
  /** Original HTML body. Absent until the body is fetched — the header and
   *  sender signals above stand on their own, so an unfetched body only ever
   *  adds confidence, never removes it. */
  rawBody?: string | null;
}

export interface BulkMailAssessment {
  isBulk: boolean;
  /** Higher = more template/system/blast-like. */
  score: number;
  /** Which rules fired — for logging and for tuning. */
  signals: string[];
}

/** Message-ID domains that belong to Email Service Providers / bulk senders.
 *  A human client's Message-ID comes from its own mail host (e.g.
 *  `@mail.gmail.com`), never one of these. */
const ESP_MESSAGE_ID_DOMAINS: readonly string[] = [
  'amazonses.com', 'sendgrid.net', 'sendgrid.me', 'sendgrid.com',
  'mailgun.org', 'mailgun.net', 'mg.', 'sparkpostmail.com',
  'mandrillapp.com', 'mcsv.net', 'mcdlv.net', 'rsgsv.net', // Mailchimp family
  'sendinblue.com', 'sibmail.com', 'brevo.com',
  'postmarkapp.com', 'pmta', 'mailjet.com', 'mtasv.net',
  'ccsend.com', 'constantcontact.com', 'hubspotemail.net', 'sparkpost.com',
  'zoho.com.cn', 'customeriomail.com', 'e.customerio.com',
];

const UNSUBSCRIBE_RE = /\bunsubscribe\b|\bopt[-\s]?out\b|manage\s+(?:your\s+)?(?:email\s+)?preferences|update\s+your\s+preferences|email\s+preferences/i;
/** A 1x1 pixel, whether sized by width/height attrs (either order) or by an
 *  inline `width:1px;height:1px` style. Humans never embed these. */
const TRACKING_PIXEL_RE = /<img\b[^>]*?(?:width\s*=\s*["']?1["']?[^>]*?height\s*=\s*["']?1["']?|height\s*=\s*["']?1["']?[^>]*?width\s*=\s*["']?1["']?|style\s*=\s*["'][^"']*?width\s*:\s*1px[^"']*?height\s*:\s*1px)/i;
/** Leaked merge tags from a template engine that didn't render. */
const PLACEHOLDER_RE = /\{\{\s*[\w.]+\s*\}\}|%[A-Z][A-Z0-9_]{2,}%|\[(?:FIRST_?NAME|LAST_?NAME|FULL_?NAME|NAME|EMAIL|RECIPIENT|USER(?:NAME)?)\]/;

/** Bulk at or above this. Tuned so any ONE strong signal (the `|bulk|` header
 *  tag, a no-reply sender, an ESP Message-ID, a tracking pixel, a leaked
 *  placeholder — each >= 3) decides, while weak hints must combine. */
export const BULK_THRESHOLD = 3;

function hasEspMessageIdDomain(messageId: string): boolean {
  const at = messageId.lastIndexOf('@');
  if (at === -1) return false;
  const domain = messageId
    .slice(at + 1)
    .replace(/[>\s]+$/, '')
    .toLowerCase();
  if (!domain) return false;
  return ESP_MESSAGE_ID_DOMAINS.some((d) => domain === d || domain.endsWith('.' + d) || domain.includes(d));
}

/** Score the message, and say which rules fired. */
export function assessBulkMail(input: BulkMailInput): BulkMailAssessment {
  const body = input.rawBody || '';
  const messageId = (input.messageId || '').toLowerCase();

  const signals: string[] = [];
  let score = 0;
  const add = (points: number, signal: string) => {
    score += points;
    signals.push(signal);
  };

  // Strongest: the sender declared it, in the headers the RFCs reserve for it.
  if (hasTag(input.tags || '', 'bulk')) add(3, 'bulk-header');

  // Strong: signals a person's mail client essentially never produces.
  if (isNoReplyAddress(input.fromAddress)) add(3, 'noreply-sender');
  if (messageId && hasEspMessageIdDomain(messageId)) add(3, 'esp-message-id');
  if (TRACKING_PIXEL_RE.test(body)) add(3, 'tracking-pixel');
  if (PLACEHOLDER_RE.test(body)) add(3, 'unrendered-placeholder');

  // Medium: common in bulk mail, but a human footer or a quote can carry it,
  // so it must not decide on its own.
  if (UNSUBSCRIBE_RE.test(body)) add(2, 'unsubscribe-copy');

  return { isBulk: score >= BULK_THRESHOLD, score, signals };
}

/** Is this a blast / notification / system message rather than a person's? */
export function isBulkMail(input: BulkMailInput): boolean {
  return assessBulkMail(input).isBulk;
}

/** The inverse: a real person's conversation turn. */
export function isConversationMail(input: BulkMailInput): boolean {
  return !assessBulkMail(input).isBulk;
}
