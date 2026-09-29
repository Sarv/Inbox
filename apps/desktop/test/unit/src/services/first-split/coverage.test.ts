// The line walk uses html-to-text, which needs no DOM; the default node
// environment is deliberate.
import { describe, expect, it } from 'vitest';

import { keepsEveryLine, segmentLines } from '../../../../../src/services/first-split/coverage';
import {
  ALICE_TEXT,
  BOB_TEXT,
  CAROL_TEXT,
  GERMAN_BODY,
  OUTLOOK_PLAIN_BODY,
  PRIYA_TEXT,
} from '../../components/email-detail/looped-in-fixture';

/**
 * The AI split's no-loss check: did the model's outputs keep every line of
 * one of Standard's segments?
 *
 * What breaks if this file goes red: the AI view loses text Standard showed —
 * a skipped message, a message cut short, a line gone from the middle — and
 * reports the split ok, so it is cached and never retried. Or, the other way,
 * a correct split of an Outlook chain is rejected because its header block or
 * a dropped signature counts as lost text, and the AI never helps the chains
 * it exists for.
 */

const key = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, '');
const ALL = [ALICE_TEXT, BOB_TEXT, CAROL_TEXT, PRIYA_TEXT].map(key);

describe('segmentLines', () => {
  // The Outlook separator and every From/Sent/To/Subject field line are
  // boundary markers, never message text the model must keep.
  it('marks an Outlook chain\'s separator and header fields as headers', () => {
    const lines = segmentLines(OUTLOOK_PLAIN_BODY);
    expect(lines.filter((line) => !line.header).map((line) => line.raw)).toEqual([PRIYA_TEXT, CAROL_TEXT, BOB_TEXT, ALICE_TEXT]);
    expect(lines.filter((line) => line.header)).toHaveLength(15);
  });

  it('marks a localized attribution as a header (the core quote-marker corpus)', () => {
    const lines = segmentLines(GERMAN_BODY);
    expect(lines.filter((line) => line.header).map((line) => line.raw)).toEqual([
      expect.stringMatching(/^Am Di\.,.*schrieb Carol Diaz/),
      expect.stringMatching(/^Am Mo\.,.*schrieb Bob Ray/),
      expect.stringMatching(/^Am Mo\.,.*schrieb Alice Chen/),
    ]);
  });

  // "To: do list" alone is prose; only a run of fields, or a field under a
  // marker line, is a header block.
  it('keeps a lone field-like line as text', () => {
    const lines = segmentLines('<div>Status update</div><div>To: do list for Friday</div><div>More text here</div>');
    expect(lines.every((line) => !line.header)).toBe(true);
  });

  it('marks a single field line directly under a marker line', () => {
    const lines = segmentLines('<div>-----Original Message-----</div><div>From: Carol Diaz</div><div>Hello there</div>');
    expect(lines.map((line) => line.header)).toEqual([true, true, false]);
  });

  // A quote nested in a blockquote comes out of the text converter with a
  // `>` prefix; the attribution under it must still be recognised.
  it('reads lines through a blockquote\'s quote prefix', () => {
    const lines = segmentLines('<div>Mine</div><blockquote><div>On Mon, 2 Mar 2026 at 10:00, Alice &lt;alice@acme.example&gt; wrote:</div><div>Theirs</div></blockquote>');
    expect(lines.map((line) => [line.raw, line.header])).toEqual([
      ['Mine', false],
      ['On Mon, 2 Mar 2026 at 10:00, Alice <alice@acme.example> wrote:', true],
      ['Theirs', false],
    ]);
  });

  // "<name@x>" in text is not a tag: the key keeps what follows it.
  it('keys a line without reading angle brackets in text as a tag', () => {
    const [line] = segmentLines('<div>send it to &lt;ops&gt; team today</div>');
    expect(line!.key).toBe('sendittoopsteamtoday');
  });
});

describe('keepsEveryLine', () => {
  const OUTLOOK = segmentLines(OUTLOOK_PLAIN_BODY);

  it('keeps a header-heavy chain every message of which the outputs hold', () => {
    expect(keepsEveryLine(OUTLOOK, ALL)).toBe(true);
    expect(keepsEveryLine(segmentLines(GERMAN_BODY), ALL)).toBe(true);
  });

  // The blocker's probe: [Bob, Carol, Dan] with Alice skipped.
  it('does not keep a chain one message of which nobody kept', () => {
    expect(keepsEveryLine(OUTLOOK, ALL.filter((each) => each !== key(ALICE_TEXT)))).toBe(false);
  });

  it('does not keep a message cut short', () => {
    expect(keepsEveryLine(OUTLOOK, [...ALL.slice(1), key('Can we move the quarterly planning review to Friday afternoon?')])).toBe(false);
  });

  it('does not keep a message whose middle line is gone', () => {
    const lines = segmentLines('<div>First line of the message.</div><div>A middle line that matters.</div><div>Last line of the message.</div>');
    expect(keepsEveryLine(lines, [key('First line of the message. Last line of the message.')])).toBe(false);
    expect(keepsEveryLine(lines, [key('First line of the message. A middle line that matters. Last line of the message.')])).toBe(true);
  });

  // The model is told to drop the trailing signature; Standard keeps it when
  // the message is too short to cut. That is not lost text.
  it('allows a dropped trailing sign-off block', () => {
    const lines = segmentLines('<div>Adding Priya.<br>Thanks,<br>Dan</div>');
    expect(keepsEveryLine(lines, [key('Adding Priya.')])).toBe(true);
  });

  it('allows a dropped trailing card with strong signature evidence (a job title)', () => {
    const lines = segmentLines('<div>The numbers are final now.</div><div>Robert Rayburn</div><div>Senior Engineer, Platform</div>');
    expect(keepsEveryLine(lines, [key('The numbers are final now.')])).toBe(true);
  });

  it('allows short trailing lines that prove nothing (a lone name)', () => {
    const lines = segmentLines('<div>The numbers are final now.</div><div>Bob</div>');
    expect(keepsEveryLine(lines, [key('The numbers are final now.')])).toBe(true);
  });

  // A tail the library would never call a signature is text the model lost.
  it('does not allow a dropped tail that is not a signature', () => {
    const lines = segmentLines('<div>The numbers are final now.</div><div>Please do not ship it before Friday.</div>');
    expect(keepsEveryLine(lines, [key('The numbers are final now.')])).toBe(false);
  });

  it('does not allow a "signature" longer than the library\'s own ceiling', () => {
    const essay = Array.from({ length: 30 }, (_, n) => `<div>Paragraph ${n} of a long closing section that is not a card.</div>`).join('');
    const lines = segmentLines(`<div>The numbers are final now.</div><div>Thanks,</div>${essay}`);
    expect(keepsEveryLine(lines, [key('The numbers are final now.')])).toBe(false);
  });

  // A block holding only a sign-off is a message of its own ("Thanks, Carol"
  // as a whole reply) — skipping it is a loss, not a dropped signature.
  it('does not keep a message nobody kept even when it is only a sign-off', () => {
    const lines = segmentLines('<div>Mine.</div><div>-----Original Message-----</div><div>From: Carol</div><div>Sent: Monday</div><div>Thanks,</div>');
    expect(keepsEveryLine(lines, [key('Mine.')])).toBe(false);
  });

  it('treats a segment with no text as kept', () => {
    expect(keepsEveryLine(segmentLines('<div>&nbsp;</div>'), [])).toBe(true);
    expect(keepsEveryLine([], [])).toBe(true);
  });
});
