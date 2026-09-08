/**
 * OAuth service (main process).
 *
 * Runs the full PKCE "authorization code" flow for Gmail/Microsoft/Yahoo:
 *   1. Spin up a loopback HTTP server on an ephemeral port.
 *   2. Open the provider's consent page in the user's default browser.
 *   3. Receive the redirect (/cb?code=...&state=...) on the loopback server.
 *   4. Exchange the code + PKCE verifier for access + refresh tokens.
 *   5. Fetch user email via the provider's OIDC userinfo endpoint.
 *   6. Persist the OAuthAccount via the safeStorage-backed token store.
 *
 * Also provides `getValidAccessToken(provider, email)` which transparently
 * refreshes expiring access tokens before returning them.
 */

import { shell } from 'electron';
import http from 'http';
import { AddressInfo } from 'net';
import {
  exchangeCodeForTokens,
  generatePkcePair,
  generateState,
  getOAuthProvider,
  isOAuthProviderConfigured,
  OAuthError,
  refreshAccessToken,
  SARV_PRODUCTION_CLIENT_ID,
  scopesLost,
  scopesNotGranted,
  setOAuthClientId,
  setOAuthClientSecret,
  setSarvBaseUrl,
  type OAuthAccount,
  type OAuthProviderId,
  type OAuthProviderConfig,
  type OAuthUserInfo,
  type IMAPConfig,
  createLogger,
} from '@sarvinbox/core';
import { getAccount, removeAccount, saveAccount, listAccounts } from './oauth-token-store';
import { waitForNetworkReady } from './network-readiness';
import { getSystemSuspended } from '../shared';
const logger = createLogger('oauth-service');

// Sliding-window refresh policy.
//
// The stored `accessExpiresAt` is derived from the server's `expires_in`
// at issuance, but that's our local estimate — network latency and clock
// skew mean it can drift from the JWT's actual `exp` claim, which is
// what the server will validate against. So we decode `exp`/`iat` from
// the JWT directly and use those as the source of truth.
//
// Refresh fires when EITHER of these is true:
//   - less than REFRESH_MIN_REMAINING_SEC of lifetime remains (hard floor), or
//   - more than REFRESH_AT_FRACTION of the token's total lifetime has elapsed.
// The hard floor protects short-lived tokens from the fraction being
// generous; the fraction protects long-lived tokens from the floor
// being stingy. 25% / 5-minute combo absorbs typical clock skew without
// needing a reactive 401 retry path.
const REFRESH_MIN_REMAINING_SEC = 300;
const REFRESH_AT_FRACTION = 0.75;

/**
 * Load OAuth client IDs from env at startup. Call once from main.ts.
 */
export function initializeOAuth(): void {
  const googleId = process.env.SARVINBOX_GOOGLE_CLIENT_ID;
  if (googleId) {
    setOAuthClientId('gmail', googleId);
    logger.info('[OAuth] Gmail client_id loaded from env');
  }
  const googleSecret = process.env.SARVINBOX_GOOGLE_CLIENT_SECRET;
  if (googleSecret) {
    setOAuthClientSecret('gmail', googleSecret);
    logger.info('[OAuth] Gmail client_secret loaded from env');
  }
  const msId = process.env.SARVINBOX_MICROSOFT_CLIENT_ID;
  if (msId) setOAuthClientId('microsoft', msId);
  const yhId = process.env.SARVINBOX_YAHOO_CLIENT_ID;
  if (yhId) setOAuthClientId('yahoo', yhId);

  // Sarv: each base URL is independently dev-switchable — the OAuth server,
  // the catalog API and the edge LLM gateway can each point at a different
  // host. See SARV_OAUTH_SETUP.md.
  const sarvOauthBase = process.env.SARVINBOX_SARV_OAUTH_BASE_URL;
  const sarvApiBase = process.env.SARVINBOX_SARV_API_BASE_URL;
  const sarvEdgeBase = process.env.SARVINBOX_SARV_EDGE_BASE_URL;
  if (sarvOauthBase || sarvApiBase || sarvEdgeBase) {
    setSarvBaseUrl({
      oauthBase: sarvOauthBase,
      apiBase: sarvApiBase,
      edgeBase: sarvEdgeBase,
    });
    logger.info('[OAuth] Sarv base URLs overridden', {
      oauth: sarvOauthBase,
      api: sarvApiBase,
      edge: sarvEdgeBase,
    });
  }
  // Sarv: env override wins (dev / staging), production constant otherwise.
  // SARV_PRODUCTION_CLIENT_ID is defined ONCE, in the core provider definition,
  // and imported here rather than re-declared, so rotating it in core rotates
  // it everywhere. The constant ensures a distributed build can sign in against
  // oauth.sarv.com without the end user editing anything.
  const sarvId = process.env.SARVINBOX_SARV_CLIENT_ID || SARV_PRODUCTION_CLIENT_ID;
  setOAuthClientId('sarv', sarvId);
  logger.info(
    process.env.SARVINBOX_SARV_CLIENT_ID
      ? '[OAuth] Sarv client_id loaded from env'
      : '[OAuth] Sarv client_id using production default',
  );
  const sarvSecret = process.env.SARVINBOX_SARV_CLIENT_SECRET;
  if (sarvSecret) {
    setOAuthClientSecret('sarv', sarvSecret);
    logger.info('[OAuth] Sarv client_secret loaded from env');
  }
}

