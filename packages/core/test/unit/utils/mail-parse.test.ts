import { describe, it, expect } from 'vitest';

import { MAX_HTML_PARSE_BYTES, SIMPLE_PARSER_OPTIONS } from '../../../src/utils/mail-parse';

// These constants are the DoS guard for `simpleParser`: a message with a
// multi-hundred-MB HTML part pins CPU/RAM during the HTML->text conversion. The
// options object is spread into EVERY simpleParser call site so the cap cannot be
// forgotten in one of them — which makes its exact shape part of the contract.

describe('MAX_HTML_PARSE_BYTES', () => {
  // Pinned deliberately: raising it re-opens the DoS window, lowering it starts
  // truncating legitimate newsletters.
  it('caps HTML parsing at 5 MB', () => {
    expect(MAX_HTML_PARSE_BYTES).toBe(5 * 1024 * 1024);
  });
});

describe('SIMPLE_PARSER_OPTIONS', () => {
  // The key name is mailparser's — a typo here silently disables the cap, since
  // simpleParser ignores unknown options.
  it('passes the cap to mailparser under its maxHtmlLengthToParse option', () => {
    expect(SIMPLE_PARSER_OPTIONS.maxHtmlLengthToParse).toBe(MAX_HTML_PARSE_BYTES);
  });

  // Nothing else may ride along: extra options here would apply to every parse in
  // the app (sync, drafts, attachment extraction) at once.
  it('carries only the one option', () => {
    expect(Object.keys(SIMPLE_PARSER_OPTIONS)).toEqual(['maxHtmlLengthToParse']);
  });
});
