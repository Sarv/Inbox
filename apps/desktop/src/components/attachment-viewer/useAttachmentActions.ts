import { useCallback, useState } from 'react';

/**
 * The one implementation of "what happens when you touch an attachment".
 *
 * EmailCard, ThreadList and ThreadChatView each carried their own near-verbatim
 * copy of this (and ThreadChatView's copy silently dropped the failure handling,
 * so a failed save looked exactly like a successful one). They now all call this.
 */

/** Key for the in-flight set. Per email AND filename — two messages in a thread
 *  can carry the same attachment name, and they must spin independently. */
export function attachmentKey(emailId: string, filename: string): string {
  return `${emailId}:${filename}`;
}

export interface AttachmentTarget {
  emailId: string;
  filename: string;
  /** Owning account, for rows from the unified "All Inboxes" view. */
  accountId?: string;
}

export interface AttachmentActions {
  /** True while this attachment is being fetched for a save / system-open. */
  isBusy: (emailId: string, filename: string) => boolean;
  /** Save a copy to a location the user picks. Opens nothing. */
  saveCopy: (target: AttachmentTarget) => Promise<void>;
  /** Hand the file to the OS default app. Main re-checks the launch allow-list. */
  openInSystemApp: (target: AttachmentTarget) => Promise<void>;
  /** Save every attachment on one email, one dialog at a time. */
  saveAll: (emailId: string, filenames: string[], accountId?: string) => Promise<void>;
}

export function useAttachmentActions(): AttachmentActions {
  const [busy, setBusy] = useState<Set<string>>(new Set());

  const run = useCallback(
    async (
      { emailId, filename, accountId }: AttachmentTarget,
      action: 'save' | 'open',
    ): Promise<void> => {
      const key = attachmentKey(emailId, filename);
      setBusy((prev) => new Set(prev).add(key));
      try {
        const result =
          action === 'save'
            ? await window.electronAPI.emails.downloadAttachment(emailId, filename, accountId)
            : await window.electronAPI.emails.previewAttachment(emailId, filename, accountId);
        // A cancelled save dialog is the user changing their mind, not a failure —
        // logging it as an error trained everyone to ignore the real ones.
        if (!result.success && result.error !== 'Save cancelled') {
          // Renderer logs go through console.* on purpose — see
          // bootstrap/renderer-logging.ts, which forwards them into app.log.
          console.error(`[Attachment] ${action} failed:`, result.error);
        }
      } catch (error) {
        console.error(`[Attachment] ${action} error:`, error);
      } finally {
        setBusy((prev) => {
          const next = new Set(prev);
          next.delete(key);
          return next;
        });
      }
    },
    [],
  );

  const saveCopy = useCallback((target: AttachmentTarget) => run(target, 'save'), [run]);
  const openInSystemApp = useCallback((target: AttachmentTarget) => run(target, 'open'), [run]);

  const saveAll = useCallback(
    async (emailId: string, filenames: string[], accountId?: string) => {
      // Sequential on purpose: each save opens a native dialog, and firing them
      // in parallel would stack modal dialogs on top of each other.
      for (const filename of filenames) {
        await saveCopy({ emailId, filename, accountId });
      }
    },
    [saveCopy],
  );

  const isBusy = useCallback(
    (emailId: string, filename: string) => busy.has(attachmentKey(emailId, filename)),
    [busy],
  );

  return { isBusy, saveCopy, openInSystemApp, saveAll };
}
