import {
  Reply,
  ReplyAll,
  ChevronDown,
  Paperclip,
  MoreHorizontal,
  Sparkles,
  X,
  Minimize2,
  Bot,
} from 'lucide-react';
import prettyBytes from 'pretty-bytes';
import { useState, useRef, useEffect, useMemo } from 'react';


import { useDraftAutosave } from '../hooks/useDraftAutosave';
import { getDefaultProvider, PolishContext } from '../services/ai-service';
import { useEmailStore } from '../store/email-store';
import { accountDisplayLabel } from '../store/helpers';
import { parseAddresses } from '../utils/email-address';
import { assembleOutgoingHtml, convertToEmailHtml } from '../utils/email-html';
import { reportSendFailure } from '../utils/send-failure';

import { ComposeToolbar } from './ComposeToolbar';
import { EmailInput } from './EmailInput';
import { PolishModal } from './PolishModal';
import { RichTextEditor } from './RichTextEditor';
import { SandboxedEmailBody } from './SandboxedEmailBody';
import { SmtpNotConfiguredBanner } from './SmtpNotConfiguredBanner';
import { useCompose, AttachmentFile, ComposeDraft } from './useCompose';


function formatFileSize(bytes: number): string {
  return prettyBytes(bytes);
}

interface InlineReplyDraft extends ComposeDraft {
  to: string;
  cc: string;
  htmlContent: string;
  attachments: AttachmentFile[];
  isAIDraft?: boolean;
  aiReasoning?: string;
  agentDecisionId?: string;
  /** Message-id of the existing draft opened into this editor — so autosave
   *  edits it in place and discard removes exactly it (not sibling drafts). */
  draftMessageId?: string;
}

interface InlineReplyProps {
  replyToEmail: {
    id: string;
    messageId?: string; // real RFC Message-ID — used as In-Reply-To so the appended draft threads natively (Gmail/Outlook) and isn't orphaned on re-sync
    threadId?: string; // groups the saved draft into this thread (avoids orphaned drafts)
    accountId?: string; // send-as / From-bar account when opened from All Inboxes
    subject: string;
    fromAddress: string;
    fromName: string | null;
    toAddress: string;
    ccAddress: string | null;
    date: number;
    cleanBody: string | null;
    rawBody: string | null; // Original HTML body for preserving email trail structure
  };
  mode: 'reply' | 'replyAll';
  /**
   * Called when the inline reply closes. `dismissed=true` means the user
   * explicitly discarded (X / Discard button / Escape); `false` means a send
   * just completed. Consumers can use this to differentiate session-level
   * "don't show this again" from normal teardown.
   */
  onClose: (opts?: { dismissed?: boolean }) => void;
  onModeChange: (mode: 'reply' | 'replyAll') => void;
  embedded?: boolean; // If true, don't show outer border (when inside thread)
  draft?: InlineReplyDraft; // Restored draft from undo send
  /**
   * Plain-text transcript of the whole thread (buildPolishThreadContext).
   * When provided, AI polish grounds the rewrite in the full conversation
   * instead of just the single email being replied to.
   */
  threadContext?: string;
}

