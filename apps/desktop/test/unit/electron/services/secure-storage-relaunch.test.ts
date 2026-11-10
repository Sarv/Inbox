import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ directory: '', inputs: [] as string[], relaunch: vi.fn(), enqueue: vi.fn(), blockingOpens: 0 }));
vi.mock('electron', () => ({ app: { getPath: () => h.directory, relaunch: h.relaunch } }));
// Opening a FIFO for reading without O_NONBLOCK blocks until a writer appears:
// count such an open and fail it fast instead of hanging the run.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    openSync: (path: import('node:fs').PathLike, flags: import('node:fs').OpenMode, mode?: import('node:fs').Mode) => {
      const nonBlocking = typeof flags === 'number' && (flags & (actual.constants.O_NONBLOCK || 0)) !== 0;
      if (!nonBlocking && actual.statSync(path, { throwIfNoEntry: false })?.isFIFO()) {
        h.blockingOpens++;
        throw new Error('opened a FIFO without O_NONBLOCK: this would block forever');
      }
      return actual.openSync(path, flags, mode);
    },
  };
});
vi.mock('../../../../electron/services/external-open-service', () => ({
  MAX_EXTERNAL_OPEN_QUEUE: 20,
  getExternalOpenService: () => ({ getPendingLaunchInputs: () => h.inputs, enqueueArgv: h.enqueue }),
}));

import { consumeKeychainLaunchHandoff, prepareKeychainLaunchHandoff, relaunchForSecureStorage, restoreSecureStorageLaunchInputs } from '../../../../electron/services/secure-storage-relaunch';

beforeEach(() => {
  h.directory = mkdtempSync(join(tmpdir(), 'inbox-keychain-handoff-'));
  h.inputs = [];
  h.blockingOpens = 0;
  h.relaunch.mockReset(); h.enqueue.mockReset();
  delete process.env.SARVINBOX_KEYCHAIN_RELAUNCH;
});
afterEach(() => { rmSync(h.directory, { recursive: true, force: true }); delete process.env.SARVINBOX_KEYCHAIN_RELAUNCH; });

