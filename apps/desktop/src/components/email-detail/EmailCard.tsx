import {
  Loader2,
  ChevronDown,
  ChevronUp,
  Reply,
  ReplyAll,
  Forward,
  Download,
  Paperclip,
  Star,
  FileSignature,
} from 'lucide-react';
import { useState } from 'react';

import { isSignatureDetectionEnabled } from '../../services/ai-service';
import { useEmailStore } from '../../store/email-store';
import { qualifiesForSafeAutoLoad } from '../../store/helpers';
import { SandboxedEmailBody } from '../SandboxedEmailBody';

import { CalendarInviteBanner } from './CalendarInviteBanner';
import { DuplicateCopiesBadge } from './DuplicateCopiesBadge';
import { EmailHeaderDetails } from './EmailHeaderDetails';
import { EmailMenu } from './EmailMenu';
import { PhishingWarningBanner } from './PhishingWarningBanner';
import type { EmailDetailContext } from './types';
import { getFileIcon, getFileType, isPreviewableAttachment, stripSignatureFromHtml, formatRelativeDate } from './utils';



interface EmailCardProps {
  ctx: EmailDetailContext;
}

export function EmailCard({ ctx }: EmailCardProps) {
  const {
    displayEmail,
    duplicatesByEmailId,
    isStarred,
    senderInitials,
    avatarColor,
    attachments,
    mainEmailExpanded,
    setMainEmailExpanded,
    showFullHeaders,
    setShowFullHeaders,
    showSignatures,
    showInlineReply,
    replyingToEmail,
    chatViewActive,
    loadingBodies,
    failedBodies,
    handleReply,
    handleReplyAll,
    handleForward,
    handleDelete,
    handleArchive,
    handleReportSpam,
    handlePrintEmail,
    handleDownloadEmail,
    handleShowOriginal,
    handleFilterLikeThis,
    handleTranslate,
    handleDetectSignature,
    toggleSignature,
    markAsRead,
    markAsStarred,
  } = ctx;

  const { fetchEmailBody } = useEmailStore();

  const [downloadingAttachments, setDownloadingAttachments] = useState<Set<string>>(new Set());

  const handleSaveAttachment = async (filename: string) => {
    setDownloadingAttachments(prev => new Set(prev).add(filename));
    try {
      const result = await window.electronAPI.emails.downloadAttachment(displayEmail.id, filename);
      if (!result.success && result.error !== 'Save cancelled') {
        console.error('[Attachment] Download failed:', result.error);
      }
    } catch (error) {
      console.error('[Attachment] Download error:', error);
    } finally {
      setDownloadingAttachments(prev => {
        const next = new Set(prev);
        next.delete(filename);
        return next;
      });
    }
  };

  const handlePreviewAttachment = async (filename: string) => {
    setDownloadingAttachments(prev => new Set(prev).add(filename));
    try {
      const result = await window.electronAPI.emails.previewAttachment(displayEmail.id, filename);
      if (!result.success) {
        console.error('[Attachment] Preview failed:', result.error);
      }
    } catch (error) {
      console.error('[Attachment] Preview error:', error);
    } finally {
      setDownloadingAttachments(prev => {
        const next = new Set(prev);
        next.delete(filename);
        return next;
      });
    }
  };

  const handleAttachmentClick = (filename: string) => {
    if (isPreviewableAttachment(filename)) {
      handlePreviewAttachment(filename);
    } else {
      handleSaveAttachment(filename);
    }
  };

  const handleDownloadAllAttachments = async () => {
    for (const attachment of attachments) {
      await handleSaveAttachment(attachment.name);
    }
  };

  return (
    <div className={`border border-border rounded-lg bg-card overflow-hidden ${chatViewActive ? 'hidden' : ''}`}>
      {/* Header Section - Clickable to expand/collapse */}
      <div className="w-full p-4 text-left hover:bg-accent/30 transition-colors">
        <div className="flex items-start gap-4">
          {/* Avatar */}
          <div
            onClick={() => setMainEmailExpanded(!mainEmailExpanded)}
            className={`w-12 h-12 rounded-full ${avatarColor} flex items-center justify-center text-white font-semibold text-lg flex-shrink-0 cursor-pointer`}
          >
            {senderInitials}
          </div>

          {/* Sender Info */}
          <div className="flex-1 min-w-0">
            <div className="flex items-start justify-between gap-4 mb-1">
              <div
                className="flex-1 min-w-0 cursor-pointer"
                onClick={() => setMainEmailExpanded(!mainEmailExpanded)}
              >
                <div className="font-semibold text-base text-foreground">
                  {displayEmail.fromName || displayEmail.fromAddress}
                </div>
                {displayEmail.fromName && (
                  <div className="text-sm text-muted-foreground">
                    &lt;{displayEmail.fromAddress}&gt;
                  </div>
                )}
              </div>
              <div className="flex items-center gap-2 flex-shrink-0">
                <button
                  onClick={(e) => { e.stopPropagation(); markAsStarred(displayEmail.id, !isStarred); }}
                  className="p-1 hover:bg-accent rounded transition-colors cursor-pointer"
                  title={isStarred ? 'Remove star' : 'Add star'}
                >
                  {isStarred ? (
                    <Star className="h-4 w-4 fill-yellow-500 text-yellow-500" />
                  ) : (
                    <Star className="h-4 w-4 text-muted-foreground hover:text-yellow-500" />
                  )}
                </button>
                <DuplicateCopiesBadge duplicates={duplicatesByEmailId.get(displayEmail.id) || []} />
                {displayEmail.hasAttachments && (
                  <Paperclip className="h-4 w-4 text-muted-foreground" />
                )}
                <span
                  className="text-sm text-muted-foreground cursor-pointer"
                  onClick={() => setMainEmailExpanded(!mainEmailExpanded)}
                >
                  {formatRelativeDate(displayEmail.date)}
                </span>
                <span
                  className="cursor-pointer"
                  onClick={() => setMainEmailExpanded(!mainEmailExpanded)}
                >
                  {mainEmailExpanded ? (
                    <ChevronUp className="h-5 w-5 text-muted-foreground" />
                  ) : (
                    <ChevronDown className="h-5 w-5 text-muted-foreground" />
                  )}
                </span>
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
            </div>

            {/* Preview when collapsed */}
            {!mainEmailExpanded && (
              <div
                className="text-sm text-muted-foreground truncate mt-1 cursor-pointer"
                onClick={() => setMainEmailExpanded(!mainEmailExpanded)}
              >
                {displayEmail.cleanBody?.substring(0, 150) || '(no content)'}
              </div>
            )}

            {/* Recipient summary + expandable full headers when expanded */}
            {mainEmailExpanded && (
              <EmailHeaderDetails
                email={displayEmail}
                showDetails={showFullHeaders}
                onToggleDetails={() => setShowFullHeaders(!showFullHeaders)}
              />
            )}
          </div>
        </div>
      </div>

      {/* Expanded Content - Body, Attachments, Footer */}
      {mainEmailExpanded && (
        <>
          {/* Email Body */}
          <div className="px-4 pb-4 border-t border-border pt-4">
            {/* Phishing warning (sender impersonation / deceptive links) — shown
                above everything so the user sees it before reading the body. */}
            <PhishingWarningBanner
              fromName={displayEmail.fromName}
              fromAddress={displayEmail.fromAddress}
              html={displayEmail.rawBody}
            />
            {/* Calendar invite card (Gmail-style) — rendered above the body when
                the message carries a .ics / text/calendar part. */}
            <CalendarInviteBanner
              emailId={displayEmail.id}
              accountId={(displayEmail as any).accountId}
              calendarIcs={displayEmail.calendarIcs}
              calendarAdded={displayEmail.calendarAdded}
            />
            {(() => {
              const isBodyLoading = loadingBodies.has(displayEmail.id);
              const hasBody = displayEmail.rawBody || displayEmail.cleanBody;

              if (isBodyLoading) {
                return (
                  <div className="flex items-center justify-center py-8">
                    <Loader2 className="h-6 w-6 animate-spin text-muted-foreground mr-2" />
                    <span className="text-muted-foreground">Loading email content...</span>
                  </div>
                );
              }

              if (!hasBody) {
                const hasFailed = failedBodies.has(displayEmail.id);
                return (
                  <div className="text-center py-8 text-muted-foreground">
                    {hasFailed ? (
                      <>
                        <p className="text-amber-600 dark:text-amber-400">
                          Unable to load email content
                        </p>
                        <p className="text-sm mt-1">
                          The email body could not be fetched. It may be a temporary issue.
                        </p>
                      </>
                    ) : (
                      <p>No content available</p>
                    )}
                    <button
                      onClick={() => {
                        const current = useEmailStore.getState().failedBodies;
                        if (current.has(displayEmail.id)) {
                          const updated = new Set(current);
                          updated.delete(displayEmail.id);
                          useEmailStore.setState({ failedBodies: updated });
                        }
                        fetchEmailBody(displayEmail.id);
                      }}
                      className="mt-2 px-3 py-1 text-sm bg-primary/10 hover:bg-primary/20 text-primary rounded transition-colors"
                    >
                      Retry loading
                    </button>
                  </div>
                );
              }

              const isHtml = displayEmail.contentType === 'html';
              const fullBody = displayEmail.rawBody || displayEmail.cleanBody || 'No content';
              const showingSig = showSignatures.has(displayEmail.id);

              const signatureEnabled = isSignatureDetectionEnabled();
              const { newContent, hasSignature } = (signatureEnabled && isHtml)
                ? stripSignatureFromHtml(fullBody)
                : { newContent: fullBody, hasSignature: false };

              const bodyToShow = (hasSignature && !showingSig) ? newContent : fullBody;

              return (
                <>
                  <div className="max-w-none">
                    {isHtml ? (
                      <SandboxedEmailBody key={`${bodyToShow.length}:${bodyToShow.slice(0, 32)}`} html={bodyToShow} safeAutoLoad={qualifiesForSafeAutoLoad(displayEmail.tags)} senderAddress={displayEmail.fromAddress} />
                    ) : (
                      <div className="whitespace-pre-wrap font-sans text-foreground leading-relaxed">
                        {bodyToShow}
                      </div>
                    )}
                  </div>
                  {hasSignature && (
                    <button
                      onClick={() => toggleSignature(displayEmail.id)}
                      className="flex items-center gap-1 mt-3 px-2 py-1 text-xs text-muted-foreground hover:text-foreground hover:bg-accent rounded transition-colors"
                    >
                      <FileSignature className="h-3 w-3" />
                      {showingSig ? 'Hide signature' : 'Show signature'}
                    </button>
                  )}
                </>
              );
            })()}
          </div>

          {/* Attachments Section - below body */}
          {displayEmail.hasAttachments && attachments.length > 0 && (
            <div className="px-4 pb-4 border-t border-border pt-4">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Paperclip className="h-4 w-4" />
                  <span>{attachments.length} attachment{attachments.length > 1 ? 's' : ''}</span>
                </div>
                <button
                  onClick={handleDownloadAllAttachments}
                  className="flex items-center gap-1.5 px-2 py-1 text-xs text-muted-foreground hover:text-foreground hover:bg-accent rounded transition-colors"
                  title="Download all"
                >
                  <Download className="h-3.5 w-3.5" />
                  <span>Download all</span>
                </button>
              </div>
              <div className="flex flex-wrap gap-3">
                {attachments.map((attachment: { name: string; size: string }, index: number) => {
                  const isDownloading = downloadingAttachments.has(attachment.name);
                  const previewable = isPreviewableAttachment(attachment.name);
                  return (
                    <div
                      key={index}
                      onClick={() => !isDownloading && handleAttachmentClick(attachment.name)}
                      className="relative flex flex-col items-center p-3 border border-border rounded-lg bg-background hover:bg-accent/50 hover:border-primary/30 transition-all cursor-pointer group min-w-[120px] max-w-[150px]"
                    >
                      {/* Save-as icon for previewable files */}
                      {previewable && !isDownloading && (
                        <button
                          onClick={(e) => { e.stopPropagation(); handleSaveAttachment(attachment.name); }}
                          className="absolute top-1 right-1 p-1 rounded bg-background/80 opacity-0 group-hover:opacity-100 transition-opacity hover:bg-accent"
                          title="Save as..."
                        >
                          <Download className="h-3 w-3 text-muted-foreground" />
                        </button>
                      )}
                      <div className="mb-2 p-2 rounded-lg bg-muted/50 group-hover:bg-background transition-colors">
                        {isDownloading ? (
                          <Loader2 className="h-6 w-6 animate-spin text-primary" />
                        ) : (
                          getFileIcon(attachment.name)
                        )}
                      </div>
                      <div className="w-full text-center">
                        <div className="text-xs font-medium truncate" title={attachment.name}>
                          {attachment.name}
                        </div>
                        <div className="text-[10px] text-muted-foreground mt-0.5">
                          {isDownloading ? 'Opening...' : previewable ? 'Click to preview' : getFileType(attachment.name)}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Quick Actions Footer - hide when inline reply is active for this email */}
          {!(showInlineReply && replyingToEmail?.id === displayEmail.id) && (
            <div className="px-4 py-3 border-t border-border bg-accent/10 flex items-center gap-2">
              <button
                onClick={() => handleReply(displayEmail)}
                className="flex items-center gap-2 px-3 py-1.5 hover:bg-accent rounded-md transition-colors text-sm font-medium"
              >
                <Reply className="h-4 w-4" />
                Reply
              </button>
              <button
                onClick={() => handleReplyAll(displayEmail)}
                className="flex items-center gap-2 px-3 py-1.5 hover:bg-accent rounded-md transition-colors text-sm font-medium"
              >
                <ReplyAll className="h-4 w-4" />
                Reply All
              </button>
              <button
                onClick={() => handleForward(displayEmail)}
                className="flex items-center gap-2 px-3 py-1.5 hover:bg-accent rounded-md transition-colors text-sm font-medium"
              >
                <Forward className="h-4 w-4" />
                Forward
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
