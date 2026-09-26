# Project Conventions

## Tests are part of the change, not a follow-up

Every new feature and every fix ships with tests, in the SAME change. This is a
mail client: a regression doesn't look like a crash, it looks like mail that
quietly stops arriving, a body that never downloads, a flag that flips back, or a
count that disagrees with the list. Nobody notices for days. The suite is the
only thing that does.

**Required for any behavioural change:**

1. **Write the tests with the code.** Aim for 100% of the lines and branches you
   added or touched; ≥90% is the floor. Coverage of the *new* code, not the repo
   average — `pnpm test:coverage` reports per file.
2. **Name the regression.** Each test (or block) carries a one-line comment
   saying what breaks if it fails. A test whose purpose isn't stated gets deleted
   by someone later, and with it the protection.
3. **Cover the failure paths, not just the happy one.** For anything touching
   IMAP/SMTP/storage that means: a transient error (connection blip, timeout,
   rate limit) vs a permanent one, a partial/interrupted run, an idempotent
   re-run, and the multi-account case. Most real bugs here were a transient
   condition treated as permanent, or a retry that double-applied.
4. **Run the WHOLE suite before you call it done** — `pnpm test`, not just your
   own file. The point is proving the change didn't break something already
   working. A green new test next to a red old one is a failed change.
5. **A pre-existing test that now fails is a decision, never an obstacle.**
   Either the behaviour genuinely changed (update the test AND say so, in the
   commit message) or you broke something (fix the code). Never delete, skip or
   loosen a test to get to green.
6. **Don't assert a bug into permanence.** If current behaviour looks wrong,
   raise it instead of pinning it. When you must record a known gap, say so
   explicitly in the test name and comment so the next person can tell a
   deliberate limitation from an accident.

Test layers, the shared IMAP/storage fakes, and the better-sqlite3 ABI split
(handled for you — see below) are documented in
[docs/TESTING.md](docs/TESTING.md). CI
runs every suite on every push and pull request — keep it green.

## Logging: ALWAYS use the shared logger, NEVER raw `console.*`

Never write `console.log` / `console.warn` / `console.error` in product code. Use
the shared logger so every line is structured (`[timestamp] [LEVEL] [name]`) and
lands in `app.log` consistently:

- Import it: `import { logger } from '@sarvinbox/core'` (or `createLogger('Name')`
  for a component-scoped logger). Re-exported from the core barrel.
- `logger.info` / `logger.warn` / `logger.error` / `logger.debug`.
- **HOT-PATH / per-item logs** (per-email, per-query, per-IDLE-event): `logger.debug`
  is NOT level-gated — it always writes, and each write is a synchronous
  main-thread cost. So gate them behind an env flag AND use the logger:
  `if (DEBUG_X) logger.debug(...)`. A per-item log that fires thousands of times
  on a large/first sync will stall the event loop — this is a real perf bug, not
  just noise. Prefer aggregated summaries (see the IDLE-event aggregation in
  `sync-handlers.ts`) over per-item lines.
- Raw `console.*` reaches `app.log` via the dev tee but UNSTRUCTURED — don't rely
  on it. Migrate any `console.*` you touch to the logger.

## Native modules: better-sqlite3 has TWO ABIs — never flip it by hand

`better-sqlite3` is a compiled addon and is valid for exactly ONE ABI at a time.
The desktop app runs inside **Electron** (its own `NODE_MODULE_VERSION`, e.g. 149
for Electron 44); the test suites run in **plain Node** (e.g. 137 for Node 24).
Whichever it was last built for, the other one fails to load:

```
was compiled against a different Node.js version using
NODE_MODULE_VERSION 137. This version of Node.js requires NODE_MODULE_VERSION 149.
```

**The flip is automatic — don't do it manually.** Every test script rebuilds for
Node first and the dev scripts rebuild for Electron first (`node
scripts/native-abi.mjs <node|electron>`, a no-op when the addon already reports
the target ABI). So `pnpm test` and `pnpm dev:desktop` can be run in any order,
as often as you like. `sh scripts/dev.sh` does the same.

