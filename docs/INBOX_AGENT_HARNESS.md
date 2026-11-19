# Inbox Agent as a harness

Status: accepted 2026-11-18; Phase 1 built behind a switch (see "Phase 1 as built"). Replaces the fixed pipeline described in
[SUPERHUMAN_COMPARISON_AND_AGENT_PLAN.md](SUPERHUMAN_COMPARISON_AND_AGENT_PLAN.md)
("Shared tool architecture"), which planned this but was never built.

## Why the current agent refuses

The agent today is not an agent. It is a router in front of four fixed programs:

| Path | What decides it | What it can do |
| --- | --- | --- |
| Capability replies | Regexes in `inbox-assistant-capabilities.ts` | Refuse archive, delete, categorize, send, calendar writes |
| Unread review | `inboxAssistantReviewIntent` regexes | One AI pass over unread mail, mark read, card-driven archive/trash |
| Mail command | Regexes for "mark … read/unread" | Mark read/unread on a literal phrase match |
| Search Q&A | Everything else | Plan JSON → search → read → grounded answer |

The model is called as a function (`callAI(prompt) → string`), never as a
decision maker. It cannot chain steps ("find X, read it, then do Y"), and every
request that does not fit one of the four shapes is refused by design. The
screenshot case, "review my uncategorized unread emails, mark read if not
related to business", fell between the review path (which only knows a date
filter) and the command path (which only knows a phrase), so it was refused,
even though the app can do every step: list unread uncategorized mail, judge
each one, mark the rest read.

Patching more regexes into the router makes the agent more brittle, not more
capable. The fix is to invert control: **the model decides what to do; the
harness decides what is allowed.**

## The shape: a model-driven loop inside an app-owned harness

```
user turn
  └─ loop (max steps / tokens / time / mail touched)
       model ──► tool call(s) ──► harness: validate → permit? → execute or stage
         ▲                                                          │
         └────────────── tool results (data, never instructions) ◄──┘
  final answer (with sources) + staged change set card + undo
```

Same pattern as Claude Code: the model only plans and calls tools; every
guarantee (scope, approval, undo, protection, budgets, logging) lives in code
the model cannot talk its way around.

### 1. Provider layer: tool calling

`callInboxAssistantAI` sends one system and one user string. Replace it, for
the agent, with a multi-turn call that carries `tools` and returns tool calls.

- **Built on the existing transport, not a new SDK.** The proposal said the
  Vercel AI SDK. On inspection every provider the app supports already speaks
  one of two wire formats the app sends itself (OpenAI Chat Completions for
  OpenAI, Sarv and custom endpoints; Gemini `generateContent`), and tool calls
  are two more fields in each. That transport carries tuned behaviour an SDK
  would have to be re-taught through a custom fetch: the OAuth bearer refresh
  on 401, Sarv's error codes and retry classes, the redirect refusal, the
  request size guard and the usage accounting that reads each response. So
  `packages/core/src/agent/ai-chat.ts` adds the tool fields on top of the same
  request functions (`postOpenAICompatibleChat`, `postGeminiGenerate`,
  `withAIRetry`), now shared by the single-prompt calls too. The loop stays
  ours either way.
- **No up-front probe**: the first request carries tools. A provider that
  refuses them (400/404/422 before any tool call worked) is asked again with
  reasoning off (`reasoning_effort: 'none'`): OpenAI's gpt-6-luna takes tools on
  Chat Completions only that way, measured live on 2026-11-18. A second refusal
  switches the run to a strict JSON protocol. Whatever worked is remembered for
  that provider identity (in memory, keyed by the existing review identity
  digest), so a refusal is paid for once. The JSON protocol is (`{"tool": …, "args": …}` or `{"final": …}`, one per
  turn, parsed with the same strict-then-lenient rules as today's plan
  parser). Small local models stay usable; they just take more turns.
- **Reasoning models**: set an output budget per step that leaves room for the
  answer, and treat `finish_reason: length` with empty content as "retry once
  with a larger budget", not as an empty answer (the gpt-6-luna bug seen in
  contact enrichment; fix it once here and reuse it there).
- Open question: **does Sarv AI accept `tools`?** If not, it runs on the JSON
  fallback until it does.

