/**
 * The seeded mailbox the Inbox Agent evaluation runs against.
 *
 * Two accounts of a small IT-infrastructure company in Pune: a director's
 * mailbox and an accounts mailbox. The mail is written to look like real mail,
 * not like test data: signatures, disclaimers, quoted reply chains, forwarded
 * tender notices, long contract drafts with the fact buried mid-document,
 * newsletters that mention the same customers, calendar invitations, Hinglish
 * threads, and amounts in lakh and crore. Retrieval measured on tidy mail
 * overstates how well it works.
 *
 * Every person, company, address and amount is invented, and every domain is
 * reserved (.example). Never add real mail here: recordings made from this
 * mailbox are committed to the repository.
 */

export const NOW_MS = Date.parse('2026-11-12T04:30:00Z'); // 10:00 IST, Thursday 12 Nov 2026
export const TIME_ZONE = 'Asia/Kolkata';
export const A1 = { id: 'acct-rohit', email: 'rohit@vertexinfra.example' };
export const A2 = { id: 'acct-accounts', email: 'accounts@vertexinfra.example' };

export interface Mail {
  id: string;
  acct: 'A1' | 'A2';
  thread?: string;
  folder: 'inbox' | 'sent';
  from: [string, string];
  to: string;
  cc?: string;
  subject: string;
  /** IST wall clock, 'YYYY-MM-DD HH:mm'. */
  at: string;
  body: string;
  /** html = Gmail-style multipart/alternative (HTML raw body + 76-col hard-wrapped text part). */
  format?: 'html' | 'text';
  attachments?: string[];
  ics?: string;
  /** Unread mail, for the review and mark-as-read cases. Everything else is read. */
  unread?: boolean;
  /** Its body was never downloaded (IDLE added it with headers only): `body` is ignored. */
  bodyMissing?: boolean;
}

/** IST wall clock to Unix seconds. */
export function ist(at: string): number {
  return Math.floor(Date.parse(`${at.replace(' ', 'T')}:00+05:30`) / 1000);
}

const SIG_ROHIT = '\n\nRegards,\nRohit Agarwal\nDirector, Vertex Infra Solutions Pvt Ltd\nBaner, Pune 411045 | +91 98220 00000';
const SIG_PRIYA = '\n\nThanks,\nPriya Nair\nPre-sales, Vertex Infra Solutions Pvt Ltd, Pune';
const SIG_ACCOUNTS = '\n\nRegards,\nAccounts Team\nVertex Infra Solutions Pvt Ltd\nBaner, Pune 411045';
const ROHIT: [string, string] = [A1.email, 'Rohit Agarwal'];
const PRIYA: [string, string] = ['priya@vertexinfra.example', 'Priya Nair'];
const ACCOUNTS: [string, string] = [A2.email, 'Vertex Accounts'];

// ---------- long bodies: the key fact sits beyond 12,000 characters ----------
const CLAUSE_SENTENCES = [
  'The Service Provider shall perform the Services with reasonable skill and care and in accordance with good industry practice.',
  'The Bank may, on thirty days written notice, request changes to the scope through the change control procedure set out in Schedule 4.',
  'All deliverables shall be subject to acceptance testing by the Bank within fifteen business days of delivery.',
  'Each party shall keep confidential all information disclosed by the other party in connection with this Agreement.',
  'The Service Provider shall maintain adequate insurance cover throughout the term and for two years thereafter.',
  'Invoices shall be raised quarterly in advance and are payable within forty-five days of receipt of a valid tax invoice.',
  'The Service Provider shall comply with the information security policy of the Bank as amended from time to time.',
  'Neither party shall be liable for any delay caused by a force majeure event notified in writing within seven days.',
  'The Bank shall have the right to audit the records of the Service Provider relating to the Services once in every contract year.',
  'Any dispute shall first be referred to the senior management of both parties for amicable resolution.',
  'The Service Provider shall not subcontract any part of the Services without the prior written consent of the Bank.',
  'All intellectual property created specifically for the Bank under a statement of work shall vest in the Bank on payment.',
];
function clause(n: number): string {
  const pick = (k: number) => CLAUSE_SENTENCES[(n * 5 + k * 3) % CLAUSE_SENTENCES.length]!;
  return `Clause ${n}.1: ${pick(0)} ${pick(1)}\nClause ${n}.2: ${pick(2)} ${pick(3)}`;
}
export const MSA_FACT = 'Clause 31.3: Notwithstanding anything contained in Schedule 2, the aggregate penalty cap shall be 7.5% of the annual contract value, computed for each contract year separately.';
const MSA_BODY = [
  'Dear Rohit,\n\nPlease find below draft v3 of the Master Services Agreement (MSA) between HDFC Bank Limited and Vertex Infra Solutions Pvt Ltd with our comments incorporated. Kindly review and revert with your acceptance or remaining points by Friday.',
  ...Array.from({ length: 30 }, (_, i) => clause(i + 1)),
  `${clause(31)}\n${MSA_FACT}`,
  ...Array.from({ length: 9 }, (_, i) => clause(i + 32)),
  'Regards,\nRitu Malhotra\nLegal Department, HDFC Bank Limited, Mumbai',
].join('\n\n');

const MOM_SENTENCES = [
  'Site access passes for the installation team will be arranged by the plant security office after police verification.',
  'The existing fibre backbone between the control room and the tank farm will be reused wherever OTDR results are within limits.',
  'All active equipment will be staged and burnt-in at the vendor warehouse before dispatch to site.',
  'Work permits are to be obtained daily and hot work is not allowed in the classified zones.',
  'The plant IT team will share the IP addressing plan and VLAN list within one week.',
  'Weekly progress review will be held every Tuesday at 11 AM over video call.',
  'Material inspection will be carried out by the third party inspection agency at the OEM premises.',
  'Shutdown windows for cut-over will be communicated at least ten days in advance.',
];
export const MOM_FACT = 'Point 46: Vertex to submit the performance bank guarantee of Rs. 25 lakh by 30 November 2026 (owner: Rohit Agarwal).';
const MOM_BODY = [
  'Dear All,\n\nPlease find below the minutes of the kickoff meeting held on 10 September 2026 at the ONGC Uran plant for the plant network project. Attendees: Venkatesh Iyer, S. Ramanathan (ONGC); Rohit Agarwal, Priya Nair (Vertex).',
  ...Array.from({ length: 60 }, (_, i) => i + 1 === 46 ? MOM_FACT
    : `Point ${i + 1}: ${MOM_SENTENCES[(i * 3) % MOM_SENTENCES.length]} ${MOM_SENTENCES[(i * 5 + 1) % MOM_SENTENCES.length]}`),
  'Regards,\nVenkatesh Iyer\nDGM (Infocom), ONGC Uran Plant',
].join('\n\n');

