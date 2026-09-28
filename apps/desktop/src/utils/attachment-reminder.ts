/**
 * "You wrote 'attached' but attached nothing" — the check that runs before a
 * message leaves the composer.
 *
 * Hand-rolled rather than a library: there is no maintained package for this
 * one product question, and the patterns are a short fixed word list with
 * word boundaries and no nested quantifiers, so they run in linear time on any
 * input. Kept pure so every phrase and exclusion below is pinned by a test.
 */
import { requestConfirm } from '../store/confirm-service';

import { readAppSettings } from './app-settings';

/** Words that say a file is (or should be) riding along. */
const MENTION_RE = /\b(attach(?:ed|es|ing|ment|ments)?|enclos(?:ed|ing|ure|ures)|pfa)\b/i;

/**
 * Phrases that mention an attachment only to say there is none — "no
 * attachment", "without attachments", "not attached". Removed before the
 * mention check so they never raise the prompt.
 */
const NEGATED_RE = /\b(?:no|without|not)\s+(?:an?\s+|any\s+|the\s+)?attach\w*/gi;

/** A plain-text quote line ("> earlier message") is someone else's words. */
const isQuotedLine = (line: string): boolean => line.trimStart().startsWith('>');

/** The user's own text with quoted lines and negated mentions taken out. */
function ownText(text: string): string {
  return text
    .split('\n')
    .filter((line) => !isQuotedLine(line))
    .join('\n')
    .replace(NEGATED_RE, ' ');
}

/**
 * The first word in `text` that promises an attachment, or null. Returned
 * rather than a boolean so the prompt can quote what the user actually wrote.
 */
export function findAttachmentMention(text: string | null | undefined): string | null {
  if (!text) return null;
  return ownText(text).match(MENTION_RE)?.[1] ?? null;
}

export interface OutgoingForAttachmentCheck {
  subject: string;
  /** The user's plain-text body, WITHOUT the quoted original or signature. */
  body: string;
  attachmentCount: number;
  /**
   * Whether the subject is the user's own. A reply or forward inherits it,
   * and "Re: Report attached" must not flag every "thanks!" in that thread.
   */
  subjectIsOwn: boolean;
}

/**
 * The word to warn about, or null when the message is fine to send: it has
 * an attachment, or nothing in the user's own words mentions one.
 */
export function missingAttachmentMention(mail: OutgoingForAttachmentCheck): string | null {
  if (mail.attachmentCount > 0) return null;
  return findAttachmentMention(mail.body) ?? (mail.subjectIsOwn ? findAttachmentMention(mail.subject) : null);
}

export interface AttachmentCheckDeps {
  /** The Settings > General switch. Off means never ask. */
  enabled: boolean;
  /** Shows the prompt; resolves true for "Send anyway". */
  ask: (opts: {
    title: string;
    message: string;
    confirmLabel: string;
    cancelLabel: string;
    destructive: boolean;
  }) => Promise<boolean>;
}

/**
 * Whether the send should go ahead. Resolves true straight away when there is
 * nothing to warn about, otherwise asks. Every composer calls this before it
 * closes or marks its draft sent, so answering "Go back" leaves the message
 * exactly as it was.
 */
export async function confirmAttachmentBeforeSend(
  mail: OutgoingForAttachmentCheck,
  { enabled, ask }: AttachmentCheckDeps,
): Promise<boolean> {
  if (!enabled) return true;
  const mention = missingAttachmentMention(mail);
  if (!mention) return true;
  return ask({
    title: 'Send without an attachment?',
    message: `Your message says “${mention}”, but nothing is attached.`,
    confirmLabel: 'Send anyway',
    cancelLabel: 'Go back',
    destructive: false,
  });
}

/** {@link confirmAttachmentBeforeSend} wired to the stored setting and the app-wide dialog. */
export const checkAttachmentBeforeSend = (mail: OutgoingForAttachmentCheck): Promise<boolean> =>
  confirmAttachmentBeforeSend(mail, { enabled: readAppSettings().attachmentReminder, ask: requestConfirm });