### 2. Tools: everything a person can do in the mail UI

Every tool is a thin, typed wrapper over a service the UI already uses
(`sync-engine` operations, `smtp:*`, `filters:*`, `snooze:*`, `labels:*`,
`contacts:*`, `drafts:*`, local calendar). No tool calls an IPC handler; shared
services are extracted from the handlers where needed (as the existing plan
already required). Each tool declares a **risk class**; the harness, not the
prompt, enforces it.

| Risk | Tools | Default in "Ask" | Default in "Approve for me" |
| --- | --- | --- | --- |
| **read** | `list_accounts`, `list_folders`, `list_labels`, `list_categories`, `search_mail` (all filters: account, folder, from/to/cc, subject, text, date range, unread, starred, important, has attachment, category incl. none, label, size; sort; cursor), `count_mail` (same filters), `get_thread`, `read_message` (paged body), `read_attachment`, `sender_profile` (history, VIP/blocked, reply rate), `find_contact`, `list_snoozed`, `list_filters`, `calendar_availability`, `list_drafts` | run | run |
| **judge** | `classify_messages(ids, instruction, labels[])`: the harness sends the messages in bounded parallel batches to the model with a fixed classification prompt and returns `{id → label, confidence, reason}` | run | run |
| **reversible** | `mark_read/unread`, `star/unstar`, `mark_important`, `set_category`, `add/remove_label`, `move_to_folder`, `archive`, `move_to_trash`, `restore_from_trash`, `mark_spam/not_spam`, `snooze/unsnooze`, `create/update/delete_draft` | staged into a change set, one approval card | applied, within caps, with Undo |
| **standing** | `create/update_filter`, `block/unblock_sender`, `trust_sender`, `set_vip`, `create_folder/label` | staged, explicit approval | staged, explicit approval |
| **outward / irreversible** | `send` (new, reply, reply-all, forward; through `smtp:sendWithUndo`), `unsubscribe` (mailto/https), `delete_forever`, `empty_folder`, calendar invites | explicit approval with full preview | **still explicit approval** |

Read and judge tools never ask. The user is only interrupted when something
changes, once per change set, not once per email.

"Can it do everything a human can?" Yes, by construction: the tool list *is*
the mail UI's action list. A new UI action is not done until it has a tool.

### 3. Harness guarantees (code, not prompt)

1. **Provenance**: a write tool accepts only message ids that a read tool
   returned in this run, in the user's selected accounts. A hallucinated id, or
   one an email's text "suggested", is rejected. This is the main defense
   against prompt injection from mail content, because content alone can then
   never widen what the agent may touch.
2. **Change sets**: in Ask mode, write calls are staged, not executed. The
   model is told "staged as change set #3 (37 messages), awaiting approval" and
   keeps going. At the end of the turn the user sees one card per change set:
   what, how many, examples, reasons from `classify_messages`, per-row
   checkboxes, Approve / Approve selected / Cancel. Mixed threads are expanded
   (a promo message inside a business thread does not drag the business reply
   along).
3. **Journal and Undo**: every applied change set records each message's prior
   state (flags, folder, labels, category, snooze) and the server result.
   Undo per change set, an `undo` tool, and honest reporting when Undo is
   partial (server already purged, message moved since).
4. **Protections**: the existing review protections (`inbox-assistant-review-protection.ts`:
   sign-in and security codes, bank and card records, invoices, quotes and
   contracts, meeting invitations) become guards on
   `mark_read`, `archive`, `move_to_trash` in **every** mode. A protected
   message is moved to an "excluded, here is why" list on the card, not
   silently skipped.
5. **Caps**: per run, max steps, tokens, wall time, AI calls, messages changed
   (e.g. 500 without a second confirmation), and outward actions (1 per
   approval). The existing `AUTOMATIC_REVIEW_LIMITS` generalise into this.
6. **Untrusted content**: tool results that carry mail text are wrapped and
   labelled as untrusted data; the system prompt says so, but nothing relies on
   the model obeying it (see 1, 2 and the outward rule).
