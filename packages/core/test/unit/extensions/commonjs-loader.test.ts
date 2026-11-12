/**
 * `require` inside the sandbox. Everything here runs where there is no Node: if it
 * resolves wrongly, an extension that worked under the old runtime fails on load
 * for a reason that has nothing to do with what it does.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  createCommonJsLoader,
  type CommonJsFactory,
} from '../../../src/extensions/runtime/commonjs-loader';

/** A loader over files given as factories, loaded the way `importScripts` would run them. */
function loaderOver(sources: Record<string, CommonJsFactory>) {
  const loadFile = vi.fn((relativePath: string) => {
    loader.define(relativePath, sources[relativePath]);
  });
  const loader = createCommonJsLoader({ files: Object.keys(sources), loadFile });
  return { loader, loadFile };
}

describe('CommonJS loader', () => {
  // The ordinary case: a no-build extension splits itself into files and requires
  // them by relative path. Breaks every multi-file extension if it fails.
  it('loads a file and what it requires, relative to the requiring file', () => {
    const { loader } = loaderOver({
      'dist/index.js': (exports, require) => {
        (exports as Record<string, unknown>).sum = (require('./lib/add') as { add: () => number }).add();
      },
      'dist/lib/add.js': (exports, require) => {
        (exports as Record<string, unknown>).add = () => (require('../two') as { two: number }).two + 1;
      },
      'dist/two.js': (exports) => {
        (exports as Record<string, unknown>).two = 2;
      },
    });

    expect(loader.load('dist/index.js')).toEqual({ sum: 3 });
  });

  // Node's resolution order, against the host's list: a bundler's output and a
  // hand-written folder use every one of these forms.
  it.each([
    ['./a', 'a'],
    ['./a.js', 'a.js'],
    ['./b', 'b.cjs'],
    ['./c', 'c.json'],
    ['./d', 'd/index.js'],
  ])('resolves %s to %s', (specifier, resolved) => {
    const loaded: string[] = [];
    const file = (name: string): CommonJsFactory => () => {
      loaded.push(name);
    };
    const { loader } = loaderOver({
      'main.js': (_exports, require) => {
        require(specifier);
      },
      'a.js': file('a.js'),
      'b.cjs': file('b.cjs'),
      'c.json': file('c.json'),
      'd/index.js': file('d/index.js'),
    });

    loader.load('main.js');
    expect(loaded).toEqual([specifier === './a' ? 'a.js' : resolved]);
  });

  // `require('..')` from lib/a.js names the extension's own folder, and bundlers write it.
  it.each(['..', '../', '../.'])('resolves %s to the index of the folder above', (specifier) => {
    const { loader } = loaderOver({
      'lib/a.js': (exports, require) => {
        (exports as Record<string, unknown>).up = (require(specifier) as { name: string }).name;
      },
      'index.js': (exports) => {
        (exports as Record<string, unknown>).name = 'root index';
      },
    });

    expect(loader.load('lib/a.js')).toEqual({ up: 'root index' });
  });

  it.each(['.', './'])('resolves %s to the index of its own folder', (specifier) => {
    const { loader } = loaderOver({
      'lib/a.js': (exports, require) => {
        (exports as Record<string, unknown>).here = (require(specifier) as { name: string }).name;
      },
      'lib/index.js': (exports) => {
        (exports as Record<string, unknown>).name = 'lib index';
      },
    });

    expect(loader.load('lib/a.js')).toEqual({ here: 'lib index' });
  });

  /** A loader where package.json files are real JSON modules. */
  function withPackage(main: unknown, files: Record<string, CommonJsFactory>) {
    return loaderOver({
      'dep/package.json': (_exports, _require, module) => {
        module.exports = { main };
      },
      ...files,
    }).loader;
  }

  // A folder carrying its own package.json is how a vendored dependency is laid out.
  it('follows a folder package.json main', () => {
    const loader = withPackage('./lib/entry.js', {
      'main.js': (exports, require) => {
        (exports as Record<string, unknown>).dep = require('./dep');
      },
      'dep/lib/entry.js': (exports) => {
        (exports as Record<string, unknown>).name = 'entry';
      },
    });

    expect(loader.load('main.js')).toEqual({ dep: { name: 'entry' } });
  });

  // Node falls back to index.js when `main` leads nowhere, and so must this.
  it.each([
    ['a missing file', './nope.js'],
    ['not a string', 42],
    ['a climb out of the extension', '../../../../etc/passwd'],
    ['the folder itself', '.'],
  ])('falls back to index.js when main is %s', (_name, main) => {
    const loader = withPackage(main, {
      'main.js': (exports, require) => {
        (exports as Record<string, unknown>).dep = require('./dep');
      },
      'dep/index.js': (exports) => {
        (exports as Record<string, unknown>).name = 'index';
      },
    });

    expect(loader.load('main.js')).toEqual({ dep: { name: 'index' } });
  });

  // A module loads once. Run twice, an extension's top-level state silently splits
  // in two, and each importScripts is a request to main.
  it('runs each file once and caches it', () => {
    const body = vi.fn();
    const { loader, loadFile } = loaderOver({
      'main.js': (_exports, require) => {
        require('./shared');
        require('./shared.js');
      },
      'shared.js': body,
    });

    loader.load('main.js');
    expect(body).toHaveBeenCalledTimes(1);
    expect(loadFile).toHaveBeenCalledTimes(2);
  });

  // A cycle gets the part-built exports, as in Node. Without this, two files that
  // require each other recurse until the stack runs out.
  it('hands back part-built exports during a cycle', () => {
    const { loader } = loaderOver({
      'a.js': (exports, require) => {
        (exports as Record<string, unknown>).early = 'early';
        (exports as Record<string, unknown>).fromB = (require('./b') as { sawEarly: unknown }).sawEarly;
      },
      'b.js': (exports, require) => {
        (exports as Record<string, unknown>).sawEarly = (require('./a') as { early: unknown }).early;
      },
    });

    expect(loader.load('a.js')).toEqual({ early: 'early', fromB: 'early' });
  });

  // `module.exports = ...` is how half of all CommonJS exports. Missing it, an
  // extension exporting that way has no `activate`.
  it('honours a reassigned module.exports', () => {
    const { loader } = loaderOver({
      'main.js': (_exports, _require, module) => {
        module.exports = { activate: 'yes' };
      },
    });

    expect(loader.load('main.js')).toEqual({ activate: 'yes' });
  });

  // Node forgets a module whose top level threw. Remembering it would hand a
  // half-initialised object to the retry instead of the same error.
  it('forgets a module whose top level threw, so a retry runs it again', () => {
    let attempts = 0;
    const { loader } = loaderOver({
      'main.js': () => {
        attempts += 1;
        throw new Error('first time');
      },
    });

    expect(() => loader.load('main.js')).toThrow('first time');
    expect(() => loader.load('main.js')).toThrow('first time');
    expect(attempts).toBe(2);
  });

  // The extension sees a path shaped like a path, and never a real one: the real
  // one names the user's home directory.
  it('gives a module a virtual filename and dirname', () => {
    let seen: string[] = [];
    const { loader } = loaderOver({
      'dist/index.js': (_exports, _require, _module, filename, dirname) => {
        seen = [filename, dirname];
      },
    });

    loader.load('dist/index.js');
    expect(seen).toEqual(['/extension/dist/index.js', '/extension/dist']);
  });

  // The escape this is here for: a relative path climbing out of the extension's
  // folder must not reach the host at all, not even as a request it then refuses.
  it('refuses to climb out of the extension folder, without loading anything', () => {
    const { loader, loadFile } = loaderOver({
      'main.js': (_exports, require) => {
        require('../../../etc/passwd');
      },
    });

    expect(() => loader.load('main.js')).toThrow("Cannot find module '../../../etc/passwd'");
    expect(loadFile).toHaveBeenCalledTimes(1);
  });

  // Climbing past the top is not the same as staying at the top. Read that way, a
  // `../config` written for another layout would quietly load the wrong file.
  it('does not read a climb past the top as a path from the top', () => {
    const { loader } = loaderOver({
      'main.js': (_exports, require) => {
        require('../other.js');
      },
      'other.js': () => undefined,
    });

    expect(() => loader.load('main.js')).toThrow("Cannot find module '../other.js'");
  });

  // Only what the host listed can be loaded. A path it did not find while walking
  // the folder is not a thing to try.
  it('refuses a file the host did not list, without asking the host', () => {
    const { loader, loadFile } = loaderOver({ 'main.js': () => undefined });

    expect(() => loader.load('secrets.js')).toThrow("Cannot find module 'secrets.js'");
    expect(loadFile).not.toHaveBeenCalled();
  });

  // Every way of naming a Node module gets the sentence that names it: this is what
  // a user with an old extension reads in Settings.
  it.each(['fs', 'node:fs', 'fs/promises', 'child_process', 'electron', 'node:sqlite'])(
    'refuses %s by name',
    (specifier) => {
      const { loader } = loaderOver({
        'main.js': (_exports, require) => {
          require(specifier);
        },
      });

      let thrown: Error | undefined;
      try {
        loader.load('main.js');
      } catch (error) {
        thrown = error as Error;
      }
      expect(thrown?.name).toBe('UnsupportedNodeApiError');
      expect(thrown?.message).toContain(`"${specifier.replace('node:', '').split('/')[0]}"`);
    }
  );

  // A package nobody bundled is not a Node API, and saying it was would send its
  // author looking in the wrong place.
  it('says a bare package must be bundled', () => {
    const { loader } = loaderOver({
      'main.js': (_exports, require) => {
        require('lodash');
      },
    });

    expect(() => loader.load('main.js')).toThrow(/Cannot find module 'lodash'.*bundle/);
  });

  // A file that loaded but never called `define` has nothing to run: a broken wrap
  // must not read as a module with empty exports.
  it('fails loudly when a loaded file defines nothing', () => {
    const loader = createCommonJsLoader({ files: ['main.js'], loadFile: () => undefined });

    expect(() => loader.load('main.js')).toThrow("Module 'main.js' did not load");
  });

  // A non-string reaching require would otherwise fail deep in string handling.
  it('rejects a require of something that is not a string', () => {
    const { loader } = loaderOver({
      'main.js': (_exports, require) => {
        require(42 as unknown as string);
      },
    });

    expect(() => loader.load('main.js')).toThrow('require expects a string');
  });
});