/**
 * Drive the full OAuth flow and persist the resulting account.
 */
export async function startOAuthFlow(providerId: OAuthProviderId): Promise<OAuthAccount> {
  if (!isOAuthProviderConfigured(providerId)) {
    throw new OAuthError(
      `${providerId} OAuth is not configured. See OAUTH_SETUP.md for setup steps.`,
      'PROVIDER_NOT_CONFIGURED',
    );
  }
  const provider = getOAuthProvider(providerId);
  const pkce = generatePkcePair();
  const state = generateState();

  const { code, redirectUri } = await runLoopbackFlow(provider, pkce.challenge, state);

  const tokens = await exchangeCodeForTokens({
    provider,
    code,
    codeVerifier: pkce.verifier,
    redirectUri,
  });

  if (!tokens.refresh_token) {
    throw new OAuthError(
      'Provider did not return a refresh token. Revoke access in the provider\'s account settings and try again.',
      'NO_REFRESH_TOKEN',
    );
  }

  const userInfo = await fetchUserInfo(provider, tokens.access_token);

  const now = Math.floor(Date.now() / 1000);
  const account: OAuthAccount = {
    provider: provider.id,
    email: userInfo.email,
    displayName: userInfo.name,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    accessExpiresAt: now + tokens.expires_in,
    scopes: (tokens.scope || provider.scopes.join(' ')).split(/\s+/).filter(Boolean),
    createdAt: now,
    updatedAt: now,
  };

  // Record what the server actually granted. A server may drop a scope it does
  // not allow instead of failing /authorize, so a successful sign-in is no
  // evidence the token can do everything the app asked for — losing `llm:view`
  // this way leaves mail working and the whole AI catalog answering 403.
  const missing = scopesNotGranted(provider.scopes, account.scopes);
  logger.info(`[OAuth] ${provider.id}:${account.email} granted scopes: ${account.scopes.join(' ')}`);
  if (missing.length > 0) {
    logger.warn(
      `[OAuth] ${provider.id}:${account.email} did NOT grant: ${missing.join(' ')} — features needing them will fail with 403`,
    );
  }

  await saveAccount(account);
  return account;
}

/**
 * In-flight refresh per provider:email. Concurrent callers hitting the
 * refresh window (e.g. several parallel LLM calls) join the one refresh
 * instead of firing N refreshes with the same refresh token — providers
 * that rotate refresh tokens reject the duplicates with invalid_grant,
 * which effectively signs the user out.
 */
const inflightRefresh = new Map<string, Promise<string>>();

/**
 * Cancels every token refresh currently in flight. Replaced after each abort so
 * later refreshes get a fresh, un-aborted signal.
 *
 * A refresh that is merely ABANDONED (its caller timed out) keeps running, and
 * if it reaches a rotating provider we never learn the outcome: the server
 * rotates, our stored token becomes a spent one, and the next refresh reads as
 * a replay attack. Aborting closes the socket at a moment we chose instead of
 * letting sleep freeze it mid-flight.
 */
let refreshAbort = new AbortController();

/**
 * Abort in-flight token refreshes — call this as the machine suspends, BEFORE
 * sleep freezes the sockets.
 *
 * Honest about its limits: aborting cannot un-send a request the server already
 * received, so this narrows the window rather than closing it. What it
 * guarantees is that we stop waiting on a request that can no longer complete,
 * and that the failure is reported as "token state unknown" instead of a silent
 * hang. Pair it with `getSystemSuspended()` gating below, which is what stops
 * doomed refreshes from STARTING during a dark wake.
 */
