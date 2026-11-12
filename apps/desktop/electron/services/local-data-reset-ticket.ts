import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { readRegularFileSync } from '@sarvinbox/core';

import type { LocalDataProfileId } from '../../src/types/local-data';

export const LOCAL_DATA_RESET_ENV = 'SARVINBOX_LOCAL_DATA_RESET';
const MAX_TICKET_AGE = 5 * 60_000;
const MAX_TICKET_BYTES = 1024;
const TOKEN = /^[a-f0-9]{32}:[A-Za-z0-9_-]{43}$/;

/** No secrets or mail are written: the capability key exists only in relaunch memory. */
export function createLocalDataResetTicket(directory: string, profile: LocalDataProfileId, now = Date.now()): { token: string; cleanup: () => void } {
  const nonce = randomBytes(16).toString('hex');
  const key = randomBytes(32);
  const payload = JSON.stringify({ version: 1, profile, time: now });
  const mac = createHmac('sha256', key).update(payload).digest('hex');
  const file = join(directory, `local-data-reset-${nonce}.json`);
  writeFileSync(file, JSON.stringify({ payload, mac }), { mode: 0o600, flag: 'wx' });
  return { token: `${nonce}:${key.toString('base64url')}`, cleanup: () => rmSync(file, { force: true }) };
}

/** A bare argv flag/environment profile can never authorize deletion. Consume once before stores open. */
export function consumeLocalDataResetTicket(directory: string, token: string, currentProfile: LocalDataProfileId, now = Date.now()): void {
  if (!TOKEN.test(token)) throw new Error('The local reset request is invalid. No data was erased.');
  const [nonce, encodedKey] = token.split(':');
  const file = join(directory, `local-data-reset-${nonce}.json`);
  try {
    // One handle, never a check-then-open on the path: no symlink, no FIFO
    // (which would hang startup on the open), and the path still names the
    // file that was read.
    const bytes = readRegularFileSync(file, { minBytes: 1, maxBytes: MAX_TICKET_BYTES });
    const envelope: unknown = JSON.parse(bytes.toString('utf8'));
    if (!envelope || typeof envelope !== 'object') throw new Error('Invalid ticket');
    const { payload, mac } = envelope as { payload?: unknown; mac?: unknown };
    if (typeof payload !== 'string' || typeof mac !== 'string' || !/^[a-f0-9]{64}$/.test(mac)) throw new Error('Invalid ticket');
    const expected = createHmac('sha256', Buffer.from(encodedKey!, 'base64url')).update(payload).digest();
    if (!timingSafeEqual(expected, Buffer.from(mac, 'hex'))) throw new Error('Ticket was changed');
    const request = JSON.parse(payload) as { version?: unknown; profile?: unknown; time?: unknown };
    if (request.version !== 1 || request.profile !== currentProfile || typeof request.time !== 'number'
      || !Number.isFinite(request.time) || request.time > now + 5_000 || now - request.time > MAX_TICKET_AGE) throw new Error('Ticket expired or belongs to another profile');
  } catch {
    throw new Error('The local reset request could not be verified or has expired. No data was erased. Open Settings and confirm a new reset.');
  } finally {
    // Remove only the fixed, nonce-derived request; never follow a renderer path.
    try { rmSync(file, { force: true }); } catch { /* An unusable request must never authorize a later wipe. */ }
  }
}
