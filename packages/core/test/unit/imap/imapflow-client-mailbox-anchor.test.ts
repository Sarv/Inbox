import { describe, expect, it, vi } from 'vitest';

import { ImapFlowClient } from '../../../src/imap/imapflow-client';

/**
 * A whole-mailbox enumeration answers with bare UIDs — there is no mailbox in the
 * reply. The caller decides which folder those UIDs belong to, and then DELETES
 * every local row missing from the set. So the only thing standing between a
 * re-selected connection and mass deletion is this client proving that the answer
 * came from the mailbox the caller asked about.
 *
 * On 2026-09-13 it did not. `ensureCurrentFolder()` checked only the client's own
 * `currentFolder` bookkeeping field, which a recycled pooled connection leaves
 * stale-but-non-null. A 917-message folder was enumerated as INBOX's 24,662 UIDs,
 * every completeness guard downstream passed (a wrong list that is LARGER than
 * the folder defeats all of them), and 410 live messages were deleted.
 *
 * These pin the anchor at all three instants it has to hold: before the command,
 * after the round-trip, and — for a chunked enumeration — between chunks.
 */

interface Internals {
  client: unknown;
  connectionState: string;
  currentFolder: string | null;
}

type FakeMailbox = { path: string; uidNext?: number; exists?: number };

/** A connected client whose live mailbox the test can move under it. */
function makeClient(mailbox: FakeMailbox | null, overrides: Record<string, unknown> = {}) {
  const client = new ImapFlowClient();
  const inner = {
    usable: true,
    mailbox,
    stats: () => ({ sent: 0, received: 0 }),
    search: vi.fn(async () => [1, 2, 3]),
    fetchAll: vi.fn(async () => [{ uid: 1, flags: new Set(['\\Seen']) }]),
    close: vi.fn(),
    ...overrides,
  };
  (client as unknown as Internals).client = inner;
  (client as unknown as Internals).connectionState = 'selected';
  (client as unknown as Internals).currentFolder = mailbox?.path ?? null;
  return { client, inner };
}

describe('ImapFlowClient — mailbox anchoring', () => {
  it('refuses to enumerate when the live mailbox is not the folder the caller named', () => {
    // THE bug, in one assertion: the caller believes it is reconciling "Interview";
    // the connection actually has INBOX open. Returning INBOX's UIDs here is what
    // deleted 410 messages.
    const { client } = makeClient({ path: 'INBOX' });
    return expect(client.fetchAllUIDs('Interview')).rejects.toThrow(/Mailbox mismatch/);
  });

  it('refuses when its own currentFolder is stale after a connection recycle', () => {
    // The recycle path: the class still thinks "Interview" is selected because
    // nothing told it otherwise, while the reused socket has INBOX open. No caller
    // passed an expected path here — the live mailbox alone must catch it.
    const { client } = makeClient({ path: 'INBOX' });
    (client as unknown as Internals).currentFolder = 'Interview';
    return expect(client.fetchAllUIDs()).rejects.toThrow(/Mailbox mismatch/);
  });

  it('refuses when no mailbox is open at all', () => {
    // A non-null currentFolder used to be accepted as proof a folder was selected.
    // An enumeration against no mailbox is not an empty folder — it is no answer.
    const { client } = makeClient(null);
    (client as unknown as Internals).currentFolder = 'Interview';
    return expect(client.fetchAllUIDs()).rejects.toThrow(/No folder selected/);
  });

  it('re-checks AFTER the round-trip, catching a re-select that lands mid-flight', async () => {
    // Checking only before the command guards the wrong instant: pooled
    // connections are recycled on op timeouts, which happens WHILE the search is
    // outstanding. The reply then describes a mailbox nobody asked about.
    const mailbox: FakeMailbox = { path: 'Interview' };
    const { client } = makeClient(mailbox, {
      search: vi.fn(async () => { mailbox.path = 'INBOX'; return [1, 2, 3]; }),
    });
    await expect(client.fetchAllUIDs('Interview')).rejects.toThrow(/Mailbox mismatch/);
  });

  it('re-checks between chunks of the fallback enumeration', async () => {
    // The chunked path splices many replies into one set. A re-select part-way
    // through would mix two mailboxes' UIDs into a single "complete" list — the
    // worst possible input to a deletion diff.
    const mailbox: FakeMailbox = { path: 'Interview', uidNext: 7000 };
    let calls = 0;
    const { client } = makeClient(mailbox, {
      search: vi.fn(async () => { throw new Error('SEARCH not supported'); }),
      fetchAll: vi.fn(async () => {
        calls += 1;
        if (calls === 2) mailbox.path = 'INBOX';
        return [{ uid: calls }];
      }),
    });
    await expect(client.fetchAllUIDs('Interview')).rejects.toThrow(/Mailbox mismatch/);
    expect(calls).toBe(2); // stopped at the chunk that moved, did not keep collecting
  });

  it('anchors the batched flag fetch too', async () => {
    // Flags are applied to local rows BY UID. Another mailbox's flags land on
    // whichever of this folder's messages happen to share a UID number — silently
    // flipping read/unread and starred on unrelated mail.
    const { client } = makeClient({ path: 'INBOX' });
    await expect(client.fetchFlagsOnly([1, 2, 3], undefined, 'Interview')).rejects.toThrow(/Mailbox mismatch/);
  });

  it('lets a matching mailbox through untouched', () => {
    // The guard must not become a reason the reconcile never runs: the ordinary
    // case still has to return the folder's UIDs.
    const { client } = makeClient({ path: 'Interview' });
    return expect(client.fetchAllUIDs('Interview')).resolves.toEqual([1, 2, 3]);
  });

  it('reports uidNext in the live mailbox state', () => {
    // The downstream provenance guard needs it: nothing in a folder can carry a
    // UID at or above its own UIDNEXT.
    const { client } = makeClient({ path: 'Interview', uidNext: 986, exists: 917 });
    expect(client.getCurrentMailboxState()).toMatchObject({ path: 'Interview', uidNext: 986, exists: 917 });
  });
});