const TENDER_SENTENCES = [
  'The bidder should have executed similar works for scheduled commercial banks during the last five years.',
  'Bids are to be submitted online only; physical submission of the technical bid will not be entertained.',
  'The successful bidder shall deploy resident engineers at the four zonal offices for the contract period.',
  'Queries will be accepted only through the designated email id up to the date mentioned in the schedule of events.',
  'The bank reserves the right to cancel the tender at any stage without assigning any reason whatsoever.',
  'Price bid shall be opened only for bidders who qualify in the technical evaluation with a minimum of seventy marks.',
];
function forwarded(from: string, date: string, subject: string, lines: number, seed: number, extra = ''): string {
  return `---------- Forwarded message ---------\nFrom: ${from}\nDate: ${date}\nSubject: ${subject}\n\n`
    + Array.from({ length: lines }, (_, i) => `${TENDER_SENTENCES[(i * 5 + seed) % TENDER_SENTENCES.length]} ${TENDER_SENTENCES[(i + seed * 2 + 1) % TENDER_SENTENCES.length]}`).join('\n\n')
    + (extra ? `\n\n${extra}` : '');
}
export const SBI_FACT = 'Corrigendum 3 changes the minimum average annual turnover criterion to Rs. 50 crore (from Rs. 30 crore) for the last three financial years.';
const SBI_BODY = [
  `Rohit, forwarding the full trail from our Mumbai partner for the SBI tender. Please go through it before the Thursday call.${SIG_PRIYA}`,
  forwarded('Nilesh Desai <nilesh@desaisystems.example>', 'Thu, 29 Oct 2026', 'Fwd: Re: SBI tender corrigendum 3', 14, 1),
  forwarded('SBI IT Procurement <itprocurement@sbi.example>', 'Wed, 28 Oct 2026', 'Re: SBI tender corrigendum 3', 22, 2),
  forwarded('Nilesh Desai <nilesh@desaisystems.example>', 'Tue, 27 Oct 2026', 'SBI tender corrigendum 3', 18, 3, SBI_FACT),
  forwarded('SBI IT Procurement <itprocurement@sbi.example>', 'Mon, 26 Oct 2026', 'SBI tender - schedule of events', 12, 4),
].join('\n\n');

// ---------- 15-message thread: the answer is only in message 9 ----------
export const DMRC_FACT = 'The bid submission deadline has been extended to 28 November 2026, 3:00 PM.';
const ARVIND: [string, string] = ['arvind.saxena@dmrc.example', 'Arvind Saxena'];
const DMRC_SUBJECT = 'DMRC CCTV tender - pre-bid queries';
const dmrc = (n: number, at: string, from: [string, string], to: string, body: string, cc?: string): Mail => ({
  id: `dmrc-${String(n).padStart(2, '0')}`, acct: 'A1', thread: 't-dmrc', folder: from[0] === A1.email ? 'sent' : 'inbox', from, to,
  ...(cc ? { cc } : {}), subject: n === 1 ? DMRC_SUBJECT : `Re: ${DMRC_SUBJECT}`, at, body, format: 'text',
});
const DMRC_THREAD: Mail[] = [
  dmrc(1, '2026-10-01 10:05', PRIYA, A1.email, `Rohit, DMRC has floated the CCTV tender for 14 stations on Line 7. The pre-bid meeting is on 8 October. I am compiling our queries; please add yours by Monday.${SIG_PRIYA}`),
  dmrc(2, '2026-10-02 18:20', ROHIT, PRIYA[0], `Priya, add a query on whether Make in India preference applies and whether a consortium is allowed. Also ask about the camera count per station.${SIG_ROHIT}`),
  dmrc(3, '2026-10-05 11:00', PRIYA, ARVIND[0], `Dear Mr. Saxena,\n\nPlease find our pre-bid queries: 1) Is a consortium permitted? 2) Does Make in India purchase preference apply? 3) Camera count per station. 4) Storage retention days.${SIG_PRIYA}`, A1.email),
  dmrc(4, '2026-10-07 16:45', ARVIND, PRIYA[0], 'Queries received. Replies will be issued to all bidders after the pre-bid meeting on 8 October at Metro Bhawan.\n\nArvind Saxena\nDy. General Manager (S&T), DMRC', A1.email),
  dmrc(5, '2026-10-08 19:10', PRIYA, A1.email, `Attended the pre-bid meeting. 11 bidders were present, including Honeywell and Bosch partners. DMRC will issue a corrigendum next week.${SIG_PRIYA}`),
  dmrc(6, '2026-10-09 09:30', ROHIT, PRIYA[0], `Thanks. Please start the costing sheet. Assume 1,120 cameras and 90 days retention until it is clarified.${SIG_ROHIT}`),
  dmrc(7, '2026-10-12 15:00', ARVIND, PRIYA[0], 'Corrigendum 1 has been uploaded on the e-tender portal: a consortium of maximum two members is permitted; video retention is 30 days.\n\nArvind Saxena\nDy. General Manager (S&T), DMRC', A1.email),
  dmrc(8, '2026-10-14 12:15', PRIYA, ARVIND[0], `Thank you. Could you also confirm the EMD amount and whether the due date will be extended in view of the Diwali holidays?${SIG_PRIYA}`, A1.email),
  dmrc(9, '2026-10-16 17:40', ARVIND, PRIYA[0], `In response to your query: EMD remains Rs. 12.5 lakh. ${DMRC_FACT} No further extension will be given.\n\nArvind Saxena\nDy. General Manager (S&T), DMRC`, A1.email),
  dmrc(10, '2026-10-17 10:00', ROHIT, PRIYA[0], `Good. Let us finalise the OEM by 25 October. Get the MAF from Hikvision or CP Plus.${SIG_ROHIT}`),
  dmrc(11, '2026-10-20 13:30', PRIYA, A1.email, `CP Plus has agreed to give the MAF. Their pricing is 9% lower than Hikvision for the 4 MP dome camera.${SIG_PRIYA}`),
  dmrc(12, '2026-10-22 11:20', ROHIT, ARVIND[0], `Dear Mr. Saxena,\n\nKindly confirm whether experience of metro rail projects outside India is acceptable for eligibility.${SIG_ROHIT}`, PRIYA[0]),
  dmrc(13, '2026-10-23 14:05', ARVIND, A1.email, 'Experience outside India is acceptable if supported by client completion certificates.\n\nArvind Saxena\nDy. General Manager (S&T), DMRC', PRIYA[0]),
  dmrc(14, '2026-10-26 18:00', PRIYA, A1.email, `Costing sheet v2 is ready. Our landed cost comes to Rs. 6.8 crore; with 12% margin the bid value would be about Rs. 7.6 crore.${SIG_PRIYA}`),
  dmrc(15, '2026-10-27 09:15', ROHIT, PRIYA[0], `Looks fine. Let us review on Thursday and freeze the price before the deadline.${SIG_ROHIT}`),
];

const TCS_ICS = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'METHOD:REQUEST', 'BEGIN:VEVENT', 'UID:tcs-qr-20261113@tcs.example',
  'DTSTART;TZID=Asia/Kolkata:20261113T150000', 'DTEND;TZID=Asia/Kolkata:20261113T160000', 'SUMMARY:TCS quarterly review',
  'LOCATION:Microsoft Teams', 'ORGANIZER;CN=Sunita Rao:mailto:sunita.rao@tcs.example', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');

