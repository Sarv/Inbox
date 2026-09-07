import type { EmailRecord } from '@sarvinbox/core';

import { fetchVaultSecrets, accountIdFor, effectiveSmtpConfig } from '../helpers';
import type { ComposeSlice, SliceCreator } from '../types';

const UNDO_SEND_DELAY = 5000;

/** A Message-ID is `<...>`; a row id is `<base36>-<hex>` (see core's generateId). */
export function looksLikeMessageId(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.startsWith('<') && trimmed.endsWith('>');
}

/** Bare form of a Message-ID, so `<x@y>` and `x@y` compare equal. */
const bareMessageId = (value: string | null | undefined): string =>
  (value ?? '').trim().replace(/^<|>$/g, '');

/**
 * Resolve the mail being replied to, by EITHER its row id or its RFC Message-ID.
 *
 * The two composers identify the parent differently: the popup composer passes
 * `replyToEmail.id` (a row id) while the inline reply passes the parent's real
 * Message-ID — deliberately, because that is what has to go into the outgoing
 * In-Reply-To header and what `markThreadRepliesAnswered` looks the parent up by.
 * This lookup used to match on row id only, so the inline path never found its
 * parent and the optimistic sent row was invented into a `local-thread-<ts>` of
 * its own. That row then became the newest message in the open conversation,
 * which (a) hid the send from the thread it belongs to and (b) defeated the
 * "this thread is handled" suppression keyed by thread id — so the just-sent
 * draft immediately re-opened in the composer underneath the sent mail. It also
 * left the outgoing message with no References header at all.
 */
export function findReplyTarget<T extends { id: string; messageId?: string | null }>(
  candidates: readonly T[] | null | undefined,
  inReplyTo: string,
): T | null {
  if (!candidates?.length) return null;
  const target = bareMessageId(inReplyTo);
  if (!target) return null;
  return candidates.find((e) => e.id === inReplyTo || bareMessageId(e.messageId) === target) ?? null;
}

/**
 * Thread the optimistic sent row joins.
 *
 * A parent with no thread of its own is still a thread — its own row id — and
 * anchoring the send there keeps it in the conversation the user is looking at.
 * Falling through to the invented `local-thread-<ts>` in that case would put the
 * sent mail in a thread nothing else belongs to, which is what defeated the
 * draft suppression keyed by thread id.
 */
export function optimisticThreadId(
  replyTarget: { id: string; threadId?: string | null } | null | undefined,
  fallback: string,
): string {
  if (!replyTarget) return fallback;
  return replyTarget.threadId || replyTarget.id || fallback;
}

// Flush function for the current pendingSend. Held at module level (the
// PendingSend type lives in types.ts) so a newer send can fire the previous
// delayed send immediately instead of silently cancelling it. Cleared by
// undoSend (intentional cancel) and when the timeout fires naturally.
let pendingFlush: ((early?: boolean) => Promise<void>) | null = null;

