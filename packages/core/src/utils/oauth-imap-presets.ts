/**
 * IMAP connection presets keyed by OAuth provider id.
 *
 * The main process persists OAuth accounts as `{ provider, email, tokens }`
 * (oauth-token-store) — it does NOT store the provider's IMAP host/port. To
 * reconstruct a full account identity (and its deterministic `accountIdFor`
 * id + per-account DB) from just the durable OAuth record — e.g. when seeding
 * the accounts registry after a lost renderer localStorage — main needs the
 * provider → IMAP host mapping.
 *
 * This is the SINGLE main-importable source for that mapping. The renderer's
 * richer `EMAIL_PROVIDERS` preset list (apps/desktop/src/config/email-providers)
 * carries the same hosts for the add-account wizard; keep the two in sync.
 */

import type { OAuthProviderId } from '../oauth/types';

export interface OAuthImapPreset {
  host: string;
  port: number;
  /** true → implicit TLS (SSL); false → STARTTLS on the plaintext port. */
  secure: boolean;
}

// 'sarv' is an OAuth *sign-in* provider (AI / identity), not a mail provider
// with an IMAP preset, so it is intentionally absent.
export const OAUTH_IMAP_PRESETS: Partial<Record<OAuthProviderId, OAuthImapPreset>> = {
  gmail: { host: 'imap.gmail.com', port: 993, secure: true },
  microsoft: { host: 'outlook.office365.com', port: 993, secure: true },
  yahoo: { host: 'imap.mail.yahoo.com', port: 993, secure: true },
};

/**
 * The IMAP preset for an OAuth provider id, or null for an unknown provider.
 *
 * The own-property check is load-bearing: `provider` arrives from a persisted
 * OAuth record, and a plain-object index also resolves INHERITED keys — so
 * `'__proto__'` handed back `Object.prototype` and `'constructor'`/`'toString'`
 * handed back functions, all of which would then be read as `{ host, port }`.
 */
export function oauthImapPreset(provider: string): OAuthImapPreset | null {
  if (!Object.prototype.hasOwnProperty.call(OAUTH_IMAP_PRESETS, provider)) return null;
  return (OAUTH_IMAP_PRESETS as Record<string, OAuthImapPreset>)[provider] ?? null;
}
