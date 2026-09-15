import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  acquireConnectionSlot,
  connectionCapForHost,
  connectionBudgetState,
  poolIdleTimeoutForHost,
  __resetConnectionBudgets,
} from '../../../src/imap/connection-budget';

// The per-account connection GOVERNOR is the ONE bound on total sockets to an
// account — the thing that finally keeps Gmail under its ~15 cap regardless of how
// many sources (primary, pool, IDLE, background, reconnect) want a connection —
// AND, for Gmail, the layer that keeps us under Gmail's independent NEW-CONNECTION
// RATE throttle and reserves headroom for the user-facing primary. If it
// over-grants, "Too many simultaneous connections" returns; if it bursts,
// CONNECT_TIMEOUT returns even under the cap; if it starves the foreground, the
// primary can't reconnect; if it leaks a slot, the account can never reconnect.
// All of these are pinned here.
//
// Behaviour change (governor added): Gmail connects are now PACED (min gap between
// connect starts), RAMPED on cold start (small cap for the first window), and
// PRIORITISED (foreground over background). The old "fill 6 Gmail slots instantly"
// tests reflected the plain-semaphore era; the semaphore invariants now live on a
// non-Gmail host (no pacing/ramp/reserve), and the Gmail cases assert the governor.

const U = 'advik.d@sarv.com';
const GMAIL = 'imap.gmail.com';
const SELF = 'imap.sarv.com'; // self-hosted: plain semaphore, no pacing/ramp/reserve

const GMAIL_INTERVAL_MS = 1500;
const GMAIL_RAMP_MS = 15000;

beforeEach(() => __resetConnectionBudgets());
afterEach(() => { vi.useRealTimers(); __resetConnectionBudgets(); });

// Drive a Gmail budget past its cold-start ramp so the full cap is available,
// leaving it idle (inUse 0) for the caller.
async function warmGmailPastRamp(): Promise<void> {
  const release = await acquireConnectionSlot(GMAIL, U); // creates the budget at t=0
  await vi.advanceTimersByTimeAsync(GMAIL_RAMP_MS);      // ramp window elapses
  release();                                             // back to idle, full cap
}

describe('connectionCapForHost', () => {
  it('caps Gmail well under its ~15 limit and is more generous for self-hosted', () => {
    // Regression: a wrong hard cap either trips "Too many connections" (too high)
    // or needlessly serialises a healthy account (too low).
    expect(connectionCapForHost('imap.gmail.com')).toBe(6);
    expect(connectionCapForHost('imap.googlemail.com')).toBe(6);
    expect(connectionCapForHost('imap.sarv.com')).toBe(10);
  });
});

describe('poolIdleTimeoutForHost', () => {
  it('holds a pooled Gmail connection idle for 5 min, others for 10 min', () => {
    // Regression: the pool used to evict idle connections after a flat 60s, so a
    // drip-fed workload re-opened a pooled socket on nearly every pass — connection
    // churn that trips Gmail's NEW-CONNECTION rate throttle (stalled greeting →
    // CONNECT_TIMEOUT) even while under the cap. Holding an idle connection longer
    // reuses the socket instead of re-handshaking. Gmail stops SHORT of a mature
    // client's ~29 min because its cap is SHARED across all the user's apps, so we
    // must not selfishly hoard a slot; a self-hosted server we own can hold longer.
    expect(poolIdleTimeoutForHost('imap.gmail.com')).toBe(5 * 60 * 1000);
    expect(poolIdleTimeoutForHost('imap.googlemail.com')).toBe(5 * 60 * 1000);
    expect(poolIdleTimeoutForHost('imap.sarv.com')).toBe(10 * 60 * 1000);
  });

  it('is case-insensitive and safe on an empty/odd host', () => {
    // Host strings arrive in mixed case from config; a case-sensitive check would
    // mis-classify GMAIL and fall back to the long window, hoarding a shared slot.
    expect(poolIdleTimeoutForHost('IMAP.GMAIL.COM')).toBe(5 * 60 * 1000);
    expect(poolIdleTimeoutForHost('')).toBe(10 * 60 * 1000);
  });
});

