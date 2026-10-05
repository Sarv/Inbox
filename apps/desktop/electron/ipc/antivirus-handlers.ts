import type { ExtensionPermission } from '@sarvinbox/core';
import { ipcMain, type IpcMainInvokeEvent } from 'electron';

import { requireTargetAccountId } from '../services/account-target';
import { readRegistryAccounts } from '../services/accounts-registry';
import { cancelSarvScannerOAuth, completeSarvScannerOAuth, connectSarvScannerOAuth, getOnboardingScannerSetup } from '../services/antivirus-onboarding';
import { getAntivirusScanService } from '../services/antivirus-scan-service';
import { getPendingUnscannedAttachmentWarning, respondUnscannedAttachmentWarning } from '../services/attachment-unscanned-warning';
import { unscannedWarningPreferences } from '../services/attachment-warning-preferences';
import { getExtensionManager, getMainWindow } from '../shared';

function authorizeWindow(event: IpcMainInvokeEvent): void {
  const window = getMainWindow();
  // Only the trusted app frame may configure uploads. Sandboxed extension
  // frames get the restricted panel bridge, never this credential-bearing API.
  if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) {
    throw new Error('Scanner setup must be opened from Sarv Inbox.');
  }
}

function authorize(event: IpcMainInvokeEvent, extensionId: string, permission: ExtensionPermission = 'security:scan-attachments'): void {
  authorizeWindow(event);
  const manager = getExtensionManager();
  const installed = typeof extensionId === 'string' ? manager?.getRegistry().get(extensionId) : undefined;
  if (!installed || !manager?.getHost().isActive(extensionId) || !installed.grantedPermissions.includes(permission)) {
    throw new Error('This extension is inactive or lacks the scanner permission.');
  }
}

export function registerAntivirusHandlers(): void {
  const register = (channel: string, run: (event: IpcMainInvokeEvent, id: string, ...args: any[]) => Promise<unknown>) => {
    ipcMain.handle(channel, async (event, id, ...args) => {
      try { authorize(event, id); return { success: true, data: await run(event, id, ...args) }; }
      catch (error) { return { success: false, error: error instanceof Error ? error.message : 'Scanner setup failed.' }; }
    });
  };
  register('antivirus:getSetup', (_event, id) => getAntivirusScanService().getTrustedSetup(id));
  register('antivirus:probe', (_event, id, endpoint, credential) => {
    if (typeof endpoint !== 'string' || endpoint.length > 2048 || (credential !== undefined && (typeof credential !== 'string' || credential.length > 8192))) {
      throw new Error('Provide a valid scanner address and credential.');
    }
    return getAntivirusScanService().probe(id, endpoint, credential);
  });
  register('antivirus:configure', async (event, id, input) => {
    if (!input || typeof input !== 'object' || typeof input.challenge !== 'string' || typeof input.allowBody !== 'boolean') {
      throw new Error('Review scanner setup before enabling uploads.');
    }
    if (input.allowBody) authorize(event, id, 'security:scan-body');
    return getAntivirusScanService().configure(id, input);
  });
  register('antivirus:disable', async (_event, id) => {
    await getAntivirusScanService().onExtensionDisabled(id);
    return getAntivirusScanService().getTrustedSetup(id);
  });

  const registerWarning = (channel: string, run: (...args: unknown[]) => Promise<unknown> | unknown) => {
    ipcMain.handle(channel, async (event, ...args) => {
      try { authorizeWindow(event); return { success: true, data: await run(...args) }; }
      catch (error) { return { success: false, error: error instanceof Error ? error.message : 'The antivirus warning could not be updated.' }; }
    });
  };
  registerWarning('antivirus:getPendingUnscannedWarning', getPendingUnscannedAttachmentWarning);
  registerWarning('antivirus:respondUnscannedWarning', respondUnscannedAttachmentWarning);
  registerWarning('antivirus:getUnscannedWarningPreferences', () => ({
    suppressedAccountIds: readRegistryAccounts().filter(account => unscannedWarningPreferences.read(account.id)).map(account => account.id),
  }));
  registerWarning('antivirus:resetUnscannedWarningPreference', (accountId: unknown) => {
    if (typeof accountId !== 'string' || !accountId) throw new Error('The attachment account is unavailable.');
    const targetAccountId = requireTargetAccountId(accountId);
    unscannedWarningPreferences.reset(targetAccountId);
  });

  // Optional first-run installation and credentials belong only to the trusted app frame.
  registerWarning('antivirus:getOnboardingSetup', getOnboardingScannerSetup);
  registerWarning('antivirus:connectSarvOAuth', (accountId: unknown) => {
    if (typeof accountId !== 'string' || !accountId || accountId.length > 128) throw new Error('Connect a mailbox before setting up antivirus.');
    requireTargetAccountId(accountId);
    return connectSarvScannerOAuth(accountId);
  });
  registerWarning('antivirus:completeSarvOAuth', (input: unknown) => {
    if (!input || typeof input !== 'object') throw new Error('Review scanner privacy terms before enabling antivirus.');
    const request = input as { challenge?: unknown; accountId?: unknown; attachmentConsent?: unknown };
    if (typeof request.challenge !== 'string' || !request.challenge || request.challenge.length > 128 ||
      typeof request.accountId !== 'string' || !request.accountId || request.accountId.length > 128 || request.attachmentConsent !== true) {
      throw new Error('Review scanner privacy terms and select a mailbox before enabling antivirus.');
    }
    requireTargetAccountId(request.accountId);
    return completeSarvScannerOAuth({ challenge: request.challenge, accountId: request.accountId, attachmentConsent: true });
  });
  registerWarning('antivirus:cancelSarvOAuth', cancelSarvScannerOAuth);
}
