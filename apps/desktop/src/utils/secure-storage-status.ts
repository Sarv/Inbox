import type { SecureStorageStatus, SecureStorageStoreStatus } from '../types/secure-storage';

export function credentialStoreProtection(status: SecureStorageStatus | null, id: string): SecureStorageStoreStatus['protection'] | undefined {
  const stores = status?.stores.filter(store => store.id === id || store.id.startsWith(`${id}-legacy-`)) ?? [];
  for (const protection of ['unprotected', 'unknown', 'encrypted', 'missing'] as const) {
    if (stores.some(store => store.protection === protection)) return protection;
  }
  return undefined;
}

export function secureKeyStoreName(status: SecureStorageStatus): string {
  return status.platform === 'darwin' ? 'macOS Keychain' : status.platform === 'win32' ? 'Windows credential protection' : status.platform === 'linux' ? 'System keyring' : 'Secure credential storage';
}

export function secureStorageAdvice(status: SecureStorageStatus): string {
  if (status.keyStore === 'available') return 'Restart Inbox and check again. Review any stores that remain unprotected under Security → Overview.';
  if (status.platform === 'darwin') return 'Choose Allow Keychain access and approve the macOS permission prompt. If access still fails, sign out and back in or restart your Mac, then retry.';
  if (status.platform === 'linux') return 'Install and unlock a system keyring such as GNOME Keyring or KWallet, then restart Inbox and check again.';
  if (status.platform === 'win32') return 'Sign in to your Windows account, then restart Inbox and check again.';
  return 'Restore secure credential storage on this device, then restart Inbox and check again.';
}

/** Compatibility verdict: an availability failure alone proves neither encryption nor plaintext. */
export function savedSecretsProtected(status: SecureStorageStatus | null): boolean | null {
  if (!status) return null;
  if (status.databaseKeyProtection === 'unprotected' || status.stores.some(store => store.protection === 'unprotected')) return false;
  if (status.databaseReadable === false || status.databaseKeyProtection === 'unknown' || status.stores.some(store => store.protection === 'unknown')) return null;
  if (status.databaseKeyProtection === 'encrypted' && status.stores.every(store => store.protection === 'encrypted' || store.protection === 'missing')) return true;
  return null;
}

export function secureStorageNotice(status: SecureStorageStatus | null, error?: string | null): { title: string; detail: string; advice?: string } | null {
  if (!status) return error ? { title: 'Credential protection could not be checked.', detail: 'Saved storage protection is unknown. Retry the check or review Security → Overview.' } : null;
  const unprotected = status.stores.filter(store => store.protection === 'unprotected');
  if (status.databaseKeyProtection === 'unprotected' || unprotected.length) {
    const detail = [status.databaseKeyProtection === 'unprotected' ? 'The saved database key is not protected by the operating system.' : '', unprotected.length ? `Unprotected saved stores: ${unprotected.map(store => store.label).join(', ')}.` : ''].filter(Boolean).join(' ');
    return { title: 'Some saved data is not protected at rest.', detail, advice: secureStorageAdvice(status) };
  }
  if (status.keyStore !== 'available') return {
    title: status.keyStore === 'basic-text' ? 'OS-backed credential encryption is unavailable.' : `${secureKeyStoreName(status)} is currently unavailable.`,
    detail: status.databaseKeyProtection === 'encrypted' ? `Your saved database key remains encrypted.${status.databaseReadable === true ? ' The database is open in this session.' : ''}${status.databaseReadable === false || status.stores.some(store => store.protection === 'unknown') ? ' Protection of unreadable credential data could not be verified.' : ' Access to protected credentials may need to be restored.'}` : 'The current secure-store availability does not establish how existing credentials are protected. Review the saved storage status in Security → Overview.',
    advice: secureStorageAdvice(status),
  };
  if (status.databaseReadable === false) return { title: 'Saved data is currently unavailable.', detail: status.databaseKeyProtection === 'encrypted' ? 'The saved database key is encrypted, but the local database could not be read in this session. Protection of unreadable credential data could not be verified.' : 'The local database could not be read in this session. Its saved protection could not be confirmed.', advice: secureStorageAdvice(status) };
  if (status.databaseKeyProtection === 'unknown' || status.stores.some(store => store.protection === 'unknown')) return { title: 'Some storage protection could not be verified.', detail: 'Review the individual saved stores in Security → Overview. Unknown status does not confirm either encryption or plaintext.' };
  return null;
}
