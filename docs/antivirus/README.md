# ClamAV Scan extension

The portable extension, desktop host, SDK/runtime bridge and separate Docker
ticket server support user-triggered attachment scanning. An enabled scanner
protects attachment downloads and user-requested previews across the app's
supported mail providers. Public service deployment and Google verification
are separate steps.

## Repository layout

- **Inbox:** `extensions/clamav-scan` is the maintained extension package.
  Desktop setup, the scan service and SDK permission bridge also belong here.
- **Inbox-av-server:** the authenticated Java ticket API, Docker stack and
  ClamAV daemon configuration are maintained in the separate server repository.

The extension is versioned with Inbox. A marketplace registry can distribute
its release package without changing where its source is maintained.

## Install and use

1. Run this updated Sarv Inbox build. An older 1.3.1 release does not have the new
   scanner host API, even though the app version has not yet been bumped.
2. In Extensions, choose **Install from folder** and select
   `extensions/clamav-scan` from this checkout. Its manifest is
   `sarvinbox-extension.json`; no npm install or extension build is needed.
3. Open a message and the **Antivirus scan** extension panel. Click
   **Configure scanner** to open the trusted app dialog.
4. Sign in to the scanner's web UI using Sarv OAuth and create a scanning token.
   Save the `iv_` token securely; the server shows it only once. Enter the scanner
   origin and this scanner-only credential in the app. **Verify scanner**
   authenticates and checks metadata without sending mail. Review operator,
   region, privacy terms, retention and limits, select allowed accounts and
   affirm attachment sharing. No account or upload is selected automatically.
5. Click an attachment to view it, choose **Open in system app**, **Download**,
   or **Save all**. The app retrieves the selected attachment in the background,
   shows the scanning state and allows viewing, opening or saving after a
   complete, byte-matched **No threat detected** result when the scanner is
   configured for that account. Threats, incomplete scans and scanner errors
   stop the action. If scanner setup or that account's sharing approval is
   missing, an in-app warning shows the complete attachment filename and offers
   **Cancel**, **Set up antivirus** or **View anyway** for a preview. Other actions
   use **Open anyway**, **Download anyway** or **Add anyway**. Continuing shows
   **Not scanned** and sends nothing to the scanner. The **Don't show this
   message again** link remembers the missing-setup warning choice for that
   account only after you continue; cancelling does not save it. Scanner setup
   lets you show warnings again. This preference never disables configured
   scanning or approves uploads. This applies to supported mail accounts, not
   only Gmail.
6. The **Antivirus scan** panel remains available for manual scans. Select exact
   targets and click **Scan selected**. Email body text requires separate setup
   consent and confirmation for each submission; attachment downloads do not
   upload the message body; attachment previews do not upload it either.
7. Inspect each item's result. **No threat detected** is not a guarantee of
   safety. Threat, incomplete, error, cancelled and expired remain distinct.
   Scan details show the engine, definitions, timestamp and byte digest.

A ZIP distribution must be extracted first; the local installer accepts a
folder. A marketplace release may be indexed in SarvInbox-extensions while
the extension source stays in this Inbox repository. This extension is not
added to default installs.

Distribution ZIPs and their checksums are generated artifacts. Recreate a ZIP
from the maintained source, from the Inbox repository root:

```sh
python3 -m zipfile -c docs/antivirus/clamav-scan-1.0.0.zip extensions/clamav-scan
shasum -a 256 docs/antivirus/clamav-scan-1.0.0.zip > docs/antivirus/clamav-scan-1.0.0.zip.sha256
```

## Local Docker server

The sibling checkout is `/Users/rcsarv/dev/Inbox-av-server`. Its Compose stack
provides an authenticated ticket gateway, scanner API, separate superadmin
API/UI, PostgreSQL and private ClamAV daemon. Sarv OAuth authenticates scanner
and admin users; a separate Keycloak identity service is unnecessary for the
normal setup. The local gateway is `http://127.0.0.1:8080`; development builds
permit HTTP only for explicitly configured loopback. Packaged apps require
HTTPS with normal certificate validation. Scanner credentials are `iv_` keys,
not Gmail tokens or Sarv sign-in tokens. The host stores them in protected
configuration; the extension never receives the secret. An organisation may
distribute a shared scanning key to its users. Usage, limits and expiry belong
to that key's scanner account, so shared users consume the same allowance.

The same Linux containers can run on a Linux server. Use the server's deployment
guide for real HTTPS at `av.sarv.com`, Sarv issuer/client binding configuration,
private database/ClamAV ports and truthful operator/privacy settings. The
locally tested platform is Linux arm64 in Docker; native amd64 was not executed.

## Implemented boundaries

- Narrow `security:scan-attachments` and `security:scan-body` grants, checked
  in the SDK, worker bridge, panel bridge and desktop host.
