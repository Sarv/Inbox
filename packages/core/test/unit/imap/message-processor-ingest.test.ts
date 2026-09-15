import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MessageProcessor } from '../../../src/imap/message-processor';
import { getEventBus } from '../../../src/pipeline/event-bus';
import type { Unsubscribe } from '../../../src/pipeline/types';
import { FakeEmailStorage, resetFakeStorageIds } from '../../../src/test-support/fake-email-storage';
import { FakeImapServer, resetFakeMessageIds } from '../../../src/test-support/fake-imap-server';
import type { FilterRule } from '../../../src/types/filters';
import type { IMAPMessage } from '../../../src/types/imap';
import {
  NO_BODY_CONTENT_HASH_PREFIX,
  bodyContentHash,
  generateContentHash,
  noBodyContentHash,
} from '../../../src/utils/id';


// Ingest tests for MessageProcessor.processBatch / convertMessage — the one path
// every message in the app enters through. The invariants pinned here are the
// ones whose failures were user-visible bugs:
//
//   - IDEMPOTENCE: syncing the same messages twice must not double the mailbox.
//     Message-ID is the identity, NOT the UID, so a message re-appearing under a
//     new UID (server renumbering, a re-delivered copy) must relink, never
//     duplicate.
//   - MOVE-BACK vs RESTORE-RACE: an existing row that lost this folder's tag is
//     either an external move BACK into this folder (must relink or the mail
//     vanishes when the source expunges it) or our own in-flight move AWAY (must
//     NOT relink or the move springs back). A pending op on that UID is the only
//     discriminator.
//   - ONE BAD MESSAGE MUST NOT ABORT THE BATCH.
//   - `quiet` (historical backfill) must skip every reactive side effect, or
//     paging in a lakh of old mail fires a lakh of AI categorisations.
//
// Real MessageProcessor against the shared FakeImapServer + in-memory storage.

const INBOX = 'INBOX';
const SENT = 'Sent';
const TRASH = 'Trash';

function setup() {
  resetFakeMessageIds();
  resetFakeStorageIds();
  const server = new FakeImapServer();
  const db = new FakeEmailStorage();
  for (const path of [INBOX, SENT, TRASH, '[Gmail]/Starred']) {
    server.addFolder(path, { uidValidity: 1 });
    db.addFolder(path, { uidValidity: 1 });
  }
  return { server, db, mp: new MessageProcessor({ headersOnly: true, batchSize: 10 }) };
}

/** A minimal but COMPLETE fetched message, as imapflow would hand it over. */
function msg(over: Partial<IMAPMessage> & { uid: number }): IMAPMessage {
  const { envelope, ...rest } = over;
  return {
    uid: over.uid,
    seqNo: over.uid,
    flags: [],
    date: new Date('2026-01-01T00:00:00Z'),
    size: 100,
    envelope: {
      messageId: `<m${over.uid}@test.local>`,
      inReplyTo: null,
      references: [],
      subject: `Message ${over.uid}`,
      from: [{ address: 'sender@test.local', name: 'Sender' }],
      replyTo: [],
      to: [{ address: 'me@test.local', name: 'Me' }],
      cc: [],
      bcc: [],
      date: new Date('2026-01-01T00:00:00Z'),
      ...envelope,
    },
    ...rest,
  } as unknown as IMAPMessage;
}

/** Fetch messages the way a sync does, so the harness path is exercised too. */
async function fetchNew(server: FakeImapServer, path: string, sinceUid = 0): Promise<IMAPMessage[]> {
  await server.selectFolder(path);
  return server.getNewMessages(sinceUid, { fetchHeaders: true, fetchBody: false } as never);
}

