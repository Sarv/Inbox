/**
 * Whether a message being written goes out encrypted and/or signed — pure, so
 * every rule is tested without a composer.
 *
 *  - Nothing is possible without a key of the sender's own: no key, no toggles,
 *    and the send carries no OpenPGP request at all.
 *  - Encryption turns itself on when every recipient has a key (the user's
 *    "auto-encrypt" preference), and always for a reply to encrypted mail — a
 *    conversation that started private stays private unless the user says so.
 *  - Signing follows the key's "sign by default" setting.
 *  - A choice the user made with a toggle beats every default.
 *
 * Encrypting to a recipient with no key is never silently downgraded: the
 * toggle stays on, the toolbar names who is missing, and main refuses the send.
 */
import type { SendPgpRequest } from '@sarvinbox/core';

import type { PgpComposeDefaults } from '../../electron/ipc/pgp-handlers';
import type { RecipientKeyStatus } from '../../electron/services/pgp-keyring';

export type { PgpComposeDefaults, RecipientKeyStatus };

export interface PgpComposeInput {
  /** Null until they have loaded. */
  defaults: PgpComposeDefaults | null;
  /** Keys for the current recipients; null while they are being looked up. */
  keys: RecipientKeyStatus[] | null;
  replyToEncrypted: boolean;
  /** The user's own choice, when they made one. */
  encryptOverride: boolean | null;
  signOverride: boolean | null;
}

export interface PgpComposeState {
  /** The sender has a key, so the toggles are shown. */
  available: boolean;
  encrypt: boolean;
  sign: boolean;
  /** Recipients with no key. */
  missing: string[];
  resolving: boolean;
  /** What the send carries; undefined when OpenPGP is not in play. */
  request: SendPgpRequest | undefined;
}

export function pgpComposeState(input: PgpComposeInput): PgpComposeState {
  const available = input.defaults?.hasOwnKey === true;
  const keys = input.keys ?? [];
  const missing = keys.filter((key) => key.status === 'none').map((key) => key.email);
  const everyoneHasKey = input.keys !== null && keys.length > 0 && missing.length === 0;
  const encryptByDefault = input.replyToEncrypted || (input.defaults?.autoEncrypt === true && everyoneHasKey);
  const encrypt = available && (input.encryptOverride ?? encryptByDefault);
  const sign = available && (input.signOverride ?? input.defaults?.signByDefault === true);
  return {
    available,
    encrypt,
    sign,
    missing,
    resolving: available && input.keys === null,
    request: available ? { encrypt, sign } : undefined,
  };
}

const listed = (emails: string[]): string =>
  emails.length > 2 ? `${emails.slice(0, 2).join(', ')} and ${emails.length - 2} more` : emails.join(' and ');

/** The lock's tooltip and label. */
export function encryptToggleText(state: PgpComposeState): string {
  if (state.encrypt && state.missing.length > 0) {
    return `No encryption key for ${listed(state.missing)} — this cannot be sent encrypted`;
  }
  if (state.encrypt) return 'Encrypted — only the recipients can read it';
  if (state.missing.length > 0) return `Encrypt (no key for ${listed(state.missing)})`;
  return 'Encrypt';
}

/** The signature toggle's tooltip and label. */
export const signToggleText = (state: PgpComposeState): string =>
  state.sign ? 'Signed with your OpenPGP key' : 'Sign with your OpenPGP key';
