import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createAntivirusDesktopBackend, requireScannerSecureStorage } from '../../../../electron/services/antivirus-desktop-backend';
import type { AntivirusDependencies, ScanSource, ScannerConfiguration } from '../../../../electron/services/antivirus-scan-service';
import { consentFingerprint, scannerOrigin, type ScannerCapabilities } from '../../../../electron/services/antivirus-transport';

const h = vi.hoisted(() => ({
  deps: null as AntivirusDependencies | null,
  available: true, storageBackend: 'gnome_libsecret', blobs: new Map<string, Buffer>(), ignoreWrite: false, isPackaged: false,
  accounts: [{ id: 'account-a', email: 'a@example.test' }, { id: 'account-b', email: 'b@example.test' }],
  storages: new Map<string, any>(), engines: new Map<string, any>(),
  requireStorage: vi.fn(), encrypt: vi.fn(), decrypt: vi.fn(), send: vi.fn(), resetWarnings: vi.fn(),
}));
vi.mock('electron', () => ({
  app: { get isPackaged() { return h.isPackaged; } },
  safeStorage: {
    isEncryptionAvailable: () => h.available, getSelectedStorageBackend: () => h.storageBackend,
    encryptString: (value: string) => h.encrypt(value), decryptString: (value: Buffer) => h.decrypt(value),
  },
}));
vi.mock('../../../../electron/shared', () => ({ getMainWindow: () => ({ webContents: { send: h.send } }), getSyncEngineFor: (id: string) => h.engines.get(id) ?? null }));
vi.mock('../../../../electron/services/accounts-registry', () => ({ readRegistryAccounts: () => h.accounts }));
vi.mock('../../../../electron/services/account-target', () => ({ requireAccountStorage: (id: string) => h.requireStorage(id) }));
vi.mock('../../../../electron/services/attachment-warning-preferences', () => ({ unscannedWarningPreferences: { resetAll: h.resetWarnings } }));
vi.mock('../../../../electron/services/core-db', () => ({
  getCoreDb: () => ({}), getBlob: (key: string) => h.blobs.get(key) ?? null,
  setBlob: (key: string, value: Buffer) => { if (!h.ignoreWrite) h.blobs.set(key, value); }, deleteBlob: (key: string) => h.blobs.delete(key),
}));
vi.mock('../../../../electron/services/antivirus-scan-service', () => ({
  initializeAntivirusScanService: (deps: AntivirusDependencies) => { h.deps = deps; return {}; },
}));

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
const deps = () => h.deps!;
const cap = (): ScannerCapabilities => ({ protocolVersion: 1,
  engine: { name: 'ClamAV', version: '1.5.4', signatureVersion: '123', signaturesUpdatedAt: new Date().toISOString(), scanPolicyVersion: 'policy-1' },
  operator: { name: 'Test scanner', region: 'Local', privacyPolicyUrl: 'https://scanner.test/privacy', privacyTermsVersion: 'privacy-1' },
  maxItemBytes: 128, maxTotalBytes: 256, maxItems: 10, contentLifetimeSeconds: 300, resultLifetimeSeconds: 900,
  contentStorage: { mode: 'ephemeral', noPersistentRetention: true } });
const configuration = (): ScannerConfiguration => { const capabilities = cap(); return { endpoint: 'https://scanner.test', credential: 'synthetic-test-key', allowedAccountIds: ['account-b'], allowBody: false, capabilities, fingerprint: consentFingerprint(capabilities) }; };

beforeEach(() => {
  vi.resetAllMocks(); h.available = true; h.storageBackend = 'gnome_libsecret'; h.ignoreWrite = false; h.blobs.clear(); h.storages.clear(); h.engines.clear();
  h.isPackaged = false; vi.stubEnv('VITE_DEV_SERVER_URL', undefined);
  h.accounts = [{ id: 'account-a', email: 'a@example.test' }, { id: 'account-b', email: 'b@example.test' }];
  h.encrypt.mockImplementation((value: string) => Buffer.from(`${process.platform === 'linux' ? 'v11' : ''}sealed(${value})`));
  h.decrypt.mockImplementation((value: Buffer) => { const match = /^(?:v11)?sealed\((.*)\)$/s.exec(value.toString()); if (!match) throw new Error('Unreadable'); return match[1]; });
  h.requireStorage.mockImplementation(async (id: string) => { const storage = h.storages.get(id); if (!storage) throw new Error('Unavailable'); return storage; });
  createAntivirusDesktopBackend();
});
afterEach(() => { vi.unstubAllEnvs(); if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform); });

