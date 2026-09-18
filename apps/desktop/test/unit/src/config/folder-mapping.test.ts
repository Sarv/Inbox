import {
  categoryNameSlug as coreCategoryNameSlug,
  isSarvHost as coreIsSarvHost,
  matchKnownCategory as coreMatchKnownCategory,
} from '@sarvinbox/core';
import { describe, it, expect } from 'vitest';

import {
  AI_LABEL_PARENT,
  HIDDEN_PROVIDER_FOLDERS,
  SPECIAL_USE_TO_TYPE,
  STANDARD_FOLDER_MAP,
  VIRTUAL_FOLDERS,
  classifyFolder,
  findFolderByType,
  folderDisplayName,
  folderTypeMatchStrength,
  categoryNameSlug,
  hideableSystemCategories,
  isAiLabelFolder,
  isArchiveFolder,
  isDraftsFolder,
  isInboxFolder,
  isSentFolder,
  isSarvHost,
  isSpamFolder,
  isSystemCategoryFolder,
  isTrashFolder,
  shouldHideFolder,
} from '../../../../src/config/folder-mapping';

describe('classifyFolder — resolution order', () => {
  // SPECIAL-USE (RFC 6154) → known path → name heuristic. Getting this order
  // wrong is how a server's real Sent folder ends up classified as a user
  // folder, which breaks "save a copy on send" and the Drafts/Trash actions.
  it('prefers the server-advertised SPECIAL-USE flag over the path', () => {
    // A localised folder ("Papierkorb") only identifies itself via \Trash.
    expect(classifyFolder({ path: 'Papierkorb', specialUse: '\\Trash' })).toBe('trash');
    // And SPECIAL-USE wins even when the path would say something else.
    expect(classifyFolder({ path: 'Archive', specialUse: '\\Sent' })).toBe('sent');
  });

  it('maps every SPECIAL-USE flag we advertise support for', () => {
    for (const [flag, type] of Object.entries(SPECIAL_USE_TO_TYPE)) {
      expect(classifyFolder({ path: 'whatever-name', specialUse: flag })).toBe(type);
    }
  });

  it('falls through to the path table when SPECIAL-USE is unknown/absent', () => {
    expect(classifyFolder({ path: '[Gmail]/Sent Mail', specialUse: '\\Unknown' })).toBe('sent');
    expect(classifyFolder({ path: '[Gmail]/Trash', specialUse: null })).toBe('trash');
    expect(classifyFolder({ path: 'Deleted Items' })).toBe('trash');
    expect(classifyFolder({ path: 'Junk E-mail' })).toBe('spam');
  });

  it('recognises every path in the standard map', () => {
    for (const [type, paths] of Object.entries(STANDARD_FOLDER_MAP)) {
      for (const path of paths) expect(classifyFolder({ path })).toBe(type);
    }
  });

  it('falls back to a case-insensitive name heuristic on the LAST path segment', () => {
    // Dovecot-style nesting: only the leaf tells you what the folder is.
    expect(classifyFolder({ path: 'INBOX/Sent' })).toBe('sent');
    expect(classifyFolder({ path: 'Mail/drafts' })).toBe('drafts');
    expect(classifyFolder({ path: 'Mail/BIN' })).toBe('trash');
    expect(classifyFolder({ path: 'Mail/junk e-mail' })).toBe('spam');
    expect(classifyFolder({ path: 'Mail/All Mail' })).toBe('archive');
    expect(classifyFolder({ path: 'Mail/Flagged' })).toBe('starred');
    expect(classifyFolder({ path: 'Mail/important' })).toBe('important');
    expect(classifyFolder({ path: 'Mail/inbox' })).toBe('inbox');
  });

  it('uses the display name when the path has no usable segment', () => {
    expect(classifyFolder({ path: '', name: 'Drafts' })).toBe('drafts');
  });

  it('returns null for a genuine user folder', () => {
    // Must be null, not a guess — otherwise a user folder named "Receipts"
    // would inherit Trash/Spam behaviour (excluded from unread counts, etc.).
    expect(classifyFolder({ path: 'Receipts' })).toBeNull();
    expect(classifyFolder({ path: 'Clients/Acme' })).toBeNull();
    expect(classifyFolder({ path: '' })).toBeNull();
  });

  it('does not match on a partial word ("Sent Invoices" is a user folder)', () => {
    expect(classifyFolder({ path: 'Sent Invoices' })).toBeNull();
    expect(classifyFolder({ path: 'Trash Talk' })).toBeNull();
  });
});