describe('secure-storage restart launch handoff', () => {
  it('retains a private mailto body and calendar path using an encrypted one-time file', () => {
    const inputs = ['mailto:person@example.test?body=synthetic-private-mail-body', '/tmp/synthetic-meeting.ics'];
    const handoff = prepareKeychainLaunchHandoff(h.directory, inputs, 1_000)!;
    const [file] = readdirSync(h.directory);
    const bytes = readFileSync(join(h.directory, file!));
    expect(bytes.includes(Buffer.from('synthetic-private-mail-body'))).toBe(false);
    expect(bytes.includes(Buffer.from('synthetic-meeting.ics'))).toBe(false);
    if (process.platform !== 'win32') expect(statSync(join(h.directory, file!)).mode & 0o777).toBe(0o600);
    expect(consumeKeychainLaunchHandoff(h.directory, handoff.token, 2_000)).toEqual(inputs);
    expect(consumeKeychainLaunchHandoff(h.directory, handoff.token, 2_000)).toEqual([]);
    expect(readdirSync(h.directory)).toEqual([]);
  });

  it('rejects tampered data, expires old handoffs, and removes the encrypted file', () => {
    const first = prepareKeychainLaunchHandoff(h.directory, ['mailto:a@example.test'], 1_000)!;
    const file = join(h.directory, readdirSync(h.directory)[0]!);
    const bytes = readFileSync(file); bytes[bytes.length - 1]! ^= 1; writeFileSync(file, bytes);
    expect(consumeKeychainLaunchHandoff(h.directory, first.token, 2_000)).toEqual([]);
    expect(readdirSync(h.directory)).toEqual([]);
    const old = prepareKeychainLaunchHandoff(h.directory, ['mailto:a@example.test'], 1_000)!;
    expect(consumeKeychainLaunchHandoff(h.directory, old.token, 400_000)).toEqual([]);
    expect(readdirSync(h.directory)).toEqual([]);
  });

  it('does not accept arbitrary paths or oversized handoffs', () => {
    expect(consumeKeychainLaunchHandoff(h.directory, '../../other:secret')).toEqual([]);
    expect(prepareKeychainLaunchHandoff(h.directory, [])).toBeNull();
    expect(() => prepareKeychainLaunchHandoff(h.directory, Array.from({ length: 21 }, () => 'mailto:a@example.test'))).toThrow('retained');
    expect(() => prepareKeychainLaunchHandoff(h.directory, ['x'.repeat(65_537)])).toThrow('retained');
  });

  it('retains a full queue of valid multibyte mailto bodies across restart', () => {
    const inputs = Array.from({ length: 20 }, (_, index) => `mailto:user${index}@example.test?body=${'文'.repeat(40_000)}`);
    const handoff = prepareKeychainLaunchHandoff(h.directory, inputs)!;
    expect(statSync(join(h.directory, readdirSync(h.directory)[0]!)).size).toBeGreaterThan(2_000_000);
    expect(consumeKeychainLaunchHandoff(h.directory, handoff.token)).toEqual(inputs);
  });

  // Breaks: a FIFO planted at the handoff path blocks the open, and with it the
  // restarted app, until some process writes to the pipe.
  it.skipIf(process.platform === 'win32')('refuses a FIFO at the handoff path without blocking the restart', () => {
    const handoff = prepareKeychainLaunchHandoff(h.directory, ['mailto:a@example.test'], 1_000)!;
    const file = join(h.directory, readdirSync(h.directory)[0]!);
    rmSync(file);
    execFileSync('mkfifo', [file]);
    expect(consumeKeychainLaunchHandoff(h.directory, handoff.token, 2_000)).toEqual([]);
    expect(h.blockingOpens).toBe(0);
    expect(existsSync(file)).toBe(false);
  });

  // Breaks: a symlink planted at the handoff path is followed and its target
  // read (and the restart restores whatever that file decrypts to).
  it.skipIf(process.platform === 'win32')('refuses a symlink at the handoff path and leaves its target alone', () => {
    const handoff = prepareKeychainLaunchHandoff(h.directory, ['mailto:a@example.test'], 1_000)!;
    const file = join(h.directory, readdirSync(h.directory)[0]!);
    const target = join(h.directory, 'real.bin');
    writeFileSync(target, readFileSync(file));
    rmSync(file);
    symlinkSync(target, file);
    expect(consumeKeychainLaunchHandoff(h.directory, handoff.token, 2_000)).toEqual([]);
    expect(existsSync(target)).toBe(true);
  });

  it('keeps the ephemeral key out of argv and removes it from the new process after restoration', () => {
    h.inputs = ['mailto:person@example.test?body=synthetic-body'];
    relaunchForSecureStorage();
    expect(h.relaunch).toHaveBeenCalledWith();
    expect(process.env.SARVINBOX_KEYCHAIN_RELAUNCH).toBeTruthy();
    restoreSecureStorageLaunchInputs();
    expect(h.enqueue).toHaveBeenCalledWith(h.inputs);
    expect(process.env.SARVINBOX_KEYCHAIN_RELAUNCH).toBeUndefined();
    expect(readdirSync(h.directory)).toEqual([]);
  });

  it('cleans up if macOS cannot schedule a restart', () => {
    h.inputs = ['mailto:a@example.test'];
    h.relaunch.mockImplementationOnce(() => { throw new Error('native private detail'); });
    expect(() => relaunchForSecureStorage()).toThrow('could not schedule');
    expect(process.env.SARVINBOX_KEYCHAIN_RELAUNCH).toBeUndefined();
    expect(readdirSync(h.directory)).toEqual([]);
  });

  it('preserves the old process when Electron returns false without throwing', () => {
    h.inputs = ['mailto:a@example.test'];
    h.relaunch.mockReturnValueOnce(false);
    expect(() => relaunchForSecureStorage()).toThrow('could not schedule');
    expect(process.env.SARVINBOX_KEYCHAIN_RELAUNCH).toBeUndefined();
    expect(readdirSync(h.directory)).toEqual([]);
  });
});
