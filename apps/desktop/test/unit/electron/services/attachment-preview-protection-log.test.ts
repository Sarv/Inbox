import { mkdtemp, rm as removeDirectory } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { getLogLevel, setLogLevel, setLogSink } from '@sarvinbox/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * What the "open in another app" preview writes to app.log when its private
 * copy cannot be removed. That copy is written under the attachment's own
 * name, and Node's error for a failed removal quotes the path: on Windows,
 * Word or Acrobat still holding the file makes the unlink fail with
 * `EBUSY: resource busy or locked, unlink 'C:\Users\<user>\…\preview-<id>\<name>'`,
 * the normal case once the preview's time limit passes. The error used to be
 * logged whole (the file name, and the Windows profile folder with it).
 *
 * What breaks if this file fails: an attachment's file name reaches app.log,
 * or a failed removal stops being reported with the code that explains it.
 */

const h = vi.hoisted(() => ({ rmFails: null as null | ((target: string) => Error | null) }));

// The real filesystem, with a seam to make a removal fail as Windows does.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    rm: (target: Parameters<typeof actual.rm>[0], options?: Parameters<typeof actual.rm>[1]) => {
      const failure = h.rmFails?.(String(target));
      return failure ? Promise.reject(failure) : actual.rm(target, options);
    },
  };
});

import { captureLogs, type CapturedLogs } from '../../../../../../packages/core/src/test-support/log-capture';
import { AttachmentOperationProtection } from '../../../../electron/services/attachment-download-protection';
import {
  AttachmentPreviewProtection,
  setAttachmentPreviewProtection,
} from '../../../../electron/services/attachment-preview-protection';

const SENTINEL = 'SENTINEL-Payslip-Jane-Doe.pdf';
/** What Node throws for a file another app holds open on Windows. */
const busy = (target: string) =>
  Object.assign(new Error(`EBUSY: resource busy or locked, unlink '${path.join(target, SENTINEL)}'`), {
    code: 'EBUSY', errno: -4082, syscall: 'unlink', path: path.join(target, SENTINEL),
  });
const operation = () => ({ signal: new AbortController().signal, assertCurrent: async () => {} });

let root: string;
let logs: CapturedLogs;
beforeEach(async () => {
  h.rmFails = null;
  root = await mkdtemp(path.join(tmpdir(), 'inbox-preview-log-'));
  logs = captureLogs({ setLogSink, setLogLevel, getLogLevel });
});
afterEach(async () => {
  logs.stop();
  h.rmFails = null;
  await removeDirectory(root, { recursive: true, force: true });
});

function preview(ttlMs = 300_000) {
  const operations = new AttachmentOperationProtection({ scanners: () => [], scan: vi.fn(), openSetup: vi.fn(), progress: vi.fn() });
  return new AttachmentPreviewProtection({
    operations,
    resolveLegacy: vi.fn(),
    readLegacy: vi.fn(),
    openPath: vi.fn(async () => ''),
    markDownloaded: vi.fn(async () => {}),
    temporaryRoot: () => root,
    ttlMs,
  });
}
/** Removals of a private copy's folder fail; the interrupted-process sweep at the root is left alone. */
const failCopyRemovals = () => { h.rmFails = (target) => (path.basename(target).startsWith('preview-') ? busy(target) : null); };

describe('attachment preview cleanup — what reaches the log', () => {
  // Breaks: 'Could not remove temporary attachment preview: <error>' quotes
  // the copy's path, which ends in the attachment's name.
  it('logs a copy that outlived its time limit by the error code, never its path', async () => {
    const previews = preview(10);
    await previews.openTemporaryCopy(SENTINEL, Buffer.from('%PDF'), operation());
    failCopyRemovals();

    await vi.waitFor(() => expect(logs.containing('Could not remove temporary attachment preview:')).toHaveLength(1));

    expect(logs.containing(SENTINEL)).toEqual([]);
    expect(logs.containing('Could not remove temporary attachment preview:')[0]).toContain("code: 'EBUSY'");
  });

  // Breaks: 'Could not clear attachment previews: <error>' (a replaced
  // preview controller disposing its predecessor) quotes the same path.
  it('logs a predecessor that could not be cleared by the error code, never its path', async () => {
    const first = preview();
    await first.openTemporaryCopy(SENTINEL, Buffer.from('%PDF'), operation());
    setAttachmentPreviewProtection(first);
    failCopyRemovals();

    setAttachmentPreviewProtection(preview());

    await vi.waitFor(() => expect(logs.containing('Could not clear attachment previews:')).toHaveLength(1));
    expect(logs.containing(SENTINEL)).toEqual([]);
    expect(logs.containing('Could not clear attachment previews:')[0]).toContain("code: 'EBUSY'");
  });

  // Breaks (the shutdown path main.ts logs, see main-preview-shutdown-log):
  // dispose() stops rejecting when a copy cannot be removed, so main's
  // shutdown line never fires and the failure goes unreported.
  it('rejects dispose() with the filesystem error when a copy cannot be removed', async () => {
    const previews = preview();
    await previews.openTemporaryCopy(SENTINEL, Buffer.from('%PDF'), operation());
    failCopyRemovals();

    await expect(previews.dispose()).rejects.toMatchObject({ code: 'EBUSY' });
  });
});
