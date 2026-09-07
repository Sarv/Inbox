import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { SyncStateManager, getSyncState, resetSyncState } from '../../../src/imap/sync-state';

// The sync state machine is what gates "can I sync now?". Its two historic bugs
// were (a) wedging at "syncing" forever so every later sync silently returned
// "already in progress" ("sync shows done but nothing synced"), and (b) throwing
// out of setError() because Node's EventEmitter throws on an unlistened 'error'.
// Everything below pins a transition rule, a guard, or one of those two bugs.

const STALE_MS = 5 * 60 * 1000;

function makeManager() {
  const manager = new SyncStateManager();
  const transitions: Array<[string, string]> = [];
  manager.on('state-change', (state, prev) => transitions.push([prev, state]));
  return { manager, transitions };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-08-19T10:00:00Z'));
  // The manager logs through the shared logger (console under the hood); these
  // tests deliberately drive warn/error paths, so keep the reporter readable.
  for (const level of ['debug', 'log', 'warn', 'error'] as const) {
    vi.spyOn(console, level).mockImplementation(() => {});
  }
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetSyncState();
});

describe('SyncStateManager — transitions', () => {
  it('starts idle and reports every transition exactly once, with the previous state', () => {
    const { manager, transitions } = makeManager();
    expect(manager.state).toBe('idle');

    manager.setConnecting();
    manager.setConnected();
    manager.startSync(['INBOX']);
    manager.completeSync(true);

    expect(transitions).toEqual([
      ['idle', 'connecting'],
      ['connecting', 'idle'],
      ['idle', 'syncing'],
      ['syncing', 'idle'],
    ]);
    expect(manager.state).toBe('idle');
  });

  it('swallows a no-op transition (same state) instead of emitting a duplicate', () => {
    const { manager, transitions } = makeManager();

    manager.setDisconnected();
    manager.setDisconnected();

    expect(transitions).toEqual([['idle', 'disconnected']]);
  });

  it('routes completeSync(false) to the error state and still reports sync-complete', () => {
    const { manager } = makeManager();
    const done = vi.fn();
    manager.on('sync-complete', done);

    manager.startSync(['INBOX']);
    manager.completeSync(false);

    expect(manager.state).toBe('error');
    expect(done).toHaveBeenCalledWith(false);
  });

  it('REFUSES to restart a sync that is already running (no state churn, folder set kept)', () => {
    const { manager, transitions } = makeManager();
    manager.startSync(['INBOX', 'Sent']);
    manager.startFolder('INBOX', 10);
    manager.updateFolderProgress('INBOX', 4);

    manager.startSync(['Drafts']); // must be ignored

    expect(transitions).toEqual([['idle', 'syncing']]);
    const status = manager.getStatus();
    expect(status.foldersTotal).toBe(2);       // NOT reset to the new 1-folder set
    expect(status.messagesProcessed).toBe(4);  // progress preserved
  });

  it('only enters realtime from a non-syncing state, and leaves it only from realtime', () => {
    const { manager } = makeManager();

    manager.startSync(['INBOX']);
    manager.setRealTimeActive();               // illegal mid-sync — must be ignored
    expect(manager.state).toBe('syncing');

    manager.completeSync(true);
    manager.setRealTimeActive();
    expect(manager.state).toBe('realtime');

    manager.stopRealTime();
    expect(manager.state).toBe('idle');
    manager.setDisconnected();
    manager.stopRealTime();                    // not in realtime — must not force idle
    expect(manager.state).toBe('disconnected');
  });

  it('treats only disconnected/connecting as "not connected"', () => {
    const { manager } = makeManager();
    expect(manager.isConnected()).toBe(true);   // idle
    manager.setConnecting();
    expect(manager.isConnected()).toBe(false);
    manager.setDisconnected();
    expect(manager.isConnected()).toBe(false);
    manager.setConnected();
    manager.setError(new Error('x'));
    expect(manager.isConnected()).toBe(true);   // error != socket down
  });
});

describe('SyncStateManager — setError', () => {
  // Regression: setError is called from catch blocks. Node's EventEmitter throws
  // synchronously on an 'error' emit with no listener, which turned a handled
  // failure into an unhandled crash.
  it('does NOT throw when nothing is listening for "error"', () => {
    const { manager } = makeManager();
    expect(() => manager.setError(new Error('boom'))).not.toThrow();
    expect(manager.state).toBe('error');
    expect(manager.getStatus().lastError?.message).toBe('boom');
  });

  it('emits to a registered error listener', () => {
    const { manager } = makeManager();
    const onError = vi.fn();
    manager.on('error', onError);
    const error = new Error('boom');

    manager.setError(error);

    expect(onError).toHaveBeenCalledWith(error);
  });
});

