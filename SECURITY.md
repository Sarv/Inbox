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

Reviewed 2026-10-05:

| CVE | Package | Why it is accepted | Removed when |
| --- | --- | --- | --- |
| [CVE-2026-93748](https://github.com/advisories/GHSA-ch52-4w7c-c8xp) | `http-cache-semantics` <= 4.2.0 | Cross-user response disclosure requires a shared HTTP cache accepting attacker-controlled `max-stale` directives. The dependency is reached only through the desktop **build tool** `electron-builder` → `app-builder-lib` → `@electron/get` → `got` → `cacheable-request`. Inbox does not use this chain to handle mail, OAuth, scanner requests, or shared user caches. **No patched release exists.** This is a temporary exception for that reviewed tooling scope, not a vulnerability fix. | A patched release becomes available, the build tool drops it, or a runtime/shared-cache path appears (reassess before shipping). |
| [CVE-2026-93687](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) | `braces` <= 3.0.3 | Stack exhaustion requires deeply nested glob patterns. All dependency paths are **tooling**: ESLint/globby, Tailwind/chokidar/fast-glob, and Metro/Jest. These tools process project patterns, not mail bodies, attachments, or user-supplied runtime patterns. **No patched release exists.** The remaining build-tool risk is accepted temporarily; the package itself remains vulnerable. | A patched release becomes available, the tooling drops it, or an untrusted runtime-pattern path appears (reassess before shipping). |

The previous Vite exception (`CVE-2026-53571`) was removed: the desktop now
uses Vite 8. The two `image-size` exceptions (`CVE-2025-71329` and
`CVE-2025-71330`) were also removed. The scoped `metro@0.83` override updates
that bundler to 0.83.8, which [replaces the `image-size` dependency with
vendored parsers](https://github.com/react/metro/releases/tag/v0.83.8);
the other Metro line already omits it. No `image-size` package remains in the
lockfile, and no incompatible major-version override is imposed on its consumers.

The CI job prints the full unfiltered report as a separate non-blocking step, so
an ignored advisory getting a fix — or a new path appearing for one — is visible
in the log rather than hidden by the ignore list.
