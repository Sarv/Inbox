import { describe, expect, it, vi } from 'vitest';

import { FakeImapServer, type FakeImapServerOptions } from '../../../src/test-support/fake-imap-server';
import { setLogLevel } from '../../../src/utils/logger';

import {
  SARV_LABEL_PARENT,
  folderPathForCategory,
  keywordForCategory,
  resolveLabelStrategy,
} from '../../../src/imap/label-strategy';

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
// The nesting under "Sarv Inbox" matters too: an earlier scheme littered the
// webmail sidebar with flat top-level folders, which `ensure()` now prunes.

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

  it('treats an unknown (empty) host as "not ours" — no folders registered', async () => {
    const server = await makeServer({ keywords: true });
    const strategy = await resolveLabelStrategy(server as any, '', 'copy');
    await strategy.ensure(FINANCE);

    expect(strategy.kind).toBe('keyword');
    expect(server.callCount('createMailbox')).toBe(0);
  });

  // The registering folder is created for OUR servers only, so the host match is
  // anchored — a look-alike domain must never get folders created in it.
  it.each(['sarv.com', 'imap.sarv.com', 'IMAP.SARV.COM', '  mail.sarv.com  '])(
    'registers the label folder for the sarv.com domain (%s)',
    async (host) => {
      const server = await makeServer({ keywords: true });
      const strategy = await resolveLabelStrategy(server as any, host, 'copy');
      await strategy.ensure(FINANCE);
      expect(strategy.kind).toBe('keyword');
      expect(server.callCount('createMailbox')).toBeGreaterThan(0);
    },
  );

  it.each(['mysarv.com', 'sarvodaya.com', 'sarv.com.evil.test', 'imap.notsarv.com'])(
    'does NOT register folders on a look-alike host (%s)',
    async (host) => {
      const server = await makeServer({ keywords: true });
      const strategy = await resolveLabelStrategy(server as any, host, 'copy');
      await strategy.ensure(FINANCE);
      expect(strategy.kind).toBe('keyword');
      expect(server.callCount('createMailbox')).toBe(0);
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

  it('on Sarv, registers the label NESTED under the parent and prunes the legacy flat folder', async () => {
    const server = await makeServer({ keywords: true });
    server.addFolder('finance'); // leftover from the earlier flat scheme
    const created = vi.spyOn(server, 'createMailbox');
    const deleted = vi.spyOn(server, 'deleteMailbox');
    const strategy = await resolveLabelStrategy(server as any, 'imap.sarv.com', 'copy');

    await strategy.apply('INBOX', [1], FINANCE);

    expect(created.mock.calls.map(([p]) => p)).toEqual(['Sarv Inbox', 'Sarv Inbox/Finance']);
    expect(deleted).toHaveBeenCalledWith('finance');
    expect(server.flagsOf('INBOX', 1)).toEqual(['finance']); // still tagged in place
  });

  it('provisions idempotently and asks for the hierarchy delimiter only once', async () => {
    const server = await makeServer({ keywords: true, hierarchyDelimiter: '.' });
    const delimiter = vi.spyOn(server, 'getHierarchyDelimiter');
    const strategy = await resolveLabelStrategy(server as any, 'sarv.com', 'copy');

    await strategy.ensure(FINANCE);
    await strategy.ensure(FINANCE);

    expect(delimiter).toHaveBeenCalledTimes(1);
    expect(await server.listMailboxPaths()).toContain('Sarv Inbox.Finance');
  });

  it('survives an "already exists" parent, a denied leaf, and a refused legacy DELETE', async () => {
    const server = await makeServer({ keywords: true });
    (server as any).createMailbox = async () => { throw new Error('NO [ALREADYEXISTS] Mailbox already exists'); };
    (server as any).deleteMailbox = async () => { throw new Error('NO mailbox is not empty'); };
    const strategy = await resolveLabelStrategy(server as any, 'sarv.com', 'copy');

    await expect(strategy.ensure(FINANCE)).resolves.toBeUndefined();
    // The tagging itself still happens — provisioning is best-effort, not a gate.
    await expect(strategy.apply('INBOX', [1], FINANCE)).resolves.toBeUndefined();
    expect(server.flagsOf('INBOX', 1)).toEqual(['finance']);
  });

  it('tolerates a client with no deleteMailbox at all (optional method)', async () => {
    const server = await makeServer({ keywords: true });
    (server as any).deleteMailbox = undefined;
    const strategy = await resolveLabelStrategy(server as any, 'sarv.com', 'copy');

    await expect(strategy.ensure(FINANCE)).resolves.toBeUndefined();
    expect(await server.listMailboxPaths()).toContain('Sarv Inbox/Finance');
  });

  it('defaults to "/" when the client cannot report a hierarchy delimiter', async () => {
    const server = await makeServer({ keywords: true, hierarchyDelimiter: '.' });
    (server as any).getHierarchyDelimiter = undefined;
    const strategy = await resolveLabelStrategy(server as any, 'sarv.com', 'copy');

    await strategy.ensure(FINANCE);

    expect(await server.listMailboxPaths()).toContain('Sarv Inbox/Finance');
  });

  it('rename is a no-op — the keyword is keyed on the stable slug, not the name', async () => {
    const server = await makeServer({ keywords: true });
    const renamed = vi.spyOn(server, 'renameMailbox');
    const strategy = await resolveLabelStrategy(server as any, 'sarv.com', 'copy');

    await expect(strategy.rename(FINANCE, { slug: 'finance', name: 'Money' })).resolves.toBeUndefined();
    expect(renamed).not.toHaveBeenCalled();
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