describe('connection governor — semaphore invariants (non-Gmail: no pacing/ramp/reserve)', () => {
  it('grants immediately while under budget and tracks inUse', async () => {
    // Regression: a healthy self-hosted account must not be paced/ramped — connects
    // are immediate up to its cap.
    const r1 = await acquireConnectionSlot(SELF, U);
    const r2 = await acquireConnectionSlot(SELF, U);
    expect(connectionBudgetState(SELF, U).inUse).toBe(2);
    r1(); r2();
    expect(connectionBudgetState(SELF, U).inUse).toBe(0);
  });

  it('BLOCKS past the cap and hands the freed slot to the next waiter', async () => {
    // Regression: over-granting past the cap is exactly the "Too many simultaneous
    // connections" bug this bound exists to prevent.
    const held: Array<() => void> = [];
    for (let i = 0; i < 10; i++) held.push(await acquireConnectionSlot(SELF, U)); // fill cap (10)

    let granted = false;
    const waiting = acquireConnectionSlot(SELF, U).then((r) => { granted = true; return r; });
    await Promise.resolve();
    expect(granted).toBe(false);                          // 11th is blocked
    expect(connectionBudgetState(SELF, U).waiting).toBe(1);

    held[0]();                                            // free one slot
    const r = await waiting;
    expect(granted).toBe(true);                           // waiter got it
    expect(connectionBudgetState(SELF, U).inUse).toBe(10); // still exactly at cap
    r(); held.slice(1).forEach((f) => f());
  });

  it('release is idempotent — double-calling never over-frees the budget', async () => {
    // Regression: an over-free would let the account open past its real cap.
    const r1 = await acquireConnectionSlot(SELF, U);
    const r2 = await acquireConnectionSlot(SELF, U);
    r1(); r1(); r1();                                     // spurious extra releases
    expect(connectionBudgetState(SELF, U).inUse).toBe(1); // only r1's one slot freed
    r2();
    expect(connectionBudgetState(SELF, U).inUse).toBe(0);
  });

  it('keys the budget per account (host+user) — accounts don\'t share slots', async () => {
    // Regression: one busy account must not be able to starve another's budget.
    for (let i = 0; i < 10; i++) await acquireConnectionSlot(SELF, U); // self-hosted full
    const r = await acquireConnectionSlot(GMAIL, U);                   // gmail has its own
    expect(connectionBudgetState(GMAIL, U).inUse).toBe(1);
    r();
  });
});

describe('connection governor — Gmail pacing (new-connection rate throttle)', () => {
  it('grants the FIRST connect immediately but paces the next start ~1.5s later', async () => {
    // Regression: a startup burst (primary + pool + drain + backfill connecting at
    // once) trips Gmail's new-connection rate throttle → CONNECT_TIMEOUT even under
    // the cap. Pacing turns the burst into a ramp.
    vi.useFakeTimers();
    const r1 = await acquireConnectionSlot(GMAIL, U);      // t=0, immediate
    expect(connectionBudgetState(GMAIL, U).inUse).toBe(1);

    let granted2 = false;
    const p2 = acquireConnectionSlot(GMAIL, U).then((r) => { granted2 = true; return r; });
    await Promise.resolve();
    expect(granted2).toBe(false);                          // paced — slot free, but too soon
    expect(connectionBudgetState(GMAIL, U).inUse).toBe(1);

    await vi.advanceTimersByTimeAsync(GMAIL_INTERVAL_MS);
    const r2 = await p2;
    expect(granted2).toBe(true);                           // starts once the interval elapses
    expect(connectionBudgetState(GMAIL, U).inUse).toBe(2);
    r1(); r2();
  });
});

