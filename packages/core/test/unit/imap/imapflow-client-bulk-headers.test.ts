import { describe, expect, it, vi } from 'vitest';

import { ImapFlowClient } from '../../../src/imap/imapflow-client';
import { BULK_HEADER_NAMES } from '../../../src/utils/bulk-mail';

/**
 * `isBulk` on a synced message, decided from the header block the FETCH asked
 * for and nothing else.
 *
 * What breaks if this file goes red: the `|bulk|` tag stops being stamped at
 * sync. That tag is not cosmetic — `thread-resolver` reads it to suppress the
 * 48h same-subject fallback, so without it every recurring notification with a
 * fixed subject ("Daily Email Digest") collapses into one ever-growing thread.
 *
 * The verdict must stay HEADER-derived. Guessing it from the body is what put
 * human replies in the bulk bucket, because a reply carries the quoted
 * newsletter it is replying to.
 */

type Internals = {
  detectBulk: (headers: Buffer | undefined) => boolean;
  headerValue: (headers: Buffer | undefined, name: string) => string | null;
};

const internals = () => new ImapFlowClient() as unknown as ImapFlowClient & Internals;

const block = (...lines: string[]) => Buffer.from(lines.join('\r\n') + '\r\n', 'utf8');

const HUMAN = block(
  'From: Mitali <mitali@acme.example>',
  'To: me@acme.example',
  'Subject: Re: API doc review',
  'In-Reply-To: <a1@mail.gmail.com>',
  'X-Mailer: Apple Mail (2.3774.600.62)',
);

describe('ImapFlowClient bulk detection', () => {
  // The three signals sync has always read. Each alone is enough.
  it('flags the RFC list headers and Precedence', () => {
    const c = internals();
    expect(c.detectBulk(block('List-Unsubscribe: <https://brand.example/u>'))).toBe(true);
    expect(c.detectBulk(block('List-Id: <news.brand.example>'))).toBe(true);
    expect(c.detectBulk(block('Precedence: bulk'))).toBe(true);
  });

  // NEW ARM. Feedback-ID is what bulk senders attach for Google Postmaster
  // Tools; plenty of notification mail carries it and nothing else.
  it('flags Feedback-ID', () => {
    expect(internals().detectBulk(block('Feedback-ID: 1:campaign:brand'))).toBe(true);
  });

  // NEW ARM. RFC 3834 — anything but `no` means a machine composed it.
  it('flags Auto-Submitted unless it says no', () => {
    const c = internals();
    expect(c.detectBulk(block('Auto-Submitted: auto-generated'))).toBe(true);
    expect(c.detectBulk(block('Auto-Submitted: auto-replied'))).toBe(true);
    expect(c.detectBulk(block('Auto-Submitted: no'))).toBe(false);
  });

  // THE EXPENSIVE DIRECTION: a person's reply wrongly tagged `|bulk|` loses its
  // thread. A real reply carries none of these headers.
  it('leaves an ordinary human reply unflagged', () => {
    expect(internals().detectBulk(HUMAN)).toBe(false);
  });

  // A message fetched without its header block must not be guessed at.
  it('says nothing when there are no headers', () => {
    expect(internals().detectBulk(undefined)).toBe(false);
    expect(internals().detectBulk(Buffer.alloc(0))).toBe(false);
  });

  // The header list the FETCH asks for is built from the same constant the
  // detector reads, so the two cannot drift: a header the detector wants but
  // the fetch omits is a rule that silently never fires in production while
  // passing every unit test that hands it a hand-built block.
  it('reads only headers the fetch asks for', () => {
    const c = internals();
    // A value that makes each named header fire, so the loop proves every name
    // in the constant is one the detector actually acts on.
    const firing: Record<string, string> = {
      'list-id': '<news.brand.example>',
      'list-unsubscribe': '<https://brand.example/u>',
      precedence: 'bulk',
      'auto-submitted': 'auto-generated',
      'feedback-id': '1:campaign:brand',
    };
    for (const name of BULK_HEADER_NAMES) {
      expect(firing[name], `BULK_HEADER_NAMES gained "${name}" with no case here`).toBeDefined();
      expect(c.detectBulk(block(`${name}: ${firing[name]}`)), name).toBe(true);
    }
  });

  // Header lookup is case-insensitive and unfolds a wrapped value — a real
  // List-Unsubscribe with both a mailto and an https entry wraps.
  it('reads a folded header value whole, whatever its case', () => {
    const c = internals();
    const folded = block('list-unsubscribe: <mailto:u@x.example>,', ' <https://x.example/u>', 'Subject: hi');
    expect(c.headerValue(folded, 'List-Unsubscribe')).toBe('<mailto:u@x.example>, <https://x.example/u>');
    expect(c.detectBulk(folded)).toBe(true);
  });
});

/**
 * The header block the FETCH asks for, as a list.
 *
 * What breaks if this goes red: the Unsubscribe button offers a web PAGE on
 * every message, forever. `List-Unsubscribe-Post` is the ONLY evidence that a
 * one-click POST is permitted (RFC 8058) — it is not a bulk signal, so nothing
 * in BULK_HEADER_NAMES pulls it down, and a header the fetch never requests is
 * absent from `rawHeaders` in exactly the same way as a header the sender
 * never wrote.
 */
describe('ImapFlowClient fetch header list', () => {
  it('asks for the RFC 8058 one-click companion alongside the list headers', async () => {
    const client = internals();
    const fetchAll = vi.fn(async () => []);
    (client as unknown as { client: unknown }).client = {
      usable: true,
      mailbox: { path: 'INBOX' },
      stats: () => ({ sent: 0, received: 0 }),
      fetchAll,
    };
    (client as unknown as { connectionState: string }).connectionState = 'selected';
    (client as unknown as { currentFolder: string }).currentFolder = 'INBOX';

    await (client as unknown as {
      fetchInternal: (range: string, useUid: boolean, options?: unknown) => Promise<unknown>;
    }).fetchInternal('1:5', true, {});

    const { headers } = fetchAll.mock.calls[0][1] as unknown as { headers: string[] };
    expect(headers).toContain('list-unsubscribe-post');
    // Its partner rides in on BULK_HEADER_NAMES; both are needed to decide the
    // route, so assert the pair rather than only the new name.
    expect(headers).toContain('list-unsubscribe');
  });
});
