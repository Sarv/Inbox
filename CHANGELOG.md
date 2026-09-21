# Changelog

All notable changes to Sarv Inbox are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- The spam filter now judges what a message LINKS to, and you can overrule it.
  Once a body is downloaded, every link target is reduced to its domain and
  looked up through the same reputation provider as the sender; a link to a
  listed phishing or malware site decides on its own. Security → Spam lists
  every message the filter scored as suspicious or spam with its score and
  reasons, and "Not spam" / "Spam" there — like Report spam and Not spam in the
  message menu — record your verdict, which the filter respects from then on:
  a message you called not-spam is never filed again. With the opt-in under
  Settings → General, those verdicts (sender domain, server address, verdict —
  never the message) are shared with the Sarv reputation service so they count
  for other users.
- Sender reputation as a spam signal. After a message arrives, its sending
  server's address and its sender and Reply-To domains are looked up — through
  Sarv's reputation service with your own Sarv sign-in (the default once its
  address is set), or local DNS blocklists if you choose — and a listing adds
  to the spam score; a message that crosses the line only then is tagged and
  filed exactly as the header stage would have. Fail-open throughout: a
  refused, unreachable or unauthenticated lookup adds nothing. Answers are
  cached per address for six hours. Settings → General chooses the provider;
  Security → Overview shows what is waiting and anything a provider refused.
- Brand logos and a verified-sender tick, Gmail-style. A sender domain's BIMI
  record is looked up once, in the background, and its logo becomes the avatar
  on mail that passed DMARC. When the domain's Verified Mark Certificate chains
  to a pinned Mark Verifying Authority root (DigiCert, Entrust, GlobalSign) for
  that exact logo and domain, a blue tick appears beside the sender, with the
  organisation and issuer on hover; the shield gains a "Brand identity" line
  saying the same, or why not. Sender pictures now fall back in order: BIMI
  logo, the contact's confirmed photo, the domain's favicon, initials. Both
  lookups are per domain, never per message, and can be turned off under
  Settings → General; Security → Sender identity lists every cached domain
  with Refresh and Forget.
- A spam filter that runs before the AI. Every arriving message is scored from
  its headers alone — a failed DMARC, a display name that names another domain,
  a "Re:" that replies to nothing, a missing or mis-dated Message-ID/Date,
  bulk mail with no way to unsubscribe, a Reply-To pointing at a free webmail
  address, your own mail server's spam verdict, and senders you have reported.
  A message over the line is tagged `spam`, moved to the account's spam folder
  (on the server too, through the same queue "Report spam" uses, so it does not
  spring back on the next sync) and kept out of AI categorisation; the shield
  beside the sender lists the score and every reason. Nothing leaves the
  machine: this stage is deterministic and offline. The connecting server's IP
  address is recorded per message for the reputation stage (blocklists, reverse
  DNS) that follows. Your own Sent and Drafts mail is never scored.
- Attachments now open **inside** Sarv Inbox. Clicking an attachment shows it in
  an in-app viewer — PDFs, images (including SVG), text/CSV/JSON/Markdown/log
  files, audio and video — instead of writing a copy to disk and handing the file
  to another application. Nothing reaches Downloads and no external app is
  launched unless you ask: "Save a copy…" and "Open in system app" are explicit
  buttons in the viewer header. Left/right arrows move between a message's
  attachments; Escape or a click outside closes it. Only file types the app can
  render itself are ever displayed, and the type comes from the file's own
  extension rather than what the sender declared — so a `.exe`, `.html`, `.js`
  or script attachment can never be rendered or launched by a click; it gets a
  card offering Save a copy only. Formats we do not render yet (docx, xlsx,
  pptx, archives) keep today's "Open in system app" fallback.
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

### Fixed
- Filter rules that move or flag mail no longer spring back. A rule's move
  used to be a local projection only, so the next sync found the server's copy
  still in place and relinked it; a rule's "mark read" met the same fate at
  the next flag sync. Every rule action now queues its server-side operation
  through the same persisted queue user actions use — flags first, then the
  one move the message ends up making.

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
- Designed mail — the daily digest, a newsletter, anything built from a template
  — no longer loses parts of itself in the chat view. The digest arrived with
  "Hello, <name>" and its section headings simply MISSING, its header and its app
  badges stacked one item per line, and an avatar's two initials broken across
  two lines, while the same message read correctly in the standard view. The chat
  view renders a designed mail inside a sandboxed frame, and the sanitizer that
  runs first keeps the message body but removes its `<style>` — so every size and
  width the template kept in a class was gone. That is not a cosmetic downgrade
  for a modern template: it wraps each column in a cell set to `font-size:0px` to
  kill stray whitespace and puts the real sizes in the stylesheet, so text sized
  that way rendered at zero height and was not there at all, and each column fell
  back to its full-width phone layout. The mail's own rules are now written onto
  the elements they match before the body reaches the frame, the same step a
  newsletter build runs before sending. Width media queries are resolved for a
  desktop reading pane, so the wide layout wins; a mail's dark-mode rules stay
  off, as they already do in the standard view.
