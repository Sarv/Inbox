import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Proactive OAuth refresh scheduler. Timing maths + failure policy:
 *   - arm at the token's due-point, clamped to MIN_DELAY (5s) so an overdue
 *     token can never busy-loop, and capped at MAX_DELAY (6h) where it merely
 *     RE-EVALUATES instead of refreshing,
 *   - transient failures retry with linear backoff (n * 60s, capped at 10min),
 *   - a terminal failure (or 5 consecutive transient ones) stops the loop and
 *     asks the user to sign in again — exactly once,
 *   - stop() cancels every pending timer so nothing fires afterwards.
 */

const h = vi.hoisted(() => {
  interface FakeWin {
    minimized: boolean;
    restored: boolean;
    focusCalls: number;
    sent: Array<{ channel: string; payload: unknown }>;
    isMinimized: () => boolean;
    restore: () => void;
    focus: () => void;
    webContents: { send: (channel: string, payload: unknown) => void };
  }
  const makeWin = (): FakeWin => {
    const win: FakeWin = {
      minimized: false,
      restored: false,
      focusCalls: 0,
      sent: [],
      isMinimized: () => win.minimized,
      restore: () => { win.restored = true; },
      focus: () => { win.focusCalls += 1; },
      webContents: { send: (channel, payload) => win.sent.push({ channel, payload }) },
    };
    return win;
  };

  const state = {
    /** Signed-in accounts returned by the token store. */
    accounts: [] as Array<{ provider: string; email: string }>,
    listThrows: false,
    /** key -> account (null models "removed"). */
    stored: new Map<string, { provider: string; email: string } | null>(),
    /** key -> ms until the token is due for refresh. */
    due: new Map<string, number>(),
    /** key -> error to throw from getValidAccessToken (undefined = success). */
    failWith: new Map<string, unknown>(),
    refreshCalls: [] as string[],
    dueLookups: [] as string[],
    notifSupported: true,
    notifThrows: false,
    notifications: [] as Array<{ opts: { title: string; body: string }; handlers: Map<string, () => void> }>,
    win: null as FakeWin | null,
  };

  class FakeNotification {
    opts: { title: string; body: string };
    handlers = new Map<string, () => void>();
    constructor(opts: { title: string; body: string }) {
      if (state.notifThrows) throw new Error('notification backend down');
      this.opts = opts;
      state.notifications.push(this);
    }
    static isSupported(): boolean { return state.notifSupported; }
    on(event: string, cb: () => void): this { this.handlers.set(event, cb); return this; }
    show(): void {}
  }

  return { state, makeWin, FakeNotification };
});

vi.mock('electron', () => ({
  Notification: h.FakeNotification,
  app: { getPath: () => '/tmp/sarvinbox-test', getName: () => 'Sarv Inbox Test', isPackaged: false },
  powerMonitor: { on: () => {}, removeListener: () => {} },
}));

vi.mock('../../../../electron/shared', () => ({ getMainWindow: () => h.state.win }));

vi.mock('@sarvinbox/core', () => ({
  createLogger: () => ({
    info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, trace: () => {},
  }),
}));

const key = (provider: string, email: string): string => `${provider}:${email.toLowerCase()}`;

vi.mock('../../../../electron/services/oauth-token-store', () => ({
  listAccounts: async () => {
    if (h.state.listThrows) throw new Error('token store unreadable');
    return h.state.accounts;
  },
  getAccount: async (provider: string, email: string) => {
    const k = `${provider}:${email.toLowerCase()}`;
    return h.state.stored.has(k) ? h.state.stored.get(k) : { provider, email };
  },
}));

vi.mock('../../../../electron/services/oauth-service', () => ({
  getValidAccessToken: async (provider: string, email: string, force?: boolean) => {
    const k = `${provider}:${email.toLowerCase()}`;
    h.state.refreshCalls.push(`${k}${force ? ':force' : ''}`);
    const err = h.state.failWith.get(k);
    if (err) throw err;
    return 'fresh-token';
  },
  msUntilRefresh: (account: { provider: string; email: string }) => {
    const k = `${account.provider}:${account.email.toLowerCase()}`;
    h.state.dueLookups.push(k);
    return h.state.due.get(k) ?? 60_000;
  },
  isTerminalOAuthError: (err: unknown) => !!(err as { terminal?: boolean })?.terminal,
  isAccountGoneError: (err: unknown) => !!(err as { gone?: boolean })?.gone,
  isRefreshDeferredError: (err: unknown) => !!(err as { deferred?: boolean })?.deferred,
}));

