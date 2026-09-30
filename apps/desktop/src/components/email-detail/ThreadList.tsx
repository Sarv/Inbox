import { compareConversationOrder } from '@sarvinbox/core/conversation-membership';
import {
  Loader2,
  ChevronDown,
  ChevronUp,
  Paperclip,
  MoreHorizontal,
  FileSignature,
  Star,
} from 'lucide-react';
import prettyBytes from 'pretty-bytes';
import { useMemo, useState } from 'react';

import { isSignatureDetectionEnabled } from '../../services/ai-service';
import { useEmailStore } from '../../store/email-store';
import { firstFlaggedEmailId } from '../../utils/email-security';
import { toForwardSource } from '../../utils/forward-quote';
import { messageAccountOf, paneAccountOf } from '../../utils/pane-account';
import { remoteImageFactsOf } from '../../utils/remote-images';
import { useLinkRules } from '../../utils/security-rules';
import { useTrustedSenders } from '../../utils/trusted-senders';
import { AttachmentChips } from '../attachment-viewer/AttachmentChips';
import { InlineForward } from '../InlineForward';
import { InlineReply } from '../InlineReply';
import { SandboxedEmailBody } from '../SandboxedEmailBody';

import { DuplicateCopiesBadge } from './DuplicateCopiesBadge';
import { buildEmailMenuHandlers, buildReplyHandlers } from './email-menu-handlers';
import { EmailHeaderDetails } from './EmailHeaderDetails';
import { EmailMenu } from './EmailMenu';
import { clearAfterTrust, PhishingWarningBanner } from './PhishingWarningBanner';
import { ReplyActionsBar } from './ReplyActionsBar';
import { SecurityIndicator } from './SecurityIndicator';
import { SenderAvatar } from './SenderAvatar';
import type { EmailDetailContext } from './types';
import { formatRelativeDate, hasLoadedBody, stripQuotedContent, stripSignatureFromHtml, parseAttachments } from './utils';
import { VerifiedBadge } from './VerifiedBadge';


interface ThreadListProps {
  ctx: EmailDetailContext;
}

