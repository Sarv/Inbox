import { describe, it, expect } from 'vitest';

import type { EmailProvider } from '../../../src/utils/provider';
import {
  detectProvider,
  getHiddenProviderFolders,
  getNormalizedFolderName,
  getProviderConfig,
  isImportantSourceFolder,
  isProviderAllMailFolder,
  isProviderImportantFolder,
  isProviderStarredFolder,
  isStarredSourceFolder,
  mapToVirtualFolder,
  normalizeFolderType,
  providerAutoSavesSentCopy,
} from '../../../src/utils/provider';

// Provider detection drives real, irreversible behaviour: whether we APPEND a
// Sent copy over IMAP (a wrong answer either duplicates every sent message or
// loses it off-device), which folders we hide, and how a server folder maps onto
// our unified sidebar.

describe('detectProvider', () => {
  it('detects Gmail from all its IMAP host spellings', () => {
    expect(detectProvider('imap.gmail.com')).toBe('gmail');
    expect(detectProvider('imap.googlemail.com')).toBe('gmail');
    expect(detectProvider('imap.google.com')).toBe('gmail');
  });

  it('detects Outlook / Microsoft 365 hosts', () => {
    expect(detectProvider('outlook.office365.com')).toBe('outlook');
    expect(detectProvider('imap-mail.outlook.com')).toBe('outlook');
    expect(detectProvider('imap.hotmail.com')).toBe('outlook');
    expect(detectProvider('imap.live.com')).toBe('outlook');
  });

  it('detects Yahoo hosts', () => {
    expect(detectProvider('imap.mail.yahoo.com')).toBe('yahoo');
    expect(detectProvider('imap.ymail.com')).toBe('yahoo');
  });

  it('detects iCloud hosts', () => {
    expect(detectProvider('imap.mail.me.com')).toBe('icloud');
    expect(detectProvider('imap.icloud.com')).toBe('icloud');
    expect(detectProvider('imap.mac.com')).toBe('icloud');
  });

  // Hosts arrive from user input and from OAuth presets with inconsistent case.
  it('is case-insensitive', () => {
    expect(detectProvider('IMAP.GMAIL.COM')).toBe('gmail');
    expect(detectProvider('Outlook.Office365.COM')).toBe('outlook');
  });

  // Self-hosted / hosting-provider mailboxes (the majority of this app's users)
  // MUST fall through to generic — that is what makes us APPEND the Sent copy.
  it('falls back to generic for self-hosted and unknown hosts', () => {
    expect(detectProvider('imap.sarv.com')).toBe('generic');
    expect(detectProvider('mail.mycompany.co.in')).toBe('generic');
    expect(detectProvider('')).toBe('generic');
  });
});

describe('providerAutoSavesSentCopy', () => {
  // Gmail auto-files SMTP submissions into [Gmail]/Sent Mail, so appending our
  // own copy creates a visible duplicate of every sent message.
  it('is true ONLY for Gmail', () => {
    expect(providerAutoSavesSentCopy('smtp.gmail.com')).toBe(true);
    expect(providerAutoSavesSentCopy('smtp.googlemail.com')).toBe(true);
  });

  // Documented policy: unknown => false => we DO append, because a missing Sent
  // copy is worse than a rare duplicate.
  it('is false for every other provider, including unknown hosts', () => {
    expect(providerAutoSavesSentCopy('outlook.office365.com')).toBe(false);
    expect(providerAutoSavesSentCopy('smtp.mail.yahoo.com')).toBe(false);
    expect(providerAutoSavesSentCopy('smtp.mail.me.com')).toBe(false);
    expect(providerAutoSavesSentCopy('smtp.sarv.com')).toBe(false);
    expect(providerAutoSavesSentCopy('')).toBe(false);
  });
});

