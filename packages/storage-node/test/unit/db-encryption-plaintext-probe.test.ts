// isExistingPlaintextDb decides, from the FILE, whether a database is migrated
// in place with `rekey=` (plaintext) or opened with `key=` (encrypted or new).
// A wrong `true` rekeys ciphertext — irreversible; a wrong `false` makes a
// plaintext file fail to open. So every doubt must answer `false`, and the
// answer must describe the file that is actually there.

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Every fs call the probe makes goes through this, so a test can swap what the
// path names at the moment it is opened.
const h = vi.hoisted(() => ({ beforeOpen: undefined as ((path: string) => void) | undefined, blockingOpens: 0 }));
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    openSync: (path: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
      h.beforeOpen?.(String(path));
      // A FIFO opened for reading without O_NONBLOCK blocks until a writer
      // appears: count it and fail fast instead of hanging the run.
      const nonBlocking = typeof flags === 'number' && (flags & (actual.constants.O_NONBLOCK || 0)) !== 0;
      if (!nonBlocking && actual.statSync(path, { throwIfNoEntry: false })?.isFIFO()) {
        h.blockingOpens++;
        throw new Error('opened a FIFO without O_NONBLOCK: this would block forever');
      }
      return actual.openSync(path, flags, mode);
    },
  };
});

import { isExistingPlaintextDb } from '../../src/db-encryption';

const posixOnly = it.skipIf(process.platform === 'win32');
/** The first bytes of every plaintext SQLite file, then a page of nothing. */
const PLAINTEXT = Buffer.concat([Buffer.from('SQLite format 3\0', 'latin1'), Buffer.alloc(4080)]);
/** What an encrypted file looks like from outside: no header. */
const CIPHERTEXT = Buffer.alloc(4096, 0xa5);

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(join(tmpdir(), 'plaintext-probe-'));
  h.beforeOpen = undefined;
  h.blockingOpens = 0;
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('isExistingPlaintextDb', () => {
  // Breaks: a legacy plaintext mailbox is opened with key= and reads as "file
  // is not a database" instead of being migrated.
  it('is true for a plaintext SQLite file', () => {
    fs.writeFileSync(join(dir, 'plain.db'), PLAINTEXT);
    expect(isExistingPlaintextDb(join(dir, 'plain.db'))).toBe(true);
  });

  // Breaks: an encrypted, new, short or missing file is "migrated" — rekeying
  // ciphertext, or a file that is not a database at all.
  it('is false for ciphertext, an absent, empty or short file, a directory and an empty path', () => {
    fs.writeFileSync(join(dir, 'enc.db'), CIPHERTEXT);
    fs.writeFileSync(join(dir, 'empty.db'), '');
    fs.writeFileSync(join(dir, 'short.db'), PLAINTEXT.subarray(0, 15));
    expect(isExistingPlaintextDb(join(dir, 'enc.db'))).toBe(false);
    expect(isExistingPlaintextDb(join(dir, 'absent.db'))).toBe(false);
    expect(isExistingPlaintextDb(join(dir, 'empty.db'))).toBe(false);
    expect(isExistingPlaintextDb(join(dir, 'short.db'))).toBe(false);
    expect(isExistingPlaintextDb(dir)).toBe(false);
    expect(isExistingPlaintextDb('')).toBe(false);
  });

  // Breaks: a mailbox kept behind a symlink stops being migrated, though
  // SQLite itself opens it through the link.
  posixOnly('follows a symlink, as SQLite does when it opens the same path', () => {
    fs.writeFileSync(join(dir, 'real.db'), PLAINTEXT);
    fs.symlinkSync(join(dir, 'real.db'), join(dir, 'link.db'));
    expect(isExistingPlaintextDb(join(dir, 'link.db'))).toBe(true);
  });

  // Breaks: a FIFO swapped in for the database after it was measured blocks
  // the open — and the app's startup — until some process writes to it.
  posixOnly('answers false for a FIFO swapped in at open time, without blocking on it', () => {
    const file = join(dir, 'mailbox.db');
    fs.writeFileSync(file, PLAINTEXT);
    h.beforeOpen = (path) => {
      if (path !== file) return;
      h.beforeOpen = undefined;
      fs.rmSync(file);
      execFileSync('mkfifo', [file]);
    };
    expect(isExistingPlaintextDb(file)).toBe(false);
    expect(h.blockingOpens).toBe(0);
  });

  // Breaks: the size is taken from one file and the header read from another,
  // so the answer describes a file that is no longer at the path.
  it('describes the file it read, even when the path changed before the open', () => {
    const file = join(dir, 'mailbox.db');
    fs.writeFileSync(file, 'stub');
    h.beforeOpen = (path) => {
      if (path !== file) return;
      h.beforeOpen = undefined;
      fs.writeFileSync(file, PLAINTEXT);
    };
    expect(isExistingPlaintextDb(file)).toBe(true);
  });
});
