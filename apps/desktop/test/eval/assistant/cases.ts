/**
 * The questions the Inbox Agent is scored on, and what must happen for each.
 *
 * A case states what a USER would expect, not what the code does today. Where
 * the two differ, the case is listed in known-gaps.ts with the reason, and the
 * evaluation fails when a listed case starts passing so that it gets promoted.
 * Never weaken a case here to make it pass: fix the agent, or list the gap.
 *
 * `route` says what kind of request it is, as the retired router named its
 * paths (kept so the cases read as before; the agent has no router):
 *   search        look in the mailbox and answer from it
 *   review        review unread mail and suggest what to mark as read
 *   mail_command  a scoped "mark X as read / unread"
 *   capability    answered in chat without searching (what the agent can do, a greeting, a thank-you)
 *   refused       nothing says which emails: change nothing, ask
 *   structured    answered from mailbox state, not keyword search (counts, unread, starred)
 *   draft         writes a reply
 * A case with `gold` is scored as a question; every other case is a task in
 * agent-tasks.ts.
 *
 * `gold` is the email that holds the answer and the exact words that must
 * reach the model. It is checked in what the tools showed the model, after
 * every host filter and excerpt limit, because mail that was found and then
 * dropped or trimmed is still a miss.
 *
 * `plan` is what a competent model returns for this question's planning
 * prompt, written by hand. With it a case is scored a second time ("ceiling"),
 * which separates a host problem from a planning problem: a case that fails
 * with a good plan cannot be fixed by a better model.
 */

export type EvalRoute = 'search' | 'review' | 'mail_command' | 'capability' | 'refused' | 'structured' | 'draft';

export interface EvalCase {
  id: string;
  ask: string;
  /**
   * Asked first, in the same chat, so that `ask` is a follow-up. The scripted
   * model answers it by quoting `cite`, so the first answer has a verified
   * source, as it would in real use.
   */
  after?: { ask: string; cite: string };
  route: EvalRoute;
  gold?: { emailId: string; needle: string };
  plan?: Record<string, unknown>;
}

