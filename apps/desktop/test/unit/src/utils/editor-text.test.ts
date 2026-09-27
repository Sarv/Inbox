// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';

import { editorHtmlToText } from '../../../../src/utils/editor-text';

describe('editorHtmlToText', () => {
  // Regression: a reopened draft / undone send had its body shown but plainBody
  // left '', so Send stayed disabled on a message that clearly had text.
  it('returns the visible text of editor HTML', () => {
    expect(editorHtmlToText('<p>hi</p>')).toBe('hi');
    expect(editorHtmlToText('<p>Hello <strong>there</strong></p>')).toBe('Hello there');
  });

  // Regression: an empty editor must stay empty so Send is still disabled for
  // a genuinely blank message.
  it('returns an empty string for empty or missing input', () => {
    expect(editorHtmlToText('')).toBe('');
    expect(editorHtmlToText(undefined)).toBe('');
    expect(editorHtmlToText(null)).toBe('');
    expect(editorHtmlToText('<p></p>').trim()).toBe('');
  });

  // Regression: converting must not execute handlers in pasted / AI HTML.
  it('does not run inline handlers in the HTML', () => {
    (globalThis as Record<string, unknown>).__editorTextPwned = false;
    editorHtmlToText('<img src="x" onerror="globalThis.__editorTextPwned = true"><p>ok</p>');
    expect((globalThis as Record<string, unknown>).__editorTextPwned).toBe(false);
  });
});
