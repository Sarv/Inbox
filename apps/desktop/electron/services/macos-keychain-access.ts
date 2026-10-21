import { execFile } from 'node:child_process';
import { basename, dirname, join } from 'node:path';

import { app } from 'electron';

const HELPER_FILENAME = 'Sarv Inbox Keychain';
const AUTHORIZATION_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 1024;
const UNAVAILABLE_STATUS = -4; // errSecUnimplemented, also used when no native result was received.

export interface MacKeychainAccessResult {
  status: number;
  /** "authorized" reports the native call only; callers must still prove a crypto round trip. */
  outcome: 'authorized' | 'cancelled' | 'unavailable';
}

function unavailable(): MacKeychainAccessResult {
  return { status: UNAVAILABLE_STATUS, outcome: 'unavailable' };
}

/** Reject arbitrary child output rather than exposing it in UI, logs or diagnostics. */
function decodeStatus(output: string): MacKeychainAccessResult {
  if (Buffer.byteLength(output, 'utf8') > MAX_OUTPUT_BYTES) return unavailable();
  try {
    const value: unknown = JSON.parse(output);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return unavailable();
    const candidate = value as Record<string, unknown>;
    const status = candidate.status;
    if (Object.keys(candidate).length !== 1 || typeof status !== 'number'
      || !Number.isInteger(status) || status < -2_147_483_648 || status > 2_147_483_647) return unavailable();
    return {
      status,
      outcome: status === 0 ? 'authorized'
        : status === -128 || status === -60006 ? 'cancelled' : 'unavailable',
    };
  } catch { return unavailable(); }
}

let inFlight: Promise<MacKeychainAccessResult> | undefined;

/**
 * Request OS-owned authorization once, using the helper included in this app's
 * signed Mac bundle. No renderer input, shell, password or Keychain item is
 * passed to the child. A process-cached Electron failure still needs a clean
 * relaunch; native status zero does not establish that saved data is readable.
 */
export function requestMacKeychainAccess(): Promise<MacKeychainAccessResult> {
  if (process.platform !== 'darwin') return Promise.resolve(unavailable());
  if (inFlight) return inFlight;
  const pending = new Promise<MacKeychainAccessResult>(resolve => {
    try {
      const directory = dirname(app.getPath('exe'));
      if (basename(directory) !== 'MacOS' || basename(dirname(directory)) !== 'Contents') {
        resolve(unavailable());
        return;
      }
      execFile(join(directory, HELPER_FILENAME), [], {
        encoding: 'utf8',
        timeout: AUTHORIZATION_TIMEOUT_MS,
        maxBuffer: MAX_OUTPUT_BYTES,
        killSignal: 'SIGTERM',
        // Native authorization is interactive, but never receives terminal input.
        windowsHide: true,
      }, (error, stdout) => {
        resolve(error ? unavailable() : decodeStatus(stdout));
      });
    } catch { resolve(unavailable()); }
  });
  // One native prompt at a time, including callers in different recovery paths.
  inFlight = pending.finally(() => { inFlight = undefined; });
  return inFlight;
}
