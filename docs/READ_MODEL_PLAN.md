# Read-Model Plan: `threads` / `thread_folders` / `thread_categories`

> Historical design note (2026). Superseded by [docs/ARCHITECTURE.md](./ARCHITECTURE.md); kept for context.

Status: **live — section reads served from the read-model by default**. Done:
schema + v64/v65 migrations, `thread-rollup.ts` derivation, trigger-based dirty
queue + `ReadModelMaintainer` (upkeep + backfill), the section read cutover
(default-on once backfilled; kill-switch `SARVINBOX_READMODEL_READS=0`), and
category-definition re-dirtying. Remaining: cross-account k-way merge, All-Mail
(folder-less) fast path, optional keyset pagination, and legacy-path retirement.
31 tests pass.

## Why

The sectioned-inbox list is served by a dynamic `GROUP BY thread` +
correlated-`EXISTS` `HAVING` query over `emails`, ordered by `MAX(date)`. It is
`O(all threads × correlated subqueries)` **per keystroke**, on the synchronous
main-thread better-sqlite3 connection. It already beachballs at ~2,600 threads /
25k emails (see the dev SlowQuery log). The product target — power users with
multiple accounts and 100k+ mail per account — is 10–40× that load. No index,
keyset, or query rewrite saves an on-the-fly `GROUP BY` at that scale.

Decision: shift from **read-side dynamic computation** to a **write-side
materialized read-model** (fan-out on write). This is the standard architecture
for high-performance mail clients (Outlook, Thunderbird, Superhuman). Once thread
state is stored, the normal folder list and the sectioned inbox collapse into
**one keyset query shape** that differs only by its `WHERE` predicates, and both
become `O(log N + K)` with `K = 50`.

Scope: everything is **per-account SQLite DB** (SQLCipher, synchronous
better-sqlite3). Cross-account ("All Inboxes") stays a main-process k-way merge —
you cannot `JOIN` across separate DB files, and `ATTACH` is avoided (cross-file
locking). All DDL is additive and idempotent (`IF NOT EXISTS`).

## Foundational invariants (everything derives from them)

- **`last_message_date` follows `emails.date` (Unix SECONDS), `NOT NULL`.** One
  unit everywhere, copied verbatim from the source column so there's no
  conversion drift against the legacy path. (The design brief said "ms"; seconds
  satisfies the real invariant — single unit, total order — with zero conversion.)
- **"Live" scope** excludes `Trash / Spam / Junk / Deleted` copies (and
  `|deleted|`) — matching `THREAD_STATE_EXCLUDED_FOLDERS` / `threadTagExists`.
  Per-folder rows use the folder-local listing scope (the
  `getExcludeSpecialFolders` set), matching `getByFolder` / the section inner
  query. The rollup reuses these exact predicates so the new path can never
  disagree with the old during the fallback window.
- **Derivation is deterministic** from a thread's `emails` rows, so
  `rebuildThread` is idempotent and safe to run any number of times (backfill,
  self-heal).

---

## 1. DDL (implemented in schema.sql + migration v64)

### 1a. `threads` — additive denormalized state

`has_important`, `has_important_unread`, `has_attachment`, `has_draft`,
`has_category`, `max_priority_score`, `first_sender`, `last_sender`,
`live_message_count`, `state_version`. (`has_unread`, `has_flagged`,
`last_message_date`, `message_count`, `subject`, `participants` already existed.)

> `has_important_unread` is **not** `has_important AND has_unread` — it means one
> message is both important and unread. Computed independently.

### 1b. `thread_folders` — per-(folder, thread) materialized read index

`WITHOUT ROWID`, PK `(folder_id, thread_id)`. Replicates `last_message_date`
(folder-local), `max_priority_score` (folder-local), and the conversation-wide
LIVE flags so a folder/section listing is a covering range scan that never
touches `threads` until hydration.

### 1c. `thread_categories` — normalized category membership

`WITHOUT ROWID`, PK `(thread_id, slug)`. Drives the materialized `has_category`
boolean and per-category browse (the AI tabs) via join.

### 1d. Indexes

- `idx_tf_list (folder_id, last_message_date DESC, thread_id DESC)` — default
  date-ordered listing; serves BOTH keyset directions via reverse scan.
- `idx_tf_priority (folder_id, max_priority_score DESC, last_message_date DESC, thread_id DESC)`
  — important-first sections.
- Partial `idx_tf_unread (… ) WHERE has_unread = 1` and
  `idx_tf_unlabelled (… ) WHERE has_category = 0` — hot + selective filters only.
- `idx_tc_slug (slug, thread_id)` — per-category browse.

### 1e. `read_model_state (key, value)` — per-account backfill progress

