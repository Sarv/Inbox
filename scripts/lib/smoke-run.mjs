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
 * The key the app reports its Electron runtime under, right after the marker:
 * `SARV_SMOKE_TEST_OK electron=44.5.1`. Must match smokeTestReport() in
 * apps/desktop/electron/services/smoke-test.ts; a unit test pins the two.
 */
const ELECTRON_VERSION_KEY = 'electron=';

/**
 * The Electron version the app reported, or null when it reported none. Only
 * the token right after the marker counts, so another line that happens to
 * mention `electron=` cannot stand in for the app's own report.
 *
 * @param {string} text
 * @returns {string | null}
 */
export function reportedElectronVersion(text) {
  const prefix = `${SMOKE_TEST_OK_MARKER} ${ELECTRON_VERSION_KEY}`;
  const start = text.indexOf(prefix);
  if (start === -1) return null;
  const version = text.slice(start + prefix.length).split(/\s/, 1)[0];
  return version === '' ? null : version;
}

/**
 * The Electron version a release must package: apps/desktop's devDependency,
 * which has to be an exact version. electron-builder reads that same spec (the
 * hoisted linker leaves no apps/desktop/node_modules/electron to read instead),
 * and a range would mean the tests and the release could run different
 * runtimes -- the CASA I-4 finding, where a stale `build.electronVersion`
 * packaged Electron 43.2.0 for eight releases while every test ran on 44.
 *
 * @param {{ devDependencies?: Record<string, string> }} desktopPackageJson
 * @returns {string}
 */
export function expectedElectronVersion(desktopPackageJson) {
  const spec = desktopPackageJson?.devDependencies?.electron;
  if (typeof spec !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(spec)) {
    throw new Error(
      `apps/desktop/package.json must pin devDependencies.electron to an exact version, not ${JSON.stringify(spec ?? null)}: the smoke launch checks the packaged runtime against it.`,
    );
  }
  return spec;
}

/**
 * @typedef {object} SmokeRunOutcome
 * @property {number | null} code Exit code, or null when killed by a signal.
 * @property {string | null} signal Signal that killed it, if any.
 * @property {boolean} timedOut Whether the launcher gave up waiting.
 * @property {string} output Everything the process wrote to stdout and stderr.
 * @property {string | null} markerText What the app wrote to its marker file, or
 *   null when it wrote none.
 * @property {number} timeoutMs How long it was given, for the message.
 * @property {string} expectedElectron The exact Electron version
 *   apps/desktop/package.json pins ({@link expectedElectronVersion}).
 */

/**
 * @param {SmokeRunOutcome} outcome
 * @returns {{ ok: boolean, reason: string }}
 */
export function evaluateSmokeRun(outcome) {
  const { code, signal, timedOut, output, markerText, timeoutMs, expectedElectron } = outcome;

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
  if (markerText === null && !output.includes(SMOKE_TEST_OK_MARKER)) {
    return {
      ok: false,
      reason: `the app exited 0 but never reported ${SMOKE_TEST_OK_MARKER}, so it quit before reaching the point where the database module loads.`,
    };
  }
  // The marker file first: Windows GUI binaries may print nothing at all.
  const electron = reportedElectronVersion(markerText ?? '') ?? reportedElectronVersion(output);
  if (electron === null) {
    return {
      ok: false,
      reason: `the app started but never reported which Electron it runs, so nothing shows this build packaged Electron ${expectedElectron}.`,
    };
  }
  if (electron !== expectedElectron) {
    return {
      ok: false,
      reason: `the app runs Electron ${electron}, but apps/desktop/package.json pins electron ${expectedElectron}: the build packaged a different runtime from the one every test ran on.`,
    };
  }
  return { ok: true, reason: `the packaged app started on Electron ${electron} and loaded its native SQLite module.` };
}
