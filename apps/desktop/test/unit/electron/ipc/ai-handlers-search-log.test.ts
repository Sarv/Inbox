import { getLogLevel, setLogLevel, setLogSink } from '@sarvinbox/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `ai:search` runs the structured query the renderer parsed from what the user
 * typed into search. Its info line used to log that query object whole (words,
 * senders, recipients, subject, labels), and a release app.log keeps info.
 *
 * What breaks if this file fails: a user's search text reaches app.log, or the
 * search stops passing its filters to storage while the log line is changed.
 */

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...a: unknown[]) => unknown>(),
  searchEmails: vi.fn(),
  searchEmailsCount: vi.fn(),
  getFolder: vi.fn(),
}));

vi.mock('electron', () => ({
  ipcMain: { handle: (name: string, fn: (...a: unknown[]) => unknown) => h.handlers.set(name, fn) },
}));
vi.mock('../../../../electron/shared', () => ({
  requireStorage: () => ({ searchEmails: h.searchEmails, searchEmailsCount: h.searchEmailsCount, getFolder: h.getFolder }),
}));
vi.mock('../../../../electron/services/accounts-registry', () => ({ readRegistryAccounts: () => [] }));
vi.mock('../../../../electron/services/accounts-runtime', () => ({ ensureAccountRuntime: vi.fn() }));
vi.mock('../../../../electron/services/ai-backlog-cap', () => ({ getAutoBacklogCap: vi.fn(), setAutoBacklogCap: vi.fn() }));
vi.mock('../../../../electron/services/ai-secret-store', () => ({
  listAiSecretIds: vi.fn(), setAiSecret: vi.fn(), deleteAiSecret: vi.fn(), revertAiSecret: vi.fn(), isSecureStorageAvailable: vi.fn(), resolveAiKey: vi.fn(),
}));
vi.mock('../../../../electron/services/conversation-extraction-scheduler', () => ({
  setAIProviderConfigured: vi.fn(),
  setBackgroundSplitEnabled: vi.fn(),
}));
vi.mock('../../../../electron/services/pipeline-ai-config-store', () => ({ clearPipelineAIConfig: vi.fn() }));
vi.mock('../../../../electron/services/unified-pipeline-service', () => ({ onCategoryDefinitionUpserted: vi.fn() }));

import { captureLogs, type CapturedLogs } from '../../../../../../packages/core/src/test-support/log-capture';
import { registerAIHandlers } from '../../../../electron/ipc/ai-handlers';

registerAIHandlers();
const search = (query: Record<string, unknown>) => h.handlers.get('ai:search')!({}, query) as Promise<any>;
const searchCount = (query: Record<string, unknown>) => h.handlers.get('ai:searchCount')!({}, query) as Promise<any>;

const SENTINEL = 'SENTINEL-search';
let logs: CapturedLogs;
beforeEach(() => {
  h.searchEmails.mockReset().mockResolvedValue([{ id: 'e1' }]);
  h.searchEmailsCount.mockReset().mockResolvedValue(1);
  h.getFolder.mockReset().mockResolvedValue({ path: 'INBOX' });
  logs = captureLogs({ setLogSink, setLogLevel, getLogLevel });
});
afterEach(() => { logs.stop(); });

