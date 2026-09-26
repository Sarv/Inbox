import type { EmailRecord } from '@sarvinbox/core';
import { format } from 'date-fns';
import { Star, ChevronRight, Square, CheckSquare, Archive, Trash2, Mail, Clock, CheckCircle } from 'lucide-react';
import { memo } from 'react';

import { formatCountdown } from '../../utils/format-time';
import { threadTagsString } from '../../utils/thread-utils';
import { LabelChips } from '../LabelChips';
import { Tooltip } from '../Tooltip';

import { CategoryBadges } from './CategoryBadges';
import { readStateTextClass } from './read-state-text';
import { SnoozeDropdown } from './SnoozeDropdown';
import type { ThreadRowProps } from './types';


function formatCompactDate(d: Date) {
  const now = new Date();
  const isCurrentYear = d.getFullYear() === now.getFullYear();
  const isToday = d.toDateString() === now.toDateString();

  if (isToday) {
    return format(d, 'h:mm a');
  } else if (isCurrentYear) {
    return format(d, 'MMM d');
  } else {
    return format(d, 'MMM d, yyyy');
  }
}

export const CompactThreadRow = memo(function CompactThreadRow({ thread, actions, uiState, hoverActions, isHovered, showSnoozeDropdown, accountColor, accountLabel }: ThreadRowProps) {
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
      className={`relative w-full text-left list-row border-b border-border transition-colors cursor-pointer flex items-center gap-2 ${
        isSelected ? 'bg-accent' : isHighlighted ? 'bg-accent/70 ring-1 ring-inset ring-primary/30' : 'hover:bg-accent/50'
      }`}
    >
      {/* Account accent — a 2px full-height bar at the row's left edge (unified
          "All Inboxes" view). Absolutely positioned so it doesn't shift the row
          content; tooltip names the account. */}
      {accountColor && (
        <Tooltip content={accountLabel ?? 'Account'} delayMs={40} className="absolute left-0 top-0 bottom-0 w-1">
          <span
            className="block h-full w-full"
            style={{ backgroundColor: accountColor }}
            aria-label={accountLabel ? `Account: ${accountLabel}` : 'Account'}
          />
        </Tooltip>
      )}

      {/* Checkbox */}
      <button
        onClick={(e) => actions.onToggleSelection(thread.threadId, e)}
        className="flex-shrink-0 p-1.5 -m-1 hover:bg-accent/50 rounded"
      >
        {isChecked ? (
          <CheckSquare className="h-4 w-4 text-primary" />
        ) : (
          <Square className="h-4 w-4 text-muted-foreground hover:text-foreground" />
        )}
      </button>

      {/* Star */}
      <button
        onClick={(e) => actions.onToggleStar(latestEmail.id, isStarred, e)}
        className="flex-shrink-0 p-1.5 -m-1 hover:bg-accent/50 rounded"
      >
        <Star className={`h-4 w-4 ${isStarred ? 'text-yellow-500 fill-yellow-500' : 'text-muted-foreground hover:text-yellow-500'}`} />
      </button>

      {/* Importance marker — agent priority score is intentionally not
          shown; Smart Prioritize only affects row ordering */}
      {uiState.showImportanceMarkers && isImportant ? (
        <ChevronRight className="h-4 w-4 text-yellow-500 fill-yellow-500 flex-shrink-0" />
      ) : (
        <div className="w-4 flex-shrink-0" />
      )}

      {/* Sender + Count - fixed width, count never truncated */}
      <div
        className={`w-44 flex-shrink-0 flex items-center text-sm ${
          readStateTextClass(hasUnread)
        }`}
      >
        <span className="truncate min-w-0">{thread.senderDisplay}</span>
        {hasDraft && (
          <>
            <span className="text-muted-foreground font-normal text-xs ml-1 flex-shrink-0">,</span>
            <span className="text-red-600 dark:text-red-400 font-normal text-xs ml-1 flex-shrink-0">Draft</span>
          </>
        )}
        {messageCount > 1 && (
          <span className="text-muted-foreground font-normal text-xs ml-1 flex-shrink-0">({messageCount})</span>
        )}
      </div>

      {/* Subject + Preview */}
      <div className="flex-1 min-w-0 overflow-hidden">
        <div className="flex items-center gap-1.5 w-full">
          <LabelChips tags={threadTagsString(thread)} variant="solid" className="shrink-0" />
          <span className={`shrink truncate text-sm ${readStateTextClass(hasUnread)}`}>
            {oldestEmail.subject || '(no subject)'}
          </span>
          <span className="text-muted-foreground text-sm shrink-0">-</span>
          <span className="text-muted-foreground text-sm truncate flex-1 min-w-0">
            {latestEmail.cleanBody?.substring(0, 100) || ''}
          </span>
        </div>
      </div>

      {/* Right side container - fixed width to prevent layout shift */}
      <div className="w-auto flex-shrink-0 flex items-center justify-end gap-1 relative">
        {/* AI Category badges — kept mounted and toggled via CSS instead of
            unmounted on hover, so the batched category IPC/effect doesn't
            re-fire every time the row is hovered. `contents` keeps the exact
            same flex layout when visible; `hidden` frees its space on hover. */}
        <span className={isHovered ? 'hidden' : 'contents'}>
          <CategoryBadges emailId={thread.badgeEmailId} />
        </span>

        {/* Snoozed countdown badge */}
        {isSnoozed && (
          <span className="text-xs px-1 py-0.5 bg-blue-100 dark:bg-blue-900 text-blue-600 dark:text-blue-300 rounded flex items-center gap-0.5">
            <Clock className="h-3 w-3" />
            {latestEmail.snoozeUntil && <span>{formatCountdown(latestEmail.snoozeUntil)}</span>}
          </span>
        )}

        {/* Was-snoozed badge */}
        {wasSnoozed && (
          <span className="text-xs px-1 py-0.5 bg-purple-100 dark:bg-purple-900 text-purple-600 dark:text-purple-300 rounded flex items-center gap-1">
            <CheckCircle className="h-3 w-3" />
            Snoozed
          </span>
        )}

        {/* Attachments indicator - always visible if has attachments */}
        {hasAttachments && (
          <svg className="h-4 w-4 text-muted-foreground flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
          </svg>
        )}

        {/* Date - hide on hover */}
        <span className={`text-xs text-muted-foreground text-right transition-opacity ${isHovered ? 'opacity-0' : 'opacity-100'}`}>
          {formatCompactDate(date)}
        </span>

        {/* Hover Actions - overlay on top */}
        {isHovered && (
          <div className="absolute right-0 top-1/2 -translate-y-1/2 z-10 flex items-center gap-0.5 bg-accent/90 rounded px-1">
            <button
              onClick={(e) => { e.stopPropagation(); actions.onArchive(latestEmail.id, e); }}
              className="p-1.5 hover:bg-background/50 rounded"
              title="Archive"
            >
              <Archive className="h-4 w-4 text-muted-foreground hover:text-foreground" />
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); actions.onDelete(latestEmail.id, e); }}
              className="p-1.5 hover:bg-background/50 rounded"
              title="Delete"
            >
              <Trash2 className="h-4 w-4 text-muted-foreground hover:text-red-500" />
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); actions.onToggleRead(latestEmail.id, isRead, e); }}
              className="p-1.5 hover:bg-background/50 rounded"
              title={isRead ? 'Mark as unread' : 'Mark as read'}
            >
              <Mail className={`h-4 w-4 ${isRead ? 'text-muted-foreground hover:text-foreground' : 'text-primary'}`} />
            </button>
            <div className="relative">
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  hoverActions.setSnoozeDropdownThreadId(showSnoozeDropdown ? null : thread.threadId);
                }}
                className="p-1.5 hover:bg-background/50 rounded"
                title="Snooze"
              >
                <Clock className={`h-4 w-4 ${isSnoozed ? 'text-blue-500' : 'text-muted-foreground hover:text-foreground'}`} />
              </button>
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
          </div>
        )}
      </div>
    </div>
  );
});
