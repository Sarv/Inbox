// `newMigratedDb` gives this file the real schema, built by the real migrations.
// It comes from storage-node's TEST-ONLY helper rather than being re-created
// here: it already carries the better-sqlite3/node:sqlite fallback (the packaged
// binding is compiled for ELECTRON's ABI and cannot be dlopen'd by vitest's
// Node), and a second copy of that logic is exactly the duplication this repo
// forbids.
import { NO_BODY_CONTENT_HASH_PREFIX, bodyContentHash, noBodyContentHash } from '@sarvinbox/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// import/order contradicts itself on this one line and cannot be satisfied:
// the TS resolver sees a workspace package (external group, no blank line
// before it) while the specifier is written as a relative path (parent group,
// blank line required). `--fix` adds the blank line, then reports it. This is
// the only cross-package relative import in the tree; every other test-db
// importer lives inside storage-node and hits neither half of the conflict.
// eslint-disable-next-line import/order
import { newMigratedDb } from '../../../../../../packages/storage-node/src/test-support/test-db';

// What breaks if this file fails: the two writers that put an `emails` row on
// disk WITHOUT going through EmailRepository — the local sent mirror and the
// local draft row.
//
// Both hand-write the insert, so every column contract the repository maintains
// is theirs to re-honour. `content_hash` was the one they didn't: both stamped
// the literal '', which is the single value that makes every sent copy and every
// draft revision look like identical content to anything comparing hashes, and
// the draft re-save rewrote the body without touching the column at all — so a
// revised draft kept claiming the content of the revision before it.
//
// Nothing about that throws, renders wrong, or shows up in a log. Only an
// assertion on the stored column can see it.

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...a: unknown[]) => unknown>(),
}));

vi.mock('electron', () => ({
  ipcMain: { handle: (name: string, fn: (...a: unknown[]) => unknown) => h.handlers.set(name, fn) },
  dialog: {},
  shell: {},
  app: { getPath: () => '/tmp' },
}));
vi.mock('../../../../electron/shared', () => ({
  requireStorage: vi.fn(),
  getStorage: vi.fn(),
  getStorageFor: vi.fn(),
  getSyncEngine: vi.fn(),
  getSyncEngineFor: vi.fn(),
  getSmtpClient: vi.fn(),
  getSmtpClientFor: vi.fn(),
  setSmtpClient: vi.fn(),
  setSmtpClientFor: vi.fn(),
  getMainWindow: vi.fn(),
  getCurrentAccountId: vi.fn(),
  getAllAccountIds: vi.fn(() => []),
  sendToWindow: vi.fn(),
}));
vi.mock('../../../../electron/services/oauth-service', () => ({ getValidAccessToken: vi.fn() }));
vi.mock('../../../../electron/services/unified-pipeline-service', () => ({
  getPipelineUserName: vi.fn(() => 'Me'),
}));
vi.mock('../../../../electron/services/outbox-service', () => ({
  getOutboxQueue: vi.fn(),
  drainOutbox: vi.fn(),
  getOutboxQueueForAccount: vi.fn(),
  drainOutboxForAccount: vi.fn(),
  notifyOutboxChanged: vi.fn(),
}));
vi.mock('../../../../electron/services/accounts-runtime', () => ({ ensureAccountRuntime: vi.fn() }));
vi.mock('../../../../electron/services/account-target', () => ({ resolveAccountTarget: vi.fn() }));

import { writeLocalDraftRow } from '../../../../electron/ipc/draft-handlers';
import { writeLocalSentRow } from '../../../../electron/ipc/smtp-handlers';

type Db = ReturnType<typeof newMigratedDb>;

const SENT = 'Sent';
const DRAFTS = 'Drafts';

/** A storage stub with just the two surfaces these writers touch. */
function storageOver(db: Db, folders?: Array<Record<string, string>>) {
  return {
    db,
    getFolders: async () =>
      folders ?? [
        { id: 'f-sent', name: SENT, path: SENT, specialUse: '\\Sent' },
        { id: 'f-drafts', name: DRAFTS, path: DRAFTS, specialUse: '\\Drafts' },
      ],
  } as never;
}

