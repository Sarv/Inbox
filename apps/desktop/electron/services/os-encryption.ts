/**
 * Whether secrets at rest are protected by the OPERATING SYSTEM's key store.
 *
 * `safeStorage.isEncryptionAvailable()` alone is not that question. On Linux
 * with no Secret Service / KWallet (headless, minimal desktops, or
 * `--password-store=basic`), Chromium picks the `basic_text` backend and
 * `isEncryptionAvailable()` still returns true — but that backend "encrypts"
 * with a hard-coded key published in Chromium's source. Data sealed with it is
 * obfuscated, not protected: anyone who copies the profile can read it.
 *
 * So every place that tells the user (or decides) whether a secret is really
 * encrypted asks THIS, not `isEncryptionAvailable()`. Reading data already
 * sealed under `basic_text` still works through safeStorage as before.
 */
import { safeStorage } from 'electron';

export function isOsBackedEncryption(): boolean {
  if (process.platform !== 'darwin' && process.platform !== 'win32' && process.platform !== 'linux') return false;
  if (!safeStorage.isEncryptionAvailable()) return false;
  if (process.platform !== 'linux') return true;
  // Linux-only API; absent or throwing means we can't vouch for the backend.
  try {
    return ['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6'].includes(safeStorage.getSelectedStorageBackend());
  } catch {
    return false;
  }
}

/**
 * Stored Linux v10 ciphertext uses Chromium's public hardcoded password; v11
 * uses a keyring key. The currently selected backend cannot prove how an OLD
 * payload was sealed. Unknown future versions remain unverified.
 */
export function storedEncryptionProtection(version: string): 'encrypted' | 'unprotected' | 'unknown' {
  if (process.platform === 'darwin' || process.platform === 'win32') return 'encrypted';
  if (process.platform !== 'linux') return 'unknown';
  return version === 'v11' ? 'encrypted' : version === 'v10' ? 'unprotected' : 'unknown';
}

/** One-word description of where secrets are kept, for the startup log. */
export function secretStorageDescription(): string {
  if (!safeStorage.isEncryptionAvailable()) return 'unavailable (saved protection checked separately)';
  if (isOsBackedEncryption()) return 'os-keychain';
  if (process.platform === 'linux') {
    try {
      if (safeStorage.getSelectedStorageBackend() === 'basic_text') return 'basic_text (not OS-backed; new secret writes blocked)';
    } catch { /* unknown backend */ }
  }
  return 'unavailable (OS-backed storage could not be verified)';
}
