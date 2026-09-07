import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// CategoryBadges owns a renderer-only cache the slice imports; stub it so the
// module graph under test stays free of IPC/DOM side effects (same as sync-slice.test).
vi.mock('../../../../../src/components/email-list/CategoryBadges', () => ({
  clearCategoryBadgeCache: vi.fn(),
}));

// The sync-health signal is what finally tells the user "mail isn't flowing"
// instead of leaving them staring at a green dot. These pin the exact rules:
// - ONE failure is a blip and must stay silent (no premature banner).
// - TWO in a row raises trouble.
// - ANY success clears it (so a recovered server drops the warning immediately).
// - clearSyncTrouble resets optimistically (used on reconnect / manual retry).

const loadSlice = async () => {
  vi.resetModules();
  (globalThis as any).window = { electronAPI: {} };
  const mod = await import('../../../../../src/store/slices/sync-slice');
  // Stateful set/get so the actions' reads (streak) and writes actually compose.
  let state: any = {};
  const set = (patch: any) => {
    state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) };
  };
  const get = () => state;
  const slice = mod.createSyncSlice(set, get, {} as any);
  state = { ...slice }; // seed initial state (syncTrouble:false, syncFailStreak:0, …) + actions
  return { get, actions: slice };
};

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); delete (globalThis as any).window; });

describe('sync-health (syncTrouble)', () => {
  it('starts clean — no trouble, zero streak, no success timestamp', async () => {
    const { get } = await loadSlice();
    expect(get().syncTrouble).toBe(false);
    expect(get().syncFailStreak).toBe(0);
    expect(get().lastSyncOkAt).toBeNull();
  });

  // A single failure must NOT alarm the user — servers blip.
  it('one failure does not raise trouble (blip stays silent)', async () => {
    const { get, actions } = await loadSlice();
    actions.noteSyncFailure('Sync timed out');
    expect(get().syncFailStreak).toBe(1);
    expect(get().syncTrouble).toBe(false);
  });

  // Two consecutive failures = real trouble → tell the user.
  it('two consecutive failures raise trouble', async () => {
    const { get, actions } = await loadSlice();
    actions.noteSyncFailure('Sync timed out');
    actions.noteSyncFailure('NO SELECT completed');
    expect(get().syncFailStreak).toBe(2);
    expect(get().syncTrouble).toBe(true);
  });

  // A success mid-streak must reset the counter so trouble can't accrete across
  // unrelated, well-separated blips.
  it('a success between failures resets the streak', async () => {
    const { get, actions } = await loadSlice();
    actions.noteSyncFailure('blip');
    actions.noteSyncOk();
    actions.noteSyncFailure('blip again');
    expect(get().syncFailStreak).toBe(1);
    expect(get().syncTrouble).toBe(false);
  });

  // The recovery path: once mail flows again, the warning must clear immediately.
  it('a success clears trouble and stamps lastSyncOkAt', async () => {
    vi.setSystemTime(new Date('2026-08-24T11:00:00Z'));
    const { get, actions } = await loadSlice();
    actions.noteSyncFailure('x');
    actions.noteSyncFailure('y');
    expect(get().syncTrouble).toBe(true);

    actions.noteSyncOk();
    expect(get().syncTrouble).toBe(false);
    expect(get().syncFailStreak).toBe(0);
    expect(get().lastSyncOkAt).toBe(Date.parse('2026-08-24T11:00:00Z'));
  });

  // Reconnect / manual retry clears the surface without needing a full success.
  it('clearSyncTrouble resets trouble and streak', async () => {
    const { get, actions } = await loadSlice();
    actions.noteSyncFailure('a');
    actions.noteSyncFailure('b');
    expect(get().syncTrouble).toBe(true);

    actions.clearSyncTrouble();
    expect(get().syncTrouble).toBe(false);
    expect(get().syncFailStreak).toBe(0);
  });
});
