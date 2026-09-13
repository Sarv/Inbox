/**
 * sarvinbox's stored mail, in the shape `@sarv-in/email-chat-view` renders.
 *
 * The library knows nothing about EmailRecord, ConversationMessage, the AI
 * pipeline or the image cache — it renders `ChatMessage[]` and leaves where
 * they came from entirely to the host. This module IS that boundary, and it is
 * deliberately pure: no React, no store, no I/O, so every rule below (drafts,
 * seconds-vs-milliseconds, attribution, the pending/failed states) is directly
 * unit-testable without mounting anything.
 */
import type { Attachment, ChatMessage } from '@sarv-in/email-chat-view';
import {
  createSegmentCache,
  threadToMessages,
  type Mail,
  type SegmentCache,
} from '@sarv-in/email-chat-view/transform';
import type { EmailRecord } from '@sarvinbox/core';

import type { ConversationMessage } from '../../services/conversation-service';

import { parseAttachments } from './utils';

/**
 * Whether a message was sent BY the current user (→ right-aligned bubble).
 *
 * `currentUserEmail` is normally the IMAP username (a single address). When it
 * could not be resolved it falls back to the displayed email's recipient LIST
 * (comma-separated) — which is not an identity, so nothing is attributed in
 * that case and every bubble goes left. Mislabelling someone else's message as
 * yours is a much worse error than a thread that is flat on one side.
 */
export function isFromMe(
  fromAddress: string | null | undefined,
  currentUserEmail: string,
): boolean {
  const me = (currentUserEmail || '').trim().toLowerCase();
  if (!me || me.includes(',')) return false;
  return (fromAddress || '').trim().toLowerCase() === me;
}

/**
 * Ids of unsent drafts in this thread.
 *
 * A Gmail draft shares its thread's id, so it is pulled into the thread and
 * would otherwise render as a bubble that looks like you already replied.
 */
export function draftIdsIn(emails: readonly EmailRecord[]): Set<string> {
  return new Set(
    emails.filter((email) => (email.tags || '').includes('|draft|')).map((email) => email.id),
  );
}

/**
 * sarvinbox stores dates in SECONDS; the library takes MILLISECONDS.
 *
 * Getting this wrong does not throw — it puts the whole thread in January 1970
 * and every date separator reads the same. Anything unusable is passed through
 * as NaN, which the library already renders as its unknown-date group rather
 * than crashing on `new Date(NaN).toISOString()`.
 */
export function toEpochMs(seconds: number | null | undefined): number {
  return typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0
    ? seconds * 1000
    : Number.NaN;
}

/**
 * The library's MILLISECONDS, back in the SECONDS everything sarv-side stores.
 *
 * The mirror of {@link toEpochMs}, for handing a transformed message to
 * something that reads stored rows — the AI summarizer, an extension. An
 * unreadable date becomes `0` rather than `NaN`, because `NaN` does not survive
 * JSON and would reach the other side as `null` in a numeric field.
 */
export function toEpochSeconds(millis: number): number {
  return Number.isFinite(millis) && millis > 0 ? Math.round(millis / 1000) : 0;
}

/** The stored attachment columns, as the library's attachment shape. */
export function attachmentsOf(email: EmailRecord | undefined): Attachment[] {
  if (!email) return [];
  return parseAttachments(email.attachmentNames, email.attachmentSizes).map((attachment) => ({
    filename: attachment.name,
    // The store records no MIME type, so the library falls back to the
    // extension for the preview decision. `undefined`, never `null`: the
    // library treats an absent size as "unknown" and renders no size at all.
    ...(attachment.size != null ? { sizeBytes: attachment.size } : {}),
  }));
}

/** What the library needs from the app to turn stored rows into bubbles. */
export interface ThreadOptions {
  /** The reader's own address, for attribution. */
  currentUserEmail: string;
  /** Ids whose body fetch permanently failed — retry, never an endless spinner. */
  failedBodies?: ReadonlySet<string>;
  /** Resolve `sarv-image:` refs to data URLs. Injected so this module stays pure. */
  resolveImages?: (html: string) => string;
}

