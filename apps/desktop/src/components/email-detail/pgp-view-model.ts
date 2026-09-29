/**
 * What the reader says about an OpenPGP message — pure, so every wording and
 * tone decision is tested without a DOM.
 *
 * The one rule that matters: a green "signed" is only ever shown for a valid
 * signature by a key that names the From address. A good signature by some
 * other key is real but proves nothing about the sender, so it reads neutral.
 */
import type { PgpSignatureView, PgpViewResult } from '../../../electron/services/pgp-reader';

export type { PgpSignatureView, PgpViewResult };

export type PgpBadgeTone = 'good' | 'neutral' | 'bad';

export interface PgpBadge {
  tone: PgpBadgeTone;
  label: string;
  /** One sentence for the tooltip. */
  detail: string;
}

/** Group a fingerprint's tail the way GnuPG prints it, so a user can compare it by eye. */
export const shortFingerprint = (fingerprint?: string): string => {
  const tail = (fingerprint ?? '').slice(-16);
  return Array.from({ length: Math.ceil(tail.length / 4) }, (_, group) => tail.slice(group * 4, group * 4 + 4)).join(' ');
};

const signerOf = (signature: PgpSignatureView): string =>
  signature.signerEmails?.[0] ?? (signature.signerFingerprint ? `key ${shortFingerprint(signature.signerFingerprint)}` : 'an unknown key');

/** The badge for an opened message. Null when there is nothing to say (plain, unsigned). */
export function pgpBadge(wasEncrypted: boolean, signature: PgpSignatureView): PgpBadge | null {
  const lock = wasEncrypted ? 'Encrypted' : null;
  const join = (part: string) => (lock ? `${lock} · ${part}` : part);
  switch (signature.status) {
    case 'valid':
      return signature.fromMatches
        ? { tone: 'good', label: join('Signed'), detail: `Signed by ${signerOf(signature)}. The message has not been changed since.` }
        : {
            tone: 'neutral',
            label: join('Signed by another key'),
            detail: `The signature is valid, but it was made by ${signerOf(signature)}, which does not match the sender.`,
          };
    case 'invalid':
      return { tone: 'bad', label: join('Bad signature'), detail: 'The signature does not match. The message was changed after it was signed, or the signature is forged.' };
    case 'unknown-key':
      return {
        tone: 'neutral',
        label: join('Signed, unverified'),
        detail: `Signed by ${signerOf(signature)}, but you do not have that public key, so the signature cannot be checked.`,
      };
    case 'none':
      return lock ? { tone: 'good', label: lock, detail: 'Only you and the other recipients could read this message.' } : null;
  }
}

export type PgpOpenFailureCode = Extract<PgpViewResult, { ok: false }>['code'];

export interface PgpFailureView {
  title: string;
  detail: string;
  /** Unlock with a passphrase. */
  canUnlock: boolean;
  canRetry: boolean;
}

export function pgpFailureView(code: PgpOpenFailureCode, error: string): PgpFailureView {
  switch (code) {
    case 'locked':
      return {
        title: 'Your key is locked',
        detail: 'Enter the passphrase of your OpenPGP key to read this message. It stays unlocked until you quit.',
        canUnlock: true,
        canRetry: false,
      };
    case 'no-key':
      return {
        title: 'None of your keys can open this message',
        detail: 'It was encrypted to a key you do not have here. Import that key in Settings → Encryption.',
        canUnlock: false,
        canRetry: false,
      };
    case 'bad-data':
      return { title: 'This encrypted message is damaged', detail: error, canUnlock: false, canRetry: false };
    case 'unavailable':
      return { title: 'The encrypted message could not be loaded', detail: error, canUnlock: false, canRetry: true };
  }
}

/** The two bridge calls unlocking needs — injected so the loop is tested without Electron. */
export interface PgpUnlockApi {
  listOwnKeys: () => Promise<{ success: boolean; data?: { fingerprint: string; unlocked: boolean }[] }>;
  unlock: (fingerprint: string, passphrase: string) => Promise<{ success: boolean; error?: string }>;
}

/**
 * Try the passphrase on every locked own key. The reader does not know which
 * key a message was encrypted to until one opens it, and asking the user to
 * pick a fingerprint is asking them a question they cannot answer.
 * Resolves to how many keys it unlocked.
 */
export async function unlockLockedKeys(api: PgpUnlockApi, passphrase: string): Promise<number> {
  const listed = await api.listOwnKeys();
  const locked = (listed.data ?? []).filter((key) => !key.unlocked);
  const results = await Promise.all(locked.map((key) => api.unlock(key.fingerprint, passphrase)));
  return results.filter((result) => result.success).length;
}
