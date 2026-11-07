# Sarv OAuth Setup

Sarv Inbox can sign in to a **Sarv account** with OAuth 2.1 + PKCE. One sign-in
does two things:

- **Mailbox access** — the access token authenticates the Sarv mailbox over
  IMAP/SMTP (`imap.sarv.com:993`, `smtp.sarv.com:465`) via XOAUTH2 /
  OAUTHBEARER, so no password is stored for the account.
- **AI provider** — the same session lets the app call the Sarv LLM API on the
  user's behalf, without pasting an API key.

The refresh token is stored encrypted with Electron `safeStorage`, and access
tokens are refreshed automatically before they expire. Gmail / Outlook / Yahoo
accounts are unaffected — see [OAUTH_SETUP.md](./OAUTH_SETUP.md) for those.

This document covers what a contributor or self-builder needs: how the flow
works, which environment variables control it, and how to point a build at a
different Sarv environment or client registration.

## Works out of the box

Sarv's OAuth server is a hosted service (`https://oauth.sarv.com`) — you don't
run it yourself. A public `client_id` for the "Sarv Inbox" desktop app is
compiled into the app
([`apps/desktop/electron/services/oauth-service.ts`](apps/desktop/electron/services/oauth-service.ts)),
so a build from source can sign in with a Sarv account **without any
configuration**. Per RFC 8252 / OAuth 2.0 §2.3.1 a native-app `client_id` is
not a secret; PKCE is what protects the flow (see "Security model" below).

You only need the rest of this document if you want to use your **own** client
registration (for example for a separately distributed fork) or target a
non-production Sarv environment.

## Configuration (environment variables)

All values are optional and are read once at startup by `initializeOAuth()`.
In dev, put them in the gitignored `.env` at the repo root (see
[`.env.example`](./.env.example)).

They are **dev-build only.** A release build (`vite build`, i.e. every shipped
app) ignores all five and uses the built-in production client and endpoints,
whatever its environment says: a shipped app's environment belongs to whoever
launched it, and these decide where the sign-in and the Sarv token go. It logs
`[OAuth] Release build — ignoring <names> …` once, naming each ignored
variable but never its value.

| Variable | Purpose | Default |
| --- | --- | --- |
| `SARVINBOX_SARV_CLIENT_ID` | OAuth client id to use instead of the built-in one | built-in production client |
| `SARVINBOX_SARV_CLIENT_SECRET` | Optional. Sent to the token endpoint only if set — the default registration is a public PKCE client and needs none | unset |
| `SARVINBOX_SARV_OAUTH_BASE_URL` | Base URL of the OAuth server; `/api/oauth/authorize`, `/api/oauth/token`, `/api/oauth/userinfo` and `/api/oauth/revoke` are appended | `https://oauth.sarv.com` |
| `SARVINBOX_SARV_API_BASE_URL` | Base URL of the Sarv API (the LLM provider, model and zone catalog) | `https://ai.sarv.com` |
| `SARVINBOX_SARV_EDGE_BASE_URL` | Base URL of the LLM gateway; `/edge/v1/llm` is appended | Sarv's production edge |

```bash
cp .env.example .env      # then fill in the SARVINBOX_SARV_* values you need
pnpm dev:desktop
```

The main process logs which source it used —
`[OAuth] Sarv client_id loaded from env` or
`[OAuth] Sarv client_id using production default` — and
`[OAuth] Sarv base URLs overridden` when any base URL is set.

The defaults and the endpoint paths live in `buildSarvProvider()` in
[`packages/core/src/oauth/providers.ts`](packages/core/src/oauth/providers.ts);
for a dev build, don't hard-code your own credentials there — use the
environment variables. A fork that ships its own release builds has to change
them there (`SARV_PRODUCTION_CLIENT_ID`, and the defaults in
`buildSarvProvider()` for another Sarv environment), because a release build
reads none of them from the environment.

## Registering your own client

Client registrations for the Sarv OAuth server are created by Sarv. If you are
distributing your own build and want a dedicated `client_id` (your own name on
the consent screen, your own redirect-URI allowlist and rate limits), contact
**support@sarv.com** with:

- the application name to show on the consent screen;
- the redirect URI(s) — Sarv Inbox uses the loopback form described below;
- the scopes you need (see "Scopes").

Then set `SARVINBOX_SARV_CLIENT_ID` (and `SARVINBOX_SARV_CLIENT_SECRET`, if the
registration you were given is a confidential client) as shown above for a dev
build, or `SARV_PRODUCTION_CLIENT_ID` for the release builds you distribute.

### Redirect URI

Sarv Inbox follows RFC 8252 (OAuth 2.0 for Native Apps): for each sign-in it
opens a loopback HTTP listener on 127.0.0.1 — the first free of 51823, 51824 and
51825, or a random port if all three are taken — closes it once the sign-in
ends, and uses

```
http://127.0.0.1:<port>/cb
```

