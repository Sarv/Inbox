# Architecture

Sarv Inbox is a **local-first** desktop email client. Mail is synced over
IMAP/SMTP into a local SQLite database, and every view is rendered from that
local store — the UI never blocks on the network, and nothing leaves the device
unless you configure an AI provider.

This document maps the codebase so contributors can orient quickly. For the dev
workflow and conventions see [CONTRIBUTING.md](../CONTRIBUTING.md) and
[DEVELOPMENT.md](../DEVELOPMENT.md).

## Monorepo layout

pnpm + [Turborepo](https://turbo.build) workspace:

```
packages/
  core/            Platform-agnostic business logic — no DOM, no Node-only APIs
                   in its public surface. IMAP/SMTP clients, OAuth, parser, the
                   AI/agent pipeline, extensions, and shared utils.
  storage-node/    Desktop SQLite persistence (better-sqlite3) — repositories,
                   migrations, FTS5 search, vector storage.
  storage-mobile/  The same storage contract on op-sqlite, for a future mobile app.
  ui-shared/       Framework-agnostic React hooks and view logic.
  ui-primitives/   Platform-specific UI wrappers.
apps/
  desktop/         Electron + React + Vite — the desktop client (the only app in the tree).
```

Dependency direction is one-way: **apps → ui-\* / storage-\* → core**. `core`
depends on nothing else in the repo.

## The desktop app (`apps/desktop`)

Electron has two processes; the boundary is the security model.

- **Main process** (`electron/`) — Node context. Owns IMAP/SMTP connections (via
  `@sarvinbox/core`), the SQLite database (via `@sarvinbox/storage-node`), OAuth
  token storage (encrypted with Electron `safeStorage`), background schedulers
  (sync, snooze wake-up, body prefetch, contact enrichment, the AI pipeline), and
  all filesystem access. Exposes functionality to the renderer over **typed IPC**
  handlers (`electron/ipc/`).
- **Renderer** (`src/`) — React + Vite, `contextIsolation` on, `nodeIntegration`
  off. Talks to the main process only through the `window.electronAPI` bridge
  defined in `electron/preload.ts`. State lives in a Zustand store
  (`src/store/`), sliced by concern (connection, emails, sections, …).

```
IMAP/SMTP  ──►  core clients  ──►  storage-node (SQLite)  ──►  IPC  ──►  renderer store  ──►  React views
   ▲                                     │
   └──────────── operation queue ◄───────┘   (offline flag/move ops replay on reconnect)
```

The renderer reads and renders from the local DB; sync happens in the
background and pushes updates through IPC. Actions (star, read, move, …) update
the UI optimistically and revert on failure.

## Core subsystems (`packages/core`)

- **IMAP** (`src/imap/`) — `ImapFlowClient` is the only IMAP client. Connection
  pooling, IDLE realtime sync, incremental sync, a reconnect ladder, and an
  operation queue for offline flag/move operations. All clients implement the
  `IIMAPClient` interface.
- **SMTP** (`src/smtp/`) — sending via nodemailer.
- **OAuth** (`src/oauth/`) — Gmail and Sarv providers, PKCE, XOAUTH2, token
  refresh. Client secrets come from the environment, never source.
- **Parser** (`src/parser/`) — MIME → clean text/HTML, HTML → Markdown.
- **Pipeline & Agent** (`src/pipeline/`, `src/agent/`) — the AI layer:
  categorization, behavior-based prioritization, conversation extraction, reply
  drafting. Provider-agnostic (any OpenAI-compatible LLM/embeddings endpoint).
- **Extensions** (`src/extensions/`) — a permission-checked, sandboxed API
  surface for extending pipeline behavior.
- **Utils** (`src/utils/`) — shared, framework-agnostic helpers (ids, logger,
  validators, tags, `withTimeout`, TLS options, error classifiers). This is the
  home for logic reused across core and the Electron main process.

## Storage (`packages/storage-node`)

`SQLiteStorage` is the facade implementing the `IEmailStorage` contract from
core. It opens the DB, runs migrations, and delegates to per-entity
repositories (email, folder, thread, contact, AI, search, agent). Notable
design points:

- **Unified tags model** — folder membership, flags (read/starred/draft/…), and
  AI categories are all encoded in a single pipe-delimited `tags` string
  (`|INBOX|read|important|`), queried with `instr(tags, '|tag|')`. Zero JOINs for
  the common list/section queries.
- **FTS5** full-text search plus a vector store for semantic search.
- **Migrations** run on `initialize()`; the schema is versioned.

`storage-mobile` implements the same contract on op-sqlite for a future mobile
app; no mobile app ships in this repository yet.

## Key design principles

1. **Privacy first** — data stays local unless you configure an AI provider.
2. **AI suggests, doesn't act silently** — deterministic, explainable behavior;
   the client works fully even with AI disabled.
3. **Fail safe** — network/AI failures degrade gracefully; the local store is
   always the source of truth for rendering.
4. **Reuse over duplication** — shared, framework-agnostic logic lives in
   `packages/core/src/utils/` and is imported everywhere rather than copied.
