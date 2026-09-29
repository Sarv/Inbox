# Changelog

All notable changes to Sarv Inbox are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **Follow-up reminders: "remind me if nobody replies".** A bell button beside
  Send (in the composer, inline reply and forward) sets a reminder for 1 day,
  2 days, 3 days, 1 week or a date you pick, counted from when the message
  actually goes out. If nobody but you has answered by then, you get a
  notification that opens the conversation, and the thread shows "No reply
  since ..." with a Follow up button that starts a reply to everyone you
  wrote to. A reply that arrives first cancels the reminder on its own. All
  open reminders, across every account, are listed under Follow-ups in the
  sidebar, below Snoozed, with a count of the ones that are due.
- **Missing-attachment warning.** If your message says something like "see
  attached" or "I've enclosed the file" but has nothing attached, the app asks
  before sending. Quoted text from earlier messages is ignored. It can be
  turned off in Settings → General.
- **Trust a sender.** A message the spam filter flagged now offers "I trust
  this sender". Their mail is then never marked or filed as spam, as long as
  it passes authentication — a message that fails it is still checked, since
  that is what a forged copy of a trusted address looks like. Trusted senders
  are listed under Security → Spam, where they can be removed; reporting one
  of their messages as spam also removes them.

### Fixed
- **Mail no longer marked "a reply to itself".** Some mail servers report
  every message's own ID as the one it replies to, and the app believed them,
  so almost every message picked up spam-filter points for "claims to be a reply to
  itself". The app now reads the message's own header. Mail already in your
  mailbox is corrected on the next launch, and anything that was moved to Spam
  only because of it goes back to your Inbox.
- **Prices in links are no longer mistaken for web addresses.** An invoice
  whose amounts (₹3.2, 136.25) link to the biller was flagged as a message
  with deceptive links. Links in Sarv email signatures, which go through a
  click-tracking address, are no longer flagged as pretending to be your own
  domain either. Existing mail is re-checked on the next launch.
- **Sarv AI asks before it reads your mail.** Signing in with Sarv used to
  switch Sarv AI on straight away, and new mail from every account was sent
  to it. The app now asks first, and nothing is sent unless you agree or pick
  a Sarv AI model yourself.
- **Crash reports no longer contain email addresses**, and you can turn them
  off in Settings → General → Send crash reports.
- **Gravatar contact photos are now opt-in.** The app used to ask Gravatar
  about every contact in the background. Turn it on in Settings → General →
  Contact photos from Gravatar.
- **Removing an account now ends its access.** Its sign-in is deleted and,
  for Google accounts, the app's access is revoked at Google. Before, this
  only happened for the account that was selected at the time.
- **Sign in with Outlook now goes to Microsoft.** It used to open Google's
  sign-in page. Outlook.com, Hotmail and Microsoft 365 accounts now sign in
  with Microsoft directly, with no app password.
- **Bank alerts from the new `.bank.in` domains are no longer flagged.**
  Indian banks now send from addresses like `alerts@axis.bank.in`, which the
  spam filter read as someone else borrowing the bank's name. Axis Bank, SBI,
  HDFC Bank, ICICI Bank, Kotak and HSBC mail from these domains is recognised,
  and two header checks no longer count against ordinary transactional mail
  (alerts, one-time passcodes, receipts).
- **A message you marked Not spam stays that way.** Opening it could tag it as
  spam again once its body was checked, and the AI could re-tag it when it
  sorted it.
- **Replying to your own sent message goes to the people you wrote to.**
  Reply on a message you sent used to address it back to yourself. It now
  goes to that message's recipients (and Reply All keeps its Cc), leaving you
  out.
- **Test notification tells you when Focus is hiding it.** On macOS, while
  Focus / Do Not Disturb is on, notifications go straight to Notification
  Center with no banner, and the app can't tell. Settings → Test notification
  used to say "Sent" anyway. Now it checks for a Focus you turned on yourself
  and says so, with how to turn it off or allow Sarv Inbox through. A Focus
  that starts on a schedule can't be detected yet, so the general checklist
  still mentions it.
- **Mail the spam filter just filed opens normally.** A message filed into
  Spam as it arrived briefly has no server ID, until the Spam folder next
  syncs. The app tried to download its body in that window, failed, and
  remembered the failure. Opening the message later showed "Unable to load
  email content" until you restarted. It now waits and tries again. The same
  applies to any message opened right after it was moved.
