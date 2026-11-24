import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { inboxAssistantRunSummary } from '../../../../electron/services/inbox-assistant-diagnostics';
import { createAssistantHarness, NO_FACTS, type AssistantHarness } from '../../../helpers/assistant-harness';

// How the agent decides that an email is about what the question names. These
// run the real agent on real account databases (see assistant-harness.ts), so
// the search index matches words the way it does in the app. The scripted model
// asks deep_search the question as the user typed it, then answers with no
// facts: what is asserted is what the search let through to the model.

let harness: AssistantHarness;
/** The question the scripted model passes to deep_search. */
let question = '';
beforeEach(async () => {
  harness = await createAssistantHarness({
    agent: turn => turn.messages.some(message => message.role === 'tool')
      ? { tools: [{ name: 'answer', arguments: { facts: [] } }] }
      : { tools: [{ name: 'deep_search', arguments: { question } }] },
  });
});
afterEach(async () => { await harness.close(); });

/** The planner's reply. Undefined: the planner is refused and keyword rules plan the search. */
function planWith(plan?: Record<string, unknown>): void {
  harness.ai = (_prompt, purpose) => purpose !== 'plan' ? NO_FACTS
    : plan ? JSON.stringify({ queries: ['email'], entityTerms: [], intent: 'all', quoteIntent: false, filters: {}, ...plan }) : { status: 400 };
}

/** The subjects of the excerpts deep_search showed the model, in the order it saw them. */
function subjectsSent(): string[] {
  const shown = harness.agentTurns.at(-1)?.messages.find(message => message.role === 'tool' && (message.content ?? '').startsWith('Result T1 (deep_search)'))?.content ?? '';
  return shown.split('\n\n---\n\n').slice(1).map(block => /^Subject: ([^\n]*)/m.exec(block)?.[1] ?? '?');
}

async function mail(accountId: string, id: string, subject: string, body: string, extra: Record<string, unknown> = {}): Promise<void> {
  await harness.mail(accountId, `t-${id}`, { id, subject, cleanBody: body, rawBody: `<p>${body}</p>`, ...extra });
}

async function ask(text: string): Promise<{ broadened?: string[]; warnings: string[] }> {
  harness.newChat();
  harness.calls.length = 0;
  harness.agentTurns.length = 0;
  question = text;
  const exchange = await harness.ask(text);
  // Every case goes through the tuned search, exactly once.
  expect(exchange.diagnostics?.agent?.toolCalls).toEqual({ deep_search: 1 });
  return { broadened: exchange.diagnostics?.searchBroadened, warnings: exchange.answer.warnings };
}

describe('a question that names two things', () => {
  // Breaks: "for the SCADA upgrade" requires the words "the SCADA upgrade" side
  // by side, so the proposal whose subject says "SCADA network upgrade" is thrown
  // away and the user is told nothing was found.
  it('finds mail that has every named word, in any order, without broadening', async () => {
    await mail('primary', 'bhel-scada', 'Commercial proposal - BHEL Haridwar SCADA network upgrade', 'Total price Rs. 2.35 crore plus GST.');
    const result = await ask('How much did we quote BHEL for the SCADA upgrade?');
    expect(subjectsSent()).toEqual(['Commercial proposal - BHEL Haridwar SCADA network upgrade']);
    expect(result.broadened).toBeUndefined();
  });

  // Breaks: matching by words lets mail about the same customer's OTHER work in,
  // so the model is shown a boiler quotation for a SCADA question. The gate
  // exists for exactly this, and must still turn it away.
  it('still keeps out mail that names only one of them', async () => {
    await mail('primary', 'bhel-scada', 'Commercial proposal - BHEL Haridwar SCADA network upgrade', 'Total price Rs. 2.35 crore plus GST.');
    await mail('primary', 'bhel-boiler', 'BHEL boiler maintenance quotation', 'Annual maintenance of the boiler: Rs. 18 lakh.');
    await mail('primary', 'other-scada', 'SCADA upgrade for NTPC Dadri', 'Our SCADA upgrade offer for NTPC: Rs. 1.1 crore.');
    await ask('How much did we quote BHEL for the SCADA upgrade?');
    expect(subjectsSent()).toEqual(['Commercial proposal - BHEL Haridwar SCADA network upgrade']);
  });

  // Breaks: "Has Wipro" (an auxiliary that is capitalised only because it opens
  // the question) is required as a phrase no email contains.
  it('ignores the word that opens the question', async () => {
    await mail('secondary', 'wipro-overdue', 'Payment reminder: invoice VIS/INV/1042', 'Wipro: the invoice VIS/INV/1042 is overdue by 30 days.');
    await ask('Has Wipro replied about the overdue invoice?');
    expect(subjectsSent()).toEqual(['Payment reminder: invoice VIS/INV/1042']);
  });

  // Breaks: with one account holding the right mail and another holding only
  // the customer's other work, the second account's mail is let in as well.
  it('decides across all accounts: when one account has the right mail, nothing is broadened anywhere', async () => {
    await mail('primary', 'bhel-scada', 'Commercial proposal - BHEL Haridwar SCADA network upgrade', 'Total price Rs. 2.35 crore plus GST.');
    await mail('secondary', 'bhel-boiler', 'BHEL boiler maintenance quotation', 'Annual maintenance of the boiler: Rs. 18 lakh.');
    const result = await ask('How much did we quote BHEL for the SCADA upgrade?');
    expect(subjectsSent()).toEqual(['Commercial proposal - BHEL Haridwar SCADA network upgrade']);
    expect(result.broadened).toBeUndefined();
  });
});

