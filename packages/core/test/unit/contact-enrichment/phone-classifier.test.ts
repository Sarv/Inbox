import { describe, expect, it } from 'vitest';

import {
  classifyDomainPhones,
  recurrenceBonus,
  MAX_RECURRENCE_BONUS,
  type SenderPhones,
} from '../../../src/contact-enrichment/phone-classifier';

/**
 * Phone classification across a domain.
 *
 * Two failure modes matter, and they pull in opposite directions:
 *
 *  - TOO STRICT: a person's own mobile gets treated as a shared line (because
 *    colleagues quoted their signature) and is dropped, so their card shows the
 *    switchboard labelled "(office)" and no direct number.
 *  - TOO LOOSE: a colleague's personal mobile, quoted into someone else's mail,
 *    is claimed as THEIR direct number. This is the worse one — it is
 *    confidently wrong, and mobile_e164 drives person_id, so it merges two
 *    people into one identity.
 *
 * Ownership (this sender contributes the maximum count for the number) is what
 * separates them, and it must hold on every path including the fallback.
 */

const SWITCHBOARD = '+919111911100';  // on every signature in the org
const POOJA = '+919988776655';
const BINDU = '+918877665544';

const mk = (email: string, pairs: Array<[string, number]>): SenderPhones => ({
  email,
  domain: 'sarv.com',
  phones: new Map(pairs.map(([k, count]) => [k, { count, display: k }])),
});

/** A 12-person org where everyone carries the switchboard. */
function org(extra: SenderPhones[]): SenderPhones[] {
  const members: SenderPhones[] = [...extra];
  for (let i = 0; i < 12 - extra.length; i++) {
    members.push(mk(`c${i}@sarv.com`, [[SWITCHBOARD, 3], [`+9198765432${String(10 + i).slice(-2)}`, 3]]));
  }
  return members;
}

describe('classifyDomainPhones', () => {
  it('identifies the shared switchboard as the office line', () => {
    const r = classifyDomainPhones(org([mk('pkh@sarv.com', [[SWITCHBOARD, 5], [POOJA, 5]])]));
    expect(r.get('pkh@sarv.com')!.officePhone).toBe(SWITCHBOARD);
  });

  it('keeps a personal mobile even when colleagues have quoted it', () => {
    // She still writes it more than anyone quotes it — she owns it.
    const r = classifyDomainPhones(org([
      mk('pkh@sarv.com', [[SWITCHBOARD, 5], [POOJA, 5]]),
      mk('a@sarv.com', [[SWITCHBOARD, 3], [POOJA, 2]]),
      mk('b@sarv.com', [[SWITCHBOARD, 3], [POOJA, 2]]),
      mk('c@sarv.com', [[SWITCHBOARD, 3], [POOJA, 2]]),
    ]));
    expect(r.get('pkh@sarv.com')!.directPhone).toBe(POOJA);
  });

  it('NEVER assigns a colleague\'s number to someone who merely quoted it', () => {
    // Bindu owns +918877665544 (count 6). Pkh quoted it twice.
    const r = classifyDomainPhones(org([
      mk('bindu@sarv.com', [[SWITCHBOARD, 3], [BINDU, 6]]),
      mk('pkh@sarv.com', [[SWITCHBOARD, 5], [BINDU, 2]]),
    ]));
    expect(r.get('pkh@sarv.com')!.directPhone).not.toBe(BINDU);
    expect(r.get('bindu@sarv.com')!.directPhone).toBe(BINDU);
  });

  it('does not claim a colleague\'s number even when the quoter has no number of their own', () => {
    // The fallback path: Pkh has nothing else to offer. It must still refuse.
    const r = classifyDomainPhones(org([
      mk('bindu@sarv.com', [[SWITCHBOARD, 3], [BINDU, 6]]),
      mk('pkh@sarv.com', [[SWITCHBOARD, 5], [BINDU, 1]]),
    ]));
    expect(r.get('pkh@sarv.com')!.directPhone).toBeNull();
  });

  it('claims neither of two genuinely shared org lines', () => {
    const OTHER = '+911204567890';
    const members: SenderPhones[] = [];
    for (let i = 0; i < 12; i++) members.push(mk(`c${i}@sarv.com`, [[SWITCHBOARD, 3], [OTHER, 3]]));
    expect(classifyDomainPhones(members).get('c0@sarv.com')!.directPhone).toBeNull();
  });

  it('treats a public-domain sender\'s most-used number as their own', () => {
    const r = classifyDomainPhones([
      { email: 'someone@gmail.com', domain: 'gmail.com', phones: new Map([[POOJA, { count: 4, display: POOJA }]]) },
    ]);
    expect(r.get('someone@gmail.com')!.directPhone).toBe(POOJA);
    expect(r.get('someone@gmail.com')!.officePhone).toBeNull();
  });
});

