import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';

import { createSearchAISlice } from '../../../../../src/store/slices/search-ai-slice';

/**
 * The search store's log lines say which fields a search used and whether one
 * is on — never what the user typed, what the AI made of it, or (for the
 * signature batch) a sender and a selector taken from their mail.
 *
 * What breaks if this file fails: a release app.log gets the user's search text
 * (`[Store] parsed query: {"textQuery":…}` on every search, `searchQuery=<text>`
 * on every category switch) or a sender + mail-derived selector per email.
 */

const SENTINEL = 'SENTINEL-QUERY-c7e2';
const h = vi.hoisted(() => ({
  parseSearchQuery: vi.fn(),
  detectSignature: vi.fn(),
  provider: vi.fn(),
  aiAssist: vi.fn(),
}));
vi.mock('../../../../../src/components/email-list/CategoryBadges', () => ({
  clearCategoryBadgeCache: vi.fn(), applyEmailCategories: vi.fn(),
  getCachedCategorySlugs: vi.fn(() => []), warmCategoryDefs: vi.fn(),
}));
vi.mock('../../../../../src/services/agent-settings', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  isAIAssistEnabled: () => h.aiAssist(),
}));
vi.mock('../../../../../src/services/ai-service', () => ({
  isAISearchEnabled: () => true, getDefaultProvider: () => h.provider(),
  parseSearchQuery: h.parseSearchQuery,
  isSignatureDetectionEnabled: () => true, detectSignature: h.detectSignature, getAIHealth: vi.fn(),
  reportAIHealthy: vi.fn(), reportAIUnhealthy: vi.fn(), syncAIProviderToMain: vi.fn(),
}));

const api = {
  search: vi.fn(async () => ({ success: true, data: [] })),
  searchCount: vi.fn(async () => ({ success: true, data: 0 })),
  emailsSearch: vi.fn(async () => ({ success: true, data: [{ id: 'fallback' }] })),
  getRecent: vi.fn(),
  getByCategory: vi.fn(async (): Promise<{ success: boolean; data?: unknown[]; error?: string }> => ({ success: true, data: [] })),
  startCategorization: vi.fn(async () => {}),
  stopCategorization: vi.fn(),
};

// Static imports, no vi.resetModules: the mocks above are guaranteed to be in
// place for a static import, and the slice reads window/localStorage per call.
function harness(state: Record<string, unknown> = {}) {
  vi.stubGlobal('window', {
    electronAPI: {
      ai: { search: api.search, searchCount: api.searchCount, getByCategory: api.getByCategory, getCategoryCounts: async () => ({ success: true, data: {} }) },
      aiCategorization: { start: api.startCategorization, stop: api.stopCategorization },
      accounts: { unifiedSearch: vi.fn(), unifiedInbox: vi.fn() },
      emails: { search: api.emailsSearch, searchServer: vi.fn(async () => ({ success: true, data: { skipped: true } })), getRecent: api.getRecent },
    },
  });
  const store = createStore<any>((set, get, zApi) => ({
    ...createSearchAISlice(set, get, zApi),
    activeAccountId: 'account-a', accounts: [{ id: 'account-a' }],
    folders: [{ id: 'inbox', path: 'INBOX' }], selectedFolderId: 'inbox', selectedVirtualFolder: null,
    inboxType: 'default', inboxSections: [], emails: [], emailsPage: 0, emailsTotal: 0,
    selectedEmailId: null, sectionData: {}, viewingSnoozed: false,
    ...state,
  }));
  return { get: store.getState, set: store.setState };
}

const consoleLines = (): string[] => (['log', 'info', 'warn', 'error', 'debug'] as const)
  .flatMap((method) => vi.mocked(console[method]).mock.calls)
  .map((args) => args.map((arg) => (typeof arg === 'string' ? arg : arg instanceof Error ? `${arg.stack} ${arg.message}` : JSON.stringify(arg))).join(' '));
const expectNoQueryInLog = () => {
  const lines = consoleLines();
  for (const line of lines) expect(line).not.toContain(SENTINEL);
  return lines.join('\n');
};