describe('processBatch — insert + idempotence', () => {
  it('inserts each new message once, tagged with the folder and its IMAP flags', async () => {
    const { server, db, mp } = setup();
    server.addMessage(INBOX, { flags: ['\\Seen'] });
    server.addMessage(INBOX, { flags: ['\\Flagged', '\\Answered'] });
    server.addMessage(INBOX, { flags: ['\\Draft', '\\Deleted'] });

    const res = await mp.processBatch(await fetchNew(server, INBOX), db.folder(INBOX), db.asStorage());

    expect(res.inserted).toBe(3);
    expect(res.insertedIds).toHaveLength(3);
    expect(res.maxUid).toBe(3);
    const byUid = new Map(db.rowsPrimaryIn(INBOX).map((e) => [e.uid, db.tagsOf(e.id).sort()]));
    expect(byUid.get(1)).toEqual([INBOX, 'read']);
    expect(byUid.get(2)).toEqual([INBOX, 'answered', 'starred']); // \Flagged also sets starred
    expect(byUid.get(3)).toEqual([INBOX, 'deleted', 'draft']);
  });

  it('RE-RUNNING the same sync inserts nothing — no duplicate rows', async () => {
    // The single most damaging regression class here: any sync path re-running
    // (periodic poll racing IDLE, a retried batch) must be a no-op.
    const { server, db, mp } = setup();
    server.addMessages(INBOX, 3);
    const messages = await fetchNew(server, INBOX);

    const first = await mp.processBatch(messages, db.folder(INBOX), db.asStorage());
    const second = await mp.processBatch(await fetchNew(server, INBOX), db.folder(INBOX), db.asStorage());

    expect(first.inserted).toBe(3);
    expect(second.inserted).toBe(0);
    expect(second.skipped).toBe(3);
    expect(db.allRows()).toHaveLength(3);
  });

  it('a message already present by MESSAGE-ID is relinked, not re-inserted under the new UID', async () => {
    // Identity is the Message-ID, never the UID: a server that renumbers (or a
    // re-delivered copy) must heal the row's uid in place. Inserting a second row
    // is how the same mail showed up twice in one folder.
    const { db, mp } = setup();
    const seeded = db.seedEmail({
      folderId: db.folderId(INBOX), uid: 5, tags: `|${INBOX}|`, messageId: '<dup@test.local>',
    });

    const res = await mp.processBatch(
      [msg({ uid: 9, envelope: { messageId: '<dup@test.local>' } as never })],
      db.folder(INBOX), db.asStorage(),
    );

    expect(res.inserted).toBe(0);
    expect(res.skipped).toBe(1);
    expect(db.allRows()).toHaveLength(1);
    expect(db.row(seeded.id)!.uid).toBe(9); // uid healed to the server's current value
  });

  it('collapses DUPLICATE message-ids inside one batch (the pre-insert check cannot see them)', async () => {
    const { server: _server, db, mp } = setup();

    const res = await mp.processBatch(
      [
        msg({ uid: 1, envelope: { messageId: '<same@test.local>' } as never }),
        msg({ uid: 2, envelope: { messageId: '<same@test.local>' } as never }),
      ],
      db.folder(INBOX), db.asStorage(),
    );

    expect(res.inserted).toBe(1);
    expect(res.skipped).toBe(1);
    expect(db.allRows()).toHaveLength(1);
  });

  it('synthesises a DETERMINISTIC id for a message with no Message-ID header', async () => {
    // Left at '' every header-less message dedups against the first one — the
    // whole class of them collapsed into a single row. The synthetic id must be
    // unique per message AND stable across re-syncs (or every sync re-inserts).
    const { db, mp } = setup();
    const headerless = () => [
      msg({ uid: 1, envelope: { messageId: '' } as never }),
      msg({ uid: 2, envelope: { messageId: '' } as never }),
    ];

    const first = await mp.processBatch(headerless(), db.folder(INBOX), db.asStorage());
    const second = await mp.processBatch(headerless(), db.folder(INBOX), db.asStorage());

    expect(first.inserted).toBe(2);
    const ids = db.allRows().map((e) => e.messageId);
    expect(ids.every((id) => /^<missing-[0-9a-f]+@sarvinbox\.local>$/.test(id))).toBe(true);
    expect(new Set(ids).size).toBe(2);   // distinct per message
    expect(second.inserted).toBe(0);      // and stable, so the re-sync is a no-op
    expect(db.allRows()).toHaveLength(2);
  });

  it('gives a header-less message the SAME id in a second folder — no duplicate row', async () => {
    // The duplicate-mail bug this closes: the synthetic id used to be hashed
    // from `folderPath|uid|...`, so on Gmail — where every message is in All
    // Mail as well as its label — the SECOND sighting of one header-less
    // message was minted a different id and stored again. The user saw the same
    // mail twice in the thread. Identity must come from the message, not from
    // where we found it.
    const { db, mp } = setup();
    const sameMessage = (uid: number) => msg({
      uid,
      envelope: { messageId: '', subject: 'Quarterly report' } as never,
    });

    const inbox = await mp.processBatch([sameMessage(11)], db.folder(INBOX), db.asStorage());
    const sent = await mp.processBatch([sameMessage(4021)], db.folder(SENT), db.asStorage());

    expect(inbox.inserted).toBe(1);
    expect(sent.inserted).toBe(0); // recognised, not re-inserted
    expect(db.allRows()).toHaveLength(1);
    expect(db.tagsOf(db.allRows()[0]!.id).sort()).toEqual([INBOX, SENT]);
  });

  it('gives a header-less message the SAME id after a UIDVALIDITY renumber', async () => {
    // The other half of the same bug: UIDs are per-folder and reset wholesale on
    // a UIDVALIDITY change, so a UID-keyed id re-ingested the ENTIRE mailbox as
    // new mail after a server rebuild or an account re-add.
    const { db, mp } = setup();
    const sameMessage = (uid: number) => msg({
      uid,
      envelope: { messageId: '', subject: 'Quarterly report' } as never,
    });

    await mp.processBatch([sameMessage(11)], db.folder(INBOX), db.asStorage());
    const renumbered = await mp.processBatch([sameMessage(1)], db.folder(INBOX), db.asStorage());

    expect(renumbered.inserted).toBe(0);
    expect(db.allRows()).toHaveLength(1);
    expect(db.allRows()[0]!.uid).toBe(1); // healed to the server's current value
  });

  it('still separates two DIFFERENT header-less messages that share a folder and a second', async () => {
    // The guard on the trade-off: dropping folder+uid from the key must not make
    // distinct messages collide. Sender, subject, recipients and size still
    // separate them, so real mail cannot be swallowed.
    const { db, mp } = setup();
    const at = new Date('2026-01-01T00:00:00Z');

    const res = await mp.processBatch(
      [
        msg({ uid: 1, date: at, size: 100, envelope: { messageId: '', subject: 'Invoice' } as never }),
        msg({ uid: 2, date: at, size: 100, envelope: { messageId: '', subject: 'Receipt' } as never }),
        msg({ uid: 3, date: at, size: 100, envelope: { messageId: '', subject: 'Invoice',
          from: [{ address: 'other@test.local', name: 'Other' }] } as never }),
        msg({ uid: 4, date: at, size: 4096, envelope: { messageId: '', subject: 'Invoice' } as never }),
      ],
      db.folder(INBOX), db.asStorage(),
    );

    expect(res.inserted).toBe(4);
    expect(new Set(db.allRows().map((e) => e.messageId)).size).toBe(4);
  });

  it('reports maxUid across the batch even when nothing is inserted', async () => {
    // maxUid drives lastSyncUid; if a fully-skipped batch reported 0 the folder
    // would re-fetch the same window forever.
    const { db, mp } = setup();
    db.seedEmail({ folderId: db.folderId(INBOX), uid: 7, tags: `|${INBOX}|`, messageId: '<m7@test.local>' });

    const res = await mp.processBatch([msg({ uid: 7 })], db.folder(INBOX), db.asStorage());

    expect(res.inserted).toBe(0);
    expect(res.maxUid).toBe(7);
  });

  it('one UNPROCESSABLE message does not abort the batch', async () => {
    // A single bad message used to throw mid-batch and lose every message after
    // it. It must be counted as an error and the rest still land. No ENVELOPE at
    // all is the unprocessable case — there is nothing to key identity on.
    const { db, mp } = setup();
    const broken = msg({ uid: 2 });
    (broken as { envelope?: unknown }).envelope = undefined;

    const res = await mp.processBatch(
      [msg({ uid: 1 }), broken, msg({ uid: 3 })],
      db.folder(INBOX), db.asStorage(),
    );

    expect(res.inserted).toBe(2);
    expect(res.errors).toBe(1);
    expect(db.rowsPrimaryIn(INBOX).map((e) => e.uid).sort()).toEqual([1, 3]);
  });

  // A missing INTERNALDATE used to be fatal for that message, so mail from
  // servers that omit it was dropped entirely. It is now tolerated: the envelope
  // date carries the message, and only a message with neither date falls back to
  // now — dated wrong is recoverable, missing is not.
  it('INSERTS a message with no INTERNALDATE, dating it from the envelope', async () => {
    const { db, mp } = setup();
    const noInternalDate = msg({ uid: 1 });
    (noInternalDate as { date?: Date }).date = undefined;

    const res = await mp.processBatch([noInternalDate], db.folder(INBOX), db.asStorage());

    expect(res.inserted).toBe(1);
    expect(res.errors).toBe(0);
    expect(db.rowsPrimaryIn(INBOX)[0]?.date)
      .toBe(Math.floor(new Date('2026-01-01T00:00:00Z').getTime() / 1000));
  });

  it('falls back to NOW when neither INTERNALDATE nor the envelope has a date', async () => {
    const { db, mp } = setup();
    const undated = msg({ uid: 1, envelope: { date: null } as never });
    (undated as { date?: Date }).date = undefined;
    const before = Math.floor(Date.now() / 1000);

    const res = await mp.processBatch([undated], db.folder(INBOX), db.asStorage());

    expect(res.inserted).toBe(1);
    expect(db.rowsPrimaryIn(INBOX)[0]?.date).toBeGreaterThanOrEqual(before);
  });
});