export function abortInFlightTokenRefreshes(reason = 'system suspend'): void {
  const pending = inflightRefresh.size;
  refreshAbort.abort(reason);
  refreshAbort = new AbortController();
  if (pending > 0) {
    logger.info(`[OAuth] aborted ${pending} in-flight token refresh(es) — ${reason}`);
  }
}

/**
 * True when a refresh was deferred because the machine is asleep. Transient by
 * construction: nothing is wrong with the credentials, so callers must retry
 * rather than count it as a failure or ask the user to sign in again.
 */
export function isRefreshDeferredError(err: unknown): boolean {
  return err instanceof OAuthError && err.code === 'REFRESH_DEFERRED_SUSPENDED';
}

/**
 * Return a currently-valid access token. Refreshes proactively using a
 * sliding window that reads the JWT's own `exp`/`iat` claims — no need
 * to wait for a 401 from the API, since JWTs carry their expiry
 * self-describingly.
 */
/**
 * Attach a fresh-token resolver to an OAuth IMAP config so EVERY connect — the
 * primary connection, every pooled worker, and every reconnect — authenticates
 * with a just-refreshed bearer via `getValidAccessToken`. Without this the pool
 * reused the token captured at pool-init; once it aged out (~15 min) every new
 * pooled connection failed with "NO Invalid or expired token", stalling
 * body-fetch / backfill / sync for OAuth accounts. The resolver is a closure
 * (not serializable), so it's attached here in the main process right before
 * the config is handed to core — never shipped over IPC or persisted. No-op for
 * password auth or a config missing its provider.
 */
export function attachImapBearer(config: IMAPConfig): IMAPConfig {
  if (config.authMethod !== 'oauth2' || !config.oauthProvider) return config;
  const provider = config.oauthProvider as unknown as OAuthProviderId;
  const email = config.username;
  return {
    ...config,
    resolveBearer: (forceRefresh?: boolean) => getValidAccessToken(provider, email, forceRefresh),
  };
}

