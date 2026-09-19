/**
 * Header-only spam signals — the offline stage of the spam filter.
 *
 * Runs at ingest on every message, before a body exists and before the AI
 * ever sees it, over the same fetched headers the sync already pays for:
 * From / Reply-To / Subject / Message-ID / Date / threading, the receiving
 * server's authentication verdict, the bulk-mail headers, and any verdict an
 * upstream filter (SpamAssassin, rspamd, Exchange) already stamped on it.
 * Everything here is deterministic and local; nothing leaves the machine.
 *
 * The shape is SpamAssassin's: each rule contributes points and a reason, and
 * the total is compared with {@link SPAM_THRESHOLD}. A single rule decides on
 * its own only where the evidence is categorical — an upstream filter said so,
 * or the user themselves reported the sender. Every other rule sits below the
 * line, because each has a benign explanation alone: a forwarder breaks DKIM,
 * a home address in Reply-To, a cron job with no Message-ID. It is the
 * COMBINATION that is unmistakable, and the weights are chosen so the classic
 * ones cross the line — a spoofed display name on a message that failed DMARC
 * (3 + 3), a forged "Re:" from an unauthenticated sender (2 + 3) — while any
 * single benign anomaly does not.
 *
 * Reputation signals (DNS blocklists, reverse DNS, sender history) are a later
 * stage: they need the network, and they hang off the origin IP recorded
 * alongside this score (see origin-ip.ts). Their points add to these; they do
 * not replace them.
 *
 * The result is stored on the row (`spam_score`, `spam_reasons`) so the shield
 * can show WHY, and so a weight can later be tuned against real history rather
 * than guessed.
 */
import emailAddresses from 'email-addresses';
import freeEmailDomains from 'free-email-domains';

import type { AuthStatus } from '../processor/email-processor';

import { bulkHeaderSignals, type HeaderLookup } from './bulk-mail';
import { assessSender, domainOfAddress } from './sender-spoof';
import { SPAM_THRESHOLD, SUSPICIOUS_THRESHOLD, type SpamReason, type SpamReasonId } from './spam-verdict';
import { hasReplyPrefix, isValidMessageId } from './validators';

/**
 * Headers this stage reads beyond the envelope and {@link BULK_HEADER_NAMES}.
 * Exported so the IMAP fetch asks for exactly these — a header read here but
 * never fetched is a rule that silently never fires.
 */
export const SPAM_HEADER_NAMES: readonly string[] = [
  'x-spam-flag', // SpamAssassin / rspamd: "YES"
  'x-spam-status', // SpamAssassin: "Yes, score=7.1 required=5.0 ..."
  'x-ms-exchange-organization-scl', // Exchange / Microsoft 365 spam confidence level
];

/**
 * A Date header this far from the server's own receive time is a forgery tell
 * (SpamAssassin's DATE_IN_FUTURE_96_XX / DATE_IN_PAST_96_XX). Four days, not
 * hours: a queue can legitimately retry for days, a laptop clock can be off
 * by hours.
 */
export const DATE_SKEW_SECONDS = 96 * 3600;

export interface SpamSignalInput {
  fromAddress?: string | null;
  fromName?: string | null;
  replyTo?: string | null;
  toAddress?: string | null;
  ccAddress?: string | null;
  subject?: string | null;
  /** The Message-ID AS RECEIVED — empty/null when the sender sent none, never a synthesised one. */
  messageId?: string | null;
  inReplyTo?: string | null;
  references?: string | null;
  /** Date header, unix seconds; null when the header is absent. */
  date?: number | null;
  /** The server's INTERNALDATE, unix seconds; null when unknown. */
  internalDate?: number | null;
  /** The receiving server's SPF/DKIM/DMARC verdict, when it recorded one. */
  auth?: AuthStatus | null;
  /** Lookup over the fetched header block; null when only the envelope is known. */
  headers?: HeaderLookup | null;
  /** The user has reported this sender (the `spammers` table). */
  knownSpammer?: boolean;
}

export interface SpamAssessment {
  score: number;
  reasons: SpamReason[];
  /** score >= SPAM_THRESHOLD */
  isSpam: boolean;
  /** score >= SUSPICIOUS_THRESHOLD */
  suspicious: boolean;
}

const FREEMAIL = new Set<string>(freeEmailDomains);

/** Is this a consumer webmail address (gmail, yahoo, outlook, …)? */
export function isFreemailAddress(address: string | null | undefined): boolean {
  if (!address) return false;
  const at = address.lastIndexOf('@');
  if (at < 0) return false;
  const host = address.slice(at + 1).trim().toLowerCase();
  if (FREEMAIL.has(host)) return true;
  const registrable = domainOfAddress(address);
  return !!registrable && FREEMAIL.has(registrable);
}

/** RFC 5322 (with RFC 6532 UTF-8) says this is one deliverable address. */
function isDeliverableAddress(address: string): boolean {
  try {
    const parsed = emailAddresses.parseOneAddress({ input: address, rfc6532: true });
    return !!parsed && 'address' in parsed && !!parsed.address;
  } catch {
    return false;
  }
}

