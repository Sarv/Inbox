/**
 * Which rows of a thread ARE the conversation — the one predicate.
 *
 * A thread's rows are not all messages in it. A draft is the user's unsent
 * reply (it renders as a compose box, never as a message); a copy in Trash or
 * Spam is mail the user threw away. Every surface that asks "what is in this
 * conversation, and in what order?" — the Standard chat view, the message
 * list, the AI view, the list row's "(N)", the background split scheduler, the
 * reply drafter and the auto-draft gates — must get the SAME answer, or they
 * visibly disagree: a count that says 4 over a thread that opens with 3, a
 * draft that shows up as a sent message in one view and not another, or two
 * processes picking two different "first emails" for the same thread.
 *
 * So the answer lives here, as pure JS over light rows, and nothing else
 * re-implements it. The one SQL twin is the list count
 * (`threadMessageCountSql` in storage-node's thread-sql.ts), which has a
 * parity test against {@link conversationMembers} on a real database.
 *
 * Zero runtime dependencies beyond two pure core modules, so the renderer
 * imports it through the `@sarvinbox/core/conversation-membership` alias
 * (never the core barrel, which drags in Node-only transports).
 */
import {
  STANDARD_FOLDER_MAP,
  folderTypeMatchStrength,
  type ClassifiableFolder,
} from '../config/folder-mapping';

import { messageIdKey } from './message-id';

/**
 * The Sent folders whose copy is a message the user SENT, even when it still
 * carries the `|draft|` marker from the compose that produced it. Excluding
 * those would hide the user's own replies from every thread they answered.
 * Recognised by name even without the folder list; provider-specific paths
 * (`INBOX.Sent`, iCloud's `Sent Messages`) come from {@link sentFolderPathsOf}.
 */
export const SENT_FOLDER_TAGS: readonly string[] = ['Sent', '[Gmail]/Sent Mail', 'Sent Items'];

/**
 * Drafts folders recognised by name even when the account's folder list is not
 * at hand (an IMAP-synced draft comes back tagged only with its folder).
 * Provider-specific paths (`INBOX.Drafts`) come from {@link draftFolderPathsOf}.
 */
export const STANDARD_DRAFT_FOLDERS: readonly string[] = ['Drafts', '[Gmail]/Drafts'];

/** The local mirror marker our own compose writes on a draft row. */
export const DRAFT_MARKER_TAG = 'draft';

/**
 * Folders whose copies are NOT part of the conversation (deleted or junked).
 * The single list; storage-node's thread-sql re-exports it as
 * `THREAD_STATE_EXCLUDED_FOLDERS` for every thread-scoped SQL fragment.
 */
export const CONVERSATION_EXCLUDED_FOLDERS: readonly string[] = [
  'Trash', 'Spam', '[Gmail]/Trash', '[Gmail]/Spam', 'Junk', 'Junk Email', 'Deleted Items',
];

/** Flag tag for a message marked `\Deleted` (awaiting expunge). */
const DELETED_FLAG_TAG = 'deleted';

type Tags = string | null | undefined;

/** Exact token test on the pipe-delimited `tags` string (`|a|b|`). */
function hasTagToken(tags: Tags, name: string): boolean {
  return !!tags && !!name && tags.includes(`|${name}|`);
}

/**
 * The paths of the account's folders in one ROLE, by the folder classifier
 * (`classifyFolder`, through its ranked form `folderTypeMatchStrength`:
 * special-use, then a known provider path, then an exact last-segment name).
 *
 * NOT a substring rule. `path.includes('draft')` would make a user's own
 * "Drafting" or "Contract drafts review" folder a drafts folder, and every
 * message filed there would silently vanish from its conversation.
 *
 * Narrower than `classifyFolder` in one case: when the server ADVERTISES the
 * role by SPECIAL-USE (RFC 6154) on some folder, the last-segment name guess
 * is not used at all — only special-use folders and the known provider paths
 * count. The guess exists for servers that advertise nothing; next to an
 * authoritative answer it only misfires, on a user's own "Clients/Draft" or
 * "Projects/Sent" folder, whose mail would then drop out of its conversations.
 *
 * Returned deduplicated and sorted, so SQL built from it (the list count) has
 * stable text and stays in the prepared-statement cache. Empty paths, and any
 * containing a NUL (which could never be a real IMAP name), are dropped.
 */