describe('findFolderByType', () => {
  // Used to resolve "where do drafts go on THIS server". A SPECIAL-USE match
  // must beat a name match, or a user folder literally named "Drafts" can win
  // over the server's real \Drafts mailbox and drafts vanish on save.
  const folders = [
    { path: 'Drafts' }, // name-only match, listed FIRST
    { path: 'MyDrafts', specialUse: '\\Drafts' }, // authoritative
    { path: 'INBOX', specialUse: '\\Inbox' },
  ];

  it('prefers a SPECIAL-USE match over an earlier name match', () => {
    expect(findFolderByType(folders, 'drafts')?.path).toBe('MyDrafts');
  });

  it('falls back to classifyFolder when nothing advertises the flag', () => {
    expect(findFolderByType([{ path: 'Sent Items' }, { path: 'Work' }], 'sent')?.path).toBe('Sent Items');
  });

  it('returns null when the server has no such folder', () => {
    expect(findFolderByType([{ path: 'Work' }], 'spam')).toBeNull();
    expect(findFolderByType([], 'inbox')).toBeNull();
  });

  // Regression for the Sent folder that showed a single message under "of
  // 1,719". Sarv lists two mailboxes for one physical Sent store — `Sent` and
  // an alias `Sent Mail` — and the sidebar collapses the role to ONE folder.
  // Returning whichever was listed first pointed the Sent view at the empty
  // alias: no mail, a server-sized count, and a "next" that paged into nothing.
  it('prefers the real mailbox over an alias that only looks the part', () => {
    const sarv = [{ path: 'INBOX' }, { path: 'Sent Mail' }, { path: 'Sent' }];
    expect(findFolderByType(sarv, 'sent')?.path).toBe('Sent');
  });

  // Breaks: the provider preference order stops meaning anything, so Gmail's
  // own Sent loses to a stray `Sent` label.
  it('ranks known provider paths by their position in the list', () => {
    expect(findFolderByType([{ path: 'Sent' }, { path: '[Gmail]/Sent Mail' }], 'sent')?.path)
      .toBe('[Gmail]/Sent Mail');
  });

  // Breaks: the ranking changes WHICH folders match instead of only ordering
  // them — it must stay in lockstep with classifyFolder.
  it('scores by tier and refuses to score a folder of another type', () => {
    expect(folderTypeMatchStrength({ path: 'X', specialUse: '\\Sent' }, 'sent')).toBe(0);
    expect(folderTypeMatchStrength({ path: 'Sent' }, 'sent'))
      .toBeLessThan(folderTypeMatchStrength({ path: 'Sent Mail' }, 'sent')!);
    expect(folderTypeMatchStrength({ path: 'Trash' }, 'sent')).toBeNull();
  });
});

describe('is<Type>Folder shorthands', () => {
  it('each answers true only for its own type', () => {
    expect(isInboxFolder({ path: 'INBOX' })).toBe(true);
    expect(isSentFolder({ path: '[Gmail]/Sent Mail' })).toBe(true);
    expect(isDraftsFolder({ path: 'Drafts' })).toBe(true);
    expect(isTrashFolder({ path: 'Deleted Items' })).toBe(true);
    expect(isSpamFolder({ path: '[Gmail]/Spam' })).toBe(true);
    expect(isArchiveFolder({ path: '[Gmail]/All Mail' })).toBe(true);

    expect(isInboxFolder({ path: 'Drafts' })).toBe(false);
    expect(isTrashFolder({ path: 'INBOX' })).toBe(false);
  });
});

