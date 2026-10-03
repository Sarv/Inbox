# ClamAV extension design reference

**Archived proposal:** 1 October 2026. For implemented behavior, installation,
verification and actual limitations, read [the current README](README.md). This
reference contains proposed future caching, retry and cleanup guarantees that
are not promises made by the current implementation. The preview remains
simulated and uploads no mail.

**Repository decision, 3 October 2026:** the maintained extension source and
package are in `Inbox/extensions/clamav-scan`; only the scanning server lives in
the separate `Inbox-av-server` repository. References below to moving extension
implementation into SarvInbox-extensions are superseded. That repository can
serve a distribution registry without becoming the source repository.

Sarv Inbox will offer an optional **Attachment Guard** extension
(`clamav-scan`) that sends selected attachment bytes to a configured HTTPS
scanner and receives results through temporary tickets. Attachment scanning is
the default. Sending a message body needs separate permission and consent.

The design uses the desktop host to control uploads, credentials and consent.
The extension presents the setup and results. This requires host additions:
the current SDK does not expose attachment bytes or a mediated network client.

## Deliverables

- [Interactive UI preview](preview.html): synthetic data and simulated results;
  no network requests, credentials or actual scans.
- [Proposed API contract](scan-api.openapi.json): OpenAPI 3.1 for the future
  HTTPS gateway. These endpoints are a Sarv proposal, not ClamAV's native API.
- This document: client integration, ticket lifecycle, privacy wording and
  acceptance criteria.

## User experience

1. Install Attachment Guard from Extensions. Installation sends no mail.
2. Open its setup dialog. Enter the HTTPS endpoint and add a scanner credential
   through a host-owned dialog. Check the server using metadata only.
3. Review the operator, region, privacy policy and declared retention periods.
   Choose allowed accounts; no account is preselected.
4. Affirmatively allow selected attachments to leave the device. Enable
   scanning. Each scan still requires a click in version 1.
5. Open the Attachment Guard panel for a message, select attachments and click
   **Scan selected attachments**. Show upload progress, ticket state and a
   separate verdict for every item.
6. If required, select **Include message body** and accept a separate disclosure
   for that scan. Body upload is never inferred from an attachment failure.

The setup dialog identifies the destination visibly. It explains that the
attachment itself can contain personal information even when its filename and
email headers are omitted. The optional body disclosure explains that quoted
messages and signatures can be part of the body.

An endpoint, operator, privacy terms or permitted-account change invalidates
consent before further upload. Adding body scanning requires fresh consent.
Consent is bound to the capabilities response's `privacyTermsVersion`; refresh
it before upload so a policy edit at the same URL is detectable. Changes to
scan configuration are represented by `scanPolicyVersion` in capabilities and
the actual item result.
Disabling/uninstalling the extension or removing an account cancels queued work,
stops new uploads and attempts cancellation of transmitted jobs. Already
transmitted bytes cannot be recalled; the server deadline remains the cleanup
fallback. No automatic mail deletion, moving, quarantine or sample sharing is
part of version 1.

### Result presentation

| Result | What the user sees | Meaning |
| --- | --- | --- |
| No threat detected | Green result with scan time and definitions version | ClamAV reported no threat within the evaluated scan limits; this is not a guarantee that a file is safe. |
| Threat detected | Red result and bounded signature names | Avoid opening the item. Keep mail unchanged and offer rescan or details. |
| Incomplete | Amber result with a reason | Encrypted archive, scan limit, stale definitions or unsupported coverage; never display as clean. |
| Error or offline | Neutral warning and Retry | No usable verdict. A timeout, rejected upload or missing item does not imply no threat. |
| Cancelled or expired | Neutral status and Scan again | The ticket did not provide a current verdict. |

This first extension provides a manual scan. It does not claim to intercept all
attachment previews or openings. A later **Scan before opening** mode must gate
the OS-open, save/download and in-app preview paths in the main process,
including decrypted PGP content, before making that promise. Malware checking
of HTML/text also does not establish that links are safe or an email is genuine.

## Components and data flow

```mermaid
sequenceDiagram
    participant U as User
    participant E as Extension panel
    participant H as Desktop scan host
    participant G as HTTPS scan gateway
    participant C as Private ClamAV daemon
    U->>H: Configure destination and consent
    U->>E: Select attachments and scan
    E->>H: Opaque target handles
    H->>H: Check consent, owning account, size and content
    H->>G: Create ticket with random item IDs and sizes
    G-->>H: Ticket and same-origin upload paths
    H->>G: Upload selected bytes over HTTPS
    H->>G: Submit ticket
    G-->>H: Accepted and queued
    G->>C: Stream ephemeral bytes over local socket
    C-->>G: Engine result
    G->>G: Dispose content; keep temporary result
    H->>G: Poll authenticated ticket
    G-->>H: Per-item verdict, digest and engine metadata
    H->>H: Validate and bind result to exact bytes
    H-->>E: Sanitized status and results
    E-->>U: Display verdict and limitations
```

