import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({ exec: vi.fn(), getPath: vi.fn() }));
vi.mock('node:child_process', () => ({ execFile: native.exec }));
vi.mock('electron', () => ({ app: { getPath: native.getPath } }));

import { requestMacKeychainAccess } from '../../../../electron/services/macos-keychain-access';
import { asPlatformAsync } from '../../../helpers/as-platform';

type NativeCallback = (error: Error | null, stdout: string) => void;
const executableDirectory = '/Applications/Sarv Inbox.app/Contents/MacOS';
const unavailable = { outcome: 'unavailable', status: -4 };

beforeEach(() => {
  vi.resetAllMocks();
  native.getPath.mockReturnValue(join(executableDirectory, 'Sarv Inbox'));
  native.exec.mockImplementation((_file, _args, _options, callback: NativeCallback) => {
    callback(null, '{"status":0}\n');
  });
});

describe('macOS native Keychain authorization', () => {
  it('runs only the helper in this Mac bundle, with no arguments, password, shell or renderer input', async () => {
    await asPlatformAsync('darwin', async () => {
      expect(await requestMacKeychainAccess()).toEqual({ outcome: 'authorized', status: 0 });
    });
    expect(native.getPath).toHaveBeenCalledExactlyOnceWith('exe');
    expect(native.exec).toHaveBeenCalledExactlyOnceWith(
      join(executableDirectory, 'Sarv Inbox Keychain'), [],
      { encoding: 'utf8', timeout: 120_000, maxBuffer: 1024, killSignal: 'SIGTERM', windowsHide: true },
      expect.any(Function),
    );
  });

  it.each(['win32', 'linux', 'freebsd'] as const)('never executes a helper or checks bundle paths on %s', async platform => {
    expect(await asPlatformAsync(platform, requestMacKeychainAccess)).toEqual(unavailable);
    expect(native.exec).not.toHaveBeenCalled(); expect(native.getPath).not.toHaveBeenCalled();
  });

  it.each([
    [0, 'authorized'], [-128, 'cancelled'], [-60006, 'cancelled'],
    [-25337, 'unavailable'], [-2147416032, 'unavailable'], [-4, 'unavailable'],
    [-2_147_483_648, 'unavailable'], [2_147_483_647, 'unavailable'],
  ] as const)('returns only the numeric native status %s with outcome %s', async (status, outcome) => {
    native.exec.mockImplementation((_file, _args, _options, callback: NativeCallback) => {
      callback(null, JSON.stringify({ status }));
    });
    expect(await asPlatformAsync('darwin', requestMacKeychainAccess)).toEqual({ status, outcome });
  });

  it.each([
    '', 'secret-raw-error', '{}', 'null', '[]', '0', '{"status":"0"}',
    '{"status":1.2}', '{"status":2147483648}', '{"status":-2147483649}',
    '{"status":0,"password":"secret-raw-error"}', '{"status":null}',
    `${' '.repeat(1024)}{"status":0}`, '{"status":0}\nsecret-raw-error',
  ])('rejects malformed, oversized or unexpected native output %j without exposing it', async output => {
    native.exec.mockImplementation((_file, _args, _options, callback: NativeCallback) => {
      callback(null, output);
    });
    const result = await asPlatformAsync('darwin', requestMacKeychainAccess);
    expect(result).toEqual(unavailable);
    expect(JSON.stringify(result)).not.toContain('secret-raw-error');
  });

  it('coalesces concurrent calls into one OS authorization prompt and resets after completion', async () => {
    let finish!: NativeCallback;
    native.exec.mockImplementation((_file, _args, _options, callback: NativeCallback) => { finish = callback; });
    await asPlatformAsync('darwin', async () => {
      const first = requestMacKeychainAccess(); const second = requestMacKeychainAccess();
      expect(first).toBe(second); expect(native.exec).toHaveBeenCalledOnce();
      finish(null, '{"status":-128}');
      expect(await first).toEqual({ status: -128, outcome: 'cancelled' });
      expect(await second).toEqual({ status: -128, outcome: 'cancelled' });
      const third = requestMacKeychainAccess();
      expect(third).not.toBe(first); expect(native.exec).toHaveBeenCalledTimes(2);
      finish(null, '{"status":0}'); expect(await third).toEqual({ status: 0, outcome: 'authorized' });
    });
  });

  it.each(['ENOENT', 'EACCES', 'ETIMEDOUT', 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'])('sanitizes %s and never retries automatically', async code => {
    native.exec.mockImplementation((_file, _args, _options, callback: NativeCallback) => {
      callback(Object.assign(new Error('secret in native stderr or path'), { code, killed: true }), '{"status":0}');
    });
    expect(await asPlatformAsync('darwin', requestMacKeychainAccess)).toEqual(unavailable);
    expect(native.exec).toHaveBeenCalledOnce();
  });

  it('sanitizes synchronous spawn/path failures and allows an explicit later attempt', async () => {
    await asPlatformAsync('darwin', async () => {
      native.getPath.mockImplementationOnce(() => { throw new Error('private profile path'); });
      expect(await requestMacKeychainAccess()).toEqual(unavailable); expect(native.exec).not.toHaveBeenCalled();
      native.exec.mockImplementationOnce(() => { throw new Error('private child error'); });
      expect(await requestMacKeychainAccess()).toEqual(unavailable);
      expect(await requestMacKeychainAccess()).toEqual({ status: 0, outcome: 'authorized' });
    });
  });

  it.each(['/usr/bin/electron', '/Applications/Sarv Inbox.app/Resources/Sarv Inbox'])('refuses a helper outside the application bundle: %s', async executable => {
    native.getPath.mockReturnValue(executable);
    expect(await asPlatformAsync('darwin', requestMacKeychainAccess)).toEqual(unavailable);
    expect(native.exec).not.toHaveBeenCalled();
  });
});
