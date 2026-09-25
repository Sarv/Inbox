import {
  Inbox,
  Layers,
  Send,
  Archive,
  Trash2,
  RefreshCw,
  Loader2,
  Star,
  FileText,
  Mail,
  Ban,
  Folder,
  Plus,
  Square,
  ChevronDown,
  ChevronRight,
  WifiOff,
  Clock,
  AlertCircle,
} from 'lucide-react';
import { useEffect, useState } from 'react';

import {
  shouldHideFolder,
  isAiLabelFolder,
  hideableSystemCategories,
  isSarvHost,
  isSystemCategoryFolder,
  type KnownCategoryRef,
  classifyFolder,
  findFolderByType,
  folderDisplayName,
  VIRTUAL_FOLDERS,
  type VirtualFolder,
} from '../config/folder-mapping';
import { getShortcutHints, getGotoShortcutHints } from '../config/keyboard-shortcuts';
import { useAppVersion } from '../hooks/useAppVersion';
import { useEmailStore } from '../store/email-store';
// Folder mapping configuration (browser-safe local copy)

import { AccountSwitcher } from './AccountSwitcher';
import { getConnectionBarStatus } from './connection-status';
import { quotaRowState } from './quota-format';
import { SidebarLabels } from './SidebarLabels';
import { Tooltip } from './Tooltip';


// Mark + wordmark lockup. The app rail to the left carries the Sarv "S" (it
// links out to sarv.com), so the SarvInbox medallion belongs here, in front of
// the product name.
//
// The wordmark is two files because the "Sarv" glyphs are solid #000 and
// disappear against the dark card; dark mode here is class-based
// (tailwind.config.js `darkMode: ['class']`), so an `@media
// (prefers-color-scheme)` rule inside the SVG would track the OS instead of the
// app and get it backwards half the time. An <img> also seals the SVG off from
// the page's CSS, so `currentColor` is not an option. Only the black flips —
// the brand orange is identical in both. The medallion needs no such swap: it
// is blue and orange on transparent and reads on either card.
const logoMark = './icon.svg';
const logoLarge = './wordmark.svg';
const logoLargeDark = './wordmark-dark.svg';


