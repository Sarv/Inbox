# OAuth Setup Guide

Sarv Inbox supports **direct provider sign-in** via OAuth 2.0 (PKCE) for Gmail,
Microsoft (Outlook/Hotmail), and Yahoo. This avoids the need for provider-
specific app-passwords and gives users the same consent UX as any other native
email client (Thunderbird, Apple Mail, Mimestream, …).

Because OAuth requires a **client ID** registered with the provider, each
deployment of Sarv Inbox must register its own OAuth app once. Then every user
installation of that build signs in against your `client_id`.

This document covers **Gmail / Google Workspace** setup. Microsoft and Yahoo
will be documented as those providers are wired in.

---

## Gmail / Google Workspace

### 1. Create a Google Cloud project

1. Open <https://console.cloud.google.com/>
2. Create a new project (or pick an existing one).

### 2. Enable the Gmail API

1. **APIs & Services → Library**
2. Search for "Gmail API" and click **Enable**.

### 3. Configure the OAuth consent screen

1. **APIs & Services → OAuth consent screen**
2. User Type: **External** (works for personal @gmail.com too).
3. Fill in app name ("Sarv Inbox"), user support email, developer email.
4. On the **Scopes** page, add:
   - `https://mail.google.com/`
   - `openid`
   - `.../auth/userinfo.email`
   - `.../auth/userinfo.profile`
5. On the **Test users** page, add each Gmail address you want to sign in with.
   You can add up to 100 test users without going through verification.

> **Important**: `https://mail.google.com/` is a **sensitive + restricted
> scope**. Until your app completes Google's security assessment (CASA), it
> runs in "testing" mode — a scary warning appears on consent and only the
> test users you added can sign in. This is fine for personal / beta use.
> For broad distribution you'll need to go through verification + CASA,
> which takes weeks and has cost.

### 4. Create an OAuth client

1. **APIs & Services → Credentials → Create credentials → OAuth client ID**
2. Application type: **Desktop app**
3. Name it anything (e.g. "Sarv Inbox Desktop").
4. Copy **both** the **Client ID** (`1234567890-abc.apps.googleusercontent.com`)
   and the **Client secret** (`GOCSPX-…`).

> Even though the desktop app uses PKCE, Google's token endpoint still requires
> the client secret for this client type, so you need both values. Google
> [considers native-app client IDs public][g-native]; treat the secret as
> semi-confidential and never commit it.

### 5. Wire the credentials into Sarv Inbox

Credentials are read from the environment at startup — **never** hard-code them
in source. In dev, put them in a gitignored `.env` at the repo root (see
[`.env.example`](.env.example)):

```bash
cp .env.example .env
```

```dotenv
# .env  (gitignored — never commit)
SARVINBOX_GOOGLE_CLIENT_ID=1234567890-abc.apps.googleusercontent.com
SARVINBOX_GOOGLE_CLIENT_SECRET=GOCSPX-your-secret
```

Then run:

```bash
pnpm --filter @sarvinbox/desktop dev
```

The main process loads `.env` and registers the values via
[`initializeOAuth`](apps/desktop/electron/services/oauth-service.ts). Without
them, Gmail shows as "not configured" in the UI.

> **Distributed builds:** inject the same env vars at package/CI time (they are
> not baked into source). Rotate the secret in Google Cloud Console if it ever
> leaks.

[g-native]: https://developers.google.com/identity/protocols/oauth2/native-app

### 6. Sign in

In the app: **Settings → Accounts → Sign in with Gmail**.

- Sarv Inbox spins up a loopback server on `http://127.0.0.1:<random-port>/cb`.
- Your default browser opens the Google consent screen.
- After approval the browser redirects back to the loopback server.
- The `authorization_code` is exchanged for access + refresh tokens.
- Tokens are stored in `<userData>/oauth-accounts.json`, encrypted via
  Electron `safeStorage` (OS keychain on macOS/Windows, Secret Service on
  Linux where available).
- IMAP/SMTP connections use **XOAUTH2** and refresh access tokens
  automatically before they expire.

---

## Troubleshooting

- **"access_denied" / "Error 403: access_denied"** — you're not in the
  test-users list. Add the signing-in address in **OAuth consent screen →
  Test users**.
- **"invalid_grant" on refresh** — the refresh token was revoked (user signed
  out in their Google account, or 6 months of inactivity). Sign out from
  Sarv Inbox settings and sign in again.
- **"This app is blocked"** — the Workspace admin has blocked unverified
  apps. Ask them to allowlist your client ID, or put the app through
  verification.
- **Nothing happens when I click Sign in** — check the main-process log for
  `[OAuth] Gmail client_id loaded from env`. Without a client ID the button
  is disabled.