describe('when no email names everything the question does', () => {
  // Breaks: the agent says "I could not find supporting mail" about mail its own
  // search had just returned, so the user is told the email does not exist.
  it('uses the closest matches, says so, and records it', async () => {
    await mail('primary', 'bhel-boiler', 'BHEL boiler maintenance quotation', 'Annual maintenance of the boiler: Rs. 18 lakh.');
    const searches = vi.spyOn(harness.mailbox('primary').storage, 'searchEmails');
    const result = await ask('How much did we quote BHEL for the SCADA upgrade?');
    expect(subjectsSent()).toEqual(['BHEL boiler maintenance quotation']);
    expect(result.broadened).toEqual(['required_topics']);
    expect(result.warnings).toContain('No email mentions all of: BHEL, SCADA upgrade. These are the closest matches; check that they are about the right thing.');
    const exchange = harness.chat().exchanges.at(-1)!;
    // The search ran twice, strict then broadened, and the record describes the
    // broadened pass only: one entry per account, its own search count.
    const broadenedSearches = exchange.diagnostics!.accounts![0]!.searches;
    expect(broadenedSearches).toBeGreaterThan(0);
    expect(searches.mock.calls.length).toBeGreaterThan(broadenedSearches);
    expect(exchange.diagnostics!.accounts!.map(account => account.accountId)).toEqual(['primary', 'secondary']);
    expect(exchange.diagnostics!.accounts![0]).toMatchObject({ evidenceItems: 1 });
    expect(exchange.activities!.some(activity => activity.message === 'No email matched the question exactly')).toBe(true);
    expect(inboxAssistantRunSummary('r', 'completed', exchange.diagnostics!)).toContain(' broadened=required_topics ');
  });

  // Breaks: a search that found nothing at all is run a second time for nothing,
  // doubling the wait before "I could not find supporting mail".
  it('does not search again when the search found nothing to begin with', async () => {
    await mail('primary', 'unrelated', 'Diwali greetings', 'Office is closed on Monday.');
    const searches = vi.spyOn(harness.mailbox('primary').storage, 'searchEmails');
    const result = await ask('How much did we quote BHEL for the SCADA upgrade?');
    const once = searches.mock.calls.length;
    expect(once).toBeGreaterThan(0);
    expect(result.broadened).toBeUndefined();
    expect(subjectsSent()).toEqual([]);
    expect(harness.chat().exchanges.at(-1)!.diagnostics).toMatchObject({ route: 'agent', outcome: 'no_evidence' });
    // Asking again does exactly the same work.
    await ask('How much did we quote BHEL for the SCADA upgrade?');
    expect(searches.mock.calls.length).toBe(once * 2);
  });

  // Breaks: a question that names one thing is broadened (there is nothing to
  // broaden), or the second pass drops a filter the user asked for.
  it('leaves a question with a single topic, and its filters, alone', async () => {
    await mail('primary', 'thermax', 'Thermax quotation', 'Total Rs. 9,85,000.', { folderId: 'f-sent', tags: '|Sent|', fromAddress: 'rc@sarv.example', toAddress: 'buyer@thermax.example' });
    await mail('primary', 'thermax-in', 'Thermax enquiry', 'Please quote for Thermax.');
    const result = await ask('What quotation did we send to Thermax?');
    expect(result.broadened).toBeUndefined();
    expect(subjectsSent()).toContain('Thermax quotation');
  });
});

