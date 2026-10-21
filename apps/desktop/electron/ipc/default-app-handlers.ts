import { ipcMain, type IpcMainInvokeEvent } from 'electron';

import { getDefaultAppService } from '../services/default-app-service';
import { getExternalOpenService } from '../services/external-open-service';
import { getMainWindow } from '../shared';

function authorize(event: IpcMainInvokeEvent): void {
  const window = getMainWindow();
  if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) {
    throw new Error('Default application requests must come from the main Sarv Inbox window.');
  }
}

export function registerDefaultAppHandlers(): void {
  const register = (channel: string, run: (value: unknown) => unknown) => {
    ipcMain.handle(channel, async (event, value: unknown) => {
      try { authorize(event); return { success: true, data: await run(value) }; }
      catch (error) { return { success: false, error: error instanceof Error ? error.message : 'The application request could not be completed.' }; }
    });
  };
  register('defaultApps:getStatus', () => getDefaultAppService().getStatus());
  register('defaultApps:requestDefault', target => getDefaultAppService().requestDefault(target));
  register('defaultApps:openSettings', target => getDefaultAppService().openSettings(target));
  register('defaultApps:setPromptSuppressed', value => getDefaultAppService().setPromptSuppressed(value));
  register('defaultApps:getPendingOpen', () => getExternalOpenService().getPendingOpen());
  register('defaultApps:acknowledgeOpen', value => getExternalOpenService().acknowledgeOpen(value));
}
