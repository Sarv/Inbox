# Security Policy

Sarv Inbox is an email client — it handles credentials, OAuth tokens, and the
full contents of your mailbox. We take security reports seriously and appreciate
responsible disclosure.

## Supported versions

Security fixes are applied to the latest release on the `main` branch. Older
versions are not maintained.

| Version | Supported |
| ------- | --------- |
| latest (`main`) | ✅ |
| older releases  | ❌ |

## Reporting a vulnerability

**Please do not open a public issue for security vulnerabilities.**

Report privately via one of:

1. **GitHub Security Advisories** (preferred) — use the repository's
   **Security → Report a vulnerability** tab. This keeps the report private
   until a fix is released.
2. **Email** — `support@sarv.com` with the subject `[Sarv Inbox] Security`.

Please include:

- A description of the issue and its impact.
- Steps to reproduce (a minimal proof-of-concept if possible).
- Affected version / commit and platform (macOS, Windows, Linux).

## What to expect

- **Acknowledgement** within 3 business days.
- An initial assessment and severity rating within 7 business days.
- Coordinated disclosure — we'll agree on a timeline and credit you in the
  release notes unless you prefer to remain anonymous.

## Scope

Areas we consider especially sensitive (in-scope, high priority):

- Credential / OAuth token storage and handling.
- TLS/transport security for IMAP and SMTP connections.
- Rendering of untrusted email content (HTML sanitization, sandboxing).
- Handling of attacker-controlled links and external-URL opening.
- Any path that could lead to remote code execution in the Electron process.

Out of scope: issues that require a already-compromised local machine, or that
only affect unsupported/self-modified builds.

Thank you for helping keep Sarv Inbox and its users safe.
