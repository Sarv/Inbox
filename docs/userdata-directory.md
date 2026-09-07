# userData Directory — Inventory

Reference for everything the app stores under Electron's `userData` directory.
Reflects the current dev-dir contents after the storage cleanup/consolidation
(orphan DBs removed, loose config/secret JSONs migrated into the core DB).

- **Dev build:** `~/Library/Application Support/Sarv Inbox Dev/`
- **Release build:** `~/Library/Application Support/Sarv Inbox/`
- **Windows:** `%APPDATA%\Sarv Inbox\`   **Linux:** `~/.config/Sarv Inbox/`

Roughly **~10 entries are ours**; the rest (group C) are the Chromium/Electron
browser engine's own files — every Electron app (Slack, VS Code, Discord) has the
same set; we neither create nor control those.

> **Action:** `KEEP` = required · `SAFE` = safe to delete (regenerated / stale) ·
> `NEVER` = deleting causes data loss.

---

## A. Sarv Inbox — mail, accounts & settings (ours)

| # | Item | Type | What it is | Action |
|---|---|---|---|---|
| 1 | `sarvinbox-<hash>.db` (per account) | file | An account's encrypted mail DB (SQLCipher). Filename = `sha256(accountId)[:32]`, one per account. | KEEP |
| 2 | `sarvinbox-<hash>.db-shm` | file | SQLite shared-memory sidecar for #1. | KEEP |
| 3 | `sarvinbox-<hash>.db-wal` | file | SQLite write-ahead-log sidecar for #1. | KEEP |
| 4 | `sarvinbox-core.db` | file | **Shared core DB** — OAuth tokens, credential vault, the `account_registry` table, image-allowlist, pipeline state, **and** `agent-config` / `ai-secrets` / `pipeline-ai-config` (migrated from loose JSON). | KEEP |
| 5 | `sarvinbox-core.db-shm` | file | SQLite shared-memory sidecar for #4. | KEEP |
| 6 | `sarvinbox-core.db-wal` | file | SQLite write-ahead-log sidecar for #4. | KEEP |
| 7 | `sarvinbox-core.db.bak` | file | Automatic backup of the core DB. | SAFE (backup) |
| 8 | `db-key.bin` | file | **SQLCipher key** that decrypts every `sarvinbox-*.db`. | NEVER |
| 9 | `attachment-cache/` | dir | Downloaded attachment files, cached per email. | SAFE (re-downloads) |

## B. Sarv Inbox — logs & subsystems (ours)

| # | Item | Type | What it is | Action |
|---|---|---|---|---|
| 10 | `app.log` | file | Rolling dev log (console tee), current segment. | SAFE |
| 11 | `app.log.1` | file | Previous rotated log segment. | SAFE |
| 12 | `draft-debug.log` | file | Dead debug log — no current writer. **Auto-swept on startup** (staleness-guarded). | SAFE → auto-removed |
| 13 | `extensions-data/` | dir | Data dir for the app's extension system (currently 0 extensions). | SAFE |
| 14 | `sentry/` | dir | Sentry SDK working dir — **live** when `SARVINBOX_SENTRY_DSN` is set (buffers offline crash reports); inert in dev without a DSN. **KEPT** (not auto-removed; safe to delete manually). | KEEP |
| 15 | `.com.sarv.sarvinbox.dev.<rand>` | file | Orphaned bundle-id atomic-write temp. **Auto-swept on startup** (staleness-guarded). | SAFE → auto-removed |
| 16 | `.com.sarv.sarvinbox.dev.<rand>` | file | Same as #15 (there are two). | SAFE → auto-removed |

## C. Electron / Chromium runtime — NOT ours (every Electron app has these)

| # | Item | Type | What it is | Action |
|---|---|---|---|---|
| 17 | `Cache/` | dir | HTTP response cache. | SAFE |
| 18 | `Code Cache/` | dir | Compiled-JS / WASM bytecode cache. | SAFE |
| 19 | `GPUCache/` | dir | GPU shader cache. | SAFE |
| 20 | `DawnGraphiteCache/` | dir | WebGPU (Dawn) pipeline cache. | SAFE |
| 21 | `DawnWebGPUCache/` | dir | WebGPU (Dawn) pipeline cache. | SAFE |
| 22 | `Cookies` | file | Cookie store (SQLite). | KEEP (session) |
| 23 | `Cookies-journal` | file | SQLite journal for #22. | KEEP |
| 24 | `Local Storage/` | dir | `window.localStorage` backend — the app still keeps some renderer settings here. | KEEP (UI state) |
| 25 | `Session Storage/` | dir | `window.sessionStorage` backend. | SAFE |
| 26 | `WebStorage/` | dir | Newer web-storage backend. | SAFE |
| 27 | `SharedStorage` | file | Chromium Shared Storage API (SQLite). | SAFE |
| 28 | `Shared Dictionary/` | dir | Network compression-dictionary storage. | SAFE |
| 29 | `blob_storage/` | dir | Blob-URL / large-request-body storage. | SAFE |
| 30 | `Preferences` | file | Chromium per-profile prefs. | KEEP |
| 31 | `Local State` | file | Chromium global (cross-profile) state. | KEEP |
| 32 | `Network Persistent State` | file | QUIC / HTTP-2 per-server config. | SAFE |
| 33 | `TransportSecurity` | file | HSTS / HPKP state. | SAFE |
| 34 | `Trust Tokens` (+ `-journal`) | file | Private State (Trust) Tokens API store. | SAFE |
| 35 | `DIPS` | file | Bounce-tracking mitigation DB (Detect Incidental Party State). | SAFE |
| 36 | `Crashpad/` | dir | Chromium crash-dump handler. | SAFE |
| 37 | `DevToolsActivePort` | file | Port DevTools listens on (dev only). | SAFE |

---

## Removed / consolidated by the storage cleanup (no longer on disk)

| Was | Fate |
|---|---|
| `accounts-registry.db` (+ sidecars) | Legacy orphan — the registry lives in the `account_registry` table of `core.db`. Removed on startup. |
| `acct-<email>` (no prefix/ext) | Oldest-scheme **plaintext** per-account DB (privacy leak). Removed on startup (magic-verified). |
| `sarvinbox-<hash>.db` orphans (+ sidecars) | Per-account DBs from removed/rekeyed identities. Auto-swept **every startup** — registry keep-set protects live accounts, staleness guard protects an actively-synced mailbox. |
| `agent-config.json` | Migrated → `core_blobs` key `agent-config`, then file removed. |
| `ai-secrets.json` | Migrated → `core_blobs` key `ai-secrets`, then file removed. |
| `pipeline-ai-config.json` | Migrated → `core_blobs` key `pipeline-ai-config`, then file removed. |

All migrations follow **write-to-DB-first, then verified-delete**
(`cleanupMigratedLegacyFiles` deletes a legacy file only once its data is confirmed
present in the core DB), so no setting is ever lost.

---

## Notes

- Settings now live in the core DB across the board — no loose config/secret JSON
  files remain.
- Account **removal** does a full nuke of that account's data in every naming scheme
  (current hashed, legacy raw, oldest plaintext) + vault secrets, keeping only
  still-registered accounts.
- Startup sweeps (`cleanupOrphanedAccountDbs`, `cleanupStaleUserDataArtifacts`) run
  every launch, self-healing any future orphan, and are staleness-guarded so a live
  file is never removed.
- Group C is unavoidable Electron/Chromium footprint; a future "Clear cache"
  Settings affordance could purge the `SAFE` cache dirs on demand.