describe('getProviderConfig', () => {
  // Gmail is the only provider with the three dedicated pseudo-folders; the
  // capability flags are what stop us hiding folders that don't exist elsewhere.
  it('gives Gmail its label/category capabilities and [Gmail]/* paths', () => {
    const config = getProviderConfig('gmail');
    expect(config.provider).toBe('gmail');
    expect(config.capabilities).toMatchObject({
      hasImportantFolder: true,
      hasStarredFolder: true,
      hasAllMailFolder: true,
      supportsLabels: true,
      supportsCategories: true,
      hasFocusedInbox: false,
    });
    expect(config.folderPaths.allMail).toBe('[Gmail]/All Mail');
    expect(config.folderPaths.trash).toBe('[Gmail]/Trash');
    expect(config.folderPaths.sent).toBe('[Gmail]/Sent Mail');
  });

  it('gives Outlook its renamed special folders and no label support', () => {
    const config = getProviderConfig('outlook');
    expect(config.capabilities.supportsLabels).toBe(false);
    expect(config.capabilities.hasFocusedInbox).toBe(true);
    expect(config.folderPaths).toMatchObject({
      spam: 'Junk',
      trash: 'Deleted Items',
      sent: 'Sent Items',
      drafts: 'Drafts',
    });
  });

  it('gives Yahoo and iCloud their provider-specific folder names', () => {
    expect(getProviderConfig('yahoo').folderPaths).toMatchObject({ spam: 'Bulk Mail', drafts: 'Draft' });
    expect(getProviderConfig('icloud').folderPaths).toMatchObject({
      spam: 'Junk',
      trash: 'Deleted Messages',
      sent: 'Sent Messages',
    });
  });

  it('gives generic (and any unrecognised provider) plain RFC folder names', () => {
    const generic = getProviderConfig('generic');
    expect(generic.folderPaths).toMatchObject({ spam: 'Spam', trash: 'Trash', sent: 'Sent', drafts: 'Drafts' });
    // A provider id from a newer config must not crash the config lookup.
    const unknown = getProviderConfig('protonmail' as EmailProvider);
    expect(unknown).toEqual(generic);
  });

  // Every provider we support treats \Flagged as "starred" — the UI star toggle
  // relies on this being universally true.
  it('reports flaggedAsStarred for every provider', () => {
    for (const provider of ['gmail', 'outlook', 'yahoo', 'icloud', 'generic'] as EmailProvider[]) {
      expect(getProviderConfig(provider).capabilities.flaggedAsStarred).toBe(true);
    }
  });
});

describe('isProvider*Folder', () => {
  it('recognises Gmail Important / Starred / All Mail, case-insensitively', () => {
    expect(isProviderImportantFolder('[Gmail]/Important', 'gmail')).toBe(true);
    expect(isProviderImportantFolder('[gmail]/important', 'gmail')).toBe(true);
    expect(isProviderStarredFolder('[Gmail]/Starred', 'gmail')).toBe(true);
    expect(isProviderAllMailFolder('[Gmail]/All Mail', 'gmail')).toBe(true);
  });

  // Must be an EXACT path match — a user folder called "Important Stuff" is not
  // Gmail's Important pseudo-folder and must not be hidden/mirrored as one.
  it('requires an exact path, not a prefix', () => {
    expect(isProviderImportantFolder('[Gmail]/Important/Sub', 'gmail')).toBe(false);
    expect(isProviderStarredFolder('Starred', 'gmail')).toBe(false);
    expect(isProviderAllMailFolder('All Mail', 'gmail')).toBe(false);
  });

  // Providers without the capability must answer false for ANY path, otherwise
  // we'd hide a real user folder on Outlook/generic.
  it('is false for providers that have no such folder', () => {
    for (const provider of ['outlook', 'yahoo', 'icloud', 'generic'] as EmailProvider[]) {
      expect(isProviderImportantFolder('[Gmail]/Important', provider)).toBe(false);
      expect(isProviderStarredFolder('[Gmail]/Starred', provider)).toBe(false);
      expect(isProviderAllMailFolder('[Gmail]/All Mail', provider)).toBe(false);
    }
  });
});

describe('getHiddenProviderFolders', () => {
  // These three are surfaced as virtual folders instead; showing both would give
  // the user duplicate sidebar entries and double-counted unread badges.
  it('hides exactly Gmail Important / Starred / All Mail', () => {
    expect(getHiddenProviderFolders('gmail')).toEqual([
      '[Gmail]/Important',
      '[Gmail]/Starred',
      '[Gmail]/All Mail',
    ]);
  });

  it('hides nothing on providers with no pseudo-folders', () => {
    for (const provider of ['outlook', 'yahoo', 'icloud', 'generic'] as EmailProvider[]) {
      expect(getHiddenProviderFolders(provider)).toEqual([]);
    }
  });
});

