import type { EmailRecord } from '@sarvinbox/core';
import { MailChatView, type Attachment, type ChatMessage } from 'email-chat-view';
import { Loader2, RefreshCw, Sparkles } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';

import { buildPolishThreadContext, getCurrentUserEmail } from '../../services/ai-service';
import type { ConversationMessage } from '../../services/conversation-service';
import { resolveRefsInHtml } from '../../services/image-cache';
import { useEmailStore } from '../../store/email-store';
import { InlineForward } from '../InlineForward';
import { InlineReply } from '../InlineReply';
import { Tooltip } from '../Tooltip';

import { chatMessagesFromConversation, chatMessagesFromThread } from './chat-message-adapter';
import { chatSourceFor, shouldShowProcessPrompt } from './chat-view-rules';
import { EmailMenu } from './EmailMenu';
import type { EmailDetailContext } from './types';

// getCurrentUserEmail used to live here; it moved to ai-service so
// EmailDetail can share it (priority: IMAP username > profile email > fallback).

/**
 * How many bubbles are allowed in the DOM at once.
 *
 * A 200-message thread is an ordinary support escalation, and every bubble
 * with a designed body costs a whole sandboxed document. The rest sit behind
 * the view's own "Show N earlier messages" button — nothing is lost, it is
 * just not laid out until asked for.
 */
const MAX_RENDERED_BUBBLES = 40;

interface ThreadChatViewProps {
  ctx: EmailDetailContext;
}

