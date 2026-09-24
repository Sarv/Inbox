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
  isTerminalOAuthError,
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
import { shell } from 'electron';

import { getSystemSuspended } from '../shared';

import { waitForNetworkReady } from './network-readiness';
import { getAccount, removeAccount, saveAccount, listAccounts } from './oauth-token-store';
import { getReauthRequirement } from './reauth-registry';
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
  // A session the user must re-authorize will not recover by being asked again:
  // every refresh is a guaranteed rejection, and replaying a spent token is
  // exactly what a reuse detector counts against the family. Fail fast, with
  // the recorded reason, so each connect attempt costs nothing and no request
  // leaves the machine.
  //
  // Placed like the suspend gate below — AFTER the cached-token fast path (a
  // still-valid access token keeps working) and AFTER the single-flight join (a
  // refresh already in the air runs to completion). Cleared the moment the user
  // signs in (`rescheduleOAuthAccount`), and never persisted, so a restart
  // always gets one fresh attempt.
  const pendingReauth = getReauthRequirement(providerId, email);
  if (pendingReauth) {
    throw new OAuthError(
      `OAuth session for ${providerId}:${email} needs an interactive sign-in — ${pendingReauth.reason}`,
      'REAUTH_REQUIRED',
    );
  }

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
 * Re-exported so existing callers keep one import site. The implementation
 * lives in core because the IMAP reconnect ladder needs the SAME verdict — see
 * `isAuthError` in `imap-errors`. Two copies is exactly how the ladder ended up
 * retrying a revoked session forever.
 */
export { isTerminalOAuthError };

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
 * Preferred loopback ports for the OAuth callback. Tried in order until one
 * binds. They must all be registered as allowed redirect_uris on the provider
 * (Sarv does strict exact-match; Google accepts any).
 *   http://127.0.0.1:51823/cb
 *   http://127.0.0.1:51824/cb
 *   http://127.0.0.1:51825/cb
 * If all three are held by another process we fall back to ephemeral port 0;
 * a strict server then answers redirect_uri_mismatch and the user has to free
 * one of the preferred ports.
 */
const PREFERRED_PORTS = [51823, 51824, 51825];

/**
 * A sign-in waiting for its redirect, keyed by the `state` we issued for it.
 *
 * Keying by state is also the CSRF check: a callback carrying a state we never
 * issued matches nothing and can complete nothing.
 */
interface PendingFlow {
  /** The redirect_uri sent to the provider — echoed back to the token exchange. */
  redirectUri: string;
  done: (code: string) => void;
  fail: (err: unknown) => void;
}

const pendingFlows = new Map<string, PendingFlow>();

/**
 * Only one interactive flow runs at a time (it is driven by a single "Sign in
 * with X" modal), so remember which state is the live one — that is the flow
 * `cancelOAuthFlow()` aborts.
 */
let activeFlowState: string | null = null;

/**
 * The loopback listener, bound ONCE and kept for the life of the process.
 *
 * It deliberately outlives the flow that started it. A server owned by a single
 * flow is closed by every cancel — Back in the modal, a superseding click, the
 * five-minute timeout — and the next flow then races the OS to rebind: it gets
 * EADDRINUSE on the just-closed socket, moves to the next preferred port, and
 * the consent page still in the user's browser redirects to the port it was
 * issued, where nothing is listening. That is ERR_CONNECTION_REFUSED on
 * 127.0.0.1:51823 after a successful sign-in. One long-lived listener removes
 * the whole class: the port never moves, and a redirect that arrives late gets
 * an explanatory page instead of a refused connection.
 */
let callbackServer: { server: http.Server; port: number } | null = null;
let callbackServerPending: Promise<{ server: http.Server; port: number }> | null = null;

