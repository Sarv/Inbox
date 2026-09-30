/**
 * The OpenPGP step of sending: what happens to a message between MailComposer
 * building it and SMTP carrying it (SMTPClient.sendEmail's `transformMime`).
 *
 *   - Every message from an address the user has a key for carries an
 *     Autocrypt header, so correspondents can encrypt back without a lookup.
 *     This part is best-effort: a keyring that cannot be read sends the
 *     message exactly as built.
 *   - When the send asks for encryption, EVERY recipient must have a key; one
 *     without refuses the send. Nothing ever silently drops to plaintext.
 *     The sender's own key is added so the Sent copy stays readable.
 *   - When it asks for a signature, the key for the From address signs; a
 *     missing or locked key refuses the send rather than sending it unsigned.
 *
 * Refusals are `OutgoingMimeError(…, false)`: permanent for the outbox, which
 * then surfaces the message instead of retrying something that cannot work
 * until the user acts.
 */
import {
  OutgoingMimeError,
  createLogger,
  parseAddresses,
  type OutgoingMimeTransform,
  type SendPgpRequest,
} from '@sarvinbox/core';
import { buildAutocryptHeader, encryptOutgoingMime, signOutgoingMime, withHeader } from '@sarvinbox/core/pgp';

import type { PgpKeyring } from './pgp-keyring';

const logger = createLogger('pgp-outgoing');

export type OutgoingKeyring = Pick<PgpKeyring, 'ownPublicKeyFor' | 'signingKeyFor' | 'encryptionKeysFor'>;

export interface OutgoingPgpOptions {
  /** What this send asked for; absent = neither encrypt nor sign. */
  request?: SendPgpRequest;
  /** Autocrypt `prefer-encrypt=mutual`: the user encrypts whenever they can. */
  preferEncrypt: boolean;
}

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

async function withAutocrypt(keyring: OutgoingKeyring, raw: Buffer, from: string, preferEncrypt: boolean): Promise<Buffer> {
  try {
    const own = await keyring.ownPublicKeyFor(from);
    if (!own) return raw;
    const header = buildAutocryptHeader({
      addr: from,
      preferEncrypt: preferEncrypt ? 'mutual' : 'nopreference',
      keydata: Buffer.from(own.write()),
    });
    return withHeader(raw, 'Autocrypt', header);
  } catch (error) {
    logger.warn(`Autocrypt header skipped: ${errorMessage(error)}`);
    return raw;
  }
}

export function pgpOutgoingTransform(keyring: OutgoingKeyring, options: OutgoingPgpOptions): OutgoingMimeTransform {
  return async (raw, context) => {
    const from = parseAddresses(context.fromHeader)[0] ?? '';
    const withHeaderRaw = from ? await withAutocrypt(keyring, raw, from, options.preferEncrypt) : raw;
    const { encrypt = false, sign = false } = options.request ?? {};
    if (!encrypt && !sign) return withHeaderRaw;

    try {
      const signingKey = sign ? await keyring.signingKeyFor(from) : null;
      if (sign && !signingKey) {
        throw new OutgoingMimeError(`No OpenPGP key for ${from || 'this sender'} to sign with`, false);
      }
      const signingKeys = signingKey ? [signingKey] : [];
      if (!encrypt) return await signOutgoingMime(withHeaderRaw, signingKeys);

      const recipients = parseAddresses(context.recipients.join(', '));
      const { keys, missing } = await keyring.encryptionKeysFor(from, recipients);
      if (missing.length > 0) {
        throw new OutgoingMimeError(`No encryption key for ${missing.join(', ')} — import their key or send unencrypted`, false);
      }
      return await encryptOutgoingMime(withHeaderRaw, { encryptionKeys: keys, signingKeys });
    } catch (error) {
      if (error instanceof OutgoingMimeError) throw error;
      // A locked key, an unreadable keyring, an openpgp failure: none of them
      // clears up by retrying, so none of them may be retried into plaintext.
      throw new OutgoingMimeError(`Could not ${encrypt ? 'encrypt' : 'sign'} the message: ${errorMessage(error)}`, false);
    }
  };
}

/**
 * A draft of an encrypted message, encrypted to the sender's own key alone —
 * a draft has one reader. Unsigned, so saving never needs a locked key.
 *
 * Throws when there is no key for the address: the caller must then save
 * nothing, because the only other thing it could save is the plaintext.
 */
export async function encryptDraftMime(raw: Buffer, from: string, keyring: Pick<PgpKeyring, 'ownPublicKeyFor'>): Promise<Buffer> {
  const own = from ? await keyring.ownPublicKeyFor(from) : null;
  if (!own) throw new Error(`No OpenPGP key for ${from || 'this account'} to encrypt the draft with`);
  return encryptOutgoingMime(raw, { encryptionKeys: [own] });
}
