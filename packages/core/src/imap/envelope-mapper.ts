// Maps a parsed IMAP envelope to the address/subject display fields of an
// EmailRecord. Single source of truth for the decode + address-join logic so
// the ingest path (message-processor) and the repair path (sync-engine) can't
// drift.

import libmime from 'libmime';

import type { EmailAddress, IMAPMessage } from '../types/imap';
import type { EmailRecord } from '../types/models';

export type EnvelopeFields = Pick<
  EmailRecord,
  | 'subject'
  | 'fromAddress'
  | 'fromName'
  | 'toAddress'
  | 'toNames'
  | 'ccAddress'
  | 'ccNames'
  | 'bccAddress'
  | 'bccNames'
  | 'replyTo'
>;

const joinAddresses = (addrs?: EmailAddress[]): string =>
  (addrs ?? []).map((a) => a.address).join(', ');

const joinNames = (addrs?: EmailAddress[]): string =>
  (addrs ?? []).map((a) => libmime.decodeWords(a.name || a.address)).join(', ');

/**
 * Resolve the sender from the ENVELOPE `from` list.
 *
 * An UNQUOTED COMMA in a display name (RFC-violating, e.g.
 * `From: Google Cloud Platform, and APIs <CloudPlatform-noreply@google.com>`)
 * makes the IMAP ENVELOPE split one sender into several entries — a name-only
 * fragment (`Google Cloud Platform`) plus the addressed one (`and APIs <addr>`).
 * Reading only `from[0]` then showed a truncated name like "and APIs". So: the
 * real mailbox is the entry that HAS an address, and when at most one entry has
 * an address we treat the whole list as one sender and rejoin the name fragments
 * (in header order). A normal single-entry From is returned unchanged.
 */
function resolveFrom(from?: EmailAddress[]): { address: string; name: string | null } {
  const list = from ?? [];
  if (list.length === 0) return { address: '', name: null };
  const addressed = list.find((a) => a.address);
  const address = addressed?.address || list[0]?.address || '';
  const addressedCount = list.filter((a) => a.address).length;
  let name: string | null;
  if (list.length > 1 && addressedCount <= 1) {
    const parts = list.map((a) => a.name).filter(Boolean) as string[];
    name = parts.length ? parts.join(', ') : (addressed?.name ?? list[0]?.name ?? null);
  } else {
    name = addressed?.name ?? list[0]?.name ?? null;
  }
  return { address, name: name ? libmime.decodeWords(name) : null };
}

export function mapEnvelopeFields(envelope: IMAPMessage['envelope']): EnvelopeFields {
  const from = resolveFrom(envelope.from);
  return {
    subject: libmime.decodeWords(envelope.subject || ''),
    fromAddress: from.address,
    fromName: from.name,
    toAddress: joinAddresses(envelope.to),
    toNames: joinNames(envelope.to),
    ccAddress: envelope.cc?.length ? joinAddresses(envelope.cc) : null,
    ccNames: envelope.cc?.length ? joinNames(envelope.cc) : null,
    bccAddress: envelope.bcc?.length ? joinAddresses(envelope.bcc) : null,
    bccNames: envelope.bcc?.length ? joinNames(envelope.bcc) : null,
    replyTo: envelope.replyTo?.[0]?.address || null,
  };
}