function newDb(): Db {
  const db = newMigratedDb();
  const folder = db.prepare(
    'INSERT OR IGNORE INTO folders (id, name, path, special_use) VALUES (?, ?, ?, ?)',
  );
  folder.run('f-sent', SENT, SENT, '\\Sent');
  folder.run('f-drafts', DRAFTS, DRAFTS, '\\Drafts');
  return db;
}

const sentRow = (over: Partial<Record<string, string>> = {}) => ({
  messageId: '<sent-1@test.local>',
  subject: 'Re: the pangolin report',
  to: 'them@test.example',
  cc: '',
  bcc: '',
  fromAddress: 'me@test.example',
  fromName: 'Me',
  bodyText: 'here is the report',
  bodyHtml: '',
  inReplyTo: '',
  references: '',
  ...over,
});

const draftRow = (over: Partial<Record<string, string>> = {}) => ({
  messageId: '<draft-1@test.local>',
  folderPath: DRAFTS,
  to: 'them@test.example',
  cc: '',
  bcc: '',
  subject: 'the pangolin report',
  bodyText: 'first attempt',
  bodyHtml: '',
  inReplyTo: '',
  fromAddress: 'me@test.example',
  fromName: 'Me',
  rawMessage: 'raw source',
  ...over,
});

const hashOf = (db: Db, messageId: string): string =>
  (db.prepare('SELECT content_hash AS h FROM emails WHERE message_id = ?').get(messageId) as {
    h: string;
  }).h;

const rowCount = (db: Db): number =>
  (db.prepare('SELECT COUNT(*) AS n FROM emails').get() as { n: number }).n;

