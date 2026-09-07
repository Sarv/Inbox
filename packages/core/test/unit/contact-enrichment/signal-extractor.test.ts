import { describe, expect, it } from 'vitest';

import { extractSignals, extractSignatureBlock, stripQuotedTail } from '../../../src/contact-enrichment/signal-extractor';

/**
 * Fixture suite for contact-signal extraction.
 *
 * These are the real-world shapes that broke it before: an HTML signature
 * flattened to text, a top-posted reply whose quoted chain still carries the
 * original sender's signature, and an Outlook-style forward. The failure mode
 * is always the same and always silent — somebody else's phone number gets
 * recorded as this sender's, which then makes the phone classifier treat a
 * personal mobile as a shared office line and drop it entirely.
 */

const HER_SIG = `Pooja Khatri
CBO
+91 9988-776-655
www.sarv.com | +91-9111-9111-00
Jaipur: IT-10, EPIP RIICO Industrial Area, Sitapura, Jaipur 302022`;

const HER_MOBILE = '+919988776655';
const SWITCHBOARD = '+919111911100';

describe('extractSignals — the sender\'s own mail', () => {
  it('pulls both numbers out of a plain-text signature', () => {
    const s = extractSignals(`Hi team,\n\nPlease review.\n\nRegards!\n\n${HER_SIG}`, 'pkh@sarv.com');
    expect(s.phones).toContain(HER_MOBILE);
    expect(s.phones).toContain(SWITCHBOARD);
  });

  it('recognises a bare C-suite acronym as a title candidate', () => {
    const s = extractSignals(`Hi,\n\nRegards!\n\n${HER_SIG}`, 'pkh@sarv.com');
    expect(s.titleCandidates.join(' ')).toMatch(/CBO/);
  });

  it('survives an HTML signature flattened with no whitespace', () => {
    // html-to-text output routinely glues fields together like this.
    const glued = 'Thanks,\n\nPooja KhatriCBO+91 9988-776-655www.sarv.com';
    const s = extractSignals(glued, 'pkh@sarv.com');
    expect(s.phones).toContain(HER_MOBILE);
  });

  it('keeps the signature when it names the sender themselves', () => {
    const withEmail = `Regards,\n\nPooja Khatri\nCBO\npkh@sarv.com\n+91 9988-776-655`;
    const s = extractSignals(withEmail, 'pkh@sarv.com');
    expect(s.phones).toContain(HER_MOBILE);
  });
});

describe('extractSignals — quoted mail must not donate signals', () => {
  it('ignores a quoted signature behind a wrapped "wrote:" header', () => {
    const reply = `Sure, will do.

Thanks,
Shalini J
shalini.j@sarv.com

On Mon, 12 May 2026 at 10:23, Pooja Khatri <pkh@sarv.com>
wrote:

Hi team,

Regards!

${HER_SIG}`;
    const s = extractSignals(reply, 'shalini.j@sarv.com');
    expect(s.phones).not.toContain(HER_MOBILE);
  });

  it('ignores a quoted signature behind an Outlook forward header', () => {
    const fwd = `FYI

From: Pooja Khatri <pkh@sarv.com>
To: team@sarv.com
Subject: Review

${HER_SIG}`;
    const s = extractSignals(fwd, 'shalini.j@sarv.com');
    expect(s.phones).not.toContain(HER_MOBILE);
  });

  it('surfaces a same-domain colleague block as a candidate, not an attribution', () => {
    // No delimiter, so there is no signature to reject — the number is
    // collected and the classifier's ownership rule decides it is Pooja's,
    // not Shalini's (see phone-classifier.test.ts). Refusing to mine
    // un-delimited bodies here is what cost internal contacts their numbers.
    const body = `Passing this along.

Pooja Khatri
CBO
pkh@sarv.com
+91 9988-776-655`;
    const s = extractSignals(body, 'shalini.j@sarv.com');
    expect(s.phones).toContain(HER_MOBILE);
  });

  it('ignores a foreign-domain signature', () => {
    const body = `See below.

Alex Roe
Acme Ltd
alex@acme.com
+1 415 555 0142`;
    const s = extractSignals(body, 'shalini.j@sarv.com');
    expect(s.phones).toEqual([]);
  });

  it('still mines the sender\'s OWN signature (no over-blocking)', () => {
    const own = `Hi,

Regards,
Shalini J
Manager
+91 98765 43210
shalini.j@sarv.com`;
    const s = extractSignals(own, 'shalini.j@sarv.com');
    expect(s.phones).toContain('+919876543210');
  });
});

