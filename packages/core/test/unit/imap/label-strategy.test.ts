import { describe, expect, it, vi } from 'vitest';

import {
  SARV_LABEL_PARENT,
  folderPathForCategory,
  isSarvLabelPath,
  keywordForCategory,
  resolveLabelStrategy,
} from '../../../src/imap/label-strategy';
import { FakeImapServer, type FakeImapServerOptions } from '../../../src/test-support/fake-imap-server';
import { setLogLevel } from '../../../src/utils/logger';


// Category mirroring writes into the user's real mailbox, so the mechanism must
// be picked from LIVE CAPABILITIES (not the provider's name) and must never
// duplicate or lose mail. This suite pins:
//
//   - which strategy each server shape resolves to, including the deliberately
//     anchored `sarv.com` match (mysarv.com must NOT be treated as ours)
//   - keyword = in place (STORE +FLAGS): no copy, no move, no duplicate
//   - Gmail = COPY to the label mailbox (Gmail reads that as "add label"), and
//     removal via STORE -X-GM-LABELS, never a delete
//   - folder = CREATE + MOVE or COPY per the user's setting
//   - label provisioning is idempotent and survives "already exists" / denied /
//     absent-optional-method, because it runs opportunistically on every apply
//
// Where the label LIVES matters too, and the two answers are deliberate: on a
// keyword server (Sarv included) the keyword IS the label, so NOTHING is created
// — we flag the mail and the webmail renders it; every other provider gets a
// real `Sarv Inbox/<Category>` mailbox, and that prefix is what keeps our labels
// from passing as the user's folders. An interim scheme created registration
// folders on Sarv too; `migrate()` prunes them, WITHOUT ever deleting a mailbox
// the server hasn't confirmed is empty.

setLogLevel('error'); // provisioning logs an INFO line per CREATE

const FINANCE = { slug: 'finance', name: 'Finance' };

async function makeServer(options: FakeImapServerOptions = {}) {
  const server = new FakeImapServer(options);
  await server.connect();
  server.addFolder('INBOX');
  server.addMessages('INBOX', 2); // UIDs 1..2
  return server;
}

describe('keywordForCategory', () => {
  it('keeps an already keyword-safe slug', () => {
    expect(keywordForCategory({ slug: 'finance', name: 'Finance' })).toBe('finance');
    expect(keywordForCategory({ slug: 'needs_response', name: 'Needs Response' })).toBe('needs_response');
  });

  it('collapses everything IMAP would reject into underscores', () => {
    expect(keywordForCategory({ slug: 'follow-up / later', name: '' })).toBe('follow_up_later');
    expect(keywordForCategory({ slug: '(bills!)', name: '' })).toBe('bills');
  });

  it('falls back to the display name, then to a safe literal', () => {
    expect(keywordForCategory({ slug: '', name: 'Finance' })).toBe('Finance');
    expect(keywordForCategory({ slug: '', name: '' })).toBe('label');
    expect(keywordForCategory({ slug: '✈', name: '✈' })).toBe('label'); // nothing survives sanitising
  });
});

describe('folderPathForCategory', () => {
  it('nests the display name under the shared parent, honouring the delimiter', () => {
    expect(folderPathForCategory(FINANCE, '/')).toBe('Sarv Inbox/Finance');
    expect(folderPathForCategory(FINANCE, '.')).toBe('Sarv Inbox.Finance');
    expect(SARV_LABEL_PARENT).toBe('Sarv Inbox');
  });

  it('never lets a name forge a deeper path (delimiter and backslash are neutralised)', () => {
    expect(folderPathForCategory({ slug: 'x', name: 'A/B' }, '/')).toBe('Sarv Inbox/A-B');
    expect(folderPathForCategory({ slug: 'x', name: 'A\\B' }, '/')).toBe('Sarv Inbox/A-B');
    expect(folderPathForCategory({ slug: 'x', name: 'v1.2' }, '.')).toBe('Sarv Inbox.v1-2');
  });

  it('falls back to the slug, then to a literal leaf', () => {
    expect(folderPathForCategory({ slug: 'finance', name: '' }, '/')).toBe('Sarv Inbox/finance');
    expect(folderPathForCategory({ slug: '', name: '' }, '/')).toBe('Sarv Inbox/Label');
  });
});

