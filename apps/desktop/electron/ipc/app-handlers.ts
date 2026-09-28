/**
 * App IPC Handlers
 *
 * Handles app-level operations like version info and external links.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

import { createLogger } from '@sarvinbox/core';
import { ipcMain, shell } from 'electron';

import { crashReportsEnabled, setCrashReportsEnabled } from '../sentry';

const logger = createLogger('app-handlers');

// Read version from package.json
// Note: After bundling, __dirname is dist-electron/, so '..' goes to desktop/
const packageJson = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8'));
const APP_VERSION = packageJson.version;

export function getAppVersion(): string {
  return APP_VERSION;
}

// Only these schemes may be handed to shell.openExternal. Email content is
// attacker-controlled, so an unrestricted openExternal could be coerced into
// opening file://, smb://, or OS-registered custom-protocol handlers. This is
// the single choke point every renderer caller funnels through.
const SAFE_EXTERNAL_SCHEMES = new Set(['http:', 'https:', 'mailto:']);

function isSafeExternalUrl(url: string): boolean {
  try {
    return SAFE_EXTERNAL_SCHEMES.has(new URL(url).protocol);
  } catch {
    return false;
  }
}

export function registerAppHandlers(): void {
  // Settings → General → Send crash reports. Applied at once and persisted for
  // the next launch (Sentry reads it before the window exists).
  ipcMain.handle('diagnostics:getCrashReports', () => ({ success: true, data: crashReportsEnabled() }));
  ipcMain.handle('diagnostics:setCrashReports', (_event, enabled: unknown) => {
    if (typeof enabled !== 'boolean') return { success: false, error: 'enabled must be a boolean' };
    try {
      setCrashReportsEnabled(enabled);
      logger.info(`[Diagnostics] crash reports ${enabled ? 'enabled' : 'disabled'}`);
      return { success: true };
    } catch (error) {
      logger.warn('[Diagnostics] crash-report preference not saved:', (error as Error).message);
      return { success: false, error: (error as Error).message };
    }
  });

  /**
   * Get app version from package.json
   */
  ipcMain.handle('app:version', () => {
    return { success: true, data: APP_VERSION };
  });

  /**
   * Open URL in default browser
   */
  ipcMain.handle('app:openExternal', async (_event, url: string) => {
    if (typeof url !== 'string' || !isSafeExternalUrl(url)) {
      logger.warn('[App] Blocked openExternal for unsafe URL scheme:', url);
      return { success: false, error: 'Unsupported URL scheme' };
    }
    try {
      await shell.openExternal(url);
      return { success: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });
}
