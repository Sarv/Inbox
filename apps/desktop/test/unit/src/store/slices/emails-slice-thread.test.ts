import { afterEach, describe, expect, it, vi } from 'vitest';

// CategoryBadges is imported by the slice for its cache-clear helper; nothing
// here touches it, so a stub keeps the module graph free of IPC.
vi.mock('../../../../../src/components/email-list/CategoryBadges', () => ({
  clearCategoryBadgeCache: vi.fn(),
}));

import { createEmailsSlice } from '../../../../../src/store/slices/emails-slice';

/**
 * The open thread's rows (`loadThread`) and the "new message in this
 * conversation" banner (`noteNewEmailForOpenThread`).
 *
 * What breaks if this file goes red: a draft saved into the thread the reader
 * is typing in raises "New message" over their own draft; the reply box loses
 * the draft it is seeded from; or a message deleted into Gmail's or Outlook's
 * trash reappears in the conversation.
 */

const row = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  threadId: 't1',
  tags: '|INBOX|',
  date: 1_000,
  fromAddress: 's@x.com',
  rawBody: '<p>body</p>',
  cleanBody: 'body',
  ...over,
});

const FOLDERS = [
  { id: 'f1', path: 'INBOX', name: 'INBOX', specialUse: null },
  { id: 'f2', path: 'INBOX.Drafts', name: 'Drafts', specialUse: '\\Drafts' },
];

function harness(api: Record<string, unknown>, initial: Record<string, unknown> = {}) {
  const state: Record<string, any> = {
    threadEmails: [],
    pendingThreadEmailIds: [],
    selectedEmailId: null,
    viewAccountId: 'acct-a',
    folders: FOLDERS,
    loadingThread: false,
    ...initial,
  };
  (globalThis as any).window = { electronAPI: { emails: api } };
  const set = (patch: Record<string, any>) => { Object.assign(state, patch); };
  const holder: { slice?: any } = {};
  // The slice carries its own initial values; the harness state wins over them.
  const get = () => ({ ...holder.slice, ...state });
  // The slice reads only set and get; zustand's store api is not needed.
  const create = createEmailsSlice as unknown as (s: typeof set, g: typeof get) => any;
  holder.slice = create(set, get);
  return { state, slice: holder.slice };
}

afterEach(() => { delete (globalThis as any).window; });

describe('loadThread', () => {
  const load = async (rows: unknown[]) => {
    const h = harness({ getThread: async () => ({ success: true, data: rows }) });
    await h.slice.loadThread('t1');
    return (h.state.threadEmails as Array<{ id: string }>).map((each) => each.id);
  };

  // The reply box is seeded from the thread's draft: dropping drafts here
  // (they are not MESSAGES — the view excludes them) would lose it.
  it('keeps a draft for the compose box', async () => {
    expect(await load([row('a'), row('d', { tags: '|INBOX.Drafts|' })])).toEqual(['a', 'd']);
  });

  // Regression: the trash check was `|Trash|`/`|Spam|`/`|Junk|` only, so a
  // message deleted in Gmail (`[Gmail]/Trash`) or Outlook (`Deleted Items`,
  // `Junk Email`) stayed in the conversation. Same folder list as the
  // membership predicate now.
  it('drops Trash and junk copies by the shared folder list', async () => {
    const ids = await load([
      row('a'),
      row('g', { tags: '|[Gmail]/Trash|' }),
      row('o', { tags: '|Deleted Items|' }),
      row('j', { tags: '|Junk Email|' }),
      row('t', { tags: '|Trash|' }),
    ]);
    expect(ids).toEqual(['a']);
  });

  it('drops an empty unsent draft', async () => {
    expect(await load([row('a'), row('d', { tags: '|draft|', rawBody: '', cleanBody: '' })])).toEqual(['a']);
  });

  // Breaks: the blank-draft filter used a bare `|draft|` check of its own, so
  // the reader's SENT reply — a Sent copy that kept a stale `|draft|` tag,
  // body not downloaded yet — vanished from the open thread. It is the ONE
  // draft predicate now, which also drops a blank provider-path draft.
  it('keeps a bodiless Sent copy with a stale draft tag, and drops a blank provider-path draft', async () => {
    const blank = { rawBody: '', cleanBody: '' };
    expect(await load([
      row('a'),
      row('sent', { tags: '|Sent|draft|', ...blank }),
      row('gsent', { tags: '|[Gmail]/Sent Mail|draft|', ...blank }),
      row('pd', { tags: '|INBOX.Drafts|', ...blank }),
    ])).toEqual(['a', 'sent', 'gsent']);
  });

  // The reader is in the Spam folder: the whole conversation is junk, and it
  // must still show — a draft reply alone does not make the junk copies
  // "filtered out successfully".
  it('keeps an all-junk conversation, even beside a draft', async () => {
    expect(await load([row('s1', { tags: '|Spam|' }), row('s2', { tags: '|Spam|' })])).toEqual(['s1', 's2']);
    expect(await load([row('s1', { tags: '|Spam|' }), row('d', { tags: '|draft|' })])).toEqual(['s1', 'd']);
  });

  // The thread's account is stamped WITH its rows: the first-split cache is
  // keyed by thread id (the same id exists in every account), so its IPC must
  // name the account these rows came from — a missing account means the
  // cache calls go nowhere, a wrong one reads another mailbox's split.
  it('stamps threadAccountId as viewAccountId ?? activeAccountId', async () => {
    const getThread = vi.fn(async () => ({ success: true, data: [row('a')] }));
    const unified = harness({ getThread }, { viewAccountId: 'acct-b', activeAccountId: 'acct-a' });
    await unified.slice.loadThread('t1');
    expect(unified.state.threadAccountId).toBe('acct-b');
    expect(getThread).toHaveBeenCalledWith('t1', 'acct-b');

    const own = harness({ getThread }, { viewAccountId: null, activeAccountId: 'acct-a' });
    await own.slice.loadThread('t1');
    expect(own.state.threadAccountId).toBe('acct-a');

    const none = harness({ getThread }, { viewAccountId: null, activeAccountId: null });
    await none.slice.loadThread('t1');
    expect(none.state.threadAccountId).toBeNull();
  });

  // A failed load leaves the previous stamp alone with its previous rows —
  // never a new account beside old rows.
  it('does not re-stamp the account when the load fails', async () => {
    const h = harness(
      { getThread: async () => ({ success: false, error: 'db closed' }) },
      { viewAccountId: 'acct-b', threadAccountId: 'acct-a', threadEmails: [row('a')] },
    );
    await h.slice.loadThread('t1');
    expect(h.state.threadAccountId).toBe('acct-a');
    expect(h.state.threadEmails).toHaveLength(1);
  });

  it('clears the queued banner when the thread reloads', async () => {
    const h = harness({ getThread: async () => ({ success: true, data: [row('a')] }) }, { pendingThreadEmailIds: ['x'] });
    await h.slice.loadThread('t1');
    expect(h.state.pendingThreadEmailIds).toEqual([]);
  });
});

