import { describe, expect, it } from 'vitest';

import {
  applyDomainSignals,
  classifyPhone,
  nameTokensFor,
  scoreCandidate,
  type PhoneCandidate,
} from '../../../src/contact-enrichment/phone-scoring';
import { segmentZones } from '../../../src/contact-enrichment/zones';

/**
 * Scoring replaces accept/reject booleans, so the assertions are about ORDER
 * and CLASSIFICATION — a labelled mobile in a signature must outrank a bare
 * number in prose — rather than about exact totals, which are tunable.
 */

const candidate = (over: Partial<PhoneCandidate> = {}): PhoneCandidate => ({
  e164: '+919988776655',
  display: '9988776655',
  source: 'Pooja Khatri\nCBO\nMobile: 9988776655',
  index: 'Pooja Khatri\nCBO\nMobile: '.length,
  zone: 'signature',
  ...over,
});

const opts = { fromAddress: 'pooja.k@sarv.com', displayName: 'Pooja Khatri' };

describe('scoreCandidate', () => {
  it('scores a labelled mobile in a signature as the sender\'s direct line', () => {
    const s = scoreCandidate(candidate(), opts);
    expect(classifyPhone(s)).toBe('direct');
  });

  it('ranks a signature number above the same number in prose', () => {
    const sig = scoreCandidate(candidate({ zone: 'signature' }), opts);
    const body = scoreCandidate(candidate({ zone: 'body' }), opts);
    expect(sig.score).toBeGreaterThan(body.score);
  });

  it('rejects a fax number even when it sits in the signature', () => {
    const s = scoreCandidate(candidate({
      source: 'Pooja Khatri\nCBO\nFax: 9988776655',
      index: 'Pooja Khatri\nCBO\nFax: '.length,
    }), opts);
    expect(classifyPhone(s)).toBe('rejected');
  });

  it('rejects a toll-free number', () => {
    const s = scoreCandidate(candidate({
      display: '18001234567',
      source: 'Support Toll-Free 1800 123 4567',
      index: 'Support Toll-Free '.length,
    }), opts);
    expect(classifyPhone(s)).toBe('rejected');
  });

  it('demotes an explicitly labelled office line below a personal one', () => {
    const office = scoreCandidate(candidate({
      source: 'Pooja Khatri\nOffice: 9988776655', index: 'Pooja Khatri\nOffice: '.length,
    }), opts);
    const mobile = scoreCandidate(candidate(), opts);
    expect(mobile.score).toBeGreaterThan(office.score);
  });

  // Regression: html-to-text renders a link as `text [href]` and mining keeps
  // hrefs on, so a click-to-call button arrives as `[tel:+91...]`. ORG_LABEL
  // matched that `tel` and docked 20 points from the one number the person
  // deliberately made clickable — and when the button shows no digits, the href
  // is the ONLY place that number appears.
  it('does not read a tel: href as an office label', () => {
    const href = 'Pooja Khatri\nCBO\nCall me [tel: +919988776655]';
    const scored = scoreCandidate(candidate({
      source: href, index: href.indexOf('+919988776655'),
    }), opts);
    expect(scored.reasons.join(' ')).not.toMatch(/org label/);
    expect(classifyPhone(scored)).toBe('direct');
  });

  // Regression: the exemption above must stay narrow. `Tel:` WRITTEN OUT in a
  // signature really does mean the landline in most of them, and loosening
  // ORG_LABEL wholesale would promote every switchboard to a personal line.
  it('still demotes a written Tel: label', () => {
    const written = 'Pooja Khatri\nCBO\nTel: 9988776655';
    const scored = scoreCandidate(candidate({
      source: written, index: written.indexOf('9988776655'),
    }), opts);
    expect(scored.reasons.join(' ')).toMatch(/org label/);
  });

  it('boosts a number sitting next to the sender\'s name', () => {
    const near = scoreCandidate(candidate({
      source: 'Pooja Khatri 9988776655', index: 'Pooja Khatri '.length,
    }), opts);
    const far = scoreCandidate(candidate({
      source: `${'x'.repeat(300)}9988776655`, index: 300,
    }), opts);
    expect(near.score).toBeGreaterThan(far.score);
  });

  it('penalises a number inside a legal disclaimer', () => {
    const s = scoreCandidate(candidate({
      zone: 'disclaimer',
      source: 'This e-mail is confidential and intended for the addressee. Tel 9988776655',
      index: 'This e-mail is confidential and intended for the addressee. Tel '.length,
    }), opts);
    expect(classifyPhone(s)).toBe('rejected');
  });
});

