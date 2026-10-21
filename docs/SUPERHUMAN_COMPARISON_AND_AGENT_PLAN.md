# Superhuman comparison and Inbox Agent development plan

Date: 14 October 2026

Updated: 21 October 2026 with the first local-calendar implementation and availability-aware Inbox Agent drafts.

Status: The current branch implements the local calendar (Phase 2A) and the local-only portion of availability-aware Inbox Agent drafts (2C), ready for the acceptance test below. Google, Microsoft, Sarv and CalDAV connections remain Phase 2B work after this test. The calendar changes are not a released version.

SarvInbox already has much of the basic email workflow. The largest useful additions are a conversational Inbox Assistant, reliable answers from sent mail and attachments, a connected calendar, and commands that act on every matching result. Build these on shared mail and calendar tools so the assistant, automatic drafter and normal UI use the same rules.

The recommended first release answers **“What quote did I send to TCS?”** with linked evidence. The calendar work starts with a usable local calendar, then synchronization with Google, Microsoft, Sarv and CalDAV and verified meeting options in drafts. Complete-result cleanup and advanced meeting workflows add actions to that foundation.

## What to learn from Superhuman

Superhuman now presents Mail, Go and Docs as separate products. For SarvInbox, the relevant references are Mail’s email and scheduling workflows and Go’s conversational assistance. Rebuilding a document suite is outside this plan. [Superhuman products](https://superhuman.com/), [Superhuman Go](https://superhuman.com/go).

Its useful product pattern is to connect search, drafting, calendar context and actions in one workflow. Ask AI can answer across mail, calendar and the web, inspect identified thread attachments, and help create emails or events. These capabilities are a useful target for SarvInbox’s assistant. [Ask AI](https://help.superhuman.com/hc/en-us/articles/46005676610829-Ask-AI).

### Feature comparison

“Present” below means connected code in this checkout. “Partial” identifies a specific limitation; it does not mean the entire feature needs rebuilding.

| Area | Superhuman reference | SarvInbox today | Addition or improvement |
| --- | --- | --- | --- |
| Inbox organization | Split Inbox and automatic triage. [Mail](https://superhuman.com/mail) | Present: priority layouts, sections, AI category tabs and filters. | Saved custom views, clearer rule explanations and assistant-created filters. |
| Keyboard workflow | Shortcuts and command access. [Mail](https://superhuman.com/mail) | Configurable shortcuts are present; no connected command palette was found. | One command palette for navigation, actions and asking the assistant. |
| Snooze and sending | Snooze and Send Later. [Mail](https://superhuman.com/mail) | Snooze, durable scheduled outbox and Undo Send are present. | Make desktop execution status explicit when the app is closed; preserve existing behavior. |
| Follow-ups | Automatic reminders and draft replies. [Auto Reminders and Auto Drafts](https://help.superhuman.com/hc/en-us/articles/46005658551053-Auto-Reminders-Auto-Drafts) | Follow-up reminders and automatic drafting are present. Automatic reply drafting is restricted to the active account. | Account-bound drafting for every enabled account, stale-draft refresh and one review queue. |
| Writing and personalization | Drafts use personal writing and scheduling preferences. [Personalization](https://help.superhuman.com/hc/en-us/articles/46005802896781-Personalization) | AI polish, thread context, tone learning and contact memory exist. | One place for writing preferences, scheduling preferences and approved business facts. |
| Thread summaries | Auto Summarize. [AI overview](https://help.superhuman.com/hc/en-us/articles/46005588676237-Superhuman-AI-Overview) | Cached summaries are available on request. | Optional background summaries with visible processing and cost controls. |
| Conversational answers | Questions combine email, calendar and web context. [Ask AI](https://help.superhuman.com/hc/en-us/articles/46005676610829-Ask-AI) | Natural-language filter interpretation exists; there is no connected mailbox question-answering conversation. | Persistent assistant conversations, linked evidence, follow-up questions and explicit account coverage. |
| Attachment understanding | Ask AI can read attachments in an identified thread. [Ask AI](https://help.superhuman.com/hc/en-us/articles/46005676610829-Ask-AI) | Download/preview/security flows exist. Search indexes attachment names, not their contents. | Bounded PDF, DOCX, XLSX and CSV extraction with page, paragraph or sheet references; OCR later. |
| Natural-language actions | Its MCP tools expose thread updates, trash, drafts and reminders. [Mail MCP Server](https://help.superhuman.com/hc/en-us/articles/46005696690317-Superhuman-Mail-MCP-Server) | Action primitives and configured agent workflows exist; no general command conversation or durable query-wide action task exists. | Reviewable commands such as “Delete all promotional email,” covering complete results with progress and Undo. |
| Automatic cleanup | Auto Archive can use labels, senders or domains. [Auto Archive](https://help.superhuman.com/hc/en-us/articles/46005662460813-Auto-Archive) | Filters, categories and agent actions exist. | Let the user turn a successful cleanup into a visible, editable future rule. |
| Calendar and scheduling | Combined calendars, availability sharing and email-to-event creation. [Calendar](https://superhuman.com/mail/calendar) | Invitation reading and OS-calendar handoff exist. The Calendar page is a placeholder. | Calendar connections, agenda, availability calculations, meeting drafts and event management. |
| Reusable replies | Personal and team Snippets. [Snippets](https://help.superhuman.com/hc/en-us/articles/46005686571149-Snippets) | Editable AI prompts exist; these are different from a compose snippet library. | Saved replies with variables and attachments, then shared templates if team features arrive. |
| Contacts | Social insights. [Mail](https://superhuman.com/mail) | Contact activity, notes and memory exist. Current branch improvements add reliable automatic signature enrichment and better category handling. | Company aliases, field provenance and a contact/company timeline shared with the assistant. |
| Team collaboration | Shared conversations and internal comments. [Shared Conversations and Team Comments](https://help.superhuman.com/hc/en-us/articles/46005593675917-Shared-Conversations-and-Team-Comments) | Team-related routes are placeholders; assignment, internal comments and live collaboration are not connected. | A separate later collaboration project with access control and a shared service. |
| Read analytics | Open time and device visibility. [Mail](https://superhuman.com/mail) | Standard SMTP read-receipt requests exist; these depend on the recipient’s client. | Keep receipt requests clear. Evaluate optional open tracking separately because it requires infrastructure and has privacy/reliability tradeoffs. |
| Business knowledge | Personal and team files and links inform AI. [Knowledge Base](https://help.superhuman.com/hc/en-us/articles/46005666866829-Knowledge-Base) | Contact notes and learned context exist; no connected knowledge-library product flow was found. | Approved product facts, pricing sources and company documents with provenance and version dates. |
| External assistants | A remote MCP server exposes mail and calendar tools. [Mail MCP Server](https://help.superhuman.com/hc/en-us/articles/46005696690317-Superhuman-Mail-MCP-Server) | No equivalent user-facing server is connected. | Design internal tools for reuse; expose an authenticated external interface only after permissions and action logs are proven. |

SarvInbox should preserve its own strengths: broad IMAP/SMTP compatibility, encrypted local mail, optional AI providers, readable conversation mode and extension controls. These are useful foundations for the proposed assistant. [Repository overview](/Users/rcsarv/dev/Inbox/README.md).

## Important gaps in the current implementation

1. **Searching all inboxes is not searching all mail.** `accounts:unifiedSearch` forces each account’s Inbox folder. A quotation in Sent or Archive can be missed. Add a separate assistant search service with explicit folder scope; keep the existing All Inboxes behavior intact. [Search handler](/Users/rcsarv/dev/Inbox/apps/desktop/electron/ipc/accounts-handlers.ts:370).
2. **Search results are not an answer engine.** The app converts natural language to filters and returns results. Vector-storage scaffolding and RAG interfaces do not currently provide connected semantic retrieval or cited answers. Start with reliable structured/FTS retrieval and entity expansion; evaluate embeddings when they improve measured retrieval quality. [AI search flow](/Users/rcsarv/dev/Inbox/apps/desktop/src/store/slices/search-ai-slice.ts:118), [Core exports](/Users/rcsarv/dev/Inbox/packages/core/src/index.ts:42).
3. **Quotation attachments need their own evidence pipeline.** The FTS index contains `attachment_names` and `clean_body`, not attachment text. [FTS schema](/Users/rcsarv/dev/Inbox/packages/storage-node/src/fts-schema.ts:54).
4. **Current drafting research is deliberately small.** The reply drafter uses bounded email/web lookups, not exhaustive mailbox research. General questions need retrieval, full-message hydration and source tracking before answer generation. [Reply drafter](/Users/rcsarv/dev/Inbox/packages/core/src/agent/reply-drafter.ts:78).
5. **Account identity must be captured for the entire task.** Automatic drafting currently restricts itself to the active account to avoid the wrong sender/storage/SMTP identity. Shared services need explicit account ownership before that restriction can be removed. [Drafting gate](/Users/rcsarv/dev/Inbox/apps/desktop/electron/services/unified-pipeline-service.ts:1263).
6. **Calendar data cannot be inferred from invitations alone.** ICS messages do not show all busy time, removed events or authoritative recurrence changes. The app currently opens invitations in the OS calendar. [Invitation banner](/Users/rcsarv/dev/Inbox/apps/desktop/src/components/email-detail/CalendarInviteBanner.tsx:34), [Calendar placeholder](/Users/rcsarv/dev/Inbox/apps/desktop/src/App.tsx:871).
7. **Existing selection and Undo do not implement query-wide trash.** Visible-row selection and current agent undo are useful primitives, but a large cleanup requires a persisted target snapshot and provider-confirmed restoration. [Bulk selection](/Users/rcsarv/dev/Inbox/apps/desktop/src/components/email-list/bulk-selection.ts:95), [Agent undo](/Users/rcsarv/dev/Inbox/apps/desktop/electron/ipc/agent-handlers.ts:544).

## A clean experience for the user

Keep **one AI configuration entry** with Dashboard and the current settings tabs. **Inbox Agent** is a separate workspace directly below Mail in the app rail. Its left sidebar uses the mail account selector design, a New conversation button and named saved chats. The center displays only the selected conversation. Activity and source emails open on the right; email sources reuse the normal mail reader, Thread/Chat views and message actions. A future global command palette can open this same assistant from Mail, Contacts or Calendar.

The assistant shows selected accounts, the scope of the current task, source links and a small task-progress area. A follow-up such as “only last month” changes the current request visibly. Search answers, draft previews, calendar proposals and action review cards use consistent layouts.

Restore **Calendar** as a first-class navigation item when its first working slice is ready. Use the full available page width, with a compact calendar/account selector and a main agenda or calendar canvas. Keep preferences in a drawer or Calendar settings tab. Avoid repeating provider configuration on the AI Dashboard.

The local calendar needs agenda/day/week/month views, create/edit/delete, date navigation, timezone, calendar selection, reminders and an event details drawer. Connected calendars show synchronization status, read-only permissions, queued edits and conflicts. A compose-side availability panel lets users see and adjust proposed meeting times while writing. Invitation sending and RSVP depend on the connected service’s scheduling capability.

## Calendar and meeting availability

### Manage a local calendar and all connected services

The required product is a full local calendar with synchronization to **Google Calendar, Microsoft Outlook and Microsoft 365, Sarv, and CalDAV**. Local-only calendars must work without signing into an external service. The same page manages local and provider-backed calendars, supports multiple connections, and remains usable offline.

Every event belongs to an owning calendar. A local appointment stays local unless the user publishes or moves it to a chosen connected calendar. Edits to a Google, Microsoft, Sarv or CalDAV event synchronize back to its owner, subject to permissions. Connecting several services should not automatically copy every event into all of them. Explicit cross-provider copy/move can be added with a clear destination and invitation preview.

Persist local edits immediately with a durable synchronization queue and visible pending/error status. Store stable local-to-remote ID mappings, provider versions or ETags, the last synchronized base, deletion tombstones and operation IDs. Reconcile remote changes before retrying; preserve both versions for conflicting edits rather than silently discarding one. A resync or disconnected provider must not erase local-only events or unsynchronized edits.

Keep recurring masters and exceptions linked. Offer occurrence-versus-series choices and distinguish deleting a local appointment, removing an attendee’s copy, and cancelling an organizer’s meeting. Local-only appointments do not send invitations. Provider-backed invitations and RSVP use the provider’s scheduling support; a generic event write must not accidentally resend invitations.

Availability combines local busy events, pending local edits, and all selected connected calendars. Preserve provider ownership in the UI and use verified mappings for duplicate display handling; equal titles or times are not enough to merge distinct meetings. Unsupported provider fields should round-trip unchanged or make the affected edit read-only.

### Connect calendars independently of mail

An IMAP account is not a calendar connection. A Sarv email user may connect a Google or Microsoft calendar, and one person may need several work/personal calendars to avoid conflicts. Distinguish calendars that are **visible**, calendars that **block availability**, and the default calendar for **creating events**.

| Provider | Plan | Constraint |
| --- | --- | --- |
| Local calendar | Standalone calendar management, reminders, import/export and offline availability. | No external connection is required; provider publication is an explicit destination choice. |
| Google Calendar | Two-way calendar/event synchronization and availability. | Obtain calendar permission separately from existing Gmail consent. Select the scopes needed for each released capability. [Google authorization](https://developers.google.com/workspace/calendar/api/auth), [Freebusy API](https://developers.google.com/workspace/calendar/api/v3/reference/freebusy/query). |
| Microsoft 365 | Graph calendar views and organizational availability where permissions allow. | Current mail access tokens target Outlook IMAP/SMTP, not Graph. Separate resource-specific access tokens before integrating calendar. [Existing OAuth provider](/Users/rcsarv/dev/Inbox/packages/core/src/oauth/providers.ts:55), [Microsoft OAuth](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow). |
| Personal Outlook | Calendar views and own-calendar busy-time calculation. | Graph `getSchedule` does not support delegated personal accounts; `calendarView` supports them. [getSchedule](https://learn.microsoft.com/en-us/graph/api/calendar-getschedule?view=graph-rest-1.0), [calendarView](https://learn.microsoft.com/en-us/graph/api/calendar-list-calendarview?view=graph-rest-1.0). |
| Sarv | Required connector, using the actual Sarv calendar API or its CalDAV endpoint. | Confirm the backend endpoint, authentication and scheduling capability during adapter discovery; no Sarv calendar API is defined in this repository. |
| CalDAV | Required generic connector with discovery, calendar selection and two-way synchronization. | Discover server capabilities and collection permissions. Basic CalDAV event storage does not by itself establish invitation/RSVP support. [CalDAV specification](https://www.rfc-editor.org/rfc/rfc4791), [CalDAV scheduling](https://www.rfc-editor.org/rfc/rfc6638). |

The existing token store keeps one account entry per provider/email. Adding a Graph token into that slot could replace the token mail needs. Introduce resource-aware access-token caching and serialized refresh handling while preserving existing mail credentials. [Token store](/Users/rcsarv/dev/Inbox/apps/desktop/electron/services/oauth-token-store.ts:122).

All four connector families are in scope. Deliver the local calendar first, then Google, Microsoft, generic CalDAV and the Sarv connector through the same adapter contract. Sarv may reuse the CalDAV adapter if its backend supports it; it still needs its own connection and end-to-end verification.

### Find availability before drafting

For “Draft a reply offering a 30-minute meeting next week,” the flow should be:

1. Resolve the date range and timezone; use saved working days/hours, duration, lead time and meeting buffers.
2. Include local busy events and pending edits, then refresh every selected connected busy calendar for the requested window. Record which calendars succeeded and when they were checked.
3. Expand recurring occurrences through the provider, account for exceptions and cancellations, and combine busy intervals deterministically.
4. Calculate two or three valid slots. Give the drafter those slots, timezone, scope and freshness, rather than asking the language model to guess availability.
5. Show editable slot chips and a draft preview. Keep private event titles out of the drafting context; busy intervals are normally enough.
6. Recheck old suggestions when inserting/sending the draft. Before creating an event, check again and report conflicts. A free-time check is a snapshot, not a reservation.

Say **“These times are free on your selected calendars”** unless recipient availability was actually accessible. An unavailable or stale calendar produces an “availability unknown” result. It must not be treated as an empty calendar.

Settings should cover working hours, timezone, default duration, buffers, minimum notice, scheduling horizon, calendars that block time, default event calendar and how to treat tentative/all-day events. Use explicit timezone names such as `Asia/Kolkata`, and handle daylight-saving changes and non-hour offsets.

### Data and synchronization

Keep calendar state in encrypted app-level storage, independent of the active mailbox. Proposed entities are connections, local/provider-backed calendars, events/occurrences, synchronization cursors, queued operations, conflict records, preferences and scheduling proposals. Preserve source IDs and versions, UTC instants plus original timezone, all-day local dates, recurrence identity, cancellation/status and transparency.

Use bounded initial windows, pagination, resume/manual refresh and incremental synchronization. Invalid cursors trigger a scoped resync. Google documents sync-token expiry; Microsoft event delta tracking has calendar/window context. [Google synchronization](https://developers.google.com/workspace/calendar/api/guides/sync), [Graph delta queries](https://learn.microsoft.com/en-us/graph/delta-query-events).

Public booking links require an always-available service for current availability, reservations and event creation. A desktop app that may be closed cannot reliably host that workflow. Treat booking links and guaranteed background execution as separate infrastructure work.

## Full Inbox Assistant

Expose one assistant to the user. Internally, mail research, contact resolution, calendar planning and action execution can be separate capabilities sharing the same conversation and task history.

### Delete all promotional email

The proposed flow is:

1. Convert the request to a deterministic, inspectable filter over selected accounts and folders. Use category/filter evidence for destructive targets; semantic similarity alone must not select them.
2. Show the scope, date range, **conversation count and message count**, examples and any exclusions. “All” means all matches, including later pages, rather than the 25 rows on screen.
3. Make mixed threads explicit. A promotional message inside a thread containing a business reply must not silently cause the business reply to be trashed. Default to matching messages; offer whole-conversation cleanup with its own expanded preview.
4. Save an immutable, account-qualified target snapshot. Show a single review card with **Move to Trash** as the default deletion action. Permanent purge is a separate operation.
5. Execute in bounded batches, showing completed, queued, failed and skipped items. New matches arriving after the preview are outside that snapshot.
6. Journal original folder/label membership and each provider result. Support cancellation, resumable execution, partial-failure retry and Undo. Report when Undo is incomplete or a server has already purged an item.
7. Offer “Apply this rule to future mail” as a separate, editable automation after the cleanup. A one-time command should not silently create a recurring rule.

Reuse the existing bulk-action routing and server-operation queue through a shared service. Refresh thread totals, categories and open list views from authoritative results. [Current bulk action handler](/Users/rcsarv/dev/Inbox/apps/desktop/electron/ipc/email-handlers.ts:2026).

### What quote did I send to TCS

Resolve TCS through known company names, aliases, email domains and participants. Ask a focused question only when several plausible companies or quotations remain.

Search Sent across the selected accounts, then relevant thread context and attachments. Use actual sent-folder/own-identity evidence; exclude drafts, unsent outbox entries and quoted copies of someone else’s proposal. Retrieve full messages rather than answering from short snippets.

Return the quotation date, recipients, reference number, products/services, amount and currency, tax treatment, validity and revision only where supported. Link each important claim to the exact email or attachment page/sheet. Separate the latest sent quotation from earlier revisions, acceptance and later negotiation. Do not combine amounts from different revisions.

For attachments, add bounded extraction after the existing attachment security checks. Keep the original file unchanged, record extraction status, and index text with source offsets. Begin with text PDFs, DOCX, XLSX and CSV. Scanned documents, passwords and unsupported files need an explicit extraction status; OCR can follow. An unreadable attachment must not produce an invented quotation amount.

The next request can then be **“Draft a follow-up on that quote and suggest three meeting times.”** The assistant reuses the cited quotation and real calendar availability, chooses the correct sending account, and leaves a reviewable draft.

### Shared tool architecture

| Layer | Responsibility |
| --- | --- |
| Core contracts | Typed requests/results, account-qualified references, retrieval plans, source evidence, availability calculation and action-plan schemas. |
| Main-process services | Mail/calendar adapters, credentials, validation, permissions, attachment extraction and execution. Extract shared services from IPC handlers instead of calling handlers internally. |
| Encrypted storage | Conversations, source references, tool runs, action targets/results, calendar cache and resumable tasks. Reconcile provider outcomes after restarts. |
| Renderer | Assistant conversation, citations, draft/slot previews, task progress, action review and Undo. |
| Provider adapter | Detect model capabilities. Use native tool calls where supported or validated structured requests for existing compatible providers. The model cannot execute arbitrary SQL or code. |

Initial tools should cover account listing, scoped mail search, full thread/message reads, attachment text, person/company resolution, draft creation/update, calendar events/availability, action preview/execute/undo and task status. Every result includes coverage and stable account/source IDs.

Reading and searching should not repeatedly interrupt the user. Bulk changes receive one clear scope review; sending mail or invitations uses a concrete recipient/content preview. Save preferences for approved recurring workflows separately. Email bodies, HTML and attachment text are untrusted evidence, never instructions authorizing tools.

Keep conversations and indexes local and encrypted. Send only the retrieved context required for the current task to the configured AI provider, following existing AI settings. Show account coverage, indexing/extraction progress and unavailable sources. Keep web research separate from private-mail retrieval so an internal quote query is not automatically sent to a public search engine.

## Phased delivery

Each phase should be independently reviewable and usable. Calendar adapter work can run alongside the assistant foundation, but scheduling must use the same verified availability service.

| Phase | Deliverable | Completion gate |
| --- | --- | --- |
| 0 | **Completed baseline.** Contacts, AI and layout improvements are committed separately, and the connected search limitations are recorded here. | Workspace type checks and lint pass; build and regression results are recorded in the development task. New assistant and calendar work starts from this baseline. |
| 1 | **Ask your Inbox.** Inbox Agent workspace with named chats, account scope, conversation history, full Sent/Archive/Inbox retrieval, company resolution, linked answers, the shared source-email reader and bounded quotation-attachment extraction. | “What quote did I send to TCS?” works when the latest quote is only in a Sent attachment; revisions and unavailable accounts are shown correctly. Agent commands remain read-only; source emails retain the normal manually operated Mail controls. |
| 2A | **Implemented for testing: local calendar.** Encrypted event storage, local-only calendars, agenda/day/week/month views, create/edit/delete, reminders, import/export and local availability. | Manage appointments offline without a provider login; restart preserves edits, recurrence and timezone behavior. |
| 2B | **Synchronization with all required services.** Google, Microsoft, CalDAV and Sarv adapters, independent connections, permissions, durable offline writes, conflict handling and sync status. | Create/edit/delete round-trips on each supported backend without duplicate events/invitations or broken mail authentication. Pending local work survives resync and permission failures. |
| 2C | **Local portion implemented for testing.** Inbox Agent meeting drafts use busy-calendar selection, working hours, buffers/timezones, optional date-range previews, and fresh conflict checks in Compose. Automatic background drafting and connected availability remain later work. | Local plus selected connected calendars → three verified 30-minute options in a draft. Stale/partial data never claims a time is free. |
| 3 | **Act on your mailbox.** Query-wide trash/archive/read/label tasks, complete target preview, progress, cancellation, restart recovery and provider-confirmed Undo. | A cleanup with hundreds of matches covers every page, preserves mixed-thread business messages, and reports precise outcomes. |
| 4 | **Meeting workflows and combined tasks.** Invitation/RSVP support across capable providers, organizer-aware cancellation, recurring meeting changes, explicit cross-provider copy/move and quote-follow-up/scheduling workflows. | Correct organizer/calendar identity, fresh conflict checks, exact invite/change previews, no duplicate events on retry, and preserved user draft edits. |
| 5 | **Proactive assistance.** Account-complete auto-drafts, stale-draft updates, daily briefing, waiting-on replies, approved cleanup playbooks, meeting preparation, company timelines, knowledge sources, snippets and optional OCR. | Per-account controls and task history; feedback improves proposals without overwriting manual decisions. Closed-app execution limits are clear. |
| Later | Team comments/assignment/shared drafts, CRM connectors, public booking links, external MCP, mobile/web clients and optional read analytics. | Separate product/infrastructure decisions, authenticated access and appropriate deployment/operating support. |

### Phase 1 user acceptance test

Inbox Agent is available from its icon **directly below Mail**. It searches selected accounts with a separate mailbox scope that includes Sent and Archive, hydrates message bodies, reads related supported attachments through the attachment security gate, and produces answers with validated source references. Named conversations stay in the encrypted app database, with a lightweight chat index and a separate blob for each conversation. Opening one chat loads only that chat; starting another preserves the previous chats and their independent context. Existing flat conversation history is migrated without removing its original backup.

The conversation sidebar uses compact **Pinned** and **Recents** sections, with metadata on hover or keyboard focus. Pin and Delete actions appear beside the name; deletion requires confirmation and removes only that saved conversation. **Draft email** uses all turns in the selected conversation, including source excerpts and warnings. The user chooses the sending account and optional instructions, then reviews the generated email in the existing Mail composer. Draft generation never sends mail or adds source attachments automatically. Long conversations are summarized in complete groups before drafting; unsupported size or incomplete summary results fail explicitly instead of dropping earlier turns.

1. Leave all accounts selected and ask **“What quote did I send to TCS?”**
2. Check the quotation details and revision dates against the linked original messages. Open a message source in the right pane and verify its owning account, even when it is not the active inbox. The pane uses the same Thread/Chat reader and Reply/Forward controls as Mail.
3. Open an attachment source and verify its filename and displayed page, paragraph, sheet/row or line reference. Text PDF, DOCX, XLSX, CSV, TSV and TXT files are supported.
4. Ask several follow-ups, such as **“Which was the latest revision?”**, **“What changed?”** and **“Who received it?”** Reopen the app and verify that the saved conversation still supplies context. Narrow the account selection and verify that answers use only those accounts.
5. Click the compact activity status to open the right sidebar. Follow account searches, missing-body downloads and attachment reading as they happen. Answers show the result and source links; coverage details and real failures are available in the sidebar without routine warning blocks.
6. Try a matching message whose body has not been downloaded, then one with a quotation only in an attachment. The agent should fetch the required content automatically. Stop a running question and start another; old activity and late answers must not appear in the new run.
7. Start a new conversation, rename it and switch back to the earlier chat. Verify that only the selected chat is displayed and each chat retains its own context. Reload and verify that the last selected chat and its name return.
8. Pin and unpin a conversation from its name, reload, and verify its section. Cancel a Delete confirmation and verify all content remains. Delete only a disposable test conversation, then verify other chats and original emails remain available.
9. Choose **Draft email**, select the sending account and describe the intended email. Verify details from early and later turns appear correctly, review recipients and content, and check that the composer displays the chosen From account. Switching chats or cancelling while generation runs must prevent a late draft from opening.

Automated validation passed with 7,197 desktop tests, 320 connection/body-queue tests and 88 real SQLite search tests, plus workspace type checks, lint, and the production build. Coverage includes separate chat persistence and migration, lazy conversation loading, switching races, pinning and deletion, full-conversation draft generation, recipient validation, cancellation, and account ownership through the shared source-email reader and composer. The production attachment worker was also exercised with synthetic PDF, DOCX and XLSX quotations from an isolated packaged-style location. Tests used temporary mailboxes and mocked AI responses; real customer quotation accuracy remains part of this user acceptance test.

This slice searches locally synchronized mail and related attachments, with bounded evidence per account. Scanned PDFs need future OCR; password-protected, unsupported, blocked or unavailable files are reported. Calendar work and mail-changing commands remain outside this feature until it passes the user test.

### Local calendar acceptance test

The Calendar icon opens a full-width local calendar independently of the selected email account. Calendar data lives in the encrypted app database; no external calendar login is required. A calendar's visibility, busy-time participation and default-event destination are separate settings. Confirmed and tentative busy events block time; cancelled or free events do not.

1. Create a timed appointment and an all-day event. Switch with the visible **Day / Week / Month / Agenda** controls (or D / W / M / A outside text fields). Use Today (T), the period arrows, the date field or the small calendar to navigate. Week and day show hourly timelines with separate lanes for overlapping events; clicking a time pre-fills a new appointment. Month shows compact event rows and **+N more** opens the complete day's list. Check overnight continuation labels and the all-day row, then edit or delete a disposable event. Restart and confirm the saved events and preferences remain.
2. Create a daily, weekly or monthly series. Move one occurrence, delete another, and verify neighboring instances are unchanged. Changing a series' dates, timezone or recurrence after occurrence exceptions exists is rejected with guidance, preserving the exceptions.
3. Set the timezone to `Asia/Kolkata`, choose working days/hours, meeting duration, notice and buffers. Hide a busy calendar: its appointments should disappear from the view but still block proposed meeting times. Turn off its availability participation to exclude it explicitly.
4. Export a disposable local calendar to ICS, then import it into a test calendar. Verify timed and all-day dates, recurrence and exceptions. Unsupported recurrence/timezone formats fail clearly before importing partial data.
5. Add a reminder on a near-future event while the app is open. Its notification should open that exact appointment or recurring occurrence. Reminders run while Inbox is open; this desktop slice cannot notify while the app is fully quit.
6. In an Inbox Agent conversation with a known recipient, choose **Draft email** and request **“Suggest a 30-minute meeting tomorrow afternoon.”** Verify activity shows a local-calendar check and the draft contains only verified time options with an explicit timezone. Use the optional date-range fields and preview for an exact window.
7. Create a conflicting event during generation or before sending. Generation/send must stop and leave a reviewable draft instead of claiming that time is still free. Remove a generated time option and confirm remaining options are still checked. Ordinary quotation drafts should not query availability.
8. Confirm a private event's title, description and location never enter the draft or AI availability payload. Only busy intervals determine slots. The compose banner states that external calendars and recipient availability were not checked; proposals do not reserve time, create an event or send invitations.
9. Receive a disposable meeting invitation addressed to the receiving account. It should appear as tentative in the local calendar even with AI disabled and before manually opening its body. Accept, Tentative or Decline from the email card; the response uses that same account and the card distinguishes sent from queued in Outbox. Declining frees the time. A higher-sequence reschedule of the appointment asks for a fresh response; queued replies to older organizer revisions fail safely in Outbox.
10. Receive a newer update or cancellation, then sync an older copy. Verify only one current event exists and stale mail cannot resurrect a cancelled meeting. Check a single-occurrence cancellation preserves the rest of the recurring series. Direct organizer requests with supported IANA timezones and daily/weekly/monthly rules are automatic; forwarded/delegated requests, floating/custom timezones and partial recurring reschedules show manual-review guidance.
11. In an installed build, restart and review the **Use Inbox by default** prompt. Choose email and/or calendar, or **Not now**. **Don’t ask again** persists. Verify OS defaults change only after **Make default**; Windows opens its Default apps chooser and status is rechecked afterward. Calendar status checks `.ics`, `webcal` and `webcals` associations. Development builds leave defaults alone.
12. Open a `mailto:` link and check the existing composer receives the intended recipients, subject and escaped body without sending. An existing draft must remain intact. Open a disposable `.ics` file: choose a local calendar and explicitly import a local copy. A meeting-request file can become a passive appointment without sending an RSVP; cancellation/response files cannot mutate another meeting. Calendar subscription links are displayed without fetching them; provider sync remains a later phase.

Validation on 21 October: the full workspace test run passed with 8,990 desktop tests, 3,723 core tests and 1,856 storage tests. Twelve optional live-scanner integration tests were skipped. Workspace type checks, lint and the production build passed. Tests use isolated mail/calendar databases and synthetic AI responses; the actual Calendar UI was also exercised against a temporary encrypted profile for event creation, editing, visibility and light/dark readability. Invitation ordering, RSVP generation, account routing, offline queuing and default-app opt-in use automated tests with synthetic data. The startup/import dialogs were checked in light and dark themes, and macOS association queries were verified read-only; native defaults were not changed. Provider authorization, live invitation delivery, external synchronization and live AI answer quality still require their own acceptance tests.

### Acceptance scenarios for the first releases

| Scenario | Required behavior |
| --- | --- |
| A quote exists in Sent but not Inbox. | Search finds it and cites the correct sending account. |
| The latest quote is in a PDF; an older quote is in the body. | Answer uses the latest supported revision with attachment provenance. |
| TCS maps to several possible organizations. | Ask a focused clarification before choosing the wrong customer. |
| One selected account is offline or only partly indexed. | Show incomplete coverage; do not describe the answer or match count as exhaustive. |
| Accounts contain identical message/thread IDs. | Every citation, draft and action routes by account plus source ID. |
| More than 25 promotional results exist. | Preview and execution cover the complete snapshot; message and conversation totals use explicit units. |
| A thread mixes promotions with a genuine customer exchange. | Preserve nonmatching messages unless the user chooses the expanded conversation action. |
| App restarts during cleanup; an item moved after preview. | Reconcile provider state, avoid duplicate actions and show skipped/failed outcomes. |
| Undo follows a partially successful cleanup. | Restore confirmed items and show any unavailable restoration accurately. |
| A malicious email asks the agent to delete invoices. | Treat it as source text; it cannot authorize a mutation. |
| Calendars overlap, recur, cancel, cross DST or use Asia/Kolkata. | Calculate valid slots from normalized occurrences and actual timezone rules. |
| Local calendars have no external connection. | Offline create/edit/delete, reminders and availability remain usable after restart. |
| Local and remote copies change while offline. | Preserve both changes, show a conflict and synchronize the chosen resolution to the owning calendar. |
| Synchronization retries after an ambiguous server response. | Reconcile stable IDs and operation history without duplicate events or invitations. |
| A resync is required or permission is revoked. | Preserve local-only events, pending edits and provider ownership; show the affected connection’s status. |
| An event is deleted or its recurring instance is changed. | Distinguish local removal, attendee-copy removal, organizer cancellation and occurrence-versus-series behavior. |
| A selected calendar is inaccessible or a proposal is old. | Report unknown availability or refresh it before offering/booking times. |
| A calendar event is private. | Use its busy interval without including its title in an external draft. |
| The user switches accounts or edits a draft during AI work. | Preserve the original task identity and user edits; stale work cannot overwrite them. |

Use temporary mail/calendar fixtures and mocked provider APIs for automated checks. Add migration, token-separation, provider-pagination, throttling, recurrence and recovery tests as each phase introduces those responsibilities. Perform an explicit consented provider smoke test before declaring a calendar connector ready.

## Additions with the greatest value after the foundation

The strongest next improvements for this product are a company timeline with quotation revisions, a daily view of commitments and unanswered messages, meeting preparation linked to contacts, and saved user-approved playbooks. These build directly on evidence already in mail and calendars.

Prioritize command access and reusable snippets before larger team or CRM projects. Treat read tracking, public booking, hosted background agents and mobile as separate decisions rather than prerequisites for a useful desktop assistant.

The first development target is **Phase 1**: one assistant conversation that can find a sent quotation across accounts, explain it with source links, and retain context for a later follow-up. Calendar development starts with **Phase 2A**, a fully usable local calendar, then all required connectors in **2B** and availability-aware drafts in **2C**. These are staged releases toward the confirmed scope, not a choice of only one calendar provider.
