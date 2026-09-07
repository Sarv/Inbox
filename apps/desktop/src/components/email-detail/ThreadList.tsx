import {
  Loader2,
  ChevronDown,
  ChevronUp,
  Reply,
  ReplyAll,
  Forward,
  Download,
  Paperclip,
  MoreHorizontal,
  FileSignature,
  Star,
} from 'lucide-react';
import prettyBytes from 'pretty-bytes';
import { useMemo, useState } from 'react';

import { isSignatureDetectionEnabled, buildPolishThreadContext, getCurrentUserEmail } from '../../services/ai-service';
import { useEmailStore } from '../../store/email-store';
import { qualifiesForSafeAutoLoad } from '../../store/helpers';
import { InlineForward } from '../InlineForward';
import { InlineReply } from '../InlineReply';
import { SandboxedEmailBody } from '../SandboxedEmailBody';

import { DuplicateCopiesBadge } from './DuplicateCopiesBadge';
import { EmailHeaderDetails } from './EmailHeaderDetails';
import { EmailMenu } from './EmailMenu';
import type { EmailDetailContext } from './types';
import { getInitials, getAvatarColor, getFileIcon, getFileType, isPreviewableAttachment, formatRelativeDate, stripQuotedContent, stripSignatureFromHtml, parseAttachments } from './utils';


interface ThreadListProps {
  ctx: EmailDetailContext;
}