describe('shouldHideFolder', () => {
  // Gmail's virtual mailboxes are synced but must not appear in the sidebar —
  // they duplicate every message and would double the apparent mail count.
  it('hides Gmail virtual mailboxes and generic all-mail/important', () => {
    expect(shouldHideFolder('[Gmail]/All Mail')).toBe(true);
    expect(shouldHideFolder('[Gmail]/Important')).toBe(true);
    expect(shouldHideFolder('[Gmail]/Starred')).toBe(true);
    expect(shouldHideFolder('All Mail')).toBe(true);
    expect(shouldHideFolder('Important')).toBe(true);
  });

  it('matches case-insensitively and on a nested trailing segment', () => {
    expect(shouldHideFolder('all mail')).toBe(true);
    expect(shouldHideFolder('INBOX/Archive')).toBe(true);
  });

  it('does not hide a user folder that merely CONTAINS a hidden name', () => {
    expect(shouldHideFolder('Important Clients')).toBe(false);
    expect(shouldHideFolder('Archived Receipts')).toBe(false);
    expect(shouldHideFolder('INBOX')).toBe(false);
  });

  it('keeps every hidden pattern non-empty (an empty pattern would hide everything)', () => {
    for (const p of HIDDEN_PROVIDER_FOLDERS) expect(p.trim().length).toBeGreaterThan(0);
  });
});

describe('isAiLabelFolder', () => {
  // Our AI categories are mirrored to the server under "Sarv Inbox"; they are
  // surfaced at the top of the app, so the mirrored folders must not also show
  // in the FOLDERS list (the user would see each category twice).
  it('matches the parent itself and anything nested under it, for any delimiter', () => {
    expect(isAiLabelFolder(AI_LABEL_PARENT)).toBe(true);
    expect(isAiLabelFolder('Sarv Inbox/Promotions')).toBe(true);
    expect(isAiLabelFolder('Sarv Inbox.Promotions')).toBe(true);
    expect(isAiLabelFolder('Sarv Inbox\\Promotions')).toBe(true);
  });

  it('does not match a user folder with a similar prefix', () => {
    expect(isAiLabelFolder('Sarv Inbox Archive')).toBe(false);
    expect(isAiLabelFolder('INBOX/Sarv Inbox')).toBe(false);
    expect(isAiLabelFolder('')).toBe(false);
  });
});

describe('VIRTUAL_FOLDERS', () => {
  it('declares the locally-computed views with unique ids and priorities', () => {
    expect(VIRTUAL_FOLDERS.map((f) => f.id)).toEqual(['virtual-all', 'virtual-important', 'virtual-starred']);
    expect(new Set(VIRTUAL_FOLDERS.map((f) => f.priority)).size).toBe(VIRTUAL_FOLDERS.length);
  });

  it('gives the filtered views a query and leaves "all" unfiltered', () => {
    expect(VIRTUAL_FOLDERS.find((f) => f.id === 'virtual-all')?.query).toBeUndefined();
    expect(VIRTUAL_FOLDERS.find((f) => f.id === 'virtual-important')?.query).toEqual({ aiCategory: 'is_important' });
    expect(VIRTUAL_FOLDERS.find((f) => f.id === 'virtual-starred')?.query).toEqual({ tags: ['starred'] });
  });
});

/**
 * The sidebar collapses a role to ONE folder with findFolderByType, so this
 * decides which Sent the user actually opens. It must agree with core's copy —
 * if the two disagree the sidebar lists a mailbox the sync engine isn't
 * filling, which is exactly the bug: an empty Sent under a 1,719 count.
 */
