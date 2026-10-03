import { describe, expect, it } from 'vitest';

import { ImapFlowClient } from '../../../src/imap/imapflow-client';
import { receivingAuthserv } from '../../../src/imap/receiving-authserv';
import type { IMAPMessage } from '../../../src/types/imap';

/**
 * Whose `Authentication-Results` an account believes.
 *
 * What breaks if this file goes red: a Gmail account believes whichever
 * `Authentication-Results` sits on top instead of Gmail's own — or, worse, an
 * unknown provider is handed an authserv-id its server never writes, and every
 * message on it loses its verdict and reads as unverified.
 */
describe('receivingAuthserv', () => {
  it('names Gmail\'s receiving server for a Gmail account', () => {
    expect(receivingAuthserv('imap.gmail.com')).toEqual(['mx.google.com']);
    expect(receivingAuthserv('imap.googlemail.com')).toEqual(['mx.google.com']);
  });

  // Hosts come from user-edited account settings: the lookup must not hinge
  // on how they were typed.
  it('ignores case, surrounding whitespace and a trailing dot', () => {
    expect(receivingAuthserv(' IMAP.Gmail.com. ')).toEqual(['mx.google.com']);
  });

  // Unknown means "believe the topmost header" — never "believe nothing",
  // which a guessed name would silently turn it into.
  it('knows nothing about other providers, or about no host at all', () => {
    expect(receivingAuthserv('imap.sarv.com')).toBeUndefined();
    expect(receivingAuthserv('outlook.office365.com')).toBeUndefined();
    expect(receivingAuthserv('')).toBeUndefined();
    expect(receivingAuthserv(null)).toBeUndefined();
    expect(receivingAuthserv(undefined)).toBeUndefined();
  });
});

type Internals = { toIMAPMessage: (m: unknown) => IMAPMessage; connectedHost: string | null };

const toMessage = (host: string | null) => {
  const client = new ImapFlowClient() as unknown as Internals;
  client.connectedHost = host;
  return client.toIMAPMessage({
    uid: 1,
    envelope: { messageId: '<m@x>' },
    headers: Buffer.from('Authentication-Results: mx.google.com; dmarc=pass\r\n', 'utf8'),
  });
};

describe('ImapFlowClient tags each message with its server\'s authserv-id', () => {
  // The client is the one piece that knows which server a message came from;
  // tagging it here is what lets ingest, the header backfill and the v100
  // re-check all read the verdict by the same rule without being told.
  it('carries the receiving server\'s id on a message fetched from Gmail', () => {
    const msg = toMessage('imap.gmail.com');
    expect(msg.authserv).toEqual(['mx.google.com']);
    expect(msg.authHeaders).toBe('Authentication-Results: mx.google.com; dmarc=pass');
  });

  it('carries none for a provider it does not know, or before any connect', () => {
    expect(toMessage('imap.sarv.com')).not.toHaveProperty('authserv');
    expect(toMessage(null)).not.toHaveProperty('authserv');
  });
});
