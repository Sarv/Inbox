import { useEffect, useRef, useCallback } from 'react';

import type { AttachmentFile } from '../components/useCompose';
import { useEmailStore } from '../store/email-store';
import { attachmentsKey, toDraftAttachments } from '../utils/compose-attachments';

interface DraftAutosaveOptions {
  to: string;
  cc?: string;
  bcc?: string;
  subject: string;
  body: string;
  htmlBody: string;
  inReplyTo?: string;
  /** Thread id of the email being replied to — used to clean up preset/AI draft
   *  rows on discard even when the autosave hook never wrote them itself. */
  threadId?: string;
  /** Message-id of the draft that was OPENED into this editor (edit-an-existing
   *  draft). Seeds the delete-before-resave chain so editing replaces THAT draft
   *  in place, and discard removes exactly it — never its sibling drafts. */
  initialDraftMessageId?: string;
  /** The opened content is NEWER than the saved draft `initialDraftMessageId`
   *  names — an Undo-send restore, where autosave last ran up to DEBOUNCE_MS
   *  before Send. The draft is still owned (so the next save REPLACES it rather
   *  than adding a duplicate), but closing unedited must save, not skip. */
  initialDraftUnsaved?: boolean;
  /** The subject was filled in FOR the user (a forward's "Fwd: …"), so on its
   *  own it is not work worth keeping — only recipients or a typed body are. */
  subjectPrefilled?: boolean;
  /** Shapes what is WRITTEN as the draft body, when that is more than the
   *  editor — a forward's draft carries the forwarded message under the note,
   *  so it still makes sense reopened from Drafts. Change detection keeps
   *  reading the editor content alone. */
  composeForSave?: (content: { body: string; htmlBody: string }) => { body: string; htmlBody: string };
  /** Files attached in the composer — saved with the draft, so reopening it
   *  brings them back. Adding or removing one counts as an edit. */
  attachments?: AttachmentFile[];
  /** The attachments were filled in FOR the user (a forward's original files),
   *  so on their own they are not work worth keeping — like subjectPrefilled. */
  attachmentsPrefilled?: boolean;
  /** Account that owns this draft — routes save/delete to the RIGHT per-account
   *  DB + IMAP engine. Without it they hit the active account (wrong DB when the
   *  draft belongs to another account / opened from All Inboxes). */
  accountId?: string;
}

const DEBOUNCE_MS = 10_000; // 10 seconds

/**
 * What closing a composer should do:
 *  - `discard` — nothing worth keeping (empty, or only an auto-filled reply
 *    header): close and clean up, no question.
 *  - `keep` — an opened draft the user didn't change: close and leave it as it
 *    was, no question.
 *  - `ask` — there is work the user hasn't said what to do with: ask Save/Discard.
 */
export type CloseAction = 'ask' | 'keep' | 'discard';

export function decideCloseAction(state: { hasContent: boolean; unchangedSinceOpened: boolean }): CloseAction {
  if (!state.hasContent) return 'discard';
  return state.unchangedSinceOpened ? 'keep' : 'ask';
}

