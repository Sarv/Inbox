import { describe, expect, it } from 'vitest';

import { classifyDomainPhones, mineAttributedPhones, minePhones, type SenderPhones } from '../../../src/contact-enrichment/phone-classifier';
import { splitByAuthor } from '../../../src/contact-enrichment/quote-attribution';

/**
 * End-to-end attribution: a signature quoted inside someone else's mail must
 * count for the person the quote header names, never for the forwarder.
 */

const BINDU = '+918877665544';
const SWITCHBOARD = '+919111911100';

/** Pkh forwards a chain that carries Bindu's signature. */
const PKH_MAIL_QUOTING_BINDU = `Please see below.

Thanks,
Pooja Khatri
CBO
+91 9988-776-655

On Tue, 6 May 2026 at 09:12, Bindu Yagnik <bindu@sarv.com>
wrote:

Sharing the deck.

Regards,
Bindu Yagnik
Manager
+91 88776 65544
www.sarv.com | +91-9111-9111-00`;

describe('splitByAuthor', () => {
  it('names the author of each quoted block from its header', () => {
    const segs = splitByAuthor(PKH_MAIL_QUOTING_BINDU, 'pkh@sarv.com');
    expect(segs[0].author).toBe('pkh@sarv.com');
    expect(segs.some((s) => s.author === 'bindu@sarv.com')).toBe(true);
  });

  it('leaves the author null when the header carries no address', () => {
    const segs = splitByAuthor('Mine.\n\nOn Tuesday someone wrote:\n\nTheirs.', 'a@x.com');
    expect(segs[0].author).toBe('a@x.com');
    expect(segs[1].author).toBeNull();
  });

  it('treats an unquoted body as entirely the sender\'s', () => {
    const segs = splitByAuthor('Just a note.', 'a@x.com');
    expect(segs).toHaveLength(1);
    expect(segs[0].author).toBe('a@x.com');
  });
});

describe('mineAttributedPhones', () => {
  it('credits the quoted signature to Bindu, not to Pkh', () => {
    const byAuthor = mineAttributedPhones([PKH_MAIL_QUOTING_BINDU], 'pkh@sarv.com');

    const pkh = byAuthor.get('pkh@sarv.com');
    const bindu = byAuthor.get('bindu@sarv.com');

    expect([...(pkh?.keys() ?? [])]).not.toContain(BINDU);
    expect([...(bindu?.keys() ?? [])]).toContain(BINDU);
  });

  it('does not let the plain miner attribute Bindu\'s number to Pkh either', () => {
    // The stripping guards should already keep it out of Pkh's own tally.
    expect([...minePhones([PKH_MAIL_QUOTING_BINDU], 'pkh@sarv.com').keys()])
      .not.toContain(BINDU);
  });
});

describe('attribution feeds ownership', () => {
  it('lets a rarely-sending but often-quoted person keep their own number', () => {
    // Bindu sent one mail; Pkh quoted her three times. Evidence from the
    // quotes is credited to Bindu, so she out-owns everyone for her number.
    const evidence = new Map<string, { display: string; count: number }>();
    for (const body of [PKH_MAIL_QUOTING_BINDU, PKH_MAIL_QUOTING_BINDU, PKH_MAIL_QUOTING_BINDU]) {
      const got = mineAttributedPhones([body], 'pkh@sarv.com').get('bindu@sarv.com');
      for (const [k, v] of got ?? []) {
        const cur = evidence.get(k) || { display: v.display, count: 0 };
        cur.count += v.count;
        evidence.set(k, cur);
      }
    }

    const senders: SenderPhones[] = [
      { email: 'bindu@sarv.com', domain: 'sarv.com', phones: evidence },
      { email: 'pkh@sarv.com', domain: 'sarv.com', phones: new Map([[SWITCHBOARD, { display: SWITCHBOARD, count: 5 }]]) },
    ];
    for (let i = 0; i < 10; i++) {
      senders.push({
        email: `c${i}@sarv.com`, domain: 'sarv.com',
        phones: new Map([[SWITCHBOARD, { display: SWITCHBOARD, count: 3 }]]),
      });
    }

    const r = classifyDomainPhones(senders);
    expect(r.get('bindu@sarv.com')!.directPhone).toBe(BINDU);
    expect(r.get('pkh@sarv.com')!.directPhone).not.toBe(BINDU);
  });
});