describe('connection governor — Gmail cold-start ramp', () => {
  it('limits the effective cap during the ramp window, then widens to the full cap', async () => {
    // Regression: on restart the previous process's sockets still occupy Gmail's
    // real cap (its reaper runs minutes later); bursting 6 fresh connects into a
    // still-full cap is the restart error storm. Ramp probes gently first.
    vi.useFakeTimers();
    const r1 = await acquireConnectionSlot(GMAIL, U);      // t=0
    await vi.advanceTimersByTimeAsync(GMAIL_INTERVAL_MS);
    const r2 = await acquireConnectionSlot(GMAIL, U);      // t=1500, ramp cap = 2
    expect(connectionBudgetState(GMAIL, U).inUse).toBe(2);
    expect(connectionBudgetState(GMAIL, U).effectiveMax).toBe(2); // ramped, not the full 6

    // A 3rd connect is blocked by the ramp cap (not by the hard cap of 6).
    let granted3 = false;
    const p3 = acquireConnectionSlot(GMAIL, U).then((r) => { granted3 = true; return r; });
    await vi.advanceTimersByTimeAsync(GMAIL_INTERVAL_MS);  // clear pacing; still ramp-blocked
    expect(granted3).toBe(false);

    // Once the ramp window elapses the cap widens and the waiter is granted.
    await vi.advanceTimersByTimeAsync(GMAIL_RAMP_MS);
    const r3 = await p3;
    expect(granted3).toBe(true);
    expect(connectionBudgetState(GMAIL, U).inUse).toBe(3);
    expect(connectionBudgetState(GMAIL, U).effectiveMax).toBe(6); // full cap after ramp
    r1(); r2(); r3();
  });
});

describe('connection governor — cold-start ramp does not starve background to zero', () => {
  it('lets the pool (background) warm up alongside the primary DURING the ramp', async () => {
    // Regression (the "connection budget exhausted (max 6)" ERROR at startup):
    // the reserve (2) is sized for the full cap (6); subtracting it from the small
    // cold-start ramp cap (2) left ZERO background slots for the entire 15s ramp,
    // so pool.initialize() could never get a socket, timed out, and failed the whole
    // account connect. The primary + pool must both fit the 2 ramp slots.
    vi.useFakeTimers();
    const rFg = await acquireConnectionSlot(GMAIL, U, 30000, 'foreground'); // t=0, ramp cap 2, inUse 1
    expect(connectionBudgetState(GMAIL, U).effectiveMax).toBe(2);           // ramping

    let bgGranted = false;
    const pBg = acquireConnectionSlot(GMAIL, U, 20000, 'background').then((r) => { bgGranted = true; return r; });
    await vi.advanceTimersByTimeAsync(GMAIL_INTERVAL_MS);                   // clear pacing only
    const rBg = await pBg;
    expect(bgGranted).toBe(true);                                          // NOT starved to zero
    expect(connectionBudgetState(GMAIL, U).inUse).toBe(2);                 // primary + pool = the 2 ramp slots

    // But the ramp is still a hard bound: a THIRD connect (background) waits — the
    // skip-reserve-while-ramping change must not widen the ramp cap itself.
    let bg3 = false;
    acquireConnectionSlot(GMAIL, U, 20000, 'background').then((r) => { bg3 = true; return r; });
    await vi.advanceTimersByTimeAsync(GMAIL_INTERVAL_MS);
    expect(bg3).toBe(false);

    rFg(); rBg();
  });
});