describe('resolveLabelStrategy — capability, not guesswork', () => {
  it('a Gmail host takes the native-label path even though keywords are supported', async () => {
    const server = await makeServer({ keywords: true });
    const strategy = await resolveLabelStrategy(server as any, 'imap.gmail.com', 'copy');
    expect(strategy.kind).toBe('gmail');
  });

  it('the Gmail IMAP extension wins on an unknown host, without consulting keywords', async () => {
    const server = await makeServer({ gmailLabels: true, keywords: true });
    const keywordProbe = vi.spyOn(server, 'supportsKeywords');

    const strategy = await resolveLabelStrategy(server as any, 'imap.somewhere.test', 'copy');

    expect(strategy.kind).toBe('gmail');
    expect(keywordProbe).not.toHaveBeenCalled();
  });

  it('a keyword-capable non-Gmail server tags in place', async () => {
    const server = await makeServer({ keywords: true });
    expect((await resolveLabelStrategy(server as any, 'imap.somewhere.test', 'copy')).kind).toBe('keyword');
  });

  it('falls back to folders when the server takes neither Gmail labels nor keywords', async () => {
    const server = await makeServer({ keywords: false });
    expect((await resolveLabelStrategy(server as any, 'imap.somewhere.test', 'move')).kind).toBe('folder');
  });

  it('falls back to folders for a client that cannot even be asked about keywords', async () => {
    const server = await makeServer({ keywords: true });
    (server as any).supportsKeywords = undefined;
    expect((await resolveLabelStrategy(server as any, 'imap.somewhere.test', 'copy')).kind).toBe('folder');
  });

  it('treats an unknown (empty) host as "not ours" — nothing created, nothing deleted', async () => {
    const server = await makeServer({ keywords: true });
    server.addFolder('Sarv Inbox/Finance');
    const strategy = await resolveLabelStrategy(server as any, '', 'copy');
    await strategy.ensure(FINANCE);
    await strategy.migrate!(FINANCE);

    expect(strategy.kind).toBe('keyword');
    expect(server.callCount('createMailbox')).toBe(0);
    expect(server.callCount('deleteMailbox')).toBe(0);
  });

  // Only OUR server's leftovers are ours to delete, so the host match is
  // anchored — a look-alike domain must never have mailboxes removed from it.
  it.each(['sarv.com', 'imap.sarv.com', 'IMAP.SARV.COM', '  mail.sarv.com  '])(
    'recognises the sarv.com domain (%s) for the leftover-folder cleanup',
    async (host) => {
      const server = await makeServer({ keywords: true });
      server.addFolder('Sarv Inbox/Finance');
      const strategy = await resolveLabelStrategy(server as any, host, 'copy');
      await strategy.migrate!(FINANCE);
      expect(strategy.kind).toBe('keyword');
      expect(await server.listMailboxPaths()).not.toContain('Sarv Inbox/Finance');
    },
  );

  it.each(['mysarv.com', 'sarvodaya.com', 'sarv.com.evil.test', 'imap.notsarv.com'])(
    'deletes nothing on a look-alike host (%s)',
    async (host) => {
      const server = await makeServer({ keywords: true });
      server.addFolder('Sarv Inbox/Finance');
      const strategy = await resolveLabelStrategy(server as any, host, 'copy');
      await strategy.migrate!(FINANCE);
      expect(strategy.kind).toBe('keyword');
      expect(await server.listMailboxPaths()).toContain('Sarv Inbox/Finance');
    },
  );
});

