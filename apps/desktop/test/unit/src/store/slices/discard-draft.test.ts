import { afterEach, describe, expect, it, vi } from 'vitest';

// Discarding a thread's draft(s) optimistically, by the ONE draft predicate
// (core `isDraftRow`, decision 6). What breaks if this file goes red: the
// discard's hand-rolled `|draft|` / `|Drafts|` check comes back, and a sent
// copy that kept a stale `|draft|` tag — the reader's own reply — vanishes from
// the open thread the moment a draft beside it is discarded, while an
// IMAP-synced draft tagged only with its provider path (`|INBOX.Drafts|`)
// lingers in the thread as if it were a message.

const FOLDERS = [
  { id: 'f1', path: 'INBOX', name: 'INBOX', specialUse: null },
  { id: 'f2', path: 'INBOX.Drafts', name: 'Drafts', specialUse: '\\Drafts' },
  { id: 'f3', path: 'INBOX.Sent', name: 'Sent', specialUse: '\\Sent' },
];

const loadSlice = async (seed: Record<string, any>, remove: () => Promise<unknown>) => {
  vi.resetModules();
  (globalThis as any).window = { electronAPI: { drafts: { delete: vi.fn(remove), debug: vi.fn() } } };
  const mod = await import('../../../../../src/store/slices/email-actions-slice');
  let state: any = {};
  const set = (patch: any) => { state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) }; };
  const get = () => state;
  const slice = mod.createEmailActionsSlice(set, get, {} as any);
  state = {
    emails: [], searchResults: [], threadEmails: [], sectionData: {},
    folders: FOLDERS,
    viewAccountId: null,
    ...slice,
    ...seed,
  };
  return { get, actions: slice as any, bridge: (globalThis as any).window.electronAPI.drafts };
};

const row = (id: string, tags: string, threadId = 't1') => ({ id, messageId: `<${id}>`, threadId, tags, date: 1_000 });

const THREAD = [
  row('inbox', '|INBOX|read|'),
  row('sent-std', '|Sent|draft|'),
  row('sent-gmail', '|[Gmail]/Sent Mail|draft|'),
  row('sent-path', '|INBOX.Sent|draft|'),
  row('mirror', '|draft|'),
  row('synced', '|INBOX.Drafts|'),
];
const ids = (rows: Array<{ id: string }>) => rows.map((r) => r.id);

afterEach(() => {
  delete (globalThis as any).window;
  vi.restoreAllMocks();
});

describe('discardDraft — the thread\'s drafts, by the one predicate', () => {
  // THE regression: the sent copies (standard, Gmail, and the account's own
  // Sent path) stay; the local mirror and the provider-path draft go.
  it('keeps sent copies with a stale draft tag and removes every real draft', async () => {
    const { get, actions } = await loadSlice({ threadEmails: THREAD, emails: [row('mirror', '|draft|')] }, async () => ({ success: true }));
    await actions.discardDraft('<mirror>', 't1', 'acct-a');
    expect(ids(get().threadEmails)).toEqual(['inbox', 'sent-std', 'sent-gmail', 'sent-path']);
    expect(ids(get().emails)).toEqual([]);
  });

  // Only the discarded thread is touched: another thread's draft stays.
  it('leaves another thread\'s draft alone', async () => {
    const other = row('elsewhere', '|draft|', 't2');
    const { get, actions } = await loadSlice({ emails: [other], threadEmails: THREAD }, async () => ({ success: true }));
    await actions.discardDraft('<mirror>', 't1', 'acct-a');
    expect(ids(get().emails)).toEqual(['elsewhere']);
  });

  // Failure path: the server delete fails (a connection blip) — the drafts
  // removed optimistically come back, and the sent copies were never touched.
  it('restores the removed drafts when the delete fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { get, actions } = await loadSlice({ threadEmails: THREAD }, async () => ({ success: false, error: 'ECONNRESET' }));
    await actions.discardDraft('<mirror>', 't1', 'acct-a');
    expect(ids(get().threadEmails).sort()).toEqual(ids(THREAD).sort());
  });
});
