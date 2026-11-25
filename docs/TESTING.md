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

### The extension sandbox: `pnpm --filter @sarvinbox/desktop test:sandbox-escape`

Whether extension code can read a file or reach the network is decided by Chromium,
so the unit tests can only pin the settings. This one runs hostile extension code
against the real transport in real Electron, from a real `app.asar`, with real
listeners on HTTP, WebSocket and UDP, and fails if anything gets out
(`apps/desktop/test/sandbox-escape`). It is not part of `pnpm test`: CI runs it on
macOS, Windows and Linux. Run it yourself when you touch `extension-runtime.ts` or
upgrade Electron, and add to `fixtures/probe` when a new way out turns up. Never
start it beside your own dev app without `SANDBOX_ESCAPE_ELECTRON`: see the note in
`run.mjs`.

It runs extension code under the app's own V8 flags (`electron/v8-flags.ts`), so its
out-of-memory probe stops at the 2 GB heap cap that ships. Without them the probe
filled about 3.7 GB. On a 7 GB macOS CI runner that left the machine swapping, and
the next sandbox start overran its 15 s load timeout about one run in six. After
that crash the harness waits for the app's own restart, retries included, rather
than racing a reload against it.

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
with a message naming the fix for the runtime it is in rather than trying to
carry on. It used to
fall back to Node's built-in `node:sqlite` behind a better-sqlite3 facade so the
suite could still run — but that quietly swapped the driver under test, and the
two disagree: `node:sqlite` rejects a bound parameter the statement does not
declare, where better-sqlite3 ignores it. A fresh `pnpm install` therefore turned
passing tests into `Unknown named parameter 'attachmentSizes'`, an error that
names a column and points at a repository that was never broken. The fallback is
gone; the ABI is now always named.

Under plain Node, the fix it names is the package's own test script: `pnpm test`,
or `pnpm test <file>` in the package directory. Inside Electron, it is
`node scripts/native-abi.mjs electron`. Running the tests inside Electron is how
to test while the dev app holds the Electron ABI, from the package directory:
`ELECTRON_RUN_AS_NODE=1 ../../node_modules/.bin/electron ../../node_modules/vitest/vitest.mjs run`.
The message used to tell everyone to run `pnpm test:node-abi`: the manual flip
this section warns against, and backwards for a run inside Electron.

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

**Inbox Agent, end to end** — `apps/desktop/test/helpers/assistant-harness.ts`
runs the real agent for a test that asks it a question: the service, planner,
retrieval over real account databases, verifier, the chat history store on a
real SQLite table, and the production provider call path (so usage accounting
and error classification are the real ones). Only the network (a scripted
endpoint) and attachment reading are replaced. Use it instead of hand-wiring
`InboxAssistantServiceDeps` when the subject is what a question does:

```ts
const harness = await createAssistantHarness({ ai: (prompt, purpose) => purpose === 'plan' ? PLAN : NO_FACTS });
await harness.mail('primary', 'thread-1', { id: 'm1', sent: true, subject: 'Acme quotation', cleanBody: QUOTE, rawBody: `<p>${QUOTE}</p>` });
const exchange = await harness.ask('What did we quote Acme?');
harness.chat().exchanges.at(-1)!.diagnostics;  // read back from the store
harness.calls;        // every model call, with its step
harness.logs;         // every log line, for "nothing private was logged" checks
harness.readChanges;  // every mark-as-read the agent made
```

## Inbox Agent evaluation

Unit tests prove the agent's plumbing with hand-written model replies. They do
not show whether a question finds the right email. `apps/desktop/test/eval/assistant/`
does, and it runs in CI with the rest of the suite (`pnpm test`), in about two
seconds. To run it alone: `pnpm --filter @sarvinbox/desktop eval:assistant`.

