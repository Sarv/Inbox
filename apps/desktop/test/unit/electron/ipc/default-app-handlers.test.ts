import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, value?: unknown) => Promise<unknown>>(),
  frame: {}, sender: { mainFrame: {} as unknown }, getWindow: vi.fn(),
  getService: vi.fn(), getQueue: vi.fn(),
  service: { getStatus: vi.fn(), requestDefault: vi.fn(), openSettings: vi.fn(), setPromptSuppressed: vi.fn() },
  queue: { getPendingOpen: vi.fn(), acknowledgeOpen: vi.fn() },
}));
vi.mock('electron', () => ({ ipcMain: { handle: (name: string, handler: (event: unknown, value?: unknown) => Promise<unknown>) => h.handlers.set(name, handler) } }));
vi.mock('../../../../electron/shared', () => ({ getMainWindow: h.getWindow }));
vi.mock('../../../../electron/services/default-app-service', () => ({ getDefaultAppService: h.getService }));
vi.mock('../../../../electron/services/external-open-service', () => ({ getExternalOpenService: h.getQueue }));

import { registerDefaultAppHandlers } from '../../../../electron/ipc/default-app-handlers';

const routes = [
  { channel: 'defaultApps:getStatus', owner: 'service', method: 'getStatus', input: undefined, output: { shouldPrompt: true } },
  { channel: 'defaultApps:requestDefault', owner: 'service', method: 'requestDefault', input: 'calendar', output: { outcome: 'requested' } },
  { channel: 'defaultApps:openSettings', owner: 'service', method: 'openSettings', input: undefined, output: { opened: true } },
  { channel: 'defaultApps:setPromptSuppressed', owner: 'service', method: 'setPromptSuppressed', input: true, output: { suppressPrompt: true } },
  { channel: 'defaultApps:getPendingOpen', owner: 'queue', method: 'getPendingOpen', input: undefined, output: { id: 'launch', kind: 'compose' } },
  { channel: 'defaultApps:acknowledgeOpen', owner: 'queue', method: 'acknowledgeOpen', input: 'launch', output: null },
] as const;
const request = () => ({ sender: h.sender, senderFrame: h.frame });
const handler = (channel: string) => h.handlers.get(channel)!;
const operation = (route: typeof routes[number]) => route.owner === 'service' ? h.service[route.method as keyof typeof h.service] : h.queue[route.method as keyof typeof h.queue];

beforeEach(() => {
  vi.resetAllMocks(); h.handlers.clear(); h.sender.mainFrame = h.frame;
  h.getWindow.mockReturnValue({ webContents: h.sender }); h.getService.mockReturnValue(h.service); h.getQueue.mockReturnValue(h.queue);
  for (const route of routes) operation(route).mockReturnValue(route.output);
  registerDefaultAppHandlers();
});

describe('default app main-frame IPC boundary', () => {
  it('registers without checking or changing native defaults, opening data or reading pending payloads', () => {
    expect([...h.handlers.keys()]).toEqual(routes.map(route => route.channel));
    expect(h.getService).not.toHaveBeenCalled(); expect(h.getQueue).not.toHaveBeenCalled(); expect(h.getWindow).not.toHaveBeenCalled();
  });

  it.each(routes)('blocks iframe, foreign window and missing window callers for $channel', async route => {
    for (const event of [{ sender: h.sender, senderFrame: {} }, { sender: {}, senderFrame: h.frame }, { sender: h.sender, senderFrame: undefined }]) {
      expect(await handler(route.channel)(event, route.input)).toEqual({ success: false, error: 'Default application requests must come from the main Sarv Inbox window.' });
    }
    h.getWindow.mockReturnValue(null);
    expect(await handler(route.channel)(request(), route.input)).toMatchObject({ success: false });
    expect(h.getService).not.toHaveBeenCalled(); expect(h.getQueue).not.toHaveBeenCalled(); expect(operation(route)).not.toHaveBeenCalled();
  });

  it.each(routes)('returns exact results from $channel', async route => {
    expect(await handler(route.channel)(request(), route.input)).toEqual({ success: true, data: route.output });
    if (route.input === undefined && ['getStatus', 'getPendingOpen'].includes(route.method)) expect(operation(route)).toHaveBeenCalledExactlyOnceWith();
    else expect(operation(route)).toHaveBeenCalledExactlyOnceWith(route.input);
  });

  it.each(routes)('reports rejected native/store/queue operations for $channel', async route => {
    operation(route).mockRejectedValueOnce(new Error('Synthetic operation failed'));
    expect(await handler(route.channel)(request(), route.input)).toEqual({ success: false, error: 'Synthetic operation failed' });
  });

  it('does not expose a renderer API for enqueueing arbitrary local files or native links', () => {
    expect([...h.handlers.keys()].some(channel => /enqueue|openFile|openUrl/i.test(channel))).toBe(false);
  });
});
