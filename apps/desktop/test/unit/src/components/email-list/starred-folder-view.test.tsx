// @vitest-environment happy-dom
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { cleanup, render } from '../../../../helpers/render';

// Opening a folder: the main process lists the starred mail only for the
// provider's Starred mailbox (isStarredFolder), and the list must make the same
// call. When it filtered on "starred" anywhere in the path, a user folder such
// as "Starred clients" got its own mail from main and then hid every message
// in it that wasn't starred.

const store = vi.hoisted(() => ({} as Record<string, any>));
vi.mock('../../../../../src/store/email-store', () => ({
  useEmailStore: Object.assign(
    (select?: (state: typeof store) => unknown) => select ? select(store) : store,
    { getState: () => store },
  ),
}));
vi.mock('../../../../../src/appearance', () => ({ useAppearance: () => ({ hoverActions: false, snippetLines: 1 }) }));
vi.mock('../../../../../src/components/SearchBar', () => ({ SearchBar: ({ below }: { below?: ReactNode }) => <div>{below}</div> }));
vi.mock('../../../../../src/components/email-list/BulkActionBar', () => ({ BulkActionBar: () => null }));
vi.mock('../../../../../src/components/email-list/CategoryFilterBar', () => ({ CategoryFilterBar: () => null }));
vi.mock('../../../../../src/components/email-list/CategoryBadges', () => ({ getCachedCategorySlugs: () => [] }));
vi.mock('../../../../../src/components/email-list/CompactThreadRow', () => ({
  CompactThreadRow: ({ thread }: { thread: { threadId: string } }) => <div data-result-thread={thread.threadId} />,
}));
vi.mock('../../../../../src/components/email-list/ThreadCard', () => ({
  ThreadCard: ({ thread }: { thread: { threadId: string } }) => <div data-result-thread={thread.threadId} />,
}));

const { EmailList } = await import('../../../../../src/components/email-list/EmailList');

const message = (id: string, tags: string) => ({
  id, threadId: `t-${id}`, accountId: 'account-a', date: 1_000, tags,
  rawBody: '<p>Message.</p>', fromAddress: 'sender@example.test', toAddress: 'me@example.test',
});

const show = (folder: { path: string; specialUse?: string }) => {
  Object.assign(store, {
    folders: [{ id: 'open', name: folder.path.split('/').pop(), totalCount: 2, lastSyncTime: 1, ...folder }],
    emails: [message('starred-one', `|${folder.path}|starred|`), message('plain-one', `|${folder.path}|`)],
  });
  const mounted = render(<EmailList />);
  return [...mounted.container.querySelectorAll('[data-result-thread]')].map((row) => row.getAttribute('data-result-thread'));
};

beforeEach(() => {
  for (const key of Object.keys(store)) delete store[key];
  Object.assign(store, {
    emails: [], searchResults: [], selectedEmailId: null, highlightedEmailId: null,
    selectedFolderId: 'open', selectedVirtualFolder: null, viewingAICategory: null,
    viewingSnoozed: false, viewingSection: null, viewingSectionLabel: null, viewingSectionPageSize: 50,
    folders: [], accounts: [],
    inboxType: 'default', inboxSections: [], sectionData: {}, sectionLoading: new Set(),
    activeInboxFilter: null, activeInboxFilterLabel: null,
    loadingEmails: false, loadingMoreEmails: false, hasMoreEmails: false, emailsPage: 0, emailsTotal: 2,
    searchQuery: '', searchFilter: null, searching: false, searchPage: 0, searchHasMore: false, searchTotal: 0,
    searchingServer: false, serverSearchStatus: null, searchSuggestions: [],
    viewMode: 'no-split', syncing: false, syncingFolders: new Map(), showImportanceMarkers: false,
    goToEmailPage: vi.fn(), goToSearchPage: vi.fn(), fetchBodiesForVisibleEmails: vi.fn(),
  });
  localStorage.clear();
});
afterEach(cleanup);

describe('EmailList — which folder shows only starred mail', () => {
  // Breaks if the list's starred filter is looser than main's: a user folder
  // whose name contains "starred" shows only its starred messages.
  it.each(['Starred clients', 'Projects/Unstarred', 'Startups'])('shows all of %s', (path) => {
    expect(show({ path })).toEqual(['account-a::t-starred-one', 'account-a::t-plain-one']);
  });

  // Breaks if the provider's Starred mailbox stops filtering to starred mail,
  // including a localised one known only by its \Flagged flag.
  it.each([
    { path: '[Gmail]/Starred' },
    { path: 'Flagged' },
    { path: '[Gmail]/Markiert', specialUse: '\\Flagged' },
  ])('shows only the starred mail in $path', (folder) => {
    expect(show(folder)).toEqual(['account-a::t-starred-one']);
  });
});
