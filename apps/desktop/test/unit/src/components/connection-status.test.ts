import { describe, expect, it } from 'vitest';

import {
  getConnectionBarStatus,
  shouldShowSyncTroubleBanner,
} from '../../../../src/components/connection-status';

// These guard the whole point of the sync-health surface: the user must never be
// shown a reassuring green "Live" while mail has actually stopped flowing. If the
// priority order or the amber "Sync issue" case regresses, that silent-wait bug
// returns.

describe('getConnectionBarStatus', () => {
  const noStatus = null;

  // Regression: a connected-but-failing socket used to fall through to green
  // "Live". It must now read amber "Sync issue" so the user knows.
  it('shows amber "Sync issue" when connected but syncTrouble is set', () => {
    const bar = getConnectionBarStatus('connected', false, true /*idle*/, noStatus, true /*trouble*/);
    expect(bar).toEqual({ dotClass: 'bg-amber-500', label: 'Sync issue', pulse: true });
  });

  // Healthy steady state stays green "Live" — trouble false, IDLE active.
  it('shows green "Live" when connected, idle-active and no trouble', () => {
    const bar = getConnectionBarStatus('connected', false, true, noStatus, false);
    expect(bar).toEqual({ dotClass: 'bg-green-500', label: 'Live', pulse: false });
  });

  it('shows green "Connected" when connected but not yet listening (no IDLE)', () => {
    const bar = getConnectionBarStatus('connected', false, false, noStatus, false);
    expect(bar.label).toBe('Connected');
    expect(bar.dotClass).toBe('bg-green-500');
  });

  // Priority: an ACTIVE sync outranks trouble (we're actively working, show progress).
  it('syncing outranks syncTrouble', () => {
    const bar = getConnectionBarStatus('connected', true /*syncing*/, false, { foldersCompleted: 2, foldersTotal: 5, percentComplete: 40 }, true);
    expect(bar.dotClass).toBe('bg-orange-500');
    expect(bar.label).toBe('2/5 folders (40%)');
  });

  // THE REGRESSION: a bar that reads "5/6 folders (22%)" unchanged for minutes
  // while a big mailbox streams in, so the user concludes the download stalled.
  // The stored-message count is the one number that always climbs.
  it('counts the mail stored so far while a sync runs', () => {
    const bar = getConnectionBarStatus('connected', true, false, {
      foldersCompleted: 5, foldersTotal: 6, percentComplete: 22, messagesProcessed: 4921,
    }, false);
    // Grouped by the reader's locale, so build the expectation the same way
    // rather than hardcoding en-US separators into a CI-portable test.
    expect(bar.label).toBe(`5/6 folders \u00b7 ${(4921).toLocaleString()} emails`);
  });

  // Breaks: the opening tick of a sync (nothing stored yet) rendering a bare
  // "0 emails", which reads worse than saying nothing about mail at all.
  it('omits the mail count until something has actually been stored', () => {
    const bar = getConnectionBarStatus('connected', true, false, {
      foldersCompleted: 0, foldersTotal: 6, percentComplete: 0, messagesProcessed: 0,
    }, false);
    expect(bar.label).toBe('0/6 folders');
  });

  // Breaks: an older main process (or a status shaped before messagesProcessed
  // existed) losing the progress read-out entirely instead of falling back.
  it('falls back to the percentage when the status carries no message count', () => {
    const bar = getConnectionBarStatus('connected', true, false, {
      foldersCompleted: 2, foldersTotal: 5, percentComplete: 40,
    }, false);
    expect(bar.label).toBe('2/5 folders (40%)');
  });

  // Priority: an explicit socket drop (reconnecting/disconnected) outranks the
  // softer "sync issue" — those have their own, more urgent surfaces.
  it('reconnecting outranks syncTrouble', () => {
    const bar = getConnectionBarStatus('reconnecting', false, false, noStatus, true);
    expect(bar.label).toBe('Reconnecting…');
  });

  it('disconnected outranks syncTrouble', () => {
    const bar = getConnectionBarStatus('disconnected', false, false, noStatus, true);
    expect(bar.label).toBe('Disconnected');
  });
});

describe('shouldShowSyncTroubleBanner', () => {
  const base = { syncTrouble: true, connected: true, needsReauth: false, dismissed: false };

  it('shows when connected + trouble + not re-auth + not dismissed', () => {
    expect(shouldShowSyncTroubleBanner(base)).toBe(true);
  });

  it('hidden when there is no trouble', () => {
    expect(shouldShowSyncTroubleBanner({ ...base, syncTrouble: false })).toBe(false);
  });

  // If the socket is fully down, the reconnect/disconnected surfaces own it.
  it('hidden when disconnected', () => {
    expect(shouldShowSyncTroubleBanner({ ...base, connected: false })).toBe(false);
  });

  // Re-auth is the harder, terminal problem — its banner takes over.
  it('hidden when re-auth is required (ReauthBanner takes priority)', () => {
    expect(shouldShowSyncTroubleBanner({ ...base, needsReauth: true })).toBe(false);
  });

  it('hidden once dismissed', () => {
    expect(shouldShowSyncTroubleBanner({ ...base, dismissed: true })).toBe(false);
  });
});
