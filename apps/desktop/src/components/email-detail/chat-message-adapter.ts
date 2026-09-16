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
import { isConversationalThread, type Attachment, type ChatMessage } from '@sarv-in/email-chat-view';
import {
  createSegmentCache,
  looksDesigned,
  threadToMessages,
  type Mail,
  type SegmentCache,
} from '@sarv-in/email-chat-view/transform';
import type { EmailRecord } from '@sarvinbox/core';
// Deep import, not the barrel: the core barrel pulls in imapflow/mailparser and
// crashes the renderer on startup. See `vite/renderer-aliases.ts`.
import { isBulkMail } from '@sarvinbox/core/bulk-mail';

import type { ConversationMessage } from '../../services/conversation-service';

import { inlineDocumentStyles } from './chat-body-styles';
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
  const me = normalizedAddress(currentUserEmail);
  if (!me || me.includes(',')) return false;
  return normalizedAddress(fromAddress) === me;
}

/** An address as it is COMPARED: trimmed and lowercased, never parsed. */
function normalizedAddress(value: string | null | undefined): string {
  return (value || '').trim().toLowerCase();
}

/**
 * The stored email a bubble may act ON — its own mail, never one that merely
 * quoted it.
 *
 * `sourceId` names the mail a bubble was carved out of, and for a message
 * recovered from a quote that is the CARRIER: the later reply that happened to
 * contain it. Reading the email straight back out of it hands the quoted
 * author's bubble the carrier's attachments, the carrier's star and the
 * carrier's menu — so the reader downloads a file that bubble never carried,
 * and stars, archives or deletes a mail they are not looking at.
 *
 * A bubble is a mail's own turn when it IS the mail — the split's own segment
 * keeps the mail's id, a recovered quote gets an id derived from it — or, for
 * an LLM-extracted turn whose id is the model's, when the two agree on who
 * wrote it. Anything else is somebody else's message passing through this
 * mail, and it gets no email at all: no attachments, no actions.
 *
 * Known gap: a mail quoting an EARLIER mail of its own sender passes the
 * sender test, so that bubble can still show the carrier's attachments. It is
 * the one shape these two rules cannot separate, and most of those bubbles are
 * removed by {@link dropDuplicateQuotes} before anything renders them.
 */
/**
 * The stored email a bubble's HTML ARRIVED in — the carrier, quote or not.
 *
 * The other half of {@link ownerEmailOf}, and the distinction is the point. Who
 * a bubble belongs to decides what may be done to it (star, reply, delete) and
 * what hangs off it (the attachment strip). Which mail its bytes came out of
 * decides whether those bytes may reach the network: a quoted message's images
 * live in the reply that carried it, so it is that mail's sender the reader
 * chose to trust or not.
 */
export function carrierEmailOf(
  message: Pick<ChatMessage, 'id' | 'sourceId'>,
  emailsById: ReadonlyMap<string, EmailRecord>
): EmailRecord | undefined {
  return emailsById.get(message.sourceId || message.id);
}