beforeEach(() => {
  vi.stubGlobal('localStorage', { getItem: () => null });
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) vi.spyOn(console, method).mockImplementation(() => {});
  h.parseSearchQuery.mockReset();
  h.detectSignature.mockReset();
  h.provider.mockReset().mockReturnValue({ id: 'p', type: 'custom', model: 'm' });
  h.aiAssist.mockReset().mockReturnValue(true);
  for (const fn of Object.values(api)) fn.mockClear();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('search logs field names, never the query', () => {
  // Breaks: `[Store] parsed query:` dumps the AI's parse (textQuery, from,
  // subject, the "Searching for: <query>" interpretation) on every search.
  it('logs the parsed field names and confidence only', async () => {
    h.parseSearchQuery.mockResolvedValue({ query: { textQuery: SENTINEL, from: `${SENTINEL}@x.example` }, interpretation: `Searching for ${SENTINEL}`, confidence: 0.8 });
    const { get } = harness();
    await get().search(`from:${SENTINEL} ${SENTINEL}`);
    expect(get().searchInterpretation).toBe(`Searching for ${SENTINEL}`);
    expect(expectNoQueryInLog()).toContain('parsed query fields=from,textQuery confidence=0.8');
  });

  // Breaks: a model that writes text where the confidence number belongs has
  // that text logged.
  it('logs a non-numeric confidence as "other", and an empty parse as "none"', async () => {
    h.parseSearchQuery.mockResolvedValue({ query: {}, interpretation: SENTINEL, confidence: `sure about ${SENTINEL}` });
    const { get } = harness();
    await get().search(SENTINEL, { skipAI: true });
    const log = expectNoQueryInLog();
    expect(log).toContain('fast search folder=all aiCategory=none skipAI=true');
    expect(log).toContain('parsed query fields=none confidence=other');
  });

  // Breaks: a search failure's message (an FTS error names its terms) is
  // logged, or the plain-text fallback stops running.
  it('logs a failed search by class and still falls back to a text search', async () => {
    h.parseSearchQuery.mockRejectedValue(new Error(`fts5: syntax error near "${SENTINEL}"`));
    const { get } = harness();
    await get().search(SENTINEL);
    expect(api.emailsSearch).toHaveBeenCalledWith(SENTINEL);
    expect(get().searchResults).toEqual([{ id: 'fallback' }]);
    expect(expectNoQueryInLog()).toContain('search failed, falling back to a plain text search {"name":"Error"}');
  });

  // Breaks: switching AI category while a search is active logs the search
  // text, or the category: `[View] Selected: AI Category "<slug>"` and `search
  // with context: {"aiCategory":"<slug>"}`, where a custom category's slug is
  // made from the name the user typed for it.
  it('says a search and a category are set when switching category, never which', async () => {
    const custom = `${SENTINEL}-client-projects`;
    h.parseSearchQuery.mockResolvedValue({ query: { textQuery: SENTINEL }, interpretation: SENTINEL, confidence: 1 });
    const { get } = harness({ searchQuery: SENTINEL });
    await get().loadAICategoryEmails(custom);
    expect(h.parseSearchQuery).toHaveBeenCalledWith(SENTINEL);
    expect(api.searchCount).toHaveBeenCalledWith(expect.objectContaining({ aiCategory: custom, folderId: 'inbox' }));
    const log = expectNoQueryInLog();
    expect(log).toContain('[View] selected an AI category (aiCategory=set, folder=set, search=set)');
    expect(log).toContain('AI-powered search folder=set aiCategory=set skipAI=false');
  });

  // Breaks: a search re-run without a category or folder logs either as set.
  it('says no folder and no category for a search across everything', async () => {
    h.parseSearchQuery.mockResolvedValue({ query: { textQuery: SENTINEL }, interpretation: SENTINEL, confidence: 1 });
    const { get } = harness();
    await get().search(SENTINEL, {});
    expect(expectNoQueryInLog()).toContain('AI-powered search folder=all aiCategory=none skipAI=false');
  });
});

describe('the recent-mail signature batch logs counts, never senders or selectors', () => {
  const recent = [
    { id: 'e1', fromAddress: `${SENTINEL}@sender.example`, rawBody: `<div class="sig-${SENTINEL}">x</div>` },
    { id: 'e2', fromAddress: `${SENTINEL}@other.example`, rawBody: '<p>y</p>' },
    { id: 'e3', fromAddress: `${SENTINEL}@third.example`, cleanBody: '<p>no signature here</p>' },
    { id: 'e4', fromAddress: '', rawBody: '<p>skipped: no sender</p>' },
  ];

  // Breaks: `[Store] Signature detected for <sender>: <selector>` comes back —
  // once per email, the selector lifted from the sender's HTML.
  it('logs one summary line for the batch, and a failed email by id and class', async () => {
    api.getRecent.mockResolvedValue({ success: true, data: recent });
    h.detectSignature
      .mockResolvedValueOnce({ hasSignature: true, htmlSelector: `div.sig-${SENTINEL}` })
      .mockRejectedValueOnce(new Error(`no selector for ${SENTINEL}`))
      .mockResolvedValueOnce({ hasSignature: false, htmlSelector: null });
    const { get } = harness();
    await get().processRecentEmailsForSignatures();
    expect(h.detectSignature).toHaveBeenCalledTimes(3);
    const log = expectNoQueryInLog();
    expect(log).toContain('failed to detect a signature for email e2 {"name":"Error"}');
    expect(log).toContain('signature detection processing complete (emails=4, detected=1)');
  });

  // Breaks: an empty batch, or a failed lookup, logs anything but its state.
  it('says when there is nothing to process, and logs a failed lookup by class', async () => {
    api.getRecent.mockResolvedValueOnce({ success: true, data: [] });
    const { get } = harness();
    await get().processRecentEmailsForSignatures();
    expect(expectNoQueryInLog()).toContain('no recent emails to process for signatures');

    api.getRecent.mockRejectedValueOnce(new Error(`database locked at ${SENTINEL}`));
    await get().processRecentEmailsForSignatures();
    expect(expectNoQueryInLog()).toContain('failed to process recent emails for signatures {"name":"Error"}');
  });
});

describe('the AI category list logs no category and no error text', () => {
  const custom = `${SENTINEL}-client-projects`;

  // Breaks: a failed category load logs main's error string (which can name
  // the custom category) or a thrown error's message, or stops clearing the
  // spinner. A failure main reports and one that throws are told apart.
  it('logs a failure main reports by whether it gave a reason, and a throw by class', async () => {
    api.getByCategory.mockResolvedValueOnce({ success: false, error: `no category named ${custom}` });
    const { get } = harness({ searchQuery: '', selectedFolderId: null });
    await get().loadAICategoryEmails(custom);
    expect(api.getByCategory).toHaveBeenCalledWith(custom, expect.any(Number), 0, undefined);
    expect(get().loadingEmails).toBe(false);
    let log = expectNoQueryInLog();
    expect(log).toContain('[View] selected an AI category (aiCategory=set, folder=all, search=none)');
    expect(log).toContain('main could not load AI category emails (error=set)');

    api.getByCategory.mockResolvedValueOnce({ success: false });
    await get().loadAICategoryEmails(`${custom}-other`);
    expect(expectNoQueryInLog()).toContain('main could not load AI category emails (error=none)');

    api.getByCategory.mockRejectedValueOnce(Object.assign(new Error(`SQLITE_ERROR near "${custom}"`), { code: 'SQLITE_ERROR' }));
    await get().loadAICategoryEmails(`${custom}-third`);
    expect(get().loadingEmails).toBe(false);
    log = expectNoQueryInLog();
    expect(log).toContain('failed to load AI category emails {"name":"Error","code":"SQLITE_ERROR"}');
  });
});

describe('AI categorization runs log through the shared logger, without the profile', () => {
  const lineFor = (text: string) => consoleLines().find((line) => line.includes(text));

  // Breaks: these lines go back to raw console output (unstructured in
  // app.log), or one of them starts naming the user's address, which the run
  // reads from the profile and hands to main.
  it('logs a stop, a run already going, AI Assist off, no provider, and a start', async () => {
    vi.stubGlobal('localStorage', { getItem: (key: string) => (key === 'sarvinbox-settings' ? JSON.stringify({ profileEmail: `${SENTINEL}@me.example` }) : null) });
    const { get, set } = harness({ aiProcessing: true });

    await get().processEmailsForAICategorization();
    expect(lineFor('AI categorization already in progress')).toMatch(/\[INFO\] \[SearchStore\]/);

    get().stopAIProcessing();
    expect(api.stopCategorization).toHaveBeenCalledTimes(1);
    expect(get().aiProcessing).toBe(false);
    expect(lineFor('AI processing stopped by the user')).toMatch(/\[INFO\] \[SearchStore\]/);

    h.aiAssist.mockReturnValueOnce(false);
    await get().processEmailsForAICategorization();
    expect(lineFor('AI Assist is off, not sending mail for categorization')).toMatch(/\[INFO\] \[SearchStore\]/);

    h.provider.mockReturnValueOnce(null);
    await get().processEmailsForAICategorization();
    expect(lineFor('no AI provider configured, skipping categorization')).toMatch(/\[INFO\] \[SearchStore\]/);
    expect(api.startCategorization).not.toHaveBeenCalled();

    set({ aiProcessing: false });
    await get().processEmailsForAICategorization();
    expect(api.startCategorization).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: 'p' }), 'bulk', expect.objectContaining({ userEmail: `${SENTINEL}@me.example` }),
    );
    expect(lineFor('starting AI categorization in the main process')).toMatch(/\[INFO\] \[SearchStore\]/);
    expectNoQueryInLog();
  });
});
