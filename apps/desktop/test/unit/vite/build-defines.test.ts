import { describe, expect, it } from 'vitest';

import { BUILD_TIME_OAUTH_KEYS, buildDefines } from '../../../vite/build-defines';

const VERSION = '1.2.3';

describe('buildDefines', () => {
  // CASA 6.7.1 / L-3 class. Breaks: a release built without one of these set
  // leaves `process.env.NAME` in the bundle, so whoever launches the app can
  // swap in their own OAuth client registration through the environment.
  it('defines every OAuth client value in a release bundle, empty when unset', () => {
    const defines = buildDefines('production', {}, VERSION);
    for (const key of BUILD_TIME_OAUTH_KEYS) {
      expect(defines[`process.env.${key}`]).toBe('""');
    }
  });

  // Breaks: a release stops carrying the client id it was built with, and
  // Gmail sign-in disappears from shipped builds.
  it('inlines the values a release was built with', () => {
    const defines = buildDefines(
      'production',
      { SARVINBOX_GOOGLE_CLIENT_ID: 'gid', SARVINBOX_MICROSOFT_CLIENT_ID: 'mid' },
      VERSION
    );
    expect(defines['process.env.SARVINBOX_GOOGLE_CLIENT_ID']).toBe('"gid"');
    expect(defines['process.env.SARVINBOX_MICROSOFT_CLIENT_ID']).toBe('"mid"');
    expect(defines['process.env.SARVINBOX_YAHOO_CLIENT_ID']).toBe('""');
  });

  // Breaks: a dev bundle inlines "" for an unset key, so a client id supplied
  // in the developer's runtime environment is ignored.
  it('leaves unset OAuth keys out of a dev bundle, and inlines the set ones', () => {
    const defines = buildDefines('development', { SARVINBOX_YAHOO_CLIENT_ID: 'yid' }, VERSION);
    expect(defines['process.env.SARVINBOX_YAHOO_CLIENT_ID']).toBe('"yid"');
    expect('process.env.SARVINBOX_GOOGLE_CLIENT_ID' in defines).toBe(false);
    expect('process.env.SARVINBOX_GOOGLE_CLIENT_SECRET' in defines).toBe(false);
    expect('process.env.SARVINBOX_MICROSOFT_CLIENT_ID' in defines).toBe(false);
  });

  // Breaks: renderer code reading process.env.SARVINBOX_SENTRY_DSN throws a
  // ReferenceError in the browser, or the release/version tags go missing.
  it('always defines the Sentry DSN, the build mode and the app version', () => {
    for (const mode of ['production', 'development']) {
      const defines = buildDefines(mode, {}, VERSION);
      expect(defines['process.env.SARVINBOX_SENTRY_DSN']).toBe('""');
      expect(defines['process.env.SARVINBOX_BUILD_MODE']).toBe(JSON.stringify(mode));
      expect(defines['process.env.SARVINBOX_APP_VERSION']).toBe('"1.2.3"');
    }
  });
});
