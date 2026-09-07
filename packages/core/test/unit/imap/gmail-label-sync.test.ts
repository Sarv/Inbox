import { beforeEach, describe, expect, it } from 'vitest';

import { FakeEmailStorage } from '../../../src/test-support/fake-email-storage';
import { FakeImapServer, resetFakeMessageIds } from '../../../src/test-support/fake-imap-server';
import { parseTags } from '../../../src/utils/tags';

import { MessageProcessor } from '../../../src/imap/message-processor';

/**
 * Gmail: labels ARE folder membership.
 *
 * The historical download runs over the `[Gmail]/All Mail` SUPERSET once, rather
 * than fetching a message again for every label it carries. That only works if
 * the labels come with it — otherwise every backfilled message is tagged
 * `|[Gmail]/All Mail|` and nothing else, so it is on disk yet invisible in INBOX,
 * Starred and the user's own labels. That is exactly how a Gmail account sat at
 * "88 mails" in INBOX while the server held 3,236 and All Mail had already
 * downloaded them.
 *
 * These tests drive the REAL MessageProcessor against the fake Gmail server, and
 * assert on the tags actually persisted.
 */

const ALL_MAIL = '[Gmail]/All Mail';

async function syncAllMail(
  server: FakeImapServer,
  storage: FakeEmailStorage,
  opts: { categories?: Array<{ slug: string; name?: string }> } = {},
) {
  if (opts.categories) {
    (storage as unknown as { getCategoryDefinitions: () => Promise<unknown> }).getCategoryDefinitions =
      async () => opts.categories!;
  }
  const folder = (await storage.getFolders()).find((f) => f.path === ALL_MAIL)!;
  await server.selectFolder(ALL_MAIL);
  const messages = await server.fetchMessages('1:*', { fetchBody: false });
  const processor = new MessageProcessor();
  await processor.processBatch(messages, folder, storage as never, undefined, { quiet: true });
  return storage;
}

/** Tags of the single stored email, sorted for order-independent assertions. */
async function tagsOfOnly(storage: FakeEmailStorage, folderPath = ALL_MAIL): Promise<string[]> {
  const folder = (await storage.getFolders()).find((f) => f.path === folderPath)!;
  const rows = await storage.getEmailTagsInFolder(folder.id);
  expect(rows).toHaveLength(1);
  return parseTags(rows[0].tags || '').sort();
}

/**
 * The FOLDER VIEW — rows the app would list for that folder, resolved the same
 * tag-based way the real SQL does. This is the assertion that matches the user's
 * complaint: "I open INBOX and my mail isn't there."
 */
async function idsVisibleIn(storage: FakeEmailStorage, folderPath: string): Promise<string[]> {
  const folder = (await storage.getFolders()).find((f) => f.path === folderPath)!;
  const rows = await storage.getEmailsByFolder(folder.id, { limit: 100, offset: 0 });
  return rows.map((r) => r.id);
}

