/**
 * Guards how renderer code points at files in `apps/desktop/public/`.
 *
 * The packaged app loads `index.html` with `loadFile`, so the page lives at
 * `file:///…/app.asar/dist/index.html`. A root-absolute `src="/icon.png"`
 * then resolves to `file:///icon.png` — the filesystem root — and the image
 * is broken. In dev the same path works because Vite serves `public/` at `/`,
 * so the bug is invisible until a release ships (it did: every provider logo
 * and the onboarding app icon rendered as a broken image in 1.3.4). Public
 * assets must be referenced relative to the page, as `./icon.png`.
 */

import { readdirSync, readFileSync } from 'fs';
import { join, relative } from 'path';

import { describe, expect, it } from 'vitest';

const DESKTOP_ROOT = join(__dirname, '../..');
const PUBLIC_DIR = join(DESKTOP_ROOT, 'public');
const SRC_DIR = join(DESKTOP_ROOT, 'src');

const publicTopLevelNames = readdirSync(PUBLIC_DIR);

const rendererSourceFiles = () =>
  readdirSync(SRC_DIR, { recursive: true, encoding: 'utf-8' })
    .filter((file) => /\.(ts|tsx)$/.test(file) && !/\.test\.tsx?$/.test(file))
    .map((file) => join(SRC_DIR, file));

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A quote or backtick immediately followed by `/<public entry>` — a root-absolute public path. */
const rootAbsolutePublicPath = new RegExp(
  `[\`'"]/(${publicTopLevelNames.map(escapeRegExp).join('|')})(?=[/\`'"])`,
);

const findRootAbsolutePublicPaths = (files: string[]) =>
  files.flatMap((file) =>
    readFileSync(file, 'utf-8')
      .split('\n')
      .flatMap((line, index) =>
        rootAbsolutePublicPath.test(line) ? [`${relative(DESKTOP_ROOT, file)}:${index + 1}: ${line.trim()}`] : [],
      ),
  );

describe('public asset paths in renderer code', () => {
  // Sanity: if public/ were empty or moved, the guard below would pass vacuously.
  it('finds the public assets it is guarding', () => {
    expect(publicTopLevelNames).toEqual(expect.arrayContaining(['icon.png', 'provider-icons']));
  });

  // If this fails, an image works in `pnpm dev:desktop` but is broken in the
  // packaged app, where `/x.png` resolves to the filesystem root. Use `./x.png`.
  it('never references a public asset by a root-absolute path', () => {
    expect(findRootAbsolutePublicPaths(rendererSourceFiles())).toEqual([]);
  });

  // Proves the pattern actually catches the shapes that shipped broken, so a
  // regex mistake cannot turn the guard above into a no-op.
  it('detects the root-absolute forms and accepts the relative ones', () => {
    expect(rootAbsolutePublicPath.test('<img src="/icon.png" />')).toBe(true);
    expect(rootAbsolutePublicPath.test('src={`/provider-icons/${asset}`}')).toBe(true);
    expect(rootAbsolutePublicPath.test('<img src="./icon.png" />')).toBe(false);
    expect(rootAbsolutePublicPath.test('src={`./provider-icons/${asset}`}')).toBe(false);
  });
});
