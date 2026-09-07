import { describe, expect, it } from 'vitest';

import {
  createQuotaBackoff,
  QUOTA_BACKOFF_BASE_MS,
  QUOTA_BACKOFF_CAP_MS,
  TIMEOUT_BACKOFF_MS,
  TIMEOUT_BACKOFF_CAP_MS,
} from '../../../../electron/services/quota-backoff';

// This is the fix for the "Too many simultaneous connections" storm: the back-off
// used to live inline in the background-sync handler only, so the ACTIVE account's
// imap:connect (fired on every window focus/online + a pool init) kept re-hitting
// a saturated cap the background path was already waiting out. These tests pin the
// shared back-off's contract — if any of them fail, one connect path can hammer a
// cap another path parked, and the storm comes back.

// Realistic server rejection ImapFlow surfaces for the cap (see core isQuotaError).
const quotaError = () => new Error('Command failed: NO Too many simultaneous connections. (Failure)');
// A withTimeout loss carries isTimeout=true (see core isTimeoutError).
const timeoutError = () => Object.assign(new Error('IMAP connect timed out'), { isTimeout: true });
// ImapFlow's OWN connect-phase timeout, in the exact shape onConnectError sees
// AFTER toImapError has run: the CONNECT_TIMEOUT code is rewritten to the generic
// CONNECTION_ERROR, only the "... in required time" message survives. This carries
// NO isTimeout flag, so it is caught by isConnectTimeoutError, not isTimeoutError.
const connectTimeoutError = () =>
  Object.assign(new Error('Failed to establish connection in required time'), { code: 'CONNECTION_ERROR' });
// A plain transient blip must NOT park the account.
const networkError = () => new Error('read ECONNRESET');

