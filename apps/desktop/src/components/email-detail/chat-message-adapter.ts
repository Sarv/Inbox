/**
 * sarvinbox's stored mail, in the shape `email-chat-view` renders.
 *
 * The library knows nothing about EmailRecord, ConversationMessage, the AI
 * pipeline or the image cache — it renders `ChatMessage[]` and leaves where
 * they came from entirely to the host. This module IS that boundary, and it is
 * deliberately pure: no React, no store, no I/O, so every rule below (drafts,
 * seconds-vs-milliseconds, attribution, the pending/failed states) is directly
 * unit-testable without mounting anything.
 */
import type { EmailRecord } from '@sarvinbox/core';
import type { Attachment, ChatMessage } from 'email-chat-view';

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

export interface AdapterOptions {
  /** The reader's own address, for attribution. */
  currentUserEmail: string;
  /** Every email in the thread, for attachments and body state. */
  emailsById: ReadonlyMap<string, EmailRecord>;
  /** Ids whose body fetch permanently failed — retry, never an endless spinner. */
  failedBodies?: ReadonlySet<string>;
  /** Resolve `sarv-image:` refs to data URLs. Injected so this module stays pure. */
  resolveImages?: (html: string) => string;
}

/** Chronological, drafts dropped. Progressive extraction appends out of order. */
function chronological<T extends { date: number }>(messages: readonly T[]): T[] {
  return [...messages].sort((left, right) => (left.date || 0) - (right.date || 0));
}

/**
 * The AI / deterministic conversation, as chat messages.
 *
 * Both view modes arrive here: the AI pipeline and
 * `buildDeterministicConversation` produce the same `ConversationMessage`
 * shape, which is exactly why the view needs no mode of its own.
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
 * The thread's emails, as chat messages.
 *
 * The fallback for a thread the conversation pipeline produced nothing for —
 * one email, no quotes to split, or an extraction that has not run yet. Bodies
 * are passed through untouched: whatever stripping was wanted has already
 * happened upstream, and stripping again here would be a second, drifting copy
 * of that logic.
 */
export function chatMessagesFromEmails(
  emails: readonly EmailRecord[],
  options: AdapterOptions,
): ChatMessage[] {
  const { currentUserEmail, failedBodies, resolveImages } = options;
  const drafts = draftIdsIn(emails);

  return chronological(emails.filter((email) => !drafts.has(email.id))).map((email) => {
    const body = email.rawBody || email.cleanBody || '';
    return {
      id: email.id,
      sourceId: email.id,
      fromAddress: email.fromAddress,
      fromName: email.fromName,
      toAddress: email.toAddress,
      toNames: email.toNames,
      ccAddress: email.ccAddress,
      ccNames: email.ccNames,
      date: toEpochMs(email.date),
      body: resolveImages ? resolveImages(body) : body,
      attachments: attachmentsOf(email),
      isFromMe: isFromMe(email.fromAddress, currentUserEmail),
      ...bodyStateOf(body, email, failedBodies),
    };
  });
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
