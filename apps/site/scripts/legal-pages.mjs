// Build-time rendering of the legal pages from docs/legal/*.md.
//
// The Markdown in docs/legal/ is the single source (it sits next to the code it
// describes, and the privacy policy must change in the same commit as any data
// flow). This turns it into the static HTML served at inbox.sarv.com, using
// `marked` — the Markdown is our own, trusted repository content.
//
// A page that still carries a `[CONFIRM: …]` placeholder is published as a
// visibly marked DRAFT and kept out of search indexes: Google's reviewers read
// the linked policy, and a placeholder must never look like the final text.
import { marked } from 'marked';

/** Page name (URL path, HTML file) → source file in docs/legal/. */
export const LEGAL_PAGES = {
  'privacy-policy': 'privacy-policy.md',
  terms: 'terms-of-service.md',
};

const MARKER = /<!--\s*legal:(\w+)\s*-->/g;

/** Title, HTML body and draft state of one legal Markdown document. */
export function renderLegalMarkdown(markdown) {
  // HTML comments hold notes for the web team and developers — never publish them.
  const source = markdown.replace(/<!--[\s\S]*?-->/g, '').trim();
  const title = source.match(/^#\s+(.+)$/m)?.[1].trim() ?? 'Sarv Inbox';
  return {
    title,
    html: marked.parse(source, { gfm: true }),
    draft: source.includes('[CONFIRM'),
  };
}

const escapeHtml = (text) =>
  text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

const DRAFT_BANNER =
  '<div class="banner warning" role="note"><strong>Draft.</strong> This document is not yet in effect: ' +
  'parts marked [CONFIRM] are still being finalised.</div>';

/** Fill a legal page template's `<!-- legal:… -->` markers. Unknown markers are an error. */
export function fillLegalTemplate(template, page) {
  const values = {
    title: escapeHtml(page.title),
    robots: page.draft ? '<meta name="robots" content="noindex" />' : '',
    draft: page.draft ? DRAFT_BANNER : '',
    body: page.html,
  };
  return template.replace(MARKER, (_, key) => {
    if (!(key in values)) throw new Error(`Unknown legal page marker: ${key}`);
    return values[key];
  });
}

/** The docs/legal source for an HTML file name, or null if it isn't a legal page. */
export function legalSourceFor(fileName) {
  const name = fileName.replace(/\.html$/, '');
  return Object.prototype.hasOwnProperty.call(LEGAL_PAGES, name) ? LEGAL_PAGES[name] : null;
}