describe('scanner development loopback policy', () => {
  // Breaks: sh scripts/dev.sh uses a branded Electron binary that reports packaged and rejects the local scanner.
  it.each(['http://localhost:8080', 'http://127.0.0.1:8080', 'http://[::1]:8080'])('allows %s under Vite even when Electron reports packaged', endpoint => {
    h.isPackaged = true; vi.stubEnv('VITE_DEV_SERVER_URL', 'http://localhost:5173');
    createAntivirusDesktopBackend();
    expect(deps().allowDevelopmentLoopback).toBe(true);
    expect(scannerOrigin(endpoint, deps().allowDevelopmentLoopback)).toBe(endpoint);
  });

  // Breaks: accepting the development exception in a shipped build sends scanner credentials over HTTP.
  it.each([undefined, ''])('requires HTTPS in a packaged app without a dev server (%s)', devServerUrl => {
    h.isPackaged = true; vi.stubEnv('VITE_DEV_SERVER_URL', devServerUrl);
    createAntivirusDesktopBackend();
    expect(deps().allowDevelopmentLoopback).toBe(false);
    expect(() => scannerOrigin('http://localhost:8080', deps().allowDevelopmentLoopback)).toThrow(/require HTTPS/);
    expect(scannerOrigin('https://scanner.example.test', deps().allowDevelopmentLoopback)).toBe('https://scanner.example.test');
  });

  // Breaks: treating all HTTP as development-safe exposes credentials outside the local machine.
  it.each(['http://scanner.example.test:8080', 'http://localhost.example.test:8080', 'http://192.168.1.20:8080'])('continues to reject non-loopback HTTP %s in development', endpoint => {
    h.isPackaged = true; vi.stubEnv('VITE_DEV_SERVER_URL', 'http://localhost:5173');
    createAntivirusDesktopBackend();
    expect(deps().allowDevelopmentLoopback).toBe(true);
    expect(() => scannerOrigin(endpoint, deps().allowDevelopmentLoopback)).toThrow(/require HTTPS/);
  });
});

