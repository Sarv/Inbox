import { afterEach, describe, expect, it, vi } from 'vitest';

// Reporting a message as spam also withdraws its sender's trust — main does it
// (spam-verdict-actions: `untrustSender`). What breaks if this file goes red:
// the renderer keeps its copy of the trusted senders, so the sender's OTHER
// messages stay "trusted" until a restart — the shield keeps setting its
// checks aside for them, and 'trusted' remote images keep fetching their
// tracking pixels.

const loadSlice = async (moveToSpam: (...args: unknown[]) => Promise<{ success: boolean; error?: string }>) => {
  vi.resetModules();
  const listTrustedSenders = vi.fn(async () => ({ success: true, data: [] }));
  (globalThis as any).window = { electronAPI: { emails: { moveToSpam: vi.fn(moveToSpam) }, spam: { listTrustedSenders } } };
  const mod = await import('../../../../../src/store/slices/email-actions-slice');
  let state: any = {};
  const set = (patch: any) => { state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) }; };
  const get = () => state;
  const slice = mod.createEmailActionsSlice(set, get, {} as any);
  state = {
    emails: [{ id: 'e1', threadId: 't1', tags: '|INBOX|' }], searchResults: [], threadEmails: [], sectionData: {},
    selectedEmailId: null, highlightedEmailId: null, manuallyMarkedUnreadId: null,
    ...slice,
    _accountIdFor: () => 'acct-b',
    loadFolders: vi.fn(),
    refreshCategoryCounts: vi.fn(),
  };
  return { get, listTrustedSenders };
};

afterEach(() => {
  delete (globalThis as any).window;
  vi.restoreAllMocks();
});

describe('moveToSpam — trusted senders follow the report', () => {
  // Multi-account: the report is filed in the message's own account (B), and
  // it is B's list that is re-read — by id, not "whichever is active".
  it("re-reads the message's account's trusted senders once the report is stored", async () => {
    const { get, listTrustedSenders } = await loadSlice(async () => ({ success: true }));
    await get().moveToSpam('e1');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(window.electronAPI.emails.moveToSpam).toHaveBeenCalledWith('e1', 'acct-b');
    expect(listTrustedSenders).toHaveBeenCalledWith('acct-b');
  });

  // A report main refused changed nothing — trust included — so nothing is re-read.
  it('re-reads nothing when the report was refused', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { get, listTrustedSenders } = await loadSlice(async () => ({ success: false, error: 'offline' }));
    await get().moveToSpam('e1');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(listTrustedSenders).not.toHaveBeenCalled();
    expect(get().emails.map((e: { id: string }) => e.id)).toEqual(['e1']); // rolled back
  });
});