| File | What it is |
| --- | --- |
| `mailbox.ts` | The seeded two-account mailbox. Synthetic, `.example` domains only. Written to look like real mail (signatures, quoted chains, long documents, Hinglish), because retrieval measured on tidy mail overstates how well it works. |
| `cases.ts` | The requests, each with the kind of request it is (`route`) and, for a question about mail, the exact words that must reach the model. A case states what a user expects, not what the code does today. |
| `agent-tasks.ts` | Every request that is not a question about mail (review my unread mail, mark these read, archive, count, "what can you do"): the tool calls a competent model makes, and what must then be true of the mailbox and the cards. |
| `known-gaps.ts` | The cases known to fail today, each with what was observed and the audit issue that covers it. |
| `assistant-eval.test.ts` | Runs every case through the real agent with a scripted model. A question is scored twice: `floor` (the model passes the question to `deep_search` as typed and the planner is refused, so host keyword rules plan the search) and `ceiling` (the planner returns the case's hand-written plan; a follow-up is made self-contained). It passes when the answering words reached the model in a tool result AND the answer quoting them was kept as a verified fact citing the right email. A task runs at the ceiling only: choosing tools is the model's job. A case that fails at the ceiling cannot be fixed by a better model. |
| `review-safety.test.ts` | "Approve for me" with a model that wants every unread email marked read, and checks which mail labelled `keep` the host's own protections keep unread. It may never protect less than the retired unread review did (`RETIRED_REVIEW_TRIAGE_GAPS`). |
| `recordings.test.ts` | Replays agent runs recorded from real providers: their own turns drive the current host. |

**The gate is per case, not a total.** Each case is its own test, named after
the question. A case not in `known-gaps.ts` must pass. A case in it must still
fail: when a fix makes it pass, the run fails with a message telling you to
delete the entry, which is how the fix becomes protected. Never add an entry to
get a change through without saying so in the commit message: it is a decision
to ship a regression. The printed totals (`floor 41/51`) are for reading, not
for gating.

**Adding a case.** Add the mail to `mailbox.ts` if it needs any, then the case to
`cases.ts`: a question with the answer's exact words as `needle` (and a `plan`
for its ceiling run), or any other request with a task in `agent-tasks.ts`. Run
the evaluation. If it fails for a reason that is already a known problem, list
it in `known-gaps.ts` with what you observed.

### Asking a real model (opt-in, never in CI)

The deterministic run cannot show what a particular model actually does with
the tools. This asks every retrieval question of a real provider, through the
production agent loop, tools, planner and call path, against the seeded
mailbox only:

```bash
ASSISTANT_EVAL_MODEL=gpt-5-mini ASSISTANT_EVAL_API_KEY=... pnpm --filter @sarvinbox/desktop eval:assistant:live
```

| Variable | Meaning |
| --- | --- |
| `ASSISTANT_EVAL_MODEL` | The model id. The run is skipped unless this is set. |
| `ASSISTANT_EVAL_API_KEY` | The provider key. Leave unset for a local model. |
| `ASSISTANT_EVAL_BASE_URL` | An OpenAI-compatible base URL, for example `http://localhost:11434/v1`. Defaults to the provider's own. |
| `ASSISTANT_EVAL_TYPE` | `openai` (default, any OpenAI-compatible endpoint) or `gemini`. |
| `ASSISTANT_EVAL_RUNS` | Runs per question, 1 to 5. Use 3 for a local model, whose replies vary. |

It prints counts (plan accepted, deep_search used, JSON protocol needed, answer
reached the model, answer verified) and saves every model turn and planner
reply under `test/eval/assistant/recorded/<model>/`. Commit the recordings:
`recordings.test.ts` then replays them on every push, the model's own turns
driving the current host, so a change to a tool, its results or the grounding
check is measured against what real models really do. Turns are read from the
OpenAI-compatible wire format; a Gemini run is scored but not replayable. The
mailbox is synthetic, so a recording holds no real mail; the key and the
provider's error text are never saved. It costs what 25 short agent runs cost on
that provider (three to six calls each).

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
- **Nothing outlives its test file.** A timer that a component leaves pending
  fires after the file's DOM environment is torn down and throws "document is
  not defined", an unhandled error that fails the whole run though every
  assertion passed. A component's delayed DOM work goes through
  `useMountedTimeout` (`apps/desktop/src/hooks/`), and a test unmounts what it
  rendered in `afterEach`.
- **A cold import is not the first test's to pay.** The first `await import()`
  of a heavy module transforms its whole graph, which takes 3–5 s on a loaded CI
  runner with coverage on, inside that test's 5 s budget. `vi.resetModules()`
  does not undo the work, so warm the import once in `beforeAll` with an
  explicit timeout (see `extension-marketplace.test.ts`).

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
