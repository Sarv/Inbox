import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { constants, openSync, readSync, closeSync, writeFileSync, rmSync, fstatSync } from 'node:fs';
import { join } from 'node:path';

import { app } from 'electron';

import { getExternalOpenService, MAX_EXTERNAL_OPEN_QUEUE } from './external-open-service';

const HANDOFF_ENV = 'SARVINBOX_KEYCHAIN_RELAUNCH';
const MAX_HANDOFF_BYTES = MAX_EXTERNAL_OPEN_QUEUE * 65_536 * 4 + 4_096;
const MAX_HANDOFF_AGE = 5 * 60_000;
const AAD = Buffer.from('Sarv Inbox Keychain relaunch v1');

/** The one-time key travels in process memory, never in the profile or argv. */
export function prepareKeychainLaunchHandoff(directory: string, inputs: readonly string[], now = Date.now()): { token: string; cleanup: () => void } | null {
  if (!inputs.length) return null;
  if (inputs.length > MAX_EXTERNAL_OPEN_QUEUE || inputs.some(input => typeof input !== 'string' || input.length > 65_536)) {
    throw new Error('Pending application requests could not be retained for restart.');
  }
  const plaintext = Buffer.from(JSON.stringify({ time: now, inputs }), 'utf8');
  if (plaintext.length + 28 > MAX_HANDOFF_BYTES) throw new Error('Pending application requests are too large to retain for restart.');
  const nonce = randomBytes(16).toString('hex');
  const key = randomBytes(32);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(AAD);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const path = join(directory, `keychain-launch-${nonce}.bin`);
  writeFileSync(path, Buffer.concat([iv, cipher.getAuthTag(), encrypted]), { mode: 0o600, flag: 'wx' });
  return { token: `${nonce}:${key.toString('base64url')}`, cleanup: () => rmSync(path, { force: true }) };
}

/** Bounded, authenticated, one-use restoration; no credential/database is opened. */
export function consumeKeychainLaunchHandoff(directory: string, token: string | undefined, now = Date.now()): string[] {
  if (!token || !/^[a-f0-9]{32}:[A-Za-z0-9_-]{43}$/.test(token)) return [];
  const [nonce, encodedKey] = token.split(':');
  const path = join(directory, `keychain-launch-${nonce}.bin`);
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size < 29 || stat.size > MAX_HANDOFF_BYTES) return [];
    const buffer = Buffer.alloc(stat.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(fd, buffer, length, buffer.length - length, null);
      if (!count) break;
      length += count;
    }
    if (length !== stat.size) return [];
    const bytes = buffer.subarray(0, length);
    const decipher = createDecipheriv('aes-256-gcm', Buffer.from(encodedKey!, 'base64url'), bytes.subarray(0, 12));
    decipher.setAAD(AAD);
    decipher.setAuthTag(bytes.subarray(12, 28));
    const payload: unknown = JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8'));
    const candidate = payload as { time?: unknown; inputs?: unknown };
    if (typeof candidate.time !== 'number' || candidate.time > now + 5_000 || now - candidate.time > MAX_HANDOFF_AGE
      || !Array.isArray(candidate.inputs) || candidate.inputs.length > MAX_EXTERNAL_OPEN_QUEUE
      || candidate.inputs.some(input => typeof input !== 'string' || input.length > 65_536)) return [];
    return candidate.inputs as string[];
  } catch { return []; }
  finally {
    if (fd !== undefined) closeSync(fd);
    try { rmSync(path, { force: true }); } catch { /* An unreadable encrypted handoff contains no persistent key. */ }
  }
}

/** Schedule a clean native process so Electron can retry its cached Keychain failure. */
export function relaunchForSecureStorage(): void {
  const directory = app.getPath('userData');
  const handoff = prepareKeychainLaunchHandoff(directory, getExternalOpenService().getPendingLaunchInputs());
  const previous = process.env[HANDOFF_ENV];
  if (handoff) process.env[HANDOFF_ENV] = handoff.token;
  else delete process.env[HANDOFF_ENV];
  try {
    // Electron's native implementation can return false without throwing,
    // despite the public TypeScript declaration describing a void result.
    if ((app.relaunch as () => unknown)() === false) throw new Error('Relaunch was declined');
  }
  catch {
    if (previous === undefined) delete process.env[HANDOFF_ENV]; else process.env[HANDOFF_ENV] = previous;
    handoff?.cleanup();
    throw new Error('Sarv Inbox could not schedule its secure-storage restart.');
  }
}

export function restoreSecureStorageLaunchInputs(): void {
  const token = process.env[HANDOFF_ENV];
  delete process.env[HANDOFF_ENV];
  const inputs = consumeKeychainLaunchHandoff(app.getPath('userData'), token);
  // Existing validators re-check URLs and local .ics paths on every launch.
  void getExternalOpenService().enqueueArgv(inputs);
}