Do NOT run `node scripts/native-abi.mjs node` (or `pnpm test:node-abi`) on its
own to "fix" a test run, and never leave the tree on the Node ABI: the next
launch of the app is then a boot with no database at all. **That is not a
cosmetic failure — it has destroyed data.** Every core-DB read is wrapped in a
`try/catch` that returns an empty result, so a broken addon does not look like an
error to the code that consumes it; it looks like an app with no accounts, no
folders and no mail. On 2026-09-09 that made the startup orphan-DB sweep read an
unreadable account registry as "zero accounts exist" and delete both live
mailbox DBs.

The lesson generalises beyond this module: **an unreadable store and an empty
store are the same value and opposite facts.** Any code path that DELETES must
source its keep-set from a read that can fail loudly (`readRegistryAccounts`,
not the swallowing `listRegistryAccounts`) and must do nothing when it does.

See [docs/TESTING.md](docs/TESTING.md) for the rebuild lock and the ABI probe.

## Releases: push a tag — GitHub builds and publishes, never you

A release IS a pushed git tag. Nothing is built, signed, uploaded or published
from a local machine, ever.

- **Cut one with `pnpm release:patch`** (or `minor` / `major`, or an explicit
  version). `scripts/release.sh` bumps `package.json` and
  `apps/desktop/package.json` in lockstep, moves whatever stands under
  `## [Unreleased]` in CHANGELOG.md into the new version section, commits
  `chore(release): X`, tags `vX`, and pushes the branch and the tag.
- **The tag is the trigger.** `.github/workflows/release.yml` fires on `v*` and
  builds macOS, Linux and Windows each on their own runner, then publishes a
  DRAFT GitHub release carrying every artifact. Review the draft on the
  releases page and publish it when it looks right.
- **Never run electron-builder, or upload/publish a release, by hand.** The app
  has two compiled native addons (better-sqlite3, lzma-native) and a native
  addon can only be built ON the platform it runs on, so a local cross-build
  ships a darwin `.node` inside the Windows and Linux artifacts and they crash
  on launch. That is not hypothetical: this script used to run
  `electron-builder --win` and `--linux` on macOS, both lines ending in
  `|| echo`, so the broken artifacts shipped and the failure was invisible.
- **Write the user-facing notes under `## [Unreleased]` BEFORE cutting.** A
  non-empty `[Unreleased]` becomes the release body verbatim and the
  commit-derived bullets are discarded — they are only printed for
  cross-checking. Anything missing there is missing from the release, and the
  changelog is the only place a user finds out what changed.
- `NO_PUSH=1` commits and tags locally without pushing; `--pr` routes the bump
  through a pull request when branch protection forbids a direct push. See
  [docs/RELEASING.md](docs/RELEASING.md).

## Debugging: there IS a log file — read it, don't ask

When the user reports a problem ("X is not working", "why is it doing Y",
"something strange"), **read the app log yourself FIRST** instead of asking them
to paste logs or assuming logs only go to the terminal. In dev, console output
is tee'd to a rolling `app.log` file (see `main.ts` — "Tee console output to a
rolling app.log file when running locally").

- **Dev log file:** `~/Library/Application Support/Sarv Inbox Dev/app.log`
  (userData dir is `Sarv Inbox Dev` in dev — distinct from the release `Sarv Inbox`).
