/**
 * Bulk / notification mail vs. a real person's message — the ONE answer.
 *
 * Three places used to answer this question independently: `detectBulk()` in the
 * IMAP client (header-only, at ingest, the verdict stored as the `|bulk|` tag),
 * `hasBulkHeaders()` in the importance scorer, and a renderer-side classifier
 * that never had a caller. A mail client that disagrees with itself about what a
 * message IS renders it two different ways on two screens and threads it a
 * third. Everything here is exported so those callers can share one rule set.
 *
 * Two layers, deliberately kept apart:
 *
 *   * HEADERS ({@link bulkHeaderSignals}, now in `@sarv-in/mailguard`
 *     and re-exported here) — what a bulk sender is REQUIRED to
 *     set: RFC 2919 `List-Id`, RFC 2369 `List-Unsubscribe`, `Precedence`, RFC
 *     3834 `Auto-Submitted`, and the `Feedback-ID` bulk senders add for
 *     Google Postmaster. Cheap, unambiguous, available before the body is
 *     downloaded. This layer alone decides the stored `|bulk|` tag, because that
 *     tag also gates threading (`thread-resolver` excludes bulk mail from the
 *     same-subject fallback) and threading must never hinge on a guess.
 *
 *   * CONTENT ({@link assessBulkMail}) — a weighted score for the places that
 *     want a verdict on a message already in hand. Only consulted when the
 *     headers and the sender address have not already decided.
 *
 * Every content rule runs on the sender's OWN words — {@link stripQuotedTail} of
 * the readable text — and never on the raw body. This is not a refinement, it is
 * the bug that made an earlier version unusable: scoring the raw body scores the
 * quoted history too, so quoting one newsletter into a reply condemned the
 * reply, and since quoted history only grows with a thread, the false-positive
 * rate rose with every round of a real conversation.
 *
 * DELIBERATELY NOT scored: "designed/heavy HTML", low text-to-HTML ratio, and
 * markup-density counts. They fire on ordinary long Outlook mail (huge markup,
 * inline styles, layout tables for a one-line reply) and they grow with thread
 * length rather than with automation, so they measure the wrong thing twice.
 * Also dropped: the 1x1 tracking-pixel rule — spacer gifs are used for layout by
 * perfectly ordinary signature templates, and `List-Unsubscribe` / `Feedback-ID`
 * identify the same senders from the headers without guessing.
 */
import {
  bulkHeaderSignals,
  BULK_HEADER_NAMES,
  hasBulkHeaderSignal,
  headerLookupFromText,
  headerValueFromText,
  headerValuesFromText,
  type BulkHeaderSignals,
  type HeaderLookup,
} from '@sarv-in/mailguard/headers';

import { htmlToPlainText } from './html-text';
import { stripQuotedTail } from './quoted-text';
import { isNoReplyAddress } from './role-address';
import { hasTag } from './tags';

// The HEADER layer described above now lives in `@sarv-in/mailguard`,
// which is where the spam filter it feeds went. Re-exported from here because
// the rule it encodes is the same one this module's CONTENT layer defers to,
// and because every caller in this repo already knows it by this module's
// name. There is exactly one implementation either way.
//
// Imported from the `/headers` subpath, NOT the package root, and that is
// load-bearing: this module is aliased straight into the renderer bundle
// (see `apps/desktop/vite/renderer-aliases.ts`), so whatever it imports, the
// browser imports. The root entry pulls in the scorer's address parser and
// freemail corpus — the latter a CommonJS array with no default export, which
// the Vite dev server serves unconverted and which blanks the window.
// `/headers` is zero-dependency by contract, and the library has a test that
// keeps it that way.
export {
  bulkHeaderSignals,
  // The headers `bulkHeaderSignals` reads. Re-exported so the IMAP fetch asks
  // for exactly these — a header this list names but the fetch omits is a
  // signal that silently never fires.
  BULK_HEADER_NAMES,
  hasBulkHeaderSignal,
  headerLookupFromText,
  headerValueFromText,
  headerValuesFromText,
  type BulkHeaderSignals,
  type HeaderLookup,
};

export interface BulkMailInput {
  /** The stored `|a|b|c|` tag string. `|bulk|` is the header verdict. */
  tags?: string | null;
  /** Sender address, for the no-reply / machine-mailbox check. */
  fromAddress?: string | null;
  /** Message-ID header, for the ESP-domain check. */
  messageId?: string | null;
  /** Original HTML (or plain) body. Absent until the body is fetched — the
   *  header and sender signals stand on their own, so an unfetched body only
   *  ever adds confidence, never removes it. */
  rawBody?: string | null;
}