import {
  rescheduleOAuthAccount,
  scheduleAccount,
  startOAuthRefreshScheduler,
  stopOAuthRefreshScheduler,
  unscheduleOAuthAccount,
} from '../../../../electron/services/oauth-refresh-scheduler';
import {
  clearAllReauthRequired,
  listReauthRequired,
} from '../../../../electron/services/reauth-registry';

const GMAIL = 'gmail' as never;
const EMAIL = 'me@gmail.com';
const K = key('gmail', EMAIL);

const transient = (message = 'network blip'): Error => new Error(message);
const terminal = (): Error => Object.assign(new Error('invalid_grant'), { terminal: true });
const gone = (): Error => Object.assign(new Error('ACCOUNT_NOT_FOUND'), { gone: true });
/** The refresh was never sent — the machine was asleep. Not a failure. */
const deferred = (): Error =>
  Object.assign(new Error('REFRESH_DEFERRED_SUSPENDED'), { deferred: true });

beforeEach(() => {
  vi.useFakeTimers();
  const s = h.state;
  s.accounts = [{ provider: 'gmail', email: EMAIL }];
  s.listThrows = false;
  s.stored.clear();
  s.due.clear();
  s.failWith.clear();
  s.refreshCalls.length = 0;
  s.dueLookups.length = 0;
  s.notifSupported = true;
  s.notifThrows = false;
  s.notifications.length = 0;
  s.win = h.makeWin();
  clearAllReauthRequired();
});

afterEach(() => {
  stopOAuthRefreshScheduler();
  vi.useRealTimers();
});

describe('startOAuthRefreshScheduler', () => {
  it('arms one timer per account and force-refreshes at the due-point', async () => {
    h.state.accounts = [
      { provider: 'gmail', email: EMAIL },
      { provider: 'microsoft', email: 'Work@Outlook.com' },
    ];
    h.state.due.set(K, 30 * 60_000);
    h.state.due.set(key('microsoft', 'work@outlook.com'), 45 * 60_000);

    await startOAuthRefreshScheduler();
    await vi.advanceTimersByTimeAsync(30 * 60_000 - 1);
    expect(h.state.refreshCalls).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    expect(h.state.refreshCalls).toEqual([`${K}:force`]);

    await vi.advanceTimersByTimeAsync(15 * 60_000);
    expect(h.state.refreshCalls).toContain('microsoft:work@outlook.com:force');
  });

  it('is idempotent — a second start does not double-arm', async () => {
    h.state.due.set(K, 10_000);
    await startOAuthRefreshScheduler();
    await startOAuthRefreshScheduler();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.state.refreshCalls).toEqual([`${K}:force`]);
  });

  it('survives a token store that cannot be read', async () => {
    h.state.listThrows = true;
    await expect(startOAuthRefreshScheduler()).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.state.refreshCalls).toEqual([]);
  });

  it('does nothing when no account is signed in', async () => {
    h.state.accounts = [];
    await startOAuthRefreshScheduler();
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(h.state.refreshCalls).toEqual([]);
  });
});

