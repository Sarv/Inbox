import { describe, expect, it } from 'vitest';

import { inboxAssistantEvidenceText, normalizeExcerpt, verifyInboxAssistantFacts } from '../../../../electron/services/inbox-assistant-answer';
import type { InboxAssistantEvidence, InboxAssistantFactRejectionReason } from '../../../../src/types/inbox-assistant';

/**
 * The amount checker: every amount in an answer must be in the quoted email
 * text, or be an exact total of one quoted amount per cited email. These
 * shapes come from real receipts, bank alerts and invoices whose correct
 * amounts were thrown away (audit issue 9); the figures here are made up.
 */

const source = (id: string, text: string, overrides: Partial<InboxAssistantEvidence> = {}): InboxAssistantEvidence => ({
  id, kind: 'message', accountId: 'primary', accountEmail: 'owner@example.test', emailId: `email-${id}`,
  subject: `Message ${id}`, from: 'billing@vendor.example', to: ['owner@example.test'],
  date: Date.UTC(2026, 10, 16) / 1_000, folder: 'INBOX', sent: false, excerpt: text.slice(0, 80), text, ...overrides,
});
type Quote = { sourceId: string; text: string };
const fact = (text: string, quotes: Quote[]) => ({ text, sourceIds: [...new Set(quotes.map(quote => quote.sourceId))], quotes });
/** The verifier as the Inbox Agent runs it: each email checked against the evidence text it was shown as. */
const verify = (sources: InboxAssistantEvidence[], ...facts: unknown[]) => verifyInboxAssistantFacts(facts,
  new Map(sources.map(item => [item.id, normalizeExcerpt(inboxAssistantEvidenceText(item))])), sources);
const rejections = (sources: InboxAssistantEvidence[], ...facts: unknown[]) => {
  const counts: Partial<Record<InboxAssistantFactRejectionReason, number>> = {};
  for (const { reason } of verify(sources, ...facts).rejectedFacts) counts[reason] = (counts[reason] ?? 0) + 1;
  return counts;
};

describe('amounts whose currency is written as a label', () => {
  const invoice = source('S1', 'Business WhatsApp postpaid invoice. Period: Oct\'26\nTotal tax(INR): 1,234.56 \nRound Off: 0.25 \nTotal Amount(INR): 8,100.00');
  const quote = { sourceId: 'S1', text: 'Total tax(INR): 1,234.56 \nRound Off: 0.25 \nTotal Amount(INR): 8,100.00' };

  // Breaks: an invoice that writes "Total Amount(INR): 8,100.00" can never be quoted, so every invoice total is dropped.
  it('verifies an amount after a "(INR):" label, in any currency spelling', () => {
    const result = verify([invoice],
      fact('The October invoice totals ₹8,100.00, including ₹1,234.56 in tax.', [quote]),
      fact('The October invoice totals INR 8,100.', [quote]));
    expect(result.facts.map(item => item.text)).toEqual(['The October invoice totals ₹8,100.00, including ₹1,234.56 in tax.', 'The October invoice totals INR 8,100.']);
  });

  // Breaks: the label form would let a changed figure or a changed currency through.
  it('still rejects a changed figure or a different currency after a label', () => {
    expect(rejections([invoice],
      fact('The October invoice totals ₹8,100.01.', [quote]),
      fact('The October invoice totals USD 8,100.00.', [quote]))).toEqual({ unsupported_number_or_currency: 2 });
  });

  // Breaks: "Amount in INR: 1,250" and "Fee (USD) 40" stop counting as amounts in that currency.
  it('verifies "INR: 1,250" and a label without a colon', () => {
    const text = 'Amount in INR: 1,250\nSupport fee (USD) 40';
    const result = verify([source('S1', text)], fact('The amount is INR 1,250 and the support fee is USD 40.', [{ sourceId: 'S1', text }]));
    expect(result.facts).toHaveLength(1);
  });
});

