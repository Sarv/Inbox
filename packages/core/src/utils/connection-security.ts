/**
 * How a mail connection is secured — the ONE resolver the IMAP client, the SMTP
 * client and the account forms share (CASA M-5).
 *
 *   'ssl'       implicit TLS from the first byte (IMAP 993, SMTP 465).
 *   'starttls'  plain connect, then the STARTTLS upgrade is REQUIRED: if the
 *               server does not offer it — or someone on the network strips it
 *               from the capability list — the client stops BEFORE sending the
 *               password or OAuth token. It used to continue in cleartext.
 *   'none'      the user's explicit opt-out: no encryption required; the client
 *               still upgrades when the server offers STARTTLS.
 *
 * Accounts saved before the `security` field existed carry only `secure`:
 * true → 'ssl', false → 'starttls' (now required). An unrecognised value never
 * resolves to 'none' — dropping encryption takes an explicit choice. And an
 * OAuth sign-in never resolves to 'none' (it becomes 'starttls'): every
 * provider encrypts, so a config saying otherwise — stale, or sent by a
 * compromised window — must not be able to carry a token in cleartext.
 *
 * Pure, zero imports: the renderer imports it through the
 * `@sarvinbox/core/connection-security` alias (vite/renderer-aliases.ts).
 */
export type ConnectionSecurity = 'ssl' | 'starttls' | 'none';

/** The parts of an IMAP/SMTP config that decide its connection security. */
export interface SecurityResolvable {
  /** Authoritative when it is one of the three modes. */
  security?: unknown;
  /** Legacy boolean: true = implicit TLS. */
  secure?: boolean;
  /** 'oauth2' never resolves to 'none'. */
  authMethod?: string;
}

export function resolveConnectionSecurity(config: SecurityResolvable): ConnectionSecurity {
  const { security } = config;
  if (security === 'none') return config.authMethod === 'oauth2' ? 'starttls' : 'none';
  if (security === 'ssl' || security === 'starttls') return security;
  return config.secure === false ? 'starttls' : 'ssl';
}

/**
 * The message for a STARTTLS account whose server would not encrypt. Worded to
 * stay clear of the transient-network and auth classifiers (no "socket",
 * "timeout", "connection closed", "login failed", …): this is a settled
 * configuration fact, not a blip to retry and not a rejected password.
 */
export function starttlsUnavailableMessage(server: 'incoming' | 'outgoing', host: string): string {
  return `The ${server} mail server ${host} did not agree to encrypt this session (STARTTLS), `
    + 'so Sarv Inbox stopped before sending your password. Someone on this network may be blocking encryption. '
    + 'If this server really has no encryption and you trust the network, set Connection security to None in the account settings.';
}