describe('Gmail label sync — folder membership from X-GM-LABELS', () => {
  let server: FakeImapServer;
  let storage: FakeEmailStorage;

  beforeEach(() => {
    resetFakeMessageIds();
    server = new FakeImapServer({ gmailLabels: true });
    server.addFolder(ALL_MAIL, { specialUse: '\\All' });
    server.addFolder('INBOX');
    storage = new FakeEmailStorage();
    storage.addFolder(ALL_MAIL, { specialUse: '\\All' });
    storage.addFolder('INBOX');
  });

  // THE bug: downloaded via All Mail, must still appear in INBOX.
  it('files a message downloaded from All Mail into INBOX when it is labelled \\Inbox', async () => {
    server.addMessage(ALL_MAIL, { subject: 'hello', labels: ['\\Inbox'] });

    const tags = await tagsOfOnly(await syncAllMail(server, storage));

    expect(tags).toContain('INBOX');        // tagged for the INBOX view
    expect(tags).toContain(ALL_MAIL);       // and still in All Mail

    // …and it really is listed by the INBOX folder view, not merely tagged.
    expect(await idsVisibleIn(storage, 'INBOX')).toHaveLength(1);
  });

  // A user label must list the same mail here as it does in Gmail.
  it('keeps the user\'s own labels, including nested and spaced names', async () => {
    server.addMessage(ALL_MAIL, { labels: ['\\Inbox', 'access', 'Work/Clients', 'Big Client 2026'] });

    const tags = await tagsOfOnly(await syncAllMail(server, storage));

    expect(tags).toContain('access');
    expect(tags).toContain('Work/Clients');
    expect(tags).toContain('Big Client 2026');
  });

  // \Starred is a FLAG here. Tagging it as a folder would invent a "\Starred"
  // folder AND leave the star missing in the UI. BEHAVIOUR CHANGE: the same
  // message's \Important label no longer becomes an `important` tag — Gmail's
  // importance guess must not reach the chip or the "Important and unread"
  // section, which only this app's AI may fill.
  it('turns \\Starred into a flag tag but drops \\Important', async () => {
    server.addMessage(ALL_MAIL, { labels: ['\\Inbox', '\\Starred', '\\Important'] });

    const tags = await tagsOfOnly(await syncAllMail(server, storage));

    expect(tags).toContain('starred');
    expect(tags).not.toContain('important');
    expect(tags.some((t) => t.startsWith('\\'))).toBe(false);
  });

  // The role → path mapping must come from THIS account's folder list: Gmail's
  // Sent is `[Gmail]/Sent Mail`, not `Sent`.
  it('resolves a system label to the account\'s real mailbox path', async () => {
    storage.addFolder('[Gmail]/Sent Mail', { specialUse: '\\Sent' });
    server.addMessage(ALL_MAIL, { labels: ['\\Sent'] });

    const tags = await tagsOfOnly(await syncAllMail(server, storage));

    expect(tags).toContain('[Gmail]/Sent Mail');
    expect(tags).not.toContain('Sent');
  });

  // Recovering the app's own mirror label restores the category chip for old mail
  // without paying an LLM to re-classify thousands of messages.
  it('recovers the category this app had mirrored to a Sarv Inbox label', async () => {
    server.addMessage(ALL_MAIL, { labels: ['\\Inbox', 'Sarv Inbox/Promotions'] });

    const tags = await tagsOfOnly(
      await syncAllMail(server, storage, { categories: [{ slug: 'promotions', name: 'Promotions' }] }),
    );

    expect(tags).toContain('promotions');                  // the chip fills in
    expect(tags).not.toContain('Sarv Inbox/Promotions');    // never a user folder
  });

  // Flags on the wire must survive alongside the label mapping — read/starred
  // state is what users notice first when it regresses.
  it('preserves IMAP flags while applying labels', async () => {
    server.addMessage(ALL_MAIL, { flags: ['\\Seen', '\\Answered'], labels: ['\\Inbox', 'access'] });

    const tags = await tagsOfOnly(await syncAllMail(server, storage));

    expect(tags).toContain('read');
    expect(tags).toContain('answered');
    expect(tags).toContain('INBOX');
    expect(tags).toContain('access');
  });

  // An unknown system label must be ignored rather than materialised, and a
  // label naming no known folder role must not fabricate a path.
  it('ignores unknown system labels', async () => {
    server.addMessage(ALL_MAIL, { labels: ['\\SomethingNew', '\\Inbox'] });

    const tags = await tagsOfOnly(await syncAllMail(server, storage));

    expect(tags).toContain('INBOX');
    expect(tags.some((t) => t.includes('SomethingNew'))).toBe(false);
  });

  // Re-syncing the same message must not duplicate rows or accumulate tags.
  it('is idempotent across a re-sync', async () => {
    server.addMessage(ALL_MAIL, { labels: ['\\Inbox', 'access'] });
    await syncAllMail(server, storage);
    const first = await tagsOfOnly(storage);

    await syncAllMail(server, storage);
    expect(await tagsOfOnly(storage)).toEqual(first);
  });

  // ── The repair pass ─────────────────────────────────────────────────────
  //
  // Mail already downloaded before labels were fetched carries `|All Mail|` and
  // nothing else. Re-syncing it would cost a full download; its labels cost a few
  // bytes. This is what un-sticks an existing account.
  describe('repairGmailLabels', () => {
    /** Store a row the OLD way: folder path + flags only, no label mapping. */
    async function storeWithoutLabels(uid: number, flags: string[] = []) {
      const plain = new FakeImapServer();                      // no label support
      plain.addFolder(ALL_MAIL);
      plain.addMessage(ALL_MAIL, { uid, flags });
      await plain.selectFolder(ALL_MAIL);
      const messages = await plain.fetchMessages('1:*', { fetchBody: false });
      const folder = (await storage.getFolders()).find((f) => f.path === ALL_MAIL)!;
      await new MessageProcessor().processBatch(messages, folder, storage as never, undefined, { quiet: true });
    }

    const repair = async () => {
      const folder = (await storage.getFolders()).find((f) => f.path === ALL_MAIL)!;
      return new MessageProcessor().repairGmailLabels(server as never, folder, storage as never);
    };

    it('files existing rows into INBOX and the user\'s labels without re-downloading', async () => {
      await storeWithoutLabels(1);
      expect(await idsVisibleIn(storage, 'INBOX')).toEqual([]);   // the reported bug

      server.addMessage(ALL_MAIL, { uid: 1, labels: ['\\Inbox', 'access'] });
      const result = await repair();

      expect(result).toEqual({ scanned: 1, updated: 1 });
      expect(await idsVisibleIn(storage, 'INBOX')).toHaveLength(1);
      expect(await tagsOfOnly(storage)).toContain('access');
      // No message fetch was needed — labels only.
      expect(server.callCount('fetchMessages')).toBe(0);
      expect(server.callCount('fetchAllLabels')).toBe(1);
    });

    it('is idempotent — a second pass changes nothing', async () => {
      await storeWithoutLabels(1);
      server.addMessage(ALL_MAIL, { uid: 1, labels: ['\\Inbox'] });
      await repair();
      const after = await tagsOfOnly(storage);

      expect((await repair()).updated).toBe(0);
      expect(await tagsOfOnly(storage)).toEqual(after);
    });

    // The repair reads the SAME label mapping as ingest, so it is a second way
    // Gmail's importance could reach the chip — on old mail, long after the fact.
    // It must file the message's folders and still leave `important` unset.
    it('files a \\Important-labelled message without tagging it important', async () => {
      await storeWithoutLabels(1);
      server.addMessage(ALL_MAIL, { uid: 1, labels: ['\\Inbox', '\\Important'] });

      await repair();

      expect(await idsVisibleIn(storage, 'INBOX')).toHaveLength(1);
      expect(await tagsOfOnly(storage)).not.toContain('important');
    });

    // KNOWN GAP, deliberate: the repair is additive-only, so a row tagged
    // `important` by the OLD label mapping keeps that tag. Nothing records who
    // authored the tag (AI, the user, or Gmail), so a blanket strip would also
    // erase genuine AI and manual marks. Existing chips clear when the AI
    // re-classifies the mail, not on sync.
    it('leaves an already-stored important tag alone (pre-existing rows are not cleaned)', async () => {
      await storeWithoutLabels(1);
      const folder = (await storage.getFolders()).find((f) => f.path === ALL_MAIL)!;
      const [row] = await storage.getEmailTagsInFolder(folder.id);
      await storage.bulkUpdateTags([{ id: row.id, tags: `${row.tags}important|` }]);

      server.addMessage(ALL_MAIL, { uid: 1, labels: ['\\Inbox', '\\Important'] });
      await repair();

      expect(await tagsOfOnly(storage)).toContain('important');
    });

    // ADDITIVE ONLY: a repair must never strip a tag. If it removed anything it
    // could undo a local action (an archive, a category the user corrected) that
    // hasn't reached the server yet.
    it('never removes an existing tag', async () => {
      await storeWithoutLabels(1, ['\\Seen']);
      const folder = (await storage.getFolders()).find((f) => f.path === ALL_MAIL)!;
      const [row] = await storage.getEmailTagsInFolder(folder.id);
      await storage.bulkUpdateTags([{ id: row.id, tags: `${row.tags}local_only|` }]);

      server.addMessage(ALL_MAIL, { uid: 1, labels: ['\\Inbox'] });
      await repair();

      const tags = await tagsOfOnly(storage);
      expect(tags).toContain('local_only');   // survived
      expect(tags).toContain('read');         // flag survived
      expect(tags).toContain('INBOX');        // membership added
    });

    /**
     * Breaks: the mail lands in INBOX but the sidebar badge still says the
     * folder is empty. The repair runs off the backfill scheduler, outside any
     * sync — so no end-of-sync recount covers it — and the badge reads the
     * STORED `folders.unread_count`, not a live query. Filing 3,000 messages
     * into INBOX while the badge stays at 0 is the version of this bug that
     * made an account look like it had never synced.
     */
    it('recounts the folders whose membership it grew', async () => {
      await storeWithoutLabels(1);
      expect(storage.folder('INBOX').unreadCount).toBe(0);

      server.addMessage(ALL_MAIL, { uid: 1, labels: ['\\Inbox'] });
      await repair();

      expect(storage.folder('INBOX').totalCount).toBe(1);
      expect(storage.folder('INBOX').unreadCount).toBe(1);
    });

    // Breaks: every idle repair pass pays for a recount. The pass runs
    // repeatedly in the background and is a no-op once converged; a recount
    // there is a synchronous main-thread cost for nothing.
    it('does not recount when it changed no membership', async () => {
      await storeWithoutLabels(1);
      server.addMessage(ALL_MAIL, { uid: 1, labels: ['\\Inbox'] });
      await repair();
      const recountsAfterFirst = storage.callCount('recalculateFolderCounts');

      await repair();

      expect(recountsAfterFirst).toBe(1);
      expect(storage.callCount('recalculateFolderCounts')).toBe(1);
    });

    it('skips a UID the server reports but we do not have locally', async () => {
      server.addMessage(ALL_MAIL, { uid: 99, labels: ['\\Inbox'] });
      expect(await repair()).toEqual({ scanned: 1, updated: 0 });
    });

    // A non-Gmail server has nothing to repair and must not be walked.
    it('is a no-op on a server without the Gmail extension', async () => {
      const plain = new FakeImapServer();
      plain.addFolder(ALL_MAIL);
      plain.addMessage(ALL_MAIL, {});
      const folder = (await storage.getFolders()).find((f) => f.path === ALL_MAIL)!;
      expect(await new MessageProcessor().repairGmailLabels(plain as never, folder, storage as never))
        .toEqual({ scanned: 0, updated: 0 });
    });
  });

  // REGRESSION GUARD for every non-Gmail account: a server that sends no labels
  // must behave exactly as before — folder path + flags, nothing else.
  it('changes nothing for a server that does not send labels', async () => {
    const plain = new FakeImapServer();                 // gmailLabels: false
    plain.addFolder('INBOX');
    plain.addMessage('INBOX', { flags: ['\\Seen'] });
    const store = new FakeEmailStorage();
    store.addFolder('INBOX');

    const folder = (await store.getFolders())[0];
    await plain.selectFolder('INBOX');
    const messages = await plain.fetchMessages('1:*', { fetchBody: false });
    await new MessageProcessor().processBatch(messages, folder, store as never, undefined, { quiet: true });

    expect(await tagsOfOnly(store, 'INBOX')).toEqual(['INBOX', 'read']);
  });
});