describe('applyDomainSignals', () => {
  it('demotes a number carried by several colleagues to a company line', () => {
    const base = scoreCandidate(candidate(), opts);
    const shared = applyDomainSignals(base, { distinctSenders: 8, ownCount: 3 });
    expect(classifyPhone(shared)).not.toBe('direct');
    expect(shared.score).toBeLessThan(base.score);
  });

  it('promotes a number unique to one sender', () => {
    const base = scoreCandidate(candidate({ zone: 'body' }), opts);
    const unique = applyDomainSignals(base, { distinctSenders: 1, ownCount: 4 });
    expect(unique.score).toBeGreaterThan(base.score);
  });

  it('keeps a personal signature number direct despite one colleague quoting it', () => {
    const base = scoreCandidate(candidate(), opts);
    const withStats = applyDomainSignals(base, { distinctSenders: 2, ownCount: 5 });
    expect(classifyPhone(withStats)).toBe('direct');
  });
});

describe('nameTokensFor', () => {
  it('derives usable tokens from a dotted local part', () => {
    expect(nameTokensFor('meghna.k@sarv.com')).toContain('meghna');
  });

  it('prefers the display name when available', () => {
    expect(nameTokensFor('pkh@sarv.com', 'Pooja Khatri')).toEqual(
      expect.arrayContaining(['pooja', 'khatri']),
    );
  });

  it('drops fragments too short to match safely', () => {
    expect(nameTokensFor('a.b@x.com')).toEqual([]);
  });
});

describe('segmentZones', () => {
  const body = `Please review the attached.

--
Pooja Khatri
CBO
Mobile: 9988776655

On Wed, 29 Jul 2026, Bindu Yagnik <bindu.y@sarv.com> wrote:

Sharing the deck.
Regards
Bindu
+91 88776 65544`;

  it('separates the sender\'s signature from quoted history', () => {
    const zones = segmentZones(body, 'pkh@sarv.com');
    const kinds = zones.map((z) => z.kind);
    expect(kinds).toContain('signature');
    expect(kinds).toContain('quoted');
  });

  it('attributes the quoted zone to the author named in the header', () => {
    const quoted = segmentZones(body, 'pkh@sarv.com').find((z) => z.kind === 'quoted');
    expect(quoted?.author).toBe('bindu.y@sarv.com');
  });

  it('keeps the sender\'s own number out of the quoted zone', () => {
    const quoted = segmentZones(body, 'pkh@sarv.com').find((z) => z.kind === 'quoted');
    expect(quoted?.text).not.toContain('9988776655');
  });

  it('splits a legal disclaimer into its own zone', () => {
    const withFooter = `Hi\n\n--\nAjay\nMobile: 9988776655\n\nThis e-mail is confidential and intended for the addressee only.\nTel 0141 4000000`;
    const zones = segmentZones(withFooter, 'ajay@sarv.com');
    expect(zones.map((z) => z.kind)).toContain('disclaimer');
  });

  it('returns nothing for an empty body', () => {
    expect(segmentZones('', 'a@b.com')).toEqual([]);
  });
});

describe('noise vetoes', () => {
  const veto = (source: string, label: string) => {
    const idx = source.indexOf(label) + label.length;
    return scoreCandidate(
      { e164: '+912026004512', display: 'x', source, index: idx, zone: 'body' },
      opts,
    );
  };

  it.each([
    ['Invoice INV-2026-004512 due', 'Invoice '],
    ['Meeting ID: 842 1928 3311', 'Meeting ID: '],
    ['Passcode: 981234', 'Passcode: '],
    ['PIN 4821 9930 11', 'PIN '],
    ['Order No 2026004512', 'Order No '],
    ['Tracking 2026004512', 'Tracking '],
    ['Ref: 2026004512', 'Ref: '],
    ['Fax: 2026004512', 'Fax: '],
  ])('vetoes %s', (source, label) => {
    expect(classifyPhone(veto(source, label))).toBe('rejected');
  });
});

