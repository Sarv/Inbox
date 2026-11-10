import { loadEnv } from 'vite';

/**
 * Build-time `process.env.*` replacements, and WHICH BUNDLE each one may enter.
 *
 * Vite's `define` pastes a value into every bundle whose config carries it,
 * whether or not that bundle reads it. One shared map used to go to all of
 * them, so the Google client secret was handed to the RENDERER build too
 * (CASA I-3). No renderer file read it, so nothing was inlined, but a single
 * future `process.env.SARVINBOX_GOOGLE_CLIENT_SECRET` in renderer code would
 * have put it in the page bundle without any warning. Each bundle now gets only
 * the names its own code reads; `forbidSecretsInRenderer` is the build-time
 * backstop if that ever slips.
 *
 *  - OAuth client registrations (Google, Microsoft, Yahoo; main only,
 *    `oauth-service.ts`): inlined so a shipped app, which carries no .env, still
 *    has those sign-ins. Microsoft's is a public client with no secret. Google's
 *    installed-app secret can be read by anyone who unpacks app.asar, and
 *    Google's installed-app guidance says it cannot be kept confidential. It is
 *    still not something to spread: it goes only to the process that uses it,
 *    never to the renderer, which shows web content.
 *    A RELEASE bundle defines every one of them, empty when unset, so
 *    `process.env.NAME` is replaced at build time and a client registration can
 *    never come from the environment the app is launched in (the same class as
 *    CASA L-3). A dev bundle leaves an unset key out, so the runtime .env still
 *    applies.
 *  - Sentry DSN (main and renderer): public by design, safe in a client.
 *    ALWAYS defined, empty when unset, so `process.env.SARVINBOX_SENTRY_DSN`
 *    is never left to the browser and Sentry stays inert without a DSN.
 *  - Build mode (main and renderer): lets a release bundle know it is one,
 *    whatever its environment says (`dev-mode.ts` isReleaseBundle, CASA L-3).
 *  - App version (renderer): tags the renderer's Sentry release. Main reads
 *    `app.getVersion()` instead.
 *
 * NOT inlined: the Sarv URLs/client, which dev.sh switches to localhost at
 * runtime; release bundles ignore those overrides at runtime instead
 * (oauth-service.ts sarvEnvOverrides) and use the hardcoded production defaults.
 *
 * The VACUUM and extension-sandbox workers read none of these, so they get an
 * empty map. The preload and the attachment-extraction worker get no `define`.
 */

/** A bundle vite.config.ts builds with its own `define` map. */
export type DefineTarget = 'main' | 'renderer' | 'worker';

/** What a define's value is computed from. */
export interface BuildDefineInputs {
  /** `SARVINBOX_*` values from the repo's .env files and the environment (see {@link loadBuildEnv}). */
  env: Readonly<Record<string, string | undefined>>;
  /** Vite mode; `production` for a release build. */
  mode: string;
  /** apps/desktop/package.json `version`. */
  appVersion: string;
}

interface DefineSpec {
  /** The bundles whose code reads this name. No other bundle gets it. */
  readers: readonly DefineTarget[];
  /** The value, or undefined to leave the name undefined. */
  value: (inputs: BuildDefineInputs) => string | undefined;
}

/** The OAuth client values. Main reads them; the renderer must never receive them. */
export const BUILD_TIME_OAUTH_KEYS = [
  'SARVINBOX_GOOGLE_CLIENT_ID',
  'SARVINBOX_GOOGLE_CLIENT_SECRET',
  'SARVINBOX_MICROSOFT_CLIENT_ID',
  'SARVINBOX_YAHOO_CLIENT_ID',
] as const;

/** An OAuth value: in a release always defined; in dev only when set, so the runtime .env still applies. */
const oauthValue =
  (name: string) =>
  ({ env, mode }: BuildDefineInputs): string | undefined =>
    mode === 'production' ? (env[name] ?? '') : env[name] || undefined;

const OAUTH_DEFINES: Readonly<Record<string, DefineSpec>> = Object.fromEntries(
  BUILD_TIME_OAUTH_KEYS.map((name) => [name, { readers: ['main'], value: oauthValue(name) } satisfies DefineSpec]),
);

const DEFINES: Readonly<Record<string, DefineSpec>> = {
  ...OAUTH_DEFINES,
  SARVINBOX_SENTRY_DSN: { readers: ['main', 'renderer'], value: ({ env }) => env.SARVINBOX_SENTRY_DSN ?? '' },
  SARVINBOX_BUILD_MODE: { readers: ['main', 'renderer'], value: ({ mode }) => mode },
  SARVINBOX_APP_VERSION: { readers: ['renderer'], value: ({ appVersion }) => appVersion },
};

/** Every name this module can define, whichever bundle it goes to. */
export const DEFINED_ENV_NAMES: readonly string[] = Object.keys(DEFINES);

/** The names `target` is allowed to receive (set or not). */
export function definedNamesFor(target: DefineTarget): string[] {
  return DEFINED_ENV_NAMES.filter((name) => DEFINES[name].readers.includes(target));
}

/** The `define` map for one bundle: only the names its own code reads. */
export function buildDefines(target: DefineTarget, inputs: BuildDefineInputs): Record<string, string> {
  const defines: Record<string, string> = {};
  for (const name of definedNamesFor(target)) {
    const value = DEFINES[name].value(inputs);
    if (value !== undefined) defines[`process.env.${name}`] = JSON.stringify(value);
  }
  return defines;
}

/**
 * The `SARVINBOX_*` build environment: the repo-root .env files merged with
 * `SARVINBOX_*` variables from the process environment, which is how the
 * release workflow passes its secrets in.
 *
 * @param mode Vite mode (picks `.env.<mode>` files).
 * @param repoRoot Absolute path of the monorepo root, where `.env` lives.
 */
export function loadBuildEnv(mode: string, repoRoot: string): Record<string, string> {
  return loadEnv(mode, repoRoot, 'SARVINBOX');
}