/** Listen on one port, resolving on success and rejecting on the bind error. */
const listenOnce = (server: http.Server, port: number): Promise<void> =>
  new Promise((resolve, reject) => {
    const onError = (err: Error) => {
      server.removeListener('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '127.0.0.1');
  });

/** Bind the first free preferred port, falling back to an ephemeral one. */
const bindCallbackServer = async (server: http.Server): Promise<number> => {
  for (const port of PREFERRED_PORTS) {
    try {
      await listenOnce(server, port);
      return (server.address() as AddressInfo).port;
    } catch (err) {
      // Anything but "taken" is a real failure (no loopback, sandboxed, …).
      if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw err;
    }
  }
  logger.warn(
    '[OAuth] All preferred loopback ports are in use — falling back to an ephemeral port. ' +
      'A strict provider (Sarv) will answer redirect_uri_mismatch; free 51823-51825 and retry.',
  );
  await listenOnce(server, 0);
  return (server.address() as AddressInfo).port;
};

/**
 * Handle one redirect. Every branch writes a response: a browser left on a
 * blank tab reads as "the app hung", which is exactly what the user sees when
 * the callback finds nothing to complete.
 */
const handleCallbackRequest = (req: http.IncomingMessage, res: http.ServerResponse): void => {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  if (url.pathname !== '/cb') {
    res.writeHead(404);
    res.end();
    return;
  }

  const state = url.searchParams.get('state') ?? '';
  const pending = pendingFlows.get(state);
  if (!pending) {
    // The flow was cancelled, timed out, or already completed — or this state
    // was never ours. Nothing to complete, so say so instead of leaving the
    // browser to guess.
    logger.warn('[OAuth] Loopback callback for an unknown or finished sign-in — ignored');
    respondHtml(res, 'expired');
    return;
  }

  const providerError = url.searchParams.get('error');
  if (providerError) {
    respondHtml(res, 'error', providerError);
    pending.fail(
      new OAuthError(`Provider returned error: ${providerError}`, 'PROVIDER_ERROR', providerError),
    );
    return;
  }

  const code = url.searchParams.get('code');
  if (!code) {
    respondHtml(res, 'error', 'missing_code');
    pending.fail(new OAuthError('Missing code in callback', 'BAD_CALLBACK'));
    return;
  }

  respondHtml(res, 'ok');
  logger.info('[OAuth] Loopback callback received — exchanging the authorization code');
  pending.done(code);
};

/** The loopback listener, started on first use and reused after that. */
const ensureCallbackServer = (): Promise<{ server: http.Server; port: number }> => {
  if (callbackServer) return Promise.resolve(callbackServer);
  if (!callbackServerPending) {
    const server = http.createServer();
    server.on('request', (req, res) => {
      try {
        handleCallbackRequest(req, res);
      } catch (err) {
        logger.warn('[OAuth] Loopback callback failed:', err);
        if (!res.headersSent) respondHtml(res, 'error', 'callback_failed');
      }
    });
    // A closed socket must not be handed to the next flow as if it were live.
    server.on('close', () => {
      callbackServer = null;
    });
    callbackServerPending = bindCallbackServer(server)
      .then((port) => {
        // Never hold the app (or a test run) open on an idle listener.
        server.unref();
        callbackServer = { server, port };
        logger.info(`[OAuth] Loopback callback server listening on http://127.0.0.1:${port}/cb`);
        return callbackServer;
      })
      .finally(() => {
        callbackServerPending = null;
      });
  }
  return callbackServerPending;
};

/**
 * Stop the loopback listener and reject anything still waiting on it. Only
 * needed to release the port deterministically (tests, shutdown) — normal
 * cancellation leaves the listener up on purpose.
 */
export function closeOAuthCallbackServer(): void {
  cancelOAuthFlow();
  const current = callbackServer;
  callbackServer = null;
  try {
    current?.server.close();
  } catch {
    /* already closing */
  }
}

/** Abort the in-flight interactive OAuth flow, if any. No-op when idle.
 *  Rejects the pending sign-in with FLOW_CANCELLED; the loopback port stays
 *  bound, so the next attempt reuses the same registered redirect_uri. */
export function cancelOAuthFlow(): void {
  const state = activeFlowState;
  if (!state) return;
  pendingFlows.get(state)?.fail(new OAuthError('OAuth sign-in cancelled', 'FLOW_CANCELLED'));
}

async function runLoopbackFlow(
  provider: OAuthProviderConfig,
  codeChallenge: string,
  expectedState: string,
): Promise<{ code: string; redirectUri: string }> {
  // A previous flow still pending (e.g. the user hit Back then clicked again)
  // is superseded, not left to answer over the top of this one.
  cancelOAuthFlow();

  const { port } = await ensureCallbackServer();
  const redirectUri = `http://127.0.0.1:${port}/cb`;

  return new Promise((resolve, reject) => {
    let settled = false;

    // Single exit point: clear the timeout, deregister the flow, and
    // resolve/reject exactly once (a late redirect racing a cancel or the
    // timeout finds nothing registered and gets the "expired" page).
    const settle = (run: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      pendingFlows.delete(expectedState);
      if (activeFlowState === expectedState) activeFlowState = null;
      run();
    };
    const done = (code: string) => settle(() => resolve({ code, redirectUri }));
    const fail = (err: unknown) => settle(() => reject(err));

    const timeout = setTimeout(
      () => fail(new OAuthError('OAuth flow timed out (5 minutes)', 'FLOW_TIMEOUT')),
      5 * 60 * 1000,
    );
    // The timer must not keep the app alive for five minutes after a quit.
    timeout.unref?.();

    pendingFlows.set(expectedState, { redirectUri, done, fail });
    activeFlowState = expectedState;

    const authUrl = buildAuthUrl(provider, redirectUri, codeChallenge, expectedState);
    shell.openExternal(authUrl).catch((err) => fail(err));
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

/**
 * Answer the browser. `expired` is the page for a redirect that no longer has a
 * sign-in to complete (cancelled, timed out, already done, or a state we never
 * issued) — the case that used to show ERR_CONNECTION_REFUSED because the
 * listener had been torn down with its flow.
 */
function respondHtml(
  res: http.ServerResponse,
  kind: 'ok' | 'error' | 'expired',
  detail = '',
): void {
  const title =
    kind === 'ok' ? 'Signed in' : kind === 'expired' ? 'This sign-in has expired' : 'Sign-in failed';
  const body =
    kind === 'ok'
      ? 'You can close this tab and return to Sarv Inbox.'
      : kind === 'expired'
        ? 'This sign-in was cancelled or took too long. Close this tab, return to Sarv Inbox and start the sign-in again.'
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
