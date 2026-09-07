# Contributing to Sarv Inbox

Thanks for your interest in contributing! This guide covers how to set up the
project, the conventions we follow, and how to get a change merged.

By participating, you agree to abide by our [Code of Conduct](./CODE_OF_CONDUCT.md).

## Prerequisites

- **Node.js ≥ 22** (the repo pins a version in [`.nvmrc`](./.nvmrc) — run
  `nvm use` if you use nvm).
- **pnpm ≥ 8** (`corepack enable` will give you the pinned `pnpm@8.15.0`).

## Getting started

```bash
git clone https://github.com/Sarv/Inbox.git
cd Inbox
pnpm install

# Configure credentials (OAuth client IDs, LLM endpoints, etc.)
cp .env.example .env
#   then edit .env — see OAUTH_SETUP.md and SARV_OAUTH_SETUP.md

# Run the desktop app in dev mode
pnpm dev:desktop
```

`.env` is gitignored and must never be committed. All values are optional —
providers you don't configure are simply hidden in the UI.

## Repository layout

This is a pnpm + [Turborepo](https://turbo.build) monorepo.

```
packages/
  core/           Platform-agnostic business logic (IMAP/SMTP, AI, OAuth, utils)
  storage-node/   SQLite storage for the desktop app
  storage-mobile/ The same storage contract on op-sqlite, for a future mobile app
  ui-shared/      Shared React hooks and logic
  ui-primitives/  Platform-specific UI wrappers
apps/
  desktop/        Electron + React + Vite desktop client
```

- Shared, framework-agnostic helpers live in `packages/core/src/utils/` and are
  exported from the `@sarvinbox/core` barrel so both core and the Electron main
  process can import them.
- The renderer (`apps/desktop/src`) must **not** import the `@sarvinbox/core`
  barrel at runtime (Vite would pull in Node-only deps); renderer-safe helper
  copies live in `apps/desktop/src/utils/`.

## Common commands

| Command | What it does |
| --- | --- |
| `pnpm dev:desktop` | Run the desktop app with hot reload |
| `pnpm type-check` | TypeScript check across all packages |
| `pnpm lint` | ESLint across the workspace |
| `pnpm build` | Build every package **and** package the desktop app with `electron-builder` (needs the signing assets under `apps/desktop/build/` — not needed for day-to-day work) |
| `pnpm build:core` | Build just `@sarvinbox/core` |
| `pnpm test` | Run tests (see [docs/TESTING.md](./docs/TESTING.md), including the `better-sqlite3` ABI note) |
| `pnpm format` | Prettier format |

> **Note:** after changing `packages/core`, restart `pnpm dev:desktop` — the
> Electron main process loads the built `core` and won't pick up new exports
> until it re-launches.

## Coding conventions

- **TypeScript, ES6+.** `const`/`let` only, `async`/`await` over callbacks,
  arrow functions for inline callbacks, optional chaining / nullish coalescing.
- **Reuse over duplication.** If the same logic appears in two places, extract a
  small, pure, single-responsibility helper and import it everywhere. Prefer
  functions that are easy to unit-test.
- **Naming:** `camelCase` for values/functions, `PascalCase` for
  classes/components, `UPPER_SNAKE_CASE` for true constants.
- **Isolate I/O at the edges;** keep business logic pure and framework-agnostic
  where possible.
- Run `pnpm type-check` before pushing.

## Commit messages

We use [Conventional Commits](https://www.conventionalcommits.org/) — single
line, imperative mood:

```
<type>(<scope>): <subject>
```

Types: `feat`, `fix`, `docs`, `style`, `refactor`, `test`, `chore`.

```
feat(imap): add ImapFlow reconnect backoff
fix(inbox): reload sections when the inbox view type changes
docs(readme): update setup steps
```

Prefer several small, logically-grouped commits over one large commit.

## Pull requests

1. Fork and create a branch off `main` (`feat/…`, `fix/…`).
2. Make your change; keep it focused. Behavioural changes ship with tests in
   the same PR (see [docs/TESTING.md](./docs/TESTING.md)).
3. Ensure `pnpm type-check`, `pnpm lint` and `pnpm test` pass.
4. Open a PR using the template. Describe **what** changed and **why**, and link
   any related issue.
5. A maintainer will review. CI (type-check, lint, renderer-bundle guard, unit &
   integration tests, dependency audit) must be green before merge.

Contributions are accepted under the repository's [MIT licence](./LICENSE): by
opening a pull request you agree that your contribution is licensed under the
same terms as the rest of the project (inbound = outbound).

## Reporting bugs & requesting features

Use the [issue templates](https://github.com/Sarv/Inbox/issues/new/choose).
For **security** issues, do **not** open a public issue — see
[SECURITY.md](./SECURITY.md).