- The chat view no longer shows a message twice, and no longer hangs one
  message's attachments under another person's name. A thread of six mails was
  drawing eight bubbles: the view recovers messages that survive only as a quote
  inside a later reply, which is what lets it show a message nobody in the
  mailbox actually holds — but it was also recovering mails the thread already
  had, so the same message appeared once as itself and once as the copy a
  colleague quoted back. The two copies are rarely byte-identical (a quoted mail
  picks up the sender's "Confidential" banner, loses its footer, is re-wrapped),
  which is why the old exact-prefix match let them through; they are now matched
  by content regardless of what was prepended, with a length floor so a genuinely
  short reply can never be mistaken for a duplicate and deleted. Separately, a
  bubble recovered from a quote was being handed the *quoting* mail's
  attachments, reply/forward actions and star — so a file Bob attached appeared
  under Alice's message, and downloading it fetched something that bubble never
  carried. A recovered message now carries only what it actually came with.
- "Copy to Clipboard" in Show original now says whether it worked. The clipboard
  is invisible, so a button that looked identical before and after the click was
  indistinguishable from a dead one — people clicked it repeatedly with no way to
  tell whether the message source had been copied. It now confirms with a check
  and "Copied to clipboard" for a moment, and — just as important — says
  "Copy failed" when the write is refused (an unfocused window, or a context with
  no clipboard access) instead of silently pretending it succeeded. The button is
  now one shared component, so every future copy affordance behaves the same way.
- Notifications and other machine-sent mail now render in the chat view exactly
  as they were sent. The view runs every body through a conversational clean-up
  — unwrap the layout, cut what reads like a signature, normalize the fonts —
  and on a designed template that is destruction, not tidying: a Keka daily
  digest arrived with its whole footer table, the company logo and the QR code
  deleted, and nothing on screen said anything had been removed. A designed body
  owns its own layout, so it is now handed to the bubble untouched, and the
  bubble stops painting its per-sender tint over it. It is still a bubble in the
  same chat, in the same thread, with the same header, attachments and actions —
  only its content is left alone. A thread stays in the ordinary chat treatment
  the moment anybody replies to it, so nothing about a human conversation, long
  or short, changes. Where the view recognises a quoted turn inside one of these
  mails, the turn it carved out is folded back into the single bubble that shows
  the mail whole; a login notification that repeats the previous one used to
  arrive as two copies of itself, both stripped of the header card and the
  striped detail rows that carry all of its meaning.
- An ordinary mail no longer arrives in the chat view dressed as a document. The
  chat library marks a message as a document whenever its body contains any
  embedded media at all — one `img` or one `table` is enough — and drew it with a
  3px coloured rule down its side and a fill of its own. A plain typed mail with
  a signature card tripped that, so a normal message looked like it was being
  flagged for something. Those bubbles now match every other bubble in the
  thread, while still being rendered through the frame that keeps their layout
  intact. Mail shown exactly as it was sent keeps the document treatment, which
  is the one case it was meant for.
- The phishing warning no longer appears in the chat view. It belongs to the
  standard view, where a reader checks who a message is really from; repeated
  under every bubble of a thread it was noise, and noise is how a warning stops
  being read where it counts. Nothing about the check itself changed — the
  standard view and the thread list still show it.
- Bulk/marketing mail is now recognised from its **headers**, not its body, so a
  long human conversation is no longer mistaken for a newsletter. The classifier
  used to score the whole raw body — and a reply carries the entire quoted
  history under it, so quoting a newsletter, a corporate footer, or an ordinary
  spacer image was enough to condemn the reply. The false-positive rate therefore
  grew with every reply in the thread. The verdict now comes from the message's
  own headers (`List-Id`, `List-Unsubscribe`, `Precedence`, plus two new signals:
  `Feedback-ID` and RFC 3834 `Auto-Submitted`), and the remaining content checks
  (bulk click-tracker domains, UTM campaign links) look only at the part of the
  message the sender actually wrote, with quoted and forwarded text cut away.
- Three separate copies of "is this bulk mail?" — one in sync, one in the
  importance scorer, one standalone — have been folded into a single shared set
  of rules, so they can no longer disagree about the same message. The scorer's
  copy was missing `Feedback-ID` and `Auto-Submitted` entirely.
- The rule-based importance scorer was being handed the message BODY where it
  expected raw headers, so every header-based check it makes — SPF/DKIM/DMARC
  authentication, `List-Unsubscribe`, `Precedence`, campaign headers — was
  reading body prose and scoring whatever happened to contain the words. Stored
  messages carry no raw headers, so those checks now correctly report nothing and
  the bulk verdict falls back to the `|bulk|` tag recorded at sync time.
- Images a sender embedded in the message itself (a `cid:` reference — signature
  logos, avatars in notification mail) could render as a broken image while the
  same email looked fine in Gmail. The mail parser only inlines such a part when
  its declared type matches a narrow pattern, so an image sent as `image/x-png`,
  `image/x-icon`, or as `application/octet-stream` with an image filename was
  left as a reference nothing in the app could resolve — and it failed silently:
  no banner, no error, just a missing picture. Those parts are now inlined
  ourselves. A message already in your mailbox repairs itself the next time you
  open it, once per message, and an image that genuinely isn't in the message
  stays broken rather than re-downloading the mail on every open.
- Remote images in email could not load at all in packaged builds, and "Load
  images" did nothing. The app document's own security policy capped what the
  email frame was allowed to load — a frame can only tighten the page's policy,
  never widen it — so the setting had no way to take effect. It could not be
  reproduced in development, where that policy is not applied. Blocking is still
  enforced where it always was, inside the email frame: with remote images off,
  tracking pixels and remote images are refused exactly as before.
- Some remote images in email — avatars in Bitbucket/Jira notifications among
  them — never loaded, even with "Load images" on, because the hosting server
  answered `429 Too Many Requests` to every request. The cause was not volume: a
  request carrying no `Referer` header was being refused outright, and email
  images are deliberately loaded without one (a packaged build sends none in any
  case). Sarv Inbox now sends the image's OWN address as the referer, which is
  what such a server checks for and reveals nothing it does not already know —
  not you, not which message is open, not that the request came from a mail app.
  This also fixes ordinary hotlink protection, which refuses images the same way.
- Images a sender routed through the WordPress.com image proxy (`i0.wp.com` and
  friends) are now fetched from the original server instead. The proxy was the
  thing returning `429` above, and skipping it also means one fewer third party
  learning that you opened the message. Only proxy links that already specify
  HTTPS are unwrapped, so no request is silently downgraded to plain HTTP — and
  only where the message itself names the proxy link. When a server redirects us
  to the proxy instead (Bitbucket avatars do), the link is left as it is:
  redirecting a redirect to a different site is something the browser refuses
  outright, which failed those images harder than the proxy ever did. They load
  through the proxy, with the referer above getting them past its `429`.
- Attachments on a message belonging to a non-active account failed with "Email
  not found" in All Inboxes. Opening, saving and base64-reading an attachment now
  resolve the message's own account instead of always using the active one.
- A message whose stored attachment list was an empty JSON array showed a
  phantom attachment named `[]`.
- Text attachments would not open in the in-app viewer. Text is the only kind the
  viewer reads with `fetch` rather than handing to an element, and the
  `sarv-attachment://` scheme is its own origin — so the browser discarded every
  one of those reads as cross-origin and the panel showed a bare "This file could
  not be read". The handler now allows exactly the app's own renderer origin, and
  a failed read shows the reason it failed instead of a dead end.
- Text attachments still would not open after that, failing with a bare
  "Failed to fetch" before the app's own handler was ever reached. The
  privileges a custom URL scheme gets are declared once at startup, and Electron
  does not merge those declarations — a later one replaces the earlier. Our crash
  reporter declares a scheme of its own during initialisation, which was running
  after ours and quietly stripping `sarv-attachment://` of the privileges the
  viewer's `fetch` needs. Images, video and PDFs kept working, which is why this
  looked like a text-only problem. The declaration now runs after the crash
  reporter's, so both schemes keep their privileges.
- An attachment whose part declares `base64` but actually carries plain text came
  through as a handful of junk bytes — a `.txt` holding HTML arrived as 7 bytes,
  which is what the app cached, showed as its size, and handed to the system
  viewer, while other mail clients showed a full kilobyte of text. A base64
  decoder keeps only alphabet characters and stops at the first `=`, so text
  mislabelled that way collapses. Sarv Inbox now measures such a part against its
  real length in the message itself and serves the part's own bytes when the
  decode has collapsed. Deliberately the message and not the server's
  `BODYSTRUCTURE` description of it: mailboxes exist that answer with every
  parameter's value missing — no filename, no size — and against those there was
  nothing to compare, which is why this attachment stayed broken through several
  attempts at it. The repair applies on both fetch paths: the per-attachment one
  and the whole-message fallback used whenever a sync is in progress, which is
  where most opens actually land. Sizes heal too — recorded at import from the
  part's true length, and corrected from the bytes on disk the next time an
  attachment is opened, so mail already in the mailbox stops being listed as
  "7 B" on the message and in the viewer header. Attachments cached before this
  fix are re-fetched once, since the collapsed bytes were otherwise served from
  the cache forever. Genuine base64 mail is untouched, and an attachment that
  cannot be repaired still opens exactly as it did before.
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
- The "this message may not be from who it claims to be" warning is now shown per
  message. It was computed only for the message a thread opens on, so in a thread
  whose first mail is genuine every later one was unchecked — including the newly
  arrived message the reader is actually looking at, with the rest collapsed above
  it. Every expanded message in the thread and every message in the chat view now
  carries its own.

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
