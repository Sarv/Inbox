import { describe, expect, it } from 'vitest';

import { fieldSizesForLog, setFieldNamesForLog, toOneLine, urlSchemeForLog, valueShapeForLog } from '../../../src/utils/log-text';

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

// Used where a link from mail reaches a log line (blocked navigations, blocked
// openExternal). Breaks: the host, path or query of a link in the user's mail
// is written to app.log.
describe('urlSchemeForLog', () => {
  it('keeps the scheme and nothing else', () => {
    expect(urlSchemeForLog('file:///Users/me/Payslip-SENTINEL.html')).toBe('file:');
    expect(urlSchemeForLog('https://bank.example/login?u=SENTINEL')).toBe('https:');
    expect(urlSchemeForLog('MS-Word:ofe|u|https://x.example/SENTINEL.docx')).toBe('ms-word:');
  });

  // Breaks: a made-up scheme long enough to carry words is written whole.
  it('refuses a scheme past 32 characters', () => {
    expect(urlSchemeForLog(`${'a'.repeat(40)}:rest`)).toBe('scheme-too-long');
  });

  // Breaks: text that is not a URL, or a value from a broken renderer that is
  // not a string, is written as it is.
  it('names unparseable text and non-strings by kind only', () => {
    expect(urlSchemeForLog('not a url SENTINEL')).toBe('unparseable');
    expect(urlSchemeForLog(42)).toBe('not-a-string:number');
    expect(urlSchemeForLog(null)).toBe('not-a-string:null');
    expect(urlSchemeForLog({ href: 'SENTINEL' })).toBe('not-a-string:object');
  });
});

// Used by the AI search line. Breaks: a typed search's words, senders or
// labels are written to app.log instead of which filters were set.
describe('setFieldNamesForLog', () => {
  // Changed deliberately: `isFlagged: false` is now listed. It used to be
  // dropped as "not set", but an explicit false is a filter (not flagged),
  // so the line hid a narrowing the search really applied.
  it('names the set fields, sorted, and none of their values', () => {
    expect(setFieldNamesForLog({
      textQuery: 'SENTINEL words', from: 'boss@x.example', subject: '', isUnread: true, isFlagged: false,
      labels: ['SENTINEL'], tags: [], sizeMin: 10, sizeMax: Number.NaN, cc: undefined, other: null, nested: {},
    })).toBe('from,isFlagged,isUnread,labels,nested,sizeMin,textQuery');
  });

  // Breaks: a search for READ mail (isUnread: false) logs as an unfiltered
  // search ('none'), so the line disagrees with the results the user saw.
  it('counts a boolean as set whether it is true or false', () => {
    expect(setFieldNamesForLog({ isUnread: false })).toBe('isUnread');
    expect(setFieldNamesForLog({ isUnread: true })).toBe('isUnread');
    expect(setFieldNamesForLog({ hasAttachments: false, isFlagged: true, isUnread: undefined })).toBe('hasAttachments,isFlagged');
  });

  // Breaks: the fields the caller reports itself are listed twice.
  it('skips the fields the caller names', () => {
    expect(setFieldNamesForLog({ textQuery: 'x', folderId: 'f1', limit: 10 }, ['folderId', 'limit'])).toBe('textQuery');
  });

  // Breaks: a key a compromised renderer chose (text, not an identifier) is
  // written out; it is counted instead.
  it('counts keys that are not identifiers instead of writing them', () => {
    expect(setFieldNamesForLog({ 'SENTINEL words here': 'x', from: 'a' })).toBe('from,+1 more');
    expect(setFieldNamesForLog({ 'SENTINEL words here': 'x' })).toBe('+1 more');
  });

  it('answers none for nothing set, or for a value that is not an object', () => {
    expect(setFieldNamesForLog({ textQuery: '' })).toBe('none');
    expect(setFieldNamesForLog(null)).toBe('none');
    expect(setFieldNamesForLog('SENTINEL')).toBe('none');
  });
});

// Used for an invalid item in an AI categorization answer. Breaks: the item
// (which can carry the model's reasoning about the email) is written whole.
describe('valueShapeForLog', () => {
  it('describes an object by its identifier keys only', () => {
    expect(valueShapeForLog({ reasoning: 'SENTINEL', categories: [] })).toBe('object keys=[categories,reasoning]');
    expect(valueShapeForLog({ 'SENTINEL prose key': 1 })).toBe('object keys=[+1 more]');
  });

  // Breaks: a huge object lists every key.
  it('names at most twelve keys and counts the rest', () => {
    const many = Object.fromEntries(Array.from({ length: 15 }, (_, i) => [`k${String(i).padStart(2, '0')}`, i]));
    expect(valueShapeForLog(many)).toBe('object keys=[k00,k01,k02,k03,k04,k05,k06,k07,k08,k09,k10,k11,+3 more]');
  });

  // Breaks: a string (a model's query, an invalid answer item) is written out
  // instead of measured.
  it('describes anything else by its type, and a string or array by its length', () => {
    expect(valueShapeForLog(null)).toBe('null');
    expect(valueShapeForLog(['SENTINEL', 'x'])).toBe('array(2)');
    expect(valueShapeForLog('SENTINEL')).toBe('string(8 chars)');
    expect(valueShapeForLog('')).toBe('string(0 chars)');
    expect(valueShapeForLog(7)).toBe('number');
    expect(valueShapeForLog(undefined)).toBe('undefined');
  });
});

// Used by the renderer's "empty content from the model" warning, for the
// model's `message` (reasoning_content and a refusal restate the prompt, which
// is mail). Breaks: a field's VALUE is logged instead of its size, a key the
// provider chose (prose, not an identifier) is printed, or a message with
// hundreds of fields lists every one.
describe('fieldSizesForLog', () => {
  it('names each field with its size or type and nothing else', () => {
    expect(fieldSizesForLog({ content: '', reasoning_content: 'SENTINEL', refusal: null, tool_calls: [1, 2], audio: { id: 'SENTINEL' }, n: 3, ok: true }))
      .toEqual({ content: 0, reasoning_content: 8, refusal: 'null', tool_calls: 'array(2)', audio: 'object', n: 'number', ok: 'boolean' });
  });

  it('counts keys that are not identifiers instead of writing them', () => {
    const sizes = fieldSizesForLog({ 'SENTINEL prose key': 'x', 'other key': 1, content: 'abc' });
    expect(sizes).toEqual({ content: 3, '+more': 2 });
    expect(JSON.stringify(sizes)).not.toContain('SENTINEL');
  });

  it('names at most twelve fields, sorted, and counts the rest', () => {
    const many = Object.fromEntries(Array.from({ length: 15 }, (_, i) => [`k${String(14 - i).padStart(2, '0')}`, 'v']));
    const sizes = fieldSizesForLog(many);
    expect(Object.keys(sizes)).toEqual(['k00', 'k01', 'k02', 'k03', 'k04', 'k05', 'k06', 'k07', 'k08', 'k09', 'k10', 'k11', '+more']);
    expect(sizes['+more']).toBe(3);
  });

  // Breaks: a provider that sends no message object (or an array, or text)
  // crashes the warning path or has its text described key by key.
  it('is empty for anything that is not a plain object', () => {
    expect(fieldSizesForLog(undefined)).toEqual({});
    expect(fieldSizesForLog(null)).toEqual({});
    expect(fieldSizesForLog('SENTINEL')).toEqual({});
    expect(fieldSizesForLog(['SENTINEL'])).toEqual({});
    expect(fieldSizesForLog({})).toEqual({});
  });
});
