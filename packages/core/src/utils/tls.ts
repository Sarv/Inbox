// Single source of truth for "should this connection verify its TLS cert?".
// Previously the `{ rejectUnauthorized: false }` decision was copy-pasted across
// the SMTP client, both IMAP/SMTP IPC handlers, and several UI config builders —
// which is exactly how an insecure default silently spreads. Centralize it so
// the secure-by-default policy lives in one place.

/** The subset of an IMAP/SMTP config that determines TLS verification. */
export interface TlsResolvable {
  /**
   * Per-account opt-in for self-signed / untrusted certs. Default
   * (undefined/false) → verification ON. Disabling exposes credentials and mail
   * to man-in-the-middle attacks, so it must be a deliberate choice.
   */
  allowInsecureTLS?: boolean;
  /** 'oauth2' always verifies. */
  authMethod?: string;
}

/**
 * Resolve the TLS options for a mail connection. Verification is ON unless the
 * account has opted into `allowInsecureTLS` (the boolean `true` — a "true"
 * string that round-tripped through storage does not count). Also pins a TLS
 * 1.2 floor so the connection can never negotiate down to the broken SSLv3 /
 * TLS 1.0 / 1.1 protocols, regardless of the runtime default.
 *
 * An OAuth sign-in always verifies: every provider has a publicly trusted
 * certificate, so a config saying otherwise — stale, or sent by a compromised
 * window — must not be able to hand the user's token to whoever answers.
 *
 * There is deliberately no per-config override (the old
 * `tlsOptions.rejectUnauthorized` won over everything, and it travelled in from
 * the renderer like the rest of the config). The main process decides
 * `allowInsecureTLS` for every connection that carries a secret it injected.
 */
export function resolveTlsOptions(
  config: TlsResolvable,
): { rejectUnauthorized: boolean; minVersion: 'TLSv1.2' } {
  const insecure = config.allowInsecureTLS === true && config.authMethod !== 'oauth2';
  return { rejectUnauthorized: !insecure, minVersion: 'TLSv1.2' };
}