export const createComposeSlice: SliceCreator<ComposeSlice> = (set, get) => ({
  compose: {
    isOpen: false,
    mode: 'new',
    replyToEmail: undefined,
  },
  sendingStatus: 'idle',
  pendingSend: null,
  restoreDraft: null,

  openCompose: (mode, replyToEmail, draftBody) => {
    set({
      compose: {
        isOpen: true,
        mode,
        replyToEmail,
        draftBody,
      },
    });
  },

  editDraftInComposer: (draft) => {
    // A standalone draft opens as a full compose window (Gmail-style) so the user
    // can edit the subject/recipients — a reply box has no subject field.
    set({
      compose: {
        isOpen: true,
        mode: 'new',
        replyToEmail: undefined,
        draftBody: undefined,
        draft,
      },
    });
  },

  closeCompose: () => {
    set({
      compose: {
        isOpen: false,
        mode: 'new',
        replyToEmail: undefined,
        draftBody: undefined,
      },
    });
  },

  clearRestoreDraft: () => {
    set({ restoreDraft: null });
  },

  undoSend: async () => {
    const { pendingSend, threadEmails } = get();
    if (!pendingSend) return;

    // Cancel the local commit timer (intentional — do NOT commit).
    clearTimeout(pendingSend.timeoutId);
    pendingFlush = null;

    // Cancel the HELD outbox send. This only succeeds while it's still held; if the
    // window already elapsed and it committed, the mail is on its way and we accept
    // that (a delivered mail beats a lost one). We NEVER deleted the draft yet
    // (deletion is deferred to commit), so nothing the user typed is lost either way.
    let cancelled = true;
    if (pendingSend.sendId != null) {
      try {
        const r = await window.electronAPI.smtp.cancelSend(pendingSend.sendId, pendingSend.accountId);
        cancelled = !!r?.cancelled;
      } catch (err) {
        console.warn('[Store] Undo cancelSend failed:', err);
        cancelled = false;
      }
    }

    if (!cancelled) {
      // Too late to unsend — leave the optimistic row and let it settle as sent.
      set({ pendingSend: null, sendingStatus: 'sent' });
      setTimeout(() => set({ sendingStatus: 'idle' }), 1500);
      console.log('[Store] Undo send — too late, message already committed to outbox');
      return;
    }

    // Remove optimistic email from thread; the draft is untouched in the DB, so the
    // reopened composer restores it with nothing lost.
    const filtered = threadEmails.filter(e => e.id !== pendingSend.optimisticEmailId);
    set({
      threadEmails: filtered,
      pendingSend: null,
      sendingStatus: 'idle',
      restoreDraft: pendingSend.draft,
    });

    // For popup compose (not inline), reopen the compose window
    if (pendingSend.draft.isInline === false) {
      set({
        compose: {
          isOpen: true,
          mode: pendingSend.draft.mode,
          replyToEmail: pendingSend.draft.replyToEmail,
        },
      });
    }

    console.log('[Store] Undo send — cancelled held outbox send, restoring draft');
  },

  sendEmail: async (options) => {
    const { smtpConnected, imapConfig, threadEmails, accounts, activeAccountId } = get();

    if (!imapConfig) {
      throw new Error('No account configured');
    }

    // Send AS — for a reply/forward to a mail from a non-active account (unified
    // "All Inboxes"), send FROM that account: its SMTP, its outbox, its identity.
    // The caller passes options.accountId (the mail's owning account).
    const sendAsId = options.accountId;
    const crossAccount = !!sendAsId && sendAsId !== activeAccountId;
    const sendingAccount = crossAccount ? accounts.find((a) => a.id === sendAsId) : null;
    const fromAddr = (crossAccount ? sendingAccount?.email : imapConfig?.username) || '';

    // Best-effort SMTP connect. Never throw on failure: the send persists in the
    // (per-account) outbox and retries once connected — so it's never lost.
    if (crossAccount) {
      // OAuth accounts derive their SMTP (smtp.gmail.com + token, immune to the
      // same-email crossing); password accounts use their verified stored config.
      let smtpCfg = effectiveSmtpConfig(sendingAccount) as any;
      if (smtpCfg) {
        try {
          // Rehydrate the sending account's SMTP secret from the vault — the
          // in-memory config is stripped for non-active accounts loaded from disk.
          // OAuth configs carry no password (the main process injects the token).
          if (smtpCfg.authMethod !== 'oauth2' && !(smtpCfg.password || smtpCfg.accessToken || smtpCfg.refreshToken)) {
            const secrets = await fetchVaultSecrets([
              sendAsId,
              accountIdFor(sendingAccount!.email, sendingAccount!.imapConfig?.host as string | undefined),
            ]);
            if (secrets?.smtp) smtpCfg = { ...smtpCfg, ...secrets.smtp };
          }
          await window.electronAPI.smtp.connectFor(sendAsId!, smtpCfg);
        } catch (error) {
          console.warn('[Store] Cross-account SMTP connect failed; send will be queued:', error);
        }
      } else {
        console.warn('[Store] Sending account has no verified SMTP; send will be queued to its outbox');
      }
    } else if (!smtpConnected) {
      try {
        await get().connectSmtp();
      } catch (error) {
        console.warn('[Store] SMTP auto-connect failed; send will be queued to the outbox:', error);
      }
    }

    // A live pendingSend means the PREVIOUS email's delayed smtp.send hasn't
    // fired yet — flush it immediately rather than cancelling it, otherwise
    // sending twice within the undo window silently loses the first email.
    const existingPending = get().pendingSend;
    if (existingPending) {
      clearTimeout(existingPending.timeoutId);
      const prevFlush = pendingFlush;
      pendingFlush = null;
      set({ pendingSend: null });
      if (prevFlush) {
        prevFlush(true).catch((err) => {
          console.error('[Store] Failed to flush previous pending send:', err);
        });
      }
    }

    // --- Unified Delayed Send with Undo ---

    // Find target if we are replying/forwarding to something
    let replyTarget: any = null;
    if (options.inReplyTo) {
      replyTarget = findReplyTarget(threadEmails, options.inReplyTo)
        ?? findReplyTarget(get().emails, options.inReplyTo);

      // Only the DB can resolve a row id we don't hold; a Message-ID is not a
      // key this endpoint understands, so asking it would just log a failure.
      if (!replyTarget && !looksLikeMessageId(options.inReplyTo)) {
        try {
          const res = await window.electronAPI.emails.get(options.inReplyTo);
          if (res.success && res.data) replyTarget = res.data;
        } catch (e) {
          console.warn('[Store] Failed to fetch reply target:', e);
        }
      }
    }

    let inReplyToMessageId = options.inReplyTo;
    let references: string[] | undefined;

    if (replyTarget?.messageId) {
      inReplyToMessageId = replyTarget.messageId;
      const refString = replyTarget.references ? `${replyTarget.references} ${replyTarget.messageId}` : replyTarget.messageId;
      references = refString.split(' ').filter(Boolean);
    }

    // Add optimistic sent email to thread immediately
    const optimisticId = `sent-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const now = Math.floor(Date.now() / 1000);

    const sentEmail: EmailRecord = {
      id: optimisticId,
      messageId: `<pending-${Date.now()}@local>`,
      threadId: optimisticThreadId(replyTarget, `local-thread-${Date.now()}`),
      folderId: 'sent',
      uid: 0,
      subject: options.subject,
      fromName: fromAddr.split('@')[0] || 'Me',
      fromAddress: fromAddr,
      toAddress: Array.isArray(options.to) ? options.to.join(', ') : options.to,
      toNames: null,
      ccAddress: options.cc ? (Array.isArray(options.cc) ? options.cc.join(', ') : options.cc) : null,
      ccNames: null,
      bccAddress: options.bcc ? (Array.isArray(options.bcc) ? options.bcc.join(', ') : options.bcc) : null,
      bccNames: null,
      replyTo: null,
      date: now,
      receivedDate: now,
      rawBody: options.htmlBody || options.body,
      cleanBody: options.body,
      contentType: options.htmlBody ? 'html' : 'text',
      contentHash: '',
      inReplyTo: inReplyToMessageId || null,
      references: references ? references.join(' ') : null,
      tags: '|read|',
      priority: null,
      hasAttachments: (options.attachments?.length ?? 0) > 0,
      attachmentCount: options.attachments?.length ?? 0,
      attachmentNames: null,
      attachmentSizes: null,
      hasEmbedding: false,
      embeddingLastGenerated: null,
      createdAt: now,
      updatedAt: now,
    };

    const newThreadEmails = [...get().threadEmails, sentEmail];
    set({ threadEmails: newThreadEmails });
    console.log('[Store] Added optimistic sent email to thread');

    // Store draft info and schedule actual send after delay
    const { draft, draftCleanup, ...sendOptions } = options;

    const payload = {
      to: sendOptions.to,
      cc: sendOptions.cc,
      bcc: sendOptions.bcc,
      subject: sendOptions.subject,
      body: sendOptions.body,
      htmlBody: sendOptions.htmlBody,
      inReplyTo: inReplyToMessageId,
      references,
      attachments: sendOptions.attachments,
      accountId: sendAsId, // send AS the mail's owning account (undefined = active)
      from: sendOptions.from, // chosen identity/alias header From (undefined = default)
      requestReadReceipt: sendOptions.requestReadReceipt,
    };

    // PERSIST-FIRST: write the mail to the outbox NOW, HELD for the undo window.
    // The message is durable in the DB before we touch anything else — a crash
    // during the window can only DELAY delivery (the outbox drains it on restart),
    // never lose it. The old path kept the mail only in renderer memory for 5s and
    // deleted the draft up front, so a quit within that window destroyed the email.
    let sendId: number | null = null;
    try {
      const enq = await window.electronAPI.smtp.sendWithUndo(payload, UNDO_SEND_DELAY);
      if (enq?.success && typeof enq.id === 'number') {
        sendId = enq.id;
      } else {
        throw new Error(enq?.error || 'Failed to persist send to outbox');
      }
    } catch (error) {
      // Could not even persist — leave the DRAFT intact (never deleted here) and
      // drop the optimistic row so nothing is silently lost.
      console.error('[Store] Failed to persist send to outbox:', error);
      set({
        threadEmails: get().threadEmails.filter(e => e.id !== optimisticId),
        sendingStatus: 'idle',
      });
      throw error;
    }

    // Commit fires when the undo window elapses (or early, when a newer send
    // supersedes this one): release the outbox hold so it transmits now, THEN
    // delete the draft — only once the mail is provably persisted.
    const commit = async (early = false) => {
      const owns = () => {
        const p = get().pendingSend;
        return !early && (!p || p.optimisticEmailId === optimisticId);
      };
      try {
        await window.electronAPI.smtp.commitSend(sendId!, sendAsId);
      } catch (error) {
        // The send stays persisted in the outbox and drains later — not a loss.
        console.error('[Store] commitSend error (send remains queued in outbox):', error);
      }
      // Mail is durably committed → now safe to remove the draft.
      if (draftCleanup) {
        window.electronAPI.drafts.delete(draftCleanup).catch(() => {});
      }
      if (owns()) {
        set({ pendingSend: null, sendingStatus: 'sent' });
        setTimeout(() => set({ sendingStatus: 'idle' }), 2000);
      }
      get().syncEmails({ folders: ['[Gmail]/Sent Mail', 'Sent', 'Sent Items'] }).catch(() => { });
    };

    const timeoutId = window.setTimeout(() => {
      if (pendingFlush === commit) pendingFlush = null;
      void commit();
    }, UNDO_SEND_DELAY);

    pendingFlush = commit;
    set({
      sendingStatus: 'sending',
      pendingSend: {
        options: sendOptions,
        timeoutId,
        optimisticEmailId: optimisticId,
        sendId,
        accountId: sendAsId,
        draftCleanup,
        // A caller without a draft (non-composer send) still gets the durable
        // hold + commit; only the undo-restore needs draft content.
        draft: draft ?? {
          to: Array.isArray(sendOptions.to) ? sendOptions.to.join(', ') : (sendOptions.to as string),
          cc: '', htmlContent: sendOptions.htmlBody || sendOptions.body || '',
          attachments: [], replyToEmail: null, mode: 'new', isInline: true,
        },
      },
    });
  },
});
