# Sarv Inbox

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![CI](https://github.com/Sarv/Inbox/actions/workflows/ci.yml/badge.svg)](https://github.com/Sarv/Inbox/actions/workflows/ci.yml)

An open-source, privacy-first email client with AI-powered features — semantic
search, smart labeling, and a conversation view that turns long threads into a
readable chat. Your mail stays on your device; nothing leaves it unless you
configure an AI provider.

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

[MIT](./LICENSE) © Sarv and Sarv Inbox contributors.

### Trademarks

The Sarv name and the Sarv / Sarv Inbox logos are trademarks of Sarv and are
**not** covered by the MIT licence. You're free to use, modify and redistribute
the code under MIT, but please don't present a modified build as an official
Sarv release or use the Sarv marks in a way that suggests endorsement.
