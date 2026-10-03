import type { ExtensionPermission } from '@sarvinbox/core';
import { ipcMain, type IpcMainInvokeEvent } from 'electron';

import { getAntivirusScanService } from '../services/antivirus-scan-service';
import { getExtensionManager, getMainWindow } from '../shared';

function authorize(event: IpcMainInvokeEvent, extensionId: string, permission: ExtensionPermission = 'security:scan-attachments'): void {
  const window = getMainWindow();
  // Only the trusted app frame may configure uploads. Sandboxed extension
  // frames get the restricted panel bridge, never this credential-bearing API.
  if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) {
    throw new Error('Scanner setup must be opened from Sarv Inbox.');
  }
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
  register('antivirus:configure', (event, id, input) => {
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
}
