import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  BUILD_TIME_OAUTH_KEYS,
  DEFINED_ENV_NAMES,
  buildDefines,
  definedNamesFor,
  loadBuildEnv,
  type DefineTarget,
} from '../../../vite/build-defines';

/**
 * CASA I-3: one shared `define` map used to go to every bundle, the renderer
 * included, so the Google client secret was one renderer-side
 * `process.env.SARVINBOX_GOOGLE_CLIENT_SECRET` away from being pasted into the
 * page bundle. These pin which bundle receives which build-time value.
 */

const FULL_ENV = {
  SARVINBOX_GOOGLE_CLIENT_ID: 'gid.apps.googleusercontent.com',
  SARVINBOX_GOOGLE_CLIENT_SECRET: 'GOCSPX-test-secret',
  SARVINBOX_MICROSOFT_CLIENT_ID: 'ms-app-id',
  SARVINBOX_YAHOO_CLIENT_ID: 'yahoo-app-id',
  SARVINBOX_SENTRY_DSN: 'https://public@example.ingest.sentry.io/1',
};
const inputs = (env: Record<string, string | undefined> = FULL_ENV, mode = 'production') => ({
  env,
  mode,
  appVersion: '9.8.7',
});
const key = (name: string): string => `process.env.${name}`;

describe('buildDefines — renderer', () => {
  // Breaks: the OAuth values reach the renderer build again, and the next
  // renderer file that reads one inlines the secret into the page bundle.
  it('never receives an OAuth value, even when every one is set', () => {
    const defines = buildDefines('renderer', inputs());
    for (const name of BUILD_TIME_OAUTH_KEYS) expect(defines).not.toHaveProperty(key(name));
    expect(JSON.stringify(defines)).not.toContain('GOCSPX-');
  });

  // Breaks: renderer Sentry loses its DSN or release tag (src/sentry.ts), or a
  // new name slips into the renderer without anyone deciding it should.
  it('gets exactly the DSN, the build mode and the app version', () => {
    expect(buildDefines('renderer', inputs())).toEqual({
      [key('SARVINBOX_SENTRY_DSN')]: JSON.stringify(FULL_ENV.SARVINBOX_SENTRY_DSN),
      [key('SARVINBOX_BUILD_MODE')]: '"production"',
      [key('SARVINBOX_APP_VERSION')]: '"9.8.7"',
    });
  });

  // Breaks: with no DSN the name is left undefined, so the browser build reads
  // a real `process.env` it does not have instead of a harmless empty string.
  it('defines the DSN as an empty string when none is configured', () => {
    expect(buildDefines('renderer', inputs({}))[key('SARVINBOX_SENTRY_DSN')]).toBe('""');
  });
});

describe('buildDefines — main', () => {
  // Breaks: a shipped app (no .env) has no Gmail, Outlook or Yahoo sign-in.
  it('receives every OAuth value that is set', () => {
    const defines = buildDefines('main', inputs());
    for (const name of BUILD_TIME_OAUTH_KEYS) {
      expect(defines[key(name)]).toBe(JSON.stringify(FULL_ENV[name]));
    }
  });

  // CASA 6.7.1 / L-3 class. Breaks: a release built without one of these set
  // leaves `process.env.NAME` in the bundle, so whoever launches the app can
  // swap in their own OAuth client registration through the environment.
  it('defines every OAuth client value in a release bundle, empty when unset', () => {
    const defines = buildDefines('main', inputs({}));
    for (const name of BUILD_TIME_OAUTH_KEYS) expect(defines[key(name)]).toBe('""');
  });

  // Breaks: a dev bundle inlines "" for an unset (or blank) key, so a client id
  // supplied in the developer's runtime environment is ignored.
  it('leaves unset or empty OAuth keys out of a dev bundle, and inlines the set ones', () => {
    const defines = buildDefines(
      'main',
      inputs({ SARVINBOX_YAHOO_CLIENT_ID: 'yid', SARVINBOX_GOOGLE_CLIENT_SECRET: '' }, 'development'),
    );
    expect(defines[key('SARVINBOX_YAHOO_CLIENT_ID')]).toBe('"yid"');
    expect(defines).not.toHaveProperty(key('SARVINBOX_GOOGLE_CLIENT_ID'));
    expect(defines).not.toHaveProperty(key('SARVINBOX_GOOGLE_CLIENT_SECRET'));
    expect(defines).not.toHaveProperty(key('SARVINBOX_MICROSOFT_CLIENT_ID'));
  });

  // Breaks: dev-mode.ts isReleaseBundle reads the real environment in a
  // release build, and the dev-server URL is honoured again (CASA L-3); or main
  // Sentry goes inert in a release.
  it('carries the build mode and the DSN, and not the renderer-only app version', () => {
    const defines = buildDefines('main', inputs(FULL_ENV, 'development'));
    expect(defines[key('SARVINBOX_BUILD_MODE')]).toBe('"development"');
    expect(defines[key('SARVINBOX_SENTRY_DSN')]).toBe(JSON.stringify(FULL_ENV.SARVINBOX_SENTRY_DSN));
    expect(defines).not.toHaveProperty(key('SARVINBOX_APP_VERSION'));
  });

  // Breaks: a value with a quote or backslash ends the string literal early
  // and becomes code in the bundle, instead of staying data.
  it('JSON-encodes every value, so it is pasted as a string literal', () => {
    const defines = buildDefines('main', inputs({ SARVINBOX_GOOGLE_CLIENT_ID: 'a"b\\c' }));
    expect(defines[key('SARVINBOX_GOOGLE_CLIENT_ID')]).toBe('"a\\"b\\\\c"');
  });
});

