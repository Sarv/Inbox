import { describe, expect, it } from 'vitest';

import { classifyDomainPhones, type SenderPhones } from '../../../src/contact-enrichment/phone-classifier';

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
