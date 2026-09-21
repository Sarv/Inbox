import {
  Loader2,
  ChevronDown,
  ChevronUp,
  Reply,
  ReplyAll,
  Forward,
  Paperclip,
  Star,
  FileSignature,
} from 'lucide-react';

import { isSignatureDetectionEnabled } from '../../services/ai-service';
import { useEmailStore } from '../../store/email-store';
import { qualifiesForSafeAutoLoad } from '../../store/helpers';
import { AttachmentChips } from '../attachment-viewer/AttachmentChips';
import { SandboxedEmailBody } from '../SandboxedEmailBody';

import { CalendarInviteBanner } from './CalendarInviteBanner';
import { DuplicateCopiesBadge } from './DuplicateCopiesBadge';
import { EmailHeaderDetails } from './EmailHeaderDetails';
import { EmailMenu } from './EmailMenu';
import { PhishingWarningBanner } from './PhishingWarningBanner';
import { SecurityIndicator } from './SecurityIndicator';
import { SenderAvatar } from './SenderAvatar';
import type { EmailDetailContext } from './types';
import { stripSignatureFromHtml, formatRelativeDate, hasLoadedBody } from './utils';
import { VerifiedBadge } from './VerifiedBadge';



interface EmailCardProps {
  ctx: EmailDetailContext;
}

export function EmailCard({ ctx }: EmailCardProps) {
  const {
    displayEmail,
    duplicatesByEmailId,
    isStarred,
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

  return (
    <div className={`border border-border rounded-lg bg-card overflow-hidden ${chatViewActive ? 'hidden' : ''}`}>
      {/* Header Section - Clickable to expand/collapse */}
      <div className="w-full p-4 text-left hover:bg-accent/30 transition-colors">
        <div className="flex items-start gap-4">
          {/* Avatar: BIMI logo (DMARC-passing mail only) → confirmed contact photo → domain favicon → initials */}
          <div onClick={() => setMainEmailExpanded(!mainEmailExpanded)} className="flex-shrink-0 cursor-pointer">
            <SenderAvatar
              email={displayEmail.fromAddress}
              name={displayEmail.fromName}
              size={48}
              authStatus={displayEmail.authStatus}
              className="text-lg font-semibold"
            />
          </div>

          {/* Sender Info */}
          <div className="flex-1 min-w-0">
            <div className="flex items-start justify-between gap-4 mb-1">
              <div
                className="flex-1 min-w-0 cursor-pointer"
                onClick={() => setMainEmailExpanded(!mainEmailExpanded)}
              >
                <div className="font-semibold text-base text-foreground flex items-center gap-1.5">
                  <span className="truncate">{displayEmail.fromName || displayEmail.fromAddress}</span>
                  <VerifiedBadge email={displayEmail.fromAddress} authStatus={displayEmail.authStatus} />
                  <SecurityIndicator
                    fromName={displayEmail.fromName}
                    fromAddress={displayEmail.fromAddress}
                    authStatus={displayEmail.authStatus}
                    spamScore={displayEmail.spamScore}
                    spamReasons={displayEmail.spamReasons}
                    html={displayEmail.rawBody}
                    bodyLoaded={hasLoadedBody(displayEmail)}
                  />
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
              authStatus={displayEmail.authStatus}
              spamScore={displayEmail.spamScore}
              spamReasons={displayEmail.spamReasons}
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
              const hasBody = hasLoadedBody(displayEmail);

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
              <AttachmentChips
                emailId={displayEmail.id}
                accountId={(displayEmail as any).accountId}
                attachments={attachments}
              />
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
