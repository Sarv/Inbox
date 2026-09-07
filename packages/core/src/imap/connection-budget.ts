/**
 * Per-account IMAP connection GOVERNOR — the single chokepoint that governs every
 * socket to one account, across EVERY source (the primary connection, the pool,
 * IDLE, background sync, and reconnect overlap).
 *
 * Why this exists: ImapFlow is a SINGLE-connection client — it has no pool, no
 * cross-connection rate limiter, and no visibility into the other sockets on the
 * same account, so per-connection options (connectionTimeout, throttle handling,
 * IDLE cycling) can't coordinate the fleet. The pool capped only itself; the
 * primary / IDLE / background engines each opened sockets OUTSIDE that count; and
 * nothing bounded the sum or the RATE — so we still blew Gmail's ~15-simultaneous
 * cap ("Too many simultaneous connections") AND tripped its independent
 * new-connection RATE throttle (a startup burst of primary + pool + drain +
 * backfill connecting at once → CONNECT_TIMEOUT "in required time", even under the
 * cap). This is the account-level layer ImapFlow deliberately leaves to the app.
 *
 * It governs three dimensions, all Gmail-aware (a self-hosted server keeps the old
 * plain-semaphore behaviour — higher cap, no pacing / reserve / ramp):
 *
 *   1. TOTAL cap        — the hard ceiling on live sockets (the original bound).
 *   2. PACING           — a minimum gap between connect STARTS, so a burst of
 *                         callers becomes a smooth ramp instead of a spike Gmail
 *                         rate-throttles into connect timeouts.
 *   3. PRIORITY/RESERVE — 'foreground' (primary/IDLE, user-facing) always has the
 *                         full cap and jumps the queue; 'background' (pool bulk:
 *                         drain/backfill/labels/prefetch) may use at most
 *                         `cap - reserve`, so the primary + a reconnect overlap
 *                         are never starved by bulk work.
 *   4. COLD-START RAMP  — for the first `rampWindowMs` after the account's first
 *                         connect (i.e. app startup / restart), the effective cap
 *                         is small so we probe Gmail's not-yet-reaped cap gently
 *                         instead of bursting into a cap the previous process
 *                         still occupies (Gmail's reaper frees dropped sockets
 *                         only after minutes).
 *
 * Deliberately account-scoped by host+user: Gmail's cap is per-account, and a
 * self-hosted server has its own (usually higher) limit, so each key gets its own
 * governor.
 */

export type ConnectionPriority = 'foreground' | 'background';

export interface ConnectionBudgetState {
  key: string;
  max: number;
  inUse: number;
  waiting: number;
  /** Effective ceiling right now (after the cold-start ramp), for diagnostics. */
  effectiveMax: number;
}

interface Waiter {
  priority: ConnectionPriority;
  grant: () => void;
  timer: ReturnType<typeof setTimeout>;
}

interface Budget {
  /** Hard ceiling on live sockets. */
  max: number;
  /** Slots kept clear for foreground even when background wants them. */
  reserve: number;
  /** Minimum gap (ms) between connect STARTS — 0 disables pacing. */
  minIntervalMs: number;
  /** Effective cap during the first `rampWindowMs` after `createdAt`. */
  rampStart: number;
  rampWindowMs: number;
  createdAt: number;
  inUse: number;
  /** Timestamp of the last granted connect start, for pacing. */
  lastConnectStart: number;
  waiters: Waiter[];
  /** Single shared timer that re-pumps when pacing or the ramp next widens the cap. */
  wakeTimer: ReturnType<typeof setTimeout> | null;
}

const budgets = new Map<string, Budget>();

interface HostPolicy {
  max: number;
  reserve: number;
  minIntervalMs: number;
  rampStart: number;
  rampWindowMs: number;
}

/**
 * The governor's per-host policy. Gmail throttles the RATE of new connections
 * independently of its ~15 cap, and its reaper frees dropped sockets only after
 * minutes — so pace connects, reserve headroom for the user-facing primary, and
 * ramp gently on cold start. Everything else gets a plain, generous semaphore.
 */