function folderPathsOfRole(
  folders: readonly ClassifiableFolder[] | null | undefined,
  role: 'drafts' | 'sent',
): string[] {
  const candidates: Array<{ path: string; strength: number }> = [];
  for (const folder of folders ?? []) {
    if (!folder || typeof folder.path !== 'string') continue;
    if (!folder.path || folder.path.includes('\0')) continue;
    const strength = folderTypeMatchStrength(folder, role);
    if (strength !== null) candidates.push({ path: folder.path, strength });
  }
  // folderTypeMatchStrength: 0 = special-use, 1..n = a known path, n + 1 = the name guess.
  const advertised = candidates.some((c) => c.strength === 0);
  const nameGuess = 1 + STANDARD_FOLDER_MAP[role].length;
  const paths = new Set<string>();
  for (const { path, strength } of candidates) {
    if (advertised && strength >= nameGuess) continue;
    paths.add(path);
  }
  return [...paths].sort();
}

/** The account's Drafts folder paths (see `folderPathsOfRole` for the rule). */
export function draftFolderPathsOf(folders: readonly ClassifiableFolder[] | null | undefined): string[] {
  return folderPathsOfRole(folders, 'drafts');
}

/** The account's Sent folder paths (see `folderPathsOfRole` for the rule). */
export function sentFolderPathsOf(folders: readonly ClassifiableFolder[] | null | undefined): string[] {
  return folderPathsOfRole(folders, 'sent');
}

/**
 * What the membership predicate needs to know about ONE account's folders:
 * where its drafts live and where its sent copies live, beyond the standard
 * names ({@link STANDARD_DRAFT_FOLDERS}, {@link SENT_FOLDER_TAGS}) that are
 * always recognised.
 *
 * Carried as one value, never as two loose lists, so a caller cannot pass the
 * Drafts paths and forget the Sent ones — which would make the user's own
 * reply in `INBOX.Sent` (with a stale `|draft|` tag) a draft in one process
 * and a message in another. Per ACCOUNT: two accounts' folder lists differ.
 * `null`/omitted means "standard names only".
 */
export interface ConversationFolders {
  readonly draftPaths: readonly string[];
  readonly sentPaths: readonly string[];
}

/** {@link ConversationFolders} of one account's folder list. */
export function conversationFoldersOf(
  folders: readonly ClassifiableFolder[] | null | undefined,
): ConversationFolders {
  return { draftPaths: draftFolderPathsOf(folders), sentPaths: sentFolderPathsOf(folders) };
}

/**
 * True when the copy lives in a Sent folder: one of the
 * {@link SENT_FOLDER_TAGS}, or one of the account's own Sent paths.
 */
export function isSentCopy(tags: Tags, folders?: ConversationFolders | null): boolean {
  return SENT_FOLDER_TAGS.some((folder) => hasTagToken(tags, folder))
    || (!!folders && folders.sentPaths.some((path) => hasTagToken(tags, path)));
}

/**
 * Is this row a draft — live OR discarded? "Should it render as a message in
 * the conversation?" is answered NO for every draft row.
 *
 *   1. A Sent copy ({@link isSentCopy} — the standard names or the account's
 *      own Sent paths) is never a draft: it keeps a stale `|draft|` tag from
 *      the compose that produced it, but it is a message the user sent.
 *   2. The local `|draft|` marker means draft.
 *   3. Membership in one of the account's Drafts folder paths means draft —
 *      this is what catches IMAP-synced drafts tagged only `|INBOX.Drafts|`.
 *   4. The standard `|Drafts|` / `|[Gmail]/Drafts|` fallbacks.
 *
 * A draft in Trash is STILL a draft row: deleting a draft used to make it
 * appear in the thread as an ordinary message, because the trashed copy fell
 * through a "live draft" filter.
 */
export function isDraftRow(tags: Tags, folders?: ConversationFolders | null): boolean {
  if (!tags) return false;
  if (isSentCopy(tags, folders)) return false;
  if (hasTagToken(tags, DRAFT_MARKER_TAG)) return true;
  if (folders && folders.draftPaths.some((path) => hasTagToken(tags, path))) return true;
  return STANDARD_DRAFT_FOLDERS.some((folder) => hasTagToken(tags, folder));
}

