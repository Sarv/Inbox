import { describe, expect, it } from 'vitest';

import { mineContactSignals } from '../../../src/contact-enrichment/phone-classifier';
import { htmlMiningWindow, htmlToPlainText } from '../../../src/utils/html-text';

/**
 * The mining pipeline exactly as the contact scan runs it: raw HTML -> window
 * -> plain text (hrefs kept) -> signal extraction. These are the shapes users
 * reported as "their signature has a personal number and it never reaches the
 * contact list", reproduced end to end so a fix in one stage cannot be undone
 * by the next.
 */

// Mirrors apps/desktop/electron/ipc/contacts-handlers.ts. Kept small so the
// fixtures below are comfortably over budget without megabytes of padding.
const BUDGET = 4 * 1024;
const mine = (rawHtml: string, from: string) => {
  const windowed = htmlMiningWindow(rawHtml, BUDGET);
  const text = htmlToPlainText(windowed, { keepLinkHrefs: true });
  return mineContactSignals([text], from);
};

const AMIT = 'amit.shukla@acme.in';
const AMIT_MOBILE = '+919876543210';
const RAVI_MOBILE = '+919000011111';

const amitSignature = `
  <p>Regards,</p>
  <p>Amit Shukla<br>Engineering Lead<br>M: +91 98765 43210<br>acme.in</p>`;

const quotedChain = (repeat: number) => `
  <div>On Mon, 2 Mar 2026 at 10:04, Ravi Menon &lt;ravi@vendor.co.in&gt; wrote:</div>
  <blockquote>
    ${'<p>Circling back on the revised timeline for the integration work.</p>'.repeat(repeat)}
    <p>Best,<br>Ravi Menon<br>Account Manager<br>M: +91 90000 11111</p>
  </blockquote>`;

describe('mining a top-posted reply', () => {
  // Regression: the scan used to convert only the LAST 12KB of a body. In a
  // reply the sender writes at the TOP, so their own signature sat above the
  // quoted chain and outside that window — the scan mined the chain instead and
  // the sender's own mobile never entered the contact list at all.
  it("finds the sender's own signature above a long quoted chain", () => {
    const reply = `<p>Thanks Ravi, looks good.</p>${amitSignature}${quotedChain(80)}`;
    expect(reply.length).toBeGreaterThan(BUDGET);

    const { phones } = mine(reply, AMIT);
    expect([...phones.keys()]).toContain(AMIT_MOBILE);
  });

  // Regression: proves the assertion above is about the window and not about
  // the fixture being small enough to fit — the old tail-only slice provably
  // cannot see this number.
  it('proves a tail-only window would have missed it', () => {
    const reply = `<p>Thanks Ravi, looks good.</p>${amitSignature}${quotedChain(80)}`;
    const { phones } = mine(reply.slice(-BUDGET), AMIT);
    expect([...phones.keys()]).not.toContain(AMIT_MOBILE);
  });

  // Regression: fixing the top-posted case must not lose the bottom-posted one.
  // A first message (no quote) carries its signature at the very end, which is
  // what the old tail-only window was built for.
  it('still finds a signature at the end of a long first message', () => {
    const long = `<div>${'<p>Detailed status update paragraph.</p>'.repeat(120)}</div>${amitSignature}`;
    expect(long.length).toBeGreaterThan(BUDGET);

    const { phones } = mine(long, AMIT);
    expect([...phones.keys()]).toContain(AMIT_MOBILE);
  });

  // Regression: the quoted correspondent's number is still evidence (quote
  // attribution credits it to its author elsewhere), but it must never outrank
  // the sender's own signature — that is how one person's mobile ends up on
  // another person's contact card.
  it("ranks the sender's own number above the one they quoted", () => {
    const reply = `<p>Thanks Ravi, looks good.</p>${amitSignature}${quotedChain(80)}`;
    const { scores } = mine(reply, AMIT);
    if (scores[RAVI_MOBILE] !== undefined) {
      expect(scores[AMIT_MOBILE]).toBeGreaterThan(scores[RAVI_MOBILE]);
    }
    expect(scores[AMIT_MOBILE]).toBeGreaterThan(0);
  });
});

describe('mining a click-to-call signature', () => {
  // Regression: a signature whose number lives only behind a tel: link.
  // html-to-text renders it as `Call me [tel:+91...]`, and the org-label rule
  // matched that `tel` and scored the number DOWN as a switchboard — the one
  // number the person deliberately made clickable.
  it('finds a number carried only by a tel: href and does not demote it', () => {
    const html = `
      <p>Regards,</p>
      <p>Amit Shukla<br>Engineering Lead<br>
      <a href="tel:+919876543210">Call me</a><br>
      <a href="mailto:amit.shukla@acme.in">amit.shukla@acme.in</a></p>`;

    const { phones, scores } = mine(html, AMIT);
    expect([...phones.keys()]).toContain(AMIT_MOBILE);
    // Same signature, same number, written out instead of linked: the linked
    // form must not be worth less than the plain one.
    const plain = mine(html.replace('<a href="tel:+919876543210">Call me</a>', '+91 98765 43210'), AMIT);
    expect(scores[AMIT_MOBILE]).toBeGreaterThanOrEqual(plain.scores[AMIT_MOBILE]);
  });

  // Regression: a tel: href inside the QUOTED chain of a top-posted reply is
  // someone else's call button. Un-penalising the URI must not turn it into
  // this sender's direct line.
  it('does not adopt a tel: href from the quoted chain as the sender\'s own', () => {
    const reply = `<p>Thanks.</p>${amitSignature}
      <blockquote>
        ${'<p>Earlier message text.</p>'.repeat(80)}
        <p>Ravi Menon<br><a href="tel:+919000011111">Call Ravi</a></p>
      </blockquote>`;
    const { scores } = mine(reply, AMIT);
    if (scores[RAVI_MOBILE] !== undefined) {
      expect(scores[AMIT_MOBILE]).toBeGreaterThan(scores[RAVI_MOBILE]);
    }
  });
});