describe('extractSignals — noise rejection', () => {
  it('does not treat transactional body numbers as phones', () => {
    const txn = 'Your order 4029381746 shipped. Ref 9988776655443322.';
    expect(extractSignals(txn, 'noreply@shop.com').phones).toEqual([]);
  });

  it('rejects toll-free numbers as personal', () => {
    const s = extractSignals(`Regards,\n\nSupport\n1800 123 4567`, 'help@vendor.com');
    expect(s.phones).not.toContain('+9118001234567');
  });

  it('returns empty signals for an empty body rather than throwing', () => {
    const s = extractSignals('', 'a@b.com');
    expect(s.phones).toEqual([]);
    expect(s.signatureBlock).toBeNull();
  });
});

describe('stripQuotedTail / extractSignatureBlock', () => {
  it('cuts everything from the first quote marker', () => {
    const out = stripQuotedTail('Mine.\n\nOn Tue, X wrote:\n\nTheirs.');
    expect(out).toBe('Mine.');
    expect(out).not.toMatch(/Theirs/);
  });

  it('cuts at a ">" quoted line', () => {
    expect(stripQuotedTail('Mine.\n\n> theirs')).toBe('Mine.');
  });

  it('returns null when no signature delimiter is present', () => {
    expect(extractSignatureBlock('Just a sentence with no sign-off')).toBeNull();
  });
});

/**
 * Fixtures are synthetic but reproduce the exact shapes seen in real mailboxes. These are the
 * shapes that defeated every earlier guard, so they are reproduced exactly —
 * html-to-text output, glued fields, indented `--`, and all.
 */
describe('extractSignals — html-to-text shaped bodies', () => {
  const POOJA = '+919988776655';
  const BINDU = '+918877665544';

  it('finds her own bare number under an INDENTED "--" separator', () => {
    // `    --` is what html-to-text emits; anchoring to column 0 missed it, so
    // no signature block was found and her number was never in scope.
    const body = [
      'Survey Link: https://docs.google.com/forms/d/e/1FAIpQLS/viewform',
      'Thanks for taking a few minutes to share your input.',
      '',
      '    --',
      '',
      '    Pooja KhatriCBOpkh@sarv.com || 9988776655',
    ].join('\n');
    const s = extractSignals(body, 'pkh@sarv.com');
    expect(s.phones).toContain(POOJA);
  });

  it('takes the LAST signature when a quoted one precedes her own', () => {
    const body = [
      '    --',
      '    Thanks & Regards,Mahesh KotakServer Admin L-3+91-9111-9111-00www.sarv.com | 1800-12345-6001',
      '',
      '    --',
      '',
      '    Pooja KhatriCBOpkh@sarv.com || 9988776655',
    ].join('\n');
    const s = extractSignals(body, 'pkh@sarv.com');
    expect(s.phones).toContain(POOJA);
    expect(s.phones).not.toContain('+9118001234560001'); // toll-free, rejected
  });

  it('DOES surface a colleague sign-off pasted inline — as a candidate only', () => {
    // Sent BY pkh, trailing sign-off is Bindu's, with no `--` and no quote
    // header to mark it. Extraction cannot tell whose it is, and refusing to
    // look at un-delimited bodies costs every sender who never emits a
    // delimiter their own number. So it is collected here and REJECTED by the
    // classifier's ownership rule (see phone-classifier.test.ts, which asserts
    // pkh never receives Bindu's number). Candidate != attribution.
    const body = [
      'Kindly treat this matter as high priority and provide an urgent update.',
      'Regards,Bindu YagnikSales Manager+91 8877-6655-44www.sarv.com | +91-9111-9111-00',
    ].join('\n');
    const s = extractSignals(body, 'pkh@sarv.com');
    expect(s.phones).toContain(BINDU);
  });

  it('ignores a quoted chain introduced inline by "On <date> … wrote:"', () => {
    const body = '@Hrishi @Advik review this today. On Wed, Jul 29, 2026 at 12:05 PM, '
      + 'Bindu Yagnik <bindu.y@sarv.com> wrote: Hi Team, +91 8877-6655-44';
    const s = extractSignals(body, 'pkh@sarv.com');
    expect(s.phones).not.toContain(BINDU);
  });
});