keys: `status` (`pending`|`running`|`complete`), `cursor`, `threads_done`,
`threads_total`, `schema_version`, `updated_at`.

### The unified read query (both lists, one shape) — for the cutover step

```sql
SELECT t.*
FROM thread_folders tf
JOIN threads t ON t.id = tf.thread_id
WHERE tf.folder_id = :folder
  AND tf.has_important_unread = 0    -- "Everything else"  (omit for a normal folder)
  AND tf.has_flagged          = 0
  AND tf.has_category         = 0    -- "+ Unlabelled"     (a quick-filter predicate)
  AND (tf.last_message_date, tf.thread_id) < (:cursor_date, :cursor_id)  -- keyset / search_after
ORDER BY tf.last_message_date DESC, tf.thread_id DESC
LIMIT 50;
```

Reverse (previous page): invert both operator and order —
`(…) > (:cursor_date, :cursor_id) ORDER BY … ASC`.

---

## 2. Maintenance interface (implemented in thread-rollup.ts)

- `deriveRollup(threadId, rows, ctx)` — **pure**, unit-testable, THE single source
  of thread-level semantics.
- `computeThreadRollup(db, threadId, ctx?)` — read + derive.
- `rebuildThread(db, threadId, ctx?)` / `rebuildThreads(db, threadIds, ctx?)` —
  persist (upsert `threads` read-model columns, replace `thread_folders` +
  `thread_categories`), idempotent, in one `IMMEDIATE` transaction.
- `verifyThread(db, threadId, ctx?)` — drift check (FNV-1a `state_version` +
  `live_message_count`) for lazy self-healing.
- `buildRollupContext(db)` — cached folder-path→id map + category-slug set.
- `withImmediateTxn(db, fn)` — `db.transaction(fn).immediate`, nesting-safe.

### Transaction contract (concurrent sync writes)

`BEGIN IMMEDIATE` acquires the RESERVED lock up front so the sync writer never
deadlocks a reader that opened a DEFERRED txn. WAL is on (asserted at DB open),
so readers proceed against the last committed snapshot — no torn reads. The IMAP
FETCH batch + the rollups for every thread it touched are **one** transaction.

### Write upkeep — trigger dirty-queue (IMPLEMENTED; supersedes per-method hooks)

The original plan hooked each list-mutating repo method. That was **rejected**
during implementation: tag changes flow through many paths (`addTag`/`removeTag`/
`setTags` **and** several ad-hoc `UPDATE emails SET tags`), so method-hooking
would silently miss some — the exact drift risk this design set out to avoid.

Instead, lightweight `AFTER INSERT / UPDATE OF … / DELETE` triggers on `emails`
record the affected `thread_id` into `read_model_dirty` (v65). The triggers do
**no derivation** — they only record *which* thread changed; the rollup logic
stays in TS (`thread-rollup.ts`), honoring the "no logic in SQL" intent. The
`ReadModelMaintainer` drains the queue: `rebuildThreads(chunk)` then delete the
drained rows, in one `IMMEDIATE` txn, chunked with `setImmediate` yields.

This captures **every** write path (current and future) with one mechanism, and
`UPDATE OF tags, folder_id, has_attachments, priority_score, date, thread_id`
scopes it to only the columns that feed the rollup. Rebuild failures are logged
and the rows stay queued (retried next drain) — a derived-state bug never blocks
or corrupts a real mail write. A test proves an ad-hoc `UPDATE` is still caught.

### Folder mapping for Drafts & Sent

- **Unsent `\Draft`** — sets `has_draft`, excluded from `live_message_count` and
  `last_message_date`, produces only a Drafts-folder row (never INBOX).
- **Sent reply** — its own Sent-folder row. Per-folder `last_message_date` is
  currently folder-local (parity with the legacy query). The Gmail-style
  "reply bumps the INBOX thread" can be enabled later by widening INBOX's date to
  conversation-wide (deliberately deferred, not dropped).

---

## 3. Migration & backfill

### Migrations (done — v64 + v65, run automatically on next launch)

`SQLiteStorage.initialize()` runs `migrate()` on every account DB open. v64 adds
the `threads` columns + `thread_folders`/`thread_categories`/`read_model_state`;
v65 adds `read_model_dirty` + the triggers. Both are additive (`ADD COLUMN` =
O(1) metadata; `CREATE … IF NOT EXISTS`), transactional, and idempotent. They do
NOT backfill; existing data is untouched and reads stay on the legacy path.

### Backfill = seed + drain the dirty queue (IMPLEMENTED)