describe('findFolderByType — two names for one mailbox', () => {
  // Same UIDVALIDITY and same server count: the server itself says one store.
  const twin = (path: string, over: Record<string, unknown> = {}) => ({
    path, uidValidity: 7, serverMessageCount: 1718, totalCount: 0, ...over,
  });

  // Breaks: the production bug of 2026-09-11. Sarv flags the EMPTY `Sent Mail`
  // with `\Sent` while every sent message is filed under `Sent`; dedup by
  // message-id means the flagged one can never gain a row, so showing it gives
  // the user one message, a server-sized count, and a blank next page.
  it('prefers the folder holding the mail over its empty SPECIAL-USE twin', () => {
    const folders = [twin('Sent Mail', { specialUse: '\\Sent' }), twin('Sent', { totalCount: 1713 })];
    expect(findFolderByType(folders, 'sent')?.path).toBe('Sent');
  });

  // Breaks: THE live account. `totalCount` counts membership TAGS, so one row
  // in a store listed twice counts under BOTH names and the tag counts read
  // ~1,718 either way. The main process measures primary filing for contested
  // roles and ships it as `ownedCount` over IPC; the sidebar must prefer it, or
  // it opens the flagged-but-empty name while the sync engine fills the other.
  it('follows the FILED count when both names are fully tagged', () => {
    const folders = [
      twin('Sent Mail', { specialUse: '\\Sent', totalCount: 1718, ownedCount: 1 }),
      twin('Sent', { serverMessageCount: 1713, totalCount: 1719, ownedCount: 1718 }),
    ];
    expect(findFolderByType(folders, 'sent')?.path).toBe('Sent');
  });

  // Breaks: the rail that keeps two REAL mailboxes apart on a server that
  // reuses one UIDVALIDITY. Each name full against its OWN server count means
  // two stores — one store can only ever fill one of its names.
  it('ignores the row count when both names are full of their own mail', () => {
    const folders = [
      { path: 'Sent', specialUse: '\\Sent', uidValidity: 7, serverMessageCount: 3, totalCount: 3 },
      { path: 'Sent Items', uidValidity: 7, serverMessageCount: 900, totalCount: 900 },
    ];
    expect(findFolderByType(folders, 'sent')?.path).toBe('Sent');
  });

  // Breaks: a fresh account with nothing synced flapping between two names —
  // with no mail anywhere the ranking must still decide, once.
  it('falls back to the ranking when neither twin holds mail yet', () => {
    expect(findFolderByType([twin('Sent Mail'), twin('Sent', { specialUse: '\\Sent' })], 'sent')?.path)
      .toBe('Sent');
  });

  // Breaks: the safety rail. Two mailboxes that merely share a role can hold
  // different mail, so a bigger row count must not move the role onto one the
  // server never said was the same store.
  it('ignores the row count when the two are different mailboxes', () => {
    const folders = [
      { path: 'Sent', specialUse: '\\Sent', uidValidity: 7, serverMessageCount: 3, totalCount: 3 },
      { path: 'Sent Items', uidValidity: 9, serverMessageCount: 900, totalCount: 900 },
    ];
    expect(findFolderByType(folders, 'sent')?.path).toBe('Sent');
  });

  // Breaks: the reader on a server that does not report UIDVALIDITY being left
  // on the empty name. Which folder to SHOW may follow the weaker evidence of
  // matching server counts — no mailbox is dropped by this choice.
  it('follows the mail when the counts match and the server gave no UIDVALIDITY', () => {
    const folders = [
      { path: 'Sent Mail', specialUse: '\\Sent', serverMessageCount: 1718, totalCount: 0 },
      { path: 'Sent', serverMessageCount: 1718, totalCount: 1713 },
    ];
    expect(findFolderByType(folders, 'sent')?.path).toBe('Sent');
  });

  // Breaks: a folder list with no sync state at all (nulls on both sides)
  // comparing equal and being read as proof.
  it('ignores the row count when the server has proven nothing', () => {
    const folders = [{ path: 'Sent', specialUse: '\\Sent' }, { path: 'Sent Mail', totalCount: 1713 }];
    expect(findFolderByType(folders, 'sent')?.path).toBe('Sent');
  });
});

