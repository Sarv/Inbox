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

import type { Logger } from '../../utils/logger';

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

/**
 * `SARV_DEBUG_EXTENSIONS=1`: an extension author's switch. It keeps the
 * extensions' own info lines in the log at info, and turns on the workflow
 * runner's per-message tracing. The one place the variable is read.
 */
export function extensionDebugEnabled(): boolean {
  return typeof process !== 'undefined' && process.env?.['SARV_DEBUG_EXTENSIONS'] === '1';
}

/** The level an extension asked for: `ctx.log.*`, or its `console` as Chromium reports it. */
export type ExtensionLogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * Write one line an extension produced (its `ctx.log`, or its `console`) to the
 * app log, tagged with the extension it came from, budgeted and capped.
 *
 * Extensions are handed mail (a thread to summarise, a message to categorise),
 * and an extension that logs its input would put that mail into a release
 * app.log. So its info lines go out at debug, which a release does not write,
 * unless {@link extensionDebugEnabled}. Warnings and errors keep their level:
 * they are how an author learns why the extension does nothing.
 *
 * Every line takes from `budget` whatever level it ends up at, so the budget
 * and the "lines dropped" notice count exactly what the extension sent.
 */
export function writeExtensionLog(
  logger: Pick<Logger, 'debug' | 'info' | 'warn' | 'error'>,
  budget: LogBudget,
  line: { extensionId: string; level: ExtensionLogLevel; message: string; source: 'console' | 'log' },
): void {
  const verdict = budget.take();
  if (verdict.dropped > 0) {
    logger.warn(`[Extension:${line.extensionId}] ${verdict.dropped} ${line.source} lines dropped: too many`);
  }
  if (!verdict.allowed) return;
  const text = `[Extension:${line.extensionId}] ${String(line.message).slice(0, MAX_EXTENSION_LOG_LINE)}`;
  if (line.level === 'error') logger.error(text);
  else if (line.level === 'warn') logger.warn(text);
  else if (line.level === 'info' && extensionDebugEnabled()) logger.info(text);
  else logger.debug(text);
}