- Untrusted panels receive opaque target handles and sanitized verdicts. They
  receive neither file bytes nor credentials nor a list of other mailboxes.
- Trusted setup uses OS secure storage inside the encrypted core profile.
  Linux `basic_text` and missing secure storage refuse scanner credential setup.
- Strict named account resolution works from All Inboxes. Exact MIME part IDs
  distinguish attachments with the same filename. Retrieval rechecks the part,
  folder/UID and size. Ambiguous filenames refuse a protected download rather
  than selecting an arbitrary MIME part. Encrypted OpenPGP attachment saves
  are blocked when scanning is configured for that account; if setup or account
  approval is missing, the per-action warning can permit an explicitly unscanned
  local save. Decrypted attachment previews are not offered. The host does not
  upload decrypted plaintext or scan a placeholder; supporting that requires
  explicit sharing consent and a dedicated implementation.
- **Add to calendar** is blocked when scanning is configured for the account
  because it generates a new file from message-derived calendar text. Open or
  save a named `.ics` attachment through its protected controls instead. If
  setup or account approval is missing, the per-action warning can permit an
  explicitly unscanned local calendar import. The escaped calendar summary in
  the message stays available and is not uploaded.
- HTTPS origin checks, rejected redirects, exact relative upload paths,
  bounded requests/response bodies, item/digest matching, fresh definitions
  and full coverage checks before a no-threat result.
- At most four running desktop jobs, two per extension, ten items per ticket,
  25 MiB per item and 50 MiB total, or smaller advertised server limits.
  Content is acquired/uploaded sequentially and buffers are erased afterward.
- Setup/consent changes, explicit disable/uninstall and account removal stop
  new uploads and cancel outstanding work. Host reload/shutdown cancels work
  but preserves approved configuration. Scanner policy changes require setup
  consent again. Scans are triggered by an attachment view, an explicit open,
  a download action or a manual scan;
  mailbox contents are not changed. Installing an extension alone does not
  consent to uploads. An enabled, active scanner with attachment permission
  offers the trusted in-app warning only when setup or the account's sharing
  approval is missing. Choosing to continue unscanned sends no mail to the scanner.
  Remembering the warning choice applies only to that account's missing-setup
  actions and creates no attachment-sharing consent. **Show warnings again** in
  scanner setup clears the account's choice. Saving scanner configuration or
  disabling/uninstalling the scanner clears all remembered warning choices;
  removing an account clears its choice. Configured threats,
  incomplete scans, scanner failures and unavailable targets remain blocked;
  an enabled scanner with failed activation or revoked permission also blocks.
  The same rules apply to downloads, in-app previews and opening documents with
  a system application.
- In-memory desktop results expire within fifteen minutes or earlier at their
  server expiry. They do not survive app exit. There is no persistent scan
  history, cross-user reputation cache or background scanning on mail arrival.
- Protected downloads retain the exact scanned bytes in main-process memory
  until the user chooses where to save them. The verdict's digest and length
  must match those bytes; the app does not fetch another copy after scanning.
  Consent is rechecked before writing, and buffers are erased when released.
- The in-app PDF and media viewers use the app's Save control. While antivirus
  protection is enabled, Chromium's native download path is blocked and directs
  you to that control so a viewer cannot bypass the scan.
- Configured in-app PDF, image, text and media previews receive no attachment
  bytes until the selected file has a complete clean result. Office documents
  and other supported system-app types are scanned before the app opens them.
  An explicitly unscanned preview instead uses a temporary permission bound to
  that account, message, filename and missing-setup state; it expires within
  five minutes. Direct or forged attachment URLs cannot bypass either gate, and
  range requests recheck the permission. Opening a message alone does not
  upload attachments, inline body images or the message body.
- In-app preview bytes, whether scanned clean or explicitly unscanned, stay
  in main-process memory while the viewer's temporary permission is valid, at
  most five minutes, and are erased when released. For a system application, the
  host writes a private temporary copy of the authorized bytes, schedules removal
  within five minutes and removes its copies on normal shutdown. Copies left by
  an interrupted process are removed before the next protected system-app open. An external application may keep its own copy.

## Ticket protocol and retention

The [OpenAPI contract](scan-api.openapi.json) documents these endpoints:

| Operation | Purpose |
| --- | --- |
| `GET /v1/scanner-capabilities` | Authenticated operator, policy, engine, retention and limits |
| `POST /v1/scan-tickets` | Random item identifiers/kinds/lengths with an idempotency key |
| `PUT /v1/scan-tickets/{ticketId}/items/{itemId}` | Selected bytes; no filename or mail headers |
| `POST /v1/scan-tickets/{ticketId}/submit` | Start asynchronous scanning |
| `GET /v1/scan-tickets/{ticketId}` | Owner-only states and byte-bound per-item results |
| `DELETE /v1/scan-tickets/{ticketId}` | Request cancellation and temporary ticket deletion |

