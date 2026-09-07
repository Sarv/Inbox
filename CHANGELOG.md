# Changelog

All notable changes to Sarv Inbox are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Gmail-style "Select" menu in the bulk-action bar — select threads by
  read / unread / starred / unstarred state.

### Fixed
- The renderer no longer imports the `@sarvinbox/core` barrel for the folder
  classifier, which crashed the dev app with "Dynamic require of 'stream' is not
  supported"; it deep-imports the pure module instead.
- Bulk selection now operates on the exact threads currently rendered, so
  "Select unread" (and friends) can no longer tick threads shown as read when
  DB-backed sections are active.
- The "Draft" thread badge no longer counts sent copies or trashed drafts that
  retain a stale `|draft|` tag — a message must live in a Drafts folder.

### Changed
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

### Added
- `NOTICE`, [`TRADEMARKS.md`](./TRADEMARKS.md),
  [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md) and
  [`docs/LICENSING-FAQ.md`](./docs/LICENSING-FAQ.md).

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
