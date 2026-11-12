import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Every fs call the helper makes goes through these spies, so a test can swap
// what the path names at the exact moment the helper touches it.
const h = vi.hoisted(() => ({
  beforeOpen: undefined as ((path: string) => void) | undefined,
  lstatOverride: undefined as ((path: string) => fs.Stats) | undefined,
  blockingOpens: 0,
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    openSync: (path: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
      h.beforeOpen?.(String(path));
      // A FIFO opened for reading without O_NONBLOCK blocks until a writer
      // appears: record it and fail fast here instead of hanging the run.
      const nonBlocking = typeof flags === 'number' && (flags & (actual.constants.O_NONBLOCK || 0)) !== 0;
      if (!nonBlocking && actual.statSync(path, { throwIfNoEntry: false })?.isFIFO()) {
        h.blockingOpens++;
        throw new Error('opened a FIFO without O_NONBLOCK: this would block forever');
      }
      return actual.openSync(path, flags, mode);
    },
    lstatSync: (path: fs.PathLike, options?: fs.StatSyncOptions) =>
      h.lstatOverride ? h.lstatOverride(String(path)) : actual.lstatSync(path, options),
  };
});

import { readRegularFileSync } from '../../../src/utils/regular-file';

const posixOnly = it.skipIf(process.platform === 'win32');
const LIMITS = { minBytes: 1, maxBytes: 64 };

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(join(tmpdir(), 'regular-file-'));
  h.beforeOpen = undefined;
  h.lstatOverride = undefined;
  h.blockingOpens = 0;
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('readRegularFileSync', () => {
  // Breaks: the one-time ticket and relaunch handoff stop being readable at all.
  it('returns exactly the bytes of a regular file within the limits', () => {
    const file = join(dir, 'ticket.json');
    fs.writeFileSync(file, '{"ok":true}');
    expect(readRegularFileSync(file, LIMITS).toString('utf8')).toBe('{"ok":true}');
  });

  // Breaks: a missing file reads as an empty one instead of "no valid file".
  it('throws for a missing file rather than returning nothing', () => {
    expect(() => readRegularFileSync(join(dir, 'absent'), LIMITS)).toThrow();
  });

  // Breaks: an empty or oversized file is read whole (unbounded memory) or
  // handed to a parser that then trusts it.
  it('refuses a file below or above the size limits', () => {
    const file = join(dir, 'f');
    fs.writeFileSync(file, '');
    expect(() => readRegularFileSync(file, LIMITS)).toThrow(/size/);
    fs.writeFileSync(file, 'x'.repeat(65));
    expect(() => readRegularFileSync(file, LIMITS)).toThrow(/size/);
  });

  // Breaks: a directory at the path is "read" as a file.
  it('refuses a directory', () => {
    expect(() => readRegularFileSync(dir, LIMITS)).toThrow();
  });

  // Breaks: a symlink planted at the fixed path makes the app read (and its
  // caller then delete or trust) whatever the link points at.
  posixOnly('refuses a symlink and leaves its target alone', () => {
    const target = join(dir, 'keep.txt');
    fs.writeFileSync(target, 'keep me');
    fs.symlinkSync(target, join(dir, 'link'));
    expect(() => readRegularFileSync(join(dir, 'link'), LIMITS)).toThrow();
    expect(fs.readFileSync(target, 'utf8')).toBe('keep me');
  });

  // Breaks: a FIFO swapped in at the path the moment it is opened blocks the
  // open — and with it app startup — until some process writes to the pipe.
  posixOnly('refuses a FIFO swapped in at open time without blocking on it', () => {
    const file = join(dir, 'ticket.json');
    fs.writeFileSync(file, '{"ok":true}');
    h.beforeOpen = (path) => {
      if (path !== file) return;
      fs.rmSync(file);
      execFileSync('mkfifo', [file]);
    };
    expect(() => readRegularFileSync(file, LIMITS)).toThrow(/regular file/);
    expect(h.blockingOpens).toBe(0);
  });

  // Breaks: the bytes read come from one file while the path names another
  // (the handle and the path no longer agree), and that is not noticed.
  it('refuses when the path no longer names the file the handle opened', () => {
    const file = join(dir, 'ticket.json');
    const other = join(dir, 'other.json');
    fs.writeFileSync(file, '{"ok":true}');
    fs.writeFileSync(other, '{"other":true}');
    // Once, at the helper's check: the path now names `other`.
    h.lstatOverride = (path) => {
      h.lstatOverride = undefined;
      return fs.lstatSync(path === file ? other : path);
    };
    expect(() => readRegularFileSync(file, LIMITS)).toThrow(/changed/);
  });
});
