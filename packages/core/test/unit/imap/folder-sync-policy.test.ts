import { describe, expect, it } from 'vitest';

import { isFolderSyncEnabled, folderHeadersOnly } from '../../../src/imap/folder-sync-policy';

// Per-folder policy gates whether/how a folder syncs. Both helpers must default
// SAFE — an unset/legacy folder syncs normally — or a missing value would
// silently stop mail from arriving (the exact class of bug we guard against).

describe('isFolderSyncEnabled', () => {
  it('defaults to enabled for unset / legacy folders', () => {
    expect(isFolderSyncEnabled(undefined)).toBe(true);
    expect(isFolderSyncEnabled(null)).toBe(true);
    expect(isFolderSyncEnabled({})).toBe(true);            // column absent
    expect(isFolderSyncEnabled({ syncEnabled: undefined })).toBe(true);
  });

  it('is disabled ONLY when explicitly false', () => {
    expect(isFolderSyncEnabled({ syncEnabled: false })).toBe(false);
    expect(isFolderSyncEnabled({ syncEnabled: true })).toBe(true);
  });
});

describe('folderHeadersOnly', () => {
  it('per-folder syncMode overrides the global default', () => {
    expect(folderHeadersOnly({ syncMode: 'headers' }, false)).toBe(true);  // force headers even if global=full
    expect(folderHeadersOnly({ syncMode: 'full' }, true)).toBe(false);     // force full even if global=headers
  });

  it('defers to the global when syncMode is unset', () => {
    expect(folderHeadersOnly({ syncMode: null }, true)).toBe(true);
    expect(folderHeadersOnly({ syncMode: null }, false)).toBe(false);
    expect(folderHeadersOnly(undefined, true)).toBe(true);
    expect(folderHeadersOnly({}, false)).toBe(false);
  });
});
