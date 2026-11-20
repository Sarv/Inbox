import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { getLogLevel, safeFilename, setLogLevel, setLogSink } from '@sarvinbox/core';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * What retiring the old plaintext attachment cache writes to app.log when an
 * unsynced draft's attachment cannot be read or sealed. The file is read from
 * `<cache>/<emailId>/<attachment name>`, and Node's error for a failed read
 * quotes that path (the attachment's name, and on Windows the profile folder).
 * Both lines used to log the error whole.
 *
 * What breaks if this file fails: an attachment's file name reaches app.log,
 * or the draft's only copy is no longer kept for the next launch.
 */

const h = vi.hoisted(() => ({
  root: '',
  readFails: null as null | ((file: string) => Error | null),
  storeFails: null as Error | null,
  stored: [] as string[],
}));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    promises: {
      ...actual.promises,
      readFile: (file: string, ...rest: unknown[]) => {
        const failure = h.readFails?.(String(file));
        return failure
          ? Promise.reject(failure)
          : (actual.promises.readFile as (...a: unknown[]) => Promise<unknown>)(file, ...rest);
      },
    },
  };
});
vi.mock('../../../../electron/services/attachment-cache', () => ({
  legacyAttachmentCacheRoot: () => h.root,
  storeCachedAttachment: async (_accountId: string, _emailId: string, filename: string) => {
    if (h.storeFails) throw h.storeFails;
    h.stored.push(filename);
  },
}));
vi.mock('../../../../electron/services/accounts-registry', () => ({ readRegistryAccounts: () => [] }));
vi.mock('../../../../electron/services/accounts-runtime', () => ({ ensureAccountRuntime: async () => null }));

import { captureLogs, type CapturedLogs } from '../../../../../../packages/core/src/test-support/log-capture';
import { migrateLegacyAttachmentCache } from '../../../../electron/services/attachment-cache-legacy';

const SENTINEL = 'SENTINEL-Payslip-Jane-Doe.pdf';
const TMP = mkdtempSync(join(tmpdir(), 'attachment-legacy-log-'));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

/** One unsynced draft (no UID) whose only copy of SENTINEL lives in the legacy cache. */
const migrate = () => migrateLegacyAttachmentCache({
  accountIds: () => ['acct'],
  openAccount: async () => ({
    storage: { getEmail: async (id: string) => (id === 'draft-1' ? { id, uid: null, attachmentNames: JSON.stringify([SENTINEL]) } : null) },
  }),
});

let logs: CapturedLogs;
beforeEach(() => {
  h.root = mkdtempSync(join(TMP, 'cache-'));
  mkdirSync(join(h.root, 'draft-1'));
  writeFileSync(join(h.root, 'draft-1', safeFilename(SENTINEL)), '%PDF draft attachment');
  h.readFails = null;
  h.storeFails = null;
  h.stored = [];
  logs = captureLogs({ setLogSink, setLogLevel, getLogLevel });
});
afterEach(() => { logs.stop(); });

describe('legacy attachment cache retirement — what reaches the log', () => {
  // Breaks: 'could not read a legacy draft attachment; …' prints Node's error,
  // whose message quotes the path ending in the attachment's name.
  it('logs an unreadable draft attachment by its error code, and keeps the folder', async () => {
    h.readFails = (file) => (file.endsWith(safeFilename(SENTINEL))
      ? Object.assign(new Error(`EACCES: permission denied, open '${file}'`), { code: 'EACCES', path: file })
      : null);

    await expect(migrate()).resolves.toBe('partial');

    expect(logs.containing(SENTINEL)).toEqual([]);
    const [line] = logs.containing('could not read a legacy draft attachment');
    expect(line).toContain("code: 'EACCES'");
    expect(existsSync(join(h.root, 'draft-1', safeFilename(SENTINEL)))).toBe(true);
  });

  // Breaks: 'could not seal a legacy draft attachment; …' prints the store's
  // error whole, and a failure to write the sealed copy names the file too.
  it('logs a draft attachment that could not be sealed by its error code, and keeps the folder', async () => {
    h.storeFails = Object.assign(new Error(`ENOSPC: no space left on device, write '${SENTINEL}'`), { code: 'ENOSPC' });

    await expect(migrate()).resolves.toBe('partial');

    expect(logs.containing(SENTINEL)).toEqual([]);
    const [line] = logs.containing('could not seal a legacy draft attachment');
    expect(line).toContain("code: 'ENOSPC'");
    expect(existsSync(join(h.root, 'draft-1', safeFilename(SENTINEL)))).toBe(true);
  });

  // Breaks (idempotent re-run): once the failure clears, the next launch no
  // longer seals the draft's file and retires the folder.
  it('seals the draft and removes the plaintext on the next launch once the read works', async () => {
    h.readFails = () => Object.assign(new Error('EIO: i/o error'), { code: 'EIO' });
    await expect(migrate()).resolves.toBe('partial');
    h.readFails = null;

    await expect(migrate()).resolves.toBe('done');

    expect(h.stored).toEqual([SENTINEL]);
    expect(existsSync(h.root)).toBe(false);
  });
});
