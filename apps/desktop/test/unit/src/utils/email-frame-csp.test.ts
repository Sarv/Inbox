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

/** The document starts with the policy, after at most a doctype. */
const startsWithPolicy = (doc: string, csp = BLOCKING) => {
  const doctype = /^\s*<!doctype[^>]*>/i.exec(doc)?.[0] ?? '';
  return doc.slice(doctype.length).startsWith(csp);
};

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