describe('local sent mirror — content_hash', () => {
  let db: Db;

  beforeEach(() => {
    db = newDb();
  });

  // THE regression: this column was the literal '' on every sent copy ever
  // written, so any reader comparing hashes saw one enormous group of "identical"
  // mail.
  it('stores the hash of the body it just wrote', async () => {
    await writeLocalSentRow(sentRow(), storageOver(db));

    expect(hashOf(db, '<sent-1@test.local>')).toBe(
      bodyContentHash({ cleanBody: 'here is the report' }),
    );
    expect(hashOf(db, '<sent-1@test.local>')).not.toBe('');
  });

  it('gives two different sent messages different hashes', async () => {
    await writeLocalSentRow(sentRow(), storageOver(db));
    await writeLocalSentRow(
      sentRow({ messageId: '<sent-2@test.local>', bodyText: 'a different message' }),
      storageOver(db),
    );

    expect(hashOf(db, '<sent-2@test.local>')).not.toBe(hashOf(db, '<sent-1@test.local>'));
  });

  // Two sends that share a subject and differ only in body — the shape that made
  // a subject-derived hash indistinguishable from a body-derived one.
  it('separates two sends that share a subject', async () => {
    await writeLocalSentRow(sentRow({ bodyText: 'August figures' }), storageOver(db));
    await writeLocalSentRow(
      sentRow({ messageId: '<sent-2@test.local>', bodyText: 'September figures' }),
      storageOver(db),
    );

    const [first, second] = ['<sent-1@test.local>', '<sent-2@test.local>'].map((m) => hashOf(db, m));
    expect(first).not.toBe(second);
  });

  // An HTML send still carries its text part as the clean body, so that is what
  // must be hashed — the same choice bodyContentHash makes everywhere else.
  it('hashes the text part of an HTML send', async () => {
    await writeLocalSentRow(
      sentRow({ bodyText: 'plain version', bodyHtml: '<p>rich version</p>' }),
      storageOver(db),
    );

    expect(hashOf(db, '<sent-1@test.local>')).toBe(bodyContentHash({ cleanBody: 'plain version' }));
  });

  // A body with no text at all must not fall back to '' — that is the collision
  // the marker exists to prevent. Two empty sends, two different hashes.
  it('marks an empty send as body-less, keyed per message', async () => {
    await writeLocalSentRow(sentRow({ bodyText: '', bodyHtml: '' }), storageOver(db));
    await writeLocalSentRow(
      sentRow({ messageId: '<sent-2@test.local>', bodyText: '', bodyHtml: '' }),
      storageOver(db),
    );

    const first = hashOf(db, '<sent-1@test.local>');
    expect(first).toBe(noBodyContentHash('<sent-1@test.local>'));
    expect(first).not.toBe(hashOf(db, '<sent-2@test.local>'));
  });

  // IDEMPOTENT RE-RUN: the send path can run twice for one message (a retry, an
  // outbox drain after a partial failure). The existing-row guard must still hold
  // — and the hash must not change under it.
  it('leaves the existing row untouched when the same message is written twice', async () => {
    await writeLocalSentRow(sentRow(), storageOver(db));
    const first = hashOf(db, '<sent-1@test.local>');

    await writeLocalSentRow(sentRow({ bodyText: 'a re-send with different text' }), storageOver(db));

    expect(rowCount(db)).toBe(1);
    expect(hashOf(db, '<sent-1@test.local>')).toBe(first);
  });

  // A reply must land in the conversation it answers, not start a new one — and
  // the two messages in it must still hash differently.
  it('threads a reply into the conversation it answers', async () => {
    await writeLocalSentRow(sentRow(), storageOver(db));
    await writeLocalSentRow(
      sentRow({
        messageId: '<sent-2@test.local>',
        inReplyTo: '<sent-1@test.local>',
        bodyText: 'and a follow-up',
      }),
      storageOver(db),
    );

    const threads = db
      .prepare('SELECT DISTINCT thread_id AS t FROM emails')
      .all() as Array<{ t: string }>;
    expect(threads).toHaveLength(1);
    expect(hashOf(db, '<sent-2@test.local>')).not.toBe(hashOf(db, '<sent-1@test.local>'));
  });

  // An account whose folder list has no Sent folder at all (some IMAP servers,
  // and any account whose folders have not synced yet) must be a clean no-op.
  it('writes nothing when the account has no Sent folder', async () => {
    await writeLocalSentRow(sentRow(), storageOver(db, []));

    expect(rowCount(db)).toBe(0);
  });

  // The folder list and the folders table can disagree mid-sync. Skipping beats
  // inserting a row with a dangling folder_id.
  it('writes nothing when the resolved Sent folder is not in the folders table', async () => {
    const ghost = [{ id: 'f-ghost', name: 'Sent Items', path: 'Sent Items', specialUse: '\\Sent' }];

    await writeLocalSentRow(sentRow(), storageOver(db, ghost));

    expect(rowCount(db)).toBe(0);
  });

  // MULTI-ACCOUNT: each account is a separate DB, and the mirror goes to the
  // SENDING account's storage. The same body must hash the same in both, or the
  // one message a user sent from two accounts looks like two different things.
  it('hashes the same body identically in a second account DB', async () => {
    const other = newDb();

    await writeLocalSentRow(sentRow(), storageOver(db));
    await writeLocalSentRow(sentRow(), storageOver(other));

    expect(hashOf(other, '<sent-1@test.local>')).toBe(hashOf(db, '<sent-1@test.local>'));
  });
});

