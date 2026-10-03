# ClamAV Scan extension

Implemented on 2 October 2026. The portable extension, desktop host, SDK/runtime
bridge and separate Docker ticket server are connected and tested with synthetic
fixtures. Public service deployment and Google verification are separate steps.

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
4. Enter the scanner origin and a scanner-only credential. **Verify scanner**
   authenticates and checks metadata without sending mail. Review operator,
   region, privacy terms, retention and limits, select allowed accounts and
   affirm attachment sharing. No account or upload is selected automatically.
5. Select exact attachment targets and click **Scan selected**. Email body text
   requires separate setup consent and confirmation for each submission.
6. Inspect each item's result. **No threat detected** is not a guarantee of
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
provides an authenticated ticket gateway, API, Keycloak, PostgreSQL and private
ClamAV daemon. The local gateway is `http://127.0.0.1:8080`; development builds
permit HTTP only for explicitly configured loopback. Packaged apps require
HTTPS with normal certificate validation. A localhost test credential is not a
Google/Gmail token and should never be copied into an extension setting.

The same Linux containers can run on a Linux server. Use the server's deployment
guide for real HTTPS, production Keycloak, issuer/audience configuration,
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
  folder/UID and size. Encrypted OpenPGP targets are unavailable, never scanned
  as plaintext placeholders.
- HTTPS origin checks, rejected redirects, exact relative upload paths,
  bounded requests/response bodies, item/digest matching, fresh definitions
  and full coverage checks before a no-threat result.
- At most four running desktop jobs, two per extension, ten items per ticket,
  25 MiB per item and 50 MiB total, or smaller advertised server limits.
  Content is acquired/uploaded sequentially and buffers are erased afterward.
- Setup/consent changes, explicit disable/uninstall and account removal stop
  new uploads and cancel outstanding work. Host reload/shutdown cancels work
  but preserves approved configuration. Scanner policy changes require setup
  consent again. Every scan is manual; mailbox contents are not changed.
- In-memory desktop results expire within fifteen minutes or earlier at their
  server expiry. They do not survive app exit. There is no persistent scan
  history, cross-user reputation cache or automatic/pre-open scan interception.

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
errors require a fresh manual scan. Unknown tickets after restart are errors.
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
- Separate server: 90 Maven tests, including PostgreSQL, zero skipped.
- Live local Docker: idempotent ticket operations, ownership/state failures,
  clean bytes, EICAR, mixed results, encrypted archives and deletion/404.
- Opt-in `apps/desktop/test/integration/antivirus-local.test.ts` runs the actual
  extension API → desktop host → Docker ClamAV on synthetic fixtures, without
  reading any profile or mailbox. It passed clean, EICAR and encrypted incomplete
  results with exact digests, engine versions and timestamps.

To rerun the integration, privately load the sibling server environment, then:

```sh
INBOX_AV_SYNTHETIC=1 pnpm -C ../Inbox/apps/desktop exec vitest run test/integration/antivirus-local.test.ts
```

Run from the server directory. Do not print the environment or bearer token.
The test is skipped by ordinary test runs and uploads synthetic data only.

The [original design reference](design-reference.md) and
[simulated UI preview](preview.html) remain as design artifacts; their proposed
future behavior must not be confused with the implementation described here.
