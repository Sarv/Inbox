import type { Plugin } from 'vite';

/**
 * Build-time guard: no OAuth client secret in the RENDERER bundle (CASA I-3).
 *
 * The renderer is the bundle that shows web content: email bodies, extension
 * panels, remote images. It never needs the Google client secret, and
 * vite/build-defines.ts no longer hands it one. This plugin is the backstop for
 * when that rule slips: a renderer `define` that grows the secret back, a
 * hard-coded test value, or a dependency that carries one. It fails the build
 * before anything is written to disk.
 *
 * Two rules:
 *  - the CONFIGURED secret value, when the build has one (a release build and
 *    a local build with a .env), anywhere in any emitted file;
 *  - any `GOCSPX-` string. Every Google client secret starts with that prefix,
 *    so this catches a secret even when the build itself has none configured,
 *    which is the case for CI's renderer-bundle-guard job.
 *
 * Scope: registered in the TOP-LEVEL vite `plugins` (and in
 * check-renderer-bundle.config.ts), which apply to the renderer build only. The
 * main-process build legitimately carries the secret and never sees this.
 */

/** Prefix of every Google OAuth client secret. */
export const GOOGLE_CLIENT_SECRET_PREFIX = 'GOCSPX-';

/** A secret value to look for, with the name the error message shows instead of it. */
export interface NamedSecret {
  name: string;
  value: string | undefined;
}

/** One emitted file, as raw bytes. */
export interface EmittedFile {
  fileName: string;
  content: Uint8Array;
}

/** A file that contains something it must not, and which rule matched. */
export interface SecretLeak {
  fileName: string;
  /** Describes the match without repeating the secret itself. */
  matched: string;
}

/** The secrets the renderer must never contain, from the `SARVINBOX_*` build env. */
export function rendererForbiddenSecrets(env: Readonly<Record<string, string | undefined>>): NamedSecret[] {
  return [{ name: 'SARVINBOX_GOOGLE_CLIENT_SECRET', value: env.SARVINBOX_GOOGLE_CLIENT_SECRET }];
}

/**
 * Every emitted file that contains a configured secret or a Google secret
 * prefix. Matching is on raw bytes, so binary assets are covered too and a
 * non-ASCII value is matched exactly. An unset or blank secret is skipped: it
 * would match everything.
 */
export function findSecretLeaks(files: Iterable<EmittedFile>, secrets: readonly NamedSecret[]): SecretLeak[] {
  const needles: Array<{ bytes: Buffer; matched: string }> = [];
  for (const { name, value } of secrets) {
    if (value === undefined || value.trim() === '') continue;
    needles.push({ bytes: Buffer.from(value, 'utf8'), matched: `the configured ${name} value` });
  }
  needles.push({
    bytes: Buffer.from(GOOGLE_CLIENT_SECRET_PREFIX, 'utf8'),
    matched: `a Google client secret ("${GOOGLE_CLIENT_SECRET_PREFIX}…")`,
  });

  const leaks: SecretLeak[] = [];
  for (const { fileName, content } of files) {
    const haystack = Buffer.from(content.buffer, content.byteOffset, content.byteLength);
    for (const { bytes, matched } of needles) {
      if (haystack.includes(bytes)) leaks.push({ fileName, matched });
    }
  }
  return leaks;
}

/** The output shape this plugin reads; rollup's and rolldown's bundles both fit it. */
type BundleOutput =
  | { type: 'chunk'; fileName: string; code: string }
  | { type: 'asset'; fileName: string; source: string | Uint8Array };

/** One bundle entry as bytes. */
export function emittedFileOf(output: BundleOutput): EmittedFile {
  const text = output.type === 'chunk' ? output.code : output.source;
  return {
    fileName: output.fileName,
    content: typeof text === 'string' ? Buffer.from(text, 'utf8') : text,
  };
}

/** The renderer-build guard plugin. */
export function forbidSecretsInRenderer(secrets: readonly NamedSecret[] = []): Plugin {
  return {
    name: 'forbid-secrets-in-renderer',
    apply: 'build',
    // After every other plugin has finished emitting (HTML, CSS, source maps),
    // so the check sees exactly what would be written.
    enforce: 'post',
    generateBundle(_options, bundle) {
      const files = Object.values(bundle).map((output) => emittedFileOf(output as BundleOutput));
      const leaks = findSecretLeaks(files, secrets);
      if (leaks.length === 0) return;
      this.error(
        'An OAuth client secret is in the RENDERER bundle:\n' +
          `${leaks.map(({ fileName, matched }) => `  - ${fileName}: ${matched}`).join('\n')}\n\n` +
          'The renderer shows web content and must never carry a client secret; only the ' +
          'main process reads it (electron/services/oauth-service.ts). Check that ' +
          "vite/build-defines.ts does not give the renderer the secret, that no renderer file reads it, " +
          'and that no test value was hard-coded. See apps/desktop/vite/forbid-secrets-in-renderer.ts.',
      );
    },
  };
}
