/*
 * Decide whether a packaged app that was launched to prove it can start
 * actually did.
 *
 * Why this exists. Every other release check reads the artifact -- the
 * signature, each addon's CPU, whether node_modules were packed at all -- and
 * v1.2.2 passed all of them while being unable to launch at all on Ubuntu
 * 22.04. Reading a binary cannot tell you it runs. So the release now starts
 * each platform's build on that platform's runner and waits for it to say so.
 *
 * The rules are here, apart from the spawning, because the interesting cases
 * are the ones a CI run must never pass by accident: a process that exits 0
 * having silently done nothing is the same shape as the bug this is for.
 */

/**
 * Printed by the app on success. Must stay identical to SMOKE_TEST_OK_MARKER in
 * apps/desktop/electron/services/smoke-test.ts -- a check that can never match
 * is a check that is not running. A unit test pins the two together.
 */
export const SMOKE_TEST_OK_MARKER = 'SARV_SMOKE_TEST_OK';

/**
 * Arguments the app is launched with.
 *
 * `--no-sandbox` on Linux only: electron-builder's unpacked tree ships
 * chrome-sandbox without the setuid bit (the .deb sets it at install time), and
 * without this the app aborts before any of our code runs, which would report a
 * perfectly good build as broken.
 *
 * @param {string} platform A `process.platform` value.
 * @returns {string[]}
 */
export function smokeLaunchArgs(platform) {
  return platform === 'linux' ? ['--smoke-test', '--no-sandbox'] : ['--smoke-test'];
}

/**
 * @typedef {object} SmokeRunOutcome
 * @property {number | null} code Exit code, or null when killed by a signal.
 * @property {string | null} signal Signal that killed it, if any.
 * @property {boolean} timedOut Whether the launcher gave up waiting.
 * @property {string} output Everything the process wrote to stdout and stderr.
 * @property {boolean} markerFileFound Whether the app wrote its marker file.
 * @property {number} timeoutMs How long it was given, for the message.
 */

/**
 * @param {SmokeRunOutcome} outcome
 * @returns {{ ok: boolean, reason: string }}
 */
export function evaluateSmokeRun(outcome) {
  const { code, signal, timedOut, output, markerFileFound, timeoutMs } = outcome;

  if (timedOut) {
    return {
      ok: false,
      reason: `the app did not finish starting within ${Math.round(timeoutMs / 1000)}s. It either hung or stopped at a dialog nobody can click on a runner.`,
    };
  }
  if (code !== 0) {
    return {
      ok: false,
      reason: `the app exited ${signal === null ? `with code ${code}` : `on signal ${signal}`} instead of starting.`,
    };
  }
  if (!markerFileFound && !output.includes(SMOKE_TEST_OK_MARKER)) {
    return {
      ok: false,
      reason: `the app exited 0 but never reported ${SMOKE_TEST_OK_MARKER}, so it quit before reaching the point where the database module loads.`,
    };
  }
  return { ok: true, reason: 'the packaged app started and loaded its native SQLite module.' };
}
