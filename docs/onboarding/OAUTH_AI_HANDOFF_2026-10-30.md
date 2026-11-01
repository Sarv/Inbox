# Sarv Inbox → OAuth → AI onboarding audit

Audited 30 October 2026. This document is ready to share with the OAuth and AI teams. Production settings were inspected read-only through the owner’s signed-in OAuth admin session. No app registration, scope, account, live token, mail or deployment was changed by the audit. Browser regression tests use local identity/provider fixtures.

## What the live OAuth admin confirms

| Setting | Sarv Inbox | AI web app |
| --- | --- | --- |
| Public client ID | `client_Z6sjVFkr4cOdgfGXsGGCXg` | `client_GFyGg4b8ZQsigEG9xXpDfA` |
| Internal registration ID | `b06509e2-5298-4968-b5e2-e9c8f7c6b7b2` | `8fbddbbc-1754-4a58-91a2-5dee686d5de9` |
| Type | Public, PKCE | Confidential |
| Active | Yes | Yes |
| Grants | Authorization code, refresh token | Authorization code, refresh token |
| Required verifications | None | None |
| Registered callbacks | `http://127.0.0.1:51823/cb`, ports `51824` and `51825` with the same path | `https://ai.sarv.com/auth/callback`, `https://ai.sarv.com/v2/auth/callback` |

Inbox’s allowlist includes `openid`, `email`, `profile`, `organization`, `llm:view`, `llm:query`, and its implemented email permissions. The AI web app has identity/organization/phone/payment-status scopes. These are separate apps: do not replace Inbox’s client ID with the AI web client, add a desktop client secret, duplicate the registration or disable PKCE.

**No Apps settings change is needed for the current Inbox LLM sign-in.** A new OAuth user also is not blocked here by an app-level KYC prerequisite.

The live Services catalog contains `llm` with `llm:view` and `llm:query`, plus legacy `llm:agents`, `llm:knowledge`, etc. TTS/STT services exist separately. The public CAI manifest documents `agents:*`, `wallet:view` and `reports:view`, but discovery does not advertise those six permissions. Reconcile the manifest, database scope catalog and implemented API scope checks before enabling those future features. Creating a service identifier does not currently select a token audience. Live `llm:query` is marked non-sensitive, unlike the CAI manifest; review the consent metadata for billed operations.

## Immediate AI Center authentication change

Both inspected Center replicas had `OAUTH_AUDIENCE=client_GFyGg4b8ZQsigEG9xXpDfA`. That accepts only the AI web client’s configured audience, not Inbox’s separate client identity. The user’s request `d8f53b03f2224d94865ac48ae63acbe5` failed with 401 on `/oauth/v1/llm/providers` at `2026-10-30T11:04:43.538446Z`. Further providers/zones failures followed. This rejection happens before AI user/org resolution or inference.

Implement an **exact trusted audience list**, retaining issuer, RS256/JWKS, expiry, delegated scope, user-active and local organization checks. Add a supported list setting and deployment wiring; merely inventing an environment key does not change the existing single-audience verifier. Apply the contract consistently on Center and Edge. Edge currently has no explicit audience configuration and defaults to not verifying audience; harden that after the shared contract is agreed, rather than weakening Center.

**Verify actual issued access-token claims before choosing the values.** The October 30 OAuth source inspected at `04faff4` passes the internal registration ID into access-token `aud` and `client_id`. Generic ID tokens also default to that internal ID; only the separate website-binding flow overrides its ID-token audience with the public client ID. That generic ID-token mismatch needs correction to meet the registered-public-client OIDC contract, independently of the API access-token migration. The access-token public-ID change in old commit `75538a9` was reverted by `c571514`; its presence in history does not mean it is active. No production bearer was extracted during this audit, so live access-token `aud` is not directly verified.

The two internal IDs and two public IDs above are the explicit candidates for a coordinated compatibility window, not a wildcard policy. Determine which are actually issued, permit only the intended client registrations, and test unrelated clients are rejected. Preserve working clients during rollout. If OAuth changes access-token claims later, update Center/Edge compatibility first, retain internal database foreign keys, test refresh/client-credentials issuance, then retire legacy audiences after their bounded validity ends. Do not use an ID token as the API bearer.