describe('a topic of several words', () => {
  // Breaks: the model's topic "Baner office lease" is required as a phrase, so
  // the lease mail titled "Office lease renewal - Baner" is thrown away even
  // though the search index returned it first.
  it('is found when the mail has its words in another order', async () => {
    await mail('primary', 'lease', 'Office lease renewal - Baner', 'Monthly rent: Rs. 1,85,000 from 1 January.');
    planWith({ queries: ['Baner office lease'], entityTerms: ['Baner'], topicTerms: ['Baner office lease'] });
    await ask('What is the monthly rent for our Baner office lease?');
    expect(subjectsSent()).toEqual(['Office lease renewal - Baner']);
  });

  // Breaks: a body that is hard-wrapped between the two words of a name loses
  // the email ("because Mahindra\nLogistics normally pays").
  it('is found across a line break in a plain-text body', async () => {
    const body = 'We agreed 30% advance because Mahindra\nLogistics normally pays within 45 days.';
    await harness.mail('primary', 't-mah', { id: 'mah', subject: 'Payment terms agreed', cleanBody: body, rawBody: body, contentType: 'text' });
    planWith({ queries: ['Mahindra Logistics payment terms'], entityTerms: ['Mahindra Logistics'], topicTerms: ['Mahindra Logistics'] });
    await ask('What payment terms did I agree with Mahindra Logistics?');
    expect(subjectsSent()).toEqual(['Payment terms agreed']);
  });

  // Breaks: matching by words lets newer mail that merely uses the same words
  // apart push the email that has the exact phrase out of the answer.
  it('ranks mail with the exact phrase above newer mail that has the words apart', async () => {
    await mail('primary', 'phrase', 'APSFL rate contract', 'The rate contract is Rs. 1,450 per ONT.', { date: 1_780_000_000 });
    for (let index = 0; index < 30; index++) {
      await mail('primary', `scattered-${index}`, `Contract amendment ${index}`, 'The exchange rate in this contract is revised.', { date: 1_790_000_000 + index });
    }
    planWith({ queries: ['rate contract'], entityTerms: [], topicTerms: ['rate contract'] });
    await ask('What is the rate contract?');
    expect(subjectsSent()[0]).toBe('APSFL rate contract');
  });
});

describe('a model topic that names more than the mail does', () => {
  // Breaks: the model's topic "Business WhatsApp postpaid plan" needs the word
  // "plan", which the invoice never uses, and the model's shorter searches
  // ("Business WhatsApp") are thrown away, so the invoice in the inbox is
  // reported as not found.
  it('runs the model\'s other searches and, when nothing matches the topic in full, lets its entity terms stand in', async () => {
    await mail('primary', 'wa-invoice', 'Business WhatsApp - POSTPAID_Invoice_SARV WHATSAPP OCT', 'Invoice amount: Rs. 4,720 including GST. Due by 25 Nov.');
    await mail('primary', 'gst-news', 'GST newsletter', 'New GST return formats explained.');
    planWith({ queries: ['Business WhatsApp', 'postpaid plan', 'invoice'], entityTerms: ['WhatsApp'], topicTerms: ['Business WhatsApp postpaid plan'] });
    const result = await ask('How much is the Business WhatsApp invoice for the postpaid plan?');
    expect(subjectsSent()).toEqual(['Business WhatsApp - POSTPAID_Invoice_SARV WHATSAPP OCT']);
    expect(result.broadened).toEqual(['model_topics']);
    expect(result.warnings).toContain('No email matched the search exactly, so emails that mention WhatsApp are shown; check that they are about the right thing.');
  });

  // Breaks: entity terms let every email that mentions a common name ("GST")
  // in beside the one that matches the topic, crowding it out of the answer.
  it('does not use entity terms when some email matches the topic', async () => {
    await mail('primary', 'gst-notice', 'GST notice for FY 2025-26', 'Reply to the GST notice by 20 November 2026.');
    for (let index = 0; index < 5; index++) await mail('primary', `irn-${index}`, `e-invoice IRN generated ${index}`, 'IRN generated under GST for your invoice.');
    planWith({ queries: ['GST notice', 'GST notice deadline'], entityTerms: ['GST'], topicTerms: ['GST notice'] });
    const result = await ask('What is the deadline to reply to the GST notice?');
    expect(subjectsSent()).toEqual(['GST notice for FY 2025-26']);
    expect(result.broadened).toBeUndefined();
  });
});

describe('a question that names only a person', () => {
  // Breaks: the model's whole queries ("Sharma payment pending") become words
  // every email must contain, so Sharma's own email, which says "3.2 lakh
  // pending", is thrown away.
  it('uses the person as the anchor instead of the wording of the queries', async () => {
    await mail('primary', 'sharma', 'Re: dues', 'Bhai, 3.2 lakh pending hai, please release this week.', { fromAddress: 'rajesh.sharma@trader.example', fromName: 'Rajesh Sharma' });
    await mail('primary', 'not-sharma', 'Payment pending reminder', 'Your payment is pending.', { fromAddress: 'billing@vendor.example' });
    planWith({ queries: ['Sharma payment pending', 'Sharma ji'], entityTerms: ['Sharma'], participantTerms: ['Sharma'] });
    await ask('Sharma ji ka kitna payment pending hai?');
    expect(subjectsSent()).toEqual(['Re: dues']);
  });
});
