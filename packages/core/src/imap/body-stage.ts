/**
 * The body stage: everything a message's CONTENT can decide, in one place.
 *
 * The header stage ({@link headerStage}) scores what the envelope and the
 * trace say. This scores what the message actually contains — the sender's own
 * words and links, and the files attached to them — and adds to that verdict.
 * Neither replaces the other: they are evidence about the same message, which
 * is why both go through `mergeAssessments` and neither adds numbers by hand.
 *
 * WHY IT IS SEPARATE FROM THE HEADER STAGE. Bodies arrive later here, and
 * usually much later. A sync fetches headers; the body is downloaded on demand
 * or by the prefetch scheduler, minutes or days afterwards. So the two stages
 * run at different times, against different inputs, on different code paths —
 * and the body stage has to be able to update a verdict that is already
 * stored, which the header stage never does.
 *
 * WHY RE-SCORING REPLACES RATHER THAN APPENDS. A body can be fetched more than
 * once: a re-open after the row was relinked, a charset repair, a re-resolve
 * after a UID went stale. Appending the content reasons each time would charge
 * the same rule twice and quietly push an ordinary message over the spam line
 * — a bug that looks like nothing at all in a total. {@link rescoreWithBody}
 * therefore drops the previous body reasons (by the library's own stage table,
 * so a rule renamed or added upstream cannot silently escape the filter) and
 * merges the fresh ones in. Running it ten times leaves the same score as
 * running it once.
 *
 * WHAT IT DELIBERATELY DOES NOT DO: decide where the message is filed. The
 * caller owns that, because filing needs the folder list and the filter engine
 * and — unlike a score — it moves mail out from under a reader who may have
 * just opened it.
 */
import {
  assessContentSignals,
  assessmentOf,
  mergeAssessments,
  parseSpamReasons,
  stageOfReason,
  type SpamAssessment,
} from '@sarv-in/mailguard';

/** A parsed body in the shape this app stores it. */
export interface BodyStageInput {
  /** The Subject line — scored with the body, because the sender wrote it too. */
  subject?: string | null;
  /** `emails.clean_body`: the plain-text rendering. */
  cleanBody?: string | null;
  /** `emails.raw_body`: the HTML when there is any, otherwise the text. */
  rawBody?: string | null;
  /** `emails.content_type`, which is what says whether `rawBody` is markup. */
  contentType?: string | null;
  /**
   * The attachment stage's verdict, or null when there was nothing to judge.
   *
   * Passed in rather than computed here because it is the one part that needs
   * the attachment BYTES, and those exist for exactly as long as the MIME
   * parse — see `parseBody`. Nothing in this app stores them, and re-fetching
   * a message to sniff its first four bytes would cost a round trip per
   * attachment.
   */
  attachments?: SpamAssessment | null;
}

/**
 * Score one message's body. Pure, synchronous, no network — the same contract
 * the header stage keeps, so a caller can run it wherever a body turns up.
 */
export function bodyStage(input: BodyStageInput): SpamAssessment {
  const html = input.contentType === 'html' ? input.rawBody : null;
  // Both parts are offered: the library prefers the HTML's own words and falls
  // back to the text, which is what rescues an HTML body that extracts to
  // nothing (a single tracking pixel, a mail that is one image).
  const content = assessContentSignals({ subject: input.subject, text: input.cleanBody, html });
  return mergeAssessments(content, input.attachments);
}

/**
 * Fold a body verdict into the verdict already stored for a message.
 *
 * Returns null when the row was never scored — `spam_score` NULL means the
 * user's own outgoing mail, or mail that predates the filter, and a body is
 * not a reason to start judging either. "Not judged" and "judged clean" have
 * to stay distinct or the shield lies about mail nothing ever looked at.
 *
 * Reasons this version cannot place are KEPT. `stageOfReason` returns null for
 * an id written by a newer release of the library, and dropping those would
 * lower a score for no better reason than that an older reader did not
 * recognise the rule.
 *
 * Returns null again when the stored reasons are UNREADABLE — corrupt JSON
 * reads as no reasons, and no reasons is also what a genuinely clean message
 * has, so the two are the same value and opposite facts. Rebuilding the
 * verdict from a column we could not read would quietly delete every point
 * the header stage charged. The row keeps the verdict it has instead.
 */
export function rescoreWithBody(
  stored: { spamScore?: number | null; spamReasons?: string | null },
  body: SpamAssessment,
): SpamAssessment | null {
  if (typeof stored.spamScore !== 'number') return null;
  const reasons = parseSpamReasons(stored.spamReasons);
  if (reasons.length === 0 && stored.spamScore !== 0) return null;
  const kept = reasons.filter((reason) => {
    const stage = stageOfReason(reason.id);
    return stage !== 'content' && stage !== 'attachment';
  });
  return mergeAssessments(assessmentOf(kept), body);
}
