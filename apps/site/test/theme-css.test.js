// @vitest-environment happy-dom
// Checks the committed theme subset against the page that uses it. The subset
// only carries what THEME_SELECTORS lists, so a class added to render.js without
// a sync would render unstyled — in production, with nothing else noticing.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import postcss from 'postcss';
import { describe, expect, it } from 'vitest';

import { definedClasses, referencedTokens } from '../scripts/theme-subset.mjs';
import { buildDownloadView } from '../src/download-view.js';
import { ARCH, OS } from '../src/platform.js';
import { renderDownloadPage } from '../src/render.js';

import { releaseV122 } from './fixtures.js';

const siteDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readSite = (file) => readFileSync(path.join(siteDir, file), 'utf8');
const theme = postcss.parse(readSite('src/theme.css'));
const styles = postcss.parse(readSite('src/styles.css'));

const rootTokens = new Set(
  theme.nodes
    .filter((node) => node.type === 'rule' && node.selector === ':root')
    .flatMap((rule) => rule.nodes.map((decl) => decl.prop))
);

// A release that reaches GitHub but ships nothing for Linux: the
// "no download for your OS" variant of the unavailable view.
const releaseWithoutLinux = () => ({
  ...releaseV122(),
  assets: releaseV122().assets.filter((asset) => !/AppImage|\.deb$|\.rpm$/.test(asset.name)),
});

// Every view the page can show, so every class render.js can emit is seen.
const PAGES = [
  { os: OS.MAC, arch: ARCH.ARM64, release: releaseV122() },
  { os: OS.WINDOWS, arch: ARCH.X64, release: releaseV122() },
  { os: OS.IOS, arch: ARCH.UNKNOWN, release: releaseV122() },
  { os: OS.UNKNOWN, arch: ARCH.UNKNOWN, release: releaseV122() },
  { os: OS.LINUX, arch: ARCH.X64, release: releaseWithoutLinux() },
  { os: OS.MAC, arch: ARCH.ARM64, release: null },
];

// Classes that only name an element for tests to find, never styled on purpose.
const HOOK_CLASSES = new Set(['release-line']);

const classesIn = (root) =>
  [...root.querySelectorAll('[class]')].flatMap((node) => [...node.classList]);

const renderedClasses = () =>
  PAGES.flatMap(({ os, arch, release }) => {
    const root = document.createElement('div');
    renderDownloadPage(root, buildDownloadView({ platform: { os, arch }, release }), 'en-US');
    // The other-platforms list is only built when opened.
    root.querySelector('button.others-toggle')?.click();
    return classesIn(root);
  });

const indexHtmlClasses = () =>
  classesIn(new DOMParser().parseFromString(readSite('index.html'), 'text/html'));

describe('src/theme.css', () => {
  // Breaks if the page uses a class neither the theme subset nor styles.css defines.
  it('defines every class the page renders', () => {
    const defined = new Set([...definedClasses(theme), ...definedClasses(styles), ...HOOK_CLASSES]);
    const used = new Set([...renderedClasses(), ...indexHtmlClasses()]);
    expect([...used].filter((name) => !defined.has(name))).toEqual([]);
  });

  // Breaks if a token the page reads was left out of the subset: it would render unset.
  it('defines every token the theme and styles.css read', () => {
    const read = new Set([...referencedTokens(theme), ...referencedTokens(styles)]);
    expect([...read].filter((name) => !rootTokens.has(name))).toEqual([]);
  });

  // Breaks if a dark palette creeps back in: the page is light-only by design.
  it('carries no .dark palette', () => {
    expect(definedClasses(theme).has('dark')).toBe(false);
  });

  // Breaks if the full design system gets vendored back into this public repository.
  it('stays a subset, not the whole design system', () => {
    expect(readSite('src/theme.css').length).toBeLessThan(20_000);
  });
});
