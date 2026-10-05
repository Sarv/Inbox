import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => Promise<any>>(),
  frame: {}, sender: {} as { mainFrame?: unknown }, permissions: ['security:scan-attachments'] as string[], active: true,
  service: { getTrustedSetup: vi.fn(), probe: vi.fn(), configure: vi.fn(), onExtensionDisabled: vi.fn() },
  warning: { snapshot: vi.fn(), respond: vi.fn(), read: vi.fn(), reset: vi.fn() },
  registeredAccounts: [{ id: 'account-a' }, { id: 'account-b' }],
  requireAccount: vi.fn(),
  onboarding: { setup: vi.fn(), connect: vi.fn(), complete: vi.fn(), cancel: vi.fn() },
}));

vi.mock('electron', () => ({ ipcMain: { handle: (channel: string, handler: (...args: any[]) => Promise<any>) => h.handlers.set(channel, handler) } }));
vi.mock('../../../../electron/shared', () => ({
  getMainWindow: () => ({ webContents: h.sender }),
  getExtensionManager: () => ({ getRegistry: () => ({ get: (id: string) => id === 'clamav-scan' ? { grantedPermissions: h.permissions } : undefined }), getHost: () => ({ isActive: () => h.active }) }),
}));
vi.mock('../../../../electron/services/antivirus-scan-service', () => ({ getAntivirusScanService: () => h.service }));
vi.mock('../../../../electron/services/attachment-unscanned-warning', () => ({ getPendingUnscannedAttachmentWarning: h.warning.snapshot, respondUnscannedAttachmentWarning: h.warning.respond }));
vi.mock('../../../../electron/services/attachment-warning-preferences', () => ({ unscannedWarningPreferences: { read: h.warning.read, reset: h.warning.reset } }));
vi.mock('../../../../electron/services/accounts-registry', () => ({ readRegistryAccounts: () => h.registeredAccounts }));
vi.mock('../../../../electron/services/account-target', () => ({ requireTargetAccountId: h.requireAccount }));
vi.mock('../../../../electron/services/antivirus-onboarding', () => ({
  getOnboardingScannerSetup: h.onboarding.setup, connectSarvScannerOAuth: h.onboarding.connect,
  completeSarvScannerOAuth: h.onboarding.complete, cancelSarvScannerOAuth: h.onboarding.cancel,
}));

import { registerAntivirusHandlers } from '../../../../electron/ipc/antivirus-handlers';

const trusted = () => ({ sender: h.sender, senderFrame: h.frame });
const call = (channel: string, event: unknown, ...args: unknown[]) => h.handlers.get(channel)!(event, 'clamav-scan', ...args);
const callWarning = (channel: string, event: unknown, ...args: unknown[]) => h.handlers.get(channel)!(event, ...args);

beforeEach(() => {
  vi.resetAllMocks(); h.handlers.clear(); h.sender = { mainFrame: h.frame }; h.permissions = ['security:scan-attachments']; h.active = true;
  h.service.getTrustedSetup.mockResolvedValue({ configured: false, accounts: [] });
  h.service.probe.mockResolvedValue({ challenge: 'synthetic-challenge', setup: {} });
  h.warning.snapshot.mockReturnValue(null); h.warning.respond.mockResolvedValue(undefined); h.warning.read.mockReturnValue(false);
  h.requireAccount.mockImplementation((id: string) => { if (!h.registeredAccounts.some(account => account.id === id)) throw new Error('The attachment account is unavailable.'); return id; });
  registerAntivirusHandlers();
});

describe('trusted optional scanner onboarding IPC', () => {
  // Regression: extension frames could silently install scanner code or create reusable scanning credentials.
  it.each(['antivirus:getOnboardingSetup', 'antivirus:connectSarvOAuth', 'antivirus:completeSarvOAuth', 'antivirus:cancelSarvOAuth'])('blocks foreign frames for %s', async channel => {
    for (const event of [{ sender: h.sender, senderFrame: {} }, { sender: {}, senderFrame: h.frame }]) {
      expect(await callWarning(channel, event, 'account-a')).toMatchObject({ success: false, error: expect.stringContaining('Sarv Inbox') });
    }
    for (const method of Object.values(h.onboarding)) expect(method).not.toHaveBeenCalled();
  });

  // Regression: a fresh profile needs a trusted installation entry point without weakening sandbox extension permissions.
  it('allows setup inspection and explicit sign-in in the main frame even before the extension is installed', async () => {
    h.active = false; h.permissions = [];
    h.onboarding.setup.mockResolvedValue({ configured: false });
    expect(await callWarning('antivirus:getOnboardingSetup', trusted())).toEqual({ success: true, data: { configured: false } });
    expect(await callWarning('antivirus:connectSarvOAuth', trusted(), 'account-b')).toMatchObject({ success: true });
    expect(h.requireAccount).toHaveBeenCalledWith('account-b'); expect(h.onboarding.connect).toHaveBeenCalledWith('account-b');
    expect(await callWarning('antivirus:cancelSarvOAuth', trusted())).toMatchObject({ success: true });
    expect(h.onboarding.cancel).toHaveBeenCalledOnce();
  });

  // Regression: native OAuth transactions must bind to an existing explicit mailbox and actual attachment consent.
  it('validates account, opaque challenge and privacy consent before finalization', async () => {
    for (const value of [undefined, '', 42, 'x'.repeat(129), 'removed-account']) {
      expect(await callWarning('antivirus:connectSarvOAuth', trusted(), value)).toMatchObject({ success: false });
    }
    for (const value of [undefined, 42, {}, { challenge: '', accountId: 'account-a', attachmentConsent: true },
      { challenge: 'x'.repeat(129), accountId: 'account-a', attachmentConsent: true },
      { challenge: 'challenge', accountId: 'account-a', attachmentConsent: false },
      { challenge: 'challenge', accountId: 'removed-account', attachmentConsent: true }]) {
      expect(await callWarning('antivirus:completeSarvOAuth', trusted(), value)).toMatchObject({ success: false });
    }
    expect(h.onboarding.connect).not.toHaveBeenCalled(); expect(h.onboarding.complete).not.toHaveBeenCalled();
    const request = { challenge: 'synthetic-challenge', accountId: 'account-a', attachmentConsent: true };
    expect(await callWarning('antivirus:completeSarvOAuth', trusted(), request)).toMatchObject({ success: true });
    expect(h.onboarding.complete).toHaveBeenCalledWith(request);
  });
});

