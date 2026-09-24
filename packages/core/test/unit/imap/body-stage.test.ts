import { assessmentOf, type SpamReason } from '@sarv-in/mailguard';
import { describe, it, expect } from 'vitest';

import { bodyStage, recipientDomainsOf, rescoreWithBody } from '../../../src/imap/body-stage';

/**
 * The body stage is the half of the spam score that cannot run at sync,
 * because at sync there is no body: this app downloads them lazily. So it runs
 * later, against a verdict that is ALREADY STORED, and that is what makes it
 * worth testing on its own.
 *
 * Two properties carry the whole design. The re-score must be idempotent — a
 * body can be fetched more than once (a repaired UID, a charset re-parse, a
 * re-open) and charging the same rule twice would push ordinary mail over the
 * spam line while looking like nothing in the total. And a row that was never
 * scored must stay unscored, or the shield starts judging the user's own Sent
 * mail.
 */

const reason = (id: string, points: number): SpamReason =>
  ({ id, points, detail: `${id} fired` }) as SpamReason;

/** The verdict a header stage left on the row, as it is actually stored. */
const stored = (score: number, reasons: SpamReason[]) => ({
  spamScore: score,
  spamReasons: JSON.stringify(reasons),
});

describe('bodyStage', () => {
  it('scores the sender words and links of an HTML body', () => {
    const result = bodyStage({
      subject: 'Your account',
      contentType: 'html',
      rawBody: '<p>Confirm below.</p><a href="https://evil.example/x">https://yourbank.example</a>',
      cleanBody: 'Confirm below. https://yourbank.example',
    });

    expect(result.reasons.map((r) => r.id)).toEqual(['link-display-mismatch']);
    expect(result.score).toBe(2);
  });

  // Regression: `rawBody` holds HTML only when content_type says so — for a
  // text/plain message it is the prose itself. Handed to the HTML extractor,
  // anything a person typed in angle brackets would be parsed as markup and
  // silently dropped from the words being scored.
  it('treats rawBody as prose, not markup, when the row is not HTML', () => {
    const result = bodyStage({
      subject: 'Pay now',
      contentType: 'text',
      rawBody: 'Pay at <https://1.2.3.4/pay> today',
      cleanBody: 'Pay at <https://1.2.3.4/pay> today',
    });

    expect(result.reasons.map((r) => r.id)).toEqual(['link-bare-ip']);
  });

  // Regression: the attachment verdict is computed elsewhere (only `parseBody`
  // ever holds the decoded bytes) and handed in. Dropped here, every
  // attachment rule would score zero on every message in the app.
  it('adds the attachment verdict it is handed to the content verdict', () => {
    const attachments = assessmentOf([reason('attachment-executable', 2)]);
    const result = bodyStage({
      subject: 'Invoice',
      contentType: 'text',
      rawBody: 'See attached http://5.6.7.8/inv',
      cleanBody: 'See attached http://5.6.7.8/inv',
      attachments,
    });

    expect(result.reasons.map((r) => r.id)).toEqual(['link-bare-ip', 'attachment-executable']);
    expect(result.score).toBe(4);
  });

  it('scores nothing for an empty body', () => {
    expect(bodyStage({ subject: '', cleanBody: '', rawBody: '', contentType: 'text' })).toEqual({
      score: 0,
      reasons: [],
      isSpam: false,
      suspicious: false,
    });
  });
});

