import { describe, it, expect } from 'vitest';

import {
  AI_LABEL_PARENT,
  HIDDEN_PROVIDER_FOLDERS,
  SPECIAL_USE_TO_TYPE,
  STANDARD_FOLDER_MAP,
  VIRTUAL_FOLDERS,
  classifyFolder,
  findFolderByType,
  isAiLabelFolder,
  isArchiveFolder,
  isDraftsFolder,
  isInboxFolder,
  isSentFolder,
  isSpamFolder,
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
