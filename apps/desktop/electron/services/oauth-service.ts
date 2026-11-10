/**
 * OAuth service (main process).
 *
 * Runs the full PKCE "authorization code" flow for Gmail/Microsoft/Yahoo:
 *   1. Open the loopback HTTP listener on 127.0.0.1 (the first free preferred
 *      port) — only while a sign-in is pending; it closes when the last settles.
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
  decodeJwtPayload,
  exchangeCodeForTokens,
  generatePkcePair,
  generateState,
  getOAuthProvider,
  isOAuthMailHostAllowed,
  isOAuthProviderConfigured,
  isSarvAIEndpointAllowed,
  listOAuthProviders,
  OAuthError,
  refreshAccessToken,
  revokeToken,
  isTerminalOAuthError,
  SARV_PRODUCTION_CLIENT_ID,
  scopesLost,
  scopesNotGranted,
  setOAuthClientId,
  setOAuthClientSecret,
  setSarvBaseUrl,
  TOKEN_REQUEST_TIMEOUT_MS,
  userInfoFromIdToken,
  withTimeout,
  type OAuthAccount,
  type OAuthMailProtocol,
  type OAuthProviderId,
  type OAuthProviderConfig,
  type OAuthUserInfo,
  type RevokeOutcome,
  type IMAPConfig,
  createLogger,
  escapeHtml,
} from '@sarvinbox/core';
import { shell } from 'electron';

import { getSystemSuspended } from '../shared';
import { isReleaseBundle } from '../utils/dev-mode';
import { loopbackCallbackCsp, setLoopbackCallbackHeaders } from '../utils/loopback-callback-headers';
import { closeLoopbackServer, trackLoopbackResponse, type AnsweringResponses } from '../utils/loopback-server-close';

import { waitForNetworkReady } from './network-readiness';
import { OAUTH_CALLBACK_PORTS } from './oauth-callback-ports';
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

// A forced refresh recovers a token the server refused although our clock still
// called it valid (skew, idle ageing, a server-side reissue). A token minted
// less than this long ago cannot be any of those: its successor carries the same
// grant and audience and is refused the same way, while every refresh spends the
// refresh token (and, on a rotating provider, replaces it). Within this window a
// force is ignored and the normal gate decides. Measured 2026-11-07: a 401 on
// every Sarv catalog call ("Token audience does not match this service") forced
// 9 refreshes in one minute.
const FORCED_REFRESH_MIN_AGE_SEC = 60;

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
  if (msId) {
    setOAuthClientId('microsoft', msId);
    logger.info('[OAuth] Microsoft client_id loaded from env');
  }
  const yhId = process.env.SARVINBOX_YAHOO_CLIENT_ID;
  if (yhId) setOAuthClientId('yahoo', yhId);

  // Sarv: each base URL is independently dev-switchable — the OAuth server,
  // the catalog API and the edge LLM gateway can each point at a different
  // host. See SARV_OAUTH_SETUP.md. A release build takes none of them.
  const sarv = sarvEnvOverrides();
  const sarvOauthBase = sarv.SARVINBOX_SARV_OAUTH_BASE_URL;
  const sarvApiBase = sarv.SARVINBOX_SARV_API_BASE_URL;
  const sarvEdgeBase = sarv.SARVINBOX_SARV_EDGE_BASE_URL;
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
  const sarvId = sarv.SARVINBOX_SARV_CLIENT_ID || SARV_PRODUCTION_CLIENT_ID;
  setOAuthClientId('sarv', sarvId);
  logger.info(
    sarv.SARVINBOX_SARV_CLIENT_ID
      ? '[OAuth] Sarv client_id loaded from env'
      : '[OAuth] Sarv client_id using production default',
  );
  const sarvSecret = sarv.SARVINBOX_SARV_CLIENT_SECRET;
  if (sarvSecret) {
    setOAuthClientSecret('sarv', sarvSecret);
    logger.info('[OAuth] Sarv client_secret loaded from env');
  }
}

/**
 * The environment variables that re-point the Sarv sign-in. Every one of them
 * decides where a Sarv credential goes: the server that hosts the consent page
 * and receives the authorization code, the API and gateway the bearer is sent
 * to (`isSarvAIEndpointAllowed` trusts whatever these name), and the client
 * registration the tokens are issued to.
 */
