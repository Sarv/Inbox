import {
  parseAttachmentNames,
  waitForAbortableOperation,
} from '@sarvinbox/core';

import { getExtensionManager } from '../shared';

import {
  requireAccountStorage,
  requireTargetAccountId,
} from './account-target';
import { getAntivirusScanService } from './antivirus-scan-service';
import { AssistantAttachmentReader, type AssistantOwnedAttachment } from './assistant-attachment-reader';
import type { AssistantAttachmentRef } from './assistant-attachment-types';
import { runAssistantAttachmentWorker } from './assistant-attachment-worker';
import { ensureAssistantMailboxConnection, fetchAssistantMessageBody } from './assistant-mailbox-download';
import { downloadScanners, getAttachmentOperationProtection } from './attachment-download-protection';

/** Resolve strictly, without the legacy active-account fallback or shared email-ID cache. */
export async function resolveOwnedAssistantAttachment(ref: AssistantAttachmentRef): Promise<AssistantOwnedAttachment | null> {
  requireTargetAccountId(ref.accountId);
  const storage = await requireAccountStorage(ref.accountId);
  const stored = await storage.getEmail(ref.emailId);
  if (!stored) return null;
  let email = stored;
  const declared = parseAttachmentNames(email.attachmentNames);
  const declaration = async (record: typeof stored) => {
    const names = parseAttachmentNames(record.attachmentNames).filter(name => name === ref.filename);
    const rows = (await storage.getAttachments(ref.emailId)).filter(row => row.filename === ref.filename);
    const valid = names.length <= 1 && rows.length <= 1 && rows.every(row => row.emailId === ref.emailId)
      && (names.length === 1 || rows.length === 1);
    return { valid, row: rows[0], names: names.length };
  };
  const initialDeclaration = await declaration(email);
  if (!initialDeclaration.valid) return null;
  // The IMAP API identifies MIME parts by name; ambiguous duplicate names must
  // never silently bind a citation to an arbitrary part.
  let size: number | undefined;
  try {
    const sizes: unknown = JSON.parse(email.attachmentSizes ?? 'null');
    const candidate = Array.isArray(sizes) ? sizes[declared.indexOf(ref.filename)] : undefined;
    if (typeof candidate === 'number' && Number.isFinite(candidate) && candidate >= 0) size = candidate;
  } catch {}
  if (size === undefined && initialDeclaration.row && Number.isFinite(initialDeclaration.row.size) && initialDeclaration.row.size >= 0)
    size = initialDeclaration.row.size;

  const assertCurrent = async () => {
    requireTargetAccountId(ref.accountId);
    if (await requireAccountStorage(ref.accountId) !== storage) throw new Error('Attachment account changed.');
    const current = await storage.getEmail(ref.emailId);
    if (!current || current.folderId !== email.folderId || current.uid !== email.uid || !(await declaration(current)).valid)
      throw new Error('Attachment source changed.');
  };

  const prepare = async (signal: AbortSignal) => {
    await assertCurrent();
    const target = await ensureAssistantMailboxConnection(ref.accountId, signal);
    if (target.storage !== storage) throw new Error('Attachment account changed.');
    if (!email.uid || initialDeclaration.names !== 1) {
      const repaired = await fetchAssistantMessageBody(ref.accountId, ref.emailId, signal, { force: true });
      if (repaired) email = repaired;
    }
    await assertCurrent();
    if (!email.uid) throw new Error('The attachment has no available server copy yet.');
  };

  return {
    size,
    assertCurrent,
    prepare,
    read: async signal => {
      await assertCurrent();
      const { storage: targetStorage, syncEngine } = await ensureAssistantMailboxConnection(ref.accountId, signal);
      if (targetStorage !== storage) throw new Error('Attachment account changed.');
      if (!email.uid) {
        // The normal body fetch can recover a stale/zero UID via Message-ID.
        const repaired = await fetchAssistantMessageBody(ref.accountId, ref.emailId, signal, { force: true });
        if (repaired) email = repaired;
      }
      if (!email.uid) throw new Error('The attachment has no available server copy yet.');
      const folder = await storage.getFolder(email.folderId);
      if (!folder) throw new Error('Attachment folder is unavailable.');
      await assertCurrent();
      signal.throwIfAborted();
      const partial = await waitForAbortableOperation(
        syncEngine.fetchAttachmentPart(ref.emailId, folder.path, email.uid, ref.filename), signal,
      );
      await assertCurrent();
      const attachment = partial ?? await waitForAbortableOperation(
        syncEngine.fetchAttachment(ref.emailId, folder.path, email.uid, ref.filename), signal,
      );
      await assertCurrent();
      signal.throwIfAborted();
      // The reader erases its private buffer, never a sync-engine cache buffer.
      return Buffer.from(attachment.content);
    },
  };
}

export function createHostAssistantAttachmentReader(): AssistantAttachmentReader {
  return new AssistantAttachmentReader({
    resolve: resolveOwnedAssistantAttachment,
    operations: getAttachmentOperationProtection,
    scannerReady: async ref => {
      const scanners = downloadScanners(getExtensionManager()).filter(scanner => scanner.enabled && scanner.scanner);
      if (!scanners.length) return true;
      if (scanners.length !== 1 || !scanners[0].active || !scanners[0].granted) return false;
      // Assistant reads report a coverage gap instead of prompting for each file.
      return !await getAntivirusScanService().getAttachmentSetupRequirement(scanners[0].id, ref.accountId);
    },
    extract: runAssistantAttachmentWorker,
  });
}