Only the host sends content. The extension never receives scanner credentials,
Google tokens, filesystem paths or an arbitrary upload URL. Ticket ownership
is authenticated; possession of a ticket ID alone grants no access.

### Proposed host API

The following API and permission names are proposed; they are not available in
the current extension SDK.

```ts
interface ExtensionSecurity {
  // The host derives the current message and account from the app context.
  // Handles identify exact MIME parts, including duplicate filenames.
  getTargets(): Promise<ScanTarget[]>;
  openSetup(): Promise<void>; // Trusted host UI handles secrets and consent.
  submit(targetIds: string[]): Promise<LocalScanJob>;
  get(jobId: string): Promise<LocalScanJob>;
  cancel(jobId: string): Promise<void>;
}

interface ScanTarget {
  targetId: string; // Opaque, short-lived, extension and account scoped.
  kind: 'attachment' | 'email-body';
  displayName: string; // Local UI only; never in the scanner payload.
  byteLength: number | null; // Enforce actual size while acquiring bytes too.
}
```

The host checks `security:scan-attachments` on attachment targets and separately
`security:scan-body` on body targets. It checks the granted permission, current
consent, account ownership, extension/job ownership and content limits on every
call and again before each upload. A panel cannot supply arbitrary paths,
buffers, URLs or credentials. A handle remains bound to its original account
and message even if the user changes accounts; removed accounts invalidate it.

For a body target, upload only the selected message's HTML or text body as UTF-8.
Use `rawBody`, not the cleaned summary, so scanning evaluates the chosen body;
do not load remote images or follow links. Do not append envelope headers,
subjects, full threads or a raw RFC822 message. The body itself can contain
quoted content. Full-message RFC822 scanning is a later, separate mode.

Version 1 rejects encrypted or undecrypted PGP targets as incomplete. The
stored body can be an encrypted-message placeholder; scanning that placeholder
or the ciphertext must never produce a verdict for the readable message.
Decrypted reader buffers are not eligible implicitly. Supporting them later
needs a target bound to the exact decrypted bytes and separate disclosure that
plaintext will leave the device.

The proposed manifest has category `security`, a sidebar result panel, a setup
modal and capability `attachment.scan`. It requests the narrow scan permissions
and `ui:panel`; `ui:notify` is needed only for opted-in result notifications.
No generic `email:read`, `network:fetch`, `email:move` or `email:delete` grant is
needed for the manual extension when the host provides this surface. Body
permission is granted independently, not bundled silently into installation.

### Existing integration points

| Area | Existing location | Required addition |
| --- | --- | --- |
| SDK and permission checks | `packages/core/src/extensions/types.ts`, `extension-api.ts`, `runtime/protocol.ts` | Add narrow scan API, grants and runtime proxy handlers; export public types through the SDK. |
| Extension distribution | `docs/EXTENSIONS.md`, `apps/desktop/extensions.config.json` | Implement and publish extension UI in `Sarv/SarvInbox-extensions`; do not add it to default installs before service/privacy readiness. |
| Attachment retrieval | `apps/desktop/electron/services/attachment-cache.ts`, `SyncEngine.fetchAttachmentPart` | Current helpers/cache are filename keyed. Add exact MIME-part retrieval and a part-aware cache key in main; use strict named account resolution and verify ownership. |
| Scanner host | New `apps/desktop/electron/services/antivirus-scan-service.ts` | Own configuration, consent, secrets, bounded queue, transport, tickets and results. |
| Extension panels | `extension-panel-protocol.ts`, `extension-panel-sdk.ts`, `extension-handlers.ts` | Bridge scan commands; trusted setup UI remains controlled by main. |
| Local scan state | New encrypted core storage table | Hold bounded job/result metadata with account and content binding; purge on removal or Clear scan history. |

Current extension settings and `context.storage` are plaintext JSON. Never put
scanner secrets there. Use the existing encrypted core storage/OS secure-key
pattern, with a separate scanner credential scoped to the chosen origin.

The extension utility process currently loads Node modules with `createRequire`.
Process separation provides crash isolation; it does not prove filesystem or
network confinement. This extension must use the host API. General sandbox
hardening is a separate prerequisite for claiming permission-enforced egress
for arbitrary third-party extensions.

