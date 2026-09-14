import { describe, it, expect } from 'vitest';

import { actionableEmailIds, selectedEmailIdsFor } from '../../../../../src/components/email-list/bulk-selection';

/**
 * What a bulk action in the list acts on.
 *
 * THE incident this pins: a user opened Drafts, selected all, and pressed
 * Delete to clear out unsent replies. Every selection resolved to the whole
 * CONVERSATION, so the received mail each draft was replying to went to Trash
 * with it — including a "Happy Ganesh Chaturthi!" message the user had never
 * touched. In the Drafts view those siblings are not even on screen, so there
 * was no way to see what was about to be deleted.
 *
 * The asymmetry is deliberate and both halves matter:
 *   - everywhere else, a selection means the whole thread (acting on only the
 *     representative left siblings unread and the row stubbornly bold), and
 *   - in Drafts, a row IS the draft, so it must narrow to the drafts alone.
 * Collapsing either half back into the other reintroduces a real bug — one
 * cosmetic, one destroying received mail.
 */

type Row = { id: string; tags: string };
const email = (id: string, tags: string) => ({ id, tags }) as never;
const thread = (threadId: string, emails: Row[]) =>
  ({ threadId, emails: emails.map((e) => email(e.id, e.tags)) }) as never;

const DRAFT_PATHS = new Set(['Drafts']);

/** A reply-in-progress plus the message it answers — the shape that broke. */
const draftThread = thread('t1', [
  { id: 'received-1', tags: '|INBOX|read|' },
  { id: 'draft-1', tags: '|Drafts|draft|' },
]);

describe('selectedEmailIdsFor — outside Drafts', () => {
  // Narrowing here would leave a thread's older messages unread while the row
  // showed as read — the bug the thread-wide rule was introduced to fix.
  it('acts on every message in a selected thread', () => {
    expect(
      selectedEmailIdsFor({
        visibleThreads: [draftThread],
        selectedThreadIds: new Set(['t1']),
        viewIsDrafts: false,
        draftFolderPaths: DRAFT_PATHS,
      }),
    ).toEqual(['received-1', 'draft-1']);
  });

  it('ignores threads that are not selected', () => {
    const other = thread('t2', [{ id: 'x', tags: '|INBOX|' }]);
    expect(
      selectedEmailIdsFor({
        visibleThreads: [draftThread, other],
        selectedThreadIds: new Set(['t2']),
        viewIsDrafts: false,
      }),
    ).toEqual(['x']);
  });

  it('returns nothing when the selection is empty', () => {
    expect(
      selectedEmailIdsFor({
        visibleThreads: [draftThread],
        selectedThreadIds: new Set(),
        viewIsDrafts: false,
      }),
    ).toEqual([]);
  });
});