export function ownerEmailOf(
  message: Pick<ChatMessage, 'id' | 'sourceId' | 'fromAddress'>,
  emailsById: ReadonlyMap<string, EmailRecord>
): EmailRecord | undefined {
  const email = emailsById.get(message.sourceId || message.id);
  if (!email) return undefined;
  if (email.id === message.id) return email;
  return normalizedAddress(message.fromAddress) === normalizedAddress(email.fromAddress)
    ? email
    : undefined;
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

/**
 * The `applied` entry on a bubble whose body was NOT shaped by anything.
 *
 * `applied` is the library's audit trail of which rules touched a body; an
 * as-sent bubble's trail is that none did. It reaches the DOM as
 * `data-sec-applied`, which is the only per-bubble hook the app has for
 * styling one — see `chat-view-theme.css`.
 */
export const AS_SENT_MARKER = 'as-sent';

/** Distinct sender addresses in a thread, unsent drafts excluded. */
function distinctSenderCount(emails: readonly EmailRecord[]): number {
  const drafts = draftIdsIn(emails);
  const senders = new Set<string>();
  for (const email of emails) {
    if (drafts.has(email.id)) continue;
    senders.add((email.fromAddress || '').trim().toLowerCase());
  }
  return senders.size;
}

/**
 * Which of a thread's mails must reach the reader EXACTLY as they were sent.
 *
 * A designed body owns its own layout: unwrapping its structure, cutting the
 * blocks that read like a signature, or normalizing its fonts turns a
 * notification into a wireframe — the Keka digest lost its whole footer table,
 * logo and QR code to one `signature:logo-strip`, and a login alert lost its
 * header card and the striping that made its detail rows readable. The library
 * says so itself (see its `looksDesigned` docblock) but never checks it
 * internally, so the host has to.
 *
 * THREE conditions, all required, and the order is the point:
 *
 * 1. The body is designed ({@link looksDesigned}) — deliberately the cheap
 *    string test first, so ordinary typed mail never reaches rule 2.
 * 2. The mail is machine-sent ({@link isBulkMail}), which is the rule that
 *    actually decides: `looksDesigned` is true of any mail carrying one image,
 *    a signature logo included.
 * 3. The whole thread has ONE sender, which is the outer guard and the reason
 *    the two rules above are allowed to be as blunt as they are. Rules 1 and 2
 *    are both fallible: `looksDesigned` fires on a signature logo, and the
 *    `|bulk|` tag comes from headers a corporate mail server can set on an
 *    ordinary person's reply. Dropping this gate — on the theory that a
 *    notification threaded beside a human reply is still a notification — put a
 *    plain two-line reply with a Sarv signature into the as-sent path, and it
 *    reached the reader as its full raw source, quoted history and all, beside
 *    the clean bubble of the same message. A thread is answered as a whole: the
 *    moment anybody has replied, it is a conversation and gets the chat
 *    treatment, all of it.
 */
export function asSentEmailIds(emails: readonly EmailRecord[]): Set<string> {
  const ids = new Set<string>();
  if (emails.length === 0 || distinctSenderCount(emails) > 1) return ids;
  for (const email of emails) {
    const body = bodyOf(email);
    if (!looksDesigned(body)) continue;
    const bulk = isBulkMail({
      tags: email.tags,
      fromAddress: email.fromAddress,
      messageId: email.messageId,
      rawBody: body,
    });
    if (bulk) ids.add(email.id);
  }
  return ids;
}

/**
 * The bubble that IS the mail, among the turns its split produced.
 *
 * The library hands a turn it RECOVERED out of a body an id of `<mailId>#n` and
 * records the mail it came from in `sourceId`; the mail's own turn keeps the
 * mail's id. So the turn whose own id is the mail id is the mail itself, and
 * the first turn is the fallback for a shape that never appears today.
 */
function ownTurnIds(
  messages: readonly ChatMessage[],
  mailIds: ReadonlySet<string>
): Map<string, string> {
  const own = new Map<string, string>();
  for (const message of messages) {
    const mailId = message.sourceId ?? message.id;
    if (!mailIds.has(mailId)) continue;
    if (message.id === mailId || !own.has(mailId)) own.set(mailId, message.id);
  }
  return own;
}

/**
 * Put the original HTML back on the bubbles that must show it verbatim.
 *
 * A body swap rather than a second render path: the bubble, its header, its
 * attachments, its actions and its date grouping all stay exactly what they
 * were, which is what "just inside the chat" means. Everything else in the
 * thread is untouched.
 *
 * Where the split turned one of these mails into SEVERAL turns, the extra turns
 * are dropped rather than the mail being left alone. Both are ways of refusing
 * to show the same content twice, but only this one shows it correctly once:
 * the restored body is the whole mail, so every turn carved out of it is
 * already inside the bubble. Skipping instead was how a login alert — one mail
 * the splitter read as quoting itself — reached the reader as two mangled
 * copies of itself.
 */
function restoreAsSentBodies(
  messages: readonly ChatMessage[],
  emails: readonly EmailRecord[]
): ChatMessage[] {
  const asSent = asSentEmailIds(emails);
  if (asSent.size === 0) return [...messages];

  const bodyById = new Map(emails.map((email) => [email.id, bodyOf(email)]));
  const ownTurn = ownTurnIds(messages, asSent);

  const kept: ChatMessage[] = [];
  for (const message of messages) {
    const mailId = message.sourceId ?? message.id;
    if (!asSent.has(mailId)) {
      kept.push(message);
      continue;
    }
    if (ownTurn.get(mailId) !== message.id) continue;
    // `applied` is REPLACED, not appended to: whatever the split reported it
    // had done to this body is no longer true of what the reader sees.
    kept.push({
      ...message,
      body: bodyById.get(mailId) ?? message.body,
      applied: [AS_SENT_MARKER],
    });
  }
  return kept;
}

/**
 * How much of a message is compared when asking "is this the same message?".
 *
 * The library's own dedupe normalizes a body to its letters and digits, cuts
 * it to 150 of them and compares the two keys for EQUALITY. Equality is an
 * anchored test, and anchoring is what fails here: the copy a client quoted
 * back routinely loses (or gains) a leading "TCS Confidential" banner that the
 * original kept, and fifteen characters at the front make the two keys differ
 * from the first one. The thread then shows the message twice — once as it was
 * sent, once as it was quoted — grouped under a single sender header, which
 * reads as the app having duplicated it.
 *
 * So: the same key, searched for UNANCHORED. One side's first 150 characters
 * against the whole of the other's.
 */
const DEDUPE_KEY_CHARS = 150;

/**
 * The shortest normalized body an unanchored compare may act on.
 *
 * "Thanks!" and "Ok, will do" are written by everyone in every thread, and
 * containment over a handful of characters would fold genuinely separate turns
 * into one. A message quietly missing from a thread is far worse than one shown
 * twice, so below this length only the library's own exact-key rule applies.
 */
const MIN_DEDUPE_CHARS = 40;

/**
 * A body reduced to what survives being quoted: its letters and digits.
 *
 * Deliberately the same normalization the library's `contentKey` performs —
 * tags, entities and punctuation all go, so `&nbsp;` for a space, a mention
 * rendered as a link in one copy and as plain text in the other, and a
 * re-wrapped line all collapse to the same string. Hand-written for the single
 * reason the library's export could not be reused: it returns the TRUNCATED
 * key, and what is needed here is the untruncated haystack to search it in.
 *
 * One step further than the library's, deliberately: NUMERIC entities go too.
 * `&#8203;` is a zero-width space — invisible, and freely sprinkled by Outlook
 * and by rich-text editors — and dropping only the named entities leaves `8203`
 * sitting in the middle of the text, which is enough to make two copies of one
 * message compare as different.
 */
export function normalizedContent(html: string): string {
  return (html || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&#x?[0-9a-f]+;/gi, ' ')
    .replace(/&[a-z]+;/gi, ' ')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

/** Whether two normalized bodies are the same message, one of them quoted. */
function isSameMessage(left: string, right: string): boolean {
  if (left.length < MIN_DEDUPE_CHARS || right.length < MIN_DEDUPE_CHARS) return false;
  return (
    right.includes(left.slice(0, DEDUPE_KEY_CHARS)) ||
    left.includes(right.slice(0, DEDUPE_KEY_CHARS))
  );
}

/**
 * Drop a recovered quote that is a copy of a message the thread already shows.
 *
 * Runs over the library's own dedupe rather than replacing it: that one catches
 * the copies that quoted cleanly, this one catches the copies whose opening
 * moved — see {@link DEDUPE_KEY_CHARS}.
 *
 * Only quotes are ever dropped. A stored mail is a fact and always renders,
 * even when another mail in the thread repeats it word for word.
 */
export function dropDuplicateQuotes(messages: readonly ChatMessage[]): ChatMessage[] {
  // A recovered quote carries the id of the mail it was carved out of; a mail's
  // own turn carries none. That is the only thing separating the two here.
  const seen = messages
    .filter((message) => !message.sourceId)
    .map((message) => normalizedContent(message.body));
  return messages.filter((message) => {
    if (!message.sourceId) return true;
    const content = normalizedContent(message.body);
    if (seen.some((each) => isSameMessage(content, each))) return false;
    // A kept quote joins the haystack, so one message quoted by three separate
    // replies is recovered once and not three times.
    seen.push(content);
    return true;
  });
}

export function chatMessagesFromThread(
  emails: readonly EmailRecord[],
  options: ThreadOptions,
): ChatMessage[] {
  const { resolveImages } = options;
  // Deduped BEFORE the as-sent restore, never after: the restore puts a bulk
  // mail's RAW html back on its bubble, quoted history included, and a
  // haystack carrying quoted history would swallow every genuine recovered
  // message in it.
  const messages = restoreAsSentBodies(dropDuplicateQuotes(splitThread(emails, options)), emails);
  // Image refs are resolved AFTER the split, not before: the raw body carries
  // the whole quoted history, most of which is about to be thrown away, and
  // inlining every image in it first is work nobody sees.
  //
  // The stylesheet is written onto the mail in the same pass, and before the
  // refs are resolved so a rule pointing at an inline image is resolved along
  // with the rest. A body that neither step changes is handed back as the same
  // object, so nothing downstream re-renders for a mail nothing happened to.
  //
  // `isConversationalThread` is asked here for the same reason the view asks it:
  // it decides whether a bare layout table reads as design or as a sign-off
  // wrapper, and so whether a body is framed at all. Asking the same question
  // the same way is what keeps the two from disagreeing about one mail.
  const conversational = isConversationalThread(messages);
  return messages.map((message) => {
    const inlined = inlineDocumentStyles(message.body, conversational);
    const body = resolveImages ? resolveImages(inlined) : inlined;
    return body === message.body ? message : { ...message, body };
  });
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
