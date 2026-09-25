/**
 * Boot-and-exit mode, used to prove a PACKAGED build actually runs before it
 * reaches anybody.
 *
 * Every release check we had read the artifacts without ever starting one: the
 * signature, the CPU of each addon, that node_modules were packed at all.
 * v1.2.2 passed all of them and still could not launch on Ubuntu 22.04, because
 * the one thing nobody did was run the app. This is what `scripts/smoke-launch.mjs`
 * drives on each platform's runner — the app starts for real, loads its native
 * SQLite module, says so, and exits 0.
 *
 * It stops BEFORE storage, keychain and IMAP: a CI runner has no business
 * creating databases, and every failure mode this is meant to catch (an empty
 * asar, an addon built for the wrong CPU, a binary linked against a newer
 * glibc, a hardened-runtime crash) has already happened by the time the module
 * loads.
 */

import { writeFileSync } from 'node:fs';

/**
 * Printed on success and matched by the launcher. Any change here must change
 * scripts/lib/smoke-run.mjs with it, or the check passes by never matching.
 */
export const SMOKE_TEST_OK_MARKER = 'SARV_SMOKE_TEST_OK';

/** Environment variable that turns the mode on. */
const ENABLE_ENV = 'SARV_SMOKE_TEST';

/** Environment variable naming a file to touch on success. */
const MARKER_FILE_ENV = 'SARV_SMOKE_TEST_FILE';

/** Command-line equivalent of {@link ENABLE_ENV}, for launching by hand. */
const ENABLE_FLAG = '--smoke-test';

export interface SmokeTestRequest {
  /** Whether this process was started only to prove it can start. */
  enabled: boolean;
  /** Where to record success, or null to report on stdout alone. */
  markerFile: string | null;
}

/**
 * Read the smoke-test request out of the environment and argv.
 *
 * Pure so the enabling rule can be tested without launching Electron: a
 * released build that accidentally treats a normal start as a smoke run would
 * quit on the user instead of opening their mail.
 */
export function readSmokeTestRequest(
  env: Record<string, string | undefined>,
  argv: readonly string[]
): SmokeTestRequest {
  const enabled = env[ENABLE_ENV] === '1' || argv.includes(ENABLE_FLAG);
  const file = env[MARKER_FILE_ENV];
  return { enabled, markerFile: enabled && file ? file : null };
}

/**
 * Record success where the launcher can see it regardless of stdout.
 *
 * Windows GUI binaries do not always hand their parent a usable stdout, so a
 * check that reads only the console can report a healthy build as a failure.
 * Best-effort: the exit code and the printed marker still stand on their own.
 */
export function writeSmokeTestMarker(file: string | null): void {
  if (file === null) return;
  try {
    writeFileSync(file, `${SMOKE_TEST_OK_MARKER}\n`, 'utf8');
  } catch {
    /* Best-effort — stdout and the exit code remain. */
  }
}
