import { createLogger } from '@sarvinbox/core/logger';
import { useCallback, useEffect, useRef, useState } from 'react';

import type { AttachmentDownloadPhase } from '../../../electron/preload';

const log = createLogger('Attachment');

/** Per-message identity: attachments with the same name spin independently. */
export function attachmentKey(emailId: string, filename: string): string {
  return `${emailId}:${filename}`;
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
}

export interface AttachmentActions {
  isBusy: (emailId: string, filename: string) => boolean;
  getStatus: (emailId: string, filename: string) => AttachmentDownloadState | undefined;
  saveCopy: (target: AttachmentTarget) => Promise<void>;
  openInSystemApp: (target: AttachmentTarget) => Promise<void>;
  /** Host-owned URL; no element may read an attachment before this resolves. */
  preparePreview: (target: AttachmentTarget, signal?: AbortSignal) => Promise<string | undefined>;
  /** Sequential dialogs; a blocked or cancelled attachment stops the batch. */
  saveAll: (emailId: string, filenames: string[], accountId?: string) => Promise<void>;
  cancelDownload: (emailId: string, filename: string) => Promise<void>;
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
export function useAttachmentActions(): AttachmentActions {
  const [statuses, setStatuses] = useState<Map<string, AttachmentDownloadState>>(new Map());
  const active = useRef(new Map<string, ActiveAction>());
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

  const putStatus = useCallback((key: string, state?: AttachmentDownloadState) => {
    if (!mounted.current) return;
    setStatuses((previous) => {
      const next = new Map(previous);
      if (state) next.set(key, state);
      else next.delete(key);
      return next;
    });
  }, []);

  const run = useCallback(async (
    { emailId, filename, accountId }: AttachmentTarget,
    action: 'save' | 'open' | 'preview',
    signal?: AbortSignal,
  ): Promise<boolean | string> => {
    const key = attachmentKey(emailId, filename);
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
      operation.state = { ...operation.state, cancelling: true };
      putStatus(key, operation.state);
      // A viewer closing may cancel only its preview, never a save it waited for.
      void window.electronAPI.emails.cancelAttachmentDownload(operation.requestId!).catch(() => {});
    };
    signal?.addEventListener('abort', abort, { once: true });
    active.current.set(key, operation);
    putStatus(key, operation.state);

    try {
      if (operation.requestId) {
        // Subscribe before invoking: a cache hit can enter scanning immediately.
        operation.unsubscribe = window.electronAPI.emails.onAttachmentDownloadProgress?.((progress) => {
          if (progress?.requestId !== operation.requestId || active.current.get(key) !== operation ||
            !['downloading', 'scanning', 'saving'].includes(progress.phase)) return;
          operation.state = { ...operation.state, phase: progress.phase };
          putStatus(key, operation.state);
        });
      }
      const result = action === 'save'
        ? await window.electronAPI.emails.downloadAttachment(emailId, filename, accountId, operation.requestId)
        : action === 'open'
          ? await window.electronAPI.emails.previewAttachment(emailId, filename, accountId, operation.requestId)
          : await window.electronAPI.emails.prepareAttachmentPreview(emailId, filename, accountId, operation.requestId);
      if (result.success && (action !== 'preview' || ('url' in result && typeof result.url === 'string' && result.url))) {
        putStatus(key, result.notScanned === true ? { notScanned: true, operation: action } : undefined);
        return action === 'preview' && 'url' in result ? result.url as string : true;
      }
      if (result.error === 'Save cancelled' || result.error === 'Download cancelled.') {
        putStatus(key, { cancelled: true, operation: action });
      } else {
        const error = attachmentError(result.error, action);
        putStatus(key, { error, operation: action });
        log.error(`${action} failed: ${error}`);
      }
      return false;
    } catch {
      const error = attachmentError(undefined, action);
      putStatus(key, { error, operation: action });
      log.error(`${action} failed: ${error}`);
      return false;
    } finally {
      signal?.removeEventListener('abort', abort);
      stopListening(operation);
      active.current.delete(key);
      finish();
    }
  }, [putStatus]);

  const saveCopy = useCallback(async (target: AttachmentTarget) => { await run(target, 'save'); }, [run]);
  const openInSystemApp = useCallback(async (target: AttachmentTarget) => { await run(target, 'open'); }, [run]);

  const preparePreview = useCallback(async (target: AttachmentTarget, signal?: AbortSignal) => {
    // Entering the viewer while Save is running shares its progress and waits.
    // A new preview cannot race that save or cancel it when the viewer closes.
    const key = attachmentKey(target.emailId, target.filename);
    while (active.current.has(key)) {
      await active.current.get(key)!.done;
      if (signal?.aborted) return undefined;
    }
    const result = await run(target, 'preview', signal);
    return typeof result === 'string' ? result : undefined;
  }, [run]);

  const saveAll = useCallback(async (emailId: string, filenames: string[], accountId?: string) => {
    for (const filename of filenames) {
      if (!await run({ emailId, filename, accountId }, 'save')) break;
    }
  }, [run]);

  const cancelDownload = useCallback(async (emailId: string, filename: string) => {
    const key = attachmentKey(emailId, filename);
    const operation = active.current.get(key);
    if (!operation?.requestId || operation.state.cancelling) return;
    operation.state = { ...operation.state, cancelling: true, error: undefined };
    putStatus(key, operation.state);
    try {
      const result = await window.electronAPI.emails.cancelAttachmentDownload(operation.requestId);
      if (!result.success) throw new Error('Cancellation unavailable');
    } catch {
      if (active.current.get(key) === operation) {
        operation.state = { ...operation.state, cancelling: false, error: 'Could not cancel the download. Try again.' };
        putStatus(key, operation.state);
      }
    }
  }, [putStatus]);

  const isBusy = useCallback((emailId: string, filename: string) =>
    Boolean(statuses.get(attachmentKey(emailId, filename))?.phase), [statuses]);
  const getStatus = useCallback((emailId: string, filename: string) =>
    statuses.get(attachmentKey(emailId, filename)), [statuses]);

  return { isBusy, getStatus, saveCopy, openInSystemApp, preparePreview, saveAll, cancelDownload };
}
