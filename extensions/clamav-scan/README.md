# ClamAV Scan

This extension is maintained in the **Inbox** repository at
`extensions/clamav-scan`. Its desktop host and permission bridge also live in
Inbox. The scanning API and Docker/ClamAV server are maintained separately in
**Inbox-av-server**.

Install this folder through **Extensions → Install from folder** in Sarv Inbox.
The portable package has no build step or dependencies. It is not published to
the marketplace automatically.

The `attachment.scan` capability opens the Antivirus scan sidebar. Open a
message, configure the scanner in the app's trusted dialog, choose allowed
accounts and consent to attachment sharing, then refresh and select targets.
No target is selected or uploaded automatically.

Body sharing requires the `security:scan-body` grant, a separate setup consent,
and the panel's body checkbox for each submission. The extension never accepts
credentials, reads file bytes, chooses accounts, or connects to the service.
The host retrieves exact MIME targets, stores credentials and owns the upload.
The panel's CSP forbids network connections and inline scripts or styles.

The panel displays no threat detected, threat detected, incomplete and error
results separately, and permits cancellation while a job is active. Use
**Configure scanner → Disable scanning** to revoke sharing consent and cancel
pending work. Disabling or uninstalling the extension also revokes consent.

Use synthetic fixtures and a development scanner to test this package. Sharing
real mail requires your reviewed operator, privacy terms and account consent.
