import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type { AntivirusSetupStatus, ExtensionPermission } from '@sarvinbox/core';
import { app, shell } from 'electron';

import { getExtensionManager } from '../shared';
import { isDevBuild } from '../utils/dev-mode';

import { readRegistryAccounts } from './accounts-registry';
import { requireScannerSecureStorage } from './antivirus-desktop-backend';
import { AntivirusOAuthService, SARV_SCANNER_EXTENSION_ID } from './antivirus-oauth-service';
import { getAntivirusScanService } from './antivirus-scan-service';

const granted: ExtensionPermission[] = ['ui:panel', 'security:scan-attachments'];

/** Install the shipped scanner only on an explicit connection action; never restore revoked permissions silently. */
export async function prepareBundledAntivirusExtension(): Promise<void> {
  const manager = getExtensionManager();
  if (!manager) throw new Error('Extensions are not ready. Retry scanner setup or skip for now.');
  const registry = manager.getRegistry();
  const existing = registry.get(SARV_SCANNER_EXTENSION_ID);
  if (existing) {
    if (!granted.every(permission => existing.grantedPermissions.includes(permission))) {
      throw new Error('Scanner permissions were changed. Review the ClamAV extension in Extensions settings, or skip for now.');
    }
    if (!manager.getHost().isActive(SARV_SCANNER_EXTENSION_ID)) await manager.enableExtension(SARV_SCANNER_EXTENSION_ID);
    return;
  }
  const source = isDevBuild() ? path.resolve(app.getAppPath(), '../../extensions/clamav-scan')
    : path.join(process.resourcesPath, 'optional-extensions', 'clamav-scan');
  let manifest: { id?: unknown; permissions?: unknown; main?: unknown };
  try { manifest = JSON.parse(await readFile(path.join(source, 'sarvinbox-extension.json'), 'utf8')); }
  catch { throw new Error('The optional antivirus extension is missing from this app. Update Inbox or skip for now.'); }
  const permissions = manifest?.permissions;
  if (!manifest || manifest.id !== SARV_SCANNER_EXTENSION_ID || manifest.main !== 'index.js' ||
    !Array.isArray(permissions) || !granted.every(permission => permissions.includes(permission)) ||
    permissions.some(permission => ![...granted, 'security:scan-body'].includes(permission))) {
    throw new Error('The bundled antivirus extension has unexpected permissions. Update Inbox or skip for now.');
  }
  // Approved permissions are persisted atomically before the host receives any context.
  await registry.install(source, granted);
  try {
    await manager.enableExtension(SARV_SCANNER_EXTENSION_ID);
  } catch (error) {
    await registry.grantPermissions(SARV_SCANNER_EXTENSION_ID, []).catch(() => {});
    await registry.disable(SARV_SCANNER_EXTENSION_ID).catch(() => {});
    throw error;
  }
}

function assertAuthorized(accountId: string): void {
  const manager = getExtensionManager();
  const extension = manager?.getRegistry().get(SARV_SCANNER_EXTENSION_ID);
  if (!extension || !manager?.getHost().isActive(SARV_SCANNER_EXTENSION_ID) ||
    !extension.grantedPermissions.includes('security:scan-attachments')) {
    throw new Error('The antivirus extension is inactive or its scanner permission was revoked.');
  }
  if (typeof accountId !== 'string' || !accountId || !readRegistryAccounts().some(account => account.id === accountId)) {
    throw new Error('The mailbox for scanner sharing is unavailable. Reconnect email before enabling antivirus.');
  }
}

const oauth = new AntivirusOAuthService({
  scanService: getAntivirusScanService,
  prepareExtension: prepareBundledAntivirusExtension,
  assertAuthorized,
  assertSecureStorage: requireScannerSecureStorage,
  openExternal: url => shell.openExternal(url),
});

export async function getOnboardingScannerSetup(): Promise<AntivirusSetupStatus> {
  const setup = await getAntivirusScanService().getTrustedSetup(SARV_SCANNER_EXTENSION_ID);
  const manager = getExtensionManager();
  const extension = manager?.getRegistry().get(SARV_SCANNER_EXTENSION_ID);
  return { ...setup, enabled: setup.enabled && Boolean(extension?.grantedPermissions.includes('security:scan-attachments') &&
    manager?.getHost().isActive(SARV_SCANNER_EXTENSION_ID)) };
}

export const connectSarvScannerOAuth = (accountId: string) => oauth.connect(accountId);
export const completeSarvScannerOAuth = (input: { challenge: string; accountId: string; attachmentConsent: boolean }) => oauth.complete(input);
export const cancelSarvScannerOAuth = () => oauth.cancel();