export function InlineReply({ replyToEmail, mode, onClose, onModeChange, embedded = false, draft, threadContext }: InlineReplyProps) {
  const { imapConfig } = useEmailStore();
  // From-account applies ONLY when replying from the unified "All Inboxes" view.
  // The replied mail loaded via the thread has no accountId (only merged rows
  // do), so the reliable source is the store's viewAccountId — set when a unified
  // mail is opened, and null for normal account-inbox opens (→ no From bar,
  // active-account send).
  const accounts = useEmailStore((s) => s.accounts);
  const activeAccountId = useEmailStore((s) => s.activeAccountId);
  const viewAccountId = useEmailStore((s) => s.viewAccountId);
  const isUnifiedView = useEmailStore((s) => s.selectedVirtualFolder === 'virtual-unified');
  const replyAccountId = ((replyToEmail as any).accountId as string | undefined) ?? (viewAccountId ?? undefined);
  // Show the From bar ONLY in All Inboxes AND when the mail is from a DIFFERENT
  // account than the active one (replying to your own active-account mail needs
  // no bar). Send-as still uses replyAccountId regardless, so sends stay correct.
  const fromAccount = (isUnifiedView && replyAccountId && replyAccountId !== activeAccountId)
    ? accounts.find((a) => a.id === replyAccountId)
    : null;

  const {
    to, setTo, pendingTo, setPendingTo,
    cc, setCc, pendingCc, setPendingCc,
    subject, setSubject,
    htmlBody, setHtmlBody,
    plainBody, setPlainBody,
    attachments, setAttachments,
    sending, setSending,
    showPolishModal, setShowPolishModal,
    polishMode, setPolishMode,
    selectedText, setSelectedText,
    showContextMenu, setShowContextMenu,
    contextMenuPosition, setContextMenuPosition,
    contextMenuRef,
    handleEditorChange,
    handleAttach,
    getSignature,
    focusEditor,
    sendEmail
  } = useCompose({
    initialDraft: draft
  });

  // Auto-save draft to IMAP
  const { markDiscarded } = useDraftAutosave({
    to,
    cc,
    subject,
    body: plainBody,
    htmlBody,
    // Use the parent's REAL Message-ID (not the internal row id) so the appended
    // IMAP draft carries a valid In-Reply-To/References and the server threads it
    // under this conversation — otherwise it comes back on sync as a standalone
    // email with a fresh thread_id (an orphaned, ever-respawning draft).
    inReplyTo: replyToEmail.messageId || replyToEmail.id,
    threadId: (replyToEmail as any).threadId,
    initialDraftMessageId: draft?.draftMessageId,
    // Owning account — routes save/delete to the correct per-account DB + engine.
    accountId: replyAccountId,
  });

  const [showDropdown, setShowDropdown] = useState(false);
  const [showQuoted, setShowQuoted] = useState(false);
  const [isMinimized, setIsMinimized] = useState(false);
  const [showRecipientFields, setShowRecipientFields] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const hasAIProvider = !!getDefaultProvider();

  // Calculate initial recipients based on mode
  const getInitialRecipients = () => {
    if (mode === 'reply') {
      return {
        to: replyToEmail.fromAddress,
        cc: '',
      };
    } else {
      // Reply All
      const myEmail = imapConfig?.username || '';
      const allRecipients = [
        ...parseAddresses(replyToEmail.toAddress),
        ...parseAddresses(replyToEmail.ccAddress),
      ].filter(e => e && e.toLowerCase() !== myEmail.toLowerCase() && e.toLowerCase() !== replyToEmail.fromAddress.toLowerCase());

      return {
        to: replyToEmail.fromAddress,
        cc: allRecipients.join(', '),
      };
    }
  };

  // Initialize recipients when mode changes (skip if restoring from draft)
  const draftUsedRef = useRef(!!draft);
  useEffect(() => {
    if (draftUsedRef.current) {
      draftUsedRef.current = false;
      return;
    }
    const initial = getInitialRecipients();
    setTo(initial.to);
    setCc(initial.cc);

    // Set subject
    const newSubject = replyToEmail.subject.startsWith('Re:') ? replyToEmail.subject : `Re: ${replyToEmail.subject}`;
    setSubject(newSubject);
  }, [mode, replyToEmail.fromAddress]);

  // Parse recipients for display
  const toEmails = to ? to.split(',').map(e => e.trim()).filter(Boolean) : [];
  const ccEmails = cc ? cc.split(',').map(e => e.trim()).filter(Boolean) : [];

  // The signature is kept OUT of the TipTap editor (its schema flattens tables/
  // flex) — captured once here and appended verbatim on send + shown in the
  // preview below, so it renders exactly as designed.
  // Signature resolves from the SENDING account (per-account signatures) — reply
  // from Gmail uses Gmail's signature, etc. Falls back to the global default.
  // Signature resolves from the SEND-AS account (replyAccountId), not the
  // display-gated fromAccount, so it's right even when the bar is hidden.
  const signatureHtml = useMemo(() => getSignature('reply', replyAccountId), [replyAccountId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Restore a saved draft into the editor (signature stays separate).
  useEffect(() => {
    if (draft?.htmlContent) {
      setHtmlBody(draft.htmlContent);
      const tempDiv = document.createElement('div');
      tempDiv.innerHTML = draft.htmlContent;
      setPlainBody(tempDiv.textContent || tempDiv.innerText || '');
    }
  }, []);

  // Focus editor on mount
  useEffect(() => {
    const timer = setTimeout(() => {
      focusEditor('#inline-reply-compose');
    }, 100);
    return () => clearTimeout(timer);
  }, []);

  // Close dropdown on click outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setShowDropdown(false);
      }
      if (contextMenuRef.current && !contextMenuRef.current.contains(e.target as Node)) {
        setShowContextMenu(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Override handleSend for inline specifically
  const handleSend = async () => {
    // Merge committed emails with any pending typed text that looks like an email
    const mergeEmails = (committed: string, pending: string) => {
      const rawCommitted = committed.split(',').map(e => e.trim()).filter(Boolean);
      const rawPending = pending.split(',').map(e => e.trim()).filter(e => e.includes('@'));
      return [...new Set([...rawCommitted, ...rawPending])];
    };

    const finalTo = mergeEmails(to, pendingTo);
    const finalCc = mergeEmails(cc, pendingCc);

    if (!plainBody.trim() || finalTo.length === 0) return;

    setSending(true);
    try {
      // Build quoted content - preserve original HTML structure
      const originalDate = new Date(replyToEmail.date * 1000).toLocaleString();
      const originalHtmlBody = replyToEmail.rawBody;
      const plainTextBody = replyToEmail.cleanBody || '';

      // Use original HTML if available, otherwise convert plain text
      const quotedBodyHtml = originalHtmlBody
        ? originalHtmlBody
        : plainTextBody.split('\n').map(line => `<p>${line || '&nbsp;'}</p>`).join('');

      const quotedHtml = `
<blockquote style="margin: 0 0 0 0.8ex; border-left: 1px solid #ccc; padding-left: 1ex;">
<p style="margin: 0 0 10px 0;"><strong>On ${originalDate}, ${replyToEmail.fromName || replyToEmail.fromAddress} wrote:</strong></p>
<div>${quotedBodyHtml}</div>
</blockquote>`;

      // Convert user's TipTap HTML to email-friendly format with inline styles
      const emailFriendlyBody = convertToEmailHtml(htmlBody);
      const fullHtml = assembleOutgoingHtml(emailFriendlyBody, signatureHtml, quotedHtml);

      // Do NOT delete the draft here — keep it until the send is durably
      // persisted (the store removes it via draftCleanup on commit). markDiscarded
      // stops the autosave churn without leaving a window where the mail exists
      // only in memory (the crash-loses-the-email fix).
      const ownedDraftId = markDiscarded();

      // Resolve linked agent proposal as "approved" when user sent the AI draft
      if (draft?.agentDecisionId) {
        try {
          await (window.electronAPI.agent as any).resolveProposal(draft.agentDecisionId, true, 'reply');
        } catch {}
      }

      onClose({ dismissed: false });

      await sendEmail({
        to: finalTo,
        cc: finalCc.length > 0 ? finalCc : undefined,
        subject,
        body: plainBody,
        htmlBody: fullHtml,
        // In-Reply-To MUST be the parent's real RFC Message-ID (wrapped in
        // angle brackets), NOT the internal row id. The row id produced a
        // malformed In-Reply-To header (breaking threading in the recipient's
        // client) and — critically — defeated markThreadRepliesAnswered on the
        // main side (it looks the parent up BY message-id), so the thread's
        // pending reply-proposal was never resolved and the pipeline could
        // re-draft the very reply the user just sent. Mirrors the draft-save
        // and auto-send paths, which already use the Message-ID.
        inReplyTo: replyToEmail.messageId
          ? (replyToEmail.messageId.startsWith('<') ? replyToEmail.messageId : `<${replyToEmail.messageId}>`)
          : replyToEmail.id,
        // Send AS the account that owns this mail (unified "All Inboxes" replies).
        accountId: replyAccountId,
        attachments: attachments.map((a: AttachmentFile) => ({ ...a, filename: a.filename || 'attachment' })) as any,
        draftCleanup: {
          threadId: (replyToEmail as any).threadId,
          messageId: ownedDraftId ?? draft?.draftMessageId,
          subject,
          to: finalTo.join(', '),
          accountId: replyAccountId,
        },
        draft: {
          to: finalTo.join(', '),
          cc: finalCc.join(', '),
          htmlContent: htmlBody,
          attachments,
          replyToEmail,
          mode,
          isInline: true,
        },
      });
    } catch (error) {
      reportSendFailure(error);
    } finally {
      setSending(false);
    }
  };

  // Dismiss the inline reply. When dismissing an AI-drafted reply, resolve
  // the linked agent proposal as rejected so it won't auto-reopen next time
  // the thread is viewed. Also delete any saved draft (IMAP + local mirror row)
  // so "discard" truly removes it — otherwise the unmount effect would
  // auto-save the current content back, or a preset AI draft would reappear
  // on next open.
  const handleDismiss = () => {
    if (draft?.agentDecisionId) {
      try {
        (window.electronAPI.agent as any).resolveProposal(draft.agentDecisionId, false, 'dismissed');
      } catch {}
    }
    // Optimistic discard: markDiscarded() blocks the unmount re-save and returns
    // the draft's current message-id; discardDraft() removes it from every view
    // INSTANTLY, deletes it on the server in the background, and restores it if
    // that fails. onClose then tears down the compose box (and navigates back to
    // the listing for a standalone draft) with no waiting on IMAP.
    const messageId = markDiscarded() || draft?.draftMessageId;
    (window.electronAPI as any).drafts?.debug?.('InlineReply.handleDismiss', {
      messageId,
      draftMessageId: draft?.draftMessageId,
      replyAccountId,
      threadId: (replyToEmail as any).threadId,
      isUnifiedView,
      viewAccountId,
      activeAccountId,
    });
    if (messageId) {
      useEmailStore.getState().discardDraft(messageId, (replyToEmail as any).threadId, replyAccountId);
    }
    onClose({ dismissed: true });
  };

  // Keyboard shortcuts
  const handleSendRef = useRef(handleSend);
  handleSendRef.current = handleSend;
  const onCloseRef = useRef(handleDismiss);
  onCloseRef.current = handleDismiss;

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const isMod = e.metaKey || e.ctrlKey;

      // Cmd/Ctrl+Enter -> Send
      if (isMod && e.key === 'Enter') {
        e.preventDefault();
        handleSendRef.current();
        return;
      }

      // Cmd/Ctrl+Shift+C -> Show/focus CC
      if (isMod && e.shiftKey && e.key.toLowerCase() === 'c') {
        e.preventDefault();
        setShowRecipientFields(true);
        requestAnimationFrame(() => {
          const ccInput = document.querySelector('[data-inline-cc] input') as HTMLInputElement;
          ccInput?.focus();
        });
        return;
      }

      // Escape -> Discard/Close
      if (e.key === 'Escape') {
        e.preventDefault();
        onCloseRef.current();
        return;
      }
    };

    // Use capture phase to ensure it runs before TipTap might intercept
    document.addEventListener('keydown', handleKeyDown, true);
    return () => document.removeEventListener('keydown', handleKeyDown, true);
  }, []);

  const handleContextMenu = (e: React.MouseEvent) => {
    if (!hasAIProvider) return;
    const selection = window.getSelection();
    const selected = selection?.toString().trim() || '';
    if (!selected) return;
    e.preventDefault();
    setSelectedText(selected);
    setContextMenuPosition({ x: e.clientX, y: e.clientY });
    setShowContextMenu(true);
  };

  const getPolishContext = (polishType: 'full' | 'selection'): PolishContext => ({
    mode: mode === 'reply' ? 'reply' : 'replyAll',
    polishMode: polishType,
    subject: subject || undefined,
    recipient: toEmails[0] || undefined,
    fullBody: plainBody || undefined,
    selectedText: polishType === 'selection' ? selectedText : undefined,
    // Whole-thread transcript (preferred). emailTrail stays as the legacy
    // fallback for render sites that don't pass threadContext.
    threadContext: threadContext || undefined,
    emailTrail: replyToEmail.cleanBody || undefined,
  });

  const handlePolishAccept = (result: { subject?: string; body: string }) => {
    if (polishMode === 'selection' && selectedText) {
      const escapedSelected = selectedText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const newHtml = htmlBody.replace(new RegExp(escapedSelected, 'g'), result.body);
      setHtmlBody(newHtml);
      const tempDiv = document.createElement('div');
      tempDiv.innerHTML = newHtml;
      setPlainBody(tempDiv.textContent || tempDiv.innerText || '');
    } else {
      setHtmlBody(result.body);
      const tempDiv = document.createElement('div');
      tempDiv.innerHTML = result.body;
      setPlainBody(tempDiv.textContent || tempDiv.innerText || '');
    }
  };

  if (isMinimized) {
    return (
      <div className="border border-border rounded-lg bg-card mt-4">
        <button
          onClick={() => setIsMinimized(false)}
          className="w-full p-3 flex items-center justify-between hover:bg-accent/50 transition-colors"
        >
          <div className="flex items-center gap-2">
            <Reply className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm text-muted-foreground">
              {mode === 'reply' ? 'Reply to' : 'Reply all to'} {replyToEmail.fromName || replyToEmail.fromAddress}
            </span>
          </div>
          <X className="h-4 w-4 text-muted-foreground hover:text-foreground" onClick={(e) => { e.stopPropagation(); handleDismiss(); }} />
        </button>
      </div>
    );
  }

  const containerClass = embedded
    ? "bg-card overflow-hidden"
    : "border border-border rounded-lg bg-card mt-4 overflow-hidden";

  return (
    <div className={containerClass}>
      {/* Header with reply type selector */}
      <div className="flex items-center justify-between p-3 border-b border-border bg-muted/30">
        <div className="relative" ref={dropdownRef}>
          <button
            onClick={() => setShowDropdown(!showDropdown)}
            className="flex items-center gap-2 text-sm hover:bg-accent px-2 py-1 rounded transition-colors"
          >
            {mode === 'reply' ? <Reply className="h-4 w-4" /> : <ReplyAll className="h-4 w-4" />}
            <span className="font-medium">
              {toEmails.length > 0 ? toEmails[0] : replyToEmail.fromAddress}
              {toEmails.length > 1 && (
                <span className="text-muted-foreground font-normal ml-1">
                  +{toEmails.length - 1}
                </span>
              )}
            </span>
            <ChevronDown className="h-3 w-3 text-muted-foreground" />
          </button>

          {showDropdown && (
            <div className="absolute top-full left-0 mt-1 bg-card border border-border rounded-lg shadow-xl py-1 z-50 min-w-[150px]">
              <button
                onClick={() => { onModeChange('reply'); setShowDropdown(false); }}
                className={`flex items-center gap-2 w-full px-3 py-2 text-sm hover:bg-accent transition-colors ${mode === 'reply' ? 'bg-accent/50' : ''}`}
              >
                <Reply className="h-4 w-4" />
                Reply
              </button>
              <button
                onClick={() => { onModeChange('replyAll'); setShowDropdown(false); }}
                className={`flex items-center gap-2 w-full px-3 py-2 text-sm hover:bg-accent transition-colors ${mode === 'replyAll' ? 'bg-accent/50' : ''}`}
              >
                <ReplyAll className="h-4 w-4" />
                Reply All
              </button>
              <div className="border-t border-border my-1" />
              <button
                onClick={() => { setShowRecipientFields(!showRecipientFields); setShowDropdown(false); }}
                className="flex items-center gap-2 w-full px-3 py-2 text-sm hover:bg-accent transition-colors"
              >
                Edit Recipients
              </button>
            </div>
          )}
        </div>

        <div className="flex items-center gap-1">
          <button
            onClick={() => setIsMinimized(true)}
            className="p-1.5 hover:bg-accent rounded transition-colors"
            title="Minimize"
          >
            <Minimize2 className="h-4 w-4 text-muted-foreground" />
          </button>
          <button
            onClick={handleDismiss}
            className="p-1.5 hover:bg-accent rounded transition-colors"
            title="Discard"
          >
            <X className="h-4 w-4 text-muted-foreground" />
          </button>
        </div>
      </div>

      {/* From: which account this reply is sent AS — always visible so the user
          never sends from the wrong mailbox (esp. in the unified view). */}
      {fromAccount && (
        <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border text-xs text-muted-foreground">
          <span>From:</span>
          <span className="h-2.5 w-2.5 rounded-full shrink-0" style={{ backgroundColor: fromAccount.color ?? '#2563eb' }} />
          <span className="font-medium text-foreground truncate">{accountDisplayLabel(accounts, fromAccount.id)}</span>
        </div>
      )}

      {/* Sending not set up — message will queue in the Outbox */}
      <SmtpNotConfiguredBanner />

      {/* AI Drafted notice */}
      {draft?.isAIDraft && (
        <div className="flex items-start gap-2 px-3 py-2 bg-violet-500/5 border-b border-violet-500/20 text-xs">
          <Bot className="h-3.5 w-3.5 text-violet-500 flex-shrink-0 mt-0.5" />
          <div className="min-w-0 flex-1">
            <span className="font-medium text-violet-600 dark:text-violet-400">AI drafted</span>
            <span className="text-muted-foreground ml-1.5">
              Review, edit, and send — or discard to dismiss.
            </span>
            {draft.aiReasoning && (
              <div className="text-muted-foreground mt-0.5 italic truncate">
                {draft.aiReasoning}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Editable recipient fields */}
      {showRecipientFields && (
        <div className="border-b border-border bg-muted/10">
          {/* To field */}
          <div className="flex items-center border-b border-border/50">
            <label className="pl-3 pr-[10px] py-2 text-xs text-muted-foreground w-auto min-h-[44px] flex items-center">To</label>
            <EmailInput
              value={to}
              onChange={setTo}
              onPendingChange={setPendingTo}
              placeholder="Recipients"
              onTabOut={() => {
                const ccInput = document.querySelector('[data-inline-cc] input') as HTMLInputElement;
                if (ccInput) ccInput.focus();
              }}
            />
          </div>

          {/* Cc field */}
          <div className="flex items-center" data-inline-cc>
            <label className="pl-3 pr-[10px] py-2 text-xs text-muted-foreground w-auto min-h-[44px] flex items-center">Cc</label>
            <EmailInput
              value={cc}
              onChange={setCc}
              onPendingChange={setPendingCc}
              placeholder="Cc recipients"
              onTabOut={() => {
                const editor = document.querySelector('#inline-reply-compose .ProseMirror, #inline-reply-compose [contenteditable="true"]') as HTMLElement;
                if (editor) editor.focus();
              }}
            />
          </div>
        </div>
      )}

      {/* Cc summary when recipient fields are hidden */}
      {!showRecipientFields && ccEmails.length > 0 && (
        <button
          onClick={() => setShowRecipientFields(true)}
          className="w-full px-3 py-2 text-xs text-muted-foreground border-b border-border bg-muted/10 text-left hover:bg-muted/20 transition-colors"
        >
          <span className="font-medium">Cc:</span> {ccEmails.join(', ')}
        </button>
      )}

      {/* Editor Area */}
      <div className="min-h-[150px]" onContextMenu={handleContextMenu}>
        <RichTextEditor
          content={htmlBody}
          onChange={handleEditorChange}
          placeholder="Write your reply..."
          className="border-0 rounded-none"
        />
      </div>

      {/* Signature preview — rendered faithfully (SandboxedEmailBody), not
          editable, so its pasted layout survives instead of being flattened. */}
      {signatureHtml && (
        <div className="border-t border-border">
          <SandboxedEmailBody html={signatureHtml} className="px-3 py-2 text-sm" heightPadding={12} blockRemoteImages={false} />
        </div>
      )}

      {/* Show quoted content toggle */}
      <div className="px-3 py-2 border-t border-border">
        <button
          onClick={() => setShowQuoted(!showQuoted)}
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          <MoreHorizontal className="h-4 w-4" />
        </button>
        {showQuoted && (
          <div className="mt-2 p-3 bg-muted/30 rounded text-sm text-muted-foreground max-h-40 overflow-y-auto">
            <div className="font-medium mb-1">
              On {new Date(replyToEmail.date * 1000).toLocaleString()}, {replyToEmail.fromName || replyToEmail.fromAddress} wrote:
            </div>
            <div className="whitespace-pre-wrap border-l-2 border-muted pl-3">
              {replyToEmail.cleanBody || '(no content)'}
            </div>
          </div>
        )}
      </div>

      {/* Footer with Send and actions */}
      <ComposeToolbar
        sending={sending}
        hasAIProvider={hasAIProvider}
        plainBody={plainBody}
        hasRecipients={!!to.trim()}
        onSend={handleSend}
        onAttach={handleAttach}
        onPolish={() => {
          setPolishMode('full');
          setShowPolishModal(true);
        }}
        onDiscard={handleDismiss}
        isInline={true}
      />

      {/* Attachment list */}
      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-2 px-3 py-2 border-t border-border">
          {attachments.map((file, i) => (
            <div key={i} className="flex items-center gap-1 px-2 py-1 bg-muted rounded text-xs">
              <Paperclip className="h-3 w-3" />
              <span className="max-w-[150px] truncate">{file.filename}</span>
              <span className="text-muted-foreground">({formatFileSize(file.size)})</span>
              <button onClick={() => setAttachments(prev => prev.filter((_, j) => j !== i))} className="ml-1 hover:text-destructive">
                <X className="h-3 w-3" />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Polish Modal */}
      {showPolishModal && (
        <PolishModal
          originalText={polishMode === 'selection' ? selectedText : plainBody}
          originalSubject={subject}
          context={getPolishContext(polishMode)}
          onAccept={handlePolishAccept}
          onClose={() => setShowPolishModal(false)}
        />
      )}

      {/* Context Menu */}
      {showContextMenu && (
        <div
          ref={contextMenuRef}
          className="fixed bg-card border border-border rounded-lg shadow-xl py-1 z-[200]"
          style={{ left: contextMenuPosition.x, top: contextMenuPosition.y }}
        >
          <button
            onClick={() => {
              setShowContextMenu(false);
              setPolishMode('selection');
              setShowPolishModal(true);
            }}
            className="flex items-center gap-2 w-full px-4 py-2 text-sm hover:bg-accent transition-colors"
          >
            <Sparkles className="h-4 w-4 text-primary" />
            Polish Selected Text
          </button>
        </div>
      )}
    </div>
  );
}
