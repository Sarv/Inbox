import {
  DATE_SKEW_SECONDS,
  SPAM_HEADER_NAMES,
  assessSpamSignals,
  isFreemailAddress,
  type SpamSignalInput,
} from '@sarv-in/email-spam-scan';
import {
  SPAM_THRESHOLD,
  SUSPICIOUS_THRESHOLD,
  isSpamScore,
  parseSpamReasons,
  spamVerdict,
} from '@sarv-in/email-spam-scan';
import { describe, expect, it } from 'vitest';

import { headerLookupFromText } from '../../../src/utils/bulk-mail';

/**
 * The header-stage spam filter.
 *
 * What this protects: this score decides, at sync time and before any human
 * or AI has seen the message, whether mail is filed as spam. A false positive
 * is mail that quietly disappears into a folder nobody reads; a false negative
 * is merely the status quo. So every block is two-sided: each rule fires on
 * the tell it exists for, AND ordinary mail — a colleague's reply, a
 * newsletter that follows the rules, a forwarded message — stays under the
 * line. The weights are part of the contract: the classic combinations must
 * cross it, a single benign anomaly must not.
 */
const T0 = 1_760_000_000; // 2025-10-09T08:53:20Z
const DAY = 86_400;

/** A clean, ordinary, authenticated message. Every case starts from here. */
const clean = (over: Partial<SpamSignalInput> = {}): SpamSignalInput => ({
  fromAddress: 'meghna.k@sarv.com',
  fromName: 'Meghna Kotak',
  replyTo: null,
  toAddress: 'rc@sarv.com',
  ccAddress: null,
  subject: 'Quarterly numbers',
  messageId: '<abc123@mail.sarv.com>',
  inReplyTo: null,
  references: null,
  date: T0,
  internalDate: T0 + 30,
  auth: { spf: 'pass', dkim: 'pass', dmarc: 'pass', overall: 'pass' },
  headers: headerLookupFromText(''),
  knownSpammer: false,
  ...over,
});
const ids = (input: SpamSignalInput): string[] => assessSpamSignals(input).reasons.map((r) => r.id);
const points = (input: SpamSignalInput, id: string): number | undefined =>
  assessSpamSignals(input).reasons.find((r) => r.id === id)?.points;
const withHeaders = (block: string) => headerLookupFromText(block);

describe('assessSpamSignals — ordinary mail stays clean', () => {
  // THE false-positive guard. If this fires, real mail is being filed away.
  it('scores a clean authenticated message 0 with no reasons', () => {
    const a = assessSpamSignals(clean());
    expect(a).toEqual({ score: 0, reasons: [], isSpam: false, suspicious: false });
  });

  // A newsletter that follows the rules — list headers WITH unsubscribe, its
  // ESP replying from its own domain — is bulk, not spam.
  it('keeps a rule-following newsletter under the suspicious line', () => {
    const a = assessSpamSignals(clean({
      fromAddress: 'news@shop.example',
      fromName: 'Shop Weekly',
      replyTo: 'reply@mailer.example',
      headers: withHeaders('List-Id: <weekly.shop.example>\r\nList-Unsubscribe: <https://shop.example/u>\r\nPrecedence: bulk\r\n'),
    }));
    expect(a.score).toBeLessThan(SUSPICIOUS_THRESHOLD);
    expect(a.isSpam).toBe(false);
  });

  // Forwarding breaks SPF and often DKIM; DMARC still passing means the
  // domain owner's policy vouched for it. Same rule the shield applies.
  it('does not penalise a forwarded message whose inputs failed but DMARC passed', () => {
    expect(ids(clean({ auth: { spf: 'fail', dkim: 'fail', dmarc: 'pass', overall: 'fail' } }))).toEqual([]);
  });

  it('does not call a reply with threading headers a fake reply', () => {
    expect(ids(clean({ subject: 'Re: Quarterly numbers', inReplyTo: '<parent@mail.sarv.com>' }))).toEqual([]);
    expect(ids(clean({ subject: 'Re: Quarterly numbers', references: '<a@x> <b@x>' }))).toEqual([]);
  });

  it('accepts a Reply-To on the sender’s own domain, including a subdomain', () => {
    expect(ids(clean({ replyTo: 'team@support.sarv.com' }))).toEqual([]);
  });

  it('accepts a Date a few hours off the server clock', () => {
    expect(ids(clean({ date: T0, internalDate: T0 + 3 * 3600 }))).toEqual([]);
    expect(ids(clean({ date: T0, internalDate: T0 - 3 * DAY }))).toEqual([]);
  });

  // No authentication verdict at all is "unverifiable", not "failed".
  it('does not score a message the server recorded no verdict for', () => {
    expect(ids(clean({ auth: null }))).toEqual([]);
    expect(ids(clean({ auth: { spf: 'none', dkim: 'none', dmarc: 'none', overall: 'none' } }))).toEqual([]);
  });

  // Auto-generated transactional mail (a receipt, a password reset) has
  // nothing to unsubscribe from and must not be scored for lacking it.
  it('exempts auto-submitted mail from the missing-unsubscribe rule', () => {
    expect(ids(clean({ headers: withHeaders('Precedence: bulk\r\nAuto-Submitted: auto-generated\r\n') }))).toEqual([]);
  });
});

