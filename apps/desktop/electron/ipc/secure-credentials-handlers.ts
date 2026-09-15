/**
 * IPC surface for the secure per-account credential vault (safeStorage-backed).
 * The renderer uses these to stash secrets in the main process instead of
 * writing IMAP/SMTP passwords to plaintext localStorage, and to rehydrate them
 * in-memory just before connecting.
 */
import { createLogger } from '@sarvinbox/core';
import { ipcMain, systemPreferences } from 'electron';

import {
  setAccountSecrets,
  getAccountSecrets,
  deleteAccountSecrets,
  hasAccountSecrets,
  isSecureStorageAvailable,
  type AccountSecrets,
} from '../services/secure-credential-store';
const logger = createLogger('secure-credentials-handlers');

export function registerSecureCredentialsHandlers(): void {
  ipcMain.handle('secureCreds:set', async (_e, accountId: string, secrets: AccountSecrets) => {
    try {
      await setAccountSecrets(accountId, secrets);
      return { success: true, encrypted: isSecureStorageAvailable() };
    } catch (error) {
      logger.error('[SecureCreds] set failed:', error);
      return { success: false, error: (error as Error).message };
    }
  });

  ipcMain.handle('secureCreds:get', async (_e, accountId: string) => {
    try {
      return { success: true, data: await getAccountSecrets(accountId) };
    } catch (error) {
      logger.error('[SecureCreds] get failed:', error);
      return { success: false, error: (error as Error).message };
    }
  });

  ipcMain.handle('secureCreds:delete', async (_e, accountId: string) => {
    try {
      await deleteAccountSecrets(accountId);
      return { success: true };
    } catch (error) {
      logger.error('[SecureCreds] delete failed:', error);
      return { success: false, error: (error as Error).message };
    }
  });

  ipcMain.handle('secureCreds:has', async (_e, accountId: string) => {
    try {
      return { success: true, data: await hasAccountSecrets(accountId) };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  // Lets the renderer warn the user when we'd have to fall back to plaintext
  // (no OS keychain), so "encrypted" is never silently assumed.
  ipcMain.handle('secureCreds:available', async () => {
    return { success: true, data: isSecureStorageAvailable() };
  });

  // Reveal a stored password to the renderer ONLY after an OS-level auth prompt
  // (Touch ID on macOS). This protects against a casual snooper at an unlocked
  // machine clicking "show password" — they can't reveal it without the owner's
  // fingerprint/keychain auth. Where biometric isn't available we refuse rather
  // than reveal silently, and the UI keeps the "leave blank to keep" flow.
  // Boolean-only existence check — does the vault actually hold a password for
  // this account/kind? Lets the UI decide "show masked field + reveal" vs "show
  // nothing (first-time setup)" WITHOUT pulling the plaintext into the renderer.
  ipcMain.handle('secureCreds:hasPassword', async (_e, accountId: string, kind: 'imap' | 'smtp' = 'smtp') => {
    try {
      const secrets = await getAccountSecrets(accountId) as { imap?: { password?: string }; smtp?: { password?: string } } | null;
      // Report ONLY a real stored password for THIS kind. Do NOT fall back to the
      // IMAP password for SMTP — SMTP can have a different password, and revealing
      // the IMAP one is misleading (it fails the SMTP login). No stored SMTP
      // password → the field shows first-time entry so the user types the right one.
      const has = !!secrets?.[kind]?.password;
      return { success: true, data: has };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  ipcMain.handle('secureCreds:reveal', async (_e, accountId: string, kind: 'imap' | 'smtp' = 'smtp') => {
    try {
      const canBiometric = process.platform === 'darwin'
        && typeof systemPreferences.canPromptTouchID === 'function'
        && systemPreferences.canPromptTouchID();
      if (!canBiometric) {
        return { success: false, error: 'biometric-unavailable' };
      }
      try {
        await systemPreferences.promptTouchID(`reveal your saved ${kind === 'smtp' ? 'sending' : 'mailbox'} password`);
      } catch {
        return { success: false, error: 'auth-cancelled' };
      }
      const secrets = await getAccountSecrets(accountId) as { imap?: { password?: string }; smtp?: { password?: string } } | null;
      const password = secrets?.[kind]?.password;
      if (!password) return { success: false, error: 'no-stored-password' };
      return { success: true, data: { password } };
    } catch (error) {
      logger.error('[SecureCreds] reveal failed:', error);
      return { success: false, error: (error as Error).message };
    }
  });
}
