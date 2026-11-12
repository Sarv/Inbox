import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ warn: vi.fn() }));

vi.mock('@sarvinbox/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@sarvinbox/core')>()),
  createLogger: () => ({ info: vi.fn(), warn: h.warn, error: vi.fn(), debug: vi.fn(), trace: vi.fn() }),
}));

import { writeProtectedAttachment } from '../../../../electron/services/attachment-download-protection';
import {
  markDownloadedFromInternet,
  MARK_TIMEOUT_MS,
  QUARANTINE_AGENT,
  quarantineValue,
  XATTR_PATH,
  ZONE_IDENTIFIER,
} from '../../../../electron/services/mark-downloaded';

// CASA 5.2.1. What breaks if these fail: an attachment the app saves (or hands
// to another app) opens with no "downloaded from the internet" warning —
// Gatekeeper, SmartScreen and Office Protected View all treat it as a file the
// user made — or, the other way round, a failing mark breaks the save itself.

// A name that must never reach the log: attachment names are mail data.
const SECRET_FILE = path.join('Users', 'me', 'Downloads', 'Q3-salaries-confidential.xlsx');

const directories: string[] = [];
afterEach(async () => {
  h.warn.mockReset();
  for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true });
});

describe('quarantineValue', () => {
  // The value is `flags;hex-seconds;agent;uuid`. A decimal timestamp, a wrong
  // flag set (e.g. USER_APPROVED 0x40) or a stray separator and macOS treats
  // the file as already approved or ignores the attribute.
  it('formats flags, hex seconds and the agent with an empty UUID', () => {
    expect(quarantineValue(Date.UTC(2026, 10, 3, 12, 0, 0, 999))).toBe(
      `0083;${Math.floor(Date.UTC(2026, 10, 3, 12, 0, 0) / 1000).toString(16)};Sarv Inbox;`,
    );
    expect(QUARANTINE_AGENT).not.toContain(';');
    expect(Number.parseInt('0083', 16) & 0x40).toBe(0); // never pre-approved
    expect(Number.parseInt('0083', 16) & 0x01).toBe(1); // QTN_FLAG_DOWNLOAD
  });
});

describe('markDownloadedFromInternet — Windows', () => {
  // Mark of the Web is the Zone.Identifier stream with ZoneId=3 (Internet), in
  // CRLF — Windows' INI reader. LF-only or a different zone and SmartScreen /
  // Protected View do not engage.
  it('writes the Zone.Identifier stream with the exact CRLF content', async () => {
    const writeFile = vi.fn(async () => {});
    const execFileSpy = vi.fn();
    await markDownloadedFromInternet('C:\\Users\\me\\Downloads\\invoice.pdf', { platform: 'win32', writeFile, execFile: execFileSpy });
    expect(writeFile).toHaveBeenCalledExactlyOnceWith('C:\\Users\\me\\Downloads\\invoice.pdf:Zone.Identifier', '[ZoneTransfer]\r\nZoneId=3\r\n');
    expect(ZONE_IDENTIFIER).toBe('[ZoneTransfer]\r\nZoneId=3\r\n');
    expect(execFileSpy).not.toHaveBeenCalled();
  });

  // FAT/exFAT and many network shares have no alternate streams: the save must
  // still succeed, and the log must not name the file.
  it('logs a failed stream write as a warning without the file name, and resolves', async () => {
    const error = Object.assign(new Error(`EINVAL: invalid argument, open '${SECRET_FILE}:Zone.Identifier'`), { code: 'EINVAL' });
    await expect(markDownloadedFromInternet(SECRET_FILE, { platform: 'win32', writeFile: vi.fn(async () => { throw error; }) }))
      .resolves.toBeUndefined();
    expect(h.warn).toHaveBeenCalledOnce();
    const line = String(h.warn.mock.calls[0][0]);
    expect(line).toContain('win32');
    expect(line).toContain('EINVAL');
    expect(line).not.toContain('salaries');
    expect(h.warn.mock.calls[0]).toHaveLength(1); // no error object (its message carries the path)
  });

  // Runs only on a Windows runner: the real NTFS stream is readable back.
  it.runIf(process.platform === 'win32')('really writes the stream on NTFS', async () => {
    const directory = await fs.mkdtemp(path.join(tmpdir(), 'inbox-motw-'));
    directories.push(directory);
    const file = path.join(directory, 'report.pdf');
    await fs.writeFile(file, 'pdf');
    await markDownloadedFromInternet(file);
    expect(await fs.readFile(`${file}:Zone.Identifier`, 'utf8')).toBe(ZONE_IDENTIFIER);
    expect(await fs.readFile(file, 'utf8')).toBe('pdf');
  });
});