describe('assessSpamSignals — categorical rules decide alone', () => {
  // An upstream filter saw the body and the network; its word is final.
  it('trusts X-Spam-Flag: YES', () => {
    const a = assessSpamSignals(clean({ headers: withHeaders('X-Spam-Flag: YES\r\n') }));
    expect(a.isSpam).toBe(true);
    expect(a.reasons).toEqual([{ id: 'upstream-spam', points: 5, detail: expect.stringContaining('X-Spam-Flag') }]);
  });

  it('trusts X-Spam-Status: Yes, …', () => {
    const a = assessSpamSignals(clean({ headers: withHeaders('X-Spam-Status: Yes, score=7.1 required=5.0 tests=BAYES_99\r\n') }));
    expect(a.isSpam).toBe(true);
    expect(a.reasons[0].id).toBe('upstream-spam');
  });

  it('trusts an Exchange spam confidence level of 5 or more, not below', () => {
    expect(assessSpamSignals(clean({ headers: withHeaders('X-MS-Exchange-Organization-SCL: 5\r\n') })).isSpam).toBe(true);
    expect(assessSpamSignals(clean({ headers: withHeaders('X-MS-Exchange-Organization-SCL: 9\r\n') })).isSpam).toBe(true);
    expect(ids(clean({ headers: withHeaders('X-MS-Exchange-Organization-SCL: 1\r\n') }))).toEqual([]);
    expect(ids(clean({ headers: withHeaders('X-MS-Exchange-Organization-SCL: -1\r\n') }))).toEqual([]);
  });

  it('does not read a NO as a yes', () => {
    expect(ids(clean({ headers: withHeaders('X-Spam-Flag: NO\r\nX-Spam-Status: No, score=0.1\r\n') }))).toEqual([]);
  });

  // The sender the user reported: the reason the `spammers` table exists.
  it('files mail from a sender the user reported', () => {
    const a = assessSpamSignals(clean({ knownSpammer: true }));
    expect(a.isSpam).toBe(true);
    expect(a.reasons).toEqual([{ id: 'known-spammer', points: 5, detail: expect.stringContaining('reported') }]);
  });

  // A header the scorer reads but the fetch never asks for is a rule that
  // silently never fires — the same contract BULK_HEADER_NAMES pins.
  it('names every upstream-verdict header it reads in SPAM_HEADER_NAMES', () => {
    for (const name of ['x-spam-flag', 'x-spam-status', 'x-ms-exchange-organization-scl']) {
      expect(SPAM_HEADER_NAMES).toContain(name);
    }
  });
});

describe('assessSpamSignals — authentication', () => {
  it('scores a DMARC failure 3', () => {
    expect(points(clean({ auth: { spf: 'fail', dkim: 'pass', dmarc: 'fail', overall: 'fail' } }), 'auth-failed')).toBe(3);
  });

  // No DMARC verdict: both inputs failing stands in for it. One alone does not
  // — a forwarder or a list breaks one routinely.
  it('falls back to SPF+DKIM both failing only when DMARC is unknown', () => {
    expect(points(clean({ auth: { spf: 'fail', dkim: 'fail', dmarc: 'none', overall: 'fail' } }), 'auth-failed')).toBe(3);
    expect(ids(clean({ auth: { spf: 'fail', dkim: 'pass', dmarc: 'none', overall: 'fail' } }))).toEqual([]);
    expect(ids(clean({ auth: { spf: 'pass', dkim: 'fail', dmarc: 'unknown', overall: 'fail' } }))).toEqual([]);
  });
});

