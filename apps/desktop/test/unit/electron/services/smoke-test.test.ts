import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SMOKE_TEST_OK_MARKER, readSmokeTestRequest, writeSmokeTestMarker } from '../../../../electron/services/smoke-test';

/**
 * Guards the boot-and-exit mode the release workflow uses to prove a packaged
 * build can start.
 *
 * Two opposite regressions live here. If the mode fails to turn on, the release
 * check silently verifies nothing -- which is how v1.2.2 shipped a Linux build
 * that could not launch. If it turns on when it should not, a RELEASED app
 * quits on the user a second after opening instead of showing their mail. The
 * second is far worse, so the off cases are tested as carefully as the on ones.
 */

describe('readSmokeTestRequest', () => {
  it('is off for a normal launch', () => {
    expect(readSmokeTestRequest({}, ['/path/to/app'])).toEqual({ enabled: false, markerFile: null });
  });

  // Only an exact "1" counts: an unset variable reads as undefined, and a stray
  // empty or "0" value must never take a user's app down.
  it('ignores an empty, absent or zero environment value', () => {
    expect(readSmokeTestRequest({ SARV_SMOKE_TEST: '' }, []).enabled).toBe(false);
    expect(readSmokeTestRequest({ SARV_SMOKE_TEST: '0' }, []).enabled).toBe(false);
    expect(readSmokeTestRequest({ SARV_SMOKE_TEST: undefined }, []).enabled).toBe(false);
  });

  it('turns on from the environment or the flag', () => {
    expect(readSmokeTestRequest({ SARV_SMOKE_TEST: '1' }, []).enabled).toBe(true);
    expect(readSmokeTestRequest({}, ['/path/to/app', '--smoke-test']).enabled).toBe(true);
  });

  it('carries the marker file through when the mode is on', () => {
    expect(readSmokeTestRequest({ SARV_SMOKE_TEST: '1', SARV_SMOKE_TEST_FILE: '/tmp/ok' }, [])).toEqual({
      enabled: true,
      markerFile: '/tmp/ok',
    });
  });

  // A marker file named without the mode being on would otherwise let a stray
  // environment variable write into a user's filesystem on every launch.
  it('ignores a marker file when the mode is off', () => {
    expect(readSmokeTestRequest({ SARV_SMOKE_TEST_FILE: '/tmp/ok' }, []).markerFile).toBeNull();
  });
});

describe('writeSmokeTestMarker', () => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'smoke-marker-'));
  });
  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it('writes the marker the launcher looks for', () => {
    const file = join(directory, 'ok');
    writeSmokeTestMarker(file);
    expect(readFileSync(file, 'utf8')).toContain(SMOKE_TEST_OK_MARKER);
  });

  it('does nothing when no file was asked for', () => {
    expect(() => writeSmokeTestMarker(null)).not.toThrow();
  });

  // The exit code and the printed marker still prove the run; an unwritable
  // path must not turn a healthy build into a failed release.
  it('swallows a write that cannot happen', () => {
    expect(() => writeSmokeTestMarker(join(directory, 'missing', 'ok'))).not.toThrow();
  });
});
