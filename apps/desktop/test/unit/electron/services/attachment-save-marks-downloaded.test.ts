import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ mark: vi.fn(async (_file: string) => {}) }));
vi.mock('../../../../electron/services/mark-downloaded', () => ({ markDownloadedFromInternet: h.mark }));

import { AttachmentOperationProtection, writeProtectedAttachment } from '../../../../electron/services/attachment-download-protection';
import { AttachmentPreviewProtection } from '../../../../electron/services/attachment-preview-protection';

// CASA 5.2.1 wiring. writeProtectedAttachment is the ONE writer behind Save,
// Save a copy, Save all, the automatic Downloads save and the OpenPGP save; the
// preview copy is what another app opens. If these fail, a saved attachment
// carries no "downloaded from the internet" mark and the OS opens it unwarned.

const directories: string[] = [];
afterEach(async () => {
  h.mark.mockReset();
  h.mark.mockImplementation(async () => {});
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function scratch(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'inbox-mark-wiring-'));
  directories.push(directory);
  return directory;
}

const exists = (file: string) => access(file).then(() => true, () => false);

describe('writeProtectedAttachment marks the saved file', () => {
  // Marked before the commit, on the temporary that BECOMES the file: the
  // destination is never visible unmarked, and the mark is on the bytes the
  // user gets (not on a copy that is then discarded).
  it.each([false, true])('marks the written bytes before they appear at the destination (exclusive=%s)', async (exclusive) => {
    const directory = await scratch();
    const destination = path.join(directory, 'invoice.pdf');
    let markedPath = '';
    h.mark.mockImplementation(async (file: string) => {
      markedPath = file;
      expect(await readFile(file, 'utf8')).toBe('pdf bytes');
      expect(await exists(destination)).toBe(false);
    });

    await writeProtectedAttachment(destination, Buffer.from('pdf bytes'), new AbortController().signal, async () => {}, exclusive);

    expect(h.mark).toHaveBeenCalledOnce();
    expect(path.dirname(markedPath)).toBe(directory);
    expect(path.basename(markedPath)).toMatch(/^\.inbox-download-.+\.partial$/);
    expect(await readFile(destination, 'utf8')).toBe('pdf bytes');
  });

  // The mark happens before the final authorization check; a revoked scan
  // must still leave nothing at the destination (the marked temporary goes).
  it('a revoked commit after marking still writes nothing', async () => {
    const directory = await scratch();
    const destination = path.join(directory, 'report.docx');
    await writeFile(destination, 'original');
    await expect(writeProtectedAttachment(destination, Buffer.from('new'), new AbortController().signal, async () => {
      throw new Error('scan revoked');
    })).rejects.toThrow('scan revoked');
    expect(h.mark).toHaveBeenCalledOnce();
    expect(await readFile(destination, 'utf8')).toBe('original');
    expect(await exists(h.mark.mock.calls[0][0])).toBe(false);
  });
});

describe('the preview copy defaults to the shared marker', () => {
  // A preview built without an explicit marker must still mark: the default is
  // the shared helper, not "no marking".
  it('marks the private copy with markDownloadedFromInternet before opening it', async () => {
    const root = await scratch();
    const openPath = vi.fn(async (_file: string) => {
      expect(h.mark).toHaveBeenCalledOnce();
      return '';
    });
    const preview = new AttachmentPreviewProtection({
      operations: new AttachmentOperationProtection({ scanners: () => [], scan: vi.fn(), openSetup: vi.fn(), progress: vi.fn() }),
      resolveLegacy: vi.fn(),
      readLegacy: vi.fn(),
      openPath,
      temporaryRoot: () => root,
    });
    try {
      await preview.openTemporaryCopy('calendar-event.ics', Buffer.from('BEGIN:VCALENDAR'), {
        signal: new AbortController().signal,
        assertCurrent: async () => {},
      });
      expect(h.mark).toHaveBeenCalledExactlyOnceWith(openPath.mock.calls[0][0]);
    } finally {
      await preview.dispose();
    }
  });
});