const SARV_ENV_OVERRIDES = [
  'SARVINBOX_SARV_OAUTH_BASE_URL',
  'SARVINBOX_SARV_API_BASE_URL',
  'SARVINBOX_SARV_EDGE_BASE_URL',
  'SARVINBOX_SARV_CLIENT_ID',
  'SARVINBOX_SARV_CLIENT_SECRET',
] as const;
type SarvEnvOverride = (typeof SARV_ENV_OVERRIDES)[number];

/**
 * The Sarv overrides this build honours: every non-empty one in a dev build,
 * none in a release bundle. A shipped app's environment belongs to whoever
 * launched it — a shell profile, a launch agent, a wrapper script — so letting
 * it choose the OAuth server would let any of them collect a sign-in. Same rule,
 * and the same build-time signal, as the `.env` file and VITE_DEV_SERVER_URL
 * (`isReleaseBundle`, CASA L-3). An ignored override is named once, never its
 * value: a client secret must not reach the log.
 */
function sarvEnvOverrides(): Partial<Record<SarvEnvOverride, string>> {
  const present = SARV_ENV_OVERRIDES.filter((name) => process.env[name]);
  if (!isReleaseBundle()) {
    return Object.fromEntries(present.map((name) => [name, process.env[name]]));
  }
  if (present.length > 0) {
    logger.warn(
      `[OAuth] Release build — ignoring ${present.join(', ')} from the environment; using the built-in Sarv endpoints and client`,
    );
  }
  return {};
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

  const userInfo =
    provider.identityFrom === 'id_token'
      ? userInfoFromIdToken(tokens.id_token)
      : await fetchUserInfo(provider, tokens.access_token);

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
const inflightRefresh = new Map<string, { promise: Promise<string>; signOutCount: number }>();

/**
 * Sign-outs per provider:email. A refresh notes the count before its first
 * await and re-checks it around every step: once it has moved, the refresh sends
 * nothing more and saves nothing, so tokens deleted a moment ago cannot come
 * back from a response that was already in the air, and the user is not asked to
 * sign in again to an account they just removed.
 */
const signOutCounts = new Map<string, number>();

/**
 * Refresh tokens a provider issued to a refresh that ended after its account was
 * signed out. Nothing on this device can use them, but the grant is live under
 * them, so they are what the sign-out has to revoke.
 */
const rotatedAfterSignOut = new Map<string, string>();

/**
 * Sign-outs whose in-flight refresh ended with no answer from the server (a
 * timeout, an abort, a dropped connection). It may have spent the stored token,
 * which would leave the grant live under one nobody here ever saw.
 */
const refreshUnansweredAtSignOut = new Set<string>();

/** Longest a sign-out waits for an in-flight refresh before revoking anyway. */
const REFRESH_SETTLE_WAIT_MS = TOKEN_REQUEST_TIMEOUT_MS + 2_000;

const oauthAccountKey = (providerId: OAuthProviderId, email: string): string =>
  `${providerId}:${email.toLowerCase()}`;

const signOutCountOf = (key: string): number => signOutCounts.get(key) ?? 0;

const accountGoneError = (providerId: OAuthProviderId, email: string): OAuthError =>
  new OAuthError(`No OAuth account for ${providerId}:${email}`, 'ACCOUNT_NOT_FOUND');

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
  const host = config.host;
  // Checked HERE, not only inside the closure, so a refused host fails the
  // connect up front instead of handing the pool a resolver that throws later.
  assertOAuthMailHost(provider, 'imap', host);
  return {
    ...config,
    resolveBearer: (forceRefresh?: boolean) => getAccessTokenForMailHost(provider, email, 'imap', host, forceRefresh),
  };
}

