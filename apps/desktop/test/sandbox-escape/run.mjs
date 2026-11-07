#!/usr/bin/env node
/**
 * Builds the sandbox-escape harness and runs it in real Electron, from an app.asar.
 *
 *   pnpm --filter @sarvinbox/desktop test:sandbox-escape
 *
 * Needs a display on Linux (`xvfb-run -a ...`) and the Chromium sandbox working there,
 * because it is a release build and a release build refuses to run extensions without
 * one: that refusal is one of the things it checks. `@sarvinbox/core` must be built.
 * SANDBOX_ESCAPE_ELECTRON overrides the binary: use it on macOS to keep a crash here off
 * the dev app's bundle id, whose crash history makes macOS prompt on its next launch.
 */
import { spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'vite-plugin-electron';

const here = dirname(fileURLToPath(import.meta.url));
const desktop = resolve(here, '../..');
const require = createRequire(join(desktop, 'package.json'));
const { createPackage } = require('@electron/asar');

const work = mkdtempSync(join(tmpdir(), 'sarv-sandbox-escape-'));
const appDir = join(work, 'app');
mkdirSync(appDir, { recursive: true });

const buildEntry = (entry, external) =>
  build({
    entry,
    vite: {
      root: desktop,
      configFile: false,
      mode: 'production',
      logLevel: 'warn',
      define: { 'process.env.SARVINBOX_BUILD_MODE': '"production"' },
      build: { outDir: appDir, emptyOutDir: false, rollupOptions: { external, output: { codeSplitting: false } } },
    },
  });

// The same two entries vite.config.ts builds, and the harness in place of main.ts.
await buildEntry('electron/extension-sandbox/extension-sandbox-guest.ts', []);
await buildEntry('electron/extension-sandbox/extension-sandbox-preload.ts', ['electron']);
await buildEntry('test/sandbox-escape/harness.ts', ['electron', '@sarvinbox/core']);

// In the packaged app core is bundled into main; here it stays outside the archive.
writeFileSync(
  join(appDir, 'main.cjs'),
  `const Module = require('module');
process.env.NODE_PATH = ${JSON.stringify(join(desktop, 'node_modules'))};
Module._initPaths();
require('./harness.js');
`
);
writeFileSync(join(appDir, 'package.json'), JSON.stringify({ name: 'sarv-inbox-sandbox-escape', version: '1.0.0', main: 'main.cjs' }));

// A real archive: the Worker's script and the preload both have to load from inside one.
const asar = join(work, 'app.asar');
await createPackage(appDir, asar);
rmSync(appDir, { recursive: true, force: true });

function launch(scenario, extraArgs) {
  const electronCli = require.resolve('electron/cli.js');
  const override = process.env.SANDBOX_ESCAPE_ELECTRON;
  const [command, args] = override
    ? [override, [asar, ...extraArgs]]
    : [process.execPath, [electronCli, asar, ...extraArgs]];
  return new Promise((done) => {
    let output = '';
    // By whole lines: a chunk can end anywhere, and a FAILED split across two would not show.
    let partial = '';
    const child = spawn(command, process.platform === 'darwin' ? [...args, '-ApplePersistenceIgnoreState', 'YES'] : args, {
      env: {
        ...process.env,
        SANDBOX_ESCAPE_FIXTURES: join(here, 'fixtures'),
        SANDBOX_ESCAPE_WORK: join(work, scenario),
        SANDBOX_ESCAPE_SCENARIO: scenario,
      },
    });
    mkdirSync(join(work, scenario), { recursive: true });
    const timer = setTimeout(() => child.kill('SIGKILL'), 240_000);
    const onData = (chunk) => {
      output += chunk;
      const lines = (partial + chunk).split('\n');
      partial = lines.pop();
      for (const line of lines) {
        if (/^(ok |FAILED|skip |SANDBOX_ESCAPE)|\d+ FAILED/.test(line)) console.log(line);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      done({ code, signal, passed: output.includes('SANDBOX_ESCAPE_PASSED'), output });
    });
  });
}

let failed = false;
for (const [scenario, args] of [['escapes', []], ['availability', []], ['refusal', ['--no-sandbox']]]) {
  console.log(`\n=== ${scenario}`);
  const { code, signal, passed, output } = await launch(scenario, args);
  // Exit code too: a crash at quit is a failure, even with every check passed.
  if (!passed || code !== 0) {
    failed = true;
    console.error(`${scenario} failed: exit ${code}, signal ${signal}\n${output.split('\n').slice(-40).join('\n')}`);
  }
}

// The verdict first, and a failure to clean up is not one: on Windows a renderer can still
// hold a file here for a moment after the app is gone.
console.log(failed ? '\nThe extension sandbox did NOT hold.' : '\nThe extension sandbox held.');
try {
  rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
} catch (error) {
  console.warn(`Could not remove ${work}: ${error.message}`);
}
if (failed) process.exit(1);
