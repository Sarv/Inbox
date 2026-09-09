import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  LINKED_PACKAGES,
  linkedDepsToExclude,
  linkedDepsToWatch,
} from '../../../vite/linked-packages';

describe('linkedDepsToExclude', () => {
  // Regression: a linked package left in the esbuild pre-bundle is served from
  // node_modules/.vite until that cache key changes, which rebuilding the
  // source package does not reliably do — the app renders the previous build
  // with no error to explain why the fix "did not work".
  it('names every linked package so none is pre-bundled', () => {
    expect(linkedDepsToExclude()).toEqual([...LINKED_PACKAGES]);
  });

  // Regression: Vite mutates the config object it is handed. Returning the
  // shared constant itself would let it edit the list the watch helper reads.
  it('returns a fresh array, not the shared constant', () => {
    expect(linkedDepsToExclude()).not.toBe(LINKED_PACKAGES);
    expect(linkedDepsToExclude()).not.toBe(linkedDepsToExclude());
  });
});

describe('linkedDepsToWatch', () => {
  // Regression: this MUST be a negation. Without the leading `!` the pattern
  // reads as "also ignore", which is the very state we are trying to escape —
  // and it would fail silently, because an over-ignored watcher looks exactly
  // like a watcher that simply saw no changes.
  it('negates the blanket node_modules skip for each package', () => {
    expect(linkedDepsToWatch(['pkg-a'])).toEqual(['!**/node_modules/pkg-a/**']);
  });

  // Regression: the two helpers must cover the same packages. Excluding a
  // package from pre-bundling without watching it still serves stale files;
  // watching it without excluding it still serves a stale pre-bundle. Only
  // both together make a library rebuild reach the browser.
  it('covers exactly the packages the exclude list covers', () => {
    const watched = linkedDepsToWatch().map((pattern) =>
      pattern.replace('!**/node_modules/', '').replace('/**', ''),
    );
    expect(watched).toEqual(linkedDepsToExclude());
  });

  it('handles several linked packages', () => {
    expect(linkedDepsToWatch(['pkg-a', 'pkg-b'])).toEqual([
      '!**/node_modules/pkg-a/**',
      '!**/node_modules/pkg-b/**',
    ]);
  });

  // A repo with nothing linked must not emit a stray pattern: an `ignored`
  // array of one meaningless entry is harder to debug than an empty one.
  it('emits nothing when no package is linked', () => {
    expect(linkedDepsToWatch([])).toEqual([]);
    expect(linkedDepsToExclude([])).toEqual([]);
  });
});

describe('LINKED_PACKAGES', () => {
  // Regression: this list and the `file:` deps in package.json must agree, and
  // nothing but a test can keep them that way — both directions fail silently.
  // A `file:` dep missing from the list is served stale, which reads as "my fix
  // did not work". A registry dep left in the list is excluded from the
  // pre-bundle and watched for changes it will never have, which just costs
  // dev-server startup. `@sarv-in/email-chat-view` moved from `file:` to the registry in
  // Sept 2026, which is why the list is empty rather than naming it.
  it('names exactly the dependencies installed by file: path', () => {
    const manifestPath = path.join(fileURLToPath(new URL('.', import.meta.url)), '../../../package.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const fileLinked = Object.entries({ ...manifest.dependencies, ...manifest.devDependencies })
      .filter(([, range]) => range.startsWith('file:'))
      .map(([name]) => name);

    expect([...LINKED_PACKAGES].sort()).toEqual(fileLinked.sort());
  });
});
