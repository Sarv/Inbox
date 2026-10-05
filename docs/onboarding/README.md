# Inbox onboarding flow

`preview.html` is the approved interactive design prototype. It uses simulated
connections and makes no network requests or credential changes. Provider logos
are embedded from official assets; provenance is in [assets/SOURCES.md](assets/SOURCES.md).

The desktop implementation lives in `apps/desktop/src/components/onboarding/`.
The centered wizard uses bundled provider marks and the existing Inbox logo.

| Stage | Action | Next |
| --- | --- | --- |
| Email | Pick Sarv, Gmail, Outlook, Yahoo or Other | Provider selection advances immediately |
| Connect email | Sarv/Gmail browser sign-in or manual IMAP/SMTP; other providers use manual setup | Check receiving; verify or explicitly defer sending |
| AI provider | Sarv AI, OpenAI, Gemini or Custom OpenAI-compatible; optional | Existing connections go to models; otherwise configure access |
| AI connection | Reuse Sarv identity, sign in, API key, or Custom endpoint/auth | Read the available model catalog |
| Model | Choose a model, agree to email processing, test a synthetic prompt | Optional Antivirus |
| Antivirus | Sarv at `https://av.sarv.com`, or Skip | Dedicated scanner OAuth, then actual privacy review and mailbox consent |
| Ready | Review email/sending, AI/model and antivirus | Open inbox; activate the chosen AI settings and complete setup |

Sarv email OAuth connects the email and AI identity once and jumps directly to
model selection. It uses four progress stages instead of six. Changing the AI
provider remains available. AI processing starts only after model choice, explicit
consent and Open inbox. It applies to all connected mailboxes, as disclosed.

AI keys stay in memory until a tested choice is saved to the native credential
vault. A Linux keyring fallback is disclosed if the native vault reports
unencrypted storage. Configuration/catalog/model requests refuse redirects and
never display server bodies containing keys. Custom services may omit API-key
authentication and enter an exact model ID when no catalog is published.

Email connection starts sync in the background. Back, retry and restart preserve
saved accounts and temporary provider choices. The durable pending marker keeps
the remaining wizard available after account creation. An explicit sending
verification/defer result is saved separately from automatically derived OAuth
SMTP settings. Offline resumes retain account details and offer reconnect.

Skipping AI leaves automatic processing off, including background conversation
splitting and contact enrichment. Existing provider credentials are preserved.
Manual AI actions remain available through their explicit app controls.

## Scanner connection

Scanner authorization is independent of email/AI OAuth. The browser can reuse its
Sarv session, but it approves the dedicated scanner client. Native code uses
PKCE/state and the existing exact callback `http://127.0.0.1:8080/auth/callback`.
If port 8080 is occupied, the UI explains how to retry or skip; it never silently
changes the callback registration.

The deployed scanner must expose its Sarv client configuration at `/ui/config`,
with `/ui/oauth/discovery` and `/ui/oauth/token` relays. The implementation checks
the expected issuer, public client and audience before starting sign-in. No
production scanner configuration or OAuth administrator changes are made by
this Inbox change.

After browser approval, the UI shows the scanner's actual operator, region,
privacy version and retention details. Explicit attachment consent creates a
named scanning API credential valid for 90 days. Native code probes with that
credential again, checks that the terms match, then stores it in the existing
encrypted scanner configuration for the selected mailbox. Body scanning is off.
Failed setup revokes only its newly issued token. Reconnect when the token
expires; expired/failed/infected scans remain blocking.

The optional ClamAV extension is bundled but installed only on Connect. Its
initial permissions are persisted atomically as `ui:panel` and
`security:scan-attachments`. Existing scanner configuration and permissions are
preserved when leaving or skipping setup. Already protected mailboxes can
continue; additional account consent is managed in Extensions settings.

Skipping an unconfigured scanner uploads nothing. The existing warning before
viewing/opening/downloading unscanned attachments remains, including the user's
chosen warning-suppression preference. Skipping never adds a bypass for a
configured scanner error or detected threat.

## Validation

Behavioral tests cover provider selection, OAuth/manual receiving and sending,
Sarv reuse, model/config errors, vault storage, explicit consent, interruption,
Back/Skip, account reuse, progress resume, scanner callback/permissions and token
cleanup. UI verification uses the actual components in a disposable harness with
mocked OAuth, mailbox, model and scanner APIs. No live customer mailbox, real
credential or paid model request is used for QA. Keyboard shortcut help is an
optional hint after opening the inbox.
