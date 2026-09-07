import {
  Mail,
  Reply,
  ReplyAll,
  Forward,
  Archive,
  Trash2,
  Printer,
  ArrowLeft,
  ChevronUp,
  ChevronDown,
  XCircle,
  Clock,
  RotateCcw,
  AlertOctagon,
  ShieldCheck,
  Loader2,
  FolderInput,
  Copy,
} from 'lucide-react';
import { useState, useEffect } from 'react';

import { getShortcutHints } from '../../config/keyboard-shortcuts';
import { useEmailStore } from '../../store/email-store';
import { SnoozeDropdown } from '../email-list/SnoozeDropdown';
import { FolderPicker } from '../FolderPicker';
import { LabelMenu } from '../LabelMenu';
import { Tooltip } from '../Tooltip';

import { EmailMenu } from './EmailMenu';
import type { EmailDetailContext } from './types';

interface EmailToolbarProps {
  ctx: EmailDetailContext;
}

export function EmailToolbar({ ctx }: EmailToolbarProps) {
  const {
    displayEmail,
    isRead,
    isInTrash,
    isInSpam,
    viewingAICategory,
    aiBoxActiveTab,
    handleBack,
    handleArchive,
    handleDelete,
    handleMarkRead,
    handleRemoveAICategory,
    handleReply,
    handleReplyAll,
    handleInlineForward,
    handleForward,
    handlePrintEmail,
    handleDownloadEmail,
    handleShowOriginal,
    handleFilterLikeThis,
    handleTranslate,
    handleDetectSignature,
    markAsRead,
    handleNextEmail,
    handlePreviousEmail,
    hasNextEmail,
    hasPreviousEmail,
    currentEmailPosition,
    totalEmailCount,
    handleSnoozeThread,
    handleUnsnoozeThread,
    handleSetLabelThread,
    handleReportSpam,
    handleReportSpamThread,
    handleNotSpam,
    handleRestore,
    isRestoring,
  } = ctx;

  const [showSnoozeDropdown, setShowSnoozeDropdown] = useState(false);
  const isSnoozed = displayEmail && (displayEmail.tags || '').includes('|snoozed|');

  const labels = useEmailStore((s) => s.labels);
  const selectedFolderId = useEmailStore((s) => s.selectedFolderId);
  const moveEmailToFolder = useEmailStore((s) => s.moveEmailToFolder);
  const copyEmailToFolder = useEmailStore((s) => s.copyEmailToFolder);
  // Owning account of the open message (unified "All Inboxes" view) so the label
  // picker + toggle target that account, not the active one.
  const viewAccountId = useEmailStore((s) => s.viewAccountId);
  const appliedLabels = new Set(
    labels.filter((l) => (displayEmail?.tags || '').includes('|' + l.name + '|')).map((l) => l.name),
  );

  // Listen for keyboard shortcut "b" to open snooze dropdown
  useEffect(() => {
    const handleOpenSnooze = () => {
      if (displayEmail) {
        setShowSnoozeDropdown(true);
      }
    };
    document.addEventListener('sarvinbox:open-snooze', handleOpenSnooze);
    return () => document.removeEventListener('sarvinbox:open-snooze', handleOpenSnooze);
  }, [displayEmail]);

  return (
    <div className="h-14 flex items-center gap-1 px-4 border-b border-border bg-card/50">
      <Tooltip content="Back to list" shortcut={getShortcutHints('GO_BACK')}>
        <button
          onClick={handleBack}
          className="p-2 hover:bg-accent rounded-md transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
      </Tooltip>

      <div className="h-6 w-px bg-border mx-1" />

      {/* Trash: show Restore instead of Archive/Delete */}
      {isInTrash ? (
        <Tooltip content="Restore to Inbox">
          <button
            onClick={() => displayEmail && !isRestoring && handleRestore(displayEmail.id)}
            disabled={isRestoring}
            className="p-2 hover:bg-accent rounded-md transition-colors text-green-600 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isRestoring ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCcw className="h-4 w-4" />}
          </button>
        </Tooltip>
      ) : (
        <>
          <Tooltip content="Archive" shortcut={getShortcutHints('ARCHIVE')}>
            <button
              onClick={handleArchive}
              className="p-2 hover:bg-accent rounded-md transition-colors"
            >
              <Archive className="h-4 w-4" />
            </button>
          </Tooltip>

          <Tooltip content="Delete" shortcut={getShortcutHints('DELETE')}>
            <button
              onClick={handleDelete}
              className="p-2 hover:bg-accent rounded-md transition-colors text-destructive"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          </Tooltip>
        </>
      )}

      {/* Spam: show Not Spam in spam folder, Report Spam elsewhere */}
      {isInSpam ? (
        <Tooltip content="Not spam — move to Inbox">
          <button
            onClick={() => handleNotSpam()}
            className="p-2 hover:bg-accent rounded-md transition-colors text-green-600"
          >
            <ShieldCheck className="h-4 w-4" />
          </button>
        </Tooltip>
      ) : !isInTrash ? (
        <Tooltip content="Report spam">
          <button
            onClick={() => displayEmail && handleReportSpamThread()}
            className="p-2 hover:bg-accent rounded-md transition-colors text-orange-500 hover:text-orange-600"
          >
            <AlertOctagon className="h-4 w-4" />
          </button>
        </Tooltip>
      ) : null}

      <Tooltip
        content={isRead ? 'Mark as unread' : 'Mark as read'}
        shortcut={isRead ? getShortcutHints('MARK_UNREAD') : getShortcutHints('MARK_READ')}
      >
        <button
          onClick={handleMarkRead}
          className="p-2 hover:bg-accent rounded-md transition-colors"
        >
          <Mail className="h-4 w-4" />
        </button>
      </Tooltip>

      {/* Snooze */}
      <Tooltip content="Snooze" shortcut={getShortcutHints('SNOOZE')} hidden={showSnoozeDropdown}>
        <div className="relative">
          <button
            onClick={() => setShowSnoozeDropdown(!showSnoozeDropdown)}
            className="p-2 hover:bg-accent rounded-md transition-colors"
          >
            <Clock className={`h-4 w-4 ${isSnoozed ? 'text-blue-500' : ''}`} />
          </button>
          {showSnoozeDropdown && displayEmail && (
            <SnoozeDropdown
              emailId={displayEmail.id}
              isSnoozed={isSnoozed}
              onSnooze={(_id, snoozeUntil) => {
                handleSnoozeThread(snoozeUntil);
                setShowSnoozeDropdown(false);
              }}
              onUnsnooze={() => handleUnsnoozeThread()}
              onClose={() => setShowSnoozeDropdown(false)}
              align="left"
            />
          )}
        </div>
      </Tooltip>

      {/* Label */}
      {displayEmail && (
        <LabelMenu
          applied={appliedLabels}
          onToggle={(name, on) => handleSetLabelThread(name, on)}
          buttonClassName="p-2 hover:bg-accent rounded-md transition-colors"
          accountId={displayEmail.accountId ?? viewAccountId ?? undefined}
        />
      )}

      {/* Move / Copy to an arbitrary folder */}
      {displayEmail && (
        <>
          <FolderPicker
            title="Move to folder"
            placeholder="Move to…"
            icon={<FolderInput className="h-4 w-4" />}
            excludeFolderId={selectedFolderId}
            onPick={(folderId) => moveEmailToFolder(displayEmail.id, folderId)}
            buttonClassName="p-2 hover:bg-accent rounded-md transition-colors"
          />
          <FolderPicker
            title="Copy to folder"
            placeholder="Copy to…"
            icon={<Copy className="h-4 w-4" />}
            onPick={(folderId) => copyEmailToFolder(displayEmail.id, folderId)}
            buttonClassName="p-2 hover:bg-accent rounded-md transition-colors"
          />
        </>
      )}

      {/* Remove AI Category - only show when viewing AI Box category tabs (not dashboard) */}
      {viewingAICategory === 'ai-box' && aiBoxActiveTab && aiBoxActiveTab !== 'dashboard' && (
        <Tooltip content="Remove from AI category">
          <button
            onClick={handleRemoveAICategory}
            className="p-2 hover:bg-accent rounded-md transition-colors text-orange-500 hover:text-orange-600"
          >
            <XCircle className="h-4 w-4" />
          </button>
        </Tooltip>
      )}

      <div className="h-6 w-px bg-border mx-1" />

      <Tooltip content="Reply" shortcut={[...getShortcutHints('REPLY'), ...getShortcutHints('REPLY_ALL_POPUP').map(k => `${k} popup`)]}>
        <button
          onClick={() => handleReply()}
          className="flex items-center gap-2 px-3 py-2 hover:bg-accent rounded-md transition-colors text-sm font-medium"
        >
          <Reply className="h-4 w-4" />
          Reply
        </button>
      </Tooltip>

      <Tooltip content="Reply all" shortcut={[...getShortcutHints('REPLY_ALL'), ...getShortcutHints('REPLY_ALL_POPUP').map(k => `${k} popup`)]}>
        <button
          onClick={() => handleReplyAll()}
          className="p-2 hover:bg-accent rounded-md transition-colors"
        >
          <ReplyAll className="h-4 w-4" />
        </button>
      </Tooltip>

      <Tooltip content="Forward" shortcut={getShortcutHints('FORWARD_INLINE')}>
        <button
          onClick={() => handleInlineForward(displayEmail)}
          className="p-2 hover:bg-accent rounded-md transition-colors"
        >
          <Forward className="h-4 w-4" />
        </button>
      </Tooltip>

      <div className="flex-1" />

      {/* Navigation arrows + position indicator */}
      {totalEmailCount > 0 && (
        <div className="flex items-center gap-1">
          <span className="text-xs text-muted-foreground mr-1">
            {currentEmailPosition} of {totalEmailCount}
          </span>
          <Tooltip content="Newer" shortcut={getShortcutHints('PREVIOUS_EMAIL')}>
            <button
              onClick={handlePreviousEmail}
              disabled={!hasPreviousEmail}
              className="p-2 hover:bg-accent rounded-md transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
            >
              <ChevronUp className="h-4 w-4" />
            </button>
          </Tooltip>
          <Tooltip content="Older" shortcut={getShortcutHints('NEXT_EMAIL')}>
            <button
              onClick={handleNextEmail}
              disabled={!hasNextEmail}
              className="p-2 hover:bg-accent rounded-md transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
            >
              <ChevronDown className="h-4 w-4" />
            </button>
          </Tooltip>
        </div>
      )}

      <div className="h-6 w-px bg-border mx-1" />

      {/* Right side actions */}
      <Tooltip content="Print">
        <button
          onClick={() => displayEmail && handlePrintEmail(displayEmail)}
          className="p-2 hover:bg-accent rounded-md transition-colors"
        >
          <Printer className="h-4 w-4" />
        </button>
      </Tooltip>

      <EmailMenu
        email={displayEmail}
        onReply={() => handleReply(displayEmail)}
        onReplyAll={() => handleReplyAll(displayEmail)}
        onForward={() => handleForward(displayEmail)}
        onDelete={handleDelete}
        onArchive={handleArchive}
        onMarkUnread={async () => { await markAsRead(displayEmail.id, false); useEmailStore.getState().clearSelectedEmail(); }}
        onReportSpam={() => handleReportSpam(displayEmail.id)}
        onPrint={() => handlePrintEmail(displayEmail)}
        onDownload={() => handleDownloadEmail(displayEmail)}
        onShowOriginal={() => handleShowOriginal(displayEmail)}
        onFilterLikeThis={() => handleFilterLikeThis(displayEmail)}
        onTranslate={() => handleTranslate(displayEmail)}
        onDetectSignature={() => handleDetectSignature(displayEmail)}
      />
    </div>
  );
}