export interface AdapterOptions extends ThreadOptions {
  /** Every email in the thread, for attachments and body state. */
  emailsById: ReadonlyMap<string, EmailRecord>;
}

/**
 * Stored emails, in the shape the library's transform reads.
 *
 * A straight field rename plus the two things the store keeps elsewhere: a
 * draft is a `|draft|` tag rather than a column, and "the body has not arrived"
 * is the failed-bodies set rather than a flag. Everything past this function —
 * splitting, cleaning, attribution, ordering, drafts, attachments — is the
 * library's, so there is exactly one place where sarvinbox's storage shape is
 * described to it.
 */
/**
 * The stored body the transform reads: the original HTML, or the stripped
 * preview text when that is all there is.
 *
 * Shared rather than repeated because {@link threadSegmentCache} is keyed on
 * this exact string. A second copy of the expression that drifted would turn
 * every warmed entry into a miss, and a miss is invisible — the view simply
 * pays for the split again.
 */
export function bodyOf(email: EmailRecord): string {
  return email.rawBody || email.cleanBody || '';
}

export function mailsFromEmails(
  emails: readonly EmailRecord[],
  failedBodies?: ReadonlySet<string>,
): Mail[] {
  const drafts = draftIdsIn(emails);
  return emails.map((email) => {
    const body = bodyOf(email);
    return {
      id: email.id,
      fromAddress: email.fromAddress || '',
      fromName: email.fromName,
      toAddress: email.toAddress,
      toNames: email.toNames,
      ccAddress: email.ccAddress,
      ccNames: email.ccNames,
      // SECONDS, as stored. Declared to the transform as `dateUnit: 's'` — it
      // converts once, at the boundary, and nothing downstream sees seconds.
      date: email.date,
      body,
      attachments: attachmentsOf(email),
      isDraft: drafts.has(email.id),
      ...bodyStateOf(body, email, failedBodies),
    };
  });
}

/**
 * A shared memo for split bodies.
 *
 * Splitting is the expensive half of this — a parse, a boundary sweep and a
 * clean per segment — and the transform re-runs on every body that arrives,
 * which for a 200-message thread is 200 times. Keyed on `(id, body)`, so a
 * message whose body finally lands is the only one re-split.
 */
export const threadSegmentCache: SegmentCache = createSegmentCache();

/**
 * The thread's emails, split into one bubble per MESSAGE.
 *
 * This is the whole Standard view: the library recovers the messages that exist
 * only as quotes inside other mails, strips signatures, banners and quoted
 * history, and orders the result. sarvinbox contributes two things it alone
 * knows — how its rows are shaped ({@link mailsFromEmails}) and how to turn a
 * `sarv-image:` ref into something a browser can render.
 */
/**
 * The thread's mails through the library's split, with nothing done to the
 * result.
 *
 * The single description of sarvinbox's thread to the transform, so the render
 * path and the background warm below cannot ask for different work and miss
 * each other's cache entries.
 */
function splitThread(emails: readonly EmailRecord[], options: ThreadOptions): ChatMessage[] {
  return threadToMessages(mailsFromEmails(emails, options.failedBodies), {
    currentUserAddress: options.currentUserEmail,
    dateUnit: 's',
    cache: threadSegmentCache,
  });
}

export function chatMessagesFromThread(
  emails: readonly EmailRecord[],
  options: ThreadOptions,
): ChatMessage[] {
  const { resolveImages } = options;
  const messages = splitThread(emails, options);
  // Image refs are resolved AFTER the split, not before: the raw body carries
  // the whole quoted history, most of which is about to be thrown away, and
  // inlining every image in it first is work nobody sees.
  if (!resolveImages) return messages;
  return messages.map((message) => ({ ...message, body: resolveImages(message.body) }));
}