describe('assessSpamSignals — identity', () => {
  it('scores a display name that names another domain 3', () => {
    const a = assessSpamSignals(clean({ fromName: 'support@paypal.com', fromAddress: 'x@evil.example' }));
    expect(a.reasons).toEqual([{ id: 'display-name-spoof', points: 3, detail: expect.stringContaining('paypal.com') }]);
  });

  it('scores a punycode sender domain 1', () => {
    expect(points(clean({ fromAddress: 'billing@xn--paypa-9qa.com' }), 'sender-punycode')).toBe(1);
  });

  it('scores a missing or unparseable sender address 2', () => {
    expect(assessSpamSignals(clean({ fromAddress: '' })).reasons).toEqual([{ id: 'sender-invalid', points: 2, detail: 'No sender address' }]);
    expect(points(clean({ fromAddress: 'not an address' }), 'sender-invalid')).toBe(2);
  });

  // RFC 6532: an internationalised local part is a valid address, not a tell.
  it('accepts an internationalised sender address', () => {
    expect(ids(clean({ fromAddress: 'राम@sarv.com' }))).toEqual([]);
  });

  // The 419 / BEC shape: corporate From, replies quietly routed to webmail.
  it('scores a Reply-To at a free webmail address 2 when the sender is not', () => {
    const a = assessSpamSignals(clean({ fromAddress: 'ceo@bigcorp.example', replyTo: 'ceo.bigcorp@gmail.com' }));
    expect(a.reasons).toEqual([{ id: 'reply-to-freemail', points: 2, detail: expect.stringContaining('gmail.com') }]);
  });

  it('scores any other cross-domain Reply-To 1', () => {
    expect(points(clean({ replyTo: 'sales@otherfirm.example' }), 'reply-to-mismatch')).toBe(1);
    // Webmail to webmail is a mismatch, not the freemail pattern.
    expect(points(clean({ fromAddress: 'a@gmail.com', replyTo: 'b@yahoo.com' }), 'reply-to-mismatch')).toBe(1);
  });
});

describe('assessSpamSignals — plumbing a real client gets right', () => {
  it('scores a missing Message-ID 2 and a malformed one 1', () => {
    expect(points(clean({ messageId: '' }), 'missing-message-id')).toBe(2);
    expect(points(clean({ messageId: null }), 'missing-message-id')).toBe(2);
    expect(points(clean({ messageId: 'no-brackets@x.example' }), 'malformed-message-id')).toBe(1);
    expect(points(clean({ messageId: '<no-at-sign>' }), 'malformed-message-id')).toBe(1);
  });

  it('scores a missing Date 1', () => {
    expect(points(clean({ date: null }), 'missing-date')).toBe(1);
  });

  it('scores a Date more than four days from arrival 2, either direction', () => {
    expect(DATE_SKEW_SECONDS).toBe(96 * 3600);
    const future = assessSpamSignals(clean({ date: T0 + 5 * DAY, internalDate: T0 }));
    expect(future.reasons).toEqual([{ id: 'date-skew', points: 2, detail: expect.stringContaining('AFTER') }]);
    expect(points(clean({ date: T0 - 5 * DAY, internalDate: T0 }), 'date-skew')).toBe(2);
    // No server time to compare against: no judgement.
    expect(ids(clean({ date: T0 - 30 * DAY, internalDate: null }))).toEqual([]);
  });

  it('scores a "Re:" that replies to nothing 2, in any locale the threader knows', () => {
    expect(points(clean({ subject: 'Re: Your invoice' }), 'fake-reply')).toBe(2);
    expect(points(clean({ subject: 'AW: Ihre Rechnung' }), 'fake-reply')).toBe(2);
    expect(ids(clean({ subject: 'Your invoice' }))).toEqual([]);
  });

  it('scores a message with no visible recipient 1', () => {
    expect(points(clean({ toAddress: '', ccAddress: null }), 'no-recipient')).toBe(1);
    expect(ids(clean({ toAddress: '', ccAddress: 'someone@sarv.com' }))).toEqual([]);
  });
});

describe('assessSpamSignals — bulk mail that breaks the bulk-mail rules', () => {
  it('scores declared bulk mail with no List-Unsubscribe 1', () => {
    expect(points(clean({ headers: withHeaders('List-Id: <blast.example>\r\n') }), 'bulk-no-unsubscribe')).toBe(1);
    expect(points(clean({ headers: withHeaders('Feedback-ID: 1:2:3:campaign\r\n') }), 'bulk-no-unsubscribe')).toBe(1);
    expect(ids(clean({ headers: withHeaders('List-Id: <blast.example>\r\nList-Unsubscribe: <mailto:u@blast.example>\r\n') }))).toEqual([]);
  });

  it('scores a self-declared Precedence: junk 1', () => {
    // Also bulk without unsubscribe — two reasons, both cheap.
    const a = assessSpamSignals(clean({ headers: withHeaders('Precedence: junk\r\n') }));
    expect(a.reasons.map((r) => r.id).sort()).toEqual(['bulk-no-unsubscribe', 'precedence-junk']);
  });

  // The envelope-only path (no fetched header block) cannot see these headers
  // and must not guess.
  it('skips the header rules entirely when no header block is available', () => {
    expect(ids(clean({ headers: null }))).toEqual([]);
  });
});

