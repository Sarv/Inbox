#!/usr/bin/env node
/*
 * Start a packaged build and fail the release if it cannot start.
 *
 * Run by .github/workflows/release.yml on each platform's own runner, after
 * electron-builder packs the app. See scripts/lib/smoke-run.mjs for why:
 * every check before this one read the artifact, and reading a binary cannot
 * tell you it runs. v1.2.2 was signed, verified, uploaded and dead on launch.
 *
 * The app cooperates: SARV_SMOKE_TEST=1 makes it boot, prove the native SQLite
 * module loads, print a marker, and exit 0 without touching a database (see
 * apps/desktop/electron/services/smoke-test.ts).
 *
 * Usage:
 *   node scripts/smoke-launch.mjs <path-to-app-binary> [--timeout=120]
 *
 * Examples:
 *   node scripts/smoke-launch.mjs apps/desktop/release/linux-unpacked/sarv-inbox
 *   node scripts/smoke-launch.mjs "apps/desktop/release/win-unpacked/Sarv Inbox.exe"
 *
 * Linux needs a display even to reach app.whenReady, so the workflow runs this
 * under xvfb-run.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SMOKE_TEST_OK_MARKER, evaluateSmokeRun, smokeLaunchArgs } from './lib/smoke-run.mjs';

/** Long enough for a cold first start on a loaded runner, short enough to fail a hang. */
const DEFAULT_TIMEOUT_MS = 120_000;

/** Tail of the app's own output shown on failure, in characters. */
const OUTPUT_TAIL = 4000;

/**
 * @param {string[]} args
 * @returns {{ binary: string | null, timeoutMs: number }}
 */
function parseArgs(args) {
  /** @type {string | null} */
  let binary = null;
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  for (const arg of args) {
    const flag = /^--timeout=(\d+)$/.exec(arg);
    if (flag) timeoutMs = Number(flag[1]) * 1000;
    else if (binary === null) binary = arg;
  }
  return { binary, timeoutMs };
}

/**
 * @param {string} binary
 * @param {number} timeoutMs
 * @returns {Promise<number>} Process exit code.
 */
async function run(binary, timeoutMs) {
  if (!existsSync(binary)) {
    console.error(`FAIL: no packaged app at ${binary} — nothing was started.`);
    return 1;
  }

  // A private userData dir keeps the run from adopting (or leaving behind) any
  // state on the runner, so a second smoke run is identical to the first.
  const scratch = mkdtempSync(join(tmpdir(), 'sarv-smoke-'));
  const markerFile = join(scratch, 'ok');

  try {
    const outcome = await new Promise((resolve) => {
      const child = spawn(binary, smokeLaunchArgs(process.platform), {
        env: {
          ...process.env,
          SARV_SMOKE_TEST: '1',
          SARV_SMOKE_TEST_FILE: markerFile,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let output = '';
      /** @param {Buffer} chunk */
      const collect = (chunk) => {
        output += chunk.toString();
      };
      child.stdout.on('data', collect);
      child.stderr.on('data', collect);

      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve({ code: null, signal: 'SIGKILL', timedOut: true, output, markerFileFound: existsSync(markerFile), timeoutMs });
      }, timeoutMs);
      timer.unref?.();

      child.on('error', (error) => {
        clearTimeout(timer);
        resolve({ code: 1, signal: null, timedOut: false, output: `${output}\n${error.message}`, markerFileFound: false, timeoutMs });
      });
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        resolve({ code, signal, timedOut: false, output, markerFileFound: existsSync(markerFile), timeoutMs });
      });
    });

    const { ok, reason } = evaluateSmokeRun(outcome);
    if (!ok) {
      console.error(`FAIL: ${binary}`);
      console.error(`      ${reason}`);
      console.error('');
      console.error('--- app output (tail) ---');
      console.error(outcome.output.slice(-OUTPUT_TAIL) || '(the app printed nothing at all)');
      console.error('--- end ---');
      console.error('');
      console.error('Do not publish this build: it fails the same way on a user machine, and');
      console.error('an app that cannot open its database looks like one with no mail.');
      return 1;
    }

    console.log(`OK: ${reason} (${SMOKE_TEST_OK_MARKER})`);
    return 0;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

const { binary, timeoutMs } = parseArgs(process.argv.slice(2));
if (binary === null) {
  console.error('usage: node scripts/smoke-launch.mjs <path-to-app-binary> [--timeout=120]');
  process.exit(2);
}
process.exit(await run(binary, timeoutMs));