/** True when the copy sits in a deleted/junk folder ({@link CONVERSATION_EXCLUDED_FOLDERS}). */
export function isExcludedFolderCopy(tags: Tags): boolean {
  return CONVERSATION_EXCLUDED_FOLDERS.some((folder) => hasTagToken(tags, folder));
}

/**
 * A draft the user could still send: a draft row that is not in Trash/Spam and
 * not flagged `\Deleted`. Treats every Sent folder ({@link isSentCopy}) as
 * sent — wider than the renderer's older `isDraftEmail`, which only knew
 * `|Sent|`.
 */
export function isLiveDraft(tags: Tags, folders?: ConversationFolders | null): boolean {
  return isDraftRow(tags, folders)
    && !isExcludedFolderCopy(tags)
    && !hasTagToken(tags, DELETED_FLAG_TAG);
}

/** The fields the ordering reads. `date` is Unix SECONDS, as stored. */
export interface ConversationOrderRow {
  id: string;
  date: number | null | undefined;
}

/** A row carrying the fields membership needs. */
export interface ConversationRow extends ConversationOrderRow {
  tags: Tags;
}

/**
 * A date the ordering can use. `null`, `0`, negative and non-finite values are
 * what a missing or unparseable `Date:` header turns into — they carry no
 * position in time, so they must never decide which message is "first" or
 * "latest". Exported so every "is this date real?" question (the ordering,
 * the AI split's date fallback) asks it the same way.
 */
export function isReadableDate(date: number | null | undefined): date is number {
  return typeof date === 'number' && Number.isFinite(date) && date > 0;
}

/**
 * The ONE conversation order — a total order, so every caller (main and the
 * renderer) picks the same first and last message:
 *
 *   1. rows with an unreadable date go LAST (an undated row must not pose as
 *      the thread's first email, nor hide the real one);
 *   2. then by date, oldest first;
 *   3. then by id, so equal timestamps (a bulk import, a same-second reply)
 *      never tie — SQL's `ORDER BY date` alone leaves that order unspecified,
 *      and main and the renderer used to break the tie differently.
 */