describe('keyword strategy — in place, no duplication', () => {
  it('applies the keyword with a STORE and leaves the mailbox untouched otherwise', async () => {
    const server = await makeServer({ keywords: true });
    const strategy = await resolveLabelStrategy(server as any, 'imap.somewhere.test', 'copy');

    await strategy.apply('INBOX', [1, 2], FINANCE);

    expect(server.flagsOf('INBOX', 1)).toEqual(['finance']);
    expect(server.callCount('addFlags')).toBe(1);   // one STORE for both UIDs
    expect(server.callCount('copyMessages')).toBe(0);
    expect(server.callCount('moveMessages')).toBe(0);
    expect(server.callCount('createMailbox')).toBe(0); // no folder clutter off-Sarv
    expect(server.messageCount('INBOX')).toBe(2);
  });

  it('removes the keyword again', async () => {
    const server = await makeServer({ keywords: true });
    const strategy = await resolveLabelStrategy(server as any, 'imap.somewhere.test', 'copy');
    await strategy.apply('INBOX', [1], FINANCE);

    await strategy.remove('INBOX', [1], FINANCE);

    expect(server.flagsOf('INBOX', 1)).toEqual([]);
  });

  // Breaks: we start manufacturing folders in the user's own mailbox again. On
  // Sarv the webmail already knows these labels — the flag is the whole job, and
  // a folder per category is clutter the user has to look at.
  it('on Sarv, flags the mail and creates NO folder for it', async () => {
    const server = await makeServer({ keywords: true });
    const strategy = await resolveLabelStrategy(server as any, 'imap.sarv.com', 'copy');

    await strategy.apply('INBOX', [1], FINANCE);
    await strategy.ensure(FINANCE); // the provisioning pass asks too

    expect(server.flagsOf('INBOX', 1)).toEqual(['finance']); // the bare category name
    expect(server.callCount('createMailbox')).toBe(0);
    expect(await server.listMailboxPaths()).toEqual(['INBOX']);
  });

  // Breaks: tagging mail gets slower the longer the app runs. The one-time
  // migration probes and DELETEs; on the apply path that is a round-trip per
  // category per message, forever, to clean something up once.
  it('never pays for the migration on the apply path', async () => {
    const server = await makeServer({ keywords: true });
    server.addFolder('Sarv Inbox/Finance');
    const strategy = await resolveLabelStrategy(server as any, 'sarv.com', 'copy');

    await strategy.apply('INBOX', [1], FINANCE);

    expect(server.callCount('deleteMailbox')).toBe(0);
    expect(server.callCount('getFolderStatus')).toBe(0);
  });


  // Breaks: the migration asks for the delimiter on every category instead of
  // once — the nested path it has to find is delimiter-dependent.
  it('asks for the hierarchy delimiter only once across migrations', async () => {
    const server = await makeServer({ keywords: true, hierarchyDelimiter: '.' });
    server.addFolder('Sarv Inbox.Finance');
    const delimiter = vi.spyOn(server, 'getHierarchyDelimiter');
    const strategy = await resolveLabelStrategy(server as any, 'sarv.com', 'copy');

    await strategy.migrate!(FINANCE);
    await strategy.migrate!(FINANCE);

    expect(delimiter).toHaveBeenCalledTimes(1);
    expect(await server.listMailboxPaths()).not.toContain('Sarv Inbox.Finance');
  });

  it('survives a refused DELETE and still tags the mail', async () => {
    const server = await makeServer({ keywords: true });
    server.addFolder('Sarv Inbox');
    server.addFolder('Sarv Inbox/Finance');
    (server as any).deleteMailbox = async () => { throw new Error('NO mailbox is not empty'); };
    const strategy = await resolveLabelStrategy(server as any, 'sarv.com', 'copy');

    await expect(strategy.migrate!(FINANCE)).resolves.toBeUndefined();
    // The tagging is independent of the cleanup — it is never gated on it.
    await expect(strategy.apply('INBOX', [1], FINANCE)).resolves.toBeUndefined();
    expect(server.flagsOf('INBOX', 1)).toEqual(['finance']);
  });

  it('tolerates a client with no deleteMailbox at all (optional method)', async () => {
    const server = await makeServer({ keywords: true });
    server.addFolder('Sarv Inbox/Finance');
    (server as any).deleteMailbox = undefined;
    const strategy = await resolveLabelStrategy(server as any, 'sarv.com', 'copy');

    await expect(strategy.ensure(FINANCE)).resolves.toBeUndefined();
    await expect(strategy.migrate!(FINANCE)).resolves.toBeUndefined();
    expect(await server.listMailboxPaths()).toContain('Sarv Inbox/Finance');
  });

  it('defaults to "/" when the client cannot report a hierarchy delimiter', async () => {
    const server = await makeServer({ keywords: true, hierarchyDelimiter: '.' });
    server.addFolder('Sarv Inbox/Finance');
    (server as any).getHierarchyDelimiter = undefined;
    const strategy = await resolveLabelStrategy(server as any, 'sarv.com', 'copy');

    await strategy.migrate!(FINANCE);

    expect(await server.listMailboxPaths()).not.toContain('Sarv Inbox/Finance');
  });

  it('rename is a no-op — the keyword is keyed on the stable slug, not the name', async () => {
    const server = await makeServer({ keywords: true });
    const renamed = vi.spyOn(server, 'renameMailbox');
    const strategy = await resolveLabelStrategy(server as any, 'sarv.com', 'copy');

    await expect(strategy.rename(FINANCE, { slug: 'finance', name: 'Money' })).resolves.toBeUndefined();
    expect(renamed).not.toHaveBeenCalled();
  });
});

