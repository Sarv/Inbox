import type { ExtensionSecurityBackend } from '@sarvinbox/core';
import { safeStorage } from 'electron';

import { getMainWindow, getSyncEngineFor } from '../shared';
import { isDevBuild } from '../utils/dev-mode';

import { requireAccountStorage } from './account-target';
import { readRegistryAccounts } from './accounts-registry';
import { initializeAntivirusScanService, type ScanSource, type ScannerConfiguration } from './antivirus-scan-service';
import { unscannedWarningPreferences } from './attachment-warning-preferences';
import { getBlob, getCoreDb, setBlob, deleteBlob } from './core-db';
import { isOsBackedEncryption } from './os-encryption';

const key = (id: string) => {
  if (!/^[a-z0-9][a-z0-9-]{0,127}$/.test(id)) throw new Error('Invalid scanner extension.');
  return `antivirus-config:${id}`;
};

export function requireScannerSecureStorage(): void {
  if (!isOsBackedEncryption()) {
    throw new Error('An operating system secure key store is required for scanner credentials.');
  }
}

async function readConfiguration(id: string): Promise<ScannerConfiguration | undefined> {
  getCoreDb(); // An unavailable encrypted profile must not look like a new empty profile.
  const blob = getBlob(key(id));
  if (!blob) return undefined;
  requireScannerSecureStorage();
  if (blob.subarray(0, 5).toString() !== 'ENC1:') throw new Error('Scanner configuration cannot be securely read.');
  try { return JSON.parse(safeStorage.decryptString(blob.subarray(5))) as ScannerConfiguration; }
  catch { throw new Error('Scanner configuration cannot be securely read.'); }
}

async function writeConfiguration(id: string, config: ScannerConfiguration | undefined): Promise<void> {
  getCoreDb();
  if (!config) {
    deleteBlob(key(id));
    if (getBlob(key(id))) throw new Error('Scanner configuration could not be removed.');
    unscannedWarningPreferences.resetAll();
    return;
  }
  requireScannerSecureStorage();
  const encoded = Buffer.concat([Buffer.from('ENC1:'), safeStorage.encryptString(JSON.stringify(config))]);
  setBlob(key(id), encoded);
  if (!getBlob(key(id))?.equals(encoded)) throw new Error('Scanner configuration could not be securely saved.');
  unscannedWarningPreferences.resetAll();
}

function names(value: string | null): string[] {
  try { const parsed: unknown = JSON.parse(value || '[]'); return Array.isArray(parsed) ? parsed.filter((n): n is string => typeof n === 'string') : []; }
  catch { return []; }
}

async function sources(messageId: string, accountId: string): Promise<ScanSource[]> {
  if (!readRegistryAccounts().some(a => a.id === accountId)) throw new Error('This mailbox is no longer available.');
  const storage = await requireAccountStorage(accountId);
  const email = await storage.getEmail(messageId);
  if (!email) throw new Error('The selected message was not found in its account.');
  const base = { accountId, messageId };
  if (email.pgpStatus === 'encrypted') {
    return [...names(email.attachmentNames).map(displayName => ({ ...base, kind: 'attachment' as const, displayName: displayName.slice(0, 512),
      byteLength: null, unavailableReason: 'Encrypted OpenPGP content is not supported for remote scanning.' })),
    { ...base, kind: 'email-body', displayName: 'Message text', byteLength: null,
      unavailableReason: 'Encrypted OpenPGP content is not supported for remote scanning.' }];
  }
  const folder = await storage.getFolder(email.folderId);
  const sync = getSyncEngineFor(accountId);
  let attachments: ScanSource[] = [];
  if (email.hasAttachments) {
    if (!folder || !email.uid || !sync?.isConnected()) {
      attachments = names(email.attachmentNames).map(displayName => ({ ...base, kind: 'attachment', displayName: displayName.slice(0, 512),
        byteLength: null, unavailableReason: 'Connect this account to select exact attachment parts.' }));
    } else {
      const parts = await sync.listAttachmentScanParts(folder.path, email.uid).catch(() => { throw new Error('Attachment metadata could not be retrieved. Reconnect this account and try again.'); });
      if (parts.length > 200) throw new Error('This message has too many attachment parts to scan.');
      attachments = parts.map(part => ({ ...base, kind: 'attachment', displayName: part.filename.slice(0, 512), partFilename: part.filename, partId: part.partId,
        byteLength: part.byteLength, folderPath: folder.path, uid: email.uid }));
    }
  }
  return [...attachments, { ...base, kind: 'email-body', displayName: 'Message text',
    byteLength: email.rawBody ? Buffer.byteLength(email.rawBody, 'utf8') : null,
    ...(!email.rawBody ? { unavailableReason: 'Open this message and download its text before scanning.' } : {}) }];
}

async function read(source: ScanSource, maxBytes: number, signal?: AbortSignal): Promise<Buffer> {
  if (signal?.aborted) throw new Error('Attachment scan cancelled.');
  if (!readRegistryAccounts().some(a => a.id === source.accountId)) throw new Error('This mailbox is no longer available.');
  const storage = await requireAccountStorage(source.accountId);
  const email = await storage.getEmail(source.messageId);
  if (!email || email.pgpStatus === 'encrypted') throw new Error('Message is unavailable or encrypted.');
  if (source.kind === 'email-body') {
    if (!email.rawBody || Buffer.byteLength(email.rawBody, 'utf8') > maxBytes) throw new Error('Message text is unavailable or exceeds the scan limit.');
    return Buffer.from(email.rawBody, 'utf8');
  }
  const folder = await storage.getFolder(email.folderId);
  const sync = getSyncEngineFor(source.accountId);
  if (!folder || folder.path !== source.folderPath || email.uid !== source.uid || !source.partId || !sync?.isConnected()) {
    throw new Error('The attachment location changed or this account is offline. Select the message again.');
  }
  return sync.fetchAttachmentScanPart(folder.path, email.uid, source.partId, source.partFilename ?? source.displayName, maxBytes, signal)
    .catch(() => { throw new Error('The exact attachment could not be downloaded within the scan limit.'); });
}

export function createAntivirusDesktopBackend(): ExtensionSecurityBackend {
  return initializeAntivirusScanService({ readConfiguration, writeConfiguration,
    accounts: () => readRegistryAccounts().map(a => ({ id: a.id, name: a.name || a.email, email: a.email })), sources, read,
    allowDevelopmentLoopback: isDevBuild(),
    openSetup: extensionId => getMainWindow()?.webContents.send('antivirus:openSetup', { extensionId }),
  });
}
