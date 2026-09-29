// A looped-in first email, shared by the AI-view suites (composition, regions,
// validation, the split run): Dan forwards a Gmail thread to the reader, and
// the thread's earlier messages — Alice's, then Bob's, then Carol's — exist
// ONLY as the nested quotes inside Dan's mail.
//
// Shared because every one of those suites has to agree on what "the first
// email's history" is; a second copy of this fixture drifts, and a test that
// passes against a body shape the others never see protects nothing.
import type { EmailRecord } from '@sarvinbox/core';
import type { FirstSplitPart } from '@sarvinbox/core/first-split';

import { email, TEN_AM } from './email-fixture';

/** Unix seconds — Dan's mail, a day after the history it carries. */
export const LOOPED_AT = TEN_AM + 86_400;

export const ALICE_TEXT =
  'Can we move the quarterly planning review to Friday afternoon? The finance numbers will not be ready before Thursday evening.';
export const BOB_TEXT =
  'Friday works for the platform team, but we need the capacity sheet from finance by Thursday noon to prepare the forecast.';
export const CAROL_TEXT =
  'Finance can share the capacity sheet on Thursday morning. I will send the updated headcount plan together with it.';
export const DAN_TEXT = 'Looping in the reader here so they have the whole planning thread before Friday.';

const attr = (when: string, name: string, address: string) =>
  `<div dir="ltr" class="gmail_attr">On ${when}, ${name} &lt;${address}&gt; wrote:<br></div>`;

/** Carol quoting Bob quoting Alice (Gmail nests): the history Dan's mail carries. */
export const LOOPED_IN_QUOTE = [
  '<div class="gmail_quote">',
  attr('Tue, 3 Mar 2026 at 09:00', 'Carol Diaz', 'carol@acme.example'),
  '<blockquote class="gmail_quote">',
  `<div dir="ltr">${CAROL_TEXT}</div>`,
  '<div class="gmail_quote">',
  attr('Mon, 2 Mar 2026 at 18:00', 'Bob Ray', 'bob@acme.example'),
  '<blockquote class="gmail_quote">',
  `<div dir="ltr">${BOB_TEXT}</div>`,
  '<div class="gmail_quote">',
  attr('Mon, 2 Mar 2026 at 10:00', 'Alice Chen', 'alice@acme.example'),
  `<blockquote class="gmail_quote"><div dir="ltr">${ALICE_TEXT}</div></blockquote>`,
  '</div>',
  '</blockquote>',
  '</div>',
  '</blockquote>',
  '</div>',
].join('');

/** Dan's own line, then the history. */
export const LOOPED_IN_BODY = `<div dir="ltr">${DAN_TEXT}</div>${LOOPED_IN_QUOTE}`;

/** The looped-in first email, as main's `withSource` record carries it. */
export function loopedInEmail(overrides: Partial<EmailRecord> = {}): EmailRecord {
  return email({
    id: 'e1',
    messageId: '<e1@acme.example>',
    fromAddress: 'dan@acme.example',
    fromName: 'Dan Moss',
    date: LOOPED_AT,
    rawBody: LOOPED_IN_BODY,
    ...overrides,
  });
}

/** One stored split part (a quote of Alice's unless overridden). */
export const splitPart = (overrides: Partial<FirstSplitPart>): FirstSplitPart => ({
  role: 'quote',
  fromAddress: 'alice@acme.example',
  fromName: 'Alice Chen',
  date: TEN_AM,
  dateApprox: false,
  body: `<div>${ALICE_TEXT}</div>`,
  fallback: false,
  ...overrides,
});

/** The split of {@link loopedInEmail}: Alice, Bob, Carol quoted; Dan's own words. */
export const loopedInParts = (): FirstSplitPart[] => [
  splitPart({ fromAddress: 'alice@acme.example', fromName: 'Alice Chen', date: TEN_AM - 3 * 3600, body: `<div>${ALICE_TEXT}</div>` }),
  splitPart({ fromAddress: 'bob@acme.example', fromName: 'Bob Ray', date: TEN_AM - 2 * 3600, body: `<div>${BOB_TEXT}</div>` }),
  splitPart({ fromAddress: 'carol@acme.example', fromName: 'Carol Diaz', date: TEN_AM - 3600, body: `<div>${CAROL_TEXT}</div>` }),
  splitPart({ role: 'own', fromAddress: 'dan@acme.example', fromName: 'Dan Moss', date: LOOPED_AT, body: `<div>${DAN_TEXT}</div>` }),
];

/** The thread's roster: every member's distinct sender. */
export const ROSTER = [
  { address: 'dan@acme.example', name: 'Dan Moss' },
  { address: 'carol@acme.example', name: 'Carol Diaz' },
];

/** Dan's own line in the chains below: short, the common looped-in shape. */
export const PRIYA_TEXT = 'FYI, adding Priya.';

/**
 * The same history as an Outlook chain in plain `<div>`s: every
 * "-----Original Message-----" and From/Sent/To/Subject line its own block,
 * which the library does not recognise as a boundary — so the whole body is
 * ONE segment (Standard shows it as one bubble) and ONE region.
 */
export const OUTLOOK_PLAIN_BODY = [
  `<div>${PRIYA_TEXT}</div>`,
  '<div>-----Original Message-----</div>',
  '<div>From: Carol Diaz &lt;carol@acme.example&gt;</div>',
  '<div>Sent: Tuesday, March 3, 2026 9:00 AM</div>',
  '<div>To: Bob Ray &lt;bob@acme.example&gt;</div>',
  '<div>Subject: RE: planning</div>',
  `<div>${CAROL_TEXT}</div>`,
  '<div>-----Original Message-----</div>',
  '<div>From: Bob Ray &lt;bob@acme.example&gt;</div>',
  '<div>Sent: Monday, March 2, 2026 6:00 PM</div>',
  '<div>To: Alice Chen &lt;alice@acme.example&gt;</div>',
  '<div>Subject: RE: planning</div>',
  `<div>${BOB_TEXT}</div>`,
  '<div>-----Original Message-----</div>',
  '<div>From: Alice Chen &lt;alice@acme.example&gt;</div>',
  '<div>Sent: Monday, March 2, 2026 10:00 AM</div>',
  '<div>To: Bob Ray &lt;bob@acme.example&gt;</div>',
  '<div>Subject: planning</div>',
  `<div>${ALICE_TEXT}</div>`,
].join('');

/** The same history under German Gmail attributions ("Am … schrieb …:"), which the library does not recognise either. */
export const GERMAN_BODY = [
  `<div>${PRIYA_TEXT}</div>`,
  '<div>Am Di., 3. März 2026 um 09:00 Uhr schrieb Carol Diaz &lt;carol@acme.example&gt;:</div>',
  `<div>${CAROL_TEXT}</div>`,
  '<div>Am Mo., 2. März 2026 um 18:00 Uhr schrieb Bob Ray &lt;bob@acme.example&gt;:</div>',
  `<div>${BOB_TEXT}</div>`,
  '<div>Am Mo., 2. März 2026 um 10:00 Uhr schrieb Alice Chen &lt;alice@acme.example&gt;:</div>',
  `<div>${ALICE_TEXT}</div>`,
].join('');
