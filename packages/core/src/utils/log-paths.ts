import { basename, isAbsolute, relative, sep } from 'path';

import { trimCharsEnd } from './trim-chars';

/**
 * File paths for a log line. Every path the app writes is under the user's
 * home folder, and the home folder is named after the user (`/Users/<name>`,
 * `C:\Users\<name>`), so an absolute path names the person whose log it is.
 * Node-only (uses `path`); the renderer never sees a real path.
 */

export interface LogPathRoots {
  /** The app's data folder (`app.getPath('userData')`). */
  userData?: string;
  /** The user's home folder (`os.homedir()`). */
  home?: string;
}

function inside(root: string | undefined, path: string): string | null {
  if (!root) return null;
  const rel = relative(root, path);
  if (rel === '') return '.';
  return rel.startsWith('..') || isAbsolute(rel) ? null : rel;
}

/**
 * A path for a log line: `<userData>/…` for a file in the app's data folder,
 * `~/…` for one elsewhere under home, and the file name alone for anything
 * else (a path outside home says nothing about where it is that the log needs).
 * Separators are written as `/` so lines read the same on every OS.
 */
export function pathForLog(path: unknown, roots: LogPathRoots): string {
  if (typeof path !== 'string' || path.length === 0) return 'none';
  if (!isAbsolute(path)) return basename(path);
  const inData = inside(roots.userData, path);
  if (inData !== null) return inData === '.' ? '<userData>' : `<userData>/${inData.split(sep).join('/')}`;
  const inHome = inside(roots.home, path);
  if (inHome !== null) return inHome === '.' ? '~' : `~/${inHome.split(sep).join('/')}`;
  return basename(path);
}

// A character that can continue a folder name: `/Users/rc` must not match
// inside `/Users/rcsarv`.
const NAME_CHAR = /[\p{L}\p{N}._ -]/u;

/**
 * `text` with every occurrence of the home folder replaced by `~`: the
 * backstop for a line (a library's message, a stack trace) that wrote an
 * absolute path. Also matches the home written with forward slashes and with
 * doubled backslashes (how util.inspect prints a Windows path inside an
 * object). An occurrence followed by more of a folder name is left alone, so
 * a home of `/Users/rc` never rewrites `/Users/rcsarv`. Linear: indexOf scans.
 * A home shorter than 3 characters (`/`, a misconfigured HOME) is not used.
 */
export function redactHomeDir(text: string, home: string | undefined): string {
  if (!home || home.length < 3) return text;
  const trimmed = trimCharsEnd(home, '\\/');
  if (trimmed.length < 3) return text;
  const forms = new Set([trimmed, trimmed.replace(/\\/g, '/'), trimmed.replace(/\\/g, '\\\\')]);
  let out = text;
  for (const form of forms) out = replaceWhole(out, form);
  return out;
}

function replaceWhole(text: string, needle: string): string {
  let from = 0;
  let at = text.indexOf(needle, from);
  if (at === -1) return text;
  let out = '';
  while (at !== -1) {
    const next = text.charAt(at + needle.length);
    if (next === '' || !NAME_CHAR.test(next)) {
      out += `${text.slice(from, at)}~`;
    } else {
      out += text.slice(from, at + needle.length);
    }
    from = at + needle.length;
    at = text.indexOf(needle, from);
  }
  return out + text.slice(from);
}