function policyForHost(host: string): HostPolicy {
  const h = (host || '').toLowerCase();
  const isGmail = h.includes('gmail') || h.includes('googlemail');
  if (isGmail) {
    return { max: 6, reserve: 2, minIntervalMs: 1500, rampStart: 2, rampWindowMs: 15000 };
  }
  return { max: 10, reserve: 0, minIntervalMs: 0, rampStart: 10, rampWindowMs: 0 };
}

/** Per-account hard ceiling. Gmail enforces ~15 simultaneous IMAP connections;
 *  stay well under it so primary + pool + IDLE + a transient reconnect never trip it. */
export function connectionCapForHost(host: string): number {
  return policyForHost(host).max;
}

/**
 * How long a warm-but-idle POOLED connection is kept before it's closed and must
 * be re-opened. This trades connection CHURN (re-opening) against FOOTPRINT
 * (holding a slot the whole time).
 *
 * Mature clients keep warm connections far longer than we used to: Thunderbird's
 * `ConnectionTimeOut` defaults to 29 minutes. Our old flat 60s meant a drip-fed
 * workload (body-prefetch / backfill every 60s-10min) opened -> used -> closed ->
 * re-opened on almost every pass, and it is exactly that CHURN — not the live
 * count — that trips Gmail's new-connection rate throttle. So keep warm
 * connections much longer.
 *
 * Gmail's cap is SHARED with every other client on the account (Apple Mail,
 * Notes, phone), so we deliberately stop short of Thunderbird's 29 min there —
 * holding a slot warm for half an hour is antisocial under a shared cap. 5 min
 * kills the churn while releasing the slot promptly once work genuinely stops. A
 * self-hosted server owns its own (roomier) cap, so it can stay warm longer.
 */
export function poolIdleTimeoutForHost(host: string): number {
  const h = (host || '').toLowerCase();
  const isGmail = h.includes('gmail') || h.includes('googlemail');
  return isGmail ? 5 * 60 * 1000 : 10 * 60 * 1000;
}

const keyFor = (host: string, username: string): string =>
  `${(host || '').toLowerCase()}:${(username || '').toLowerCase()}`;

function getOrCreate(host: string, username: string): Budget {
  const key = keyFor(host, username);
  let b = budgets.get(key);
  if (!b) {
    const p = policyForHost(host);
    b = {
      max: p.max,
      reserve: p.reserve,
      minIntervalMs: p.minIntervalMs,
      rampStart: p.rampStart,
      rampWindowMs: p.rampWindowMs,
      createdAt: Date.now(),
      inUse: 0,
      // -Infinity so the account's FIRST connect is never paced — only subsequent
      // starts within `minIntervalMs` of the last one wait.
      lastConnectStart: Number.NEGATIVE_INFINITY,
      waiters: [],
      wakeTimer: null,
    };
    budgets.set(key, b);
  }
  return b;
}

/** The cap in force right now — reduced during the cold-start ramp window. */
function currentCap(b: Budget, now: number): number {
  if (b.rampWindowMs > 0 && now - b.createdAt < b.rampWindowMs) {
    return Math.min(b.rampStart, b.max);
  }
  return b.max;
}

/** The cap a given priority may use right now: background yields `reserve` slots. */
function effectiveCap(b: Budget, priority: ConnectionPriority, now: number): number {
  const cap = currentCap(b, now);
  if (priority !== 'background') return cap;
  // During the cold-start ramp the TOTAL cap is already clamped low (rampStart);
  // that clamp IS the gentleness. Subtracting the full-cap-sized reserve on top of
  // it zeroed background out entirely — reserve (2) taken from the ramp cap (2)
  // left 0 slots for the whole 15s ramp, so pool.initialize() could never get a
  // socket and timed out with "connection budget exhausted", which then failed the
  // entire account connect. Skip the reserve WHILE ramping so the pool can warm up
  // alongside the primary (primary + pool = the 2 ramp slots); the reserve still
  // protects foreground headroom at steady state.
  if (b.rampWindowMs > 0 && now - b.createdAt < b.rampWindowMs) return cap;
  return Math.max(0, cap - b.reserve);
}

/**
 * The next waiter that the CAP allows to be granted right now (pacing checked
 * separately). Foreground is always considered before background and jumps the
 * queue; within a priority it is FIFO. Because every waiter of a priority shares
 * the same cap, only the head of each priority can be the candidate.
 */
