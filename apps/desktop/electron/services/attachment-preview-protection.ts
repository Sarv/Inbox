import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';

import {
  buildAttachmentUrl,
  createLogger,
  isInlineRenderableAttachment,
  isPreviewableAttachment,
  parseAttachmentUrl,
  safeFilename,
  waitForAbortableOperation,
  type AttachmentRef,
} from '@sarvinbox/core';

import { AttachmentError, MAX_ATTACHMENT_BYTES } from './attachment-cache';
import {
  AttachmentOperationProtection,
  readUnscannedAttachment,
  type ProtectedAttachmentOperation,
  type ProtectedDownloadContent,
} from './attachment-download-protection';

const MAX_PREVIEWS = 4;
const MAX_PREVIEW_TTL_MS = 300_000;
const logger = createLogger('attachment-preview-protection');
const BLOCKED_PREVIEW = 'Preview blocked: scan this attachment again before viewing.';

interface PreviewLease {
  ref: AttachmentRef;
  extensionId: string;
  receipt: ProtectedDownloadContent;
  expiresAt: number;
  timer: ReturnType<typeof setTimeout>;
}

export interface AttachmentPreviewDependencies {
  operations: AttachmentOperationProtection;
  resolveLegacy(messageId: string, filename: string, accountId: string): Promise<string>;
  openPath(filePath: string): Promise<string>;
  temporaryRoot(): string;
  now?: () => number;
  ttlMs?: number;
}

/** Clean bytes remain bound to their account, message and filename until the viewer closes. */
export class AttachmentPreviewProtection {
  private closed = false;
  private leases = new Map<string, PreviewLease>();
  private temporaryRootReady?: Promise<string>;
  private pendingOpened = 0;
  private opened = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(private deps: AttachmentPreviewDependencies) {
    this.ttlMs = Math.max(1, Math.min(deps.ttlMs ?? MAX_PREVIEW_TTL_MS, MAX_PREVIEW_TTL_MS));
    this.now = deps.now ?? Date.now;
  }

  private requireAvailable(): void {
    if (this.closed) throw new AttachmentError(BLOCKED_PREVIEW, 403);
  }

  private prune(): void {
    for (const [token, lease] of this.leases)
      if (lease.expiresAt <= this.now()) this.releaseToken(token);
  }

  private releaseToken(token: string): boolean {
    const lease = this.leases.get(token);
    if (!lease) return false;
    this.leases.delete(token);
    clearTimeout(lease.timer);
    lease.receipt.dispose();
    return true;
  }

  async preparePreview(
    messageId: string,
    accountId: string,
    filename: string,
    requestId?: string,
    onUnscanned?: () => void
  ): Promise<string> {
    this.requireAvailable();
    if (!isInlineRenderableAttachment(filename))
      throw new AttachmentError('This file type cannot be shown in Sarv Inbox', 403);
    this.prune();
    if (this.leases.size >= MAX_PREVIEWS)
      throw new AttachmentError('Too many attachment previews. Close a viewer and try again.', 429);
    let prepared: string | undefined;
    let unscanned: ProtectedDownloadContent | undefined;
    try {
      return await this.deps.operations.run(
        messageId,
        accountId,
        filename,
        async (operation) => {
          const ref = { emailId: messageId, accountId, filename };
          if (operation.notScanned) onUnscanned?.();
          if (!operation.content && !operation.notScanned) {
            await this.deps.resolveLegacy(messageId, filename, accountId);
            await operation.assertCurrent();
            return buildAttachmentUrl(ref);
          }
          // The warning authorizes only this attachment. Retain its local bytes
          // behind a lease rather than allowing raw cache URLs to bypass AV.
          if (operation.notScanned) unscanned = await this.readUnscanned(ref, operation);
          const receipt = operation.content ?? unscanned!;
          await operation.assertCurrent();
          // Concurrent scans may finish together; bound retained bytes at completion too.
          this.prune();
          if (this.leases.size >= MAX_PREVIEWS)
            throw new AttachmentError(
              'Too many attachment previews. Close a viewer and try again.',
              429
            );
          const token = randomUUID();
          const timer = setTimeout(() => this.releaseToken(token), this.ttlMs);
          timer.unref?.();
          this.leases.set(token, {
            ref,
            extensionId: operation.extensionId!,
            receipt,
            expiresAt: this.now() + this.ttlMs,
            timer,
          });
          const url = new URL(buildAttachmentUrl(ref));
          url.searchParams.set('preview', token);
          prepared = url.toString();
          operation.retainContent();
          return prepared;
        },
        requestId,
        undefined,
        'view'
      );
    } catch (error) {
      if (prepared) this.releasePreview(prepared);
      else unscanned?.dispose();
      throw error;
    }
  }

