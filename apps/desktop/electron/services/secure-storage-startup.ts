import { createLogger } from '@sarvinbox/core';
import { app, dialog, safeStorage, type MessageBoxOptions } from 'electron';

import { requestMacKeychainAccess } from './macos-keychain-access';
import { isOsBackedEncryption } from './os-encryption';

const logger = createLogger('secure-storage-startup');
const STORAGE_PROBE = 'Sarv Inbox secure-storage startup check';

export type StartupRecoveryReason = 'unavailable' | 'authorization-cancelled' | 'saved-data-locked' | 'initialization-failed';

export interface MacKeychainAuthorizationResult {
  status: number;
  outcome: 'authorized' | 'cancelled' | 'unavailable';
}

export interface SecureStorageStartupDeps {
  platform?: NodeJS.Platform;
  whenReady?: () => Promise<unknown>;
  /** Checks OS-backed availability and a nonsecret round trip; never reads profile secrets. */
  checkStorage?: () => boolean;
  /** Gives macOS an active app and a native event turn before its authorization UI. */
  foregroundMac?: () => Promise<void>;
  /** Only requests native authorization; a success status does not prove encryption works. */
  authorizeMac?: () => Promise<MacKeychainAuthorizationResult>;
  showRecovery?: (options: MessageBoxOptions) => Promise<{ response: number }>;
  showErrorBox?: (title: string, message: string) => void;
  /** Main may inject a relaunch that also preserves pending file/URL launch inputs. */
  restart?: () => void;
  quit?: () => void;
  log?: (message: string) => void;
}

/** A positive backend flag alone does not prove that encryption and decryption work. */
export function probeSecureStorage(platform: NodeJS.Platform = process.platform): boolean {
  try {
    if (!isOsBackedEncryption()) return false;
    const encrypted = safeStorage.encryptString(STORAGE_PROBE);
    // Linux may return its public-password v10 fallback despite an earlier
    // backend check. Verify this actual result before trusting the round trip.
    if (platform === 'linux' && encrypted.subarray(0, 3).toString('ascii') !== 'v11') return false;
    return encrypted.length > 0 && safeStorage.decryptString(encrypted) === STORAGE_PROBE;
  } catch { return false; }
}

/** Safe, actionable copy only. Raw initialization errors can contain credentials or local data. */
export function startupRecoveryOptions(reason: StartupRecoveryReason, platform: NodeJS.Platform, macStatus?: number): MessageBoxOptions {
  const unlockAdvice = platform === 'darwin'
    ? 'Choose Try again to ask macOS to unlock its keychain. Enter your password only in the macOS prompt, and allow Sarv Inbox access if macOS asks. Sarv Inbox will restart after authorization to try secure storage again. If macOS keeps rejecting access, sign out of your Mac and sign in again, or restart your Mac, then reopen Sarv Inbox. An unlocked keychain alone does not guarantee that secure storage is working.'
    : platform === 'win32'
      ? 'Sign in to and unlock your normal Windows user session, then restart Sarv Inbox. Windows secure storage is tied to that user. If access is still blocked, sign out of Windows and sign in again before reopening the app.'
      : platform === 'linux'
        ? 'Start or unlock a system keyring in your graphical desktop session, such as GNOME Keyring / Secret Service or KDE Wallet, then restart Sarv Inbox. A basic text password backend cannot protect saved credentials.'
        : 'Unlock your operating system’s secure credential store, then restart Sarv Inbox.';
  const secureFailure = reason !== 'initialization-failed';
  const macRecovery = platform === 'darwin' && secureFailure;
  return {
    type: 'error',
    title: secureFailure ? 'Sarv Inbox needs secure storage' : 'Sarv Inbox could not start',
    message: reason === 'unavailable' ? 'Your operating system’s secure storage is unavailable.'
      : reason === 'authorization-cancelled' ? 'Keychain authorization was cancelled.'
      : reason === 'saved-data-locked' ? 'Sarv Inbox could not unlock its saved data.'
        : 'An initialization error prevented Sarv Inbox from opening.',
    detail: [
      secureFailure ? unlockAdvice : 'Restart Sarv Inbox to try again. If the problem continues, contact support with the app version and the time of this error.',
      '',
      'Your existing mail, accounts and settings have not been deleted or replaced. Sarv Inbox is stopping before continuing startup.',
      macRecovery ? 'Authorization may help a locked keychain, but cannot repair every macOS secure-storage error.' : 'Restart only when you are ready to try again, or choose Quit.',
      ...(macRecovery && Number.isSafeInteger(macStatus) ? [`macOS Keychain status: ${macStatus}.`] : []),
    ].join('\n'),
    buttons: [macRecovery ? 'Try again' : 'Restart Sarv Inbox', 'Quit'],
    // Enter/Escape must never create a restart loop. Relaunch requires an explicit user choice.
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  };
}

