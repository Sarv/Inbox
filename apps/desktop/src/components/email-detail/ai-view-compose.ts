/**
 * The chat view's AI mode, as pure functions: Standard's bubbles as they are,
 * except the thread's FIRST email, whose quoted history the AI split into the
 * messages it quotes.
 *
 * Why only the first email. A looped-in recipient's earlier conversation lives
 * in exactly one place: the quoted history of the first email they received.
 * Every later mail's history repeats messages the thread already shows, so
 * Standard's deterministic split handles those; the first email is the one
 * place where a missed attribution line (a localized client, a mangled
 * Outlook header) means whole messages are unreachable. So the AI is spent on
 * that email only, and everything else in the AI view is the Standard view's
 * own bubble — the SAME object (reference-equal), never a re-derivation.
 *
 * Pure: no React, no store, no I/O. The cached split parts come in from the
 * caller (`first_email_splits`, via main), as do Standard's turns.
 */
import { hasGlobalDomParser, type ChatMessage } from '@sarv-in/email-chat-view/transform';
import type { EmailRecord } from '@sarvinbox/core';
import type { FirstSplitPart } from '@sarvinbox/core/first-split';
import { quoteMarkerCount } from '@sarvinbox/core/quoted-text';

import {
  attachmentsOf,
  isAsSentMail,
  isFromMe,
  isSameContent,
  normalizedContent,
  splitThread,
  toEpochMs,
  type StandardTurns,
} from './chat-message-adapter';
import { sortTurns } from './turn-order';

/** `applied` on a bubble the AI split produced — the audit trail says so. */
export const AI_SPLIT_MARKER = 'ai-split';
/** `applied` on a split part that is Standard's rendering of a region the AI did not cover. */
export const AI_SPLIT_FALLBACK_MARKER = 'ai-split:fallback';

/** How much of a later copy an AI part must hold to stand in for it… */
const COVER_MIN_SHARE = 0.9;
/** …or the copy's closing characters (normalized) it must contain. */
const COVER_TAIL_CHARS = 60;

/**
 * Does a split part (`covering`, normalized) show ALL of a later mail's quoted
 * copy (`covered`)? The same message by {@link isSameContent}, AND long
 * enough to hold it — at least {@link COVER_MIN_SHARE} of it, or its closing
 * characters. The containment rule alone says yes for a part that keeps only
 * the message's first sentence, and the later mail's full copy would then be
 * hidden behind the cut one.
 */
export function coversContent(covering: string, covered: string): boolean {
  return isSameContent(covering, covered)
    && (covering.length >= COVER_MIN_SHARE * covered.length || covering.includes(covered.slice(-COVER_TAIL_CHARS)));
}

/**
 * What the chat rules need to know about the thread's first email.
 *
 * `unknown` is its own answer, never 0: the body has not arrived (or there is
 * no DOM to split it with), and "we don't know yet" read as "quotes nothing"
 * would decide the email is ordinary mail — no chat offered, no AI — for good.
 */
export type FirstEmailFacts =
  | { kind: 'unknown' }
  | {
    kind: 'known';
    /** Designed bulk mail from a single sender — shown as sent, never split. */
    asSent: boolean;
    /** How many earlier messages the email quotes. */
    quoteCount: number;
    /**
     * Where the count came from: the structural split (`split`), or — when
     * that found no quoted turn — the text's attribution markers (`marker`).
     */
    countSource: 'split' | 'marker';
  };

/**
 * The first email's facts.
 *
 * `quoteCount` counts the turns the library's split carves out of this ONE
 * email (the {@link splitThread} of `[first]` — the same segment-cache entry
 * the Standard view and the chat prewarm fill), BEFORE the host's
 * `dropDuplicateQuotes`: that pass keeps whichever copy of a message sorts
 * first, and a later mail's approximately-dated copy can displace this
 * email's own, which would undercount it.
 *
 * When the split finds no quoted turn — plain text, a client whose markup it
 * does not recognise — the text's attribution markers are counted instead
 * (core `quoteMarkerCount`), so a plain-text looped-in chain is still offered.
 *
 * @param distinctSenders the thread's distinct senders (main's
 *   `FirstSplitCurrent.distinctSenders`), for the as-sent rule's "one sender".
 */