describe('createQuotaBackoff', () => {
  it('is not parked before any failure', () => {
    // Baseline: a healthy account is always free to connect.
    const bo = createQuotaBackoff();
    expect(bo.remainingMs('acct-a', 0)).toBe(0);
  });

  it('parks on a quota error for the escalating window and reports it', () => {
    // If this regresses, a quota failure no longer blocks the next connect and the
    // active-account focus/online reconnects re-hammer the saturated cap.
    const bo = createQuotaBackoff();
    const parked = bo.parkOnError('acct-a', quotaError(), 1_000);

    expect(parked).toEqual({ reason: 'quota', backoffMs: QUOTA_BACKOFF_BASE_MS, attempt: 1 });
    // Parked now…
    expect(bo.remainingMs('acct-a', 1_000)).toBe(QUOTA_BACKOFF_BASE_MS);
    // …and free again once the window elapses.
    expect(bo.remainingMs('acct-a', 1_000 + QUOTA_BACKOFF_BASE_MS)).toBe(0);
  });

  it('escalates 45s → 90s → … across consecutive quota hits and caps at 5m', () => {
    // Gmail's reaper frees slots gradually; a flat window misses the reopen and a
    // too-short one re-hammers. The doubling ladder (capped) is what balances that.
    // NOTE: escalation is driven by GENUINE retries — each next park fires AFTER the
    // prior window elapses (a same-instant burst now coalesces instead of climbing;
    // see the thundering-herd suite). Advancing `now` by the returned window models
    // exactly the caller retrying the moment the back-off frees.
    const bo = createQuotaBackoff();
    let now = 0;
    const park = () => {
      const backoffMs = bo.parkOnError('acct-a', quotaError(), now).backoffMs;
      now += backoffMs; // retry right when the window elapses
      return backoffMs;
    };
    expect(park()).toBe(QUOTA_BACKOFF_BASE_MS); // 45s
    expect(park()).toBe(QUOTA_BACKOFF_BASE_MS * 2); // 90s
    expect(park()).toBe(QUOTA_BACKOFF_BASE_MS * 4); // 3m
    // 4th hit would be 6m → clamped to the 5m cap, and stays capped after.
    expect(park()).toBe(QUOTA_BACKOFF_CAP_MS);
    expect(park()).toBe(QUOTA_BACKOFF_CAP_MS);
  });

  it('parks the FIRST connect timeout for the short base window WITHOUT escalating quota', () => {
    // A timeout is usually the same near-saturated condition but also a plain
    // network blip, so the first one parks briefly and must not inflate the quota
    // ladder — otherwise a couple of blips would push a real quota hit straight to
    // 5m. NOTE: attempt is now 1-based (the first rung of the timeout ladder); it
    // used to report 0 before timeouts escalated on their own ladder.
    const bo = createQuotaBackoff();
    const t = bo.parkOnError('acct-a', timeoutError(), 0);
    expect(t).toEqual({ reason: 'timeout', backoffMs: TIMEOUT_BACKOFF_MS, attempt: 1 });
    // The next quota hit is still the FIRST rung (45s), not escalated by the timeout.
    expect(bo.parkOnError('acct-a', quotaError(), TIMEOUT_BACKOFF_MS).backoffMs).toBe(QUOTA_BACKOFF_BASE_MS);
  });

  it('escalates consecutive connect timeouts 2m → 4m → 8m and caps at 8m', () => {
    // The 55-timeouts-in-2-hours storm: a flat window retries into a still-throttled
    // Gmail every 2 min forever. Sustained timeouts must back off harder so the
    // server-side throttle clears — but on the timeout ladder, not the quota one.
    // Like the quota ladder, escalation is retry-driven: each next park fires once
    // the prior window elapses (a same-instant burst coalesces — see thundering-herd).
    const bo = createQuotaBackoff();
    let now = 0;
    const park = () => {
      const backoffMs = bo.parkOnError('acct-a', timeoutError(), now).backoffMs;
      now += backoffMs; // retry right when the window elapses
      return backoffMs;
    };
    expect(park()).toBe(TIMEOUT_BACKOFF_MS); // 2m
    expect(park()).toBe(TIMEOUT_BACKOFF_MS * 2); // 4m
    expect(park()).toBe(TIMEOUT_BACKOFF_CAP_MS); // 8m (4th would be 16m → capped)
    expect(park()).toBe(TIMEOUT_BACKOFF_CAP_MS);
  });

  it('keeps the timeout and quota ladders independent from each other', () => {
    // A quota hit in the middle of a timeout run must not reset the timeout rung
    // (and vice versa) — otherwise a saturated cap that surfaces as alternating
    // errors would never climb either ladder and the storm never settles.
    const bo = createQuotaBackoff();
    bo.parkOnError('acct-a', timeoutError(), 0); // timeout rung 1 → 2m
    bo.parkOnError('acct-a', quotaError(), 0); // quota rung 1 (does not touch timeout)
    // The next timeout is rung 2 (4m), not reset to rung 1 by the quota hit.
    expect(bo.parkOnError('acct-a', timeoutError(), 0).backoffMs).toBe(TIMEOUT_BACKOFF_MS * 2);
  });

  it('parks on ImapFlow\'s own connect-phase timeout (the pool-drain storm)', () => {
    // Regression: the pool's dominant failure — "Failed to establish connection in
    // required time" — is NOT our TimeoutError and has no isTimeout flag, so it
    // slipped past parkOnError entirely (reason:null). The connect gate never
    // closed and the [Gmail]/All Mail drain re-hammered the saturated cap. It must
    // park like a timeout (first rung of the timeout ladder, no quota escalation).
    const bo = createQuotaBackoff();
    const t = bo.parkOnError('acct-a', connectTimeoutError(), 0);
    expect(t).toEqual({ reason: 'timeout', backoffMs: TIMEOUT_BACKOFF_MS, attempt: 1 });
    expect(bo.remainingMs('acct-a', 0)).toBe(TIMEOUT_BACKOFF_MS);
    // Like other timeouts, it must NOT inflate the quota ladder.
    expect(bo.parkOnError('acct-a', quotaError(), TIMEOUT_BACKOFF_MS).backoffMs).toBe(QUOTA_BACKOFF_BASE_MS);
    // …and it DOES climb the timeout ladder: the next connect-phase timeout is 4m.
    expect(bo.parkOnError('acct-a', connectTimeoutError(), TIMEOUT_BACKOFF_MS).backoffMs).toBe(TIMEOUT_BACKOFF_MS * 2);
  });

  it('does not park a plain transient error', () => {
    // A one-off ECONNRESET must stay retriable immediately — parking it would make
    // the app go dark for minutes on an ordinary blip.
    const bo = createQuotaBackoff();
    const parked = bo.parkOnError('acct-a', networkError(), 0);
    expect(parked).toEqual({ reason: null, backoffMs: 0, attempt: 0 });
    expect(bo.remainingMs('acct-a', 0)).toBe(0);
  });

  it('keys the back-off per account — one saturated account never blocks another', () => {
    // Caps are PER account; parking acct-a must leave acct-b free to connect.
    const bo = createQuotaBackoff();
    bo.parkOnError('acct-a', quotaError(), 0);
    expect(bo.remainingMs('acct-a', 0)).toBeGreaterThan(0);
    expect(bo.remainingMs('acct-b', 0)).toBe(0);
  });

  it('clear() releases the park and resets BOTH escalation ladders', () => {
    // A successful connect (or a self-healed reconnect, which now calls clear())
    // proves a slot is free; the account must be free again AND start over so the
    // next unrelated hit isn't already escalated — on the quota AND timeout ladders.
    const bo = createQuotaBackoff();
    // Escalate BOTH ladders to rung 2 via genuine time-separated retries (a
    // same-instant repeat would coalesce and never climb — see thundering-herd).
    let now = 0;
    now += bo.parkOnError('acct-a', quotaError(), now).backoffMs; // quota rung 1 → now past its window
    now += bo.parkOnError('acct-a', quotaError(), now).backoffMs; // quota rung 2
    now += bo.parkOnError('acct-a', timeoutError(), now).backoffMs; // timeout rung 1 → now past its window
    bo.parkOnError('acct-a', timeoutError(), now); // timeout rung 2
    bo.clear('acct-a');
    expect(bo.remainingMs('acct-a', 0)).toBe(0);
    // Both ladders back to rung 1 (45s quota / 2m timeout), not an escalated rung.
    expect(bo.parkOnError('acct-a', quotaError(), 0).backoffMs).toBe(QUOTA_BACKOFF_BASE_MS);
    expect(bo.parkOnError('acct-a', timeoutError(), 0).backoffMs).toBe(TIMEOUT_BACKOFF_MS);
  });

  it('treats an undefined accountId as a no-op (never throws, never parks)', () => {
    // imap:connect resolves the key as accountId ?? getCurrentAccountId(); both can
    // be undefined at cold start — the back-off must degrade to "always free".
    const bo = createQuotaBackoff();
    expect(bo.remainingMs(undefined, 0)).toBe(0);
    expect(bo.parkOnError(undefined, quotaError(), 0)).toEqual({ reason: null, backoffMs: 0, attempt: 0 });
    expect(() => bo.clear(undefined)).not.toThrow();
  });
});