describe('processBatch — trivial and degenerate inputs', () => {
  it('an EMPTY batch touches nothing', async () => {
    const { db, mp } = setup();

    const res = await mp.processBatch([], db.folder(INBOX), db.asStorage());

    expect(res).toMatchObject({ inserted: 0, updated: 0, skipped: 0, errors: 0, maxUid: 0 });
    expect(db.calls).toEqual([]); // not even a lookup query
  });

  it('leaves a spammer\'s mail where it is when there is NO spam folder', async () => {
    const { db, mp } = setup();
    db.markSpammer('spammer@test.local');

    await mp.processBatch(
      [msg({ uid: 1, envelope: { from: [{ address: 'spammer@test.local', name: '' }] } as never })],
      db.folder(INBOX), db.asStorage(),
    );

    expect(db.tagsOf(db.allRows()[0].id)).toEqual([INBOX]);
  });

  it('a FAILING spammer check does not break the sync', async () => {
    const { db, mp } = setup();
    vi.spyOn(db, 'isSpammer').mockRejectedValue(new Error('db busy'));

    const res = await mp.processBatch([msg({ uid: 1 })], db.folder(INBOX), db.asStorage());

    expect(res.inserted).toBe(1);
    vi.restoreAllMocks();
  });
});

describe('processBatch — user filter rules', () => {
  const rule = (over: Partial<FilterRule> = {}): FilterRule => ({
    id: 'r1',
    name: 'Newsletters',
    enabled: true,
    priority: 1,
    matchType: 'all',
    conditions: [{ field: 'from', operator: 'contains', value: 'news@' }],
    actions: [{ type: 'markRead' }, { type: 'applyLabel', value: 'reading' }],
    stopProcessing: false,
    createdAt: 0,
    updatedAt: 0,
    ...over,
  });

  it('applies a matching rule to a freshly-ingested email', async () => {
    const { db, mp } = setup();
    db.setFilterRules([rule()]);

    await mp.processBatch(
      [msg({ uid: 1, envelope: { from: [{ address: 'news@test.local', name: '' }] } as never })],
      db.folder(INBOX), db.asStorage(),
    );

    expect(db.tagsOf(db.allRows()[0].id).sort()).toEqual([INBOX, 'read', 'reading'].sort());
  });

  it('leaves a NON-matching email untouched', async () => {
    const { db, mp } = setup();
    db.setFilterRules([rule()]);

    await mp.processBatch([msg({ uid: 1 })], db.folder(INBOX), db.asStorage());

    expect(db.tagsOf(db.allRows()[0].id)).toEqual([INBOX]);
  });

  it('a rule-loading failure never breaks the sync', async () => {
    const { db, mp } = setup();
    vi.spyOn(db, 'getEnabledFilterRules').mockRejectedValue(new Error('bad JSON in rules'));

    const res = await mp.processBatch([msg({ uid: 1 })], db.folder(INBOX), db.asStorage());

    expect(res.inserted).toBe(1);
    vi.restoreAllMocks();
  });
});