- **An expired extension card no longer stays on screen.** If an extension
  (such as One-Time Passcodes) sent a card that had already expired, the app
  dropped only the expiry and kept the card. It then had no countdown and
  never closed, so an old code could sit on screen until you closed it
  yourself. Cards that have already expired are now not shown at all.
- **Each Gmail account's category labels stay in that account.** With more
  than one Gmail account signed in with Google, the app made the second
  account's label changes in the first account's Gmail: its labels were
  created and coloured there, renaming a category renamed only the first
  account's label, and Remove all labels (Settings → General) left the second
  account's labels in place. A background Gmail account's new mail was also
  labelled through the account you had selected. Each account now changes only
  its own labels. When an account's Google sign-in can't be used at that
  moment, its labels are still applied, without colours, and the colours
  follow later.

### Security
- **Mail sign-in tokens no longer reach the app window.** The window that
  shows your mail could ask for the access token of any Gmail, Outlook or
  Yahoo account you signed in to. It can now get only the Sarv token that
  Sarv AI needs. Those accounts' tokens are used only by the part of the app
  that syncs and sends mail, which works as before.

## [1.2.5] - 2026-09-27

### Fixed
- **Signing in to Sarv turns AI on, every time.** On a fresh install, Login
  with Sarv connected your Sarv mailbox and the app jumped straight to the
  inbox — before the step where you choose an AI provider and model had even
  appeared — so you landed behind an "AI is inactive" banner with nothing
  chosen. Onboarding now stays on screen until you finish it, and the
  recommended Sarv model is set up in the background as soon as you sign in,
  whichever screen is open. Installs already stuck on "AI is inactive" with a
  signed-in Sarv account are fixed on the next launch. A provider you picked
  yourself — Sarv or another — is never replaced.
- **Verification-code cards only show codes you can still use.** Setting up
  the app or adding an account used to put up cards for every code from the
  last few hours, some already read, some long expired, each with a fresh
  countdown. Now a card appears only for an unread code that is still valid.
  Validity is counted from when the mail arrived, using the time the mail
  itself states ("expires in 10 minutes"), or 10 minutes when it states none.
  (One-Time Passcodes 1.2.2.)
- **A fresh install starts on the latest built-in extensions.** Built-in
  extensions ship inside the app, so an install could start on a copy that
  was already out of date and greet you with an Update button. On first run
  the app now installs the newer release straight away when one is
  available. The bundled copy stays in use if you are offline.

## [1.2.4] - 2026-09-27

### Added
- **Message text size (Settings > Appearance).** The size of the message you
  are reading, on its own scale from 80% to 160%. Interface zoom (Cmd/Ctrl +
  and -) still scales the whole app; this scales the mail alone, so you can
  read comfortably without a list, sidebar and toolbar built for someone
  further from the screen.
- **Reading font (Settings > Appearance).** A separate face for the message
  body — a serif to read in, say, with the app itself left in its interface
  font. It applies to plain-text mail and to messages that name no font of
  their own; a sender who styles their mail keeps their own typography.
- **Preview lines in the list (Settings > Appearance).** How much of each
  message shows under the subject: none for the most threads per screen, one
  (as before), or two.
- **Motion (Settings > Appearance).** Animated transitions can now follow your
  OS "reduce motion" setting, be forced on, or be turned off everywhere in the
  app.
- **Send later.** The arrow beside Send schedules a message instead of sending
  it: later today, tomorrow morning, Monday morning, or any date and time you
  pick. A scheduled message waits in the Outbox under Scheduled, where you can
  reschedule it, send it now, or cancel it and get the draft back. It is
  written to disk before the composer closes, so it survives quitting the app,
  and it goes out from the account you wrote it from. The date and time you
  pick stay put while that composer is open — a click outside no longer throws
  them away — and every composer keeps its own. A moment that has already
  passed is refused, with a line saying so rather than a greyed-out button; a
  pick that lapses while the menu is shut comes back moved to the next half
  hour instead of stale. A message set for 1:08 leaves at 1:08 — the Outbox
  wakes on the time you chose rather than on a one-minute tick, and the list
  redraws the moment it goes, so the app never shows a send still waiting after
  its time has come. And once the server has taken a message it leaves the
  Outbox for your Sent folder straight away, instead of sitting there marked
  Queued while the recipient is already reading it; if only the copy filed on
  the server is still outstanding, a line under the list says so and it
  finishes on its own.
