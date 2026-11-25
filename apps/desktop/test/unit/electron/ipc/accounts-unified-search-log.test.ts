import { accountLogLabel, getLogLevel, setLogLevel, setLogSink } from '@sarvinbox/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * What "All Inboxes" search writes to app.log when it fails. A search error
 * can name the words searched for (an FTS syntax error quotes the token it
 * choked on), and those are the user's own words about their mail. The
 * per-account line used to log the error's message, the whole-search line the
 * error itself.
 *
 * What breaks if this file fails: the user's search words reach app.log, or a
 * failing account stops being skipped (and takes the whole search down).
 */

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  accounts: new Map<string, unknown>(),
  pageFails: null as Error | null,
}));
vi.mock('electron', () => ({
  ipcMain: { handle: (name: string, fn: (...args: unknown[]) => unknown) => h.handlers.set(name, fn), on: () => {} },
}));
vi.mock('../../../../electron/services/accounts-registry', () => ({}));
vi.mock('../../../../electron/services/accounts-runtime', () => ({
  ensureAccountRuntime: async (id: string) => ({ storage: h.accounts.get(id) }),
}));
vi.mock('../../../../electron/services/antivirus-scan-service', () => ({}));
vi.mock('../../../../electron/services/attachment-warning-preferences', () => ({}));
vi.mock('../../../../electron/services/oauth-refresh-scheduler', () => ({}));
vi.mock('../../../../electron/services/outbox-service', () => ({}));
vi.mock('../../../../electron/services/reputation-service', () => ({}));
vi.mock('../../../../electron/services/unified-pipeline-service', () => ({}));
vi.mock('../../../../electron/shared', () => ({}));
// The real merge, with a seam to make it fail.
vi.mock('../../../../electron/utils/thread-page', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../electron/utils/thread-page')>();
  return {
    ...actual,
    pageThreadMatches: (...args: Parameters<typeof actual.pageThreadMatches>) => {
      if (h.pageFails) throw h.pageFails;
      return actual.pageThreadMatches(...args);
    },
  };
});

import { captureLogs, type CapturedLogs } from '../../../../../../packages/core/src/test-support/log-capture';
import { registerAccountsHandlers } from '../../../../electron/ipc/accounts-handlers';

const SENTINEL = 'SENTINEL-salary-revision-Jane';
const ftsError = () => Object.assign(new Error(`fts5: syntax error near "${SENTINEL}"`), { code: 'SQLITE_ERROR' });
const inbox = { getFolders: async () => [{ path: 'INBOX' }] };
type SearchResult = { success: boolean; data?: Array<{ id: string }>; total?: number };
const search = (accountIds: string[]) =>
  h.handlers.get('accounts:unifiedSearch')!(null, { accountIds, searchQuery: { textQuery: SENTINEL } }) as Promise<SearchResult>;

let logs: CapturedLogs;
beforeEach(() => {
  h.handlers.clear();
  h.pageFails = null;
  h.accounts = new Map<string, unknown>([
    ['ok', { ...inbox, searchEmails: async () => [{ id: 'm1', date: 1 }], searchEmailsCount: async () => 1 }],
    ['broken', { ...inbox, searchEmails: async () => { throw ftsError(); }, searchEmailsCount: async () => 0 }],
  ]);
  registerAccountsHandlers();
  logs = captureLogs({ setLogSink, setLogLevel, getLogLevel });
});
afterEach(() => { logs.stop(); });

describe('accounts:unifiedSearch — what reaches the log', () => {
  // Breaks: 'unifiedSearch: skipping account <id> <error message>' quotes the
  // search words; or one failing account fails the whole search.
  // Changed deliberately (log privacy): the id is written as its label (an
  // account id spells out its owner's address).
  it('skips a failing account, logging its id and the error class and code only', async () => {
    const result = await search(['ok', 'broken']);

    expect(result).toMatchObject({ success: true, total: 1 });
    expect(result.data?.map((row) => row.id)).toEqual(['m1']);
    expect(logs.containing(SENTINEL)).toEqual([]);
    expect(logs.containing('unifiedSearch: skipping account')).toEqual([
      `[WARN] [accounts-handlers] [Accounts] unifiedSearch: skipping account ${accountLogLabel('broken')} { name: 'Error', code: 'SQLITE_ERROR' }`,
    ]);
  });

  // Breaks: 'unifiedSearch failed: <error>' prints the error whole (message
  // and stack); the renderer still gets a failure to show.
  it('logs a failed search by the error class and code only', async () => {
    h.pageFails = ftsError();

    const result = await search(['ok']);

    expect(result.success).toBe(false);
    expect(logs.containing(SENTINEL)).toEqual([]);
    expect(logs.containing('unifiedSearch failed:')).toEqual([
      "[ERROR] [accounts-handlers] [Accounts] unifiedSearch failed: { name: 'Error', code: 'SQLITE_ERROR' }",
    ]);
  });
});
