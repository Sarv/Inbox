// Where an OAuth bearer may be sent — the single answer for every main-process
// path that attaches a token to a connection or request.
//
// The renderer hands main an IMAP/SMTP config (host, port, oauthProvider) or an
// AI provider config (baseUrl, oauthProvider) and main mints a fresh bearer for
// it. The renderer also hosts untrusted email HTML and extension panels, so it
// is not trusted to choose where that bearer goes: a config naming
// `oauthProvider: 'gmail'` with a host or baseUrl of its own would otherwise
// receive the user's Gmail token (OWASP ASVS 3.5.x / 8.1; the restricted
// https://mail.google.com/ scope makes this the CASA reviewer's first question).
//
// Matching is exact string equality on a normalised hostname — no suffix match
// for mail hosts and no regex — so a lookalike ('imap.gmail.com.evil.test',
// 'evil.test/imap.gmail.com') can never pass.

import { oauthImapPreset } from '../utils/oauth-imap-presets';

import { getOAuthProvider } from './providers';
import type { OAuthProviderId } from './types';

export type OAuthMailProtocol = 'imap' | 'smtp';

/**
 * Hosts a provider documents for the same mailbox besides the one in its
 * registry entry. Without these, an account a user set up against a documented
 * alias would stop connecting the moment this guard shipped.
 */
const MAIL_HOST_ALIASES: Partial<Record<OAuthProviderId, Record<OAuthMailProtocol, readonly string[]>>> = {
  gmail: { imap: ['imap.googlemail.com'], smtp: ['smtp.googlemail.com'] },
  microsoft: { imap: ['imap-mail.outlook.com'], smtp: ['smtp-mail.outlook.com'] },
};

const KNOWN_PROVIDERS: ReadonlySet<string> = new Set<OAuthProviderId>(['gmail', 'microsoft', 'yahoo', 'sarv']);

/** Lower-cased, trimmed, one trailing root dot removed. */
function normalizeHost(host: string): string {
  const h = host.trim().toLowerCase();
  return h.endsWith('.') ? h.slice(0, -1) : h;
}

/**
 * Every host a `provider` bearer may be sent to over `protocol`: its registry
 * entry, its IMAP preset, and the documented aliases. Empty for an unknown
 * provider id (including inherited keys such as `__proto__`).
 */
export function oauthMailHostsFor(provider: string, protocol: OAuthMailProtocol): string[] {
  if (!KNOWN_PROVIDERS.has(provider)) return [];
  const id = provider as OAuthProviderId;
  const hosts = new Set<string>();
  const registered = getOAuthProvider(id)[protocol]?.host;
  if (registered) hosts.add(normalizeHost(registered));
  if (protocol === 'imap') {
    const preset = oauthImapPreset(id)?.host;
    if (preset) hosts.add(normalizeHost(preset));
  }
  for (const alias of MAIL_HOST_ALIASES[id]?.[protocol] ?? []) hosts.add(alias);
  return [...hosts];
}

/** Whether a `provider` bearer may be sent to `host` over `protocol`. */
export function isOAuthMailHostAllowed(
  provider: string,
  protocol: OAuthMailProtocol,
  host: string | undefined | null,
): boolean {
  if (typeof host !== 'string' || host.trim() === '') return false;
  return oauthMailHostsFor(provider, protocol).includes(normalizeHost(host));
}

/**
 * Whether a Sarv OAuth bearer may be sent to the AI endpoint `url`.
 *
 * Sarv AI routes each model to a zone with its own edge host
 * (`<zone>-ai-edge.sarv.com`), so the rule is a host under sarv.com over https,
 * or the exact origin of a configured Sarv base URL (the dev override, which
 * may be http://localhost). URLs carrying credentials are refused outright.
 */
export function isSarvAIEndpointAllowed(url: string | undefined | null): boolean {
  if (typeof url !== 'string' || url.trim() === '') return false;
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return false;
  }
  if (parsed.username || parsed.password) return false;
  const sarv = getOAuthProvider('sarv');
  for (const base of [sarv.llmBaseUrl, sarv.edgeBaseUrl, sarv.apiBaseUrl]) {
    if (!base) continue;
    try {
      if (new URL(base).origin === parsed.origin) return true;
    } catch {
      // A malformed configured base can never match anything.
    }
  }
  const host = normalizeHost(parsed.hostname);
  return parsed.protocol === 'https:' && (host === 'sarv.com' || host.endsWith('.sarv.com'));
}