- **Unsubscribe.** Bulk mail that publishes a way off its list now shows an
  Unsubscribe bar above the message. Where the sender supports the one-click
  standard it is a single confirmed click and nothing opens; otherwise it
  offers their unsubscribe page in your browser, or sends their unsubscribe
  address a message from your account. Every route is spelled out before
  anything leaves your machine — including that a one-click request tells the
  sender this address is read — and the browser route says plainly that you
  still have to finish on their page. One-click requests go over HTTPS only, so
  the token in an unsubscribe link is never replayed in the clear; a sender who
  published an http link gets the page route instead. Mail synced before this
  release only grows the bar after it is re-synced.

### Changed
- **Hover actions and Button labels moved from General to Appearance > Layout,
  and now actually do something.** Both had been switches that changed nothing.
  Turning hover actions off keeps a row's time, attachment clip and category
  badges visible as the pointer passes over it, instead of swapping them for
  the quick actions. Button labels draws the actions above an open message as
  icons (as before), as names, or as both — with names shown the toolbar wraps
  onto a second line rather than hiding actions.
- **Conversation view and Preview pane have been removed from General.** They
  were switches with nothing behind them; they will come back when the layouts
  they promise exist.

### Fixed
- **The Drafts count lagged behind the draft you just discarded.** The message
  left the list at once and the number beside Drafts kept the old count for a
  second or five before catching up. Draft rows are written and removed by a
  faster path than the rest of the app uses, and the counts are rebuilt from a
  projection nothing told about it — so the correction waited for a background
  sweep that runs every five seconds. Saving, discarding and sending a draft now
  refresh the count immediately, as does the copy filed in Sent.
- **The Sent copy of a message could never finish uploading.** Filing a sent
  message on the server began by scanning the whole Sent folder to check the
  copy wasn't already there — which, on a large one, took longer than the
  connection was allowed to wait. The app dropped the connection as stuck, the
  upload that followed had nothing to travel over, and the whole thing repeated
  a minute later for as long as the app stayed open, with the copy never
  arriving. The check now looks only at the newest messages, an upload never
  runs on a connection that was just dropped, and a copy that still can't be
  filed waits a little longer before each attempt instead of retrying every
  minute.
- **A discarded draft could come back.** Removing a draft's copy from the server
  began the same way — reading every message in the Drafts folder to find it —
  so on a large Drafts folder the search timed out, the connection was dropped,
  and the deletion that should have followed never ran. The draft was gone
  locally, then reappeared on the next sync. The search now starts with the
  newest messages and only reads further back when the draft genuinely is older,
  so an ordinary discard is quick and an old draft is still found.
- **Mail you sent could be missing from Sent.** On a server that publishes two
  names for one Sent mailbox (Sarv lists both `Sent` and `Sent Mail`), the copy
  written the moment a message goes out was filed under the name the app hides,
  so the message was delivered and read while your Sent folder showed nothing.
  Every part of the app now resolves Sent — and Drafts, Trash and Spam — the
  same way the sidebar does, by which name your mail is actually under, and
  messages already stranded under the hidden name are moved across on the next
  sync.
- **The Undo send delay in Settings > General did nothing.** The choice was
  saved and then read by nobody — every message used a fixed five seconds. It
  is now the window you picked, and it goes up to five minutes for anyone who
  wants longer to change their mind.
- **Closing a compose asks before throwing your mail away.** X and Escape
  used to discard the message — silently, once "Don't ask me again" had been
  ticked — so mail you closed never reached Drafts. They now ask: Save draft
  (the default, on Enter), Discard, or Keep editing. An empty compose, or a
  draft you opened and didn't change, still just closes. The trash button
  remains the way to discard outright. This applies to new mail, inline
  replies and forwards.
- **Forwards are saved as drafts.** A forward you were writing used to vanish
  when you closed it — it was never autosaved. It now saves like any other
  compose, as a draft of its own that carries the forwarded message under your
  note, so it is complete when you reopen it from Drafts.
- **Drafts keep their attachments.** Files you attached — or the original's
  files on a forward — were dropped when a compose was saved as a draft, so
  the draft reopened, and was sent, without them. Drafts now store their
  attachments (on the server too, so they follow you to other devices), show
  the paperclip in the Drafts list, and bring the files back when reopened —
  including a draft saved while offline.
- **Forwards keep the original's attachments.** Forwarding from the single
  message view or from a message in the thread list sent the mail without its
  attachments; only the chat view carried them over. Every view now attaches
  the original's files.
