import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';

import { waitForAbortableOperation, type ExtensionManager } from '@sarvinbox/core';

export type AttachmentDownloadPhase = 'downloading' | 'scanning' | 'saving';

export interface DownloadScanner {
  id: string;
  enabled: boolean;
  active: boolean;
  scanner: boolean;
  granted: boolean;
}

/** Include enabled scanners whose activation or permission grant has failed. */
export function downloadScanners(manager?: ExtensionManager | null): DownloadScanner[] {
  if (!manager) return [];
  const registry = manager.getRegistry();
  return registry.getAll().map((extension) => {
    const manifest = registry.getLoaded(extension.id)?.manifest;
    return {
      id: extension.id,
      enabled: extension.enabled,
      active: manager.getHost().isActive(extension.id),
      scanner:
        extension.id === 'clamav-scan' ||
        extension.grantedPermissions.includes('security:scan-attachments') ||
        Boolean(manifest?.permissions.includes('security:scan-attachments')) ||
        Boolean(
          manifest?.contributes?.capabilities?.some(
            (capability) => capability.id === 'attachment.scan'
          )
        ),
      granted: extension.grantedPermissions.includes('security:scan-attachments'),
    };
  });
}

export function attachmentScanRequired(manager?: ExtensionManager | null): boolean {
  return downloadScanners(manager).some((extension) => extension.enabled && extension.scanner);
}

export interface ProtectedDownloadContent {
  content: Buffer;
  assertCurrent(): Promise<void>;
  dispose(): void;
}

/** Host-only proof that scanner setup was missing for this account. */
export interface AttachmentSetupRequirement {
  assertCurrent(): Promise<void>;
}

export type AttachmentWarningAction = 'view' | 'open' | 'download' | 'calendar';

export interface AttachmentWarningTarget {
  messageId: string;
  accountId: string;
  filename: string;
  action: AttachmentWarningAction;
}

export interface AttachmentOperationDependencies {
  scanners(): DownloadScanner[];
  checkSetup?(
    extensionId: string,
    accountId: string
  ): Promise<AttachmentSetupRequirement | undefined>;
  confirmUnscanned?(
    target: AttachmentWarningTarget,
    signal: AbortSignal,
    assertCurrent: () => Promise<void>
  ): Promise<'continue' | 'setup' | 'cancel'>;
  scan(
    extensionId: string,
    messageId: string,
    accountId: string,
    filename: string,
    options: {
      signal: AbortSignal;
      onProgress(phase: 'downloading' | 'scanning'): void;
    }
  ): Promise<ProtectedDownloadContent>;
  openSetup(extensionId: string): Promise<void> | void;
  progress(requestId: string, phase: AttachmentDownloadPhase): void;
  timeoutMs?: number;
}

export interface ProtectedAttachmentOperation {
  signal: AbortSignal;
  content?: ProtectedDownloadContent;
  extensionId?: string;
  /** True only after the host warning was explicitly accepted for missing setup. */
  notScanned: boolean;
  assertCurrent(): Promise<void>;
  assertNotCancelled(): void;
  progress(phase: AttachmentDownloadPhase): void;
  /** Transfer the verified receipt only if the operation completes successfully. */
  retainContent(): void;
}

/** One cancellation, deadline and scanner gate for saves and every viewer. */
export class AttachmentOperationProtection {
  private closed = false;
  private requests = new Map<string, AbortController>();

  constructor(private deps: AttachmentOperationDependencies) {}

  scanningRequired(): boolean {
    return this.deps.scanners().some((item) => item.enabled && item.scanner);
  }

  cancel(requestId: string): boolean {
    this.requireRequestId(requestId);
    const request = this.requests.get(requestId);
    if (!request) return false;
    request.abort(new Error('Download cancelled.'));
    return true;
  }

  cancelAll(): void {
    for (const request of this.requests.values()) request.abort(new Error('Download cancelled.'));
  }

  dispose(): void {
    this.closed = true;
    this.cancelAll();
  }

  private requireRequestId(requestId: string): void {
    if (typeof requestId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(requestId)) {
      throw new Error('Invalid attachment download request');
    }
  }

  assertCurrentScanner(extensionId: string): void {
    const enabled = this.deps.scanners().filter((item) => item.enabled && item.scanner);
    if (
      enabled.length !== 1 ||
      enabled[0]?.id !== extensionId ||
      !enabled[0].active ||
      !enabled[0].granted
    ) {
      throw new Error('Antivirus scanning was disabled or changed. Download cancelled.');
    }
  }

