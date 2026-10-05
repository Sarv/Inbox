import path from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  readFile: vi.fn(), installed: null as null | { grantedPermissions: string[] }, active: false, managerAvailable: true,
  install: vi.fn(), grant: vi.fn(), enable: vi.fn(), disable: vi.fn(), getSetup: vi.fn(), isPackaged: false,
  prepare: vi.fn(), secure: vi.fn(), resourcesPath: '/synthetic/resources',
  dependencies: null as null | { scanService(): unknown; prepareExtension(): Promise<void>; assertAuthorized(accountId: string): void; assertSecureStorage(): void; openExternal(url: string): Promise<unknown> },
  oauth: { connect: vi.fn(), complete: vi.fn(), cancel: vi.fn() }, openExternal: vi.fn(),
}));
vi.mock('node:fs/promises', () => ({ readFile: h.readFile }));
vi.mock('electron', () => ({ app: { get isPackaged() { return h.isPackaged; }, getAppPath: () => '/synthetic/Inbox/apps/desktop' }, shell: { openExternal: h.openExternal } }));
vi.mock('../../../../electron/shared', () => ({ getExtensionManager: () => h.managerAvailable ? {
  getRegistry: () => ({ get: () => h.installed, install: h.install, grantPermissions: h.grant, disable: h.disable }),
  getHost: () => ({ isActive: () => h.active }), enableExtension: h.enable,
} : null }));
vi.mock('../../../../electron/services/accounts-registry', () => ({ readRegistryAccounts: () => [{ id: 'account-a' }] }));
vi.mock('../../../../electron/services/antivirus-desktop-backend', () => ({ requireScannerSecureStorage: h.secure }));
vi.mock('../../../../electron/services/antivirus-scan-service', () => ({ getAntivirusScanService: () => ({ getTrustedSetup: h.getSetup }) }));
vi.mock('../../../../electron/services/antivirus-oauth-service', () => ({ SARV_SCANNER_EXTENSION_ID: 'clamav-scan', AntivirusOAuthService: class {
  constructor(dependencies: NonNullable<typeof h.dependencies>) { h.dependencies = dependencies; }
  connect = h.oauth.connect; complete = h.oauth.complete; cancel = h.oauth.cancel;
} }));

import { cancelSarvScannerOAuth, completeSarvScannerOAuth, connectSarvScannerOAuth, getOnboardingScannerSetup, prepareBundledAntivirusExtension } from '../../../../electron/services/antivirus-onboarding';

const manifest = { id: 'clamav-scan', main: 'index.js', permissions: ['ui:panel', 'security:scan-attachments', 'security:scan-body'] };

beforeEach(() => {
  vi.resetAllMocks(); h.installed = null; h.active = false; h.isPackaged = false; h.managerAvailable = true;
  h.readFile.mockResolvedValue(JSON.stringify(manifest));
  h.install.mockResolvedValue({ id: 'clamav-scan' }); h.grant.mockResolvedValue(undefined); h.enable.mockResolvedValue(undefined); h.disable.mockResolvedValue(undefined);
  h.getSetup.mockResolvedValue({ configured: false, enabled: false, allowedAccountIds: [], allowBody: false });
  vi.stubEnv('VITE_DEV_SERVER_URL', undefined);
});

