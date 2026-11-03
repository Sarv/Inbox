/**
 * Build-time string replacements shared by the main, preload and renderer
 * bundles.
 *
 *  - OAuth client registrations (Google, Microsoft, Yahoo): inlined so a
 *    shipped app (which carries no .env) still has those sign-ins.
 *    Non-confidential per the providers' installed-app docs (Microsoft's is a
 *    public client: no secret). A RELEASE bundle always defines every one of
 *    them, empty when unset, so `process.env.NAME` is replaced at build time
 *    and a client registration can never come from the environment the app
 *    is launched in (the same class as CASA L-3). A dev bundle leaves an unset
 *    key out, so the runtime .env still applies.
 *  - Sentry DSN: public by design (safe to embed in a client). ALWAYS defined
 *    (empty when unset) so renderer code can read process.env.* without a
 *    ReferenceError in the browser, and Sentry stays inert without a DSN.
 *  - Build mode: so a release bundle knows it is one whatever its environment
 *    says (dev-mode.ts isReleaseBundle — CASA L-3).
 *  - App version: exposed so the renderer can tag the Sentry release.
 *
 * NOT inlined: the Sarv URLs/client, which dev.sh toggles to localhost at
 * runtime; release bundles ignore those overrides at runtime instead
 * (oauth-service.ts sarvEnvOverrides) and use the hardcoded production
 * defaults.
 */

/** The OAuth client values a release takes only from its build. */
export const BUILD_TIME_OAUTH_KEYS = [
  'SARVINBOX_GOOGLE_CLIENT_ID',
  'SARVINBOX_GOOGLE_CLIENT_SECRET',
  'SARVINBOX_MICROSOFT_CLIENT_ID',
  'SARVINBOX_YAHOO_CLIENT_ID',
] as const;

export function buildDefines(
  mode: string,
  env: Record<string, string | undefined>,
  appVersion: string
): Record<string, string> {
  const release = mode === 'production';
  const defines: Record<string, string> = {};
  for (const key of BUILD_TIME_OAUTH_KEYS) {
    if (release || env[key]) defines[`process.env.${key}`] = JSON.stringify(env[key] ?? '');
  }
  defines['process.env.SARVINBOX_SENTRY_DSN'] = JSON.stringify(env.SARVINBOX_SENTRY_DSN ?? '');
  defines['process.env.SARVINBOX_BUILD_MODE'] = JSON.stringify(mode);
  defines['process.env.SARVINBOX_APP_VERSION'] = JSON.stringify(appVersion);
  return defines;
}
