import type { Plugin } from 'vite';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { BUILD_TIME_OAUTH_KEYS } from '../../../vite/build-defines';
import {
  GOOGLE_CLIENT_SECRET_PREFIX,
  emittedFileOf,
  findSecretLeaks,
  forbidSecretsInRenderer,
  rendererForbiddenSecrets,
  type EmittedFile,
} from '../../../vite/forbid-secrets-in-renderer';

/**
 * CASA I-3: the renderer bundle must never carry the Google OAuth client
 * secret. This plugin fails the renderer build when it does; if these go red
 * the guard is silent and a leaked secret ships in the page bundle.
 */

const SECRET = 'plain-secret-without-the-google-prefix-123';
const file = (fileName: string, text: string): EmittedFile => ({ fileName, content: Buffer.from(text, 'utf8') });
const configured = [{ name: 'SARVINBOX_GOOGLE_CLIENT_SECRET', value: SECRET }];

describe('findSecretLeaks', () => {
  // Breaks: a release build (which has the real secret configured) ships it
  // in the renderer whenever the value lacks the usual prefix.
  it('finds the configured secret value', () => {
    expect(findSecretLeaks([file('assets/index.js', `const s="${SECRET}";`)], configured)).toEqual([
      { fileName: 'assets/index.js', matched: 'the configured SARVINBOX_GOOGLE_CLIENT_SECRET value' },
    ]);
  });

  // Breaks: CI's renderer-bundle-guard job, which runs with no secrets
  // configured, can no longer catch a hard-coded Google secret.
  it('finds a Google secret prefix with nothing configured', () => {
    expect(findSecretLeaks([file('assets/index.js', `x="${GOOGLE_CLIENT_SECRET_PREFIX}abc"`)], [])).toEqual([
      { fileName: 'assets/index.js', matched: `a Google client secret ("${GOOGLE_CLIENT_SECRET_PREFIX}…")` },
    ]);
  });

  // Breaks: one rule shadows the other, so a fix that removes one match
  // reports the file clean while the other is still in it.
  it('reports each rule that matched, in every file', () => {
    const leaks = findSecretLeaks(
      [file('a.js', `${GOOGLE_CLIENT_SECRET_PREFIX}${SECRET}`), file('b.js.map', SECRET), file('c.css', 'body{}')],
      configured,
    );
    expect(leaks.map(({ fileName }) => fileName)).toEqual(['a.js', 'a.js', 'b.js.map']);
  });

  // Breaks: a secret inside a binary asset (or a non-ASCII value) is missed
  // because the bytes were decoded before matching.
  it('matches raw bytes, including binary assets and non-ASCII values', () => {
    const unicode = 'sécret-ünïcode-value';
    const binary = new Uint8Array([0, 255, ...Buffer.from(unicode, 'utf8'), 0]);
    expect(findSecretLeaks([{ fileName: 'logo.png', content: binary }], [{ name: 'S', value: unicode }])).toHaveLength(1);
    // A view onto part of a larger buffer is read only within its own bounds.
    const backing = Buffer.from(`${SECRET}|clean`, 'utf8');
    const view = new Uint8Array(backing.buffer, backing.byteOffset + SECRET.length + 1, 5);
    expect(findSecretLeaks([{ fileName: 'v.js', content: view }], configured)).toEqual([]);
  });

  // Breaks: a build without the secret configured (CI, a fresh clone) fails on
  // every file, because an empty needle matches everything.
  it('ignores an unset or blank secret', () => {
    const files = [file('assets/index.js', 'console.log(1)')];
    for (const value of [undefined, '', '   ']) {
      expect(findSecretLeaks(files, [{ name: 'SARVINBOX_GOOGLE_CLIENT_SECRET', value }])).toEqual([]);
    }
  });

  // Breaks: the guard fails a clean renderer build and blocks every PR.
  it('passes a bundle that carries neither', () => {
    expect(findSecretLeaks([file('assets/index.js', 'export const a = 1;')], configured)).toEqual([]);
  });
});

describe('emittedFileOf', () => {
  // Breaks: chunks or one kind of asset are never scanned, so a secret in them
  // passes the guard.
  it('reads chunk code, string assets and binary assets as bytes', () => {
    expect(Buffer.from(emittedFileOf({ type: 'chunk', fileName: 'a.js', code: 'abc' }).content).toString()).toBe('abc');
    expect(Buffer.from(emittedFileOf({ type: 'asset', fileName: 'a.map', source: 'def' }).content).toString()).toBe('def');
    const bytes = new Uint8Array([1, 2, 3]);
    expect(emittedFileOf({ type: 'asset', fileName: 'a.png', source: bytes })).toEqual({ fileName: 'a.png', content: bytes });
  });
});