export async function getValidAccessToken(
  providerId: OAuthProviderId,
  email: string,
  forceRefresh = false,
): Promise<string> {
  const account = await getAccount(providerId, email);
  if (!account) {
    throw new OAuthError(`No OAuth account for ${providerId}:${email}`, 'ACCOUNT_NOT_FOUND');
  }
  // `forceRefresh` bypasses the proactive expiry gate — used to recover from a
  // 401 where the resource server rejected a token our local clock still
  // thought was valid (clock skew, server-side revocation-then-reissue, or a
  // token that aged out while the app sat idle and made no calls).
  if (!forceRefresh && !shouldRefresh(account)) {
    if (!account.accessToken || account.accessToken.trim() === '') {
      // Stored token is blank — treat as if the account never completed
      // sign-in. Forcing the caller to re-authorize beats sending an
      // empty Bearer header to the LLM gateway.
      throw new OAuthError(
        `Stored OAuth accessToken for ${providerId}:${email} is empty. Re-authenticate.`,
        'EMPTY_STORED_TOKEN',
      );
    }
    return account.accessToken;
  }

  // Single-flight: join an already-running refresh for this account.
  const key = `${providerId}:${email.toLowerCase()}`;
  const existing = inflightRefresh.get(key);
  if (existing) return existing;

  // Refuse to START a refresh while the machine is suspended — deliberately
  // placed AFTER the cached-token fast path (a still-valid token is still
  // handed out) and AFTER the single-flight join (a refresh begun while awake
  // runs to completion), so this rejects exactly one thing: a new token POST
  // during sleep.
  //
  // This is the fix for the dark-wake session kill. macOS Power Nap wakes the
  // machine for ~2 seconds every ~16 minutes and fires NO 'resume' event, so
  // `systemSuspended` correctly stays true across the nap. A refresh started in
  // that window cannot finish before the machine sleeps again — and against a
  // rotating provider, an unfinished refresh is what costs the whole session.
  // Waiting for a real wake loses nothing: no user is watching a sleeping Mac.
  if (getSystemSuspended()) {
    throw new OAuthError(
      `Token refresh for ${providerId}:${email} deferred — the system is suspended; it will refresh on the next real wake`,
      'REFRESH_DEFERRED_SUSPENDED',
    );
  }

  const refreshPromise = (async () => {
    // Captured BEFORE the first await: `abortInFlightTokenRefreshes` swaps the
    // controller, and reading `.signal` later would hand this refresh the fresh
    // one and quietly miss the abort it was meant to receive.
    const abortSignal = refreshAbort.signal;
    const provider = getOAuthProvider(providerId);
    // A wake's first seconds have no DNS. Let the link settle rather than
    // spending this refresh on a guaranteed ENOTFOUND.
    await waitForNetworkReady();
    const tokens = await refreshAccessToken({
      provider,
      refreshToken: account.refreshToken,
      signal: abortSignal,
    });
    const now = Math.floor(Date.now() / 1000);

    // Observability: does this provider ROTATE the refresh token? A rotating
    // provider returns a NEW refresh_token on each refresh (sliding window);
    // Sarv does NOT today (30-day static token, no refresh_token in the refresh
    // response). Logging it makes the behaviour verifiable at runtime and flags
    // a silent policy change if Sarv ever starts rotating. Low-frequency (once
    // per ~10-min token cycle).
    const rotated = !!tokens.refresh_token && tokens.refresh_token !== account.refreshToken;
    logger.info(
      `[OAuth] ${providerId}:${email} refreshed — refresh_token ${
        !tokens.refresh_token
          ? 'NOT returned (static, reused)'
          : rotated
            ? 'ROTATED (new token issued)'
            : 'returned but unchanged'
      }; access expires_in=${tokens.expires_in}s`,
    );

    // Crash/persist-race hardening for rotation. When the provider rotates, the
    // OLD refresh token is revoked server-side the moment it responds — so the NEW
    // one is IRRECOVERABLE if we lose it (losing it forces a full re-login). Persist
    // it FIRST, before validating/using the access token, so no later throw (an
    // empty access token below, a network error building the Sent copy, etc.) can
    // strand us on the now-dead old token. A `finally` can't help the remaining
    // window — a hard crash (SIGKILL / power loss) between the response and this
    // write skips all JS — but the write itself is atomic (single SQLite blob), so
    // we're never left with a torn store, and the window is now just network→disk.
    // If a crash does land in it, the next refresh presents the dead old token →
    // invalid_grant → the re-login flow (handled, not corruption). The clean,
    // complete fix for that residual is a server-side refresh-token grace window.
    if (rotated) {
      await saveAccount({ ...account, refreshToken: tokens.refresh_token!, updatedAt: now });
    }

    // Refresh providers can return { access_token: '' } on transient failures.
    // Validate before using; otherwise every subsequent call sends
    // `Authorization: Bearer ` and the gateway 502s on an illegal header. Safe to
    // throw here now — a rotated refresh token is already durably saved above.
    if (!tokens.access_token || tokens.access_token.trim() === '') {
      throw new OAuthError(
        `Refresh for ${providerId}:${email} returned an empty access token.`,
        'EMPTY_REFRESH_TOKEN',
      );
    }

    const updated: OAuthAccount = {
      ...account,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token || account.refreshToken,
      accessExpiresAt: now + tokens.expires_in,
      scopes: tokens.scope
        ? tokens.scope.split(/\s+/).filter(Boolean)
        : account.scopes,
      updatedAt: now,
    };
    // A refresh that comes back NARROWER is the silent killer: the account stays
    // signed in, mail keeps syncing on the scopes that survived, and only the
    // dropped ones (AI) start 403ing — with nothing in the log to say when or
    // why. Say it once, at the moment it happens.
    const lost = scopesLost(account.scopes, updated.scopes);
    if (lost.length > 0) {
      logger.warn(
        `[OAuth] ${providerId}:${email} refresh returned a NARROWER grant — lost: ${lost.join(' ')}`,
      );
    }
    await saveAccount(updated);
    return updated.accessToken;
  })();

  inflightRefresh.set(key, refreshPromise);
  try {
    return await refreshPromise;
  } finally {
    inflightRefresh.delete(key);
  }
}

