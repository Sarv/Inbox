import { Mail, Loader2, List, MessageSquare, ArrowDown, X } from 'lucide-react';
import { useMemo } from 'react';

import { buildPolishThreadContext, getCurrentUserEmail } from '../../services/ai-service';
import { useEmailStore } from '../../store/email-store';
import { accountDisplayLabel } from '../../store/helpers';
import { InlineForward } from '../InlineForward';
import { InlineReply } from '../InlineReply';
import { LabelChips } from '../LabelChips';
import { ThreadSummary } from '../ThreadSummary';
import { Tooltip } from '../Tooltip';

import { useChatPrewarm } from './chat-prewarm';
import { EmailCard } from './EmailCard';
import { EmailToolbar } from './EmailToolbar';
import { useEmailDetail } from './hooks/useEmailDetail';
import { ShowOriginalModal } from './ShowOriginalModal';
import { SignatureDetectionModal } from './SignatureDetectionModal';
import { threadHeaderLabel } from './thread-header-label';
import { ThreadChatView } from './ThreadChatView';
import { ThreadList } from './ThreadList';


/** Stable empty thread, so the prewarm effect does not restart on every render. */
const NO_EMAILS: readonly [] = [];

export function EmailDetail() {
  const ctx = useEmailDetail();
  const setEmailLabel = useEmailStore((s) => s.setEmailLabel);
  // Account color dot before the subject — ONLY when the message was opened from
  // the unified "All Inboxes" view, so the reader can tell which account it's in.
  const isUnifiedView = useEmailStore((s) => s.selectedVirtualFolder === 'virtual-unified');
  const viewAccountId = useEmailStore((s) => s.viewAccountId);
  const accounts = useEmailStore((s) => s.accounts);
  // "New message" banner: messages that landed in this thread (via IMAP IDLE)
  // after it was opened. The reading pane is snapshotted at open time and does
  // not live-append, so we surface them here instead of silently going stale.
  const pendingThreadCount = useEmailStore((s) => s.pendingThreadEmailIds.length);
  const showPendingThreadMessages = useEmailStore((s) => s.showPendingThreadMessages);
  const dismissPendingThreadMessages = useEmailStore((s) => s.dismissPendingThreadMessages);

  // Whole-thread transcript for AI polish of the inline reply. These hooks
  // must run BEFORE the `!ctx` early return (rules of hooks), and are
  // memoized on the thread data so the transcript is not rebuilt on every
  // keystroke while the user types their reply.
  const currentUserEmail = useMemo(
    () => getCurrentUserEmail(ctx?.displayEmail?.toAddress || ''),
    [ctx?.displayEmail?.toAddress],
  );
  const polishThreadContext = useMemo(
    () =>
      ctx
        ? buildPolishThreadContext({
            conversationMessages: ctx.conversationMessages,
            threadEmails: ctx.threadEmails,
            currentUserEmail,
          })
        : '',
    [ctx?.conversationMessages, ctx?.threadEmails, currentUserEmail],
  );

  // Get the chat view's split done in the background while the reader is still
  // in the standard view, so switching to it is instant rather than a freeze on
  // a long thread. Gated on the same condition that decides whether the toggle
  // is offered at all — warming a thread the reader cannot switch is work that
  // only evicts another thread's from a shared cache.
  useChatPrewarm({
    emails: ctx?.threadEmails ?? NO_EMAILS,
    currentUserEmail,
    enabled:
      !!ctx && !ctx.chatViewEnabled && (ctx.threadEmails.length > 1 || ctx.hasInlineConversation),
  });

  if (!ctx) {
    return (
      <div className="flex-1 flex items-center justify-center bg-background">
        <div className="text-center text-muted-foreground">
          <Mail className="h-16 w-16 mx-auto mb-4 opacity-20" />
          <p className="text-lg">Select an email to read</p>
          <p className="text-sm mt-2 opacity-70">
            Choose a message from the list to view its contents
          </p>
        </div>
      </div>
    );
  }

  const {
    displayEmail,
    isStandaloneDraft,
    threadEmails,
    threadMessageTotal,
    loadingThread,
    chatViewEnabled,
    chatViewActive,
    hasInlineConversation,
    showInlineReply,
    replyingToEmail,
    inlineReplyMode,
    inlineReplyDraft,
    showInlineForward,
    forwardingEmail,
    inlineForwardDraft,
    handleCloseInlineForward,
    showOriginalEmail,
    setShowOriginalEmail,
    signatureDetectionEmail,
    setSignatureDetectionEmail,
    signatureDetectionResult,
    setSignatureDetectionResult,
    signatureDetecting,
    handleChatViewToggle,
    handleCloseInlineReply,
    handleSaveSignatureSelector,
    setInlineReplyMode,
  } = ctx;

  return (
    <div className="flex-1 min-w-0 flex flex-col bg-background overflow-hidden">
      {/* Action Toolbar */}
      <EmailToolbar ctx={ctx} />

      {/* Email Content */}
      <div className="flex-1 overflow-y-auto" data-email-detail-scroll>
        <div className="p-6">
          {/* Subject + applied labels (removable) at the end of the line */}
          <div className="flex items-center flex-wrap gap-x-3 gap-y-2 mb-4">
            {(() => {
              if (!isUnifiedView) return null;
              const acctId = displayEmail.accountId ?? viewAccountId;
              const acct = accounts.find((a) => a.id === acctId);
              if (!acct) return null;
              return (
                <Tooltip content={accountDisplayLabel(accounts, acct.id)} delayMs={40}>
                  <span
                    className="h-3 w-3 rounded-full shrink-0"
                    style={{ backgroundColor: acct.color ?? '#2563eb' }}
                    aria-label={`Account: ${accountDisplayLabel(accounts, acct.id)}`}
                  />
                </Tooltip>
              );
            })()}
            <h1 className="text-3xl font-bold text-foreground min-w-0 break-words">
              {displayEmail.subject || '(no subject)'}
            </h1>
            <LabelChips
              tags={displayEmail.tags}
              variant="solid"
              onRemove={(name) => setEmailLabel(displayEmail.id, name, false)}
            />
          </div>

          {/* Thread info: message count + view toggle + summary.
              Shown for real threads AND single emails with embedded
              conversations (loop-me-in / forwarded chain) so the user
              can switch between Chat and Standard view. */}
          {(threadEmails.length > 1 || hasInlineConversation) && (
            <div className="mb-6 space-y-3">
              <div className="flex items-center gap-2">
                <div className="h-px flex-1 bg-border" />
                <span className="text-sm font-medium text-muted-foreground px-2">
                  {/* `threadMessageTotal`, NOT `threadEmails.length`: the latter
                      is the duplicate-collapsed list, so a thread with a folded
                      copy headed "(2)" under a list row that said "(3)". */}
                  {threadHeaderLabel(threadEmails, threadMessageTotal)}
                </span>
                {/* View Mode Toggle */}
                <div className="flex items-center gap-1 bg-muted rounded-md p-0.5">
                  <button
                    onClick={() => handleChatViewToggle(false)}
                    className={`p-1.5 rounded-md transition-colors ${!chatViewEnabled
                        ? 'bg-background shadow-sm text-foreground'
                        : 'text-muted-foreground hover:text-foreground'
                      }`}
                    title="List view"
                  >
                    <List className="h-4 w-4" />
                  </button>
                  {/* Never disabled — chat view always has something to
                      show now (skeleton while extracting, standard-bubble
                      fallback when extraction fails). */}
                  <button
                    onClick={() => handleChatViewToggle(true)}
                    className={`p-1.5 rounded-md transition-colors ${chatViewEnabled
                        ? 'bg-background shadow-sm text-foreground'
                        : 'text-muted-foreground hover:text-foreground'
                      }`}
                    title="Chat view"
                  >
                    <MessageSquare className="h-4 w-4" />
                  </button>
                </div>
                <div className="h-px flex-1 bg-border" />
              </div>

              {/* AI Thread Summary — only for real threads */}
              {threadEmails.length > 1 && displayEmail?.threadId && (
                <ThreadSummary
                  threadId={displayEmail.threadId}
                  emails={threadEmails}
                />
              )}
            </div>
          )}

          {/* Email Card — hidden when conversation chat view is active, and for a
              standalone draft (no surrounding conversation) where the draft IS
              the compose box below, not a read-only message. */}
          {!isStandaloneDraft && <EmailCard ctx={ctx} />}

          {/* Inline Reply for main email — hidden in conversation mode */}
          {showInlineReply && replyingToEmail?.id === displayEmail.id && !chatViewActive && (
            <div id="inline-reply-compose">
              <InlineReply
                replyToEmail={{
                  id: replyingToEmail.id,
                  messageId: replyingToEmail.messageId,
                  threadId: replyingToEmail.threadId,
                  accountId: replyingToEmail.accountId,
                  subject: replyingToEmail.subject || '',
                  fromAddress: replyingToEmail.fromAddress,
                  fromName: replyingToEmail.fromName,
                  toAddress: replyingToEmail.toAddress || '',
                  ccAddress: replyingToEmail.ccAddress,
                  date: replyingToEmail.date,
                  cleanBody: replyingToEmail.cleanBody,
                  rawBody: replyingToEmail.rawBody,
                }}
                mode={inlineReplyMode}
                onClose={handleCloseInlineReply}
                onModeChange={setInlineReplyMode}
                draft={inlineReplyDraft}
                threadContext={polishThreadContext || undefined}
              />
            </div>
          )}

          {/* Inline Forward for main email — hidden in conversation mode */}
          {showInlineForward && forwardingEmail?.id === displayEmail.id && !chatViewActive && (
            <div id="inline-forward-compose">
              <InlineForward
                forwardEmail={{
                  id: forwardingEmail.id,
                  subject: forwardingEmail.subject || '',
                  fromAddress: forwardingEmail.fromAddress,
                  fromName: forwardingEmail.fromName,
                  toAddress: forwardingEmail.toAddress || '',
                  ccAddress: forwardingEmail.ccAddress,
                  date: forwardingEmail.date,
                  cleanBody: forwardingEmail.cleanBody,
                  rawBody: forwardingEmail.rawBody,
                }}
                draft={inlineForwardDraft}
                onClose={handleCloseInlineForward}
              />
            </div>
          )}

          {/* Thread Section — also renders for single emails with embedded
              conversation (loop-me-in / forwarded chain) so chat view shows. */}
          {(threadEmails.length > 1 || hasInlineConversation || (chatViewEnabled && loadingThread)) && (
            <div className="mt-6">
              {/* Chat View Mode */}
              {chatViewEnabled ? (
                loadingThread ? (
                  <div className="flex items-center justify-center p-8">
                    <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                  </div>
                ) : (
                  <ThreadChatView ctx={ctx} />
                )
              ) : loadingThread ? (
                <div className="flex items-center justify-center p-8">
                  <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                </div>
              ) : (
                <ThreadList ctx={ctx} />
              )}
            </div>
          )}
        </div>
      </div>

      {/* New-message banner — a message arrived in this thread after it was
          opened. Click Show to fold it into the conversation; the banner
          clears itself once the thread reloads or the user navigates away. */}
      {pendingThreadCount > 0 && (
        <div className="shrink-0 border-t border-border bg-accent/60 px-6 py-2.5 flex items-center justify-center gap-3">
          <ArrowDown className="h-4 w-4 text-primary" />
          <span className="text-sm text-foreground">
            {pendingThreadCount === 1
              ? '1 new message in this conversation'
              : `${pendingThreadCount} new messages in this conversation`}
          </span>
          <button
            onClick={() => showPendingThreadMessages()}
            className="px-3 py-1 text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90 rounded-md transition-colors"
          >
            Show
          </button>
          <Tooltip content="Ignore" delayMs={40}>
            <button
              onClick={dismissPendingThreadMessages}
              aria-label="Ignore new messages"
              className="p-1 text-muted-foreground hover:text-foreground rounded transition-colors"
            >
              <X className="h-4 w-4" />
            </button>
          </Tooltip>
        </div>
      )}

      {/* Show Original Modal */}
      {showOriginalEmail && (
        <ShowOriginalModal
          email={showOriginalEmail}
          onClose={() => setShowOriginalEmail(null)}
        />
      )}

      {/* Signature Detection Modal */}
      {signatureDetectionEmail && (
        <SignatureDetectionModal
          email={signatureDetectionEmail}
          result={signatureDetectionResult}
          detecting={signatureDetecting}
          onSave={handleSaveSignatureSelector}
          onClose={() => {
            setSignatureDetectionEmail(null);
            setSignatureDetectionResult(null);
          }}
        />
      )}
    </div>
  );
}