function pickByCap(b: Budget, now: number): Waiter | null {
  const fg = b.waiters.find((w) => w.priority === 'foreground');
  if (fg && b.inUse < effectiveCap(b, 'foreground', now)) return fg;
  const bg = b.waiters.find((w) => w.priority === 'background');
  if (bg && b.inUse < effectiveCap(b, 'background', now)) return bg;
  return null;
}

function scheduleWake(b: Budget, delayMs: number): void {
  if (b.wakeTimer || delayMs <= 0) return;
  b.wakeTimer = setTimeout(() => {
    b.wakeTimer = null;
    pump(b);
  }, delayMs);
}

/**
 * Grant as many waiting acquisitions as the cap AND the pacing interval currently
 * allow, then arm a single timer to re-pump when the next connect may start (or
 * when the cold-start ramp next widens the cap). Called after every acquire and
 * every release, and from the wake timer.
 */
function pump(b: Budget): void {
  const now = Date.now();
  const waiter = pickByCap(b, now);

  if (!waiter) {
    // Nothing is grantable by cap. If waiters are held back only by the cold-start
    // ramp (not genuine saturation), wake when the ramp widens the cap — otherwise
    // a release() is the only thing that can make progress, and it re-pumps itself.
    if (b.waiters.length > 0 && b.rampWindowMs > 0) {
      scheduleWake(b, b.rampWindowMs - (now - b.createdAt));
    }
    return;
  }

  const sinceLastConnect = now - b.lastConnectStart;
  const pacingWait = b.minIntervalMs - sinceLastConnect;
  if (pacingWait > 0) {
    // A slot is free but Gmail's rate throttle isn't — hold the next connect start.
    scheduleWake(b, pacingWait);
    return;
  }

  const index = b.waiters.indexOf(waiter);
  if (index >= 0) b.waiters.splice(index, 1);
  clearTimeout(waiter.timer);
  b.inUse++;
  b.lastConnectStart = now;
  waiter.grant();

  // More may be grantable; pacing will gate the next one via the wake timer.
  pump(b);
}

function makeRelease(b: Budget): () => void {
  let released = false;
  return () => {
    if (released) return; // idempotent: safe to call from 'close' AND a catch
    released = true;
    b.inUse--;
    pump(b);
  };
}

/**
 * Acquire one connection slot for the account. Resolves with a `release` fn once a
 * slot is free AND the pacing interval allows the connect to start (immediately if
 * both are satisfied, else when they are). Rejects if no slot frees within
 * `timeoutMs` — the caller treats that as a connection error and backs off, rather
 * than opening past the cap. `priority` decides whether this connect competes for
 * the full cap and jumps the queue ('foreground': primary/IDLE) or yields the
 * reserved headroom to the foreground ('background': pool bulk work).
 */
export function acquireConnectionSlot(
  host: string,
  username: string,
  timeoutMs = 30000,
  priority: ConnectionPriority = 'foreground',
): Promise<() => void> {
  const b = getOrCreate(host, username);
  const key = keyFor(host, username);
  return new Promise<() => void>((resolve, reject) => {
    const waiter: Waiter = {
      priority,
      grant: () => resolve(makeRelease(b)),
      timer: setTimeout(() => {
        const i = b.waiters.indexOf(waiter);
        if (i >= 0) b.waiters.splice(i, 1);
        reject(
          new Error(
            `IMAP connection budget for ${key} exhausted (max ${b.max}) — timed out after ${timeoutMs}ms waiting for a slot`,
          ),
        );
      }, timeoutMs),
    };
    b.waiters.push(waiter);
    pump(b);
  });
}

/** Introspection for diagnostics/tests. */
export function connectionBudgetState(host: string, username: string): ConnectionBudgetState {
  const key = keyFor(host, username);
  const b = budgets.get(key);
  const max = b?.max ?? connectionCapForHost(host);
  return {
    key,
    max,
    inUse: b?.inUse ?? 0,
    waiting: b?.waiters.length ?? 0,
    effectiveMax: b ? currentCap(b, Date.now()) : max,
  };
}

/** Test-only: clear all budgets and any pending timers. */
export function __resetConnectionBudgets(): void {
  for (const b of budgets.values()) {
    if (b.wakeTimer) clearTimeout(b.wakeTimer);
    for (const w of b.waiters) clearTimeout(w.timer);
  }
  budgets.clear();
}
