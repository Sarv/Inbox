import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => Promise<any>>(),
  frame: {}, sender: {} as { mainFrame?: unknown }, permissions: ['security:scan-attachments'] as string[], active: true,
  service: { getTrustedSetup: vi.fn(), probe: vi.fn(), configure: vi.fn(), onExtensionDisabled: vi.fn() },
}));

vi.mock('electron', () => ({ ipcMain: { handle: (channel: string, handler: (...args: any[]) => Promise<any>) => h.handlers.set(channel, handler) } }));
vi.mock('../../../../electron/shared', () => ({
  getMainWindow: () => ({ webContents: h.sender }),
  getExtensionManager: () => ({ getRegistry: () => ({ get: (id: string) => id === 'clamav-scan' ? { grantedPermissions: h.permissions } : undefined }), getHost: () => ({ isActive: () => h.active }) }),
}));
vi.mock('../../../../electron/services/antivirus-scan-service', () => ({ getAntivirusScanService: () => h.service }));

import { registerAntivirusHandlers } from '../../../../electron/ipc/antivirus-handlers';

const trusted = () => ({ sender: h.sender, senderFrame: h.frame });
const call = (channel: string, event: unknown, ...args: unknown[]) => h.handlers.get(channel)!(event, 'clamav-scan', ...args);

beforeEach(() => {
  vi.resetAllMocks(); h.handlers.clear(); h.sender = { mainFrame: h.frame }; h.permissions = ['security:scan-attachments']; h.active = true;
  h.service.getTrustedSetup.mockResolvedValue({ configured: false, accounts: [] });
  h.service.probe.mockResolvedValue({ challenge: 'synthetic-challenge', setup: {} });
  registerAntivirusHandlers();
});

describe('trusted antivirus setup IPC', () => {
  it('permits setup details only in the current main app frame', async () => {
    expect(await call('antivirus:getSetup', trusted())).toEqual({ success: true, data: { configured: false, accounts: [] } });
    expect(h.service.getTrustedSetup).toHaveBeenCalledWith('clamav-scan');
    h.service.getTrustedSetup.mockClear();
    expect(await call('antivirus:getSetup', { sender: h.sender, senderFrame: {} })).toMatchObject({ success: false, error: expect.stringMatching(/Sarv Inbox/) });
    expect(await call('antivirus:getSetup', { sender: { mainFrame: h.frame }, senderFrame: h.frame })).toMatchObject({ success: false });
    expect(h.service.getTrustedSetup).not.toHaveBeenCalled();
  });

  it.each(['disabled', 'permission-revoked'] as const)('rejects %s extensions before touching credentials', async state => {
    if (state === 'disabled') h.active = false; else h.permissions = [];
    expect(await call('antivirus:probe', trusted(), 'https://scanner.test', 'synthetic-test-key')).toMatchObject({ success: false, error: expect.stringMatching(/inactive or lacks/) });
    expect(h.service.probe).not.toHaveBeenCalled();
  });

  it('requires a separately granted body permission for body consent', async () => {
    const input = { challenge: 'synthetic-challenge', allowedAccountIds: ['account-b'], allowBody: true, attachmentConsent: true, bodyConsent: true };
    expect(await call('antivirus:configure', trusted(), input)).toMatchObject({ success: false });
    expect(h.service.configure).not.toHaveBeenCalled();
    h.permissions.push('security:scan-body');
    expect(await call('antivirus:configure', trusted(), input)).toMatchObject({ success: true });
    expect(h.service.configure).toHaveBeenCalledWith('clamav-scan', input);
  });

  it('rejects oversized and non-string endpoint or credential input', async () => {
    for (const args of [[{}, 'synthetic-test-key'], ['https://scanner.test', {}], ['x'.repeat(2049), 'synthetic-test-key'], ['https://scanner.test', 'x'.repeat(8193)]]) {
      expect(await call('antivirus:probe', trusted(), ...args)).toMatchObject({ success: false });
    }
    expect(h.service.probe).not.toHaveBeenCalled();
    expect(await call('antivirus:configure', trusted(), { challenge: 12, allowBody: false })).toMatchObject({ success: false });
    expect(h.service.configure).not.toHaveBeenCalled();
  });

  it('revokes saved consent through the host when disabled from setup', async () => {
    expect(await call('antivirus:disable', trusted())).toMatchObject({ success: true });
    expect(h.service.onExtensionDisabled).toHaveBeenCalledWith('clamav-scan');
  });
});