- **Forwards go out from the right account.** Forwarding a message from All
  Inboxes sent it from whichever account was active, not the one it arrived
  in. A forward now sends from — and drafts into — the mailbox the message
  belongs to, uses that account's signature, and shows a From line when that
  isn't your active account, as replies already did.
- **A saved draft now shows up in Drafts straight away.** The Drafts list
  used to wait for the next sync, so a draft could be missing for a while after
  you closed the window. Closing during an autosave also dropped whatever you
  had typed since that autosave began, and Undo on a send could leave two
  copies of the same draft. The draft now appears as soon as it is written
  locally, a close waits for the running save and then stores your latest text,
  and an undone send replaces its draft instead of adding a second one.
- **Drafts list rows name the recipient.** A draft used to show your own
  address, the sender, where the list should show who the mail is for. It now
  names the To, Cc and Bcc recipients, or "(no recipients)".
- **Send works on a reopened draft.** A draft opened from the Drafts list, or
  brought back with Undo, showed its text but kept Send disabled until you
  typed something.
- **The Undo toast follows the theme.** It showed as a white slab in dark mode.

## [1.2.3] - 2026-09-26

### Added
- **Dark email bodies (Settings > Appearance).** In dark mode the message
  itself still arrives on a white page, because that is the page senders write
  their mail for. Turn this on and Sarv Inbox re-colours the message for dark
  mode instead: white paper becomes a dark surface, black text becomes light,
  and the parts the sender actually designed — a brand-coloured button, a
  coloured header bar, a message that already has a dark design — are left
  exactly as they drew them, along with every image. It is off by default and
  has no effect in the light theme, so nothing changes unless you ask for it.

### Fixed
- **Trash and Junk always showed no unread mail, however much was sitting in
  them.** Their badges were derived from a conversation-wide "is this thread
  live" flag, and a message in Trash or Junk is by definition not live — so the
  count was stamped 0 on the folder's own row and could never be anything else,
  even while the folder's list showed the unread mail plainly and the mail
  server reported it as unseen. Each folder now counts the unread mail its own
  list shows. The inbox is unaffected: a thread you trashed still does not count
  toward INBOX.
- **Opening a thread, and the app in general, no longer stalls while mail is
  syncing.** Every folder Sarv Inbox checked for flag changes also recounted
  that folder's badge by reading each message in it from end to end, bodies
  included, and re-scanned the folder for messages the server had dropped. On a
  large mailbox that was several hundred milliseconds of frozen interface per
  folder, over and over, which showed up as a delay whenever you clicked into a
  conversation. Badges are now counted from a small membership index instead of
  the messages themselves, and the dropped-message scan runs on a timer rather
  than on every pass. The counts are identical; on a 27,000-message account the
  recount went from 147 seconds of accumulated freezing to well under a second.
- **The Linux app refused to start on Ubuntu 22.04, Debian 12 and other
  long-term releases.** 1.2.2's Linux builds were compiled against a newer
  system C library than those distributions ship, so the database module could
  not load and the app stopped at "Sarv Inbox cannot open its databases"
  (`version 'GLIBC_2.38' not found`). Nothing was lost — the app refuses to
  start rather than open with an empty mailbox — and Linux builds are now
  compiled against the oldest supported distribution, which every newer one
  accepts.
- **macOS: updates failed with "Cannot update while running on a read-only
  volume".** An app kept in Downloads, or opened straight from the disk image,
  is run by macOS from a temporary read-only copy and cannot replace itself, so
  every update check ended in an error that read like a connection problem.
  Sarv Inbox now offers to move itself into your Applications folder the first
  time it starts from the wrong place; your accounts, mail and settings are
  stored separately and are not touched by the move.
- **No more screens of blank space in the chat view.** A table pasted from
  Google Sheets shrank to one pixel wide and pushed the rest of the message a
  page or more down; it now shows as the table it is. Column widths, merged
  cells, alignment and cell colours reach the message again, and a run of more
  than two blank lines is cut to two. Fixed in email-chat-view 0.2.4.

## [1.2.2] - 2026-09-25

### Added
- **Appearance settings.** A new Settings tab for making the app look the way
  you want it: light, dark or follow-the-system theme; seven accent colours,
  each with its own dark-mode shade, and an optional gradient; text size from
  70% to 160%; three row densities; and a choice of interface font. Everything
  applies as you pick it — there is nothing to save — and a preview shows a real
  message row as you go. Cmd/Ctrl +, - and 0 now change the same text size and
  remember it, instead of a zoom that was lost on the next launch. Nothing
  changes until you change it: the defaults are exactly today's appearance.