describe('folderDisplayName', () => {
  // Breaks: the sidebar shouting "INBOX" next to normally-cased folders. IMAP
  // reserves the literal name `INBOX` (RFC 3501), so every server returns it in
  // caps; without a label for the role the raw wire name reaches the screen.
  it('labels the inbox "Inbox" however the server spells it', () => {
    expect(folderDisplayName({ path: 'INBOX', name: 'INBOX' })).toBe('Inbox');
    expect(folderDisplayName({ path: 'Inbox', name: 'Inbox' })).toBe('Inbox');
    expect(folderDisplayName({ path: 'Posteingang', name: 'Posteingang', specialUse: '\\Inbox' })).toBe('Inbox');
  });

  // Breaks: Gmail's system folders showing their wire paths ("[Gmail]/Sent Mail").
  it('gives every standard role its canonical label', () => {
    expect(folderDisplayName({ path: '[Gmail]/Sent Mail', name: '[Gmail]/Sent Mail' })).toBe('Sent');
    expect(folderDisplayName({ path: '[Gmail]/Drafts', name: '[Gmail]/Drafts' })).toBe('Drafts');
    expect(folderDisplayName({ path: 'Deleted Items', name: 'Deleted Items' })).toBe('Trash');
    expect(folderDisplayName({ path: 'Junk Email', name: 'Junk Email' })).toBe('Spam');
    expect(folderDisplayName({ path: '[Gmail]/All Mail', name: '[Gmail]/All Mail' })).toBe('Archive');
  });

  // Breaks: a user's own folder being renamed by a role label it never asked
  // for, or keeping Gmail's "[Gmail]/" prefix when it has no role at all.
  it('leaves a user folder its own name, minus the [Gmail]/ prefix', () => {
    expect(folderDisplayName({ path: 'Receipts', name: 'Receipts' })).toBe('Receipts');
    expect(folderDisplayName({ path: 'Work/Clients', name: 'Clients' })).toBe('Clients');
    expect(folderDisplayName({ path: '[Gmail]/Misc', name: '[Gmail]/Misc' })).toBe('Misc');
  });

  // Breaks: a role with no canonical label (starred/important) rendering as
  // empty instead of falling back to the server's name.
  it('falls back to the server name for a role with no canonical label', () => {
    expect(folderDisplayName({ path: '[Gmail]/Starred', name: '[Gmail]/Starred' })).toBe('Starred');
    expect(folderDisplayName({ path: 'Important', name: 'Important' })).toBe('Important');
  });
});

/**
 * Hiding our own system categories from the sidebar's FOLDERS list.
 *
 * On sarv.com the webmail team creates the category mailboxes themselves, under
 * their bare display names, so nothing carries the `Sarv Inbox` parent that
 * `isAiLabelFolder` keys off. The app shows those categories as pills in the
 * top bar; without this the user sees every one of them twice.
 */
describe('isSarvHost (renderer copy)', () => {
  // Regression: this gate is the ONLY thing standing between "hide our own
  // duplicate" and "hide a Gmail user's real Promotions folder".
  it('accepts sarv.com and its subdomains, and nothing that merely looks like it', () => {
    expect(isSarvHost('sarv.com')).toBe(true);
    expect(isSarvHost('imap.sarv.com')).toBe(true);
    expect(isSarvHost('MAIL.SARV.COM')).toBe(true);
    expect(isSarvHost('  imap.sarv.com  ')).toBe(true);

    expect(isSarvHost('notsarv.com')).toBe(false);
    expect(isSarvHost('sarv.com.br')).toBe(false);
    expect(isSarvHost('sarv.co')).toBe(false);
    expect(isSarvHost('imap.gmail.com')).toBe(false);
  });

  // Regression: an account added before the host was recorded must not throw
  // inside the sidebar render.
  it('treats a missing host as not ours', () => {
    expect(isSarvHost('')).toBe(false);
    expect(isSarvHost(null)).toBe(false);
    expect(isSarvHost(undefined)).toBe(false);
  });
});

