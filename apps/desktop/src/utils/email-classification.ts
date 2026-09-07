/**
 * Human (conversation) vs. automated (template / system / bulk) email
 * classification — Phase A: BODY + Message-ID signals only, the ones we already
 * have on every EmailRecord. No IMAP/schema change.
 *
 * The gold-standard signals are the headers `List-Unsubscribe`, `Auto-Submitted`
 * and `Precedence`, which we don't persist yet (Phase B captures them at
 * body-parse via mailparser). Until then this scores only signals a human's mail
 * client essentially NEVER produces, so it stays robust against verbose Outlook /
 * Word HTML (huge markup, inline styles, layout tables even for a one-line reply):
 *   - 1x1 tracking pixels
 *   - unrendered template placeholders ({{name}}, %VAR%, [NAME])
 *   - ESP Message-ID domains (SendGrid, SES, Mailgun, Mailchimp, ...)
 *   - no-reply / mailer / bounce sender
 *   - unsubscribe / opt-out / manage-preferences copy (medium — a corporate
 *     footer can carry it, so it can't flip the verdict alone)
 *
 * DELIBERATELY NOT scored: "designed/heavy HTML" and "low text-to-HTML ratio" —
 * both fire on ordinary long Outlook mail and were misflagging real replies as
 * automated, stripping the chat tint and leaving plain white bubbles. The
 * reliable form of that signal is the List-Unsubscribe / Auto-Submitted /
 * Precedence header (Phase B), not the body shape.
 *
 * A weighted score with a threshold (not a single rule) keeps a lone weak hit —
 * e.g. a corporate signature that happens to contain "unsubscribe" — from
 * misflagging a genuine human reply. Weights are deliberately conservative: only
 * signals humans essentially NEVER produce (tracking pixel, leaked placeholder,
 * ESP id, no-reply sender) can flip the verdict on their own.
 */
export interface EmailClassificationInput {
  /** Original HTML/text body. */
  rawBody?: string | null;
  /** Message-ID header (stored on every row). */
  messageId?: string | null;
  /** Sender address (for no-reply/mailer detection). */
  fromAddress?: string | null;
}

export interface EmailClassification {
  kind: 'human' | 'automated';
  /** Automated-signal score; higher = more template/system-like. */
  score: number;
  /** Which rules fired — for logging / debugging / tuning. */
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
/** A 1×1 pixel, whether sized by width/height attrs (either order) or by an
 *  inline `width:1px;height:1px` style. Humans never embed these. */
const TRACKING_PIXEL_RE = /<img\b[^>]*?(?:width\s*=\s*["']?1["']?[^>]*?height\s*=\s*["']?1["']?|height\s*=\s*["']?1["']?[^>]*?width\s*=\s*["']?1["']?|style\s*=\s*["'][^"']*?width\s*:\s*1px[^"']*?height\s*:\s*1px)/i;
/** Leaked merge tags from a template engine that didn't render. */
const PLACEHOLDER_RE = /\{\{\s*[\w.]+\s*\}\}|%[A-Z][A-Z0-9_]{2,}%|\[(?:FIRST_?NAME|LAST_?NAME|FULL_?NAME|NAME|EMAIL|RECIPIENT|USER(?:NAME)?)\]/;
/** Sender local-part that only ever sends automated mail. */
const NOREPLY_RE = /(?:no[-_.]?reply|donotreply|do[-_.]?not[-_.]?reply)|^(?:notifications?|mailer|mailer-daemon|bounce[-+.\w]*|postmaster|automated?|system)@/i;

/** Automated if the score reaches this. Tuned so any ONE strong signal
 *  (pixel/placeholder/ESP-id/no-reply, each ≥ 3) flips it, but weak structural
 *  hints must combine. */
const AUTOMATED_THRESHOLD = 3;

function espMessageIdDomain(messageId: string): boolean {
  const at = messageId.lastIndexOf('@');
  if (at === -1) return false;
  const domain = messageId
    .slice(at + 1)
    .replace(/[>\s]+$/, '')
    .toLowerCase();
  if (!domain) return false;
  return ESP_MESSAGE_ID_DOMAINS.some((d) => domain === d || domain.endsWith('.' + d) || domain.includes(d));
}

export function classifyEmail(input: EmailClassificationInput): EmailClassification {
  const body = input.rawBody || '';
  const messageId = (input.messageId || '').toLowerCase();
  const from = (input.fromAddress || '').trim().toLowerCase();

  const signals: string[] = [];
  let score = 0;
  const add = (points: number, signal: string) => { score += points; signals.push(signal); };

  // Strong: signals humans essentially never produce.
  if (TRACKING_PIXEL_RE.test(body)) add(3, 'tracking-pixel');
  if (PLACEHOLDER_RE.test(body)) add(3, 'unrendered-placeholder');
  if (messageId && espMessageIdDomain(messageId)) add(3, 'esp-message-id');
  if (from && NOREPLY_RE.test(from)) add(3, 'noreply-sender');

  // Medium: common in bulk mail but occasionally in a human footer/quote, so it
  // can't flip the verdict on its own.
  if (UNSUBSCRIBE_RE.test(body)) add(2, 'unsubscribe-copy');

  return { kind: score >= AUTOMATED_THRESHOLD ? 'automated' : 'human', score, signals };
}

/** Convenience: is this a real person's conversation turn (vs. a template /
 *  system / bulk message)? */
export function isConversationEmail(input: EmailClassificationInput): boolean {
  return classifyEmail(input).kind === 'human';
}
