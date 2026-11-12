/**
 * How much an extension may write to the app log.
 *
 * Every line is a synchronous write on the main thread (see CLAUDE.md, Logging),
 * and an extension chooses how many it sends. A loop that logs must spend its
 * own sandbox's time, not the time of the process syncing the user's mail.
 *
 * Generous on purpose: this is a guard against a flood, never a limit an
 * extension doing its job should meet.
 */

/** Lines kept per window, per extension. */
export const LOG_LINES_PER_WINDOW = 200;

/** The window those lines are counted over. */
export const LOG_WINDOW_MS = 10_000;

/** The longest line kept. */
export const MAX_EXTENSION_LOG_LINE = 4_000;

export interface LogBudgetVerdict {
  /** Write this line. */
  allowed: boolean;
  /** Lines dropped in the window that just ended, to say so once. */
  dropped: number;
}

export interface LogBudget {
  take(): LogBudgetVerdict;
}

export function createLogBudget(now: () => number = Date.now): LogBudget {
  let windowStart = now();
  let lines = 0;
  let dropped = 0;

  return {
    take() {
      const time = now();
      let reportDropped = 0;
      if (time - windowStart >= LOG_WINDOW_MS) {
        reportDropped = dropped;
        windowStart = time;
        lines = 0;
        dropped = 0;
      }
      lines += 1;
      if (lines > LOG_LINES_PER_WINDOW) {
        dropped += 1;
        return { allowed: false, dropped: reportDropped };
      }
      return { allowed: true, dropped: reportDropped };
    },
  };
}
