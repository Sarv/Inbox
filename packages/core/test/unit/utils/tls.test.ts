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

  // An empty tlsOptions object (very common when a caller spreads a partial
  // config) must NOT be read as "no verification".
  it('verifies certificates when tlsOptions exists but sets no rejectUnauthorized', () => {
    expect(resolveTlsOptions({ tlsOptions: {} }).rejectUnauthorized).toBe(true);
    expect(resolveTlsOptions({ tlsOptions: { rejectUnauthorized: undefined } }).rejectUnauthorized).toBe(true);
  });

  // Settings round-trip through JSON/IPC and sometimes arrive as strings. Only a
  // real boolean `false` may disable verification — "false", 0 and null must not.
  it('ignores a non-boolean rejectUnauthorized and stays secure', () => {
    const asString = { tlsOptions: { rejectUnauthorized: 'false' } } as unknown as TlsResolvable;
    expect(resolveTlsOptions(asString).rejectUnauthorized).toBe(true);

    const asZero = { tlsOptions: { rejectUnauthorized: 0 } } as unknown as TlsResolvable;
    expect(resolveTlsOptions(asZero).rejectUnauthorized).toBe(true);

    const asNull = { tlsOptions: { rejectUnauthorized: null } } as unknown as TlsResolvable;
    expect(resolveTlsOptions(asNull).rejectUnauthorized).toBe(true);
  });
});

describe('resolveTlsOptions — explicit opt-out', () => {
  // The per-account escape hatch for self-signed corporate servers. It must work
  // (users depend on it) but only when deliberately set.
  it('disables verification when the account opted into allowInsecureTLS', () => {
    expect(resolveTlsOptions({ allowInsecureTLS: true }).rejectUnauthorized).toBe(false);
  });

  it('honours an explicit tlsOptions.rejectUnauthorized=false', () => {
    expect(resolveTlsOptions({ tlsOptions: { rejectUnauthorized: false } }).rejectUnauthorized).toBe(false);
  });

  // tlsOptions is the narrower, more explicit signal, so it must win both ways —
  // including RE-ENABLING verification on an account that has the loose flag set.
  it('lets an explicit tlsOptions=true override allowInsecureTLS=true (fail-safe direction)', () => {
    const config: TlsResolvable = { allowInsecureTLS: true, tlsOptions: { rejectUnauthorized: true } };
    expect(resolveTlsOptions(config).rejectUnauthorized).toBe(true);
  });

  it('lets an explicit tlsOptions=false override allowInsecureTLS=false', () => {
    const config: TlsResolvable = { allowInsecureTLS: false, tlsOptions: { rejectUnauthorized: false } };
    expect(resolveTlsOptions(config).rejectUnauthorized).toBe(false);
  });
});

describe('resolveTlsOptions — protocol floor', () => {
  // Pinned regardless of what the Node/OpenSSL runtime default is, so the
  // connection can never negotiate down to SSLv3 / TLS 1.0 / 1.1.
  it('always pins minVersion to TLSv1.2, even when verification is disabled', () => {
    expect(resolveTlsOptions({}).minVersion).toBe('TLSv1.2');
    expect(resolveTlsOptions({ allowInsecureTLS: true }).minVersion).toBe('TLSv1.2');
    expect(resolveTlsOptions({ tlsOptions: { rejectUnauthorized: false } }).minVersion).toBe('TLSv1.2');
  });

  // Callers spread the result straight into an ImapFlow/nodemailer config, so the
  // shape must stay exactly these two keys.
  it('returns only the two TLS keys it owns', () => {
    expect(Object.keys(resolveTlsOptions({})).sort()).toEqual(['minVersion', 'rejectUnauthorized']);
  });
});