describe('dollar amounts and their currency code', () => {
  const receipt = source('S1', 'You paid $ 34.95 USD to Hosting Vendor Ltd');
  const quote = { sourceId: 'S1', text: 'You paid $ 34.95 USD to Hosting Vendor Ltd' };

  // Breaks: a PayPal-style "$ 34.95 USD" could only be restated as "$34.95", never as "USD 34.95".
  it('reads "$ 34.95 USD" as US dollars, so "USD 34.95" and "$34.95" both verify', () => {
    const result = verify([receipt], fact('You paid USD 34.95.', [quote]), fact('You paid $34.95.', [quote]));
    expect(result.facts).toHaveLength(2);
  });

  // Breaks: the code after the number would be ignored, or a bare "$" would be taken as proof of one particular dollar.
  it('rejects another dollar, and a currency code the email does not state', () => {
    expect(rejections([receipt], fact('You paid CAD 34.95.', [quote]))).toEqual({ unsupported_number_or_currency: 1 });
    const bare = source('S1', 'You paid $34.95 to Hosting Vendor Ltd');
    expect(rejections([bare], fact('You paid USD 34.95.', [{ sourceId: 'S1', text: 'You paid $34.95 to Hosting Vendor Ltd' }])))
      .toEqual({ unsupported_number_or_currency: 1 });
  });
});

// Breaks: in a list of whole amounts ("INR 500, INR 600") the comma and the next currency were read as part of
// the first amount, so the second one was never seen and any statement listing it was rejected.
it('reads every amount in a comma-separated list of whole amounts', () => {
  const text = 'Charges: INR 500, INR 600, $ 70, USD 80.';
  const result = verify([source('S1', text)], fact('The charges were INR 500, INR 600, $70 and USD 80.', [{ sourceId: 'S1', text }]));
  expect(result.facts).toHaveLength(1);
  expect(rejections([source('S1', text)], fact('The charges were INR 500 and INR 601.', [{ sourceId: 'S1', text }])))
    .toEqual({ unsupported_number_or_currency: 1 });
});

// Breaks: a bank alert whose no-break space was mis-decoded ("INR�8406.3") can never be quoted for its amount.
it('treats a replacement character between currency and number as a space', () => {
  const text = 'Transaction Amount: INR�2406.3 spent on credit card no. XX0000';
  const result = verify([source('S1', text)], fact('INR 2,406.30 was spent on the card.', [{ sourceId: 'S1', text }]));
  expect(result.facts).toHaveLength(1);
});