7. **Diagnostics stay content-free**: each step logs tool name, risk class,
   counts, durations, error class. Never arguments that carry search words,
   addresses or text (same rule as today's run line).
8. **Cancellation and restart**: Stop aborts the loop between steps; an applied
   change set in progress finishes its current batch and reports exactly what
   changed. A change set approved but not finished when the app quits resumes
   or reports on next launch.

### 4. Keeping the loop small on big inboxes

The model never sees 3,000 emails. Patterns the harness provides:

- `search_mail` / `count_mail` return compact rows (id, account, sender,
  subject, date, flags, category, 200-char snippet), paged by cursor, with the
  true total.
- Bulk judgment goes through `classify_messages`, which batches outside the
  main context and returns only labels. "Mark read if not business" becomes:
  `search_mail(unread, category: none)` → `classify_messages(ids, "is this
  related to the user's business?", [business, not_business, unsure])` →
  `mark_read(ids where not_business)` → one card. `unsure` stays unread.
- Tools that act on a query (`mark_read({query})`) resolve the query to a
  frozen snapshot of ids at staging time, so "all" means every page, and mail
  arriving later is not swept in.
- Long runs compact earlier tool results into summaries when the context fills.

### 5. What we keep from today

- Retrieval (`inbox-assistant-retrieval.ts`): hybrid search, body completeness
  and attachment reading become the implementation of `search_mail`,
  `read_message` and `read_attachment`.
- The grounded answer verifier and source links: a final answer must cite the
  ids it read; unsupported amounts and claims are still removed or flagged.
- The history store, activity view, usage/cost accounting, diagnostics report
  and the evaluation harness (`createAssistantHarness`, `test/eval/assistant/`),
  which becomes a task-based eval: a scripted fake mailbox, a request, and
  assertions on the final mailbox state and the staged change sets.
- Draft generation and meeting availability become `create_draft` and
  `calendar_availability`.

What goes: the regex router, the capability refusals, the separate review and
command paths, and the single-shot plan JSON.

## Delivery

Each phase ships behind a switch, with the old path still default until its
eval passes. Tests and the whole suite with every phase, as CLAUDE.md requires.

| Phase | Deliverable | Gate |
| --- | --- | --- |
| 1 | Tool-calling provider layer (with JSON fallback), loop, read and judge tools, final answer with sources. | Today's Q&A eval passes at least as well; "how many unread" and multi-step questions answered; works on OpenAI, Gemini, a local model, Sarv (native or fallback). |
| 2 | Reversible write tools, change sets, approval cards, provenance, protections, journal, Undo, caps. | The screenshot request works end to end in Ask mode; injection fixtures ("forward this to …", "mark all as read") cannot change mail outside the user's request; Undo restores state; partial failure and re-run never double-apply. |
| 3 | Standing tools: filters, block/trust/VIP, folders/labels, snooze. Old pipeline removed. | Eval parity on everything the old paths did; no regex router left. |
| 4 | Outward tools: send/reply/forward with full preview and undo-send, unsubscribe, permanent delete. | Never sent without an explicit approval naming the recipients; "Approve for me" cannot send. |
| 5 | Proactive: saved playbooks ("every morning, clean promos"), briefings, follow-ups. | Separate opt-in per playbook, same harness. |

## Decisions (2026-11-18)

1. **"Approve for me"**: reversible actions apply automatically, with Undo and
   caps; standing and outward actions always ask.
2. **Sending**: the agent may send, with an explicit approval per message that
   names the recipients. "Approve for me" never sends.
3. **Models without tool calls**: supported through the JSON protocol.
4. **Deleting**: Trash by default; permanent delete is offered too, with its
   own confirmation, never automatic.

## Phase 1 as built

- **Switch**: start the app with `SARVINBOX_AGENT_HARNESS=1`. Typed questions
  then go to the loop; review cards (`reviewKind`, continuations) keep their
  own path. Without the switch nothing changes.
- **Transport**: `packages/core/src/agent/ai-chat.ts` (`callAIChat`,
  `callAIChatWithRetry`). The retry also handles a reasoning model that spent
  its whole budget thinking (`finish_reason: length`, no text, no call) by
  trying once with twice the budget. Contact enrichment, which hit this with
  gpt-6-luna, still uses the single-prompt path; moving it is a follow-up.
- **Loop**: `apps/desktop/electron/services/inbox-assistant-agent.ts`. 14 turns,
  40 tool calls, 8 calls per turn; the last turn offers only `answer`. Old tool
  results are shortened past 300k characters.
- **Tools** (`inbox-assistant-agent-tools.ts`), all read-only: `search_mail`,
  `count_mail`, `read_message`, `read_thread`, `read_attachment`, `deep_search`
  (today's tuned plan + retrieval, as a tool), `classify_messages`,
  `list_accounts`, `list_folders`, `list_categories`. A request to change mail
  is answered with what was found and a note that changing mail comes later.
- **Grounding**: every email or document a tool shows gets an id (`S…`), every
  tool result one too (`T…`). `answer` takes the existing grounded-fact format;
  `verifyInboxAssistantFacts` (shared with the one-shot answer) keeps a fact
  only if each cited id was shown and each quote appears in what was shown
  under it, numbers included. One corrected answer is allowed. A free-text
  `message` may not contain a number no tool showed.
- **Diagnostics**: route `agent`, outcome `answered` for replies from tool
  results, and `diagnostics.agent` (protocol, steps, tool tallies, tool error
  classes, stop reason) in the run record, app.log line, copied report and
  activity panel. Content-free like the rest.
- **Not yet**: write tools, change sets, Undo (Phase 2); a Settings toggle in
  place of the environment switch; the eval suite ported to agent tasks.

## Phase 2 as built

- **Same switch**: the write tools are offered whenever the loop runs with the
  host's mail actions (`InboxAssistantServiceDeps.mailActions`, wired in
  `ipc/inbox-assistant-handlers.ts`). Without them the agent stays read-only,
  as in Phase 1.
- **Tools** (`inbox-assistant-agent-write-tools.ts`): `change_mail` with one
  `action` (`mark_read`, `mark_unread`, `star`, `unstar`, `archive`, `trash`,
  `restore`, `move`, `add_category`, `remove_category`; `important` is the
  category of that name), and `undo_change` for a set this request applied.
  Emails are named by `S…` ids a tool showed in this run, or by a
  `classify_messages` result and its labels (`from_result` + `labels`);
  `unsure` is never changed. `include_conversation` adds each email's
  conversation (same account). Mail already as asked is left out and counted.
  A move covers one account, never to Trash (that is `trash`), Spam, Drafts or
  Sent.
- **Provenance**: an id the model was not shown (made up, or read in an email)
  fails the whole call; ids exist only for the selected accounts.
- **Change sets** (`inbox-assistant-change-sets.ts`): a staged set freezes each
  message with its tags and folder. Applying runs only pending and failed rows,
  so approving twice never applies a row twice and a retry repeats only what
  failed. A row moved or deleted since staging is skipped. Each account's
  action fails on its own. Approval is open 30 minutes; Undo 24 hours, in this
  app session (memory only: after a restart the card shows as expired).
- **Undo** puts each changed row back only if it is still as the set left it:
  flags and categories by their inverse, archive and move back to where the
  message was (its Inbox if it was in one), Trash back through the Trash
  restore when it came from the Inbox, a restore back to Trash.
- **Protections**: for `mark_read`, `archive`, `trash` and `move`, starred and
  important mail and the unread review's content gates (security codes, bank
  and card records, invoices, contracts, business reports, invitations) are
  staged unticked with the reason. Only the user's tick applies them; the card
  asks once more, as it does for Trash.
