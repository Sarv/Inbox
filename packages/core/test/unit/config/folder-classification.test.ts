import { describe, expect, it } from 'vitest';

import { classifyFolder, findFolderByType, isTrashFolder, isSpamFolder } from '../../../src/config/folder-mapping';

// Regression for the data-loss/mis-routing class where destructive paths matched
// folder TYPE by substring (`path.toLowerCase().includes('trash'|'spam'|'archive')`).
// A user folder whose name merely CONTAINS "trash"/"spam"/"archive" would then be
// treated as the real Trash/Spam/Archive — a bulk delete there expunged mail
// permanently, and moves mis-routed. classifyFolder/findFolderByType must match
// EXACTLY (special-use → known path → exact last-segment name), never a substring.

describe('folder classification is exact, not substring (no destructive mis-match)', () => {
  it('classifies the real Trash/Spam/Archive folders', () => {
    expect(classifyFolder({ path: 'Trash' })).toBe('trash');
    expect(classifyFolder({ path: '[Gmail]/Trash' })).toBe('trash');
    expect(classifyFolder({ path: 'Deleted Items' })).toBe('trash');
    expect(classifyFolder({ path: 'Spam' })).toBe('spam');
    expect(classifyFolder({ path: 'Junk Email' })).toBe('spam');
    expect(classifyFolder({ path: '[Gmail]/All Mail' })).toBe('archive');
  });

  it('does NOT misclassify custom folders that merely contain the substring', () => {
    // These are the folders the old `.includes(...)` logic would have wrongly
    // treated as Trash/Spam/Archive — and permanently expunged / mis-routed.
    expect(classifyFolder({ path: 'Trash Pandas' })).not.toBe('trash');
    expect(classifyFolder({ path: 'Notes/trashy-ideas' })).not.toBe('trash');
    expect(classifyFolder({ path: 'metrash' })).not.toBe('trash');
    expect(classifyFolder({ path: 'Spam Reports' })).not.toBe('spam');
    expect(classifyFolder({ path: 'My Archive 2023' })).not.toBe('archive');
    expect(isTrashFolder({ path: 'Trash Pandas' })).toBe(false);
    expect(isSpamFolder({ path: 'Spam Reports' })).toBe(false);
  });

  it('special-use wins and is authoritative regardless of the display name', () => {
    expect(classifyFolder({ path: 'Papelera', specialUse: '\\Trash' })).toBe('trash');
    expect(isTrashFolder({ path: 'Papelera', specialUse: '\\Trash' })).toBe(true);
  });

  it('findFolderByType picks the real folder, never a substring-collision one', () => {
    const folders = [
      { path: 'Trash Pandas' },        // decoy — contains "trash"
      { path: 'Archive of Spam' },     // decoy — contains "spam" AND "archive"
      { path: 'Trash' },               // the real Trash
      { path: 'Spam' },                // the real Spam
    ];
    expect(findFolderByType(folders, 'trash')?.path).toBe('Trash');
    expect(findFolderByType(folders, 'spam')?.path).toBe('Spam');
  });

  it('findFolderByType returns null when no real folder of that type exists', () => {
    // Only decoys present → must NOT fall back to a substring match.
    expect(findFolderByType([{ path: 'Trash Pandas' }, { path: 'Spam Reports' }], 'trash')).toBeNull();
  });
});
