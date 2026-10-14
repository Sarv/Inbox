// @vitest-environment happy-dom
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { cleanup, render } from '../../../../helpers/render';

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

const message = (id: string, threadId: string) => ({
  id, threadId, accountId: 'account-a', date: 1_000,
  tags: '|INBOX|finance|', rawBody: '<p>Unread message.</p>',
  fromAddress: 'sender@example.test', toAddress: 'me@example.test',
});
const matchingMessages = [
  ...Array.from({ length: 31 }, (_, index) => message(`e${index}`, `t${index}`)),
  message('second-unread-in-t30', 't30'), message('third-unread-in-t30', 't30'),
];

beforeEach(() => {
  for (const key of Object.keys(store)) delete store[key];
  Object.assign(store, {
    emails: [], searchResults: [], selectedEmailId: null, highlightedEmailId: null,
    selectedFolderId: 'inbox', selectedVirtualFolder: null, viewingAICategory: null,
    viewingSnoozed: false, viewingSection: null, viewingSectionLabel: null, viewingSectionPageSize: 50,
    folders: [{ id: 'inbox', path: 'INBOX', totalCount: 31, lastSyncTime: 1 }], accounts: [],
    inboxType: 'default', inboxSections: [], sectionData: {}, sectionLoading: new Set(),
    activeInboxFilter: null, activeInboxFilterLabel: null,
    loadingEmails: false, loadingMoreEmails: false, hasMoreEmails: false, emailsPage: 0, emailsTotal: 31,
    searchQuery: '', searchFilter: null, searching: false, searchPage: 0, searchHasMore: false, searchTotal: 31,
    searchingServer: false, serverSearchStatus: null, searchSuggestions: [],
    viewMode: 'no-split', syncing: false, syncingFolders: new Map(), showImportanceMarkers: false,
    goToEmailPage: vi.fn(), goToSearchPage: vi.fn(), fetchBodiesForVisibleEmails: vi.fn(),
  });
  localStorage.clear();
});
afterEach(cleanup);

describe('conversation counts in the rendered result list', () => {
  it('shows 31 total matches on both search pages and counts the last 8 messages as 6 rows', () => {
    expect(matchingMessages).toHaveLength(33);
    Object.assign(store, {
      searchQuery: 'is:unread', searchFilter: { isUnread: true },
      searchResults: matchingMessages.slice(0, 25), searchHasMore: true,
    });
    const mounted = render(<EmailList />);
    expect(mounted.container.querySelectorAll('[data-result-thread]')).toHaveLength(25);
    expect(mounted.container.textContent).toContain('31 results');
    expect(mounted.container.textContent?.match(/1–25 of 31/g)).toHaveLength(2);

    Object.assign(store, { searchPage: 1, searchResults: matchingMessages.slice(25), searchHasMore: false });
    mounted.rerender(<EmailList />);

    expect(mounted.container.querySelectorAll('[data-result-thread]')).toHaveLength(6);
    expect(mounted.container.textContent).toContain('31 results');
    expect(mounted.container.textContent?.match(/26–31 of 31/g)).toHaveLength(2);
    expect(mounted.container.textContent).not.toContain('26–33');
    expect([...mounted.container.querySelectorAll<HTMLButtonElement>('button[aria-label="Older"]')].every((button) => button.disabled)).toBe(true);
  });

  it.each([
    { label: 'account category', selectedVirtualFolder: null },
    { label: 'unified category', selectedVirtualFolder: 'virtual-unified' },
  ])('uses the same six-row count in both $label paginators', ({ selectedVirtualFolder }) => {
    Object.assign(store, {
      viewingAICategory: 'finance', selectedVirtualFolder,
      emails: matchingMessages.slice(25), emailsPage: 1,
    });
    const mounted = render(<EmailList />);
    expect(mounted.container.querySelectorAll('[data-result-thread]')).toHaveLength(6);
    expect(mounted.container.textContent?.match(/26–31 of 31/g)).toHaveLength(2);
  });

  it('counts All Inboxes pages in account-scoped conversations', () => {
    Object.assign(store, {
      selectedFolderId: null, selectedVirtualFolder: 'virtual-unified',
      emails: matchingMessages.slice(25), emailsPage: 1, emailsTotal: 106,
    });
    const mounted = render(<EmailList />);
    expect(mounted.container.querySelectorAll('[data-result-thread]')).toHaveLength(6);
    expect(mounted.container.textContent?.match(/101–106 of 106/g)).toHaveLength(2);
  });

  it('keeps a hidden unread conversation out of the current search count and total', () => {
    Object.assign(store, {
      searchQuery: 'is:unread', searchFilter: { isUnread: true },
      searchResults: matchingMessages.slice(0, 25).map((row) => row.threadId === 't0' ? { ...row, tags: '|INBOX|finance|read|' } : row),
    });
    const mounted = render(<EmailList />);
    expect(mounted.container.querySelectorAll('[data-result-thread]')).toHaveLength(24);
    expect(mounted.container.textContent).toContain('30 results');
    expect(mounted.container.textContent?.match(/1–24 of 30/g)).toHaveLength(2);
  });

  it('keeps two accounts with the same thread ID as two visible conversations', () => {
    Object.assign(store, {
      searchQuery: 'is:unread', searchFilter: { isUnread: true }, searchTotal: 2,
      searchResults: [message('copy-a', 'same-thread'), { ...message('copy-b', 'same-thread'), accountId: 'account-b' }],
    });
    const mounted = render(<EmailList />);
    expect(mounted.container.querySelectorAll('[data-result-thread]')).toHaveLength(2);
    expect(mounted.container.textContent?.match(/1–2 of 2/g)).toHaveLength(2);
    expect(mounted.container.textContent).toContain('2 results');
  });

  it('counts empty stored thread IDs using each message ID, matching storage fallback', () => {
    Object.assign(store, {
      searchQuery: 'is:unread', searchFilter: { isUnread: true }, searchTotal: 2,
      searchResults: [message('first-unthreaded', ''), message('second-unthreaded', '')],
    });
    const mounted = render(<EmailList />);
    expect(mounted.container.querySelectorAll('[data-result-thread]')).toHaveLength(2);
    expect(mounted.container.textContent?.match(/1–2 of 2/g)).toHaveLength(2);
  });
});
