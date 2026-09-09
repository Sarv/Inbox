# Changelog

All notable changes to Sarv Inbox are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Gmail-style "Select" menu in the bulk-action bar — select threads by
  read / unread / starred / unstarred state.
- An in-app banner when an account's session expires, so a mailbox can no longer
  stop syncing silently. Previously the only signal was a native "Sign in again"
  notification, and the app was told about the failure only if that notification
  was clicked — so a toast suppressed by Focus mode, missed while the app was in
  the background, or absent entirely (Linux without a notification daemon) left
  mail quietly not arriving with nothing on screen. The banner names the affected
  accounts, offers "Sign in" and "Account settings", and clears itself the moment
  the account works again. It is also pulled on startup rather than only pushed,
  so a session that broke while the app was closed still surfaces.
- `NOTICE`, [`TRADEMARKS.md`](./TRADEMARKS.md),
  [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md) and
  [`docs/LICENSING-FAQ.md`](./docs/LICENSING-FAQ.md).

### Changed
- The conversation ("chat") view is now rendered by the published
  [`@sarv-in/email-chat-view`](https://www.npmjs.com/package/@sarv-in/email-chat-view) package
  instead of a bundled component. The in-app `ChatView` and the ~1,000-line
  conversation heuristic behind it are replaced by a small adapter that maps
  stored messages onto the package's API, and the AI thread summary no longer
  falls back to the chat renderer — thread splitting and quote detection now
  come from one place.
- **Licence: MIT → [Sarv Community License, Version 1.0](./LICENSE).** Sarv Inbox
  is now source-available (fair-code), not OSI open source. Using, modifying and
  self-hosting it — including commercially, at any scale — stays free and needs
  no permission. Selling it, offering it to third parties as a hosted or
  white-label service, bundling it into a product you supply, and removing or
  replacing the Sarv branding now require written consent. Redistribution must
  be free of charge, keep the branding, and publish the source of any
  modifications. Commercial, OEM and hosting licences: licensing@sarv.com.
  See [docs/LICENSING-FAQ.md](./docs/LICENSING-FAQ.md).
- Contributions are now accepted under the Sarv Community License, and
  contributors additionally grant Sarv Webs Private Limited the right to
  relicense their contribution (see [CONTRIBUTING.md](./CONTRIBUTING.md)).
- Copyright holder recorded as the legal entity, Sarv Webs Private Limited.
- Test fixtures, sample data and the demo seed use synthetic identities and
  example domains (`example.com`, `partner.example`, patterned phone numbers).

### Fixed
- Mail now appears while the first sync is still running, instead of only when
  the whole of it finishes. The view was refreshed at one point — after INBOX,
  Sent and Starred had each been pulled to their per-folder cap — so a
  newly-configured account (or one whose cache is being rebuilt) showed an empty
  list for minutes, next to a sidebar already counting the mail sitting in the
  database. Each batch is committed before the sync reports its progress, so the
  list is now refreshed as those batches land: the first messages are on screen
  within seconds and the rest fill in behind them. Refreshes are throttled to
  one every 1.5 seconds and skipped entirely when a pass stored nothing, so a
  25,000-message first sync fills progressively rather than re-querying the list
  hundreds of times; and it is the folder ON SCREEN that is refreshed, not
  whichever folder the parallel sync happens to be working on.
- A folder view could stop updating during a sync that was creating folders. The
  check for "is this the folder the user is looking at" resolved the arriving
  folder by path out of the renderer's cached folder list, which during a first
  sync predates half the folders being created — so the lookup found nothing,
  the refresh was dropped, and the list sat empty until a manual refresh. It now
  resolves the SELECTED folder by id, which is always present, and compares its
  path.
- A mailbox database can no longer be deleted because the app failed to open its
  account registry. The startup sweep that removes database files belonging to
  removed accounts asked the registry which accounts still exist, and that read
  returned an empty list both when there genuinely were no accounts and when the
  read itself had failed — the same answer for opposite facts. So a boot in which
  the native SQLite module could not load at all (a mismatched ABI after a
  developer test run) looked exactly like a fresh install, and every account's
  cached mail was swept away. Anything that deletes now reads the registry
  through a call that fails loudly instead of answering "empty", both sweeps skip
  and log rather than guess when that read fails, and the sweep itself treats an
  empty keep-set as non-authoritative and keeps every account database. Locally
  cached mail re-syncs from the server, but a large mailbox costs hours to
  rebuild.
- The better-sqlite3 native module is rebuilt for the right runtime
  automatically: the dev scripts ensure Electron's ABI before launching the app
  and the test scripts ensure Node's before running the suite. Running the tests
  no longer leaves the app unable to open any database (which is what triggered
  the deletion above), and the two can be alternated in any order. The rebuild is
  skipped when the module already reports the target ABI, so the guard is free.
- An account no longer opens two IMAP connections at once on startup. Every
  path that reconnects — first mount, window focus, the network coming back,
  the reconnect ladder — called connect independently, so a cold start could run
  two attempts for the same mailbox at the same time; they then fought, one
  tearing down the socket the other was still opening, and everything the
  connect path writes (the credential vault, the saved account, the first sync)
  happened twice. Concurrent attempts for one account are now joined into a
  single connection, while different accounts still connect in parallel. The
  window-focus check reached the same outcome by another route: before deciding
  whether to reconnect it asks the current connection to answer, and a connect
  still shaking hands cannot answer — so on every cold start it read the
  starting connection as a dead socket, tore it down mid-handshake, reported a
  failed sign-in the user could see, and spent another connection against the
  server's cap to replace one that was about to work. A connect in progress is
  now recognised as its own state and waited for rather than replaced.
- Large emails download their bodies again. A body fetch had a flat 30-second
  budget, but its duration depends on the size of the message being downloaded —
  so any mail too big to transfer in 30 seconds could never be fetched at all.
  Each retry restarted the download from the beginning and failed at exactly the
  same point, five times, before the message was retired as un-fetchable, and
  every attempt abandoned a transfer that was still in flight and cost a
  discarded IMAP connection. The budget now measures a stall rather than the
  clock: a connection that has gone silent still fails in 30 seconds, while a
  transfer that keeps delivering data is allowed to finish, and a download
  running longer than the pool's stuck-connection limit is no longer evicted
  mid-transfer. The IMAP client applied a second flat budget of its own — one
  minute for any command, whatever it was doing — which killed the download and
  discarded the connection before the new rule could ever apply; the command
  that streams a message body is now judged on stalls too, while every other
  command keeps the flat budget that spots a dead socket quickly.
- An OAuth sign-in you abandon no longer strands the button on "Opening…".
  Closing the provider's browser tab is invisible to the app — the flow simply
  never answers — so a button that disabled itself until it did sat there for
  the full five-minute timeout with no way back. The sign-in buttons now stay
  clickable and a "Cancel" appears beside them, which releases the loopback
  port without waiting for the abandoned flow. A late result from a superseded
  attempt can no longer clear a newer one's spinner.
- Settings → Accounts now shows "Sign-in required" on an account whose session
  has expired, in the list and in the account's details, with a "Sign in again"
  button. It previously read "Connected" — a dead refresh token does not close
  the connection — so dismissing the expiry banner left the user with no way to
  find out which account had stopped working. The list and the banner now read
  the same state, so they cannot disagree.
- A revoked or expired OAuth session no longer triggers a reconnect storm. Every
  reconnect path — startup, window focus, account switch, background sync and
  the IMAP ladder — retried independently, and each retry POSTed the same dead
  refresh token; a single revoked account produced 140–230 log lines a minute
  for as long as it stayed broken, and replaying a spent token is exactly what
  keeps a rotating provider's reuse detector holding the session revoked. Once
  an account is known to need signing in, the token request now fails locally
  without reaching the network, and the reconnect ladder stops instead of
  dialling forever. A refresh interrupted by sleep, a network blip or a timeout
  is still treated as transient — a closing laptop lid must never demand a new
  sign-in. Connect failures for a revoked session are also logged as one line
  rather than an error with a stack per attempt.
- The renderer no longer imports the `@sarvinbox/core` barrel for the folder
  classifier, which crashed the dev app with "Dynamic require of 'stream' is not
  supported"; it deep-imports the pure module instead.
- Bulk selection now operates on the exact threads currently rendered, so
  "Select unread" (and friends) can no longer tick threads shown as read when
  DB-backed sections are active.
- The "Draft" thread badge no longer counts sent copies or trashed drafts that
  retain a stale `|draft|` tag — a message must live in a Drafts folder.
- Chat bubbles keep the AM/PM marker on a quoted-reply attribution whose time
  is not followed by a comma, instead of dropping it and showing a bare
  12-hour time.
- The per-message star is back on chat bubbles, so a single message in a thread
  can be starred from the conversation view again.
- The chat view honours the reader's remote-image preference. Remote images in
  a conversation are no longer loaded unconditionally — they follow the same
  auto-load rule as the standard reading view, which is now a single shared
  helper rather than two copies that could disagree.
- A token refresh interrupted by sleep no longer signs the account out. The
  request now carries a real `AbortSignal`, so its timeout cancels the HTTP call
  instead of leaving it running unattended — against a provider that rotates
  refresh tokens, an orphaned request could be processed server-side while its
  reply was lost, after which the next refresh replayed a spent token and the
  provider revoked the whole session as suspected theft.
- Refreshes are deferred while the machine is suspended, rather than fired into a
  sleeping network. Pending refreshes are cancelled on suspend, and on wake the
  app waits for the link to actually come back before the first request. A
  deferred refresh is re-checked shortly afterwards and never counts as a
  failure, so a night of sleep can no longer exhaust the retry budget and leave
  the account showing as disconnected in the morning.

## [1.1.0] - 2026-07-09

### Added
- Section-based inbox (default / important-first / unread-first / priority-first)
  with customizable filters and per-section pagination.
- AI conversation view — chat-style reading mode for long quote chains.
- AI features behind a configurable provider: categorization, semantic search,
  signature detection, draft assistance, and thread summaries.
- Full email actions: read/unread, star, important, archive, delete (with undo),
  spam, snooze, and compose / reply / forward (inline + modal).
- Snooze with wake-up, optimistic UI with revert-on-failure, and
  disconnected-account recovery in Settings.

### Changed
- Rebranded from EmailGPT to **Sarv Inbox** (text and assets).
- OAuth client secrets moved out of source into environment variables
  (`.env` / `.env.example`).

### Security
- TLS verification is **on by default**; insecure TLS is opt-in via
  `allowInsecureTLS`.
- `openExternal` restricted to an allowlist of URL schemes.

[1.1.0]: https://github.com/Sarv/Inbox/releases/tag/v1.1.0
