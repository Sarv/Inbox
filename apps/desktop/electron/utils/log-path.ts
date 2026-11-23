import { homedir } from 'os';

import { pathForLog, redactHomeDir } from '@sarvinbox/core';
import { app } from 'electron';

function home(): string | undefined {
  try {
    return homedir();
  } catch {
    return undefined;
  }
}

function userData(): string | undefined {
  try {
    return app.getPath('userData');
  } catch {
    return undefined;
  }
}

/**
 * A path for a main-process log line: `<userData>/…`, `~/…` or the file name
 * (core's `pathForLog`, rooted at this app's data folder and the user's home).
 * Use it wherever a line would otherwise print an absolute path, which names
 * the user through their home folder.
 */
export function logPath(path: unknown): string {
  return pathForLog(path, { userData: userData(), home: home() });
}

/** `text` with the user's home folder written as `~` (core's `redactHomeDir`). */
export function withoutHomeDir(text: string): string {
  return redactHomeDir(text, home());
}
