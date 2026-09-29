// @vitest-environment happy-dom
// The library splits bodies with the DOM, so these tests need a real DOMParser.
import type { ChatMessage } from '@sarv-in/email-chat-view';
import type { FirstSplitPart } from '@sarvinbox/core/first-split';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AI_SPLIT_FALLBACK_MARKER,
  AI_SPLIT_MARKER,
  aiEligibilityFor,
  composeAiTurns,
  coversContent,
  firstEmailFacts,
} from '../../../../../src/components/email-detail/ai-view-compose';
import {
  attachmentsOf,
  normalizedContent,
  ownerEmailOf,
  threadTurns,
  toEpochMs,
} from '../../../../../src/components/email-detail/chat-message-adapter';

import { ELEVEN_AM, email, ME, TEN_AM } from './email-fixture';
import {
  ALICE_TEXT,
  BOB_TEXT,
  CAROL_TEXT,
  DAN_TEXT,
  LOOPED_AT,
  loopedInEmail,
  loopedInParts,
  splitPart,
} from './looped-in-fixture';

/**
 * The AI view's composition: Standard's bubbles, with only the FIRST email's
 * slot replaced by its split parts.
 *
 * What breaks if this file goes red: the AI view stops being "Standard plus a
 * better first email". Either later emails vanish or re-render (the old AI
 * view showed nothing for a message the pipeline had not processed), a
 * message of the first email's history shows twice (once from the split, once
 * from a later reply's quote), or a split part takes the email's id without
 * its attachments and menu.
 */

const part = splitPart;

/** The split of the looped-in fixture: Alice, Bob, Carol quoted; Dan's own words. */
const LOOPED_PARTS: FirstSplitPart[] = loopedInParts();

/** The reader's reply to Dan, a day later: a later member of the thread. */
const readerReply = () =>
  email({
    id: 'e2',
    date: LOOPED_AT + 3600,
    fromAddress: ME,
    fromName: 'Me',
    rawBody: '<div dir="ltr">Thanks Dan, I will join the Friday review with the forecast.</div>',
  });

/**
 * The verified inversion, with real bodies: the first email quotes Alice
 * under an attribution with no readable date (so its copy is dated
 * approximately, just before the first email) and with a banner in front
 * (so the library's exact-key dedupe does not merge it); the reader's reply
 * quotes Alice with her real date. The host dedupe keeps whichever copy sorts
 * first — the reply's.
 */
function inversionThread() {
  const e1 = email({
    id: 'e1',
    date: LOOPED_AT,
    fromAddress: 'dan@acme.example',
    rawBody: [
      '<div dir="ltr">Looping you in on the planning thread below, see Alice.</div>',
      '<div class="gmail_quote"><div dir="ltr" class="gmail_attr">On the day, Alice Chen &lt;alice@acme.example&gt; wrote:<br></div>',
      `<blockquote class="gmail_quote"><div dir="ltr">CONFIDENTIAL NOTICE ${ALICE_TEXT}</div></blockquote></div>`,
    ].join(''),
  });
  const e2 = email({
    id: 'e2',
    date: LOOPED_AT + 3600,
    fromAddress: ME,
    rawBody: [
      '<div dir="ltr">Thanks Dan, joining the review with the forecast numbers.</div>',
      '<div class="gmail_quote"><div dir="ltr" class="gmail_attr">On Mon, 2 Mar 2026 at 10:00, Alice Chen &lt;alice@acme.example&gt; wrote:<br></div>',
      `<blockquote class="gmail_quote"><div dir="ltr">${ALICE_TEXT}</div></blockquote></div>`,
    ].join(''),
  });
  return { e1, e2 };
}

/** A hand-built turn, for the shapes the library produces only by accident of timing. */
const turn = (overrides: Partial<ChatMessage> & { id: string }): ChatMessage => ({
  fromAddress: 'alice@acme.example',
  date: toEpochMs(TEN_AM),
  body: '<div>x</div>',
  ...overrides,
});

