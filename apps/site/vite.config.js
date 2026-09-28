import { readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';

import { defineConfig } from 'vite';

import { fillLegalTemplate, legalSourceFor, renderLegalMarkdown } from './scripts/legal-pages.mjs';

const LEGAL_DIR = resolve(import.meta.dirname, '../../docs/legal');

// Renders docs/legal/*.md into privacy-policy.html and terms.html, in dev and
// build alike, so the published pages are always the committed Markdown.
const legalPages = () => ({
  name: 'sarvinbox-legal-pages',
  transformIndexHtml: {
    order: 'pre',
    handler(html, ctx) {
      const source = legalSourceFor(basename(ctx.filename));
      if (!source) return html;
      return fillLegalTemplate(html, renderLegalMarkdown(readFileSync(resolve(LEGAL_DIR, source), 'utf8')));
    },
  },
});

export default defineConfig({
  // Relative asset URLs: GitHub Pages serves a project site under /Inbox/, and
  // a custom domain serves it at /. Relative paths work under both.
  base: './',
  plugins: [legalPages()],
  build: {
    rollupOptions: {
      input: {
        index: resolve(import.meta.dirname, 'index.html'),
        'privacy-policy': resolve(import.meta.dirname, 'privacy-policy.html'),
        terms: resolve(import.meta.dirname, 'terms.html'),
      },
    },
  },
  server: {
    // main.js imports the app icon from ../desktop/public rather than keeping a
    // second copy of it.
    fs: { allow: ['..'] },
  },
  test: {
    environment: 'node',
    // Same as every other suite in the repo (see the root vitest.config.ts).
    pool: 'forks',
    include: ['test/**/*.test.js'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.js', 'scripts/theme-subset.mjs', 'scripts/legal-pages.mjs'],
    },
  },
});