The client does not automatically retry ambiguous uploads or submissions;
errors require a fresh scan/view/download attempt. Unknown tickets after restart are errors.
A completed ticket may contain an incomplete item; it never establishes safety
for the ticket as a whole.

The separate Inbox-av-server implementation uses bounded volatile ticket state, memory/tmpfs processing,
no persistent ticket content/results/digests, and no payload/result logging.
Authentication, quota and sanitized security audit records are separate,
persistent metadata; their actual retention is disclosed in capabilities.

The fixed content deadline is at most five minutes from creation; new uploads
and late results are rejected after it. Results expire within fifteen minutes
of a terminal state. Active ClamAV extraction cannot yet be proven to stop at
that universal deadline: cancellation may remain pending until the worker
finishes. **A timeout, HTTP 202 or lost deletion response is not proof of erasure.**
Read the server's `docs/scanner-tickets.md` for the demonstrated limits and
remaining daemon watchdog/isolation work before promising a universal bound.

## Privacy and Gmail review

[The policy](../legal/privacy-policy.md#49-optional-clamav-attachment-scans)
now describes optional attachment/body uploads, consent, operator disclosures,
processing, metadata retention and cancellation limitations. No additional
Gmail scope is introduced. Temporary server processing is still a transfer of
Google data; this implementation is not a statement of Google approval.

Google requires accurate disclosures and consent for new uses, and transmitting
restricted data to servers can require a security assessment even without
persistent storage. Update the verification questionnaire and data-flow diagram
for the actual public server before enabling public Gmail uploads.
[User Data Policy](https://developers.google.com/terms/api-services-user-data-policy),
[restricted scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification).

## Verification

- Core/SDK and desktop typechecks, production renderer/main/worker/preload builds.
- Permission, sandbox/panel bridge, trusted setup, extension DOM, secure credential
  storage, consent, account isolation, revocation, digest/coverage and deadline tests.
- Exact MIME parts, bounded attachment acquisition and cancellation tests.
- Missing-setup modal choices, complete attachment filenames, explicit remembered
  warning choices, per-action unscanned permissions, account binding and refusal
  to bypass configured scanner failures.
- Separate server: scanner authentication, PostgreSQL, admin isolation and quota
  tests, plus real local ClamAV checks.
- Live local Docker: idempotent ticket operations, ownership/state failures,
  clean bytes, EICAR, mixed results, encrypted archives and deletion/404.
- Opt-in `apps/desktop/test/integration/antivirus-local.test.ts` runs the actual
  extension API → desktop host → Docker ClamAV on synthetic fixtures, without
  reading any profile or mailbox. It passed clean, EICAR and encrypted incomplete
  results with exact digests, engine versions and timestamps. It also exercises
  the host's protected-download path, returning exact clean bytes and refusing
  EICAR and encrypted-archive results before any save. Preview checks cover a
  clean PDF's exact bytes, infected PDF refusal, encrypted Office refusal,
  system-app temporary copies, close/shutdown cleanup and consent revocation.

To rerun against a synthetic account on a local scanner, save its `iv_` token in
an absolute-path, mode-600 file and supply the path. Do not source the normal
server environment or use a real user's credential:

```sh
INBOX_AV_SYNTHETIC=1 \
INBOX_AV_TEST_ORIGIN=http://127.0.0.1:28080 \
INBOX_AV_SCAN_KEY_FILE=/absolute/private/path/synthetic-scan-key \
pnpm -C apps/desktop exec vitest run test/integration/antivirus-local.test.ts
```

Run from the Inbox repository root. The test accepts only a loopback HTTP
scanner and refuses supplied keys belonging to real users; synthetic accounts
must use an `.invalid` email. It is skipped by ordinary test runs and reads no
profile or mailbox. No token or payload is printed, and no file is saved to a
user-chosen location.
The burst suite needs a synthetic account with enough per-minute request
allowance (at least 120 recommended). Its temporary system-app checks write
only synthetic clean bytes into an isolated temporary directory, which the
harness removes; no real system application is launched.

The separate server repository's isolated `compose.ci.yaml` and
`scripts/ci-sarv-fixture.py` also produce private synthetic Sarv access tokens.
For that stack, use `INBOX_AV_SYNTHETIC_TOKENS_FILE` instead of
`INBOX_AV_SCAN_KEY_FILE`. The harness validates the CI fixture marker and local
issuer, creates a temporary `iv_` key, uses it for the extension path, and revokes
it afterward. This exercises Sarv-shaped access authentication without a real
Sarv account. The optional scanner-only Keycloak test profile remains available
with explicit `INBOX_AV_TEST_AUTH=keycloak`; it is not the default integration.

The [original design reference](design-reference.md) and
[simulated UI preview](preview.html) remain as design artifacts; their proposed
future behavior must not be confused with the implementation described here.
