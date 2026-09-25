import { Loader2, Filter, X, Globe } from 'lucide-react';
import { useState, useRef, useCallback, useMemo, useEffect } from 'react';
import { useShallow } from 'zustand/react/shallow';

import { isDraftsFolder } from '../../config/folder-mapping';
import { SECTION_FILTER_LABELS, SETTINGS_KEY, DEFAULT_SECTIONS } from '../../config/inbox-types';
import type { SectionFilter } from '../../config/inbox-types';
import { useEmailStore } from '../../store/email-store';
import { accountDisplayLabel, getEmailsPerPage, getPageSizeForView, isThreadPagedView } from '../../store/helpers';
import { emailMatchesLiveSearchFilter, hasLiveSearchFilterTokens } from '../../utils/search-filter';
import type { SectionData , EmailThread } from '../../utils/thread-utils';
import { adjustTotalForFilteredOut, buildThreads, sectionIsVisible, threadStaysVisible, visibleThreadsUnderFilter } from '../../utils/thread-utils';
import { SearchBar } from '../SearchBar';
import { canOfferServerSearch, hasServerSearchableParsedQuery } from '../server-search';
import { Tooltip } from '../Tooltip';

import { actionableEmailIds, selectedEmailIdsFor } from './bulk-selection';
import { BulkActionBar } from './BulkActionBar';
import { getCachedCategorySlugs } from './CategoryBadges';
import { CategoryFilterBar } from './CategoryFilterBar';
import { CompactThreadRow } from './CompactThreadRow';
import { EMPTY_LIST_MESSAGES, emptyListReason } from './empty-list-view';
import { useEmailListSearch } from './hooks/useEmailListSearch';
import { useSectionAssignment } from './hooks/useSectionAssignment';
import { listHeaderTitle } from './list-header-view';
import { ListHeader } from './ListHeader';
import { Paginator } from './Paginator';
import { SectionList } from './SectionList';
import { ThreadCard } from './ThreadCard';
import type { ThreadActions, ThreadHoverActions, RowUIState } from './types';

/** Map section filter + inbox context to the DB filter string */
function getDbFilter(filter: SectionFilter, inboxType: string): string {
  if (inboxType === 'important_first' && filter === 'everything_else') return 'not_important';
  if (inboxType === 'unread_first' && filter === 'everything_else') return 'read';
  return filter;
}

