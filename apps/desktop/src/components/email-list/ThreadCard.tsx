import type { EmailRecord } from '@sarvinbox/core';
import { format } from 'date-fns';
import { Star, ChevronRight, Square, CheckSquare, Archive, Trash2, Mail, Clock, CheckCircle } from 'lucide-react';
import { memo } from 'react';

import { getShortcutHints } from '../../config/keyboard-shortcuts';
import { formatCountdown } from '../../utils/format-time';
import { threadTagsString } from '../../utils/thread-utils';
import { LabelChips } from '../LabelChips';
import { Tooltip } from '../Tooltip';

import { CategoryBadges } from './CategoryBadges';
import { readStateTextClass } from './read-state-text';
import { SnoozeDropdown } from './SnoozeDropdown';
import type { ThreadRowProps } from './types';


export const ThreadCard = memo(function ThreadCard({ thread, actions, uiState, hoverActions, isHovered, showSnoozeDropdown, accountColor, accountLabel }: ThreadRowProps) {
  const { latestEmail, oldestEmail, hasUnread, messageCount, hasDraft, isImportant, isStarred } = thread;
  const isSelected = thread.emails.some((e: EmailRecord) => e.id === uiState.selectedEmailId);
  const isHighlighted = !isSelected && thread.emails.some((e: EmailRecord) => e.id === uiState.highlightedEmailId);
  const isChecked = uiState.selectedThreadIds.has(thread.threadId);
  const date = new Date(latestEmail.date * 1000);
  const hasAttachments = latestEmail.hasAttachments || oldestEmail.hasAttachments;
  const isRead = (latestEmail.tags || '').includes('|read|');
  const isSnoozed = (latestEmail.tags || '').includes('|snoozed|');
  const wasSnoozed = !isSnoozed && (latestEmail.tags || '').includes('|was_snoozed|');

  return (
    <div
      key={thread.threadId}
      data-thread-id={thread.threadId}
      onClick={() => actions.onThreadClick(thread)}
      onMouseEnter={() => hoverActions.setHoveredThreadId(thread.threadId)}
      onMouseLeave={() => {
        if (!showSnoozeDropdown) {
          hoverActions.setHoveredThreadId(null);
        }
      }}
      className={`w-full text-left list-card border-b border-border transition-colors cursor-pointer relative ${
        isSelected ? 'bg-accent' : isHighlighted ? 'bg-accent/70 ring-1 ring-inset ring-primary/30' : 'hover:bg-accent/50'
      }`}
    >
      {/* Account accent — a 2px full-height bar at the card's left edge (unified
          "All Inboxes" view). Absolutely positioned so it doesn't shift content;
          tooltip names the account. */}
      {accountColor && (
        <Tooltip content={accountLabel ?? 'Account'} delayMs={40} className="absolute left-0 top-0 bottom-0 w-1">
          <span
            className="block h-full w-full"
            style={{ backgroundColor: accountColor }}
            aria-label={accountLabel ? `Account: ${accountLabel}` : 'Account'}
          />
        </Tooltip>
      )}

      {/* Row 1: Checkbox, Importance, Senders, Count, Attachments, Time/Actions */}
      <div className="flex items-center gap-2">
        {/* Checkbox */}
        <button
          onClick={(e) => actions.onToggleSelection(thread.threadId, e)}
          className="flex-shrink-0 p-1.5 -m-1 hover:bg-accent rounded"
        >
          {isChecked ? (
            <CheckSquare className="h-4 w-4 text-primary" />
          ) : (
            <Square className="h-4 w-4 text-muted-foreground hover:text-foreground" />
          )}
        </button>

        {/* Importance marker — the agent priority score stays hidden by
            design; Smart Prioritize only affects ordering (thread-utils
            sortThreadsForDisplay), not what's rendered here */}
        {uiState.showImportanceMarkers && isImportant ? (
          <ChevronRight className="h-4 w-4 text-yellow-500 fill-yellow-500 flex-shrink-0" />
        ) : (
          <div className="w-6 flex-shrink-0" />
        )}


        {/* Senders + Count - count never truncated */}
        <div
          className={`flex-1 min-w-0 flex items-center text-sm ${
            readStateTextClass(hasUnread)
          }`}
        >
          <span className="truncate min-w-0">{thread.senderDisplay}</span>
          {hasDraft && (
            <>
              <span className="text-muted-foreground font-normal flex-shrink-0 ml-1">,</span>
              <span className="text-red-600 dark:text-red-400 font-normal flex-shrink-0 ml-1">Draft</span>
            </>
          )}
          {messageCount > 1 && (
            <span className="text-muted-foreground font-normal flex-shrink-0 ml-1">({messageCount})</span>
          )}
        </div>

        {/* Snoozed countdown badge */}
        {isSnoozed && !isHovered && (
          <span className="text-xs px-1.5 py-0.5 bg-blue-100 dark:bg-blue-900 text-blue-600 dark:text-blue-300 rounded flex items-center gap-1">
            <Clock className="h-3 w-3" />
            {latestEmail.snoozeUntil ? formatCountdown(latestEmail.snoozeUntil) : 'Snoozed'}
          </span>
        )}

        {/* Was-snoozed badge (shown in inbox after unsnooze) */}
        {wasSnoozed && !isHovered && (
          <span className="text-xs px-1.5 py-0.5 bg-purple-100 dark:bg-purple-900 text-purple-600 dark:text-purple-300 rounded flex items-center gap-0.5">
            <CheckCircle className="h-3 w-3" />
          </span>
        )}

        {/* Attachments indicator */}
        {hasAttachments && !isHovered && (
          <svg className="h-4 w-4 text-muted-foreground flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
          </svg>
        )}

        {/* Time and Hover Actions - fixed width container */}
        <div className="flex items-center gap-1 flex-shrink-0 w-28 justify-end relative">
          {/* Category badges + Time - absolute right, hidden on hover */}
          <div className={`absolute right-0 flex items-center gap-1.5 transition-opacity ${isHovered ? 'opacity-0 pointer-events-none' : 'opacity-100'}`}>
            <CategoryBadges emailId={thread.badgeEmailId} compact />
            <span className="text-xs text-muted-foreground whitespace-nowrap">
              {format(date, 'h:mm a')}
            </span>
          </div>

          {/* Action buttons - always rendered, visible on hover */}
          <div className={`relative z-10 flex items-center gap-1 transition-opacity ${isHovered ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}>
            {/* Archive */}
            <Tooltip content="Archive" shortcut={getShortcutHints('ARCHIVE')}>
              <button
                onClick={(e) => { e.stopPropagation(); actions.onArchive(latestEmail.id, e); }}
                className="p-1.5 hover:bg-accent rounded-md"
              >
                <Archive className="h-4 w-4 text-muted-foreground hover:text-foreground" />
              </button>
            </Tooltip>

            {/* Delete */}
            <Tooltip content="Delete" shortcut={getShortcutHints('DELETE')}>
              <button
                onClick={(e) => { e.stopPropagation(); actions.onDelete(latestEmail.id, e); }}
                className="p-1.5 hover:bg-accent rounded-md"
              >
                <Trash2 className="h-4 w-4 text-muted-foreground hover:text-red-500" />
              </button>
            </Tooltip>

            {/* Mark Read/Unread */}
            <Tooltip
              content={isRead ? 'Mark as unread' : 'Mark as read'}
              shortcut={isRead ? getShortcutHints('MARK_UNREAD') : getShortcutHints('MARK_READ')}
            >
              <button
                onClick={(e) => { e.stopPropagation(); actions.onToggleRead(latestEmail.id, isRead, e); }}
                className="p-1.5 hover:bg-accent rounded-md"
              >
                <Mail className={`h-4 w-4 ${isRead ? 'text-muted-foreground hover:text-foreground' : 'text-primary'}`} />
              </button>
            </Tooltip>

            {/* Snooze */}
            <Tooltip content="Snooze" shortcut={getShortcutHints('SNOOZE')} hidden={showSnoozeDropdown}>
              <div className="relative">
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    hoverActions.setSnoozeDropdownThreadId(showSnoozeDropdown ? null : thread.threadId);
                  }}
                  className="p-1.5 hover:bg-accent rounded-md"
                >
                  <Clock className={`h-4 w-4 ${isSnoozed ? 'text-blue-500' : 'text-muted-foreground hover:text-foreground'}`} />
                </button>

                {/* Snooze Dropdown */}
                {showSnoozeDropdown && (
                  <SnoozeDropdown
                    emailId={latestEmail.id}
                    isSnoozed={isSnoozed}
                    onSnooze={actions.onSnooze}
                    onUnsnooze={actions.onUnsnooze}
                    onClose={() => hoverActions.setSnoozeDropdownThreadId(null)}
                  />
                )}
              </div>
            </Tooltip>
          </div>
        </div>
      </div>

      {/* Row 2: Labels + Subject (labels lead so they catch the eye first) */}
      <div className="flex items-center gap-2 mt-0.5 pl-10">
        <LabelChips tags={threadTagsString(thread)} variant="solid" className="shrink-0" />
        <div
          className={`flex-1 min-w-0 truncate text-sm ${
            readStateTextClass(hasUnread)
          }`}
        >
          {latestEmail.subject || oldestEmail.subject || '(no subject)'}
        </div>
      </div>

      {/* Row 3: Body preview and Star */}
      <div className="flex items-center gap-2 mt-0.5 pl-10">
        <div className="flex-1 min-w-0 text-sm text-muted-foreground truncate flex items-center gap-1.5">
          <span className="truncate">{latestEmail.cleanBody?.substring(0, 80) || ''}</span>
        </div>

        {/* Star on the right */}
        <Tooltip content={isStarred ? 'Unstar' : 'Star'} shortcut={getShortcutHints('STAR_TOGGLE')}>
          <button
            onClick={(e) => actions.onToggleStar(latestEmail.id, isStarred, e)}
            className="flex-shrink-0 p-1.5 -m-1 hover:bg-accent rounded"
          >
            <Star className={`h-4 w-4 ${isStarred ? 'text-yellow-500 fill-yellow-500' : 'text-muted-foreground hover:text-yellow-500'}`} />
          </button>
        </Tooltip>
      </div>

    </div>
  );
});
