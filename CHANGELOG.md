# Changelog

All notable changes to Sarv Inbox are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/Sarv/Inbox/compare/v1.2.1...HEAD
[1.2.1]: https://github.com/Sarv/Inbox/releases/tag/v1.2.1
[1.2.0]: https://github.com/Sarv/Inbox/releases/tag/v1.2.0
[1.1.0]: https://github.com/Sarv/Inbox/releases/tag/v1.1.0
