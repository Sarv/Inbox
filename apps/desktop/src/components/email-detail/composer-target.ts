/**
 * The inline composers' seed drafts, and which message they belong to.
 *
 * A seed — a draft reopened by Undo send, or the saved/AI draft auto-opened for
 * a thread — is written for ONE message: its recipients, its `Re:` subject, and
 * the Message-ID of the stored draft the composer will replace on save and
 * delete on discard. Handed to a composer opened on a different message, it
 * sends that message's reply to the wrong people, and discarding it deletes a
 * draft that belongs to another reply. Kept pure so the rule is tested without
 * mounting the reading pane.
 */

/** A seed draft, recorded with the message it was written for. */
export interface ComposerSeed<D> {
  /** Row id of the message the draft answers (or forwards). A row id, not a
   *  Message-ID: one mail delivered to two of the reader's accounts is two
   *  rows, and the stored draft lives in ONE account's mailbox. */
  forEmailId: string;
  draft: D;
}

/** The message a composer is open on — only its identity matters here. */
interface ComposerTarget {
  id: string;
}

/**
 * The draft to hand the composer that is open on `target`: the seed's, if the
 * seed was written for that very message — otherwise none.
 *
 * The seed itself is NOT dropped when the composer moves to another message.
 * Reply → Forward → Reply on the same message must come back to the draft it
 * started from: that draft's Message-ID is what the reply replaces on save and
 * deletes on send, and a reply reopened without it wrote a second draft and
 * left the first behind in Drafts after the send. Owner-matching is what keeps
 * it away from every OTHER message's composer in the meantime.
 */
export function composerDraftFor<D>(
  seed: ComposerSeed<D> | undefined,
  target: ComposerTarget | null | undefined,
): D | undefined {
  return seed && target && seed.forEmailId === target.id ? seed.draft : undefined;
}
