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
- Category labels are no longer prefixed on Sarv accounts, and no longer create
  folders there. Sarv is our own product and its webmail already knows these
  labels, so a categorised message is simply flagged with the bare category name
  — `important`, `needs_response`, `invoices`. The `Sarv Inbox/…` folders an
  earlier version created on Sarv matched no flag, so they surfaced nothing and
  only cluttered the mailbox; they are now removed automatically, and only ever
  once the server confirms a folder holds no mail. Every other provider (Gmail,
  Outlook, …) is unchanged: there the label IS a mailbox and keeps its
  `Sarv Inbox/` prefix, which is what stops our labels from passing as the
  user's own folders.
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
- Every message list now carries the same bar at the top — what you are looking
  at on the left, the page range and prev/next on the right — so a plain folder
  such as Sent can be paged from the top, not only from the bottom of the list.
  Only the section, "All Inboxes" and category views used to have one, each a
  hand-rolled copy; there is now one header component behind all of them.
- Page sizes follow what a list is for, rather than one setting everywhere:
  "All Email" and "All Inboxes" page 100 at a time because a page there spans
  every folder and account; a section's full page and the lists you scan in bulk
  within one account — Sent, Drafts, Trash, Spam, Archive, Starred and Important
  — page 50; everything else follows your "emails per page" setting (25 by
  default).
  Every list, its loader and both of its page indicators now read that size from
  one place, so they cannot disagree with each other.
- Every message list now says how much mail is behind it — "1-50 of 5,000" — not
  just the range on screen. "All Email", Starred, Important, Snoozed and
  "All Inboxes" previously paged with no total at all, so there was no way to see
  whether a list held a hundred messages or a hundred thousand. Each now reads a
  count taken with the same rules as the list it heads, fetched once and reused
  while paging, and "next" stops offering a page once the last one is reached.
- Your contact directory is now one list shared by every connected account,
  instead of a separate copy per mailbox. Connect a second address and you no
  longer get a second, half-populated address book: a person you know from both
  accounts is one contact, with one set of notes, one enrichment history and one
  merged view of their phone numbers and links. The directory lives in its own
  `sarvinbox-contacts.db` alongside the mailbox databases, attached to each
  account as it opens, and is encrypted with the same key as your mail (an
  existing plaintext install is rekeyed in place the first time a key is
  available). Each account's existing contacts are merged into it once, on
  upgrade; the per-account tables are kept as `pre_directory_*` for this release
  so nothing is destroyed by the move, and a later release will drop them. Which
  account a contact first arrived from is recorded, but not shown anywhere yet.
  Per-account sender statistics stay per-account, since they describe how you
  use that mailbox.

### Fixed
- Mail that was never deleted could be deleted from the app. A folder's deletion
  reconcile asks the server for that folder's full list of message numbers and
  removes anything local that is missing from it — but the reply carries no
  mailbox name, and a connection that had been recycled mid-run could answer from
  a completely different folder. On 13 September a 917-message folder was
  reconciled against the Inbox's 24,662 message numbers and 410 live messages
  were removed from it. Every existing safety check was defeated by the same
  thing: they all ask whether the list is *complete*, and a list from a bigger
  mailbox looks more than complete. Two independent facts now have to line up
  before anything is deleted — the connection must prove it still has the
  expected folder open at every step of the enumeration, not just at the start,
  and the returned numbers must fit inside what the folder itself reports about
  its own size and numbering. Anything else aborts the pass and leaves the mail
  alone. Nothing was lost on the server, so the affected folder refills on its
  next sync.
- Missing mail in Trash is now re-downloaded, like it already was everywhere
  else. The background repair that spots messages the server holds and the app
  lacks skipped Trash and Spam, on the reasoning that neither is worth archiving
  for search. But a gap in Trash is mail you deleted and can still restore, it is
  invisible until you go looking, and no other folder covers it — Gmail's "All
  Mail" excludes Trash by definition — so Trash was the one place a gap could
  never heal by itself. It is now repaired on the same schedule as every other
  folder. Spam is still skipped: it churns constantly and nothing in it is
  restored.