describe('migrate — undoing the interim nested scheme, without losing mail', () => {
  const INVOICES = { slug: 'invoices', name: 'Invoices' };

  // Breaks: the interim "Sarv Inbox/Finance" tree stays in Sarv webmail forever
  // next to the flat labels that replaced it — two entries for one category.
  it('drops the nested leaf and then the childless parent', async () => {
    const server = await makeServer({ keywords: true });
    server.addFolder(SARV_LABEL_PARENT);
    server.addFolder('Sarv Inbox/Finance');
    const strategy = await resolveLabelStrategy(server as any, 'sarv.com', 'copy');

    await strategy.migrate!(FINANCE);

    expect(await server.listMailboxPaths()).not.toContain('Sarv Inbox/Finance');
    expect(await server.listMailboxPaths()).not.toContain(SARV_LABEL_PARENT);
  });

  // Breaks: DATA LOSS. IMAP's DELETE destroys the messages in the mailbox, so a
  // category folder someone actually filed mail into must survive the cleanup.
  it('refuses to delete a nested label that holds mail', async () => {
    const server = await makeServer({ keywords: true });
    server.addFolder('Sarv Inbox/Finance');
    server.addMessages('Sarv Inbox/Finance', 3);
    const strategy = await resolveLabelStrategy(server as any, 'sarv.com', 'copy');

    await strategy.migrate!(FINANCE);

    expect(await server.listMailboxPaths()).toContain('Sarv Inbox/Finance');
    expect(server.messageCount('Sarv Inbox/Finance')).toBe(3);
  });

  // Breaks: DATA LOSS again, one level up. Many servers delete a mailbox that
  // still has inferiors and take the subtree with it, so the parent may only go
  // once the server LISTS nothing under it — not merely once we migrated a leaf.
  it('leaves the parent alone while another category is still nested under it', async () => {
    const server = await makeServer({ keywords: true });
    server.addFolder(SARV_LABEL_PARENT);
    server.addFolder('Sarv Inbox/Finance');
    server.addFolder('Sarv Inbox/Invoices');
    const strategy = await resolveLabelStrategy(server as any, 'sarv.com', 'copy');

    await strategy.migrate!(FINANCE);

    expect(await server.listMailboxPaths()).toContain(SARV_LABEL_PARENT);
    expect(await server.listMailboxPaths()).toContain('Sarv Inbox/Invoices');

    // ...and once the last leaf migrates, the parent goes with it.
    await strategy.migrate!(INVOICES);
    expect(await server.listMailboxPaths()).not.toContain(SARV_LABEL_PARENT);
  });

  // Breaks: THE lesson from the orphan-DB sweep — an unreadable store and an
  // empty store are the same value and opposite facts. A STATUS that fails
  // (blip, denied, gone) must mean "leave it", never "it was empty".
  it('deletes nothing when the server will not say how much is in there', async () => {
    const server = await makeServer({ keywords: true });
    server.addFolder(SARV_LABEL_PARENT);
    server.addFolder('Sarv Inbox/Finance');
    (server as any).getFolderStatus = async () => { throw new Error('NO [SERVERBUG] try again'); };
    const deleted = vi.spyOn(server, 'deleteMailbox');
    const strategy = await resolveLabelStrategy(server as any, 'sarv.com', 'copy');

    await strategy.migrate!(FINANCE);

    expect(deleted).not.toHaveBeenCalled();
    expect(await server.listMailboxPaths()).toContain('Sarv Inbox/Finance');
  });

  // Breaks: a server that answers STATUS without a message count is read as
  // "zero messages" and the mailbox is destroyed on the strength of a field
  // that was never there.
  it('deletes nothing when STATUS comes back without a message count', async () => {
    const server = await makeServer({ keywords: true });
    server.addFolder('Sarv Inbox/Finance');
    (server as any).getFolderStatus = async () => ({ uidNext: 1, uidValidity: 1, unseen: 0 });
    const deleted = vi.spyOn(server, 'deleteMailbox');
    const strategy = await resolveLabelStrategy(server as any, 'sarv.com', 'copy');

    await strategy.migrate!(FINANCE);

    expect(deleted).not.toHaveBeenCalled();
    expect(await server.listMailboxPaths()).toContain('Sarv Inbox/Finance');
  });

  // Breaks: the parent survives on a client that cannot LIST, because "no
  // children found" would be read out of an answer we never got.
  it('leaves the parent alone when the client cannot list mailboxes', async () => {
    const server = await makeServer({ keywords: true });
    server.addFolder(SARV_LABEL_PARENT);
    (server as any).listMailboxPaths = undefined;
    const deleted = vi.spyOn(server, 'deleteMailbox');
    const strategy = await resolveLabelStrategy(server as any, 'sarv.com', 'copy');

    await strategy.migrate!(FINANCE);

    expect(deleted).not.toHaveBeenCalled();
  });

  // Same, for a LIST that errors rather than being absent.
  it('leaves the parent alone when listing fails', async () => {
    const server = await makeServer({ keywords: true });
    server.addFolder(SARV_LABEL_PARENT);
    (server as any).listMailboxPaths = async () => { throw new Error('NO cannot list'); };
    const deleted = vi.spyOn(server, 'deleteMailbox');
    const strategy = await resolveLabelStrategy(server as any, 'sarv.com', 'copy');

    await strategy.migrate!(FINANCE);

    expect(deleted).not.toHaveBeenCalled();
  });

  // Breaks: we start deleting mailboxes on servers that were never ours to
  // tidy — a Fastmail/Dovecot account with a folder called "Sarv Inbox".
  it('does nothing at all on a keyword server that is not ours', async () => {
    const server = await makeServer({ keywords: true });
    server.addFolder('Sarv Inbox/Finance');
    const deleted = vi.spyOn(server, 'deleteMailbox');
    const strategy = await resolveLabelStrategy(server as any, 'imap.somewhere.test', 'copy');

    await strategy.migrate!(FINANCE);

    expect(deleted).not.toHaveBeenCalled();
    expect(await server.listMailboxPaths()).toContain('Sarv Inbox/Finance');
  });

  // Breaks: the prefixed providers get their labels deleted out from under them.
  // Only the keyword strategy has an old scheme to migrate away from.
  it.each([
    ['gmail', 'imap.gmail.com', { gmailLabels: true } as FakeImapServerOptions],
    ['folder', 'imap.outlook.test', { keywords: false } as FakeImapServerOptions],
  ])('the %s strategy has nothing to migrate', async (kind, host, options) => {
    const server = await makeServer(options);
    const strategy = await resolveLabelStrategy(server as any, host, 'copy');

    expect(strategy.kind).toBe(kind);
    expect(strategy.migrate).toBeUndefined();
  });
});