describe('isSystemCategoryFolder', () => {
  const systemCategories = [
    { slug: 'needs_response', name: 'Needs Response' },
    { slug: 'promotions', name: 'Promotions' },
    { slug: 'finance' },
  ];

  // Regression: the whole point — a server folder named after one of our
  // system categories is the duplicate of a top-bar pill.
  it('matches a bare category mailbox by display name or slug', () => {
    expect(isSystemCategoryFolder('Promotions', systemCategories)).toBe(true);
    expect(isSystemCategoryFolder('Needs Response', systemCategories)).toBe(true);
    expect(isSystemCategoryFolder('needs-response', systemCategories)).toBe(true);
    expect(isSystemCategoryFolder('finance', systemCategories)).toBe(true);
  });

  // Regression: servers that root every mailbox under the INBOX namespace
  // (Courier, some Dovecot configs) report "INBOX.Promotions" — the same
  // top-level folder, one namespace down.
  it('matches a category directly under the INBOX namespace root', () => {
    expect(isSystemCategoryFolder('INBOX.Promotions', systemCategories)).toBe(true);
    expect(isSystemCategoryFolder('INBOX/Promotions', systemCategories)).toBe(true);
  });

  // Regression: hiding a folder we did not create loses the user access to its
  // mail — the top bar shows CATEGORISED mail, not that folder's contents.
  it('never matches a nested folder the user made themselves', () => {
    expect(isSystemCategoryFolder('Work/Promotions', systemCategories)).toBe(false);
    expect(isSystemCategoryFolder('INBOX.Work.Promotions', systemCategories)).toBe(false);
    expect(isSystemCategoryFolder('Promotions/2024', systemCategories)).toBe(false);
  });

  // Regression: a near-miss name is the user's own folder.
  it('does not match a folder that merely resembles a category', () => {
    expect(isSystemCategoryFolder('Promotional', systemCategories)).toBe(false);
    expect(isSystemCategoryFolder('Newsletters', systemCategories)).toBe(false);
    expect(isSystemCategoryFolder('Response', systemCategories)).toBe(false);
  });

  // Regression: the definitions arrive over IPC. A failed or empty load must
  // hide NOTHING — an empty list and an unreadable list look the same here, so
  // the safe reading is "hide nothing", never "hide everything".
  it('hides nothing when no system categories are known', () => {
    expect(isSystemCategoryFolder('Promotions', [])).toBe(false);
    expect(isSystemCategoryFolder('Promotions', undefined as unknown as [])).toBe(false);
  });

  // Regression: blank/odd paths must not throw inside a render path.
  it('is total for blank and malformed paths', () => {
    expect(isSystemCategoryFolder('', systemCategories)).toBe(false);
    expect(isSystemCategoryFolder('   ', systemCategories)).toBe(false);
    expect(isSystemCategoryFolder('INBOX.', systemCategories)).toBe(false);
    expect(isSystemCategoryFolder(undefined as unknown as string, systemCategories)).toBe(false);
  });

  // Regression: a USER-created category named after one of their own folders
  // must not make that folder vanish. The isSystem filter is the CALLER's job
  // (the Sidebar applies it before calling), so what this pins is that the
  // decision follows the list it is handed — nothing else.
  it('follows the list it is given, so a non-system category hides nothing', () => {
    const withUserCategory = [...systemCategories, { slug: 'receipts', name: 'Receipts' }];
    expect(isSystemCategoryFolder('Receipts', withUserCategory)).toBe(true);
    expect(isSystemCategoryFolder('Receipts', systemCategories)).toBe(false);
  });
});

