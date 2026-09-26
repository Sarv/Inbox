// Regenerates src/theme.css: the part of sarv_theme the download page uses.
//
// Why generated: GitHub Pages builds this site in CI, which cannot reach the
// private sarv_theme repository, and this public repository should carry only
// the few rules one page needs — not the whole design system. The output is
// never edited by hand: change sarv_theme (or THEME_SELECTORS), then run
// `pnpm --filter @sarvinbox/site sync-theme`.
//
// Usage: node scripts/sync-theme.mjs [path-to-sarv_theme]
// Default path: the sibling checkout at ../../../../sarv_theme from this repo.
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildThemeSubset } from './theme-subset.mjs';

const siteDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const themeDir = path.resolve(
  process.argv[2] ?? path.join(siteDir, '..', '..', '..', '..', 'sarv_theme')
);
const outputFile = path.join(siteDir, 'src', 'theme.css');

try {
  const [designSystemCss, fontsCss, pageCss] = await Promise.all([
    readFile(path.join(themeDir, 'design-system.css'), 'utf8'),
    readFile(path.join(themeDir, 'fonts.css'), 'utf8'),
    readFile(path.join(siteDir, 'src', 'styles.css'), 'utf8'),
  ]);
  const subset = buildThemeSubset({ designSystemCss, fontsCss, pageCss });
  await writeFile(outputFile, subset);
  process.stdout.write(
    `Wrote ${path.relative(siteDir, outputFile)} (${subset.length} bytes) from ${themeDir}\n`
  );
} catch (error) {
  process.stderr.write(`sync-theme failed: ${error.message}\n`);
  process.exit(1);
}
