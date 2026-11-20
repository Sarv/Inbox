/* eslint-disable no-console -- these tests call the console on purpose: a raw console line is what they must catch */
import { afterEach, describe, expect, it } from 'vitest';

import { captureLogs, type CapturedLogs } from '../../../src/test-support/log-capture';
import { createLogger, getLogLevel, setLogLevel, setLogSink } from '../../../src/utils/logger';

// What breaks if this file fails: the sentinel tests that prove mail text never
// reaches app.log pass while it does. In the main process the file logger also
// writes raw console.* calls to app.log (release included), so a capture that
// only listens to the logger's sink would miss a `console.log(subject)`.

const controls = { setLogSink, setLogLevel, getLogLevel };
const log = createLogger('capture-test');
let logs: CapturedLogs | null = null;
afterEach(() => { logs?.stop(); logs = null; });

describe('captureLogs', () => {
  // Breaks: a logger line is recorded twice (console write + sink), so a test
  // that counts lines, or compares a re-run's lines, is wrong.
  it('records each logger line once, without its timestamp', () => {
    logs = captureLogs(controls);

    log.info('one', { n: 1 });
    log.debug('two');

    expect(logs.lines).toEqual(['[INFO] [capture-test] one { n: 1 }', '[DEBUG] [capture-test] two']);
  });

  // Breaks: a raw console call (which app.log keeps) slips past every
  // sentinel test, since only the logger's sink was listened to.
  it('records a raw console call as a line of its own', () => {
    logs = captureLogs(controls);

    console.log('SENTINEL subject', { to: 'SENTINEL-to' });
    console.error('[2026-11-19 10:00:00.000] not a logger line');

    expect(logs.containing('SENTINEL')).toEqual(["[CONSOLE.log] SENTINEL subject { to: 'SENTINEL-to' }"]);
    expect(logs.lines).toHaveLength(2);
  });

  // Breaks: a line from a logger whose sink is not the one captured (another
  // module instance: the source copy beside the built one) is dropped.
  it('keeps a logger-shaped console line that no sink record follows', () => {
    logs = captureLogs(controls);

    console.warn('[2026-11-19 10:00:00.000] [WARN] [other-copy] SENTINEL', 3);
    log.warn('after');

    expect(logs.lines).toEqual(['[WARN] [other-copy] SENTINEL 3', '[WARN] [capture-test] after']);
  });

  // Breaks: a line the sink records with no console write before it (a test
  // that replaced console.warn after the capture started) is lost.
  it('records a sink line whose console write it did not see', () => {
    logs = captureLogs(controls);
    const wrapped = console.warn;
    console.warn = () => {};
    try {
      log.warn('quiet console');
    } finally {
      console.warn = wrapped;
    }

    expect(logs.lines).toEqual(['[WARN] [capture-test] quiet console']);
  });

  // Breaks: stop() leaves the capture's console, sink or level in place, and
  // every later test in the file logs into a dead array (or not at all).
  it('puts the console, the sink and the level back on stop', () => {
    const before = { log: console.log, level: getLogLevel() };
    logs = captureLogs(controls, { level: 'info' });
    expect(getLogLevel()).toBe('info');
    log.debug('dropped at info');
    logs.stop();
    const stopped = logs;
    logs = null;

    log.info('after stop');
    expect(console.log).toBe(before.log);
    expect(getLogLevel()).toBe(before.level);
    expect(stopped.lines).toEqual([]);
  });
});
