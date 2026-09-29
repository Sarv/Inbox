// @vitest-environment happy-dom
// Output bodies are cleaned with the library's DOM-based segment recipe.
import { describe, expect, it } from 'vitest';

import { splitThread } from '../../../../../src/components/email-detail/chat-message-adapter';
import { chunkRegions, splitRegions, type RegionChunk } from '../../../../../src/services/first-split/regions';
import {
  buildParts,
  parseSplitResponse,
  validateChunkOutputs,
  type AcceptedOutput,
  type BuildPartsInput,
} from '../../../../../src/services/first-split/validate';
import { email } from '../../components/email-detail/email-fixture';
import {
  ALICE_TEXT,
  BOB_TEXT,
  CAROL_TEXT,
  DAN_TEXT,
  GERMAN_BODY,
  LOOPED_AT,
  LOOPED_IN_QUOTE,
  loopedInEmail,
  OUTLOOK_PLAIN_BODY,
  PRIYA_TEXT,
  ROSTER,
} from '../../components/email-detail/looped-in-fixture';

/**
 * Checking the model's split, and building the stored parts.
 *
 * What breaks if this file goes red: the AI view can lose or invent history.
 * A paraphrased or invented message would be shown as if the email carried it;
 * a salutation-only "husk" would stand in for a whole message; a message
 * Standard recovered but the model skipped would silently vanish; a cut-off
 * answer would be cached as a complete success and never retried.
 */

const E1 = loopedInEmail();
const REGIONS = splitRegions(E1.rawBody, { sentAt: new Date(LOOPED_AT * 1000), registerImage: (src) => src })!;
const CHUNK: RegionChunk = chunkRegions(REGIONS).chunks[0]!;
const STANDARD = splitThread([E1], { currentUserEmail: '' });

const entry = (region: number, body: string, overrides: Record<string, unknown> = {}) => ({
  region,
  from_address: '',
  from_name: null,
  to_address: '',
  date: '',
  body,
  ...overrides,
});

/** The model's answer covering every message of the fixture, oldest first. */
const FULL = [
  entry(3, `<div>${ALICE_TEXT}</div>`, { from_address: 'alice@acme.example', from_name: 'Alice Chen', date: 'Mon, 2 Mar 2026 at 10:00' }),
  entry(2, `<div>${BOB_TEXT}</div>`, { from_address: 'bob@acme.example', from_name: 'Bob Ray', date: 'Mon, 2 Mar 2026 at 18:00' }),
  entry(1, `<div>${CAROL_TEXT}</div>`, { from_address: 'carol@acme.example', from_name: 'Carol Diaz', date: 'Tue, 3 Mar 2026 at 09:00' }),
  entry(0, `<div>${DAN_TEXT}</div>`, { from_address: 'dan@acme.example', from_name: 'Dan Moss' }),
];

const accept = (messages: unknown[], truncated = false) => validateChunkOutputs(messages, CHUNK, { truncated });

/** The husk check's region floor (validate.ts HUSK_MIN_REGION_CHARS). */
const HUSK_REGION_FLOOR = 200;

/**
 * A first email whose history the library found NO boundary in: one region,
 * one Standard segment (the whole body). `answer` is the model's reply.
 */
function unsplitChain(rawBody: string) {
  const first = loopedInEmail({ rawBody });
  const regions = splitRegions(rawBody, { sentAt: new Date(LOOPED_AT * 1000), registerImage: (src) => src })!;
  const chunk = chunkRegions(regions).chunks[0]!;
  const standard = splitThread([first], { currentUserEmail: '' });
  return {
    regions,
    standard,
    build: (answer: unknown[]) => buildParts({
      accepted: validateChunkOutputs(answer, chunk, { truncated: false }).accepted,
      standard,
      first,
      roster: ROSTER,
      truncated: false,
      nowSeconds: LOOPED_AT + 999,
    }),
  };
}

