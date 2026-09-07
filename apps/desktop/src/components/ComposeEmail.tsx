import {
  X,
  Send,
  Paperclip,
  Trash2,
  Maximize2,
  Minimize2,
  ChevronDown,
  ChevronUp,
  Wand2,
  Sparkles,
} from 'lucide-react';
import prettyBytes from 'pretty-bytes';
import { useState, useEffect, useRef, useMemo } from 'react';


import { MOD_KEY } from '../config/keyboard-shortcuts';
import { useDraftAutosave } from '../hooks/useDraftAutosave';
import { getDefaultProvider, PolishContext } from '../services/ai-service';
import { useEmailStore } from '../store/email-store';
import { accountDisplayLabel } from '../store/helpers';
import { normalizeIdentities, sendAsFrom } from '../store/identities';
import { parseAddresses } from '../utils/email-address';
import { assembleOutgoingHtml, convertToEmailHtml } from '../utils/email-html';
import { reportSendFailure } from '../utils/send-failure';

import { ComposeToolbar } from './ComposeToolbar';
import { EmailInput } from './EmailInput';
import { PolishModal } from './PolishModal';
import { RichTextEditor } from './RichTextEditor';
import { SandboxedEmailBody } from './SandboxedEmailBody';
import { SmtpNotConfiguredBanner } from './SmtpNotConfiguredBanner';
import { Tooltip } from './Tooltip';
import { useCompose, AttachmentFile } from './useCompose';


// AttachmentFile comes from useCompose

function formatFileSize(bytes: number): string {
  return prettyBytes(bytes);
}

interface ComposeEmailProps {
  mode: 'new' | 'reply' | 'replyAll' | 'forward';
  replyToEmail?: {
    id: string;
    subject: string;
    fromAddress: string;
    fromName: string | null;
    toAddress: string;
    ccAddress: string | null;
    date: number;
    cleanBody: string | null;
    rawBody: string | null; // Original HTML body for preserving email trail structure
  };
  draft?: any; // To restore draft on Undo
  /** AI-drafted reply body (plain text) — prefilled when agent suggests reply */
  draftBody?: string;
  onClose: () => void;
}