export function ThreadChatView({ ctx }: ThreadChatViewProps) {
  const {
    displayEmail,
    threadEmails,
    conversationMessages,
    conversationLoading,
    conversationError,
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

  const currentUserEmail = useMemo(
    () => getCurrentUserEmail(displayEmail?.toAddress || ''),
    [displayEmail?.toAddress],
  );

  const emailsById = useMemo(
    () => new Map(threadEmails.map((email) => [email.id, email])),
    [threadEmails],
  );

  // Bodies that permanently failed to fetch — so chat bubbles show a Retry
  // affordance instead of an endless "Loading content…" spinner.
  const failedBodies = useEmailStore((s) => s.failedBodies);
  const retryBody = useCallback((emailId: string) => {
    // fetchEmailBody skips ids already in failedBodies, so clear it first.
    useEmailStore.setState((s) => {
      const next = new Set(s.failedBodies);
      next.delete(emailId);
      return { failedBodies: next };
    });
    useEmailStore.getState().fetchEmailBody(emailId);
  }, []);

  // The LLM-extracted turns, when the AI view is the one on screen. Standard
  // has none: it is the library's deterministic split, which produces chat
  // messages directly and needs no ConversationMessage of its own.
  const aiMessages: ConversationMessage[] | undefined = showAIView
    ? conversationMessages || undefined
    : undefined;

  const chatMessages = useMemo<ChatMessage[]>(() => {
    const options = {
      currentUserEmail,
      emailsById,
      failedBodies,
      resolveImages: resolveRefsInHtml,
    };
    switch (chatSourceFor(showAIView, aiMessages?.length ?? 0)) {
      // Only what the LLM actually extracted — see `chatSourceFor` for why
      // there is no fallback to the deterministic split here.
      case 'ai':
        return chatMessagesFromConversation(aiMessages!, options);
      // `email-chat-view` splits the thread's own mails into one bubble per
      // message — quotes, signatures and banners stripped, and the messages
      // that exist only as quotes inside other mails recovered. All of that
      // lives in the library now; the app just hands it stored rows.
      case 'thread':
        return chatMessagesFromThread(threadEmails, options);
      case 'none':
        return [];
    }
  }, [showAIView, aiMessages, threadEmails, currentUserEmail, emailsById, failedBodies]);

  // Per-message extraction state, keyed the way the view hands messages back.
  // AI-only: a deterministic split has no extraction to fail.
  const conversationById = useMemo(() => {
    const map = new Map<string, ConversationMessage>();
    for (const message of aiMessages || []) map.set(message.id, message);
    return map;
  }, [aiMessages]);

  // The thread-level "needs attention" state (orange reload icon) reflects
  // whether any message ACTUALLY failed AI cleanup — i.e. a message showing a
  // per-message re-extract affordance. Computed over the SAME set the view
  // renders (drafts already dropped by the adapter), so a draft whose cleanup
  // fell back to the heuristic cannot turn the icon orange with no visible
  // message to act on. conversationPartial also flips true for benign
  // truncation, which isn't a per-message failure, so it deliberately doesn't
  // colour on that.
  const hasFailedMessage = useMemo(
    () => chatMessages.some((message) => conversationById.get(message.id)?.extractionFailed),
    [chatMessages, conversationById],
  );

  // AI view with nothing extracted: offer the extraction rather than bubbles.
  // Deliberately NOT gated on `conversationPartial` any more — a thread the
  // pipeline never touched at all is not "partial", and that gate was why the
  // prompt stayed hidden while the fallback quietly rendered Standard's
  // bubbles here instead.
  const showProcessPrompt = shouldShowProcessPrompt({
    showAIView,
    extractionInFlight,
    conversationLoading,
    renderedCount: chatMessages.length,
  });

  // Whole-thread transcript for AI polish of the inline reply. Memoized on the
  // thread data so it is NOT rebuilt on every keystroke or unrelated ctx change
  // while the user types their reply.
  const polishThreadContext = useMemo(
    () => buildPolishThreadContext({ conversationMessages, threadEmails, currentUserEmail }),
    [conversationMessages, threadEmails, currentUserEmail],
  );

  const emailFor = useCallback(
    (message: ChatMessage) => emailsById.get(message.sourceId || message.id),
    [emailsById],
  );

  const runAttachmentAction = useCallback(
    async (attachment: Attachment, message: ChatMessage, action: 'preview' | 'download') => {
      const email = emailFor(message);
      if (!email) return;
      try {
        if (action === 'preview') {
          await window.electronAPI.emails.previewAttachment(email.id, attachment.filename);
        } else {
          await window.electronAPI.emails.downloadAttachment(email.id, attachment.filename);
        }
      } catch (err) {
        // Renderer logs go through console.* on purpose — see
        // bootstrap/renderer-logging.ts, which forwards them into app.log.
        console.error(`[ThreadChatView] attachment ${action} failed:`, err);
      }
    },
    [emailFor],
  );

  const openLink = useCallback((url: string) => {
    // `#` is an in-document jump with nowhere to go once the body is framed,
    // and mailto: is the compose window's job, not the browser's.
    if (!url || url.startsWith('#') || url.startsWith('mailto:')) return;
    if (window.electronAPI?.app?.openExternal) {
      window.electronAPI.app.openExternal(url);
    } else {
      window.open(url, '_blank');
    }
  }, []);

  const renderActions = useCallback(
    (message: ChatMessage) => {
      const email = emailFor(message);
      if (!email) return null;
      return (
        <BubbleActions
          email={email}
          extractionFailed={!!conversationById.get(message.id)?.extractionFailed}
          onReExtract={
            showAIView && handleReExtractMessage
              ? () => handleReExtractMessage(message.id)
              : undefined
          }
          onReply={() => handleReply(email, false)}
          onReplyAll={() => handleReplyAll(email, false)}
          onForward={() => handleInlineForward(email)}
          onDelete={() => ctx.deleteEmail(email.id)}
          onArchive={() => ctx.archiveEmail(email.id)}
          onMarkUnread={async () => {
            await markAsRead(email.id, false);
            useEmailStore.getState().clearSelectedEmail();
          }}
          onReportSpam={() => handleReportSpam(email.id)}
          onPrint={() => handlePrintEmail(email)}
          onDownload={() => handleDownloadEmail(email)}
          onShowOriginal={() => handleShowOriginal(email)}
          onFilterLikeThis={() => handleFilterLikeThis(email)}
          onTranslate={() => handleTranslate(email)}
          onDetectSignature={() => handleDetectSignature(email)}
        />
      );
    },
    [
      emailFor, conversationById, showAIView, handleReExtractMessage, handleReply,
      handleReplyAll, handleInlineForward, ctx, markAsRead, handleReportSpam,
      handlePrintEmail, handleDownloadEmail, handleShowOriginal, handleFilterLikeThis,
      handleTranslate, handleDetectSignature,
    ],
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

      <MailChatView
        messages={chatMessages}
        currentUserAddress={currentUserEmail}
        loading={showAIView && conversationLoading && chatMessages.length === 0}
        maxRendered={MAX_RENDERED_BUBBLES}
        className="px-3 py-4"
        onOpenLink={openLink}
        onRetryBody={(message) => {
          const email = emailFor(message);
          if (email) retryBody(email.id);
        }}
        onPreviewAttachment={(attachment, message) =>
          runAttachmentAction(attachment, message, 'preview')
        }
        onDownloadAttachment={(attachment, message) =>
          runAttachmentAction(attachment, message, 'download')
        }
        renderActions={renderActions}
        emptyState={
          showProcessPrompt ? (
            <div className="flex flex-col items-center gap-2 py-8 text-center">
              <Sparkles className="h-5 w-5 text-violet-500" />
              <p className="text-xs text-muted-foreground max-w-xs">
                This thread hasn’t been processed with AI yet. Standard view has the
                full content in the meantime.
              </p>
              <button
                onClick={handleRetryConversation}
                className="text-xs font-medium text-primary hover:underline"
              >
                Process now
              </button>
            </div>
          ) : undefined
        }
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

/**
 * The hover controls at a bubble's outer edge.
 *
 * The view reveals `.sec-actions` on row hover and hides it otherwise — but
 * the menu portals to `<body>`, so once it is open the cursor leaves the row
 * and the trigger would fade out from under its own open menu. Pinning the
 * opacity while it is open is the whole reason this needs state.
 */
function BubbleActions({
  email,
  onReExtract,
  extractionFailed,
  ...menu
}: {
  email: EmailRecord;
  onReExtract?: () => void;
  /** This message's AI cleanup failed → tint the re-extract icon orange (like the
   *  thread-level reload) so an unprocessed message is visible at a glance. */
  extractionFailed?: boolean;
  onReply: () => void;
  onReplyAll: () => void;
  onForward: () => void;
  onDelete: () => void;
  onArchive: () => void;
  onMarkUnread: () => void;
  onReportSpam: () => void;
  onPrint: () => void;
  onDownload: () => void;
  onShowOriginal: () => void;
  onFilterLikeThis: () => void;
  onTranslate: () => void;
  onDetectSignature: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [reExtracting, setReExtracting] = useState(false);

  const runReExtract = async () => {
    if (!onReExtract || reExtracting) return;
    setReExtracting(true);
    try {
      await onReExtract();
    } finally {
      setReExtracting(false);
    }
  };

  return (
    <div className="flex items-center gap-0.5" style={menuOpen ? { opacity: 1 } : undefined}>
      {onReExtract && (
        <Tooltip
          content={
            reExtracting
              ? 'Re-extracting with AI…'
              : extractionFailed
                ? 'Process this message with AI'
                : 'Re-extract this message with AI'
          }
          delayMs={40}
        >
          <button
            onClick={(e) => { e.stopPropagation(); void runReExtract(); }}
            disabled={reExtracting}
            className="p-1 hover:bg-accent rounded transition-colors"
          >
            <RefreshCw
              className={`h-3.5 w-3.5 ${
                reExtracting
                  ? 'animate-spin text-violet-500'
                  : extractionFailed
                    ? 'text-orange-500 hover:text-orange-600'
                    : 'text-muted-foreground'
              }`}
            />
          </button>
        </Tooltip>
      )}
      <EmailMenu email={email} {...menu} onOpenChange={setMenuOpen} />
    </div>
  );
}