describe('createQuotaBackoff — thundering-herd coalescing', () => {
  // The bug this guards: several connect paths (the active imap:connect, the
  // background reconnect, and the pool init) all fail on the SAME account within
  // the same instant, and each calls parkOnError. Every call used to advance the
  // ladder, so ONE real failure jumped attempt 1 → 2 → 3 in a single second and
  // locked the account out for minutes. A same-reason repeat WHILE STILL PARKED is
  // part of that one burst, not a genuine time-separated retry, so it must coalesce
  // into the park already in force instead of climbing the ladder.

  it('does NOT escalate on a same-instant burst of the SAME reason', () => {
    // If this regresses, one quota failure fanned across the connect paths jumps
    // straight to a multi-minute lockout — the storm this whole module fixes.
    const bo = createQuotaBackoff();
    const first = bo.parkOnError('acct-a', quotaError(), 0);
    expect(first).toEqual({ reason: 'quota', backoffMs: QUOTA_BACKOFF_BASE_MS, attempt: 1 });
    // Two more failures in the same instant — still rung 1, not 2 or 3.
    expect(bo.parkOnError('acct-a', quotaError(), 0).attempt).toBe(1);
    expect(bo.parkOnError('acct-a', quotaError(), 0).attempt).toBe(1);
    // The window is unchanged — still the base window, reported as what remains.
    expect(bo.remainingMs('acct-a', 0)).toBe(QUOTA_BACKOFF_BASE_MS);
  });

  it('coalesces a timeout burst the same way (stays on rung 1)', () => {
    // Same guard on the timeout ladder: the pool-drain storm fans a single connect
    // timeout across paths; it must not inflate the timeout window either.
    const bo = createQuotaBackoff();
    expect(bo.parkOnError('acct-a', timeoutError(), 0).attempt).toBe(1);
    expect(bo.parkOnError('acct-a', timeoutError(), 500).attempt).toBe(1);
    expect(bo.remainingMs('acct-a', 500)).toBe(TIMEOUT_BACKOFF_MS - 500);
  });

  it('reports the REMAINING park (not a fresh window) for a coalesced failure', () => {
    // A coalesced call must not extend the park — it returns what's left of the
    // window already running, so the account isn't held dark longer than the one
    // real failure warranted.
    const bo = createQuotaBackoff();
    bo.parkOnError('acct-a', quotaError(), 0); // parked until 45s
    const later = bo.parkOnError('acct-a', quotaError(), 10_000); // 10s into the window
    expect(later).toEqual({ reason: 'quota', backoffMs: QUOTA_BACKOFF_BASE_MS - 10_000, attempt: 1 });
  });

  it('DOES escalate on a genuine retry after the window elapses', () => {
    // Coalescing must not defeat the ladder: once the window is over, the next
    // failure is a real retry into a still-throttled server and must back off harder.
    const bo = createQuotaBackoff();
    bo.parkOnError('acct-a', quotaError(), 0); // rung 1, until 45s
    expect(bo.parkOnError('acct-a', quotaError(), 0).attempt).toBe(1); // same instant → coalesced
    const retry = bo.parkOnError('acct-a', quotaError(), QUOTA_BACKOFF_BASE_MS); // after the window
    expect(retry).toEqual({ reason: 'quota', backoffMs: QUOTA_BACKOFF_BASE_MS * 2, attempt: 2 });
  });

  it('lets a reason CHANGE through even while parked (timeout → hard quota refusal)', () => {
    // A distinct, stronger signal is not part of the same-reason burst: if a timeout
    // park is in force and the server then hard-refuses with a quota error, that must
    // park on the quota ladder rather than being swallowed as a duplicate.
    const bo = createQuotaBackoff();
    bo.parkOnError('acct-a', timeoutError(), 0); // parked on timeout
    const q = bo.parkOnError('acct-a', quotaError(), 1_000); // different reason, still parked
    expect(q).toEqual({ reason: 'quota', backoffMs: QUOTA_BACKOFF_BASE_MS, attempt: 1 });
  });
});
