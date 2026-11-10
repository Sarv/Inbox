import { describe, expect, it } from 'vitest';

import { toOneLine } from '../../../src/utils/log-text';

// Shared by app.log's renderer-forwarded records and main's Sarv catalog
// failure lines (server text). Breaks: a crafted or hostile string forges a
// line that reads as the main process's own, or drives a terminal on `cat`.
describe('toOneLine', () => {
  it('escapes CR and LF visibly so one record stays one line', () => {
    expect(toOneLine('a\nb\r\nc')).toBe('a\\nb\\r\\nc');
  });

  it('escapes every other control character and the Unicode separators', () => {
    expect(toOneLine('\u001b[31mred\u0000\u0085\u2028\u2029')).toBe('\\u001b[31mred\\u0000\\u0085\\u2028\\u2029');
  });

  // Breaks: ordinary text, tabs included, is mangled.
  it('leaves printable text and tabs alone', () => {
    expect(toOneLine('code=insufficient_scope\tllm:view required — ok')).toBe('code=insufficient_scope\tllm:view required — ok');
  });
});