## Correct first-time account lifecycle

An OAuth identity and an AI account are different records. OAuth can issue its delegated access token before an AI account exists. A missing AI account is an onboarding condition, not an invalid-token condition. An independent AI API key is not required for this delegated sign-in.

Today Center’s `/oauth/v1/*` dependency verifies the token and resolves `sub → users.sarv_universal_user_id → organization_id`. An unknown subject gets a generic 403 asking the user to sign in to CAI once; it does not create a local account or supply a resumable setup flow. Center’s own SSO callback separately exchanges its own code, reads the verified identity, creates or links the local AI user/org, and issues its own web session. New SSO accounts start at plan selection with onboarding incomplete.

Implement this coordinated journey:

1. Inbox completes its normal OAuth PKCE sign-in and requests the AI catalog.
2. After token validation, Center returns a structured `ai_account_required` or `ai_onboarding_required` response when appropriate. Distinguish it from invalid/expired token, missing scope, disabled account and missing organization. Agree these error names and fields with Inbox before implementation.
3. Inbox offers **Finish AI setup**, opening an approved Center URL with an opaque, expiring setup continuation. Bind that continuation to the requesting client, verified OAuth subject and an approved return destination. Do not accept an arbitrary external `return_to`.
4. Center signs in through its own OAuth transaction, idempotently creates/links the correct user/org, enforces its account/2FA/plan requirements and preserves the continuation through every onboarding page, refresh, retry and payment/verification redirect.
5. Await authoritative onboarding completion. On failure retain retry state; do not return success prematurely.
6. Resume Inbox through a dedicated setup-completion mechanism, validate the state, recheck setup status with the original identity, reload providers/models/zones and focus Inbox. A bounded status poll can recover a browser that cannot return directly.

The original Inbox OAuth code is single-use and may already have been consumed before AI onboarding starts. Do not replay it or reuse its PKCE verifier for Center’s separate sign-in. Inbox currently supports registered loopback callbacks, not `sarvinbox://`; a new setup continuation must be implemented on both sides rather than assuming that scheme exists. Setup completion must remain recoverable beyond a single open tab or an expired browser callback.

## Specific AI code changes

Paths are relative to `/Users/rcsarv/dev/CAI/center`.

- `services/api/app/auth/oauth.py`: supported trusted audience list; structured missing-link/setup states; preserve local subject-to-organization authority. Never trust a caller-supplied `cai_org_id` as the tenant.
- `services/ui/apps/ui/src/pages/OAuthCallback.jsx`: use the existing auth-response normalization. The server returns `session_token`, but this callback reads only `access_token`. A stale localStorage bearer can override the new session cookie. Install the new session before requesting profile/onboarding status; handle local 2FA without losing the continuation.
- `services/ui/packages/cai-api/src/api-service.js`: preserve the shared normalization and consistent structured error contract. Its `/login?next=...` recovery needs a consumer in Login.
- `services/ui/apps/ui/src/pages/Login.jsx`: preserve validated continuation and the full internal destination, including search/hash; it currently reads only `location.state.from.pathname`.
- `services/ui/apps/ui/src/pages/Onboarding/index.jsx`: preserve continuation across every step and exit. It currently hardcodes `/dashboard` or `/agents`. Await `completeOnboardingFull()` and handle failure instead of swallowing it and navigating immediately.
- Signup, email verification, payment return and account-switch paths must use the same continuation. Keep the existing verified-email and conflicting-subject protections when linking accounts.

## Local fixes prepared during this audit

**Inbox:** interactive Sarv sign-in now uses native OAuth’s five-minute callback deadline rather than cancelling at 60 seconds. After sign-in completes, catalog loading gets its own 60-second guard. Skip/Back/hide/unmount still cancel immediately. This fixes the existing AI setup screen; the coordinated external AI onboarding feature above remains to be implemented.

