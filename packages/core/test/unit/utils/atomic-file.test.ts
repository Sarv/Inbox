import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { writePrivateFileAtomicSync } from '../../../src/utils/atomic-file';

// writePrivateFileAtomicSync keeps extension storage and the extension crash guard. If
// it writes in place, a crash midway leaves half a file and an extension's data is lost;
// if it writes with the default mode, another account on the computer can read it.

const posixOnly = process.platform === 'win32' ? it.skip : it;

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sarv-atomic-'));
});

afterEach(() => {
  chmodSync(dir, 0o700);
  rmSync(dir, { recursive: true, force: true });
});

describe('writePrivateFileAtomicSync', () => {
  // Breaks: the new contents never arrive, or arrive beside the old ones.
  it('creates a file, then replaces it whole, leaving nothing beside it', () => {
    const file = join(dir, 'store.json');

    writePrivateFileAtomicSync(file, '{"a":1}');
    writePrivateFileAtomicSync(file, '{"b":2}');

    expect(readFileSync(file, 'utf8')).toBe('{"b":2}');
    expect(readdirSync(dir)).toEqual(['store.json']);
  });

  // Breaks: the file is readable by every account on the computer.
  posixOnly('writes it readable by this user only, even over a world-readable one', () => {
    const file = join(dir, 'store.json');
    writeFileSync(file, 'old', { mode: 0o644 });

    writePrivateFileAtomicSync(file, 'new');

    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  // Breaks: a write that cannot finish destroys what was there, or fails silently.
  posixOnly('keeps the old file whole when the write cannot finish, and says so', () => {
    const file = join(dir, 'store.json');
    writeFileSync(file, 'old');
    chmodSync(dir, 0o500);

    expect(() => writePrivateFileAtomicSync(file, 'new')).toThrow();
    expect(readFileSync(file, 'utf8')).toBe('old');
  });
});
