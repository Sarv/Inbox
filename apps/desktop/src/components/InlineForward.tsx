import {
  MoreHorizontal,
  Sparkles,
  X,
  Minimize2,
  Forward,
  Paperclip
} from 'lucide-react';
import prettyBytes from 'pretty-bytes';
import { useState, useEffect, useRef, useMemo } from 'react';

import { useCloseComposePrompt } from '../hooks/useCloseComposePrompt';
import { useDraftAutosave } from '../hooks/useDraftAutosave';
import { useInlineSendingAccount } from '../hooks/useInlineSendingAccount';
import { getDefaultProvider, PolishContext } from '../services/ai-service';
import { useEmailStore } from '../store/email-store';
import { loadEmailAttachments } from '../utils/compose-attachments';
import { assembleOutgoingHtml, convertToEmailHtml } from '../utils/email-html';
import { buildForwardQuoteHtml, composeForwardDraft, forwardSubject, type ForwardSource } from '../utils/forward-quote';
import { reportSendFailure } from '../utils/send-failure';

import { ComposeToolbar } from './ComposeToolbar';
import { EmailInput } from './EmailInput';
import { FromAccountBar } from './FromAccountBar';
import { PolishModal } from './PolishModal';
import { RichTextEditor } from './RichTextEditor';
import { SandboxedEmailBody } from './SandboxedEmailBody';
import { useCompose, AttachmentFile } from './useCompose';


function formatFileSize(bytes: number): string {
  return prettyBytes(bytes);
}

interface InlineForwardProps {
  forwardEmail: ForwardSource;
  draft?: any;
  onClose: () => void;
  embedded?: boolean;
}