export function EmailList() {
  // Slice-select with shallow equality so the list only re-renders when one of
  // these specific fields changes — NOT on every unrelated store mutation.
  const {
    emails,
    selectedEmailId,
    highlightedEmailId,
    selectedFolderId,
    selectEmail,
    loadingEmails,
    loadingMoreEmails,
    hasMoreEmails,
    emailsPage,
    emailsTotal,
    goToEmailPage,
    searchResults,
    searchFilter,
    searching,
    searchPage,
    searchHasMore,
    searchTotal,
    goToSearchPage,
    searchServer,
    searchingServer,
    serverSearchStatus,
    viewingSnoozed,
    viewingAICategory,
    selectedVirtualFolder,
    viewMode,
    syncing,
    syncingFolders,
    syncEmails,
    runBackgroundSyncCycle,
    folders,
    fetchBodiesForVisibleEmails,
    inboxType,
    showImportanceMarkers,
    inboxSections,
    sectionData,
    sectionLoading,
    loadMoreSectionEmails,
    viewingSection,
    viewingSectionLabel,
    viewingSectionPageSize,
    openSectionFullPage,
    closeSectionFullPage,
    activeInboxFilter,
    activeInboxFilterLabel,
    setInboxFilter,
    snoozeEmail,
    unsnoozeEmail,
    bulkRemoveEmails,
    bulkMarkRead,
    bulkMarkStarred,
    bulkMoveToFolder,
    bulkCopyToFolder,
  } = useEmailStore(
    useShallow((s) => ({
      emails: s.emails,
      selectedEmailId: s.selectedEmailId,
      highlightedEmailId: s.highlightedEmailId,
      selectedFolderId: s.selectedFolderId,
      selectEmail: s.selectEmail,
      loadingEmails: s.loadingEmails,
      loadingMoreEmails: s.loadingMoreEmails,
      hasMoreEmails: s.hasMoreEmails,
      emailsPage: s.emailsPage,
      emailsTotal: s.emailsTotal,
      goToEmailPage: s.goToEmailPage,
      searchResults: s.searchResults,
      searchFilter: s.searchFilter,
      searching: s.searching,
      searchPage: s.searchPage,
      searchHasMore: s.searchHasMore,
      searchTotal: s.searchTotal,
      goToSearchPage: s.goToSearchPage,
      searchServer: s.searchServer,
      searchingServer: s.searchingServer,
      serverSearchStatus: s.serverSearchStatus,
      viewingSnoozed: s.viewingSnoozed,
      viewingAICategory: s.viewingAICategory,
      selectedVirtualFolder: s.selectedVirtualFolder,
      viewMode: s.viewMode,
      syncing: s.syncing,
      syncingFolders: s.syncingFolders,
      syncEmails: s.syncEmails,
      runBackgroundSyncCycle: s.runBackgroundSyncCycle,
      folders: s.folders,
      fetchBodiesForVisibleEmails: s.fetchBodiesForVisibleEmails,
      inboxType: s.inboxType,
      showImportanceMarkers: s.showImportanceMarkers,
      inboxSections: s.inboxSections,
      sectionData: s.sectionData,
      sectionLoading: s.sectionLoading,
      loadMoreSectionEmails: s.loadMoreSectionEmails,
      viewingSection: s.viewingSection,
      viewingSectionLabel: s.viewingSectionLabel,
      viewingSectionPageSize: s.viewingSectionPageSize,
      openSectionFullPage: s.openSectionFullPage,
      closeSectionFullPage: s.closeSectionFullPage,
      activeInboxFilter: s.activeInboxFilter,
      activeInboxFilterLabel: s.activeInboxFilterLabel,
      setInboxFilter: s.setInboxFilter,
      snoozeEmail: s.snoozeEmail,
      unsnoozeEmail: s.unsnoozeEmail,
      bulkRemoveEmails: s.bulkRemoveEmails,
      bulkMarkRead: s.bulkMarkRead,
      bulkMarkStarred: s.bulkMarkStarred,
      bulkMoveToFolder: s.bulkMoveToFolder,
      bulkCopyToFolder: s.bulkCopyToFolder,
    })),
  );

  const listRef = useRef<HTMLDivElement>(null);

  // Local UI state
  const [selectedThreadIds, setSelectedThreadIds] = useState<Set<string>>(new Set());
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(() => {
    try {
      const stored = localStorage.getItem('sarvinbox-collapsed-sections');
      return stored ? new Set(JSON.parse(stored)) : new Set();
    } catch { return new Set(); }
  });
  const [hoveredThreadId, setHoveredThreadId] = useState<string | null>(null);
  const [snoozeDropdownThreadId, setSnoozeDropdownThreadId] = useState<string | null>(null);
  const [showViewModeDropdown, setShowViewModeDropdown] = useState(false);
  const [expandedSectionIds, setExpandedSectionIds] = useState<Set<string>>(new Set());
  const [sectionMenuId, setSectionMenuId] = useState<string | null>(null);
  const [hoveredPaginationId, setHoveredPaginationId] = useState<string | null>(null);
  const [countdownTick, setCountdownTick] = useState(0);

  // Search hook
  const {
    localSearchQuery,
    setLocalSearchQuery,
    showAdvancedSearch,
    setShowAdvancedSearch,
    searchFocused,
    setSearchFocused,
    getSearchContext,
    handleSearch,
    handleClearSearch,
    search,
    searchQuery,
    searchSuggestions,
  } = useEmailListSearch();

  // Check if viewing starred/important folder
  const selectedFolder = folders.find(f => f.id === selectedFolderId);

  // Drafts context for bulk actions. Both are derived from the SAME folder list
  // the rest of the view uses, so a provider-specific path (INBOX.Drafts,
  // [Gmail]/Drafts) is covered without a hardcoded name.
  const viewIsDrafts = !!selectedFolder && isDraftsFolder(selectedFolder as never);
  const draftFolderPaths = useMemo(
    () => new Set(folders.filter(f => isDraftsFolder(f as never)).map(f => f.path)),
    [folders],
  );
  const isInboxFolder = selectedFolder?.path === 'INBOX';
  // True while this folder's mail is still resolving (global sync or this
  // folder's own sync) — lets empty sections show "checking…" not "none".
  const isViewSyncing = syncing || (selectedFolder ? syncingFolders.has(selectedFolder.path) : false);
  const isStarredFolder = selectedFolder?.path?.toLowerCase().includes('starred') ||
                          selectedFolder?.path?.includes('[Gmail]/Starred');
  const isImportantFolder = selectedFolder?.path?.toLowerCase().includes('important') ||
                            selectedFolder?.path?.includes('[Gmail]/Important');
  const folderPathLc = selectedFolder?.path?.toLowerCase() ?? '';
  const folderSpecialUse = (selectedFolder as { specialUse?: string | null } | undefined)?.specialUse;
  const isTrashFolder = folderSpecialUse === '\\Trash' ||
                        folderPathLc.includes('trash') || folderPathLc === 'deleted items';
  const isSpamFolder = folderSpecialUse === '\\Junk' ||
                       folderPathLc.includes('spam') || folderPathLc.includes('junk');
  const isVirtualImportant = selectedVirtualFolder === 'virtual-important';
  const isImportantView = isImportantFolder || isVirtualImportant;

  // The current view's page size — shared by the header and footer paginators
  // and by the store loaders, so they can never disagree. The tiers live in
  // getPageSizeForView: section 50, "All Email"/"All Inboxes" 100, the account's
  // own standard mailboxes (Sent, Drafts, …) 50, everything else emailsPerPage.
  const listPageSize = viewingSection
    ? viewingSectionPageSize
    : getPageSizeForView({
        virtualFolder: selectedVirtualFolder,
        aiCategory: viewingAICategory,
        snoozed: viewingSnoozed,
        folder: selectedFolder,
      });

  // Filter emails
  const displayEmails = useMemo(() => {
    let baseEmails = searchQuery ? searchResults : emails;
    if (isStarredFolder) {
      baseEmails = baseEmails.filter(email => (email.tags || '').includes('|starred|'));
    }
    // Active search filter with a live state token (is:unread / is:starred):
    // re-check each row against its CURRENT tags so an optimistic action
    // (mark read, unstar) drops the now-non-matching row from the list instantly.
    if (searchQuery && hasLiveSearchFilterTokens(searchFilter)) {
      baseEmails = baseEmails.filter(email => emailMatchesLiveSearchFilter(email, searchFilter!));
    }
    return baseEmails;
  }, [searchQuery, searchResults, emails, isStarredFolder, searchFilter]);

  const isSearching = searchQuery && searching;

  // Group emails by thread
  const threads = useMemo(() => {
    return buildThreads(displayEmails);
  }, [displayEmails]);

  // The FLAT list re-checks the active quick-filter at render, exactly as both
  // section paths do. Without this, "Filtered: Unread" + mark-as-read left every
  // row sitting there — the rows are fetched by a server query and nothing
  // re-queries until the view reloads, so an optimistic tag change was invisible
  // and the action looked like it had failed. Hits every flat view: any non-INBOX
  // folder, the default inbox type, virtual folders, AI categories and the
  // full-page section view.
  const flatThreads = useMemo(
    () => visibleThreadsUnderFilter(threads, activeInboxFilter, getCachedCategorySlugs(), selectedEmailId),
    [threads, activeInboxFilter, selectedEmailId],
  );

  // Threads the render-time filter re-check just took off screen: take them off
  // the server-side total too, or the paginator reads "30 of 30" above 9 visible
  // rows the moment 21 mails are read in webmail. Same helper as the per-section
  // `droppedPerSection` adjustment below.
  const flatTotal = adjustTotalForFilteredOut(emailsTotal, threads.length - flatThreads.length);

  // True when the SOURCE paged by conversation — the section full-page view and
  // the Starred/Important virtual folders all fetch pageSize THREADS and hand
  // back every message of those threads. The paginator must then label the
  // fixed thread window and count collapsed rows; using the message count is
  // what made Starred read "1-50 of 52" above 15 visible rows.
  const threadPaged = isThreadPagedView({
    section: viewingSection,
    virtualFolder: selectedVirtualFolder,
    // Snoozed is the same kind of source (a page of conversations, every snoozed
    // message of each) but carries no virtualFolder to recognise it by.
    snoozed: viewingSnoozed,
  });

  // Section assignment hook
  const { sectionedThreads, threadMatchesFilter } = useSectionAssignment({
    threads,
    inboxType,
    inboxSections,
    selectedFolderId,
    isImportantView,
    selectedVirtualFolder,
    viewFilter: activeInboxFilter,
    selectedEmailId,
  });

  // Check if DB-backed sections are active
  const hasSectionData = Object.keys(sectionData).length > 0;
  // Inbox type sections only apply to INBOX folder — all other folders use default flat view
  const useDbSections = isInboxFolder && inboxType !== 'default' && !selectedVirtualFolder?.startsWith('virtual-starred') && !selectedVirtualFolder?.startsWith('virtual-important') && !viewingAICategory && !viewingSection && !searchQuery && hasSectionData;

  // Build DB-backed section data for SectionList
  const dbSectionedThreads = useMemo((): SectionData[] => {
    if (!useDbSections) return [];

    // DB buckets are snapshots of per-filter server queries. After an optimistic
    // tag change (read/star/important) a thread may no longer match the section
    // it was fetched into, and may now match a different one. Pool every
    // section's threads (dedup by threadId) and assign each to the FIRST section
    // whose filter it matches — so a changed thread re-buckets to the right
    // section at render instead of vanishing from its old bucket or lingering in
    // the wrong one. Mirrors the flat-inbox assignment in useSectionAssignment.
    // ...but re-bucketing alone is not enough under an active quick-filter:
    // "Everything else" matches everything, so a thread the optimistic change
    // pushed OUT of the filter (mark a mail read under "Filtered: Unread")
    // would just land there and stay on screen. Drop those from the pool
    // entirely, and take them off their origin section's total, so the filtered
    // view keeps agreeing with the query that built it.
    const categorySlugs = getCachedCategorySlugs();
    const stillMatches = (t: EmailThread) =>
      threadStaysVisible(t, activeInboxFilter, categorySlugs, selectedEmailId);
    const poolMap = new Map<string, any>();
    const droppedPerSection = new Map<string, number>();
    for (const section of inboxSections) {
      if (section.filter === 'none') continue;
      for (const t of sectionData[section.id]?.threads || []) {
        if (!stillMatches(t)) {
          droppedPerSection.set(section.id, (droppedPerSection.get(section.id) ?? 0) + 1);
          continue;
        }
        if (!poolMap.has(t.threadId)) poolMap.set(t.threadId, t);
      }
    }
    const pool = [...poolMap.values()].sort(
      (a, b) => (b.latestEmail?.date || 0) - (a.latestEmail?.date || 0),
    );

    const result: SectionData[] = [];
    const usedIds = new Set<string>();
    for (const section of inboxSections) {
      if (section.filter === 'none') continue;
      const sd = sectionData[section.id];
      if (!sd && section.hideWhenEmpty) continue;
      const bucketThreads = pool.filter(
        (t) => !usedIds.has(t.threadId) && threadMatchesFilter(t, section.filter),
      );
      bucketThreads.forEach((t) => usedIds.add(t.threadId));
      // Loading is NOT an exemption: a hide-when-empty section that stays on
      // screen while it loads renders "0" and then disappears when the load
      // resolves empty. See sectionIsVisible.
      if (!sectionIsVisible({ hideWhenEmpty: !!section.hideWhenEmpty, threadCount: bucketThreads.length })) continue;
      result.push({
        section,
        threads: bucketThreads,
        label: SECTION_FILTER_LABELS[section.filter],
        total: adjustTotalForFilteredOut(sd?.total, droppedPerSection.get(section.id) ?? 0),
        hasMore: sd?.hasMore || false,
        loading: sd?.loading || false,
        page: sd?.page || 0,
      });
    }
    return result;
  }, [useDbSections, inboxSections, sectionData, threadMatchesFilter, activeInboxFilter, selectedEmailId]);

  // Handler for "Show more" per section
  const handleLoadMoreSection = useCallback((sectionId: string) => {
    const section = inboxSections.find(s => s.id === sectionId);
    if (!section) return;
    const dbFilter = getDbFilter(section.filter, inboxType);
    const folder = folders.find(f => f.id === selectedFolderId);
    const folderPath = selectedVirtualFolder === 'virtual-all' ? undefined : folder?.path;
    loadMoreSectionEmails(sectionId, dbFilter, folderPath);
  }, [inboxSections, inboxType, folders, selectedFolderId, selectedVirtualFolder, loadMoreSectionEmails]);

  // Gmail: click a section's count → open it as a full paginated page.
  const handleOpenSectionFullPage = useCallback((sectionId: string) => {
    const section = inboxSections.find(s => s.id === sectionId);
    if (!section) return;
    // Full-page view always paginates at SECTION_FULL_PAGE_SIZE (50), regardless
    // of the section's "Show up to" — that only controls the home preview count.
    openSectionFullPage(getDbFilter(section.filter, inboxType), SECTION_FILTER_LABELS[section.filter]);
  }, [inboxSections, inboxType, openSectionFullPage]);

  // Persist a per-section option (maxItems / hideWhenEmpty) to the SAME store the
  // Settings → Inbox tab uses, then reload it into the live inbox — so the home
  // 3-dot menu and the settings page stay consistent, and it survives relaunch.
  const setSectionOption = useCallback((sectionId: string, option: 'maxItems' | 'hideWhenEmpty', value: number | boolean) => {
    try {
      const stored = localStorage.getItem(SETTINGS_KEY);
      const parsed = stored ? JSON.parse(stored) : {};
      const current: any[] = (parsed.inboxSections && parsed.inboxSections.length > 0)
        ? parsed.inboxSections
        : (DEFAULT_SECTIONS[parsed.inboxType || inboxType] || inboxSections);
      const updated = current.map((s) => (s.id === sectionId ? { ...s, [option]: value } : s));
      localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...parsed, inboxSections: updated }));
      useEmailStore.getState().reloadInboxSettings();
    } catch (e) { console.error('Failed to update section option:', e); }
  }, [inboxSections, inboxType]);

  const handleSetSectionMaxItems = useCallback((sectionId: string, n: number) => setSectionOption(sectionId, 'maxItems', n), [setSectionOption]);
  const handleToggleSectionHideWhenEmpty = useCallback((sectionId: string) => {
    const cur = inboxSections.find(s => s.id === sectionId)?.hideWhenEmpty ?? false;
    setSectionOption(sectionId, 'hideWhenEmpty', !cur);
  }, [inboxSections, setSectionOption]);
  const handleManageInboxSettings = useCallback(() => {
    document.dispatchEvent(new CustomEvent('sarvinbox:open-settings', { detail: { tab: 'inbox' } }));
  }, []);

  // The exact set of threads currently on screen. Selection + bulk actions MUST
  // operate on this, not on `threads` (built from `displayEmails`): when
  // DB-backed sections are active the rows come from `dbSectionedThreads` (the
  // per-section `sectionData` pool), whose thread objects are built from a
  // different email subset. Filtering `threads` there desyncs the checkbox from
  // the row — e.g. "Select unread" would tick a row shown as read because its
  // `displayEmails` copy had a loaded unread message the pool copy didn't.
  // Mirrors the render branch selection in the list body exactly.
  const visibleThreads = useMemo(() => {
    if (useDbSections && dbSectionedThreads.length > 0) {
      return dbSectionedThreads.flatMap(s => s.threads);
    }
    const useFlatList =
      !isInboxFolder || inboxType === 'default' || selectedVirtualFolder ||
      viewingAICategory || sectionedThreads.length === 0;
    if (useFlatList) return flatThreads;
    return sectionedThreads.flatMap(s => s.threads);
  }, [useDbSections, dbSectionedThreads, isInboxFolder, inboxType, selectedVirtualFolder, viewingAICategory, sectionedThreads, flatThreads]);

  // Read state of the on-screen selection (drives the smart read/unread toggle).
  const allSelectedAreRead = useMemo(() => {
    if (selectedThreadIds.size === 0) return false;
    return visibleThreads
      .filter(t => selectedThreadIds.has(t.threadId))
      .every(t => (t.latestEmail.tags || '').includes('|read|'));
  }, [visibleThreads, selectedThreadIds]);

  // --- Event Handlers ---

  // Thread-row action handlers are wrapped in useCallback so the shared
  // `threadActions` object below stays referentially stable — otherwise the
  // memoized rows would re-render on every parent render.
  const toggleThreadSelection = useCallback((threadId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setSelectedThreadIds(prev => {
      const newSet = new Set(prev);
      if (newSet.has(threadId)) {
        newSet.delete(threadId);
      } else {
        newSet.add(threadId);
      }
      return newSet;
    });
  }, []);

  // Resolve the WHOLE conversation an action was taken on. A per-row hover
  // button hands us only the representative email's id (latestEmail/badgeEmailId);
  // acting on that single id left a multi-message thread's siblings untouched.
  // Find the on-screen thread this id belongs to and return every message id, so
  // archive/delete/read/star/snooze operate on the entire conversation — matching
  // the detail toolbar and the bulk-select toolbar. Falls back to the lone id if
  // no thread is found (defensive; shouldn't happen for a rendered row).
  const threadEmailIdsFor = useCallback((emailId: string): string[] => {
    const thread = visibleThreads.find(
      t => t.emails.some(e => e.id === emailId) ||
        t.latestEmail.id === emailId ||
        t.badgeEmailId === emailId,
    );
    // Narrowed for Drafts by the SAME rule the bulk toolbar uses: the hover
    // trash icon on a draft row must not delete the mail it replies to either.
    return thread
      ? actionableEmailIds(thread.emails, viewIsDrafts, draftFolderPaths)
      : [emailId];
  }, [visibleThreads, viewIsDrafts, draftFolderPaths]);

  const toggleStar = useCallback((emailId: string, currentlyStarred: boolean, e: React.MouseEvent) => {
    e.stopPropagation();
    // Star/unstar the whole conversation as one, via the shared batched action
    // (covers every straggler copy in a single state update + one IMAP call).
    bulkMarkStarred(threadEmailIdsFor(emailId), !currentlyStarred);
  }, [bulkMarkStarred, threadEmailIdsFor]);

  const handleArchive = useCallback(async (emailId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    bulkRemoveEmails(threadEmailIdsFor(emailId), 'archive');
  }, [bulkRemoveEmails, threadEmailIdsFor]);

  const handleDelete = useCallback(async (emailId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    bulkRemoveEmails(threadEmailIdsFor(emailId), 'delete');
  }, [bulkRemoveEmails, threadEmailIdsFor]);

  const handleToggleRead = useCallback(async (emailId: string, isRead: boolean, e: React.MouseEvent) => {
    e.stopPropagation();
    // Whole-conversation read toggle via the shared batched action (one state
    // update + one coalesced IMAP bulkAction).
    bulkMarkRead(threadEmailIdsFor(emailId), !isRead);
  }, [bulkMarkRead, threadEmailIdsFor]);

  const handleSnooze = useCallback(async (emailId: string, snoozeUntil: number, e: React.MouseEvent) => {
    e.stopPropagation();
    // Snooze is local-only (no IMAP), so looping every message is fine.
    const ids = threadEmailIdsFor(emailId);
    for (const id of ids) await snoozeEmail(id, snoozeUntil);
    setSnoozeDropdownThreadId(null);
  }, [snoozeEmail, threadEmailIdsFor]);

  const handleUnsnooze = useCallback(async (emailId: string) => {
    // Unsnooze the whole conversation, not just the representative message.
    const ids = threadEmailIdsFor(emailId);
    for (const id of ids) await unsnoozeEmail(id);
  }, [unsnoozeEmail, threadEmailIdsFor]);

  const handleThreadClick = useCallback((thread: EmailThread) => {
    const emailToSelect = thread.firstUnreadEmail || thread.latestEmail;
    selectEmail(emailToSelect.id);
  }, [selectEmail]);

  const selectAllThreads = () => {
    if (selectedThreadIds.size === visibleThreads.length) {
      setSelectedThreadIds(new Set());
    } else {
      setSelectedThreadIds(new Set(visibleThreads.map(t => t.threadId)));
    }
  };

  // Gmail-style select-by-state. Read = thread fully read (no unread message);
  // Starred/Unstarred use the thread-level star aggregate.
  const selectThreadsBy = (kind: 'all' | 'none' | 'read' | 'unread' | 'starred' | 'unstarred') => {
    const match: Record<typeof kind, (t: EmailThread) => boolean> = {
      all: () => true,
      none: () => false,
      read: (t) => !t.hasUnread,
      unread: (t) => t.hasUnread,
      starred: (t) => t.isStarred,
      unstarred: (t) => !t.isStarred,
    };
    setSelectedThreadIds(new Set(visibleThreads.filter(match[kind]).map(t => t.threadId)));
  };

  const handleRefresh = () => {
    if (syncing) return;
    // In All Inboxes, refresh must sync EVERY account (active + background) and
    // re-merge — not just the active one. runBackgroundSyncCycle syncs the
    // non-active accounts (and refreshes the unified list); syncEmails covers
    // the active account.
    if (selectedVirtualFolder === 'virtual-unified') {
      syncEmails();
      void runBackgroundSyncCycle();
    } else {
      syncEmails();
    }
  };

  // --- Bulk Action Handlers ---

  const getSelectedEmailIds = (): string[] =>
    selectedEmailIdsFor({ visibleThreads, selectedThreadIds, viewIsDrafts, draftFolderPaths });

  const handleBulkArchive = () => {
    const ids = getSelectedEmailIds();
    bulkRemoveEmails(ids, 'archive');
    setSelectedThreadIds(new Set());
  };

  const handleBulkDelete = () => {
    const ids = getSelectedEmailIds();
    bulkRemoveEmails(ids, 'delete');
    setSelectedThreadIds(new Set());
  };

  const handleBulkMarkRead = (read: boolean) => {
    bulkMarkRead(getSelectedEmailIds(), read);
    setSelectedThreadIds(new Set());
  };

  const handleBulkMarkStarred = (starred: boolean) => {
    bulkMarkStarred(getSelectedEmailIds(), starred);
    setSelectedThreadIds(new Set());
  };

  const handleBulkMoveToSpam = () => {
    const ids = getSelectedEmailIds();
    bulkRemoveEmails(ids, 'spam');
    setSelectedThreadIds(new Set());
  };

  // Restore the selection to Inbox from Trash/Spam (the benign `notspam` op:
  // drops the source-folder tag, adds INBOX, and IMAP-moves the messages).
  const handleBulkMoveToInbox = () => {
    const ids = getSelectedEmailIds();
    bulkRemoveEmails(ids, 'notspam');
    setSelectedThreadIds(new Set());
  };

  const handleBulkMove = (folderId: string) => {
    const ids = getSelectedEmailIds();
    bulkMoveToFolder(ids, folderId);
    setSelectedThreadIds(new Set());
  };

  const handleBulkCopy = (folderId: string) => {
    const ids = getSelectedEmailIds();
    bulkCopyToFolder(ids, folderId);
    // Copy leaves the originals in view — keep the selection so the user can act again.
  };

  const handleBulkSnooze = async (snoozeUntil: number) => {
    const ids = getSelectedEmailIds();
    for (const id of ids) await snoozeEmail(id, snoozeUntil);
    setSelectedThreadIds(new Set());
  };

  const toggleSectionCollapse = (sectionId: string) => {
    setCollapsedSections(prev => {
      const newSet = new Set(prev);
      if (newSet.has(sectionId)) {
        newSet.delete(sectionId);
      } else {
        newSet.add(sectionId);
      }
      try { localStorage.setItem('sarvinbox-collapsed-sections', JSON.stringify([...newSet])); } catch {}
      return newSet;
    });
  };

  const toggleSectionExpansion = (sectionId: string) => {
    setExpandedSectionIds(prev => {
      const newSet = new Set(prev);
      if (newSet.has(sectionId)) {
        newSet.delete(sectionId);
      } else {
        newSet.add(sectionId);
      }
      return newSet;
    });
    setSectionMenuId(null);
  };

  // --- Effects ---

  // Listen for keyboard shortcut thread selection toggle
  useEffect(() => {
    const handler = (e: Event) => {
      const threadId = (e as CustomEvent).detail?.threadId;
      if (!threadId) return;
      setSelectedThreadIds(prev => {
        const next = new Set(prev);
        if (next.has(threadId)) {
          next.delete(threadId);
        } else {
          next.add(threadId);
        }
        return next;
      });
    };
    document.addEventListener('sarvinbox:toggle-thread-selection', handler);
    return () => document.removeEventListener('sarvinbox:toggle-thread-selection', handler);
  }, []);

  // Listen for keyboard shortcut "b" to open snooze dropdown on highlighted/selected thread
  const threadsRef = useRef(threads);
  threadsRef.current = threads;
  useEffect(() => {
    const handler = () => {
      const activeId = highlightedEmailId || selectedEmailId;
      if (!activeId) return;
      const thread = threadsRef.current.find(t => t.emails.some(e => e.id === activeId));
      if (thread) {
        setSnoozeDropdownThreadId(thread.threadId);
      }
    };
    document.addEventListener('sarvinbox:open-snooze', handler);
    return () => document.removeEventListener('sarvinbox:open-snooze', handler);
  }, [highlightedEmailId, selectedEmailId]);

  // Auto-scroll list to the active email when selection changes (important for split view after delete/archive)
  useEffect(() => {
    if (viewMode === 'no-split') return; // Not needed in no-split (list is hidden when detail is open)
    const activeId = selectedEmailId || highlightedEmailId;
    if (!activeId) return;
    const thread = threadsRef.current.find(t => t.emails.some(e => e.id === activeId));
    if (thread) {
      requestAnimationFrame(() => {
        const el = document.querySelector(`[data-thread-id="${thread.threadId}"]`);
        el?.scrollIntoView({ block: 'nearest' });
      });
    }
  }, [selectedEmailId, highlightedEmailId, viewMode]);

  // Background body loading for visible emails
  useEffect(() => {
    const emailsToLoad = searchQuery ? searchResults : emails;
    if (emailsToLoad.length === 0 || loadingEmails) return;

    const emailIds = emailsToLoad
      .slice(0, 20)
      // Prefetch bodies only for rows with NO body anywhere — not loaded in the
      // store (rawBody) AND not present in the DB (hasBody). List rows now omit
      // the heavy rawBody, so gate on hasBody too, else we'd re-fetch every
      // visible row whose body is already stored.
      .filter(email => !email.rawBody && !email.hasBody)
      .map(email => email.id);

    if (emailIds.length === 0) return;

    const timer = setTimeout(() => {
      console.log(`[EmailList] Background loading bodies for ${emailIds.length} emails`);
      fetchBodiesForVisibleEmails(emailIds);
    }, 500);

    return () => clearTimeout(timer);
  }, [emails, searchResults, searchQuery, loadingEmails, fetchBodiesForVisibleEmails]);

  // Countdown timer for snoozed view — tick every 60s to update countdowns
  useEffect(() => {
    if (!viewingSnoozed) return;
    const id = setInterval(() => setCountdownTick(t => t + 1), 60_000);
    return () => clearInterval(id);
  }, [viewingSnoozed]);


  // Auto-refresh snoozed view when a snooze expires
  useEffect(() => {
    if (!viewingSnoozed) return;
    const handler = () => {
      useEmailStore.getState().loadSnoozedEmails();
    };
    document.addEventListener('sarvinbox:snooze-wakeup', handler);
    return () => document.removeEventListener('sarvinbox:snooze-wakeup', handler);
  }, [viewingSnoozed]);

  // Infinite scroll is replaced by Gmail-style discrete pagination (the Paginator
  // footer for the flat view, per-section prev/next for the sectioned inbox), so
  // scrolling no longer auto-loads and the DOM stays bounded to one page. Kept as
  // a no-op so the existing onScroll wiring doesn't need to change.
  const handleScroll = useCallback(() => {}, []);

  // --- Assemble props objects ---

  // Stable references for the props passed to every row. `threadUIState`
  // intentionally omits the per-row hover/snooze ids — those are passed to each
  // row as booleans (see renderEmailThread) so hovering one row does not change
  // this shared object and re-render every memoized sibling.
  const threadActions = useMemo<ThreadActions>(() => ({
    onThreadClick: handleThreadClick,
    onToggleSelection: toggleThreadSelection,
    onToggleStar: toggleStar,
    onArchive: handleArchive,
    onDelete: handleDelete,
    onToggleRead: handleToggleRead,
    onSnooze: handleSnooze,
    onUnsnooze: handleUnsnooze,
  }), [handleThreadClick, toggleThreadSelection, toggleStar, handleArchive, handleDelete, handleToggleRead, handleSnooze, handleUnsnooze]);

  const threadUIState = useMemo<RowUIState>(() => ({
    selectedEmailId,
    highlightedEmailId,
    selectedThreadIds,
    showImportanceMarkers,
    viewingSnoozed,
    countdownTick,
  }), [selectedEmailId, highlightedEmailId, selectedThreadIds, showImportanceMarkers, viewingSnoozed, countdownTick]);

  const threadHoverActions = useMemo<ThreadHoverActions>(() => ({
    setHoveredThreadId,
    setSnoozeDropdownThreadId,
  }), [setHoveredThreadId, setSnoozeDropdownThreadId]);

  // Unified "All Inboxes": map accountId -> { color, label } so each row can show
  // a per-account dot. Empty/unused in every other view.
  const isUnifiedView = selectedVirtualFolder === 'virtual-unified';
  // ── The one top bar ─────────────────────────────────────────────────────
  // Every listing gets a title + pager at the top; the footer pager stays as the
  // second copy. Previously only the section / All Inboxes / AI-category views
  // hand-rolled a bar, so a plain folder (Sent, a user folder) had none — you
  // could only page from the bottom of the list. The sectioned inbox is the one
  // view without one: each section there carries its own pager.
  const listHeader = useMemo(() => {
    if (useDbSections) return null;
    const title = listHeaderTitle({
      sectionLabel: viewingSection ? viewingSectionLabel : null,
      searching: !!searchQuery,
      aiCategory: viewingAICategory,
      snoozed: viewingSnoozed,
      virtualFolder: selectedVirtualFolder,
      folder: selectedFolder,
    });
    if (title === null) return null;
    if (searchQuery) {
      // Search pages through ALL matches with no exact total (no COUNT), so
      // prev/next is gated by hasMore.
      return {
        title, page: searchPage, pageSize: getEmailsPerPage(), count: searchResults.length,
        total: searchTotal, hasMore: searchHasMore, loading: searching,
        onGoToPage: goToSearchPage, fixedWindow: false,
        onBack: undefined as (() => void) | undefined, backLabel: undefined as string | undefined,
      };
    }
    return {
      title,
      onBack: viewingSection ? () => closeSectionFullPage() : undefined,
      backLabel: viewingSection ? 'Back to inbox' : undefined,
      page: emailsPage,
      pageSize: listPageSize,
      // A thread-paged view fetches pageSize THREADS per page, so its label must
      // follow the window, not the collapsed on-screen row count.
      count: threadPaged ? flatThreads.length : displayEmails.length,
      total: flatTotal,
      hasMore: hasMoreEmails,
      loading: loadingMoreEmails,
      onGoToPage: goToEmailPage,
      fixedWindow: threadPaged,
    };
  }, [useDbSections, viewingSection, viewingSectionLabel, searchQuery, viewingAICategory, viewingSnoozed,
      selectedVirtualFolder, selectedFolder, searchPage, searchResults.length, searchTotal, searchHasMore,
      searching, goToSearchPage, closeSectionFullPage, emailsPage, listPageSize, flatThreads.length,
      displayEmails.length, flatTotal, hasMoreEmails, loadingMoreEmails, goToEmailPage, threadPaged]);

  const accounts = useEmailStore((s) => s.accounts);
  const accountMetaById = useMemo(
    () => Object.fromEntries(accounts.map((a) => [a.id, { color: a.color, label: accountDisplayLabel(accounts, a.id) }])),
    [accounts],
  );

  // Choose render function based on view mode. The per-row hover/snooze flags
  // are computed here (not read from the shared uiState inside the row) so a
  // hover change only invalidates the one affected row, not all of them.
  const renderEmailThread = (thread: EmailThread) => {
    const isHovered = hoveredThreadId === thread.threadId;
    const showSnoozeDropdown = snoozeDropdownThreadId === thread.threadId;
    const meta = isUnifiedView ? accountMetaById[thread.latestEmail.accountId ?? ''] : undefined;
    const rowProps = {
      thread,
      actions: threadActions,
      uiState: threadUIState,
      hoverActions: threadHoverActions,
      isHovered,
      showSnoozeDropdown,
      accountColor: meta?.color,
      accountLabel: meta?.label,
    };
    // thread.threadId is already unique per row (buildThreads keys unified rows by
    // account + thread), so it's a safe React key even for dual-delivered copies.
    if (viewMode === 'no-split') {
      return <CompactThreadRow key={thread.threadId} {...rowProps} />;
    }
    return <ThreadCard key={thread.threadId} {...rowProps} />;
  };

  // Get list width based on view mode
  const getListWidth = () => {
    switch (viewMode) {
      case 'no-split':
        return 'flex-1';
      case 'horizontal':
        return 'w-full h-full';
      case 'vertical':
      default:
        return 'w-96';
    }
  };

  // --- Main inbox ---

  return (
    <div className={`${getListWidth()} ${viewMode === 'vertical' ? 'border-r border-border' : ''} flex flex-col bg-background h-full min-w-0 overflow-hidden`}>
      {/* Search Bar — always on top */}
      <SearchBar
        placeholder="Search emails..."
        localSearchQuery={localSearchQuery}
        setLocalSearchQuery={setLocalSearchQuery}
        onSearch={handleSearch}
        onClear={handleClearSearch}
        showClearButton={!!searchQuery}
        searchFocused={searchFocused}
        setSearchFocused={setSearchFocused}
        showAdvancedSearch={showAdvancedSearch}
        setShowAdvancedSearch={setShowAdvancedSearch}
        getSearchContext={getSearchContext}
        search={search}
        viewMode={viewMode}
        initialQuery={localSearchQuery}
        searchSuggestions={searchSuggestions}
        below={searchQuery ? (
          <div className="mt-2 flex items-center gap-2 flex-wrap">
            {/* Prominent active-filter chip so it's obvious a filter is applied
                (and why fewer emails show) — with a one-click clear. */}
            <span className="inline-flex items-center gap-1.5 rounded-full border border-primary/40 bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary">
              <Filter className="h-3 w-3 shrink-0" />
              <span className="max-w-[240px] truncate">{searchQuery}</span>
              <button
                type="button"
                onClick={handleClearSearch}
                aria-label="Clear filter"
                className="ml-0.5 rounded-full p-0.5 hover:bg-primary/20 transition-colors"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
            <span className="text-xs text-muted-foreground">{flatThreads.length} results</span>
            {/* Server-search escalation. Local index is searched first; this lets
                the user force an IMAP UID SEARCH (and auto-fires when local came
                back thin) to surface mail not downloaded yet. Single-account /
                single-folder only — All Inboxes has no one folder to SEARCH. */}
            {canOfferServerSearch({
              hasServerSearchableTerms: hasServerSearchableParsedQuery(searchFilter),
              isUnifiedView,
            }) && (
              searchingServer ? (
                <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  Searching all mail on the server…
                </span>
              ) : (
                <Tooltip content="Search the mail server directly for matches not downloaded yet" delayMs={40}>
                  <button
                    type="button"
                    onClick={() => searchServer()}
                    aria-label="Search server"
                    className="inline-flex items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
                  >
                    <Globe className="h-3 w-3 shrink-0" />
                    Search server
                  </button>
                </Tooltip>
              )
            )}
            {serverSearchStatus && !searchingServer && (
              <span className="text-xs text-muted-foreground/80">{serverSearchStatus}</span>
            )}
          </div>
        ) : activeInboxFilter ? (
          <div className="mt-2 flex items-center gap-2 flex-wrap">
            {/* Quick-filter narrows the sectioned inbox (not a text search) — the
                same highlighted chip so it's clear a filter is on while paging. */}
            <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-500/40 bg-amber-500/10 px-2.5 py-1 text-xs font-medium text-amber-600 dark:text-amber-400">
              <Filter className="h-3 w-3 shrink-0" />
              <span className="max-w-[240px] truncate">Filtered: {activeInboxFilterLabel}</span>
              <button
                type="button"
                onClick={() => setInboxFilter(null)}
                aria-label="Clear filter"
                className="ml-0.5 rounded-full p-0.5 hover:bg-amber-500/20 transition-colors"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          </div>
        ) : undefined}
      />

      {/* Bulk Action Bar — all view modes */}
      <BulkActionBar
        selectedCount={selectedThreadIds.size}
        totalCount={visibleThreads.length}
        syncing={syncing}
        hasSelection={selectedThreadIds.size > 0}
        allSelectedAreRead={allSelectedAreRead}
        showViewModeDropdown={showViewModeDropdown}
        setShowViewModeDropdown={setShowViewModeDropdown}
        onSelectAll={selectAllThreads}
        onSelectBy={selectThreadsBy}
        onRefresh={handleRefresh}
        onBulkArchive={handleBulkArchive}
        onBulkDelete={handleBulkDelete}
        onBulkMarkRead={handleBulkMarkRead}
        onBulkMarkStarred={handleBulkMarkStarred}
        onBulkMoveToSpam={handleBulkMoveToSpam}
        onBulkSnooze={handleBulkSnooze}
        onBulkMoveToInbox={handleBulkMoveToInbox}
        onBulkMove={handleBulkMove}
        onBulkCopy={handleBulkCopy}
        isTrashView={isTrashFolder}
        isSpamView={isSpamFolder}
      />

      {/* Category Filter Pills */}
      <CategoryFilterBar />

      {/* Email List */}
      <div
        ref={listRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto overflow-x-hidden"
      >
        {/* The one top bar every listing wears (title + pager). Rendered above
            the loading/empty/populated switch so the pager stays reachable even
            when the current page is momentarily empty (recover via prev/next). */}
        {listHeader && (
          <ListHeader
            title={listHeader.title}
            onBack={listHeader.onBack}
            backLabel={listHeader.backLabel}
            page={listHeader.page}
            pageSize={listHeader.pageSize}
            count={listHeader.count}
            total={listHeader.total}
            hasMore={listHeader.hasMore}
            loading={listHeader.loading}
            onGoToPage={listHeader.onGoToPage}
            fixedWindow={listHeader.fixedWindow}
          />
        )}
        {loadingEmails || isSearching ? (
          <div className="flex items-center justify-center p-8">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : !selectedFolderId && !searchQuery && !viewingSnoozed && !selectedVirtualFolder && !viewingAICategory ? (
          <div className="p-8 text-center text-muted-foreground text-sm">
            Select a folder to view emails
          </div>
        ) : flatThreads.length === 0 && !(useDbSections && dbSectionedThreads.length > 0) ? (
          // `threads` derives from the FLAT `emails` array. On return to the
          // sectioned INBOX, selectFolder clears `emails: []` but keeps the
          // cached `sectionData` (for instant stale sections) — so this guard
          // must NOT fire while the sectioned view still has data, or the list
          // flashes "No emails in this folder" until loadAllSections refills
          // `emails` (the reported empty-then-populated flicker).
          <div className="p-8 text-center text-muted-foreground text-sm">
            {(() => {
              // `isViewSyncing` (global sync OR this folder's own sync), not a
              // second `syncingFolders.has(...)` lookup: the FIRST sync of an
              // account runs through `syncEmails`, which never touches
              // `syncingFolders` — so a never-synced INBOX read "No emails in
              // this folder" for the whole of it, exactly when the mail was on
              // its way. Same folder record the rest of the view resolves from.
              const reason = emptyListReason({
                syncing: isViewSyncing,
                neverSynced: !!selectedFolder && !selectedFolder.lastSyncTime,
                searching: !!searchQuery,
                snoozed: viewingSnoozed,
                aiCategory: viewingAICategory,
              });
              if (reason === 'syncing') {
                return (
                  <div className="flex items-center justify-center gap-2">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    <span>Syncing emails...</span>
                  </div>
                );
              }
              return EMPTY_LIST_MESSAGES[reason];
            })()}
          </div>
        ) : (
          <div>
            {/* DB-backed section view */}
            {useDbSections && dbSectionedThreads.length > 0 ? (
              <SectionList
                sections={dbSectionedThreads}
                collapsedSections={collapsedSections}
                expandedSectionIds={expandedSectionIds}
                sectionMenuId={sectionMenuId}
                hoveredPaginationId={hoveredPaginationId}
                displayEmailsCount={searchQuery ? displayEmails.length : (selectedFolder?.totalCount || displayEmails.length)}
                renderThread={renderEmailThread}
                onToggleCollapse={toggleSectionCollapse}
                onToggleExpansion={toggleSectionExpansion}
                onSetSectionMenuId={setSectionMenuId}
                onSetHoveredPaginationId={setHoveredPaginationId}
                onLoadMoreSection={handleLoadMoreSection}
                onOpenSectionFullPage={handleOpenSectionFullPage}
                onSetSectionMaxItems={handleSetSectionMaxItems}
                onToggleSectionHideWhenEmpty={handleToggleSectionHideWhenEmpty}
                onManageInboxSettings={handleManageInboxSettings}
                sectionLoadingSet={sectionLoading}
                isSyncing={isViewSyncing}
              />
            ) : !isInboxFolder || inboxType === 'default' || selectedVirtualFolder || viewingAICategory || viewingSection || sectionedThreads.length === 0 ? (
              /* Default flat list view (also used for AI category pills + full-page section) */
              flatThreads.map((thread) => renderEmailThread(thread))
            ) : (
              /* Client-side section fallback */
              <SectionList
                sections={sectionedThreads}
                collapsedSections={collapsedSections}
                expandedSectionIds={expandedSectionIds}
                sectionMenuId={sectionMenuId}
                hoveredPaginationId={hoveredPaginationId}
                displayEmailsCount={searchQuery ? displayEmails.length : (selectedFolder?.totalCount || displayEmails.length)}
                renderThread={renderEmailThread}
                onToggleCollapse={toggleSectionCollapse}
                onToggleExpansion={toggleSectionExpansion}
                onSetSectionMenuId={setSectionMenuId}
                onSetHoveredPaginationId={setHoveredPaginationId}
                isSyncing={isViewSyncing}
              />
            )}

            {/* Gmail-style paginator for the flat / unified / AI-category views.
                Discrete pages REPLACE the rows, so the DOM stays bounded to one
                page. (The sectioned inbox paginates per section — see SectionList.) */}
            {!useDbSections && searchQuery && (
              /* Search results page through ALL matches (getEmailsPerPage per
                 page) instead of a capped one-shot fetch. No exact total (no
                 COUNT), so prev/next is gated by hasMore. */
              <Paginator
                page={searchPage}
                pageSize={getEmailsPerPage()}
                count={searchResults.length}
                total={searchTotal}
                hasMore={searchHasMore}
                loading={searching}
                onGoToPage={goToSearchPage}
              />
            )}
            {!useDbSections && !searchQuery && (
              <Paginator
                page={emailsPage}
                pageSize={listPageSize}
                count={threadPaged ? flatThreads.length : displayEmails.length}
                total={flatTotal}
                hasMore={hasMoreEmails}
                loading={loadingMoreEmails}
                onGoToPage={goToEmailPage}
                fixedWindow={threadPaged}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}
