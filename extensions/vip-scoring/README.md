# VIP Senders

A Sarv Inbox extension that works out who you actually deal with — from your own
mailbox, not from a list you maintain — and tags their incoming mail `vip`.

Nothing leaves the machine. It has no `network:fetch` permission and no `ai:use`
permission: it stores counts, never message content.

## What it counts

| Signal | Why it is evidence |
| --- | --- |
| Messages you answered (the IMAP `\Answered` flag) | The single clearest statement that a sender matters |
| Messages you sent them | Writing to someone unprompted says more than reading them |
| Messages addressed to you alone | A conversation, as opposed to an announcement |
| Messages you starred | You marked it yourself |
| How much they send | Some credit for volume, saturating quickly |
| How recently | A relationship that ended should fade |

Reply rate dominates, and every rate is smoothed so that one answered message
cannot read as a 100% reply rate and outrank a colleague with two hundred.

A sender needs at least three messages either way before any score can promote
them, and addresses nobody can reply to — `no-reply@`, `bounces-…@`,
`mailer-daemon@` — are never promoted however much they send.

## Settings

| Key | Default | Meaning |
| --- | --- | --- |
| `vip-scoring.enabled` | `true` | Learn and tag at all |
| `vip-scoring.threshold` | `0.6` | How strong the relationship must be to count as VIP |
| `vip-scoring.tagVipMail` | `true` | Tag incoming VIP mail `vip` |

## How it learns

Learning and acting are deliberately split.

**Learning** listens to the `email:synced` event, because that event carries the
folder — which is the only way to tell mail you *sent* from mail you *received*.
Only messages flagged `isNew` are counted; the same event also fires when an
existing message is re-synced, and counting those would inflate every counter by
however many times the mailbox has been swept.

The first sync of an existing mailbox is what makes this useful immediately: it
delivers your whole history with its `\Answered` flags intact, so the extension
knows who you talk to before you have done anything. After that, your outgoing
mail keeps it current — newly arrived mail is by definition not yet answered, so
the Sent folder is the signal that keeps working.

**Acting** is a workflow, because a workflow is what can return labels for the
message being processed.

## A note on writes

Extension storage rewrites the whole `storage.json` synchronously on every
`set`. A write per message would turn a 40,000-message first sync into 40,000
synchronous whole-file writes of a growing file — quadratic work on the main
thread, which is a frozen window.

So the profile table is held in memory, mutated per message at no I/O cost, and
flushed at most once every 30 seconds and only when something changed, plus once
on quit. A crash loses at most one interval of counters, which the next sync
re-observes anyway. The table is capped at 2,000 senders, pruned by recency.

## Developing

```sh
pnpm install
pnpm --filter @sarvinbox-ext/vip-scoring test
pnpm --filter @sarvinbox-ext/vip-scoring type-check
pnpm --filter @sarvinbox-ext/vip-scoring build
```

See [docs/EXTENSIONS.md](../../docs/EXTENSIONS.md) for the extension API, the
permission model and how to publish one of your own.
