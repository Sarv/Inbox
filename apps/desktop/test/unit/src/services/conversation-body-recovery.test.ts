import { describe, expect, it } from 'vitest';

import { recoverBodyField } from '../../../../src/services/conversation-service';

/**
 * Recovering the rewritten body when the model's JSON is malformed.
 *
 * THE incident: 36 body-rewrite responses in one mailbox failed to parse, and
 * every one fell back to the heuristic slicer — a visibly worse email. The
 * responses were not truncated garbage; they were large HTML documents that the
 * model could not reliably escape into a JSON string. Classified from the log:
 *
 *   22  a quote escaped going in but not coming out, so the JSON string ends
 *       mid-attribute:  style=\"max-width:100%;">
 *   10  escapes JSON does not define:  </div\>  and  &quot;\;
 *    2  a literal control character inside the string
 *    1  trailing junk after the closing brace
 *    1  no key separator at all:  {"body"<html dir="ltr">
 *
 * The fixtures below are shaped from those real responses. A stricter parser
 * cannot fix any of them — the damage is in the delimiters a parser depends on
 * — so the recovery anchors on the schema instead: the prompt asks for exactly
 * {"body":"…"} and nothing else.
 */
describe('recoverBodyField', () => {
  // THE dominant failure, 22 of 36. The opening quote of the attribute is
  // escaped and the closing one is not, so JSON.parse ends the string early and
  // everything after it is syntax noise.
  it('recovers a body whose inner quotes are inconsistently escaped', () => {
    const raw = '{"body":"<div style=\\"max-width: 100%;">Strict Vetting</div>"}';
    expect(recoverBodyField(raw)).toBe('<div style="max-width: 100%;">Strict Vetting</div>');
  });

  // 10 of 36. `\>` and `\;` are not JSON escapes; the backslash is dropped and
  // the character kept, which is what the model meant.
  it('drops backslashes JSON gives no meaning', () => {
    expect(recoverBodyField('{"body":"<td\\>hi</td\\>"}')).toBe('<td>hi</td>');
    expect(recoverBodyField('{"body":"font: &quot;Sans&quot;\\;"}')).toBe('font: &quot;Sans&quot;;');
  });

  // THE case a repair pass handles worst: the response stopped mid-HTML, so
  // there is no closing quote or brace to find. Anchoring on the key means we
  // do not need one — and a partial email still beats the heuristic slicer.
  it('recovers a response cut off mid-HTML', () => {
    const raw = '{"body":"<table>\\n <tbody>\\n <tr>\\n <';
    expect(recoverBodyField(raw)).toBe('<table>\n <tbody>\n <tr>\n <');
  });

  // 1 of 36, and the reason the anchor tolerates a missing separator: the key
  // literal is still unambiguous even when the colon and quote are both gone.
  it('recovers when the key separator is missing entirely', () => {
    expect(recoverBodyField('{"body"<html dir="ltr">Hi Ramesh</html>'))
      .toBe('<html dir="ltr">Hi Ramesh</html>');
  });

  it('decodes the standard escapes', () => {
    expect(recoverBodyField('{"body":"a\\nb\\tc\\u00e9"}')).toBe('a\nb\tcé');
  });

  it('handles a response that is in fact well-formed', () => {
    expect(recoverBodyField('{"body":"<p>fine</p>"}')).toBe('<p>fine</p>');
  });

  // The guard that stops this being used as a universal rescue: without the
  // anchor it must decline, so a response of some OTHER shape is never
  // reinterpreted as a body.
  it('declines when there is no body field', () => {
    expect(recoverBodyField('{"messages":[{"from":"a@b.com"}]}')).toBeNull();
    expect(recoverBodyField('total nonsense')).toBeNull();
    expect(recoverBodyField('')).toBeNull();
  });

  // The model is told to return {"body":""} for "sender wrote nothing new".
  // That must read as empty, not as a recovery worth preferring.
  it('returns null for a deliberately empty body', () => {
    expect(recoverBodyField('{"body":""}')).toBeNull();
  });

  // A body ending in an escaped quote, immediately before the real closer —
  // the closer must come off and the escaped quote must survive.
  it('keeps a trailing escaped quote while removing the real closer', () => {
    expect(recoverBodyField('{"body":"<p class=\\"x\\">y</p>"}'))
      .toBe('<p class="x">y</p>');
  });

  // Whitespace and a missing brace around the closer are both seen in the wild.
  it('tolerates whitespace and a missing closing brace', () => {
    expect(recoverBodyField('{"body":"<p>a</p>"  }  ')).toBe('<p>a</p>');
    expect(recoverBodyField('{"body":"<p>a</p>"')).toBe('<p>a</p>');
  });

  // Only ONE field is ever requested, so reading to the end is safe — but if a
  // model volunteers a sibling key the content still has to survive rather than
  // the whole recovery collapsing.
  it('keeps the body when the model volunteers an extra field', () => {
    const out = recoverBodyField('{"body":"<p>hi</p>","note":"extra"}');
    expect(out).toContain('<p>hi</p>');
  });
});