export function Sidebar() {
  const {
    folders,
    selectedFolderId,
    selectFolder,
    loadFolders,
    loadingFolders,
    syncing,
    syncingFolders,
    syncEmails,
    syncStatus,
    syncTrouble,
    idleActive,
    openCompose,
    connectionStatus,
    reconnect,
    loadSnoozedEmails,
    viewingSnoozed,
    clearSnoozedView,
    clearAICategoryView,
    loadAllEmails,
    loadStarredEmails,
    selectedVirtualFolder,
    showOutbox,
    accounts,
    selectUnifiedInbox,
    accountUnread,
    refreshUnreadSummary,
  } = useEmailStore();
  // Labels that were mirrored to the server appear as folders too (we sync
  // server folders) — dedupe them out of the FOLDERS section so they show once,
  // under Labels. Selector kept separate to avoid touching the big destructure.
  const labels = useEmailStore((s) => s.labels);
  // Active account's IMAP host — decides whether the bare-named category
  // mailboxes below are ours to hide or the user's own folders.
  const activeHost = useEmailStore((s) => s.imapConfig?.host as string | undefined);

  // On our own host the webmail team creates the system categories as real
  // mailboxes named after the category ("Promotions"). The top bar already
  // shows them, so they'd otherwise be listed twice; load the SYSTEM
  // definitions so categorizedFolders can drop the duplicates. A failed load
  // just means nothing extra is hidden — never a missing user folder.
  const [systemCategories, setSystemCategories] = useState<KnownCategoryRef[]>([]);
  const categoryDefsVersion = useEmailStore((s) => s.aiCategoryCountsLastUpdate);
  useEffect(() => {
    // Nothing to hide off our own host — skip the IPC entirely.
    if (!isSarvHost(activeHost)) { setSystemCategories([]); return; }
    let cancelled = false;
    const loadDefs = async () => {
      try {
        const result = await window.electronAPI?.ai?.getCategoryDefinitions();
        if (cancelled) return;
        const defs = (result?.success && Array.isArray(result.data) ? result.data : []) as Array<{
          slug: string; name?: string; isSystem?: boolean;
        }>;
        setSystemCategories(hideableSystemCategories(activeHost, defs));
      } catch { /* leave the list empty: hide nothing rather than hide wrongly */ }
    };
    loadDefs();
    return () => { cancelled = true; };
  }, [activeHost, categoryDefsVersion]);

  // Per-account unread badges for "All Inboxes". Refresh on mount, when the set
  // of accounts changes, and whenever the active account's folder counts change
  // (e.g. after reading mail). Cheap local reads across each account's DB; the
  // background poll (added later) keeps inactive accounts fresh in real time.
  useEffect(() => {
    if (accounts.length > 1) refreshUnreadSummary();
  }, [refreshUnreadSummary, accounts.length, folders]);

  // Outbox badge count (pending + failed sends), refreshed periodically.
  const [outboxCount, setOutboxCount] = useState(0);
  useEffect(() => {
    let cancelled = false;
    const fetchCount = async () => {
      try {
        const res = await window.electronAPI?.outbox?.counts();
        if (!cancelled && res.success && res.data) {
          setOutboxCount((res.data.pending ?? 0) + (res.data.failed ?? 0));
        }
      } catch { /* ignore */ }
    };
    fetchCount();
    // Live: refetch the instant the outbox changes (send/queue/fail/drain).
    // The interval stays only as a slow backstop.
    const off = window.electronAPI?.outbox?.onChanged?.(fetchCount);
    const t = window.setInterval(fetchCount, 60000);
    return () => { cancelled = true; window.clearInterval(t); off?.(); };
  }, []);

  // Show syncing state for both full sync and single-folder sync
  const isSyncing = syncing || syncingFolders.size > 0;

  const [systemFoldersExpanded, setSystemFoldersExpanded] = useState(true);
  const [labelsFoldersExpanded, setLabelsFoldersExpanded] = useState(true);
  const appVersion = useAppVersion();
  const quota = useEmailStore((s) => s.quota);
  const quotaLoading = useEmailStore((s) => s.quotaLoading);
  // Has the ACTIVE account ever answered? A server with no QUOTA extension
  // answers `null`, and that counts — without this the placeholder would
  // reappear at every refresh on such an account.
  const quotaAnswered = useEmailStore((s) => !!s.activeAccountId && s.activeAccountId in s.quotaByAccount);
  const [expandedLabels, setExpandedLabels] = useState<Set<string>>(new Set());
  const [snoozedCount, setSnoozedCount] = useState(0);

  // Initial load and setup
  useEffect(() => {
    loadFolders();

    // Fetch snoozed count
    const loadSnoozedCount = async () => {
      const result = await window.electronAPI.snooze.count();
      if (result.success && result.data !== undefined) {
        setSnoozedCount(result.data);
      }
    };
    loadSnoozedCount();

    // Listen for snooze wakeup events
    window.electronAPI.snooze.onWakeup((data) => {
      console.log(`[Snooze] ${data.count} emails unsnoozed`);
      loadSnoozedCount();
      // Refresh current view so unsnoozed emails appear as unread
      const state = useEmailStore.getState();
      if (state.viewingSnoozed) {
        state.loadSnoozedEmails();
      } else if (state.viewingAICategory) {
        // On an AI-category tab: bump so the category list re-fetches unsnoozed mail.
        useEmailStore.setState({ aiCategoryCountsLastUpdate: Date.now() });
      } else if (state.selectedVirtualFolder) {
        const vfType = state.selectedVirtualFolder.replace('virtual-', '') as 'all' | 'starred' | 'important' | 'snoozed' | 'unified';
        state.refreshVirtualFolder(vfType);
      } else if (state.selectedFolderId) {
        state.mergeNewEmails(state.selectedFolderId);
      }
      // Notify EmailList to refresh snoozed view
      document.dispatchEvent(new CustomEvent('sarvinbox:snooze-wakeup', { detail: data }));
    });

    return () => {
      window.electronAPI.snooze.removeWakeupListener();
    };
  }, []);

  const handleSync = async () => {
    try {
      await syncEmails();
    } catch (error) {
      console.error('Sync failed:', error);
    }
  };

  const handleStopSync = async () => {
    try {
      await window.electronAPI.imap.stopSync();
      console.log('Stop sync requested');
    } catch (error) {
      console.error('Failed to stop sync:', error);
    }
  };

  const handleCompose = () => {
    openCompose('new');
  };

  // Gmail-style folder icons
  const getFolderIcon = (path: string) => {
    const lowerPath = path.toLowerCase();

    // Gmail specific folders
    if (lowerPath.includes('starred') || lowerPath.includes('star'))
      return <Star className="h-4 w-4 text-yellow-500" />;
    if (lowerPath.includes('important'))
      return <ChevronRight className="h-4 w-4 text-yellow-500 fill-yellow-500" />;
    if (lowerPath.includes('all mail'))
      return <Mail className="h-4 w-4" />;

    // Standard folders
    if (lowerPath === 'inbox') return <Inbox className="h-4 w-4" />;
    if (lowerPath.includes('sent')) return <Send className="h-4 w-4" />;
    if (lowerPath.includes('draft')) return <FileText className="h-4 w-4" />;
    if (lowerPath.includes('archive')) return <Archive className="h-4 w-4" />;
    if (lowerPath.includes('trash') || lowerPath.includes('deleted'))
      return <Trash2 className="h-4 w-4" />;
    if (lowerPath.includes('spam') || lowerPath.includes('junk'))
      return <Ban className="h-4 w-4" />;

    // Default folder icon for labels
    return <Folder className="h-4 w-4" />;
  };

  // Categorize folders into system and user-defined (labels) using the shared
  // core classifier (SPECIAL-USE → exact path → name heuristic). This correctly
  // recognizes provider-specific spam names like "Junk"/"INBOX.Junk" and the
  // \Junk special-use flag, which the old hard-coded substring list missed —
  // so the Spam/Junk folder lands in System instead of falling into Labels.
  const SYSTEM_FOLDER_ORDER = ['sent', 'drafts', 'archive', 'spam', 'trash'] as const;
  const SYSTEM_FOLDER_TYPES = new Set<string>(SYSTEM_FOLDER_ORDER);
  const categorizedFolders = () => {
    // Filter out hidden provider folders (All Mail, Important, Starred)
    const visibleFolders = folders.filter(f => !shouldHideFolder(f.path));

    const inbox = visibleFolders.filter((f) => f.path === 'INBOX');
    // Collapse each system role to ONE canonical folder. A provider can expose
    // two mailboxes for the same role (e.g. Gmail's "[Gmail]/Sent Mail" plus a
    // stray "Sent" label); findFolderByType prefers the SPECIAL-USE-flagged one,
    // and we drop the duplicates so only a single Sent / Drafts / Trash / … shows.
    // On Gmail all sent mail already lives in that canonical folder, so nothing
    // is lost by hiding the duplicate.
    const systemFolders = SYSTEM_FOLDER_ORDER
      .map((type) => findFolderByType(visibleFolders, type))
      .filter((f): f is (typeof visibleFolders)[number] => f !== null);
    const systemFolderIds = new Set(systemFolders.map((f) => f.id));
    // A user label that was mirrored to the server (synced_to_server) surfaces
    // here as a folder too; hide those so the label shows only under Labels.
    const syncedLabelPaths = new Set(
      (labels ?? []).filter((l) => l.syncedToServer).map((l) => l.name.toLowerCase()),
    );
    const userFolders = visibleFolders.filter(
      (f) =>
        f.path !== 'INBOX' &&
        !SYSTEM_FOLDER_TYPES.has(classifyFolder(f) ?? '') &&
        !systemFolderIds.has(f.id) &&
        !syncedLabelPaths.has(f.path.toLowerCase()) &&
        // Our own AI-category labels ("Sarv Inbox/…") are shown at the top of
        // the app, not in the sidebar — only real user folders belong here.
        !isAiLabelFolder(f.path) &&
        // Same idea on our own host, where the server names those mailboxes
        // bare ("Promotions"). `systemCategories` is empty off sarv.com, so a
        // folder of that name on any other account stays visible.
        !isSystemCategoryFolder(f.path, systemCategories),
    );

    // Sort user folders alphabetically
    userFolders.sort((a, b) => a.path.localeCompare(b.path));

    return { inbox, systemFolders, userFolders };
  };

  const { inbox, systemFolders, userFolders } = categorizedFolders();

  // Build tree structure from flat folder list for labels like [Superhuman]/AI/Tax
  type FolderTreeNode = {
    name: string;
    path: string;
    folder: typeof folders[0] | null; // null for virtual parent nodes
    children: FolderTreeNode[];
  };

  const buildFolderTree = (folderList: typeof folders): FolderTreeNode[] => {
    const root: FolderTreeNode[] = [];
    const nodeMap = new Map<string, FolderTreeNode>();

    for (const folder of folderList) {
      // Split path by / to get hierarchy
      // Handle paths like [Superhuman]/AI/Tax or just MyLabel
      const parts = folder.path.split('/');
      let currentPath = '';
      let currentLevel = root;

      for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        currentPath = currentPath ? `${currentPath}/${part}` : part;
        const isLast = i === parts.length - 1;

        let existingNode = nodeMap.get(currentPath);

        if (!existingNode) {
          existingNode = {
            name: part.replace(/^\[|\]$/g, ''), // Remove brackets from [Gmail] etc
            path: currentPath,
            folder: isLast ? folder : null, // Only leaf nodes have actual folder
            children: [],
          };
          nodeMap.set(currentPath, existingNode);
          currentLevel.push(existingNode);
        }

        // If this is the last part and we found an existing virtual node, attach the folder
        if (isLast && !existingNode.folder) {
          existingNode.folder = folder;
        }

        currentLevel = existingNode.children;
      }
    }

    return root;
  };

  const folderTree = buildFolderTree(userFolders);

  const toggleLabelExpanded = (path: string) => {
    setExpandedLabels(prev => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  };

  const renderFolderTree = (nodes: FolderTreeNode[], depth = 0): JSX.Element[] => {
    return nodes.map(node => {
      const hasChildren = node.children.length > 0;
      const isExpanded = expandedLabels.has(node.path);
      const isSelected = node.folder && selectedFolderId === node.folder.id && !viewingSnoozed;
      return (
        <div key={node.path}>
          <button
            onClick={() => {
              if (hasChildren) {
                toggleLabelExpanded(node.path);
              }
              if (node.folder) {
                // Let selectFolder see the still-active virtual / AI / snoozed
                // state and clear it itself. Pre-clearing here flips the flags
                // to null before selectFolder's "already-viewing-this-folder"
                // skip check runs, which then mistakenly short-circuits the
                // reload — leaving the filtered email list on screen.
                selectFolder(node.folder.id);
              }
            }}
            className={`w-full flex items-center gap-2 px-3 py-1.5 rounded-md text-left text-foreground ${
              isSelected
                ? 'bg-accent'
                : 'hover:bg-accent/50'
            }`}
            style={{ paddingLeft: `${12 + depth * 16}px` }}
          >
            {hasChildren ? (
              isExpanded ? (
                <ChevronDown className="h-3 w-3 flex-shrink-0" />
              ) : (
                <ChevronRight className="h-3 w-3 flex-shrink-0" />
              )
            ) : (
              <span className="w-3" /> // Spacer for alignment
            )}
            <Folder className="h-4 w-4 flex-shrink-0" />
            <span className="text-sm truncate flex-1">{node.name}</span>
            {node.folder && node.folder.unreadCount > 0 && (
              <span className="text-xs text-muted-foreground tabular-nums">
                {node.folder.unreadCount}
              </span>
            )}
          </button>
          {hasChildren && isExpanded && (
            <div>
              {renderFolderTree(node.children, depth + 1)}
            </div>
          )}
        </div>
      );
    });
  };

  // Get icon for virtual folder
  const getVirtualFolderIcon = (type: VirtualFolder['type']) => {
    switch (type) {
      case 'all':
        return <Mail className="h-4 w-4 text-blue-500" />;
      case 'important':
        return <AlertCircle className="h-4 w-4 text-yellow-500" />;
      case 'starred':
        return <Star className="h-4 w-4 text-yellow-500" />;
      default:
        return <Folder className="h-4 w-4" />;
    }
  };

  // Handle virtual folder click (Single Source of Truth)
  const handleVirtualFolderClick = (folder: VirtualFolder) => {
    clearSnoozedView();
    clearAICategoryView();

    if (folder.type === 'all') {
      loadAllEmails?.();
    } else if (folder.type === 'starred') {
      // Use unified starred emails method
      loadStarredEmails?.();
    }
  };

  // Map folder paths to goto shortcut targets
  const getFolderGotoHints = (path: string): string[] => {
    const lower = path.toLowerCase();
    if (lower === 'inbox') return getGotoShortcutHints('inbox');
    if (lower.includes('sent')) return getGotoShortcutHints('sent');
    if (lower.includes('draft')) return getGotoShortcutHints('drafts');
    return [];
  };

  const renderFolder = (folder: typeof folders[0]) => {
    const gotoHints = getFolderGotoHints(folder.path);
    const displayName = folderDisplayName(folder);
    const btn = (
      <button
        key={folder.id}
        onClick={() => {
          // selectFolder clears viewingAICategory / selectedVirtualFolder /
          // viewingSnoozed / searchQuery in its set() call. Pre-clearing here
          // sabotages selectFolder's skip-reload check (it would see clean
          // state and assume nothing to do), leaving the filtered list on
          // screen when user clicks back to a folder.
          selectFolder(folder.id);
        }}
        className={`w-full flex items-center gap-3 nav-row rounded-md text-left text-foreground ${
          selectedFolderId === folder.id && !viewingSnoozed
            ? 'bg-accent'
            : 'hover:bg-accent/50'
        }`}
      >
        {getFolderIcon(folder.path)}
        <div className="flex-1 min-w-0">
          <div className="text-sm truncate">
            {displayName}
          </div>
        </div>
        {folder.unreadCount > 0 && (
          <div className="text-xs text-muted-foreground tabular-nums">
            {folder.unreadCount}
          </div>
        )}
      </button>
    );

    if (gotoHints.length > 0) {
      return (
        <Tooltip key={folder.id} content="" shortcut={gotoHints} position="right" className="w-full">
          {btn}
        </Tooltip>
      );
    }
    return btn;
  };

  return (
    <div className="w-64 min-w-64 flex-shrink-0 border-r border-border bg-card flex flex-col">
      {/* Header */}
      <div className="h-14 px-2 border-b border-border flex items-center justify-center gap-2.5">
        {/* Decorative: the wordmark beside it already says "SarvInbox". */}
        <img
          src={logoMark}
          alt=""
          aria-hidden="true"
          className="h-10 w-10 shrink-0 object-contain"
        />
        <img
          src={logoLarge}
          alt="SarvInbox"
          className="h-5 w-auto object-contain dark:hidden"
        />
        <img
          src={logoLargeDark}
          alt=""
          aria-hidden="true"
          className="hidden h-5 w-auto object-contain dark:block"
        />
      </div>

      {/* Account switcher (multi-account) */}
      <AccountSwitcher />

      {/* Compose Button */}
      <div className="p-3">
        <Tooltip content="" shortcut={getShortcutHints('COMPOSE')} position="right" className="w-full">
          <button
            onClick={handleCompose}
            className="w-full flex items-center justify-center gap-2 px-4 py-2.5 brand-fill text-primary-foreground rounded-full shadow-md hover:shadow-lg transition-all font-medium"
          >
            <Plus className="h-5 w-5" />
            Compose
          </button>
        </Tooltip>
      </div>

      {/* Folders */}
      <div className="flex-1 overflow-y-auto">
        {/* Only show full loading spinner on initial load (no folders yet) */}
        {loadingFolders && folders.length === 0 ? (
          <div className="flex items-center justify-center p-8">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : folders.length === 0 ? (
          <div className="p-4 text-sm text-muted-foreground text-center">
            {/* A sync IS running — telling the user to click sync is both wrong
                and the reason a first run looks broken. The list appears on its
                own as soon as the sync reports its folders (see
                shouldAdoptSyncFolders); until then, say what is happening. */}
            {isSyncing ? (
              <span className="flex items-center justify-center gap-2">
                <Loader2 className="h-4 w-4 animate-spin" />
                Fetching your folders...
              </span>
            ) : (
              'No folders yet. Click sync below to fetch emails.'
            )}
          </div>
        ) : (
          <div className="px-2">
            {/* All Inboxes — merged view across accounts. Only meaningful with
                more than one account. Shows the TOTAL unread COUNT across opted-in
                accounts (not a bell — bells are the per-account switcher signal). */}
            {accounts.length > 1 && (() => {
              const totalUnread = accounts
                .filter((a) => a.includeInUnified !== false)
                .reduce((sum, a) => sum + (accountUnread[a.id] ?? 0), 0);
              return (
                <button
                  onClick={() => selectUnifiedInbox()}
                  className={`w-full flex items-center gap-3 nav-row rounded-md text-left text-foreground ${
                    selectedVirtualFolder === 'virtual-unified' ? 'bg-accent' : 'hover:bg-accent/50'
                  }`}
                >
                  <Layers className="h-4 w-4 text-primary" />
                  <span className="text-sm flex-1 truncate font-medium">All Inboxes</span>
                  {totalUnread > 0 && (
                    <span className="text-xs font-semibold text-muted-foreground shrink-0">{totalUnread}</span>
                  )}
                </button>
              );
            })()}

            {/* Inbox - Always visible at top */}
            {inbox.map(renderFolder)}

            {/* Virtual Folders - All Email (Important removed — replaced by AI category pill) */}
            {VIRTUAL_FOLDERS.filter(vf => vf.type !== 'starred' && vf.type !== 'important').map((vFolder) => (
              <Tooltip key={vFolder.id} content="" shortcut={vFolder.type === 'all' ? getGotoShortcutHints('all') : []} position="right" className="w-full">
                <button
                  onClick={() => handleVirtualFolderClick(vFolder)}
                  className={`w-full flex items-center gap-3 nav-row rounded-md text-left text-foreground ${
                    selectedVirtualFolder === vFolder.id
                      ? 'bg-accent'
                      : 'hover:bg-accent/50'
                  }`}
                >
                  {getVirtualFolderIcon(vFolder.type)}
                  <span className="text-sm flex-1 truncate">{vFolder.name}</span>
                </button>
              </Tooltip>
            ))}

            {/* Starred - Virtual folder (Single Source of Truth) */}
            <Tooltip content="" shortcut={getGotoShortcutHints('starred')} position="right" className="w-full">
              <button
                onClick={() => {
                  clearSnoozedView();
                  clearAICategoryView();
                  loadStarredEmails?.();
                }}
                className={`w-full flex items-center gap-3 nav-row rounded-md text-left text-foreground ${
                  selectedVirtualFolder === 'virtual-starred'
                    ? 'bg-accent'
                    : 'hover:bg-accent/50'
                }`}
              >
                <Star className="h-4 w-4 text-yellow-500" />
                <span className="text-sm flex-1 truncate">Starred</span>
              </button>
            </Tooltip>

            {/* Snoozed - Virtual folder */}
            <Tooltip content="" shortcut={getGotoShortcutHints('snoozed')} position="right" className="w-full">
              <button
                onClick={() => {
                  clearAICategoryView();
                  loadSnoozedEmails();
                }}
                className={`w-full flex items-center gap-3 nav-row rounded-md text-left text-foreground ${
                  viewingSnoozed
                    ? 'bg-accent'
                    : 'hover:bg-accent/50'
                }`}
              >
                <Clock className="h-4 w-4 text-blue-500" />
                <div className="flex-1 min-w-0">
                  <div className="text-sm truncate">Snoozed</div>
                </div>
                {snoozedCount > 0 && (
                  <div className="text-xs text-muted-foreground tabular-nums">{snoozedCount}</div>
                )}
              </button>
            </Tooltip>

            {/* Outbox - virtual view (send queue), like Thunderbird's Outbox */}
            <Tooltip content="" position="right" className="w-full">
              <button
                onClick={() => showOutbox()}
                className={`w-full flex items-center gap-3 nav-row rounded-md text-left text-foreground ${
                  selectedVirtualFolder === 'virtual-outbox'
                    ? 'bg-accent'
                    : 'hover:bg-accent/50'
                }`}
              >
                <Send className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm flex-1 truncate">Outbox</span>
                {outboxCount > 0 && (
                  <span className="text-xs text-muted-foreground tabular-nums">{outboxCount}</span>
                )}
              </button>
            </Tooltip>

            {/* System Folders Section */}
            {systemFolders.length > 0 && (
              <div className="mt-2">
                <button
                  onClick={() => setSystemFoldersExpanded(!systemFoldersExpanded)}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-xs font-semibold text-muted-foreground uppercase tracking-wider hover:text-foreground"
                >
                  {systemFoldersExpanded ? (
                    <ChevronDown className="h-3 w-3" />
                  ) : (
                    <ChevronRight className="h-3 w-3" />
                  )}
                  System
                </button>
                {systemFoldersExpanded && (
                  <div className="mt-1">
                    {systemFolders.map(renderFolder)}
                  </div>
                )}
              </div>
            )}

            {/* User-defined Labels — nested tree, create/recolor/rename/delete */}
            <SidebarLabels />

            {/* IMAP folders / server labels (custom mailbox folders) */}
            {userFolders.length > 0 && (
              <div className="mt-2">
                <button
                  onClick={() => setLabelsFoldersExpanded(!labelsFoldersExpanded)}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-xs font-semibold text-muted-foreground uppercase tracking-wider hover:text-foreground"
                >
                  {labelsFoldersExpanded ? (
                    <ChevronDown className="h-3 w-3" />
                  ) : (
                    <ChevronRight className="h-3 w-3" />
                  )}
                  Folders
                </button>
                {labelsFoldersExpanded && (
                  <div className="mt-1">
                    {renderFolderTree(folderTree)}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Mailbox storage quota — only when the server reports a meaningful limit.
          Amber near full, red when critical, so a full mailbox (a silent cause of
          "mail stopped arriving") is visible before it bites. */}
      {(() => {
        const row = quotaRowState({ quota, loading: quotaLoading, answered: quotaAnswered });
        if (row.kind === 'hidden') return null;
        // Nothing to show YET but a lookup is running (first look at this
        // account): keep the row, at the same height, as a placeholder. It fills
        // in when the server answers instead of appearing and shoving the footer.
        if (row.kind === 'placeholder') {
          return (
            <div className="px-3 py-1.5 border-t border-border" aria-hidden="true">
              <div className="flex items-center justify-between gap-2 mb-1">
                <span className="h-[11px] w-20 rounded bg-muted animate-pulse" />
                <span className="h-[11px] w-6 rounded bg-muted animate-pulse shrink-0" />
              </div>
              <div className="h-1 rounded-full bg-muted overflow-hidden" />
            </div>
          );
        }
        const qv = row.view;
        const barColor = qv.level === 'critical' ? 'bg-red-500' : qv.level === 'warning' ? 'bg-amber-500' : 'bg-primary';
        const textColor = qv.level === 'critical'
          ? 'text-red-600 dark:text-red-400'
          : qv.level === 'warning'
            ? 'text-amber-600 dark:text-amber-400'
            : 'text-muted-foreground';
        return (
          <div className="px-3 py-1.5 border-t border-border">
            <div className="flex items-center justify-between gap-2 mb-1">
              <span className={`text-[11px] truncate ${textColor}`}>{qv.usedLabel} of {qv.limitLabel}</span>
              <span className={`text-[11px] tabular-nums shrink-0 ${textColor}`}>{qv.percent}%</span>
            </div>
            <div className="h-1 rounded-full bg-muted overflow-hidden">
              <div className={`h-full ${barColor} transition-all`} style={{ width: `${qv.percent}%` }} />
            </div>
          </div>
        );
      })()}

      {/* Footer status bar: version (left) · status bubble + label · action (right) */}
      {(() => {
        const barStatus = getConnectionBarStatus(
          connectionStatus,
          isSyncing,
          idleActive,
          syncStatus,
          syncTrouble,
        );
        return (
          <div className="relative border-t border-border overflow-hidden">
            {/* Sync progress fill along the bottom edge */}
            {isSyncing && syncStatus && (
              <div
                className="absolute left-0 bottom-0 h-0.5 bg-primary transition-all duration-300"
                style={{ width: `${syncStatus.percentComplete || 0}%` }}
              />
            )}

            <div className="flex items-center justify-between gap-2 px-3 py-1.5">
              {/* Left: version */}
              <span className="text-xs text-muted-foreground tabular-nums shrink-0">
                v{appVersion}
              </span>

              {/* Right: status bubble + label + action */}
              <div className="flex items-center gap-2 min-w-0">
                <span
                  className={`h-2 w-2 rounded-full shrink-0 ${barStatus.dotClass} ${
                    barStatus.pulse ? 'animate-pulse' : ''
                  }`}
                />
                <span className="text-xs text-muted-foreground truncate">
                  {barStatus.label}
                </span>

                {connectionStatus === 'reconnecting' ? (
                  <RefreshCw className="h-4 w-4 shrink-0 animate-spin text-yellow-600 dark:text-yellow-500" />
                ) : isSyncing ? (
                  <button
                    onClick={handleStopSync}
                    title="Stop sync"
                    className="shrink-0 p-1 rounded-md text-red-500 hover:bg-red-500/10 transition-colors"
                  >
                    <Square className="h-4 w-4 fill-current" />
                  </button>
                ) : connectionStatus === 'disconnected' ? (
                  <button
                    onClick={reconnect}
                    title="Reconnect"
                    className="shrink-0 p-1 rounded-md text-muted-foreground hover:text-yellow-600 dark:hover:text-yellow-500 hover:bg-yellow-500/10 transition-colors"
                  >
                    <WifiOff className="h-4 w-4" />
                  </button>
                ) : (
                  <button
                    onClick={handleSync}
                    disabled={loadingFolders}
                    title="Sync now"
                    className="shrink-0 p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors disabled:opacity-50"
                  >
                    <RefreshCw className="h-4 w-4" />
                  </button>
                )}
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