export function useDraftAutosave(opts: DraftAutosaveOptions) {
  const { imapConfig } = useEmailStore();
  const accountEmail = imapConfig?.username || '';

  // Keep latest values in refs to avoid stale closures
  const latestRef = useRef(opts);
  latestRef.current = opts;

  const savingRef = useRef(false);
  // The save currently in flight, so a close can wait for it and then persist
  // anything typed after it started (see the unmount effect).
  const inFlightRef = useRef<Promise<void> | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sentRef = useRef(false);
  // The message-id of the draft this hook currently "owns" — either the one
  // opened into the editor (initialDraftMessageId) or the one we last saved.
  // Every save deletes THIS message-id then writes a fresh one and updates the
  // ref; discard deletes THIS message-id. Message-id is the stable per-draft
  // identity, so a thread with several drafts only ever loses the one in play
  // (Gmail-style 6→5) instead of all of them.
  const ownedMessageIdRef = useRef<string | undefined>(opts.initialDraftMessageId);

  // A stable fingerprint of the editable content. Used to detect whether the
  // user actually CHANGED an opened draft — if not, we must never re-save it.
  const contentKey = useCallback(() => {
    // Use htmlBody (canonical editor content, set SYNCHRONOUSLY from the opened
    // draft) — NOT plainBody, which an InlineReply effect sets one render LATER.
    // Including it made the baseline (captured while plainBody was '') never match
    // once it filled in, re-saving an unedited opened draft every time (churn).
    const { to, cc, bcc, subject, htmlBody, attachments } = latestRef.current;
    return [to, cc || '', bcc || '', subject, htmlBody, attachmentsKey(attachments)].join('\u0000');
  }, []);

  // Baseline = the content as it was OPENED into the editor.
  //  - Editing an EXISTING draft (initialDraftMessageId set): start null, then
  //    capture the opened content once it lands; saveDraft skips while the key
  //    still equals this baseline. This is THE fix for immortal drafts — merely
  //    opening a draft (no edits) used to trigger a re-save every 10s that minted
  //    a NEW message-id, and that churn outpaced the discard, so the draft could
  //    never die.
  //  - Fresh reply/compose (no initialDraftMessageId): baseline '' so the first
  //    real content counts as a change and saves normally.
  const baselineKeyRef = useRef<string | null>(
    opts.initialDraftMessageId && !opts.initialDraftUnsaved ? null : '',
  );
  // The content as OPENED, frozen for the life of the editor (the baseline above
  // moves on every save). Only an opened, already-saved draft has one: closing it
  // unchanged needs no question. Fresh compose and an unsaved restore stay null.
  const openedKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (baselineKeyRef.current === null && (opts.htmlBody || opts.body)) {
      baselineKeyRef.current = contentKey();
      openedKeyRef.current = baselineKeyRef.current;
    }
  }, [opts.htmlBody, opts.body, contentKey]);

  const hasContent = useCallback(() => {
    const { to, subject, body, htmlBody, inReplyTo, subjectPrefilled, attachments, attachmentsPrefilled } = latestRef.current;
    // A file the user attached is work, even with nothing typed around it.
    const bodyHasContent = !!(body.trim() || htmlBody.replace(/<[^>]*>/g, '').trim())
      || (!attachmentsPrefilled && (attachments?.length ?? 0) > 0);
    // For a REPLY/reply-all the recipient + subject are auto-filled, so they must
    // NOT count as "content" — only a user-typed body makes the draft worth
    // keeping. This is what makes "open a reply, type nothing, click away" simply
    // close (no draft), while "type something, click away" saves a draft — and it
    // stops empty replies from piling up as drafts just by being opened.
    if (inReplyTo) return bodyHasContent;
    // New compose (or forward): any user-entered field counts.
    return bodyHasContent || !!to.trim() || (!subjectPrefilled && !!subject.trim());
  }, []);

  // What the close button should do with this editor — see decideCloseAction.
  const closeAction = useCallback(
    (): CloseAction =>
      decideCloseAction({
        hasContent: !sentRef.current && hasContent(),
        unchangedSinceOpened: openedKeyRef.current !== null && contentKey() === openedKeyRef.current,
      }),
    [hasContent, contentKey],
  );

  const runSave = useCallback(async () => {
    if (savingRef.current || sentRef.current) return;
    if (!hasContent()) return;
    // Unchanged since it was opened → do NOT re-save. Re-saving an untouched
    // draft mints a new message-id every cycle and that churn outpaces discard,
    // making the draft effectively immortal. Only a real edit gets saved.
    if (baselineKeyRef.current !== null && contentKey() === baselineKeyRef.current) {
      return;
    }

    const { to, cc, bcc, subject, inReplyTo, threadId, accountId, composeForSave, attachments } = latestRef.current;
    const edited = { body: latestRef.current.body, htmlBody: latestRef.current.htmlBody };
    const { body, htmlBody } = composeForSave ? composeForSave(edited) : edited;
    // Fingerprint of exactly what THIS save writes. The baseline must be this
    // snapshot, not contentKey() read after the await: that read picks up edits
    // typed while the save was in flight, marks them "saved", and the next
    // autosave/close then skips them as unchanged — they are never persisted.
    const savedKey = contentKey();
    savingRef.current = true;

    // The draft this hook currently OWNS (the one being superseded). Captured
    // BEFORE the save so we can delete it only AFTER the new draft is durably
    // persisted — never before.
    const supersededMessageId = ownedMessageIdRef.current;

    try {
      // SAVE-THEN-DELETE (never delete-then-save). The old order deleted the
      // thread's draft(s) FIRST and only then saved the new content, so between
      // the two awaits the thread had NO persisted draft — a kill/quit or a
      // failed IMAP append in that gap lost both the prior draft and the new
      // edit. We now persist the NEW draft first (minting a fresh Message-ID),
      // then remove the superseded one, so the user's content is never absent.
      const res: any = await window.electronAPI.drafts.save({
        to,
        cc,
        bcc,
        subject,
        body,
        htmlBody,
        inReplyTo,
        accountId,
        attachments: toDraftAttachments(attachments),
        // Group the draft into the SAME thread as the mail being replied to, so
        // reopening the thread finds this draft and edits it in place instead of
        // spawning a brand-new standalone draft every time (the "immortal draft"
        // bug). Without it, writeLocalDraftRow falls back to threadId = its own
        // message-id and the draft is orphaned in its own one-message thread.
        threadId,
        accountEmail,
      });

      // If the user discarded WHILE this save was in flight, undo it — otherwise
      // the just-written draft resurrects the one they just deleted. (The discard
      // path already removed the superseded draft, so skip that delete too.)
      if (sentRef.current) {
        if (res?.messageId) {
          window.electronAPI.drafts.delete({ messageId: res.messageId, accountId }).catch(() => {});
        }
        return;
      }

      // Take ownership of the freshly written draft so the next save/discard
      // targets it, and update the baseline so an unchanged follow-up won't re-save.
      const newMessageId: string | undefined = res?.messageId;
      ownedMessageIdRef.current = newMessageId || ownedMessageIdRef.current;
      baselineKeyRef.current = savedKey;

      // Enforce ONE draft per thread: now that the new draft is persisted, remove
      // the superseded one by its Message-ID. Targeting the OLD message-id (never
      // threadId) means we can't delete the draft we just wrote — save() always
      // mints a brand-new id, so newMessageId !== supersededMessageId. This keeps
      // repeated edits from accumulating duplicates WITHOUT the loss window.
      if (supersededMessageId && supersededMessageId !== newMessageId) {
        window.electronAPI.drafts
          .delete({ messageId: supersededMessageId, accountId })
          .catch(() => {});
      }
      console.log('[DraftAutosave] Draft saved', ownedMessageIdRef.current);
    } catch (error) {
      console.error('[DraftAutosave] Failed to save draft:', error);
    } finally {
      savingRef.current = false;
    }
  }, [accountEmail, hasContent, contentKey]);

  const saveDraft = useCallback((): Promise<void> => {
    const run = runSave().finally(() => {
      if (inFlightRef.current === run) inFlightRef.current = null;
    });
    inFlightRef.current = run;
    return run;
  }, [runSave]);
  const saveDraftRef = useRef(saveDraft);
  saveDraftRef.current = saveDraft;

  // Mark this draft as done WITHOUT deleting — cancels the pending autosave and
  // blocks the unmount re-save, then hands the caller the message-id it currently
  // owns so an optimistic discard (instant UI removal + background delete +
  // rollback) can target exactly this draft. Returns undefined if nothing was
  // ever saved (nothing to delete).
  const markDiscarded = useCallback((): string | undefined => {
    sentRef.current = true;
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const owned = ownedMessageIdRef.current;
    ownedMessageIdRef.current = undefined;
    return owned;
  }, []);

  const deleteDraft = useCallback(async () => {
    sentRef.current = true;
    // Cancel any pending save
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }

    try {
      // Delete the WHOLE thread's drafts (one-draft-per-thread), not just the one
      // this editor owns. A thread can hold a SIBLING draft — e.g. the pipeline's
      // AI auto-draft that was never adopted by this composer — and deleting only
      // the owned message-id left that sibling behind to auto-reopen after send
      // ("new draft keeps coming back"). Fall back to message-id, then
      // subject/recipient, when there's no thread. The IPC is idempotent.
      const { accountId, threadId, subject, to } = latestRef.current;
      if (threadId) {
        await window.electronAPI.drafts.delete({ threadId, accountId });
      } else if (ownedMessageIdRef.current) {
        await window.electronAPI.drafts.delete({ messageId: ownedMessageIdRef.current, accountId });
      } else {
        await window.electronAPI.drafts.delete({ subject, to, accountId });
      }
      ownedMessageIdRef.current = undefined;
      console.log('[DraftAutosave] Draft(s) deleted for thread');
    } catch (error) {
      console.error('[DraftAutosave] Failed to delete draft:', error);
    }
  }, []);

  // Debounced save on content change
  const attachmentsFingerprint = attachmentsKey(opts.attachments);
  useEffect(() => {
    if (sentRef.current) return;

    if (timerRef.current) {
      clearTimeout(timerRef.current);
    }

    timerRef.current = setTimeout(() => {
      saveDraft();
    }, DEBOUNCE_MS);

    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [opts.to, opts.cc, opts.bcc, opts.subject, opts.body, opts.htmlBody, attachmentsFingerprint, saveDraft]);

  // Save on unmount (close without send). Goes through saveDraft, so it gets
  // the same content/unchanged/discarded checks and the same save-then-delete of
  // the superseded draft. If an autosave is still uploading, wait for it and
  // THEN save: skipping here (the old behaviour) dropped whatever was typed after
  // that autosave began — close within a few seconds of a pause lost the edit.
  // The follow-up save is a no-op when nothing changed since (baseline match).
  useEffect(() => {
    return () => {
      // Latest saveDraft via ref — this closure is from the first render.
      const save = () => saveDraftRef.current();
      const pending = inFlightRef.current;
      if (pending) {
        void pending.then(save);
      } else {
        void save();
      }
    };
  }, []); // Empty deps — runs only on unmount

  return { deleteDraft, markDiscarded, closeAction };
}
