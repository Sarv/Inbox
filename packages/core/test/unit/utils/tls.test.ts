import { describe, it, expect } from 'vitest';

import { resolveTlsOptions } from '../../../src/utils/tls';
import type { TlsResolvable } from '../../../src/utils/tls';

// SECURITY BOUNDARY. This function is the ONLY place that decides whether a mail
// connection verifies its certificate. `rejectUnauthorized: false` used to be
// copy-pasted across the SMTP client, both IPC handlers and several UI config
// builders — which is exactly how an insecure default spreads unnoticed. Every
// test below asserts one direction of "secure unless the user explicitly opted
// out", plus the TLS 1.2 floor.

describe('resolveTlsOptions — secure by default', () => {
  it('verifies certificates for a bare config', () => {
    expect(resolveTlsOptions({})).toEqual({ rejectUnauthorized: true, minVersion: 'TLSv1.2' });
  });

  it('verifies certificates when allowInsecureTLS is undefined or false', () => {
    expect(resolveTlsOptions({ allowInsecureTLS: undefined }).rejectUnauthorized).toBe(true);
    expect(resolveTlsOptions({ allowInsecureTLS: false }).rejectUnauthorized).toBe(true);
  });

  // Changed deliberately (renderer-supplied TLS relaxation): this used to pin
  // that an empty `tlsOptions` kept verification on, because a set
  // `tlsOptions.rejectUnauthorized` won over everything. That override came in
  // from the renderer with the rest of the config, so it is gone: no
  // `tlsOptions` value can turn verification off. Breaks: a compromised window
  // sends `tlsOptions: { rejectUnauthorized: false }` and main dials the user's
  // saved password to whoever answers.
  it('ignores a tlsOptions override in either direction', () => {
    const off = { tlsOptions: { rejectUnauthorized: false } } as unknown as TlsResolvable;
    expect(resolveTlsOptions(off).rejectUnauthorized).toBe(true);
    const on = { allowInsecureTLS: true, tlsOptions: { rejectUnauthorized: true } } as unknown as TlsResolvable;
    expect(resolveTlsOptions(on).rejectUnauthorized).toBe(false);
  });

  // Changed deliberately (renderer-supplied TLS relaxation): this used to test
  // non-boolean `tlsOptions.rejectUnauthorized` values; it now tests the opt-in
  // itself, which used to be read as truthy. Settings round-trip through
  // JSON/IPC and can arrive as strings. Breaks: a stored "false" (truthy)
  // turns verification off.
  it('only the boolean true opts out — "true", "false", 1 and {} do not', () => {
    for (const value of ['true', 'false', 1, {}]) {
      const config = { allowInsecureTLS: value } as unknown as TlsResolvable;
      expect(resolveTlsOptions(config).rejectUnauthorized).toBe(true);
    }
  });

  // An OAuth token never goes over an unverified connection (the audit's
  // "known issue"). Every provider has a public certificate, so nothing
  // legitimate needs the opt-in. Breaks: a config carrying allowInsecureTLS —
  // stale, or from a compromised window — hands the Gmail token to a
  // man-in-the-middle.
  it('always verifies for an OAuth sign-in, whatever the config says', () => {
    expect(resolveTlsOptions({ authMethod: 'oauth2', allowInsecureTLS: true }).rejectUnauthorized).toBe(true);
    expect(resolveTlsOptions({ authMethod: 'password', allowInsecureTLS: true }).rejectUnauthorized).toBe(false);
  });
});

describe('resolveTlsOptions — explicit opt-out', () => {
  // The per-account escape hatch for self-signed corporate servers. It must work
  // (users depend on it) but only when deliberately set.
  it('disables verification when the account opted into allowInsecureTLS', () => {
    expect(resolveTlsOptions({ allowInsecureTLS: true }).rejectUnauthorized).toBe(false);
  });
});

describe('resolveTlsOptions — protocol floor', () => {
  // Pinned regardless of what the Node/OpenSSL runtime default is, so the
  // connection can never negotiate down to SSLv3 / TLS 1.0 / 1.1.
  // Changed deliberately (renderer-supplied TLS relaxation): the third case
  // used a tlsOptions override, which no longer exists; it is an OAuth config now.
  it('always pins minVersion to TLSv1.2, even when verification is disabled', () => {
    expect(resolveTlsOptions({}).minVersion).toBe('TLSv1.2');
    expect(resolveTlsOptions({ allowInsecureTLS: true }).minVersion).toBe('TLSv1.2');
    expect(resolveTlsOptions({ authMethod: 'oauth2' }).minVersion).toBe('TLSv1.2');
  });

  // Callers spread the result straight into an ImapFlow/nodemailer config, so the
  // shape must stay exactly these two keys.
  it('returns only the two TLS keys it owns', () => {
    expect(Object.keys(resolveTlsOptions({})).sort()).toEqual(['minVersion', 'rejectUnauthorized']);
  });
});