describe('scanner credential storage', () => {
  it('seals credentials with OS encryption, verifies saving, and removes them when revoked', async () => {
    const config = configuration(); await deps().writeConfiguration('clamav-scan', config);
    expect(h.encrypt).toHaveBeenCalledOnce(); expect(h.blobs.get('antivirus-config:clamav-scan')?.subarray(0, 5).toString()).toBe('ENC1:');
    expect(await deps().readConfiguration('clamav-scan')).toEqual(config);
    await deps().writeConfiguration('clamav-scan', undefined); expect(await deps().readConfiguration('clamav-scan')).toBeUndefined();
    expect(h.resetWarnings).toHaveBeenCalledTimes(2);
  });

  it('keeps credentials in memory when OS encryption is unavailable or Linux uses basic_text', async () => {
    const config = configuration(); h.available = false;
    expect(() => requireScannerSecureStorage()).toThrow(/secure key store/);
    await deps().writeConfiguration('clamav-scan', config);
    expect(await deps().readConfiguration('clamav-scan')).toEqual(config);
    expect(deps().credentialStorage?.('clamav-scan')).toBe('session');
    h.available = true; Object.defineProperty(process, 'platform', { value: 'linux', configurable: true }); h.storageBackend = 'basic_text';
    expect(() => requireScannerSecureStorage()).toThrow(/secure key store/);
    await deps().writeConfiguration('clamav-scan', config);
    expect(await deps().readConfiguration('clamav-scan')).toEqual(config);
    expect(h.encrypt).not.toHaveBeenCalled(); expect(h.blobs.size).toBe(0);
    expect(h.resetWarnings).toHaveBeenCalledTimes(2);
  });

  it('forgets session credentials on explicit disable and on a new app backend instance', async () => {
    h.available = false; await deps().writeConfiguration('clamav-scan', configuration());
    await deps().writeConfiguration('clamav-scan', undefined);
    expect(await deps().readConfiguration('clamav-scan')).toBeUndefined();
    await deps().writeConfiguration('clamav-scan', configuration());
    createAntivirusDesktopBackend();
    expect(await deps().readConfiguration('clamav-scan')).toBeUndefined();
    expect(h.blobs.size).toBe(0); expect(h.encrypt).not.toHaveBeenCalled();
  });

  it('can reconnect in memory and explicitly save anew after the OS keychain recovers', async () => {
    const config = configuration(); h.available = false;
    await deps().writeConfiguration('clamav-scan', config);
    const updated = { ...config, credential: 'synthetic-reconnected-key' };
    await deps().writeConfiguration('clamav-scan', updated);
    expect(await deps().readConfiguration('clamav-scan')).toEqual(updated);
    expect(h.blobs.size).toBe(0);
    h.available = true;
    // Availability alone does not silently persist a session credential.
    expect(await deps().readConfiguration('clamav-scan')).toEqual(updated);
    expect(deps().credentialStorage?.('clamav-scan')).toBe('session'); expect(h.encrypt).not.toHaveBeenCalled();
    await deps().writeConfiguration('clamav-scan', updated);
    expect(deps().credentialStorage?.('clamav-scan')).toBe('os-keychain');
    expect(h.blobs.get('antivirus-config:clamav-scan')?.subarray(0, 5).toString()).toBe('ENC1:');
    createAntivirusDesktopBackend(); expect(await deps().readConfiguration('clamav-scan')).toEqual(updated);
    await deps().writeConfiguration('clamav-scan', undefined);
    expect(h.blobs.size).toBe(0); expect(await deps().readConfiguration('clamav-scan')).toBeUndefined();
  });

  it('preserves an existing encrypted configuration throughout a transient unavailable keychain', async () => {
    const config = configuration(); await deps().writeConfiguration('clamav-scan', config);
    const saved = Buffer.from(h.blobs.get('antivirus-config:clamav-scan')!);
    h.available = false;
    await expect(deps().readConfiguration('clamav-scan')).rejects.toThrow(/secure key store/);
    expect(deps().savedCredentialsLocked?.('clamav-scan')).toBe(true);
    const temporary = { ...config, credential: 'synthetic-replacement' };
    await deps().writeConfiguration('clamav-scan', temporary);
    expect(await deps().readConfiguration('clamav-scan')).toEqual(temporary);
    expect(deps().savedCredentialsLocked?.('clamav-scan')).toBe(false);
    expect(h.blobs.get('antivirus-config:clamav-scan')).toEqual(saved);
    h.available = true;
    // Recovering the keychain does not silently replace either credential.
    expect(await deps().readConfiguration('clamav-scan')).toEqual(temporary);
    createAntivirusDesktopBackend();
    expect(await deps().readConfiguration('clamav-scan')).toEqual(config);
    expect(h.encrypt).toHaveBeenCalledOnce();
  });

  it('explicitly forgetting a locked sign-in removes both its encrypted copy and session shadow', async () => {
    await deps().writeConfiguration('clamav-scan', configuration());
    h.available = false;
    await deps().writeConfiguration('clamav-scan', { ...configuration(), credential: 'synthetic-session-key' });
    await deps().writeConfiguration('clamav-scan', undefined);
    expect(h.blobs.size).toBe(0); expect(await deps().readConfiguration('clamav-scan')).toBeUndefined();
    h.available = true; createAntivirusDesktopBackend();
    expect(await deps().readConfiguration('clamav-scan')).toBeUndefined();
  });

  it('does not replace a failed OS-encrypted save with an unprotected persistent or session secret', async () => {
    h.encrypt.mockImplementation(() => { throw new Error('Keychain is locked'); });
    await expect(deps().writeConfiguration('clamav-scan', configuration())).rejects.toThrow('Keychain is locked');
    expect(h.blobs.size).toBe(0); expect(await deps().readConfiguration('clamav-scan')).toBeUndefined();
  });

  it('keeps a consented memory-only choice in memory even if the keychain recovers before saving', async () => {
    const config = configuration();
    await deps().writeConfiguration('clamav-scan', config, 'session');
    expect(await deps().readConfiguration('clamav-scan')).toEqual(config);
    expect(deps().credentialStorage?.('clamav-scan')).toBe('session');
    expect(deps().newConfigurationStorage?.()).toBe('os-keychain');
    expect(h.encrypt).not.toHaveBeenCalled(); expect(h.blobs.size).toBe(0);
  });

  it('requires re-verification when an OS-persistent choice loses its keychain before saving', async () => {
    h.available = false;
    await expect(deps().writeConfiguration('clamav-scan', configuration(), 'os-keychain')).rejects.toThrow(/secure key store/);
    expect(await deps().readConfiguration('clamav-scan')).toBeUndefined();
    expect(h.blobs.size).toBe(0); expect(h.encrypt).not.toHaveBeenCalled();
  });

  it('fails closed for an unreadable envelope or unsuccessful database write', async () => {
    h.blobs.set('antivirus-config:clamav-scan', Buffer.from('plaintext synthetic-test-key'));
    await expect(deps().readConfiguration('clamav-scan')).rejects.toThrow(/securely read/);
    h.blobs.clear(); h.ignoreWrite = true;
    await expect(deps().writeConfiguration('clamav-scan', configuration())).rejects.toThrow(/securely saved/);
    await expect(deps().writeConfiguration('../other-extension', configuration())).rejects.toThrow(/Invalid scanner extension/);
    expect(h.resetWarnings).not.toHaveBeenCalled();
  });

  // Breaks: a broken preference store silently leaves old remembered bypasses active after scanner changes.
  it('fails closed when remembered warnings cannot be cleared after a successful configuration change', async () => {
    h.resetWarnings.mockImplementation(() => { throw new Error('Warning store unreadable'); });
    await expect(deps().writeConfiguration('clamav-scan', configuration())).rejects.toThrow('Warning store unreadable');
    await expect(deps().writeConfiguration('clamav-scan', undefined)).rejects.toThrow('Warning store unreadable');
  });
});