describe('spatial position', () => {
  it('rewards a number in the bottom fifth of the body over one mid-paragraph', () => {
    const src = 'Pooja Khatri 9988776655';
    const bottom = scoreCandidate(
      { e164: '+919988776655', display: 'x', source: src, index: 15, zone: 'body', relativePosition: 0.95 },
      opts,
    );
    const middle = scoreCandidate(
      { e164: '+919988776655', display: 'x', source: src, index: 15, zone: 'body', relativePosition: 0.4 },
      opts,
    );
    expect(bottom.score).toBeGreaterThan(middle.score);
  });

  it('does not stack the position bonus onto a disclaimer', () => {
    const s = scoreCandidate(
      {
        e164: '+919988776655', display: 'x',
        source: 'This e-mail is confidential. Tel 9988776655',
        index: 'This e-mail is confidential. Tel '.length,
        zone: 'disclaimer', relativePosition: 0.99,
      },
      opts,
    );
    expect(s.reasons.join(' ')).not.toContain('bottom of body');
    expect(classifyPhone(s)).toBe('rejected');
  });
});

/**
 * Regression: a label describes the number it precedes, nothing else.
 *
 * Sarv signatures print mobile, switchboard and toll-free within a few
 * characters of each other. Matching labels across the whole neighbourhood
 * vetoed all three, so every contact on that domain lost both their direct and
 * office number at once.
 */
describe('label radius', () => {
  const SIG = 'Madhav Sethi\nTeam Lead\n+91 9090909005\nwww.sarv.com | +919111911100 |\n1800123456001';

  it('does not veto a number merely printed near a toll-free line', () => {
    const idx = SIG.indexOf('9090909005');
    const s = scoreCandidate(
      { e164: '+919090909005', display: 'x', source: SIG, index: idx, zone: 'signature' },
      { fromAddress: 'madhav.s@sarv.com' },
    );
    expect(s.vetoed).toBe(false);
    expect(classifyPhone(s)).not.toBe('rejected');
  });

  it('does not veto the switchboard printed beside a toll-free line', () => {
    const idx = SIG.indexOf('919111911100');
    const s = scoreCandidate(
      { e164: '+919111911100', display: 'x', source: SIG, index: idx, zone: 'signature' },
      { fromAddress: 'madhav.s@sarv.com' },
    );
    expect(s.vetoed).toBe(false);
  });

  it('still vetoes a number the label directly precedes', () => {
    const src = 'Ajay\nMobile: 9988776655\nFax: 9876500000';
    const s = scoreCandidate(
      { e164: '+919876500000', display: 'x', source: src, index: src.indexOf('9876500000'), zone: 'signature' },
      { fromAddress: 'ajay@sarv.com' },
    );
    expect(s.vetoed).toBe(true);
  });
});

describe('a label never reads across a line break', () => {
  // Regression: ORG_LABEL matched the word "Support" in the sender's JOB TITLE
  // on the line above his number, docking his own mobile 20 points. That put it
  // below a vendor's number he had forwarded once, and his contact card showed
  // the vendor's. Every "... Support", "Head of Sales", "Office Manager"
  // signature had the same hole.
  it('does not read a job title on the line above as an org label', () => {
    const src = 'Bhupesh Chugh VP Support\n+91 9414511220';
    const s = scoreCandidate(
      { e164: '+919414511220', display: 'x', source: src, index: src.indexOf('+91 9414511220'), zone: 'signature' },
      { fromAddress: 'bhupesh@sarv.com' },
    );
    expect(s.reasons).not.toContain('-20 org label');
    expect(s.score).toBeGreaterThan(0);
  });

  // The flip side, and why the window is narrowed rather than removed: a label
  // on the SAME line is exactly what the penalty is for, and must still apply.
  it('still reads a label printed beside the number', () => {
    const src = 'Bhupesh Chugh\nOffice: +91 9111911100';
    const s = scoreCandidate(
      { e164: '+919111911100', display: 'x', source: src, index: src.indexOf('+91 9111911100'), zone: 'signature' },
      { fromAddress: 'bhupesh@sarv.com' },
    );
    expect(s.reasons).toContain('-20 org label');
  });

  // A veto must not leak across a line break either — "Fax" ending the line
  // above is not describing the number below it.
  it('does not veto on a word that ends the previous line', () => {
    const src = 'Sales & Fax\n+91 9876500000';
    const s = scoreCandidate(
      { e164: '+919876500000', display: 'x', source: src, index: src.indexOf('+91 9876500000'), zone: 'signature' },
      { fromAddress: 'ajay@sarv.com' },
    );
    expect(s.vetoed).toBe(false);
  });
});