**OAuth:** isolated branch `codex/inbox-auth-return`, permanent worktree `/Users/rcsarv/dev/oauth-inbox-auth-return`, initially based on October 30 `origin/main` at `04faff4`. Provider sign-in preserves a validated same-origin authorization continuation in expiring server-side state; success and error retries retain it. The UI forwards Inbox requests for Google/Microsoft/GitHub, resumes authorization after social login and has one password-login navigation owner. Errors require explicit sign-in so a cancelled account switch cannot silently authorize a previous account. Existing website identity restrictions and signup/reauth behavior are retained. Access-token audience semantics are intentionally unchanged in this patch. Before integration on November 1, the branch was updated to `afb726b` (v1.3.1), retaining main’s newer social-return validation, direct successful return to the original authorization endpoint and navigation guard.

## Acceptance tests before deployment

| Case | Required result |
| --- | --- |
| Inbox token, existing linked completed AI account | Providers/models/zones load without a new AI signup |
| New OAuth identity with no AI account | One AI user/org/link; setup appears; successful setup returns to the same Inbox request |
| Existing AI email without a Sarv link | Link the matching verified identity, preserving its organization |
| AI email already linked to a different subject | Explicit conflict, no silent reassignment |
| Partial onboarding, reload, payment redirect, browser reopen | Resume the authoritative stage and original requester |
| Existing account A; sign in/register as B; provider denied or fails | No continuation as A; explicit retry as the intended identity |
| Fresh browser, expired bearer, different-account bearer | New AI session installed before profile/status calls |
| Callback after 61 seconds; native deadline expiry; Skip/Back | Valid slow sign-in succeeds; timeout/cancel remains recoverable |
| Missing/wrong/replayed state, altered callback return, two tabs | Reject or recover without crossing transactions/accounts |
| Foreign origin, protocol-relative/encoded authority, credentials, injected query | No external return or parameter injection |
| Trusted and unrelated audiences, wrong issuer/signature, expired token, missing scope, ID-token bearer | Expected allow/deny behavior without weakening verification |
| Refresh/retry and network failure at completion | Preserve identity/scopes; no duplicate AI account, token-family revocation or false success |

Run the local OAuth API suite against dedicated PostgreSQL and Redis only. UI helper tests run with `npm run test:auth-return-to` in `ui/`. The real-browser fixture is `e2e/auth-continuation.mjs`; start the isolated UI, set `AUTH_TEST_BASE`, optionally set `AUTH_TEST_CHROME`, then run it. These browser tests mock external identity/provider APIs; they do not prove the still-unimplemented cross-service AI onboarding journey.

October 30 local verification completed: OAuth API **960 passed, 17 skipped** (including 44 social-continuation regression cases); focused social/website identity tests **76 passed**; UI helper tests **10 passed**; headless Chrome navigation checks **9 passed**; OAuth UI TypeScript and production build passed. Inbox verification: **121 component/connection tests and 10 native loopback tests passed**, plus TypeScript and targeted ESLint. Existing dependency/test warnings remain. An independent code review caught the wrong-account retry path; its failing regression and fix were included before these checks. November 1 fresh Inbox verification again passed all **131 tests**, TypeScript and targeted ESLint before committing.

## Release order and existing constraints

OAuth `dev` was 28 commits behind refreshed `origin/main`. Do not overwrite current production source with the older dev tree or reintroduce the lost-refresh-response bug. Preserve the existing explicit post-registration sign-in and website session protections.

Current OAuth `CLAUDE.md`, `RELEASE.md` and `bitbucket-pipelines.yml` confirm **pushing main runs tests, not a production deployment**. OAuth production uses pinned images and a release packet; `/opt/oauth` is not the live source of truth. Prepare a compatible release packet and test its offline plan, then obtain the required production approval. Do not assume Inbox’s release workflow deploys OAuth or Center.

Deploy the AI audience/structured-setup contract and the matching Inbox/OAuth changes in a coordinated order; run the acceptance matrix before calling first-time setup complete. No production deployment was performed here.

Additional OAuth source findings for a separate security review: consent POST must recheck client scopes and verification prerequisites, and introspection must enforce the intended client ownership policy. These were not probed against live production accounts and were not changed in this continuation patch.
