import { mkdirSync, mkdtempSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  listModuleFiles,
  MAX_MODULE_BYTES,
  readModuleFile,
  wrapModuleSource,
} from '../../../../electron/services/extension-sandbox-files';

/**
 * The only file access a confined extension has: its own code, read for it by main.
 * A bug in the listing is a way to read any file on the disk.
 */

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sarv-files-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Run a served module the way the Worker's loader would, and hand back its exports. */
function run(served: string, relativePath: string): Record<string, unknown> {
  let factory: ((...args: unknown[]) => void) | undefined;
  const scope = {
    __sarvDefineModule: (path: string, fn: (...args: unknown[]) => void) => {
      expect(path).toBe(relativePath);
      factory = fn;
    },
  };
  new Function('globalThis', served)(scope);
  const module = { exports: {} as Record<string, unknown> };
  factory?.(module.exports, () => undefined, module, '/f', '/d');
  return module.exports;
}

describe('listModuleFiles', () => {
  // Breaks every multi-file extension if it stops finding them, and every platform's
  // path separator has to come out as `/`: that is what the Worker asks for.
  it('finds code files at any depth, with forward slashes', async () => {
    mkdirSync(join(root, 'dist', 'lib'), { recursive: true });
    writeFileSync(join(root, 'dist', 'index.js'), '');
    writeFileSync(join(root, 'dist', 'lib', 'a.cjs'), '');
    writeFileSync(join(root, 'dist', 'lib', 'b.JSON'), '');

    expect(await listModuleFiles(root)).toEqual(['dist/index.js', 'dist/lib/a.cjs', 'dist/lib/b.JSON']);
  });

  // A Worker has no reason to load a README, or a private key that sits in the folder.
  it('leaves out anything that is not code', async () => {
    writeFileSync(join(root, 'README.md'), '');
    writeFileSync(join(root, 'id_rsa'), '');
    writeFileSync(join(root, 'icon.svg'), '');
    writeFileSync(join(root, 'index.mjs'), '');
    writeFileSync(join(root, 'index.js'), '');

    expect(await listModuleFiles(root)).toEqual(['index.js']);
  });

  // The hole this exists to close: a link inside the folder is a path to the rest of
  // the disk. It must not be listed whatever its name, and a linked folder not entered.
  it('follows no symbolic link, to a file or a folder', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'sarv-outside-'));
    writeFileSync(join(outside, 'secret.js'), 'SECRET');
    writeFileSync(join(root, 'index.js'), '');
    symlinkSync(join(outside, 'secret.js'), join(root, 'notes.js'));
    symlinkSync(outside, join(root, 'more'));

    expect(await listModuleFiles(root)).toEqual(['index.js']);
    rmSync(outside, { recursive: true, force: true });
  });

  // A folder of a million files must not become a million-entry list in main.
  it('refuses an absurd number of files', async () => {
    mkdirSync(join(root, 'many'));
    for (let i = 0; i < 5_002; i += 1) writeFileSync(join(root, 'many', `${i}.js`), '');

    await expect(listModuleFiles(root)).rejects.toThrow('more than 5000 code files');
  });

  // A folder that cannot be read has to fail, not read as an extension with no code.
  it('fails on a folder that does not exist', async () => {
    await expect(listModuleFiles(join(root, 'nope'))).rejects.toThrow();
  });
});

describe('wrapModuleSource', () => {
  // The contract with the Worker's loader: exports, require and module are parameters.
  it('runs the source as a CommonJS module body', () => {
    expect(run(wrapModuleSource('a.js', 'exports.value = 1 + 1;'), 'a.js')).toEqual({ value: 2 });
  });

  // Two files each declaring `const x` would collide as top-level scripts. That the
  // wrapper is a function is the whole fix.
  it('keeps a top-level const inside the module', () => {
    const served = wrapModuleSource('a.js', 'const shared = 1; exports.value = shared;');
    expect(run(served, 'a.js')).toEqual({ value: 1 });
    expect(run(served, 'a.js')).toEqual({ value: 1 });
  });

  // `'use strict'` has to stay a directive: a sloppy-mode module behaves differently.
  it('keeps a strict directive in effect', () => {
    const served = wrapModuleSource('a.js', "'use strict';\nexports.strict = (function () { return this === undefined; })();");
    expect(run(served, 'a.js')).toEqual({ strict: true });
  });

  // A trailing `//# sourceMappingURL=` comment would swallow a closing bracket on the
  // same line, and every bundler writes one.
  it('survives a trailing line comment', () => {
    expect(run(wrapModuleSource('a.js', 'exports.v = 1;\n//# sourceMappingURL=a.js.map'), 'a.js')).toEqual({ v: 1 });
  });

  // Legal only on a script's first line, which this no longer is.
  it('survives a shebang', () => {
    expect(run(wrapModuleSource('a.js', '#!/usr/bin/env node\nexports.v = 1;'), 'a.js')).toEqual({ v: 1 });
  });

  // Stack traces point at the author's own lines.
  it('keeps the first line of the source on the first line', () => {
    expect(wrapModuleSource('a.js', 'first();\nsecond();').split('\n')[1]).toBe('second();');
  });

  it('turns JSON into a module exporting it', () => {
    expect(run(wrapModuleSource('d.json', '{"a":[1,2]}'), 'd.json')).toEqual({ a: [1, 2] });
  });

  // Only real JSON reaches the script parser, so a file named .json is not a way to
  // run code past the listing, and a broken one fails when required, with its name.
  it('fails a broken JSON file when required, naming it', () => {
    const served = wrapModuleSource('d.json', '{"a":');
    expect(() => run(served, 'd.json')).toThrow('Invalid JSON in d.json');
  });

  it('does not let a JSON file carry code', () => {
    const served = wrapModuleSource('d.json', '1;globalThis.ran=true');
    expect(() => run(served, 'd.json')).toThrow('Invalid JSON');
  });

  // The path goes into source text: it is quoted, not pasted.
  it('quotes a file name that could break out of the wrapper', () => {
    const name = 'a"+evil()+".js';
    expect(run(wrapModuleSource(name, 'exports.v = 1;'), name)).toEqual({ v: 1 });
  });
});

describe('readModuleFile', () => {
  // Between the listing and the read a file can have been replaced by a link.
  it('reads a real file and refuses a link that replaced it', async () => {
    writeFileSync(join(root, 'a.js'), 'source');
    expect(await readModuleFile(root, 'a.js')).toBe('source');

    const outside = join(root, 'outside.js');
    writeFileSync(outside, 'SECRET');
    rmSync(join(root, 'a.js'));
    symlinkSync(outside, join(root, 'a.js'));
    expect(await readModuleFile(root, 'a.js')).toBeNull();
  });

  // A file swollen after install must not be read whole into the main process.
  it('refuses a file over the size limit', async () => {
    writeFileSync(join(root, 'big.js'), '');
    truncateSync(join(root, 'big.js'), MAX_MODULE_BYTES + 1);
    expect(await readModuleFile(root, 'big.js')).toBeNull();
  });

  it('reads through nested folders', async () => {
    mkdirSync(join(root, 'lib'));
    writeFileSync(join(root, 'lib', 'a.js'), 'nested');
    expect(await readModuleFile(root, 'lib/a.js')).toBe('nested');
  });

  it('rejects for a file that has gone', async () => {
    await expect(readModuleFile(root, 'gone.js')).rejects.toThrow();
  });
});
