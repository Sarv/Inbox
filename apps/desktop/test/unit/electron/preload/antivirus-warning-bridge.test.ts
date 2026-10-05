import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ElectronAPI, UnscannedWarningRequest } from '../../../../electron/preload';

const h = vi.hoisted(() => ({
  api: null as ElectronAPI | null,
  invoke: vi.fn(),
  listeners: new Map<string, (_event: unknown, payload: unknown) => void>(),
  remove: vi.fn(),
}));
vi.mock('@sentry/electron/preload', () => ({}));
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: (_key: string, api: ElectronAPI) => { h.api = api; } },
  ipcRenderer: {
    invoke: h.invoke,
    on: (channel: string, listener: (_event: unknown, payload: unknown) => void) => h.listeners.set(channel, listener),
    removeListener: (channel: string, listener: unknown) => { h.remove(channel, listener); h.listeners.delete(channel); },
  },
  webFrame: {},
}));

import '../../../../electron/preload';

beforeEach(() => { h.invoke.mockReset().mockResolvedValue({ success: true }); h.listeners.clear(); h.remove.mockReset(); });

// Breaks: bridge callbacks truncate MIME filenames, leak Electron events, use wrong channels, or leave stale warning subscribers attached.
describe('trusted antivirus warning preload bridge', () => {
  it('passes exact host warning metadata and only the closed ID to app callbacks and unsubscribes both', () => {
    const warning = vi.fn(); const closed = vi.fn();
    const stopWarning = h.api!.antivirus.onUnscannedWarning(warning);
    const stopClosed = h.api!.antivirus.onUnscannedWarningClosed(closed);
    const payload: UnscannedWarningRequest = { id: 'synthetic-warning', filename: 'arakiri_A_50186774_/_3.pdf', accountId: 'account-b', action: 'view' };
    h.listeners.get('antivirus:unscannedWarning')!({ sender: 'untrusted-event' }, payload);
    h.listeners.get('antivirus:unscannedWarningClosed')!({}, payload.id);
    expect(warning).toHaveBeenCalledExactlyOnceWith(payload); expect(closed).toHaveBeenCalledExactlyOnceWith(payload.id);
    stopWarning(); stopClosed();
    expect(h.remove).toHaveBeenCalledTimes(2); expect(h.listeners.size).toBe(0);
  });

  it('uses explicit trusted channels for response, pending recovery and account preference reset', async () => {
    const response = { id: 'synthetic-warning', choice: 'continue' as const, dontShowAgain: true };
    await h.api!.antivirus.respondUnscannedWarning(response);
    await h.api!.antivirus.getPendingUnscannedWarning();
    await h.api!.antivirus.getUnscannedWarningPreferences();
    await h.api!.antivirus.resetUnscannedWarningPreference('account-b');
    expect(h.invoke.mock.calls).toEqual([
      ['antivirus:respondUnscannedWarning', response], ['antivirus:getPendingUnscannedWarning'],
      ['antivirus:getUnscannedWarningPreferences'], ['antivirus:resetUnscannedWarningPreference', 'account-b'],
    ]);
  });
});
