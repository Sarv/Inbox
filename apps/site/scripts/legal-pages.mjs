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
import { Marked } from 'marked';

/** Page name (URL path, HTML file) → source file in docs/legal/. */
export const LEGAL_PAGES = {
  'privacy-policy': 'privacy-policy.md',
  terms: 'terms-of-service.md',
};

const MARKER = /<!--\s*legal:(\w+)\s*-->/g;

// HTML comments hold notes for the web team and developers — never publish
// them. Dropped at the token level (marked has already parsed where a comment
// starts and ends), not with a regex over the text: a single-pass pattern can
// leave a new `<!--` behind when comments are nested or overlap.
const isComment = (html) => html.trimStart().startsWith('<!--');
const markdown = new Marked({
  gfm: true,
  renderer: {
    html({ text }) {
      return isComment(text) ? '' : text;
    },
  },
});

/** Title, HTML body and draft state of one legal Markdown document. */
export function renderLegalMarkdown(source) {
  const tokens = markdown.lexer(source);
  const heading = tokens.find((t) => t.type === 'heading' && t.depth === 1);
  const html = markdown.parser(tokens);
  return {
    title: heading?.text.trim() || 'Sarv Inbox',
    html,
    // Judged on what is published, so a [CONFIRM] inside a comment doesn't count.
    draft: html.includes('[CONFIRM'),
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