// Breaks: extension/secondary frames answer warnings or change remembered decisions, or reset follows the active mailbox.
describe('trusted custom antivirus warning IPC', () => {
  it.each(['antivirus:getPendingUnscannedWarning', 'antivirus:respondUnscannedWarning', 'antivirus:getUnscannedWarningPreferences', 'antivirus:resetUnscannedWarningPreference'])('rejects foreign frames and windows for %s', async channel => {
    for (const event of [{ sender: h.sender, senderFrame: {} }, { sender: { mainFrame: h.frame }, senderFrame: h.frame }]) {
      expect(await callWarning(channel, event, 'account-a')).toMatchObject({ success: false, error: expect.stringContaining('Sarv Inbox') });
    }
    expect(h.warning.snapshot).not.toHaveBeenCalled(); expect(h.warning.respond).not.toHaveBeenCalled();
    expect(h.warning.read).not.toHaveBeenCalled(); expect(h.warning.reset).not.toHaveBeenCalled();
  });

  it('recovers the host-owned active popup and forwards only an opaque response through the trusted main frame', async () => {
    const payload = { id: 'synthetic-opaque-id', filename: 'arakiri_A_50186774_/_3.pdf', accountId: 'account-b', action: 'view' };
    h.warning.snapshot.mockReturnValue(payload); h.active = false; h.permissions = [];
    expect(await callWarning('antivirus:getPendingUnscannedWarning', trusted())).toEqual({ success: true, data: payload });
    const response = { id: payload.id, choice: 'continue', dontShowAgain: true };
    expect(await callWarning('antivirus:respondUnscannedWarning', trusted(), response)).toMatchObject({ success: true });
    expect(h.warning.respond).toHaveBeenCalledWith(response);
    h.warning.respond.mockRejectedValue(new Error('This antivirus warning is no longer available.'));
    expect(await callWarning('antivirus:respondUnscannedWarning', trusted(), response)).toMatchObject({ success: false, error: expect.stringContaining('no longer available') });
  });

  it('lists suppression only for registered accounts and resets an explicit account without scanner permission', async () => {
    h.warning.read.mockImplementation((id: string) => id === 'account-b'); h.active = false; h.permissions = [];
    expect(await callWarning('antivirus:getUnscannedWarningPreferences', trusted())).toEqual({ success: true, data: { suppressedAccountIds: ['account-b'] } });
    expect(await callWarning('antivirus:resetUnscannedWarningPreference', trusted(), 'account-b')).toMatchObject({ success: true });
    expect(h.requireAccount).toHaveBeenCalledWith('account-b'); expect(h.warning.reset).toHaveBeenCalledWith('account-b');
    h.warning.reset.mockClear();
    for (const accountId of [undefined, '', 42, 'removed-account']) {
      expect(await callWarning('antivirus:resetUnscannedWarningPreference', trusted(), accountId)).toMatchObject({ success: false });
    }
    expect(h.warning.reset).not.toHaveBeenCalled();
  });

  it('surfaces broken preference stores and non-Error failures instead of silently bypassing warnings', async () => {
    h.warning.read.mockImplementation(() => { throw new Error('Store unreadable'); });
    expect(await callWarning('antivirus:getUnscannedWarningPreferences', trusted())).toMatchObject({ success: false, error: 'Store unreadable' });
    h.warning.reset.mockImplementation(() => { throw null; });
    expect(await callWarning('antivirus:resetUnscannedWarningPreference', trusted(), 'account-b')).toMatchObject({ success: false, error: 'The antivirus warning could not be updated.' });
  });
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
