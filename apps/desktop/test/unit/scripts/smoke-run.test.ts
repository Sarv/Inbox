import { describe, expect, it } from 'vitest';

import { SMOKE_TEST_OK_MARKER, evaluateSmokeRun, smokeLaunchArgs } from '../../../../../scripts/lib/smoke-run.mjs';
import { SMOKE_TEST_OK_MARKER as APP_MARKER } from '../../../electron/services/smoke-test';

/**
 * Guards the release step that starts each packaged build before anyone else
 * does.
 *
 * Every other check reads the artifact -- signature, CPU of each addon,
 * whether node_modules were packed -- and v1.2.2 passed all of them while
 * being unable to launch at all on Ubuntu 22.04. Reading a binary cannot tell
 * you it runs. The value of this check is entirely in what it REFUSES to pass,
 * so those cases are what is tested.
 */

/** A run that should pass, which each case below breaks in exactly one way. */
const healthyRun = {
  code: 0,
  signal: null,
  timedOut: false,
  output: `[Main] ${SMOKE_TEST_OK_MARKER} — packaged app booted`,
  markerFileFound: true,
  timeoutMs: 120_000,
};

describe('evaluateSmokeRun', () => {
  it('passes a run that started and reported readiness', () => {
    expect(evaluateSmokeRun(healthyRun)).toEqual({ ok: true, reason: expect.stringContaining('started') });
  });

  // A hang is the shape of a build that stopped at a dialog: on a runner there
  // is nobody to click OK, so it would otherwise wait forever and look busy.
  it('fails a run that never finished', () => {
    const result = evaluateSmokeRun({ ...healthyRun, timedOut: true, code: null, signal: 'SIGKILL', markerFileFound: false });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('120s');
  });

  it('fails a run that exited non-zero, naming the code or the signal', () => {
    expect(evaluateSmokeRun({ ...healthyRun, code: 1, markerFileFound: false }).reason).toContain('code 1');
    expect(evaluateSmokeRun({ ...healthyRun, code: null, signal: 'SIGSEGV', markerFileFound: false }).reason).toContain('SIGSEGV');
  });

  // The case that makes this check worth having. An app whose whenReady handler
  // returns early -- a failed native-module guard, a lost single-instance lock --
  // exits perfectly cleanly having done nothing at all.
  it('fails a clean exit that never reported readiness', () => {
    const result = evaluateSmokeRun({ ...healthyRun, output: 'starting…', markerFileFound: false });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain(SMOKE_TEST_OK_MARKER);
  });

  // Windows GUI binaries do not always hand a parent usable stdout, so the
  // marker file alone has to be enough to pass.
  it('accepts the marker file when the app printed nothing', () => {
    expect(evaluateSmokeRun({ ...healthyRun, output: '' }).ok).toBe(true);
  });
});

describe('smokeLaunchArgs', () => {
  // Without --no-sandbox the unpacked Linux tree aborts before any of our code
  // runs (chrome-sandbox is only setuid once the .deb installs it), which would
  // report a perfectly good build as broken.
  it('disables the sandbox on Linux only', () => {
    expect(smokeLaunchArgs('linux')).toEqual(['--smoke-test', '--no-sandbox']);
    expect(smokeLaunchArgs('darwin')).toEqual(['--smoke-test']);
    expect(smokeLaunchArgs('win32')).toEqual(['--smoke-test']);
  });
});

// The marker is written twice -- once in the app, once in the launcher -- and
// nothing at runtime notices when they drift. A check that can never match is a
// check that is not running, so the two are pinned together here.
describe('the marker the app prints and the one the launcher looks for', () => {
  it('are the same string', () => {
    expect(SMOKE_TEST_OK_MARKER).toBe(APP_MARKER);
  });
});
