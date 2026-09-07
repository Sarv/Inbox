import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Move/Copy to an arbitrary folder. The invariants that matter for a mail client:
// MOVE optimistically leaves the current view and REVERTS on a hard failure (no
// ghost rows, no silent loss); COPY keeps the originals visible. Each test names
// the regression it guards.

const loadSlice = async (seed: Record<string, any> = {}) => {
  vi.resetModules();
  type Res = { success: boolean; error?: string; data?: any };
  const emailsApi = {
    moveToFolder: vi.fn(async (): Promise<Res> => ({ success: true })),
    copyToFolder: vi.fn(async (): Promise<Res> => ({ success: true })),
    bulkMoveToFolder: vi.fn(async (): Promise<Res> => ({ success: true, data: { moved: 2 } })),
    bulkCopyToFolder: vi.fn(async (): Promise<Res> => ({ success: true, data: { copied: 2 } })),
  };
  (globalThis as any).window = { electronAPI: { emails: emailsApi } };
  const mod = await import('../../../../../src/store/slices/email-actions-slice');
  let state: any = {};
  const set = (patch: any) => { state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) }; };
  const get = () => state;
  const slice = mod.createEmailActionsSlice(set, get, {} as any);
  state = {
    emails: [], searchResults: [], threadEmails: [], sectionData: null,
    selectedEmailId: null, highlightedEmailId: null, manuallyMarkedUnreadId: null,
    ...slice,
    ...seed,
    // Stubs LAST so they win over the slice's own (real) _accountIdFor.
    _accountIdFor: () => 'acct-1',
    loadFolders: vi.fn(),
    refreshCategoryCounts: vi.fn(),
  };
  return { get, actions: slice as any, emailsApi };
};

const rows = (...ids: string[]) => ids.map((id) => ({ id }));

beforeEach(() => { /* fresh per test via loadSlice */ });
afterEach(() => { delete (globalThis as any).window; });

describe('moveEmailToFolder', () => {
  // Regression: a move must drop the row from the current view and call the move
  // IPC with the chosen destination + owning account.
  it('optimistically removes the email and calls moveToFolder', async () => {
    const { get, actions, emailsApi } = await loadSlice({ emails: rows('e1', 'e2') });
    await actions.moveEmailToFolder('e1', 'folderX');
    expect(get().emails.map((e: any) => e.id)).toEqual(['e2']);
    expect(emailsApi.moveToFolder).toHaveBeenCalledWith('e1', 'folderX', 'acct-1');
    expect(get().loadFolders).toHaveBeenCalled();
  });

  // Regression: a permanent failure must NOT strand a ghost — the row comes back.
  it('reverts the optimistic removal when the move fails', async () => {
    const { get, actions, emailsApi } = await loadSlice({ emails: rows('e1', 'e2') });
    emailsApi.moveToFolder.mockResolvedValueOnce({ success: false, error: 'Destination folder not found' });
    await actions.moveEmailToFolder('e1', 'bad');
    expect(get().emails.map((e: any) => e.id)).toEqual(['e1', 'e2']); // restored
  });
});

describe('copyEmailToFolder', () => {
  // Copy keeps the original in the current view — removing it would look like a move.
  it('leaves the email in place and calls copyToFolder', async () => {
    const { get, actions, emailsApi } = await loadSlice({ emails: rows('e1', 'e2') });
    await actions.copyEmailToFolder('e1', 'folderX');
    expect(get().emails.map((e: any) => e.id)).toEqual(['e1', 'e2']); // unchanged
    expect(emailsApi.copyToFolder).toHaveBeenCalledWith('e1', 'folderX', 'acct-1');
    expect(get().loadFolders).toHaveBeenCalled();
  });

  // A failed copy is a no-op on the view (nothing was optimistically changed).
  it('does not mutate the view when copy fails', async () => {
    const { get, actions, emailsApi } = await loadSlice({ emails: rows('e1', 'e2') });
    emailsApi.copyToFolder.mockResolvedValueOnce({ success: false, error: 'nope' });
    await actions.copyEmailToFolder('e1', 'folderX');
    expect(get().emails.map((e: any) => e.id)).toEqual(['e1', 'e2']);
  });
});

describe('bulk move / copy to folder', () => {
  it('bulkMoveToFolder removes all selected and uses the ONE bulk IPC', async () => {
    const { get, actions, emailsApi } = await loadSlice({ emails: rows('e1', 'e2', 'e3') });
    await actions.bulkMoveToFolder(['e1', 'e2'], 'folderX');
    expect(get().emails.map((e: any) => e.id)).toEqual(['e3']);
    expect(emailsApi.bulkMoveToFolder).toHaveBeenCalledWith(['e1', 'e2'], 'folderX', 'acct-1');
    expect(emailsApi.moveToFolder).not.toHaveBeenCalled(); // bulk endpoint, not N singles
  });

  it('bulkCopyToFolder keeps all originals and uses the bulk copy IPC', async () => {
    const { get, actions, emailsApi } = await loadSlice({ emails: rows('e1', 'e2', 'e3') });
    await actions.bulkCopyToFolder(['e1', 'e2'], 'folderX');
    expect(get().emails.map((e: any) => e.id)).toEqual(['e1', 'e2', 'e3']); // all stay
    expect(emailsApi.bulkCopyToFolder).toHaveBeenCalledWith(['e1', 'e2'], 'folderX', 'acct-1');
  });

  it('a single-id bulk call routes to the single (not bulk) IPC', async () => {
    const { actions, emailsApi } = await loadSlice({ emails: rows('e1', 'e2') });
    await actions.bulkMoveToFolder(['e1'], 'folderX');
    expect(emailsApi.moveToFolder).toHaveBeenCalledWith('e1', 'folderX', 'acct-1');
    expect(emailsApi.bulkMoveToFolder).not.toHaveBeenCalled();
  });

  it('an empty selection is a no-op — no IPC call', async () => {
    const { actions, emailsApi } = await loadSlice({ emails: rows('e1') });
    await actions.bulkMoveToFolder([], 'folderX');
    expect(emailsApi.moveToFolder).not.toHaveBeenCalled();
    expect(emailsApi.bulkMoveToFolder).not.toHaveBeenCalled();
  });
});