## Tickets and transport

| Operation | Purpose |
| --- | --- |
| `GET /v1/scanner-capabilities` | Check engine, upload limits, operator information and declared retention without sending mail. |
| `POST /v1/scan-tickets` | Reserve capacity with random item IDs, item kinds and byte lengths. |
| `PUT /v1/scan-tickets/{ticketId}/items/{itemId}` | Upload `application/octet-stream`; do not send a real filename or multipart metadata. |
| `POST /v1/scan-tickets/{ticketId}/submit` | Start asynchronous scanning after all required uploads succeed. |
| `GET /v1/scan-tickets/{ticketId}` | Read status/results with the scanner credential. |
| `DELETE /v1/scan-tickets/{ticketId}` | Request cancellation and purge temporary content/results. |

Ticket states are `awaiting_upload`, `queued`, `scanning`, `completed`, `failed`,
`cancelled` and `expired`. A completed ticket can contain mixed item verdicts;
an aggregate completed state is never a clean verdict. Results must match all
requested item IDs and the locally computed SHA-256 of the transmitted bytes.

Version 1 proposes at most 10 items, 25 MiB per item and 50 MiB per ticket. The
host honors smaller server limits and validates actual bytes, not just declared
metadata. Acquire/transfer at most two items at once. A bounded host queue of
20 jobs holds identifiers, not unbounded byte buffers. New-message workflows
must never wait on upload or polling; automatic arrival scanning is deferred.

Use a scanner-only bearer credential. Never reuse Gmail/IMAP tokens or send a
mail account identity. Persist no URLs containing secrets. HTTPS with normal
certificate validation is required. Private/LAN destinations need an explicit
host-owned server setup choice; mail/extension content cannot nominate them.
Reject credentials in URLs, fragments, redirects and protocol-relative upload
paths. Resolve only the exact expected relative path under the approved origin.

Create tickets with a random `Idempotency-Key`; retry ambiguous creation with
the same key and unchanged metadata. Keep different accounts and consent
versions in separate jobs. Repeated item uploads are idempotent only for the
same bytes; conflicting replacement is rejected. A server restart can lose an
ephemeral ticket; show expired/unknown and require a fresh manual scan.

Poll after 1, 2, 4 and then 8 seconds, honoring a bounded `Retry-After` with
jitter. Use a 15-second metadata request timeout and an upload/scan deadline
bounded by the ticket's content deadline. Pause after authentication failure;
do not repeatedly upload. Reconcile an ambiguous submit by reading ticket
state. Never turn an HTTP error, missing result, bad digest, unknown enum or
oversized/malformed JSON response into a no-threat result.

Cache successful verdicts locally for at most 24 hours, scoped by account,
exact byte digest, approved endpoint/operator, consent version and engine,
signature and scan-policy versions. Refresh capability metadata before reuse;
unknown freshness requires rescan. The digest proves which bytes were scanned,
not that every embedded format was understood. Threat results remain visible
until acknowledged or superseded, without retaining a content copy for scans.

## Temporary processing and retention

An asynchronous ticket requires temporary content while upload/scan is pending
and temporary result metadata afterward. The intended promise is **no
persistent content retention**, with these proposed deadlines:

| Data | Intended lifetime |
| --- | --- |
| Uploaded content and scanner extraction files | RAM/tmpfs only; delete after each item's processing ends, or at most 5 minutes after ticket creation, including incomplete upload, queue wait and scan. |
| Ticket results, random IDs and content digests | Ephemeral state; at most 15 minutes after terminal state, or earlier on acknowledged cancellation. |
| Authentication/rate-limit metadata | Separately documented by the operator before release; exclude mail content, filenames, subjects and ticket payloads. |
| Desktop mapping and verdicts | Encrypted local state with bounded retention; remove on account removal, extension uninstall or Clear scan history. Existing mail/cache retention remains governed by the app policy. |

The result expiry is unknown while pending and becomes a timestamp on terminal
state. Every ticket has an immutable content deadline. Reject work when capacity
or remaining time cannot support it. Cancellation acknowledgement must describe
whether cleanup is complete or still pending; a lost cancellation response is
not evidence that content was erased.

The later server must demonstrate cleanup on success, failure, expiry,
cancellation, process crash and host restart. Verify reverse-proxy buffering,
worker/extractor temporary files, swap, crash/core dumps, backups, telemetry and
logs. No durable message/blob queue, quarantine copies, public malware sample
submission or cross-user file reputation cache is part of this design.

