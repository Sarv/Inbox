import { Loader2, Trash2, RefreshCw, AlertCircle, Send, Clock, Mailbox, Eye, Paperclip, X, Info } from 'lucide-react';
import prettyBytes from 'pretty-bytes';
import { useState, useEffect, useCallback } from 'react';

import { useConfirm } from '../ConfirmDialog';
import { Paginator } from '../email-list/Paginator';
import { SandboxedEmailBody } from '../SandboxedEmailBody';
import { Tooltip } from '../Tooltip';

// Page both lists like the inbox so a large Outbox / dead-letter pile stays
// scannable: 25 rows per page, prev/next replaces the visible page.
const PAGE_SIZE = 25;

interface OutboxSend {
  id: number;
  to: string;
  subject: string;
  status: string;
  retryCount: number;
  lastError: string | null;
  nextRetryAt: number | null;
  createdAt: number;
}

interface OutboxAttachmentMeta {
  filename: string;
  contentType: string;
  size: number;
}

/** Full stored content of a queued/failed send (from outbox:get). */
interface OutboxPreview {
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
  htmlBody: string;
  status: string;
  lastError: string | null;
  createdAt: number;
  attachments: OutboxAttachmentMeta[];
}

interface FailedOperation {
  id: number;
  type: string;
  folderPath: string;
  uid: number;
  status: string;
  retryCount: number;
  lastError: string | null;
  /** The IMAP command we sent (dead-lettered ops); null on connection failures. */
  attemptedCommand?: string | null;
  /** The server's raw NO/BAD reply; null when there was no server response. */
  serverResponse?: string | null;
  data?: any;
  createdAt: number;
}

const fmtDate = (secs: number) => new Date(secs * 1000).toLocaleString();

/** Human, product-language summary of what the action was trying to do. */
const describeOp = (op: FailedOperation): string => {
  const cats = Array.isArray(op.data?.categories)
    ? op.data.categories.map((c: any) => c?.name || c?.slug || c).filter(Boolean).join(', ')
    : '';
  switch (op.type) {
    case 'applyCategoryLabel': return cats ? `Apply label “${cats}”` : 'Apply category label';
    case 'removeGmailLabels': return 'Remove stale labels';
    case 'markRead': return 'Mark as read';
    case 'markUnread': return 'Mark as unread';
    case 'setFlags': return 'Update flags';
    case 'move': return `Move to ${op.data?.targetFolder || op.data?.destination || 'another folder'}`;
    case 'delete': return 'Delete message';
    case 'star': return 'Star message';
    case 'unstar': return 'Unstar message';
    default: return op.type;
  }
};

