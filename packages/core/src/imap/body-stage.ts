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
  domainOfAddress,
  mergeAssessments,
  parseSpamReasons,
  stageOfReason,
  type SpamAssessment,
  type SpamReason,
} from '@sarv-in/mailguard';

import { parseAddresses } from '../utils/email-address';

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
  /**
   * The registrable domains the message was addressed to — see
   * {@link recipientDomainsOf}. A deceptive link whose text names one of them
   * is dressed as the reader's own organisation, which the library weighs at
   * twice an anonymous mismatch. Omitted, every mismatch scores the same.
   */
  recipientDomains?: readonly (string | null | undefined)[];
}

/**
 * The registrable domains in one or more stored address lists — `emails.to_address`
 * and `emails.cc_address` are comma-separated — de-duplicated, in order.
 *
 * The mailbox owner's own address is in one of those lists for any message they
 * were sent, so this is also the reader's domain without the processor having to
 * know whose account it is syncing.
 */
export function recipientDomainsOf(...lists: ReadonlyArray<string | null | undefined>): string[] {
  const domains = new Set<string>();
  for (const list of lists) {
    for (const address of parseAddresses(list)) {
      const domain = domainOfAddress(address);
      if (domain) domains.add(domain);
    }
  }
  return [...domains];
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
  const content = assessContentSignals({
    subject: input.subject,
    text: input.cleanBody,
    html,
    recipientDomains: input.recipientDomains,
  });
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
  return replaceStages(stored, ['content', 'attachment'], body);
}

/**
 * {@link rescoreWithBody} for the content stage alone: the attachment reasons
 * stay as they were charged. For re-judging a stored body with a newer
 * library, where the attachments' bytes are not to hand — dropping their
 * reasons would un-charge a malicious attachment nobody looked at again.
 */
export function rescoreContent(
  stored: { spamScore?: number | null; spamReasons?: string | null },
  content: SpamAssessment,
): SpamAssessment | null {
  return replaceStages(stored, ['content'], content);
}

/**
 * A stored verdict with its `auth-failed` reason re-decided — for a row whose
 * SPF / DKIM / DMARC verdict was re-read with a stricter parser (mailguard
 * 0.4.3 stopped believing forged `Authentication-Results`; see migration v101).
 *
 * `authReasons` is what the header stage charges for the re-read verdict:
 * `auth-failed` or nothing. Only that one reason is replaced. The rest of the
 * header stage is NOT re-run, because that would be judging the message afresh
 * with every rule change since it arrived, not correcting the verdict the
 * forged header wrote.
 *
 * Null — leave the row alone — when it was never scored, when its reasons are
 * unreadable (see {@link rescoreWithBody}), and when the reason would come out
 * exactly as it is stored: a re-read that changes nothing must not rewrite the
 * column, or every re-checked row would be churned for no difference.
 */
export function rescoreAuth(
  stored: { spamScore?: number | null; spamReasons?: string | null },
  authReasons: readonly SpamReason[],
): SpamAssessment | null {
  const before = parseSpamReasons(stored.spamReasons).filter((reason) => reason.id === 'auth-failed');
  const same = before.length === authReasons.length
    && before.every((reason, i) => reason.points === authReasons[i]!.points && reason.detail === authReasons[i]!.detail);
  if (same) return null;
  return replaceReasons(stored, (reason) => reason.id === 'auth-failed', assessmentOf([...authReasons]));
}

function replaceStages(
  stored: { spamScore?: number | null; spamReasons?: string | null },
  stages: readonly string[],
  fresh: SpamAssessment,
): SpamAssessment | null {
  return replaceReasons(stored, (reason) => {
    const stage = stageOfReason(reason.id);
    return stage !== null && stages.includes(stage);
  }, fresh);
}

/** The stored reasons minus the ones `drop` picks, plus `fresh`; null for a row that was never scored or cannot be read. */
function replaceReasons(
  stored: { spamScore?: number | null; spamReasons?: string | null },
  drop: (reason: SpamReason) => boolean,
  fresh: SpamAssessment,
): SpamAssessment | null {
  if (typeof stored.spamScore !== 'number') return null;
  const reasons = parseSpamReasons(stored.spamReasons);
  if (reasons.length === 0 && stored.spamScore !== 0) return null;
  return mergeAssessments(assessmentOf(reasons.filter((reason) => !drop(reason))), fresh);
}
