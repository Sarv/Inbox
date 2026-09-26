# Testing

The suite exists for one reason: **a new feature must not silently break a
working one.** Sync, sending and storage bugs are expensive here — mail that
vanishes, duplicates, or loses a flag is not something a user forgives — and
neither `tsc` nor eslint can catch a behavioural regression. So every push and
pull request runs every suite (see `.github/workflows/ci.yml`, job
"Unit & integration tests").

## Running

```bash
pnpm test                 # every suite, all packages (turbo)
pnpm test:coverage        # same, with a coverage report per package
pnpm test:watch           # watch mode while you work

pnpm --filter @sarvinbox/core test          # one package
npx vitest run packages/core/test/unit/imap # one directory
npx vitest run -t 'UIDVALIDITY'             # one test by name
```

### The one gotcha: better-sqlite3's ABI

`better-sqlite3` is a compiled addon, valid for exactly **one** ABI at a time,
and this repo needs two:

| What | ABI it needs |
|---|---|
| the desktop app (Electron) | Electron's |
| the test suites (plain Node) | Node's |

**You should never have to flip it yourself.** Every `test*` script in the
packages that open a database starts with `node scripts/native-abi.mjs node`, and
`dev` / `electron:dev` (and `sh scripts/dev.sh`) start with the `electron`
counterpart. The script probes the ABI the built binary actually reports and
returns immediately when it already matches, so the guard costs nothing on a
run that is already on the right side, and `pnpm test` and `pnpm dev:desktop`
can be alternated freely.

That automation exists because the manual flip was dangerous, not merely
annoying. Leaving the addon on Node's ABI means the *app* can no longer open any
database — and since every core-DB read is wrapped in a `try/catch` that returns
an empty result, that boots as an app with no accounts rather than as an error.
On 2026-09-09 it made the startup orphan-DB sweep read the unreadable account
registry as "no accounts exist" and delete both live mailbox DBs. So: don't run
`node scripts/native-abi.mjs node` or `pnpm test:node-abi` on their own to
"unblock" a test run — run the tests, which do it for you and leave the tree
consistent either way.

`pnpm install` runs `scripts/postinstall.mjs`, which builds it for **Electron**,
so a fresh install is ready for the app and the first `pnpm test` after it pays
one rebuild. `scripts/native-abi.mjs` prints which ABI the binary currently
reports before it rebuilds, so you can check without waiting for a compile;
`--force` rebuilds regardless. CI sidesteps the flip entirely by installing with
`SARVINBOX_SKIP_ELECTRON_REBUILD=1`, which leaves the addon on Node's ABI and
makes the test-time guard a no-op probe.

The runtime is a required argument, `node` or `electron`. Anything else the
script cannot read (an unknown flag, no runtime, two runtimes) is refused with
its usage text and exit code 1 before it even probes the addon, and `--help`
(`-h`) prints that text and exits 0. It used to default to `node` and skip
flags it did not know, so `node scripts/native-abi.mjs --help` rebuilt the addon
for Node. On 2026-09-24 that command, piped into `head`, was killed after
node-gyp had deleted `build/`, and left no addon at all. The parsing lives in
`scripts/lib/native-abi-args.mjs`, tested by
`packages/storage-node/test/unit/native-abi-args.test.ts`.

Tests that open a database go through `src/test-support/test-db.ts`, which fails
with a message naming this exact fix rather than trying to carry on. It used to
fall back to Node's built-in `node:sqlite` behind a better-sqlite3 facade so the
suite could still run — but that quietly swapped the driver under test, and the
two disagree: `node:sqlite` rejects a bound parameter the statement does not
declare, where better-sqlite3 ignores it. A fresh `pnpm install` therefore turned
passing tests into `Unknown named parameter 'attachmentSizes'`, an error that
names a column and points at a repository that was never broken. The fallback is
gone; the ABI is now always named.

Two rebuilds must never run in the same directory at once: `node-gyp rebuild`
starts by deleting `build/`, so a second run removes what the first is compiling
into and both die on an ENOENT for a path that should exist
(`build/Release/.deps/…/sqlite3.o.d.raw`, `build/node_gyp_bins`). A pid lock
(`node_modules/better-sqlite3/.native-abi.lock`) prevents that — if the script
says *another rebuild is already running*, wait for it or kill that process; a
lock left by an interrupted run is taken over automatically. Every rebuild then
loads the finished binary in a child process and checks the ABI it reports, so a
build that "succeeded" against a stale `build/config.gypi` (the other runtime's
settings) is reported as the failure it is rather than silently shipped.