/** The model's full answer for an unsplit chain: every message in region 0, oldest first, the own entry last. */
const UNSPLIT_FULL = [
  entry(0, `<div>${ALICE_TEXT}</div>`, { from_address: 'alice@acme.example', from_name: 'Alice Chen', date: 'Monday, March 2, 2026 10:00 AM' }),
  entry(0, `<div>${BOB_TEXT}</div>`, { from_address: 'bob@acme.example', from_name: 'Bob Ray', date: 'Monday, March 2, 2026 6:00 PM' }),
  entry(0, `<div>${CAROL_TEXT}</div>`, { from_address: 'carol@acme.example', from_name: 'Carol Diaz', date: 'Tuesday, March 3, 2026 9:00 AM' }),
  entry(0, `<div>${PRIYA_TEXT}</div>`, { from_address: 'dan@acme.example', from_name: 'Dan Moss' }),
];

const build = (accepted: AcceptedOutput[], overrides: Partial<BuildPartsInput> = {}) =>
  buildParts({
    accepted,
    standard: STANDARD,
    first: E1,
    roster: ROSTER,
    truncated: false,
    nowSeconds: LOOPED_AT + 999,
    ...overrides,
  });

describe('parseSplitResponse', () => {
  it('reads the messages array, or a bare array', () => {
    expect(parseSplitResponse(JSON.stringify({ messages: FULL }))).toEqual({ messages: FULL, truncated: false });
    expect(parseSplitResponse(JSON.stringify(FULL))!.messages).toHaveLength(4);
  });

  // No messages array → `unparseable`, which is retried once, then permanent.
  it('is null for prose, an empty answer or an object with no messages', () => {
    expect(parseSplitResponse('I could not split this email.')).toBeNull();
    expect(parseSplitResponse('')).toBeNull();
    expect(parseSplitResponse('{"result": []}')).toBeNull();
  });

  // A cut-off answer that jsonrepair salvages is flagged, so its last entry
  // (whose body may have lost its end) is not trusted.
  it('flags a response that was cut off', () => {
    const cut = JSON.stringify({ messages: FULL }).slice(0, -40);
    const parsed = parseSplitResponse(cut);
    expect(parsed?.truncated).toBe(true);
  });
});

