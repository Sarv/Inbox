import type { InboxSection, SectionFilter } from '../../config/inbox-types';
import type { EmailThread, SectionData } from '../../utils/thread-utils';

// Callback actions for thread interactions
export interface ThreadActions {
  onThreadClick: (thread: EmailThread) => void;
  onToggleSelection: (threadId: string, e: React.MouseEvent) => void;
  onToggleStar: (emailId: string, currentlyStarred: boolean, e: React.MouseEvent) => void;
  onArchive: (emailId: string, e: React.MouseEvent) => void;
  onDelete: (emailId: string, e: React.MouseEvent) => void;
  onToggleRead: (emailId: string, isRead: boolean, e: React.MouseEvent) => void;
  onSnooze: (emailId: string, snoozeUntil: number, e: React.MouseEvent) => void;
  onUnsnooze: (emailId: string) => Promise<void>;
}

// Read-only UI state
export interface ThreadUIState {
  selectedEmailId: string | null;
  highlightedEmailId: string | null;
  selectedThreadIds: Set<string>;
  hoveredThreadId: string | null;
  snoozeDropdownThreadId: string | null;
  showImportanceMarkers: boolean;
  viewingSnoozed: boolean;
  countdownTick: number;
}

// Hover-related setters
export interface ThreadHoverActions {
  setHoveredThreadId: (id: string | null) => void;
  setSnoozeDropdownThreadId: (id: string | null) => void;
}

// UI state actually consumed by a rendered row. The per-row hover/snooze
// flags are intentionally excluded and passed as separate `isHovered` /
// `showSnoozeDropdown` booleans so that hovering one row does not change the
// shared uiState reference and invalidate every memoized sibling row.
export type RowUIState = Omit<ThreadUIState, 'hoveredThreadId' | 'snoozeDropdownThreadId'>;

// Shared props for the memoized thread rows (ThreadCard + CompactThreadRow).
export interface ThreadRowProps {
  thread: EmailThread;
  actions: ThreadActions;
  uiState: RowUIState;
  hoverActions: ThreadHoverActions;
  isHovered: boolean;
  showSnoozeDropdown: boolean;
  /** Unified "All Inboxes" view only: color + label of the owning account, to
   *  render a per-account dot so mixed-account rows are distinguishable. */
  accountColor?: string;
  accountLabel?: string;
}

export interface SnoozeDropdownProps {
  emailId?: string;
  isSnoozed?: boolean;
  onSnooze?: (emailId: string, snoozeUntil: number, e: React.MouseEvent) => void;
  onBulkSnooze?: (snoozeUntil: number) => void;
  onUnsnooze?: (emailId: string) => Promise<void>;
  onClose: () => void;
  align?: 'left' | 'right';
}

export interface SectionHeaderProps {
  sectionId: string;
  label: string;
  count: number;
  totalInSection: number;
  folderTotal?: number;
  isEverythingElse?: boolean;
  startIndex?: number;
  maxItems?: number;
  isCollapsed: boolean;
  isExpanded: boolean;
  showMenu: boolean;
  isHoveredPagination: boolean;
  onToggleCollapse: (sectionId: string) => void;
  onToggleExpansion: (sectionId: string) => void;
  onSetSectionMenuId: (id: string | null) => void;
  onSetHoveredPaginationId: (id: string | null) => void;
  // DB-backed section pagination
  dbTotal?: number;
  hasMore?: boolean;
  onLoadMore?: () => void;
  sectionLoading?: boolean;
  // Gmail-style: the count is clickable → full page; the 3-dot menu holds the
  // per-section options.
  page?: number;
  pageSize?: number;
  hideWhenEmpty?: boolean;
  /** Click the "X–Y of Z" count → open this section full-page. */
  onOpenFullPage?: () => void;
  /** 3-dot "Show up to" (5/10/25/50) — sets this section's maxItems. */
  onSetMaxItems?: (n: number) => void;
  /** 3-dot "Hide section when empty" toggle. */
  onToggleHideWhenEmpty?: () => void;
  /** 3-dot "Manage Inbox settings". */
  onManageSettings?: () => void;
}