describe('buildDefines — workers', () => {
  // Breaks: the VACUUM and extension-sandbox bundles (which read none of
  // these) carry the OAuth secret for no reason.
  it('gets nothing', () => {
    expect(buildDefines('worker', inputs())).toEqual({});
    expect(definedNamesFor('worker')).toEqual([]);
  });
});

/**
 * Every `process.env.SARVINBOX_*` read in a bundle's source must be one the
 * table gives that bundle. Breaks (in either direction):
 *  - renderer code starts reading the secret: this fails instead of the build
 *    silently leaving it undefined, or a later "fix" handing it the secret;
 *  - main starts reading a name the table only gives the renderer, which a
 *    release build would then read from its real (empty) environment.
 * Only names this module defines are checked; names it never inlines (the Sarv
 * URLs) are read from the runtime environment.
 */
describe('the table matches what each bundle reads', () => {
  const desktop = fileURLToPath(new URL('../../../', import.meta.url));
  const READ = /process\.env\.(SARVINBOX_[A-Z0-9_]+)/g;

  const sourceFiles = (dir: string, skip: (rel: string) => boolean = () => false): string[] =>
    (readdirSync(join(desktop, dir), { recursive: true, encoding: 'utf8' }) as string[])
      .filter((rel) => /\.(ts|tsx)$/.test(rel) && !rel.includes('.test.') && !skip(rel))
      .map((rel) => join(desktop, dir, rel));

  const definedNamesRead = (files: string[]): Set<string> => {
    const names = new Set<string>();
    for (const file of files) {
      for (const [, name] of readFileSync(file, 'utf8').matchAll(READ)) {
        if (DEFINED_ENV_NAMES.includes(name)) names.add(name);
      }
    }
    return names;
  };

  const bundles: Array<{ target: DefineTarget; files: () => string[] }> = [
    { target: 'renderer', files: () => sourceFiles('src') },
    {
      target: 'main',
      files: () => sourceFiles('electron', (rel) => rel.startsWith('workers') || rel === 'preload.ts'),
    },
    { target: 'worker', files: () => sourceFiles('electron/workers') },
  ];

  for (const { target, files } of bundles) {
    it(`${target}: every defined name it reads is in its own define map`, () => {
      const list = files();
      expect(list.length).toBeGreaterThan(0);
      const allowed = new Set(definedNamesFor(target));
      expect([...definedNamesRead(list)].filter((name) => !allowed.has(name))).toEqual([]);
    });
  }

  // Breaks: the scan above finds nothing because its pattern or paths went
  // stale, and the three checks pass vacuously.
  it('actually sees the reads it is meant to police', () => {
    expect([...definedNamesRead(sourceFiles('src'))].sort()).toEqual([
      'SARVINBOX_APP_VERSION',
      'SARVINBOX_SENTRY_DSN',
    ]);
    expect(definedNamesRead(sourceFiles('electron')).has('SARVINBOX_GOOGLE_CLIENT_SECRET')).toBe(true);
  });
});

/**
 * vite-plugin-electron keeps each entry's config inside its plugin closure, so
 * the nested `define`s can only be read from the source. Breaks: an entry is
 * handed another bundle's map (a worker given main's, which carries the
 * secret), or the main entry loses its map and with it OAuth and the build mode.
 * The top-level (renderer) map is checked on the evaluated config in
 * forbid-secrets-in-renderer.test.ts.
 */
describe('vite.config.ts hands each Electron entry its own map', () => {
  it('main gets main, the VACUUM and sandbox workers get the worker map, the others none', () => {
    const viteConfig = readFileSync(new URL('../../../vite.config.ts', import.meta.url), 'utf8');
    // The Electron entries all come before the first renderer-only plugin.
    const electronPart = viteConfig.slice(0, viteConfig.indexOf('browserSafeBuiltinsPlugin(__dirname),'));
    const entries = electronPart
      .split("entry: '")
      .slice(1)
      .map((chunk) => ({
        entry: chunk.slice(0, chunk.indexOf("'")),
        define: /define: definesFor\('(\w+)', mode\)/.exec(chunk)?.[1] ?? null,
        otherDefine: /define: (?!definesFor\()/.test(chunk),
      }));
    expect(entries).toEqual([
      { entry: 'electron/main.ts', define: 'main', otherDefine: false },
      { entry: 'electron/workers/db-compact.worker.ts', define: 'worker', otherDefine: false },
      { entry: 'electron/services/assistant-attachment-extract.worker.ts', define: null, otherDefine: false },
      { entry: 'electron/workers/extension-sandbox.worker.ts', define: 'worker', otherDefine: false },
      { entry: 'electron/preload.ts', define: null, otherDefine: false },
    ]);
  });
});

describe('loadBuildEnv', () => {
  let dir: string | null = null;
  afterEach(() => {
    vi.unstubAllEnvs();
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  // Breaks: the release build (secrets arrive as SARVINBOX_* environment
  // variables, no .env) or a local build (.env at the repo root) loses its
  // OAuth values, and the shipped app has no Gmail sign-in.
  it('merges SARVINBOX_* from the .env files and the process environment, and nothing else', () => {
    dir = mkdtempSync(join(tmpdir(), 'build-env-'));
    writeFileSync(
      join(dir, '.env'),
      'SARVINBOX_GOOGLE_CLIENT_ID=from-dotenv\nUNRELATED_SECRET=nope\n',
    );
    vi.stubEnv('SARVINBOX_GOOGLE_CLIENT_SECRET', 'from-process-env');
    const env = loadBuildEnv('production', dir);
    expect(env.SARVINBOX_GOOGLE_CLIENT_ID).toBe('from-dotenv');
    expect(env.SARVINBOX_GOOGLE_CLIENT_SECRET).toBe('from-process-env');
    expect(env).not.toHaveProperty('UNRELATED_SECRET');
  });
});
