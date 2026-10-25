import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ElectronAPI } from '../../../../electron/preload';

const h = vi.hoisted(() => ({ api: null as ElectronAPI | null, invoke: vi.fn() }));
vi.mock('@sentry/electron/preload', () => ({}));
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: (_name: string, api: ElectronAPI) => { h.api = api; } },
  ipcRenderer: { invoke: h.invoke, on: vi.fn(), removeListener: vi.fn() }, webFrame: {},
}));
import '../../../../electron/preload';

beforeEach(() => { h.invoke.mockReset().mockResolvedValue({ success: true, data: [] }); });

describe('agent proposal bridge', () => {
  it('passes a named source owner through the existing proposal channel', async () => {
    await h.api!.agent.getProposals('secondary');
    expect(h.invoke).toHaveBeenCalledExactlyOnceWith('agent:getProposals', 'secondary');
  });

  it('keeps the no-argument active-account contract', async () => {
    await h.api!.agent.getProposals();
    expect(h.invoke).toHaveBeenCalledExactlyOnceWith('agent:getProposals');
  });
});
