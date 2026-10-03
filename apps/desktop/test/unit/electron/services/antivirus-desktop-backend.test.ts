import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createAntivirusDesktopBackend } from '../../../../electron/services/antivirus-desktop-backend';
import type { AntivirusDependencies, ScanSource, ScannerConfiguration } from '../../../../electron/services/antivirus-scan-service';
import { consentFingerprint, type ScannerCapabilities } from '../../../../electron/services/antivirus-transport';

const h = vi.hoisted(() => ({
  deps: null as AntivirusDependencies | null,
  available: true, storageBackend: 'keychain', blobs: new Map<string, Buffer>(), ignoreWrite: false,
  accounts: [{ id: 'account-a', email: 'a@example.test' }, { id: 'account-b', email: 'b@example.test' }],
  storages: new Map<string, any>(), engines: new Map<string, any>(),
  requireStorage: vi.fn(), encrypt: vi.fn(), decrypt: vi.fn(), send: vi.fn(),
}));
vi.mock('electron', () => ({
  app: { isPackaged: false },
  safeStorage: {
    isEncryptionAvailable: () => h.available, getSelectedStorageBackend: () => h.storageBackend,
    encryptString: (value: string) => h.encrypt(value), decryptString: (value: Buffer) => h.decrypt(value),
  },
}));
vi.mock('../../../../electron/shared', () => ({ getMainWindow: () => ({ webContents: { send: h.send } }), getSyncEngineFor: (id: string) => h.engines.get(id) ?? null }));
vi.mock('../../../../electron/services/accounts-registry', () => ({ readRegistryAccounts: () => h.accounts }));
vi.mock('../../../../electron/services/account-target', () => ({ requireAccountStorage: (id: string) => h.requireStorage(id) }));
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
  vi.resetAllMocks(); h.available = true; h.storageBackend = 'keychain'; h.ignoreWrite = false; h.blobs.clear(); h.storages.clear(); h.engines.clear();
  h.accounts = [{ id: 'account-a', email: 'a@example.test' }, { id: 'account-b', email: 'b@example.test' }];
  h.encrypt.mockImplementation((value: string) => Buffer.from(`sealed(${value})`));
  h.decrypt.mockImplementation((value: Buffer) => { const match = /^sealed\((.*)\)$/s.exec(value.toString()); if (!match) throw new Error('Unreadable'); return match[1]; });
  h.requireStorage.mockImplementation(async (id: string) => { const storage = h.storages.get(id); if (!storage) throw new Error('Unavailable'); return storage; });
  createAntivirusDesktopBackend();
});
afterEach(() => { if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform); });

describe('scanner credential storage', () => {
  it('seals credentials with OS encryption, verifies saving, and removes them when revoked', async () => {
    const config = configuration(); await deps().writeConfiguration('clamav-scan', config);
    expect(h.encrypt).toHaveBeenCalledOnce(); expect(h.blobs.get('antivirus-config:clamav-scan')?.subarray(0, 5).toString()).toBe('ENC1:');
    expect(await deps().readConfiguration('clamav-scan')).toEqual(config);
    await deps().writeConfiguration('clamav-scan', undefined); expect(await deps().readConfiguration('clamav-scan')).toBeUndefined();
  });

  it('rejects insecure Linux basic_text and missing OS encryption', async () => {
    h.available = false; await expect(deps().writeConfiguration('clamav-scan', configuration())).rejects.toThrow(/secure key store/);
    h.available = true; Object.defineProperty(process, 'platform', { value: 'linux', configurable: true }); h.storageBackend = 'basic_text';
    await expect(deps().writeConfiguration('clamav-scan', configuration())).rejects.toThrow(/secure key store/);
    expect(h.encrypt).not.toHaveBeenCalled(); expect(h.blobs.size).toBe(0);
  });

  it('fails closed for an unreadable envelope or unsuccessful database write', async () => {
    h.blobs.set('antivirus-config:clamav-scan', Buffer.from('plaintext synthetic-test-key'));
    await expect(deps().readConfiguration('clamav-scan')).rejects.toThrow(/securely read/);
    h.blobs.clear(); h.ignoreWrite = true;
    await expect(deps().writeConfiguration('clamav-scan', configuration())).rejects.toThrow(/securely saved/);
    await expect(deps().writeConfiguration('../other-extension', configuration())).rejects.toThrow(/Invalid scanner extension/);
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
