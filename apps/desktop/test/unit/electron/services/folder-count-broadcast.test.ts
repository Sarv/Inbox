import { describe, expect, it } from 'vitest';

import {
  FOLDERS_UPDATED_CHANNEL,
  wireFolderCountBroadcast,
  type FolderCountSource,
} from '../../../../electron/services/folder-count-broadcast';

// The read-model drain repairs a drifted badge in the database on its own. This
// is the only thing that tells the WINDOW about it — without it the sidebar keeps
// rendering the stale number until the user happens to do something that reloads
// folders, which is exactly the "it still says 7" symptom.

/** A storage stand-in that hands back the listener it was given. */
function fakeStorage(): FolderCountSource & { fire: (paths: string[]) => void } {
  let listener: ((paths: string[]) => void) | null = null;
  return {
    setFolderCountsListener: (l) => { listener = l; },
    fire: (paths) => listener?.(paths),
  };
}

describe('wireFolderCountBroadcast', () => {
  it('pushes a badge refresh naming the account, and no folder path', () => {
    // No folderPath on purpose: the list already reads the read model, so only
    // the badge was stale. Naming a folder would re-run the open list query too.
    const sent: Array<{ channel: string; payload: unknown }> = [];
    const storage = fakeStorage();
    wireFolderCountBroadcast(storage, { send: (channel, payload) => sent.push({ channel, payload }), accountId: () => 'acct-1' });

    storage.fire(['INBOX']);

    expect(sent).toEqual([{ channel: FOLDERS_UPDATED_CHANNEL, payload: { accountId: 'acct-1' } }]);
  });

  it('resolves the account id at SEND time, not at wire time', () => {
    // Storage is constructed before its runtime is registered; an eagerly
    // captured id would be null for the life of the process.
    const sent: unknown[] = [];
    const storage = fakeStorage();
    let accountId: string | null = null;
    wireFolderCountBroadcast(storage, { send: (_c, payload) => sent.push(payload), accountId: () => accountId });

    accountId = 'acct-late';
    storage.fire(['INBOX']);

    expect(sent).toEqual([{ accountId: 'acct-late' }]);
  });

  it('falls back to an unscoped payload before an account is known', () => {
    // The legacy pre-account database has no id; the renderer treats a payload
    // with no accountId as "refresh the active account's badges".
    const sent: unknown[] = [];
    const storage = fakeStorage();
    wireFolderCountBroadcast(storage, { send: (_c, payload) => sent.push(payload), accountId: () => null });

    storage.fire(['INBOX']);

    expect(sent).toEqual([{}]);
  });

  it('stays silent when nothing changed', () => {
    // A drain that moved no badge must not wake the sidebar.
    const sent: unknown[] = [];
    const storage = fakeStorage();
    wireFolderCountBroadcast(storage, { send: (_c, p) => sent.push(p), accountId: () => 'a' });

    storage.fire([]);

    expect(sent).toEqual([]);
  });

  it('swallows a send failure — a dead window must not break the drain', () => {
    // The listener runs inside the maintainer's hook; throwing here would be
    // logged as a read-model failure for something purely cosmetic.
    const storage = fakeStorage();
    wireFolderCountBroadcast(storage, {
      send: () => { throw new Error('no window'); },
      accountId: () => 'a',
    });

    expect(() => storage.fire(['INBOX'])).not.toThrow();
  });
});