describe('scheduleAccount timing maths', () => {
  it('clamps an ALREADY-OVERDUE token to the 5s minimum (never a busy loop)', async () => {
    h.state.due.set(K, -60 * 60_000);
    await scheduleAccount(GMAIL, EMAIL);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(h.state.refreshCalls).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.state.refreshCalls).toEqual([`${K}:force`]);
  });

  it('caps a far-future token at 6h and merely RE-EVALUATES there (no refresh)', async () => {
    h.state.due.set(K, 30 * 60 * 60 * 1000); // 30h out
    await scheduleAccount(GMAIL, EMAIL);
    await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000);
    expect(h.state.refreshCalls).toEqual([]);
    // It re-read the token to re-evaluate, and armed the next wait.
    expect(h.state.dueLookups.filter((k) => k === K).length).toBe(2);

    // Once the token comes within the cap, the same chain refreshes it.
    h.state.due.set(K, 60_000);
    await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.state.refreshCalls).toEqual([`${K}:force`]);
  });

  it('cancels the timer when the account no longer exists', async () => {
    h.state.due.set(K, 10_000);
    await scheduleAccount(GMAIL, EMAIL);
    h.state.stored.set(K, null);
    await scheduleAccount(GMAIL, EMAIL);
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(h.state.refreshCalls).toEqual([]);
  });

  it('re-arming replaces the previous timer rather than stacking one', async () => {
    h.state.due.set(K, 10_000);
    await scheduleAccount(GMAIL, EMAIL);
    await scheduleAccount(GMAIL, EMAIL);
    await scheduleAccount(GMAIL, EMAIL);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.state.refreshCalls).toEqual([`${K}:force`]);
  });
});

describe('after a successful refresh', () => {
  it('reschedules off the FRESH token', async () => {
    h.state.due.set(K, 10_000);
    await scheduleAccount(GMAIL, EMAIL);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.state.refreshCalls).toHaveLength(1);

    // The success path re-read the token and armed the next refresh.
    h.state.due.set(K, 20_000);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(h.state.refreshCalls).toHaveLength(2);
  });
});

describe('failure policy', () => {
  it('retries a TRANSIENT failure with linear backoff', async () => {
    h.state.due.set(K, 10_000);
    h.state.failWith.set(K, transient());
    await scheduleAccount(GMAIL, EMAIL);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.state.refreshCalls).toHaveLength(1);

    // 1st failure -> 60s, 2nd -> 120s, 3rd -> 180s ...
    await vi.advanceTimersByTimeAsync(59_999);
    expect(h.state.refreshCalls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.state.refreshCalls).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(119_999);
    expect(h.state.refreshCalls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.state.refreshCalls).toHaveLength(3);
    expect(h.state.notifications).toHaveLength(0);
  });

  it('gives up after 5 consecutive transient failures and asks for a re-login ONCE', async () => {
    h.state.due.set(K, 0);
    h.state.failWith.set(K, transient('ETIMEDOUT'));
    await scheduleAccount(GMAIL, EMAIL);

    await vi.advanceTimersByTimeAsync(5_000);          // attempt 1
    await vi.advanceTimersByTimeAsync(60_000);         // attempt 2
    await vi.advanceTimersByTimeAsync(120_000);        // attempt 3
    await vi.advanceTimersByTimeAsync(180_000);        // attempt 4
    expect(h.state.notifications).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(240_000);        // attempt 5 -> give up
    expect(h.state.refreshCalls).toHaveLength(5);
    expect(h.state.notifications).toHaveLength(1);
    expect(h.state.notifications[0].opts.body).toContain(EMAIL);

    // The loop really stopped — no further attempts, no second notification.
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(h.state.refreshCalls).toHaveLength(5);
    expect(h.state.notifications).toHaveLength(1);
  });

  it('a TERMINAL failure stops immediately (no retry) and asks for a re-login', async () => {
    h.state.due.set(K, 10_000);
    h.state.failWith.set(K, terminal());
    await scheduleAccount(GMAIL, EMAIL);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(h.state.refreshCalls).toHaveLength(1);
    expect(h.state.notifications).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(h.state.refreshCalls).toHaveLength(1);
  });

  it('an account REMOVED mid-flight just stops — no re-auth prompt', async () => {
    h.state.due.set(K, 10_000);
    h.state.failWith.set(K, gone());
    await scheduleAccount(GMAIL, EMAIL);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.state.notifications).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(h.state.refreshCalls).toHaveLength(1);
  });

  it('a success RESETS the transient failure count', async () => {
    h.state.due.set(K, 10_000);
    h.state.failWith.set(K, transient());
    await scheduleAccount(GMAIL, EMAIL);
    await vi.advanceTimersByTimeAsync(10_000);  // fail #1 -> retry in 60s
    await vi.advanceTimersByTimeAsync(60_000);  // fail #2 -> retry in 120s

    h.state.failWith.delete(K);
    await vi.advanceTimersByTimeAsync(120_000); // success -> counter cleared
    const afterSuccess = h.state.refreshCalls.length;
    expect(afterSuccess).toBe(3);

    // Failing again starts the backoff at 60s (not 180s), proving the reset.
    h.state.failWith.set(K, transient());
    await vi.advanceTimersByTimeAsync(10_000);  // the rescheduled refresh fails
    expect(h.state.refreshCalls.length).toBe(afterSuccess + 1);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(h.state.refreshCalls.length).toBe(afterSuccess + 1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.state.refreshCalls.length).toBe(afterSuccess + 2);
  });
});