describe('isSarvLabelPath', () => {
  // Breaks: the cleanup action either misses our label tree or eats the user's
  // folders. It is the one definition of "this mailbox is ours".
  it('matches the parent and anything under it, whatever the delimiter', () => {
    expect(isSarvLabelPath(SARV_LABEL_PARENT)).toBe(true);
    expect(isSarvLabelPath('Sarv Inbox/Finance')).toBe(true);
    expect(isSarvLabelPath('Sarv Inbox.Finance')).toBe(true);
    expect(isSarvLabelPath('Sarv Inbox\\Finance')).toBe(true);
  });

  it('does not match a folder that merely starts with the same words', () => {
    expect(isSarvLabelPath('Sarv Inbox Archive')).toBe(false);
    expect(isSarvLabelPath('INBOX/Sarv Inbox')).toBe(false);
    expect(isSarvLabelPath('finance')).toBe(false); // a plain folder, not our tree
    expect(isSarvLabelPath('')).toBe(false);
  });
});

describe('gmail strategy — COPY means "add label", not duplicate', () => {
  it('creates the parent, then the label, then COPYs — and the mail stays in INBOX', async () => {
    const server = await makeServer({ gmailLabels: true });
    const strategy = await resolveLabelStrategy(server as any, 'imap.gmail.com', 'copy');

    await strategy.apply('INBOX', [1], FINANCE);

    expect(server.calls.filter((c) => c === 'createMailbox' || c === 'copyMessages'))
      .toEqual(['createMailbox', 'createMailbox', 'copyMessages']);
    expect(await server.listMailboxPaths()).toContain('Sarv Inbox/Finance');
    expect(server.messageCount('INBOX')).toBe(2);              // no duplicate in the inbox
    expect(server.messageCount('Sarv Inbox/Finance')).toBe(1); // labelled
  });

  it('removes the label in place with STORE -X-GM-LABELS, never deleting the message', async () => {
    const server = await makeServer({ gmailLabels: true });
    const strategy = await resolveLabelStrategy(server as any, 'imap.gmail.com', 'copy');
    const removeLabels = vi.spyOn(server, 'removeGmailLabels');

    await strategy.remove('INBOX', [1], FINANCE);

    expect(removeLabels).toHaveBeenCalledWith([1], ['Sarv Inbox/Finance']);
    expect(server.callCount('deleteMessages')).toBe(0);
    expect(server.messageCount('INBOX')).toBe(2);
  });

  it('removal is a silent no-op on a client without Gmail-label support', async () => {
    const server = await makeServer({ gmailLabels: true });
    const strategy = await resolveLabelStrategy(server as any, 'imap.gmail.com', 'copy');
    (server as any).removeGmailLabels = undefined;
    const before = server.calls.length;

    await expect(strategy.remove('INBOX', [1], FINANCE)).resolves.toBeUndefined();
    expect(server.calls.length).toBe(before); // not even a SELECT
  });

  it('ensure creates the empty label without touching any message', async () => {
    const server = await makeServer({ gmailLabels: true });
    const strategy = await resolveLabelStrategy(server as any, 'imap.gmail.com', 'copy');

    await strategy.ensure(FINANCE);

    expect(await server.listMailboxPaths()).toEqual(expect.arrayContaining(['Sarv Inbox', 'Sarv Inbox/Finance']));
    expect(server.callCount('copyMessages')).toBe(0);
    expect(server.messageCount('Sarv Inbox/Finance')).toBe(0);
  });

  it('defaults the delimiter to "/" when the client cannot report one', async () => {
    const server = await makeServer({ gmailLabels: true, hierarchyDelimiter: '.' });
    (server as any).getHierarchyDelimiter = undefined;
    const strategy = await resolveLabelStrategy(server as any, 'imap.gmail.com', 'copy');

    await strategy.ensure(FINANCE);

    expect(await server.listMailboxPaths()).toContain('Sarv Inbox/Finance');
  });

  it('rename moves the label mailbox, and no-ops when the client cannot rename', async () => {
    const server = await makeServer({ gmailLabels: true });
    const strategy = await resolveLabelStrategy(server as any, 'imap.gmail.com', 'copy');
    await strategy.ensure(FINANCE);

    await strategy.rename(FINANCE, { slug: 'finance', name: 'Money' });
    expect(await server.listMailboxPaths()).toContain('Sarv Inbox/Money');
    expect(await server.listMailboxPaths()).not.toContain('Sarv Inbox/Finance');

    (server as any).renameMailbox = undefined;
    await expect(strategy.rename(FINANCE, { slug: 'finance', name: 'Cash' })).resolves.toBeUndefined();
  });
});

