import type { OAuthProviderConfig, OAuthProviderId } from './types';

// Gmail requires the full mail.google.com scope for IMAP+SMTP over XOAUTH2.
// Google restricts this scope — until the app is verified, only test users
// added in Google Cloud Console can sign in. See OAUTH_SETUP.md at repo root.
const GMAIL: OAuthProviderConfig = {
  id: 'gmail',
  label: 'Gmail / Google Workspace',
  purpose: 'email',
  // Google Cloud Console → Desktop app client. Google's token endpoint
  // requires BOTH client_id and client_secret even with PKCE. These are NOT
  // baked into source — supply them via SARVINBOX_GOOGLE_CLIENT_ID /
  // SARVINBOX_GOOGLE_CLIENT_SECRET (see .env.example and OAUTH_SETUP.md).
  // initializeOAuth() applies them at startup; without them the Gmail option
  // is shown as "not configured".
  clientId: '',
  clientSecret: undefined,
  authEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenEndpoint: 'https://oauth2.googleapis.com/token',
  userInfoEndpoint: 'https://openidconnect.googleapis.com/v1/userinfo',
  scopes: [
    'https://mail.google.com/',
    'openid',
    'email',
    'profile',
  ],
  extraAuthParams: {
    access_type: 'offline',
    prompt: 'consent',
  },
  tokenBodyFormat: 'form',
  imap: { host: 'imap.gmail.com', port: 993, secure: true },
  smtp: { host: 'smtp.gmail.com', port: 465, secure: true },
};

// Sarv OAuth 2.1 + PKCE. The base URL can be swapped for the dev server
// (http://localhost:<port>) via setSarvBaseUrl() or SARVINBOX_SARV_OAUTH_BASE_URL.
// Register the app in your Sarv admin dashboard to obtain client_id and
// (optionally) client_secret. See SARV_OAUTH_SETUP.md at the repo root.

/**
 * Production client_id of the "Sarv Inbox" public OAuth client. Baked into the
 * build so a distributed DMG/exe signs in against oauth.sarv.com without anyone
 * setting env vars; OAuth 2.0 §2.3.1 classifies installed-app client_ids as
 * non-secret — PKCE is the actual defense.
 *
 * This is the ONE place the value lives: the registry default below is built
 * from it and the desktop's `initializeOAuth()` imports it from here instead of
 * re-declaring it, so rotating it here rotates it everywhere. A runtime
 * override is still available via SARVINBOX_SARV_CLIENT_ID.
 */
export const SARV_PRODUCTION_CLIENT_ID = 'client_Z6sjVFkr4cOdgfGXsGGCXg';

interface SarvUrls {
  oauthBase?: string;
  apiBase?: string;
  edgeBase?: string;
}

function buildSarvProvider(urls: SarvUrls = {}): OAuthProviderConfig {
  const oauthBase = urls.oauthBase || 'https://oauth.sarv.com';
  const apiBase = urls.apiBase || 'https://ai.sarv.com';
  const edgeBase = urls.edgeBase || 'https://jpr1-ai-edge.sarv.com';
  return {
    id: 'sarv',
    label: 'Sarv',
    // 'both': the same Sarv OAuth session powers the LLM/AI features AND now
    // authenticates the Sarv mailbox over IMAP/SMTP via the access token
    // (XOAUTH2 / OAUTHBEARER — ImapFlow negotiates from the server's AUTH caps).
    // This is what surfaces the "Sign in with Sarv" button in the account UIs
    // (they list providers whose purpose is 'email' or 'both').
    purpose: 'both',
    // Public client "Sarv Inbox" registered in the Sarv OAuth admin dashboard
    // (grant types: authorization_code + refresh_token; PKCE, no client_secret
    // per RFC 8252). Override at runtime via SARVINBOX_SARV_CLIENT_ID to rotate
    // without touching source.
    clientId: SARV_PRODUCTION_CLIENT_ID,
    clientSecret: undefined,
    authEndpoint: `${oauthBase}/api/oauth/authorize`,
    tokenEndpoint: `${oauthBase}/api/oauth/token`,
    userInfoEndpoint: `${oauthBase}/api/oauth/userinfo`,
    // Sarv CAI resource-server scopes (colon form, ``resource:verb``).
    //   organization — embeds cai_org_id / cai_user_id in the JWT
    //   llm:view     — list LLM providers / models / zones via /oauth/v1/*
    //   llm:query    — call /edge/v1/llm/chat/completions (spends wallet)
    // `offline_access` is NOT requested: the Sarv OAuth server issues a
    // refresh_token on every authorization_code grant regardless of scope, so
    // listing it just trips the production `invalid_scope` allowlist.
    scopes: [
      'openid',
      'email',
      'profile',
      'organization',
      'llm:view',
      'llm:query',
      // Sarv Mail resource-server scopes (the "Email" RS; granted to the Sarv
      // Inbox client in the OAuth admin dashboard). These authorize the access
      // token for the MAILBOX so imap.sarv.com / smtp.sarv.com can accept it
      // over XOAUTH2/OAUTHBEARER. read+send are the minimum for IMAP+SMTP; the
      // rest cover the delete/draft/label/filter/attachment actions the app
      // performs. Must stay a subset of the client's allowed_scopes or the whole
      // authorize request fails with `invalid_scope`.
      'email:read',
      'email:send',
      'email:delete',
      'email:draft',
      'email:labels',
      'email:attachments',
      'email:filters',
    ],
    tokenBodyFormat: 'json',
    // Sarv mailbox endpoints — the OAuth access token authenticates these via
    // XOAUTH2/OAUTHBEARER. `oauth:startFlow` returns these so the account is
    // created with authMethod 'oauth2' (no password). NOTE: imap.sarv.com must
    // accept the token for the granted scopes; if the mail server gates on a
    // dedicated mail scope, add it to `scopes` above (kept out for now to avoid
    // tripping the server's invalid_scope allowlist until it's confirmed).
    imap: { host: 'imap.sarv.com', port: 993, secure: true },
    smtp: { host: 'smtp.sarv.com', port: 465, secure: true },
    apiBaseUrl: apiBase,
    edgeBaseUrl: edgeBase,
    llmBaseUrl: `${edgeBase}/edge/v1/llm`,
  };
}