- **AI is ready the moment you sign in.** Signing in to Sarv now registers the
  recommended model for you, so the AI features work straight away instead of
  showing "AI is inactive" until you opened Settings and picked a provider by
  hand.

### Fixed
- **Connections that timed out on networks without working IPv6.** Node gives a
  host's first address only 250ms to answer before it gives up on it, so on a
  network that advertises IPv6 without it actually working, an ordinary 300ms
  handshake came back as a connection timeout: Gmail accounts quietly stopped
  refreshing their sign-in and mail stopped arriving, while the same address
  loaded fine in a browser. Every connection the app makes now gets a fair two
  seconds on its first address.
- **Sender and link reputation on accounts carried over from an earlier build.**
  Two changes each shipped a database step numbered 88, so whichever one arrived
  second was recorded as done without ever running. The columns holding a
  message's spam verdict were missing on those accounts and every check against
  them failed silently. They are repaired on the next launch.
- **Extensions now run in the installed app.** Every extension reported
  "Extension sandbox is not running" and none of them did anything: the process
  extensions run in was packed inside the app archive, where it cannot be
  started, so it died the instant it was asked to. Development builds were
  unaffected, which is why it reached a release.

## [1.2.1] - 2026-09-24

### Added
- **Domain age.** The sender's domain and the domains a message links to are
  looked up in the domain registry; one registered days or weeks ago adds to
  the spam score, never enough to file mail alone. Settings → General turns it
  off.
- **The AI now sees what the spam filter found.** It reads the verdict, the
  reasons and where each link really goes, and mail the filter found deceptive
  can no longer be marked important, needs-response or a reminder.

### Changed
- **One Mac download instead of four.** The `.dmg` and `.zip` are now universal
  builds carrying both Apple Silicon and Intel, so there is no longer a choice
  to get wrong; the file is larger because it holds both. The filenames say
  `mac-arm64-amd64` so you can see it before downloading.
- **Blocklists are on by default**, every list ticked, existing installs
  included. A list that refuses this network now steps aside on its own while
  the others keep answering.
