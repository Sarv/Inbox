import { ipcMain } from 'electron';

import { eraseLocalData, getLocalDataProfiles } from '../services/local-data-reset';
import { getMainWindow } from '../shared';

/** Also covered by the global app-URL guard; require the exact main frame here. */
export function registerLocalDataHandlers(): void {
  const trustedWindow = (event: Electron.IpcMainInvokeEvent) => {
    const window = getMainWindow();
    return window && !window.isDestroyed() && event.sender === window.webContents
      && event.senderFrame === window.webContents.mainFrame ? window : null;
  };
  ipcMain.handle('localData:getProfiles', (event) => {
    if (!trustedWindow(event)) return { success: false, error: 'Local data settings must be opened in the main Inbox window.' };
    try { return { success: true, data: getLocalDataProfiles() }; }
    catch (error) { return { success: false, error: error instanceof Error ? error.message : 'Local profiles could not be checked.' }; }
  });
  ipcMain.handle('localData:erase', async (event, request: unknown) => {
    const window = trustedWindow(event);
    if (!window) return { success: false, error: 'Local data settings must be opened in the main Inbox window.' };
    try { return { success: true, data: await eraseLocalData(request, window) }; }
    catch (error) { return { success: false, error: error instanceof Error ? error.message : 'Local data could not be erased.' }; }
  });
}