describe('connection governor — Gmail foreground priority / reserved headroom', () => {
  it('caps background at cap-reserve, leaving reserved slots the foreground can still take', async () => {
    // Regression: bulk pool work (drain/backfill/labels/prefetch) grabbing every
    // slot starves the user-facing primary/IDLE reconnect. Background yields the
    // reserve; foreground keeps the full cap.
    vi.useFakeTimers();
    await warmGmailPastRamp();

    const bg: Array<() => void> = [];
    for (let i = 0; i < 4; i++) {                          // background ceiling = 6 - 2 = 4
      const p = acquireConnectionSlot(GMAIL, U, 30000, 'background');
      await vi.advanceTimersByTimeAsync(GMAIL_INTERVAL_MS);
      bg.push(await p);
    }
    expect(connectionBudgetState(GMAIL, U).inUse).toBe(4);

    // A 5th BACKGROUND connect is refused — the reserve is kept clear.
    let bg5 = false;
    const _p5 = acquireConnectionSlot(GMAIL, U, 30000, 'background').then((r) => { bg5 = true; return r; });
    await vi.advanceTimersByTimeAsync(GMAIL_INTERVAL_MS);
    expect(bg5).toBe(false);

    // But a FOREGROUND connect may use a reserved slot.
    const fgP = acquireConnectionSlot(GMAIL, U, 30000, 'foreground');
    await vi.advanceTimersByTimeAsync(GMAIL_INTERVAL_MS);
    const rFg = await fgP;
    expect(connectionBudgetState(GMAIL, U).inUse).toBe(5);
    rFg(); bg.forEach((f) => f());
  });

  it('a foreground waiter jumps ahead of a background one already in the queue', async () => {
    // Regression: strict FIFO let a background connect that queued first take the
    // freed slot ahead of a later primary reconnect. Foreground must win.
    vi.useFakeTimers();
    await warmGmailPastRamp();

    const held: Array<() => void> = [];
    for (let i = 0; i < 6; i++) {                          // fill the full cap with foreground
      const p = acquireConnectionSlot(GMAIL, U, 30000, 'foreground');
      await vi.advanceTimersByTimeAsync(GMAIL_INTERVAL_MS);
      held.push(await p);
    }
    expect(connectionBudgetState(GMAIL, U).inUse).toBe(6);

    let bgGranted = false;
    let fgGranted = false;
    // Background queues FIRST, foreground SECOND.
    acquireConnectionSlot(GMAIL, U, 30000, 'background').then((r) => { bgGranted = true; return r; });
    acquireConnectionSlot(GMAIL, U, 30000, 'foreground').then((r) => { fgGranted = true; return r; });
    await Promise.resolve();

    held[0]();                                             // free exactly one slot
    await vi.advanceTimersByTimeAsync(GMAIL_INTERVAL_MS);
    expect(fgGranted).toBe(true);                          // foreground took it...
    expect(bgGranted).toBe(false);                         // ...ahead of the earlier background
    held.slice(1).forEach((f) => f());
  });
});

describe('connection governor — Gmail never exceeds the hard cap', () => {
  it('rejects (times out) rather than opening past the cap when no slot frees', async () => {
    // Regression: opening past Gmail's cap is the "Too many simultaneous
    // connections" lockout. A rush of demand must reject the overflow, not over-open.
    vi.useFakeTimers();
    await warmGmailPastRamp();

    // Rush 8 foreground connects at the full cap of 6; the extras must time out.
    // Use the real connect-wait window (20s) — long enough to admit 6 paced
    // connects (~9s) yet still reject the 2 that the cap can never satisfy.
    const WAIT_MS = 20000;
    const results = Array.from({ length: 8 }, () =>
      acquireConnectionSlot(GMAIL, U, WAIT_MS, 'foreground').then(
        (r) => ({ ok: true as const, r }),
        (e) => ({ ok: false as const, e: e as Error }),
      ),
    );
    // Advance past both the pacing ramp for 6 grants and the 20s reject window.
    await vi.advanceTimersByTimeAsync(WAIT_MS + 6 * GMAIL_INTERVAL_MS + 1);
    const settled = await Promise.all(results);

    const granted = settled.filter((s) => s.ok);
    const timedOut = settled.filter((s) => !s.ok);
    expect(granted).toHaveLength(6);                       // never more than the hard cap
    expect(timedOut).toHaveLength(2);
    expect(connectionBudgetState(GMAIL, U).inUse).toBe(6);
    for (const s of granted) if (s.ok) s.r();
  });
});