describe('the re-login prompt', () => {
  // CHANGED: clicking the toast now sends `oauth:reauth-open-settings`, not
  // `oauth:reauth-required`. The two were the same channel when the ONLY way to
  // learn about a dead session was clicking the toast; they had to split once
  // the failure itself started pushing a banner, because navigating on the
  // failure would yank the user out of whatever they were reading.
  it('focuses/restores the window and asks for Settings when clicked', async () => {
    h.state.due.set(K, 0);
    h.state.failWith.set(K, terminal());
    h.state.win!.minimized = true;
    await scheduleAccount(GMAIL, EMAIL);
    await vi.advanceTimersByTimeAsync(5_000);

    h.state.notifications[0].handlers.get('click')!();
    expect(h.state.win!.restored).toBe(true);
    expect(h.state.win!.focusCalls).toBe(1);
    const navigation = h.state.win!.sent.filter((m) => m.channel === 'oauth:reauth-open-settings');
    expect(navigation).toHaveLength(1);
    expect(navigation[0].payload).toMatchObject({ provider: 'gmail', email: EMAIL });
  });

  // The whole point of the banner: the user must be told even though nobody
  // clicked anything. Before this, the renderer only heard about a dead session
  // if the OS toast was seen AND clicked.
  it('pushes the reauth event as soon as it gives up, without any click', async () => {
    h.state.due.set(K, 0);
    h.state.failWith.set(K, terminal());
    await scheduleAccount(GMAIL, EMAIL);
    await vi.advanceTimersByTimeAsync(5_000);

    const pushed = h.state.win!.sent.filter((m) => m.channel === 'oauth:reauth-required');
    expect(pushed).toHaveLength(1);
    expect(pushed[0].payload).toMatchObject({ provider: 'gmail', email: EMAIL, reason: 'invalid_grant' });
  });

  // A platform with no notification daemon (headless Linux, notifications
  // disabled) must still surface the problem in-app — otherwise mail stops with
  // nothing on screen at all.
  it('still pushes the reauth event when the OS cannot show a toast', async () => {
    h.state.notifSupported = false;
    h.state.due.set(K, 0);
    h.state.failWith.set(K, terminal());
    await scheduleAccount(GMAIL, EMAIL);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(h.state.notifications).toHaveLength(0);
    expect(h.state.win!.sent.some((m) => m.channel === 'oauth:reauth-required')).toBe(true);
  });

  // A window that did not exist at the moment of failure has nothing to receive;
  // the registry is what it asks on mount. Losing this makes the banner depend
  // on the user happening to be looking at the app.
  it('records the requirement for a renderer that mounts later', async () => {
    h.state.win = null;
    h.state.due.set(K, 0);
    h.state.failWith.set(K, terminal());
    await scheduleAccount(GMAIL, EMAIL);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(listReauthRequired()).toMatchObject([{ provider: 'gmail', email: EMAIL }]);
  });

  // Re-auth that fails again would otherwise queue a second toast for a state
  // already on screen. The push repeats (cheap, idempotent); the toast does not.
  it('toasts once per episode but keeps pushing', async () => {
    h.state.due.set(K, 0);
    h.state.failWith.set(K, terminal());
    await scheduleAccount(GMAIL, EMAIL);
    await vi.advanceTimersByTimeAsync(5_000);
    await scheduleAccount(GMAIL, EMAIL);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(h.state.notifications).toHaveLength(1);
    expect(h.state.win!.sent.filter((m) => m.channel === 'oauth:reauth-required')).toHaveLength(2);
  });

  // A banner that outlives the problem is its own bug: the user would be told to
  // sign in to an account that already works.
  it('resolves the requirement once a refresh succeeds again', async () => {
    h.state.due.set(K, 0);
    h.state.failWith.set(K, terminal());
    await scheduleAccount(GMAIL, EMAIL);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(listReauthRequired()).toHaveLength(1);

    h.state.failWith.delete(K);
    h.state.due.set(K, 0);
    await scheduleAccount(GMAIL, EMAIL);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(listReauthRequired()).toEqual([]);
    expect(h.state.win!.sent.filter((m) => m.channel === 'oauth:reauth-resolved')).toHaveLength(1);
  });

  // Signing in from the banner is the expected remedy — the banner must clear
  // itself off the back of it, with no restart and no scheduler running yet.
  it('resolves the requirement when the account signs in again', async () => {
    h.state.due.set(K, 0);
    h.state.failWith.set(K, terminal());
    await scheduleAccount(GMAIL, EMAIL);
    await vi.advanceTimersByTimeAsync(5_000);

    rescheduleOAuthAccount(GMAIL, EMAIL);
    expect(listReauthRequired()).toEqual([]);
    expect(h.state.win!.sent.some((m) => m.channel === 'oauth:reauth-resolved')).toBe(true);
  });

  // Removing the account removes the problem. A banner demanding a sign-in for
  // a mailbox that is no longer configured cannot be acted on at all.
  it('resolves the requirement when the account is removed', async () => {
    h.state.due.set(K, 0);
    h.state.failWith.set(K, terminal());
    await scheduleAccount(GMAIL, EMAIL);
    await vi.advanceTimersByTimeAsync(5_000);

    unscheduleOAuthAccount(GMAIL, EMAIL);
    expect(listReauthRequired()).toEqual([]);
  });

  // A healthy refresh must stay silent — broadcasting on every success would put
  // a pointless event on the wire every few minutes per account.
  it('says nothing when a refresh succeeds and nothing was pending', async () => {
    h.state.due.set(K, 0);
    await scheduleAccount(GMAIL, EMAIL);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.state.win!.sent).toEqual([]);
  });

  it('is safe with no window to focus', async () => {
    h.state.due.set(K, 0);
    h.state.failWith.set(K, terminal());
    await scheduleAccount(GMAIL, EMAIL);
    await vi.advanceTimersByTimeAsync(5_000);
    h.state.win = null;
    expect(() => h.state.notifications[0].handlers.get('click')!()).not.toThrow();
  });

  it('skips the toast when the OS reports no notification support', async () => {
    h.state.notifSupported = false;
    h.state.due.set(K, 0);
    h.state.failWith.set(K, terminal());
    await scheduleAccount(GMAIL, EMAIL);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.state.notifications).toHaveLength(0);
  });

  it('swallows a notification backend failure', async () => {
    h.state.notifThrows = true;
    h.state.due.set(K, 0);
    h.state.failWith.set(K, terminal());
    await scheduleAccount(GMAIL, EMAIL);
    await expect(vi.advanceTimersByTimeAsync(5_000)).resolves.toBeDefined();
    expect(h.state.notifications).toHaveLength(0);
  });
});