describe('SyncStateManager — stale-sync auto-recovery', () => {
  // The wedge bug: a sync aborted outside syncAll's try/catch left the state at
  // "syncing" forever, so every later sync returned "already in progress".
  it('auto-resets a global sync that has been running past the stale timeout', () => {
    const { manager, transitions } = makeManager();
    manager.startSync(['INBOX']);
    expect(manager.isSyncing()).toBe(true);

    vi.advanceTimersByTime(STALE_MS + 1);

    expect(manager.isSyncing()).toBe(false);      // unblocks the next sync
    expect(manager.state).toBe('idle');
    expect(transitions.at(-1)).toEqual(['syncing', 'idle']);
    expect(manager.getStatus().lastError?.message).toContain('auto-recovered');
    expect(manager.getStatus().startTime).toBeNull();
  });

  it('leaves a young sync alone and reports not-syncing when idle', () => {
    const { manager } = makeManager();
    expect(manager.isSyncing()).toBe(false);      // idle

    manager.startSync(['INBOX']);
    vi.advanceTimersByTime(STALE_MS - 1000);

    expect(manager.isSyncing()).toBe(true);
    expect(manager.state).toBe('syncing');
  });

  it('marks a stale FOLDER sync as errored and reports it as not syncing', () => {
    const { manager } = makeManager();
    const folderComplete = vi.fn();
    manager.on('folder-complete', folderComplete);
    manager.startSync(['INBOX']);
    manager.startFolder('INBOX', 5);
    expect(manager.isFolderSyncing('INBOX')).toBe(true);

    vi.advanceTimersByTime(STALE_MS + 1);

    expect(manager.isFolderSyncing('INBOX')).toBe(false);
    expect(folderComplete).toHaveBeenCalledWith('INBOX', false);
    expect(manager.getStatus().foldersCompleted).toBe(0);
  });

  it('reports not-syncing for an unknown or pending folder', () => {
    const { manager } = makeManager();
    expect(manager.isFolderSyncing('Nope')).toBe(false); // never seen
    manager.startSync(['INBOX']);
    expect(manager.isFolderSyncing('INBOX')).toBe(false); // pending, not syncing
  });
});

describe('SyncStateManager — progress accounting', () => {
  it('aggregates per-folder progress into the global counters and percentage', () => {
    const { manager } = makeManager();
    const progress = vi.fn();
    manager.on('folder-progress', progress);
    manager.startSync(['INBOX', 'Sent']);

    manager.startFolder('INBOX', 10);
    manager.startFolder('Sent', 10);
    manager.updateFolderProgress('INBOX', 5);
    manager.updateFolderProgress('INBOX', 8);       // delta-based, not additive
    manager.updateFolderProgress('Sent', 2, 20);    // total revised upward

    const status = manager.getStatus();
    expect(status.messagesProcessed).toBe(10);      // 8 + 2, not 5 + 8 + 2
    expect(status.messagesTotal).toBe(30);          // 10 + 20 after the revision
    expect(status.percentComplete).toBe(33);
    expect(progress).toHaveBeenLastCalledWith('Sent', 2, 20);
  });

  it('reports 0% (not NaN) before any totals are known', () => {
    const { manager } = makeManager();
    manager.startSync(['INBOX']);
    expect(manager.getStatus().percentComplete).toBe(0);
  });

  it('ignores progress/completion for folders that are not part of this sync', () => {
    const { manager } = makeManager();
    const progress = vi.fn();
    const complete = vi.fn();
    manager.on('folder-progress', progress);
    manager.on('folder-complete', complete);
    manager.startSync(['INBOX']);

    expect(() => {
      manager.startFolder('Ghost', 5);
      manager.updateFolderProgress('Ghost', 3);
      manager.completeFolder('Ghost');
      manager.setFolderError('Ghost', new Error('x'));
    }).not.toThrow();

    expect(manager.getStatus().messagesTotal).toBe(0); // untracked folder ignored
    expect(progress).toHaveBeenCalledWith('Ghost', 3, 0);
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it('clears currentFolder on completion only for the folder that owns it', () => {
    const { manager } = makeManager();
    manager.startSync(['INBOX', 'Sent']);
    manager.startFolder('INBOX', 1);
    manager.startFolder('Sent', 1);

    manager.completeFolder('INBOX');                 // not the current folder
    expect(manager.getStatus().currentFolder).toBe('Sent');

    manager.setFolderError('Sent', new Error('nope'));
    expect(manager.getStatus().currentFolder).toBeNull();
    expect(manager.getStatus().foldersCompleted).toBe(1); // only INBOX counts
  });
});

describe('SyncStateManager — email events and reset', () => {
  it('forwards the per-email events with their arguments', () => {
    const { manager } = makeManager();
    const onNew = vi.fn();
    const onUpdated = vi.fn();
    const onDeleted = vi.fn();
    manager.on('new-email', onNew);
    manager.on('email-updated', onUpdated);
    manager.on('email-deleted', onDeleted);

    manager.emitNewEmail('e1', 'INBOX');
    manager.emitEmailUpdated('e2', 'INBOX', ['flags']);
    manager.emitEmailDeleted('e3', 'Trash');

    expect(onNew).toHaveBeenCalledWith('e1', 'INBOX');
    expect(onUpdated).toHaveBeenCalledWith('e2', 'INBOX', ['flags']);
    expect(onDeleted).toHaveBeenCalledWith('e3', 'Trash');
  });

  it('reset() wipes state back to idle SILENTLY (no state-change event)', () => {
    const { manager, transitions } = makeManager();
    manager.startSync(['INBOX']);
    manager.startFolder('INBOX', 4);
    manager.updateFolderProgress('INBOX', 4);
    manager.setError(new Error('x'));
    transitions.length = 0;

    manager.reset();

    expect(manager.state).toBe('idle');
    expect(transitions).toEqual([]); // deliberate: reset bypasses transition()
    expect(manager.getStatus()).toMatchObject({
      currentFolder: null,
      foldersTotal: 0,
      messagesProcessed: 0,
      messagesTotal: 0,
      startTime: null,
      lastError: null,
    });
  });
});

describe('getSyncState / resetSyncState', () => {
  it('returns one shared instance and drops it (with its listeners) on reset', () => {
    const first = getSyncState();
    expect(getSyncState()).toBe(first);

    const listener = vi.fn();
    first.on('state-change', listener);
    resetSyncState();

    const second = getSyncState();
    expect(second).not.toBe(first);
    second.setDisconnected();
    expect(listener).not.toHaveBeenCalled(); // listeners did not survive the reset
  });

  it('resetSyncState is a no-op when no singleton was ever created', () => {
    resetSyncState();
    expect(() => resetSyncState()).not.toThrow();
  });
});
