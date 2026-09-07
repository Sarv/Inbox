import { useEffect, useRef, useCallback } from 'react';

import { useEmailStore } from '../store/email-store';

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
  /** Account that owns this draft — routes save/delete to the RIGHT per-account
   *  DB + IMAP engine. Without it they hit the active account (wrong DB when the
   *  draft belongs to another account / opened from All Inboxes). */
  accountId?: string;
}

const DEBOUNCE_MS = 10_000; // 10 seconds

export function useDraftAutosave(opts: DraftAutosaveOptions) {
  const { imapConfig } = useEmailStore();
  const accountEmail = imapConfig?.username || '';

  // Keep latest values in refs to avoid stale closures
  const latestRef = useRef(opts);
  latestRef.current = opts;

  const savingRef = useRef(false);
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
    const { to, cc, bcc, subject, htmlBody } = latestRef.current;
    return [to, cc || '', bcc || '', subject, htmlBody].join('\u0000');
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
  const baselineKeyRef = useRef<string | null>(opts.initialDraftMessageId ? null : '');
  useEffect(() => {
    if (baselineKeyRef.current === null && (opts.htmlBody || opts.body)) {
      baselineKeyRef.current = contentKey();
    }
  }, [opts.htmlBody, opts.body, contentKey]);

  const hasContent = useCallback(() => {
    const { to, subject, body, htmlBody, inReplyTo } = latestRef.current;
    const bodyHasContent = !!(body.trim() || htmlBody.replace(/<[^>]*>/g, '').trim());
    // For a REPLY/reply-all the recipient + subject are auto-filled, so they must
    // NOT count as "content" — only a user-typed body makes the draft worth
    // keeping. This is what makes "open a reply, type nothing, click away" simply
    // close (no draft), while "type something, click away" saves a draft — and it
    // stops empty replies from piling up as drafts just by being opened.
    if (inReplyTo) return bodyHasContent;
    // New compose (or forward): any user-entered field counts.
    return bodyHasContent || !!to.trim() || !!subject.trim();
  }, []);

  const saveDraft = useCallback(async () => {
    if (savingRef.current || sentRef.current) return;
    if (!hasContent()) return;
    // Unchanged since it was opened → do NOT re-save. Re-saving an untouched
    // draft mints a new message-id every cycle and that churn outpaces discard,
    // making the draft effectively immortal. Only a real edit gets saved.
    if (baselineKeyRef.current !== null && contentKey() === baselineKeyRef.current) {
      return;
    }

    const { to, cc, bcc, subject, body, htmlBody, inReplyTo, threadId, accountId } = latestRef.current;
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
      baselineKeyRef.current = contentKey();

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
  }, [opts.to, opts.cc, opts.bcc, opts.subject, opts.body, opts.htmlBody, saveDraft]);

  // Save on unmount (close without send)
  useEffect(() => {
    return () => {
      // Skip if discarded, if a debounced save is already in flight (it'll finish
      // and persist — launching another here would append a SECOND draft to the
      // thread), if there's no content, OR if the opened draft was never edited
      // (unchanged baseline — re-saving an untouched draft on close is the churn
      // that made drafts immortal).
      const unchanged = baselineKeyRef.current !== null && contentKey() === baselineKeyRef.current;
      if (!sentRef.current && !savingRef.current && hasContent() && !unchanged) {
        // SAVE-THEN-DELETE on teardown, matching saveDraft. The old order deleted
        // the thread's draft(s) and THEN saved fire-and-forget DURING unmount — if
        // the quit interrupted that gap, the draft was lost. Now we persist the new
        // draft FIRST and only delete the superseded one once the save resolves, so
        // an interrupted teardown can at worst leave a duplicate (never zero drafts).
        const { to, cc, bcc, subject, body, htmlBody, inReplyTo, threadId, accountId } = latestRef.current;
        const supersededMessageId = ownedMessageIdRef.current;
        window.electronAPI.drafts
          .save({ to, cc, bcc, subject, body, htmlBody, inReplyTo, threadId, accountId, accountEmail })
          .then((res: any) => {
            // Delete the superseded draft by its Message-ID only — never the
            // just-saved one (save mints a fresh id, so they can't collide).
            const newMessageId: string | undefined = res?.messageId;
            if (supersededMessageId && supersededMessageId !== newMessageId) {
              window.electronAPI.drafts.delete({ messageId: supersededMessageId, accountId }).catch(() => {});
            }
          })
          .catch(() => {});
      }
    };
  }, []); // Empty deps — runs only on unmount

  return { deleteDraft, markDiscarded };
}