export function OutboxTab() {
  const { confirm, confirmDialog } = useConfirm();
  const [sends, setSends] = useState<OutboxSend[]>([]);
  const [failedOps, setFailedOps] = useState<FailedOperation[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  // Transient, non-error outcome of the last retry ("Sent.", "SMTP offline —
  // re-queued…"), so the retry button always visibly reports what happened.
  const [actionInfo, setActionInfo] = useState<string | null>(null);
  const [sendsPage, setSendsPage] = useState(0);
  const [failedPage, setFailedPage] = useState(0);
  // Outbox message preview (what content is queued). previewId drives the modal;
  // preview holds the fetched content (null while loading).
  const [previewId, setPreviewId] = useState<number | null>(null);
  const [preview, setPreview] = useState<OutboxPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);

  // Current page's slice of each list (client-side — both are already loaded).
  const pagedSends = sends.slice(sendsPage * PAGE_SIZE, sendsPage * PAGE_SIZE + PAGE_SIZE);
  const pagedFailed = failedOps.slice(failedPage * PAGE_SIZE, failedPage * PAGE_SIZE + PAGE_SIZE);

  // Clamp the page if the list shrank (retry/discard) so we never strand the
  // view on an empty page past the end.
  useEffect(() => {
    const maxPage = Math.max(0, Math.ceil(sends.length / PAGE_SIZE) - 1);
    if (sendsPage > maxPage) setSendsPage(maxPage);
  }, [sends.length, sendsPage]);
  useEffect(() => {
    const maxPage = Math.max(0, Math.ceil(failedOps.length / PAGE_SIZE) - 1);
    if (failedPage > maxPage) setFailedPage(maxPage);
  }, [failedOps.length, failedPage]);

  // Run a mutating outbox/queue action, surfacing any IPC failure instead of
  // swallowing it (a handler returning { success:false } or throwing must be
  // visible, not a button that silently does nothing).
  const runAction = useCallback(
    async (fn: () => Promise<{ success: boolean; error?: string } | void>) => {
      setActionError(null);
      try {
        const res = await fn();
        if (res && res.success === false) {
          setActionError(res.error || 'Action failed');
          return false;
        }
        return true;
      } catch (err) {
        setActionError((err as Error)?.message || 'Action failed');
        return false;
      }
    },
    [],
  );

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [sendsRes, opsRes] = await Promise.all([
        window.electronAPI.outbox.list(),
        window.electronAPI.opQueue.failed(),
      ]);
      if (sendsRes.success && sendsRes.data) {
        setSends(Array.isArray(sendsRes.data) ? sendsRes.data : []);
      }
      if (opsRes.success && opsRes.data) {
        setFailedOps(Array.isArray(opsRes.data) ? opsRes.data : []);
      }
    } catch (error) {
      console.error('Failed to load outbox:', error);
    } finally {
      setLoading(false);
    }
  }, []);

  // Load on mount and poll while the tab is open so retries/drains are visible.
  useEffect(() => {
    load();
    // Live on any outbox change; interval kept only as a slow backstop.
    const off = window.electronAPI.outbox.onChanged?.(load);
    const t = window.setInterval(load, 30000);
    return () => { window.clearInterval(t); off?.(); };
  }, [load]);

  // Human-readable outcome of a retry, so the button never looks like it did
  // nothing. Distinguishes "sent" from "re-queued because SMTP is offline" from
  // "failed again" — the three real cases the user was previously blind to.
  const describeRetry = (
    outcome: 'sent' | 'queued' | 'failed',
    connected: boolean,
    lastError: string | null,
  ): string => {
    if (outcome === 'sent') return 'Message sent.';
    if (outcome === 'failed') return `Still failing: ${lastError || 'send was rejected'}`;
    return connected
      ? 'Re-queued — retrying now; it will send shortly.'
      : 'Sending (SMTP) is offline — message re-queued and will send automatically when the connection returns.';
  };

  const retrySend = async (id: number) => {
    setBusyId(id);
    setActionError(null);
    setActionInfo(null);
    try {
      const res = await window.electronAPI.outbox.retry(id);
      if (res.success && res.data) {
        const { outcome, connected, lastError } = res.data;
        setActionInfo(describeRetry(outcome, connected, lastError));
      } else if (res.success === false) {
        setActionError(res.error || 'Retry failed');
      }
      await load();
    } catch (err) {
      setActionError((err as Error)?.message || 'Retry failed');
    } finally {
      setBusyId(null);
    }
  };

  const retryAllSends = async () => {
    setLoading(true);
    setActionInfo(null);
    try {
      const res = await window.electronAPI.outbox.retryAll();
      if (res.success && res.data) {
        const { retried, connected, drained } = res.data;
        setActionInfo(
          connected
            ? `Retried ${retried} message${retried === 1 ? '' : 's'}: ${drained.sent} sent, ${drained.queued} still queued, ${drained.failed} failed.`
            : `Sending (SMTP) is offline — ${retried} message${retried === 1 ? '' : 's'} re-queued; they'll send automatically when the connection returns.`,
        );
      } else if (res.success === false) {
        setActionError(res.error || 'Retry failed');
      }
      await load();
    } finally {
      setLoading(false);
    }
  };

  // Load the full stored content for a send and open the preview modal.
  const openPreview = async (id: number) => {
    setPreviewId(id);
    setPreview(null);
    setPreviewError(null);
    try {
      const res = await window.electronAPI.outbox.get(id);
      if (res.success && res.data) setPreview(res.data);
      else setPreviewError(res.error || 'Could not load message');
    } catch (err) {
      setPreviewError((err as Error)?.message || 'Could not load message');
    }
  };

  const closePreview = () => { setPreviewId(null); setPreview(null); setPreviewError(null); };

  const discardAllSends = async () => {
    const failedCount = sends.filter((s) => s.status === 'failed').length;
    const ok = await confirm({
      title: 'Discard failed messages',
      message: `Discard ${failedCount} failed message${failedCount === 1 ? '' : 's'}? They won't be sent and can't be recovered. Queued messages waiting to send are kept.`,
      confirmLabel: 'Discard all',
    });
    if (!ok) return;
    setLoading(true);
    try {
      await runAction(() => window.electronAPI.outbox.discardAll());
      await load();
    } finally {
      setLoading(false);
    }
  };

  const deleteSend = async (id: number) => {
    const ok = await confirm({
      title: 'Discard message',
      message: "Discard this queued message? It won't be sent and can't be recovered.",
      confirmLabel: 'Discard',
    });
    if (!ok) return;
    setBusyId(id);
    try {
      await window.electronAPI.outbox.delete(id);
      setSends(prev => prev.filter(s => s.id !== id));
    } finally {
      setBusyId(null);
    }
  };

  const retryAllOps = async () => {
    setLoading(true);
    try {
      await runAction(() => window.electronAPI.opQueue.retry());
      await load();
    } finally {
      setLoading(false);
    }
  };

  const retryOp = async (id: number) => {
    setBusyId(id);
    try {
      await window.electronAPI.opQueue.retryOne(id);
      await load();
    } finally {
      setBusyId(null);
    }
  };

  const discardAllOps = async () => {
    const ok = await confirm({
      title: 'Discard all failed actions',
      message: `Discard all ${failedOps.length} failed action${failedOps.length === 1 ? '' : 's'}? They won't be retried and can't be recovered.`,
      confirmLabel: 'Discard all',
    });
    if (!ok) return;
    setLoading(true);
    try {
      await runAction(() => window.electronAPI.opQueue.discardAll());
      await load();
    } finally {
      setLoading(false);
    }
  };

  const deleteOp = async (id: number) => {
    const ok = await confirm({
      title: 'Discard failed action',
      message: "Discard this failed action? It won't be retried.",
      confirmLabel: 'Discard',
    });
    if (!ok) return;
    setBusyId(id);
    try {
      await window.electronAPI.opQueue.delete(id);
      setFailedOps(prev => prev.filter(o => o.id !== id));
    } finally {
      setBusyId(null);
    }
  };

  const statusBadge = (send: OutboxSend) => {
    if (send.status === 'failed') {
      return (
        <span className="inline-flex items-center gap-1 text-xs text-destructive">
          <AlertCircle className="h-3 w-3" /> Failed
        </span>
      );
    }
    if (send.retryCount > 0) {
      return (
        <span className="inline-flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400">
          <Clock className="h-3 w-3" /> Retrying ({send.retryCount})
        </span>
      );
    }
    return (
      <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
        <Clock className="h-3 w-3" /> Queued
      </span>
    );
  };

  return (
    <div className="space-y-6">
      {confirmDialog}
      {actionError && (
        <div className="flex items-start gap-2 text-xs text-destructive bg-destructive/10 border border-destructive/30 rounded-md px-3 py-2">
          <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
          <span className="flex-1">{actionError}</span>
          <button
            onClick={() => setActionError(null)}
            className="text-destructive/70 hover:text-destructive"
            aria-label="Dismiss error"
          >
            &times;
          </button>
        </div>
      )}
      {actionInfo && (
        <div className="flex items-start gap-2 text-xs text-blue-700 dark:text-blue-300 bg-blue-500/10 border border-blue-500/30 rounded-md px-3 py-2">
          <Info className="h-4 w-4 shrink-0 mt-0.5" />
          <span className="flex-1">{actionInfo}</span>
          <button
            onClick={() => setActionInfo(null)}
            className="text-blue-700/70 hover:text-blue-700 dark:text-blue-300/70 dark:hover:text-blue-300"
            aria-label="Dismiss message"
          >
            &times;
          </button>
        </div>
      )}
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border pb-4">
        <div>
          <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
            Outbox
          </h3>
          <p className="text-sm text-muted-foreground mt-1">
            Messages waiting to send and actions that failed to sync. Everything here retries
            automatically when your connection returns.
          </p>
        </div>
        <Tooltip content="Refresh" delayMs={40}>
          <button
            onClick={load}
            className="p-2 text-muted-foreground hover:text-foreground hover:bg-muted/50 rounded-md transition-colors"
            aria-label="Refresh outbox"
          >
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </Tooltip>
      </div>

      {/* Pending / failed sends */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h4 className="text-sm font-medium flex items-center gap-2">
            <Send className="h-4 w-4" /> Messages ({sends.length})
          </h4>
          {sends.some((s) => s.status === 'failed') && (
            <div className="flex items-center gap-2">
              <button
                onClick={retryAllSends}
                disabled={loading}
                className="text-xs px-3 py-1.5 bg-primary text-primary-foreground rounded-md hover:bg-primary/90 disabled:opacity-50 flex items-center gap-1.5"
              >
                <RefreshCw className={`h-3 w-3 ${loading ? 'animate-spin' : ''}`} /> Retry all
              </button>
              <button
                onClick={discardAllSends}
                disabled={loading}
                className="text-xs px-3 py-1.5 border border-border text-destructive rounded-md hover:bg-destructive/10 disabled:opacity-50 flex items-center gap-1.5"
              >
                <Trash2 className="h-3 w-3" /> Discard all
              </button>
            </div>
          )}
        </div>
        <div className="border border-border rounded-lg overflow-hidden">
          {sends.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
              <Mailbox className="h-8 w-8 mb-2" />
              <p className="text-sm">Outbox is empty</p>
              <p className="text-xs mt-1">Sent messages appear here only if they can&apos;t go out yet</p>
            </div>
          ) : (
            <div className="divide-y divide-border">
              {pagedSends.map((send) => (
                <div key={send.id} className="flex items-start justify-between px-4 py-3 hover:bg-muted/30">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-sm truncate">
                        {send.subject || '(no subject)'}
                      </span>
                      {statusBadge(send)}
                    </div>
                    <div className="text-xs text-muted-foreground mt-1 truncate">
                      To: {send.to || '(unknown)'} · {fmtDate(send.createdAt)}
                    </div>
                    {send.lastError && (
                      <p className="text-xs text-destructive mt-1 truncate" title={send.lastError}>
                        {send.lastError}
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-1 ml-4">
                    <Tooltip content="Preview message" delayMs={40}>
                      <button
                        onClick={() => openPreview(send.id)}
                        className="p-2 text-muted-foreground hover:text-primary hover:bg-primary/10 rounded-md transition-colors"
                        aria-label="Preview message"
                      >
                        <Eye className="h-4 w-4" />
                      </button>
                    </Tooltip>
                    {send.status === 'failed' && (
                      <Tooltip content="Retry now" delayMs={40}>
                        <button
                          onClick={() => retrySend(send.id)}
                          disabled={busyId === send.id}
                          className="p-2 text-muted-foreground hover:text-primary hover:bg-primary/10 rounded-md transition-colors disabled:opacity-50"
                          aria-label="Retry send"
                        >
                          {busyId === send.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                        </button>
                      </Tooltip>
                    )}
                    <Tooltip content="Discard" delayMs={40}>
                      <button
                        onClick={() => deleteSend(send.id)}
                        disabled={busyId === send.id}
                        className="p-2 text-muted-foreground hover:text-destructive hover:bg-destructive/10 rounded-md transition-colors disabled:opacity-50"
                        aria-label="Discard send"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </Tooltip>
                  </div>
                </div>
              ))}
              {sends.length > PAGE_SIZE && (
                <Paginator
                  page={sendsPage}
                  pageSize={PAGE_SIZE}
                  count={pagedSends.length}
                  total={sends.length}
                  hasMore={(sendsPage + 1) * PAGE_SIZE < sends.length}
                  loading={loading}
                  onGoToPage={(p) => setSendsPage(Math.max(0, p))}
                />
              )}
            </div>
          )}
        </div>
      </div>

      {/* Failed IMAP operations */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h4 className="text-sm font-medium flex items-center gap-2">
            <AlertCircle className="h-4 w-4" /> Failed actions ({failedOps.length}{failedOps.length >= 200 ? '+' : ''})
          </h4>
          {failedOps.length > 0 && (
            <div className="flex items-center gap-2">
              <button
                onClick={retryAllOps}
                disabled={loading}
                className="text-xs px-3 py-1.5 bg-primary text-primary-foreground rounded-md hover:bg-primary/90 disabled:opacity-50 flex items-center gap-1.5"
              >
                <RefreshCw className={`h-3 w-3 ${loading ? 'animate-spin' : ''}`} /> Retry all
              </button>
              <button
                onClick={discardAllOps}
                disabled={loading}
                className="text-xs px-3 py-1.5 border border-border text-destructive rounded-md hover:bg-destructive/10 disabled:opacity-50 flex items-center gap-1.5"
              >
                <Trash2 className="h-3 w-3" /> Discard all
              </button>
            </div>
          )}
        </div>
        <p className="text-xs text-muted-foreground mb-2">
          Read/star/move/delete changes that couldn&apos;t reach the server after several tries.
        </p>
        <div className="border border-border rounded-lg overflow-hidden">
          {failedOps.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-6 text-muted-foreground">
              <p className="text-sm">No failed actions</p>
            </div>
          ) : (
            <div className="divide-y divide-border">
              {pagedFailed.map((op) => (
                <div key={op.id} className="flex items-start justify-between px-4 py-3 hover:bg-muted/30">
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium">
                      {describeOp(op)} <span className="text-xs text-muted-foreground">in {op.folderPath}</span>
                    </div>
                    <div className="text-xs text-muted-foreground mt-1">
                      {op.type} · UID {op.uid} · {op.retryCount} retries · {fmtDate(op.createdAt)}
                    </div>
                    {/* What we sent → what the server said. For a pure connection
                        failure there's no command/response, so the message
                        ("Connection not available") is shown on its own. */}
                    {op.attemptedCommand && (
                      <p className="text-xs mt-1 break-all">
                        <span className="text-muted-foreground">Sent: </span>
                        <code className="text-foreground/80">{op.attemptedCommand}</code>
                      </p>
                    )}
                    {op.serverResponse ? (
                      <p className="text-xs text-destructive mt-1 break-all">
                        <span className="text-muted-foreground">Server: </span>{op.serverResponse}
                      </p>
                    ) : op.lastError && (
                      <p className="text-xs text-destructive mt-1 break-all" title={op.lastError}>
                        {op.lastError}
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-1 ml-4">
                    <Tooltip content="Retry now" delayMs={40}>
                      <button
                        onClick={() => retryOp(op.id)}
                        disabled={busyId === op.id}
                        className="p-2 text-muted-foreground hover:text-primary hover:bg-primary/10 rounded-md transition-colors disabled:opacity-50"
                        aria-label="Retry failed action"
                      >
                        {busyId === op.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                      </button>
                    </Tooltip>
                    <Tooltip content="Discard" delayMs={40}>
                      <button
                        onClick={() => deleteOp(op.id)}
                        disabled={busyId === op.id}
                        className="p-2 text-muted-foreground hover:text-destructive hover:bg-destructive/10 rounded-md transition-colors disabled:opacity-50"
                        aria-label="Discard failed action"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </Tooltip>
                  </div>
                </div>
              ))}
              {failedOps.length > PAGE_SIZE && (
                <Paginator
                  page={failedPage}
                  pageSize={PAGE_SIZE}
                  count={pagedFailed.length}
                  total={failedOps.length}
                  hasMore={(failedPage + 1) * PAGE_SIZE < failedOps.length}
                  loading={loading}
                  onGoToPage={(p) => setFailedPage(Math.max(0, p))}
                />
              )}
            </div>
          )}
        </div>
      </div>

      {/* Message preview — what content is actually queued for this send. */}
      {previewId !== null && (
        <div
          className="fixed inset-0 z-[200] flex items-center justify-center bg-black/40 p-4"
          onClick={closePreview}
        >
          <div
            className="bg-card border border-border rounded-xl shadow-xl w-full max-w-2xl max-h-[85vh] flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-4 py-3 border-b border-border">
              <h4 className="text-sm font-semibold flex items-center gap-2">
                <Eye className="h-4 w-4" /> Message preview
              </h4>
              <Tooltip content="Close" delayMs={40}>
                <button
                  onClick={closePreview}
                  className="p-1.5 text-muted-foreground hover:text-foreground hover:bg-muted/50 rounded-md transition-colors"
                  aria-label="Close preview"
                >
                  <X className="h-4 w-4" />
                </button>
              </Tooltip>
            </div>
            <div className="flex-1 overflow-y-auto">
              {previewError ? (
                <div className="flex items-center gap-2 text-sm text-destructive p-6">
                  <AlertCircle className="h-4 w-4 shrink-0" /> {previewError}
                </div>
              ) : !preview ? (
                <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground p-10">
                  <Loader2 className="h-4 w-4 animate-spin" /> Loading…
                </div>
              ) : (
                <div className="p-4 space-y-3">
                  {/* Headers */}
                  <div className="space-y-1 text-sm">
                    <div className="flex gap-2">
                      <span className="text-muted-foreground w-16 shrink-0">To</span>
                      <span className="flex-1 break-words">{preview.to.join(', ') || '(none)'}</span>
                    </div>
                    {preview.cc.length > 0 && (
                      <div className="flex gap-2">
                        <span className="text-muted-foreground w-16 shrink-0">Cc</span>
                        <span className="flex-1 break-words">{preview.cc.join(', ')}</span>
                      </div>
                    )}
                    {preview.bcc.length > 0 && (
                      <div className="flex gap-2">
                        <span className="text-muted-foreground w-16 shrink-0">Bcc</span>
                        <span className="flex-1 break-words">{preview.bcc.join(', ')}</span>
                      </div>
                    )}
                    <div className="flex gap-2">
                      <span className="text-muted-foreground w-16 shrink-0">Subject</span>
                      <span className="flex-1 font-medium break-words">{preview.subject || '(no subject)'}</span>
                    </div>
                  </div>

                  {/* Attachments */}
                  {preview.attachments.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 border-t border-border pt-3">
                      {preview.attachments.map((att, i) => (
                        <span
                          key={i}
                          className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md bg-muted/50 border border-border text-xs text-muted-foreground"
                        >
                          <Paperclip className="h-3 w-3" />
                          <span className="truncate max-w-[220px]">{att.filename}</span>
                          {att.size > 0 && <span className="opacity-70">({prettyBytes(att.size)})</span>}
                        </span>
                      ))}
                    </div>
                  )}

                  {/* Body — render the composed HTML faithfully; fall back to text. */}
                  <div className="border-t border-border pt-3">
                    {preview.htmlBody ? (
                      <SandboxedEmailBody html={preview.htmlBody} transparentCanvas blockRemoteImages={false} />
                    ) : (
                      <pre className="text-sm whitespace-pre-wrap break-words font-sans text-foreground/90">
                        {preview.body || '(empty message)'}
                      </pre>
                    )}
                  </div>

                  {preview.lastError && (
                    <div className="flex items-start gap-2 text-xs text-destructive bg-destructive/10 border border-destructive/30 rounded-md px-3 py-2">
                      <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
                      <span className="flex-1 break-words">{preview.lastError}</span>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