export function firstEmailFacts(
  first: EmailRecord | null | undefined,
  distinctSenders: number,
): FirstEmailFacts {
  // `rawBody` only: the stripped `cleanBody` has lost the quote structure, so
  // a count read from it would be a confident wrong answer.
  if (!first || !(first.rawBody ?? '').trim()) return { kind: 'unknown' };
  if (!hasGlobalDomParser()) return { kind: 'unknown' };

  if (isAsSentMail(first, distinctSenders)) {
    return { kind: 'known', asSent: true, quoteCount: 0, countSource: 'split' };
  }

  const quoted = splitThread([first], { currentUserEmail: '' })
    .filter((turn) => turn.sourceId === first.id).length;
  if (quoted > 0) return { kind: 'known', asSent: false, quoteCount: quoted, countSource: 'split' };

  const format = first.contentType === 'text' ? 'text' : 'html';
  return {
    kind: 'known',
    asSent: false,
    quoteCount: quoteMarkerCount(first.rawBody, format),
    countSource: 'marker',
  };
}

/**
 * How much AI the thread's first email deserves.
 *
 *   * `unknown` — its body is not here yet; decide nothing (never read as 0).
 *   * `none` — designed bulk mail (shown as sent), or it quotes nothing.
 *   * `on_demand` — it quotes ONE earlier message: the chat view is offered,
 *     the split runs only when the reader asks ("Process now").
 *   * `auto` — it quotes two or more: a looped-in history worth splitting as
 *     soon as the chat view shows it (and in the background, when enabled).
 */
export type AiEligibility = 'unknown' | 'none' | 'on_demand' | 'auto';

export function aiEligibilityFor(facts: FirstEmailFacts): AiEligibility {
  if (facts.kind === 'unknown') return 'unknown';
  if (facts.asSent) return 'none';
  if (facts.quoteCount >= 2) return 'auto';
  return facts.quoteCount === 1 ? 'on_demand' : 'none';
}

/** The mail a turn's HTML arrived in: its own mail, or the one that quoted it. */
function carrierIdOf(turn: Pick<ChatMessage, 'id' | 'sourceId'>): string {
  return turn.sourceId ?? turn.id;
}

/** A split part, as the bubble it becomes. Ids are derived here, never stored. */
function partTurn(
  part: FirstSplitPart,
  first: EmailRecord,
  quoteIndex: number | null,
  currentUserEmail: string,
): ChatMessage {
  const applied = [part.fallback ? AI_SPLIT_FALLBACK_MARKER : AI_SPLIT_MARKER];
  if (quoteIndex === null) {
    // The first email's OWN words: its id (so `ownerEmailOf` resolves the
    // email — its star, its menu, its attachments), its recipients.
    const fromAddress = part.fromAddress || first.fromAddress || '';
    const attachments = attachmentsOf(first);
    return {
      id: first.id,
      fromAddress,
      fromName: part.fromName ?? first.fromName ?? null,
      toAddress: first.toAddress ?? null,
      toNames: first.toNames ?? null,
      ccAddress: first.ccAddress ?? null,
      ccNames: first.ccNames ?? null,
      date: toEpochMs(part.date),
      body: part.body,
      ...(attachments.length > 0 ? { attachments } : {}),
      isFromMe: isFromMe(fromAddress, currentUserEmail),
      applied,
    };
  }
  // A message the first email QUOTES: somebody else's words passing through
  // it. `sourceId` routes it to its carrier; no recipients and no attachments
  // are claimed for it (the carrier's `To` is not who this message went to).
  // `#ai<k>` can never collide with the library's `#<n>`.
  return {
    id: `${first.id}#ai${quoteIndex}`,
    sourceId: first.id,
    fromAddress: part.fromAddress,
    fromName: part.fromName,
    toAddress: null,
    date: toEpochMs(part.date),
    ...(part.dateApprox ? { dateApprox: true } : {}),
    body: part.body,
    isFromMe: isFromMe(part.fromAddress, currentUserEmail),
    applied,
  };
}

