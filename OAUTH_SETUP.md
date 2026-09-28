# OAuth Setup Guide

Sarv Inbox supports **direct provider sign-in** via OAuth 2.0 (PKCE) for Gmail,
Microsoft (Outlook/Hotmail), and Yahoo. This avoids the need for provider-
specific app-passwords and gives users the same consent UX as any other native
email client (Thunderbird, Apple Mail, Mimestream, …).

Because OAuth requires a **client ID** registered with the provider, each
deployment of Sarv Inbox must register its own OAuth app once. Then every user
installation of that build signs in against your `client_id`.

This document covers **Gmail / Google Workspace** and **Microsoft (Outlook.com
/ Microsoft 365)**. Yahoo will be documented once that provider is wired in.

## Checklist: one-click sign-in for public users

Everything below is a one-time setup per distributed build. Tick it off in
order; the detail for each step is in the provider sections further down.

**Google (existing app, currently in Testing)**

- [ ] Branding: app name, logo, support email, **homepage URL** and **privacy
      policy URL** on a domain you own ([Branding](#google-branding)).
- [ ] That domain is verified in Google Search Console and listed under
      *Authorized domains*.
- [ ] Data access lists exactly `https://mail.google.com/`, `openid`,
      `userinfo.email`, `userinfo.profile`, each with a written justification.
- [ ] Demo video (unlisted YouTube) showing sign-in and every use of the mail
      scope.
- [ ] Audience → **Publish app** (Testing → In production).
- [ ] Submit for verification; answer Google's review emails.
- [ ] Restricted-scope **security assessment (CASA)** with an authorised lab —
      required for `https://mail.google.com/`, repeated yearly.
- [ ] Until verified: users see "Google hasn't verified this app" and sign-ins
      are capped at 100 users — expected, not a bug.

**Microsoft (new app)**

- [ ] Entra admin center → App registrations → New registration, account type
      **any organizational directory + personal Microsoft accounts**
      ([Microsoft section](#microsoft-outlookcom--microsoft-365)).
- [ ] Platform **Mobile and desktop applications** with redirect URIs
      `http://127.0.0.1:51823/cb`, `http://127.0.0.1:51824/cb`,
      `http://127.0.0.1:51825/cb`.
- [ ] Authentication → **Allow public client flows: Yes**. No client secret.
- [ ] API permissions (delegated): Office 365 Exchange Online
      `IMAP.AccessAsUser.All`, `SMTP.Send`; Microsoft Graph `offline_access`,
      `openid`, `email`, `profile`.
- [ ] Branding & properties: logo, homepage, terms, privacy policy.
- [ ] **Publisher verification** (Microsoft AI Cloud Partner Program ID) — without
      it most work/school tenants block user consent.
- [ ] Copy the **Application (client) ID**.

**Ship it**

- [ ] GitHub → repo Settings → Secrets and variables → Actions:
      `SARVINBOX_GOOGLE_CLIENT_ID`, `SARVINBOX_GOOGLE_CLIENT_SECRET` (already
      set) and **`SARVINBOX_MICROSOFT_CLIENT_ID`** (new).
- [ ] Same values in your local `.env` for dev.
- [ ] Sign in once with each of: a personal Gmail, a Google Workspace account,
      an Outlook.com account and a Microsoft 365 work account.
- [ ] Cut a release (`pnpm release:patch`) — the release workflow inlines the
      IDs into the build.

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

### 6. Publish to production (public users)

Steps 3–5 are enough for you and up to 100 test users. To let **anyone** sign in
with one click, the app must leave *Testing* and pass Google's verification.
Google now calls this area **Google Auth Platform** (Branding, Audience, Data
access, Clients, Verification center); older consoles show it all under *OAuth
consent screen*.

<a id="google-branding"></a>
1. **Branding** — app name, logo (120×120), user support email, and three URLs
   on a domain you control: application homepage, privacy policy, terms of
   service. The privacy policy must say what mail data the app accesses and that
   it stays on the user's device (Google's
   [Limited Use][g-limited-use] requirements apply to Gmail data).
2. **Authorized domains** — add that domain, and verify ownership of it in
   [Google Search Console](https://search.google.com/search-console) with the
   same Google account that owns the Cloud project.
3. **Data access** — keep only the scopes the app requests
   (`https://mail.google.com/`, `openid`, `userinfo.email`, `userinfo.profile`).
   For the mail scope, explain why the narrower Gmail scopes don't work: IMAP
   and SMTP over XOAUTH2 accept **only** `https://mail.google.com/`.
4. **Demo video** — an unlisted YouTube video that shows the consent screen
   (with the client ID visible in the browser URL), signing in, and each feature
   that reads, sends or deletes mail.
5. **Audience → Publish app** — moves the app from *Testing* to *In production*.
   Test-user restrictions end, but until verification completes users see the
   "Google hasn't verified this app" screen and Google caps the number of users.
6. **Verification center → Prepare for verification** — submit, then watch the
   project owner's inbox; Google's reviewers reply there and the review stalls
   until you answer.
7. **Security assessment (CASA)** — because `https://mail.google.com/` is a
   **restricted** scope, Google requires an independent assessment by an
   authorised lab after the brand/scope review. It is paid, takes weeks, and has
   to be renewed every year; Google emails the instructions when you reach this
   stage.

Once verified, the consent screen shows your app name and logo with no warning
— that's the "one click" experience. Nothing in the app changes: the same client
ID and secret keep working through the whole process.

[g-limited-use]: https://developers.google.com/terms/api-services-user-data-policy#additional_requirements_for_specific_api_scopes

### 7. Sign in

In the app: **Settings → Accounts → Sign in with Gmail**.

- Sarv Inbox listens on `http://127.0.0.1:<port>/cb` (the first free of 51823–51825).
- Your default browser opens the Google consent screen.
- After approval the browser redirects back to the loopback server.
- The `authorization_code` is exchanged for access + refresh tokens.
- Tokens are stored in `<userData>/oauth-accounts.json`, encrypted via
  Electron `safeStorage` (OS keychain on macOS/Windows, Secret Service on
  Linux where available).
- IMAP/SMTP connections use **XOAUTH2** and refresh access tokens
  automatically before they expire.

---

## Microsoft (Outlook.com / Microsoft 365)

One registration covers personal accounts (Outlook.com, Hotmail, Live) and
work/school Microsoft 365 accounts. The app is a **public client**: it uses PKCE
and has **no client secret** — Microsoft rejects a secret sent by a desktop app
(`AADSTS700025`), so don't create one.

### 1. Register the app

1. Open the [Microsoft Entra admin center](https://entra.microsoft.com/) →
   **Identity → Applications → App registrations → New registration**. (Any
   Microsoft account works; a free Entra tenant is created for you if needed.)
2. Name: **Sarv Inbox**.
3. Supported account types: **Accounts in any organizational directory and
   personal Microsoft accounts** (multitenant + personal). This is what makes
   the endpoints under `login.microsoftonline.com/common` accept everyone.
4. Leave the redirect URI empty here and click **Register**.
5. Copy the **Application (client) ID** from the Overview page.

### 2. Redirect URIs and public client

1. **Authentication → Add a platform → Mobile and desktop applications**.
2. Add each custom redirect URI (the app binds the first free port of these,
   see `PREFERRED_PORTS` in
   [`oauth-service.ts`](apps/desktop/electron/services/oauth-service.ts)):
   - `http://127.0.0.1:51823/cb`
   - `http://127.0.0.1:51824/cb`
   - `http://127.0.0.1:51825/cb`
3. Under **Advanced settings**, set **Allow public client flows** to **Yes**, then
   **Save**.
4. Do **not** add anything under *Certificates & secrets*.

### 3. API permissions

**API permissions → Add a permission**, all **Delegated**:

| API | Permission | Why |
| --- | --- | --- |
| Office 365 Exchange Online (*APIs my organization uses* → "Office 365 Exchange Online") | `IMAP.AccessAsUser.All` | read the mailbox over IMAP |
| Office 365 Exchange Online | `SMTP.Send` | send over SMTP |
| Microsoft Graph | `offline_access` | refresh token — without it sign-in fails with `NO_REFRESH_TOKEN` |
| Microsoft Graph | `openid`, `email`, `profile` | the id_token the app reads the address from |

None of these need admin consent, so users can approve them themselves (subject
to their tenant's consent policy — see publisher verification below). The app
requests them as `https://outlook.office.com/IMAP.AccessAsUser.All` and
`https://outlook.office.com/SMTP.Send`; see the `MICROSOFT` entry in
[`providers.ts`](packages/core/src/oauth/providers.ts).

### 4. Branding and publisher verification

1. **Branding & properties** — logo, home page URL, terms of service URL,
   privacy statement URL.
2. **Publisher verification** — link a verified
   [Microsoft AI Cloud Partner Program](https://partner.microsoft.com/) ID
   (free to join; the partner account's domain must match the publisher domain
   you set here). Once verified the consent screen shows a blue *verified*
   badge.

Without publisher verification personal accounts can still sign in, but most
work/school tenants' default policy only lets users consent to apps from
verified publishers — everyone else sees "Need admin approval".

### 5. Wire the client ID into Sarv Inbox

```dotenv
# .env  (gitignored — never commit)
SARVINBOX_MICROSOFT_CLIENT_ID=00000000-0000-0000-0000-000000000000
```

For release builds add the same value as the GitHub Actions secret
`SARVINBOX_MICROSOFT_CLIENT_ID`; `.github/workflows/release.yml` passes it to the
build and `apps/desktop/vite.config.ts` inlines it. Startup logs
`[OAuth] Microsoft client_id loaded from env` when it is picked up.

### 6. Sign in

**Settings → Accounts → Sign in with Outlook**. The flow is the same as Gmail's,
with two differences: the email address comes from the sign-in id_token (the
IMAP access token can't call a userinfo API), and SMTP uses
`smtp.office365.com:587` with STARTTLS.

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

### Microsoft

- **"AADSTS50011: redirect URI … does not match"** — the loopback URI isn't
  registered under *Mobile and desktop applications*. Add all three
  `http://127.0.0.1:5182x/cb` URIs; a URI added under *Web* does not count.
- **"AADSTS7000218 / AADSTS700025" (client secret)** — *Allow public client
  flows* is off, or a secret is being sent. Turn the setting on; never set a
  Microsoft client secret.
- **"Need admin approval"** — the user's tenant restricts consent. Complete
  publisher verification, or ask the tenant admin to grant consent for the app.
- **Signs in, then IMAP/SMTP fails with `AUTHENTICATE failed`** — the Microsoft
  365 admin has disabled IMAP or *Authenticated SMTP* for that mailbox
  (Microsoft 365 admin center → user → Mail → Manage email apps). SMTP AUTH is
  off by default in many tenants.
- **`NO_REFRESH_TOKEN`** — `offline_access` is missing from the API
  permissions.