async function foregroundMacForAuthorization(): Promise<void> {
  app.focus({ steal: true });
  await new Promise<void>(resolve => setImmediate(resolve));
}

async function authorizeMacKeychain(deps: SecureStorageStartupDeps): Promise<MacKeychainAuthorizationResult> {
  const { foregroundMac = foregroundMacForAuthorization, authorizeMac = requestMacKeychainAccess, log = message => logger.info(message) } = deps;
  try {
    await foregroundMac();
    const result = await authorizeMac();
    // Only numeric OSStatus values are diagnostic data; never echo native exceptions.
    if (!Number.isSafeInteger(result.status) || !['authorized', 'cancelled', 'unavailable'].includes(result.outcome)) {
      throw new Error('Invalid native authorization result');
    }
    log(`[Security] Native Keychain authorization: ${result.outcome}; OSStatus ${result.status}.`);
    return result;
  } catch {
    log('[Security] Native Keychain authorization is unavailable.');
    return { outcome: 'unavailable', status: -4 };
  }
}

async function stopForRecovery(reason: StartupRecoveryReason, deps: SecureStorageStartupDeps, macStatus?: number): Promise<false> {
  const {
    platform = process.platform,
    showRecovery = options => dialog.showMessageBox(options),
    showErrorBox = (title, message) => dialog.showErrorBox(title, message),
    restart = () => app.relaunch(),
    quit = () => app.quit(),
    log = message => logger.error(message),
  } = deps;
  const options = startupRecoveryOptions(reason, platform, macStatus);
  log(`[Security] Startup stopped: ${reason}. Existing profile data preserved.`);
  let response = 1;
  try { response = (await showRecovery(options)).response; }
  catch {
    log('[Security] The startup recovery dialog could not be shown.');
    try { showErrorBox(options.title!, `${options.message}\n\n${options.detail}`); } catch { /* A headless session still exits safely. */ }
  }
  if (response === 0) {
    if (platform === 'darwin' && reason !== 'initialization-failed') {
      // A failed synchronous native key lookup is cached for this process. Never
      // probe that cache again or loop automatically: one explicit native retry,
      // then a clean process only after authorization succeeds.
      const authorization = await authorizeMacKeychain(deps);
      if (authorization.outcome !== 'authorized' || authorization.status !== 0) {
        const retryOptions = startupRecoveryOptions(authorization.outcome === 'cancelled' ? 'authorization-cancelled' : 'unavailable', platform, authorization.status);
        try {
          showErrorBox(retryOptions.title!, `${retryOptions.message}\n\nSarv Inbox will quit without opening or replacing your saved data. Reopen the app to try the macOS prompt again. If macOS keeps rejecting access, sign out of your Mac and sign in again, or restart your Mac.\n\nmacOS Keychain status: ${authorization.status}.`);
        } catch { /* Still stop before opening saved data. */ }
        quit();
        return false;
      }
    }
    try { restart(); }
    catch {
      log('[Security] Sarv Inbox could not schedule a restart.');
      try { showErrorBox('Reopen Sarv Inbox', 'Sarv Inbox could not restart automatically. Quit, then open Sarv Inbox again. Your existing data is preserved.'); } catch { /* Still stop before opening saved data. */ }
    }
  }
  quit();
  return false;
}

/** Runs after CI smoke checks and install-location handling, before ANY persistent mail/credential store opens. */
export async function ensureSecureStorageForStartup(deps: SecureStorageStartupDeps = {}): Promise<boolean> {
  const { platform = process.platform, whenReady = () => app.whenReady(), checkStorage = probeSecureStorage } = deps;
  try {
    await whenReady();
    if (platform === 'darwin') {
      // Authorize before the first sync key lookup: its failure is process-cached.
      const authorization = await authorizeMacKeychain(deps);
      if (authorization.outcome !== 'authorized' || authorization.status !== 0) {
        return stopForRecovery(authorization.outcome === 'cancelled' ? 'authorization-cancelled' : 'unavailable', deps, authorization.status);
      }
    }
    if (checkStorage()) return true;
  } catch { /* Treat a failed availability probe as unavailable, never as permission to save unprotected data. */ }
  return stopForRecovery('unavailable', deps);
}

/** The outer startup catch must not disappear into a log and a silently closed app. */
export async function reportStartupInitializationFailure(error: unknown, deps: SecureStorageStartupDeps = {}): Promise<false> {
  const message = error instanceof Error ? error.message : '';
  const reason: StartupRecoveryReason = /(?:db[- ]?key|safeStorage|keychain|secure[ -]storage|decrypt|encryption key|cipher|credentials? (?:are|is) encrypted)/i.test(message)
    ? 'saved-data-locked' : 'initialization-failed';
  return stopForRecovery(reason, deps);
}