Backfill is unified with ongoing upkeep — there is no separate keyset-cursor
runner. On first run the maintainer seeds the queue with every existing thread
(`INSERT OR IGNORE INTO read_model_dirty SELECT DISTINCT thread_id FROM emails`),
sets `status='running'` + `threads_total`, and the normal chunked drain empties
it (`status='complete'` + `ANALYZE`).

- **The queue IS the cursor** — a dirty row is deleted only after its rebuild
  commits, so an interrupted backfill resumes from what's left. `rebuildThread`
  is idempotent → a crash mid-chunk just re-does one uncommitted chunk.
- **Non-blocking** — seed + drain run on later ticks (`setImmediate`), never
  stalling startup; chunks yield so UI + IDLE sync interleave.

### Read cutover (IMPLEMENTED, default-on)

`getEmailsBySection` / `getSectionCount` branch to the `thread_folders` fast path
when `status='complete'` (**default on**); `SARVINBOX_READMODEL_READS=0` is the
kill-switch that forces the legacy `GROUP BY`. The fast path selects the page's thread
ids from `thread_folders` (indexed) then hydrates the SAME email rows + THREAD_META
in the same order, so the renderer + OFFSET pagination are unchanged. Parity with
the legacy path (thread sets + counts, every section + the Unlabelled filter) is
proven by `section-read-parity.test.ts`. Default-on shipped after live
verification (legacy `getSectionByThreads` slow-queries went 312 → 0); retire the
legacy path one release later.

### Self-healing

`verifyThread` on thread open compares stored `state_version`/`live_message_count`
to a cheap recompute; a mismatch enqueues an async rebuild (off the synchronous
write path) and serves stored data now. Backs a periodic low-priority verifier.

---

## Cross-account (unified "All Inboxes")

No cross-file `JOIN`. Run the per-account keyset query (each an already-sorted
stream) and k-way merge the top 50 in the main process. Bounded by `50 × N`.

---

## Ratified open items

1. `WITHOUT ROWID` on the junction tables — **approved**.
2. Partial-index set = `unread` + `unlabelled` only; tune the rest from
   `EXPLAIN QUERY PLAN` + SlowQuery logs — **approved**.
3. Keep the legacy `GROUP BY` path behind a flag for one release post-cutover —
   **approved**.

## Sequencing

1. Foundation — schema, v64 migration, `thread-rollup.ts` + tests. **Done.**
2. Trigger dirty-queue + `ReadModelMaintainer` (upkeep + backfill), v65. **Done.**
3. Section read cutover behind `SARVINBOX_READMODEL_READS` + parity tests. **Done.**

## Remaining

- ~~**Flip the read flag on by default.**~~ **Done** — reads use `thread_folders`
  by default once `status='complete'`. Kill-switch: `SARVINBOX_READMODEL_READS=0`
  forces the legacy `GROUP BY` path (instant rollback, no redeploy). Verified on a
  ~25k-mail DB: legacy `getSectionByThreads` slow-queries went 312 → 0, no slow
  fast-path queries.
- **All-Mail (folder-less) fast path.** The cutover covers folder-scoped views
  (INBOX sections — the beachball). `selectedVirtualFolder = virtual-all`
  (folderPath undefined) still falls back to legacy; needs a folder-less scan
  over `thread_folders` (or a dedup across folder rows).
- **Cross-account k-way merge** for the unified "All Inboxes" view — per-account
  fast query, merge top-50 in the main process (scatter-gather).
- **Keyset pagination.** The cutover kept OFFSET (indexed now, so the beachball is
  gone); switching the folder + section pagers to `(last_message_date, thread_id)`
  keyset — and the flat folder list (Path A) too — removes the residual O(offset).
  Requires threading a cursor through the store/Paginator.
- **Retire the legacy `GROUP BY` path** one release after the default flip.
- **`test:electron` script / CI note** so the DB-backed tests don't hit the
  native-module ABI wall (they need a Node-ABI `better-sqlite3`; locally it's
  Electron-ABI, so run vitest under Electron-as-Node).

## Testing note

The DB-backed tests need a Node-ABI `better-sqlite3`; locally it's built for
Electron (ABI 148) via `electron-rebuild`, so run vitest under Electron-as-Node.
In CI (`better-sqlite3` built for the CI Node) `pnpm --filter @sarvinbox/storage-node test`
runs directly.

## Kill-switch

Section reads use the read-model by default once `read_model_state.status =
'complete'`. To force the legacy `GROUP BY` path (instant rollback, no code
change) set the env var to `0` and relaunch — it must be on the launch command so
it reaches the main process, same as `SARV_LOG_LEVEL`:

```
SARVINBOX_READMODEL_READS=0 pnpm dev:desktop
```

Any other value (or unset) = default-on-when-ready. The var is read per query but
the process env is fixed at start, so changing it needs a relaunch.