/** What {@link composeAiTurns} composes from. */
export interface ComposeAiTurnsInput {
  /** Standard's turns for the thread's members ({@link threadTurns}). */
  standard: StandardTurns;
  /** The thread's first member — the email the split parts belong to. */
  first: EmailRecord;
  /** The cached split's parts, oldest first; null/empty means "no usable split". */
  parts: readonly FirstSplitPart[] | null | undefined;
  /** The reader's own address, for attribution. */
  currentUserEmail: string;
}

/**
 * The AI view's turns: Standard's, with the first email's slot replaced by its
 * split parts.
 *
 *   1. With no parts, this IS Standard's list — nothing to replace.
 *   2. Every turn NOT carried by the first email is Standard's own object, by
 *      reference. The one exception is a QUOTED copy (a later reply's quote)
 *      of something the first email carries — the first email's own split
 *      turns or the AI's parts: the first email always wins, because it is
 *      where that history is complete. This is what removes the duplicates
 *      Standard itself cannot: a later mail's approximately-dated copy that
 *      displaced the first email's, and the quotes a later mail's split
 *      recovered while the first email's body had not arrived.
 *   3. The first email's turns are replaced by the parts: its own words keep
 *      the email's id; each quoted message is `<id>#ai<k>`, carried by it. A
 *      quoted part that is another mail's OWN message is dropped — that mail
 *      already shows it, as a fact.
 *   4. Everything is sorted by the library's rule (unreadable dates last),
 *      the first email's parts ahead of other mails at an equal time.
 */
export function composeAiTurns(input: ComposeAiTurnsInput): ChatMessage[] {
  const { standard, first, parts, currentUserEmail } = input;
  if (!parts || parts.length === 0) return [...standard.turns];

  // (a) What the first email carries in Standard, before any dedupe.
  const firstKeys = standard.raw
    .filter((turn) => carrierIdOf(turn) === first.id)
    .map((turn) => normalizedContent(turn.body))
    .filter(Boolean);

  // Other mails' OWN messages — facts, which a quoted part never duplicates.
  const otherOwnKeys = standard.turns
    .filter((turn) => !turn.sourceId && turn.id !== first.id)
    .map((turn) => normalizedContent(turn.body))
    .filter(Boolean);

  // (b) The parts as bubbles.
  const aiTurns: ChatMessage[] = [];
  let quoteIndex = 0;
  for (const part of parts) {
    if (part.role === 'own') {
      aiTurns.push(partTurn(part, first, null, currentUserEmail));
      continue;
    }
    quoteIndex += 1;
    const key = normalizedContent(part.body);
    if (otherOwnKeys.some((own) => isSameContent(key, own))) continue;
    aiTurns.push(partTurn(part, first, quoteIndex, currentUserEmail));
  }
  const aiKeys = aiTurns.map((turn) => normalizedContent(turn.body)).filter(Boolean);

  // (c) Everything the first email does not carry, minus quoted copies of
  // what it does.
  const kept = standard.turns.filter((turn) => {
    if (carrierIdOf(turn) === first.id) return false;
    if (!turn.sourceId) return true;
    const key = normalizedContent(turn.body);
    return !firstKeys.some((each) => isSameContent(key, each))
      && !aiKeys.some((each) => coversContent(each, key));
  });

  // (d) The first email is the thread's earliest member, so at an equal time
  // its parts go first; the sort is stable.
  return sortTurns([...aiTurns, ...kept]);
}