describe('composeAiTurns', () => {
  // I1 — THE invariant: every bubble not carried by the first email is the
  // Standard view's own object. A re-derived copy would re-render every body
  // frame on toggle and could drift from what Standard shows.
  it('keeps every turn the first email does not carry as the SAME object Standard produced', () => {
    const standard = threadTurns([loopedInEmail(), readerReply()], { currentUserEmail: ME });
    const composed = composeAiTurns({ standard, first: loopedInEmail(), parts: LOOPED_PARTS, currentUserEmail: ME });
    const later = standard.turns.filter((each) => (each.sourceId ?? each.id) !== 'e1');
    expect(later.length).toBeGreaterThan(0);
    for (const each of later) expect(composed).toContain(each);
  });

  it('replaces the first email’s slot with its parts, oldest first', () => {
    const standard = threadTurns([loopedInEmail(), readerReply()], { currentUserEmail: ME });
    const composed = composeAiTurns({ standard, first: loopedInEmail(), parts: LOOPED_PARTS, currentUserEmail: ME });
    expect(composed.map((each) => each.id)).toEqual(['e1#ai1', 'e1#ai2', 'e1#ai3', 'e1', 'e2']);
    expect(composed.every((each) => each.id === 'e2' || each.applied?.includes(AI_SPLIT_MARKER))).toBe(true);
  });

  // Empty parts is "no usable split": the AI view must then be exactly
  // Standard, not an empty pane.
  it('is exactly Standard’s list when there are no parts', () => {
    const standard = threadTurns([loopedInEmail(), readerReply()], { currentUserEmail: ME });
    for (const parts of [null, undefined, []]) {
      const composed = composeAiTurns({ standard, first: loopedInEmail(), parts, currentUserEmail: ME });
      expect(composed).toEqual(standard.turns);
      composed.forEach((each, index) => expect(each).toBe(standard.turns[index]));
    }
  });

  // The verified inversion: a later reply's copy of H1 carries a readable date
  // and sorts BEFORE the first email's approximately-dated copy, so the host
  // dedupe kept the later mail's copy and dropped the first email's. In the AI
  // view, H1 must appear exactly once — the first email's split part.
  it('shows a quoted message once when a later reply’s copy displaced the first email’s', () => {
    const h1 = `<div>${ALICE_TEXT}</div>`;
    const e1 = email({ id: 'e1', date: LOOPED_AT, fromAddress: 'dan@acme.example' });
    const raw = [
      turn({ id: 'e1#1', sourceId: 'e1', body: h1, date: toEpochMs(LOOPED_AT) - 1, dateApprox: true }),
      turn({ id: 'e1', fromAddress: 'dan@acme.example', date: toEpochMs(LOOPED_AT), body: `<div>${DAN_TEXT}</div>` }),
      turn({ id: 'e2#1', sourceId: 'e2', body: h1, date: toEpochMs(TEN_AM) }),
      turn({ id: 'e2', fromAddress: ME, date: toEpochMs(LOOPED_AT + 3600), body: '<div>Reply</div>' }),
    ];
    // What dropDuplicateQuotes left: e2's copy (earlier date) won.
    const turns = [raw[2]!, raw[1]!, raw[3]!];
    const composed = composeAiTurns({
      standard: { raw, turns },
      first: e1,
      parts: [LOOPED_PARTS[0]!, LOOPED_PARTS[3]!],
      currentUserEmail: ME,
    });
    expect(composed.filter((each) => each.body.includes('quarterly planning review'))).toHaveLength(1);
    expect(composed.map((each) => each.id)).toEqual(['e1#ai1', 'e1', 'e2']);
  });

  // The same inversion through the real pipeline: H1 once, as the split part.
  it('shows the displaced quote once with the real split and dedupe', () => {
    const { e1, e2 } = inversionThread();
    const standard = threadTurns([e1, e2], { currentUserEmail: ME });
    expect(standard.turns.some((each) => each.id === 'e2#1')).toBe(true); // the inversion happened
    const composed = composeAiTurns({
      standard,
      first: e1,
      parts: [
        part({ body: `<div>${ALICE_TEXT}</div>` }),
        part({ role: 'own', fromAddress: 'dan@acme.example', date: LOOPED_AT, body: '<div>Looping you in on the planning thread below, see Alice.</div>' }),
      ],
      currentUserEmail: ME,
    });
    expect(composed.filter((each) => each.body.includes('quarterly planning review'))).toHaveLength(1);
    expect(composed.map((each) => each.id)).toEqual(['e1#ai1', 'e1', 'e2']);
  });

  // The carrier flip: while the first email's body had not arrived, a later
  // mail's split recovered the history (e2#1..#3) and Standard shows it under
  // that mail. With a usable split those copies collapse into the parts.
  it('collapses a later mail’s copies of the history into the first email’s parts', () => {
    const e1 = email({ id: 'e1', date: LOOPED_AT, fromAddress: 'dan@acme.example', rawBody: '' });
    const pending = turn({ id: 'e1', fromAddress: 'dan@acme.example', date: toEpochMs(LOOPED_AT), body: '', bodyPending: true });
    const copies = [ALICE_TEXT, BOB_TEXT, CAROL_TEXT].map((text, index) =>
      turn({ id: `e2#${index + 1}`, sourceId: 'e2', body: `<div>${text}</div>`, date: toEpochMs(TEN_AM) + index }));
    const own = turn({ id: 'e2', fromAddress: ME, date: toEpochMs(LOOPED_AT + 3600), body: '<div>Reply</div>' });
    const all = [...copies, pending, own];
    const composed = composeAiTurns({ standard: { raw: all, turns: all }, first: e1, parts: LOOPED_PARTS, currentUserEmail: ME });
    expect(composed.map((each) => each.id)).toEqual(['e1#ai1', 'e1#ai2', 'e1#ai3', 'e1', 'e2']);
    expect(composed.find((each) => each.id === 'e1')!.bodyPending).toBeUndefined();
  });

  // Regression: a part that kept only a message's first sentence (a model
  // that stopped early, cached) hid a later mail's FULL copy behind it — the
  // containment rule reads "opens the same" as "the same message", and the
  // AI view then showed less than Standard.
  it('keeps a later mail’s full copy when the split part holding it was cut short', () => {
    const e1 = email({ id: 'e1', date: LOOPED_AT, fromAddress: 'dan@acme.example', rawBody: '' });
    const pending = turn({ id: 'e1', fromAddress: 'dan@acme.example', date: toEpochMs(LOOPED_AT), body: '', bodyPending: true });
    const fullAlice = turn({ id: 'e2#1', sourceId: 'e2', body: `<div>${ALICE_TEXT}</div>`, date: toEpochMs(TEN_AM) });
    const own = turn({ id: 'e2', fromAddress: ME, date: toEpochMs(LOOPED_AT + 3600), body: '<div>Reply</div>' });
    const cutParts = LOOPED_PARTS.map((each, index) => (index === 0
      ? { ...each, body: '<div>Can we move the quarterly planning review to Friday afternoon?</div>' }
      : each));
    const all = [fullAlice, pending, own];
    const composed = composeAiTurns({ standard: { raw: all, turns: all }, first: e1, parts: cutParts, currentUserEmail: ME });
    expect(composed).toContain(fullAlice);
    // A full part still stands in for the copy (the carrier flip above).
    const whole = composeAiTurns({ standard: { raw: all, turns: all }, first: e1, parts: LOOPED_PARTS, currentUserEmail: ME });
    expect(whole).not.toContain(fullAlice);
  });

  // Regression for the first-email half of the rule: the model CLEANED Alice's
  // message (dropped her long legal footer), so its part no longer covers a
  // later mail's copy footer and all — but the first email's own Standard
  // segment is that very copy. The first email carries the message, so the
  // later copy is a duplicate and goes; without the check against the first
  // email's Standard turns Alice showed twice (the clean part, then the later
  // mail's full copy).
  it('drops a later copy the first email carries even when the cleaned part does not cover it', () => {
    const footer = ' This message and any attachments are confidential and intended solely for the addressee.'
      + ' If you received it in error, notify the sender and delete it; any use or disclosure is prohibited.';
    const withFooter = `<div>${ALICE_TEXT}</div><div>${footer}</div>`;
    const e1 = email({ id: 'e1', date: LOOPED_AT, fromAddress: 'dan@acme.example' });
    const e1Copy = turn({ id: 'e1#1', sourceId: 'e1', body: withFooter, date: toEpochMs(LOOPED_AT) - 1, dateApprox: true });
    const e1Own = turn({ id: 'e1', fromAddress: 'dan@acme.example', date: toEpochMs(LOOPED_AT), body: `<div>${DAN_TEXT}</div>` });
    const laterCopy = turn({ id: 'e2#1', sourceId: 'e2', body: withFooter, date: toEpochMs(TEN_AM) });
    const own = turn({ id: 'e2', fromAddress: ME, date: toEpochMs(LOOPED_AT + 3600), body: '<div>Reply</div>' });
    const raw = [e1Copy, e1Own, laterCopy, own];
    // The host dedupe kept the later mail's (readably dated) copy.
    const turns = [laterCopy, e1Own, own];
    const cleanParts = [LOOPED_PARTS[0]!, LOOPED_PARTS[3]!];
    // The premise: the cleaned part alone does NOT stand in for the later copy.
    expect(coversContent(
      normalizedContent(cleanParts[0]!.body),
      normalizedContent(withFooter),
    )).toBe(false);
    const composed = composeAiTurns({ standard: { raw, turns }, first: e1, parts: cleanParts, currentUserEmail: ME });
    expect(composed).not.toContain(laterCopy);
    expect(composed.map((each) => each.id)).toEqual(['e1#ai1', 'e1', 'e2']);
  });

  // A branch: a later mail quotes a message the first email never carried.
  // That quote is the only copy of it — it must survive.
  it('keeps a quote only a later mail carries', () => {
    const e1 = email({ id: 'e1', date: LOOPED_AT, fromAddress: 'dan@acme.example' });
    const branch = turn({
      id: 'e2#1',
      sourceId: 'e2',
      body: '<div>Side question from Erin about the offsite venue booking and the catering headcount deadline.</div>',
      date: toEpochMs(LOOPED_AT + 60),
    });
    const own = turn({ id: 'e2', fromAddress: ME, date: toEpochMs(LOOPED_AT + 3600), body: '<div>Reply</div>' });
    const e1Own = turn({ id: 'e1', fromAddress: 'dan@acme.example', date: toEpochMs(LOOPED_AT), body: `<div>${DAN_TEXT}</div>` });
    const all = [e1Own, branch, own];
    const composed = composeAiTurns({ standard: { raw: all, turns: all }, first: e1, parts: LOOPED_PARTS, currentUserEmail: ME });
    expect(composed).toContain(branch);
  });

  // A quote part that is another mail's OWN message (a misdated member the
  // first email happens to quote) is dropped — that mail already shows it, as
  // a stored fact.
  it('drops a quoted part that is another mail’s own message', () => {
    const e1 = email({ id: 'e1', date: LOOPED_AT, fromAddress: 'dan@acme.example' });
    const carolOwn = turn({ id: 'e0', fromAddress: 'carol@acme.example', body: `<div>${CAROL_TEXT}</div>`, date: toEpochMs(TEN_AM) });
    const all = [carolOwn];
    const composed = composeAiTurns({ standard: { raw: all, turns: all }, first: e1, parts: LOOPED_PARTS, currentUserEmail: ME });
    expect(composed.filter((each) => each.body.includes('headcount plan'))).toEqual([carolOwn]);
  });

  // The own part IS the email: its id (so star/menu/reply act on it), no
  // sourceId, its recipients and its attachments — ownerEmailOf resolves it.
  it('gives the own part the email’s id, recipients and attachments', () => {
    const e1 = loopedInEmail({ attachmentNames: 'plan.pdf', attachmentSizes: '2048', ccAddress: 'erin@acme.example' });
    const standard = threadTurns([e1], { currentUserEmail: ME });
    const composed = composeAiTurns({ standard, first: e1, parts: LOOPED_PARTS, currentUserEmail: ME });
    const own = composed.find((each) => each.id === 'e1')!;
    expect(own.sourceId).toBeUndefined();
    expect(own.ccAddress).toBe('erin@acme.example');
    expect(own.attachments).toEqual(attachmentsOf(e1));
    expect(own.attachments?.[0]?.filename).toBe('plan.pdf');
    expect(ownerEmailOf(own, new Map([['e1', e1]]))).toBe(e1);
    // A quoted part claims no recipients and no attachments of the carrier.
    const quote = composed.find((each) => each.id === 'e1#ai1')!;
    expect(quote).toMatchObject({ sourceId: 'e1', toAddress: null });
    expect(quote.attachments).toBeUndefined();
    expect(ownerEmailOf(quote, new Map([['e1', e1]]))).toBeUndefined();
  });

  // `#ai<k>` ids never collide with the library's `#<n>`, so a later mail's
  // recovered quote and a split part can never share a React key.
  it('numbers quoted parts e1#ai<k>, apart from the library’s e1#<n>', () => {
    const standard = threadTurns([loopedInEmail()], { currentUserEmail: ME });
    const libraryIds = standard.raw.map((each) => each.id);
    const composed = composeAiTurns({ standard, first: loopedInEmail(), parts: LOOPED_PARTS, currentUserEmail: ME });
    const partIds = composed.filter((each) => each.sourceId === 'e1').map((each) => each.id);
    expect(partIds).toEqual(['e1#ai1', 'e1#ai2', 'e1#ai3']);
    expect(partIds.some((id) => libraryIds.includes(id))).toBe(false);
  });

  it('marks approximately-dated parts and fallback parts', () => {
    const e1 = loopedInEmail();
    const composed = composeAiTurns({
      standard: threadTurns([e1], { currentUserEmail: ME }),
      first: e1,
      parts: [part({ dateApprox: true, fallback: true }), LOOPED_PARTS[3]!],
      currentUserEmail: ME,
    });
    expect(composed[0]).toMatchObject({ dateApprox: true, applied: [AI_SPLIT_FALLBACK_MARKER] });
  });

  // A draft is never a bubble in either view — the AI view is built from
  // Standard's turns, whose input drops drafts by the shared predicate.
  it('never shows a draft', () => {
    const draft = email({ id: 'd1', date: LOOPED_AT + 60, fromAddress: ME, tags: '|Drafts|', rawBody: '<p>my draft reply</p>' });
    const e1 = loopedInEmail();
    const composed = composeAiTurns({
      standard: threadTurns([e1, draft], { currentUserEmail: ME }),
      first: e1,
      parts: LOOPED_PARTS,
      currentUserEmail: ME,
    });
    expect(composed.some((each) => each.id === 'd1' || each.body.includes('my draft reply'))).toBe(false);
  });

  // A forward with no comment has no own words: the parts are all quotes and
  // the view simply has no own bubble for the first email.
  it('works for a forward with no own words', () => {
    const e1 = loopedInEmail();
    const composed = composeAiTurns({
      standard: threadTurns([e1, readerReply()], { currentUserEmail: ME }),
      first: e1,
      parts: LOOPED_PARTS.slice(0, 3),
      currentUserEmail: ME,
    });
    expect(composed.map((each) => each.id)).toEqual(['e1#ai1', 'e1#ai2', 'e1#ai3', 'e2']);
  });

  // The reader's own quoted message right-aligns, like every other bubble.
  it('right-aligns a part the reader wrote', () => {
    const e1 = loopedInEmail();
    const composed = composeAiTurns({
      standard: threadTurns([e1], { currentUserEmail: ME }),
      first: e1,
      parts: [part({ fromAddress: ME }), LOOPED_PARTS[3]!],
      currentUserEmail: ME,
    });
    expect(composed[0]!.isFromMe).toBe(true);
    expect(composed[1]!.isFromMe).toBe(false);
  });
});