- The same userData dir holds the account DBs (`sarvinbox-<hash>.db`,
  `oauth-accounts.json`, `imap-account.json`, `db-key.bin`) — check these to tell
  **data-loss from a UI/init state** (e.g. the onboarding screen appears when the
  main process hasn't initialised storage yet, NOT because accounts were deleted).
- It can be large (tens of MB) — use `tail` / `grep` / `awk` with time-window
  filters, never read the whole file.
- Editing main-process files while `pnpm dev:desktop` is running RESTARTS the main
  process (vite-plugin-electron) under the open renderer window; a brief
  "Storage not initialized" burst + onboarding screen during that restart is
  expected, not a reset.

## Cross-platform: macOS, Windows AND Linux (always assume all three)

This is an Electron desktop app that ships on **macOS, Windows, and Linux**.
Every change — especially in the main process, filesystem, and OS-integration
code — must work on all three. Never hardcode a macOS-only assumption.

- **Paths**: always build paths with `path.join()` / `path.resolve()`, never
  string-concatenate with `/` or `\`. Anchor user data at `app.getPath('userData')`
  (and friends), never a hardcoded `~/Library/...` or `/tmp`.
- **`safeStorage` availability differs by OS.** macOS (Keychain) and Windows
  (DPAPI) essentially always support encryption; **Linux depends on an available
  keyring/Secret Service (libsecret) and is often UNAVAILABLE** (headless, no
  gnome-keyring/kwallet). Never assume `safeStorage.isEncryptionAvailable()` is
  true — branch on it, fall back safely (clearly-marked plaintext, never silent
  data loss), and surface the reduced-security state to the user. This governs
  the credential vault (`secure-credential-store.ts`) and the future DB key.
- **File modes / permissions**: `fs.writeFile(..., { mode: 0o600 })` is honored
  on macOS/Linux but is effectively a no-op on Windows (NTFS uses ACLs). Set it
  anyway (harmless), but do NOT rely on POSIX modes as the security boundary on
  Windows.
- **Filesystem case-sensitivity**: Linux is case-sensitive; macOS/Windows are
  usually case-insensitive. Keep import paths and filenames exact.
- **No shell-specific commands** in runtime code; prefer Node/Electron APIs
  (`shell.openExternal`, `shell.openPath`) over spawning platform shells.
- **Line endings**: write `\n`; don't depend on `\r\n`.
- When adding OS-integration code, mentally test the Linux-no-keyring and
  Windows paths, not just macOS.

## Reuse over duplication (thumb rule — applies to everything you touch)

Never duplicate logic. Whenever you touch code, actively look for existing
duplication and repeated patterns:

- If the same logic already exists elsewhere, import and reuse it — do not copy it.
- If you find yourself writing (or seeing) the same pattern in two or more
  places, extract it into a shared helper and use it everywhere it applies.
- Put shared, framework-agnostic helpers in `packages/core/src/utils/` and
  export them via the `utils` barrel so both core and the Electron main process
  can import them from `@sarvinbox/core`.
- When you fix or refactor a function, sweep the immediate area for sibling
  copies of the same pattern and fold them into the shared helper too.

Prefer small, pure, single-responsibility helpers that are easy to unit test.

Established shared helpers (extend this list as you add more):
- `withTimeout(promise, ms, message)` — `packages/core/src/utils/timeout.ts`.
  The single source for the "race a promise against a timeout" pattern; it also
  clears the timer. Use it instead of hand-rolling `Promise.race([p, setTimeout(reject)])`.

## Prefer a mature library over hand-rolled / regex logic

For any solved, standardized problem — parsing, dates, MIME, email addresses,
sanitization, validation, path/URL handling, normalization, etc. — reach for a
well-maintained third-party library FIRST. Hand-written parsers, manual string
munging, and especially bespoke regex are the LAST resort, used only when nothing
suitable exists in the market (or the only options are unmaintained/abandoned).
Regex in particular is error-prone on real-world input and a common source of
correctness and ReDoS bugs — don't reinvent what a battle-tested package already
handles, including its edge cases.

Before adding a dependency, vet its health: actively maintained (recent
commits/releases, not archived), healthy downloads/stars, stable or rising
trend, and a primary purpose that matches the job. Prefer libraries already in
the stack / same ecosystem for consistency. Keep custom code only for
product-specific logic no library fits — and if you must hand-roll (e.g. a small
security primitive), keep it small, pure, unit-tested, and documented as to why
no library was used.

## UI conventions

- **Every icon-only control must have a tooltip.** Any interactive element whose
  only visible label is an icon (icon buttons, toggles like show/hide password,
  affordances on hover) must show a tooltip naming what it does. Use the shared
  `Tooltip` component (`apps/desktop/src/components/Tooltip.tsx`) — NOT the
  native `title` attribute, which has a slow (~500ms) fixed delay. Keep the
  tooltip delay short (`delayMs={40}`) so it feels instant. Still set
  `aria-label` on the button for accessibility.

## IMAP

- ImapFlow is the only IMAP client (`imapflow-client.ts`); node-imap has been
  removed. Construct via `new ImapFlowClient()`.
- Pooled/worker connections and the primary connection go through the same
  `IIMAPClient` interface; keep new client behavior behind that interface.