describe('processBatch — folder-specific tagging', () => {
  it('marks mail in SENT as read (you have read what you sent)', async () => {
    const { db, mp } = setup();

    await mp.processBatch([msg({ uid: 1 })], db.folder(SENT), db.asStorage());

    expect(db.tagsOf(db.rowsPrimaryIn(SENT)[0].id)).toEqual([SENT, 'read']);
  });

  it('stars everything found in the STARRED source folder, flag or not', async () => {
    const { db, mp } = setup();

    await mp.processBatch([msg({ uid: 1 })], db.folder('[Gmail]/Starred'), db.asStorage());

    expect(db.tagsOf(db.allRows()[0].id)).toContain('starred');
  });

  it('adds `starred` to an EXISTING row when the server now reports \\Flagged', async () => {
    const { db, mp } = setup();
    const seeded = db.seedEmail({
      folderId: db.folderId(INBOX), uid: 1, tags: `|${INBOX}|`, messageId: '<m1@test.local>',
    });

    const res = await mp.processBatch(
      [msg({ uid: 1, flags: ['\\Flagged'] })], db.folder(INBOX), db.asStorage(),
    );

    expect(res.updated).toBe(1);
    expect(db.tagsOf(seeded.id)).toContain('starred');
  });

  it('marks a bulk/mailing-list message with the `bulk` tag', async () => {
    // Threading uses this to suppress the subject-based fallback so newsletters
    // never collapse into one giant thread.
    const { db, mp } = setup();

    await mp.processBatch(
      [{ ...msg({ uid: 1 }), isBulk: true } as IMAPMessage], db.folder(INBOX), db.asStorage(),
    );

    expect(db.tagsOf(db.allRows()[0].id)).toContain('bulk');
  });
});