describe('markDownloadedFromInternet — macOS', () => {
  // execFile with an absolute binary and NO shell: the attachment's name is
  // attacker-chosen, and a shell would parse `$(…)` or `;` inside it.
  it('runs /usr/bin/xattr -w com.apple.quarantine with no shell and a bounded timeout', async () => {
    const writeFile = vi.fn();
    const run = vi.fn((_file: string, _args: readonly string[], _options: object, callback: (error: Error | null) => void) => {
      callback(null);
    });
    const hostile = '/Users/me/Downloads/$(touch pwned); rm -rf ~.pdf';
    await markDownloadedFromInternet(hostile, { platform: 'darwin', execFile: run, now: () => 1_793_700_632_000, writeFile });
    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0][0]).toBe(XATTR_PATH);
    expect(XATTR_PATH).toBe('/usr/bin/xattr');
    expect(run.mock.calls[0][1]).toEqual(['-w', 'com.apple.quarantine', '0083;6ae9b318;Sarv Inbox;', hostile]);
    expect(run.mock.calls[0][2]).toEqual({ timeout: MARK_TIMEOUT_MS, shell: false, windowsHide: true });
    expect(writeFile).not.toHaveBeenCalled();
    expect(h.warn).not.toHaveBeenCalled();
  });

  it('logs a failed xattr as a warning without the file name, and resolves', async () => {
    const run = vi.fn((_f: string, _a: readonly string[], _o: object, callback: (error: Error | null) => void) => {
      callback(Object.assign(new Error(`Command failed: /usr/bin/xattr -w com.apple.quarantine x ${SECRET_FILE}`), { code: 1 }));
    });
    await expect(markDownloadedFromInternet(SECRET_FILE, { platform: 'darwin', execFile: run })).resolves.toBeUndefined();
    expect(h.warn).toHaveBeenCalledOnce();
    expect(String(h.warn.mock.calls[0][0])).toMatch(/darwin, 1\)/);
    expect(String(h.warn.mock.calls[0][0])).not.toContain('salaries');
  });

  // A hung child must not hold the save: the wait is capped, then logged.
  // Breaks: the save waits on a child that never answers. On fake timers it
  // checks the cap itself (still waiting at 19 ms, given up at 20 ms) instead of
  // racing a wall clock that a loaded CI runner stretches.
  it('gives up after the timeout instead of delaying the save', async () => {
    vi.useFakeTimers();
    try {
      const run = vi.fn(); // never calls back
      let settled = false;
      const marking = markDownloadedFromInternet(SECRET_FILE, { platform: 'darwin', execFile: run, timeoutMs: 20 })
        .then(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(19);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toBe(true);
      await marking;
      expect(String(h.warn.mock.calls[0][0])).toContain('timeout');
    } finally {
      vi.useRealTimers();
    }
  });

  // A synchronous throw from the spawn (EAGAIN, a bad argument) is still best effort.
  it('treats a synchronous spawn failure as a logged warning', async () => {
    const run = vi.fn(() => { throw Object.assign(new Error('spawn EAGAIN'), { code: 'EAGAIN' }); });
    await expect(markDownloadedFromInternet(SECRET_FILE, { platform: 'darwin', execFile: run })).resolves.toBeUndefined();
    expect(String(h.warn.mock.calls[0][0])).toContain('EAGAIN');
  });

  // Runs only on macOS: the real attribute is readable back with the real tool.
  it.runIf(process.platform === 'darwin')('really sets com.apple.quarantine', async () => {
    const directory = await fs.mkdtemp(path.join(tmpdir(), 'inbox-qtn-'));
    directories.push(directory);
    const file = path.join(directory, 'report $(x); y.pdf');
    await fs.writeFile(file, 'pdf');
    await markDownloadedFromInternet(file);
    const value = await new Promise<string>((resolve, reject) =>
      execFile(XATTR_PATH, ['-p', 'com.apple.quarantine', file], (error, stdout) => (error ? reject(error) : resolve(stdout.trim()))),
    );
    expect(value).toMatch(/^0083;[0-9a-f]+;Sarv Inbox;$/);
    expect(h.warn).not.toHaveBeenCalled();
  });
});

// writeProtectedAttachment marks its temporary file, then commits it under the
// real name by rename (or, for the automatic Downloads save, a hard link and
// an unlink). The mark lives on the file itself — an NTFS stream on the file
// record, an xattr on the inode — so both must carry it over. If either does
// not, every attachment saved through the app opens with no warning at all,
// and only these real-filesystem tests can see it.
describe('the mark survives the commit writeProtectedAttachment makes', () => {
  const commit = async (exclusive: boolean) => {
    const directory = await fs.mkdtemp(path.join(tmpdir(), 'inbox-mark-commit-'));
    directories.push(directory);
    const destination = path.join(directory, 'invoice.pdf');
    await writeProtectedAttachment(destination, Buffer.from('pdf'), new AbortController().signal, async () => {}, exclusive);
    expect(await fs.readFile(destination, 'utf8')).toBe('pdf');
    expect((await fs.readdir(directory)).filter((name) => name.endsWith('.partial'))).toEqual([]);
    return destination;
  };

  // Runs only on a Windows runner (CI's windows-unit-tests job).
  it.runIf(process.platform === 'win32').each([false, true])('keeps the Zone.Identifier stream (exclusive=%s)', async (exclusive) => {
    const destination = await commit(exclusive);
    expect(await fs.readFile(`${destination}:Zone.Identifier`, 'utf8')).toBe(ZONE_IDENTIFIER);
    expect(h.warn).not.toHaveBeenCalled();
  });

  // Runs only on macOS.
  it.runIf(process.platform === 'darwin').each([false, true])('keeps com.apple.quarantine (exclusive=%s)', async (exclusive) => {
    const destination = await commit(exclusive);
    const value = await new Promise<string>((resolve, reject) =>
      execFile(XATTR_PATH, ['-p', 'com.apple.quarantine', destination], (error, stdout) => (error ? reject(error) : resolve(stdout.trim()))),
    );
    expect(value).toMatch(/^0083;[0-9a-f]+;Sarv Inbox;$/);
    expect(h.warn).not.toHaveBeenCalled();
  });
});

describe('markDownloadedFromInternet — Linux and others', () => {
  // There is no Linux standard; doing anything here (or logging a warning on
  // every save) would be noise. It must neither write nor spawn.
  it.each(['linux', 'freebsd'] as const)('%s does nothing', async (platform) => {
    const writeFile = vi.fn();
    const run = vi.fn();
    await markDownloadedFromInternet('/home/me/Downloads/x.pdf', { platform, writeFile, execFile: run });
    expect(writeFile).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    expect(h.warn).not.toHaveBeenCalled();
  });
});
