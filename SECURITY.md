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

## Dependency advisories

`pnpm audit --audit-level=high` runs on every push and pull request
(`.github/workflows/ci.yml`, job "Dependency vulnerability scan") and **fails the
build** on a high or critical advisory. Most are fixed by bumping the direct
dependency; the rest by a `pnpm.overrides` entry in the root `package.json`,
which is how a transitive package deep in someone else's tree gets pinned to a
patched version.

A handful cannot be fixed that way. Those are listed in
`pnpm.auditConfig.ignoreCves` in the root `package.json` — the only mechanism
pnpm 8 offers — and every entry must be justified here. An undocumented entry is
a bug: the point of the gate is that nothing high-severity is silently carried.

Reviewed 2026-09-23:

| CVE | Package | Why it is accepted | Removed when |
| --- | --- | --- | --- |
| CVE-2026-53571 | `vite` <= 6.4.2 | A `server.fs.deny` bypass in vite's **dev server** on Windows. The dev server is a local build tool — it is never started by the packaged app, and no shipped artifact contains vite. Clearing it means moving `apps/desktop` to vite 6, which forces `vite-plugin-electron` 0.28 -> 1.x, a build-system migration on the app's only build path. | `apps/desktop` moves to vite >= 6.4.3. |
| CVE-2025-71329 | `image-size` <= 2.0.2 | JXL/HEIF parser infinite loop (denial of service). Reached only through `metro`, the React Native bundler, under `packages/storage-mobile` and `packages/ui-primitives`. It is a build-time tool for the mobile packages and is not part of the desktop app. **No patched version exists** — the advisory's fixed range is empty. | `image-size` publishes a fix, or `metro` drops it. |
| CVE-2025-71330 | `image-size` <= 2.0.2 | ICNS parser infinite loop (denial of service). Same package, same path, same absence of a fix as above. | As above. |

The CI job prints the full unfiltered report as a separate non-blocking step, so
an ignored advisory getting a fix — or a new path appearing for one — is visible
in the log rather than hidden by the ignore list.
