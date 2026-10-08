import { describe, expect, it } from 'vitest';

import { escapeHtml } from '../../../src/utils/html-escape';

// Sender-controlled text (subject, names, addresses) interpolated into HTML.
// Breaks if any of the five characters survives: text turns into markup — a
// remote image, a form, or a closed attribute.
describe('escapeHtml', () => {
  it('escapes all five characters that can end text or an attribute', () => {
    expect(escapeHtml(`<img src="x" onerror='y'> & co`)).toBe('&lt;img src=&quot;x&quot; onerror=&#39;y&#39;&gt; &amp; co');
  });

  it('escapes an existing entity again, so it displays as typed', () => {
    expect(escapeHtml('&lt;')).toBe('&amp;lt;');
  });

  it('leaves everything else alone, including non-ASCII', () => {
    expect(escapeHtml('Ünïcødé — plain text ✓ 123')).toBe('Ünïcødé — plain text ✓ 123');
    expect(escapeHtml('')).toBe('');
  });
});
