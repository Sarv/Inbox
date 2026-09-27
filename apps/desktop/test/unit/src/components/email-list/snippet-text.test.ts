import { describe, expect, it } from 'vitest';

import { SNIPPET_CHARS_PER_LINE, snippetText } from '../../../../../src/components/email-list/snippet-text';

// ---------------------------------------------------------------------------
// The body preview a list row shows (Appearance -> Message list).
//
// What breaks if this goes red: "None" still prints a preview, or a row is
// handed the WHOLE message body to lay out under a CSS clamp — once per row,
// on every render of a list that can hold hundreds of them.
// ---------------------------------------------------------------------------
const body = 'x'.repeat(5000);

describe('snippetText', () => {
  // THE REGRESSION: the "None" setting is the only thing that hides the
  // preview. Return text here and the option silently does nothing.
  it('shows nothing at all for zero lines', () => {
    expect(snippetText(body, 0)).toBe('');
  });

  // A negative count can only come from a corrupt stored value; it must read
  // as "none", never as "everything".
  it('shows nothing for a negative line count', () => {
    expect(snippetText(body, -1)).toBe('');
  });

  it('budgets one line of characters per line shown', () => {
    expect(snippetText(body, 1)).toHaveLength(SNIPPET_CHARS_PER_LINE);
    expect(snippetText(body, 2)).toHaveLength(SNIPPET_CHARS_PER_LINE * 2);
  });

  // Regression: the cut exists to keep a multi-kilobyte string out of the DOM.
  it('never hands a row the whole body', () => {
    expect(snippetText(body, 2).length).toBeLessThan(body.length);
  });

  it('leaves a body shorter than the budget alone', () => {
    expect(snippetText('Short one', 2)).toBe('Short one');
  });

  // A thread whose body never downloaded has no cleanBody — an empty preview,
  // not a crash in the middle of rendering the list.
  it('treats a missing body as an empty preview', () => {
    expect(snippetText(null, 2)).toBe('');
    expect(snippetText(undefined, 2)).toBe('');
  });
});