export function ThreadList({ ctx }: ThreadListProps) {
  const {
    displayEmail,
    threadEmails,
    duplicatesByEmailId,
    conversationMessages,
    expandedThreads,
    showFullContent,
    showSignatures,
    showInlineReply,
    inlineReplyMode,
    replyingToEmail,
    inlineReplyDraft,
    loadingBodies,
    handleReply,
    handleReplyAll,
    handleForward,
    handleReportSpam,
    handlePrintEmail,
    handleDownloadEmail,
    handleShowOriginal,
    handleFilterLikeThis,
    handleTranslate,
    handleDetectSignature,
    handleCloseInlineReply,
    showInlineForward,
    forwardingEmail,
    handleInlineForward,
    handleCloseInlineForward,
    toggleThread,
    toggleFullContent,
    toggleSignature,
    deleteEmail,
    archiveEmail,
    markAsRead,
    markAsStarred,
    fetchEmailBody,
    setInlineReplyMode,
  } = ctx;

  const [downloadingAttachments, setDownloadingAttachments] = useState<Set<string>>(new Set());

  // Thread transcript for the reply polish feature — same wiring as
  // ThreadChatView/EmailDetail so list-view replies get context too.
  const currentUserEmail = useMemo(
    () => getCurrentUserEmail(displayEmail?.toAddress || ''),
    [displayEmail?.toAddress]
  );
  const polishThreadContext = useMemo(
    () => buildPolishThreadContext({ conversationMessages, threadEmails, currentUserEmail }),
    [conversationMessages, threadEmails, currentUserEmail]
  );

  const handleSaveAttachment = async (emailId: string, filename: string) => {
    const key = `${emailId}:${filename}`;
    setDownloadingAttachments(prev => new Set(prev).add(key));
    try {
      const result = await window.electronAPI.emails.downloadAttachment(emailId, filename);
      if (!result.success && result.error !== 'Save cancelled') {
        console.error('[Attachment] Download failed:', result.error);
      }
    } catch (error) {
      console.error('[Attachment] Download error:', error);
    } finally {
      setDownloadingAttachments(prev => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  };

  const handlePreviewAttachment = async (emailId: string, filename: string) => {
    const key = `${emailId}:${filename}`;
    setDownloadingAttachments(prev => new Set(prev).add(key));
    try {
      const result = await window.electronAPI.emails.previewAttachment(emailId, filename);
      if (!result.success) {
        console.error('[Attachment] Preview failed:', result.error);
      }
    } catch (error) {
      console.error('[Attachment] Preview error:', error);
    } finally {
      setDownloadingAttachments(prev => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  };

  const handleAttachmentClick = (emailId: string, filename: string) => {
    if (isPreviewableAttachment(filename)) {
      handlePreviewAttachment(emailId, filename);
    } else {
      handleSaveAttachment(emailId, filename);
    }
  };

  const handleDownloadAllAttachments = async (emailId: string, attachmentList: { name: string }[]) => {
    for (const att of attachmentList) {
      await handleSaveAttachment(emailId, att.name);
    }
  };

  // Per-reply "Show details" toggle (full From/To/Cc/Date/Subject header).
  const [detailsOpen, setDetailsOpen] = useState<Set<string>>(new Set());
  const toggleDetails = (id: string) => {
    setDetailsOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="space-y-2">
      {threadEmails
        .filter((e) => e.id !== displayEmail.id)
        // Unsent drafts share the thread id but aren't messages — don't
        // render them as sent cards in the conversation (List view).
        .filter((e) => !(e.tags || '').includes('|draft|'))
        .sort((a, b) => a.date - b.date)
        .map((email) => {
          const isExpanded = expandedThreads.has(email.id);
          const threadInitials = getInitials(email.fromName, email.fromAddress);
          const threadAvatarColor = getAvatarColor(email.fromAddress);
          const threadAttachments = parseAttachments(email.attachmentNames, email.attachmentSizes)
            .map((a) => ({ name: a.name, size: a.size != null ? prettyBytes(a.size) : 'Unknown' }));

          return (
            <div
              key={email.id}
              id={`thread-${email.id}`}
              className="border border-border rounded-lg bg-card transition-all"
            >
              {/* Thread Header - Always Visible */}
              <div className="w-full p-4 flex items-start gap-4 hover:bg-accent/50 transition-colors">
                <div
                  onClick={() => toggleThread(email.id)}
                  className={`w-10 h-10 rounded-full ${threadAvatarColor} flex items-center justify-center text-white font-semibold flex-shrink-0 cursor-pointer`}
                >
                  {threadInitials}
                </div>
                <div
                  className="flex-1 min-w-0 cursor-pointer"
                  onClick={() => toggleThread(email.id)}
                >
                  <div className="flex items-start justify-between gap-2 mb-1">
                    <div className="min-w-0">
                      <div className="font-semibold text-sm text-foreground truncate">
                        {email.fromName || email.fromAddress}
                      </div>
                      {email.fromName && (
                        <div className="text-sm text-muted-foreground truncate">
                          &lt;{email.fromAddress}&gt;
                        </div>
                      )}
                    </div>
                    <div className="text-xs text-muted-foreground flex-shrink-0 flex items-center gap-2">
                      <DuplicateCopiesBadge duplicates={duplicatesByEmailId.get(email.id) || []} />
                      {email.hasAttachments && (
                        <Paperclip className="h-3.5 w-3.5" />
                      )}
                      {formatRelativeDate(email.date)}
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          const starred = (email.tags || '').includes('|starred|');
                          markAsStarred(email.id, !starred);
                        }}
                        className="p-1 hover:bg-accent rounded transition-colors"
                        title={(email.tags || '').includes('|starred|') ? 'Remove star' : 'Add star'}
                      >
                        <Star className={`h-4 w-4 ${(email.tags || '').includes('|starred|') ? 'fill-yellow-500 text-yellow-500' : 'text-muted-foreground hover:text-yellow-500'}`} />
                      </button>
                    </div>
                  </div>
                  {!isExpanded && (
                    <div className="text-sm text-muted-foreground truncate">
                      {email.cleanBody?.substring(0, 100) || '(no content)'}
                    </div>
                  )}
                  {isExpanded && (
                    <EmailHeaderDetails
                      email={email}
                      showDetails={detailsOpen.has(email.id)}
                      onToggleDetails={() => toggleDetails(email.id)}
                    />
                  )}
                </div>
                <div
                  className="flex items-center gap-1 flex-shrink-0 cursor-pointer"
                  onClick={() => toggleThread(email.id)}
                >
                  {isExpanded ? (
                    <ChevronUp className="h-5 w-5 text-muted-foreground" />
                  ) : (
                    <ChevronDown className="h-5 w-5 text-muted-foreground" />
                  )}
                </div>
                <EmailMenu
                  email={email}
                  onReply={() => { handleReply(email); }}
                  onReplyAll={() => { handleReplyAll(email); }}
                  onForward={() => { handleForward(email); }}
                  onDelete={() => deleteEmail(email.id)}
                  onArchive={() => archiveEmail(email.id)}
                  onMarkUnread={async () => { await markAsRead(email.id, false); useEmailStore.getState().clearSelectedEmail(); }}
                  onReportSpam={() => handleReportSpam(email.id)}
                  onPrint={() => handlePrintEmail(email)}
                  onDownload={() => handleDownloadEmail(email)}
                  onShowOriginal={() => handleShowOriginal(email)}
                  onFilterLikeThis={() => handleFilterLikeThis(email)}
                  onTranslate={() => handleTranslate(email)}
                  onDetectSignature={() => handleDetectSignature(email)}
                />
              </div>

              {/* Expanded Thread Content */}
              {isExpanded && (() => {
                const isBodyLoading = loadingBodies.has(email.id);
                const hasBody = email.rawBody || email.cleanBody;

                if (isBodyLoading) {
                  return (
                    <div className="border-t border-border p-4 bg-background/50">
                      <div className="flex items-center justify-center py-4">
                        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground mr-2" />
                        <span className="text-sm text-muted-foreground">Loading content...</span>
                      </div>
                    </div>
                  );
                }

                if (!hasBody) {
                  return (
                    <div className="border-t border-border p-4 bg-background/50">
                      <div className="text-center py-4 text-muted-foreground text-sm">
                        <p>No content available</p>
                        <button
                          onClick={(e) => { e.stopPropagation(); fetchEmailBody(email.id); }}
                          className="mt-2 px-2 py-1 text-xs bg-primary/10 hover:bg-primary/20 text-primary rounded transition-colors"
                        >
                          Retry loading
                        </button>
                      </div>
                    </div>
                  );
                }

                const isHtml = email.contentType === 'html';
                const fullBody = isHtml ? (email.rawBody || email.cleanBody) : (email.cleanBody || email.rawBody);
                const { newContent: contentWithoutQuotes, hasQuoted } = stripQuotedContent(fullBody, isHtml);
                const showFull = showFullContent.has(email.id);
                const showingSig = showSignatures.has(email.id);

                const signatureEnabled = isSignatureDetectionEnabled();
                const baseContent = showFull ? fullBody : contentWithoutQuotes;
                const { newContent: contentWithoutSig, hasSignature } = (signatureEnabled && isHtml)
                  ? stripSignatureFromHtml(baseContent || '')
                  : { newContent: baseContent || '', hasSignature: false };

                const displayContent = (hasSignature && !showingSig) ? contentWithoutSig : baseContent;

                return (
                  <div className="border-t border-border p-4 bg-background/50">
                    <div className="max-w-none">
                      {isHtml ? (
                        <SandboxedEmailBody key={`${(displayContent || '').length}:${(displayContent || '').slice(0, 32)}`} html={displayContent || '(no content)'} safeAutoLoad={qualifiesForSafeAutoLoad(email.tags)} senderAddress={email.fromAddress} />
                      ) : (
                        <div className="whitespace-pre-wrap font-sans text-foreground leading-relaxed">
                          {displayContent || '(no content)'}
                        </div>
                      )}
                    </div>
                    {/* Toggle buttons for quoted content and signature */}
                    <div className="flex items-center gap-2 flex-wrap">
                      {hasQuoted && (
                        <button
                          onClick={(e) => { e.stopPropagation(); toggleFullContent(email.id); }}
                          className="flex items-center gap-1 mt-2 px-2 py-1 text-xs text-muted-foreground hover:text-foreground hover:bg-accent rounded transition-colors"
                        >
                          <MoreHorizontal className="h-3 w-3" />
                          {showFull ? 'Hide quoted content' : 'Show quoted content'}
                        </button>
                      )}
                      {hasSignature && (
                        <button
                          onClick={(e) => { e.stopPropagation(); toggleSignature(email.id); }}
                          className="flex items-center gap-1 mt-2 px-2 py-1 text-xs text-muted-foreground hover:text-foreground hover:bg-accent rounded transition-colors"
                        >
                          <FileSignature className="h-3 w-3" />
                          {showingSig ? 'Hide signature' : 'Show signature'}
                        </button>
                      )}
                    </div>
                    {/* Attachments */}
                    {email.hasAttachments && threadAttachments.length > 0 && (
                      <div className="mt-4 pt-3 border-t border-border">
                        <div className="flex items-center justify-between mb-2">
                          <div className="flex items-center gap-2 text-xs text-muted-foreground">
                            <Paperclip className="h-3.5 w-3.5" />
                            <span>{threadAttachments.length} attachment{threadAttachments.length > 1 ? 's' : ''}</span>
                          </div>
                          <button
                            onClick={(e) => { e.stopPropagation(); handleDownloadAllAttachments(email.id, threadAttachments); }}
                            className="flex items-center gap-1 px-1.5 py-0.5 text-xs text-muted-foreground hover:text-foreground hover:bg-accent rounded transition-colors"
                            title="Download all"
                          >
                            <Download className="h-3 w-3" />
                            <span>Download all</span>
                          </button>
                        </div>
                        <div className="flex flex-wrap gap-2">
                          {threadAttachments.map((att: { name: string }, i: number) => {
                            const dlKey = `${email.id}:${att.name}`;
                            const isDownloading = downloadingAttachments.has(dlKey);
                            const previewable = isPreviewableAttachment(att.name);
                            return (
                              <div
                                key={i}
                                onClick={(e) => { e.stopPropagation(); if (!isDownloading) handleAttachmentClick(email.id, att.name); }}
                                className="relative flex flex-col items-center p-2 border border-border rounded-lg bg-background hover:bg-accent/50 hover:border-primary/30 transition-all cursor-pointer group min-w-[100px] max-w-[130px]"
                              >
                                {/* Save-as icon for previewable files */}
                                {previewable && !isDownloading && (
                                  <button
                                    onClick={(e) => { e.stopPropagation(); handleSaveAttachment(email.id, att.name); }}
                                    className="absolute top-1 right-1 p-0.5 rounded bg-background/80 opacity-0 group-hover:opacity-100 transition-opacity hover:bg-accent"
                                    title="Save as..."
                                  >
                                    <Download className="h-3 w-3 text-muted-foreground" />
                                  </button>
                                )}
                                <div className="mb-1.5 p-1.5 rounded-lg bg-muted/50 group-hover:bg-background transition-colors">
                                  {isDownloading ? (
                                    <Loader2 className="h-5 w-5 animate-spin text-primary" />
                                  ) : (
                                    getFileIcon(att.name)
                                  )}
                                </div>
                                <div className="w-full text-center">
                                  <div className="text-[11px] font-medium truncate" title={att.name}>
                                    {att.name}
                                  </div>
                                  <div className="text-[10px] text-muted-foreground">
                                    {isDownloading ? 'Opening...' : previewable ? 'Click to preview' : getFileType(att.name)}
                                  </div>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}
                    {/* Reply/Forward buttons - hide if inline reply is active for this email */}
                    {!(showInlineReply && replyingToEmail?.id === email.id) && (
                      <div className="mt-4 pt-3 border-t border-border flex items-center gap-2">
                        <button
                          onClick={(e) => { e.stopPropagation(); handleReply(email); }}
                          className="flex items-center gap-2 px-3 py-1.5 hover:bg-accent rounded-md transition-colors text-sm font-medium"
                        >
                          <Reply className="h-4 w-4" />
                          Reply
                        </button>
                        <button
                          onClick={(e) => { e.stopPropagation(); handleReplyAll(email); }}
                          className="flex items-center gap-2 px-3 py-1.5 hover:bg-accent rounded-md transition-colors text-sm font-medium"
                        >
                          <ReplyAll className="h-4 w-4" />
                          Reply All
                        </button>
                        <button
                          onClick={(e) => { e.stopPropagation(); handleInlineForward(email); }}
                          className="flex items-center gap-2 px-3 py-1.5 hover:bg-accent rounded-md transition-colors text-sm font-medium"
                        >
                          <Forward className="h-4 w-4" />
                          Forward
                        </button>
                      </div>
                    )}
                  </div>
                );
              })()}

              {/* Inline Reply for this thread email */}
              {showInlineReply && replyingToEmail?.id === email.id && (
                <div id="inline-reply-compose">
                <InlineReply
                  replyToEmail={{
                    id: email.id,
                    messageId: (email as any).messageId,
                    threadId: (email as any).threadId,
                    accountId: (email as any).accountId,
                    subject: email.subject || '',
                    fromAddress: email.fromAddress,
                    fromName: email.fromName,
                    toAddress: email.toAddress || '',
                    ccAddress: email.ccAddress,
                    date: email.date,
                    cleanBody: email.cleanBody,
                    rawBody: email.rawBody,
                  }}
                  mode={inlineReplyMode}
                  onClose={handleCloseInlineReply}
                  onModeChange={setInlineReplyMode}
                  embedded={true}
                  draft={inlineReplyDraft}
                  threadContext={polishThreadContext || undefined}
                />
                </div>
              )}

              {/* Inline Forward for this thread email */}
              {showInlineForward && forwardingEmail?.id === email.id && (
                <div id="inline-forward-compose">
                  <InlineForward
                    forwardEmail={{
                      id: email.id,
                      subject: email.subject || '',
                      fromAddress: email.fromAddress,
                      fromName: email.fromName,
                      toAddress: email.toAddress || '',
                      ccAddress: email.ccAddress,
                      date: email.date,
                      cleanBody: email.cleanBody,
                      rawBody: email.rawBody,
                    }}
                    onClose={handleCloseInlineForward}
                    embedded={true}
                  />
                </div>
              )}
            </div>
          );
        })}
    </div>
  );
}