describe('totals across the cited emails', () => {
  const alertA = source('S1', 'Transaction Amount: INR 1458.39 Merchant Name: VENDOR A Date & Time: 16-11-2026, 12:20:43 IST');
  const alertB = source('S2', 'Transaction Amount: INR 2406.3 Merchant Name: VENDOR B Date & Time: 16-11-2026, 12:20:30 IST',
    { accountId: 'secondary', accountEmail: 'other@example.test' });
  const quotes = [
    { sourceId: 'S1', text: 'Transaction Amount: INR 1458.39' }, { sourceId: 'S1', text: '16-11-2026, 12:20:43 IST' },
    { sourceId: 'S2', text: 'Transaction Amount: INR 2406.3' }, { sourceId: 'S2', text: '16-11-2026, 12:20:30 IST' },
  ];

  // Breaks: "how much did I spend today" can only ever list alerts; the exact total the model added up is thrown away.
  it('verifies an exact total of one amount from each cited email, across accounts', () => {
    const claim = 'The two card spends today total INR 3,864.69: INR 1,458.39 and INR 2,406.30.';
    const result = verify([alertA, alertB], fact(claim, quotes));
    expect(result.facts.map(item => item.text)).toEqual([claim]);
  });

  // Breaks: the total rule would accept a figure that is off by a paisa, a total in another currency, or a sum with no word saying it is one.
  it('rejects a wrong total, a total in another currency, and an unannounced sum', () => {
    expect(rejections([alertA, alertB],
      fact('The card spends total INR 3,864.70: INR 1,458.39 and INR 2,406.30.', quotes),
      fact('The card spends total USD 3,864.69: INR 1,458.39 and INR 2,406.30.', quotes),
      fact('Today\'s card spends came to INR 3,864.69: INR 1,458.39 and INR 2,406.30.', quotes))).toEqual({ unsupported_number_or_currency: 3 });
  });

  // Breaks: a total can hide what was added. Live, two autopay REMINDERS were summed into "today's spend" as one verified figure.
  it('rejects a total that does not name the amounts it adds', () => {
    expect(rejections([alertA, alertB],
      fact('The two card spends today total INR 3,864.69.', quotes),
      fact('The card spends total INR 3,864.69, including INR 1,458.39.', quotes))).toEqual({ unsupported_number_or_currency: 2 });
  });

  // Breaks: a "total" over some of the cited emails would verify, so the model could leave out a payment and still be confirmed.
  it('rejects a total that leaves out one of the cited emails', () => {
    const third = source('S3', 'Transaction Amount: INR 500');
    expect(rejections([alertA, alertB, third],
      fact('The card spends total INR 3,864.69: INR 1,458.39 and INR 2,406.30.', [...quotes, { sourceId: 'S3', text: 'Transaction Amount: INR 500' }])))
      .toEqual({ unsupported_number_or_currency: 1 });
    expect(verify([alertA, alertB, third],
      fact('The card spends total INR 4,364.69: INR 1,458.39, INR 2,406.30 and INR 500.', [...quotes, { sourceId: 'S3', text: 'Transaction Amount: INR 500' }])).facts).toHaveLength(1);
  });

  // Breaks: amounts inside ONE email (a fee and its tax) could be added into a "total" the email never states.
  it('does not add amounts within a single email', () => {
    const text = 'Service fee INR 1,000. Tax INR 180.';
    expect(rejections([source('S1', text)], fact('The total of INR 1,000 and INR 180 is INR 1,180.', [{ sourceId: 'S1', text }])))
      .toEqual({ unsupported_number_or_currency: 1 });
  });

  // Breaks: four receipts quoted with their amount AND converted charge (8 quotes) fail as the wrong shape, and their totals as unsupported.
  it('verifies totals in both currencies over four receipts quoted twice each', () => {
    const charges = ['3,458.39', '3,495.07', '3,501.39', '3,483.88'];
    const sources = charges.map((inr, index) => source(`S${index + 1}`, `You paid $ 34.95 USD to Hosting Vendor Ltd\nPaid Hosting Vendor Ltd with Visa ₹ ${inr} INR`));
    const quotes = sources.flatMap(item => [
      { sourceId: item.id, text: 'You paid $ 34.95 USD to Hosting Vendor Ltd' },
      { sourceId: item.id, text: item.text.split('\n')[1]! },
    ]);
    const claim = 'Four receipts were for $34.95 each, totaling $139.80 USD, charged as ₹3,458.39, ₹3,495.07, ₹3,501.39 and ₹3,483.88, a total of ₹13,938.73.';
    expect(verify(sources, fact(claim, quotes)).facts.map(item => item.text)).toEqual([claim]);
    // The rupee total without its four charges does not show what was added.
    expect(rejections(sources, fact('Four receipts were for $34.95 each, totaling $139.80 USD (₹13,938.73 INR).', quotes)))
      .toEqual({ unsupported_number_or_currency: 1 });
  });

  // Breaks: with many amounts per email the combinations explode; past the bound the checker must refuse, not hang.
  it('refuses, rather than searches, when the possible totals are too many', () => {
    const sources = Array.from({ length: 6 }, (_, index) => source(`S${index + 1}`,
      Array.from({ length: 5 }, (_, item) => `Line ${item + 1}: INR ${(index + 1) * 100 + item}`).join('. ')));
    const quotes = sources.map(item => ({ sourceId: item.id, text: item.text }));
    const smallest = sources.reduce((sum, _, index) => sum + (index + 1) * 100, 0);
    const parts = sources.map((_, index) => `INR ${(index + 1) * 100}`).join(', ');
    expect(rejections(sources, fact(`The total of ${parts} is INR ${smallest}.`, quotes))).toEqual({ unsupported_number_or_currency: 1 });
  });
});

describe('how many quotes one statement may carry', () => {
  const sources = Array.from({ length: 6 }, (_, index) => source(`S${index + 1}`, `Receipt ${index + 1}. Amount INR ${index + 1}00. Reference R-${index + 1}.`));
  const twoEach = sources.flatMap(item => [
    { sourceId: item.id, text: `Amount INR ${item.id.slice(1)}00` }, { sourceId: item.id, text: `Reference R-${item.id.slice(1)}` },
  ]);

  // Breaks: a statement citing several emails with two quotes each is dropped whole as "not in the expected format".
  it('accepts two quotes from each of six emails', () => {
    expect(twoEach).toHaveLength(12);
    expect(verify(sources, fact('Six receipts were found.', twoEach)).facts).toHaveLength(1);
  });

  // Breaks: an unbounded quote list lets one statement carry an arbitrary amount of copied text.
  it('still rejects a thirteenth quote', () => {
    expect(rejections(sources, fact('Six receipts were found.', [...twoEach, { sourceId: 'S1', text: 'Receipt 1.' }])))
      .toEqual({ invalid_fact_shape: 1 });
  });
});

