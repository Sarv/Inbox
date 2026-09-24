/**
 * Consecutive-failure circuit breakers, one per key.
 *
 * The shape every network lookup on the ingest path needs: a key (a blocklist
 * zone, a service) that fails `failureThreshold` times IN A ROW is not asked
 * again for `cooldownMs`, and one success forgives it everything. Consecutive,
 * not total: failures separated by successes are a flaky network, not a
 * resolver the operator refuses to answer.
 *
 * After a cooldown the key starts from zero, so it takes another full run of
 * failures to retire it again — one refusal after a cooldown is one refusal.
 * A configuration change builds new breakers rather than resetting these.
 */

/** Consecutive failures that open a breaker. */
export const DEFAULT_FAILURE_THRESHOLD = 5;
/** How long an open breaker stays open. Long enough that a wrong resolver costs one burst. */
export const DEFAULT_BREAKER_COOLDOWN_MS = 30 * 60_000;

export interface CircuitBreakerOptions {
  failureThreshold?: number;
  cooldownMs?: number;
  /** Millisecond clock, injectable for tests. */
  now?: () => number;
}

export class CircuitBreakers {
  readonly failureThreshold: number;
  readonly cooldownMs: number;
  private readonly now: () => number;
  private readonly keys = new Map<string, { failures: number; openUntil: number }>();

  constructor(options: CircuitBreakerOptions = {}) {
    this.failureThreshold = Math.max(1, options.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD);
    this.cooldownMs = options.cooldownMs ?? DEFAULT_BREAKER_COOLDOWN_MS;
    this.now = options.now ?? Date.now;
  }

  /** Whether `key` may be asked right now. */
  isClosed(key: string): boolean {
    return (this.keys.get(key)?.openUntil ?? 0) <= this.now();
  }

  /** An answer: the key is forgiven its past. */
  succeeded(key: string): void {
    this.keys.delete(key);
  }

  /** A failure. True when this one opened the breaker. */
  failed(key: string): boolean {
    const entry = this.keys.get(key) ?? { failures: 0, openUntil: 0 };
    entry.failures += 1;
    const opened = entry.failures >= this.failureThreshold;
    if (opened) {
      entry.openUntil = this.now() + this.cooldownMs;
      entry.failures = 0;
    }
    this.keys.set(key, entry);
    return opened;
  }
}
