import {
  Square, CheckSquare, MinusSquare, ChevronDown,
  RefreshCw, Archive, AlertOctagon, Trash2,
  Mail, MailOpen, Clock, MoreVertical, Star, StarOff,
  Check, RotateCcw, ShieldCheck, FolderInput, Copy,
} from 'lucide-react';
import { useState, useRef, useEffect } from 'react';

import { getShortcutHints } from '../../config/keyboard-shortcuts';
import { useEmailStore } from '../../store/email-store';
import { FolderPicker } from '../FolderPicker';
import { Tooltip } from '../Tooltip';
import { ViewModeDropdown } from '../ViewModeDropdown';

import { SnoozeDropdown } from './SnoozeDropdown';
import type { BulkActionBarProps, SelectKind } from './types';

// Gmail-style "Select" dropdown: All/None, then by read-state, then by star.
const SELECT_OPTIONS: Array<{ kind: SelectKind; label: string } | { divider: true }> = [
  { kind: 'all', label: 'All' },
  { kind: 'none', label: 'None' },
  { divider: true },
  { kind: 'read', label: 'Read' },
  { kind: 'unread', label: 'Unread' },
  { divider: true },
  { kind: 'starred', label: 'Starred' },
  { kind: 'unstarred', label: 'Unstarred' },
];