## Layout

Tests live in a dedicated `test/` folder per package (NOT co-located with
source), split by kind and mirroring the source tree:

- `test/unit/<path-under-src>/x.test.ts` — unit tests.
- `test/integration/<path-under-src>/x.integration.test.ts` — integration tests
  (filename keeps the `integration` marker).
- In `apps/desktop`, the mirror keeps both source roots: `test/unit/src/**`
  (renderer) and `test/unit/electron/**` (main-process helpers).

Run them with `pnpm test` (all), `pnpm test:unit`, or `pnpm test:integration` in
any package. A file is classified integration purely by its name containing
`integration`.

## Layers

**Unit** — pure functions under `test/unit/`. Tag encoding, filter matching,
address parsing, PKCE/XOAUTH2, error classifiers, TLS option resolution,
scheduling maths. Fast, no I/O.

**Integration (sync)** — the real `MessageProcessor` / `FolderSyncer` /
`SyncEngine` driven against `packages/core/src/test-support/fake-imap-server.ts`,
an in-memory IMAP server that satisfies `IIMAPClient`. Use it instead of writing
another `vi.fn()` client:

```ts
const server = new FakeImapServer({ condstore: true, qresync: true });
server.addFolder('INBOX');
const uid = server.addMessage('INBOX', { subject: 'hi', flags: ['\\Seen'] });
server.setFlagsOnServer('INBOX', uid, []);   // another client marked it unread
server.expungeOnServer('INBOX', uid);        // …then deleted it
server.bumpUidValidity('INBOX');             // …then the UID space was lost
expect(server.callCount('fetchAllFlags')).toBe(1);  // assert no redundant fetch
```

It models per-folder UID spaces, UIDVALIDITY, MODSEQ/CONDSTORE, QRESYNC
`VANISHED`, flags, `\Deleted` + expunge, and move/copy returning the server's
UID map. It deliberately does **not** model the wire protocol — that's imapflow's
job, and we don't re-test a dependency.

**Integration (storage)** — repositories against a **real** SQLite database
(in-memory or a temp file), asserting the rows that result. Mocking the DB here
would defeat the purpose: this is the layer where a wrong SQL predicate loses
mail. See `packages/storage-node/test/unit/thread-resolver.test.ts` for the pattern.

## House rules

- **Name the regression.** Every test (or block) carries a short comment saying
  what breaks if it fails. A test whose purpose isn't obvious gets deleted by
  someone later.
- **Assert observable outcomes**, not call sequences — except where "no redundant
  round trip" *is* the contract (then `callCount` is the assertion).
- **Deterministic.** No wall clock, no randomness, no network, no sleeping:
  `vi.useFakeTimers()` / `vi.setSystemTime()`, and inject dates. Filesystem use
  goes under `os.tmpdir()` and is cleaned up.
- **No production code in a test's service.** If something can only be tested by
  changing the source, change the source deliberately in its own commit — don't
  bend the test around it.
- **A failing test is a finding, not an obstacle.** If behaviour looks wrong,
  raise it; don't assert the bug into permanence.

## What isn't covered, deliberately

- **React component rendering.** There's no testing-library/React setup, so
  nothing mounts a component. Component *logic* is tested by extracting it into
  pure helpers; the visual layer is verified by running the app.

  DOM **APIs** are available though — `happy-dom` is installed, and a test opts
  in per file with a pragma on line 1 (see `packages/core/test/unit/utils/signatures.test.ts`,
  `apps/desktop/test/unit/src/components/email-detail/chat-message-adapter.test.ts`):

  ```ts
  // @vitest-environment happy-dom
  ```

  Use it for code that genuinely parses HTML (`DOMParser`, sanitisation,
  quoted-content detection); keep everything else in the default `node`
  environment, which is faster.

- **Zustand store internals.** The highest-value renderer logic — optimistic
  update/rollback, selection maths, the "of N" derivation — lives in
  module-private functions inside `src/store/slices/*.ts`, so it can only be
  reached by exporting it or by standing up the whole store behind an
  `electronAPI` fake. Exporting those helpers is the cheapest way to make them
  testable, and is the biggest remaining coverage gap on the renderer side.
- **Real IMAP/SMTP servers.** No test opens a socket. Server behaviour we depend
  on is modelled in the fake; anything beyond that is verified manually against
  a real account.
- **Electron runtime APIs.** Main-process services are tested with `electron`
  mocked at the module level (`vi.mock('electron', …)`). Code that genuinely
  needs a live Electron runtime (window management, `safeStorage` against a real
  keychain) is out of scope here.