Put the authenticated HTTPS gateway in front of a private `clamd` local socket.
ClamAV's TCP protocol has no built-in authentication or encryption. Use
`INSTREAM`, bounded extraction limits and maintained definitions. A stream
exceeding `StreamMaxLength` is an error, not a clean result. [ClamD protocol](https://docs.clamav.net/manual/Usage/ClamdProtocol.html)

Explicitly configure scan-limit/encrypted-archive reporting and inspect engine
warnings. A bare `OK` cannot certify that encrypted or unsupported embedded
content was examined. Evaluate settings such as `AlertExceedsMax`,
`AlertEncryptedArchive`, `AlertEncryptedDoc`, `LeaveTemporaryFiles`,
`ForceToDisk`, `GenerateMetadataJson` and cache behavior against the chosen
ClamAV version. The gateway must convert known coverage failures to
`incomplete`. Audit temporary-file behavior even with streaming. [ClamAV configuration](https://github.com/Cisco-Talos/clamav/blob/main/etc/clamd.conf.sample)

The capabilities response declares the operator's retention policy. It cannot
prove compliance. A Sarv-operated service needs operational evidence before
the app promises these guarantees; a custom server's operator remains visible
and its own terms apply.

## Privacy and Google verification

The current policy has disclosures for AI, reputation and extension downloads,
but no attachment/body upload to an antivirus server. Add a dedicated section
under **When data leaves your device** before enabling this feature publicly.
Reconcile the introduction, storage summary, retention section and landing-page
statements with temporary server processing. Keep the existing Limited Use
commitments and explain operator, purpose, data, controls and retention.

Google requires accurate disclosure and uses that benefit the user. A visible,
optional email-security feature is a plausible use of email-client data, but
this is a design assessment, not approval. [Google Workspace user data policy](https://developers.google.com/workspace/workspace-api-user-data-developer-policy)

Sarv Inbox currently requests the restricted `https://mail.google.com/` scope.
Google states that transmitting restricted data to servers can require a
security assessment even without server storage. The extension's separation
and a custom endpoint do not establish an exemption. Include the scanner in
the OAuth data-flow diagram and verification questionnaire; plan the applicable
CASA/security assessment with the actual server before public Gmail uploads.
No additional Gmail scope is proposed. [Gmail scopes](https://developers.google.com/workspace/gmail/api/auth/scopes),
[Restricted scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification)

### Proposed disclosure

This wording describes the intended feature. Publish it only once the real
operator, location, deadlines and implementation have been confirmed.

> Antivirus scanning is optional and off by default. When you request a scan,
> Sarv Inbox sends only the attachments you select to your configured scanning
> server over HTTPS for malware checking with ClamAV. Message text is included
> only when you separately choose and authorize message-body scanning. The
> selected content may contain personal information. Email account credentials
> are never sent to the scanner.
>
> Before enabling scanning, the app shows the server operator, processing
> location, privacy policy and processing deadlines. The intended Sarv service
> temporarily processes content without persistent content storage, disposes it
> when scanning ends or its processing deadline expires, and keeps ticket
> results for a separately disclosed short period. It does not use submitted
> content for advertising, model training or malware sample collections.
>
> Disabling scanning stops new uploads and requests cancellation of pending
> scans. Content already transmitted may finish processing before cancellation
> takes effect. Another operator's server is governed by that operator's
> disclosed processing and retention terms. You can remove the scanner
> configuration and clear locally saved scan history from the extension setup.

## Implementation sequence and acceptance criteria

1. Add host scan permissions, trusted setup/consent, secret storage, target
   resolution and the SDK/runtime bridge. Fail closed when absent.
2. Implement bounded transport and ticket validation against the proposed
   contract using a fake gateway. Never contact a real mailbox during tests.
3. Build the extension panel/capability in `Sarv/SarvInbox-extensions`. Test
   synthetic no-threat, EICAR detection, mixed results, encrypted files,
   limits, server errors and cancellation.
4. Implement the separate gateway/ClamAV repository and verify deletion and
   retention through fault/restart tests. Record actual operator and limits.
5. Update privacy/site copy and Google review material before public release.
   Add automatic/pre-open policies only after all relevant host paths are gated.

Required tests cover consent absence/revocation; changing endpoint or account;
same filename in different MIME parts; mixed-account selection; removed account;
digest/item mismatch; missing results; redirects; oversized uploads/responses;
stale definitions; queue backpressure; authenticated ticket isolation;
cancellation races; content/result expiry; crash recovery and log redaction.
No passing synthetic test establishes that the future service actually retains
no data; that needs server implementation and operational checks.
