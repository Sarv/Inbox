/**
 * Which of an extension's files its sandbox may load, and how they are served.
 *
 * The only file access a confined extension has is its own code, read for it by
 * main. Decided here by listing, not by checking paths: the folder is walked once
 * when the sandbox starts, and a request is served only when it names an entry of
 * that list exactly. A `..`, an encoded separator or a Windows path simply is not
 * on the list. A symbolic link never gets on it, because the walk does not follow
 * one, so a link inside the folder is not a way to the rest of the disk.
 *
 * Plain Node, no Electron, so it runs under test as it runs in the app.
 */
import { promises as fs } from 'fs';
import { extname, join } from 'path';

import { SANDBOX_DEFINE_GLOBAL } from '../extension-sandbox/constants';
import { readRegularFile } from '../utils/read-regular-file';

/** What `require` can load. Nothing else in the folder is any of a Worker's business. */
const MODULE_EXTENSIONS = new Set(['.js', '.cjs', '.json']);

/** More files than any bundled extension has; a guard against a folder of a million. */
export const MAX_MODULE_FILES = 5_000;

/** The largest module file served: 16 MB. A published extension is well under 1 MB. */
export const MAX_MODULE_BYTES = 16 * 1024 * 1024;

/**
 * Every module file under `rootDir`, relative with `/` separators on every platform.
 * Links are not followed, into either a file or a folder.
 */
export async function listModuleFiles(rootDir: string): Promise<string[]> {
  const found: string[] = [];
  const pending: string[][] = [[]];
  while (pending.length > 0) {
    const segments = pending.pop() as string[];
    const entries = await fs.readdir(join(rootDir, ...segments), { withFileTypes: true });
    for (const entry of entries) {
      const next = [...segments, entry.name];
      if (entry.isDirectory()) {
        pending.push(next);
      } else if (entry.isFile() && MODULE_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
        found.push(next.join('/'));
        if (found.length > MAX_MODULE_FILES) {
          throw new Error(`This extension has more than ${MAX_MODULE_FILES} code files`);
        }
      }
    }
  }
  return found.sort();
}

/**
 * A module file as the Worker's `importScripts` runs it: one call handing over a
 * CommonJS wrapper. On the file's own first line, so stack traces stay accurate.
 * A JSON file becomes a module exporting it, and bad JSON fails when `require`d.
 */
export function wrapModuleSource(relativePath: string, text: string): string {
  const path = JSON.stringify(relativePath);
  const open = `globalThis.${SANDBOX_DEFINE_GLOBAL}(${path},function(exports,require,module,__filename,__dirname){`;
  if (extname(relativePath).toLowerCase() === '.json') {
    try {
      // Through `parse` and back: only real JSON reaches the script's parser.
      return `${open}module.exports=${JSON.stringify(JSON.parse(text))};\n});`;
    } catch {
      return `${open}throw new SyntaxError(${JSON.stringify(`Invalid JSON in ${relativePath}`)});\n});`;
    }
  }
  // A shebang is legal only on a script's first line, which this no longer is.
  const source = text.startsWith('#!') ? `//${text}` : text;
  // The newline keeps a trailing `//# sourceMappingURL=` comment from eating the close.
  return `${open}${source}\n});`;
}

/**
 * Read one listed file. Null for anything that is no longer a plain file of a
 * sensible size: the list is from startup, so this looks again without following
 * a link that has replaced it.
 */
export async function readModuleFile(rootDir: string, relativePath: string): Promise<string | null> {
  const bytes = await readRegularFile(join(rootDir, ...relativePath.split('/')), MAX_MODULE_BYTES);
  return bytes === null ? null : bytes.toString('utf8');
}