describe('validateChunkOutputs', () => {
  it('accepts grounded outputs and cleans their bodies with the segment recipe', () => {
    const { accepted, rejected } = accept(FULL);
    expect(rejected).toEqual([]);
    expect(accepted.map((each) => each.region)).toEqual([3, 2, 1, 0]);
    expect(accepted[0]!.body).toContain('quarterly planning review');
  });

  // The model is only trusted to find boundaries: a paraphrase or an invented
  // message is not in the text it was given.
  it('drops an ungrounded or paraphrased output', () => {
    const { accepted, rejected } = accept([
      entry(1, '<div>Finance will share the capacity spreadsheet on Thursday, along with headcount.</div>'),
      entry(2, '<div>This message was never in the email at all and the model made it up entirely.</div>'),
    ]);
    expect(accepted).toEqual([]);
    expect(rejected).toEqual(['ungrounded', 'ungrounded']);
  });

  // An output grounded in a DIFFERENT region of the chunk than it named is
  // kept, under the region that actually holds it.
  it('re-assigns an output to the region its text is found in', () => {
    const { accepted } = accept([entry(1, `<div>${BOB_TEXT}</div>`)]);
    expect(accepted[0]!.region).toBe(2);
  });

  it('drops an output naming a region outside the chunk, or none', () => {
    const { accepted, rejected } = accept([
      entry(9, `<div>${BOB_TEXT}</div>`),
      entry(1.5 as unknown as number, `<div>${BOB_TEXT}</div>`),
      { body: `<div>${BOB_TEXT}</div>` },
      'not an object',
      null,
    ]);
    expect(accepted).toEqual([]);
    expect(rejected).toEqual(['region', 'region', 'region', 'shape', 'shape']);
  });

  // An empty body is never emitted as a bubble.
  it('drops an empty or text-less body', () => {
    const { rejected } = accept([entry(1, ''), entry(1, '<div>&nbsp;</div>'), entry(1, 42 as unknown as string)]);
    expect(rejected).toEqual(['empty', 'empty', 'empty']);
  });

  it('treats a body that cannot be parsed as empty', () => {
    const throwing = validateChunkOutputs([entry(1, `<div>${CAROL_TEXT}</div>`)], CHUNK, {
      truncated: false,
      parser: () => { throw new Error('no DOM'); },
    });
    const bodiless = validateChunkOutputs([entry(1, `<div>${CAROL_TEXT}</div>`)], CHUNK, {
      truncated: false,
      parser: () => ({ body: null }) as unknown as Document,
    });
    expect(throwing.rejected).toEqual(['empty']);
    expect(bodiless.rejected).toEqual(['empty']);
  });

  // A salutation standing in for a whole message: the only output for a long
  // region, keeping under a quarter of it.
  it('rejects a husk as the only output of a long region', () => {
    const long = `${CAROL_TEXT} ${BOB_TEXT} ${ALICE_TEXT}`;
    const regions = [
      { index: 1, html: `<div>Hi Ravi,</div><div>${long}</div>`, text: `hiravi${long.toLowerCase().replace(/[^a-z0-9]+/g, '')}`, messageChars: 6 + long.toLowerCase().replace(/[^a-z0-9]+/g, '').length, attribution: null },
    ];
    const chunk: RegionChunk = { regions, chars: 0, includesOwnRegion: false };
    const { accepted, rejected } = validateChunkOutputs([entry(1, '<div>Hi Ravi, see the notes below.</div><div>Hi Ravi</div>')], chunk, { truncated: false });
    expect(rejected).toContain('ungrounded');
    const husk = validateChunkOutputs([entry(1, '<div>Hi Ravi,</div>')], chunk, { truncated: false });
    expect(husk.accepted).toEqual([]);
    expect(husk.rejected).toEqual(['husk']);
    expect(accepted).toEqual([]);
  });

  // Regression: the husk share was measured against the region INCLUDING its
  // attribution. An Outlook From/Sent/To/Cc/Subject block is most of a short
  // reply's region, so "Approved, go ahead." was dropped as a husk and nearly
  // every Outlook split came out partial.
  it('measures the husk share against the message, not its Outlook header block', () => {
    const body = [
      '<div>Looping in Priya.</div>',
      '<div style="border:none;border-top:solid #E1E1E1 1.0pt"><p class="MsoNormal">',
      '<b>From:</b> Carol Diaz &lt;carol@acme.example&gt;<br><b>Sent:</b> Tuesday, March 3, 2026 9:00 AM<br>',
      '<b>To:</b> Bob Ray &lt;bob@acme.example&gt;; Alice Chen &lt;alice@acme.example&gt;; Ops Team &lt;ops-team@acme.example&gt;<br>',
      '<b>Cc:</b> Finance Planning &lt;finance-planning@acme.example&gt;; Headcount Review &lt;headcount-review@acme.example&gt;<br>',
      '<b>Subject:</b> RE: Quarterly planning review and capacity sheet</p></div>',
      '<p class="MsoNormal">Approved, go ahead.</p>',
    ].join('');
    const regions = splitRegions(body, { registerImage: (src) => src })!;
    expect(regions[1]!.text.length).toBeGreaterThan(HUSK_REGION_FLOOR);
    const chunk = chunkRegions(regions).chunks[0]!;
    const { accepted, rejected } = validateChunkOutputs([entry(1, '<p>Approved, go ahead.</p>')], chunk, { truncated: false });
    expect(rejected).toEqual([]);
    expect(accepted.map((each) => each.region)).toEqual([1]);
  });

  // The model's address is trusted only when the text it was given carries it.
  it('records whether the output\'s address is in the region\'s text', () => {
    const { accepted } = accept([
      entry(1, `<div>${CAROL_TEXT}</div>`, { from_address: 'carol@acme.example' }),
      entry(2, `<div>${BOB_TEXT}</div>`, { from_address: 'robert@elsewhere.example' }),
      entry(3, `<div>${ALICE_TEXT}</div>`, { from_address: 'Alice Chen' }),
    ]);
    expect(accepted.map((each) => each.addressInText)).toEqual([true, false, false]);
  });

  // A cut-off answer's last entry may have lost the end of its body — and a
  // cut body passes every other check.
  it('drops the last output of a truncated answer', () => {
    const { accepted, rejected } = accept(FULL, true);
    expect(accepted).toHaveLength(3);
    expect(rejected).toEqual(['truncated']);
  });
});