/**
 * Copy a provider config deeply enough that NOTHING mutable is shared with the
 * registry (or with a sibling provider derived from the same template).
 *
 * A shallow `{ ...cfg }` only isolates top-level reassignment: `scopes`,
 * `imap`, `smtp` and `extraAuthParams` stay the very objects the registry
 * holds, so a caller doing `p.scopes.push(…)` or `p.imap.host = …` silently
 * corrupts every later sign-in — process-wide, for every account. Nested
 * fields are copied explicitly (rather than via structuredClone) so the result
 * stays typed and no non-cloneable field added later can throw at runtime.
 *
 * Key presence is preserved: an absent `imap`/`smtp`/`extraAuthParams` stays
 * absent instead of materialising as `undefined`.
 */
function cloneProviderConfig(cfg: OAuthProviderConfig): OAuthProviderConfig {
  const copy: OAuthProviderConfig = { ...cfg, scopes: [...cfg.scopes] };
  if (cfg.extraAuthParams) copy.extraAuthParams = { ...cfg.extraAuthParams };
  if (cfg.imap) copy.imap = { ...cfg.imap };
  if (cfg.smtp) copy.smtp = { ...cfg.smtp };
  return copy;
}

// microsoft/yahoo start from the Gmail template. They MUST be deep-cloned:
// a bare `{ ...GMAIL }` leaves all three sharing one `scopes` array and one
// `imap`/`smtp`/`extraAuthParams` object, so touching Yahoo's imap host would
// also move Gmail's.
const REGISTRY: Record<OAuthProviderId, OAuthProviderConfig> = {
  gmail: GMAIL,
  microsoft: { ...cloneProviderConfig(GMAIL), id: 'microsoft', label: 'Outlook / Microsoft 365', clientId: '' },
  yahoo: { ...cloneProviderConfig(GMAIL), id: 'yahoo', label: 'Yahoo Mail', clientId: '' },
  sarv: buildSarvProvider(),
};

export function getOAuthProvider(id: OAuthProviderId): OAuthProviderConfig {
  const cfg = REGISTRY[id];
  if (!cfg) throw new Error(`Unknown OAuth provider: ${id}`);
  return cloneProviderConfig(cfg);
}

export function setOAuthClientId(id: OAuthProviderId, clientId: string): void {
  if (!REGISTRY[id]) throw new Error(`Unknown OAuth provider: ${id}`);
  REGISTRY[id].clientId = clientId;
}

export function setOAuthClientSecret(id: OAuthProviderId, clientSecret: string): void {
  if (!REGISTRY[id]) throw new Error(`Unknown OAuth provider: ${id}`);
  REGISTRY[id].clientSecret = clientSecret;
}

/**
 * Swap one or more Sarv base URLs (prod ↔ dev). Each arg is optional —
 * unspecified URLs keep their production defaults (or previously-set value).
 * Preserves client credentials set via setOAuthClientId/Secret.
 */
export function setSarvBaseUrl(urls: {
  oauthBase?: string;
  apiBase?: string;
  edgeBase?: string;
}): void {
  const current = REGISTRY.sarv;
  const inferCurrent = (prop: 'authEndpoint' | 'apiBaseUrl' | 'edgeBaseUrl'): string | undefined => {
    const v = current[prop];
    return typeof v === 'string' ? v : undefined;
  };
  // Recover the current oauthBase from authEndpoint if the caller didn't
  // provide one — keeps the call idempotent.
  const authEndpoint = inferCurrent('authEndpoint');
  const currentOauthBase = authEndpoint
    ? authEndpoint.replace(/\/api\/oauth\/authorize$/, '')
    : undefined;
  const next = buildSarvProvider({
    oauthBase: urls.oauthBase ?? currentOauthBase,
    apiBase: urls.apiBase ?? current.apiBaseUrl,
    edgeBase: urls.edgeBase ?? current.edgeBaseUrl,
  });
  next.clientId = current.clientId;
  next.clientSecret = current.clientSecret;
  REGISTRY.sarv = next;
}

export function isOAuthProviderConfigured(id: OAuthProviderId): boolean {
  return Boolean(REGISTRY[id]?.clientId);
}

export function listOAuthProviders(): OAuthProviderConfig[] {
  return Object.values(REGISTRY).map(cloneProviderConfig);
}