describe('local draft row — content_hash', () => {
  let db: Db;

  beforeEach(() => {
    db = newDb();
  });

  it('stores the hash of the draft body on insert', async () => {
    await writeLocalDraftRow(storageOver(db), draftRow());

    expect(hashOf(db, '<draft-1@test.local>')).toBe(bodyContentHash({ cleanBody: 'first attempt' }));
    expect(hashOf(db, '<draft-1@test.local>')).not.toBe('');
  });

  // THE draft-specific regression: a draft is re-saved on every autosave, and the
  // re-save path rewrote clean_body/raw_body without touching content_hash — so
  // the column described a revision the user had already replaced.
  it('follows the body when the draft is re-saved with new text', async () => {
    await writeLocalDraftRow(storageOver(db), draftRow());
    const first = hashOf(db, '<draft-1@test.local>');

    await writeLocalDraftRow(storageOver(db), draftRow({ bodyText: 'second attempt' }));

    expect(rowCount(db)).toBe(1); // re-save updates in place, never duplicates
    expect(hashOf(db, '<draft-1@test.local>')).not.toBe(first);
    expect(hashOf(db, '<draft-1@test.local>')).toBe(bodyContentHash({ cleanBody: 'second attempt' }));
  });

  // IDEMPOTENT RE-RUN: an autosave that fires with no changes must not churn the
  // column, or a freshness check re-does work on every keystroke pause.
  it('is stable when the same draft text is saved twice', async () => {
    await writeLocalDraftRow(storageOver(db), draftRow());
    const first = hashOf(db, '<draft-1@test.local>');

    await writeLocalDraftRow(storageOver(db), draftRow());

    expect(hashOf(db, '<draft-1@test.local>')).toBe(first);
  });

  // A brand-new empty draft (the composer opens and saves before anything is
  // typed) must not collide with every other empty draft.
  it('marks an empty draft as body-less, keyed per message', async () => {
    await writeLocalDraftRow(storageOver(db), draftRow({ bodyText: '', bodyHtml: '', rawMessage: '' }));
    await writeLocalDraftRow(
      storageOver(db),
      draftRow({ messageId: '<draft-2@test.local>', bodyText: '', bodyHtml: '', rawMessage: '' }),
    );

    const first = hashOf(db, '<draft-1@test.local>');
    expect(first.startsWith(NO_BODY_CONTENT_HASH_PREFIX)).toBe(true);
    expect(first).not.toBe(hashOf(db, '<draft-2@test.local>'));
  });

  // An empty draft that then gets text must stop being marked body-less — the
  // update path has to recompute, not just the insert.
  it('replaces the body-less marker once the user types something', async () => {
    await writeLocalDraftRow(storageOver(db), draftRow({ bodyText: '', bodyHtml: '', rawMessage: '' }));
    expect(hashOf(db, '<draft-1@test.local>').startsWith(NO_BODY_CONTENT_HASH_PREFIX)).toBe(true);

    await writeLocalDraftRow(storageOver(db), draftRow({ bodyText: 'now it has text' }));

    expect(hashOf(db, '<draft-1@test.local>')).toBe(bodyContentHash({ cleanBody: 'now it has text' }));
  });

  // A pasted image reaches the composer as a `data:` URI and is relocated to the
  // blob store on the way to disk. The hash is taken from the body as TYPED, so
  // it must not depend on whether that blob was already stored — the second save
  // finds the blob present and rewrites differently.
  it('is not perturbed by the inline-image relocation', async () => {
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';
    const body = { bodyText: 'see image', bodyHtml: `<p>see image</p><img src="${png}">` };

    await writeLocalDraftRow(storageOver(db), draftRow(body));
    const first = hashOf(db, '<draft-1@test.local>');
    await writeLocalDraftRow(storageOver(db), draftRow(body));

    expect(hashOf(db, '<draft-1@test.local>')).toBe(first);
    expect(first).toBe(bodyContentHash({ cleanBody: 'see image' }));
  });

  // A draft folder that isn't in the folders table is a no-op, not a crash — and
  // must not leave a half-written row behind.
  it('writes nothing when the drafts folder is unknown', async () => {
    await writeLocalDraftRow(storageOver(db), draftRow({ folderPath: 'NoSuchFolder' }));

    expect(rowCount(db)).toBe(0);
  });
});

// ONE RULE, ALL WRITERS: the whole point of the shared helper is that the same
// body cannot hash differently depending on which code path stored it. If these
// two ever disagree, the duplication has crept back in.
describe('the two local writers agree with each other', () => {
  it('hashes the same body to the same value from either path', async () => {
    const db = newDb();
    const text = 'the exact same words';

    await writeLocalSentRow(sentRow({ bodyText: text }), storageOver(db));
    await writeLocalDraftRow(storageOver(db), draftRow({ bodyText: text }));

    expect(hashOf(db, '<draft-1@test.local>')).toBe(hashOf(db, '<sent-1@test.local>'));
  });
});
