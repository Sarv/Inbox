import { execFileSync } from 'child_process';
import { constants, mkdirSync, mkdtempSync, promises, rmSync, symlinkSync, writeFileSync } from 'fs';
import type { FileHandle } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { readRegularFile } from '../../../src/utils/regular-file';

// readRegularFile serves an extension's panel files and the modules its sandbox loads.
// If it follows a link, a panel can read any file the user can; if it hangs, so does
// the extension's protocol handler; if it reads past its bound, one file fills main's heap.

const posixOnly = process.platform === 'win32' ? it.skip : it;

let dir: string;
let outside: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sarv-regular-'));
  outside = mkdtempSync(join(tmpdir(), 'sarv-outside-'));
  writeFileSync(join(outside, 'secret.txt'), 'SECRET');
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

/** Make the next open hand back a handle whose stat is `adjust`ed. */
function adjustOpenedStat(adjust: (stat: Awaited<ReturnType<FileHandle['stat']>>) => object) {
  const open = promises.open.bind(promises);
  vi.spyOn(promises, 'open').mockImplementationOnce(async (...args: Parameters<typeof promises.open>) => {
    const handle = await open(...args);
    const stat = handle.stat.bind(handle);
    handle.stat = (async () => adjust(await stat())) as FileHandle['stat'];
    return handle;
  });
}

describe('readRegularFile', () => {
  // Breaks: the files a panel or a sandbox asks for come back empty or altered.
  it('reads a plain file whole, past one chunk', async () => {
    const big = Buffer.alloc(200 * 1024, 7);
    writeFileSync(join(dir, 'big.bin'), big);
    writeFileSync(join(dir, 'small.txt'), 'hello');

    expect((await readRegularFile(join(dir, 'big.bin')))?.equals(big)).toBe(true);
    expect((await readRegularFile(join(dir, 'small.txt')))?.toString()).toBe('hello');
  });

  // Breaks: a link in the folder serves whatever it points at, anywhere on the disk.
  posixOnly('refuses a link to a file or to a folder', async () => {
    symlinkSync(join(outside, 'secret.txt'), join(dir, 'notes.txt'));
    symlinkSync(outside, join(dir, 'more'));

    expect(await readRegularFile(join(dir, 'notes.txt'))).toBeNull();
    expect(await readRegularFile(join(dir, 'more'))).toBeNull();
  });

  // Breaks: on Windows, which has no O_NOFOLLOW, the open follows a link and nothing
  // else notices. Simulated here by opening without the flag.
  posixOnly('refuses a link even when the open itself follows it', async () => {
    symlinkSync(join(outside, 'secret.txt'), join(dir, 'notes.txt'));
    const open = promises.open.bind(promises);
    vi.spyOn(promises, 'open').mockImplementation((path, flags) =>
      open(path, (flags as number) & ~(constants.O_NOFOLLOW || 0))
    );

    expect(await readRegularFile(join(dir, 'notes.txt'))).toBeNull();
  });

  // Breaks: the race CodeQL flagged: the path is swapped for something else between
  // the open and the read, and the other thing is served.
  it('refuses a path that no longer names the file it opened', async () => {
    writeFileSync(join(dir, 'a.txt'), 'A');
    adjustOpenedStat((stat) => ({ isFile: () => true, size: stat.size, dev: stat.dev, ino: Number(stat.ino) + 1 }));

    expect(await readRegularFile(join(dir, 'a.txt'))).toBeNull();
  });

  // Breaks: a folder is read as an empty file on some platforms and throws on others.
  it('refuses a folder', async () => {
    mkdirSync(join(dir, 'sub'));

    expect(await readRegularFile(join(dir, 'sub'))).toBeNull();
  });

  // Breaks: a named pipe holds the open until something writes to it, and the
  // protocol handler waiting on it never answers.
  posixOnly('refuses a named pipe without waiting on it', async () => {
    execFileSync('mkfifo', [join(dir, 'pipe')]);

    expect(await readRegularFile(join(dir, 'pipe'))).toBeNull();
  });

  // Breaks: one oversized module is read whole into main's heap.
  it('refuses a file over the bound, and reads one exactly at it', async () => {
    writeFileSync(join(dir, 'five.txt'), '12345');

    expect(await readRegularFile(join(dir, 'five.txt'), 4)).toBeNull();
    expect((await readRegularFile(join(dir, 'five.txt'), 5))?.toString()).toBe('12345');
  });

  // Breaks: a file that grows after its size was checked is read past the bound.
  it('stops reading once a growing file passes the bound', async () => {
    writeFileSync(join(dir, 'grows.txt'), 'x'.repeat(10));
    adjustOpenedStat((stat) => ({ isFile: () => true, size: 1, dev: stat.dev, ino: stat.ino }));

    expect(await readRegularFile(join(dir, 'grows.txt'), 5)).toBeNull();
  });

  // Breaks: a missing file reads as a refused one, and the caller cannot tell them apart.
  it('throws for a missing file, as readFile does', async () => {
    await expect(readRegularFile(join(dir, 'gone.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  // Breaks: a handle is leaked on every refusal, until main runs out of descriptors.
  it('closes what it opened, whatever it decides', async () => {
    writeFileSync(join(dir, 'five.txt'), '12345');
    const closes: number[] = [];
    const open = promises.open.bind(promises);
    vi.spyOn(promises, 'open').mockImplementation(async (...args: Parameters<typeof promises.open>) => {
      const handle = await open(...args);
      const close = handle.close.bind(handle);
      handle.close = async () => {
        closes.push(handle.fd);
        return close();
      };
      return handle;
    });

    await readRegularFile(join(dir, 'five.txt'));
    await readRegularFile(join(dir, 'five.txt'), 1);
    mkdirSync(join(dir, 'sub'));
    await readRegularFile(join(dir, 'sub'));

    expect(closes).toHaveLength(process.platform === 'win32' ? 2 : 3);
  });
});