describe('normalizeFolderType', () => {
  // One sidebar across five providers: each provider's own spelling of a special
  // folder has to collapse onto the same unified type.
  it('normalizes every provider spelling of the standard folders', () => {
    expect(normalizeFolderType('INBOX')).toBe('inbox');
    expect(normalizeFolderType('Sent')).toBe('sent');
    expect(normalizeFolderType('Sent Items')).toBe('sent');
    expect(normalizeFolderType('Sent Messages')).toBe('sent');
    expect(normalizeFolderType('[Gmail]/Sent Mail')).toBe('sent');
    expect(normalizeFolderType('Draft')).toBe('drafts');
    expect(normalizeFolderType('[Gmail]/Drafts')).toBe('drafts');
    expect(normalizeFolderType('Deleted Items')).toBe('trash');
    expect(normalizeFolderType('Deleted Messages')).toBe('trash');
    expect(normalizeFolderType('Bin')).toBe('trash');
    expect(normalizeFolderType('[Gmail]/Trash')).toBe('trash');
    expect(normalizeFolderType('Junk')).toBe('spam');
    expect(normalizeFolderType('Junk Email')).toBe('spam');
    expect(normalizeFolderType('Bulk Mail')).toBe('spam');
    expect(normalizeFolderType('[Gmail]/Spam')).toBe('spam');
    expect(normalizeFolderType('Archive')).toBe('archive');
    expect(normalizeFolderType('[Gmail]/Important')).toBe('important');
    expect(normalizeFolderType('Flagged')).toBe('starred');
    expect(normalizeFolderType('[Gmail]/Starred')).toBe('starred');
  });

  it('is case-insensitive', () => {
    expect(normalizeFolderType('inbox')).toBe('inbox');
    expect(normalizeFolderType('DELETED ITEMS')).toBe('trash');
  });

  // A nested path is matched on its LAST segment, so "Personal/Archive" is still
  // an archive folder for sync purposes.
  it('matches on the last path segment for nested folders', () => {
    expect(normalizeFolderType('Personal/Archive')).toBe('archive');
    expect(normalizeFolderType('INBOX/Drafts')).toBe('drafts');
  });

  // Anything unrecognised must stay 'other' so user folders keep their identity
  // instead of being sucked into a special-folder behaviour.
  it('returns other for ordinary user folders', () => {
    expect(normalizeFolderType('Projects/Alpha')).toBe('other');
    expect(normalizeFolderType('Receipts')).toBe('other');
    expect(normalizeFolderType('')).toBe('other');
  });

  // Gmail's All Mail is classified as `archive` (the archive pattern list also
  // contains 'all mail' and is checked first). Both routes end at the same
  // virtual folder, so this pins the behaviour callers actually depend on.
  // All Mail is its OWN type, not Archive. It used to fall into `archive`
  // (the archive pattern list contained 'all mail' and was checked first), which
  // made the `all_mail` type dead and displayed Gmail's All Mail as "Archive".
  // Both still route to the same virtual folder — only the label differs.
  it('classifies All Mail as all_mail, distinct from archive', () => {
    expect(normalizeFolderType('All Mail')).toBe('all_mail');
    expect(normalizeFolderType('[Gmail]/All Mail')).toBe('all_mail');
    expect(normalizeFolderType('Archive')).toBe('archive');
  });
});

describe('mapToVirtualFolder', () => {
  it('routes Important, Starred and All Mail/Archive to their virtual folders', () => {
    expect(mapToVirtualFolder('[Gmail]/Important')).toBe('virtual-important');
    expect(mapToVirtualFolder('[Gmail]/Starred')).toBe('virtual-starred');
    expect(mapToVirtualFolder('Flagged')).toBe('virtual-starred');
    expect(mapToVirtualFolder('[Gmail]/All Mail')).toBe('virtual-all');
    expect(mapToVirtualFolder('Archive')).toBe('virtual-all');
  });

  // Real folders must stay real folders — returning a virtual id for INBOX would
  // make the primary mailbox unselectable.
  it('returns null for real folders', () => {
    expect(mapToVirtualFolder('INBOX')).toBeNull();
    expect(mapToVirtualFolder('Sent')).toBeNull();
    expect(mapToVirtualFolder('Trash')).toBeNull();
    expect(mapToVirtualFolder('Projects/Alpha')).toBeNull();
  });
});

describe('getNormalizedFolderName', () => {
  it('gives special folders their unified display name', () => {
    expect(getNormalizedFolderName('INBOX')).toBe('Inbox');
    expect(getNormalizedFolderName('[Gmail]/Sent Mail')).toBe('Sent');
    expect(getNormalizedFolderName('Deleted Items')).toBe('Trash');
    expect(getNormalizedFolderName('Bulk Mail')).toBe('Spam');
    expect(getNormalizedFolderName('[Gmail]/Important')).toBe('Important');
    expect(getNormalizedFolderName('[Gmail]/Starred')).toBe('Starred');
  });

  // User folders keep their own leaf name — renaming them would be very visible.
  it('uses the leaf segment for ordinary user folders', () => {
    expect(getNormalizedFolderName('Projects/Alpha')).toBe('Alpha');
    expect(getNormalizedFolderName('Receipts')).toBe('Receipts');
  });

  it('falls back to the raw path when there is no leaf segment', () => {
    expect(getNormalizedFolderName('')).toBe('');
    expect(getNormalizedFolderName('Projects/')).toBe('Projects/');
  });
});

describe('isImportantSourceFolder / isStarredSourceFolder', () => {
  // Starred and Important are DISTINCT signals — folding one into the other makes
  // every starred mail show up in the AI "Important" section (a known regression).
  it('keeps important and starred strictly separate', () => {
    expect(isImportantSourceFolder('[Gmail]/Important')).toBe(true);
    expect(isImportantSourceFolder('[Gmail]/Starred')).toBe(false);

    expect(isStarredSourceFolder('[Gmail]/Starred')).toBe(true);
    expect(isStarredSourceFolder('Flagged')).toBe(true);
    expect(isStarredSourceFolder('[Gmail]/Important')).toBe(false);
  });

  it('is false for ordinary folders', () => {
    for (const folder of ['INBOX', 'Sent', 'Projects/Alpha', 'Archive']) {
      expect(isImportantSourceFolder(folder)).toBe(false);
      expect(isStarredSourceFolder(folder)).toBe(false);
    }
  });
});
