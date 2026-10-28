import { createLogger } from '@sarvinbox/core/logger';
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

import type { AttachmentDownloadPhase } from '../../../electron/preload';

import { AttachmentActionsContext } from './attachment-actions-context';
import type { AttachmentTransfer } from './attachment-transfer-types';
import type { ViewerAttachment } from './AttachmentViewer';

const log = createLogger('Attachment');

/** Per-message identity: attachments with the same name spin independently. */
export function attachmentKey(emailId: string, filename: string, accountId?: string): string {
  return accountId ? JSON.stringify([accountId, emailId, filename]) : `${emailId}:${filename}`;
}

export interface AttachmentTarget {
  emailId: string;
  filename: string;
  /** Owning account, for rows from the unified "All Inboxes" view. */
  accountId?: string;
}

export interface AttachmentDownloadState {
  phase?: AttachmentDownloadPhase;
  operation?: 'save' | 'open' | 'preview';
  error?: string;
  cancelled?: boolean;
  cancelling?: boolean;
  canCancel?: boolean;
  /** The user explicitly accepted the host's missing-setup warning. */
  notScanned?: boolean;
  transferredBytes?: number;
  totalBytes?: number;
}

export interface AttachmentPreviewRequest {
  emailId: string;
  accountId?: string;
  attachments: ViewerAttachment[];
  initialIndex: number;
}

export interface AttachmentActions {
  isBusy: (emailId: string, filename: string, accountId?: string) => boolean;
  getStatus: (emailId: string, filename: string, accountId?: string) => AttachmentDownloadState | undefined;
  saveCopy: (target: AttachmentTarget) => Promise<void>;
  openInSystemApp: (target: AttachmentTarget) => Promise<void>;
  /** Host-owned URL; no element may read an attachment before this resolves. */
  preparePreview: (target: AttachmentTarget, signal?: AbortSignal) => Promise<string | undefined>;
  /** Sequential saves; a blocked or cancelled attachment stops the batch. */
  saveAll: (emailId: string, filenames: string[], accountId?: string) => Promise<void>;
  cancelDownload: (emailId: string, filename: string, accountId?: string) => Promise<void>;
  /** App-level preview preparation survives leaving the email that opened it. */
  requestPreview?: (request: AttachmentPreviewRequest) => void;
}

// Main returns these host-owned messages. Arbitrary IPC/server errors must never
// reveal credentials, internal paths, or remote response bodies in the renderer.
const SAFE_ATTACHMENT_ERRORS = new Set([
  'Download blocked: ClamAV detected a threat.',
  'Download blocked: the attachment could not be fully scanned.',
  'Download blocked: scanning failed. Try again when the scanner is available.',
  'Configure ClamAV Scan before downloading attachments.',
  'This account is not approved for attachment scanning. Review scanner setup.',
  'Download blocked: scanner settings changed. Review scanner setup and try again.',
  'Download blocked: this attachment is unavailable or exceeds the scanner limits.',
  'Download blocked: attachment details timed out. Reconnect this account and try again.',
  'Download blocked: attachment details are unavailable. Reopen this email and try again.',
  'Download blocked: this attachment is unavailable. Reopen this email and try again.',
  'Download blocked: multiple attachments have this name and cannot be safely distinguished.',
  'Download blocked: this account is offline. Reconnect it and try again.',
  'More than one antivirus extension is enabled. Enable one scanner before downloading.',
  'The antivirus extension is unavailable or lacks attachment scanning permission. Download blocked.',
  'Set up antivirus scanning and allow this account before downloading attachments.',
  'Antivirus scanning was disabled or changed. Download cancelled.',
  'Antivirus scanning was enabled. Retry the download to scan this attachment.',
  'Attachment download timed out.',
  'Download blocked: encrypted OpenPGP attachments cannot be scanned.',
  'Preview blocked: scan this attachment again before viewing.',
  'Too many attachment previews. Close a viewer and try again.',
  'Too many attachment previews. Try again shortly.',
  'Antivirus setup changed. Try again.',
  'Attachment is too large to open or save without scanning.',
]);

const attachmentError = (error: unknown, action: 'save' | 'open' | 'preview') =>
  typeof error === 'string' && SAFE_ATTACHMENT_ERRORS.has(error)
    ? error
    : action === 'save'
      ? 'The attachment could not be saved. Check your connection and try again.'
      : 'The attachment could not be opened. Try again.';

interface ActiveAction {
  requestId?: string;
  unsubscribe?: () => void;
  state: AttachmentDownloadState;
  done: Promise<void>;
}

function stopListening(operation: ActiveAction) {
  operation.unsubscribe?.();
  operation.unsubscribe = undefined;
}