- The app could freeze for minutes at a time after a large batch of mail was
  removed or re-indexed. Search index maintenance looked its rows up by a column
  the index cannot search on, so every single message added, edited or deleted
  quietly walked the entire search index end to end. One folder's cleanup of 410
  messages froze the main window for over three minutes; the same cost sat on
  every arriving message body and every edited subject. Maintenance is now a
  direct lookup — measured at 9.2 seconds down to 44ms for that same batch. The
  existing search index is rebuilt once, automatically, on first launch.
- The background pass that keeps conversation lists up to date now yields on a
  time budget instead of a fixed number of conversations. A hundred short
  threads and a hundred nine-hundred-message threads cost wildly different
  amounts, so a fixed count bounded nothing; the pass now stops after roughly
  8ms and picks up where it left off, keeping the window responsive whatever the
  mix of threads.
- The AI view no longer hangs on a loader for a big thread. Conversation
  extraction runs once per thread and every other caller joins that run, but a
  joiner used to receive only the final result — not the progress. Since the
  background extractor usually starts a large thread first and asks for no
  progress at all, a user who then opened that thread and switched to AI view
  watched a bare spinner for the entire multi-minute run, with no message
  bubbles, no counter, and no way to see it was working. Joining a run now
  streams its progress: the latest snapshot paints immediately and the bubbles
  and the `done/total` counter fill in as each message is extracted.
- Snoozed, the last view with the conversation/message mix-up, and the one where
  it also disagreed with the sidebar. The badge counted every message tagged
  snoozed — including ones with no wake-up time, which the list can never show —
  while the list counted the messages it had loaded and called that the total.
  It now pages and counts in conversations under one predicate, so the badge, the
  header and the rows are the same number, and a conversation is shown whole with
  every message of it that is coming back. The view is also no longer capped: it
  quietly stopped at 100 messages while claiming to show everything, and it now
  has real prev/next pages. Loading it takes one query instead of one round trip
  per snoozed message.
- "All Email" had the same conversation/message mix-up as Starred and Important
  below, at a bigger page size: it paged and counted in messages while showing
  one row per conversation, so a 100-message page could render as a couple of
  dozen rows under a total it could never reach, and a conversation whose mail
  straddled the boundary was split across two pages. It now pages and counts in
  conversations, and a conversation is shown whole — including the user's own
  replies, which the old per-message query dropped mid-thread. The view is also
  much faster on a large mailbox: the page is an index range scan instead of a
  full table scan with twelve folder tests per message.