describe('per-account (re)scheduling helpers', () => {
  it('rescheduleOAuthAccount is a no-op until the scheduler has started', async () => {
    h.state.due.set(K, 10_000);
    rescheduleOAuthAccount(GMAIL, EMAIL);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.state.refreshCalls).toEqual([]);
  });

  it('rescheduleOAuthAccount re-arms and clears the failure count after a re-auth', async () => {
    h.state.due.set(K, 10_000);
    h.state.failWith.set(K, transient());
    await startOAuthRefreshScheduler();
    await vi.advanceTimersByTimeAsync(10_000); // fail #1
    await vi.advanceTimersByTimeAsync(60_000); // fail #2

    h.state.failWith.delete(K);
    rescheduleOAuthAccount(GMAIL, EMAIL);
    await vi.advanceTimersByTimeAsync(0);
    const before = h.state.refreshCalls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.state.refreshCalls.length).toBe(before + 1);
  });

  it('unscheduleOAuthAccount cancels that account only', async () => {
    h.state.accounts = [
      { provider: 'gmail', email: EMAIL },
      { provider: 'microsoft', email: 'work@outlook.com' },
    ];
    h.state.due.set(K, 10_000);
    h.state.due.set(key('microsoft', 'work@outlook.com'), 10_000);
    await startOAuthRefreshScheduler();

    unscheduleOAuthAccount(GMAIL, EMAIL);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.state.refreshCalls).toEqual(['microsoft:work@outlook.com:force']);
  });
});

