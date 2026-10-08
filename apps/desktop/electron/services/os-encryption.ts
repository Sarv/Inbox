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
  if (!safeStorage.isEncryptionAvailable()) return false;
  if (process.platform !== 'linux') return true;
  // Linux-only API; absent or throwing means we can't vouch for the backend.
  try {
    return safeStorage.getSelectedStorageBackend() !== 'basic_text';
  } catch {
    return false;
  }
}

/** One-word description of where secrets are kept, for the startup log. */
export function secretStorageDescription(): string {
  if (!safeStorage.isEncryptionAvailable()) return 'unavailable (marked plaintext)';
  if (isOsBackedEncryption()) return 'os-keychain';
  return 'basic_text (no system keyring — NOT protected at rest)';
}