describe('assessSpamSignals — the line', () => {
  // THE combinations the weights were chosen for.
  it('a spoofed display name on a DMARC failure is spam', () => {
    const a = assessSpamSignals(clean({
      fromName: 'security@paypal.com', fromAddress: 'x@evil.example',
      auth: { spf: 'fail', dkim: 'fail', dmarc: 'fail', overall: 'fail' },
    }));
    expect(a.score).toBe(6);
    expect(a.isSpam).toBe(true);
  });

  it('a forged reply from an unauthenticated sender is spam', () => {
    const a = assessSpamSignals(clean({ subject: 'Re: Payment', auth: { spf: 'fail', dkim: 'fail', dmarc: 'fail', overall: 'fail' } }));
    expect(a.score).toBe(SPAM_THRESHOLD);
    expect(a.isSpam).toBe(true);
  });

  // Several small anomalies make a message SUSPICIOUS — shown on the shield —
  // without filing it. Filing on plumbing alone would eat real mail from
  // badly configured but honest senders.
  it('plumbing anomalies alone reach suspicious, not spam', () => {
    const a = assessSpamSignals(clean({ messageId: '', date: null, toAddress: '' }));
    expect(a.score).toBe(4);
    expect(a.suspicious).toBe(true);
    expect(a.isSpam).toBe(false);
  });

  it('a single benign anomaly is neither', () => {
    const a = assessSpamSignals(clean({ replyTo: 'me@gmail.com' }));
    expect(a.score).toBe(2);
    expect(a.suspicious).toBe(false);
    expect(a.isSpam).toBe(false);
  });
});

describe('spam-verdict', () => {
  // NULL means "never scored" — a row synced before the filter existed, or
  // the user's own mail — and must never read as clean.
  it('distinguishes not-scored from clean', () => {
    expect(spamVerdict(null)).toBeNull();
    expect(spamVerdict(undefined)).toBeNull();
    expect(spamVerdict(Number.NaN)).toBeNull();
    expect(spamVerdict(0)).toBe('clean');
  });

  it('draws the lines at the thresholds', () => {
    expect(spamVerdict(SUSPICIOUS_THRESHOLD - 1)).toBe('clean');
    expect(spamVerdict(SUSPICIOUS_THRESHOLD)).toBe('suspicious');
    expect(spamVerdict(SPAM_THRESHOLD - 1)).toBe('suspicious');
    expect(spamVerdict(SPAM_THRESHOLD)).toBe('spam');
    expect(isSpamScore(SPAM_THRESHOLD)).toBe(true);
    expect(isSpamScore(SPAM_THRESHOLD - 0.5)).toBe(false);
    expect(isSpamScore(null)).toBe(false);
  });

  // The shield reads this column for every message; one bad row must render
  // as "no reasons", not crash the detail pane.
  it('parses the stored reasons tolerantly', () => {
    const stored = JSON.stringify([{ id: 'fake-reply', points: 2, detail: 'x' }, { junk: true }, 'nope']);
    expect(parseSpamReasons(stored)).toEqual([{ id: 'fake-reply', points: 2, detail: 'x' }]);
    expect(parseSpamReasons(null)).toEqual([]);
    expect(parseSpamReasons('')).toEqual([]);
    expect(parseSpamReasons('not json')).toEqual([]);
    expect(parseSpamReasons('{"id":"x"}')).toEqual([]);
  });
});

describe('isFreemailAddress', () => {
  it('recognises consumer webmail domains, case-insensitively, including country variants', () => {
    expect(isFreemailAddress('a@gmail.com')).toBe(true);
    expect(isFreemailAddress('A@GMAIL.COM')).toBe(true);
    expect(isFreemailAddress('a@yahoo.co.in')).toBe(true);
    expect(isFreemailAddress('a@mail.yahoo.co.in')).toBe(true); // registrable domain match
  });
  it('is false for a company domain or a non-address', () => {
    expect(isFreemailAddress('a@sarv.com')).toBe(false);
    expect(isFreemailAddress('nope')).toBe(false);
    expect(isFreemailAddress(null)).toBe(false);
  });
});
