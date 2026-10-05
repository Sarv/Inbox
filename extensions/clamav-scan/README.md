# ClamAV Scan

This extension is maintained in the **Inbox** repository at
`extensions/clamav-scan`. Its desktop host and permission bridge also live in
Inbox. The scanning API and Docker/ClamAV server are maintained separately in
**Inbox-av-server**.

Install this folder through **Extensions → Install from folder** in Sarv Inbox.
The portable package has no build step or dependencies. It is not published to
the marketplace automatically.
Download and preview protection require the updated Inbox desktop build;
installing the extension into an older build does not add the host workflows.

The `attachment.scan` capability opens the Antivirus scan sidebar. Open a
message and configure the scanner in the app's trusted dialog. Sign in to the
scanner UI using Sarv OAuth, create an `iv_` scanning token, enter the scanner
origin and token, then choose allowed accounts and consent to attachment sharing.
An organisation can share a scanning token; those users consume the same
scanner-account limits. The extension receives neither the token nor account
credentials.

With this extension enabled, opening an attachment, **Open in system app**,
**Download** and **Save all** retrieve selected attachments in the background
and show scanning progress when the scanner is configured for the account.
Viewing, opening and saving then require a complete **No threat detected**
verdict matching the exact retrieved bytes. Threats, incomplete results and
scanner failures stop the action. If setup or account sharing approval is
missing, an in-app warning shows the complete attachment filename and offers
**Cancel**, **Set up antivirus** or **View anyway** for a preview. Other actions use
**Open anyway**, **Download anyway** or **Add anyway**. Continuing shows **Not scanned**
and sends nothing to the scanner. The **Don't show this message again** link
remembers the warning choice for that account only when you continue; cancelling
does not save it. **Show warnings again** in scanner setup clears the account's
choice. Saving scanner configuration or disabling/uninstalling the scanner
clears remembered warning choices; removing an account clears its choice. This affects
missing-setup warnings only: configured scanning still runs, and the preference
does not approve attachment sharing.
This works across supported mail providers. Attachments are not uploaded merely
by opening a message, and attachment preview and download protection do not
upload its body or inline
body images. PDFs, images, text and media are scanned before the in-app viewer
receives their bytes; supported Office documents are scanned before the system
application opens them. An explicitly unscanned preview uses a temporary app
permission bound to the selected account, message, filename and missing-setup
state; direct attachment URLs cannot skip the warning or scan.
Encrypted OpenPGP attachment saves are blocked when scanning is configured for
the account; decrypted plaintext is not sent to the scanner. **Add to calendar**
is also blocked in that case because it generates a file from message-derived
text; use the named `.ics` attachment's protected controls instead. When setup
or account approval is missing, the warning can permit an explicitly unscanned
local OpenPGP save or calendar import. The calendar summary in the message
remains available.

In-app PDF and media viewers use the app's **Save a copy** control. While this
protection is enabled, native viewer and context-menu downloads direct you to
that control so saving cannot bypass the scan.

The sidebar still supports manual scanning: refresh targets, select attachments
and click **Scan selected**. A no-threat result describes the configured scan
coverage; it is not a guarantee that a file is safe.

Body sharing requires the `security:scan-body` grant, a separate setup consent,
and the panel's body checkbox for each submission. The extension never accepts
credentials, reads file bytes, chooses accounts, or connects to the service.
The host retrieves exact MIME targets, stores credentials and owns the upload.
The panel's CSP forbids network connections and inline scripts or styles.

The panel displays no threat detected, threat detected, incomplete and error
results separately, and permits cancellation while a job is active. Use
**Configure scanner → Disable scanning** to revoke sharing consent and cancel
pending work. Disabling or uninstalling the extension also revokes consent.
Without an enabled scanner extension, normal attachment download and preview
behavior applies.

Use synthetic fixtures and a development scanner to test this package. Sharing
real mail requires your reviewed operator, privacy terms and account consent.