  async run<T>(
    messageId: string,
    accountId: string,
    filename: string,
    consume: (operation: ProtectedAttachmentOperation) => Promise<T>,
    requestId: string = randomUUID(),
    unscannableReason?: string,
    action: AttachmentWarningAction = 'view'
  ): Promise<T> {
    if (this.closed) throw new Error('Download cancelled.');
    this.requireRequestId(requestId);
    if (
      !messageId ||
      typeof messageId !== 'string' ||
      !accountId ||
      typeof accountId !== 'string' ||
      !filename ||
      typeof filename !== 'string'
    ) {
      throw new Error('Invalid attachment download request');
    }
    if (this.requests.has(requestId))
      throw new Error('This attachment download is already in progress');
    if (this.requests.size >= 4)
      throw new Error('Too many attachment downloads. Wait for a download to finish.');
    const controller = new AbortController();
    const { signal } = controller;
    this.requests.set(requestId, controller);
    const timer = setTimeout(
      () => controller.abort(new Error('Attachment download timed out.')),
      this.deps.timeoutMs ?? 300_000
    );
    timer.unref?.();
    let scanned: ProtectedDownloadContent | undefined;
    let missingSetup: AttachmentSetupRequirement | undefined;
    let notScanned = false;
    let retain = false;
    let completed = false;
    const assertNotCancelled = () => {
      if (signal.aborted)
        throw signal.reason instanceof Error ? signal.reason : new Error('Download cancelled.');
    };
    const progress = (phase: AttachmentDownloadPhase) => {
      assertNotCancelled();
      this.deps.progress(requestId, phase);
    };
    try {
      const scanners = this.deps.scanners().filter((item) => item.enabled && item.scanner);
      if (scanners.length > 1)
        throw new Error(
          'More than one antivirus extension is enabled. Enable one scanner before downloading.'
        );
      const scanner = scanners[0];
      progress('downloading');
      const assertCurrent = async () => {
        assertNotCancelled();
        if (scanner && (scanned || notScanned)) {
          this.assertCurrentScanner(scanner.id);
          if (scanned) await scanned.assertCurrent();
          else await missingSetup!.assertCurrent();
          this.assertCurrentScanner(scanner.id);
        } else if (this.scanningRequired()) {
          throw new Error(
            'Antivirus scanning was enabled. Retry the download to scan this attachment.'
          );
        }
        assertNotCancelled();
      };
      if (scanner) {
        if (!scanner.active || !scanner.granted) {
          await this.deps.openSetup(scanner.id);
          throw new Error(
            'The antivirus extension is unavailable or lacks attachment scanning permission. Download blocked.'
          );
        }
        missingSetup = this.deps.checkSetup
          ? await waitForAbortableOperation(this.deps.checkSetup(scanner.id, accountId), signal)
          : undefined;
        this.assertCurrentScanner(scanner.id);
        if (missingSetup) {
          // Revalidate before remembering a warning choice as well as before
          // consuming bytes: a stale popup must never create durable consent.
          const verifyMissingSetup = async () => {
            assertNotCancelled();
            this.assertCurrentScanner(scanner.id);
            await waitForAbortableOperation(missingSetup!.assertCurrent(), signal);
            this.assertCurrentScanner(scanner.id);
            assertNotCancelled();
          };
          await verifyMissingSetup();
          if (!this.deps.confirmUnscanned) {
            await this.deps.openSetup(scanner.id);
            throw new Error(
              'Set up antivirus scanning and allow this account before downloading attachments.'
            );
          }
          const choice = await waitForAbortableOperation(
            this.deps.confirmUnscanned(
              { messageId, accountId, filename, action },
              signal,
              verifyMissingSetup
            ),
            signal
          );
          assertNotCancelled();
          if (choice === 'setup') await this.deps.openSetup(scanner.id);
          if (choice !== 'continue') throw new Error('Download cancelled.');
          // Choosing Continue grants only this action. It cannot survive scanner,
          // account or configuration changes while the warning was displayed.
          notScanned = true;
        } else {
          // Derived/decrypted content has no MIME receipt. Never upload it just
          // to authorize an operation that the configured scanner cannot cover.
          if (unscannableReason) throw new Error(unscannableReason);
          scanned = await this.deps.scan(scanner.id, messageId, accountId, filename, {
            signal,
            onProgress: progress,
          });
        }
        await assertCurrent();
      }
      const result = await consume({
        signal,
        content: scanned,
        extensionId: scanner?.id,
        notScanned,
        assertCurrent,
        assertNotCancelled,
        progress,
        retainContent: () => {
          retain = true;
        },
      });
      assertNotCancelled();
      completed = true;
      return result;
    } catch (error) {
      // Preserve the host's timeout reason when the scanner returns a generic cancellation.
      assertNotCancelled();
      throw error;
    } finally {
      clearTimeout(timer);
      if (!retain || !completed) scanned?.dispose();
      this.requests.delete(requestId);
    }
  }
}

