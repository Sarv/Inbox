/**
 * The header stage: everything a message's own headers can decide, in ONE place.
 *
 * Three columns come out of it — `auth_status`, `spam_score`/`spam_reasons`,
 * and `origin_ip` — and two callers produce them: `convertMessage` when mail
 * arrives, and the header backfill when it sweeps mail that predates the
 * columns. Those two must agree. A score that depends on which code path
 * happened to write it is not a score; it means the Spam filter view lists a
 * message today that an identical message tomorrow would not appear in, and
 * nobody could tell which run was right.
 *
 * So the derivation lives here, as one pure function over an `IMAPMessage`,
 * and both callers get their answer from it. The inputs it reads are exactly
 * the ones a headers-only FETCH returns — envelope, `rawHeaders`, INTERNALDATE
 * — which is what makes the backfill possible at all: the same round-trip that
 * re-reads an authentication verdict already carries everything the scorer
 * needs.
 */
import {
  assessSpamSignals,
  extractOriginIp,
  headerLookupFromText,
  headerValueFromText,
  headerValuesFromText,
  parseAuthenticationHeaders,
  type AuthStatus,
  type SpamAssessment,
} from '@sarv-in/mailguard';

import type { IMAPMessage } from '../types/imap';

import { mapEnvelopeFields } from './envelope-mapper';

/** A Date as unix seconds, or null when absent or unparseable (an invalid Date has a NaN time). */
function toUnixSeconds(value: Date | string | null | undefined): number | null {
  if (!value) return null;
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
}

export interface HeaderStageOptions {
  /** The user has reported this sender (a `spammers` row). */
  knownSpammer?: boolean;
  /** The user's own outgoing mail (Sent / Drafts) — never spam-scored. */
  ownMail?: boolean;
}

/** The two `List-Unsubscribe*` headers, verbatim — see utils/unsubscribe. */
export interface UnsubscribeHeaders {
  listUnsubscribe: string | null;
  listUnsubscribePost: string | null;
}

/**
 * Lift the unsubscribe headers out of a fetched message's header block.
 *
 * Verbatim, unparsed and unvalidated: which entry of `List-Unsubscribe` is
 * useful depends on what the reader asks for later, and a parser improved next
 * month should improve every message already stored rather than only the ones
 * synced after it. The parsing lives in utils/unsubscribe and runs at read time.
 *
 * Unfolding is `headerValueFromText`'s job — these headers are long enough that
 * real senders wrap them, and a value cut at the fold is a URL that 404s.
 */
export function unsubscribeHeaders(rawHeaders: string | null | undefined): UnsubscribeHeaders {
  if (!rawHeaders) return { listUnsubscribe: null, listUnsubscribePost: null };
  return {
    listUnsubscribe: headerValueFromText(rawHeaders, 'list-unsubscribe'),
    listUnsubscribePost: headerValueFromText(rawHeaders, 'list-unsubscribe-post'),
  };
}

export interface HeaderStageResult {
  /** SPF / DKIM / DMARC as the receiving server recorded it; null when it recorded none. */
  auth: AuthStatus | null;
  /** Null for own mail — "not judged", which the shield renders differently from "judged clean". */
  spam: SpamAssessment | null;
  /** The address that handed the message to the recipient's mail system. */
  originIp: string | null;
  /** How to leave the list, verbatim; both null when the sender offered none. */
  unsubscribe: UnsubscribeHeaders;
}

/**
 * Derive the header-stage verdicts for one fetched message.
 *
 * `auth` is parsed once and handed to the scorer rather than re-parsed, so the
 * spam score keys on the very same DMARC verdict the shield displays. Anything
 * else would let the two disagree on screen about a single message.
 */
export function headerStage(message: IMAPMessage, opts?: HeaderStageOptions): HeaderStageResult {
  const auth = message.authHeaders ? parseAuthenticationHeaders(message.authHeaders) : null;
  const headers = message.rawHeaders ? headerLookupFromText(message.rawHeaders) : null;
  const envelopeFields = mapEnvelopeFields(message.envelope);

  const spam = opts?.ownMail
    ? null
    : assessSpamSignals({
        fromAddress: envelopeFields.fromAddress,
        fromName: envelopeFields.fromName,
        replyTo: envelopeFields.replyTo,
        toAddress: envelopeFields.toAddress,
        ccAddress: envelopeFields.ccAddress,
        subject: envelopeFields.subject,
        // The id AS RECEIVED: a synthesised stand-in would hide the missing header.
        messageId: message.messageIdSynthesized ? '' : message.envelope.messageId,
        inReplyTo: message.envelope.inReplyTo,
        references: message.envelope.references.length > 0 ? message.envelope.references.join(' ') : null,
        date: toUnixSeconds(message.envelope.date),
        internalDate: toUnixSeconds(message.date),
        auth,
        headers,
        knownSpammer: opts?.knownSpammer === true,
      });

  return {
    auth,
    spam,
    originIp: extractOriginIp({
      authHeaders: message.authHeaders,
      received: message.rawHeaders ? headerValuesFromText(message.rawHeaders, 'received') : null,
    }),
    unsubscribe: unsubscribeHeaders(message.rawHeaders),
  };
}

/** An Autocrypt header seen on incoming mail, for the keyring to weigh. */
export interface AutocryptSighting {
  /** The message's From address — the only address the header may speak for. */
  fromAddress: string;
  /** The raw header value, unparsed. */
  header: string;
  /** UTC ISO-8601: when the message was sent, never later than it arrived. */
  sentAt: string;
}

/** Receives sightings. Fire-and-forget: ingest never waits on the keyring. */
export type AutocryptSink = (sighting: AutocryptSighting) => void;

/**
 * The Autocrypt header on a fetched message, or null. Exactly ONE header is
 * required — the spec treats several as none, since at most one of them can
 * be the sender's. The date is the Date header clamped to the arrival time,
 * the spec's "effective date": a message dated in the future must not win
 * "most recently seen" over every real one.
 */
export function autocryptSighting(message: IMAPMessage): AutocryptSighting | null {
  if (!message.rawHeaders) return null;
  const headers = headerValuesFromText(message.rawHeaders, 'autocrypt');
  if (headers.length !== 1) return null;
  const fromAddress = mapEnvelopeFields(message.envelope).fromAddress;
  if (!fromAddress) return null;
  const sent = toUnixSeconds(message.envelope.date);
  const arrived = toUnixSeconds(message.date);
  const effective = [sent, arrived].filter((value): value is number => value !== null);
  if (effective.length === 0) return null;
  return { fromAddress, header: headers[0], sentAt: new Date(Math.min(...effective) * 1000).toISOString() };
}