describe('rescoreWithBody', () => {
  // Regression: NULL spam_score is the user's own outgoing mail, or mail that
  // predates the filter. A body arriving is not a reason to start judging
  // either — and "not judged" and "judged clean" are different facts to the
  // shield.
  it('leaves a row that was never scored unscored', () => {
    const body = assessmentOf([reason('content-shouting', 1)]);
    expect(rescoreWithBody({ spamScore: null, spamReasons: null }, body)).toBeNull();
    expect(rescoreWithBody({}, body)).toBeNull();
  });

  it('adds the body reasons to the verdict already stored', () => {
    const body = assessmentOf([reason('link-bare-ip', 2)]);
    const result = rescoreWithBody(stored(3, [reason('auth-failed', 3)]), body);

    expect(result!.score).toBe(5);
    expect(result!.isSpam).toBe(true);
    expect(result!.reasons.map((r) => r.id)).toEqual(['auth-failed', 'link-bare-ip']);
  });

  // Regression: THE reason this function exists. A body can be fetched more
  // than once, and appending the content reasons each time would charge the
  // same rule twice — an inflation that is invisible in a stored total and
  // eventually files ordinary mail as spam.
  it('is idempotent — re-running the body stage never charges a rule twice', () => {
    const body = assessmentOf([reason('link-bare-ip', 2), reason('attachment-macro', 1)]);
    const once = rescoreWithBody(stored(3, [reason('auth-failed', 3)]), body)!;
    const twice = rescoreWithBody(stored(once.score, once.reasons), body)!;

    expect(twice.score).toBe(once.score);
    expect(twice.reasons).toEqual(once.reasons);
  });

  // Regression: a re-score must only replace ITS OWN stages. The reputation
  // sweep writes its reasons into the same column and cannot recompute them
  // here — dropping them would undo a blocklist hit every time a body loaded.
  it('keeps the header and reputation reasons it cannot recompute', () => {
    const result = rescoreWithBody(
      stored(6, [reason('auth-failed', 3), reason('reputation-ip-listed', 3), reason('content-shouting', 1)]),
      assessmentOf([]),
    );

    expect(result!.reasons.map((r) => r.id)).toEqual(['auth-failed', 'reputation-ip-listed']);
    expect(result!.score).toBe(6);
  });

  // Regression: a verdict written by a NEWER version of the library can carry
  // a reason this build has never heard of. Dropping it would silently lower
  // the score for no better reason than an older reader.
  it('keeps a reason id it cannot place', () => {
    const result = rescoreWithBody(
      stored(4, [reason('a-rule-from-a-later-release', 4)]),
      assessmentOf([reason('content-shouting', 1)]),
    );

    expect(result!.reasons.map((r) => r.id)).toEqual(['a-rule-from-a-later-release', 'content-shouting']);
    expect(result!.score).toBe(5);
  });

  // Regression: corrupt JSON reads as "no reasons", and so does a genuinely
  // clean message — the same value, opposite facts. Re-scoring off a column we
  // could not read would silently delete every point the header stage charged,
  // so a scored row with unreadable reasons keeps the verdict it has.
  it('refuses to re-score a scored row whose reasons will not parse', () => {
    expect(rescoreWithBody({ spamScore: 3, spamReasons: 'not json' }, assessmentOf([reason('link-bare-ip', 2)]))).toBeNull();
    expect(rescoreWithBody({ spamScore: 3, spamReasons: null }, assessmentOf([]))).toBeNull();
  });

  // ...but a zero score with no reasons is exactly what a clean message looks
  // like, and that row MUST still get its body verdict.
  it('re-scores a clean row, which legitimately has no reasons', () => {
    const result = rescoreWithBody({ spamScore: 0, spamReasons: '[]' }, assessmentOf([reason('link-bare-ip', 2)]));
    expect(result!.score).toBe(2);
  });
});

describe('recipientDomainsOf', () => {
  // Regression: `to_address` is a stored, comma-separated list with display
  // names — a naive split shreds `"Doe, John"`. It must go through the shared
  // address parser, and yield each registrable domain once.
  it('collects the registrable domains of every address in the stored lists, once', () => {
    expect(
      recipientDomainsOf(
        'Ramesh <rc@sarv.com>, "Doe, John" <john@mail.acme.example>',
        'x@sarv.com, not-an-address',
        null,
        undefined,
        '',
      ),
    ).toEqual(['sarv.com', 'acme.example']);
    expect(recipientDomainsOf()).toEqual([]);
  });
});

describe('bodyStage — a link dressed as the reader’s own domain', () => {
  // Regression: the Adobe Sign lure. Text "Sarv.com Engagement Letter", href
  // kuaiyudh.top — dressed as the reader's own organisation, which the library
  // weighs at 4. But only if this app hands the recipient domains over: the
  // same call without them is an anonymous 2-point mismatch.
  it('weighs it at 4 with the recipient domains, and at 2 without them', () => {
    const input = {
      subject: 'Signature requested',
      contentType: 'html',
      rawBody: '<a href="https://kuaiyudh.top/v/#rc">Sarv.com Engagement Letter - for signature</a>',
      cleanBody: 'Sarv.com Engagement Letter - for signature',
    };
    const own = bodyStage({ ...input, recipientDomains: recipientDomainsOf('rc@sarv.com') });
    expect(own.reasons.map((r) => [r.id, r.points])).toEqual([['link-display-mismatch', 4]]);
    expect(bodyStage(input).score).toBe(2);
  });
});