export const BASE_MAILS: Mail[] = [
  // ----- quotations and revisions (INR, lakh/crore) -----
  { id: 'inf-q1', acct: 'A1', thread: 't-inf-quote', folder: 'sent', from: ROHIT, to: 'anand.kulkarni@infosys.example', at: '2026-08-10 12:10',
    subject: 'Quotation for Infosys Pune DC network refresh - VIS/Q/2026/041', format: 'html', attachments: ['VIS-Q-2026-041.pdf'],
    body: `Dear Anand,\n\nPlease find attached our quotation VIS/Q/2026/041 for the Pune DC network refresh (core and access switching with 3 years support).\n\nTotal: Rs. 48,50,000 (Rupees Forty-Eight Lakh Fifty Thousand only) plus 18% GST. Validity: 30 days. Delivery: 6-8 weeks from PO.${SIG_ROHIT}` },
  { id: 'inf-q2', acct: 'A1', thread: 't-inf-quote', folder: 'sent', from: ROHIT, to: 'anand.kulkarni@infosys.example', at: '2026-08-24 16:30',
    subject: 'Revised quotation - Infosys Pune DC network refresh (Rev 1)', format: 'html', attachments: ['VIS-Q-2026-041-R1.pdf'],
    body: `Dear Anand,\n\nAs discussed, we have offered an 8% discount on the switching line items. The revised total is Rs. 44,75,000 plus GST. All other terms remain the same as the original quotation.${SIG_ROHIT}` },
  { id: 'inf-q3', acct: 'A1', thread: 't-inf-quote', folder: 'sent', from: ROHIT, to: 'anand.kulkarni@infosys.example', at: '2026-09-05 11:45',
    subject: 'Re: Revised quotation - Infosys Pune DC network refresh (Rev 2 - final)', format: 'html', attachments: ['VIS-Q-2026-041-R2.pdf'],
    body: `Dear Anand,\n\nFurther to our call today, our final and best price is Rs. 43.2 lakh plus GST. This Rev 2 supersedes Rev 1. Validity is 15 days from today.${SIG_ROHIT}` },
  { id: 'inf-q-ack', acct: 'A1', thread: 't-inf-quote', folder: 'inbox', from: ['anand.kulkarni@infosys.example', 'Anand Kulkarni'], to: A1.email, at: '2026-09-08 10:20',
    subject: 'Re: Revised quotation - Infosys Pune DC network refresh (Rev 2 - final)', format: 'html',
    body: 'Thanks Rohit. We will take Rev 2 to our procurement committee on 15 September and revert.\n\nAnand Kulkarni\nInfrastructure Sourcing, Infosys Limited' },
  { id: 'bhel-prop', acct: 'A1', folder: 'sent', from: ROHIT, to: 'sk.verma@bhel.example', at: '2026-07-02 15:00',
    subject: 'Commercial proposal - BHEL Haridwar SCADA upgrade', format: 'html', attachments: ['BHEL-Haridwar-commercial.pdf'],
    body: `Dear Mr. Verma,\n\nWith reference to the technical discussions at Haridwar, please find our commercial proposal for the upgrade of the SCADA network. The total project value is Rs. 2.35 crore inclusive of three years comprehensive AMC. Taxes extra as applicable. Payment: 70% on delivery, 30% on commissioning.${SIG_ROHIT}` },
  { id: 'lnt-rfq', acct: 'A1', thread: 't-lnt', folder: 'inbox', from: ['deepak.joshi@lnthydrocarbon.example', 'Deepak Joshi'], to: A1.email, at: '2026-09-20 09:50',
    subject: 'RFQ: L&T Hydrocarbon - firewall supply for Hazira', format: 'html',
    body: 'Dear Sir,\n\nPlease submit your best offer for supply of 6 nos. Palo Alto PA-3410 firewalls with 3 year subscription for our Hazira facility. Offer to reach us by 24 September.\n\nDeepak Joshi\nL&T Hydrocarbon Engineering, Procurement' },
  { id: 'lnt-quote', acct: 'A1', thread: 't-lnt', folder: 'sent', from: ROHIT, to: 'deepak.joshi@lnthydrocarbon.example', at: '2026-09-23 17:25',
    subject: 'Re: RFQ: L&T Hydrocarbon - firewall supply for Hazira', format: 'html', attachments: ['Vertex-offer-PA3410.pdf'],
    body: `Dear Deepak,\n\nThank you for the enquiry. Our offer for 6 nos. PA-3410 firewalls with 3 year subscription is Rs. 18,40,000 per unit, i.e. a total of Rs. 1,10,40,000 plus GST. Delivery 4 weeks.${SIG_ROHIT}` },
  { id: 'red-quote', acct: 'A1', folder: 'inbox', from: ['sales.west@redington.example', 'Redington Sales West'], to: A1.email, at: '2026-10-03 13:00',
    subject: 'Quotation', format: 'html',
    body: 'Dear Sir,\n\nPlease find our best quote for 24 nos. Cisco Catalyst 9300 switches (C9300-48P-A): Rs. 12,60,000 for the lot, ex-Bhiwandi, GST extra. Stock is available; price valid for 7 days.\n\nRedington Limited, West Region Sales' },
  { id: 'thermax-quote', acct: 'A1', folder: 'sent', from: ROHIT, to: 'purchase@thermax.example', at: '2026-10-06 12:40',
    subject: 'Quotation', format: 'html', attachments: ['Quotation-WiFi-Chakan.pdf'],
    body: `Dear Mr. Kulkarni,\n\nAs per your enquiry for Wi-Fi coverage at the Chakan plant, our quotation is Rs. 9,85,000 plus GST for 38 access points including installation and heat-map survey.${SIG_ROHIT}` },
  { id: 'kirloskar-quote', acct: 'A1', folder: 'sent', from: ROHIT, to: 'stores@kirloskar.example', at: '2026-10-09 10:10',
    subject: 'Quotation', format: 'html',
    body: `Dear Sir,\n\nOur quotation for structured cabling of the new admin block (420 nodes, Cat 6A) is Rs. 6,20,000 plus GST.${SIG_ROHIT}` },
  { id: 'godrej-quote', acct: 'A1', folder: 'sent', from: ROHIT, to: 'it.purchase@godrej.example', at: '2026-10-12 14:30',
    subject: 'Re: Quotation', format: 'html',
    body: `Dear Madam,\n\nOur quotation for the CCTV AMC at the Vikhroli campus is Rs. 3,75,000 per annum plus GST, covering 310 cameras.${SIG_ROHIT}` },

  // ----- meeting invitations -----
  { id: 'mtg-tcs', acct: 'A1', folder: 'inbox', from: ['sunita.rao@tcs.example', 'Sunita Rao'], to: A1.email, at: '2026-11-06 11:30',
    subject: 'Invitation: TCS quarterly review @ Fri 13 Nov 2026 3:00pm - 4:00pm (IST)', format: 'html', ics: TCS_ICS,
    body: 'You are invited to the TCS quarterly review meeting.\n\nWhen: Friday 13 November 2026, 3:00pm - 4:00pm IST\nWhere: Microsoft Teams\nOrganizer: Sunita Rao\n\nAgenda: SLA performance for Q2, open incidents, renewal plan.' },
  { id: 'mtg-tcs-old', acct: 'A1', folder: 'inbox', from: ['sunita.rao@tcs.example', 'Sunita Rao'], to: A1.email, at: '2026-08-07 11:30',
    subject: 'Invitation: TCS quarterly review @ Fri 14 Aug 2026 3:00pm - 4:00pm (IST)', format: 'html',
    body: 'You are invited to the TCS quarterly review meeting.\n\nWhen: Friday 14 August 2026, 3:00pm - 4:00pm IST\nWhere: Microsoft Teams\nOrganizer: Sunita Rao' },
  { id: 'mtg-zoho', acct: 'A1', folder: 'inbox', from: ['partners@zoho.example', 'Zoho Partner Desk'], to: A1.email, at: '2026-11-05 15:10',
    subject: 'Meeting Confirmation | Vertex Infra <> Zoho partner onboarding', format: 'html',
    body: 'Hello Rohit,\n\nYour meeting is confirmed for Monday, 16 November 2026 at 11:30 AM IST. Please join the call using the link in your partner portal.\n\nZoho Partner Desk' },
  { id: 'mtg-board', acct: 'A1', folder: 'inbox', from: ['cs@vertexinfra.example', 'Neha Kulkarni'], to: A1.email, at: '2026-11-09 17:00',
    subject: 'Board meeting on 21 November - agenda and notice', format: 'html', attachments: ['Board-notice-Nov-2026.pdf'],
    body: 'Dear Directors,\n\nNotice is hereby given that the board meeting of Vertex Infra Solutions Pvt Ltd will be held on Saturday, 21 November 2026 at 10:30 AM at the registered office, Baner, Pune. Agenda: approval of Q2 accounts, bank limit renewal, new hires.\n\nNeha Kulkarni\nCompany Secretary' },

  // ----- newsletters -----
  { id: 'nl-et', acct: 'A1', folder: 'inbox', from: ['newsletters@ettech.example', 'ET Tech'], to: A1.email, at: '2026-11-10 07:05',
    subject: 'ET Tech Morning Dispatch: Infosys, TCS announce GCC deals', format: 'html',
    body: 'Good morning. Infosys and TCS both announced large GCC build-out deals on Monday. HDFC Bank is reported to be evaluating a Rs. 1,200 crore core modernisation programme. Markets added Rs. 2.1 lakh crore in investor wealth. DMRC has invited bids for station surveillance. Unsubscribe | Manage preferences' },
  { id: 'nl-nasscom', acct: 'A1', folder: 'inbox', from: ['digest@nasscom.example', 'NASSCOM'], to: A1.email, at: '2026-11-03 08:00',
    subject: "NASSCOM Weekly Digest: Karnataka's new GCC policy", format: 'html',
    body: "This week: Karnataka's new GCC policy offers a 50% rental reimbursement for centres set up beyond Bengaluru, capped at Rs. 2 crore per centre. Also inside: deep-tech fund update, events calendar. You are receiving this email because you are a NASSCOM member. Unsubscribe" },
  { id: 'nl-zoho', acct: 'A1', folder: 'inbox', from: ['partner-news@zoho.example', 'Zoho Partner News'], to: A1.email, at: '2026-10-28 09:00',
    subject: 'Zoho Partner Newsletter - October', format: 'html',
    body: 'New this month: revised partner margins for Zoho One, a certification drive in Pune and Chennai, and the partner awards shortlist. Unsubscribe' },
  { id: 'nl-crn', acct: 'A1', folder: 'inbox', from: ['news@crnindia.example', 'CRN India'], to: A1.email, at: '2026-10-20 08:30',
    subject: 'CRN India: Cisco, Palo Alto price revisions from January', format: 'html',
    body: 'Cisco will increase list prices by 6% from 1 January 2027. Palo Alto Networks has announced a new subscription bundle for PA-3400 series firewalls. Redington and Ingram have issued advisories to partners. Unsubscribe' },
  { id: 'nl-gem', acct: 'A1', folder: 'inbox', from: ['seller-updates@gem.example', 'GeM Seller Updates'], to: A1.email, at: '2026-10-15 10:00',
    subject: 'GeM seller update: new bid security rules', format: 'html',
    body: 'Dear Seller, bid security (EMD) exemption for MSEs continues. New rule: bids above Rs. 5 crore will require a pre-bid meeting. Read the full circular on the portal. Unsubscribe' },

  ...DMRC_THREAD,

  // ----- sent-folder replies -----
  { id: 'mah-in', acct: 'A1', thread: 't-mah', folder: 'inbox', from: ['vikram.patil@mahindralogistics.example', 'Vikram Patil'], to: A1.email, at: '2026-10-18 12:00',
    subject: 'Payment terms for Chakan warehouse Wi-Fi project', format: 'html',
    body: 'Hi Rohit,\n\nBefore we release the PO, can you confirm the payment terms? Mahindra Logistics normally pays 100% after installation with 45 days credit.\n\nVikram Patil\nIT Infrastructure, Mahindra Logistics' },
  { id: 'mah-sent', acct: 'A1', thread: 't-mah', folder: 'sent', from: ROHIT, to: 'vikram.patil@mahindralogistics.example', at: '2026-10-19 10:35',
    subject: 'Re: Payment terms for Chakan warehouse Wi-Fi project', format: 'html',
    body: `Dear Vikram,\n\nGiven the material value, we can agree to 30% advance with the PO, 60% on delivery of material and 10% after installation and sign-off. Credit period 15 days on each milestone.${SIG_ROHIT}` },
  { id: 'po4471-in', acct: 'A1', thread: 't-po4471', folder: 'inbox', from: ['purchase@kpitsystems.example', 'Sneha Deshpande'], to: A1.email, at: '2026-10-25 16:15',
    subject: 'PO 4471 - delivery schedule?', format: 'html',
    body: 'Dear Rohit,\n\nWe have not received the delivery schedule against our PO 4471 for the server racks. Please confirm the dates today.\n\nSneha Deshpande\nPurchase' },
  { id: 'po4471-sent', acct: 'A1', thread: 't-po4471', folder: 'sent', from: ROHIT, to: 'purchase@kpitsystems.example', at: '2026-10-26 09:40',
    subject: 'Re: PO 4471 - delivery schedule?', format: 'html',
    body: `Dear Sneha,\n\nApologies for the delay. We will deliver the complete material against PO 4471 by 18 December 2026. Installation will start within three working days of delivery.${SIG_ROHIT}` },
  { id: 'apsfl-sent', acct: 'A1', folder: 'sent', from: ROHIT, to: 'kavita.reddy@apsfl.example', at: '2026-09-30 15:50',
    subject: 'Rate contract renewal - APSFL ONT supply', format: 'html',
    body: `Dear Kavita ma'am,\n\nWith reference to the rate contract expiring on 31 October, we propose to renew it at the existing rate of Rs. 1,450 per ONT for FY 2026-27, for a minimum quantity of 40,000 units.${SIG_ROHIT}` },

  // ----- key fact deep in a long body -----
  { id: 'msa-long', acct: 'A1', folder: 'inbox', from: ['ritu.malhotra@hdfcbank.example', 'Ritu Malhotra'], to: A1.email, at: '2026-10-08 18:30',
    subject: 'Master Services Agreement - draft v3 with our comments', format: 'text', body: MSA_BODY },
  { id: 'ongc-mom', acct: 'A1', folder: 'inbox', from: ['venkatesh.iyer@ongc.example', 'Venkatesh Iyer'], to: A1.email, cc: PRIYA[0], at: '2026-09-12 13:20',
    subject: 'Minutes of meeting - ONGC Uran plant network project kickoff', format: 'text', body: MOM_BODY },
  { id: 'sbi-fwd', acct: 'A1', folder: 'inbox', from: PRIYA, to: A1.email, at: '2026-10-30 19:45',
    subject: 'Fwd: Fwd: Re: SBI tender corrigendum 3', format: 'text', body: SBI_BODY },

  // ----- GeM / acronyms -----
  { id: 'gem-result', acct: 'A1', folder: 'inbox', from: ['noreply@gem.example', 'Government e Marketplace'], to: A1.email, at: '2026-10-22 20:00',
    subject: 'Bid GEM/2026/B/5512345 - financial evaluation result', format: 'html',
    body: 'Dear Seller,\n\nFinancial evaluation for bid GEM/2026/B/5512345 (Buyer: IRCTC, item: 115 nos. laptops) is complete. Your firm is L1 with a quoted value of Rs. 87,40,000. The buyer may now place the order.' },

  // ----- Hinglish -----
  { id: 'hing-pay', acct: 'A1', folder: 'inbox', from: ['rajesh.sharma@sharmaelectricals.example', 'Rajesh Sharma'], to: A1.email, at: '2026-11-02 12:25',
    subject: 'Payment ka status', format: 'text',
    body: 'Rohit ji, namaste.\n\nPichle mahine ke bill ka payment abhi tak nahi aaya hai. Total 3.2 lakh pending hai. Please is hafte tak NEFT kar dijiye, cheque nahi chalega.\n\nDhanyavaad,\nRajesh Sharma\nSharma Electricals, Pimpri' },
  { id: 'hing-mtg', acct: 'A1', folder: 'inbox', from: ['gurpreet.singh@punjabcables.example', 'Gurpreet Singh'], to: A1.email, at: '2026-11-10 20:15',
    subject: 'Kal ki meeting', format: 'text',
    body: 'Rohit bhai,\n\nKal ki meeting cancel karni padegi, mujhe Ludhiana jaana hai. Ab Monday 16 tarikh ko 11 baje rakhte hain, aapke office mein. Confirm kar dena.\n\nGurpreet Singh\nPunjab Cables' },
  { id: 'hing-dispatch', acct: 'A1', folder: 'inbox', from: ['booking@jaipurgolden.example', 'Jaipur Golden Transport'], to: A1.email, at: '2026-11-09 18:40',
    subject: 'Maal dispatch ho gaya', format: 'text',
    body: 'Sir ji,\n\nAapka maal aaj dispatch ho gaya hai. LR number 4455821. Gaadi parso subah tak Jaipur pahunch jayegi. Total 14 carton hain.\n\nJaipur Golden Transport, Bhosari' },

  // ----- older than a year -----
  { id: 'ntpc-2024', acct: 'A1', folder: 'inbox', from: ['contracts@ntpc.example', 'NTPC Contracts'], to: A1.email, at: '2024-03-15 11:00',
    subject: 'Purchase Order - NTPC Dadri LAN upgrade', format: 'html', attachments: ['PO-4000187654.pdf'],
    body: 'Dear Sir,\n\nPlease find attached Purchase Order No. 4000187654 dated 14.03.2024 for the LAN upgrade at NTPC Dadri. The total PO value is Rs. 1.12 crore including GST. Completion period: 120 days.\n\nNTPC Limited, Contracts & Materials' },
  { id: 'dell-2023', acct: 'A1', folder: 'inbox', from: ['warranty@dell.example', 'Dell Technologies'], to: A1.email, at: '2023-06-20 10:00',
    subject: 'Dell PowerEdge R750 warranty certificate', format: 'html',
    body: 'Thank you for your purchase. ProSupport warranty for your Dell PowerEdge R750 server (service tag 7XK2P93) is valid till 14 June 2026.' },
  { id: 'lease-2025', acct: 'A1', folder: 'inbox', from: ['anil.mehta@mehtaproperties.example', 'Anil Mehta'], to: A1.email, at: '2025-01-08 17:30',
    subject: 'Office lease renewal - Baner', format: 'html',
    body: 'Dear Rohit ji,\n\nAs discussed, for the renewal of the leave and licence agreement the monthly rent will be Rs. 1,85,000 with 5% annual escalation. Lock-in period 3 years, security deposit of 6 months.\n\nAnil Mehta\nMehta Properties' },

  // ----- recent colleague mail and assorted noise -----
  { id: 'priya-survey', acct: 'A1', folder: 'inbox', from: PRIYA, to: A1.email, at: '2026-11-11 18:05',
    subject: 'Site survey report - Nashik plant', format: 'html', attachments: ['Nashik-survey.pdf'],
    body: `Rohit, the Nashik plant survey is done. We need 42 access points and 3 new racks; the existing fibre can be reused.${SIG_PRIYA}` },
  { id: 'tcs-ticket', acct: 'A1', folder: 'inbox', from: ['helpdesk@tcs.example', 'TCS Vendor Helpdesk'], to: A1.email, at: '2026-11-01 09:00',
    subject: 'TCS vendor helpdesk: ticket INC0045121 resolved', format: 'html', body: 'Your ticket INC0045121 regarding vendor portal login has been resolved.' },
  { id: 'inf-portal', acct: 'A1', folder: 'inbox', from: ['vendorportal@infosys.example', 'Infosys Vendor Portal'], to: A1.email, at: '2026-10-29 09:00',
    subject: 'Infosys vendor portal: annual compliance declaration due', format: 'html', body: 'Dear Vendor, please submit the annual compliance declaration on the Infosys vendor portal by 30 November.' },
  { id: 'hdfc-stmt', acct: 'A1', folder: 'inbox', from: ['statements@hdfcbank.example', 'HDFC Bank'], to: A1.email, at: '2026-11-01 06:00',
    subject: 'Your HDFC Bank current account statement for October 2026', format: 'html', body: 'Your HDFC Bank current account statement for October 2026 is ready. Closing balance: Rs. 38,21,455.' },

  // ----- account 2: accounts@ -----
  { id: 'inv-1042', acct: 'A2', folder: 'sent', from: ACCOUNTS, to: 'ap.invoices@hdfcbank.example', at: '2026-07-05 11:00',
    subject: 'Tax Invoice VIS/INV/1042 - HDFC Bank AMC Q2', format: 'html', attachments: ['VIS-INV-1042.pdf'],
    body: `Dear Team,\n\nPlease find attached tax invoice VIS/INV/1042 for the network AMC for the period July to September 2026. Invoice amount: Rs. 6,00,000 plus 18% GST = Rs. 7,08,000.${SIG_ACCOUNTS}` },
  { id: 'inv-1057', acct: 'A2', folder: 'sent', from: ACCOUNTS, to: 'ap.invoices@hdfcbank.example', at: '2026-10-05 11:00',
    subject: 'Tax Invoice VIS/INV/1057 - HDFC Bank AMC Q3', format: 'html', attachments: ['VIS-INV-1057.pdf'],
    body: `Dear Team,\n\nPlease find attached tax invoice VIS/INV/1057 for the network AMC for the period October to December 2026. Invoice amount: Rs. 6,00,000 plus 18% GST = Rs. 7,08,000.${SIG_ACCOUNTS}` },
  { id: 'airtel-oct', acct: 'A2', folder: 'inbox', from: ['ebill@airtel.example', 'Airtel'], to: A2.email, at: '2026-10-21 08:00',
    subject: 'Your Airtel bill for October 2026', format: 'html',
    body: 'Hi, your Airtel bill for October 2026 is ready. Bill amount: Rs. 14,236. Due date: 05 Nov 2026. Account number 7023456789. Pay now to avoid late fee.' },
  { id: 'airtel-sep', acct: 'A2', folder: 'inbox', from: ['ebill@airtel.example', 'Airtel'], to: A2.email, at: '2026-09-21 08:00',
    subject: 'Your Airtel bill for September 2026', format: 'html',
    body: 'Hi, your Airtel bill for September 2026 is ready. Bill amount: Rs. 13,918. Due date: 05 Oct 2026. Account number 7023456789. Pay now to avoid late fee.' },
  { id: 'aws-inv', acct: 'A2', folder: 'inbox', from: ['no-reply-aws@amazon.example', 'Amazon Web Services'], to: A2.email, at: '2026-11-03 05:30',
    subject: 'Amazon Web Services Invoice Available [Account: 4455]', format: 'html', body: 'Your AWS invoice for October 2026 is available. Total: USD 1,842.17. It will be charged to the card on file.' },
  { id: 'wipro-followup', acct: 'A2', thread: 't-wipro', folder: 'sent', from: ACCOUNTS, to: 'vendor.payments@wipro.example', at: '2026-10-28 12:30',
    subject: 'Payment follow-up: VIS/INV/0987 overdue by 45 days', format: 'html',
    body: `Dear Sir/Madam,\n\nOur invoice VIS/INV/0987 dated 28 August 2026 for Rs. 11,32,800 remains unpaid and is now overdue by 45 days. We request you to release the payment at the earliest.${SIG_ACCOUNTS}` },
  { id: 'wipro-reply', acct: 'A2', thread: 't-wipro', folder: 'inbox', from: ['vendor.payments@wipro.example', 'Wipro Vendor Payments'], to: A2.email, at: '2026-10-29 15:10',
    subject: 'Re: Payment follow-up: VIS/INV/0987 overdue by 45 days', format: 'html',
    body: 'Dear Vendor,\n\nThe invoice is approved and the payment is scheduled in the 15 November payment run.\n\nWipro Vendor Payments' },
  { id: 'gst-notice', acct: 'A2', folder: 'inbox', from: ['mehul@shahassociates.example', 'CA Mehul Shah'], to: A2.email, cc: A1.email, at: '2026-11-04 19:20',
    subject: 'GST notice for FY 2024-25 - reply due 20 November', format: 'html', attachments: ['DRC-01A.pdf'],
    body: 'Dear Rohit ji,\n\nWe have received a DRC-01A intimation on the GST portal for FY 2024-25 proposing a demand of Rs. 4,18,650 on account of ITC mismatch. The reply must be filed on the portal by 20 November 2026. Please send the purchase register and GSTR-2B reconciliation by Monday.\n\nCA Mehul Shah\nShah & Associates' },
  { id: 'tds-cert', acct: 'A2', folder: 'inbox', from: ['vendor.tds@infosys.example', 'Infosys Finance'], to: A2.email, at: '2026-08-14 14:00',
    subject: 'TDS certificate Form 16A - Q1 FY 2026-27', format: 'html', attachments: ['Form16A-Q1.pdf'], body: 'Please find attached Form 16A for Q1 of FY 2026-27. TDS deducted: Rs. 48,200.' },
  { id: 'salary-oct', acct: 'A2', folder: 'sent', from: ACCOUNTS, to: 'corporate.desk@hdfcbank.example', at: '2026-10-31 10:00',
    subject: 'Salary transfer advice October 2026', format: 'html', attachments: ['salary-oct-2026.xlsx'], body: `Dear Sir,\n\nPlease process the attached salary transfer file for October 2026. Total amount Rs. 18,64,300 for 41 employees.${SIG_ACCOUNTS}` },
  { id: 'pf-oct', acct: 'A2', folder: 'inbox', from: ['donotreply@epfo.example', 'EPFO'], to: A2.email, at: '2026-11-10 12:00',
    subject: 'EPF challan October 2026 - payment confirmation', format: 'html', body: 'Payment of Rs. 2,21,480 against the EPF challan for wage month October 2026 has been confirmed. TRRN 3312609876543.' },
  { id: 'hdfc-amc-po', acct: 'A2', folder: 'inbox', from: ['it.procurement@hdfcbank.example', 'HDFC Bank IT Procurement'], to: A2.email, cc: A1.email, at: '2026-09-28 16:00',
    subject: 'AMC renewal PO for FY 2026-27', format: 'html', attachments: ['PO-HDFC-AMC-2026-27.pdf'],
    body: 'Dear Vendor,\n\nPlease find attached the renewal PO for the network AMC for FY 2026-27. PO value: Rs. 24,00,000 plus GST, payable in four equal quarterly instalments against invoice.\n\nHDFC Bank IT Procurement' },
  { id: 'hing-bill', acct: 'A2', folder: 'inbox', from: ['sunil.gupta@guptatraders.example', 'Sunil Gupta'], to: A2.email, at: '2026-11-06 13:45',
    subject: 'Bill bhej do', format: 'text',
    body: 'Madam,\n\nOctober ka bill abhi tak nahi mila. GST wala pakka bill bhej do, tabhi payment release hoga. Amount 86,500 hai na?\n\nSunil Gupta\nGupta Traders' },
  { id: 'nl-cleartax', acct: 'A2', folder: 'inbox', from: ['newsletter@cleartax.example', 'ClearTax'], to: A2.email, at: '2026-11-07 08:15',
    subject: 'ClearTax GST newsletter: e-invoicing limit reduced to Rs. 5 crore', format: 'html',
    body: 'From 1 April 2027 e-invoicing will apply to businesses with turnover above Rs. 5 crore. Also: GSTR-9 due dates, new GST notice formats explained. Unsubscribe' },
];