/** Twenty-five questions whose answer is one known sentence in one known email. */
export const RETRIEVAL_CASES: EvalCase[] = [
  { id: 'infosys-revised-quote', ask: 'What is the final revised amount we quoted to Infosys for the Pune DC network refresh?', route: 'search', gold: { emailId: 'inf-q3', needle: 'Rs. 43.2 lakh' },
    plan: { queries: ['Infosys quotation', 'Infosys Pune DC network refresh', 'Infosys revised quote', 'Pune DC network refresh'], entityTerms: ['Infosys'], topicTerms: ['Infosys', 'Pune DC network refresh'], intent: 'all', quoteIntent: true, filters: {} } },
  { id: 'bhel-scada-quote', ask: 'How much did we quote BHEL for the SCADA upgrade?', route: 'search', gold: { emailId: 'bhel-prop', needle: 'Rs. 2.35 crore' },
    plan: { queries: ['BHEL SCADA', 'BHEL quotation', 'BHEL proposal', 'SCADA upgrade'], entityTerms: ['BHEL', 'Bharat Heavy Electricals'], topicTerms: ['BHEL', 'SCADA upgrade'], intent: 'all', quoteIntent: true, filters: {} } },
  { id: 'lnt-firewall-quote', ask: 'What did we quote L&T for the firewall supply?', route: 'search', gold: { emailId: 'lnt-quote', needle: 'Rs. 1,10,40,000' },
    plan: { queries: ['L&T firewall', 'L&T quotation', 'Larsen & Toubro firewall', 'firewall supply'], entityTerms: ['L&T', 'Larsen & Toubro'], topicTerms: ['L&T', 'firewall supply'], intent: 'all', quoteIntent: true, filters: {} } },
  { id: 'redington-switch-price', ask: 'What price did Redington quote for the Cisco switches?', route: 'search', gold: { emailId: 'red-quote', needle: 'Rs. 12,60,000' },
    plan: { queries: ['Redington Cisco switches', 'Redington quotation', 'Redington quote', 'Cisco switches price'], entityTerms: ['Redington', 'Cisco'], topicTerms: ['Redington', 'Cisco switches'], intent: 'all', quoteIntent: true, filters: {} } },
  { id: 'thermax-quotation-sent', ask: 'What quotation did we send to Thermax?', route: 'search', gold: { emailId: 'thermax-quote', needle: 'Rs. 9,85,000' },
    plan: { queries: ['Thermax quotation', 'Thermax quote', 'Thermax proposal', 'Thermax'], entityTerms: ['Thermax'], topicTerms: ['Thermax'], intent: 'all', quoteIntent: true, filters: {} } },
  { id: 'hdfc-amc-invoice-number', ask: 'What is the invoice number for the HDFC Bank AMC Q3 invoice?', route: 'search', gold: { emailId: 'inv-1057', needle: 'VIS/INV/1057' },
    plan: { queries: ['HDFC Bank AMC Q3 invoice', 'HDFC AMC invoice', 'HDFC Bank invoice Q3', 'AMC Q3'], entityTerms: ['HDFC Bank', 'HDFC'], topicTerms: ['HDFC Bank', 'AMC Q3'], intent: 'all', quoteIntent: false, filters: {} } },
  { id: 'wipro-outstanding', ask: 'Which invoice is Wipro yet to pay and how much is outstanding?', route: 'search', gold: { emailId: 'wipro-followup', needle: 'Rs. 11,32,800' },
    plan: { queries: ['Wipro invoice', 'Wipro payment pending', 'Wipro outstanding', 'Wipro overdue'], entityTerms: ['Wipro'], topicTerms: ['Wipro'], intent: 'all', quoteIntent: false, filters: {} } },
  { id: 'airtel-october-due', ask: 'When is the Airtel bill for October due?', route: 'search', gold: { emailId: 'airtel-oct', needle: 'Due date: 05 Nov 2026' },
    plan: { queries: ['Airtel bill October', 'Airtel bill due date', 'Airtel invoice'], entityTerms: ['Airtel'], topicTerms: ['Airtel'], intent: 'all', quoteIntent: false, filters: {} } },
  { id: 'gst-notice-deadline', ask: 'What is the deadline to reply to the GST notice?', route: 'search', gold: { emailId: 'gst-notice', needle: 'by 20 November 2026' },
    plan: { queries: ['GST notice', 'GST notice reply', 'GST notice deadline', 'GST show cause notice'], entityTerms: ['GST'], topicTerms: ['GST notice'], intent: 'all', quoteIntent: false, filters: {} } },
  { id: 'tcs-quarterly-review-when', ask: 'When is the TCS quarterly review meeting?', route: 'search', gold: { emailId: 'mtg-tcs', needle: 'Friday 13 November 2026' },
    plan: { queries: ['TCS quarterly review', 'TCS quarterly review meeting', 'TCS QBR', 'TCS meeting invite'], entityTerms: ['TCS', 'Tata Consultancy Services'], topicTerms: ['TCS quarterly review'], intent: 'all', quoteIntent: false, filters: {} } },
  { id: 'meetings-tomorrow', ask: 'What meetings do I have tomorrow?', route: 'search', gold: { emailId: 'mtg-tcs', needle: 'Friday 13 November 2026' },
    plan: { queries: ['meeting tomorrow', 'meeting invitation', 'calendar invite', 'meeting'], entityTerms: [], intent: 'all', quoteIntent: false, filters: {} } },
  { id: 'board-meeting-when', ask: 'When is the board meeting?', route: 'search', gold: { emailId: 'mtg-board', needle: 'Saturday, 21 November 2026' },
    plan: { queries: ['board meeting', 'board meeting notice', 'board meeting agenda'], entityTerms: [], topicTerms: ['board meeting'], intent: 'all', quoteIntent: false, filters: {} } },
  { id: 'nasscom-gcc-policy', ask: "What did the NASSCOM newsletter say about Karnataka's GCC policy?", route: 'search', gold: { emailId: 'nl-nasscom', needle: '50% rental reimbursement' },
    plan: { queries: ['NASSCOM newsletter', 'NASSCOM GCC policy', 'Karnataka GCC policy', 'NASSCOM Karnataka'], entityTerms: ['NASSCOM', 'Karnataka'], topicTerms: ['NASSCOM', 'Karnataka GCC policy'], intent: 'all', quoteIntent: false, filters: {} } },
  { id: 'dmrc-bid-deadline', ask: 'What is the bid submission deadline for the DMRC CCTV tender?', route: 'search', gold: { emailId: 'dmrc-09', needle: 'extended to 28 November 2026' },
    plan: { queries: ['DMRC CCTV tender', 'DMRC tender bid submission', 'DMRC bid deadline', 'Delhi Metro CCTV tender'], entityTerms: ['DMRC', 'Delhi Metro Rail Corporation'], topicTerms: ['DMRC', 'CCTV tender'], intent: 'all', quoteIntent: false, filters: {} } },
  { id: 'mahindra-payment-terms', ask: 'What payment terms did I agree with Mahindra Logistics?', route: 'search', gold: { emailId: 'mah-sent', needle: '30% advance' },
    plan: { queries: ['Mahindra Logistics payment terms', 'Mahindra Logistics', 'payment terms Mahindra'], entityTerms: ['Mahindra Logistics'], topicTerms: ['Mahindra Logistics'], intent: 'all', quoteIntent: false, filters: {} } },
  { id: 'po-4471-delivery', ask: 'What delivery date did I commit for PO 4471?', route: 'search', gold: { emailId: 'po4471-sent', needle: 'by 18 December 2026' },
    plan: { queries: ['PO 4471', 'PO 4471 delivery', '4471 delivery date', 'purchase order 4471'], entityTerms: ['PO 4471'], topicTerms: ['PO 4471'], intent: 'all', quoteIntent: false, filters: {} } },
  { id: 'kavita-rate-contract', ask: 'What did I send to Kavita Reddy about the rate contract?', route: 'search', gold: { emailId: 'apsfl-sent', needle: 'Rs. 1,450 per ONT' },
    plan: { queries: ['Kavita Reddy rate contract', 'rate contract', 'Kavita Reddy'], entityTerms: ['Kavita Reddy'], topicTerms: ['rate contract'], participantTerms: ['Kavita Reddy'], intent: 'sent', quoteIntent: false, filters: {} } },
  { id: 'hdfc-msa-penalty-cap', ask: 'What is the penalty cap in the HDFC Bank MSA draft?', route: 'search', gold: { emailId: 'msa-long', needle: 'penalty cap shall be 7.5%' },
    plan: { queries: ['HDFC Bank MSA', 'MSA draft penalty cap', 'Master Services Agreement HDFC', 'penalty cap'], entityTerms: ['HDFC Bank', 'HDFC'], topicTerms: ['HDFC Bank', 'MSA'], intent: 'all', quoteIntent: false, filters: {} } },
  { id: 'ongc-bank-guarantee', ask: 'How much bank guarantee do we have to submit for the ONGC project?', route: 'search', gold: { emailId: 'ongc-mom', needle: 'bank guarantee of Rs. 25 lakh' },
    plan: { queries: ['ONGC bank guarantee', 'ONGC performance bank guarantee', 'ONGC project BG', 'ONGC'], entityTerms: ['ONGC'], topicTerms: ['ONGC'], intent: 'all', quoteIntent: false, filters: {} } },
  { id: 'sbi-turnover-criterion', ask: 'What turnover is required as per the SBI tender corrigendum?', route: 'search', gold: { emailId: 'sbi-fwd', needle: 'criterion to Rs. 50 crore' },
    plan: { queries: ['SBI tender corrigendum', 'SBI tender turnover', 'SBI corrigendum turnover criteria', 'State Bank of India tender'], entityTerms: ['SBI', 'State Bank of India'], topicTerms: ['SBI tender'], intent: 'all', quoteIntent: false, filters: {} } },
  { id: 'hinglish-sharma-payment', ask: 'Sharma ji ka kitna payment pending hai?', route: 'search', gold: { emailId: 'hing-pay', needle: '3.2 lakh pending' },
    plan: { queries: ['Sharma payment pending', 'Sharma payment', 'Sharma pending', 'Sharma ji'], entityTerms: ['Sharma'], participantTerms: ['Sharma'], intent: 'all', quoteIntent: false, filters: {} } },
  { id: 'hinglish-gurpreet-meeting', ask: 'Gurpreet ne meeting kab rakhi hai?', route: 'search', gold: { emailId: 'hing-mtg', needle: 'Monday 16 tarikh' },
    plan: { queries: ['Gurpreet meeting', 'Gurpreet meeting reschedule', 'Gurpreet'], entityTerms: ['Gurpreet'], participantTerms: ['Gurpreet'], intent: 'all', quoteIntent: false, filters: {} } },
  { id: 'hinglish-jaipur-dispatch', ask: 'Jaipur wala maal kab pahunchega?', route: 'search', gold: { emailId: 'hing-dispatch', needle: 'parso subah tak Jaipur' },
    plan: { queries: ['Jaipur dispatch', 'Jaipur maal', 'Jaipur delivery', 'Jaipur consignment'], entityTerms: ['Jaipur'], topicTerms: ['Jaipur'], intent: 'all', quoteIntent: false, filters: {} } },
  { id: 'ntpc-po-value-2024', ask: 'What was the PO value for the NTPC Dadri LAN upgrade in 2024?', route: 'search', gold: { emailId: 'ntpc-2024', needle: 'Rs. 1.12 crore' },
    plan: { queries: ['NTPC Dadri LAN upgrade', 'NTPC Dadri PO', 'NTPC purchase order', 'Dadri LAN upgrade'], entityTerms: ['NTPC', 'Dadri'], topicTerms: ['NTPC Dadri', 'LAN upgrade'], intent: 'all', quoteIntent: false, filters: { after: '2024-01-01', before: '2025-01-01' } } },
  { id: 'baner-office-rent', ask: 'What is the monthly rent for our Baner office lease?', route: 'search', gold: { emailId: 'lease-2025', needle: 'Rs. 1,85,000' },
    plan: { queries: ['Baner office lease', 'Baner office rent', 'office lease renewal', 'leave and license Baner'], entityTerms: ['Baner'], topicTerms: ['Baner office lease'], intent: 'all', quoteIntent: false, filters: {} } },
];

