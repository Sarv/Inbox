import { parse, type DefaultTreeAdapterMap } from 'parse5';
import { describe, expect, it } from 'vitest';

import { buildSrcdoc } from '../../../../src/components/SandboxedEmailBody';
import { emailFrameCsp, withLeadingCsp } from '../../../../src/utils/email-frame-csp';

// The email frame's Content-Security-Policy must come before every byte of the
// email (CASA M-4). It used to be spliced in at the email's own </head>, so an
// email could lose it — and with no policy the frame fell back to the app's,
// which allows https: images: the tracking pixel fired without "Load images".
// What breaks if this fails: a crafted email reports when and where it was read.

const BLOCKING = emailFrameCsp(false);
const PIXEL = '<img src="https://tracker.example/p.gif">';

type Node = DefaultTreeAdapterMap['childNode'] | DefaultTreeAdapterMap['document'];
const children = (node: Node): Node[] => ('childNodes' in node ? (node.childNodes as Node[]) : []);
const find = (node: Node, test: (n: Node) => boolean): Node | null =>
  test(node) ? node : children(node).reduce<Node | null>((hit, child) => hit ?? find(child, test), null);
const attr = (node: Node, name: string) => ('attrs' in node ? node.attrs.find((a) => a.name === name)?.value : undefined);

/**
 * Where a browser's parser really puts the policy (parse5 implements the HTML
 * spec's tree construction, as Chromium does). It only takes effect as an
 * element of <head>, and only over what comes after it, so it must be the
 * FIRST element there, with the expected content, and the only policy.
 * Checked by parsing, not by a regex: the regex the code used is what let an
 * email push the policy into <body>.
 */
const startsWithPolicy = (doc: string, csp = BLOCKING) => {
  const tree = parse(doc);
  const head = find(tree, (n) => n.nodeName === 'head');
  const firstInHead = head ? children(head).find((n) => n.nodeName !== '#text' && n.nodeName !== '#comment') : undefined;
  const policies: Node[] = [];
  find(tree, (n) => { if (attr(n, 'http-equiv')?.toLowerCase() === 'content-security-policy') policies.push(n); return false; });
  const expected = /content="([^"]*)"/.exec(csp)![1];
  return policies.length === 1 && firstInHead === policies[0] && attr(policies[0], 'content') === expected;
};

/** Leading characters JavaScript counts as whitespace but HTML reads as text. */
const NOT_HTML_WHITESPACE: Array<[string, string]> = [
  ['U+00A0', '\u00a0'], ['U+3000', '\u3000'], ['VT', '\v'], ['U+2028', '\u2028'], ['U+1680', '\u1680'],
  ['U+2009', '\u2009'], ['U+202F', '\u202f'], ['two BOMs', '\ufeff\ufeff'], ['three BOMs', '\ufeff\ufeff\ufeff'],
];

describe('emailFrameCsp', () => {
  it('blocks every remote fetch, and remote images unless allowed', () => {
    expect(BLOCKING).toContain("default-src 'none'; img-src data: blob:;");
    expect(emailFrameCsp(true)).toContain('img-src data: blob: https: http:;');
  });
});

describe('withLeadingCsp', () => {
  it('puts the policy before all content', () => {
    expect(withLeadingCsp(`<p>${PIXEL}</p>`, false)).toBe(`${BLOCKING}<p>${PIXEL}</p>`);
  });

  // The document must parse exactly as the email wrote it; a <meta> ahead of
  // a doctype would force quirks mode anywhere but a srcdoc frame.
  it('keeps a leading doctype first, and drops a BOM', () => {
    expect(withLeadingCsp('﻿  <!DOCTYPE html PUBLIC "x"><html>', false)).toBe(`  <!DOCTYPE html PUBLIC "x">${BLOCKING}<html>`);
  });

  // A doctype is hoisted past HTML whitespace only. Breaks if it is hoisted
  // past a character the parser reads as text: the policy lands in <body>,
  // Chromium ignores it, and the tracking pixel loads (CASA M-4).
  it.each(NOT_HTML_WHITESPACE)('keeps the policy in <head> when %s comes before the doctype', (_label, lead) => {
    const doc = withLeadingCsp(`${lead}<!DOCTYPE html><html><head></head><body>${PIXEL}</body></html>`, false);
    expect(startsWithPolicy(doc)).toBe(true);
  });

  // A doctype that isn't leading is the email's content, not ours to hoist.
  it('does not hoist a doctype that comes after other content', () => {
    expect(withLeadingCsp('<p>a</p><!DOCTYPE html>', false)).toBe(`${BLOCKING}<p>a</p><!DOCTYPE html>`);
  });

  it('adds extra head content right after the policy', () => {
    expect(withLeadingCsp('<p>x</p>', true, '<style>t</style>')).toBe(`${emailFrameCsp(true)}<style>t</style><p>x</p>`);
  });
});

describe('buildSrcdoc — the policy survives hostile structure', () => {
  // Each of these used to produce a document with NO policy.
  it.each([
    ['<head> with no </head>', `<html><head><title>x</title><body>${PIXEL}</body></html>`],
    ['a </head> inside a comment', `<html><head><!-- </head> --><title>x</title></head><body>${PIXEL}</body></html>`],
    ['<html inside an attribute', `<p title="<html>">${PIXEL}</p>`],
    ['a doctype then <head> with no </head>', `<!DOCTYPE html><html><head><body>${PIXEL}`],
    ...NOT_HTML_WHITESPACE.map(([label, lead]): [string, string] => [`${label} before a doctype`, `${lead}<!DOCTYPE html><html><body>${PIXEL}</body></html>`]),
    ['U+00A0 before a doctype and a real <head>', `\u00a0<!DOCTYPE html><html><head><title>x</title></head><body>${PIXEL}</body></html>`],
  ])('keeps the policy first for %s', (_label, email) => {
    const doc = buildSrcdoc(email, 'THEME', false, false);
    expect(startsWithPolicy(doc)).toBe(true);
    expect(doc).toContain('<style data-sarv-theme>THEME</style>');
  });

  // Ordinary mail renders exactly as before: the theme still lands in <head>.
  it.each([
    ['a full document', `<!DOCTYPE html><html><head><title>x</title></head><body>${PIXEL}</body></html>`],
    ['a <body>-only document', `<body>${PIXEL}</body>`],
    ['a fragment', `<p>Hello</p>${PIXEL}`],
    ['an <html> with no <head>', `<html><body>${PIXEL}</body></html>`],
  ])('keeps the policy first for %s, with the theme in <head>', (_label, email) => {
    const doc = buildSrcdoc(email, 'THEME', false, false);
    expect(startsWithPolicy(doc)).toBe(true);
    expect(doc).toMatch(/<style data-sarv-theme>THEME<\/style><\/head>/);
    expect(doc.match(/Content-Security-Policy/g)).toHaveLength(1);
  });

  it('keeps the email doctype first, so standards/quirks mode is unchanged', () => {
    expect(buildSrcdoc('<!DOCTYPE html><html><head></head><body>x</body></html>', '', false, false).startsWith('<!DOCTYPE html>')).toBe(true);
    // No doctype in the email (quirks) stays without one.
    expect(buildSrcdoc('<html><head></head><body>x</body></html>', '', false, false).startsWith(BLOCKING)).toBe(true);
  });

  // "Load images" — the one way remote images are allowed.
  it('allows remote images only when asked', () => {
    expect(startsWithPolicy(buildSrcdoc(`<p>${PIXEL}</p>`, '', false, true), emailFrameCsp(true))).toBe(true);
  });
});