describe('processBatch — external move-BACK vs local move-AWAY', () => {
  /** A row that lives in TRASH and has LOST the INBOX tag (moved away from Inbox). */
  const seedMovedAway = (db: FakeEmailStorage) => db.seedEmail({
    folderId: db.folderId(TRASH), uid: 40, tags: `|${TRASH}|`, messageId: '<moved@test.local>',
  });

  it('RELINKS an external move-back and names the SOURCE folder to reconcile', async () => {
    // Trash -> Inbox done in webmail. Without the relink the row keeps pointing at
    // Trash, Trash's expunge then deletes it, and the mail disappears from
    // everywhere — the "restored mail vanishes" bug.
    const { db, mp } = setup();
    const row = seedMovedAway(db);

    const res = await mp.processBatch(
      [msg({ uid: 77, envelope: { messageId: '<moved@test.local>' } as never })],
      db.folder(INBOX), db.asStorage(),
    );

    expect(db.tagsOf(row.id)).toContain(INBOX);
    // The source folder must be reconciled promptly — its membership is stale now,
    // but only a reconcile (never a blind drop) is safe for real Gmail labels.
    expect(res.relinkedFromFolders).toEqual([TRASH]);
  });

  it('does NOT relink when a PENDING local op owns that UID (our own move away)', async () => {
    // The user moved it away in-app; a stale sync that relinks makes the move
    // spring back in the UI.
    const { db, mp } = setup();
    const row = seedMovedAway(db);
    mp.setPendingUidsProvider(async () => new Set([77]));

    const res = await mp.processBatch(
      [msg({ uid: 77, envelope: { messageId: '<moved@test.local>' } as never })],
      db.folder(INBOX), db.asStorage(),
    );

    expect(db.tagsOf(row.id)).toEqual([TRASH]); // untouched
    expect(res.relinkedFromFolders).toEqual([]);
  });

  it('never reports FLAG tags as a source folder to reconcile', async () => {
    // The relink scan walks the row's tag string; read/starred/etc. are flags, not
    // folders, and reconciling "read" as a folder path would be nonsense.
    const { db, mp } = setup();
    db.seedEmail({
      folderId: db.folderId(TRASH), uid: 40, tags: `|${TRASH}|read|starred|`, messageId: '<moved@test.local>',
    });

    const res = await mp.processBatch(
      [msg({ uid: 77, envelope: { messageId: '<moved@test.local>' } as never })],
      db.folder(INBOX), db.asStorage(),
    );

    expect(res.relinkedFromFolders).toEqual([TRASH]);
  });

  it('a row that STILL carries this folder tag is a plain skip, not a move-back', async () => {
    const { db, mp } = setup();
    db.seedEmail({
      folderId: db.folderId(INBOX), uid: 40, tags: `|${INBOX}|`, messageId: '<here@test.local>',
    });

    const res = await mp.processBatch(
      [msg({ uid: 40, envelope: { messageId: '<here@test.local>' } as never })],
      db.folder(INBOX), db.asStorage(),
    );

    expect(res.relinkedFromFolders).toEqual([]);
    expect(res.skipped).toBe(1);
  });
});