export interface AttachmentDownloadDependencies extends AttachmentOperationDependencies {
  resolveLegacy(messageId: string, filename: string, accountId: string): Promise<string>;
  readLegacy?(sourcePath: string, signal: AbortSignal): Promise<Buffer>;
  chooseSavePath(filename: string): Promise<string | null>;
  writeContent(
    filePath: string,
    content: Buffer,
    signal: AbortSignal,
    beforeCommit: () => Promise<void>
  ): Promise<void>;
  copyLegacy(sourcePath: string, filePath: string): Promise<void>;
}

/** The trusted host decides whether bytes may leave the attachment cache. */
export class AttachmentDownloadProtection {
  readonly operations: AttachmentOperationProtection;

  constructor(
    private deps: AttachmentDownloadDependencies,
    operations?: AttachmentOperationProtection
  ) {
    this.operations = operations ?? new AttachmentOperationProtection(deps);
  }

  cancel(requestId: string): boolean {
    return this.operations.cancel(requestId);
  }

  async download(
    messageId: string,
    accountId: string,
    filename: string,
    requestId?: string,
    onUnscanned?: () => void
  ): Promise<string | null> {
    return this.operations.run(
      messageId,
      accountId,
      filename,
      async (operation) => {
        if (operation.notScanned) onUnscanned?.();
        const { signal, content: scanned, assertCurrent, assertNotCancelled, progress } = operation;
        const legacyPath = scanned
          ? undefined
          : await this.deps.resolveLegacy(messageId, filename, accountId);
        let unscanned: Buffer | undefined;
        try {
          assertNotCancelled();
          if (operation.notScanned) {
            await assertCurrent();
            if (!this.deps.readLegacy || !legacyPath)
              throw new Error('The attachment could not be saved.');
            unscanned = await this.deps.readLegacy(legacyPath, signal);
            await assertCurrent();
          }
          // A destination is chosen only after scanning or explicit warning acceptance.
          const destination = await waitForAbortableOperation(
            this.deps.chooseSavePath(filename),
            signal
          );
          assertNotCancelled();
          if (!destination) return null;
          await assertCurrent();
          progress('saving');
          if (scanned || unscanned)
            await this.deps.writeContent(
              destination,
              (scanned?.content ?? unscanned)!,
              signal,
              assertCurrent
            );
          else if (legacyPath) await this.deps.copyLegacy(legacyPath, destination);
          return destination;
        } finally {
          unscanned?.fill(0);
        }
      },
      requestId,
      undefined,
      'download'
    );
  }
}

let attachmentOperations: AttachmentOperationProtection | undefined;
export function getAttachmentOperationProtection(): AttachmentOperationProtection | undefined {
  return attachmentOperations;
}
export function setAttachmentOperationProtection(value: AttachmentOperationProtection): void {
  attachmentOperations = value;
}

/** Bound local warning-approved snapshots without buffering a growing file unboundedly. */
export async function readUnscannedAttachment(
  filePath: string,
  signal: AbortSignal,
  maxBytes: number
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    const stream = createReadStream(filePath, { highWaterMark: 256 * 1024, signal });
    for await (const chunk of stream) {
      const bytes = chunk as Buffer;
      size += bytes.length;
      if (size > maxBytes) {
        bytes.fill(0);
        throw new Error('Attachment is too large to open or save without scanning.');
      }
      chunks.push(bytes);
    }
    signal.throwIfAborted();
    return Buffer.concat(chunks, size);
  } finally {
    for (const chunk of chunks) chunk.fill(0);
  }
}

/** Never truncate an existing destination for a cancelled or revoked scan. */
export async function writeProtectedAttachment(
  destination: string,
  content: Buffer,
  signal: AbortSignal,
  beforeCommit: () => Promise<void>
): Promise<void> {
  const temporary = path.join(path.dirname(destination), `.inbox-download-${randomUUID()}.partial`);
  try {
    await fs.writeFile(temporary, content, { mode: 0o600, flag: 'wx', signal });
    await beforeCommit();
    signal.throwIfAborted();
    await fs.rename(temporary, destination);
  } finally {
    await fs.unlink(temporary).catch((error) => {
      if (error?.code !== 'ENOENT') throw error;
    });
  }
}