as the redirect URI, so the registration must allow any loopback port. If a
registration can only allow a fixed URI, the two usual alternatives — a fixed
port (`http://127.0.0.1:51823/cb`, which fails when the port is already taken)
or a custom URI scheme (`sarvinbox://auth/callback`, which needs per-OS
protocol-handler plumbing) — both require code changes in
`packages/core/src/oauth/` and `apps/desktop/electron/services/oauth-service.ts`.
Open an issue if you need one of them.

### Scopes

The app requests the scopes below; the registration must allow all of them (a
request outside the client's allowlist fails with `invalid_scope`).

| Scope | Used for |
| --- | --- |
| `openid` `email` `profile` | identity — the "Connected as …" display |
| `organization` | embeds the Sarv organisation / user id in the token |
| `llm:view` | list the available LLM providers, models and zones |
| `llm:query` | call the LLM gateway (chat completions) |
| `email:read` `email:send` | the minimum for IMAP + SMTP |
| `email:delete` `email:draft` `email:labels` `email:attachments` `email:filters` | the remaining mailbox actions the client performs |

`offline_access` is **not** requested: the Sarv server issues a refresh token on
every authorization-code grant regardless of scope.

## Signing in from the app

Choose **Sign in with Sarv** on the onboarding screen, or later from
**Settings** (Accounts for the mailbox, AI → Providers for the LLM).

1. The default browser opens the Sarv consent page.
2. Approve the requested scopes.
3. The browser redirects to `http://127.0.0.1:<port>/cb`; the app exchanges the
   code (with its PKCE verifier) at the token endpoint. Sarv's token endpoint
   takes a **JSON** body (Google's takes form-encoded).
4. The refresh token is stored encrypted via the OS keychain and the app shows
   "Connected as <email>".

## Security model

| Dimension | Google (Gmail) | Sarv |
| --- | --- | --- |
| OAuth version | 2.0 | 2.1 |
| PKCE | recommended | mandatory |
| `client_secret` for the desktop client | required by the token endpoint, public by nature | not required (public client) |
| Token endpoint body | form-urlencoded | JSON |

PKCE is the real defence for a desktop client. Google's own documentation
[notes][g-native] that a native app's client secret "cannot actually be kept a
secret" — anything in the binary can be extracted. The per-sign-in
`code_verifier`, which never leaves memory, is what prevents an intercepted
authorization code from being exchanged. So a `client_id` (or a leaked
`client_secret`) is effectively a rate-limit identifier, not a credential.

The flow relies on the standard OAuth 2.1 server-side guarantees — per-client
`redirect_uri` allowlisting, single-use and short-lived authorization codes, and
`code_challenge` / `code_verifier` (S256) matching. On the client side Sarv Inbox
sends a random `state` and rejects a callback where it doesn't round-trip
unchanged.

The access token never leaves the main process. It is also the mailbox's
XOAUTH2 credential (`email:read`, `email:send`, `email:delete`, …), and the
renderer displays untrusted email HTML, so the renderer never receives it —
there is no IPC channel that returns a token. Sarv AI requests and catalog
lookups are made by the main process (`ai:providerFetch`, `oauth:sarvCatalog`):
the renderer names the account, and main attaches the token only for Sarv AI
endpoints (a zone edge host `<zone>-ai-edge.sarv.com` over https on the default
port, or the configured edge base URL; only under `/edge/v1/llm`; never a URL
carrying credentials), fetches the catalog only from its own configured API
base URL, and refuses redirects. On a 401 it refreshes the token and retries
once.

Removing a Sarv account deletes its tokens from this device and then revokes the
refresh token at `/api/oauth/revoke` (RFC 7009, JSON body). A refresh already in
flight is allowed to finish first, so the two never present one token twice, which
Sarv's reuse detector would treat as theft. A `200` with `{"revoked":false}` means
the server no longer knows the token, and a failure never blocks the removal: it
is logged as failed and the user is told.

[g-native]: https://developers.google.com/identity/protocols/oauth2/native-app

## Troubleshooting

- **"Token exchange failed (400): invalid_client"** — the `client_id` (or the
  `client_secret`, if your registration has one) doesn't match the
  registration. Check the `SARVINBOX_SARV_*` values in `.env`.
- **"Token exchange failed (400): invalid_grant"** — the PKCE verifier doesn't
  match, the code was already used, or the code expired. Try again.
- **"invalid_scope"** — the requested scopes aren't all in the client's
  allowlist. See "Scopes".
- **"redirect_uri_mismatch"** — the registration doesn't allow loopback ports.
  See "Redirect URI".
- **Sign-in button is missing / "Sarv OAuth isn't configured for this build"**
  — no client id was resolved. Check the main-process log for the
  `[OAuth] Sarv client_id …` line.
- **The consent page belongs to the wrong environment** — check
  `SARVINBOX_SARV_OAUTH_BASE_URL`.

For anything not covered here, contact **support@sarv.com**.