describe('recurrence versus a single well-formatted sighting', () => {
  const BHUPESH = '+919414511220';   // his own mobile, in 49 of his own mails
  const VENDOR = '+917033058211';    // a supplier's, in one mail he forwarded

  /** A domain big enough for the org test, so SWITCHBOARD is an orgKey. */
  const withColleagues = (subject: SenderPhones): SenderPhones[] => [
    subject,
    ...['a', 'b', 'c', 'd'].map((n) => ({
      email: `${n}@sarv.com`,
      domain: 'sarv.com',
      phones: new Map([[SWITCHBOARD, { display: SWITCHBOARD, count: 30 }]]),
      scores: { [SWITCHBOARD]: 35 },
    })),
  ];

  // Regression: score decided outright and count only broke ties, so ONE
  // sighting of a cleanly-formatted vendor signature (50) beat the sender's own
  // mobile sitting in 49 of his own emails (35). His card showed the vendor's
  // number. Recurrence in a person's own outgoing mail is the strongest
  // ownership evidence there is and cannot be a tiebreak.
  it('prefers the number seen 49 times over the one seen once', () => {
    const bhupesh: SenderPhones = {
      email: 'bhupesh@sarv.com',
      domain: 'sarv.com',
      phones: new Map([
        [BHUPESH, { display: BHUPESH, count: 49 }],
        [VENDOR, { display: VENDOR, count: 1 }],
        [SWITCHBOARD, { display: SWITCHBOARD, count: 51 }],
      ]),
      scores: { [BHUPESH]: 35, [VENDOR]: 50, [SWITCHBOARD]: 50 },
    };
    const out = classifyDomainPhones(withColleagues(bhupesh));
    expect(out.get('bhupesh@sarv.com')).toEqual({
      officePhone: SWITCHBOARD,
      directPhone: BHUPESH,
    });
  });

  // The bonus must ORDER candidates without swamping the per-email signals: a
  // number seen twice is not thereby better than a signature seen once. If the
  // weight ever grows enough to invert this, a number quoted in passing starts
  // outranking a real sign-off.
  it('does not let two sightings overturn a much stronger signal', () => {
    const sender: SenderPhones = {
      email: 'e@sarv.com',
      domain: 'sarv.com',
      phones: new Map([
        ['+919000000001', { display: '+919000000001', count: 2 }],
        ['+919000000002', { display: '+919000000002', count: 1 }],
      ]),
      scores: { '+919000000001': 10, '+919000000002': 70 },
    };
    const out = classifyDomainPhones(withColleagues(sender));
    expect(out.get('e@sarv.com')?.directPhone).toBe('+919000000002');
  });

  // Recurrence must never buy a number the sender does not own. The ownership
  // test (their count is the domain maximum) still runs first, so quoting a
  // colleague's mobile a hundred times cannot claim it.
  it('cannot claim a colleague’s number however often it is quoted', () => {
    const owner: SenderPhones = {
      email: 'pooja@sarv.com',
      domain: 'sarv.com',
      phones: new Map([[POOJA, { display: POOJA, count: 200 }]]),
      scores: { [POOJA]: 35 },
    };
    const quoter: SenderPhones = {
      email: 'quoter@sarv.com',
      domain: 'sarv.com',
      phones: new Map([[POOJA, { display: POOJA, count: 100 }]]),
      scores: { [POOJA]: 35 },
    };
    const out = classifyDomainPhones(withColleagues(owner).concat(quoter));
    expect(out.get('quoter@sarv.com')?.directPhone).toBeNull();
    expect(out.get('pooja@sarv.com')?.directPhone).toBe(POOJA);
  });
});

describe('recurrenceBonus', () => {
  // Regression: the bonus must be bounded and monotonic. An unbounded one lets
  // a high-volume sender's every stray number outrank real signature evidence;
  // a non-monotonic one makes the ranking depend on mailbox size.
  it('is zero for a single sighting and saturates at eight', () => {
    expect(recurrenceBonus(0)).toBe(0);
    expect(recurrenceBonus(1)).toBe(0);
    expect(recurrenceBonus(2)).toBeGreaterThan(0);
    expect(recurrenceBonus(8)).toBe(MAX_RECURRENCE_BONUS);
    expect(recurrenceBonus(49)).toBe(MAX_RECURRENCE_BONUS);
    expect(recurrenceBonus(10_000)).toBe(MAX_RECURRENCE_BONUS);
  });

  it('never decreases as sightings grow', () => {
    for (let n = 1; n < 40; n++) {
      expect(recurrenceBonus(n + 1)).toBeGreaterThanOrEqual(recurrenceBonus(n));
    }
  });

  // A missing/garbage count must not produce NaN — NaN poisons every
  // comparison in the sort and silently randomises the ranking.
  it('treats a non-finite count as no evidence', () => {
    expect(recurrenceBonus(NaN)).toBe(0);
    expect(recurrenceBonus(Infinity)).toBe(0);
  });
});