- **One place for blocklists.** Security → Blocklists is now the only control:
  whether to ask, who answers (this computer's DNS or the Sarv service), whether
  the domains a message links to are asked about too, and registration dates
  (domain age), which used to be switched off under Settings → General.
  Settings → General's "Sender reputation checks" is gone and its choices carry
  over — "Off" stays off. A sender is asked about once, as the message arrives,
  so a listed sender is filed before you see it whoever answers; the Reply-To
  domain is asked too, and every answer lands in one cache that survives a
  restart.

### Removed
- Windows portable `.exe` and the Linux `.tar.gz` builds. Both duplicated a
  download that was already there — the NSIS installer carries x64 and arm64 in
  one file, and the AppImage covers the no-package-manager case.

### Fixed
- **A brand name on a free mailbox address is flagged again.** "Microsoft
  account team" writing from an outlook.com address passed the brand check;
  fixed in mailguard 0.4.0.
- **Blocklist settings that cannot be read ask nobody**, instead of reading as
  the every-list default for a user who had switched blocklists off. A resolver
  address that cannot be used no longer fails the message being synced.
- **Signing in again no longer fails after an abandoned attempt.** The
  sign-in window listens on one loopback port for the life of the app instead
  of opening a fresh listener each time, so a second or third attempt can no
  longer find the port already taken and stall.
- **A dismissed update notice stays dismissed** instead of reappearing.
- **macOS shows the app as "Sarv Inbox"** — in Finder, the Applications folder
  and the menu bar — rather than "sarv-inbox" and "sarvinbox-main".
- **Recent mail could stop arriving on a large mailbox.** When an account's sync
  watermark fell a long way behind, the app tried to download the whole gap —
  tens of thousands of messages — in one pass. It could never finish inside the
  sync timeout, so it was cancelled and restarted from the same point every
  cycle: the oldest mail kept downloading while the newest weeks never appeared.
  Each pass now fetches the newest mail first and is bounded, so today's mail
  lands on the first sync; the older gap continues filling in the background.

## [1.2.0] - 2026-09-24

### Added
- **Extensions.** A working extension system: extensions can add a page beside
  the mail, react to what you do rather than only to what arrives, and run in
  their own process. No build step — a folder with a manifest is enough.
- **Extension store.** Settings → Extensions gained a **Browse** tab.
- **Spam filtering that runs before the AI.** Every arriving message is scored
  from its headers and links, and you can overrule any verdict. Sender
  reputation feeds the score, and mail already in the mailbox is judged too.
- **Blocklists**, off by default, under Settings → Security → Blocklists.
- **Brand logos and a verified-sender tick**, Gmail-style, from the sender
  domain's BIMI record.
- **Attachment preview** — attachments open inside Sarv Inbox instead of
  handing off to the OS.
- **One contact directory shared by every account**, rather than one per
  account.
- A Gmail-style **Select** menu in the bulk-action bar.
- An in-app banner when an account's session expires, so a mailbox can no
  longer go quiet without saying why.
- Every list now shows what it is looking at and how much is behind it
  ("1-50 of 5,000"), with page sizes that suit the list rather than one global
  setting.
- `NOTICE` and [`TRADEMARKS.md`](./TRADEMARKS.md).

### Changed
- **BREAKING — Licence: MIT → [Sarv Community License, Version 1.0](./LICENSE).**
  Contributions are accepted under the new licence, and the copyright holder is
  recorded as the legal entity, Sarv Webs Private Limited.
- Extensions now run in a separate process instead of inside the app's own.
- The conversation view moved to the published
  [`@sarv-in/email-chat-view`](https://www.npmjs.com/package/@sarv-in/email-chat-view)
  package, and the mail-security rules to
  [`@sarv-in/mailguard`](https://www.npmjs.com/package/@sarv-in/mailguard).
- Browsing extensions costs far less bandwidth; the catalogue is a third of its
  former size.
- Bulk/marketing mail is recognised from message **headers** rather than body
  text, in one shared implementation instead of three copies.
- Category labels are no longer prefixed on Sarv accounts.
- Test fixtures, sample data and the demo seed use synthetic identities.

### Fixed
- **Your address book could disappear on launch**, and a mailbox database could
  be deleted when the app failed to open its key. Both sweeps now refuse to
  delete anything when the read they source their keep-set from fails.
- **The app now refuses to start** on a native SQLite module it cannot load,
  instead of running as though the mailbox were empty.
- Mail that was never deleted could be deleted from the app, and mail missing
  from Trash is re-downloaded like everywhere else.
- **Multi-minute freezes** after a large batch of mail arrived. Background
  passes now yield on a time budget rather than a row count, and the AI view no
  longer hangs on a long thread.
- Counts and pagination disagreed with the list in Starred, Important, Snoozed,
  All Email and Sent — Sent showed almost no mail at all.
- Images: inline `cid:` images, remote images in packaged builds, and images
  routed through a proxy (`i0.wp.com`, Bitbucket/Jira avatars) all failed to
  load.
- Attachments failed to open on non-active accounts, on an empty stored list,
  and for text parts — including ones that declare `base64` but carry plain
  text.
- Contacts picked up phone numbers from signatures, could show somebody else's
  number, and put colleagues' names on robot addresses.
- The chat view showed messages twice, hung on one, dressed ordinary mail as a
  document, and showed a phishing warning that belonged elsewhere.
- Filter rules that move or flag mail no longer spring back.
- Sync: mail appears while the first sync is still running, folder views keep
  updating during a sync that creates folders, accounts no longer open two IMAP
  connections at once, and large bodies are no longer cut off by a flat
  30-second timeout.
- OAuth: an abandoned sign-in no longer strands the button on "Opening…", a
  revoked session no longer triggers a reconnect storm, and Settings → Accounts
  says "Sign-in required".
- Bulk selection acts on exactly the threads on screen, and the "Draft" badge
  no longer counts sent copies or trashed drafts.

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

[Unreleased]: https://github.com/Sarv/Inbox/compare/v1.2.5...HEAD
[1.2.5]: https://github.com/Sarv/Inbox/releases/tag/v1.2.5
[1.2.4]: https://github.com/Sarv/Inbox/releases/tag/v1.2.4
[1.2.3]: https://github.com/Sarv/Inbox/releases/tag/v1.2.3
[1.2.2]: https://github.com/Sarv/Inbox/releases/tag/v1.2.2
[1.2.1]: https://github.com/Sarv/Inbox/releases/tag/v1.2.1
[1.2.0]: https://github.com/Sarv/Inbox/releases/tag/v1.2.0
[1.1.0]: https://github.com/Sarv/Inbox/releases/tag/v1.1.0
