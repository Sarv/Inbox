import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  pgpComposeState,
  type PgpComposeDefaults,
  type PgpComposeState,
  type RecipientKeyStatus,
} from '../utils/pgp-compose';

/** Wait for typing to pause before looking recipients' keys up — a lookup can reach the network (WKD). */
export const RECIPIENT_LOOKUP_DEBOUNCE_MS = 400;

const NO_PGP: PgpComposeDefaults = { hasOwnKey: false, signByDefault: false, autoEncrypt: false };

// An unreadable answer reads as "no key for anyone" — never as "everyone has one".
const noKeysFor = (list: string): RecipientKeyStatus[] => list.split(',').map((email) => ({ email, status: 'none' }));

export interface PgpComposeControls {
  state: PgpComposeState;
  toggleEncrypt: () => void;
  toggleSign: () => void;
}

/**
 * The composer's OpenPGP state over the bridge: the sender's defaults, and
 * which recipients have a key.
 *
 * Recipients are looked up only once the sender is known to have a key of
 * their own. A lookup can ask the recipient's mail domain for a key (WKD),
 * which tells that domain someone is writing to the address — not something
 * to do on behalf of a user who has never set up encryption.
 */
export function usePgpCompose(fromEmail: string | undefined, recipients: string[], replyToEncrypted: boolean): PgpComposeControls {
  const [defaults, setDefaults] = useState<PgpComposeDefaults | null>(null);
  const [resolved, setResolved] = useState<{ forList: string; keys: RecipientKeyStatus[] } | null>(null);
  const [encryptOverride, setEncryptOverride] = useState<boolean | null>(null);
  const [signOverride, setSignOverride] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    setDefaults(null);
    if (!fromEmail) {
      setDefaults(NO_PGP);
      return undefined;
    }
    window.electronAPI.pgp
      .composeDefaults(fromEmail)
      .then((result) => !cancelled && setDefaults(result.success ? result.data : NO_PGP))
      .catch(() => !cancelled && setDefaults(NO_PGP));
    return () => {
      cancelled = true;
    };
  }, [fromEmail]);

  // One string per recipient set, so a re-render with an equal list is not a new lookup.
  const recipientList = useMemo(
    () => [...new Set(recipients.map((email) => email.trim().toLowerCase()).filter(Boolean))].sort().join(','),
    [recipients],
  );
  const hasOwnKey = defaults?.hasOwnKey === true;

  useEffect(() => {
    if (!hasOwnKey) return undefined;
    if (!recipientList) {
      setResolved({ forList: recipientList, keys: [] });
      return undefined;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      window.electronAPI.pgp
        .resolveRecipients(recipientList.split(','))
        .then((result) => (result.success ? result.data : noKeysFor(recipientList)))
        .catch(() => noKeysFor(recipientList))
        .then((keys) => !cancelled && setResolved({ forList: recipientList, keys }));
    }, RECIPIENT_LOOKUP_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [hasOwnKey, recipientList]);

  const state = pgpComposeState({
    defaults,
    // Keys found for an older recipient list say nothing about this one.
    keys: resolved?.forList === recipientList ? resolved.keys : null,
    replyToEncrypted,
    encryptOverride,
    signOverride,
  });

  const toggleEncrypt = useCallback(() => setEncryptOverride(!state.encrypt), [state.encrypt]);
  const toggleSign = useCallback(() => setSignOverride(!state.sign), [state.sign]);
  return { state, toggleEncrypt, toggleSign };
}
