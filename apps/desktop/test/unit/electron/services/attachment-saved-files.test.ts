import { mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { writeProtectedAttachment } from '../../../../electron/services/attachment-download-protection';
import { AttachmentSavedFiles } from '../../../../electron/services/attachment-saved-files';

const temporary: string[] = [];
afterEach(async () => { for (const directory of temporary.splice(0)) await rm(directory, { recursive: true, force: true }); });
async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'inbox-saved-files-')); temporary.push(directory);
  let now = Date.now(); const openPath = vi.fn(async () => ''); const revealPath = vi.fn();
  const files = new AttachmentSavedFiles({ downloadsDirectory: () => directory, openPath, revealPath, now: () => now });
  return { directory, files, openPath, revealPath, advance: () => { now += 60 * 60_000 + 1; } };
}

describe('saved attachment receipts', () => {
  it('opens or reveals only an unchanged file saved by this host session', async () => {
    const f = await fixture(); const destination = path.join(f.directory, 'report.pdf'); await writeFile(destination, '%PDF synthetic');
    const receipt = await f.files.remember(destination, 'report.pdf');
    expect(receipt.canOpenSavedFile).toBe(true);
    await f.files.open(receipt.savedFileId); await f.files.reveal(receipt.savedFileId);
    expect(f.openPath).toHaveBeenCalledWith(destination); expect(f.revealPath).toHaveBeenCalledWith(destination);
    await expect(f.files.open(destination)).rejects.toThrow(/no longer available/);
    await writeFile(destination, 'replaced content');
    await expect(f.files.open(receipt.savedFileId)).rejects.toThrow(/moved or changed/);
    expect(f.openPath).toHaveBeenCalledOnce();
  });

  it('refuses executables and renamed executable destinations but allows revealing them', async () => {
    const f = await fixture(); const destination = path.join(f.directory, 'invoice.sh'); await writeFile(destination, 'synthetic');
    const receipt = await f.files.remember(destination, 'invoice.pdf');
    expect(receipt.canOpenSavedFile).toBe(false);
    await expect(f.files.open(receipt.savedFileId)).rejects.toThrow(/file type/);
    await f.files.reveal(receipt.savedFileId);
    expect(f.openPath).not.toHaveBeenCalled(); expect(f.revealPath).toHaveBeenCalledWith(destination);
  });

  it('rejects expired and symlink-replaced receipts without launching another path', async () => {
    const f = await fixture(); const destination = path.join(f.directory, 'document.pdf'); const other = path.join(f.directory, 'other.pdf');
    await writeFile(destination, 'synthetic'); await writeFile(other, 'other');
    const first = await f.files.remember(destination, 'document.pdf');
    await unlink(destination); await symlink(other, destination);
    await expect(f.files.open(first.savedFileId)).rejects.toThrow(/moved or changed/);
    const second = await f.files.remember(other, 'other.pdf'); f.advance();
    await expect(f.files.reveal(second.savedFileId)).rejects.toThrow(/no longer available/);
    expect(f.openPath).not.toHaveBeenCalled(); expect(f.revealPath).not.toHaveBeenCalled();
  });

  it('reserves distinct safe names across concurrent saves and never overwrites a race-created destination', async () => {
    const f = await fixture();
    const [first, second] = await Promise.all([f.files.chooseDownloadPath('../../report.pdf'), f.files.chooseDownloadPath('report.pdf')]);
    expect(new Set([first, second])).toEqual(new Set([path.join(f.directory, 'report.pdf'), path.join(f.directory, 'report (1).pdf')]));
    await writeFile(first, 'existing');
    await expect(writeProtectedAttachment(first, Buffer.from('new'), new AbortController().signal, async () => {}, true)).rejects.toMatchObject({ code: 'EEXIST' });
    expect((await readFile(first)).toString()).toBe('existing');
    await writeProtectedAttachment(second, Buffer.from('new'), new AbortController().signal, async () => {}, true);
    expect((await readFile(second)).toString()).toBe('new');
    f.files.releaseDownloadPath(first); f.files.releaseDownloadPath(second);
  });
});