export function compareConversationOrder(a: ConversationOrderRow, b: ConversationOrderRow): number {
  const aReadable = isReadableDate(a.date);
  const bReadable = isReadableDate(b.date);
  if (aReadable !== bReadable) return aReadable ? -1 : 1;
  if (aReadable && bReadable && a.date !== b.date) return (a.date as number) - (b.date as number);
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

/**
 * The conversation: every row that is a message in it, in
 * {@link compareConversationOrder}. Returns a new array; input is not mutated.
 *
 *   * Drafts are NEVER members ({@link isDraftRow}).
 *   * Trash/Spam/Junk copies are excluded — unless EVERY non-draft row is one
 *     (the user is reading the Junk folder): then those rows are the
 *     conversation, rather than an empty one.
 *
 * A thread that is nothing but drafts has no members.
 */
export function conversationMembers<T extends ConversationRow>(
  rows: readonly T[],
  folders?: ConversationFolders | null,
): T[] {
  const nonDrafts = rows.filter((row) => !isDraftRow(row.tags, folders));
  const live = nonDrafts.filter((row) => !isExcludedFolderCopy(row.tags));
  return [...(live.length > 0 ? live : nonDrafts)].sort(compareConversationOrder);
}

/** The first message of the conversation (see {@link conversationMembers}), or null. */
export function firstConversationMember<T extends ConversationRow>(
  rows: readonly T[],
  folders?: ConversationFolders | null,
): T | null {
  return conversationMembers(rows, folders)[0] ?? null;
}

/**
 * The conversation's NEWEST message (see {@link conversationMembers}), or null
 * — the thread's default reply target and the card the reading pane opens on.
 *
 * The last member in {@link compareConversationOrder} that has a readable
 * date: an undated member sorts last but carries no position in time, so it
 * never outranks a dated one (the same rule {@link hasNewerMember} applies).
 * Only when no member has a readable date is it the last member in the order.
 * A same-second pair resolves by id, like every other caller of the order.
 */
export function latestConversationMember<T extends ConversationRow>(
  rows: readonly T[],
  folders?: ConversationFolders | null,
): T | null {
  const members = conversationMembers(rows, folders);
  for (let i = members.length - 1; i >= 0; i--) {
    if (isReadableDate(members[i].date)) return members[i];
  }
  return members[members.length - 1] ?? null;
}

/**
 * Does the conversation hold a message AFTER `email`? The auto-draft gate's
 * question — "has somebody already answered this?" — so every doubt resolves
 * to YES (skipping an auto-draft is cheap; drafting, or auto-sending, a reply
 * to an answered email is not).
 *
 *   * Only members count: a newer draft or a newer Trash copy is not a reply.
 *   * For a DATED email, only members with a readable date that sort after it
 *     count: an undated row sorts last in the conversation order, and must not
 *     read as "someone already answered" a dated email.
 *   * For an UNDATED email (no or unparseable `Date:`), its position is
 *     unknown, so ANY other member counts as possibly newer. The gate this
 *     replaces (`ORDER BY date DESC LIMIT 1`) skipped such an email whenever
 *     the thread held another row; ordering it last and finding nothing after
 *     it would have auto-drafted in an already-answered thread instead.
 */
export function hasNewerMember<T extends ConversationRow>(
  rows: readonly T[],
  email: ConversationOrderRow,
  folders?: ConversationFolders | null,
): boolean {
  const others = conversationMembers(rows, folders).filter((member) => member.id !== email.id);
  if (!isReadableDate(email.date)) return others.length > 0;
  return others.some((member) => isReadableDate(member.date) && compareConversationOrder(member, email) > 0);
}

/** A row carrying what the sender questions need. */
export interface SenderRow {
  fromAddress?: string | null;
  fromName?: string | null;
}

/** One distinct sender of a conversation. */
export interface ConversationSender {
  /** The address as its first message spelled it (trimmed); compared case-insensitively. */
  address: string;
  /** The first non-blank display name any of their messages carried, or null. */
  name: string | null;
}

/**
 * The distinct senders of a conversation, in order of first appearance — the
 * ONE answer to "how many people wrote in this thread?" (the as-sent rule's
 * "single sender") and "who are they?" (the split's name lookup), so main's
 * background job and the renderer's on-open check cannot count differently.
 *
 * Pass MEMBERS ({@link conversationMembers}): a draft or a Trash copy is not a
 * message in the conversation, so its sender must not count.
 *
 *   * Addresses compare case-insensitively after trimming.
 *   * A row with no From address is skipped: an empty address is nobody, and
 *     counting it would make one sender's mail plus one header-less row look
 *     like a two-party exchange.
 *   * A sender's name is the first non-blank one among their messages, so a
 *     first message without a display name is filled from a later one.
 */
export function conversationSenders(rows: readonly SenderRow[]): ConversationSender[] {
  const byAddress = new Map<string, ConversationSender>();
  for (const row of rows) {
    const address = (row.fromAddress ?? '').trim();
    if (!address) continue;
    const name = row.fromName?.trim() || null;
    const key = address.toLowerCase();
    const known = byAddress.get(key);
    if (!known) byAddress.set(key, { address, name });
    else if (!known.name && name) known.name = name;
  }
  return [...byAddress.values()];
}

/** A row carrying what the live-draft question needs. */
export interface DraftCandidateRow {
  tags: Tags;
  messageId?: string | null;
}

/**
 * Does the thread hold a live draft the USER is writing?
 *
 * Any live draft ({@link isLiveDraft}) counts — not only the newest row: a
 * user's half-written reply is theirs however many messages arrived after it.
 * The agent's own saved drafts are excluded by their Message-ID key
 * (`agentDraftKeys`, compared through {@link messageIdKey}), so one auto-draft
 * does not block every later one. A draft with no Message-ID is always the
 * user's — the conservative direction.
 */
export function hasLiveUserDraftAmong(
  rows: readonly DraftCandidateRow[],
  folders?: ConversationFolders | null,
  agentDraftKeys?: Iterable<string> | null,
): boolean {
  const agent = new Set<string>();
  for (const key of agentDraftKeys ?? []) {
    const normalized = messageIdKey(key);
    if (normalized) agent.add(normalized);
  }
  return rows.some((row) => {
    if (!isLiveDraft(row.tags, folders)) return false;
    const key = messageIdKey(row.messageId);
    return !key || !agent.has(key);
  });
}