export interface SectionListProps {
  sections: SectionData[];
  collapsedSections: Set<string>;
  expandedSectionIds: Set<string>;
  sectionMenuId: string | null;
  hoveredPaginationId: string | null;
  displayEmailsCount: number;
  renderThread: (thread: EmailThread) => React.ReactNode;
  onToggleCollapse: (sectionId: string) => void;
  onToggleExpansion: (sectionId: string) => void;
  onSetSectionMenuId: (id: string | null) => void;
  onSetHoveredPaginationId: (id: string | null) => void;
  // Per-section pagination (DB-backed sections)
  onLoadMoreSection?: (sectionId: string) => void;
  /** Click a section's count → open it full-page (Gmail). */
  onOpenSectionFullPage?: (sectionId: string) => void;
  /** 3-dot "Show up to" — set a section's maxItems. */
  onSetSectionMaxItems?: (sectionId: string, n: number) => void;
  /** 3-dot "Hide section when empty" — toggle for a section. */
  onToggleSectionHideWhenEmpty?: (sectionId: string) => void;
  /** 3-dot "Manage Inbox settings". */
  onManageInboxSettings?: () => void;
  sectionLoadingSet?: Set<string>;
  /** A background IMAP sync is in flight — empty sections show a "checking…"
   *  hint instead of a flat "No … emails" so the view doesn't read as broken. */
  isSyncing?: boolean;
}

/** Gmail-style "Select" dropdown options. */
export type SelectKind = 'all' | 'none' | 'read' | 'unread' | 'starred' | 'unstarred';

export interface BulkActionBarProps {
  selectedCount: number;
  totalCount: number;
  syncing: boolean;
  hasSelection: boolean;
  allSelectedAreRead: boolean;
  showViewModeDropdown: boolean;
  setShowViewModeDropdown: (show: boolean) => void;
  onSelectAll: () => void;
  /** Select all threads matching a state (Gmail-style select menu). */
  onSelectBy: (kind: SelectKind) => void;
  onRefresh: () => void;
  onBulkArchive: () => void;
  onBulkDelete: () => void;
  onBulkMarkRead: (read: boolean) => void;
  onBulkMarkStarred: (starred: boolean) => void;
  onBulkMoveToSpam: () => void;
  onBulkSnooze: (snoozeUntil: number) => void;
  /** Restore the selection to Inbox (Trash/Spam recovery — the `notspam` op). */
  onBulkMoveToInbox: () => void;
  /** Move the selection to a chosen folder. */
  onBulkMove: (folderId: string) => void;
  /** Copy the selection to a chosen folder (originals stay). */
  onBulkCopy: (folderId: string) => void;
  /** Current view is Trash: swap Archive/Report-spam for "Restore to Inbox". */
  isTrashView?: boolean;
  /** Current view is Spam: swap "Report spam" for "Not spam — move to Inbox". */
  isSpamView?: boolean;
}

export interface LoadMoreIndicatorProps {
  displayEmailsCount: number;
  conversationCount: number;
  localTotal: number;
  serverTotal: number;
  hasMoreEmails: boolean;
  loadingMoreEmails: boolean;
  onLoadMore: () => void;
}

export interface AIBoxCategoryViewProps {
  renderThread: (thread: EmailThread) => React.ReactNode;
  threadMatchesFilter: (thread: EmailThread, filter: SectionFilter) => boolean;
  inboxType: string;
  inboxSections: InboxSection[];
  collapsedSections: Set<string>;
  expandedSectionIds: Set<string>;
  sectionMenuId: string | null;
  hoveredPaginationId: string | null;
  displayEmailsCount: number;
  onToggleCollapse: (sectionId: string) => void;
  onToggleExpansion: (sectionId: string) => void;
  onSetSectionMenuId: (id: string | null) => void;
  onSetHoveredPaginationId: (id: string | null) => void;
}