/** Requests that are not a mailbox question, or that must be routed before any search. */
export const ROUTING_CASES: EvalCase[] = [
  { id: 'review-unread', ask: 'Review my unread emails', route: 'review' },
  { id: 'review-unread-polite', ask: 'Can you review my unread emails?', route: 'review' },
  { id: 'review-unread-hinglish', ask: 'meri unread emails review karo', route: 'review' },
  { id: 'review-uncategorized', ask: 'Review my uncategorized unread emails', route: 'review' },
  { id: 'mark-sender-read', ask: 'Mark all emails from LinkedIn as read', route: 'mail_command' },
  { id: 'mark-phrase-read', ask: 'Mark all SaaS Weekly emails as read', route: 'mail_command' },
  { id: 'mark-sender-read-hinglish', ask: 'LinkedIn ke saare emails read mark kar do', route: 'mail_command' },
  { id: 'mark-pronoun', ask: 'Mark them as read', route: 'refused' },
  { id: 'mark-all', ask: 'Mark all as read', route: 'refused' },
  { id: 'mark-the-rest', ask: 'Mark the rest as read', route: 'refused' },
  { id: 'what-can-you-do', ask: 'What can you do?', route: 'capability' },
  { id: 'categorize', ask: 'Categorize my uncategorized emails', route: 'capability' },
  { id: 'thanks', ask: 'thanks', route: 'capability' },
  { id: 'namaste', ask: 'namaste', route: 'capability' },
  { id: 'who-are-you', ask: 'who are you?', route: 'capability' },
  { id: 'archive-newsletters', ask: 'Archive all the newsletters', route: 'capability' },
  { id: 'star-this', ask: 'Star the email from Anita', route: 'capability' },
  { id: 'count-unread', ask: 'How many unread emails do I have?', route: 'structured' },
  { id: 'starred-list', ask: 'Show my starred emails', route: 'structured' },
  { id: 'draft-reply', ask: 'Draft a reply to Anita saying we will share the proforma by Friday', route: 'draft' },
];