export interface BulkMailAssessment {
  isBulk: boolean;
  /** Higher = more template/system/blast-like. */
  score: number;
  /** Which rules fired — for logging and for tuning. Content rules are only
   *  EVALUATED when the cheap ones left the verdict open, so their absence here
   *  means "not asked", not always "not present". */
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

/** Hosts that exist to COUNT a click and redirect. A person writing their own
 *  mail links to the destination; only a campaign tool rewrites every link
 *  through one of these. Overlaps the Message-ID list above on purpose — the
 *  same vendor shows up in both places and each list is checked against a
 *  different field. */
const LINK_TRACKER_DOMAINS: readonly string[] = [
  'list-manage.com', 'mailchi.mp', // Mailchimp
  'ct.sendgrid.net', 'sendgrid.net', 'sendgrid.me',
  'awstrack.me', // Amazon SES click tracking
  'mailgun.org', 'email.mailgun.net',
  'rs6.net', 'ccsend.com', 'constantcontact.com',
  'hubspotlinks.com', 'hs-sites.com',
  'mktoresp.com', 'marketo.com', 'pardot.com',
  'klclick.com', 'klaviyomail.com',
  'iterable.com', 'links.iterable.com',
  'braze.com', 'intercom-mail.com',
  'exct.net', 'exacttarget.com',
  'customeriomail.com', 'mlsend.com', 'mailerlite.com',
  'sparkpostmail.com', 'mandrillapp.com', 'brevo.com', 'sendinblue.com',
];

/** Leaked merge tags from a template engine that didn't render. */
const PLACEHOLDER_RE = /\{\{\s*[\w.]+\s*\}\}|%[A-Z][A-Z0-9_]{2,}%|\[(?:FIRST_?NAME|LAST_?NAME|FULL_?NAME|NAME|EMAIL|RECIPIENT|USER(?:NAME)?)\]/;
const UNSUBSCRIBE_RE = /\bunsubscribe\b|\bopt[-\s]?out\b|manage\s+(?:your\s+)?(?:email\s+)?preferences|update\s+your\s+preferences|email\s+preferences/i;
/** Candidate URLs in free text. Only to FIND them — each one is then handed to
 *  the platform `URL` parser, which owns the actual host/query grammar. */
const URL_CANDIDATE_RE = /https?:\/\/[^\s\]<>"')]+/gi;

/** Bulk at or above this. Tuned so any ONE strong signal (the `|bulk|` header
 *  tag, a no-reply sender, an ESP Message-ID, click-tracked links, a leaked
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

/**
 * The sender's own words: readable text, link targets kept, quoted and forwarded
 * content cut off. Everything downstream of this is safe to score; the raw body
 * is not.
 */
export function senderOwnText(rawBody: string | null | undefined): string {
  const body = rawBody || '';
  if (!body.trim()) return '';
  // An HTML body has to go through the converter to get readable text and its
  // hrefs; a plain-text part is already what we want and must not be fed to an
  // HTML parser, which would swallow anything that looks like a tag.
  const text = /<[a-z!/]/i.test(body) ? htmlToPlainText(body, { keepLinkHrefs: true }) : body;
  return stripQuotedTail(text);
}

/** The URLs in a piece of text, parsed. Unparseable candidates are dropped. */
export function urlsIn(text: string): URL[] {
  const found: URL[] = [];
  for (const candidate of text.match(URL_CANDIDATE_RE) || []) {
    try {
      found.push(new URL(candidate));
    } catch {
      // Not a URL after all (a trailing bracket, a mangled line-wrap) — skip it.
    }
  }
  return found;
}

function isTrackerHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return LINK_TRACKER_DOMAINS.some((d) => host === d || host.endsWith('.' + d));
}

/** Score the message, and say which rules fired. */
export function assessBulkMail(input: BulkMailInput): BulkMailAssessment {
  const messageId = (input.messageId || '').toLowerCase();

  const signals: string[] = [];
  let score = 0;
  const add = (points: number, signal: string) => {
    score += points;
    signals.push(signal);
  };

  // Strongest: the sender declared it, in the headers the RFCs reserve for it.
  if (hasTag(input.tags || '', 'bulk')) add(3, 'bulk-header');

  // Strong, and free: signals a person's mail client essentially never produces.
  if (isNoReplyAddress(input.fromAddress)) add(3, 'noreply-sender');
  if (messageId && hasEspMessageIdDomain(messageId)) add(3, 'esp-message-id');

  // Reading the body means converting HTML to text on the calling thread, per
  // message. Skip it entirely once the cheap signals have already decided.
  if (score >= BULK_THRESHOLD) return { isBulk: true, score, signals };

  const own = senderOwnText(input.rawBody);
  if (!own) return { isBulk: score >= BULK_THRESHOLD, score, signals };

  const urls = urlsIn(own);
  // Every link rewritten through a click counter: a campaign tool did that, not
  // a person. Safe to decide alone ONLY because the quoted chain is already cut
  // off above — a human quoting a newsletter keeps its tracker links.
  if (urls.some((url) => isTrackerHost(url.hostname))) add(3, 'tracker-domain-links');
  if (PLACEHOLDER_RE.test(own)) add(3, 'unrendered-placeholder');

  // Medium: real, but reachable by hand. Someone can paste a campaign link into
  // their own message, and a corporate footer can say "unsubscribe" — neither
  // may condemn a message on its own.
  if (urls.some((url) => [...url.searchParams.keys()].some((key) => key.toLowerCase().startsWith('utm_')))) {
    add(2, 'utm-campaign-links');
  }
  if (UNSUBSCRIBE_RE.test(own)) add(2, 'unsubscribe-copy');

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