export function ComposeEmail({ mode, replyToEmail, draft, draftBody, onClose }: ComposeEmailProps) {
  const { imapConfig } = useEmailStore();
  // From-account (and the From bar) applies ONLY to a reply/forward whose mail
  // belongs to a DIFFERENT account than the active one (unified "All Inboxes").
  // New mail and same-account flows → no From bar, active-account send.
  const accounts = useEmailStore((s) => s.accounts);
  const activeAccountId = useEmailStore((s) => s.activeAccountId);
  const replyAccountId = mode !== 'new' ? ((replyToEmail as any)?.accountId as string | undefined) : undefined;
  const fromAccount = (replyAccountId && replyAccountId !== activeAccountId)
    ? accounts.find((a) => a.id === replyAccountId)
    : null;
  // The account this compose actually sends through: the replied mail's owner in a
  // cross-account reply, otherwise the active account. Its identities feed the
  // "From" picker (send-as an alias WITHIN that account).
  const sendingAccount = fromAccount ?? accounts.find((a) => a.id === activeAccountId) ?? null;
  const identities = sendingAccount ? normalizeIdentities(sendingAccount.email, sendingAccount.identities) : [];
  const canPickIdentity = identities.length > 1;
  // Chosen From header (undefined = the account's own address / default). Resolved
  // through sendAsFrom on send so a stale/unknown value can never spoof an alias.
  const [fromIdentity, setFromIdentity] = useState<string | undefined>(undefined);
  const resolvedFrom = sendingAccount ? sendAsFrom(sendingAccount.email, fromIdentity, sendingAccount.identities) : undefined;
  const FromBar = () =>
    (fromAccount || canPickIdentity) ? (
      <div className="flex items-center gap-2 px-4 py-1.5 border-b border-border text-xs text-muted-foreground">
        <span>From:</span>
        {fromAccount && (
          <span className="h-2.5 w-2.5 rounded-full shrink-0" style={{ backgroundColor: fromAccount.color ?? '#2563eb' }} />
        )}
        {canPickIdentity ? (
          <select
            aria-label="Send as"
            className="bg-transparent font-medium text-foreground truncate outline-none cursor-pointer max-w-full"
            value={fromIdentity ?? (sendingAccount?.email ?? '')}
            onChange={(e) => setFromIdentity(e.target.value)}
          >
            {identities.map((identity) => (
              <option key={identity} value={identity}>{identity}</option>
            ))}
          </select>
        ) : (
          <span className="font-medium text-foreground truncate">{fromAccount ? accountDisplayLabel(accounts, fromAccount.id) : ''}</span>
        )}
      </div>
    ) : null;

  const {
    to, setTo, pendingTo, setPendingTo,
    cc, setCc, pendingCc, setPendingCc,
    bcc, setBcc, pendingBcc, setPendingBcc,
    subject, setSubject,
    htmlBody, setHtmlBody,
    plainBody, setPlainBody,
    attachments, setAttachments,
    sending, setSending,
    showCc, setShowCc,
    showBcc, setShowBcc,
    showPolishModal, setShowPolishModal,
    polishMode, setPolishMode,
    selectedText, setSelectedText,
    showContextMenu, setShowContextMenu,
    contextMenuPosition, setContextMenuPosition,
    contextMenuRef,
    handleEditorChange,
    mergeEmails,
    handleAttach,
    removeAttachment,
    getSignature,
    focusEditor,
    sendEmail
  } = useCompose({
    initialDraft: draft
  });

  // Auto-save draft to IMAP. When EDITING an existing standalone draft (opened
  // from the Drafts list), thread the draft's own thread/message-id/account so it
  // replaces + deletes the right row instead of spawning a new one.
  const { markDiscarded } = useDraftAutosave({
    to,
    cc,
    bcc,
    subject,
    body: plainBody,
    htmlBody,
    inReplyTo: mode !== 'new' ? replyToEmail?.id : undefined,
    threadId: (draft as any)?.threadId,
    initialDraftMessageId: (draft as any)?.draftMessageId,
    accountId: (draft as any)?.accountId ?? replyAccountId,
  });

  const [quotedHtml, setQuotedHtml] = useState('');
  // Signature is kept OUT of the TipTap editor (its schema flattens tables/flex)
  // — appended verbatim on send + shown in the preview, so it renders as designed.
  // Per-account signature: reply/forward use the replied mail's owning account
  // (unified view); new mail uses the active account's default.
  const signatureHtml = useMemo(() => getSignature(mode === 'new' ? 'new' : 'reply', mode === 'new' ? undefined : (replyToEmail as any)?.accountId), [mode]); // eslint-disable-line react-hooks/exhaustive-deps
  const [isMinimized, setIsMinimized] = useState(false);
  const [readReceipt, setReadReceipt] = useState(false);
  const [isFullScreen, setIsFullScreen] = useState(false);
  const [showDiscardConfirm, setShowDiscardConfirm] = useState(false);
  const [dontAskDiscard, setDontAskDiscard] = useState(false);

  // Check if AI provider is configured
  const hasAIProvider = !!getDefaultProvider();

  // Get email trail for replies
  const getEmailTrail = (): string | undefined => {
    if (mode === 'reply' || mode === 'replyAll') {
      return replyToEmail?.cleanBody || undefined;
    }
    return undefined;
  };

  // Build polish context
  const getPolishContext = (polishType: 'full' | 'selection'): PolishContext => ({
    mode,
    polishMode: polishType,
    subject: subject || undefined,
    recipient: to || undefined,
    fullBody: plainBody || undefined,
    selectedText: polishType === 'selection' ? selectedText : undefined,
    emailTrail: getEmailTrail(),
  });

  // Handle polished result acceptance
  const handlePolishAccept = (result: { subject?: string; body: string }) => {
    if (polishMode === 'selection' && selectedText) {
      // Selection mode - replace only the selected text in HTML
      // The result.body is plain text for selection mode
      const escapedSelected = selectedText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const newHtml = htmlBody.replace(new RegExp(escapedSelected, 'g'), result.body);
      setHtmlBody(newHtml);
      // Update plain text
      const tempDiv = document.createElement('div');
      tempDiv.innerHTML = newHtml;
      setPlainBody(tempDiv.textContent || tempDiv.innerText || '');
    } else {
      // Full mode - replace entire email
      // Update subject if provided (for new emails)
      if (result.subject && (mode === 'new' || mode === 'forward')) {
        setSubject(result.subject);
      }

      // Body is already HTML from AI, use directly
      setHtmlBody(result.body);
      // Extract plain text from HTML for plainBody
      const tempDiv = document.createElement('div');
      tempDiv.innerHTML = result.body;
      setPlainBody(tempDiv.textContent || tempDiv.innerText || '');
    }
  };

  // Handle right-click context menu
  const handleContextMenu = (e: React.MouseEvent) => {
    if (!hasAIProvider) return;

    // Get selected text from window selection
    const selection = window.getSelection();
    const selected = selection?.toString().trim() || '';

    // Only show context menu if text is selected
    if (!selected) return;

    e.preventDefault();
    setSelectedText(selected);
    setContextMenuPosition({ x: e.clientX, y: e.clientY });
    setShowContextMenu(true);
  };

  // Pre-fill fields based on mode
  useEffect(() => {
    if (draft) return; // Do not overwrite restored drafts

    if (mode === 'new') {
      // Blank lines for typing space; the signature is kept separate
      // (signatureHtml) so TipTap can't flatten it — appended on send + previewed.
      setHtmlBody('<p></p><p></p><p></p>');
      return;
    }

    if (!replyToEmail) return;

    const originalDate = new Date(replyToEmail.date * 1000).toLocaleString();

    // Use original HTML body to preserve email trail structure
    // Fall back to plain text conversion only if HTML is not available
    const originalHtmlBody = replyToEmail.rawBody;
    const plainTextBody = replyToEmail.cleanBody || '';

    // Create the quoted content header
    const createQuotedHeader = (prefix: string, extraInfo = '') => {
      return `<p><strong>---------- ${prefix} ----------</strong><br>
<strong>From:</strong> ${replyToEmail.fromName || replyToEmail.fromAddress}<br>
<strong>Date:</strong> ${originalDate}<br>
<strong>Subject:</strong> ${replyToEmail.subject}${extraInfo}</p>`;
    };

    // Build quoted HTML - stored separately to preserve original formatting
    // TipTap would corrupt complex HTML, so we keep it outside the editor
    const buildQuotedHtml = (prefix: string, extraInfo = '') => {
      const quotedBodyHtml = originalHtmlBody
        ? originalHtmlBody
        : plainTextBody.split('\n').map(line => `<p>${line || '&nbsp;'}</p>`).join('');

      return `
<blockquote style="margin: 0 0 0 0.8ex; border-left: 1px solid #ccc; padding-left: 1ex;">
${createQuotedHeader(prefix, extraInfo)}
<div>${quotedBodyHtml}</div>
</blockquote>`;
    };

    // Set up editor content (user's compose area only) with signature
    // If AI draft body is provided, convert to HTML paragraphs and prepend
    const draftHtml = draftBody
      ? draftBody.split('\n').map(line => `<p>${line || '&nbsp;'}</p>`).join('')
      : '';
    const editorContent = draftHtml || '<p></p>';

    switch (mode) {
      case 'reply':
        setTo(replyToEmail.fromAddress);
        setSubject(replyToEmail.subject.startsWith('Re:') ? replyToEmail.subject : `Re: ${replyToEmail.subject}`);
        setHtmlBody(editorContent);
        setQuotedHtml(buildQuotedHtml('Original Message'));
        break;

      case 'replyAll': {
        setTo(replyToEmail.fromAddress);
        // Add other recipients to CC (excluding self)
        const myEmail = imapConfig?.username || '';
        const allRecipients = [
          ...parseAddresses(replyToEmail.toAddress),
          ...parseAddresses(replyToEmail.ccAddress),
        ].filter(e => e && e.toLowerCase() !== myEmail.toLowerCase() && e.toLowerCase() !== replyToEmail.fromAddress.toLowerCase());
        if (allRecipients.length > 0) {
          setCc(allRecipients.join(', '));
          setShowCc(true);
        }
        setSubject(replyToEmail.subject.startsWith('Re:') ? replyToEmail.subject : `Re: ${replyToEmail.subject}`);
        setHtmlBody(editorContent);
        setQuotedHtml(buildQuotedHtml('Original Message'));
        break;
      }

      case 'forward':
        setSubject(replyToEmail.subject.startsWith('Fwd:') ? replyToEmail.subject : `Fwd: ${replyToEmail.subject}`);
        setHtmlBody(editorContent);
        setQuotedHtml(buildQuotedHtml('Forwarded Message', `<br><strong>To:</strong> ${replyToEmail.toAddress}`));
        break;
    }
  }, [mode, replyToEmail, draftBody, imapConfig]);

  // Discard the composer's draft. Routes through the store's discardDraft so the
  // Drafts LIST updates optimistically (deleteDraft alone only hits the DB/IMAP,
  // leaving the just-discarded row visible until the next sync). markDiscarded
  // blocks the unmount re-save and hands us the draft's current message-id.
  const discardAndClose = () => {
    const mid = markDiscarded() || (draft as any)?.draftMessageId;
    if (mid) {
      useEmailStore.getState().discardDraft(
        mid,
        (draft as any)?.threadId,
        (draft as any)?.accountId ?? replyAccountId,
      );
    }
    onClose();
  };

  const handleDiscard = () => {
    if (!(to || subject || plainBody)) {
      // Nothing typed — nothing persisted worth confirming; just clean up + close.
      discardAndClose();
      return;
    }
    // User previously opted out of confirmation → discard immediately.
    if (localStorage.getItem('sarvinbox-skip-discard-confirm') === 'true') {
      discardAndClose();
      return;
    }
    setDontAskDiscard(false);
    setShowDiscardConfirm(true);
  };

  const confirmDiscard = () => {
    if (dontAskDiscard) {
      localStorage.setItem('sarvinbox-skip-discard-confirm', 'true');
    }
    setShowDiscardConfirm(false);
    discardAndClose();
  };

  const handleSend = async () => {
    const finalTo = mergeEmails(to, pendingTo);
    const finalCc = mergeEmails(cc, pendingCc);
    const finalBcc = mergeEmails(bcc, pendingBcc);

    if (finalTo.length === 0) {
      alert('Please enter a recipient');
      return;
    }

    setSending(true);
    try {
      const emailFriendlyBody = convertToEmailHtml(htmlBody);
      const fullHtmlBody = assembleOutgoingHtml(emailFriendlyBody, signatureHtml, quotedHtml);
      // Do NOT delete the draft here. markDiscarded stops the autosave churn (and
      // blocks the unmount re-save), but the draft row stays in the DB until the
      // send is durably persisted — the store deletes it via draftCleanup once the
      // send commits. This is the fix for "quit within the undo window loses the
      // whole email": the mail is never memory-only, and the draft is the backstop.
      const ownedDraftId = markDiscarded();
      const cleanupAccountId = (draft as any)?.accountId ?? replyAccountId;
      onClose();

      await sendEmail({
        to: finalTo,
        cc: finalCc.length > 0 ? finalCc : undefined,
        bcc: finalBcc.length > 0 ? finalBcc : undefined,
        subject,
        body: plainBody, // Plain text fallback
        htmlBody: fullHtmlBody, // Email-friendly HTML with inline styles
        inReplyTo: mode !== 'new' ? replyToEmail?.id : undefined,
        // Send AS the replied mail's owning account (unified view). undefined = active.
        accountId: mode !== 'new' ? (replyToEmail as any)?.accountId : undefined,
        // Send-as identity/alias header From within that account (undefined = default).
        from: resolvedFrom,
        requestReadReceipt: readReceipt,
        attachments: attachments.map(a => ({ ...a, filename: a.filename || a.name || 'attachment' })) as any,
        draftCleanup: {
          threadId: (draft as any)?.threadId,
          messageId: ownedDraftId ?? (draft as any)?.draftMessageId,
          subject,
          to: finalTo.join(', '),
          accountId: cleanupAccountId,
        },
        draft: {
          to: finalTo.join(', '),
          cc: finalCc.join(', '),
          bcc: finalBcc.join(', '),
          subject,
          htmlContent: htmlBody,
          attachments,
          replyToEmail,
          mode,
          isInline: false,
        },
      });
    } catch (error) {
      reportSendFailure(error);
    } finally {
      setSending(false);
    }
  };

  // Compose keyboard shortcuts: Cmd+Enter to send, Cmd+Shift+C for CC, Cmd+Shift+B for BCC, Escape to close
  const handleSendRef = useRef(handleSend);
  handleSendRef.current = handleSend;
  const handleDiscardRef = useRef(handleDiscard);
  handleDiscardRef.current = handleDiscard;

  useEffect(() => {
    const handleComposeKeyDown = (e: KeyboardEvent) => {
      const isMod = e.metaKey || e.ctrlKey;

      // Cmd/Ctrl+Enter → Send
      if (isMod && e.key === 'Enter') {
        e.preventDefault();
        handleSendRef.current();
        return;
      }

      // Cmd/Ctrl+Shift+C → Show/focus CC
      if (isMod && e.shiftKey && e.key.toLowerCase() === 'c') {
        e.preventDefault();
        setShowCc(true);
        requestAnimationFrame(() => {
          const ccRow = document.querySelector('[data-cc-input]');
          const input = ccRow?.querySelector('input');
          input?.focus();
        });
        return;
      }

      // Cmd/Ctrl+Shift+B → Show/focus BCC
      if (isMod && e.shiftKey && e.key.toLowerCase() === 'b') {
        e.preventDefault();
        setShowBcc(true);
        requestAnimationFrame(() => {
          const bccRow = document.querySelector('[data-bcc-input]');
          const input = bccRow?.querySelector('input');
          input?.focus();
        });
        return;
      }

      // Escape → Discard/close compose
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        handleDiscardRef.current();
        return;
      }
    };

    document.addEventListener('keydown', handleComposeKeyDown, true);
    return () => document.removeEventListener('keydown', handleComposeKeyDown, true);
  }, []);

  // Auto-focus body editor for reply/replyAll (To is already pre-filled)
  useEffect(() => {
    if (mode !== 'reply' && mode !== 'replyAll') return;
    const timer = setTimeout(() => focusEditor('.bg-card'), 150);
    return () => clearTimeout(timer);
  }, [mode]);

  const getTitle = () => {
    switch (mode) {
      case 'reply':
        return 'Reply';
      case 'replyAll':
        return 'Reply All';
      case 'forward':
        return 'Forward';
      default:
        return 'New Message';
    }
  };

  // Minimized state - just a small bar at bottom right
  if (isMinimized) {
    return (
      <>
      {showDiscardConfirm && (
        <DiscardConfirm
          dontAsk={dontAskDiscard}
          onDontAskChange={setDontAskDiscard}
          onCancel={() => setShowDiscardConfirm(false)}
          onConfirm={confirmDiscard}
        />
      )}
      <div className="fixed bottom-0 right-4 w-72 bg-card border border-border rounded-t-lg shadow-2xl z-50">
        <div
          className="flex items-center justify-between px-4 py-2 bg-primary text-primary-foreground rounded-t-lg cursor-pointer"
          onClick={() => setIsMinimized(false)}
        >
          <span className="font-medium text-sm truncate">{subject || getTitle()}</span>
          <div className="flex items-center gap-1">
            <button
              onClick={(e) => { e.stopPropagation(); setIsMinimized(false); }}
              className="p-1 hover:bg-primary-foreground/20 rounded"
              title="Expand"
            >
              <ChevronUp className="h-4 w-4" />
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); handleDiscard(); }}
              className="p-1 hover:bg-primary-foreground/20 rounded"
              title="Close"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
      </div>
      </>
    );
  }

  // Full screen mode - centered modal with backdrop (5% top/bottom, 10% left/right)
  if (isFullScreen) {
    return (
      <>
      {showDiscardConfirm && (
        <DiscardConfirm
          dontAsk={dontAskDiscard}
          onDontAskChange={setDontAskDiscard}
          onCancel={() => setShowDiscardConfirm(false)}
          onConfirm={confirmDiscard}
        />
      )}
      <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-[5%_10%]">
        <div className="bg-card border border-border rounded-lg shadow-xl w-full h-full flex flex-col">
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-muted/50 rounded-t-lg">
            <h2 className="font-semibold">{getTitle()}</h2>
            <div className="flex items-center gap-1">
              <button
                onClick={() => setIsMinimized(true)}
                className="p-1.5 hover:bg-accent rounded-md transition-colors"
                title="Minimize"
              >
                <ChevronDown className="h-4 w-4" />
              </button>
              <button
                onClick={() => setIsFullScreen(false)}
                className="p-1.5 hover:bg-accent rounded-md transition-colors"
                title="Exit full screen"
              >
                <Minimize2 className="h-4 w-4" />
              </button>
              <button
                onClick={handleDiscard}
                className="p-1.5 hover:bg-accent rounded-md transition-colors"
                title="Close"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>

          {/* Sending not set up — message will queue in the Outbox */}
          <FromBar />
          <SmtpNotConfiguredBanner />

          {/* Form - flex column layout */}
          <div className="flex-1 flex flex-col overflow-hidden">
            {/* Form fields - fixed at top */}
            <div className="flex-shrink-0">
              {/* To */}
              <div className="flex items-center border-b border-border">
                <label className="pl-3 pr-[10px] py-2 text-sm text-muted-foreground w-auto min-h-[44px] flex items-center">To</label>
                <EmailInput
                  value={to}
                  onChange={setTo}
                  onPendingChange={setPendingTo}
                  placeholder="Recipients"
                  autoFocus={mode === 'new' || mode === 'forward'}
                  onTabOut={() => {
                    const subjectInput = document.querySelector('[data-compose-subject]') as HTMLInputElement;
                    subjectInput?.focus();
                  }}
                />
                <div className="flex items-center gap-2 px-2 min-h-[44px]">
                  {!showCc && (
                    <button
                      onClick={() => setShowCc(true)}
                      className="text-xs text-muted-foreground hover:text-foreground"
                    >
                      Cc
                    </button>
                  )}
                  {!showBcc && (
                    <button
                      onClick={() => setShowBcc(true)}
                      className="text-xs text-muted-foreground hover:text-foreground"
                    >
                      Bcc
                    </button>
                  )}
                </div>
              </div>

              {/* Cc */}
              {showCc && (
                <div className="flex items-center border-b border-border" data-cc-input>
                  <label className="pl-3 pr-[10px] py-2 text-sm text-muted-foreground w-auto min-h-[44px] flex items-center">Cc</label>
                  <EmailInput
                    value={cc}
                    onChange={setCc}
                    onPendingChange={setPendingCc}
                    placeholder="Cc recipients"
                    onTabOut={() => {
                      const subjectInput = document.querySelector('[data-compose-subject]') as HTMLInputElement;
                      subjectInput?.focus();
                    }}
                  />
                </div>
              )}

              {/* Bcc */}
              {showBcc && (
                <div className="flex items-center border-b border-border" data-bcc-input>
                  <label className="pl-3 pr-[10px] py-2 text-sm text-muted-foreground w-auto min-h-[44px] flex items-center">Bcc</label>
                  <EmailInput
                    value={bcc}
                    onChange={setBcc}
                    onPendingChange={setPendingBcc}
                    placeholder="Bcc recipients"
                    onTabOut={() => {
                      const subjectInput = document.querySelector('[data-compose-subject]') as HTMLInputElement;
                      subjectInput?.focus();
                    }}
                  />
                </div>
              )}

              {/* Subject */}
              <div className="flex items-center border-b border-border">
                <label className="pl-3 pr-[10px] py-2 text-sm text-muted-foreground w-auto min-h-[44px] flex items-center">Subject</label>
                <input
                  type="text"
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Tab' && !e.shiftKey) {
                      e.preventDefault();
                      const editor = document.querySelector('.ProseMirror') as HTMLElement;
                      editor?.focus();
                    }
                  }}
                  placeholder="Subject"
                  className="flex-1 px-0 py-2 bg-transparent outline-none text-sm"
                  data-compose-subject
                />
              </div>
            </div>

            {/* Body - Rich Text Editor - takes remaining space */}
            <div className="flex-1 min-h-0 overflow-y-auto" onContextMenu={handleContextMenu}>
              <RichTextEditor
                content={htmlBody}
                onChange={handleEditorChange}
                placeholder="Compose your message..."
                className="border-0 rounded-none"
              />
            </div>

            {/* Signature preview (not editable) — faithful render, grows to the
                full signature height (small buffer so the last row isn't clipped). */}
            {signatureHtml && (
              <div className="flex-shrink-0 border-t border-border bg-muted/10">
                <SandboxedEmailBody html={signatureHtml} className="px-4 py-2 text-sm" heightPadding={12} blockRemoteImages={false} />
              </div>
            )}

            {/* Quoted Content Preview (not editable, shows original email) */}
            {quotedHtml && (
              <div className="flex-shrink-0 border-t border-border bg-muted/20 max-h-[200px] overflow-y-auto">
                <div className="px-4 py-2 text-xs text-muted-foreground font-medium border-b border-border bg-muted/30">
                  Original Message
                </div>
                <SandboxedEmailBody html={quotedHtml} className="px-4 py-2 text-sm" blockRemoteImages={false} />
              </div>
            )}
          </div>

          {/* Footer UI replaced by ComposeToolbar */}
          <ComposeToolbar
            sending={sending}
            hasAIProvider={hasAIProvider}
            plainBody={plainBody}
            hasRecipients={!!to.trim()}
            isForward={mode === 'forward'}
            readReceipt={readReceipt}
            onToggleReadReceipt={() => setReadReceipt((v) => !v)}
            onSend={() => {
              const finalTo = mergeEmails(to, pendingTo);
              const finalCc = mergeEmails(cc, pendingCc);
              const finalBcc = mergeEmails(bcc, pendingBcc);

              if (finalTo.length === 0) return alert('Please enter a recipient');

              setSending(true);
              try {
                const emailFriendlyBody = convertToEmailHtml(htmlBody);
                const fullHtmlBody = assembleOutgoingHtml(emailFriendlyBody, signatureHtml, quotedHtml);
                // Keep the draft until the send is durably persisted — the store
                // deletes it via draftCleanup on commit (persist-first undo-send).
                const ownedDraftId = markDiscarded();
                const cleanupAccountId = (draft as any)?.accountId ?? replyAccountId;
                onClose();

                sendEmail({
                  to: finalTo,
                  cc: finalCc.length > 0 ? finalCc : undefined,
                  bcc: finalBcc.length > 0 ? finalBcc : undefined,
                  subject,
                  body: plainBody,
                  htmlBody: fullHtmlBody,
                  inReplyTo: mode !== 'new' ? replyToEmail?.id : undefined,
                  accountId: mode !== 'new' ? (replyToEmail as any)?.accountId : undefined,
                  from: resolvedFrom,
        requestReadReceipt: readReceipt,
                  attachments: attachments.map(a => ({ ...a, filename: a.filename || a.name || 'attachment' })) as any,
                  draftCleanup: {
                    threadId: (draft as any)?.threadId,
                    messageId: ownedDraftId ?? (draft as any)?.draftMessageId,
                    subject,
                    to: finalTo.join(', '),
                    accountId: cleanupAccountId,
                  },
                  draft: {
                    to: finalTo.join(', '),
                    cc: finalCc.join(', '),
                    bcc: finalBcc.join(', '),
                    subject,
                    htmlContent: htmlBody,
                    attachments,
                    replyToEmail,
                    mode,
                    isInline: false,
                  },
                });
              } catch (error) {
                reportSendFailure(error);
              } finally {
                setSending(false);
              }
            }}
            onAttach={handleAttach}
            onPolish={() => {
              setPolishMode('full');
              setShowPolishModal(true);
            }}
            onDiscard={handleDiscard}
          />

          {/* Attachment list */}
          {attachments.length > 0 && (
            <div className="flex flex-wrap gap-2 px-4 py-2 border-t border-border">
              {attachments.map((file: AttachmentFile, i: number) => (
                <div key={i} className="flex items-center gap-1 px-2 py-1 bg-muted rounded text-xs">
                  <span className="max-w-[200px] truncate">{file.name || file.filename}</span>
                  <span className="text-muted-foreground">({formatFileSize(file.size)})</span>
                  <button onClick={() => removeAttachment(i)} className="ml-1 hover:text-destructive">
                    <X className="h-3 w-3" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

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
      </>
    );
  }

  // Default: Floating panel in bottom-right (Gmail style) - 50% width, 60% height
  return (
    <div className="fixed bottom-0 right-4 w-[50%] min-w-[500px] max-w-[900px] h-[60vh] bg-card border border-border rounded-t-lg shadow-2xl z-50 flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 bg-muted/30 border-b border-border rounded-t-lg">
        <h2 className="font-medium text-sm">{getTitle()}</h2>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setIsMinimized(true)}
            className="p-1 hover:bg-accent rounded text-muted-foreground hover:text-foreground"
            title="Minimize"
          >
            <ChevronDown className="h-4 w-4" />
          </button>
          <button
            onClick={() => setIsFullScreen(true)}
            className="p-1 hover:bg-accent rounded text-muted-foreground hover:text-foreground"
            title="Full screen"
          >
            <Maximize2 className="h-4 w-4" />
          </button>
          <button
            onClick={handleDiscard}
            className="p-1 hover:bg-accent rounded text-muted-foreground hover:text-foreground"
            title="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Sending not set up — message will queue in the Outbox */}
      <FromBar />
      <SmtpNotConfiguredBanner />

      {/* Form - flex column layout */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Form fields - fixed at top */}
        <div className="flex-shrink-0">
          {/* To */}
          <div className="flex items-center border-b border-border">
            <label className="pl-3 pr-[10px] py-2 text-xs text-muted-foreground w-auto min-h-[44px] flex items-center">To</label>
            <EmailInput
              value={to}
              onChange={setTo}
              onPendingChange={setPendingTo}
              placeholder="Recipients"
              autoFocus
              onTabOut={() => {
                const subjectInput = document.querySelector('[data-compose-subject]') as HTMLInputElement;
                subjectInput?.focus();
              }}
            />
            <div className="flex items-center gap-2 px-2 min-h-[44px]">
              {!showCc && (
                <button
                  onClick={() => setShowCc(true)}
                  className="text-xs text-muted-foreground hover:text-foreground"
                >
                  Cc
                </button>
              )}
              {!showBcc && (
                <button
                  onClick={() => setShowBcc(true)}
                  className="text-xs text-muted-foreground hover:text-foreground"
                >
                  Bcc
                </button>
              )}
            </div>
          </div>

          {/* Cc */}
          {showCc && (
            <div className="flex items-center border-b border-border" data-cc-input>
              <label className="pl-3 pr-[10px] py-2 text-xs text-muted-foreground w-auto min-h-[44px] flex items-center">Cc</label>
              <EmailInput
                value={cc}
                onChange={setCc}
                onPendingChange={setPendingCc}
                placeholder="Cc recipients"
                onTabOut={() => {
                  const subjectInput = document.querySelector('[data-compose-subject]') as HTMLInputElement;
                  subjectInput?.focus();
                }}
              />
            </div>
          )}

          {/* Bcc */}
          {showBcc && (
            <div className="flex items-center border-b border-border" data-bcc-input>
              <label className="pl-3 pr-[10px] py-2 text-xs text-muted-foreground w-auto min-h-[44px] flex items-center">Bcc</label>
              <EmailInput
                value={bcc}
                onChange={setBcc}
                onPendingChange={setPendingBcc}
                placeholder="Bcc recipients"
                onTabOut={() => {
                  const subjectInput = document.querySelector('[data-compose-subject]') as HTMLInputElement;
                  subjectInput?.focus();
                }}
              />
            </div>
          )}

          {/* Subject */}
          <div className="flex items-center border-b border-border">
            <label className="pl-3 pr-[10px] py-2 text-xs text-muted-foreground w-auto min-h-[44px] flex items-center">Subject</label>
            <input
              type="text"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Tab' && !e.shiftKey) {
                  e.preventDefault();
                  const editor = document.querySelector('.ProseMirror') as HTMLElement;
                  editor?.focus();
                }
              }}
              placeholder="Subject"
              className="flex-1 px-0 py-2 bg-transparent outline-none text-sm"
              data-compose-subject
            />
          </div>
        </div>

        {/* Body - Rich Text Editor - takes remaining space */}
        <div className="flex-1 min-h-0 overflow-y-auto" onContextMenu={handleContextMenu}>
          <RichTextEditor
            content={htmlBody}
            onChange={handleEditorChange}
            placeholder="Compose your message..."
            className="border-0 rounded-none"
          />
        </div>

        {/* Signature preview (not editable) — faithful render, full height. */}
        {signatureHtml && (
          <div className="flex-shrink-0 border-t border-border bg-muted/10">
            <SandboxedEmailBody html={signatureHtml} className="px-3 py-2 text-xs" heightPadding={12} blockRemoteImages={false} />
          </div>
        )}

        {/* Quoted Content Preview (not editable, shows original email) */}
        {quotedHtml && (
          <div className="flex-shrink-0 border-t border-border bg-muted/20 max-h-[150px] overflow-y-auto">
            <div className="px-3 py-1.5 text-xs text-muted-foreground font-medium border-b border-border bg-muted/30">
              Original Message
            </div>
            <SandboxedEmailBody html={quotedHtml} className="px-3 py-2 text-xs" blockRemoteImages={false} />
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="flex-shrink-0 flex items-center justify-between px-3 py-2 border-t border-border bg-muted/30">
        <div className="flex items-center gap-2">
          <Tooltip content="Send" shortcut={`${MOD_KEY}+Enter`} position="top">
            <button
              onClick={handleSend}
              disabled={sending || !to.trim()}
              className="flex items-center gap-2 px-3 py-1.5 bg-primary text-primary-foreground rounded-md hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed text-sm font-medium"
            >
              <Send className="h-4 w-4" />
              {sending ? 'Sending...' : 'Send'}
            </button>
          </Tooltip>

          {hasAIProvider && (
            <Tooltip content="Polish with AI" position="top">
              <button
                onClick={() => {
                  setPolishMode('full');
                  setShowPolishModal(true);
                }}
                disabled={!plainBody.trim()}
                className="flex items-center gap-2 p-1.5 hover:bg-accent rounded-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <Wand2 className="h-4 w-4 text-primary" />
              </button>
            </Tooltip>
          )}

          <Tooltip content="Attach file" position="top">
            <button
              onClick={handleAttach}
              className="p-1.5 hover:bg-accent rounded-md transition-colors"
            >
              <Paperclip className="h-4 w-4" />
            </button>
          </Tooltip>

          {attachments.length > 0 && (
            <span className="text-xs text-muted-foreground">
              {attachments.length} file{attachments.length !== 1 ? 's' : ''} attached
            </span>
          )}
        </div>

        <Tooltip content="Discard" shortcut="Esc" position="top">
          <button
            onClick={handleDiscard}
            className="p-1.5 hover:bg-accent rounded-md transition-colors text-destructive"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </Tooltip>
      </div>

      {/* Attachment list */}
      {attachments.length > 0 && (
        <div className="flex-shrink-0 flex flex-wrap gap-2 px-3 py-2 border-t border-border">
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

      {/* Discard confirmation */}
      {showDiscardConfirm && (
        <DiscardConfirm
          dontAsk={dontAskDiscard}
          onDontAskChange={setDontAskDiscard}
          onCancel={() => setShowDiscardConfirm(false)}
          onConfirm={confirmDiscard}
        />
      )}
    </div>
  );
}

function DiscardConfirm({
  dontAsk,
  onDontAskChange,
  onCancel,
  onConfirm,
}: {
  dontAsk: boolean;
  onDontAskChange: (v: boolean) => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-[300]"
      onClick={onCancel}
    >
      <div
        className="bg-card border border-border rounded-lg shadow-xl w-full max-w-sm p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-base font-semibold mb-2">Discard this draft?</h3>
        <p className="text-sm text-muted-foreground mb-4">
          Your draft will be permanently deleted.
        </p>
        <label className="flex items-center gap-2 text-sm mb-4 cursor-pointer">
          <input
            type="checkbox"
            checked={dontAsk}
            onChange={(e) => onDontAskChange(e.target.checked)}
            className="h-4 w-4 accent-primary"
          />
          <span>Don't ask me again</span>
        </label>
        <div className="flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="px-3 py-1.5 text-sm border border-input rounded-lg hover:bg-accent"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className="px-3 py-1.5 text-sm bg-red-500 text-white rounded-lg hover:bg-red-600"
          >
            Discard
          </button>
        </div>
      </div>
    </div>
  );
}
