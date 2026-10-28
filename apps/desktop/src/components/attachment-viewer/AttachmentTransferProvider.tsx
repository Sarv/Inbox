import { attachmentViewerKind } from '@sarvinbox/core/attachment-kind';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { AttachmentActionsContext } from './attachment-actions-context';
import type { AttachmentTransfer } from './attachment-transfer-types';
import { AttachmentTransferPopup } from './AttachmentTransferPopup';
import { AttachmentViewer } from './AttachmentViewer';
import { attachmentKey, useAttachmentController, type AttachmentPreviewRequest, type AttachmentTarget } from './useAttachmentActions';

interface PreviewRequest {
  id: number;
  key: string;
  request: AttachmentPreviewRequest;
  controller: AbortController;
  autoOpen: boolean;
  url?: string;
  preparedAt?: number;
}

// Host leases last five minutes. Re-open conservatively before that boundary.
const REOPEN_PREVIEW_AFTER_MS = 4 * 60_000;

/** Owns transfers and clean preview leases independently of the currently open mail. */
export function AttachmentTransferProvider({ children, resolveAccountId }: { children: ReactNode; resolveAccountId?: (emailId: string) => string | undefined }) {
  const resolveTarget = useCallback((target: AttachmentTarget) => ({ ...target,
    accountId: target.accountId ?? resolveAccountId?.(target.emailId) }), [resolveAccountId]);
  const controller = useAttachmentController(resolveTarget);
  const { preparePreview } = controller;
  const sequence = useRef(0);
  const pending = useRef<PreviewRequest | undefined>(undefined);
  const [preview, setPreview] = useState<PreviewRequest>();
  const [expanded, setExpanded] = useState(false);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());

  const release = useCallback((url?: string) => {
    if (url) void window.electronAPI.emails.releaseAttachmentPreview(url).catch(() => {});
  }, []);

  const closePreview = useCallback(() => {
    const current = pending.current;
    pending.current = undefined;
    current?.controller.abort();
    release(current?.url);
    setPreview(undefined);
    setExpanded(false);
  }, [release]);

  useEffect(() => () => {
    const current = pending.current;
    pending.current = undefined;
    current?.controller.abort();
    release(current?.url);
  }, [release]);

  const requestPreview = useCallback((request: AttachmentPreviewRequest) => {
    const attachment = request.attachments[request.initialIndex];
    if (!attachment) return;
    request = { ...request, accountId: resolveTarget({ emailId: request.emailId, accountId: request.accountId, filename: attachment.name }).accountId };
    const key = attachmentKey(request.emailId, attachment.name, request.accountId);
    const previous = pending.current;
    const leaseCurrent = previous?.url && previous.preparedAt !== undefined && Date.now() - previous.preparedAt < REOPEN_PREVIEW_AFTER_MS;
    if (previous?.key === key && !previous.controller.signal.aborted && (!previous.url || leaseCurrent)) {
      previous.autoOpen = true;
      if (previous.url || attachmentViewerKind(attachment.name) === 'unsupported') setExpanded(true);
      setDismissed(new Set());
      return;
    }
    previous?.controller.abort();
    release(previous?.url);
    const current: PreviewRequest = { id: ++sequence.current, key, request,
      controller: new AbortController(), autoOpen: true };
    pending.current = current;
    setPreview(current);
    setExpanded(false);
    // An explicitly re-opened file should be visible in the progress panel.
    setDismissed(new Set());
    if (attachmentViewerKind(attachment.name) === 'unsupported') {
      setExpanded(true);
      return;
    }
    void preparePreview({ emailId: request.emailId, accountId: request.accountId, filename: attachment.name }, current.controller.signal).then(url => {
      if (!url) {
        if (pending.current === current) { pending.current = undefined; setPreview(undefined); setExpanded(false); }
        return;
      }
      if (pending.current !== current || current.controller.signal.aborted) { release(url); return; }
      current.url = url;
      current.preparedAt = Date.now();
      setPreview({ ...current });
      setExpanded(current.autoOpen);
    });
  }, [preparePreview, release, resolveTarget]);

  const actions = useMemo(() => ({ ...controller, requestPreview }), [controller, requestPreview]);
  const minimize = useCallback(() => {
    if (pending.current) pending.current.autoOpen = false;
    setExpanded(false);
  }, []);
  const finishPreview = () => {
    const key = pending.current?.key;
    setDismissed(previous => {
      const next = new Set(previous);
      for (const item of controller.transfers) {
        if (item.operation === 'preview' && item.key === key && item.status !== 'active') next.add(item.id);
      }
      return next;
    });
    closePreview();
  };
  const dismiss = (id: string) => {
    const item = controller.transfers.find(transfer => transfer.id === id);
    if (item?.operation === 'preview' && item.key === pending.current?.key) {
      pending.current.autoOpen = false;
      if (item.status !== 'active') closePreview();
    }
    setDismissed(previous => new Set(previous).add(id));
  };
  const viewTransfer = (item: AttachmentTransfer) => {
    const held = pending.current;
    if (held?.key === item.key && held.url && held.preparedAt !== undefined && Date.now() - held.preparedAt < REOPEN_PREVIEW_AFTER_MS) {
      held.autoOpen = true;
      setExpanded(true);
    } else requestPreview({ emailId: item.emailId, accountId: item.accountId,
      attachments: [{ name: item.filename }], initialIndex: 0 });
  };
  const savedAction = async (id: string, action: 'open' | 'reveal') => {
    const item = controller.transfers.find(transfer => transfer.id === id);
    if (!item?.savedFileId || (action === 'open' && !item.canOpenSavedFile)) return;
    try {
      const result = await (action === 'open' ? window.electronAPI.emails.openSavedAttachment(item.savedFileId)
        : window.electronAPI.emails.revealSavedAttachment(item.savedFileId));
      if (!result.success) throw new Error('Saved file unavailable');
      controller.updateTransfer(id, { error: undefined });
    } catch {
      controller.updateTransfer(id, { error: 'This saved file is no longer available. Download it again.' });
    }
  };
  const retry = (item: AttachmentTransfer) => {
    const target = { emailId: item.emailId, filename: item.filename, accountId: item.accountId };
    setDismissed(previous => new Set(previous).add(item.id));
    if (item.operation === 'preview') viewTransfer(item);
    else if (item.operation === 'save') void controller.saveCopy(target);
    else void controller.openInSystemApp(target);
  };

  return <AttachmentActionsContext.Provider value={actions}>
    {children}
    <AttachmentTransferPopup transfers={controller.transfers.filter(item => !dismissed.has(item.id))}
      onCancel={id => {
        const item = controller.transfers.find(transfer => transfer.id === id);
        if (!item) return;
        if (item.key === pending.current?.key) closePreview();
        void controller.cancelDownload(item.emailId, item.filename, item.accountId);
      }}
      onDismiss={dismiss} onMinimize={minimize}
      onPreview={id => { const item = controller.transfers.find(transfer => transfer.id === id); if (item) viewTransfer(item); }}
      onRetry={id => { const item = controller.transfers.find(transfer => transfer.id === id); if (item) retry(item); }}
      onOpenFile={id => { void savedAction(id, 'open'); }} onShowFolder={id => { void savedAction(id, 'reveal'); }} />
    {preview && expanded && <AttachmentViewer key={preview.id} emailId={preview.request.emailId}
      accountId={preview.request.accountId} attachments={preview.request.attachments} initialIndex={preview.request.initialIndex}
      actions={actions} preparedUrl={preview.url} onClose={finishPreview} onMinimize={minimize}
      onRetryPreview={() => { const request = preview.request; closePreview(); requestPreview(request); }}
      onNavigate={index => requestPreview({ ...preview.request, initialIndex: index })} />}
  </AttachmentActionsContext.Provider>;
}
