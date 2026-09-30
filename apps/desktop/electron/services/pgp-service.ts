/**
 * The process-wide OpenPGP keyring, wired to its real dependencies: the core
 * DB, the OS keychain, Chromium's network stack and the user's settings.
 * Everything with logic in it lives in pgp-keyring.ts, tested without Electron.
 */
import {
  OutgoingMimeError,
  createLogger,
  type AutocryptSighting,
  type AutocryptSink,
  type OutgoingMimeTransform,
  type SendPgpRequest,
} from '@sarvinbox/core';
import { readPgpPrefs, type PgpPrefs } from '@sarvinbox/core/pgp';

import { readAppSetting } from './core-db';
import { lookupPublicKey } from './pgp-key-lookup';
import { getPgpKeyStore } from './pgp-key-store';
import { PgpKeyring } from './pgp-keyring';
import { pgpOutgoingTransform } from './pgp-outgoing';
import { electronKeychain } from './pgp-secret-seal';
import { timedChromiumFetch } from './timed-fetch';

/** A key directory that has not answered in this long is treated as down. */
const LOOKUP_TIMEOUT_MS = 10_000;
const SETTINGS_KEY = 'sarvinbox-settings';

const logger = createLogger('pgp');

/** THROWS when the settings cannot be read or parsed — the keyring then asks nobody. */
export function readPgpPrefsFromSettings(read: (key: string) => string | null = readAppSetting): PgpPrefs {
  const raw = read(SETTINGS_KEY);
  return readPgpPrefs(raw === null ? null : JSON.parse(raw));
}

let keyring: PgpKeyring | null = null;

export function getPgpKeyring(): PgpKeyring {
  const fetch = timedChromiumFetch(LOOKUP_TIMEOUT_MS);
  keyring ??= new PgpKeyring({
    store: getPgpKeyStore(),
    keychain: electronKeychain,
    lookup: (email, policy) => lookupPublicKey(email, policy, fetch),
    prefs: () => readPgpPrefsFromSettings(),
    now: () => Date.now(),
  });
  return keyring;
}

/**
 * The MIME transform for one send. A keyring that cannot be opened (core DB
 * not ready) leaves a plain send untouched but refuses one that asked to be
 * encrypted or signed — it must never go out as plaintext instead.
 */
export function sendTransformFor(
  request: SendPgpRequest | undefined,
  deps: { keyring?: () => PgpKeyring; prefs?: () => PgpPrefs } = {},
): OutgoingMimeTransform | undefined {
  const wantsPgp = !!(request?.encrypt || request?.sign);
  let ring: PgpKeyring;
  try {
    ring = (deps.keyring ?? getPgpKeyring)();
  } catch (error) {
    logger.warn(`OpenPGP keyring unavailable for this send: ${(error as Error).message}`);
    if (!wantsPgp) return undefined;
    return async () => {
      throw new OutgoingMimeError('The OpenPGP keyring could not be opened, so the message was not sent', false);
    };
  }
  let preferEncrypt = false;
  try {
    preferEncrypt = (deps.prefs ?? readPgpPrefsFromSettings)().autoEncrypt;
  } catch {
    // Unreadable settings: advertise no preference rather than guess one.
  }
  return pgpOutgoingTransform(ring, { request, preferEncrypt });
}

/**
 * The sink an account's sync engine hands Autocrypt headers to. Fire-and-
 * forget: ingest never waits on a key parse, and a keyring that cannot open or
 * a header that fails to parse costs a log line, never the message.
 */
export function autocryptSink(
  keyringFor: () => Pick<PgpKeyring, 'recordAutocrypt'> = getPgpKeyring,
): AutocryptSink {
  return (sighting: AutocryptSighting) => {
    const warn = (error: unknown) =>
      logger.warn(`Autocrypt from ${sighting.fromAddress} not recorded: ${(error as Error)?.message ?? String(error)}`);
    try {
      keyringFor().recordAutocrypt(sighting).catch(warn);
    } catch (error) {
      warn(error);
    }
  };
}

/** Wire an account's sync engine to the keyring (beside attachReputation). */
export function attachAutocrypt(engine: { setAutocryptSink(fn: AutocryptSink): void }): void {
  engine.setAutocryptSink(autocryptSink());
}
