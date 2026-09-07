import { Loader2, RefreshCw, Sparkles } from 'lucide-react';
import { useMemo } from 'react';

import { buildPolishThreadContext, getCurrentUserEmail } from '../../services/ai-service';
import { buildDeterministicConversation } from '../../services/conversation-heuristic';
import { useEmailStore } from '../../store/email-store';
import { ChatView } from '../ChatView';
import { InlineForward } from '../InlineForward';
import { InlineReply } from '../InlineReply';
import { Tooltip } from '../Tooltip';

import type { EmailDetailContext } from './types';

// getCurrentUserEmail used to live here; it moved to ai-service so
// EmailDetail can share it (priority: IMAP username > profile email > fallback).

interface ThreadChatViewProps {
  ctx: EmailDetailContext;
}

export function ThreadChatView({ ctx }: ThreadChatViewProps) {
  const {
    displayEmail,
    threadEmails,
    conversationMessages,
    conversationLoading,
    conversationUpdating,
    conversationError,
    conversationPartial,
    conversationProgress,
    showAIView,
    setShowAIView,
    handleRetryConversation,
    handleReExtractMessage,
    handleReply,
    handleReplyAll,
    handleInlineForward,
    handleReportSpam,
    handlePrintEmail,
    handleDownloadEmail,
    handleShowOriginal,
    handleFilterLikeThis,
    handleTranslate,
    handleDetectSignature,
    markAsRead,
    showInlineReply,
    inlineReplyMode,
    setInlineReplyMode,
    replyingToEmail,
    inlineReplyDraft,
    handleCloseInlineReply,
    showInlineForward,
    forwardingEmail,
    handleCloseInlineForward,
  } = ctx;

  // A run is in flight when loading (cold open, pre-first-bubbles) OR
  // when progressive counters are live (loading flips false as soon as
  // the first bubbles render, but progress stays non-null to the end).
  const extractionInFlight = conversationLoading || conversationProgress != null;

  // The thread-level "needs attention" state (orange reload icon) reflects
  // whether any message ACTUALLY failed AI cleanup — i.e. a message showing a
  // per-message "Process with AI" card. This keeps the thread indicator
  // consistent with the bubbles: no more orange thread icon with no actionable
  // message. (conversationPartial also flips true for benign truncation, which
  // isn't a per-message failure, so we deliberately don't colour on that.)
  // Compute over the SAME draft-filtered set ChatView renders: a draft bubble
  // is never rendered (ChatView drops sourceEmailIds carrying the |draft| tag),
  // so a draft whose per-message AI cleanup fell back to heuristic
  // (extractionFailed:true) must NOT turn the icon orange — there's no visible
  // failed card to act on. Mirror ChatView's draftIds derivation here.
  const hasFailedMessage = useMemo(() => {
    const draftIds = new Set(
      threadEmails.filter(e => (e.tags || '').includes('|draft|')).map(e => e.id),
    );
    return !!conversationMessages?.some(
      (m: any) => m.extractionFailed && !draftIds.has(m.sourceEmailId),
    );
  }, [conversationMessages, threadEmails]);

  const currentUserEmail = useMemo(
    () => getCurrentUserEmail(displayEmail?.toAddress || ''),
    [displayEmail?.toAddress],
  );

  // Standard (non-AI) view: split the thread into per-sender chat bubbles
  // deterministically — no LLM. Feeds the same bubble renderer the AI view
  // uses, so Standard shows oldest->newest messages with quotes + signatures
  // stripped instead of one email with the whole history inlined.
  const standardMessages = useMemo(
    () => buildDeterministicConversation(threadEmails, currentUserEmail),
    [threadEmails, currentUserEmail],
  );

  // Bodies that permanently failed to fetch — so chat bubbles show a Retry
  // affordance instead of an endless "Loading content…" spinner.
  const failedBodies = useEmailStore((s) => s.failedBodies);
  const retryBody = (emailId: string) => {
    // fetchEmailBody skips ids already in failedBodies, so clear it first.
    useEmailStore.setState((s) => {
      const next = new Set(s.failedBodies);
      next.delete(emailId);
      return { failedBodies: next };
    });
    useEmailStore.getState().fetchEmailBody(emailId);
  };

  // Whole-thread transcript for AI polish of the inline reply. Memoized on
  // the thread data so it is NOT rebuilt on every keystroke / unrelated
  // ctx change while the user types their reply.
  const polishThreadContext = useMemo(
    () => buildPolishThreadContext({ conversationMessages, threadEmails, currentUserEmail }),
    [conversationMessages, threadEmails, currentUserEmail],
  );

  return (
    <div className="relative border border-border rounded-lg bg-card mt-2 pt-3">
      {/* AI / Logical toggle — sits on the top border line. Always
          rendered so the user can switch to Standard mid-extraction;
          the re-extract icon only appears once messages exist. */}
      <div className="absolute -top-3 left-0 right-0 flex items-center justify-center z-10">
        <div className="relative flex items-center p-1 bg-muted/70 hover:bg-muted/90 backdrop-blur-md border border-border shadow-sm rounded-lg transition-colors">
          {/* Animated pill background — Standard sits LEFT (default), AI right. */}
          <div
            className={`absolute top-1 bottom-1 w-[82px] bg-background rounded-md shadow-[0_1px_3px_rgba(0,0,0,0.1)] border border-border/50 transition-all duration-300 ease-out z-0 ${showAIView ? 'left-[83px]' : 'left-1'
              }`}
          />
          <button
            onClick={() => setShowAIView(false)}
            className={`relative z-10 flex items-center justify-center w-[80px] gap-1.5 py-1 rounded-md text-xs font-semibold transition-colors duration-300 ${!showAIView
                ? 'text-foreground'
                : 'text-muted-foreground hover:text-foreground'
              }`}
          >
            Standard
          </button>
          <button
            onClick={() => setShowAIView(true)}
            className={`relative z-10 flex items-center justify-center w-[80px] gap-1.5 py-1 rounded-md text-xs font-semibold transition-colors duration-300 ml-1 ${showAIView
                ? 'text-violet-600 dark:text-violet-400'
                : 'text-muted-foreground hover:text-foreground'
              }`}
          >
            <Sparkles className="h-3.5 w-3.5" />
            AI View
          </button>
          {showAIView && conversationMessages && (
            <div className="relative z-10 flex items-center border-l border-border/50 ml-1 pl-1">
              <Tooltip
                content={
                  conversationLoading
                    ? 'Extracting…'
                    : hasFailedMessage
                      ? 'Some messages need AI processing — click to extract again'
                      : 'Re-extract conversation'
                }
              >
                <button
                  onClick={handleRetryConversation}
                  disabled={conversationLoading}
                  className={`flex items-center justify-center p-1.5 rounded-md transition-all duration-200 ${
                    hasFailedMessage && !conversationLoading
                      ? 'text-orange-500 hover:text-orange-600 hover:bg-orange-500/10'
                      : 'text-muted-foreground hover:bg-accent/80 hover:text-foreground'
                  }`}
                >
                  <RefreshCw
                    className={`h-3 w-3 ${
                      conversationLoading
                        ? 'animate-spin text-violet-500'
                        : hasFailedMessage
                          ? 'text-orange-500 hover:text-orange-600'
                          : ''
                    }`}
                  />
                </button>
              </Tooltip>
            </div>
          )}
        </div>
        {extractionInFlight && (
          <div className="flex items-center gap-1.5 ml-2 px-2 py-0.5 text-[11px] text-muted-foreground bg-card border border-border rounded-md">
            <Loader2 className="h-3 w-3 animate-spin text-violet-500" />
            <span className="font-medium tabular-nums">
              {conversationProgress && conversationProgress.total > 0
                ? `${conversationProgress.done}/${conversationProgress.total}`
                : 'Extracting…'}
            </span>
          </div>
        )}
        {conversationError && (
          <div className="flex items-center gap-1 ml-2">
            <span className="text-xs text-destructive bg-card px-2 py-0.5 rounded border border-border">{conversationError}</span>
            <button
              onClick={handleRetryConversation}
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground bg-card px-2 py-0.5 rounded border border-border transition-colors"
            >
              <RefreshCw className="h-3 w-3" />
              Retry
            </button>
          </div>
        )}
      </div>
      <ChatView
        emails={threadEmails}
        currentUserEmail={currentUserEmail}
        conversationMessages={
          showAIView
            ? (conversationMessages || undefined)
            : (standardMessages.length > 0 ? standardMessages : undefined)
        }
        conversationUpdating={showAIView ? conversationUpdating : false}
        conversationLoading={showAIView ? conversationLoading : false}
        conversationProgress={showAIView ? conversationProgress : null}
        conversationPartial={showAIView ? conversationPartial : false}
        mode={showAIView ? 'ai' : 'logical'}
        onReply={(email) => handleReply(email, false)}
        onReplyAll={(email) => handleReplyAll(email, false)}
        onForward={(email) => handleInlineForward(email)}
        onDelete={(emailId) => ctx.deleteEmail(emailId)}
        onArchive={(emailId) => ctx.archiveEmail(emailId)}
        onMarkUnread={async (emailId) => { await markAsRead(emailId, false); useEmailStore.getState().clearSelectedEmail(); }}
        onReportSpam={(emailId) => handleReportSpam(emailId)}
        onPrint={(email) => handlePrintEmail(email)}
        onDownload={(email) => handleDownloadEmail(email)}
        onShowOriginal={(email) => handleShowOriginal(email)}
        onFilterLikeThis={(email) => handleFilterLikeThis(email)}
        onTranslate={(email) => handleTranslate(email)}
        onDetectSignature={(email) => handleDetectSignature(email)}
        onToggleStar={(emailId, starred) => useEmailStore.getState().markMessageStarred(emailId, starred)}
        failedBodies={failedBodies}
        onRetryBody={retryBody}
        onReExtractMessage={showAIView ? handleReExtractMessage : undefined}
        onRetryAll={showAIView ? handleRetryConversation : undefined}
      />

      {/* Inline Reply */}
      {showInlineReply && replyingToEmail && (
        <div id="inline-reply-compose" className="border-t border-border">
          <InlineReply
            replyToEmail={replyingToEmail}
            mode={inlineReplyMode}
            onClose={handleCloseInlineReply}
            onModeChange={setInlineReplyMode}
            embedded
            draft={inlineReplyDraft}
            threadContext={polishThreadContext || undefined}
          />
        </div>
      )}

      {/* Inline Forward */}
      {showInlineForward && forwardingEmail && (
        <div id="inline-forward-compose" className="border-t border-border">
          <InlineForward
            forwardEmail={forwardingEmail}
            onClose={handleCloseInlineForward}
            embedded
          />
        </div>
      )}
    </div>
  );
}
