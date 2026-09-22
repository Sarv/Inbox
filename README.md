<p align="center">
  <img src="apps/desktop/public/icon.svg" alt="Sarv Inbox" width="128" height="128">
</p>

# Sarv Inbox

[![License: Sarv Community License](https://img.shields.io/badge/license-Sarv%20Community%20License-0b7285.svg)](./LICENSE)
[![fair-code](https://img.shields.io/badge/fair--code-source%20available-blue.svg)](https://faircode.io)
[![CI](https://github.com/Sarv/Inbox/actions/workflows/ci.yml/badge.svg)](https://github.com/Sarv/Inbox/actions/workflows/ci.yml)

A source-available, privacy-first email client with AI-powered features —
semantic search, smart labeling, and a conversation view that turns long threads
into a readable chat. Your mail stays on your device; nothing leaves it unless
you configure an AI provider.

Free to use and modify, including commercially, for yourself or your
organisation. Selling it, hosting it for others, bundling it into your own
product, or removing the Sarv branding needs our written permission — see
[License](#license).

## Features

- **IMAP sync** — connect any IMAP/SMTP account, with OAuth for Gmail and Sarv.
- **Local-first storage** — all mail lives in a local SQLite database.
- **Thread & conversation view** — automatic threading plus an AI-extracted,
  chat-style reading mode for deep Outlook/Gmail quote chains.
- **Fast search** — full-text (SQLite FTS5) and AI-powered semantic search.
- **Smart categorization** — AI labels (Important, Needs Response, Meetings,
  Invoices, …) with a customizable, section-based inbox.
- **Privacy-first** — no data leaves your device unless you opt into an AI
  provider; TLS verification is on by default.
- **Cross-platform** — macOS, Windows and Linux (Electron).

## Getting started

### Prerequisites

- **Node.js ≥ 22** — the repo pins a version in [`.nvmrc`](./.nvmrc)
  (`nvm use`). `better-sqlite3` ships prebuilds for 22 and 24.
- **pnpm ≥ 8** — easiest via Corepack (bundled with Node).

### Quick start (fresh clone)

```bash
git clone https://github.com/Sarv/Inbox.git
cd Inbox

# Use the pinned toolchain
nvm use                                              # reads .nvmrc
corepack enable && corepack prepare pnpm@8.15.0 --activate

# Install (postinstall rebuilds native deps for Electron's ABI)
pnpm install

# Configure OAuth client IDs / LLM endpoints (all optional)
cp .env.example .env        # then edit — see OAUTH_SETUP.md / SARV_OAUTH_SETUP.md

# Run the desktop app
pnpm dev:desktop
```

`pnpm dev:desktop` builds `core` + `storage-node`, then launches Vite +
Electron.

> **Don't** run `pnpm build` to start the app — that runs `electron-builder` to
> package a distributable and needs the signing assets under
> `apps/desktop/build/`. For day-to-day work use `pnpm dev:desktop`.

### Configuration

Secrets are never baked into source — supply them via environment variables
(loaded from a gitignored `.env` in dev). See [`.env.example`](./.env.example)
for the full list, and:

- [OAUTH_SETUP.md](./OAUTH_SETUP.md) — Gmail / Google Workspace OAuth
- [SARV_OAUTH_SETUP.md](./SARV_OAUTH_SETUP.md) — Sarv OAuth (mailbox + LLM)

Providers you don't configure are simply hidden in the UI.

## Development

```bash
pnpm dev:core       # watch-build the core package
pnpm type-check     # TypeScript across all packages
pnpm lint           # ESLint
pnpm test           # tests
pnpm format         # Prettier
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the full workflow, conventions, and
commit format.

> After changing `packages/core`, restart `pnpm dev:desktop` — the Electron
> main process loads the built `core` and won't pick up new exports until it
> re-launches.

## Architecture

pnpm + [Turborepo](https://turbo.build) monorepo.

```
packages/
  core/            Platform-agnostic business logic (IMAP/SMTP, AI, OAuth, utils)
  storage-node/    Desktop SQLite (better-sqlite3)
  storage-mobile/  The same storage contract on op-sqlite, for a future mobile app
  ui-shared/       Shared React hooks and logic
  ui-primitives/   Platform-specific UI wrappers
apps/
  desktop/         Electron + React + Vite
```

**Stack:** TypeScript · Electron · React · Vite · Tailwind · Zustand ·
SQLite (FTS5 + vector search) · OpenAI-compatible LLM/embeddings.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for a deeper tour of the
processes, data flow, and core subsystems.

The mail-security rules — SPF/DKIM/DMARC reading, display-name impersonation,
the header-stage spam score, deceptive links and the security levels — are
maintained as a separate open-source library,
[`@sarv-in/mailguard`](https://github.com/Sarv/mailguard). See
[docs/mailguard.md](docs/mailguard.md) for what stayed behind and
how to switch the dependency between the local checkout and the registry.

### Extensions

Sarv Inbox loads extensions from a folder: a manifest, a bundled entry point,
and a list of permissions the user sees before installing. They are published
to their own repository,
[Sarv/SarvInbox-extensions](https://github.com/Sarv/SarvInbox-extensions),
and installed from **Settings → Extensions → Browse**: the app reads that
registry over HTTPS, shows you exactly what an extension can do, and refuses
the download unless it hashes to the SHA-256 the registry pinned. Three are
published today — one-time passcodes, VIP scoring, and thread summarization —
and the build decides which of them a new profile starts with in
[`apps/desktop/extensions.config.json`](apps/desktop/extensions.config.json).

Write your own against [`@sarvinbox/extension-sdk`](packages/extension-sdk).
[docs/EXTENSIONS.md](docs/EXTENSIONS.md) covers the host side — the manifest,
the permission model, the workflow contract, the SDK, and how an install is
verified — and the extensions repository's README covers scaffolding,
publishing a release, and running a registry of your own.

### Design principles

1. **Privacy first** — data stays local unless you configure AI providers.
2. **AI suggests, doesn't act silently** — deterministic, explainable behavior.
3. **Fail safe** — the email client works even if AI is unavailable.
4. **Reuse over duplication** — shared logic lives in `packages/core`.

## Debug logging

In **dev only**, the desktop main-process console is also written to a rolling
`app.log` (20 MB cap, oldest-half dropped on overflow) in the app's
[userData directory](docs/userdata-directory.md). The dev build uses its own
directory, `Sarv Inbox Dev`, so it never mixes with an installed release:

- macOS: `~/Library/Application Support/Sarv Inbox Dev/app.log`
- Windows: `%APPDATA%\Sarv Inbox Dev\app.log`
- Linux: `~/.config/Sarv Inbox Dev/app.log`

```bash
tail -f "$HOME/Library/Application Support/Sarv Inbox Dev/app.log"   # macOS
pnpm clean:logs     # clear logs only, on every platform (leaves DB/credentials)
```

It's covered by `*.log` in `.gitignore`, so it's never committed.

## Contributing

Contributions are welcome! Please read [CONTRIBUTING.md](./CONTRIBUTING.md) and
our [Code of Conduct](./CODE_OF_CONDUCT.md). Notable changes are recorded in
[CHANGELOG.md](./CHANGELOG.md).

## Security

Found a vulnerability? **Do not open a public issue** — see
[SECURITY.md](./SECURITY.md) for private disclosure.

## License

[Sarv Community License, Version 1.0](./LICENSE) © 2026 Sarv Webs Private
Limited and Sarv Inbox contributors.

This is a **source-available ([fair-code](https://faircode.io))** licence, not an
OSI-approved open-source licence — we do not call it open source, because it
is not.

**Always allowed, no permission needed**

- Use it for anything, including your own commercial work, at any scale
- Self-host it for your organisation, with no user limit and no fee
- Read, modify and study the source
- Redistribute it **free of charge**, with the Sarv branding intact, publishing
  the source of any changes you made

**Needs our written consent**

- Selling it, or charging any fee for it or a modified version
- Offering it to third parties as a hosted, managed or white-label service
- Bundling or embedding it in a product or service you supply to others
- Rebranding it, or removing/altering the Sarv name, logos and notices

Questions answered in [docs/LICENSING-FAQ.md](./docs/LICENSING-FAQ.md).
Commercial, OEM, hosting and white-label licences: **licensing@sarv.com** — we
grant them, and they can include the branding rights the community licence
withholds.

### Trademarks

The Sarv name and the Sarv / Sarv Inbox logos are trademarks of Sarv Webs
Private Limited and are **not** licensed with the code. The licence requires you
to *keep* them on copies you pass on; it does not let you use them to name or
promote anything of your own, or to present a modified build as official. See
[TRADEMARKS.md](./TRADEMARKS.md).

### Third-party components

Dependencies keep their own licences (mostly MIT and Apache-2.0; `ical.js` is
MPL-2.0) — see [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).
