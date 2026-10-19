import { FileText, Loader2, Mail, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { useEmailStore } from '../../store/email-store';
import type { InboxAssistantSource } from '../../types/inbox-assistant';
import { resolveInboxAssistantSource, type InboxAssistantSourceTarget } from '../../utils/inbox-assistant-source';
import { MailDetailWithPanels } from '../extensions/MailDetailWithPanels';

interface AssistantSourcePaneProps {
  source: InboxAssistantSource;
  onClose: () => void;
  onOpenAttachment?: (target: InboxAssistantSourceTarget & { filename: string }) => void;
  autoMarkRead?: boolean;
}

/** The normal mail reader, embedded beside the conversation rather than copied. */
export function AssistantSourcePane({ source, onClose, onOpenAttachment, autoMarkRead = true }: AssistantSourcePaneProps) {
  const sourceKey = JSON.stringify([source.accountId, source.emailId, source.filename ?? '']);
  const [resolved, setResolved] = useState<{ key: string; target: InboxAssistantSourceTarget } | null>(null);
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null);
  const [retry, setRetry] = useState(0);
  const generation = useRef(0);
  const opened = useRef<InboxAssistantSourceTarget | null>(null);
  const selectedEmailId = useEmailStore(state => state.selectedEmailId);
  const threadEmails = useEmailStore(state => state.threadEmails);
  const threadAccountId = useEmailStore(state => state.threadAccountId);
  const viewAccountId = useEmailStore(state => state.viewAccountId);
  const activeAccountId = useEmailStore(state => state.activeAccountId);
  const loadingThread = useEmailStore(state => state.loadingThread);
  const target = resolved?.key === sourceKey ? resolved.target : null;
  const error = failure?.key === sourceKey ? failure.message : null;
  const ownedThread = !!target && selectedEmailId === target.emailId && threadAccountId === target.accountId
    && (viewAccountId ?? activeAccountId) === target.accountId
    && threadEmails.some(email => email.id === target.emailId && (email.threadId || email.id) === target.threadId);

  useEffect(() => {
    const version = ++generation.current;
    opened.current = null;
    setResolved(null);
    setFailure(null);
    // A source may share its IDs with mail in another account. Clear the old
    // reader before resolving/loading, including the account stamped on its rows.
    useEmailStore.getState().clearSelectedEmail();
    useEmailStore.setState({ threadAccountId: null, pendingThreadEmailIds: [] });
    void resolveInboxAssistantSource({ accountId: source.accountId, emailId: source.emailId, filename: source.filename }).then(next => {
      if (version !== generation.current) return;
      useEmailStore.setState({ threadEmails: [], threadAccountId: null, pendingThreadEmailIds: [] });
      useEmailStore.getState().openThread(next.emailId, next.threadId, next.accountId);
      opened.current = next;
      setResolved({ key: sourceKey, target: next });
    }).catch(cause => {
      if (version === generation.current) setFailure({ key: sourceKey, message: cause instanceof Error ? cause.message : 'This source could not be opened.' });
    });
    return () => {
      generation.current++;
      const previous = opened.current;
      opened.current = null;
      const current = useEmailStore.getState();
      if (previous && current.selectedEmailId === previous.emailId
        && (current.threadAccountId === previous.accountId || (current.viewAccountId ?? current.activeAccountId) === previous.accountId)) {
        current.clearSelectedEmail();
      }
    };
  }, [source.accountId, source.emailId, source.filename, sourceKey, retry]);

  const close = useCallback(() => {
    generation.current++;
    opened.current = null;
    useEmailStore.getState().clearSelectedEmail();
    onClose();
  }, [onClose]);

  // The shared Back/delete/archive actions can dismiss or advance selection.
  // An embedded source never follows that into the unrelated inbox list.
  useEffect(() => {
    if (target && opened.current && selectedEmailId !== target.emailId) close();
  }, [target, selectedEmailId, close]);

  return (
    <section aria-label="Source email" className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background">
      <div className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-3">
        <Mail className="h-4 w-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-semibold">Source email</h3>
          <p className="truncate text-xs text-muted-foreground">{source.accountEmail} · {source.subject || '(No subject)'}</p>
        </div>
        <button type="button" onClick={close} aria-label="Close source email" className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"><X className="h-4 w-4" /></button>
      </div>
      {target?.filename && onOpenAttachment && (
        <div className="shrink-0 border-b border-border px-4 py-2">
          <button type="button" onClick={() => onOpenAttachment({ ...target, filename: target.filename! })} className="flex max-w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs text-primary hover:bg-accent"><FileText className="h-4 w-4 shrink-0" /><span className="truncate">Open {target.filename}</span></button>
        </div>
      )}
      {error ? (
        <div role="alert" className="m-4 space-y-3 rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm"><p>{error}</p><button type="button" onClick={() => setRetry(value => value + 1)} className="font-medium underline">Try again</button></div>
      ) : target && ownedThread ? (
        <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden"><MailDetailWithPanels key={`${target.accountId}:${target.threadId}`} onBack={close} threadOnly autoMarkRead={autoMarkRead} /></div>
      ) : !target || loadingThread ? (
        <p role="status" className="flex items-center justify-center gap-2 p-8 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Opening the original email…</p>
      ) : (
        <div role="alert" className="m-4 space-y-3 rounded-lg border border-border p-4 text-sm"><p>This source could not be loaded from its original account.</p><button type="button" onClick={() => setRetry(value => value + 1)} className="font-medium text-primary underline">Try again</button></div>
      )}
    </section>
  );
}