/** Score one message from its headers alone. Pure; safe to run per message at ingest. */
export function assessSpamSignals(input: SpamSignalInput): SpamAssessment {
  const reasons: SpamReason[] = [];
  const add = (id: SpamReasonId, points: number, detail: string) => {
    reasons.push({ id, points, detail });
  };
  const header = (name: string): string => (input.headers ? (input.headers(name) || '').trim() : '');

  // 1. An upstream filter already decided. Categorical: it saw the body and
  //    the network, which this stage cannot.
  const spamFlag = header('x-spam-flag');
  const spamStatus = header('x-spam-status');
  const scl = Number.parseInt(header('x-ms-exchange-organization-scl'), 10);
  if (/^yes\b/i.test(spamFlag)) {
    add('upstream-spam', 5, 'Your mail server marked it as spam (X-Spam-Flag: YES)');
  } else if (/^yes\b/i.test(spamStatus)) {
    add('upstream-spam', 5, 'Your mail server marked it as spam (X-Spam-Status: Yes)');
  } else if (Number.isFinite(scl) && scl >= 5) {
    add('upstream-spam', 5, `Exchange rated it spam (spam confidence level ${scl})`);
  }

  // 2. The user's own word.
  if (input.knownSpammer) add('known-spammer', 5, 'You reported this sender as spam');

  // 3. Authentication. DMARC is the authoritative verdict; SPF and DKIM are its
  //    inputs and either can fail benignly (a forwarder, a list). Only when the
  //    server recorded no DMARC verdict do both inputs failing stand in for it.
  //    Same rule the renderer's security level applies, so the shield's red and
  //    the filter's points always agree.
  const auth = input.auth;
  if (auth) {
    const dmarcKnown = auth.dmarc === 'pass' || auth.dmarc === 'fail';
    if (auth.dmarc === 'fail') {
      add('auth-failed', 3, 'DMARC failed — the sender’s domain did not authenticate this message');
    } else if (!dmarcKnown && auth.spf === 'fail' && auth.dkim === 'fail') {
      add('auth-failed', 3, 'SPF and DKIM both failed — the sending server is not authorised for this domain');
    }
  }

  // 4. Identity.
  for (const reason of assessSender(input.fromName, input.fromAddress)) {
    if (reason.severity === 'danger') add('display-name-spoof', 3, reason.text);
    else add('sender-punycode', 1, reason.text);
  }
  const from = (input.fromAddress || '').trim();
  if (!from) add('sender-invalid', 2, 'No sender address');
  else if (!isDeliverableAddress(from)) add('sender-invalid', 2, `The sender address “${from}” is not a valid address`);

  const fromDomain = domainOfAddress(from);
  const replyDomain = domainOfAddress(input.replyTo);
  if (fromDomain && replyDomain && fromDomain !== replyDomain) {
    if (isFreemailAddress(input.replyTo) && !isFreemailAddress(from)) {
      add('reply-to-freemail', 2, `Replies go to a free webmail address at ${replyDomain}, while the message claims to be from ${fromDomain}`);
    } else {
      add('reply-to-mismatch', 1, `Replies go to ${replyDomain}, not to the sender’s domain ${fromDomain}`);
    }
  }

  // 5. Plumbing a real mail client always gets right.
  const messageId = (input.messageId || '').trim();
  if (!messageId) add('missing-message-id', 2, 'No Message-ID header — every real mail server adds one');
  else if (!isValidMessageId(messageId)) add('malformed-message-id', 1, 'The Message-ID header is malformed');

  if (input.date == null) {
    add('missing-date', 1, 'No Date header');
  } else if (input.internalDate != null) {
    const skew = input.date - input.internalDate;
    if (Math.abs(skew) > DATE_SKEW_SECONDS) {
      const days = Math.round(Math.abs(skew) / 86_400);
      add('date-skew', 2, skew > 0 ? `Dated ${days} days AFTER it arrived` : `Dated ${days} days before it arrived`);
    }
  }

  if (hasReplyPrefix(input.subject) && !(input.inReplyTo || '').trim() && !(input.references || '').trim()) {
    add('fake-reply', 2, 'Looks like a reply, but it is not replying to anything (no In-Reply-To or References)');
  }

  if (!(input.toAddress || '').trim() && !(input.ccAddress || '').trim()) {
    add('no-recipient', 1, 'No visible recipient — sent to undisclosed recipients');
  }

  // 6. Bulk mail that does not play by the bulk-mail rules. A list or campaign
  //    tool is REQUIRED to offer List-Unsubscribe; a blast that hides it is
  //    the kind that never intended to honour one. Auto-generated transactional
  //    mail is exempt — a receipt has nothing to unsubscribe from.
  if (input.headers) {
    const bulk = bulkHeaderSignals(input.headers);
    const declaredBulk = bulk.listId || bulk.precedenceBulk || bulk.feedbackId || bulk.espTrace;
    if (declaredBulk && !bulk.listUnsubscribe && !bulk.autoSubmitted) {
      add('bulk-no-unsubscribe', 1, 'Bulk mail with no way to unsubscribe');
    }
    if (header('precedence').toLowerCase() === 'junk') {
      add('precedence-junk', 1, 'The sender labelled it junk itself (Precedence: junk)');
    }
  }

  const score = reasons.reduce((sum, r) => sum + r.points, 0);
  return { score, reasons, isSpam: score >= SPAM_THRESHOLD, suspicious: score >= SUSPICIOUS_THRESHOLD };
}
