# Sarv Inbox

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![CI](https://github.com/Sarv/SarvInbox/actions/workflows/ci.yml/badge.svg)](https://github.com/Sarv/SarvInbox/actions/workflows/ci.yml)

An open-source, privacy-first email client with AI-powered features — semantic
search, smart labeling, and a conversation view that turns long threads into a
readable chat. Your mail stays on your device; nothing leaves it unless you
configure an AI provider.

<p align="center">
  <img src="docs/screenshots/inbox.webp" alt="Sarv Inbox — section-based, prioritized inbox" width="100%">
</p>

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
- **Cross-platform** — desktop (Electron) and mobile (React Native).

## Screenshots

| | |
| :---: | :---: |
| **AI conversation view** | **Compose, reply &amp; forward** |
| ![AI conversation view](docs/screenshots/conversation-view.webp) | ![Compose](docs/screenshots/compose.webp) |
| **Focused reading** | **Fast full-text &amp; semantic search** |
| ![Reading a message](docs/screenshots/reading.webp) | ![Search](docs/screenshots/search.webp) |
| **Bulk select by read / star / state** | **Deep customization** |
| ![Bulk select](docs/screenshots/bulk-select.webp) | ![Settings](docs/screenshots/settings.webp) |

## Getting started

### Prerequisites

- **Node.js ≥ 22** — the repo pins a version in [`.nvmrc`](./.nvmrc)
  (`nvm use`). `better-sqlite3` ships prebuilds for 22 and 24.
- **pnpm ≥ 8** — easiest via Corepack (bundled with Node).

### Quick start (fresh clone)

```bash
git clone https://github.com/Sarv/SarvInbox.git
cd SarvInbox

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
- [SARV_OAUTH_SETUP.md](./SARV_OAUTH_SETUP.md) — Sarv OAuth + LLM

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
  storage-mobile/  Mobile SQLite (op-sqlite)
  ui-shared/       Shared React hooks and logic
  ui-primitives/   Platform-specific UI wrappers
apps/
  desktop/         Electron + React + Vite
  mobile/          React Native (Expo)
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
`app.log` (20 MB cap, oldest-half dropped on overflow) next to the database:

- macOS: `~/Library/Application Support/Sarv Inbox/app.log`

```bash
tail -f "$HOME/Library/Application Support/Sarv Inbox/app.log"
pnpm clean:logs     # clear logs only (leaves DB/credentials)
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

[MIT](./LICENSE) © Sarv and Sarv Inbox contributors