describe('optional trusted bundled scanner installation', () => {
  // Regression: new users could not connect the optional scanner because it was only available through folder installation.
  it('installs the bundled extension on request and narrows permissions before activation', async () => {
    await prepareBundledAntivirusExtension();
    expect(h.readFile).toHaveBeenCalledWith(path.resolve('/synthetic/Inbox/extensions/clamav-scan/sarvinbox-extension.json'), 'utf8');
    expect(h.install).toHaveBeenCalledWith(path.resolve('/synthetic/Inbox/extensions/clamav-scan'), ['ui:panel', 'security:scan-attachments']);
    expect(h.grant).not.toHaveBeenCalled();
    expect(h.enable).toHaveBeenCalledWith('clamav-scan');
    expect(h.install.mock.invocationCallOrder[0]).toBeLessThan(h.enable.mock.invocationCallOrder[0]);
  });

  // Regression: a branded dev binary reports packaged, while production must load only shipped trusted resources.
  it('uses packaged resources in releases and the workspace package under a dev server', async () => {
    h.isPackaged = true;
    const original = Object.getOwnPropertyDescriptor(process, 'resourcesPath');
    Object.defineProperty(process, 'resourcesPath', { configurable: true, value: h.resourcesPath });
    try {
      await prepareBundledAntivirusExtension();
      expect(h.install).toHaveBeenLastCalledWith(path.join(h.resourcesPath, 'optional-extensions', 'clamav-scan'), ['ui:panel', 'security:scan-attachments']);
      vi.stubEnv('VITE_DEV_SERVER_URL', 'http://localhost:5173');
      await prepareBundledAntivirusExtension();
      expect(h.install).toHaveBeenLastCalledWith(path.resolve('/synthetic/Inbox/extensions/clamav-scan'), ['ui:panel', 'security:scan-attachments']);
    } finally { if (original) Object.defineProperty(process, 'resourcesPath', original); else delete (process as unknown as Record<string, unknown>).resourcesPath; vi.unstubAllEnvs(); }
  });

  // Regression: retry could reinstall a user's scanner or silently restore a permission the user revoked.
  it('preserves existing grants, activates a disabled approved extension and refuses revoked permissions', async () => {
    h.installed = { grantedPermissions: manifest.permissions }; h.active = true;
    await prepareBundledAntivirusExtension();
    expect(h.readFile).not.toHaveBeenCalled(); expect(h.install).not.toHaveBeenCalled(); expect(h.grant).not.toHaveBeenCalled(); expect(h.enable).not.toHaveBeenCalled();
    h.active = false; await prepareBundledAntivirusExtension(); expect(h.enable).toHaveBeenCalledWith('clamav-scan');
    h.installed = { grantedPermissions: ['ui:panel'] };
    await expect(prepareBundledAntivirusExtension()).rejects.toThrow(/permissions were changed/);
    expect(h.grant).not.toHaveBeenCalled();
  });

  // Regression: the packaged optional scanner must not receive newly added unrelated permissions without review.
  it.each([{ ...manifest, id: 'unrelated' }, { ...manifest, main: 'arbitrary.js' }, { ...manifest, permissions: ['ui:panel'] },
    { ...manifest, permissions: [...manifest.permissions, 'network:fetch'] }, null])('refuses missing or unexpected bundled manifests', async value => {
    h.readFile.mockResolvedValue(JSON.stringify(value));
    await expect(prepareBundledAntivirusExtension()).rejects.toThrow(/unexpected permissions/);
    expect(h.install).not.toHaveBeenCalled();
  });

  // Regression: permission/activation failures must not leave an enabled scanner with default body-sharing permissions.
  it('disables and clears grants after activation failure', async () => {
    h.enable.mockRejectedValueOnce(new Error('Permission persistence failed'));
    await expect(prepareBundledAntivirusExtension()).rejects.toThrow(/Permission persistence/);
    expect(h.grant).toHaveBeenLastCalledWith('clamav-scan', []); expect(h.disable).toHaveBeenCalledWith('clamav-scan');
  });

  // Regression: wrapper entry points must retain native-only authorization, secure storage, browser and cancellation behavior.
  it('binds native dependencies to the current mailbox/extension and exposes only the OAuth coordinator methods', async () => {
    const deps = h.dependencies!;
    expect(() => deps.assertAuthorized('account-a')).toThrow(/inactive/);
    h.installed = { grantedPermissions: ['security:scan-attachments'] }; h.active = true;
    expect(() => deps.assertAuthorized('removed-account')).toThrow(/mailbox.*unavailable/);
    expect(() => deps.assertAuthorized('account-a')).not.toThrow();
    expect(deps.scanService()).toHaveProperty('getTrustedSetup', h.getSetup);
    deps.assertSecureStorage(); expect(h.secure).toHaveBeenCalledOnce();
    h.openExternal.mockResolvedValue(undefined); await deps.openExternal('https://oauth.sarv.com/authorize');
    expect(h.openExternal).toHaveBeenCalledWith('https://oauth.sarv.com/authorize');
    h.installed = { grantedPermissions: ['ui:panel', 'security:scan-attachments'] };
    await deps.prepareExtension();
    h.oauth.connect.mockResolvedValue({ challenge: 'host-only' });
    expect(await connectSarvScannerOAuth('account-a')).toEqual({ challenge: 'host-only' });
    const input = { challenge: 'host-only', accountId: 'account-a', attachmentConsent: true };
    await completeSarvScannerOAuth(input); expect(h.oauth.complete).toHaveBeenCalledWith(input);
    cancelSarvScannerOAuth(); expect(h.oauth.cancel).toHaveBeenCalledOnce();
  });

  // Regression: missing packaging or an unavailable registry should remain an actionable optional setup error.
  it('reports unavailable extension infrastructure and missing files', async () => {
    h.managerAvailable = false; await expect(prepareBundledAntivirusExtension()).rejects.toThrow(/not ready/);
    h.managerAvailable = true; h.readFile.mockRejectedValue(new Error('ENOENT'));
    await expect(prepareBundledAntivirusExtension()).rejects.toThrow(/missing from this app/);
    expect(h.install).not.toHaveBeenCalled();
  });

  // Regression: a saved scanner connection alone is not active protection when its extension is disabled or permission revoked.
  it('reports active protection only when configuration, extension activation and attachment grant all exist', async () => {
    h.getSetup.mockResolvedValue({ configured: true, enabled: true, allowedAccountIds: ['account-a'], allowBody: false });
    expect(await getOnboardingScannerSetup()).toMatchObject({ configured: true, enabled: false });
    h.installed = { grantedPermissions: ['security:scan-attachments'] }; h.active = true;
    expect(await getOnboardingScannerSetup()).toMatchObject({ enabled: true });
    h.active = false; expect(await getOnboardingScannerSetup()).toMatchObject({ configured: true, enabled: false });
    h.active = true; h.installed = { grantedPermissions: [] }; expect(await getOnboardingScannerSetup()).toMatchObject({ enabled: false });
    h.getSetup.mockRejectedValue(new Error('Configuration unreadable'));
    await expect(getOnboardingScannerSetup()).rejects.toThrow(/unreadable/);
  });
});