describe('folder strategy — the move-vs-copy trade-off the user picked', () => {
  it('mode "move" takes the mail out of the inbox with no duplicate', async () => {
    const server = await makeServer({ keywords: false });
    const strategy = await resolveLabelStrategy(server as any, 'imap.somewhere.test', 'move');

    await strategy.apply('INBOX', [1], FINANCE);

    expect(server.uidsIn('INBOX')).toEqual([2]);
    expect(server.messageCount('Sarv Inbox/Finance')).toBe(1);
    expect(server.callCount('copyMessages')).toBe(0);
  });

  it('mode "copy" keeps the inbox copy (and accepts the real duplicate)', async () => {
    const server = await makeServer({ keywords: false });
    const strategy = await resolveLabelStrategy(server as any, 'imap.somewhere.test', 'copy');

    await strategy.apply('INBOX', [1], FINANCE);

    expect(server.uidsIn('INBOX')).toEqual([1, 2]);
    expect(server.messageCount('Sarv Inbox/Finance')).toBe(1);
    expect(server.callCount('moveMessages')).toBe(0);
  });

  it('removal is a documented no-op in v1 — it must not delete or move anything', async () => {
    const server = await makeServer({ keywords: false });
    const strategy = await resolveLabelStrategy(server as any, 'imap.somewhere.test', 'move');
    await strategy.apply('INBOX', [1], FINANCE);
    const before = server.calls.length;

    await expect(strategy.remove('INBOX', [1], FINANCE)).resolves.toBeUndefined();

    expect(server.calls.length).toBe(before);
    expect(server.messageCount('Sarv Inbox/Finance')).toBe(1);
  });

  it('defaults the delimiter to "/" when the client cannot report one', async () => {
    const server = await makeServer({ keywords: false, hierarchyDelimiter: '.' });
    (server as any).getHierarchyDelimiter = undefined;
    const strategy = await resolveLabelStrategy(server as any, 'imap.somewhere.test', 'copy');

    await strategy.ensure(FINANCE);

    expect(await server.listMailboxPaths()).toContain('Sarv Inbox/Finance');
  });

  it('ensure provisions parent + label with no message commands', async () => {
    const server = await makeServer({ keywords: false });
    const strategy = await resolveLabelStrategy(server as any, 'imap.somewhere.test', 'move');

    await strategy.ensure(FINANCE);

    expect(await server.listMailboxPaths()).toEqual(expect.arrayContaining(['Sarv Inbox', 'Sarv Inbox/Finance']));
    expect(server.callCount('moveMessages')).toBe(0);
    expect(server.callCount('copyMessages')).toBe(0);
    expect(server.messageCount('INBOX')).toBe(2);
  });

  it('rename moves the label folder, and no-ops without renameMailbox', async () => {
    const server = await makeServer({ keywords: false });
    const strategy = await resolveLabelStrategy(server as any, 'imap.somewhere.test', 'copy');
    await strategy.ensure(FINANCE);

    await strategy.rename(FINANCE, { slug: 'finance', name: 'Money' });
    expect(await server.listMailboxPaths()).toContain('Sarv Inbox/Money');

    (server as any).renameMailbox = undefined;
    await expect(strategy.rename(FINANCE, { slug: 'finance', name: 'Cash' })).resolves.toBeUndefined();
  });
});