/**
 * Refuse to mint a mail bearer for a host that is not one of `providerId`'s own
 * IMAP/SMTP servers. The IMAP/SMTP config (host included) arrives from the
 * renderer, so without this a compromised renderer could have main send the
 * user's Gmail token to a server of its choosing (see token-destinations.ts).
 * Refused BEFORE the token store is read, and logged as a security event.
 */
function assertOAuthMailHost(providerId: string, protocol: OAuthMailProtocol, host: string | undefined): void {
  if (isOAuthMailHostAllowed(providerId, protocol, host)) return;
  logger.warn(`[OAuth] Refused a ${providerId} token for ${protocol.toUpperCase()} host "${host ?? ''}" — not one of that provider's mail servers`);
  throw new OAuthError(
    `A ${providerId} sign-in can only be used with ${providerId}'s own mail servers, not ${host || 'an unspecified host'}.`,
    'TOKEN_DESTINATION_REFUSED',
  );
}

/**
 * `getValidAccessToken` for a bearer that is about to be sent to a mail server.
 * Every IMAP/SMTP connect path goes through this (or `attachImapBearer`), never
 * through `getValidAccessToken` directly.
 */
export async function getAccessTokenForMailHost(
  providerId: OAuthProviderId,
  email: string,
  protocol: OAuthMailProtocol,
  host: string | undefined,
  forceRefresh = false,
): Promise<string> {
  assertOAuthMailHost(providerId, protocol, host);
  return getValidAccessToken(providerId, email, forceRefresh);
}