/**
 * Decide whether an access token should be refreshed now.
 *
 * Uses the JWT's `exp` claim (and `iat` when present) as the source of
 * truth — this is what the resource server validates against, so it's
 * immune to the clock drift that can mislead `accessExpiresAt` (derived
 * locally from `expires_in` plus client time).
 *
 * Fires on the stricter of:
 *   - hard floor: less than REFRESH_MIN_REMAINING_SEC left, or
 *   - sliding window: more than REFRESH_AT_FRACTION of lifetime elapsed.
 *
 * If the token isn't a parseable JWT (opaque token, or Google's
 * access_token which isn't a JWT), falls back to the stored
 * `accessExpiresAt` with the same hard floor.
 */
/**
 * Milliseconds until this account's access token is DUE for refresh — the
 * EARLIER of the hard-floor point (`REFRESH_MIN_REMAINING_SEC` before `exp`)
 * and the fraction point (`REFRESH_AT_FRACTION` of the token's lifetime
 * elapsed). Negative when already overdue. Uses the JWT's `exp`/`iat` as the
 * source of truth, falling back to the stored `accessExpiresAt`/`updatedAt` for
 * opaque tokens.
 *
 * Shared by the lazy gate (`shouldRefresh`, used on every `getValidAccessToken`)
 * and the proactive `oauth-refresh-scheduler`, so both agree on exactly WHEN a
 * token needs refreshing.
 */
/**
 * Whether an OAuth refresh error is TERMINAL — the refresh token itself is
 * dead/revoked/expired and ONLY interactive re-authentication can fix it — vs a
 * transient failure (network blip, rate-limit, 5xx) that's worth retrying.
 *
 * Terminal signals: a missing/blank stored token, or the token endpoint
 * rejecting the grant (`invalid_grant` / `invalid_client` /
 * `unauthorized_client` / `invalid_token`, or a 400/401 response). Everything
 * else — `TOKEN_REFRESH_NETWORK_ERROR`, 429, 5xx, timeouts — is transient.
 */
export function isTerminalOAuthError(err: unknown): boolean {
  if (err instanceof OAuthError) {
    if (err.code === 'EMPTY_STORED_TOKEN' || err.code === 'EMPTY_REFRESH_TOKEN') return true;
    if (err.code === 'TOKEN_REFRESH_NETWORK_ERROR') return false;
    // A refresh we cut short (deadline, suspend) or never started (asleep) says
    // NOTHING about the credentials. Treating these as terminal would sign the
    // user out over a laptop lid — the opposite of the bug being fixed here.
    if (
      err.code === 'TOKEN_REFRESH_TIMEOUT' ||
      err.code === 'TOKEN_REFRESH_ABORTED' ||
      err.code === 'REFRESH_DEFERRED_SUSPENDED'
    ) {
      return false;
    }
  }
  const e = err as { message?: string; serverResponse?: string };
  const msg = `${e?.message ?? ''} ${e?.serverResponse ?? ''}`.toLowerCase();
  if (/invalid_grant|invalid_client|unauthorized_client|invalid_token/.test(msg)) return true;
  if (/\(400\)|\(401\)/.test(msg)) return true;
  return false;
}

/** True when the account no longer exists (removed) — cancel, don't re-auth. */
export function isAccountGoneError(err: unknown): boolean {
  return err instanceof OAuthError && err.code === 'ACCOUNT_NOT_FOUND';
}

export function msUntilRefresh(account: OAuthAccount): number {
  const now = Math.floor(Date.now() / 1000);
  const claims = decodeJwtClaims(account.accessToken);
  const exp = claims?.exp ?? account.accessExpiresAt;
  // Prefer JWT iat for lifetime; fall back to the stored issuance (updatedAt is
  // set on every refresh, so it's the most recent "issued at us" time we have
  // for opaque tokens).
  const iat = claims?.iat ?? account.updatedAt;
  const lifetime = exp - iat;
  const floorDueAt = exp - REFRESH_MIN_REMAINING_SEC;
  const fractionDueAt = lifetime > 0 ? iat + lifetime * REFRESH_AT_FRACTION : floorDueAt;
  const dueAt = Math.min(floorDueAt, fractionDueAt);
  return (dueAt - now) * 1000;
}

function shouldRefresh(account: OAuthAccount): boolean {
  return msUntilRefresh(account) <= 0;
}

/**
 * Decode a JWT's payload without verifying the signature — we only need
 * `exp`/`iat` for refresh scheduling, and the server re-validates on
 * every API call anyway. Returns null for non-JWT tokens.
 */
