import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../../../src/components/email-list/CategoryBadges', () => ({
  clearCategoryBadgeCache: vi.fn(),
}));

import { createEmailsSlice } from '../../../../../src/store/slices/emails-slice';

// The Follow-ups view and opening a reminder's thread. What breaks: the view
// keeps a stale search or folder selection (the list shows one thing, the
// pane another), or clicking a reminder opens nothing because its sent
// message isn't in the visible list — or opens it from the wrong account's DB.

const harness = (state: Record<string, unknown> = {}) => {
  const h = {
    state: {
      activeAccountId: 'acct-a',
      threadEmails: [] as Array<{ threadId: string }>,
      pendingThreadEmailIds: ['stale'],
      selectedEmailId: 'old',
      viewAccountId: null as string | null,
      ...state,
    } as Record<string, any>,
    loaded: [] as string[],
    slice: null as any,
  };
  const set = (patch: Record<string, unknown>) => { Object.assign(h.state, patch); };
  const get = () => ({ ...h.slice, ...h.state, loadThread: async (threadId: string) => { h.loaded.push(threadId); } });
  h.slice = createEmailsSlice(set as any, get as any, undefined as any);
  return h;
};

describe('showFollowUps', () => {
  // A virtual view like Outbox: selection, search and other views cleared.
  it('switches to the follow-ups view and clears the previous one', () => {
    const h = harness({ selectedFolderId: 'f1', searchQuery: 'invoice', viewingSnoozed: true });
    h.slice.showFollowUps();
    expect(h.state).toMatchObject({
      selectedVirtualFolder: 'virtual-follow-ups',
      selectedFolderId: null,
      selectedEmailId: null,
      searchQuery: '',
      viewingSnoozed: false,
      viewingSection: null,
    });
  });
});

describe('openThread', () => {
  // The sent message is opened by its thread id, whatever the list holds.
  it('selects the message and loads its thread, dropping a different open thread', () => {
    const h = harness({ threadEmails: [{ threadId: 'other' }] });
    h.slice.openThread('sent-1', 't1');
    expect(h.state).toMatchObject({ selectedEmailId: 'sent-1', viewAccountId: null, threadEmails: [], pendingThreadEmailIds: [] });
    expect(h.loaded).toEqual(['t1']);
  });

  // Re-opening the thread already on screen must not blank the pane.
  it('keeps the loaded messages when it is the same thread', () => {
    const open = [{ threadId: 't1' }];
    const h = harness({ threadEmails: open });
    h.slice.openThread('sent-1', 't1', 'acct-a');
    expect(h.state.threadEmails).toBe(open);
    expect(h.state.viewAccountId).toBeNull();
  });

  // A reminder on a background account reads that account's DB.
  it('routes to the reminder\'s account when it is not the active one', () => {
    const h = harness();
    h.slice.openThread('sent-1', 't1', 'acct-b');
    expect(h.state.viewAccountId).toBe('acct-b');
  });
});