export async function getValidAccessToken(
  providerId: OAuthProviderId,
  email: string,
  forceRefresh = false,
): Promise<string> {
  const key = oauthAccountKey(providerId, email);
  const signOutCount = signOutCountOf(key);
  const account = await getAccount(providerId, email);
  if (!account || signOutCountOf(key) !== signOutCount) throw accountGoneError(providerId, email);
  // `forceRefresh` bypasses the proactive expiry gate — used to recover from a
  // 401 where the resource server rejected a token our local clock still
  // thought was valid (clock skew, server-side revocation-then-reissue, or a
  // token that aged out while the app sat idle and made no calls). Not for a
  // token minted moments ago (FORCED_REFRESH_MIN_AGE_SEC).
  const forced = forceRefresh && !mintedWithin(account, FORCED_REFRESH_MIN_AGE_SEC);
  if (!forced && !shouldRefresh(account)) {
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

  // Single-flight: join an already-running refresh for this account. Not one left
  // over from a sign-in that has since been signed out, which can only end in
  // "account gone" and would report that for the account signed in again now.
  const existing = inflightRefresh.get(key);
  if (existing?.signOutCount === signOutCount) return existing.promise;

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

  const signedOutSinceStart = (): boolean => signOutCountOf(key) !== signOutCount;

  // Save a refresh's result unless the account was signed out meanwhile. Checked
  // on both sides of the write: the store's write can interleave with its
  // removal, and that must not leave tokens behind.
  const saveUnlessSignedOut = async (next: OAuthAccount): Promise<void> => {
    if (!signedOutSinceStart()) {
      await saveAccount(next);
      if (!signedOutSinceStart()) return;
      await removeAccount(providerId, email);
    }
    if (next.refreshToken !== account.refreshToken) rotatedAfterSignOut.set(key, next.refreshToken);
    throw accountGoneError(providerId, email);
  };

  const refreshPromise = (async () => {
    // Captured BEFORE the first await: `abortInFlightTokenRefreshes` swaps the
    // controller, and reading `.signal` later would hand this refresh the fresh
    // one and quietly miss the abort it was meant to receive.
    const abortSignal = refreshAbort.signal;
    const provider = getOAuthProvider(providerId);
    // A wake's first seconds have no DNS. Let the link settle rather than
    // spending this refresh on a guaranteed ENOTFOUND.
    await waitForNetworkReady();
    // Signed out during that wait: the token is being revoked. Presenting it now
    // is exactly what a reuse detector counts against the session.
    if (signedOutSinceStart()) throw accountGoneError(providerId, email);
    const tokens = await refreshAccessToken({
      provider,
      refreshToken: account.refreshToken,
      signal: abortSignal,
    });
    const now = Math.floor(Date.now() / 1000);

    // Observability: does this provider ROTATE the refresh token? A rotating
    // provider returns a NEW refresh_token on each refresh (sliding window);
    // Sarv does (seen in the dev log on 2026-11-07: "ROTATED" on every refresh).
    // Logging it makes the behaviour verifiable at runtime and flags a silent
    // policy change. Low-frequency (once per ~10-min token cycle).
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
      await saveUnlessSignedOut({ ...account, refreshToken: tokens.refresh_token!, updatedAt: now });
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
    await saveUnlessSignedOut(updated);
    return updated.accessToken;
  })().catch((err: unknown) => {
    if (!signedOutSinceStart()) throw err;
    // Whatever went wrong, it no longer matters to anyone: the account is gone,
    // so nothing may read this as a session that needs signing in again. All the
    // sign-out still needs to know is whether the server answered at all.
    const code = (err as { code?: unknown } | null)?.code;
    if (code !== 'ACCOUNT_NOT_FOUND' && code !== 'TOKEN_REFRESH_FAILED') refreshUnansweredAtSignOut.add(key);
    throw accountGoneError(providerId, email);
  });

  const inflight = { promise: refreshPromise, signOutCount };
  inflightRefresh.set(key, inflight);
  try {
    return await refreshPromise;
  } finally {
    if (inflightRefresh.get(key) === inflight) inflightRefresh.delete(key);
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
 * Whether the stored access token was minted less than `seconds` ago, by our
 * own clock: `updatedAt` is written only at sign-in and on each refresh. A clock
 * that stepped backwards reads as "just minted", which only defers a force to
 * the normal gate.
 */
function mintedWithin(account: OAuthAccount, seconds: number): boolean {
  return Math.floor(Date.now() / 1000) - account.updatedAt < seconds;
}

/**
 * Decode a JWT's payload without verifying the signature — we only need
 * `exp`/`iat` for refresh scheduling, and the server re-validates on
 * every API call anyway. Returns null for non-JWT tokens.
 */
function decodeJwtClaims(token: string): { exp?: number; iat?: number } | null {
  const claims = decodeJwtPayload(token);
  if (!claims) return null;
  const exp = typeof claims.exp === 'number' ? claims.exp : undefined;
  const iat = typeof claims.iat === 'number' ? claims.iat : undefined;
  return { exp, iat };
}

/**
 * Sign out: forget the tokens on this device (awaited, so they are gone before
 * this resolves, even if the provider is unreachable), then revoke the grant at
 * the provider where it supports RFC 7009 (Google, Sarv). The revocation is
 * handed back as its own promise so a caller can finish its own work without
 * waiting on a network round-trip. It never rejects: a 'failed' outcome is logged
 * and the user is told (see the privacy policy).
 *
 * A refresh already in flight is NOT aborted. Aborting cannot un-send it, and
 * against a rotating provider it would leave the grant live under a token we
 * never saw. The revocation waits for it instead and revokes the newest token,
 * so it can neither present a token the refresh just spent nor have that refresh
 * replay one it just revoked. Either of those reads as token theft to Sarv's
 * reuse detector (see TOKEN_REQUEST_TIMEOUT_MS in core's token-refresher).
 *
 * The tokens cannot always be deleted: rewriting the store needs the OS key store
 * to seal it, and that can be refused. The revocation still goes ahead with the
 * token in hand, so what stays on disk is dead. Only a store that could not be
 * read at all fails the sign-out, because there is then nothing to revoke with.
 */
export async function signOut(
  providerId: OAuthProviderId,
  email: string,
): Promise<{ revocation: Promise<RevokeOutcome | 'no-account'> }> {
  const key = oauthAccountKey(providerId, email);
  // Before any await: from here on, no refresh can start or save for this account.
  signOutCounts.set(key, signOutCountOf(key) + 1);
  // What an earlier sign-out left behind belongs to an older sign-in, not this one.
  rotatedAfterSignOut.delete(key);
  refreshUnansweredAtSignOut.delete(key);
  let account: OAuthAccount | null = null;
  try {
    account = await getAccount(providerId, email);
    await removeAccount(providerId, email);
  } catch (error) {
    if (!account) throw error;
    logger.error(`[OAuth] ${providerId}:${email} could not be deleted from this device: ${(error as Error)?.message}`);
  } finally {
    // Again, now the account is gone: a caller that read it just before its
    // removal, after the first count, must still see that it was signed out.
    signOutCounts.set(key, signOutCountOf(key) + 1);
  }
  if (!account) return { revocation: Promise.resolve('no-account') };
  return {
    revocation: revokeAfterRefreshSettles(providerId, email, account.refreshToken, inflightRefresh.get(key)?.promise),
  };
}

async function revokeAfterRefreshSettles(
  providerId: OAuthProviderId,
  email: string,
  storedRefreshToken: string,
  refreshing: Promise<string> | undefined,
): Promise<RevokeOutcome> {
  const key = oauthAccountKey(providerId, email);
  // Bounded by the refresh's own deadline; the bound here is only a backstop.
  const settled = !refreshing || await withTimeout(
    refreshing.then(() => true, () => true),
    REFRESH_SETTLE_WAIT_MS,
    'refresh did not settle',
  ).catch(() => false);
  const refreshUnanswered = refreshUnansweredAtSignOut.delete(key) || !settled;
  const token = rotatedAfterSignOut.get(key) ?? storedRefreshToken;
  rotatedAfterSignOut.delete(key);
  const answer = await revokeToken({ provider: getOAuthProvider(providerId), token });
  // "Not found" normally means the state we wanted. After a refresh nobody heard
  // back from, it can mean that refresh spent this token, and then the grant lives
  // on under a newer one. Nothing is confirmed, so it must not read as done.
  const outcome = answer === 'already-invalid' && refreshUnanswered ? 'failed' : answer;
  const line = `[OAuth] ${providerId}:${email} signed out — revocation ${outcome}`;
  if (outcome === 'failed') logger.warn(line);
  else logger.info(line);
  return outcome;
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
    baseUrl?: string;
    resolveBearer?: (forceRefresh?: boolean) => Promise<string>;
  },
>(config: C): C {
  if (
    config.authMethod === 'oauth' &&
    config.oauthProvider &&
    config.oauthEmail
  ) {
    // Refused configs pass through with no bearer: the request then fails as
    // unauthenticated rather than leaking a credential.
    const resolveBearer = sarvAIBearerResolver(config.oauthProvider, config.oauthEmail, config.baseUrl);
    return resolveBearer ? { ...config, resolveBearer } : config;
  }
  return config;
}

/**
 * THE rule for which OAuth sign-in may authenticate a request to an AI
 * endpoint: only a Sarv session, and only toward Sarv's own AI endpoints
 * (`isSarvAIEndpointAllowed`: a zone edge host `<zone>-ai-edge.sarv.com` over
 * https, or the configured Sarv edge origin, and only the LLM API path under
 * `/edge/v1/llm`; never a URL carrying credentials). Shared by the background
 * categorizers (`attachOAuthBearer`) and the renderer's AI proxy
 * (`ai-provider-proxy.ts`), so the two cannot drift.
 *
 * The provider, email and URL all arrive from the renderer. Without this a
 * request naming 'gmail' (or 'sarv') with a URL of its own would be sent the
 * user's Gmail token, or the Sarv token — which is also the Sarv mailbox's
 * XOAUTH2 credential (email:read/send/delete).
 *
 * Returns a resolver that mints the bearer — `forceRefresh` forces a fresh one,
 * for a retry after a 401 — or null when refused. Refusal happens BEFORE the
 * token store is read, and is logged without echoing renderer text: the
 * provider is named only if it is a real one, and the URL only by its parsed
 * origin, so a crafted value cannot forge lines in app.log.
 */
export function sarvAIBearerResolver(
  oauthProvider: unknown,
  email: string,
  url: string | undefined,
): ((forceRefresh?: boolean) => Promise<string>) | null {
  if (oauthProvider !== 'sarv' || !isSarvAIEndpointAllowed(url)) {
    logger.warn(
      `[OAuth] Refused ${describeOAuthProvider(oauthProvider)} token for AI endpoint ${describeEndpoint(url)} — only a Sarv sign-in may authenticate Sarv AI endpoints`,
    );
    return null;
  }
  return (forceRefresh?: boolean) => getValidAccessToken('sarv', email, forceRefresh);
}

/** "a gmail" for a real provider id; never the renderer's raw text otherwise. */
function describeOAuthProvider(providerId: unknown): string {
  return listOAuthProviders().some((p) => p.id === providerId) ? `a ${String(providerId)}` : 'an unrecognised provider\'s';
}

/** The URL's origin (never its path, query or credentials), for a log line. */
function describeEndpoint(url: string | undefined): string {
  if (typeof url !== 'string' || url.trim() === '') return '(none)';
  try {
    return new URL(url.trim()).origin;
  } catch {
    return '(not a URL)';
  }
}

// ---------- Internal helpers ----------

/** How long a sign-in waits for its redirect before giving up. */
const FLOW_TIMEOUT_MS = 5 * 60 * 1000;

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

interface CallbackListener {
  server: http.Server;
  port: number;
  /**
   * Each response written on this listener that has not yet reached the OS,
   * settling when it has (or its connection is gone) — what a close waits for
   * before dropping connections. See `closeLoopbackServer`.
   */
  answering: AnsweringResponses;
}

/**
 * The loopback listener — open ONLY while a sign-in is waiting for its redirect
 * (CASA 3.2.2: no local port listens when nothing needs it).
 *
 * Every flow HOLDS the listener from the moment it starts until it settles
 * (success, provider error, bad callback, timeout, cancel, browser failure);
 * the last hold released closes it, and the next sign-in opens it again on the
 * first free preferred port — the same port as last time unless another process
 * has taken it since, so the registered redirect_uri stays the same.
 *
 * What this must keep from the listener that used to live for the whole
 * process: the port never moves under a PENDING sign-in. A server owned by
 * a single flow was closed by every cancel — Back in the modal, a superseding
 * click, the timeout — and the next flow then rebound, sometimes on the next
 * preferred port, while the consent page still in the browser redirected to
 * the old one: ERR_CONNECTION_REFUSED on 127.0.0.1:51823 after a successful
 * sign-in. So a new sign-in takes its hold BEFORE it supersedes the pending
 * one; the count never reaches zero in between and the socket stays put.
 *
 * The cost: a redirect that arrives after EVERY sign-in has settled (the user
 * pressed Back, then finished consent in the browser anyway) now meets a
 * refused connection instead of the "expired" page. While any sign-in is
 * pending it still gets that page.
 */
let callbackServer: CallbackListener | null = null;
let callbackServerPending: Promise<CallbackListener> | null = null;
/** Sign-ins currently holding the listener open — see `acquireCallbackServer`. */
let callbackServerHolds = 0;

/**
 * Bumped by every cancel: the user's Back (`cancelOAuthFlow`) and teardown
 * (`closeOAuthCallbackServer`). Both reach a sign-in through `pendingFlows`,
 * but one still waiting for its listener to bind is not there yet; it compares
 * the epoch it started under once the bind returns and gives up, instead of
 * opening the browser and holding the port until the five-minute timeout.
 * Superseding a pending flow is not a cancel and does not bump it — the later
 * of two sign-ins started together must still win.
 */
let flowCancelEpoch = 0;

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
  for (const port of OAUTH_CALLBACK_PORTS) {
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
      `A strict provider (Sarv) will answer redirect_uri_mismatch; free ${OAUTH_CALLBACK_PORTS.join(', ')} and retry.`,
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
  // A redirect is a top-level GET. Anything else is refused before the state is
  // even read, so it can neither complete nor fail a sign-in.
  if (req.method !== 'GET') {
    res.writeHead(405, { Allow: 'GET' });
    res.end();
    return;
  }

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

/** Bind a new loopback listener, or join the bind already in progress. */
const ensureCallbackServer = (): Promise<CallbackListener> => {
  if (callbackServer) return Promise.resolve(callbackServer);
  if (!callbackServerPending) {
    const server = http.createServer();
    const answering: AnsweringResponses = new Map();
    server.on('request', (req, res) => {
      trackLoopbackResponse(answering, res);
      // Before any branch can write a status, so every answer carries them.
      setLoopbackCallbackHeaders(res, CALLBACK_PAGE_CSP);
      try {
        handleCallbackRequest(req, res);
      } catch (err) {
        logger.warn('[OAuth] Loopback callback failed:', err);
        if (!res.headersSent) respondHtml(res, 'error', 'callback_failed');
      }
    });
    // No 'close' handler clears `callbackServer`: the only thing that closes a
    // listener is `releaseCallbackServer`, which forgets it first. One that did
    // would fire late — after the next sign-in had bound a new listener — and
    // orphan that one, open, for the life of the process.
    callbackServerPending = bindCallbackServer(server)
      .then((port) => {
        // Never hold the app (or a test run) open on an idle listener.
        server.unref();
        callbackServer = { server, port, answering };
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
 * Take a hold on the listener, opening it if nothing holds it yet. The count
 * goes up synchronously, before the first await, so a sign-in that starts while
 * another is settling can never see it at zero. Every successful acquire is
 * paired with exactly one `releaseCallbackServer()` — the flow's `settle`.
 */
const acquireCallbackServer = async (): Promise<CallbackListener> => {
  callbackServerHolds += 1;
  try {
    return await ensureCallbackServer();
  } catch (err) {
    releaseCallbackServer();
    throw err;
  }
};

/** Drop one hold; the last one closes the listener and frees its port. */
const releaseCallbackServer = (): void => {
  callbackServerHolds -= 1;
  if (callbackServerHolds > 0) return;
  const current = callbackServer;
  callbackServer = null;
  if (current) closeCallbackListener(current);
};

/** Close the listener, letting the "Signed in" page reach the browser first (see `closeLoopbackServer`). */
const closeCallbackListener = ({ server, port, answering }: CallbackListener): void => {
  closeLoopbackServer(server, answering);
  logger.info(`[OAuth] Loopback callback server on port ${port} closed — no sign-in pending`);
};

/** FLOW_CANCELLED, for the live sign-in if there is one. Not a cancel of its own — see `flowCancelEpoch`. */
const failActiveFlow = (): void => {
  const state = activeFlowState;
  if (!state) return;
  pendingFlows.get(state)?.fail(new OAuthError('OAuth sign-in cancelled', 'FLOW_CANCELLED'));
};

/**
 * Cancel every sign-in — pending, or still waiting for its listener to bind —
 * which closes the listener. For tests and shutdown, where a pending flow must
 * not outlive its caller; the user-facing cancel is `cancelOAuthFlow()`.
 */
export function closeOAuthCallbackServer(): void {
  flowCancelEpoch += 1;
  for (const pending of [...pendingFlows.values()]) {
    pending.fail(new OAuthError('OAuth sign-in cancelled', 'FLOW_CANCELLED'));
  }
}

/** Abort the in-flight interactive OAuth flow, if any. No-op when idle.
 *  Rejects the pending sign-in with FLOW_CANCELLED — or, when it is still
 *  waiting for the listener to bind, stops it before it opens the browser —
 *  which closes the loopback listener unless another sign-in still holds it;
 *  the next attempt reopens it on the same preferred port, so the registered
 *  redirect_uri does not change. */
export function cancelOAuthFlow(): void {
  flowCancelEpoch += 1;
  failActiveFlow();
}

async function runLoopbackFlow(
  provider: OAuthProviderConfig,
  codeChallenge: string,
  expectedState: string,
): Promise<{ code: string; redirectUri: string }> {
  // Hold the listener FIRST: superseding the pending flow below releases its
  // hold, and without ours already counted that would close the socket under
  // the consent page it opened.
  const startedUnder = flowCancelEpoch;
  const { port } = await acquireCallbackServer();
  // Cancelled (Back, teardown) while the bind was in progress: this flow was
  // in no list a cancel could reach, so it checks for itself — before it
  // registers, opens the browser, and holds the port for five minutes.
  if (flowCancelEpoch !== startedUnder) {
    releaseCallbackServer();
    throw new OAuthError('OAuth sign-in cancelled', 'FLOW_CANCELLED');
  }
  const redirectUri = `http://127.0.0.1:${port}/cb`;

  // A previous flow still pending (e.g. the user hit Back then clicked again)
  // is superseded, not left to answer over the top of this one. Only after the
  // await: two sign-ins started together both wait for the same bind, and the
  // later one must still find — and cancel — the earlier.
  failActiveFlow();

  return new Promise((resolve, reject) => {
    let settled = false;

    // Single exit point: clear the timeout, deregister the flow, release its
    // hold on the listener, and resolve/reject exactly once (a late redirect
    // racing a cancel or the timeout finds nothing registered and gets the
    // "expired" page — or, with nothing else pending, a closed port).
    const settle = (run: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      pendingFlows.delete(expectedState);
      if (activeFlowState === expectedState) activeFlowState = null;
      releaseCallbackServer();
      run();
    };
    const done = (code: string) => settle(() => resolve({ code, redirectUri }));
    const fail = (err: unknown) => settle(() => reject(err));

    const timeout = setTimeout(
      () => fail(new OAuthError('OAuth flow timed out (5 minutes)', 'FLOW_TIMEOUT')),
      FLOW_TIMEOUT_MS,
    );
    // The timer must not keep the app alive for five minutes after a quit.
    timeout.unref?.();

    pendingFlows.set(expectedState, { redirectUri, done, fail });
    activeFlowState = expectedState;

    // A launcher that throws instead of rejecting must still settle the flow,
    // or it would hold the port open until the timeout.
    try {
      shell
        .openExternal(buildAuthUrl(provider, redirectUri, codeChallenge, expectedState))
        .catch((err) => fail(err));
    } catch (err) {
      fail(err);
    }
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
 * The callback page's only styling. Its CSP admits exactly this text by hash,
 * so it lives in one constant that both the page and the policy are built from.
 */
const CALLBACK_PAGE_STYLE = `body{font-family:-apple-system,system-ui,sans-serif;max-width:480px;margin:80px auto;padding:24px;text-align:center;color:#1f2937}
h1{font-size:22px;margin:0 0 12px}p{color:#4b5563}`;
const CALLBACK_PAGE_CSP = loopbackCallbackCsp({ inlineStyle: CALLBACK_PAGE_STYLE });

/**
 * Answer the browser. `expired` is the page for a redirect that no longer has a
 * sign-in to complete (cancelled, timed out, already done, or a state we never
 * issued) while another sign-in keeps the listener open.
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
<style>${CALLBACK_PAGE_STYLE}</style></head>
<body><h1>${title}</h1><p>${body}</p></body></html>`;
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}