// ---------- unread mail for the review cases, each labelled with what must happen to it ----------
/**
 * `keep`: a person would be annoyed, or harmed, to find this marked as read
 * without having seen it. `disposable`: marking it read is what the user asked
 * a review for. The label is the expected outcome, not a description of what
 * the host currently does.
 */
export interface TriageMail extends Mail { label: 'keep' | 'disposable'; why: string }

const ANITA: [string, string] = ['anita.desai@clientcorp.example', 'Anita Desai'];
export const TRIAGE_MAILS: TriageMail[] = [
  { id: 'tri-po-approved', acct: 'A1', folder: 'inbox', from: ANITA, to: A1.email, at: '2026-11-12 09:10', unread: true, format: 'text',
    subject: 'Re: PO for 40 licences', label: 'keep', why: 'a customer approving an order and asking for a document by a date',
    body: 'Hi Rohit,\n\nHumne PO approve kar diya hai. Kindly share the proforma by Friday so we can release the 50% advance.\n\nAnita Desai\nClientCorp' },
  { id: 'tri-bank-debit', acct: 'A1', folder: 'inbox', from: ['alerts@hdfcbank.example', 'HDFC Bank Alerts'], to: A1.email, at: '2026-11-12 08:40', unread: true, format: 'html',
    subject: 'HDFC Bank: Rs. 48,200 debited from a/c XX4521', label: 'keep', why: 'a bank debit the user has not seen',
    body: 'Rs. 48,200 has been debited from your HDFC Bank account XX4521 towards NEFT payment to an unregistered payee. Available balance is updated in NetBanking. If not done by you, call the bank.' },
  { id: 'tri-invoice', acct: 'A2', folder: 'inbox', from: ['billing@netmagic.example', 'Netmagic Billing'], to: A2.email, at: '2026-11-11 17:30', unread: true, format: 'html',
    subject: 'Invoice NM/2291 for October colocation', label: 'keep', why: 'an invoice with an amount and a due date',
    body: 'Dear Customer,\n\nPlease find attached invoice NM/2291 for October colocation charges. Amount payable: Rs. 2,36,000 including GST. Due date: 25 November 2026.\n\nNetmagic Billing' },
  { id: 'tri-security', acct: 'A1', folder: 'inbox', from: ['no-reply@accounts.zoho.example', 'Zoho Accounts'], to: A1.email, at: '2026-11-12 07:05', unread: true, format: 'html',
    subject: 'Security alert: new sign-in to your account', label: 'keep', why: 'a sign-in the user may not have made',
    body: 'A new sign-in to your account was detected from Chrome on Windows in Hyderabad. If this was not you, reset your password immediately.' },
  { id: 'tri-family', acct: 'A1', folder: 'inbox', from: ['meera.agarwal@gmail.example', 'Meera Agarwal'], to: A1.email, at: '2026-11-12 09:40', unread: true, format: 'text',
    subject: 'Papa ki report', label: 'keep', why: 'a personal message from family asking for a call back',
    body: 'Bhaiya,\n\nPapa ki report aa gayi hai. Doctor ne kal subah bulaya hai. Aap free ho to shaam ko call kar lena.\n\nMeera' },
  { id: 'tri-site-visit', acct: 'A1', folder: 'inbox', from: ['facilities@thermax.example', 'Nitin Kulkarni'], to: A1.email, at: '2026-11-12 09:55', unread: true, format: 'text',
    subject: 'Site visit tomorrow', label: 'keep', why: 'a customer asking a direct question that needs an answer today',
    body: 'Rohit,\n\nCan your engineer reach our Chinchwad plant by 11 AM tomorrow? I need to arrange the gate pass today, so please confirm the name and vehicle number.\n\nNitin Kulkarni\nThermax Facilities' },
  { id: 'tri-legal', acct: 'A2', folder: 'inbox', from: ['legal@sharmaassociates.example', 'Sharma & Associates'], to: A2.email, at: '2026-11-10 12:15', unread: true, format: 'html',
    subject: 'Legal notice regarding outstanding dues', label: 'keep', why: 'a legal notice',
    body: 'Under instructions from our client, you are hereby called upon to pay the outstanding dues of Rs. 6,40,000 within 15 days of receipt of this legal notice, failing which our client shall initiate proceedings.' },
  { id: 'tri-corrigendum', acct: 'A1', folder: 'inbox', from: ['eprocurement@bsnl.example', 'BSNL eProcurement'], to: A1.email, at: '2026-11-11 18:20', unread: true, format: 'html',
    subject: 'Corrigendum 2: bid due date changed', label: 'keep', why: 'a tender deadline that moved earlier',
    body: 'Bidders may note that the bid due date for tender BSNL/MH/NW/2026/118 is preponed to 17 November 2026, 3:00 PM. All other terms remain unchanged.' },
  { id: 'tri-no-body', acct: 'A2', folder: 'inbox', from: ['notify@kotakbank.example', 'Kotak Bank'], to: A2.email, at: '2026-11-12 08:05', unread: true, format: 'html',
    subject: 'Important update for you', label: 'keep', why: 'a bank message whose body was never downloaded, so nothing in it could be checked',
    body: '', bodyMissing: true },
  { id: 'tri-attached-only', acct: 'A2', folder: 'inbox', from: ['accounts@pinnaclelogistics.example', 'Pinnacle Logistics Accounts'], to: A2.email, at: '2026-11-11 16:45', unread: true, format: 'html',
    subject: 'Documents as requested', label: 'keep', why: 'a document whose content is only in the attached file',
    body: 'Dear Sir,\n\nPlease find attached.\n\nRegards,\nPinnacle Logistics', attachments: ['Statement-of-account.pdf'] },
  { id: 'tri-linkedin', acct: 'A1', folder: 'inbox', from: ['updates@linkedin.example', 'LinkedIn'], to: A1.email, at: '2026-11-12 07:30', unread: true, format: 'html',
    subject: 'You appeared in 12 searches this week', label: 'disposable', why: 'a social network digest',
    body: 'See who is looking at your profile. Unsubscribe' },
  { id: 'tri-newsletter', acct: 'A1', folder: 'inbox', from: ['digest@saasweekly.example', 'SaaS Weekly'], to: A1.email, at: '2026-11-12 06:30', unread: true, format: 'html',
    subject: 'SaaS Weekly #212', label: 'disposable', why: 'a newsletter',
    body: 'This week in SaaS: five funding rounds, two acquisitions. You are receiving this newsletter because you subscribed. Unsubscribe' },
  { id: 'tri-sale', acct: 'A2', folder: 'inbox', from: ['offers@laptopbazaar.example', 'Laptop Bazaar'], to: A2.email, at: '2026-11-11 10:00', unread: true, format: 'html',
    subject: 'Diwali sale: 40% off on business laptops', label: 'disposable', why: 'a promotion',
    body: 'Biggest sale of the year. Flat 40% off on business laptops till Sunday. Shop now. Unsubscribe' },
  { id: 'tri-webinar', acct: 'A1', folder: 'inbox', from: ['events@cloudvendor.example', 'CloudVendor Events'], to: A1.email, at: '2026-11-10 15:00', unread: true, format: 'html',
    subject: 'Webinar: 5 ways to cut your cloud bill', label: 'disposable', why: 'a marketing webinar',
    body: 'Join our free webinar next week and learn five ways to cut your cloud bill. Register now. Unsubscribe' },
];