function mailbox() {
  const email = { uid: 42, folderId: 'folder-b', rawBody: 'Synthetic message text', hasAttachments: true, attachmentNames: '["sample.txt"]', pgpStatus: undefined as string | undefined };
  const storage = { getEmail: vi.fn(async () => email), getFolder: vi.fn(async () => ({ path: 'INBOX' })) };
  const engine = { isConnected: vi.fn(() => true), listAttachmentScanParts: vi.fn(async () => [{ partId: '3', filename: 'sample.txt', byteLength: null }]), fetchAttachmentScanPart: vi.fn(async () => Buffer.from('Synthetic attachment')) };
  h.storages.set('account-b', storage); h.engines.set('account-b', engine);
  return { email, storage, engine };
}

describe('scanner exact mailbox source adapter', () => {
  it('uses the named mailbox runtime and exact selected MIME part with a byte bound', async () => {
    const { storage, engine } = mailbox();
    const [attachment] = await deps().sources('message-b', 'account-b');
    expect(h.requireStorage).toHaveBeenCalledWith('account-b'); expect(storage.getEmail).toHaveBeenCalledWith('message-b');
    expect(engine.listAttachmentScanParts).toHaveBeenCalledWith('INBOX', 42);
    expect((await deps().read(attachment!, 128)).toString()).toBe('Synthetic attachment');
    expect(engine.fetchAttachmentScanPart).toHaveBeenCalledWith('INBOX', 42, '3', 'sample.txt', 128, undefined);
  });

  it('does not reopen removed accounts or fall back to the active mailbox', async () => {
    const { engine } = mailbox(); h.accounts = h.accounts.filter(account => account.id !== 'account-b');
    await expect(deps().sources('message-b', 'account-b')).rejects.toThrow(/no longer available/);
    await expect(deps().read({ accountId: 'account-b', messageId: 'message-b', kind: 'email-body', displayName: 'Message text', byteLength: 4 }, 128)).rejects.toThrow(/no longer available/);
    expect(h.requireStorage).not.toHaveBeenCalled(); expect(engine.listAttachmentScanParts).not.toHaveBeenCalled();
  });

  it('refuses encrypted OpenPGP content without fetching or decrypting its attachments', async () => {
    const { email, engine } = mailbox(); email.pgpStatus = 'encrypted';
    const targets = await deps().sources('message-b', 'account-b'); expect(targets.every(target => !!target.unavailableReason)).toBe(true);
    await expect(deps().read(targets[0]!, 128)).rejects.toThrow(/encrypted/);
    expect(engine.listAttachmentScanParts).not.toHaveBeenCalled(); expect(engine.fetchAttachmentScanPart).not.toHaveBeenCalled();
  });

  it('retains an original long filename privately while showing a bounded label', async () => {
    const { engine } = mailbox(); const filename = 'x'.repeat(600) + '.txt';
    engine.listAttachmentScanParts.mockResolvedValue([{ partId: '3', filename, byteLength: null }]);
    const [target] = await deps().sources('message-b', 'account-b'); expect(target?.displayName).toHaveLength(512);
    await deps().read(target!, 128); expect(engine.fetchAttachmentScanPart).toHaveBeenCalledWith('INBOX', 42, '3', filename, 128, undefined);
  });

  it('refuses moved attachments, oversized body text, and unavailable body text', async () => {
    const { email, engine } = mailbox(); const targets = await deps().sources('message-b', 'account-b');
    email.uid = 43; await expect(deps().read(targets[0]!, 128)).rejects.toThrow(/location changed/);
    expect(engine.fetchAttachmentScanPart).not.toHaveBeenCalled();
    const body = targets.find(target => target.kind === 'email-body') as ScanSource;
    await expect(deps().read(body, 4)).rejects.toThrow(/scan limit/);
    email.rawBody = ''; await expect(deps().read(body, 128)).rejects.toThrow(/unavailable/);
  });

  it('does not expose underlying IMAP errors, subjects, or secrets to the extension', async () => {
    const { engine } = mailbox(); engine.listAttachmentScanParts.mockRejectedValue(new Error('private mail subject or token'));
    await expect(deps().sources('message-b', 'account-b')).rejects.toThrow('Attachment metadata could not be retrieved. Reconnect this account and try again.');
  });
});
