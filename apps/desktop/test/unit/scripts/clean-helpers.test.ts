/*
 * Guards the shared helpers behind `pnpm clean:db` and `pnpm clean:logs`:
 * scripts/lib/userdata-dirs.mjs and scripts/lib/stale-js.mjs.
 *
 * Three regressions are pinned here, all of them shipped bugs:
 *
 *  1. Log rotation was ignored. The file logger renames app.log → app.log.1 at
 *     its size cap, but both clean scripts deleted only "app.log", so a "full
 *     reset" left the older half on disk — observed as 20 MB of app.log.1
 *     surviving a wipe. Mail logs carry addresses, subjects and folder names,
 *     and clean:logs is what people run before attaching a log to a bug report.
 *
 *  2. A locked file aborted the whole clean. rmSync throws EBUSY/EPERM on
 *     Windows when the app still holds a file, and nothing caught it, so the
 *     run died half-way and left userData in a state neither the user nor the
 *     app expected.
 *
 *  3. "Stale JS" deleted every .js. The desktop clean script ran a bare
 *     `find src electron -name '*.js' -delete`, which cannot tell tsc output
 *     from a hand-written file.
 */

import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { cleanStaleJs } from '../../../../../scripts/lib/stale-js.mjs';
import {
  humanSize,
  listLogFiles,
  lockedPaths,
  rmDir,
  rmFile,
} from '../../../../../scripts/lib/userdata-dirs.mjs';

let work: string;

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'clean-helpers-'));
  lockedPaths.length = 0;
});

afterEach(() => {
  try {
    chmodSync(work, 0o700);
  } catch {
    /* already writable */
  }
  rmSync(work, { recursive: true, force: true });
});

const touch = (p: string, body = 'x') => {
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, body);
  return p;
};

describe('listLogFiles — the rotated log must not survive a clean', () => {
  // THE regression: deleting only app.log left app.log.1, the bigger half.
  it('returns app.log AND its rotated siblings', () => {
    touch(join(work, 'app.log'));
    touch(join(work, 'app.log.1'));
    touch(join(work, 'app.log.2'));

    expect(listLogFiles(work).map((p) => basename(p))).toEqual(['app.log', 'app.log.1', 'app.log.2']);
  });

  it('finds the rotated log even when the live one is already gone', () => {
    touch(join(work, 'app.log.1'));
    expect(listLogFiles(work).map((p) => basename(p))).toEqual(['app.log.1']);
  });

  // Over-matching here would delete the mail database, which is the one file in
  // that directory that is expensive to lose.
  it('matches nothing else in the userData directory', () => {
    touch(join(work, 'sarvinbox-core.db'));
    touch(join(work, 'db-key.bin'));
    touch(join(work, 'app.log.old'));
    touch(join(work, 'my-app.log'));
    touch(join(work, 'app.logger.json'));

    expect(listLogFiles(work)).toEqual([]);
  });

  it('returns empty for a directory that does not exist', () => {
    expect(listLogFiles(join(work, 'nope'))).toEqual([]);
  });
});

describe('rmFile / rmDir — a file the app still holds must not abort the run', () => {
  it('reports success for a file it removed, false for one that was not there', () => {
    const p = touch(join(work, 'gone.db'));
    expect(rmFile(p)).toBe(true);
    expect(rmFile(p)).toBe(false);
    expect(lockedPaths).toEqual([]);
  });

  it('removes a directory tree', () => {
    mkdirSync(join(work, 'cache', 'inner'), { recursive: true });
    touch(join(work, 'cache', 'inner', 'blob'));
    expect(rmDir(join(work, 'cache'))).toBe(true);
    expect(rmDir(join(work, 'cache'))).toBe(false);
  });

  // Stands in for Windows EBUSY: a read-only parent directory makes unlink fail
  // with EPERM/EACCES. Before the fix this threw out of main() and the cleanup
  // stopped dead, half-done.
  it('records an undeletable file instead of throwing, so the clean continues', () => {
    const locked = join(work, 'locked');
    mkdirSync(locked);
    const victim = touch(join(locked, 'app.log'));
    const survivor = touch(join(work, 'other.db'));
    chmodSync(locked, 0o500); // r-x: cannot unlink children

    expect(() => rmFile(victim)).not.toThrow();
    expect(lockedPaths).toContain(victim);

    // The important half: everything after the locked file still gets cleaned.
    expect(rmFile(survivor)).toBe(true);

    chmodSync(locked, 0o700);
  });
});

describe('cleanStaleJs — delete build output, not hand-written JS', () => {
  it('deletes a .js that has a .ts beside it', () => {
    touch(join(work, 'src', 'main.ts'));
    touch(join(work, 'src', 'main.js'));

    const { removed } = cleanStaleJs([join(work, 'src')]);

    expect(removed.map((p) => basename(p))).toEqual(['main.js']);
    expect(readdirSync(join(work, 'src'))).toEqual(['main.ts']);
  });

  // THE regression: `find … -name '*.js' -delete` ate this file.
  it('KEEPS a .js with no TypeScript source — the bug the find one-liner had', () => {
    touch(join(work, 'src', 'shim.js'));

    const { removed } = cleanStaleJs([join(work, 'src')]);

    expect(removed).toEqual([]);
    expect(readdirSync(join(work, 'src'))).toEqual(['shim.js']);
  });

  it('treats .tsx as a source too', () => {
    touch(join(work, 'src', 'App.tsx'));
    touch(join(work, 'src', 'App.js'));

    expect(cleanStaleJs([join(work, 'src')]).removed).toHaveLength(1);
  });

  it('recurses, and never descends into node_modules or build output', () => {
    touch(join(work, 'src', 'deep', 'nested', 'a.ts'));
    touch(join(work, 'src', 'deep', 'nested', 'a.js'));
    touch(join(work, 'src', 'node_modules', 'dep', 'b.ts'));
    touch(join(work, 'src', 'node_modules', 'dep', 'b.js'));
    touch(join(work, 'src', 'dist', 'c.ts'));
    touch(join(work, 'src', 'dist', 'c.js'));

    const { removed } = cleanStaleJs([join(work, 'src')]);

    expect(removed.map((p) => basename(p))).toEqual(['a.js']);
    expect(readdirSync(join(work, 'src', 'node_modules', 'dep')).sort()).toEqual(['b.js', 'b.ts']);
    expect(readdirSync(join(work, 'src', 'dist')).sort()).toEqual(['c.js', 'c.ts']);
  });

  it('skips roots that do not exist rather than throwing', () => {
    expect(() => cleanStaleJs([join(work, 'absent'), join(work, 'also-absent')])).not.toThrow();
    expect(cleanStaleJs([join(work, 'absent')]).removed).toEqual([]);
  });

  it('accepts several roots in one pass', () => {
    touch(join(work, 'src', 'a.ts'));
    touch(join(work, 'src', 'a.js'));
    touch(join(work, 'electron', 'b.ts'));
    touch(join(work, 'electron', 'b.js'));

    const { removed } = cleanStaleJs([join(work, 'src'), join(work, 'electron')]);
    expect(removed.map((p) => basename(p)).sort()).toEqual(['a.js', 'b.js']);
  });
});

describe('humanSize', () => {
  it('reports bytes below 1 KiB and scales up from there', () => {
    expect(humanSize(0)).toBe('0 B');
    expect(humanSize(999)).toBe('999 B');
    expect(humanSize(1024)).toBe('1.0 KB');
    expect(humanSize(20 * 1024 * 1024)).toBe('20.0 MB');
  });
});