describe('stopOAuthRefreshScheduler', () => {
  it('cancels every pending timer so nothing fires afterwards', async () => {
    h.state.accounts = [
      { provider: 'gmail', email: EMAIL },
      { provider: 'microsoft', email: 'work@outlook.com' },
    ];
    h.state.due.set(K, 30_000);
    h.state.due.set(key('microsoft', 'work@outlook.com'), 30_000);
    await startOAuthRefreshScheduler();

    stopOAuthRefreshScheduler();
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    expect(h.state.refreshCalls).toEqual([]);
  });

  it('is safe to call twice, and the scheduler can be started again', async () => {
    await startOAuthRefreshScheduler();
    stopOAuthRefreshScheduler();
    expect(() => stopOAuthRefreshScheduler()).not.toThrow();

    h.state.due.set(K, 10_000);
    await startOAuthRefreshScheduler();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.state.refreshCalls).toEqual([`${K}:force`]);
  });
});

/**
 * Sleep deferrals are NOT failures. A laptop closed overnight defers every
 * scheduled refresh; if those counted against the 5-transient-failure budget,
 * the user would wake to a false "sign in again" toast for a session that is
 * perfectly healthy — and the scheduler would have stopped refreshing it.
 */
describe('deferred while suspended', () => {
  // A deferral must re-arm on the short deferred cadence, not stop the loop.
  it('re-checks after 60s instead of giving up', async () => {
    h.state.due.set(K, 10_000);
    h.state.failWith.set(K, deferred());
    await scheduleAccount(GMAIL, EMAIL);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.state.refreshCalls).toHaveLength(1);

    // Not the transient ladder's 60s-then-120s — a flat 60s re-check.
    await vi.advanceTimersByTimeAsync(59_999);
    expect(h.state.refreshCalls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.state.refreshCalls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.state.refreshCalls).toHaveLength(3);
  });

  // THE regression: deferrals must not accumulate into the give-up threshold.
  it('never counts toward the 5-failure budget, however long the sleep', async () => {
    h.state.due.set(K, 0);
    h.state.failWith.set(K, deferred());
    await scheduleAccount(GMAIL, EMAIL);

    // Well past 5 attempts — an overnight sleep is hours of these.
    await vi.advanceTimersByTimeAsync(5_000 + 60_000 * 12);
    expect(h.state.refreshCalls.length).toBeGreaterThan(5);
    expect(h.state.notifications).toHaveLength(0);

    // And on the real wake it refreshes normally and settles back to the
    // account's own due-point.
    h.state.failWith.delete(K);
    h.state.due.set(K, 30 * 60_000);
    const before = h.state.refreshCalls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.state.refreshCalls).toHaveLength(before + 1);
    expect(h.state.notifications).toHaveLength(0);
  });

  // A deferral must not silently forgive earlier genuine failures either — it
  // leaves the count exactly as it found it.
  it('leaves an existing transient failure count untouched', async () => {
    h.state.due.set(K, 0);
    h.state.failWith.set(K, transient());
    await scheduleAccount(GMAIL, EMAIL);
    await vi.advanceTimersByTimeAsync(5_000);           // failure 1 -> retry in 60s
    await vi.advanceTimersByTimeAsync(60_000);          // failure 2 -> retry in 120s
    await vi.advanceTimersByTimeAsync(120_000);         // failure 3 -> retry in 180s

    // The machine sleeps: one deferral, re-armed on the 60s deferred cadence.
    h.state.failWith.set(K, deferred());
    await vi.advanceTimersByTimeAsync(180_000);         // deferral (count still 3)

    // Back to genuine failures — two more reach the threshold, no more.
    h.state.failWith.set(K, transient());
    await vi.advanceTimersByTimeAsync(60_000);          // failure 4
    expect(h.state.notifications).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(240_000);         // failure 5 -> give up
    expect(h.state.notifications).toHaveLength(1);
  });
});
