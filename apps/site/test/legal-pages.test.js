import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  LEGAL_PAGES,
  fillLegalTemplate,
  legalSourceFor,
  renderLegalMarkdown,
} from '../scripts/legal-pages.mjs';

import { CONSENT_SCREEN } from './consent-screen.js';

// inbox.sarv.com/privacy-policy.html and /terms.html are built from
// docs/legal/*.md, and the privacy policy URL is what Google's reviewers read.
// Breaks if: internal notes (HTML comments) get published, an unfinished
// [CONFIRM] draft looks final or gets indexed, or a page silently renders empty.

const read = (file) => readFileSync(resolve(import.meta.dirname, '../../../docs/legal', file), 'utf8');
const template = (name) => readFileSync(resolve(import.meta.dirname, '..', `${name}.html`), 'utf8');

describe('renderLegalMarkdown', () => {
  it('takes the title from the first heading and renders GitHub-flavoured Markdown', () => {
    const page = renderLegalMarkdown('# Policy\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n**bold**');
    expect(page.title).toBe('Policy');
    expect(page.html).toContain('<table>');
    expect(page.html).toContain('<strong>bold</strong>');
    expect(page.draft).toBe(false);
  });

  // The web-team / developer notes live in HTML comments and must never ship.
  it('strips every HTML comment before rendering', () => {
    const page = renderLegalMarkdown('<!--\nINTERNAL NOTE\n-->\n# T\n\ntext <!-- inline secret --> more');
    expect(page.html).not.toContain('INTERNAL NOTE');
    expect(page.html).not.toContain('inline secret');
    expect(page.html).toContain('text');
    expect(page.html).toContain('more');
  });

  // CodeQL: a single regex pass over nested/overlapping comments could leave a
  // fresh `<!--` in the output. Token-level removal leaves none.
  it('leaves no comment opener behind for nested or overlapping comments', () => {
    const page = renderLegalMarkdown('# T\n\n<!<!-- x -->-- hidden -->\n\na <!-- b <!-- c --> d -->');
    expect(page.html).not.toContain('<!--');
  });

  // Draft state is judged on what is published, not on the internal notes.
  it('ignores a [CONFIRM] that only appears inside a comment', () => {
    expect(renderLegalMarkdown('<!-- items marked [CONFIRM] -->\n# T\n\nDone.').draft).toBe(false);
  });

  it('marks a document with a [CONFIRM] placeholder as a draft, and falls back to a default title', () => {
    const page = renderLegalMarkdown('No heading. Date: [CONFIRM: date]');
    expect(page.draft).toBe(true);
    expect(page.title).toBe('Sarv Inbox');
  });
});

describe('fillLegalTemplate', () => {
  const tpl = '<title><!-- legal:title --></title><!-- legal:robots --><!-- legal:draft --><main><!--legal:body--></main>';

  // A draft must say so and stay out of search results.
  it('adds the draft banner and noindex for a draft', () => {
    const out = fillLegalTemplate(tpl, { title: 'P', html: '<p>x</p>', draft: true });
    expect(out).toContain('<meta name="robots" content="noindex" />');
    expect(out).toContain('class="banner warning"');
    expect(out).toContain('<main><p>x</p></main>');
  });

  // Final text: no banner, indexable, title escaped.
  it('omits both for final text and escapes the title', () => {
    const out = fillLegalTemplate(tpl, { title: 'A & <B>', html: '', draft: false });
    expect(out).toBe('<title>A &amp; &lt;B&gt;</title><main></main>');
  });

  // A typo in a template marker must fail the build, not publish a hole.
  it('throws on an unknown marker', () => {
    expect(() => fillLegalTemplate('<!-- legal:bogus -->', { title: '', html: '', draft: false })).toThrow(
      'Unknown legal page marker: bogus'
    );
  });
});

describe('legalSourceFor', () => {
  it('maps the two page files to their Markdown and nothing else', () => {
    expect(legalSourceFor('privacy-policy.html')).toBe('privacy-policy.md');
    expect(legalSourceFor('terms.html')).toBe('terms-of-service.md');
    expect(legalSourceFor('index.html')).toBeNull();
    expect(legalSourceFor('constructor.html')).toBeNull();
  });
});

describe('the real pages', () => {
  // End to end over the committed files: every marker filled, the notes gone,
  // and the policy carries Google's Limited Use sentence verbatim.
  it.each(Object.entries(LEGAL_PAGES))('%s renders completely from docs/legal/%s', (name, file) => {
    const out = fillLegalTemplate(template(name), renderLegalMarkdown(read(file)));
    expect(out).not.toMatch(/<!--\s*legal:/);
    expect(out).not.toContain('FOR THE WEB TEAM');
    expect(out).not.toContain('DRAFT: not legal advice');
    expect(out).toContain('<h1');
    expect(out).toContain('href="./privacy-policy.html"');
  });

  it('the privacy policy keeps the Limited Use statement', () => {
    const { html } = renderLegalMarkdown(read('privacy-policy.md'));
    expect(html).toContain('including the Limited Use requirements');
  });

  // The consent screen links these pages and Google's review reads them: a
  // [CONFIRM] placeholder would publish them as a noindexed Draft, which fails it.
  it.each(Object.entries(LEGAL_PAGES))('%s is published as final text, not a draft', (name, file) => {
    const page = renderLegalMarkdown(read(file));
    expect(page.draft).toBe(false);
    const out = fillLegalTemplate(template(name), page);
    expect(out).not.toContain('class="banner warning"');
    expect(out).not.toContain('noindex');
  });

  // The terms send readers to the policy Google reviews, at the consent-screen URL.
  it('the terms link the privacy policy at its consent-screen URL', () => {
    const { html } = renderLegalMarkdown(read('terms-of-service.md'));
    expect(html).toContain(`href="${CONSENT_SCREEN.privacyPolicy}"`);
  });
});