describe('hideableSystemCategories', () => {
  const defs = [
    { slug: 'promotions', name: 'Promotions', isSystem: true },
    { slug: 'needs_response', name: 'Needs Response', isSystem: true },
    { slug: 'receipts', name: 'Receipts', isSystem: false },
    { slug: 'my_stuff', name: 'My Stuff' },
  ];

  // Regression: a Gmail/Fastmail user's own "Promotions" folder disappearing
  // from their sidebar. Only our own host names those mailboxes for us.
  it('hides nothing on any host but ours', () => {
    expect(hideableSystemCategories('imap.gmail.com', defs)).toEqual([]);
    expect(hideableSystemCategories('imap.fastmail.com', defs)).toEqual([]);
    expect(hideableSystemCategories('sarv.com.br', defs)).toEqual([]);
    expect(hideableSystemCategories(null, defs)).toEqual([]);
  });

  // Regression: a USER-created category named after one of their own folders
  // must never make that folder vanish — only built-in ones can.
  it('keeps only the system categories on our own host', () => {
    expect(hideableSystemCategories('imap.sarv.com', defs)).toEqual([
      { slug: 'promotions', name: 'Promotions' },
      { slug: 'needs_response', name: 'Needs Response' },
    ]);
  });

  // Regression: the definitions arrive over IPC, which can fail or answer
  // late. An unreadable list and an empty list look identical here, so both
  // must mean "hide nothing" — never "hide everything".
  it('hides nothing when the definitions are missing, empty or malformed', () => {
    expect(hideableSystemCategories('sarv.com', [])).toEqual([]);
    expect(hideableSystemCategories('sarv.com', null)).toEqual([]);
    expect(hideableSystemCategories('sarv.com', undefined)).toEqual([]);
    expect(hideableSystemCategories('sarv.com', [{ slug: '', isSystem: true }])).toEqual([]);
    expect(
      hideableSystemCategories('sarv.com', [null as unknown as { slug: string }]),
    ).toEqual([]);
  });

  // Regression: the two halves have to compose — what this returns is exactly
  // what decides whether a folder is dropped from the FOLDERS list.
  it('composes with isSystemCategoryFolder to drop only our own duplicates', () => {
    const ours = hideableSystemCategories('imap.sarv.com', defs);
    expect(isSystemCategoryFolder('Promotions', ours)).toBe(true);
    expect(isSystemCategoryFolder('Needs Response', ours)).toBe(true);
    // The user's own folders — one named after a non-system category, one
    // nested, one unrelated — all survive.
    expect(isSystemCategoryFolder('Receipts', ours)).toBe(false);
    expect(isSystemCategoryFolder('Work/Promotions', ours)).toBe(false);
    expect(isSystemCategoryFolder('Travel', ours)).toBe(false);

    const gmail = hideableSystemCategories('imap.gmail.com', defs);
    expect(isSystemCategoryFolder('Promotions', gmail)).toBe(false);
  });
});

/**
 * These helpers are browser-safe COPIES: the renderer bundle can import only
 * types from @sarvinbox/core (a value import pulls mailparser and breaks the
 * bundle). The tests run in Node, so here — and only here — both can be loaded
 * and compared. If this block fails, the copy has drifted from the original and
 * the two processes now disagree about what is one of our categories.
 */
describe('renderer copies agree with @sarvinbox/core', () => {
  it('isSarvHost decides identically', () => {
    const hosts = [
      'sarv.com', 'imap.sarv.com', 'MAIL.SARV.COM', '  sarv.com  ',
      'notsarv.com', 'sarv.com.br', 'sarv.co', 'imap.gmail.com', '',
    ];
    for (const host of hosts) {
      expect([host, isSarvHost(host)]).toEqual([host, coreIsSarvHost(host)]);
    }
  });

  it('categoryNameSlug normalises identically', () => {
    const names = ['Needs Response', 'needs-response', 'NEEDS   RESPONSE', '  Promotions  ', ''];
    for (const name of names) {
      expect([name, categoryNameSlug(name)]).toEqual([name, coreCategoryNameSlug(name)]);
    }
  });

  it('matches the same bare leaves against the same definitions', () => {
    const categories = [
      { slug: 'needs_response', name: 'Needs Response' },
      { slug: 'finance' },
    ];
    const leaves = ['Needs Response', 'needs-response', 'finance', 'Finance', 'Newsletters', ''];
    for (const leaf of leaves) {
      expect([leaf, isSystemCategoryFolder(leaf, categories)])
        .toEqual([leaf, coreMatchKnownCategory(leaf, categories) !== null]);
    }
  });
});