describe('rendererForbiddenSecrets', () => {
  // Breaks: the build env's secret never reaches the plugin, and only the
  // prefix rule is left.
  it('names the Google client secret from the build env', () => {
    expect(rendererForbiddenSecrets({ SARVINBOX_GOOGLE_CLIENT_SECRET: SECRET })).toEqual(configured);
    expect(rendererForbiddenSecrets({})).toEqual([{ name: 'SARVINBOX_GOOGLE_CLIENT_SECRET', value: undefined }]);
  });
});

/** Runs the plugin's generateBundle the way the bundler does, capturing this.error. */
function runGenerateBundle(plugin: Plugin, bundle: Record<string, unknown>): string | null {
  let message: string | null = null;
  const context = {
    error: (msg: string) => {
      message = msg;
      throw new Error(msg);
    },
  };
  const hook = plugin.generateBundle as unknown as (this: typeof context, options: unknown, bundle: unknown) => void;
  try {
    hook.call(context, {}, bundle);
  } catch {
    // this.error throws in a real build too; the message is what matters.
  }
  return message;
}

const leakingBundle = {
  'assets/index.js': { type: 'chunk', fileName: 'assets/index.js', code: `var s="${SECRET}"` },
  'assets/index.js.map': { type: 'asset', fileName: 'assets/index.js.map', source: `{"x":"${GOOGLE_CLIENT_SECRET_PREFIX}y"}` },
};

describe('forbidSecretsInRenderer', () => {
  // Breaks: the guard runs in the dev server (no bundle to scan) or before
  // other plugins finish emitting, so it misses late files such as source maps.
  it('runs on build only, after the other plugins', () => {
    const plugin = forbidSecretsInRenderer();
    expect(plugin.name).toBe('forbid-secrets-in-renderer');
    expect(plugin.apply).toBe('build');
    expect(plugin.enforce).toBe('post');
  });

  // Breaks: a leaking renderer build exits 0 and the secret ships.
  it('fails the build, naming each file and rule, without printing the secret', () => {
    const message = runGenerateBundle(forbidSecretsInRenderer(configured), leakingBundle);
    expect(message).toContain('assets/index.js: the configured SARVINBOX_GOOGLE_CLIENT_SECRET value');
    expect(message).toContain('assets/index.js.map: a Google client secret');
    // The error lands in CI logs; repeating the secret there would leak it again.
    expect(message).not.toContain(SECRET);
  });

  // Breaks: every clean renderer build fails.
  it('lets a clean bundle through', () => {
    const clean = { 'assets/index.js': { type: 'chunk', fileName: 'assets/index.js', code: 'var a=1' } };
    expect(runGenerateBundle(forbidSecretsInRenderer(configured), clean)).toBeNull();
  });
});

/**
 * Both renderer builds carry the guard, fed from the same build env. Breaks:
 * one build (the release `vite build`, or CI's renderer-bundle-guard) drops the
 * plugin or stops passing it the configured secret, or its renderer `define`
 * grows an OAuth value back.
 */
describe('wired into both renderer builds', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  type ConfigFn = (env: { mode: string; command: 'build' | 'serve' }) => { define?: Record<string, string>; plugins?: unknown[] };
  const configs: Array<[string, () => Promise<ConfigFn>]> = [
    ['vite.config.ts', async () => (await import('../../../vite.config')).default as unknown as ConfigFn],
    [
      'vite/check-renderer-bundle.config.ts',
      async () => (await import('../../../vite/check-renderer-bundle.config')).default as unknown as ConfigFn,
    ],
  ];

  for (const [label, load] of configs) {
    it(`${label}: no OAuth value in the renderer define, and the guard knows the configured secret`, async () => {
      vi.stubEnv('SARVINBOX_GOOGLE_CLIENT_ID', 'wired-id.apps.googleusercontent.com');
      vi.stubEnv('SARVINBOX_GOOGLE_CLIENT_SECRET', SECRET);
      vi.stubEnv('SARVINBOX_MICROSOFT_CLIENT_ID', 'wired-ms-id');
      const config = (await load())({ mode: 'production', command: 'build' });

      const define = config.define ?? {};
      for (const name of BUILD_TIME_OAUTH_KEYS) expect(define).not.toHaveProperty(`process.env.${name}`);
      expect(JSON.stringify(define)).not.toContain(SECRET);

      const plugins = (config.plugins ?? []).flat(3) as Plugin[];
      const guard = plugins.find((plugin) => plugin?.name === 'forbid-secrets-in-renderer');
      expect(guard).toBeDefined();
      const bundle = { 'assets/index.js': { type: 'chunk', fileName: 'assets/index.js', code: `"${SECRET}"` } };
      expect(runGenerateBundle(guard!, bundle)).toContain('the configured SARVINBOX_GOOGLE_CLIENT_SECRET value');
    });
  }
});
