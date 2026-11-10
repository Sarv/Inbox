import { describe, expect, it } from 'vitest';

import {
  SMOKE_TEST_OK_MARKER,
  evaluateSmokeRun,
  expectedElectronVersion,
  reportedElectronVersion,
  smokeLaunchArgs,
} from '../../../../../scripts/lib/smoke-run.mjs';
import { SMOKE_TEST_OK_MARKER as APP_MARKER, smokeTestReport } from '../../../electron/services/smoke-test';
import desktopPackageJson from '../../../package.json';

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

/**
 * A run that should pass, which each case below breaks in exactly one way.
 * Changed deliberately (CASA I-4): the app now reports the Electron it runs
 * (`electron=…`, in its output and its marker file) and the launcher compares
 * it with the pinned version, so the run carries `markerText` (the file's
 * content, null when absent) instead of `markerFileFound`, plus
 * `expectedElectron`.
 */
const healthyRun = {
  code: 0,
  signal: null,
  timedOut: false,
  output: `[Main] ${SMOKE_TEST_OK_MARKER} electron=44.5.1 — packaged app booted`,
  markerText: `${SMOKE_TEST_OK_MARKER} electron=44.5.1\n`,
  timeoutMs: 120_000,
  expectedElectron: '44.5.1',
};

describe('evaluateSmokeRun', () => {
  it('passes a run that started and reported readiness', () => {
    expect(evaluateSmokeRun(healthyRun)).toEqual({ ok: true, reason: expect.stringContaining('started') });
  });

  // A hang is the shape of a build that stopped at a dialog: on a runner there
  // is nobody to click OK, so it would otherwise wait forever and look busy.
  it('fails a run that never finished', () => {
    const result = evaluateSmokeRun({ ...healthyRun, timedOut: true, code: null, signal: 'SIGKILL', markerText: null });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('120s');
  });

  it('fails a run that exited non-zero, naming the code or the signal', () => {
    expect(evaluateSmokeRun({ ...healthyRun, code: 1, markerText: null }).reason).toContain('code 1');
    expect(evaluateSmokeRun({ ...healthyRun, code: null, signal: 'SIGSEGV', markerText: null }).reason).toContain('SIGSEGV');
  });

  // The case that makes this check worth having. An app whose whenReady handler
  // returns early -- a failed native-module guard, a lost single-instance lock --
  // exits perfectly cleanly having done nothing at all.
  it('fails a clean exit that never reported readiness', () => {
    const result = evaluateSmokeRun({ ...healthyRun, output: 'starting…', markerText: null });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain(SMOKE_TEST_OK_MARKER);
  });

  // Windows GUI binaries do not always hand a parent usable stdout, so the
  // marker file alone has to be enough to pass.
  it('accepts the marker file when the app printed nothing', () => {
    expect(evaluateSmokeRun({ ...healthyRun, output: '' }).ok).toBe(true);
  });

  // The other way round: the marker file is best-effort, and stdout alone
  // carries the same report.
  it('accepts the printed report when the app wrote no marker file', () => {
    expect(evaluateSmokeRun({ ...healthyRun, markerText: null }).ok).toBe(true);
  });

  // THE CASA I-4 case: a stale `build.electronVersion` packaged Electron 43.2.0
  // for eight releases while every test ran on 44. Breaks: a build carrying a
  // different runtime from the pinned one is published.
  it('fails a build that runs a different Electron from the pinned one, naming both', () => {
    const stale = `${SMOKE_TEST_OK_MARKER} electron=43.2.0`;
    const result = evaluateSmokeRun({ ...healthyRun, output: stale, markerText: stale });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('43.2.0');
    expect(result.reason).toContain('44.5.1');
  });

  // Breaks: an app that stops reporting its runtime passes without the check
  // ever having run.
  it('fails a run that reported readiness but no Electron version', () => {
    const result = evaluateSmokeRun({ ...healthyRun, output: SMOKE_TEST_OK_MARKER, markerText: `${SMOKE_TEST_OK_MARKER}\n` });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('never reported which Electron');
    expect(result.reason).toContain('44.5.1');
  });
});

describe('reportedElectronVersion', () => {
  // Breaks: an unrelated line mentioning electron= (a dependency's log, say)
  // stands in for the app's own report.
  it('reads only the version right after the marker', () => {
    expect(reportedElectronVersion(`x electron=1.0.0\n[Main] ${SMOKE_TEST_OK_MARKER} electron=44.5.1 — booted`)).toBe('44.5.1');
    expect(reportedElectronVersion('electron=44.5.1')).toBeNull();
    expect(reportedElectronVersion(`${SMOKE_TEST_OK_MARKER} electron=`)).toBeNull();
    expect(reportedElectronVersion('')).toBeNull();
  });
});

describe('expectedElectronVersion', () => {
  // Breaks: a range slips through, and the smoke launch compares the packaged
  // runtime with something that is not a version.
  it('accepts only an exact version', () => {
    expect(expectedElectronVersion({ devDependencies: { electron: '44.5.1' } })).toBe('44.5.1');
    expect(expectedElectronVersion({ devDependencies: { electron: '45.0.0-beta.3' } })).toBe('45.0.0-beta.3');
    for (const spec of ['^44.5.1', '~44.5.1', '>=44', '44', 'latest', '']) {
      expect(() => expectedElectronVersion({ devDependencies: { electron: spec } })).toThrow(/exact version/);
    }
    expect(() => expectedElectronVersion({})).toThrow(/exact version/);
  });

  // Breaks: the launcher reads a version the repo no longer pins (the real
  // package.json is what release.yml's smoke launch reads).
  it('reads the real desktop package.json', () => {
    expect(expectedElectronVersion(desktopPackageJson)).toBe(desktopPackageJson.devDependencies.electron);
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

  // Breaks: the app's report and the launcher's parser drift apart, and every
  // release fails (or, with a looser parser, passes without checking).
  it('carry the Electron version in a form the launcher reads back', () => {
    expect(reportedElectronVersion(`[Main] ${smokeTestReport('44.5.1')} — booted`)).toBe('44.5.1');
  });
});