describe('ai:search and ai:searchCount — what reaches the log', () => {
  // Breaks: '[AI Search] Executing structured query:' dumps the query object.
  it('logs which filters are set, never what they hold, and still searches with them', async () => {
    const res = await search({
      textQuery: `${SENTINEL} words`, subject: `${SENTINEL} subject`, from: `${SENTINEL}@bank.example`,
      to: 'Jane SENTINEL', cc: `${SENTINEL}-cc`, labels: [`${SENTINEL}-label`], doesntHave: `${SENTINEL}-not`,
      isUnread: true, folderId: 'folder-1', aiCategory: 'invoice', limit: 50, offset: 100,
    });

    expect(res).toEqual({ success: true, data: [{ id: 'e1' }] });
    expect(h.searchEmails).toHaveBeenCalledWith(expect.objectContaining({
      query: `${SENTINEL} words`, subject: `${SENTINEL} subject`, from: `${SENTINEL}@bank.example`,
      labels: [`${SENTINEL}-label`], folderPath: 'INBOX', aiCategory: 'invoice', limit: 50, offset: 100,
    }));
    expect(logs.containing(SENTINEL)).toEqual([]);
    expect(logs.containing('Executing structured query')).toEqual([
      '[INFO] [ai-handlers] [AI Search] Executing structured query: '
        + 'fields=cc,doesntHave,from,isUnread,labels,subject,textQuery,to folder=set aiCategory=set limit=50 offset=100',
    ]);
    expect(logs.containing('[AI Search] Found 1 results (folder=INBOX, aiCategory=set)')).toHaveLength(1);
  });

  // Breaks: a custom category's slug (made from the name the user typed, e.g.
  // "SENTINEL-project-x" -> sentinel_project_x) is written by either search line.
  it('logs a category filter as set, never its slug, and still filters by it', async () => {
    const slug = 'sentinel_project_falcon';

    await search({ aiCategory: slug });

    expect(h.searchEmails).toHaveBeenCalledWith(expect.objectContaining({ aiCategory: slug }));
    expect(logs.containing('sentinel_project')).toEqual([]);
    expect(logs.containing('aiCategory=set')).toHaveLength(2);
  });

  // Breaks: a search for read mail (isUnread: false) logs as unfiltered
  // (fields=none) while the search really narrowed to read mail.
  it('logs a false boolean filter as set, since false narrows the search too', async () => {
    await search({ isUnread: false });

    expect(h.searchEmails).toHaveBeenCalledWith(expect.objectContaining({ isUnread: false }));
    expect(logs.containing('Executing structured query')).toEqual([
      '[INFO] [ai-handlers] [AI Search] Executing structured query: fields=isUnread folder=all aiCategory=none limit=default offset=0',
    ]);
  });

  // Breaks: a query with no filters, or a page number the renderer did not
  // send, logs as something other than the defaults the search really used.
  it('logs an empty query with the defaults', async () => {
    await search({});

    expect(logs.containing('Executing structured query')).toEqual([
      '[INFO] [ai-handlers] [AI Search] Executing structured query: fields=none folder=all aiCategory=none limit=default offset=0',
    ]);
  });

  // Breaks (failure path): a full-text search error names the query's tokens,
  // and the error line logs it whole.
  it('logs a failed search by error class and code', async () => {
    h.searchEmails.mockRejectedValue(Object.assign(new Error(`fts5: syntax error near "${SENTINEL}"`), { code: 'SQLITE_ERROR' }));

    const res = await search({ textQuery: `${SENTINEL} (` });

    expect(res).toEqual({ success: false, error: `fts5: syntax error near "${SENTINEL}"` });
    expect(logs.containing(SENTINEL)).toEqual([]);
    expect(logs.containing("[AI Search] Error: { name: 'Error', code: 'SQLITE_ERROR' }")).toHaveLength(1);
  });

  // Breaks (failure path, the sibling handler): the renderer sends the same
  // query to ai:searchCount, and its error line logged the error whole.
  it('logs a failed count by error class and code, and still answers', async () => {
    h.searchEmailsCount.mockRejectedValue(Object.assign(new Error(`fts5: syntax error near "${SENTINEL}"`), { code: 'SQLITE_ERROR' }));

    const res = await searchCount({ textQuery: `${SENTINEL} (`, subject: SENTINEL });

    expect(res).toEqual({ success: false, error: `fts5: syntax error near "${SENTINEL}"` });
    expect(h.searchEmailsCount).toHaveBeenCalledWith(expect.objectContaining({ query: `${SENTINEL} (`, subject: SENTINEL }));
    expect(logs.containing(SENTINEL)).toEqual([]);
    expect(logs.lines).toEqual(["[ERROR] [ai-handlers] [AI Search] Count error: { name: 'Error', code: 'SQLITE_ERROR' }"]);
  });

  // Breaks: a successful count starts logging the query (it logs nothing today).
  it('counts without logging anything', async () => {
    const res = await searchCount({ textQuery: `${SENTINEL} words` });

    expect(res).toEqual({ success: true, data: 1 });
    expect(logs.lines).toEqual([]);
  });
});
