// OAuth types — shared across core, main-process service, and renderer.

export type OAuthProviderId = 'gmail' | 'microsoft' | 'yahoo' | 'sarv';

/**
 * What the OAuth connection is used for:
 *  - email: IMAP/SMTP access (Gmail, Microsoft, Yahoo)
 *  - llm: access to the provider's LLM API (Sarv)
 *  - both: reserved for future combined providers
 */
export type OAuthProviderPurpose = 'email' | 'llm' | 'both';

export interface OAuthProviderConfig {
  id: OAuthProviderId;
  label: string;
  purpose: OAuthProviderPurpose;
  clientId: string;
  /**
   * For Google "Desktop app" OAuth clients the token endpoint requires the
   * client_secret in the POST body even though PKCE is in use. Google's own
   * docs acknowledge this: the secret "cannot actually be kept a secret" for
   * installed apps — it's effectively a public rate-limit identifier.
   * Sarv OAuth (OAuth 2.1) also accepts a client_secret alongside PKCE for
   * backend-ish flows — same caveat applies. Omit this field for providers
   * (e.g. Microsoft public client) that don't accept a secret on PKCE.
   */
  clientSecret?: string;
  authEndpoint: string;
  tokenEndpoint: string;
  userInfoEndpoint: string;
  scopes: string[];
  extraAuthParams?: Record<string, string>;
  /**
   * Token endpoint body encoding. RFC 6749 mandates form-encoded, but some
   * OAuth 2.1 servers (Sarv) accept JSON. Defaults to 'form'.
   */
  tokenBodyFormat?: 'form' | 'json';
  /** Only populated for email-purpose providers. */
  imap?: { host: string; port: number; secure: boolean };
  smtp?: { host: string; port: number; secure: boolean };
  /** Only populated for llm-purpose providers. Base URL of the LLM API. */
  llmBaseUrl?: string;
  /**
   * Sarv-only: Sarv has three services on separate hosts/ports in dev
   *   - OAuth server        (see authEndpoint / tokenEndpoint)
   *   - API (agent-models, zone, etc.)
   *   - Edge (chat/completions — OpenAI-compatible)
   * In production they share a domain family; in dev they're split across
   * ports. Populated at runtime via setSarvBaseUrl().
   */
  apiBaseUrl?: string;
  edgeBaseUrl?: string;
}

export interface OAuthAccount {
  provider: OAuthProviderId;
  email: string;
  displayName?: string;
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: number;
  scopes: string[];
  createdAt: number;
  updatedAt: number;
}

export interface OAuthTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type: string;
  scope?: string;
  id_token?: string;
}

export interface OAuthUserInfo {
  email: string;
  name?: string;
  picture?: string;
}

export class OAuthError extends Error {
  constructor(message: string, public code: string, public detail?: string) {
    super(message);
    this.name = 'OAuthError';
  }
}
