import { describe, expect, it, vi } from 'vitest';

import { ImapFlowClient } from '../../../src/imap/imapflow-client';

/**
 * What breaks if this file fails: a message the user sent is never filed in
 * their Sent folder on the server, and the app burns an IMAP connection a
 * minute forever trying.
 *
 * The Message-ID map is an ENVELOPE fetch — one envelope per message in the
 * range. Asked for `1:*` on a 1,718-message Sent folder it ran past the
 * client's 60s op timeout; the timeout handler recycles the wedged connection,
 * which killed the socket the APPEND was about to use, so the Sent copy failed
 * with "Not connected to IMAP server" and the retry repeated the whole thing.
 *
 * The caller that only asks "is the message I just sent already here?" needs
 * the newest few messages, not the mailbox. These pin the range it actually
 * puts on the wire — nothing else can see it.
 */

interface Internals {
  client: unknown;
  connectionState: string;
  currentFolder: string | null;
}

type FakeMailbox = { path: string; exists?: number };

const envelopes = [
  { uid: 11, envelope: { messageId: '<A@sent.example>' } },
  { uid: 12, envelope: { messageId: 'b@sent.example' } },
];

/** A connected client whose live mailbox and fetch the test can inspect. */
function makeClient(mailbox: FakeMailbox | null) {
  const client = new ImapFlowClient();
  const fetchAll = vi.fn(async () => envelopes);
  const inner = {
    usable: true,
    mailbox,
    stats: () => ({ sent: 0, received: 0 }),
    fetchAll,
    close: vi.fn(),
  };
  (client as unknown as Internals).client = inner;
  (client as unknown as Internals).connectionState = 'selected';
  (client as unknown as Internals).currentFolder = mailbox?.path ?? null;
  return { client, fetchAll };
}

/** The sequence range the client actually asked the server for. */
const rangeAsked = (fetchAll: ReturnType<typeof vi.fn>): string => fetchAll.mock.calls[0][0] as string;

describe('ImapFlowClient — Message-ID map window', () => {
  // The deletion reconcile needs every message, and must keep getting it.
  it('scans the whole mailbox when no window is asked for', async () => {
    const { client, fetchAll } = makeClient({ path: 'Sent', exists: 1718 });

    await client.fetchMessageIdToUidMap('Sent');

    expect(rangeAsked(fetchAll)).toBe('1:*');
  });

  // THE fix: 50 envelopes instead of 1,718, on the account where 1,718 timed out.
  it('asks only for the newest N messages when given a window', async () => {
    const { client, fetchAll } = makeClient({ path: 'Sent', exists: 1718 });

    await client.fetchMessageIdToUidMap('Sent', { recent: 50 });

    expect(rangeAsked(fetchAll)).toBe('1669:*');
  });

  // A window wider than the mailbox is the whole mailbox — never a range that
  // starts below 1, which servers reject outright.
  it.each([
    { exists: 50, label: 'exactly the window' },
    { exists: 3, label: 'smaller than the window' },
  ])('scans everything when the mailbox is $label', async ({ exists }) => {
    const { client, fetchAll } = makeClient({ path: 'Sent', exists });

    await client.fetchMessageIdToUidMap('Sent', { recent: 50 });

    expect(rangeAsked(fetchAll)).toBe('1:*');
  });

  // No EXISTS means no way to bound the window. A scan that cannot be bounded
  // must be COMPLETE: a caller reading a truncated map concludes the message
  // isn't on the server, and a silently partial answer to "is it already here?"
  // is worse than a slow one.
  it('scans everything when the server reported no message count', async () => {
    const { client, fetchAll } = makeClient({ path: 'Sent' });

    await client.fetchMessageIdToUidMap('Sent', { recent: 50 });

    expect(rangeAsked(fetchAll)).toBe('1:*');
  });

  it.each([{ recent: 0 }, { recent: -5 }])(
    'treats a window of $recent as no window at all',
    async ({ recent }) => {
      const { client, fetchAll } = makeClient({ path: 'Sent', exists: 1718 });

      await client.fetchMessageIdToUidMap('Sent', { recent });

      expect(rangeAsked(fetchAll)).toBe('1:*');
    },
  );

  // The map's keys are what every caller looks a message up by, windowed or not.
  it('keys the window by bracket-stripped, lower-cased Message-ID', async () => {
    const { client } = makeClient({ path: 'Sent', exists: 1718 });

    const map = await client.fetchMessageIdToUidMap('Sent', { recent: 50 });

    expect(map.get('a@sent.example')).toBe(11);
    expect(map.get('b@sent.example')).toBe(12);
  });

  // The window must not cost the mailbox anchor: these UIDs are used to EXPUNGE,
  // so an answer from the wrong mailbox deletes an unrelated message.
  it('still refuses when the connection has another mailbox open', async () => {
    const { client, fetchAll } = makeClient({ path: 'INBOX', exists: 1718 });

    await expect(client.fetchMessageIdToUidMap('Sent', { recent: 50 })).rejects.toThrow(
      /Mailbox mismatch/,
    );
    expect(fetchAll).not.toHaveBeenCalled();
  });
});
