import { afterEach, describe, expect, it, vi } from 'vitest';

// The list's AI icon reads `aiActions` from the rows already in state. When an
// agent action (or its Undo) changes an email in main, the open list must get
// the new record, in every place the email is shown, without a reload.

const loadSlice = async (seed: Record<string, any> = {}) => {
  vi.resetModules();
  (globalThis as any).window = { electronAPI: { emails: {} } };
  const mod = await import('../../../../../src/store/slices/email-actions-slice');
  let state: any = {};
  const set = (patch: any) => { state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) }; };
  const get = () => state;
  const slice = mod.createEmailActionsSlice(set, get, {} as any);
  state = {
    emails: [], searchResults: [], threadEmails: [], sectionData: {}, ...slice, ...seed, _accountIdFor: () => 'acct-1',
    loadFolders: vi.fn(), refreshCategoryCounts: vi.fn(), refreshUnreadSummary: vi.fn(),
  };
  return { get, actions: slice as any };
};

const installLocalStorage = () => {
  const store = new Map<string, string>();
  (globalThis as any).localStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
  };
};

const row = (id: string) => ({ id, threadId: `t-${id}`, tags: '|INBOX|', date: 1_000 });
const READ = [{ kind: 'read', at: 1, auto: true }];

afterEach(() => {
  delete (globalThis as any).window;
  delete (globalThis as any).localStorage;
});

describe('applyAiActions', () => {
  // Breaks: the row the agent just changed shows no AI icon until the list reloads,
  // or keeps one after Undo, in one of the panes showing the same email.
  it('updates the email in the list, the thread, the search results and every section', async () => {
    installLocalStorage();
    const { get, actions } = await loadSlice({
      emails: [row('e1'), row('e2')], threadEmails: [row('e1')], searchResults: [row('e1')],
      sectionData: { today: { emails: [row('e1')], threads: [], offset: 0, hasMore: false, total: 1, loading: false } },
    });
    actions.applyAiActions('e1', READ);
    expect(get().emails.map((e: any) => e.aiActions)).toEqual([READ, undefined]);
    expect(get().threadEmails[0].aiActions).toEqual(READ);
    expect(get().searchResults[0].aiActions).toEqual(READ);
    expect(get().sectionData.today.emails[0].aiActions).toEqual(READ);
    expect(get().sectionData.today.threads[0].emails[0].aiActions).toEqual(READ);
  });

  // Breaks: a malformed event clears other state or throws in the listener.
  it('ignores an update with no email or no list', async () => {
    const { get, actions } = await loadSlice({ emails: [row('e1')] });
    const before = get().emails;
    actions.applyAiActions('', READ);
    actions.applyAiActions('e1', undefined);
    expect(get().emails).toBe(before);
  });

  // Breaks: the tag helpers this shares stop flipping tags (the shared
  // updater replaced their own copies).
  it('leaves tag updates working through the same updater', async () => {
    const { get, actions } = await loadSlice({ emails: [row('e1')] });
    actions.applyPersistedTags('e1', '|INBOX|read|');
    expect(get().emails[0].tags).toBe('|INBOX|read|');
  });
});