function decodeJwtClaims(token: string): { exp?: number; iat?: number } | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const payload = Buffer.from(parts[1], 'base64url').toString('utf8');
    const claims = JSON.parse(payload) as Record<string, unknown>;
    const exp = typeof claims.exp === 'number' ? claims.exp : undefined;
    const iat = typeof claims.iat === 'number' ? claims.iat : undefined;
    return { exp, iat };
  } catch {
    return null;
  }
}

export async function signOut(providerId: OAuthProviderId, email: string): Promise<void> {
  await removeAccount(providerId, email);
}

export async function listSignedInAccounts(): Promise<OAuthAccount[]> {
  return listAccounts();
}

/**
 * Wrap an AIProviderConfig coming from the renderer so LLM calls can fetch
 * a fresh OAuth bearer per request. The renderer marshals ``authMethod``,
 * ``oauthProvider``, and ``oauthEmail`` alongside the usual apiKey/model —
 * if those fields indicate OAuth, we attach a ``resolveBearer`` closure
 * (not serializable over IPC, so must happen here in main).
 *
 * For non-OAuth providers (OpenAI with a pasted apiKey, Gemini, custom)
 * this is a no-op — the config passes through unchanged.
 */
export function attachOAuthBearer<
  C extends {
    authMethod?: 'apiKey' | 'oauth';
    oauthProvider?: OAuthProviderId;
    oauthEmail?: string;
    resolveBearer?: (forceRefresh?: boolean) => Promise<string>;
  },
>(config: C): C {
  if (
    config.authMethod === 'oauth' &&
    config.oauthProvider &&
    config.oauthEmail
  ) {
    const providerId = config.oauthProvider;
    const email = config.oauthEmail;
    // The closure forwards `forceRefresh` so a call site can force a fresh
    // token on 401 and retry, instead of failing the whole categorization run.
    return {
      ...config,
      resolveBearer: (forceRefresh?: boolean) => getValidAccessToken(providerId, email, forceRefresh),
    };
  }
  return config;
}

// ---------- Internal helpers ----------

/**
 * Preferred loopback ports for the OAuth callback. We try them in order
 * until one is free. They must all be registered as allowed redirect_uris
 * on the provider (Sarv does strict exact-match; Google accepts any).
 *   http://127.0.0.1:51823/cb
 *   http://127.0.0.1:51824/cb
 *   http://127.0.0.1:51825/cb
 * If all three are in use (extremely rare), we fall back to ephemeral
 * port 0 and the flow will fail with redirect_uri_mismatch on strict
 * servers — the user then needs to free one of the preferred ports.
 */
const PREFERRED_PORTS = [51823, 51824, 51825];

// Only one interactive loopback flow runs at a time (it's driven by a single
// "Sign in with X" modal). Track it so we can ABORT a pending flow — closing its
// loopback server releases the registered redirect port and lets the user retry.
// Without this, hitting Back left the flow (and its server) alive: the button
// stayed a disabled spinner and, after a few retries, all preferred ports were
// held → the flow fell back to an unregistered ephemeral port → redirect_uri
// mismatch.
let activeLoopbackFlow: { cancel: () => void } | null = null;

/** Abort the in-flight interactive OAuth loopback flow, if any. Safe to call
 *  when nothing is running (no-op). Rejects the pending flow with FLOW_CANCELLED
 *  and frees the loopback port. */
export function cancelOAuthFlow(): void {
  activeLoopbackFlow?.cancel();
}

