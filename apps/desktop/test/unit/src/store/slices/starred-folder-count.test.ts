import { afterEach, describe, expect, it, vi } from 'vitest';

// Starring a message moves the Starred mailbox's count at once, before the
// server answers. Which folder counts as "the Starred mailbox" must be the same
// rule that decides what opening a folder lists (isStarredFolder), never "starred"
// somewhere in the path: that bumped a user folder such as "Starred clients"
// when it was listed first, and left the real Starred count behind.

const loadSlice = async (seed: Record<string, any>) => {
  vi.resetModules();
  const markStarred = vi.fn(async () => ({ success: true }));
  (globalThis as any).window = { electronAPI: { emails: { markStarred } } };
  const mod = await import('../../../../../src/store/slices/email-actions-slice');
  let state: any = {};
  const set = (patch: any) => { state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) }; };
  const get = () => state;
  const slice = mod.createEmailActionsSlice(set, get, {} as any);
  state = {
    emails: [], searchResults: [], threadEmails: [], sectionData: {}, inboxSections: [], folders: [],
    ...slice,
    ...seed,
    _accountIdFor: () => 'acct-1',
    loadFolders: vi.fn(),
  };
  return { get, actions: slice as any, markStarred };
};

const row = (id: string, tags = '|INBOX|') => ({ id, threadId: `t-${id}`, tags, date: 1_000 });
const counts = (folders: Array<{ path: string; totalCount?: number }>) =>
  Object.fromEntries(folders.map((f) => [f.path, f.totalCount]));
/** Let the queued IMAP call (a setTimeout 0) run before the window goes away. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  delete (globalThis as any).window;
});

describe('markAsStarred — the Starred count it moves', () => {
  // Breaks if the substring test comes back: starring bumps "Starred clients"
  // (listed first) and the real Starred count stays one behind until a refresh.
  it('bumps the provider\'s Starred mailbox, not a user folder named "Starred clients"', async () => {
    const { get, actions, markStarred } = await loadSlice({
      emails: [row('e1')],
      folders: [
        { id: 'user', path: 'Starred clients', totalCount: 5 },
        { id: 'startups', path: 'Startups', totalCount: 7 },
        { id: 'gmail-starred', path: '[Gmail]/Starred', totalCount: 3 },
      ],
    });

    await actions.markAsStarred('e1', true);
    await settle();

    expect(counts(get().folders)).toEqual({ 'Starred clients': 5, Startups: 7, '[Gmail]/Starred': 4 });
    expect(markStarred).toHaveBeenCalledExactlyOnceWith('e1', true, 'acct-1');
  });

  // Breaks if unstarring takes the count off the wrong folder (or below zero).
  it('takes an unstar off the Starred mailbox only', async () => {
    const { get, actions } = await loadSlice({
      emails: [row('e1', '|INBOX|starred|')],
      folders: [
        { id: 'user', path: 'Starred clients', totalCount: 5 },
        { id: 'gmail-starred', path: '[Gmail]/Starred', totalCount: 3 },
      ],
    });

    await actions.markAsStarred('e1', false);
    await settle();

    expect(counts(get().folders)).toEqual({ 'Starred clients': 5, '[Gmail]/Starred': 2 });
  });

  // Breaks if a localised Gmail Starred (known only by its \Flagged
  // SPECIAL-USE flag, e.g. German "Markiert") stops getting the count.
  it('finds a localised Starred mailbox by its \\Flagged flag', async () => {
    const { get, actions } = await loadSlice({
      emails: [row('e1')],
      folders: [
        { id: 'inbox', path: 'INBOX', totalCount: 10 },
        { id: 'markiert', path: '[Gmail]/Markiert', specialUse: '\\Flagged', totalCount: 1 },
      ],
    });

    await actions.markAsStarred('e1', true);
    await settle();

    expect(counts(get().folders)).toEqual({ INBOX: 10, '[Gmail]/Markiert': 2 });
  });

  // Breaks if an account with no Starred mailbox gets some other folder's count
  // changed: "Startups" and "Mustard" contain "star" but are the user's own.
  it('leaves every count alone when the account has no Starred mailbox', async () => {
    const folders = [
      { id: 'inbox', path: 'INBOX', totalCount: 10 },
      { id: 'startups', path: 'Startups', totalCount: 7 },
      { id: 'mustard', path: 'Recipes/Mustard', totalCount: 2 },
    ];
    const { get, actions } = await loadSlice({ emails: [row('e1')], folders });

    await actions.markAsStarred('e1', true);
    await settle();

    expect(get().folders).toBe(folders);
    expect(get().emails[0].tags).toContain('|starred|');
  });
});