describe('buildParts', () => {
  it('builds ok parts, oldest first, the own part last, when every message is covered', () => {
    const built = build(accept(FULL).accepted);
    expect(built.status).toBe('ok');
    expect(built.fallbackParts).toBe(0);
    expect(built.parts.map((part) => [part.role, part.fromAddress])).toEqual([
      ['quote', 'alice@acme.example'],
      ['quote', 'bob@acme.example'],
      ['quote', 'carol@acme.example'],
      ['own', 'dan@acme.example'],
    ]);
    expect(built.parts[3]).toMatchObject({ date: LOOPED_AT, dateApprox: false, fallback: false });
    expect(built.parts.every((part) => part.body.trim() !== '')).toBe(true);
  });

  // THE no-loss rule: a message Standard recovered that the model skipped is
  // kept as Standard rendered it — and the run is `partial`, not `ok`.
  it('turns an uncovered Standard segment into a fallback part (partial)', () => {
    const built = build(accept(FULL.filter((each) => each.region !== 2)).accepted);
    expect(built.status).toBe('partial');
    expect(built.fallbackParts).toBe(1);
    const bob = built.parts.find((part) => part.body.includes('capacity sheet from finance by Thursday noon'))!;
    expect(bob).toMatchObject({ role: 'quote', fallback: true, fromAddress: 'bob@acme.example', fromName: 'Bob Ray' });
  });

  it('fails as unusable with no accepted output', () => {
    expect(build([])).toMatchObject({ status: 'failed', errorKind: 'unusable', parts: [] });
  });

  // A cut-off answer is never an `ok`: something may be missing from it.
  it('gives partial, not ok, for a repaired truncated answer', () => {
    const cut = parseSplitResponse(JSON.stringify({ messages: FULL }).slice(0, -40))!;
    const built = build(accept(cut.messages, cut.truncated).accepted, { truncated: cut.truncated });
    expect(built.status).toBe('partial');
    // Dan's own turn (the truncated last entry) is Standard's, not lost.
    expect(built.parts[built.parts.length - 1]).toMatchObject({ role: 'own', fallback: true });
  });

  // The same rule when nothing falls back: the output the cut dropped covered
  // no Standard segment (a message only the model found), so every segment is
  // covered — yet the answer was cut off, and what it lost is unknown. Without
  // the truncation half of the status rule this stored `ok`, and an `ok` is
  // never re-split automatically.
  it('gives partial for a truncated answer even when every Standard segment is covered', () => {
    const extra = entry(0, '<div>One more thing only the model found, cut off mid-sentence</div>', { from_address: 'dan@acme.example' });
    const { accepted, rejected } = accept([...FULL, extra], true);
    expect(rejected).toEqual(['truncated']);
    const built = build(accepted, { truncated: true });
    expect(built.fallbackParts).toBe(0);
    expect(built.status).toBe('partial');
    // …while the very same outputs from a complete answer are `ok`.
    expect(build(accepted).status).toBe('ok');
  });

  // A quote cannot be written after the email quoting it: a later date is a
  // misread (usually day/month) and is clamped, marked approximate.
  it('clamps an AI date later than the first email, marking it approximate', () => {
    const future = [entry(1, `<div>${CAROL_TEXT}</div>`, { from_address: 'carol@acme.example', date: '20 March 2026 09:00' }), FULL[3]!];
    const carol = build(accept(future).accepted).parts.find((part) => part.role === 'quote' && !part.fallback)!;
    expect(carol.dateApprox).toBe(true);
    expect(carol.date).toBeLessThan(LOOPED_AT);
    expect(carol.date).toBeGreaterThan(LOOPED_AT - 1);
  });

  // Moved from the retired utils/human-date suite: the AI's echoed dates are
  // read DAY-first, the convention these mailboxes use. Breaks: an ambiguous
  // "02/03/2026" read as the US 3 Feb — the exact wrong date the old
  // conversation view showed — while "2/17/2026" (only readable one way)
  // must stay 17 Feb.
  it('reads an ambiguous numeric AI date day-first, and an unambiguous US one as written', () => {
    const localDay = (seconds: number) => {
      const day = new Date(seconds * 1000);
      return { month: day.getMonth(), day: day.getDate() };
    };
    const dated = (date: string) => {
      const answer = [entry(1, `<div>${CAROL_TEXT}</div>`, { from_address: 'carol@acme.example', date }), FULL[3]!];
      return build(accept(answer).accepted).parts.find((part) => part.fromAddress === 'carol@acme.example' && !part.fallback)!;
    };
    const dayFirst = dated('02/03/2026, 11:12:15');
    expect(localDay(dayFirst.date)).toEqual({ month: 2, day: 2 });
    expect(dayFirst.dateApprox).toBe(false);
    expect(localDay(dated('On 2/17/2026, 2:51:17 PM, Carol Diaz wrote').date)).toEqual({ month: 1, day: 17 });
  });

  // A missing AI date takes the date Standard read off the attribution line.
  it('dates a quote from the Standard segment it covers when the model gave none', () => {
    const undated = [entry(1, `<div>${CAROL_TEXT}</div>`, { from_address: 'carol@acme.example' }), FULL[3]!];
    const carol = build(accept(undated).accepted).parts.find((part) => part.fromAddress === 'carol@acme.example' && !part.fallback)!;
    const standardCarol = STANDARD.find((turn) => turn.fromAddress === 'carol@acme.example')!;
    expect(carol).toMatchObject({ date: standardCarol.date / 1000, dateApprox: false });
  });

  // A mangled attribution loses the address and keeps the name: the roster
  // (the thread's senders) supplies it.
  it('resolves a name-only sender through the roster', () => {
    const nameOnly = [entry(1, `<div>${CAROL_TEXT}</div>`, { from_address: 'Carol Diaz', from_name: 'carol diaz' }), FULL[3]!];
    const built = build(accept(nameOnly).accepted, { standard: [] });
    expect(built.parts[0]).toMatchObject({ fromAddress: 'carol@acme.example' });
  });

  it('resolves a name written into the address field through the roster', () => {
    const misplaced = [entry(1, `<div>${CAROL_TEXT}</div>`, { from_address: 'Carol Diaz' }), FULL[3]!];
    const built = build(accept(misplaced).accepted, { standard: [] });
    expect(built.parts[0]).toMatchObject({ fromAddress: 'carol@acme.example', fromName: 'Carol Diaz' });
  });

  // The model gave an address but no name: the roster names the sender.
  it('names an address-only sender from the roster', () => {
    const addressOnly = [entry(1, `<div>${CAROL_TEXT}</div>`, { from_address: 'CAROL@acme.example' }), FULL[3]!];
    const built = build(accept(addressOnly).accepted, { standard: [] });
    expect(built.parts[0]).toMatchObject({ fromAddress: 'CAROL@acme.example', fromName: 'Carol Diaz' });
  });

  // Two senders sharing a display name: the roster cannot say which one.
  it('does not guess between two senders with the same name', () => {
    const roster = [{ address: 'sam@a.example', name: 'Sam' }, { address: 'sam@b.example', name: 'Sam' }];
    const nameOnly = [entry(1, `<div>${CAROL_TEXT}</div>`, { from_address: 'Sam', from_name: 'Sam' }), FULL[3]!];
    const built = build(accept(nameOnly).accepted, { standard: [], roster });
    expect(built.parts[0]!.fromAddress).toBe('');
  });

  it('leaves the address empty when neither the model, the roster nor Standard knows it', () => {
    const unknown = [entry(1, `<div>${CAROL_TEXT}</div>`, { from_address: 'Someone', from_name: 'Someone' }), FULL[3]!];
    const built = build(accept(unknown).accepted, { standard: [], roster: [] });
    expect(built.parts[0]).toMatchObject({ fromAddress: '', fromName: 'Someone' });
  });

  // The own part follows Standard's own turn: when the model did not cover
  // it, Standard's own turn IS the own part.
  it('keeps Standard’s own turn as the own part when the model missed it', () => {
    const built = build(accept(FULL.slice(0, 3)).accepted);
    expect(built.parts[built.parts.length - 1]).toMatchObject({ role: 'own', fallback: true, fromAddress: 'dan@acme.example' });
    expect(built.parts[built.parts.length - 1]!.body).toContain('Looping in the reader');
    expect(built.status).toBe('partial');
  });

  // A forward with no comment: Standard has no own turn. The own part is the
  // last region-0 output from the email's sender, if the model produced one.
  it('takes the last region-0 output from the sender as the own part of a comment-less forward', () => {
    const noOwn = STANDARD.filter((turn) => turn.sourceId);
    const outputs: AcceptedOutput[] = [
      { region: 0, fromAddress: 'dan@acme.example', addressInText: false, fromName: null, date: '', body: '<div>fwd note one</div>', key: 'fwdnoteone' },
      { region: 0, fromAddress: 'Dan <dan@acme.example>', addressInText: false, fromName: null, date: '', body: '<div>fwd note two</div>', key: 'fwdnotetwo' },
      ...accept(FULL.slice(0, 3)).accepted,
    ];
    const built = build(outputs, { standard: noOwn });
    const own = built.parts.filter((part) => part.role === 'own');
    expect(own).toHaveLength(1);
    expect(own[0]!.body).toContain('fwd note two');
    // The other region-0 output is kept as a quote rather than dropped.
    expect(built.parts.some((part) => part.role === 'quote' && part.body.includes('fwd note one'))).toBe(true);
  });

  it('has no own part for a comment-less forward the model found nothing of the sender in', () => {
    const noOwn = STANDARD.filter((turn) => turn.sourceId);
    const built = build(accept(FULL.slice(0, 3)).accepted, { standard: noOwn });
    expect(built.parts.some((part) => part.role === 'own')).toBe(false);
    expect(built.status).toBe('ok');
  });

  // A first email with no readable date: the parts are dated from the run's
  // clock rather than 0 (which the cache refuses, and which sorts to 1970).
  it('dates the parts of an undated first email from the run’s clock', () => {
    const undated = email({ id: 'e1', date: 0, fromAddress: 'dan@acme.example', rawBody: E1.rawBody });
    const built = build(accept(FULL).accepted, { first: undated });
    expect(built.parts.every((part) => part.date > 0)).toBe(true);
    expect(built.parts[built.parts.length - 1]).toMatchObject({ date: LOOPED_AT + 999, dateApprox: true });
  });

  // The same message twice in the model's answer is one part.
  it('keeps one part per message', () => {
    const doubled = [...FULL.slice(0, 3), entry(1, `<div>${CAROL_TEXT}</div>`), FULL[3]!];
    const built = build(accept(doubled).accepted);
    expect(built.parts.filter((part) => part.body.includes('headcount plan'))).toHaveLength(1);
  });

  // Regression (blocker): with no boundary the library recognises, Standard's
  // own segment is the WHOLE chain, every output sits inside it, and the own
  // part used to be the model's FIRST (oldest) entry — Alice's words shown as
  // Dan's, with his id, date and attachments, and Dan's line demoted to a
  // quote, all reported ok.
  describe.each([
    ['an Outlook "-----Original Message-----" chain in plain divs', OUTLOOK_PLAIN_BODY],
    ['a German "Am … schrieb" chain', GERMAN_BODY],
  ])('a first email with no recognised boundary: %s', (_name, rawBody) => {
    it('is one Standard segment and one region (the premise)', () => {
      const { regions, standard } = unsplitChain(rawBody);
      expect(regions).toHaveLength(1);
      expect(standard).toHaveLength(1);
    });

    it('takes the own part from the sender\'s own entry, not the first output inside the chain', () => {
      const built = unsplitChain(rawBody).build(UNSPLIT_FULL);
      expect(built.status).toBe('ok');
      expect(built.parts.map((part) => [part.role, part.fromAddress])).toEqual([
        ['quote', 'alice@acme.example'],
        ['quote', 'bob@acme.example'],
        ['quote', 'carol@acme.example'],
        ['own', 'dan@acme.example'],
      ]);
      expect(built.parts[3]!.body).toContain(PRIYA_TEXT);
      expect(built.parts[3]!.body).not.toContain('quarterly planning');
    });

    // The own entry is found by how it OPENS, whatever order the model used.
    it('finds the own entry out of order', () => {
      const shuffled = [UNSPLIT_FULL[3]!, UNSPLIT_FULL[1]!, UNSPLIT_FULL[0]!, UNSPLIT_FULL[2]!];
      const own = unsplitChain(rawBody).build(shuffled).parts.filter((part) => part.role === 'own');
      expect(own).toHaveLength(1);
      expect(own[0]!.body).toContain(PRIYA_TEXT);
    });

    // A skipped message had no coverage floor at all here: the segment list
    // was empty of quotes, so [Bob, Carol, Dan] came out ok with Alice gone.
    it('fails as unusable, never ok, when the model skipped a message', () => {
      const built = unsplitChain(rawBody).build(UNSPLIT_FULL.slice(1));
      expect(built).toMatchObject({ status: 'failed', errorKind: 'unusable', parts: [] });
    });

    it('fails as unusable when the model cut a message short', () => {
      const cut = [entry(0, '<div>Can we move the quarterly planning review to Friday afternoon?</div>'), ...UNSPLIT_FULL.slice(1)];
      expect(unsplitChain(rawBody).build(cut).status).toBe('failed');
    });

    it('fails as unusable when the model never gave the sender\'s own entry', () => {
      expect(unsplitChain(rawBody).build(UNSPLIT_FULL.slice(0, 3)).status).toBe('failed');
    });
  });

  // Regression: Standard keeps a short own line's sign-off (too little would
  // be left to cut it), the model drops it as the trailing signature, and the
  // model's line used to become a SECOND bubble — a quote from Dan, with E1's
  // attachment strip shown twice.
  it('keeps exactly one own part when a short own line differs only by its sign-off', () => {
    const rawBody = `<div dir="ltr">Adding Priya. Thanks, Dan</div>${LOOPED_IN_QUOTE}`;
    const first = loopedInEmail({ rawBody });
    const regions = splitRegions(rawBody, { sentAt: new Date(LOOPED_AT * 1000), registerImage: (src) => src })!;
    const chunk = chunkRegions(regions).chunks[0]!;
    const answer = [FULL[0]!, FULL[1]!, FULL[2]!, entry(0, '<div dir="ltr">Adding Priya.</div>', { from_address: 'dan@acme.example' })];
    const built = buildParts({
      accepted: validateChunkOutputs(answer, chunk, { truncated: false }).accepted,
      standard: splitThread([first], { currentUserEmail: '' }),
      first,
      roster: ROSTER,
      truncated: false,
      nowSeconds: LOOPED_AT,
    });
    const priya = built.parts.filter((part) => part.body.includes('Adding Priya'));
    expect(priya).toHaveLength(1);
    // Standard's own line, sign-off and all: nothing it showed is lost.
    expect(priya[0]).toMatchObject({ role: 'own', fallback: true, fromAddress: 'dan@acme.example' });
    expect(priya[0]!.body).toContain('Thanks, Dan');
    expect(built.parts.filter((part) => part.fromAddress === 'dan@acme.example')).toHaveLength(1);
  });

  // The sign-off on its own lines is exactly what the model is told to drop:
  // the model's own line is the own part, and the run is ok.
  it('takes the model\'s own line when Standard\'s differs by a sign-off block on its own lines', () => {
    const rawBody = `<div dir="ltr">Adding Priya.<br>Thanks,<br>Dan</div>${LOOPED_IN_QUOTE}`;
    const first = loopedInEmail({ rawBody });
    const regions = splitRegions(rawBody, { sentAt: new Date(LOOPED_AT * 1000), registerImage: (src) => src })!;
    const chunk = chunkRegions(regions).chunks[0]!;
    const answer = [FULL[0]!, FULL[1]!, FULL[2]!, entry(0, '<div dir="ltr">Adding Priya.</div>', { from_address: 'dan@acme.example' })];
    const built = buildParts({
      accepted: validateChunkOutputs(answer, chunk, { truncated: false }).accepted,
      standard: splitThread([first], { currentUserEmail: '' }),
      first,
      roster: ROSTER,
      truncated: false,
      nowSeconds: LOOPED_AT,
    });
    expect(built.status).toBe('ok');
    expect(built.parts.filter((part) => part.body.includes('Adding Priya'))).toEqual([
      expect.objectContaining({ role: 'own', fallback: false }),
    ]);
  });

  // Regression (major): an output keeping only a message's first sentence
  // counted as covering it (its opening is inside Standard's segment), so
  // Standard's segment was not kept, the run was ok, and the second sentence
  // was gone.
  it('keeps Standard\'s segment, and drops the output, when the model cut a quote short', () => {
    const cut = [
      entry(3, '<div>Can we move the quarterly planning review to Friday afternoon?</div>', { from_address: 'alice@acme.example' }),
      ...FULL.slice(1),
    ];
    const built = build(accept(cut).accepted);
    expect(built.status).toBe('partial');
    expect(built.fallbackParts).toBe(1);
    const alice = built.parts.filter((part) => part.body.includes('quarterly planning review'));
    expect(alice).toHaveLength(1);
    expect(alice[0]).toMatchObject({ role: 'quote', fallback: true, fromAddress: 'alice@acme.example' });
    expect(alice[0]!.body).toContain('will not be ready before Thursday evening');
  });

  // The same message twice in the answer, once cut short: the full copy wins,
  // whichever order they came in.
  it('keeps the longer copy of a message the model gave twice', () => {
    const twice = [
      entry(1, `<div>${CAROL_TEXT}</div>`, { from_address: 'carol@acme.example' }),
      entry(1, '<div>Finance can share the capacity sheet on Thursday morning.</div>', { from_address: 'carol@acme.example' }),
      FULL[3]!,
    ];
    const carol = build(accept(twice).accepted).parts.filter((part) => part.body.includes('capacity sheet on Thursday morning'));
    expect(carol).toHaveLength(1);
    expect(carol[0]!.body).toContain('headcount plan');
  });

  // Regression (minor): an address the model invented beat the attribution
  // Standard actually parsed.
  it('prefers Standard\'s parsed address to one the model invented', () => {
    const invented = [entry(1, `<div>${CAROL_TEXT}</div>`, { from_address: 'c.diaz@invented.example' }), FULL[3]!];
    const carol = build(accept(invented).accepted).parts.find((part) => part.body.includes('headcount plan'))!;
    expect(carol.fromAddress).toBe('carol@acme.example');
  });

  // An address the roster knows is not an invention, even when the region's
  // text does not carry it.
  it('keeps a model address the roster knows', () => {
    const outputs: AcceptedOutput[] = [
      { region: 1, fromAddress: 'dan@acme.example', addressInText: false, fromName: null, date: '', body: '<div>x note</div>', key: 'xnote' },
      ...accept([FULL[3]!]).accepted,
    ];
    const built = build(outputs, { standard: [] });
    expect(built.parts.find((part) => part.body.includes('x note'))!.fromAddress).toBe('dan@acme.example');
  });

  // Regression (minor): fallback parts stored Standard's segment HTML as it
  // came — with main's inline images inflated back to data: URIs — so one
  // row could carry megabytes of base64. Stored bodies carry sarv-image refs.
  it('stores a fallback part\'s data: images as sarv-image refs', () => {
    const dataUrl = 'data:image/png;base64,iVBORw0KGgo=';
    const withImage = STANDARD.map((turn) => (turn.fromAddress === 'bob@acme.example'
      ? { ...turn, body: `${turn.body}<img src="${dataUrl}">` }
      : turn));
    const skipBob = accept(FULL.filter((each) => each.region !== 2)).accepted;
    const built = build(skipBob, { standard: withImage, registerImage: () => 'sarv-image:bob-chart' });
    const bob = built.parts.find((part) => part.fallback && part.fromAddress === 'bob@acme.example')!;
    expect(bob.body).toContain('sarv-image:bob-chart');
    expect(bob.body).not.toContain('base64');
  });

  it('stores the own fallback part\'s data: images as sarv-image refs', () => {
    const dataUrl = 'data:image/png;base64,iVBORw0KGgo=';
    const withImage = STANDARD.map((turn) => (turn.sourceId ? turn : { ...turn, body: `${turn.body}<img src="${dataUrl}">` }));
    const built = build(accept(FULL.slice(0, 3)).accepted, { standard: withImage, registerImage: () => 'sarv-image:dan-logo' });
    const own = built.parts[built.parts.length - 1]!;
    expect(own).toMatchObject({ role: 'own', fallback: true });
    expect(own.body).toContain('sarv-image:dan-logo');
  });

  // Every part passes the cache's own shape check, so a save is never refused
  // as invalid.
  it('builds parts the cache accepts', async () => {
    const { parseFirstSplitParts } = await import('@sarvinbox/core/first-split');
    const built = build(accept(FULL.filter((each) => each.region !== 2)).accepted);
    expect(parseFirstSplitParts(JSON.stringify(built.parts))).not.toBeNull();
  });
});