const THERMAX = { ask: 'What quotation did we send to Thermax?', cite: 'Rs. 9,85,000' };

/** A second question that only makes sense with the first. */
export const FOLLOW_UP_CASES: EvalCase[] = [
  { id: 'followup-validity', after: THERMAX, ask: 'What is its validity?', route: 'search',
    gold: { emailId: 'thermax-quote', needle: 'Rs. 9,85,000' } },
  { id: 'followup-when', after: THERMAX, ask: 'When did we send it?', route: 'search',
    gold: { emailId: 'thermax-quote', needle: 'Rs. 9,85,000' } },
  { id: 'followup-hinglish', after: THERMAX, ask: 'aur validity kitni hai?', route: 'search',
    gold: { emailId: 'thermax-quote', needle: 'Rs. 9,85,000' } },
  // A new topic after an answer must not inherit the previous one. It uses a
  // question that works alone, so a failure here is the context, not the search.
  { id: 'new-topic-after-answer', after: THERMAX, ask: 'What is the deadline to reply to the GST notice?', route: 'search',
    gold: { emailId: 'gst-notice', needle: 'by 20 November 2026' } },
];

/** The same retrieval questions as people type them: lower case, no punctuation. */
export const LOWERCASE_CASES: EvalCase[] = RETRIEVAL_CASES.filter(item => !item.id.startsWith('hinglish-')).map(item => ({
  id: `lowercase-${item.id}`, ask: item.ask.toLowerCase().replace(/[?.]+$/, ''), route: item.route, ...(item.gold ? { gold: item.gold } : {}),
}));

export const EVAL_CASES: EvalCase[] = [...RETRIEVAL_CASES, ...ROUTING_CASES, ...FOLLOW_UP_CASES, ...LOWERCASE_CASES];
