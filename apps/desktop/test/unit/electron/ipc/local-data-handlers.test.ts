import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, value?: unknown) => Promise<unknown> | unknown>(),
  frame: {}, sender: { mainFrame: {} as unknown }, destroyed: vi.fn(), getWindow: vi.fn(),
  profiles: vi.fn(), erase: vi.fn(),
}));
vi.mock('electron', () => ({ ipcMain: { handle: (name: string, handler: (event: unknown, value?: unknown) => Promise<unknown>) => h.handlers.set(name, handler) } }));
vi.mock('../../../../electron/shared', () => ({ getMainWindow: h.getWindow }));
vi.mock('../../../../electron/services/local-data-reset', () => ({ getLocalDataProfiles: h.profiles, eraseLocalData: h.erase }));

import { registerLocalDataHandlers } from '../../../../electron/ipc/local-data-handlers';

const window = { webContents: h.sender, isDestroyed: h.destroyed };
const event = () => ({ sender: h.sender, senderFrame: h.frame });
const request = { profile: 'production', confirmation: 'ERASE production' };
beforeEach(() => {
  vi.resetAllMocks(); h.handlers.clear(); h.sender.mainFrame = h.frame;
  h.getWindow.mockReturnValue(window); h.destroyed.mockReturnValue(false);
  h.profiles.mockReturnValue({ currentProfile: 'production', profiles: [] });
  h.erase.mockResolvedValue({ restarting: true }); registerLocalDataHandlers();
});

describe('local reset IPC main-frame boundary', () => {
  it('registers without reading or erasing a profile', () => {
    expect([...h.handlers.keys()]).toEqual(['localData:getProfiles', 'localData:erase']);
    expect(h.profiles).not.toHaveBeenCalled(); expect(h.erase).not.toHaveBeenCalled();
  });
  it.each(['localData:getProfiles', 'localData:erase'])('blocks iframe, foreign and absent senders for %s', async channel => {
    for (const caller of [{ sender: h.sender, senderFrame: {} }, { sender: {}, senderFrame: h.frame }, { sender: h.sender }]) {
      expect(await h.handlers.get(channel)!(caller, request)).toMatchObject({ success: false });
    }
    h.destroyed.mockReturnValue(true);
    expect(await h.handlers.get(channel)!(event(), request)).toMatchObject({ success: false });
    h.getWindow.mockReturnValue(null);
    expect(await h.handlers.get(channel)!(event(), request)).toMatchObject({ success: false });
    expect(h.profiles).not.toHaveBeenCalled(); expect(h.erase).not.toHaveBeenCalled();
  });
  it('uses the trusted window as the OS prompt parent and passes only the request to the service', async () => {
    expect(await h.handlers.get('localData:erase')!(event(), request)).toEqual({ success: true, data: { restarting: true } });
    expect(h.erase).toHaveBeenCalledExactlyOnceWith(request, window);
  });
  it('reports erasure failures without converting them into success', async () => {
    h.erase.mockRejectedValue(new Error('Reset incomplete'));
    expect(await h.handlers.get('localData:erase')!(event(), request)).toEqual({ success: false, error: 'Reset incomplete' });
  });
  it('returns profile metadata and surfaces unreadable profile state', async () => {
    expect(await h.handlers.get('localData:getProfiles')!(event())).toEqual({ success: true, data: { currentProfile: 'production', profiles: [] } });
    h.profiles.mockImplementation(() => { throw new Error('Cannot inspect'); });
    expect(await h.handlers.get('localData:getProfiles')!(event())).toEqual({ success: false, error: 'Cannot inspect' });
  });
});
