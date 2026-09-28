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

import { useAppearance } from '../../appearance';
import { getShortcutHints } from '../../config/keyboard-shortcuts';
import { useEmailStore } from '../../store/email-store';
import { SnoozeDropdown } from '../email-list/SnoozeDropdown';
import { FolderPicker } from '../FolderPicker';
import { LabelMenu } from '../LabelMenu';

import { buildEmailMenuHandlers } from './email-menu-handlers';
import { EmailMenu } from './EmailMenu';
import { showsToolbarIcon, showsToolbarLabel, toolbarButtonClass } from './toolbar-button-view';
import { ToolbarButton } from './ToolbarButton';
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
    handlePrintEmail,
    handleNextEmail,
    handlePreviousEmail,
    hasNextEmail,
    hasPreviousEmail,
    currentEmailPosition,
    totalEmailCount,
    handleSnoozeThread,
    handleUnsnoozeThread,
    handleSetLabelThread,
    handleReportSpamThread,
    handleNotSpam,
    handleRestore,
    isRestoring,
  } = ctx;

  // Appearance > Layout: whether these actions are drawn as icons, text, or both.
  const { buttonLabels } = useAppearance();
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
    // Wraps rather than scrolls: with labels on, fifteen actions are wider than
    // the window, and an overflow container would clip the snooze popover that
    // opens inside it (it is absolutely positioned, not portalled). In icon
    // mode the row still fits on one line and looks exactly as it always did.
    <div className="min-h-14 flex flex-wrap items-center gap-1 px-4 py-1 border-b border-border bg-card/50">
      <ToolbarButton
        name="Back"
        tooltip="Back to list"
        icon={<ArrowLeft className="h-4 w-4" />}
        onClick={handleBack}
        shortcut={getShortcutHints('GO_BACK')}
      />

      <div className="h-6 w-px bg-border mx-1 shrink-0" />

      {/* Trash: show Restore instead of Archive/Delete */}
      {isInTrash ? (
        <ToolbarButton
          name="Restore"
          tooltip="Restore to Inbox"
          icon={isRestoring ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCcw className="h-4 w-4" />}
          onClick={() => displayEmail && !isRestoring && handleRestore(displayEmail.id)}
          disabled={isRestoring}
          className="text-green-600 disabled:opacity-50 disabled:cursor-not-allowed"
        />
      ) : (
        <>
          <ToolbarButton
            name="Archive"
            icon={<Archive className="h-4 w-4" />}
            onClick={handleArchive}
            shortcut={getShortcutHints('ARCHIVE')}
          />

          <ToolbarButton
            name="Delete"
            icon={<Trash2 className="h-4 w-4" />}
            onClick={handleDelete}
            shortcut={getShortcutHints('DELETE')}
            className="text-destructive"
          />
        </>
      )}

      {/* Spam: show Not Spam in spam folder, Report Spam elsewhere */}
      {isInSpam ? (
        <ToolbarButton
          name="Not spam"
          tooltip="Not spam — move to Inbox"
          icon={<ShieldCheck className="h-4 w-4" />}
          onClick={() => handleNotSpam()}
          className="text-green-600"
        />
      ) : !isInTrash ? (
        <ToolbarButton
          name="Report spam"
          icon={<AlertOctagon className="h-4 w-4" />}
          onClick={() => displayEmail && handleReportSpamThread()}
          className="text-orange-500 hover:text-orange-600"
        />
      ) : null}

      <ToolbarButton
        name={isRead ? 'Mark as unread' : 'Mark as read'}
        icon={<Mail className="h-4 w-4" />}
        onClick={handleMarkRead}
        shortcut={isRead ? getShortcutHints('MARK_UNREAD') : getShortcutHints('MARK_READ')}
      />

      {/* Snooze */}
      <ToolbarButton
        name="Snooze"
        icon={<Clock className={`h-4 w-4 ${isSnoozed ? 'text-blue-500' : ''}`} />}
        onClick={() => setShowSnoozeDropdown(!showSnoozeDropdown)}
        shortcut={getShortcutHints('SNOOZE')}
        tooltipHidden={showSnoozeDropdown}
        dropdown={
          showSnoozeDropdown && displayEmail ? (
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
          ) : null
        }
      />

      {/* Label. LabelMenu and FolderPicker draw their own trigger (each owns a
          popover), so they take the same classes and label the same way rather
          than being wrapped in a ToolbarButton. */}
      {displayEmail && (
        <LabelMenu
          applied={appliedLabels}
          onToggle={(name, on) => handleSetLabelThread(name, on)}
          buttonClassName={toolbarButtonClass(buttonLabels)}
          label={showsToolbarLabel(buttonLabels) ? 'Label' : undefined}
          showIcon={showsToolbarIcon(buttonLabels)}
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
            label={showsToolbarLabel(buttonLabels) ? 'Move' : undefined}
            showIcon={showsToolbarIcon(buttonLabels)}
            excludeFolderId={selectedFolderId}
            onPick={(folderId) => moveEmailToFolder(displayEmail.id, folderId)}
            buttonClassName={toolbarButtonClass(buttonLabels)}
          />
          <FolderPicker
            title="Copy to folder"
            placeholder="Copy to…"
            icon={<Copy className="h-4 w-4" />}
            label={showsToolbarLabel(buttonLabels) ? 'Copy' : undefined}
            showIcon={showsToolbarIcon(buttonLabels)}
            onPick={(folderId) => copyEmailToFolder(displayEmail.id, folderId)}
            buttonClassName={toolbarButtonClass(buttonLabels)}
          />
        </>
      )}

      {/* Remove AI Category - only show when viewing AI Box category tabs (not dashboard) */}
      {viewingAICategory === 'ai-box' && aiBoxActiveTab && aiBoxActiveTab !== 'dashboard' && (
        <ToolbarButton
          name="Remove from AI category"
          icon={<XCircle className="h-4 w-4" />}
          onClick={handleRemoveAICategory}
          className="text-orange-500 hover:text-orange-600"
        />
      )}

      <div className="h-6 w-px bg-border mx-1 shrink-0" />

      <ToolbarButton
        name="Reply"
        icon={<Reply className="h-4 w-4" />}
        onClick={() => handleReply()}
        // Its own key only. It used to list reply ALL's popup keys (Shift+R /
        // Shift+A) as its own "popup" variant; Reply has none.
        shortcut={getShortcutHints('REPLY')}
        alwaysLabel
      />

      <ToolbarButton
        name="Reply all"
        icon={<ReplyAll className="h-4 w-4" />}
        onClick={() => handleReplyAll()}
        shortcut={[...getShortcutHints('REPLY_ALL'), ...getShortcutHints('REPLY_ALL_POPUP').map(k => `${k} popup`)]}
      />

      <ToolbarButton
        name="Forward"
        icon={<Forward className="h-4 w-4" />}
        onClick={() => handleInlineForward(displayEmail)}
        shortcut={getShortcutHints('FORWARD_INLINE')}
      />

      <div className="flex-1" />

      {/* Navigation arrows + position indicator */}
      {totalEmailCount > 0 && (
        <div className="flex items-center gap-1">
          <span className="text-xs text-muted-foreground mr-1">
            {currentEmailPosition} of {totalEmailCount}
          </span>
          <ToolbarButton
            name="Newer"
            icon={<ChevronUp className="h-4 w-4" />}
            onClick={handlePreviousEmail}
            disabled={!hasPreviousEmail}
            shortcut={getShortcutHints('PREVIOUS_EMAIL')}
            className="disabled:opacity-30 disabled:cursor-not-allowed"
          />
          <ToolbarButton
            name="Older"
            icon={<ChevronDown className="h-4 w-4" />}
            onClick={handleNextEmail}
            disabled={!hasNextEmail}
            shortcut={getShortcutHints('NEXT_EMAIL')}
            className="disabled:opacity-30 disabled:cursor-not-allowed"
          />
        </div>
      )}

      <div className="h-6 w-px bg-border mx-1 shrink-0" />

      {/* Right side actions */}
      <ToolbarButton
        name="Print"
        icon={<Printer className="h-4 w-4" />}
        onClick={() => displayEmail && handlePrintEmail(displayEmail)}
      />

      {/* The ⋮ overflow menu stays icon-only in every mode: it has no single
          action to name, and "More" beside fifteen named actions reads as one
          more of them. */}
      <EmailMenu
        email={displayEmail}
        // The toolbar acts on the conversation, like its own Delete and
        // Archive buttons: Forward in the popup, removal thread-wide.
        {...buildEmailMenuHandlers(ctx, displayEmail, { forward: 'popup', removes: 'thread' })}
      />
    </div>
  );
}