describe('selectedEmailIdsFor — in Drafts', () => {
  // THE regression. If this fails, deleting a draft deletes the mail it replies
  // to, and that mail is not recoverable from the Drafts view.
  it('acts ONLY on the draft, never the message it replies to', () => {
    const ids = selectedEmailIdsFor({
      visibleThreads: [draftThread],
      selectedThreadIds: new Set(['t1']),
      viewIsDrafts: true,
      draftFolderPaths: DRAFT_PATHS,
    });

    expect(ids).toEqual(['draft-1']);
    expect(ids).not.toContain('received-1');
  });

  // Select-all is how the incident happened — every received sibling across
  // every selected thread has to survive it.
  it('keeps every received message safe under select-all', () => {
    const threads = [
      draftThread,
      thread('t2', [
        { id: 'received-2', tags: '|INBOX|' },
        { id: 'draft-2', tags: '|Drafts|draft|' },
      ]),
    ];

    expect(
      selectedEmailIdsFor({
        visibleThreads: threads,
        selectedThreadIds: new Set(['t1', 't2']),
        viewIsDrafts: true,
        draftFolderPaths: DRAFT_PATHS,
      }),
    ).toEqual(['draft-1', 'draft-2']);
  });

  // A provider path (INBOX.Drafts, [Gmail]/Drafts) with no local `|draft|`
  // marker is still a draft — an IMAP-synced draft comes back tagged only with
  // its folder. Missing it would make Delete a no-op on exactly those rows.
  it('recognises an IMAP-synced draft by its folder path alone', () => {
    const synced = thread('t3', [
      { id: 'received-3', tags: '|INBOX|' },
      { id: 'draft-3', tags: '|INBOX.Drafts|' },
    ]);

    expect(
      selectedEmailIdsFor({
        visibleThreads: [synced],
        selectedThreadIds: new Set(['t3']),
        viewIsDrafts: true,
        draftFolderPaths: new Set(['INBOX.Drafts']),
      }),
    ).toEqual(['draft-3']);
  });

  // A sent copy keeps a stale `|draft|` tag. Treating it as a live draft would
  // delete sent mail from the Drafts view — the same class of loss, one folder
  // over. `isDraftEmail` already rules this out; the point is that this path
  // uses it rather than a hand-rolled tag check that would not.
  it('does not treat a sent copy with a stale draft tag as a draft', () => {
    const sent = thread('t4', [{ id: 'sent-1', tags: '|Sent|draft|' }]);

    expect(
      selectedEmailIdsFor({
        visibleThreads: [sent],
        selectedThreadIds: new Set(['t4']),
        viewIsDrafts: true,
        draftFolderPaths: DRAFT_PATHS,
      }),
    ).toEqual([]);
  });

  // Likewise a draft already in Trash — acting on it again would be a
  // permanent expunge of a row the user already discarded once.
  it('does not treat a trashed draft as a live draft', () => {
    const trashed = thread('t5', [{ id: 'trashed-1', tags: '|Trash|draft|' }]);

    expect(
      selectedEmailIdsFor({
        visibleThreads: [trashed],
        selectedThreadIds: new Set(['t5']),
        viewIsDrafts: true,
        draftFolderPaths: DRAFT_PATHS,
      }),
    ).toEqual([]);
  });

  // A thread of drafts only: nothing to protect, all of them go.
  it('takes every draft when the thread has no received mail', () => {
    const allDrafts = thread('t6', [
      { id: 'd1', tags: '|Drafts|draft|' },
      { id: 'd2', tags: '|Drafts|draft|' },
    ]);

    expect(
      selectedEmailIdsFor({
        visibleThreads: [allDrafts],
        selectedThreadIds: new Set(['t6']),
        viewIsDrafts: true,
        draftFolderPaths: DRAFT_PATHS,
      }),
    ).toEqual(['d1', 'd2']);
  });

  // Without the folder list (store not hydrated yet) the local `|draft|` marker
  // must still work, or a bulk delete silently does nothing.
  it('still finds locally-marked drafts with no folder paths supplied', () => {
    expect(
      selectedEmailIdsFor({
        visibleThreads: [draftThread],
        selectedThreadIds: new Set(['t1']),
        viewIsDrafts: true,
      }),
    ).toEqual(['draft-1']);
  });
});

/**
 * The row-level hover actions (trash / archive icons on a single row) share this
 * rule with the bulk toolbar. They were fixed together on purpose: narrowing
 * only the bulk path would have left the same data loss reachable one click at
 * a time, which is harder to notice and just as unrecoverable.
 */
describe('actionableEmailIds — the rule both paths share', () => {
  const emails = [
    { id: 'received-1', tags: '|INBOX|read|' },
    { id: 'draft-1', tags: '|Drafts|draft|' },
  ].map((e) => email(e.id, e.tags));

  it('takes the whole conversation outside Drafts', () => {
    expect(actionableEmailIds(emails, false, DRAFT_PATHS)).toEqual(['received-1', 'draft-1']);
  });

  // THE regression, at the row level: the hover trash icon on a draft row.
  it('takes only the draft inside Drafts', () => {
    expect(actionableEmailIds(emails, true, DRAFT_PATHS)).toEqual(['draft-1']);
  });

  it('returns nothing for an empty thread', () => {
    expect(actionableEmailIds([], true, DRAFT_PATHS)).toEqual([]);
  });
});