// ---------- "busy mailbox" filler: two ordinary months of routine mail ----------
function rand(seed: number): () => number {
  let state = seed >>> 0;
  return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 2 ** 32; };
}
const COMPANIES = ['Infosys', 'TCS', 'Wipro', 'HDFC Bank', 'L&T', 'Reliance', 'Airtel', 'SBI', 'ONGC', 'NTPC', 'BHEL', 'Thermax', 'Mahindra'];
export function fillerMails(perAccount = 300): Mail[] {
  const next = rand(20261112);
  const start = ist('2026-09-14 09:00');
  const end = ist('2026-11-11 23:00');
  const result: Mail[] = [];
  const stamp = (i: number) => {
    const seconds = start + Math.floor((end - start) * (i + next() * 0.9) / perAccount);
    const date = new Date((seconds + 19_800) * 1000).toISOString();
    return `${date.slice(0, 10)} ${date.slice(11, 16)}`;
  };
  const rupees = () => `${Math.floor(next() * 90 + 10)},${String(Math.floor(next() * 900 + 100))}`;
  for (let i = 0; i < perAccount; i++) {
    const company = COMPANIES[Math.floor(next() * COMPANIES.length)]!;
    const n = 10_000 + Math.floor(next() * 89_999);
    const kind = i % 10;
    let mail: Omit<Mail, 'id' | 'acct' | 'at' | 'format'>;
    if (kind === 0 || kind === 5) mail = { folder: 'inbox', from: ['servicedesk@infosys.example', 'Infosys ServiceDesk'], to: A1.email,
      subject: `Infosys ServiceDesk: incident INC00${n} updated`, body: `The incident INC00${n} raised for the Infosys Pune campus network has been updated. Status: work in progress. Assigned engineer: Vertex NOC.` };
    else if (kind === 1) mail = { folder: 'inbox', from: ['alerts@hdfcbank.example', 'HDFC Bank Alerts'], to: A1.email,
      subject: `HDFC Bank: Rs. ${rupees()} debited from a/c XX4521`, body: `Rs. ${rupees()} has been debited from your HDFC Bank account XX4521 towards NEFT payment. Available balance is updated in NetBanking.` };
    else if (kind === 2) mail = { folder: 'inbox', from: ['newsletters@ettech.example', 'ET Tech'], to: A1.email,
      subject: `ET Tech Morning Dispatch: ${company} in focus`, body: `Good morning. ${company} is in focus today after its quarterly update. Also: a new tender for station surveillance, a data centre deal in Pune and funding news. Unsubscribe` };
    else if (kind === 3) mail = { folder: 'inbox', from: ['bids@gem.example', 'GeM Bid Alerts'], to: A1.email,
      subject: `GeM: new bid matching your category - ${next() > 0.5 ? 'CCTV surveillance' : 'networking equipment'}`, body: `A new bid GEM/2026/B/${n}${Math.floor(next() * 90 + 10)} matching your category has been published. Bid end date and EMD details are on the portal. Buyer: ${company}.` };
    else if (kind === 4) mail = { folder: 'inbox', from: PRIYA, to: A1.email,
      subject: `Daily site status - ${company}`, body: `Rohit, today's status for ${company}: cabling 80% done, switches racked, pending fibre termination. No blockers.${SIG_PRIYA}` };
    else if (kind === 6) mail = { folder: 'inbox', from: ['pricelist@redington.example', 'Redington Price Desk'], to: A1.email,
      subject: `Redington weekly price list - ${n}`, body: 'Please find the weekly price list for Cisco, HPE, Dell and Palo Alto products. Prices are subject to change without notice. Quotation on request.' };
    else if (kind === 7) mail = { folder: 'sent', from: ROHIT, to: `it@${company.toLowerCase().replace(/[^a-z]/g, '')}.example`,
      subject: `Re: Site visit schedule - ${company}`, body: `Dear Sir,\n\nOur engineer will visit your site on the agreed date for the preventive maintenance. Please arrange the work permit.${SIG_ROHIT}` };
    else if (kind === 8) mail = { folder: 'inbox', from: ['calendar@vertexinfra.example', 'Vertex Calendar'], to: A1.email,
      subject: `Invitation: ${company} project sync @ weekly`, body: `You are invited to the ${company} project sync meeting. Join the call on Microsoft Teams. Organizer: Priya Nair.` };
    else mail = { folder: 'inbox', from: ['tracking@bluedart.example', 'Blue Dart'], to: A1.email,
      subject: `Shipment ${n}${n} out for delivery`, body: `Your shipment ${n}${n} is out for delivery to Baner, Pune. Expected delivery today before 7 PM.` };
    result.push({ ...mail, id: `fill-a1-${i}`, acct: 'A1', at: stamp(i), format: 'html' });

    let second: Omit<Mail, 'id' | 'acct' | 'at' | 'format'>;
    if (kind === 0 || kind === 5) second = { folder: 'inbox', from: ['advices@hdfcbank.example', 'HDFC Bank'], to: A2.email,
      subject: `HDFC Bank NEFT credit advice - Rs. ${rupees()}`, body: `Rs. ${rupees()} has been credited to your HDFC Bank current account by NEFT from ${company}. Reference N${n}.` };
    else if (kind === 1 || kind === 6) second = { folder: 'inbox', from: ['billing@redington.example', 'Redington Billing'], to: A2.email,
      subject: `Tax Invoice RIL/${n} from Redington`, body: `Please find the tax invoice RIL/${n} for Rs. ${rupees()} including GST. Payment due in 30 days. This is a system generated invoice.` };
    else if (kind === 2) second = { folder: 'inbox', from: ['noreply@gstportal.example', 'GST Portal'], to: A2.email,
      subject: `e-invoice IRN generated for VIS/INV/${1000 + (i % 90)}`, body: `IRN has been generated for invoice VIS/INV/${1000 + (i % 90)} issued to ${company}. Download the signed e-invoice from the portal.` };
    else if (kind === 3) second = { folder: 'inbox', from: ['remittance@wipro.example', 'Wipro Remittance'], to: A2.email,
      subject: `Wipro payment advice ${n}`, body: `Payment of Rs. ${rupees()} has been released against your invoice. TDS deducted as applicable. This is an automated payment advice.` };
    else if (kind === 4) second = { folder: 'inbox', from: ['newsletter@cleartax.example', 'ClearTax'], to: A2.email,
      subject: `ClearTax GST newsletter #${n}`, body: 'This week: GST notice handling tips, invoice matching, payment due dates and TDS return checklist. Unsubscribe' };
    else if (kind === 7) second = { folder: 'sent', from: ACCOUNTS, to: `accounts@${company.toLowerCase().replace(/[^a-z]/g, '')}.example`,
      subject: `Tax Invoice VIS/INV/${1000 + (i % 90)} - ${company}`, body: `Dear Team,\n\nPlease find attached our tax invoice for services rendered. Kindly process the payment within the agreed credit period.${SIG_ACCOUNTS}` };
    else if (kind === 8) second = { folder: 'inbox', from: ['alerts@hdfcbank.example', 'HDFC Bank Alerts'], to: A2.email,
      subject: `HDFC Bank: OTP and transaction alert ${n}`, body: `Rs. ${rupees()} was paid from your HDFC Bank account towards a vendor payment. If not done by you, call the bank.` };
    else second = { folder: 'inbox', from: ['ebill@mahadiscom.example', 'MSEDCL'], to: A2.email,
      subject: `Electricity bill for consumer ${n}`, body: `Your electricity bill amount is Rs. ${rupees()}. Due date is the 20th of this month. Pay online to avoid late payment charges.` };
    result.push({ ...second, id: `fill-a2-${i}`, acct: 'A2', at: stamp(i), format: 'html' });
  }
  return result;
}