- Starred and Important disagreed with themselves: the header read "1-50 of 52"
  above 15 visible rows, page 2 held 2 more, and the inbox's own Starred section
  said 8. The list shows one row per conversation, but these two views were
  paged and counted in MESSAGES — so the "of N" was a message total, a page of
  50 messages collapsed to however many conversations they happened to belong
  to, and a conversation whose mail straddled the 50-message boundary was split
  across two pages. Both now page and count in conversations end to end: the
  page holds 50 whole conversations, "of N" counts conversations, and a
  conversation is never half-shown. A star that exists only on a Trash, Spam or
  Junk copy no longer counts, matching what the rest of the app means by
  starred. (The inbox's "8" was always a different, correct number: it counts
  only INBOX conversations, and skips the ones already listed under "Important
  and unread".)
- Phone numbers in a sender's signature were often missing from their contact
  card. Three separate causes, all fixed:
  - **Only the bottom of long mail was read.** Mining looked at the last ~12 KB
    of a message, which on a top-posted reply is the *end of the quoted chain* —
    so it read whoever signed off last in the thread and never saw the sender's
    own signature at the top. It now reads both ends of a long message, cutting
    on tag boundaries so no markup leaks into the text.
  - **A click-to-call button was scored as a switchboard.** A signature whose
    number appears only behind a "Call me" link arrives as `tel:+…`, and the
    scorer matched the `tel` of that URI against its list of office-line labels
    and docked the number — inverting the one signal that meant the opposite. A
    `tel:` link is now read as the person's own number; a written `Tel:` label
    still means the landline and keeps its penalty.
  - **Mail in your other accounts was ignored.** With one shared directory, a
    contact who writes to your second address was mined only against the account
    you happened to be scanning from, so their signature looked absent.
    Signature mining now reads that contact's recent mail across every connected
    account, newest first.
  Because mining only ever re-reads mail newer than what it has already seen, the
  fix would otherwise have reached nobody until each contact wrote again — and
  never for one who has gone quiet. Upgrading therefore clears that mark once, so
  every contact is re-read under the corrected rules on the next scan. Numbers
  already found are kept.
- **"Scan" read only the account you were looking at.** The contact directory is
  now one list shared by every account, but the mail it is built from still lives
  in each account's own database — and the scan walked just the active one. Every
  person who writes to your other address was therefore missing from the list
  until you happened to switch to that account and scan again. A scan now walks
  every connected mailbox in one pass, and if one of them can't be read it
  finishes the rest instead of giving up. Per-account statistics stay per-account.
- **Your whole address book could disappear on launch.** The startup sweep that
  clears out orphaned per-account databases treated `sarvinbox-contacts.db` —
  the new shared contact directory — as one of them, because it deletes any
  `sarvinbox-*.db` it does not recognise. On the first launch after the unified
  directory shipped it deleted the file; the next launch recreated it empty, and
  Contacts was blank. The sweep now keeps the directory by name, and no longer
  assumes an unfamiliar database is a dead one: it deletes only files shaped
  like the per-account DBs it used to write, and logs anything else it leaves
  alone. Nothing was actually lost — the move parks each mailbox's original
  contacts rather than dropping them — so upgrading restores the address book,
  with the repairs below applied to it, the first time it finds the directory
  empty and those copies still on disk.
- A contact could show somebody else's phone number. Two causes, both fixed:
  - **A job title was read as an office label.** The scorer looks just before a
    number for a word like "Office" or "Support" that marks it as a company
    line, but the look-back ran past the end of the line — onto the title
    printed above. "VP Support" over a mobile docked that mobile as if it were
    a switchboard, and the same hole hit every "Head of Sales", "Office
    Manager" or "... Support" signature. The label must now sit on the number's
    own line, which is where a real one is always written.
  - **One well-formatted sighting outranked a number seen fifty times.** Ranking
    went by signature-shape alone, so a vendor's number the contact had
    forwarded once, in a tidy signature, beat the number in their own sign-off
    on every mail they had ever sent. How often a number is seen under a
    person's name now counts towards it — with a ceiling, so repetition can
    lift a weak signal but never claim a colleague's number outright.
  Both verdicts are worked out while a signature is read and then stored, so
  upgrading re-reads every contact's mail once under the corrected rules rather
  than waiting for each of them to write again.
- Colleagues' names appeared on robot addresses. A notification service puts the
  acting person in the From name, so Jira, Bitbucket and Google Drive mail
  landed in the directory as real people — one teammate's name on
  `notifications@atlassian.net`, another's on `pullrequests-reply@bitbucket.org`
  — and once a name was stored no later scan replaced it. No-reply detection
  only recognised the marker at the START of an address, so `...-reply@` and
  `...-noreply@` read as human; it now matches at either end, and a machine
  mailbox is named after its sending domain instead of the person it happens to
  be writing about. Rows already stored are corrected on upgrade; a name you set
  yourself is left alone.
- "All Email" could show more messages than a page holds — the range read
  "1-111" on a page of 100, and a background refresh while you were on page 4
  pulled page 1's mail in underneath you. The virtual lists (All Email, Starred,
  Important, All Inboxes) now refresh the page you are actually on, and no page
  indicator can report a range wider than its own page.
- A page of mail could report more messages than it was showing — Sent read
  "1-100 of 1,718" under a 25-row page. After every sync the app re-read a fixed
  100 messages from the top of the folder and folded them into the list on
  screen, which both stretched the page past its own size and, if you had paged
  forward, quietly swapped in the newest messages while you were reading page 4.
  The refresh now re-reads exactly the page you are on, at the size that page
  uses, and leaves it that size.
