/**
 * `require` for confined code: CommonJS with no Node behind it.
 *
 * An extension is a CommonJS file, usually one bundled file, and inside a Web
 * Worker there is no module system to load it with. Each file the extension
 * ships is fetched with `importScripts` (a synchronous load, which is what
 * `require` has to be) and served by the host wrapped in a call to `define`, so
 * its top-level `const` cannot collide with another file's and `exports` and
 * `require` are the ordinary parameters a CommonJS module expects.
 *
 * It only resolves files the host listed: there is nothing to probe, and no path
 * reaches the host that it did not itself find while walking the extension's
 * folder. Every Node module is refused with a sentence naming it. The `require`
 * here is a plain function with no authority: anything it refuses, the extension
 * could not have done any other way either.
 */

import { nodeBuiltinNamed, UnsupportedNodeApiError } from './unsupported-node-api';

/** What a CommonJS module's wrapper function takes. */
export type CommonJsFactory = (
  exports: unknown,
  require: (specifier: string) => unknown,
  module: { exports: unknown; id: string; filename: string; loaded: boolean },
  filename: string,
  dirname: string
) => void;

export interface CommonJsLoaderOptions {
  /** Every module file the host will serve, relative with `/` separators. */
  files: readonly string[];
  /** Runs one listed file, which must call `define` before returning. */
  loadFile: (relativePath: string) => void;
  /** Where the extension believes its folder is. Not a real path. */
  virtualRoot?: string;
}

export interface CommonJsLoader {
  /** Called by a served file with its wrapper function. */
  define(relativePath: string, factory: CommonJsFactory): void;
  /** Load a module, starting from the extension's folder. */
  load(relativePath: string): unknown;
}

const posixDirname = (filePath: string): string => {
  const slash = filePath.lastIndexOf('/');
  return slash === -1 ? '' : filePath.slice(0, slash);
};

/** Resolve `.` and `..` against a folder inside the extension. Null when it climbs out. */
function joinInside(fromDir: string, specifier: string): string | null {
  const parts = fromDir ? fromDir.split('/') : [];
  for (const segment of specifier.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else {
      parts.push(segment);
    }
  }
  return parts.join('/');
}

/** Join a folder and a name, where the extension's own folder is the empty string. */
const inFolder = (folder: string, name: string): string => (folder ? `${folder}/${name}` : name);

const isRelative = (specifier: string): boolean =>
  specifier === '.' || specifier === '..' || specifier.startsWith('./') || specifier.startsWith('../');

export function createCommonJsLoader(options: CommonJsLoaderOptions): CommonJsLoader {
  const files = new Set(options.files);
  const virtualRoot = options.virtualRoot ?? '/extension';
  const factories = new Map<string, CommonJsFactory>();
  const modules = new Map<string, { exports: unknown; id: string; filename: string; loaded: boolean }>();

  const virtualPath = (relativePath: string): string =>
    relativePath ? `${virtualRoot}/${relativePath}` : virtualRoot;

  /**
   * Node's resolution order for a relative path, against the host's list: the file, then
   * a folder through its package.json `main`, then the folder's index. The folder forms
   * are how a bundler's output and `require('..')` reach a file, and an empty target is
   * the extension's own folder, which is what `require('..')` from `lib/a.js` names.
   */
  function resolveListed(target: string): string | null {
    if (target) {
      for (const candidate of [target, `${target}.js`, `${target}.cjs`, `${target}.json`]) {
        if (files.has(candidate)) return candidate;
      }
    }
    const manifest = inFolder(target, 'package.json');
    if (files.has(manifest)) {
      const main = (load(manifest) as { main?: unknown } | null)?.main;
      if (typeof main === 'string') {
        const entry = joinInside(target, main);
        // Not back to this folder, or a package.json naming itself would never end.
        const resolved = entry === null || entry === target ? null : resolveListed(entry);
        if (resolved !== null) return resolved;
      }
    }
    const index = inFolder(target, 'index.js');
    return files.has(index) ? index : null;
  }

  function requireFrom(fromFile: string, specifier: string): unknown {
    if (typeof specifier !== 'string') throw new TypeError('require expects a string');
    if (!isRelative(specifier)) {
      const builtin = nodeBuiltinNamed(specifier);
      if (builtin) throw new UnsupportedNodeApiError(builtin);
      throw new Error(
        `Cannot find module '${specifier}': an extension must bundle its dependencies into its own files.`
      );
    }
    const target = joinInside(posixDirname(fromFile), specifier);
    const resolved = target === null ? null : resolveListed(target);
    if (resolved === null) {
      throw new Error(`Cannot find module '${specifier}' from '${fromFile}'.`);
    }
    return load(resolved);
  }

  function load(relativePath: string): unknown {
    const existing = modules.get(relativePath);
    // Handed back part-built during a cycle, exactly as Node does.
    if (existing) return existing.exports;

    if (!files.has(relativePath)) {
      throw new Error(`Cannot find module '${relativePath}'.`);
    }
    if (!factories.has(relativePath)) options.loadFile(relativePath);
    const factory = factories.get(relativePath);
    if (!factory) throw new Error(`Module '${relativePath}' did not load.`);

    const filename = virtualPath(relativePath);
    const record = { exports: {}, id: filename, filename, loaded: false };
    modules.set(relativePath, record);
    try {
      factory(
        record.exports,
        (specifier) => requireFrom(relativePath, specifier),
        record,
        filename,
        virtualPath(posixDirname(relativePath))
      );
    } catch (error) {
      // Node forgets a module whose top level threw, and a retry runs it again.
      modules.delete(relativePath);
      throw error;
    }
    record.loaded = true;
    return record.exports;
  }

  return {
    define: (relativePath, factory) => {
      factories.set(relativePath, factory);
    },
    load,
  };
}