/**
 * Recall across signature STYLES. The goal is to find a number in whatever
 * shape a signature arrives in — attribution is the classifier's job, so being
 * strict here loses information rather than protecting anything. Each case is
 * a style seen in real mail.
 */
describe('extractSignals — recall across signature styles', () => {
  const styles: Array<[label: string, body: string, from: string, expected: string | null]> = [
    ['indented -- separator', 'txt\n\n    --\n\n    Pooja KhatriCBOpkh@sarv.com || 9988776655', 'pkh@sarv.com', '+919988776655'],
    ['glued sign-off', 'Please review.Regards,Meghna KotakSales+91 98765 43210', 'meghna.k@sarv.com', '+919876543210'],
    ['no delimiter, bare national', 'Report attached.\nMeghna Kotak\nSarv\n9876543210', 'meghna.k@sarv.com', '+919876543210'],
    ['"Thanks & Regards" glued', 'ok.Thanks & Regards,Mahesh KotakServer Admin+91-9876-5432-10', 'mahesh@sarv.com', '+919876543210'],
    ['mobile-client signature', 'sent.\n\nSent from my iPhone\nRohit\n+91 99999 88888', 'rohit@sarv.com', '+919999988888'],
    ['labelled "Mob:"', 'hi\n--\nAjay\nMob: 8877665544', 'ajay@sarv.com', '+918877665544'],
    ['em-dash separator', 'hi\n—\nSunil\n+91 90000 11111', 'sunil@sarv.com', '+919000011111'],
  ];

  for (const [label, body, from, expected] of styles) {
    it(`finds the number: ${label}`, () => {
      expect(extractSignals(body, from).phones).toContain(expected);
    });
  }

  const noise: Array<[label: string, body: string, from: string]> = [
    ['order / reference numbers', 'Your order 4029381746 shipped. Ref 9988776655443322.', 'noreply@shop.com'],
    ['invoice amounts and tax ids', 'Invoice 2026-08-02, amount 45000, GST 08AABCS1429B1ZM', 'billing@x.com'],
    ['number beside a foreign address', 'FYI\nAlex Roe alex@acme.com +1 415 555 0142', 'shalini.j@sarv.com'],
  ];

  for (const [label, body, from] of noise) {
    it(`stays empty: ${label}`, () => {
      expect(extractSignals(body, from).phones).toEqual([]);
    });
  }
});

/**
 * Cases that only appear once you look at real mailboxes: a signature BELOW the
 * quoted history, conference dial-ins in calendar invites, and recruiter mail
 * whose body is a table of other people's phone numbers.
 */
describe('extractSignals — signature position and body noise', () => {
  it('ignores a conference dial-in in a calendar invite', () => {
    const invite = 'Join by phone\n(US) +1 415-555-0123 PIN: 123456789#\nMore phone numbers https://tel.meet/abc';
    expect(extractSignals(invite, 'meghna.k@sarv.com').phones).toEqual([]);
  });

  it('ignores Zoom dial-in details', () => {
    const zoom = 'Join Zoom Meeting https://zoom.us/j/123\nDial: +1 646 555 0145\nMeeting ID: 842 1928 3311';
    expect(extractSignals(zoom, 'a@x.com').phones).toEqual([]);
  });

  it('does not attribute candidate numbers from a recruiter table to the sender', () => {
    // Her own signature is present too — the table must not contaminate it.
    const body = [
      'Kindly review the profiles.',
      '',
      'Profile  Candidate Name  Number  E-mail ID',
      '1  Kriti J  +91 98111 22233  kriti@x.com',
      '2  Sameer V  +91 97222 33344  sameer@y.com',
      '',
      '--',
      'Meghna Kotak',
      'Team Lead - Talent Acquisition',
      '+91 8899001122',
    ].join('\n');
    const phones = extractSignals(body, 'meghna.k@sarv.com').phones;
    expect(phones).toContain('+918899001122');
    expect(phones).not.toContain('+919811122233');
    expect(phones).not.toContain('+919722233344');
  });
});
