import { describe, expect, it } from 'vitest';

import { ImapFlowClient } from '../../../src/imap/imapflow-client';
import type { IMAPMessage } from '../../../src/types/imap';

/**
 * In-Reply-To on a synced message: the raw header the FETCH asked for wins
 * over the server's ENVELOPE.
 *
 * What breaks if this file goes red: a server whose ENVELOPE repeats the
 * Message-ID in the In-Reply-To slot makes every message "a reply to itself".
 * That is a spam rule (`in-reply-to-self`), so an org's own authenticated mail
 * — and 99% of one mailbox — was charged spam points for a header it never
 * carried, and threading/follow-ups read a parent that does not exist.
 */

type Internals = { toIMAPMessage: (m: unknown) => IMAPMessage };

const toMessage = (m: unknown) =>
  (new ImapFlowClient() as unknown as Internals).toIMAPMessage(m);

const block = (...lines: string[]) => Buffer.from(lines.join('\r\n') + '\r\n', 'utf8');

const OWN_ID = '<74e6c4ea-4c50@sarv.com>';

describe('ImapFlowClient In-Reply-To', () => {
  // THE regression: ENVELOPE says reply-to-self, the message has no such header.
  it('ignores an ENVELOPE In-Reply-To the header block does not carry', () => {
    const msg = toMessage({
      uid: 1,
      envelope: { messageId: OWN_ID, inReplyTo: OWN_ID },
      headers: block(`Message-ID: ${OWN_ID}`, 'Subject: Request to Add Testing Credits'),
    });
    expect(msg.envelope.messageId).toBe(OWN_ID);
    expect(msg.envelope.inReplyTo).toBeNull();
  });

  // A real reply keeps its parent, read from the header, even when the
  // ENVELOPE got it wrong.
  it('takes In-Reply-To from the header block when it has one', () => {
    const msg = toMessage({
      uid: 2,
      envelope: { messageId: OWN_ID, inReplyTo: OWN_ID },
      headers: block(`Message-ID: ${OWN_ID}`, 'In-Reply-To: <parent@mail.gmail.com>'),
    });
    expect(msg.envelope.inReplyTo).toBe('<parent@mail.gmail.com>');
  });

  // A message that genuinely names itself still does — the spam rule must see
  // the forgery it exists to catch.
  it('keeps a genuine self-reference written in the header', () => {
    const msg = toMessage({
      uid: 3,
      envelope: { messageId: OWN_ID },
      headers: block(`Message-ID: ${OWN_ID}`, `In-Reply-To: ${OWN_ID}`),
    });
    expect(msg.envelope.inReplyTo).toBe(OWN_ID);
  });

  // Fetched without a header block (envelope-only paths), the ENVELOPE is all
  // there is, and it is still normalised to angle brackets.
  it('falls back to the ENVELOPE when there is no header block', () => {
    expect(toMessage({ uid: 4, envelope: { inReplyTo: 'p@x.example' } }).envelope.inReplyTo).toBe(
      '<p@x.example>',
    );
    expect(
      toMessage({ uid: 5, envelope: { inReplyTo: '<p@x.example>' }, headers: Buffer.alloc(0) })
        .envelope.inReplyTo,
    ).toBe('<p@x.example>');
    expect(toMessage({ uid: 6, envelope: {} }).envelope.inReplyTo).toBeNull();
  });
});