/** The shared scan gate for saves, system opens and in-app attachment viewing. */
export function useAttachmentController(resolveTarget?: (target: AttachmentTarget) => AttachmentTarget) {
  const [statuses, setStatuses] = useState<Map<string, AttachmentDownloadState>>(new Map());
  const [transferMap, setTransferMap] = useState<Map<string, AttachmentTransfer>>(new Map());
  const active = useRef(new Map<string, ActiveAction>());
  const identities = useRef(new Map<string, AttachmentTarget>());
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    const operations = active.current;
    return () => {
      mounted.current = false;
      // Closing a message/viewer leaves its already-requested save running, but
      // cannot leave progress listeners retaining the unmounted component.
      for (const action of operations.values()) stopListening(action);
    };
  }, []);

  const updateTransfer = useCallback((id: string, patch: Partial<AttachmentTransfer>) => {
    if (!mounted.current) return;
    setTransferMap(previous => {
      const held = previous.get(id);
      if (!held) return previous;
      const next = new Map(previous);
      next.set(id, { ...held, ...patch, updatedAt: Date.now() });
      return next;
    });
  }, []);

  const putStatus = useCallback((key: string, state?: AttachmentDownloadState) => {
    if (!mounted.current) return;
    if (!state) identities.current.delete(key);
    setStatuses((previous) => {
      const next = new Map(previous);
      if (state) next.set(key, state);
      else next.delete(key);
      return next;
    });
  }, []);

  const requestCancellation = useCallback(async (key: string, operation: ActiveAction) => {
    if (!operation.requestId || operation.state.cancelling) return;
    operation.state = { ...operation.state, cancelling: true, error: undefined };
    putStatus(key, operation.state);
    updateTransfer(operation.requestId, { cancelling: true, error: undefined });
    try {
      const result = await window.electronAPI.emails.cancelAttachmentDownload(operation.requestId);
      if (!result.success) throw new Error('Cancellation unavailable');
    } catch {
      if (active.current.get(key) === operation) {
        operation.state = { ...operation.state, cancelling: false, error: 'Could not cancel the download. Try again.' };
        putStatus(key, operation.state);
        updateTransfer(operation.requestId, { cancelling: false, error: operation.state.error });
      }
    }
  }, [putStatus, updateTransfer]);

  const run = useCallback(async (
    target: AttachmentTarget,
    action: 'save' | 'open' | 'preview',
    signal?: AbortSignal,
  ): Promise<boolean | string> => {
    const { emailId, filename, accountId } = resolveTarget?.(target) ?? target;
    const key = attachmentKey(emailId, filename, accountId);
    // Ref guard works before React paints the disabled control, preventing a
    // double click from creating two scanner requests/native save dialogs.
    if (active.current.has(key) || signal?.aborted) return false;
    let finish!: () => void;
    const operation: ActiveAction = {
      requestId: crypto.randomUUID(),
      state: { phase: 'downloading', canCancel: true, operation: action },
      done: new Promise((resolve) => { finish = resolve; }),
    };
    const abort = () => {
      if (active.current.get(key) !== operation) return;
      // A viewer closing may cancel only its preview, never a save it waited for.
      void requestCancellation(key, operation);
    };
    signal?.addEventListener('abort', abort, { once: true });
    active.current.set(key, operation);
    identities.current.set(key, { emailId, filename, accountId });
    setTransferMap(previous => {
      const next = new Map(previous);
      next.set(operation.requestId!, { id: operation.requestId!, key, emailId, filename, accountId, operation: action,
        status: 'active', phase: 'downloading', canCancel: true, startedAt: Date.now(), updatedAt: Date.now() });
      // Bound notification history without evicting ongoing work.
      for (const [id, item] of next) {
        if (next.size <= 20) break;
        if (item.status !== 'active') next.delete(id);
      }
      return next;
    });
    putStatus(key, operation.state);

    try {
      if (operation.requestId) {
        // Subscribe before invoking: a cache hit can enter scanning immediately.
        operation.unsubscribe = window.electronAPI.emails.onAttachmentDownloadProgress?.((progress) => {
          if (progress?.requestId !== operation.requestId || active.current.get(key) !== operation ||
            !['downloading', 'uploading', 'scanning', 'saving'].includes(progress.phase)) return;
          const counts = {
            transferredBytes: Number.isFinite(progress.transferredBytes) && progress.transferredBytes! >= 0 ? progress.transferredBytes : undefined,
            totalBytes: Number.isFinite(progress.totalBytes) && progress.totalBytes! > 0 ? progress.totalBytes : undefined,
          };
          operation.state = { ...operation.state, phase: progress.phase,
            ...(counts.transferredBytes !== undefined || counts.totalBytes !== undefined ? counts : {}) };
          putStatus(key, operation.state);
          updateTransfer(operation.requestId!, { phase: progress.phase, ...counts });
        });
      }
      const result = action === 'save'
        ? await (window.electronAPI.emails.downloadAttachmentToDownloads ?? window.electronAPI.emails.downloadAttachment)(emailId, filename, accountId, operation.requestId)
        : action === 'open'
          ? await window.electronAPI.emails.previewAttachment(emailId, filename, accountId, operation.requestId)
          : await window.electronAPI.emails.prepareAttachmentPreview(emailId, filename, accountId, operation.requestId);
      if (result.success && (action !== 'preview' || ('url' in result && typeof result.url === 'string' && result.url))) {
        // Cancellation can race a cache hit. Do not display stale prepared bytes.
        if (signal?.aborted && action === 'preview' && 'url' in result && typeof result.url === 'string') {
          void window.electronAPI.emails.releaseAttachmentPreview(result.url).catch(() => {});
          updateTransfer(operation.requestId!, { status: 'cancelled', phase: undefined, canCancel: false, cancelling: false });
          putStatus(key, { cancelled: true, operation: action });
          return false;
        }
        putStatus(key, result.notScanned === true ? { notScanned: true, operation: action } : undefined);
        updateTransfer(operation.requestId!, { status: action === 'save' ? 'saved' : action === 'preview' ? 'ready' : 'opened',
          phase: undefined, canCancel: false, cancelling: false, notScanned: result.notScanned === true,
          ...('filePath' in result && typeof result.filePath === 'string' ? { filePath: result.filePath } : {}),
          ...('savedFileId' in result && typeof result.savedFileId === 'string' ? { savedFileId: result.savedFileId } : {}),
          ...('canOpenSavedFile' in result ? { canOpenSavedFile: result.canOpenSavedFile === true } : {}) });
        return action === 'preview' && 'url' in result ? result.url as string : true;
      }
      if (result.error === 'Save cancelled' || result.error === 'Download cancelled.') {
        putStatus(key, { cancelled: true, operation: action });
        updateTransfer(operation.requestId!, { status: 'cancelled', phase: undefined, canCancel: false, cancelling: false });
      } else {
        const error = attachmentError(result.error, action);
        putStatus(key, { error, operation: action });
        updateTransfer(operation.requestId!, { status: 'failed', phase: undefined, error, canCancel: false, cancelling: false });
        log.error(`${action} failed: ${error}`);
      }
      return false;
    } catch {
      const error = attachmentError(undefined, action);
      putStatus(key, { error, operation: action });
      updateTransfer(operation.requestId!, { status: 'failed', phase: undefined, error, canCancel: false, cancelling: false });
      log.error(`${action} failed: ${error}`);
      return false;
    } finally {
      signal?.removeEventListener('abort', abort);
      stopListening(operation);
      active.current.delete(key);
      finish();
    }
  }, [putStatus, updateTransfer, requestCancellation, resolveTarget]);

  const saveCopy = useCallback(async (target: AttachmentTarget) => { await run(target, 'save'); }, [run]);
  const openInSystemApp = useCallback(async (target: AttachmentTarget) => { await run(target, 'open'); }, [run]);

  const preparePreview = useCallback(async (target: AttachmentTarget, signal?: AbortSignal) => {
    const bound = resolveTarget?.(target) ?? target;
    // Entering the viewer while Save is running shares its progress and waits.
    // A new preview cannot race that save or cancel it when the viewer closes.
    const key = attachmentKey(bound.emailId, bound.filename, bound.accountId);
    while (active.current.has(key)) {
      await active.current.get(key)!.done;
      if (signal?.aborted) return undefined;
    }
    const result = await run(bound, 'preview', signal);
    return typeof result === 'string' ? result : undefined;
  }, [run, resolveTarget]);

  const saveAll = useCallback(async (emailId: string, filenames: string[], accountId?: string) => {
    const owner = (resolveTarget?.({ emailId, filename: filenames[0] ?? '', accountId }) ?? { accountId }).accountId;
    for (const filename of filenames) {
      if (!await run({ emailId, filename, accountId: owner }, 'save')) break;
    }
  }, [run, resolveTarget]);

  const cancelDownload = useCallback(async (emailId: string, filename: string, accountId?: string) => {
    const target = resolveTarget?.({ emailId, filename, accountId }) ?? { emailId, filename, accountId };
    const key = attachmentKey(target.emailId, target.filename, target.accountId);
    const operation = active.current.get(key);
    if (operation) await requestCancellation(key, operation);
  }, [requestCancellation, resolveTarget]);

  const getStatus = useCallback((emailId: string, filename: string, accountId?: string) => {
    const direct = statuses.get(attachmentKey(emailId, filename, accountId));
    if (direct || accountId) return direct;
    const matching = [...identities.current].filter(([key, target]) => target.emailId === emailId && target.filename === filename && statuses.has(key));
    return matching.length === 1 ? statuses.get(matching[0][0]) : undefined;
  }, [statuses]);
  const isBusy = useCallback((emailId: string, filename: string, accountId?: string) =>
    Boolean(getStatus(emailId, filename, accountId)?.phase), [getStatus]);

  const transfers = useMemo(() => [...transferMap.values()].reverse(), [transferMap]);

  return { isBusy, getStatus, saveCopy, openInSystemApp, preparePreview, saveAll, cancelDownload, transfers, updateTransfer };
}

/** A single app-owned controller in production; isolated embeds retain a local fallback. */
export function useAttachmentActions(): AttachmentActions {
  const shared = useContext(AttachmentActionsContext);
  const local = useAttachmentController();
  return shared ?? local;
}
