import { afterEach, describe, expect, it, vi } from 'vitest';

import { LOG_LEVELS, isLogLevel } from '../../../src/utils/logger';

// The one check for a log level that arrives from outside the code. Breaks if a
// renderer-forwarded record can stamp app.log with an invented level (CASA
// L-7: a forged "[FATAL]" or a multi-word level reads as the app's own line),
// or a bad SARV_LOG_LEVEL silently switches logging off.
describe('isLogLevel', () => {
  it('accepts exactly the logger’s own levels', () => {
    expect(LOG_LEVELS).toEqual(['trace', 'debug', 'info', 'warn', 'error']);
    for (const level of LOG_LEVELS) expect(isLogLevel(level)).toBe(true);
  });

  it('rejects anything else, including prototype keys, other cases and non-strings', () => {
    for (const bad of ['fatal', 'INFO', 'Info', ' info', 'constructor', 'toString', '__proto__', '', undefined, null, 3, {}]) {
      expect(isLogLevel(bad)).toBe(false);
    }
  });
});

describe('SARV_LOG_LEVEL', () => {
  const original = process.env.SARV_LOG_LEVEL;
  afterEach(() => {
    if (original === undefined) delete process.env.SARV_LOG_LEVEL;
    else process.env.SARV_LOG_LEVEL = original;
    vi.resetModules();
  });

  const levelWith = async (value: string): Promise<string> => {
    process.env.SARV_LOG_LEVEL = value;
    vi.resetModules();
    return (await import('../../../src/utils/logger')).getLogLevel();
  };

  // A prototype key used to pass the `in` check and set the threshold to a
  // function, which made every comparison false: no log line at all.
  it('ignores a value that is not a level and keeps the default', async () => {
    expect(await levelWith('constructor')).toBe('debug');
    expect(await levelWith('loud')).toBe('debug');
  });

  it('honours a real level, in any case', async () => {
    expect(await levelWith('WARN')).toBe('warn');
    expect(await levelWith('trace')).toBe('trace');
  });
});