export function InlineForward({ forwardEmail, draft, onClose, embedded = false }: InlineForwardProps) {
  const {
    to, setTo, pendingTo, setPendingTo,
    htmlBody,
    plainBody, setBody,
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
    focusEditor,
    getSignature,
    sendEmail
  } = useCompose({
    initialDraft: draft
  });

  // Send (and draft) from the account the mail was received in, not whichever
  // account happens to be active — the All Inboxes forward went out from the
  // wrong mailbox. The From bar says so when that isn't the active account.
  const { accountId: forwardAccountId, fromAccount, accounts } = useInlineSendingAccount(forwardEmail);

  const [showQuoted, setShowQuoted] = useState(false);
  const [isMinimized, setIsMinimized] = useState(false);

  const hasAIProvider = !!getDefaultProvider();

  // Fetch original attachments on mount
  useEffect(() => {
    if (draft) return; // don't fetch if restoring a draft with existing files
    if (!forwardEmail.hasAttachments || !forwardEmail.attachmentNames) return;
    void loadEmailAttachments({ ...forwardEmail, accountId: forwardAccountId }).then((loaded) => {
      if (loaded.length > 0) setAttachments(prev => [...prev, ...loaded]);
    });
  }, [forwardEmail.id, forwardEmail.hasAttachments, forwardEmail.attachmentNames]);

  const subject = forwardSubject(forwardEmail.subject);

  // Auto-save the forward as a draft. It is a STANDALONE draft (no threadId /
  // inReplyTo): kept in the original's thread, the thread view would reopen it
  // as a reply and send it to the original sender. Its body carries the
  // forwarded message under the note, so reopened from Drafts it is complete.
  const { markDiscarded, closeAction } = useDraftAutosave({
    to,
    subject,
    subjectPrefilled: true,
    body: plainBody,
    htmlBody,
    composeForSave: (note) => composeForwardDraft(forwardEmail, note),
    attachments,
    // A fresh forward's files are the original's, loaded for the user; a
    // restored forward's are the ones they chose to send.
    attachmentsPrefilled: !draft,
    initialDraftMessageId: draft?.draftMessageId,
    initialDraftUnsaved: draft?.unsaved,
    accountId: forwardAccountId,
  });

  // Throw the forward away: stop the autosave, drop any draft it wrote from
  // every view (and the server, in the background), then close.
  const handleDiscard = () => {
    const messageId = markDiscarded() || draft?.draftMessageId;
    if (messageId) useEmailStore.getState().discardDraft(messageId, undefined, forwardAccountId);
    onClose();
  };

  // X / Escape: ask whether to keep the forward in Drafts or discard it.
  // Saving is just closing — the autosave's unmount save writes the draft.
  const { requestClose, isAsking, closePromptDialog } = useCloseComposePrompt({
    closeAction,
    onSave: onClose,
    onDiscard: handleDiscard,
  });

  // Focus editor on mount
  useEffect(() => {
    const timer = setTimeout(() => {
      focusEditor('#inline-forward-compose');
    }, 100);
    return () => clearTimeout(timer);
  }, []);

  // Signature is kept OUT of the TipTap editor (its schema flattens tables/flex)
  // — captured once and appended verbatim on send + shown in the preview below.
  const signatureHtml = useMemo(() => getSignature('reply', forwardAccountId), [forwardAccountId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Close context menu on click outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (contextMenuRef.current && !contextMenuRef.current.contains(e.target as Node)) {
        setShowContextMenu(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleSend = async () => {
    // Merge committed emails with any pending typed text that looks like an email
    const mergeEmails = (committed: string, pending: string) => {
      const rawCommitted = committed.split(',').map(e => e.trim()).filter(Boolean);
      const rawPending = pending.split(',').map(e => e.trim()).filter(e => e.includes('@'));
      return [...new Set([...rawCommitted, ...rawPending])];
    };

    const finalTo = mergeEmails(to, pendingTo);

    if (finalTo.length === 0) return;

    setSending(true);
    try {
      const quotedHtml = buildForwardQuoteHtml(forwardEmail);
      const emailFriendlyBody = convertToEmailHtml(htmlBody);
      const fullHtml = assembleOutgoingHtml(emailFriendlyBody, signatureHtml, quotedHtml);

      // Stop the autosave (and the unmount save) — the mail is being sent, not
      // drafted. Any draft it already wrote is removed once the send commits
      // (draftCleanup), never before, so the mail is never only in memory.
      const ownedDraftId = markDiscarded() ?? draft?.draftMessageId;

      // Close immediately for responsive UX — sendingStatus in store shows feedback
      onClose();

      await sendEmail({
        to: finalTo,
        subject,
        body: plainBody,
        htmlBody: fullHtml,
        inReplyTo: forwardEmail.id,
        attachments: attachments.map((a: AttachmentFile) => ({ ...a, filename: a.filename || 'attachment' })) as any,
        accountId: forwardAccountId,
        ...(ownedDraftId ? { draftCleanup: { messageId: ownedDraftId, accountId: forwardAccountId } } : {}),
        draft: {
          to: finalTo.join(', '),
          cc: '',
          htmlContent: htmlBody,
          attachments,
          replyToEmail: forwardEmail,
          mode: 'forward',
          isInline: true,
          draftMessageId: ownedDraftId,
          accountId: forwardAccountId,
          unsaved: true,
        },
      });
    } catch (error) {
      reportSendFailure(error);
    } finally {
      setSending(false);
    }
  };

  // Keyboard shortcuts
  const handleSendRef = useRef(handleSend);
  handleSendRef.current = handleSend;
  const onCloseRef = useRef(requestClose);
  onCloseRef.current = requestClose;
  const isAskingRef = useRef(isAsking);
  isAskingRef.current = isAsking;

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // The close question owns the keyboard while it is up.
      if (isAskingRef.current()) return;
      const isMod = e.metaKey || e.ctrlKey;

      if (isMod && e.key === 'Enter') {
        e.preventDefault();
        handleSendRef.current();
        return;
      }

      if (e.key === 'Escape') {
        e.preventDefault();
        void onCloseRef.current();
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
    mode: 'forward',
    polishMode: polishType,
    subject: subject || undefined,
    recipient: to || undefined,
    fullBody: plainBody || undefined,
    selectedText: polishType === 'selection' ? selectedText : undefined,
    emailTrail: forwardEmail.cleanBody || undefined,
  });

  const handlePolishAccept = (result: { subject?: string; body: string }) => {
    if (polishMode === 'selection' && selectedText) {
      const escapedSelected = selectedText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const newHtml = htmlBody.replace(new RegExp(escapedSelected, 'g'), result.body);
      setBody(newHtml);
    } else {
      setBody(result.body);
    }
  };

  if (isMinimized) {
    return (
      <div className="border border-border rounded-lg bg-card mt-4">
        {closePromptDialog}
        <button
          onClick={() => setIsMinimized(false)}
          className="w-full p-3 flex items-center justify-between hover:bg-accent/50 transition-colors"
        >
          <div className="flex items-center gap-2">
            <Forward className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm text-muted-foreground">
              Forward: {forwardEmail.subject}
            </span>
          </div>
          <X className="h-4 w-4 text-muted-foreground hover:text-foreground" onClick={(e) => { e.stopPropagation(); void requestClose(); }} />
        </button>
      </div>
    );
  }

  const containerClass = embedded
    ? "bg-card overflow-hidden"
    : "border border-border rounded-lg bg-card mt-4 overflow-hidden";

  return (
    <div className={containerClass}>
      {closePromptDialog}
      {/* Header */}
      <div className="flex items-center justify-between p-3 border-b border-border bg-muted/30">
        <div className="flex items-center gap-2 text-sm">
          <Forward className="h-4 w-4" />
          <span className="font-medium">Forward</span>
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
            onClick={() => void requestClose()}
            className="p-1.5 hover:bg-accent rounded transition-colors"
            title="Close"
          >
            <X className="h-4 w-4 text-muted-foreground" />
          </button>
        </div>
      </div>

      {/* From: which account this forward is sent AS (All Inboxes, when it
          isn't the active one). */}
      {fromAccount && <FromAccountBar account={fromAccount} accounts={accounts} />}

      {/* To field - always visible */}
      <div className="flex items-center border-b border-border">
        <label className="pl-3 pr-[10px] py-2 text-xs text-muted-foreground w-auto min-h-[44px] flex items-center">To</label>
        <EmailInput
          value={to}
          onChange={setTo}
          onPendingChange={setPendingTo}
          placeholder="Recipients"
          autoFocus
          onTabOut={() => {
            const editor = document.querySelector('#inline-forward-compose .ProseMirror, #inline-forward-compose [contenteditable="true"]') as HTMLElement;
            if (editor) editor.focus();
          }}
        />
      </div>

      {/* Editor Area */}
      <div className="min-h-[150px]" onContextMenu={handleContextMenu}>
        <RichTextEditor
          content={htmlBody}
          onChange={handleEditorChange}
          placeholder="Add a message..."
          className="border-0 rounded-none"
        />
      </div>

      {/* Signature preview — faithful render, not editable, so its layout survives. */}
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
              ---------- Forwarded Message ----------
            </div>
            <div className="text-xs mb-1">
              <strong>From:</strong> {forwardEmail.fromName || forwardEmail.fromAddress}<br />
              <strong>Date:</strong> {new Date(forwardEmail.date * 1000).toLocaleString()}<br />
              <strong>Subject:</strong> {forwardEmail.subject}<br />
              <strong>To:</strong> {forwardEmail.toAddress}
            </div>
            <div className="whitespace-pre-wrap border-l-2 border-muted pl-3">
              {forwardEmail.cleanBody || '(no content)'}
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
        isForward={true}
        onSend={handleSend}
        onAttach={handleAttach}
        onPolish={() => {
          setPolishMode('full');
          setShowPolishModal(true);
        }}
        onDiscard={handleDiscard}
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