describe('processBatch — quiet (historical backfill) mode', () => {
  let unsubscribe: Unsubscribe | null = null;

  afterEach(() => {
    unsubscribe?.();
    unsubscribe = null;
  });

  it('emits one email:synced per inserted row on the LIVE path', async () => {
    const { db, mp } = setup();
    const seen: string[] = [];
    unsubscribe = getEventBus().on('email:synced', (e) => { seen.push((e as { type: string }).type); });

    await mp.processBatch([msg({ uid: 1 }), msg({ uid: 2 })], db.folder(INBOX), db.asStorage());

    expect(seen).toEqual(['email:synced', 'email:synced']);
  });

  it('emits NOTHING and runs no spam/filter work when quiet', async () => {
    // Backfilling a lakh of old mail must not fire a lakh of categorisations or
    // wake the body-prefetch backlog.
    const { db, mp } = setup();
    db.markSpammer('sender@test.local');
    const spamSpy = vi.spyOn(db, 'isSpammer');
    const rulesSpy = vi.spyOn(db, 'getEnabledFilterRules');
    const seen: unknown[] = [];
    unsubscribe = getEventBus().on('email:synced', (e) => { seen.push(e); });

    const res = await mp.processBatch(
      [msg({ uid: 1 })], db.folder(INBOX), db.asStorage(), undefined, { quiet: true },
    );

    expect(res.inserted).toBe(1); // the row IS stored — only the reactions are skipped
    expect(seen).toEqual([]);
    expect(spamSpy).not.toHaveBeenCalled();
    expect(rulesSpy).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it('LIVE mode moves a known spammer to the spam folder', async () => {
    const { db, mp } = setup();
    db.addFolder('Spam');
    db.markSpammer('spammer@test.local');

    await mp.processBatch(
      [msg({ uid: 1, envelope: { from: [{ address: 'spammer@test.local', name: '' }] } as never })],
      db.folder(INBOX), db.asStorage(),
    );

    const row = db.allRows()[0];
    expect(row.folderId).toBe(db.folderId('Spam'));
    expect(db.tagsOf(row.id)).toEqual(['Spam']); // INBOX membership dropped
  });
});

describe('convertMessage', () => {
  let mp: MessageProcessor;

  beforeEach(() => {
    mp = new MessageProcessor({ headersOnly: true });
  });

  it('maps the internal date to UNIX SECONDS and carries the envelope fields through', async () => {
    const record = await mp.convertMessage(
      msg({ uid: 1, date: new Date('2026-08-19T10:30:00Z') }), 'f-inbox', INBOX,
    );

    expect(record.date).toBe(Math.floor(Date.parse('2026-08-19T10:30:00Z') / 1000));
    expect(record.fromAddress).toBe('sender@test.local');
    expect(record.uid).toBe(1);
    expect(record.folderId).toBe('f-inbox');
    expect(record.tags).toBe(`|${INBOX}|`);
  });

  it('does not throw on an UNPARSEABLE internal date', async () => {
    // Robustness only: a garbage INTERNALDATE must not take the message (or the
    // rest of its batch) down.
    const record = await mp.convertMessage(msg({ uid: 1, date: new Date('not a date') }), 'f-inbox', INBOX);

    expect(record.messageId).toBe('<m1@test.local>');
  });

  it('threads a reply onto its parent via References, not via subject', async () => {
    // convertMessage joins `envelope.references` for generateThreadId; a broken
    // join silently split every thread into singletons.
    const root = await mp.convertMessage(
      msg({ uid: 1, envelope: { messageId: '<root@test.local>' } as never }), 'f', INBOX,
    );
    const reply = await mp.convertMessage(
      msg({
        uid: 2,
        envelope: {
          messageId: '<reply@test.local>',
          references: ['<root@test.local>'],
          inReplyTo: '<root@test.local>',
        } as never,
      }), 'f', INBOX,
    );
    const unrelated = await mp.convertMessage(
      msg({ uid: 3, envelope: { messageId: '<other@test.local>' } as never }), 'f', INBOX,
    );

    expect(reply.threadId).toBe(root.threadId);
    expect(unrelated.threadId).not.toBe(root.threadId);
    expect(reply.references).toBe('<root@test.local>');
  });

  it('parses the body when the processor is NOT headers-only', async () => {
    // The initial sync fetches bodies for the recent window; a body that arrives
    // with the headers must be parsed there and then, not left for a second fetch.
    const withBody = new MessageProcessor({ headersOnly: false });
    const raw = 'Content-Type: text/plain; charset=utf-8\r\n\r\nHello body\r\n';

    const record = await withBody.convertMessage(
      { ...msg({ uid: 1 }), body: raw } as IMAPMessage, 'f-inbox', INBOX,
    );

    expect(record.cleanBody).toContain('Hello body');
    expect(record.contentType).toBe('text');
  });

  it('omits the folder tag entirely when no folder path is supplied', async () => {
    const record = await mp.convertMessage(msg({ uid: 1, flags: ['\\Seen'] }), 'f-inbox');

    expect(record.tags).toBe('|read|');
  });

  // Regression: `content_hash` was `generateContentHash(cleanBody || subject)`, and
  // under headers-first sync — which is how the whole mailbox arrives — cleanBody is
  // '', so the column held a hash of the SUBJECT. Two unrelated notifications that
  // share a subject then looked like identical content, and the value was never
  // recomputed when the body finally landed (1,809 hash groups on a live account
  // spanned more than one distinct clean_body_len). The column must be body-derived
  // or explicitly marked as not-yet-known.
  describe('content hash', () => {
    it('stamps the no-body marker, keyed per message, on a headers-only fetch', async () => {
      const first = await mp.convertMessage(msg({ uid: 1 }), 'f-inbox', INBOX);
      const second = await mp.convertMessage(msg({ uid: 2 }), 'f-inbox', INBOX);

      expect(first.contentHash).toBe(noBodyContentHash('<m1@test.local>'));
      expect(first.contentHash).not.toBe(second.contentHash);
    });

    // The subject is the one thing these two share; the hash must not.
    it('does not let a shared subject produce a shared hash', async () => {
      const subject = 'OverTime Request is approved.';
      const first = await mp.convertMessage(
        msg({ uid: 1, envelope: { subject } as never }), 'f-inbox', INBOX,
      );
      const second = await mp.convertMessage(
        msg({ uid: 2, envelope: { subject } as never }), 'f-inbox', INBOX,
      );

      expect(first.subject).toBe(second.subject);
      expect(first.contentHash).not.toBe(second.contentHash);
      expect(first.contentHash).not.toBe(generateContentHash(subject));
    });

    // The body-carrying route must produce the SAME hash the body-fetch route will
    // write later (EmailRepository.update recomputes it there), or the two ingest
    // paths disagree about whether identical mail is identical.
    it('hashes the body when the body came with the headers', async () => {
      const withBody = new MessageProcessor({ headersOnly: false });
      const raw = 'Content-Type: text/plain; charset=utf-8\r\n\r\nHello body\r\n';

      const record = await withBody.convertMessage(
        { ...msg({ uid: 1 }), body: raw } as IMAPMessage, 'f-inbox', INBOX,
      );

      expect(record.contentHash).toBe(bodyContentHash(record));
      expect(record.contentHash).not.toContain(NO_BODY_CONTENT_HASH_PREFIX);
    });

    // Idempotence: re-syncing the same message must not churn the column, or a
    // freshness check re-does work on every pass.
    it('is stable across re-converts of the same message', async () => {
      const first = await mp.convertMessage(msg({ uid: 1 }), 'f-inbox', INBOX);
      const again = await mp.convertMessage(msg({ uid: 7 }), 'f-inbox', INBOX);
      const sameMessage = await mp.convertMessage(
        msg({ uid: 7, envelope: { messageId: '<m1@test.local>' } as never }), 'f-inbox', INBOX,
      );

      expect(sameMessage.contentHash).toBe(first.contentHash);
      expect(again.contentHash).not.toBe(first.contentHash);
    });
  });
});