export function BulkActionBar({
  selectedCount,
  totalCount,
  syncing,
  hasSelection,
  allSelectedAreRead,
  showViewModeDropdown,
  setShowViewModeDropdown,
  onSelectAll,
  onSelectBy,
  onRefresh,
  onBulkArchive,
  onBulkDelete,
  onBulkMarkRead,
  onBulkMarkStarred,
  onBulkMoveToSpam,
  onBulkSnooze,
  onBulkMoveToInbox,
  onBulkMove,
  onBulkCopy,
  isTrashView,
  isSpamView,
}: BulkActionBarProps) {
  const sendingStatus = useEmailStore(state => state.sendingStatus);
  const [showMoreMenu, setShowMoreMenu] = useState(false);
  const [showSelectMenu, setShowSelectMenu] = useState(false);
  const [showSnoozeMenu, setShowSnoozeMenu] = useState(false);
  const moreMenuRef = useRef<HTMLDivElement>(null);
  const selectMenuRef = useRef<HTMLDivElement>(null);
  const snoozeMenuRef = useRef<HTMLDivElement>(null);

  // Close menus on outside click
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (moreMenuRef.current && !moreMenuRef.current.contains(e.target as Node)) {
        setShowMoreMenu(false);
      }
      if (selectMenuRef.current && !selectMenuRef.current.contains(e.target as Node)) {
        setShowSelectMenu(false);
      }
      if (snoozeMenuRef.current && !snoozeMenuRef.current.contains(e.target as Node)) {
        setShowSnoozeMenu(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const iconBtn = "p-1.5 hover:bg-accent rounded-md transition-colors";
  const iconSize = "h-4 w-4 text-muted-foreground";

  return (
    <div className="h-10 px-2 border-b border-border flex items-center gap-0.5 flex-shrink-0">
      {/* Select checkbox + dropdown */}
      <div className="relative flex items-center" ref={selectMenuRef}>
        <button
          onClick={onSelectAll}
          className={iconBtn}
          title={selectedCount === totalCount && totalCount > 0 ? 'Deselect all' : 'Select all'}
        >
          {selectedCount === 0 ? (
            <Square className={iconSize} />
          ) : selectedCount === totalCount ? (
            <CheckSquare className="h-4 w-4 text-primary" />
          ) : (
            <MinusSquare className="h-4 w-4 text-primary" />
          )}
        </button>
        <button
          onClick={() => setShowSelectMenu(!showSelectMenu)}
          className="p-0.5 hover:bg-accent rounded-md -ml-0.5"
        >
          <ChevronDown className="h-3 w-3 text-muted-foreground" />
        </button>

        {showSelectMenu && (
          <div className="absolute left-0 top-full mt-1 z-50 bg-popover border border-border rounded-lg shadow-lg py-1 w-36">
            {SELECT_OPTIONS.map((opt, i) =>
              'divider' in opt ? (
                <div key={`div-${i}`} className="h-px bg-border my-1" />
              ) : (
                <button
                  key={opt.kind}
                  onClick={() => { onSelectBy(opt.kind); setShowSelectMenu(false); }}
                  className="w-full px-3 py-1.5 text-left text-sm hover:bg-accent"
                >
                  {opt.label}
                </button>
              ),
            )}
          </div>
        )}
      </div>

      {hasSelection ? (
        <>
          {/* Bulk action buttons — folder-aware. Trash/Spam swap the outbound
              actions (Archive/Report-spam) for a "move back to Inbox" recovery,
              mirroring the single-mail toolbar. */}
          {isTrashView ? (
            <Tooltip content="Restore to Inbox">
              <button onClick={onBulkMoveToInbox} className={`${iconBtn} text-green-600`}>
                <RotateCcw className="h-4 w-4" />
              </button>
            </Tooltip>
          ) : isSpamView ? (
            <Tooltip content="Not spam — move to Inbox">
              <button onClick={onBulkMoveToInbox} className={`${iconBtn} text-green-600`}>
                <ShieldCheck className="h-4 w-4" />
              </button>
            </Tooltip>
          ) : (
            <>
              <Tooltip content="Archive" shortcut={getShortcutHints('ARCHIVE')}>
                <button onClick={onBulkArchive} className={iconBtn}>
                  <Archive className={iconSize} />
                </button>
              </Tooltip>
              <Tooltip content="Report spam" shortcut={getShortcutHints('SPAM')}>
                <button onClick={onBulkMoveToSpam} className={iconBtn}>
                  <AlertOctagon className={iconSize} />
                </button>
              </Tooltip>
            </>
          )}
          <Tooltip content={isTrashView ? 'Delete forever' : 'Delete'} shortcut={getShortcutHints('DELETE')}>
            <button onClick={onBulkDelete} className={`${iconBtn}${isTrashView ? ' text-destructive' : ''}`}>
              <Trash2 className={iconSize} />
            </button>
          </Tooltip>

          {/* Move / Copy the selection to a chosen folder */}
          <FolderPicker
            title="Move to folder"
            placeholder="Move to…"
            icon={<FolderInput className={iconSize} />}
            onPick={(folderId) => onBulkMove(folderId)}
            buttonClassName={iconBtn}
          />
          <FolderPicker
            title="Copy to folder"
            placeholder="Copy to…"
            icon={<Copy className={iconSize} />}
            onPick={(folderId) => onBulkCopy(folderId)}
            buttonClassName={iconBtn}
          />

          <div className="w-px h-5 bg-border mx-1" />

          {allSelectedAreRead ? (
            <Tooltip content="Mark as unread" shortcut={getShortcutHints('MARK_UNREAD')}>
              <button onClick={() => onBulkMarkRead(false)} className={iconBtn}>
                <Mail className={iconSize} />
              </button>
            </Tooltip>
          ) : (
            <Tooltip content="Mark as read" shortcut={getShortcutHints('MARK_READ')}>
              <button onClick={() => onBulkMarkRead(true)} className={iconBtn}>
                <MailOpen className={iconSize} />
              </button>
            </Tooltip>
          )}

          {/* Snooze dropdown */}
          <Tooltip content="Snooze" shortcut={getShortcutHints('SNOOZE')} hidden={showSnoozeMenu}>
            <div className="relative" ref={snoozeMenuRef}>
              <button
                onClick={() => setShowSnoozeMenu(!showSnoozeMenu)}
                className={iconBtn}
              >
                <Clock className={iconSize} />
              </button>
              {showSnoozeMenu && (
                <SnoozeDropdown
                  onBulkSnooze={onBulkSnooze}
                  onClose={() => setShowSnoozeMenu(false)}
                  align="left"
                />
              )}
            </div>
          </Tooltip>

          {/* More dropdown */}
          <div className="relative" ref={moreMenuRef}>
            <button
              onClick={() => setShowMoreMenu(!showMoreMenu)}
              className={iconBtn}
              title="More"
            >
              <MoreVertical className={iconSize} />
            </button>
            {showMoreMenu && (
              <div className="absolute left-0 top-full mt-1 z-50 bg-popover border border-border rounded-lg shadow-lg py-1 w-48">
                <button
                  onClick={() => { onBulkMarkRead(true); setShowMoreMenu(false); }}
                  className="w-full px-3 py-1.5 text-left text-sm hover:bg-accent flex items-center gap-2"
                >
                  <MailOpen className="h-4 w-4" />
                  Mark as read
                </button>
                <button
                  onClick={() => { onBulkMarkRead(false); setShowMoreMenu(false); }}
                  className="w-full px-3 py-1.5 text-left text-sm hover:bg-accent flex items-center gap-2"
                >
                  <Mail className="h-4 w-4" />
                  Mark as unread
                </button>
                <div className="h-px bg-border my-1" />
                <button
                  onClick={() => { onBulkMarkStarred(true); setShowMoreMenu(false); }}
                  className="w-full px-3 py-1.5 text-left text-sm hover:bg-accent flex items-center gap-2"
                >
                  <Star className="h-4 w-4" />
                  Add star
                </button>
                <button
                  onClick={() => { onBulkMarkStarred(false); setShowMoreMenu(false); }}
                  className="w-full px-3 py-1.5 text-left text-sm hover:bg-accent flex items-center gap-2"
                >
                  <StarOff className="h-4 w-4" />
                  Remove star
                </button>
              </div>
            )}
          </div>

          {/* Spacer */}
          <div className="flex-1" />

          {/* Selection count */}
          <span className="text-xs text-muted-foreground mr-2">
            {selectedCount} selected
          </span>
        </>
      ) : (
        <>
          {/* Default state - refresh / sending status */}
          {sendingStatus === 'sending' ? (
            <div className="flex items-center gap-1.5 px-2 py-1 rounded-md">
              <RefreshCw className="h-4 w-4 text-primary animate-spin" />
              <span className="text-xs font-medium text-primary">Sending...</span>
            </div>
          ) : sendingStatus === 'sent' ? (
            <div className="flex items-center gap-1.5 px-2 py-1 bg-green-500/10 rounded-md">
              <Check className="h-4 w-4 text-green-600" />
              <span className="text-xs font-medium text-green-600">Sent</span>
            </div>
          ) : (
            <button
              onClick={onRefresh}
              className={iconBtn}
              title="Refresh"
              disabled={syncing}
            >
              <RefreshCw className={`${iconSize} ${syncing ? 'animate-spin' : ''}`} />
            </button>
          )}

          {/* Spacer */}
          <div className="flex-1" />

          {/* View Mode Toggle */}
          <ViewModeDropdown
            showDropdown={showViewModeDropdown}
            setShowDropdown={setShowViewModeDropdown}
          />
        </>
      )}
    </div>
  );
}
