import { afterEach, describe, expect, it, vi } from 'vitest';

async function loadSlice() {
  vi.resetModules();
  const markImportant = vi.fn(async () => ({ success: true, error: undefined as string | undefined }));
  (globalThis as any).window = { electronAPI: { emails: { markImportant } } };
  const { createEmailActionsSlice } = await import('../../../../../src/store/slices/email-actions-slice');
  let state: any = {};
  const set = (patch: any) => { state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) }; };
  const get = () => state;
  const actions = createEmailActionsSlice(set, get, {} as any);
  const email = { id: 'e1', threadId: 't1', tags: '|INBOX|promotions|', date: 1000 };
  state = { ...actions, emails: [email], threadEmails: [email], searchResults: [email], sectionData: {},
    _accountIdFor: () => 'owner-account', refreshCategoryCounts: vi.fn() };
  return { actions, get, set, markImportant };
}

afterEach(() => { delete (globalThis as any).window; });

describe('markImportant', () => {
  it('uses the owning account and preserves Promotions', async () => {
    const { actions, get, markImportant } = await loadSlice();
    await actions.markImportant('e1', true);
    expect(markImportant).toHaveBeenCalledWith('e1', true, 'owner-account');
    expect(get().emails[0].tags).toBe('|INBOX|promotions|important|');
  });
  it.each(['failure', 'exception'])('rolls back a %s without losing a simultaneous label change', async (mode) => {
    const { actions, get, set, markImportant } = await loadSlice();
    markImportant.mockImplementationOnce(async () => {
      set({ emails: [{ ...get().emails[0], tags: '|INBOX|promotions|important|custom-label|' }] });
      if (mode === 'exception') throw new Error('IPC unavailable');
      return { success: false, error: 'Queue unavailable' };
    });
    await actions.markImportant('e1', true);
    expect(get().emails[0].tags).toBe('|INBOX|promotions|custom-label|');
    expect(get().threadEmails[0].tags).not.toContain('|important|');
    expect(get().searchResults[0].tags).not.toContain('|important|');
    expect(get().refreshCategoryCounts).not.toHaveBeenCalled();
  });
  it('serializes rapid toggles and restores the last confirmed choice when the final write fails', async () => {
    const { actions, get, set, markImportant } = await loadSlice();
    let firstResolve!: (result: { success: boolean; error: string | undefined }) => void;
    markImportant.mockImplementationOnce(() => new Promise((resolve) => { firstResolve = resolve; }));
    markImportant.mockResolvedValueOnce({ success: false, error: 'Queue unavailable' });
    const first = actions.markImportant('e1', true);
    const last = actions.markImportant('e1', false);
    expect(markImportant).toHaveBeenCalledTimes(1);
    set({ emails: [{ ...get().emails[0], tags: '|INBOX|promotions|important|custom-label|' }] });
    firstResolve({ success: true, error: undefined });
    await Promise.all([first, last]);
    expect(markImportant.mock.calls).toEqual([['e1', true, 'owner-account'], ['e1', false, 'owner-account']]);
    expect(get().emails[0].tags).toContain('|important|');
    expect(get().emails[0].tags).toContain('|custom-label|');
    expect(get().emails[0].tags).toContain('|promotions|');
  });
  it('an earlier failed toggle cannot roll back a later successful choice', async () => {
    const { actions, get, markImportant } = await loadSlice();
    let firstReject!: (error: Error) => void;
    markImportant.mockImplementationOnce(() => new Promise((_resolve, reject) => { firstReject = reject; }));
    const first = actions.markImportant('e1', true);
    const middle = actions.markImportant('e1', false);
    const last = actions.markImportant('e1', true);
    expect(markImportant).toHaveBeenCalledTimes(1);
    firstReject(new Error('IPC unavailable'));
    await Promise.all([first, middle, last]);
    expect(markImportant.mock.calls).toEqual([['e1', true, 'owner-account'], ['e1', true, 'owner-account']]);
    expect(get().emails[0].tags).toBe('|INBOX|promotions|important|');
  });
  it('does not block an independent message behind a pending toggle', async () => {
    const { actions, get, set, markImportant } = await loadSlice();
    set({ emails: [...get().emails, { id: 'e2', threadId: 't2', tags: '|INBOX|', date: 1000 }] });
    let firstResolve!: (result: { success: boolean; error: string | undefined }) => void;
    markImportant.mockImplementationOnce(() => new Promise((resolve) => { firstResolve = resolve; }));
    const first = actions.markImportant('e1', true);
    await actions.markImportant('e2', true);
    expect(markImportant).toHaveBeenCalledTimes(2);
    expect(get().emails[1].tags).toContain('|important|');
    firstResolve({ success: true, error: undefined });
    await first;
  });

});