  /** A bounded private snapshot; continuing never uploads or labels it clean. */
  private async readUnscanned(
    ref: AttachmentRef,
    operation: ProtectedAttachmentOperation
  ): Promise<ProtectedDownloadContent> {
    const filePath = await this.deps.resolveLegacy(ref.emailId, ref.filename, ref.accountId!);
    await operation.assertCurrent();
    let content: Buffer | undefined;
    try {
      content = await readUnscannedAttachment(filePath, operation.signal, MAX_ATTACHMENT_BYTES);
      await operation.assertCurrent();
      const retained = content;
      return {
        content: retained,
        assertCurrent: operation.assertCurrent,
        dispose: () => {
          retained.fill(0);
        },
      };
    } catch (error) {
      content?.fill(0);
      throw error;
    }
  }

  private parseRequest(ref: AttachmentRef, url: string): { parsed: URL; token: string | null } {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new AttachmentError(BLOCKED_PREVIEW, 403);
    }
    const target = parseAttachmentUrl(url);
    if (
      !target ||
      parsed.hash ||
      parsed.username ||
      parsed.password ||
      target.emailId !== ref.emailId ||
      target.filename !== ref.filename ||
      target.accountId !== ref.accountId ||
      [...parsed.searchParams.keys()].some((key) => key !== 'account' && key !== 'preview') ||
      parsed.searchParams.getAll('account').length > 1 ||
      parsed.searchParams.getAll('preview').length > 1
    ) {
      throw new AttachmentError(BLOCKED_PREVIEW, 403);
    }
    return { parsed, token: parsed.searchParams.get('preview') };
  }

  /** Undefined allows the old cache path only when AV is disabled and no lease was presented. */
  async contentForRequest(
    ref: AttachmentRef,
    url: string,
    signal?: AbortSignal
  ): Promise<Buffer | undefined> {
    this.requireAvailable();
    const { parsed, token } = this.parseRequest(ref, url);
    this.prune();
    signal?.throwIfAborted();
    if (!parsed.searchParams.has('preview')) {
      if (this.deps.operations.scanningRequired()) throw new AttachmentError(BLOCKED_PREVIEW, 403);
      return undefined;
    }
    const lease = token ? this.leases.get(token) : undefined;
    if (
      !lease ||
      lease.ref.emailId !== ref.emailId ||
      lease.ref.filename !== ref.filename ||
      lease.ref.accountId !== ref.accountId
    ) {
      throw new AttachmentError(BLOCKED_PREVIEW, 403);
    }
    try {
      this.deps.operations.assertCurrentScanner(lease.extensionId);
      await waitForAbortableOperation(lease.receipt.assertCurrent(), signal);
      signal?.throwIfAborted();
      // A close or TTL timer may have erased the receipt while its account check awaited.
      if (this.leases.get(token!) !== lease || lease.expiresAt <= this.now())
        throw new Error(BLOCKED_PREVIEW);
      this.deps.operations.assertCurrentScanner(lease.extensionId);
      return lease.receipt.content;
    } catch (error) {
      if (signal?.aborted) throw error;
      this.releaseToken(token!);
      throw new AttachmentError(BLOCKED_PREVIEW, 403);
    }
  }

  releasePreview(url: string): boolean {
    const ref = parseAttachmentUrl(url);
    if (!ref) throw new AttachmentError(BLOCKED_PREVIEW, 403);
    const { token } = this.parseRequest(ref, url);
    if (!token) return false;
    const lease = this.leases.get(token);
    if (
      lease &&
      (lease.ref.emailId !== ref.emailId ||
        lease.ref.filename !== ref.filename ||
        lease.ref.accountId !== ref.accountId)
    ) {
      throw new AttachmentError(BLOCKED_PREVIEW, 403);
    }
    return this.releaseToken(token);
  }

  async openPreview(
    messageId: string,
    accountId: string,
    filename: string,
    requestId?: string,
    onUnscanned?: () => void
  ): Promise<void> {
    this.requireAvailable();
    if (!isPreviewableAttachment(filename))
      throw new AttachmentError('This file type cannot be opened from Sarv Inbox', 403);
    await this.deps.operations.run(
      messageId,
      accountId,
      filename,
      async (operation) => {
        let directory: string | undefined;
        let keep = false;
        let reserved = false;
        let unscanned: ProtectedDownloadContent | undefined;
        try {
          if (operation.notScanned) onUnscanned?.();
          let filePath: string;
          if (operation.content || operation.notScanned) {
            if (this.opened.size + this.pendingOpened >= MAX_PREVIEWS)
              throw new AttachmentError('Too many attachment previews. Try again shortly.', 429);
            this.pendingOpened++;
            reserved = true;
            if (operation.notScanned) {
              unscanned = await this.readUnscanned(
                { emailId: messageId, accountId, filename },
                operation
              );
            }
            const content = operation.content ?? unscanned!;
            const root = await this.prepareTemporaryRoot();
            directory = await fs.mkdtemp(path.join(root, 'preview-'));
            filePath = path.join(directory, safeFilename(filename));
            await operation.assertCurrent();
            await fs.writeFile(filePath, content.content, {
              mode: 0o600,
              flag: 'wx',
              signal: operation.signal,
            });
          } else filePath = await this.deps.resolveLegacy(messageId, filename, accountId);
          await operation.assertCurrent();
          const error = await waitForAbortableOperation(
            this.deps.openPath(filePath),
            operation.signal
          );
          await operation.assertCurrent();
          if (error) throw new Error(error);
          if (directory) {
            // External apps read after openPath resolves. Retain only this clean private copy briefly.
            const ownedDirectory = directory;
            const timer = setTimeout(() => {
              void this.removeOpened(ownedDirectory).catch((error) =>
                logger.warn('Could not remove temporary attachment preview:', error)
              );
            }, this.ttlMs);
            timer.unref?.();
            this.opened.set(ownedDirectory, timer);
            keep = true;
          }
        } finally {
          unscanned?.dispose();
          if (reserved) this.pendingOpened--;
          if (directory && !keep) await fs.rm(directory, { recursive: true, force: true });
        }
      },
      requestId,
      undefined,
      'open'
    );
  }

  private prepareTemporaryRoot(): Promise<string> {
    if (!this.temporaryRootReady) {
      this.temporaryRootReady = (async () => {
        const root = this.deps.temporaryRoot();
        await fs.mkdir(root, { recursive: true, mode: 0o700 });
        // Only our random per-preview entries are removed after an interrupted process.
        const entries = await fs.readdir(root, { withFileTypes: true });
        await Promise.all(
          entries
            .filter((entry) => entry.name.startsWith('preview-'))
            .map((entry) => fs.rm(path.join(root, entry.name), { recursive: true, force: true }))
        );
        return root;
      })().catch((error) => {
        this.temporaryRootReady = undefined;
        throw error;
      });
    }
    return this.temporaryRootReady;
  }

  private async removeOpened(directory: string): Promise<void> {
    const timer = this.opened.get(directory);
    if (!timer) return;
    this.opened.delete(directory);
    clearTimeout(timer);
    await fs.rm(directory, { recursive: true, force: true });
  }

  async dispose(): Promise<void> {
    this.closed = true;
    this.deps.operations.dispose();
    for (const token of this.leases.keys()) this.releaseToken(token);
    await Promise.all([...this.opened.keys()].map((directory) => this.removeOpened(directory)));
  }
}

let previews: AttachmentPreviewProtection | undefined;
export function getAttachmentPreviewProtection(): AttachmentPreviewProtection | undefined {
  return previews;
}
export function setAttachmentPreviewProtection(value: AttachmentPreviewProtection): void {
  if (previews && previews !== value)
    void previews
      .dispose()
      .catch((error) => logger.warn('Could not clear attachment previews:', error));
  previews = value;
}