export function ThreadList({ ctx }: ThreadListProps) {
  const {
    displayEmail,
    threadEmails,
    duplicatesByEmailId,
    expandedThreads,
    showFullContent,
    showSignatures,
    showInlineReply,
    inlineReplyMode,
    replyingToEmail,
    inlineReplyDraft,
    loadingBodies,
    handleCloseInlineReply,
    showInlineForward,
    forwardingEmail,
    inlineForwardDraft,
    handleCloseInlineForward,
    toggleThread,
    toggleFullContent,
    toggleSignature,
    markAsStarred,
    fetchEmailBody,
    setInlineReplyMode,
    // The thread transcript for reply polish — built once in useEmailDetail,
    // the same one the card and the chat hand their composers.
    polishThreadContext,
  } = ctx;
  // The account the open thread was read from (`threadAccountId`, stamped with
  // the rows): whose trust lists decide each message's shield, warning and
  // remote images, and where "Trust this sender" / "Load images" are saved.
  const paneAccountId = useEmailStore(paneAccountOf);

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

  // Which message carries the thread's single warning banner (see the comment
  // at the render site). Includes the anchor, so a clean anchor with a spoofed
  // reply puts the banner on the reply — and a spoofed anchor keeps it there.
  const { sets: linkRuleSets } = useLinkRules();
  // The list itself, not the stable lookup, is the memo key: it is a new array
  // whenever a sender is trusted or removed, so the banner moves with it.
  const { senders: trustedSenders, isTrusted } = useTrustedSenders(paneAccountId);
  const firstFlaggedId = useMemo(
    () => firstFlaggedEmailId(threadEmails, linkRuleSets, isTrusted),
    [threadEmails, linkRuleSets, trustedSenders, isTrusted],
  );

  return (
    <div className="space-y-2">
      {threadEmails
        // `threadEmails` is already the conversation's MEMBERS (drafts and
        // Trash copies out, by the one predicate the chat view and main's
        // counts use — see useEmailDetail). A second, narrower filter here
        // (`|draft|` only) was how this list and the chat view came to
        // disagree about a draft synced back tagged only with its folder.
        .filter((e) => e.id !== displayEmail.id)
        // The one conversation order: an undated message goes last instead of
        // posing as the first reply, and equal timestamps tie-break by id.
        .sort(compareConversationOrder)
        .map((email) => {
          const isExpanded = expandedThreads.has(email.id);
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
                {/* The SAME avatar the anchor card draws (SenderAvatar:
                    BIMI logo on DMARC-passing mail, then the confirmed contact
                    photo, then the domain favicon, then initials). This row
                    used to hand-roll an initials circle, so one message showed
                    its sender's brand logo and the next message FROM THE SAME
                    SENDER showed two letters — a difference that looks like a
                    fact about the mail and is only a fact about which
                    component drew it. */}
                <div onClick={() => toggleThread(email.id)} className="flex-shrink-0 cursor-pointer">
                  <SenderAvatar
                    email={email.fromAddress}
                    name={email.fromName}
                    size={40}
                    authStatus={email.authStatus}
                    className="font-semibold"
                  />
                </div>
                <div
                  className="flex-1 min-w-0 cursor-pointer"
                  onClick={() => toggleThread(email.id)}
                >
                  <div className="flex items-start justify-between gap-2 mb-1">
                    <div className="min-w-0">
                      {/* The shield is PER MESSAGE, on every reply — not only on
                          the anchor card above. A thread is a list of separately
                          authenticated messages: the opener can pass DMARC while
                          reply 14 is a display-name spoof from a look-alike
                          domain, and until this rendered here the reader saw one
                          green shield at the top of that thread and nothing else.
                          The banner still appears once (see firstFlaggedEmailId);
                          the shield is a level with its evidence on hover, which
                          is why every message gets one. */}
                      <div className="font-semibold text-sm text-foreground flex items-center gap-1.5">
                        <span className="truncate">{email.fromName || email.fromAddress}</span>
                        <VerifiedBadge email={email.fromAddress} authStatus={email.authStatus} />
                        <SecurityIndicator
                          accountId={messageAccountOf(email, paneAccountId)}
                          fromName={email.fromName}
                          fromAddress={email.fromAddress}
                          authStatus={email.authStatus}
                          spamScore={email.spamScore}
                          spamReasons={email.spamReasons}
                          html={email.rawBody}
                          bodyLoaded={hasLoadedBody(email)}
                        />
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
                  // A reply's menu: Forward in the popup, as it always has been
                  // here; Delete and Archive act on this reply alone.
                  {...buildEmailMenuHandlers(ctx, email, { forward: 'popup', removes: 'message' })}
                />
              </div>

              {/* Expanded Thread Content */}
              {isExpanded && (() => {
                const isBodyLoading = loadingBodies.has(email.id);
                const hasBody = hasLoadedBody(email);

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
                    {/* ONE banner per thread, on the first message (by date)
                        that trips a check. Every message is still ASSESSED —
                        the shield beside each sender shows its own level — but
                        repeating the same banner down a 20-message thread
                        trained readers to ignore it. It must still be the
                        OFFENDING message that carries it: pinning it to the
                        oldest mail once hid a newly arrived spoof entirely
                        (see firstFlaggedEmailId). */}
                    {email.id === firstFlaggedId && (
                      <PhishingWarningBanner
                        emailId={email.id}
                        accountId={messageAccountOf(email, paneAccountId) ?? undefined}
                        onTrusted={() => clearAfterTrust(ctx, email.id, messageAccountOf(email, paneAccountId) ?? undefined)}
                        fromName={email.fromName}
                        fromAddress={email.fromAddress}
                        authStatus={email.authStatus}
                        spamScore={email.spamScore}
                        spamReasons={email.spamReasons}
                        html={email.rawBody}
                      />
                    )}
                    <div className="max-w-none">
                      {isHtml ? (
                        <SandboxedEmailBody key={`${(displayContent || '').length}:${(displayContent || '').slice(0, 32)}`} html={displayContent || '(no content)'} remoteImagesFrom={remoteImageFactsOf(email, paneAccountId)} />
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
                        <AttachmentChips
                          emailId={email.id}
                          accountId={(email as any).accountId}
                          attachments={threadAttachments}
                          size="sm"
                          stopPropagation
                        />
                      </div>
                    )}
                    {/* Reply/Forward buttons - hide if inline reply is active for this email */}
                    {!(showInlineReply && replyingToEmail?.id === email.id) && (
                      <ReplyActionsBar
                        className="mt-4 pt-3 border-t border-border flex items-center gap-2"
                        // Forward inline, under this reply — unlike the
                        // anchor card's, which opens the popup composer.
                        {...buildReplyHandlers(ctx, email, 'inline')}
                      />
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
                    forwardEmail={toForwardSource(email)}
                    // A forward restored by Undo send reopens with what was
                    // written, not empty. The hook only ever holds the draft
                    // of the forward that is open, so it belongs to this card.
                    draft={inlineForwardDraft}
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
