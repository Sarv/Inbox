/**
 * The thread as the reply drafter reads it — ONE builder, used by the
 * pipeline's auto-drafter and by the manual `agent:draftReply`.
 *
 * There used to be two, and they disagreed: the pipeline read the whole-thread
 * chat-view cache (which could hold another account's bubbles, a draft, or a
 * message bound to the wrong email) and fell back to every raw row, drafts
 * included; `agent:draftReply` ran its own SQL, kept the last ten rows, cut
 * each body to 300 characters and handed the drafter `{ from, date: number,
 * body }` — not the `ThreadMessage` shape it declares. Now both call this.
 *
 * What it builds, oldest first:
 *
 *   * Only conversation MEMBERS (core's membership predicate, through
 *     `getConversationMembers`): never a draft, never a Trash/Spam copy — the
 *     drafter must not answer the user's own unsent reply, or read a message
 *     the user threw away as context.
 *   * The FIRST member (E1) is where a looped-in recipient's earlier
 *     conversation lives, as quoted history. When the first-email split cache
 *     holds a USABLE split for exactly this email and body, E1 is replaced by
 *     its parts — the messages it quotes, then its sender's own words. Without
 *     one, E1 goes in whole (cleaned, up to {@link FIRST_EMAIL_BODY_CHARS}),
 *     because it is the only copy of that history.
 *   * Every LATER member contributes only what its sender wrote: the quoted
 *     tail is cut (it repeats the messages already listed), capped at
 *     {@link MESSAGE_BODY_CHARS}. When the cut leaves nothing (a reply whose
 *     own words the marker corpus misread, a top-posted forward), the cleaned
 *     body is used instead — never an empty message.
 *
 * Synchronous: `AgentReplyDrafter` calls `getThreadMessages` synchronously,
 * and every read here is a synchronous better-sqlite3 read on the account's
 * OWN storage.
 */
import {
  cleanEmailHtmlForLLM,
  htmlToPlainText,
  isUsableSplit,
  parseFirstSplitParts,
  stripQuotedTail,
  type EmailRecord,
  type FirstSplitPart,
  type ThreadMessage,
} from '@sarvinbox/core';
import type { SQLiteStorage } from '@sarvinbox/storage-node';

/** Cap on the first email's body when it goes in whole (it carries the looped-in history). */
export const FIRST_EMAIL_BODY_CHARS = 6000;

/** Cap on every other message body (split parts and later members). */
export const MESSAGE_BODY_CHARS = 2000;

/** What the builder reads from an account's storage. */
export type ThreadContextStorage = Pick<
  SQLiteStorage,
  'getConversationMembers' | 'firstMemberKeySync' | 'getFirstSplitSync'
>;

export interface BuildThreadMessagesOptions {
  /** Every address that is the user, so the drafter can find "my previous replies". */
  userAliases?: readonly string[];
}

const splitList = (value: string | null | undefined): string[] =>
  (value || '').split(',').map((item) => item.trim()).filter(Boolean);

/** `Name <addr>` per recipient, zipping the stored address and name lists. */
function labelRecipients(addresses: string | null | undefined, names: string | null | undefined): string[] {
  const nameList = splitList(names);
  return splitList(addresses).map((address, i) => {
    const name = (nameList[i] || '').replace(/^["']|["']$/g, '').trim();
    return name ? `${name} <${address}>` : address;
  });
}

const senderLabel = (address: string, name: string | null | undefined): string =>
  (name ? `${name} <${address}>` : address);

/** Stored dates are Unix seconds; an unreadable one (0) reads as the epoch, as before. */
const isoDate = (seconds: number): string => new Date(seconds * 1000).toISOString();

const isAlias = (aliases: ReadonlySet<string>, address: string): boolean => aliases.has(address.trim().toLowerCase());

const bodyOf = (email: EmailRecord): string => email.rawBody || email.cleanBody || '';

/**
 * What a later member's sender wrote: the quoted tail cut from its text
 * (HTML converted first; plain text as it is, since converting it would
 * collapse the `>` lines the cut reads), or the cleaned body when the cut
 * leaves nothing.
 */
function ownWordsOf(email: EmailRecord): string {
  const raw = bodyOf(email);
  const text = email.contentType === 'text' ? raw : htmlToPlainText(raw);
  const own = stripQuotedTail(text).trim();
  if (own) return own.length > MESSAGE_BODY_CHARS ? own.slice(0, MESSAGE_BODY_CHARS) : own;
  return cleanEmailHtmlForLLM(raw, { maxLength: MESSAGE_BODY_CHARS });
}

function messageOf(email: EmailRecord, body: string, aliases: ReadonlySet<string>): ThreadMessage {
  return {
    messageId: email.messageId || null,
    subject: email.subject || null,
    from: senderLabel(email.fromAddress, email.fromName),
    to: labelRecipients(email.toAddress, email.toNames),
    cc: labelRecipients(email.ccAddress, email.ccNames),
    date: isoDate(email.date),
    body,
    isFromUser: isAlias(aliases, email.fromAddress),
  };
}

/**
 * The first email as its split parts, oldest first (the sender's own part
 * last on a tie — it is the newest thing in the email). The own part carries
 * E1's Message-ID, subject and recipients; a quoted message's are unknown.
 */
function partsAsMessages(first: EmailRecord, parts: FirstSplitPart[], aliases: ReadonlySet<string>): ThreadMessage[] {
  const ordered = parts
    .map((part, index) => ({ part, index }))
    .sort((a, b) => a.part.date - b.part.date
      || Number(a.part.role === 'own') - Number(b.part.role === 'own')
      || a.index - b.index)
    .map(({ part }) => part);
  return ordered.map((part) => {
    const own = part.role === 'own';
    return {
      messageId: own ? first.messageId || null : null,
      subject: own ? first.subject || null : null,
      from: senderLabel(part.fromAddress, part.fromName),
      to: own ? labelRecipients(first.toAddress, first.toNames) : [],
      cc: own ? labelRecipients(first.ccAddress, first.ccNames) : [],
      date: isoDate(part.date),
      body: cleanEmailHtmlForLLM(part.body, { maxLength: MESSAGE_BODY_CHARS }),
      isFromUser: isAlias(aliases, part.fromAddress),
    };
  });
}

/** The drafter's view of a thread (see the module comment). Empty for a thread with no member. */
export function buildThreadMessages(
  storage: ThreadContextStorage,
  threadId: string,
  options: BuildThreadMessagesOptions = {},
): ThreadMessage[] {
  const members = storage.getConversationMembers(threadId);
  if (members.length === 0) return [];
  const aliases = new Set((options.userAliases ?? []).map((alias) => alias.trim().toLowerCase()).filter(Boolean));
  const [first, ...later] = members;

  // The split is used only for exactly this first email and its stored body
  // (the key), at the current split version, with readable parts.
  const key = storage.firstMemberKeySync(threadId);
  const row = key && key.firstEmailId === first.id ? storage.getFirstSplitSync(threadId) : null;
  const parts = row && isUsableSplit(row, key) ? parseFirstSplitParts(row.parts) : null;

  const messages = parts
    ? partsAsMessages(first, parts, aliases)
    : [messageOf(first, cleanEmailHtmlForLLM(bodyOf(first), { maxLength: FIRST_EMAIL_BODY_CHARS }), aliases)];
  for (const email of later) messages.push(messageOf(email, ownWordsOf(email), aliases));
  return messages;
}
