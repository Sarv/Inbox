/**
 * The guard on how fast an extension can write to the app log, which is a
 * synchronous write on the main thread. Gone, a loop in an extension stalls the
 * process syncing the user's mail.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createLogBudget,
  extensionDebugEnabled,
  LOG_LINES_PER_WINDOW,
  LOG_WINDOW_MS,
  MAX_EXTENSION_LOG_LINE,
  writeExtensionLog,
  type ExtensionLogLevel,
} from '../../../src/extensions/runtime/log-budget';
import { captureLogs, type CapturedLogs } from '../../../src/test-support/log-capture';
import { createLogger, getLogLevel, setLogLevel, setLogSink } from '../../../src/utils/logger';

describe('log budget', () => {
  // An extension logging normally must never meet it.
  it('allows lines up to the limit and refuses the rest', () => {
    let time = 0;
    const budget = createLogBudget(() => time);
    for (let i = 0; i < LOG_LINES_PER_WINDOW; i += 1) expect(budget.take().allowed).toBe(true);
    expect(budget.take().allowed).toBe(false);
    time += LOG_WINDOW_MS - 1;
    expect(budget.take().allowed).toBe(false);
  });

  // Silence would look like an extension that stopped logging: the drop has to be
  // said, once, when the next window opens.
  it('reports what it dropped once, then starts again', () => {
    let time = 0;
    const budget = createLogBudget(() => time);
    for (let i = 0; i < LOG_LINES_PER_WINDOW + 7; i += 1) budget.take();

    time += LOG_WINDOW_MS;
    expect(budget.take()).toEqual({ allowed: true, dropped: 7 });
    expect(budget.take()).toEqual({ allowed: true, dropped: 0 });
  });
});

/**
 * Where an extension's own lines go. Extensions are handed mail (a thread to
 * summarise, a message to categorise), so an extension that logs its input
 * would write that mail into a release app.log, which runs at 'info'.
 */
describe('writeExtensionLog', () => {
  const SENTINEL = 'SENTINEL-thread-about-Jane-payslip';
  const logger = createLogger('extension-bridge');
  let logs: CapturedLogs;
  const write = (level: ExtensionLogLevel, message: string, budget = createLogBudget(), source: 'console' | 'log' = 'log') =>
    writeExtensionLog(logger, budget, { extensionId: 'demo', level, message, source });

  beforeEach(() => {
    vi.stubEnv('SARV_DEBUG_EXTENSIONS', '');
    // The level a release build runs main at.
    logs = captureLogs({ setLogSink, setLogLevel, getLogLevel }, { level: 'info' });
  });
  afterEach(() => {
    logs.stop();
    vi.unstubAllEnvs();
  });

  // Breaks: an extension's console.log(input) / ctx.log.info(input) puts the
  // mail it was handed into a release app.log.
  it('keeps info and debug lines out of a release log', () => {
    write('info', `summarising ${SENTINEL}`);
    write('debug', `raw ${SENTINEL}`);

    expect(logs.containing(SENTINEL)).toEqual([]);
  });

  // Breaks: the author's switch stops working, so an extension author can no
  // longer see their own lines; or it also promotes debug lines.
  it('writes info lines at info with SARV_DEBUG_EXTENSIONS=1, and debug lines still at debug', () => {
    vi.stubEnv('SARV_DEBUG_EXTENSIONS', '1');
    expect(extensionDebugEnabled()).toBe(true);

    write('info', `summarising ${SENTINEL}`);
    write('debug', `raw ${SENTINEL}`);

    expect(logs.containing(SENTINEL)).toEqual([`[INFO] [extension-bridge] [Extension:demo] summarising ${SENTINEL}`]);
  });

  // Breaks: any value but exactly '1' turns the switch on.
  it.each(['0', 'true', 'yes', ' 1'])('treats SARV_DEBUG_EXTENSIONS=%j as off', (value) => {
    vi.stubEnv('SARV_DEBUG_EXTENSIONS', value);
    expect(extensionDebugEnabled()).toBe(false);
    write('info', SENTINEL);
    expect(logs.containing(SENTINEL)).toEqual([]);
  });

  // Breaks: warnings and errors (how an author learns why the extension does
  // nothing) are hidden along with the info lines.
  it('keeps warnings and errors at their own level, tagged with the extension', () => {
    write('warn', 'careful');
    write('error', 'refused by CSP');

    expect(logs.lines).toEqual([
      '[WARN] [extension-bridge] [Extension:demo] careful',
      '[ERROR] [extension-bridge] [Extension:demo] refused by CSP',
    ]);
  });

  // Breaks: one huge line costs main what thousands of short ones do.
  it('caps each line', () => {
    write('error', 'x'.repeat(MAX_EXTENSION_LOG_LINE * 3));

    expect(logs.lines).toHaveLength(1);
    expect(logs.lines[0].length).toBeLessThan(MAX_EXTENSION_LOG_LINE + 60);
  });

  // Breaks: lines sent to debug stop counting, so a flood of console.log (cheap
  // in a release, a synchronous write in a dev run) is never budgeted, or the
  // drop is no longer said once the window turns.
  it('budgets every line whatever level it is written at, and says what it dropped', () => {
    let time = 0;
    const budget = createLogBudget(() => time);
    for (let i = 0; i < LOG_LINES_PER_WINDOW; i += 1) write('info', 'chatter', budget, 'console');
    write('error', 'over the budget', budget, 'console');
    expect(logs.lines).toEqual([]);

    time += LOG_WINDOW_MS;
    write('error', 'next window', budget, 'console');
    expect(logs.lines).toEqual([
      '[WARN] [extension-bridge] [Extension:demo] 1 console lines dropped: too many',
      '[ERROR] [extension-bridge] [Extension:demo] next window',
    ]);
  });
});