describe('noteNewEmailForOpenThread', () => {
  const open = (arrived: Record<string, unknown>) =>
    harness(
      { get: async () => ({ success: true, data: arrived }) },
      { selectedEmailId: 'a', threadEmails: [row('a')] },
    );

  // A real reply arriving over IDLE into the open thread raises the banner.
  it('queues a new message for the banner', async () => {
    const h = open(row('n', { tags: '|INBOX|' }));
    await h.slice.noteNewEmailForOpenThread('n');
    expect(h.state.pendingThreadEmailIds).toEqual(['n']);
  });

  // THE regression: saving a reply into the open thread (or the AI drafter
  // doing so) raised "New message in this conversation" over the draft the
  // reader was typing — for a local `|draft|` row and for a draft synced back
  // tagged only with the provider Drafts path.
  it('ignores a draft saved into the open thread', async () => {
    for (const tags of ['|draft|', '|INBOX.Drafts|', '|Drafts|']) {
      const h = open(row('d', { tags }));
      await h.slice.noteNewEmailForOpenThread('d');
      expect(h.state.pendingThreadEmailIds).toEqual([]);
    }
  });

  it('ignores mail for another thread', async () => {
    const h = open(row('n', { threadId: 't2' }));
    await h.slice.noteNewEmailForOpenThread('n');
    expect(h.state.pendingThreadEmailIds).toEqual([]);
  });
});

describe('the thread loaders’ failure paths', () => {
  // A failed read must neither throw into the caller nor leave the spinner on.
  it('logs a failed thread read and clears the spinner', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const h = harness({ getThread: async () => { throw new Error('db closed'); } });
    await h.slice.loadThread('t1');
    expect(h.state.loadingThread).toBe(false);
    expect(error.mock.calls.some((call) => String(call[0]).includes('[EmailsSlice] Failed to load thread t1: db closed'))).toBe(true);
    error.mockRestore();
  });

  it('logs a failed lookup of an arriving email and queues nothing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const h = harness(
      { get: async () => { throw new Error('ipc down'); } },
      { selectedEmailId: 'a', threadEmails: [row('a')] },
    );
    await h.slice.noteNewEmailForOpenThread('n');
    expect(h.state.pendingThreadEmailIds).toEqual([]);
    expect(warn.mock.calls.some((call) => String(call[0]).includes('noteNewEmailForOpenThread failed for n: ipc down'))).toBe(true);
    warn.mockRestore();
  });
});