- The Sent folder showed almost no mail, a count of ~1,700, and a "next" button
  that paged into a blank list. Sarv's IMAP server lists two mailboxes for the
  same physical Sent store — the real `Sent` and an alias `Sent Mail` — and the
  app resolved the "sent" role to whichever the server happened to list first.
  Mail was syncing all along, into `Sent`, while the sidebar, the sent-copy
  upload and Gmail label routing all pointed at the alias, which held nothing.
  A standard folder is now resolved by how strongly it matches — the server's
  own SPECIAL-USE flag first, then a path the provider is known to use, and only
  then a name that merely looks the part — and, decisively, by where the mail
  actually is: when the server proves two names are one mailbox (same
  UIDVALIDITY, and message counts that agree to within a little drift, because
  the two names are read at different moments), the one already holding your
  mail wins however weakly it matches. "Holding" means messages FILED under that
  name, not merely tagged with it: a message in two folders is stored once and
  carries both names, so the membership count reads full under both and cannot
  tell them apart — it was the filing that showed 1,718 under `Sent` against 1
  under `Sent Mail`. That rule is what fixes this account, where the empty alias
  is the one Sarv flags as Sent; because a message is never stored twice, the
  other name can never catch up, so following the mail is both correct and
  stable. Two names that are EACH full against their own server count are left
  alone — that is a server reusing a UIDVALIDITY across two real mailboxes, and
  neither may be dropped. Paging is also clamped: a page that comes back empty keeps
  the reader on the page they were on and disables "next", instead of stranding
  them on a blank list under a count that promised more. The duplicate name is
  dropped from sync and from the historical backfill rather than merely
  out-ranked, so one mailbox is no longer fetched, paged and counted twice — and
  a sync asked for by the dropped name runs against the mailbox it stands for
  instead of doing nothing. Nothing is dropped on a guess: only the four roles a
  server has exactly one mailbox for (Sent, Drafts, Trash, Spam), only across
  top-level or known provider paths — a folder of your own that happens to be
  named like a system one (`Archive/Sent`) is never folded into it — only once
  the server has proved the two are the same store, and never at all if the
  folder list can't be read. The inflated count had a second cause of its own:
  every polling cycle wrote the server's message count into the field that
  records how many messages we actually hold locally, so both halves of the
  displayed count were the server's number and nothing was left to disagree with
  it — a folder holding one message still read "1-1 of 1,719". The poll now
  records only what the server reports, leaving the local count to be recounted
  from what is really stored; that also restores every "have we got them all
  yet?" comparison.
- Emails in the sectioned inbox can be opened again after returning to the
  folder. The rows on screen and the flat list a click is resolved against are
  held in two places: re-selecting INBOX while a message was open emptied the
  second one while deliberately keeping the rows cached, and the reload that
  would have refilled it decided nothing visible had changed and skipped itself.
  The list still looked right and every row in it was inert — the reading pane
  stayed on "Select an email to read" whatever was clicked, until a sync
  happened to change one of the sections. A reload now skips itself only when
  the rows AND the list behind them are both still in step.
- Opening a section's full page ("X-Y of Z") no longer has the list swapped out
  from under you. The page you are reading and the sectioned inbox behind it are
  the same store slot, and every section loader wrote the whole sectioned inbox
  into it — so the first background sync that changed anything replaced the page
  mid-read. Which of the two owns that slot is now decided in one shared place
  that every loader writes through.
- The app refuses to start on a native SQLite module it cannot load, instead of
  coming up as a fresh install. `better-sqlite3` opens its compiled addon lazily
  — on the first database, not at import — and every core-database read wraps
  that failure into an empty result, so a mismatched build showed no accounts,
  no folders and no mail, with an onboarding screen inviting the user to add the
  account again on top of data that was still on disk. (That reading is what let
  a startup sweep delete two live mailbox databases.) Startup now opens a
  throwaway in-memory database before anything else touches storage, and on
  failure stops with a dialog and a log entry that name both ABI numbers, say
  plainly that nothing was read, written or deleted, and give the one command
  that fixes it.
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
  whichever folder the parallel sync happens to be working on. A reload is spent
  only when the stored count has gone UP, so the zero-count tick that opens
  every sync — and the reset to zero between one sync and the next — no longer
  costs a re-query for rows that are not there yet.
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