- **Modes**: "Ask for approval" stages every set for a card under the answer.
  "Approve for me" applies a set at once, up to 200 emails per request; a
  larger set, or one made only of protected mail, waits for a card. A set
  applied before the run fails keeps its card and Undo.
- **Card and IPC**: `AssistantChangeSetCard` (Approve / Approve selected /
  Cancel, Retry failed, Undo); `inboxAssistant:changeSet` with
  `decision: approve | cancel | undo`, validated strictly and serialized with
  every other mail action. The mail list refreshes after a change.
- **Mail writes** reuse the review cards' durable, receipt-returning paths:
  `changeAssistantReadFlags` and the new `changeAssistantStarFlags`,
  `changeAssistantMailLocation` (now also to any folder by id),
  `restoreEmailsFromTrash`, `changeEmailCategory`. Each is logged for learning
  as `agent_approved`.
- **Diagnostics**: `diagnostics.agent.changes` (sets, messages, how many
  applied without a card), on the app.log line as `changes=…`, in the copied
  report and the activity panel. Counts only.
- **Not yet**: standing tools (filters, block, VIP, folders, labels, snooze),
  spam, drafts (Phase 3); outward tools and permanent delete (Phase 4); Undo
  across a restart; "undo that" in a later message (the card's Undo does it).

## Phase 3 as built

Decisions (2026-11-19): a filter's "also apply to existing mail" is offered
unticked with the match count; blocking a sender offers "move their existing
mail to Spam" as a separate box, unticked; the automatic unread review keeps
its own path until the agent passes the same evaluation (Phase 3b, with
removing the regex router).

- **Switch**: the "Tools · Preview" switch in the Inbox Agent header (one
  managed app setting, `sarvinbox-inbox-agent`, mirrored to the core database
  and read by main on every request; `inbox-agent-switch.ts`).
  `SARVINBOX_AGENT_HARNESS=1` still forces it on. An unreadable setting means
  the earlier paths. Inbox Agent stays out of the AI settings tabs.
- **More `change_mail` actions**: `add_label` / `remove_label` (`label_name`;
  a label the account lacks is created when the set is applied, and deleted
  again by Undo if nothing else uses it), `snooze` (`until`, local wall time in
  the user's zone, read with `@date-fns/tz`) / `unsnooze`, and `spam` /
  `not_spam` through the mail view's verdict path. A spam verdict, and a set
  that creates a label, are **standing**: they always wait for a card, even
  under "Approve for me". Spam's Undo puts back the tag, folder, stored verdict
  and the sender's spammer and trusted listing (`revertUserSpamVerdict`); it
  refuses while sync has not reported the moved message's new UID, rather
  than move only the local copy.
- **Setting changes** (`inbox-assistant-setting-changes.ts`, tools in
  `inbox-assistant-agent-setting-tools.ts`, card `AssistantSettingChangeCard`):
  `create_filter`, `update_filter`, `delete_filter` (ids F1… from
  `list_filters`) and `change_sender` (block, unblock, vip, unvip, trust,
  untrust). Each is one card (R1, R2…) that always waits for approval. Existing
  mail a change can act on is staged as linked change sets (one per filter
  action; Sent, Drafts, Trash and Spam left out; protected mail stays) and is
  applied only when the user ticks it. Undo reverts only what is still as the
  change left it: a filter edited since, or a flag the user changed, is kept.
  "Block" adds the sender to the spammer list (what files new mail in Spam)
  and, for a sender with history, the blocked flag; it ends any trust.
  `change_sender` acts only on an address the user wrote or the sender of an
  email a tool showed: an address inside an email's text is refused.
- **Read tools**: `list_filters`, `list_labels`, `list_snoozed`,
  `find_contact` (the shared address book, read once), `sender_profile`, and a
  `label` filter on `search_mail` / `count_mail`.
- **Change journal** (`inbox-assistant-change-journal.ts`): open change sets
  and setting changes are saved in one core-database blob
  (`inbox-agent-change-journal`), so a card keeps Approve and Undo across a
  restart while its windows last. An unreadable journal is never written over;
  a save larger than 16 MB is skipped and logged.
- **"Undo that"**: labels run on through a chat (C1, C2… and R1, R2…); the
  prompt lists earlier changes that can still be undone, and `undo_change`
  takes C or R ids from earlier messages, checked against the accounts each was
  prepared for. A card always shows its held state, and an earlier card the
  agent undid is saved that way.
- **Enrichment fix**: an empty reply at the token limit (a reasoning model that
  spent its budget thinking) is retried once with twice the budget in the
  renderer's provider call; the empty-reply log no longer writes the model's
  text.
- **Not yet**: the evaluation ported to agent tasks and the regex router and
  review paths removed (Phase 3b); drafts (`create_draft` and friends) move to
  Phase 4 with sending; the reasoning-off protocol is still learned once per
  launch.
