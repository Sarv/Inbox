import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { appJsFlags, V8_MAX_OLD_SPACE_MB } from '../../../electron/v8-flags';

const desktop = join(__dirname, '../../..');
const source = (relative: string) => readFileSync(join(desktop, relative), 'utf8');
/** Every `appendSwitch('js-flags', …)` argument in a file, as written. */
const jsFlagSwitches = (text: string) => [...text.matchAll(/appendSwitch\(\s*'js-flags'\s*,\s*([^)]*\))/g)].map((m) => m[1]);

describe('the V8 flags', () => {
  // Breaks: the heap cap changes shape, and main and every renderer (extension
  // sandboxes included) get a different limit, or none.
  it('cap the old-space heap at 2 GB and keep what a caller adds', () => {
    expect(V8_MAX_OLD_SPACE_MB).toBe(2048);
    expect(appJsFlags()).toBe('--max-old-space-size=2048');
    expect(appJsFlags(' --prof --logfile=/tmp/x-%p.log')).toBe('--max-old-space-size=2048 --prof --logfile=/tmp/x-%p.log');
  });

  // Breaks: main.ts goes back to writing its own flag string, which can drift from the
  // one the sandbox-escape harness runs under.
  it('are the ones the app sets, from the shared helper only', () => {
    expect(jsFlagSwitches(source('electron/main.ts'))).toEqual(['appJsFlags(V8_PROFILE)']);
  });

  // Breaks: the harness runs extension code without the app's heap cap. Its
  // out-of-memory probe then fills ~3.7 GB instead of 2 GB, and on a 7 GB macOS CI
  // runner the next sandbox start overran its load timeout about one run in six.
  it('are the ones the sandbox-escape harness runs extension code under', () => {
    expect(jsFlagSwitches(source('test/sandbox-escape/harness.ts'))).toEqual(['appJsFlags()']);
  });
});
