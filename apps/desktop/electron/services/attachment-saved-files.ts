import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';

import { isPreviewableAttachment, safeFilename } from '@sarvinbox/core';

interface SavedFile {
  filePath: string;
  originalFilename: string;
  device: number;
  inode: number;
  size: number;
  modified: number;
  expiresAt: number;
}

/** The renderer receives a receipt, never permission to open arbitrary paths. */
export class AttachmentSavedFiles {
  private receipts = new Map<string, SavedFile>();
  private reserved = new Set<string>();

  constructor(private deps: {
    downloadsDirectory(): string;
    openPath(filePath: string): Promise<string>;
    revealPath(filePath: string): void;
    now?: () => number;
  }) {}

  private now(): number { return this.deps.now?.() ?? Date.now(); }

  async chooseDownloadPath(filename: string): Promise<string> {
    const directory = this.deps.downloadsDirectory();
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const name = safeFilename(path.win32.basename(filename)) || 'attachment';
    const extension = path.extname(name);
    const stem = name.slice(0, name.length - extension.length);
    for (let suffix = 0; suffix < 10_000; suffix++) {
      const destination = path.join(directory, suffix ? `${stem} (${suffix})${extension}` : name);
      if (this.reserved.has(destination)) continue;
      try { await fs.lstat(destination); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        if (this.reserved.has(destination)) continue;
        this.reserved.add(destination);
        return destination;
      }
    }
    throw new Error('Too many files with this name in Downloads. Choose Save as instead.');
  }

  releaseDownloadPath(filePath: string): void { this.reserved.delete(filePath); }

  async remember(filePath: string, originalFilename: string): Promise<{ savedFileId: string; canOpenSavedFile: boolean }> {
    const stat = await fs.lstat(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('The saved attachment is no longer available.');
    for (const [id, receipt] of this.receipts) if (receipt.expiresAt <= this.now()) this.receipts.delete(id);
    while (this.receipts.size >= 100) this.receipts.delete(this.receipts.keys().next().value!);
    const savedFileId = randomUUID();
    this.receipts.set(savedFileId, { filePath, originalFilename, device: stat.dev, inode: stat.ino,
      size: stat.size, modified: stat.mtimeMs, expiresAt: this.now() + 60 * 60_000 });
    return { savedFileId, canOpenSavedFile: isPreviewableAttachment(originalFilename) && isPreviewableAttachment(filePath) };
  }

  private async resolve(id: string): Promise<SavedFile> {
    if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) throw new Error('This saved attachment is no longer available.');
    const receipt = this.receipts.get(id);
    if (!receipt || receipt.expiresAt <= this.now()) {
      this.receipts.delete(id);
      throw new Error('This saved attachment is no longer available. Download it again.');
    }
    const stat = await fs.lstat(receipt.filePath).catch(() => undefined);
    if (!stat || !stat.isFile() || stat.isSymbolicLink() || stat.dev !== receipt.device || stat.ino !== receipt.inode ||
      stat.size !== receipt.size || stat.mtimeMs !== receipt.modified) {
      this.receipts.delete(id);
      throw new Error('The saved attachment was moved or changed. Download it again.');
    }
    return receipt;
  }

  async open(id: string): Promise<void> {
    const receipt = await this.resolve(id);
    if (!isPreviewableAttachment(receipt.originalFilename) || !isPreviewableAttachment(receipt.filePath))
      throw new Error('This file type cannot be opened from Sarv Inbox. Use Show in folder instead.');
    const error = await this.deps.openPath(receipt.filePath);
    if (error) throw new Error(error);
  }

  async reveal(id: string): Promise<void> { this.deps.revealPath((await this.resolve(id)).filePath); }
}