/** Whether this email's body has already been split and is still cached. */
export function isThreadSegmentWarm(email: EmailRecord): boolean {
  const body = bodyOf(email);
  return body !== '' && threadSegmentCache.get(email.id, body) !== undefined;
}

/**
 * Split a slice of a thread into the shared cache, and throw the result away.
 *
 * The chat view's first render is one synchronous {@link chatMessagesFromThread}
 * on the main thread: a parse, a boundary sweep and a clean for every mail in
 * the thread. On a long one that is felt as a hang on the click that opens it.
 * Running the same split ahead of time, a few mails at a time while the reader
 * is still in the standard view, moves the cost off the click — the view's own
 * call finds every segment already in {@link threadSegmentCache} and returns.
 *
 * Takes a SLICE rather than the whole thread because the point is to hand the
 * main thread back between chunks. Splitting mail by mail is valid because the
 * cache key is per mail and a mail's segments never depend on its neighbours.
 *
 * `failedBodies` is deliberately not a parameter: it decides only the
 * pending/failed flags on the rendered bubble, never the split, so warming
 * without it produces exactly the entries the render will look for.
 */
export function warmThreadSegments(
  emails: readonly EmailRecord[],
  options: Pick<ThreadOptions, 'currentUserEmail'>,
): void {
  if (emails.length === 0) return;
  splitThread(emails, { currentUserEmail: options.currentUserEmail });
}

/** Chronological, drafts dropped. Progressive extraction appends out of order. */
function chronological<T extends { date: number }>(messages: readonly T[]): T[] {
  return [...messages].sort((left, right) => (left.date || 0) - (right.date || 0));
}

/**
 * The LLM-extracted conversation, as chat messages.
 *
 * The AI path only. The Standard view no longer passes through
 * `ConversationMessage` at all — {@link chatMessagesFromThread} hands the
 * library stored rows and gets bubbles back — so this is the one remaining
 * adapter for turns a model produced.
 */
export function chatMessagesFromConversation(
  messages: readonly ConversationMessage[],
  options: AdapterOptions,
): ChatMessage[] {
  const { currentUserEmail, emailsById, failedBodies, resolveImages } = options;
  const drafts = draftIdsIn([...emailsById.values()]);

  return chronological(messages.filter((message) => !drafts.has(message.sourceEmailId))).map(
    (message) => {
      const source = emailsById.get(message.sourceEmailId);
      const body = message.body || '';
      return {
        id: message.id,
        sourceId: message.sourceEmailId,
        fromAddress: message.fromAddress,
        fromName: message.fromName,
        toAddress: message.toAddress,
        ccAddress: source?.ccAddress ?? null,
        ccNames: source?.ccNames ?? null,
        date: toEpochMs(message.date),
        body: resolveImages ? resolveImages(body) : body,
        attachments: attachmentsOf(source),
        isFromMe: isFromMe(message.fromAddress, currentUserEmail),
        // An extracted turn has no body of its own to download: it was carved
        // out of a source email that is already here. Only a message backed by
        // an email whose body never arrived can be pending or failed.
        ...bodyStateOf(body, source, failedBodies),
      };
    },
  );
}

/**
 * Pending vs failed vs arrived, for one body.
 *
 * A body that is simply empty is NOT pending — plenty of real mail has no
 * content — so the spinner is reserved for an email the store knows has a body
 * it has not fetched yet. A permanent failure wins over pending, because a
 * spinner that never stops is the state the reader cannot act on.
 */
function bodyStateOf(
  body: string,
  source: EmailRecord | undefined,
  failedBodies?: ReadonlySet<string>,
): Pick<ChatMessage, 'bodyPending' | 'bodyFailed'> {
  if (body || !source) return {};
  if (failedBodies?.has(source.id)) return { bodyFailed: true };
  return { bodyPending: true };
}