describe('coversContent', () => {
  const key = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, '');
  const ALICE = key(ALICE_TEXT);

  // Breaks: a cut-short part hides a full copy, or a full part stops
  // standing in for its own copy and the message shows twice.
  it('holds for the same message, and for one that keeps its closing characters', () => {
    expect(coversContent(ALICE, ALICE)).toBe(true);
    expect(coversContent(`${ALICE}thanksalice`, ALICE)).toBe(true);
    // Missing its opening words, but ending as the copy ends.
    expect(coversContent(ALICE.slice(12), ALICE)).toBe(true);
  });

  it('fails for a part that keeps only the opening of the copy', () => {
    expect(coversContent(ALICE.slice(0, 60), ALICE)).toBe(false);
  });

  it('fails for a different message', () => {
    expect(coversContent(key(BOB_TEXT), ALICE)).toBe(false);
  });
});

describe('firstEmailFacts', () => {
  afterEach(() => vi.unstubAllGlobals());

  // UNKNOWN is never 0: a first email whose original HTML has not arrived
  // (only the stripped preview) would otherwise be decided "quotes nothing",
  // and the chat view never offered for it.
  it('is unknown when the raw body is missing, even with a stripped preview', () => {
    expect(firstEmailFacts(loopedInEmail({ rawBody: '', cleanBody: 'On Mon Carol wrote: …' }), 2)).toEqual({ kind: 'unknown' });
    expect(firstEmailFacts(null, 1)).toEqual({ kind: 'unknown' });
  });

  it('is unknown with no DOM to split with', () => {
    vi.stubGlobal('DOMParser', undefined);
    expect(firstEmailFacts(loopedInEmail(), 2)).toEqual({ kind: 'unknown' });
  });

  it('counts the messages a looped-in email quotes from the structural split', () => {
    expect(firstEmailFacts(loopedInEmail(), 2)).toEqual({ kind: 'known', asSent: false, quoteCount: 3, countSource: 'split' });
  });

  // A Gmail reply quoting ONE message: offered chat, AI on demand only.
  it('counts one for a reply quoting one message', () => {
    const reply = email({
      id: 'r1',
      date: ELEVEN_AM,
      rawBody: [
        '<div dir="ltr">Sounds good.</div>',
        '<div class="gmail_quote"><div dir="ltr" class="gmail_attr">',
        'On Tue, 3 Mar 2026 at 10:00, Alice Chen &lt;alice@acme.example&gt; wrote:<br></div>',
        `<blockquote class="gmail_quote"><div dir="ltr">${ALICE_TEXT}</div></blockquote></div>`,
      ].join(''),
    });
    const facts = firstEmailFacts(reply, 1);
    expect(facts).toMatchObject({ quoteCount: 1, countSource: 'split' });
    expect(aiEligibilityFor(facts)).toBe('on_demand');
  });

  // The count comes from THIS email's own split, before the host dedupe: in
  // the verified inversion a later reply's readably-dated copy of the quote
  // displaces this email's approximately-dated one in Standard, which then
  // shows NO quote under the first email — counting there would read 0 and
  // never offer the chat view.
  it('counts from the first email alone, not from Standard’s deduped list', () => {
    const { e1, e2 } = inversionThread();
    const standard = threadTurns([e1, e2], { currentUserEmail: ME });
    expect(standard.turns.filter((each) => each.sourceId === 'e1')).toHaveLength(0);
    expect(firstEmailFacts(e1, 2)).toMatchObject({ quoteCount: 1, countSource: 'split' });
  });

  // Designed bulk mail is shown as sent and never split.
  it('gives 0 for as-sent bulk mail', () => {
    const digest = email({
      id: 'k1',
      fromAddress: 'no-reply@kekamail.com',
      messageId: '<k1@kekamail.com>',
      tags: '|INBOX|bulk|',
      rawBody: '<table role="presentation" bgcolor="#fff"><tr><td>Digest</td></tr></table>',
    });
    const facts = firstEmailFacts(digest, 1);
    expect(facts).toEqual({ kind: 'known', asSent: true, quoteCount: 0, countSource: 'split' });
    expect(aiEligibilityFor(facts)).toBe('none');
  });

  // Plain text has no markup for the structural split; its `>` nesting and
  // attribution lines still say how many messages it carries.
  it('falls back to the marker count for a plain-text chain', () => {
    const text = [
      'Looping you in.',
      '',
      'On Tue, 3 Mar 2026 at 09:00, Carol Diaz <carol@acme.example> wrote:',
      '> Finance can share the sheet.',
      '>',
      '> On Mon, 2 Mar 2026 at 18:00, Bob Ray <bob@acme.example> wrote:',
      '>> Friday works.',
    ].join('\n');
    const facts = firstEmailFacts(email({ id: 't1', contentType: 'text', rawBody: text }), 2);
    expect(facts).toMatchObject({ kind: 'known', countSource: 'marker' });
    expect(facts.kind === 'known' && facts.quoteCount).toBeGreaterThanOrEqual(2);
  });

  it('gives 0 for a plain message', () => {
    expect(firstEmailFacts(email({ id: 'p1', rawBody: '<p>Just a note.</p>' }), 1))
      .toEqual({ kind: 'known', asSent: false, quoteCount: 0, countSource: 'marker' });
  });
});

describe('aiEligibilityFor', () => {
  it.each([
    [{ kind: 'unknown' } as const, 'unknown'],
    [{ kind: 'known', asSent: true, quoteCount: 5, countSource: 'split' } as const, 'none'],
    [{ kind: 'known', asSent: false, quoteCount: 0, countSource: 'marker' } as const, 'none'],
    [{ kind: 'known', asSent: false, quoteCount: 1, countSource: 'split' } as const, 'on_demand'],
    [{ kind: 'known', asSent: false, quoteCount: 2, countSource: 'marker' } as const, 'auto'],
  ])('%j → %s', (facts, expected) => {
    expect(aiEligibilityFor(facts)).toBe(expected);
  });
});
