import { Mail, Loader2, ArrowDown, X } from 'lucide-react';

import { useEmailStore } from '../../store/email-store';
import { accountDisplayLabel } from '../../store/helpers';
import { toForwardSource } from '../../utils/forward-quote';
import { InlineForward } from '../InlineForward';
import { InlineReply } from '../InlineReply';
import { LabelChips } from '../LabelChips';
import { ThreadSummary } from '../ThreadSummary';
import { Tooltip } from '../Tooltip';

import { useChatPrewarm } from './chat-prewarm';
import { chatMountsComposer } from './chat-view-rules';
import { EmailCard } from './EmailCard';
import { EmailToolbar } from './EmailToolbar';
import { FollowUpBanner } from './FollowUpBanner';
import { useEmailDetail } from './hooks/useEmailDetail';
import { ShowOriginalModal } from './ShowOriginalModal';
import { SignatureDetectionModal } from './SignatureDetectionModal';
import { threadHeaderLabel } from './thread-header-label';
import { ThreadChatView } from './ThreadChatView';
import { ThreadList } from './ThreadList';
import { ViewModeToggle } from './ViewModeToggle';


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

  // Get the chat view's split done in the background while the reader is still
  // in the standard view, so switching to it is instant rather than a freeze on
  // a long thread. Gated on the chat rules: only where the toggle is offered
  // (warming a thread the reader cannot switch is work that only evicts
  // another thread's from a shared cache) and chat is not already showing.
  useChatPrewarm({
    emails: ctx?.threadEmails ?? NO_EMAILS,
    currentUserEmail: ctx?.currentUserEmail ?? '',
    enabled: !!ctx && ctx.chatRules.offerChat && !ctx.chatViewActive,
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
    chatViewActive,
    chatRules,
    polishThreadContext,
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
    handleReplyAll,
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

          <FollowUpBanner
            threadId={displayEmail.threadId}
            accountId={displayEmail.accountId ?? viewAccountId}
            threadEmails={threadEmails}
            onFollowUp={(email) => handleReplyAll(email)}
          />

          {/* Thread info: message count + view toggle + summary. Shown
              wherever the chat view is OFFERED (chatRules.offerChat): real
              threads, and a single email that quotes earlier messages (a
              looped-in chain) — never designed bulk mail. */}
          {chatRules.offerChat && (
            <div className="mb-6 space-y-3">
              <div className="flex items-center gap-2">
                <div className="h-px flex-1 bg-border" />
                <span className="text-sm font-medium text-muted-foreground px-2">
                  {/* `threadMessageTotal`, NOT `threadEmails.length`: the latter
                      is the duplicate-collapsed list, so a thread with a folded
                      copy headed "(2)" under a list row that said "(3)". */}
                  {threadHeaderLabel(threadEmails, threadMessageTotal)}
                </span>
                {/* Selected = what is ON SCREEN: a single email quoting one
                    message stays a card (List) until the reader picks Chat,
                    even with the chat setting on. */}
                <ViewModeToggle chatViewEnabled={chatViewActive} onToggle={handleChatViewToggle} />
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

          {/* Inline Reply for main email — hidden in conversation mode. The
              chat view mounts every box this one does not (chatMountsComposer
              decides both sides), so a reply never gets two composers. */}
          {showInlineReply && replyingToEmail &&
            !chatMountsComposer({ chatViewActive, targetId: replyingToEmail.id, anchorId: displayEmail.id }) && (
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
          {showInlineForward && forwardingEmail &&
            !chatMountsComposer({ chatViewActive, targetId: forwardingEmail.id, anchorId: displayEmail.id }) && (
            <div id="inline-forward-compose">
              <InlineForward
                forwardEmail={toForwardSource(forwardingEmail)}
                draft={inlineForwardDraft}
                onClose={handleCloseInlineForward}
              />
            </div>
          )}

          {/* Thread Section — the chat view whenever it IS the reading surface
              (chatRules.chatActive: the card above is hidden then, so the two
              never render together), the list for a multi-email thread read
              as a list. */}
          {(threadEmails.length > 1 || chatViewActive) && (
            <div className="mt-6">
              {/* Chat View Mode */}
              {chatViewActive ? (
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
