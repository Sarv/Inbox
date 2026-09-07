// Single source of truth for "should this connection verify its TLS cert?".
// Previously the `{ rejectUnauthorized: false }` decision was copy-pasted across
// the SMTP client, both IMAP/SMTP IPC handlers, and several UI config builders —
// which is exactly how an insecure default silently spreads. Centralize it so
// the secure-by-default policy lives in one place.

/** The subset of an IMAP/SMTP config that determines TLS verification. */
export interface TlsResolvable {
  /** Explicit override — wins when its rejectUnauthorized is set. */
  tlsOptions?: { rejectUnauthorized?: boolean };
  /**
   * Per-account opt-in for self-signed / untrusted certs. Default
   * (undefined/false) → verification ON. Disabling exposes credentials and mail
   * to man-in-the-middle attacks, so it must be a deliberate choice.
   */
  allowInsecureTLS?: boolean;
}

/**
 * Resolve the TLS options for a mail connection. Verification is ON unless an
 * explicit `tlsOptions.rejectUnauthorized` says otherwise, or the account has
 * opted into `allowInsecureTLS`. Also pins a TLS 1.2 floor so the connection can
 * never negotiate down to the broken SSLv3 / TLS 1.0 / 1.1 protocols, regardless
 * of what the Node/OpenSSL runtime default happens to be.
 */
export function resolveTlsOptions(
  config: TlsResolvable,
): { rejectUnauthorized: boolean; minVersion: 'TLSv1.2' } {
  const rejectUnauthorized =
    typeof config.tlsOptions?.rejectUnauthorized === 'boolean'
      ? config.tlsOptions.rejectUnauthorized
      : !config.allowInsecureTLS;
  return { rejectUnauthorized, minVersion: 'TLSv1.2' };
}