function runLoopbackFlow(
  provider: OAuthProviderConfig,
  codeChallenge: string,
  expectedState: string,
): Promise<{ code: string; redirectUri: string }> {
  // A previous flow still pending (e.g. user hit Back then clicked again) — kill
  // it first so its server releases the registered redirect port before we bind.
  activeLoopbackFlow?.cancel();

  return new Promise((resolve, reject) => {
    const server = http.createServer();
    let settled = false;

    // Single exit point: clear the timeout, close the server, deregister this
    // flow, and resolve/reject exactly once (guards against a late redirect
    // racing the timeout/cancel).
    const settle = (run: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try { server.close(); } catch { /* already closing */ }
      if (activeLoopbackFlow === handle) activeLoopbackFlow = null;
      run();
    };
    const done = (value: { code: string; redirectUri: string }) => settle(() => resolve(value));
    const fail = (err: unknown) => settle(() => reject(err));

    const timeout = setTimeout(
      () => fail(new OAuthError('OAuth flow timed out (5 minutes)', 'FLOW_TIMEOUT')),
      5 * 60 * 1000,
    );

    const handle = {
      cancel: () => fail(new OAuthError('OAuth sign-in cancelled', 'FLOW_CANCELLED')),
    };
    activeLoopbackFlow = handle;

    server.on('request', (req, res) => {
      try {
        const url = new URL(req.url || '/', `http://127.0.0.1`);
        if (url.pathname !== '/cb') {
          res.writeHead(404); res.end(); return;
        }
        const err = url.searchParams.get('error');
        if (err) {
          respondHtml(res, 'error', err);
          fail(new OAuthError(`Provider returned error: ${err}`, 'PROVIDER_ERROR', err));
          return;
        }
        const code = url.searchParams.get('code');
        const state = url.searchParams.get('state');
        if (!code || !state) {
          respondHtml(res, 'error', 'missing_code');
          fail(new OAuthError('Missing code or state in callback', 'BAD_CALLBACK'));
          return;
        }
        if (state !== expectedState) {
          respondHtml(res, 'error', 'state_mismatch');
          fail(new OAuthError('OAuth state mismatch — possible CSRF', 'STATE_MISMATCH'));
          return;
        }
        respondHtml(res, 'ok');
        const addr = server.address() as AddressInfo;
        const redirectUri = `http://127.0.0.1:${addr.port}/cb`;
        done({ code, redirectUri });
      } catch (e) {
        fail(e);
      }
    });

    // Try preferred fixed ports, then fall back to an ephemeral port.
    const onListening = () => {
      const addr = server.address() as AddressInfo;
      const redirectUri = `http://127.0.0.1:${addr.port}/cb`;
      const authUrl = buildAuthUrl(provider, redirectUri, codeChallenge, expectedState);
      shell.openExternal(authUrl).catch((e) => fail(e));
    };
    // Register exactly ONCE, outside the retry loop. Passing the callback
    // to every listen() attempt left one once-listener per failed port, so
    // the eventual success fired them all → multiple consent tabs.
    server.once('listening', onListening);

    const tryPorts = (ports: number[]) => {
      const [next, ...rest] = ports;
      server.removeAllListeners('error');
      server.once('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE' && rest.length > 0) {
          tryPorts(rest);
          return;
        }
        // Last-resort: ephemeral port. This will fail on strict servers
        // (Sarv) with redirect_uri_mismatch; user must free a preferred port.
        if (err.code === 'EADDRINUSE') {
          logger.warn('[OAuth] All preferred loopback ports in use — falling back to ephemeral');
          server.removeAllListeners('error');
          server.once('error', (e) => fail(e));
          server.listen(0, '127.0.0.1');
          return;
        }
        fail(err);
      });
      server.listen(next, '127.0.0.1');
    };

    tryPorts([...PREFERRED_PORTS]);
  });
}

function buildAuthUrl(
  provider: OAuthProviderConfig,
  redirectUri: string,
  codeChallenge: string,
  state: string,
): string {
  const params = new URLSearchParams({
    client_id: provider.clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: provider.scopes.join(' '),
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    state,
    ...(provider.extraAuthParams || {}),
  });
  return `${provider.authEndpoint}?${params.toString()}`;
}

async function fetchUserInfo(
  provider: OAuthProviderConfig,
  accessToken: string,
): Promise<OAuthUserInfo> {
  const res = await fetch(provider.userInfoEndpoint, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw new OAuthError(`userinfo failed (${res.status})`, 'USERINFO_FAILED');
  }
  const body = (await res.json()) as Record<string, string>;
  if (!body.email) {
    throw new OAuthError('userinfo response missing email', 'USERINFO_NO_EMAIL');
  }
  return { email: body.email, name: body.name, picture: body.picture };
}

function respondHtml(res: http.ServerResponse, kind: 'ok' | 'error', detail = ''): void {
  const title = kind === 'ok' ? 'Signed in' : 'Sign-in failed';
  const body = kind === 'ok'
    ? 'You can close this tab and return to Sarv Inbox.'
    : `Sign-in failed: ${escapeHtml(detail)}. Close this tab and try again.`;
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:-apple-system,system-ui,sans-serif;max-width:480px;margin:80px auto;padding:24px;text-align:center;color:#1f2937}
h1{font-size:22px;margin:0 0 12px}p{color:#4b5563}</style></head>
<body><h1>${title}</h1><p>${body}</p></body></html>`;
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}
