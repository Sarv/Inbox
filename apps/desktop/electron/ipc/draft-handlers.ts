/**
 * Draft IPC Handlers
 *
 * Handles saving, deleting, and managing drafts on the IMAP server.
 */

import { ipcMain } from 'electron';
import MailComposer from 'nodemailer/lib/mail-composer';
import pLimit from 'p-limit';
import { emailContentHash, findFolderByType, createLogger, withFolderSelected } from '@sarvinbox/core';
import { UPSERT_BODY_SQL, bodyLengthFromParam, cleanBodyExpression, rawBodyExpression, rawBodyForStorage, relocateBodyForInsert, writeImageLinks, writeThreadKey } from '@sarvinbox/storage-node';
import { requireStorage, getCurrentAccountId, getAllAccountIds, sendToWindow } from '../shared';
import { resolveAccountTarget } from './email-handlers';
const logger = createLogger('draft-handlers');

// Draft diagnostic log (from the "immortal draft" investigation). Kept as a
// plain console log — the previous version did a SYNCHRONOUS fs.appendFileSync
// on every draft save/delete, blocking the main-process event loop per action.
function draftLog(event: string, data: Record<string, unknown>): void {
  logger.info('[DraftDebug]', event, data);
}
function dbFileOf(storage: unknown): string {
  try { return (storage as any)?.db?.name || 'unknown'; } catch { return 'error'; }
}

/**
 * The server UIDs a set of draft rows can be deleted by.
 *
 * Only a row with a real UID is known to have a copy on the server — the UID is
 * written when the draft is APPENDed, and synced drafts always carry one. A row
 * with uid 0 was never accepted by the server (offline save, failed append), so
 * queueing it would enqueue a delete for a message that does not exist.
 *
 * Exported for tests: this is the gate between "the local row is gone" and "the
 * server copy is gone too", and getting it wrong in either direction is a bug
 * users see — too strict leaves drafts to re-sync, too loose queues junk
 * operations that dead-letter.
 */
export function serverDeletableUids(rows: ReadonlyArray<{ uid?: number | null }>): number[] {
  const uids = new Set<number>();
  for (const row of rows ?? []) {
    const uid = Number(row?.uid ?? 0);
    if (Number.isInteger(uid) && uid > 0) uids.add(uid);
  }
  return [...uids];
}

// Serialize ALL draft IMAP work (append/select/search/delete/expunge) so it runs
// one-at-a-time. ImapFlow allows only ONE operation at a time per connection —
// firing draft deletes/saves concurrently (or overlapping the sync engine's
// folder use) yields "Connection not available" and the server copies survive to
// be re-synced. Backed by p-limit(1) (the standard concurrency limiter, matching
// write-queue/unified-pipeline) instead of a hand-rolled promise chain; a
// rejected op never wedges the queue.
const imapDraftLimit = pLimit(1);
function serializeDraftImap<T>(fn: () => Promise<T>): Promise<T> {
  return imapDraftLimit(fn);
}

/**
 * Find the Drafts folder path using the unified provider-agnostic resolver
 * (IMAP \Drafts special-use → known path → name heuristic). Takes the storage
 * for the TARGET account so multi-account drafts resolve their own Drafts
 * folder, not the active account's.
 */
export async function findDraftsFolderPath(storage = requireStorage()): Promise<string | null> {
  try {
    const folders = await storage.getFolders();
    const drafts = findFolderByType(folders as any, 'drafts');
    return drafts?.path || null;
  } catch {
    return null;
  }
}

/**
 * Save a draft to the IMAP Drafts folder AND write an immediate mirror row
 * to the local emails table so the draft is visible instantly (without
 * waiting for the next IMAP sync round-trip). When sync later pulls the
 * server's copy, it dedupes on the Message-ID we stamped below.
 *
 * Shared by the user's inline reply autosave (via IPC) and the AI agent's
 * auto-draft pipeline step.
 */
export async function saveDraftToIMAP(draft: {
  to?: string;
  cc?: string;
  bcc?: string;
  subject?: string;
  body?: string;
  htmlBody?: string;
  inReplyTo?: string;
  /** Full References header value (space- or whitespace-delimited list of
   *  Message-IDs in chronological order). Required for Gmail/Outlook to
   *  group the draft under the original conversation; without it, drafts
   *  appear as standalone "new" emails in the Drafts folder. */
  references?: string;
  accountEmail?: string;
  accountName?: string;
  threadId?: string; // if caller knows the thread this draft belongs to
  /** Account that OWNS this draft. Without it, save/delete hit the active
   *  account's DB — so a draft opened from All Inboxes (or any non-active
   *  account) was written to / deleted from the WRONG database, which made
   *  drafts undeletable and accumulate ("immortal drafts"). */
  accountId?: string;
}): Promise<{ success: boolean; folderPath?: string; messageId?: string; error?: string }> {
  // Resolve the TARGET account's storage + sync engine (falls back to the active
  // account when no accountId is given).
  const { storage, syncEngine } = await resolveAccountTarget(draft.accountId);
  if (!syncEngine) {
    return { success: false, error: 'No sync engine for account' };
  }
  const folderPath = await findDraftsFolderPath(storage);
  if (!folderPath) {
    return { success: false, error: 'Drafts folder not found' };
  }

  // Generate a stable Message-ID so the IMAP copy (after sync) can be deduped
  // against the local row we insert below.
  const domain = (draft.accountEmail || '').split('@')[1] || 'sarvinbox.local';
  const messageId = `<draft-${Date.now()}-${Math.random().toString(36).slice(2, 10)}@${domain}>`;

  const mailOptions: any = {
    from: draft.accountName
      ? `${draft.accountName} <${draft.accountEmail || ''}>`
      : (draft.accountEmail || ''),
    to: draft.to || '',
    subject: draft.subject || '',
    messageId,
  };
  if (draft.cc) mailOptions.cc = draft.cc;
  if (draft.bcc) mailOptions.bcc = draft.bcc;
  // Threading: In-Reply-To + References must both be set in proper Message-ID
  // form (`<id@host>`) for Gmail/Outlook to group the draft under the original
  // conversation. Skip if we don't have a well-formed value — using the
  // internal row id here would break threading worse than omitting.
  const wrap = (id: string) => (id.startsWith('<') ? id : `<${id}>`);
  const looksLikeMessageId = (id: string | undefined) =>
    !!id && /@/.test(id) && !/\s/.test(id);
  if (looksLikeMessageId(draft.inReplyTo)) {
    mailOptions.inReplyTo = wrap(draft.inReplyTo!);
  }
  if (draft.references) {
    // Caller-supplied References chain — take as-is (whitespace-separated IDs).
    mailOptions.references = draft.references
      .split(/\s+/)
      .filter(looksLikeMessageId)
      .map(wrap)
      .join(' ');
  } else if (mailOptions.inReplyTo) {
    // Minimum viable References header — just the parent's Message-ID.
    mailOptions.references = mailOptions.inReplyTo;
  }
  if (draft.htmlBody) {
    mailOptions.html = draft.htmlBody;
    if (draft.body) mailOptions.text = draft.body;
  } else if (draft.body) {
    mailOptions.text = draft.body;
  }
  mailOptions.date = new Date();

  const composer = new MailComposer(mailOptions);
  const rawMessage = await new Promise<Buffer>((resolve, reject) => {
    composer.compile().build((err: Error | null, message: Buffer) => {
      if (err) reject(err);
      else resolve(message);
    });
  });

  // 1. Write to local DB first — instant visibility in the Drafts folder.
  try {
    await writeLocalDraftRow(storage, {
      messageId,
      folderPath,
      to: draft.to || '',
      cc: draft.cc || '',
      bcc: draft.bcc || '',
      subject: draft.subject || '',
      bodyText: draft.body || '',
      bodyHtml: draft.htmlBody || '',
      inReplyTo: draft.inReplyTo || '',
      fromAddress: draft.accountEmail || '',
      fromName: draft.accountName || '',
      threadId: draft.threadId,
      rawMessage: rawMessage.toString('utf-8'),
    });
  } catch (err) {
    logger.error('[Drafts] Local mirror write failed:', err);
    // Non-fatal — IMAP save is still attempted below.
  }

  // 2. APPEND to IMAP Drafts — serialized on the shared draft IMAP lock so it
  //    can't overlap a concurrent draft delete/scan on the same connection.
  if (!syncEngine.isConnected()) {
    logger.warn('[Drafts] IMAP not connected — draft saved locally only');
    return { success: true, folderPath, messageId, error: 'IMAP offline (local-only)' };
  }
  try {
    const appendedUid = await serializeDraftImap(async () => {
      const pool = (syncEngine as any).connectionPool;
      if (pool?.withConnection) {
        return await pool.withConnection((conn: any) => conn.appendMessage(folderPath, rawMessage, ['\\Draft', '\\Seen']));
      }
      return await syncEngine!.getClient().appendMessage(folderPath, rawMessage, ['\\Draft', '\\Seen']);
    });
    // Persist the server UID on the local mirror row so a later discard can delete
    // the SERVER copy directly — without waiting for a sync to backfill the UID or
    // relying on a Message-ID scan (which misses a just-appended message and let
    // the server copy re-sync back, re-opening the draft = churn).
    if (appendedUid && appendedUid > 0) {
      try {
        (storage as any).db?.prepare?.('UPDATE emails SET uid = ? WHERE message_id = ?').run(appendedUid, messageId);
      } catch (e) {
        draftLog('save:uid-update:error', { err: String(e) });
      }
    }
    logger.info('[Drafts] Draft saved to IMAP', folderPath, messageId, 'uid', appendedUid);
  } catch (err: any) {
    logger.error('[Drafts] IMAP append failed (local copy kept):', err);
    return { success: true, folderPath, messageId, error: `IMAP append failed: ${err?.message || err}` };
  }

  return { success: true, folderPath, messageId };
}

/**
 * Insert (or replace) a local emails-table row representing a draft so the UI
 * sees it immediately. Uses the same schema as IMAP-synced emails.
 *
 * Exported for tests: this writes an `emails` row by hand rather than through
 * EmailRepository, so every column contract the repository maintains (body
 * lengths, the thread key, `content_hash`) has to be re-honoured here — and the
 * only way to prove it still is, is to drive this function against a real
 * schema. It is not part of the IPC surface.
 */
export async function writeLocalDraftRow(storage: ReturnType<typeof requireStorage>, row: {
  messageId: string;
  folderPath: string;
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  bodyText: string;
  bodyHtml: string;
  inReplyTo: string;
  fromAddress: string;
  fromName?: string;
  threadId?: string;
  rawMessage: string;
}): Promise<void> {
  const db = (storage as any).db;
  if (!db?.prepare) return;

  // Resolve folder id by path
  const folder = db.prepare('SELECT id FROM folders WHERE path = ?').get(row.folderPath) as any;
  if (!folder?.id) {
    logger.warn('[Drafts] No local folder row for', row.folderPath);
    return;
  }

  // Tag the row with BOTH the folder-path (so getByFolder finds it via the
  // `instr(tags, '|<path>|')` filter used for normal emails) and our synthetic
  // `|draft|` marker (used elsewhere to distinguish locally-written drafts).
  const draftTags = `|${row.folderPath}|draft|`;

  // If a draft with this message-id already exists, replace it (new version)
  const existing = db.prepare('SELECT id FROM emails WHERE message_id = ?').get(row.messageId) as any;
  if (existing?.id) {
    const params = {
      id: existing.id,
      cleanBody: row.bodyText,
      rawBody: row.bodyHtml || row.rawMessage,
      // Recomputed on every re-save, from the body as typed — before the
      // relocation below rewrites the raw part — so a revised draft stops
      // claiming the content of its previous revision.
      contentHash: emailContentHash({
        cleanBody: row.bodyText,
        rawBody: row.bodyHtml || row.rawMessage,
        messageId: row.messageId,
      }),
      subject: row.subject,
      toAddress: row.to,
      ccAddress: row.cc,
      date: Math.floor(Date.now() / 1000),
      tags: draftTags,
    };
    // Body row first, header second — the same ordering EmailRepository.update
    // uses, and for the same reason: the FTS trigger on `emails` re-indexes a
    // changed clean_body only while no side row exists, so emptying the inline
    // column first would tokenize the draft twice. The lengths are refreshed
    // here too; the previous version rewrote the body without them, leaving a
    // re-saved draft carrying the length of a body it no longer had.
    db.transaction(() => {
      // A pasted or dragged image reaches the composer as a base64 `data:` URI,
      // so a draft bloats the same way a received mail does — and worse, a draft
      // is re-saved on every autosave, rewriting those megabytes each time.
      // Relocating here means one blob and a 41-character ref per save. Mutating
      // `params` covers BOTH statements, which is what keeps `raw_body_len` in
      // agreement with the body actually stored.
      params.rawBody = rawBodyForStorage(db, existing.id, params.rawBody);
      db.prepare(UPSERT_BODY_SQL).run(params);
      db.prepare(`
        UPDATE emails SET
          clean_body = '', raw_body = '',
          clean_body_len = ${bodyLengthFromParam('@cleanBody')},
          raw_body_len = ${bodyLengthFromParam('@rawBody')},
          content_hash = @contentHash,
          subject = @subject, to_address = @toAddress, cc_address = @ccAddress,
          date = @date, tags = @tags
         WHERE id = @id
      `).run(params);
    })();
    return;
  }

  // Derive a local id — use the message-id (without brackets) for stability
  const id = row.messageId.replace(/[<>]/g, '');
  const now = Math.floor(Date.now() / 1000);
  // Group into the same thread as the email we're replying to (if provided)
  const threadId = row.threadId || id;

  // Ensure the thread row exists before inserting — emails.thread_id has a
  // FOREIGN KEY to threads(id). For replies the thread row already exists
  // (the parent email created it), but for a new compose or when the caller
  // passed a made-up threadId, we need to insert a placeholder thread first
  // or the INSERT below fails with SQLITE_CONSTRAINT_FOREIGNKEY.
  try {
    db.prepare(`
      INSERT OR IGNORE INTO threads
        (id, subject, first_message_id, last_message_id, last_message_date, message_count, participants, has_unread, has_flagged, labels)
      VALUES
        (?, ?, ?, ?, ?, 1, '[]', 0, 0, '[]')
    `).run(threadId, row.subject || '', row.messageId, row.messageId, now);
  } catch (err) {
    logger.warn('[Drafts] Thread upsert failed, insert may still succeed if row exists:', err);
  }

  const insertDraftRow = db.prepare(`
    INSERT INTO emails (
      id, message_id, thread_id, folder_id, uid, tags,
      subject, from_address, from_name, to_address, to_names,
      cc_address, cc_names, bcc_address, bcc_names, reply_to,
      date, received_date,
      clean_body, raw_body, clean_body_len, raw_body_len, content_type, content_hash,
      in_reply_to, "references",
      priority,
      has_attachments, attachment_count, attachment_names,
      importance_score, importance_source,
      extraction_status, agent_status
    ) VALUES (
      @id, @messageId, @threadId, @folderId, @uid, @tags,
      @subject, @fromAddress, @fromName, @toAddress, @toNames,
      @ccAddress, @ccNames, @bccAddress, @bccNames, @replyTo,
      @date, @receivedDate,
      -- The bodies go to the email_bodies side table (migration 73), written
      -- right after this insert; '' rather than NULL keeps the read-side
      -- COALESCE total so a body-less draft reads back exactly as before.
      '', '',
      -- Body lengths are maintained by EVERY writer, not just the repository:
      -- a row that arrives with NULL lengths is invisible to the fast has-body
      -- test, so one forgetful insert path is enough to hide mail from the AI
      -- pipeline and the search size filter. Computed in SQL via the shared
      -- helper so this can never disagree with what the repository stores.
      ${bodyLengthFromParam('@cleanBody')}, ${bodyLengthFromParam('@rawBody')},
      @contentType, @contentHash,
      @inReplyTo, @refs,
      @priority,
      @hasAttachments, @attachmentCount, @attachmentNames,
      @importanceScore, @importanceSource,
      'done', 'done'
    )
  `);
  const insertParams = {
    id,
    messageId: row.messageId,
    threadId,
    folderId: folder.id,
    uid: 0, // local-only until IMAP assigns a real UID on sync
    tags: draftTags,
    subject: row.subject,
    fromAddress: row.fromAddress,
    fromName: row.fromName || '',
    toAddress: row.to,
    toNames: '',
    ccAddress: row.cc,
    ccNames: '',
    bccAddress: row.bcc,
    bccNames: '',
    replyTo: '',
    date: now,
    receivedDate: now,
    cleanBody: row.bodyText,
    rawBody: row.bodyHtml || row.rawMessage,
    contentType: row.bodyHtml ? 'html' : 'text',
    // Through the shared rule, like every other writer of a body. A draft is
    // re-saved on every keystroke pause, so '' here meant every revision of
    // every draft carried the same "content" as all the others.
    contentHash: emailContentHash({
      cleanBody: row.bodyText,
      rawBody: row.bodyHtml || row.rawMessage,
      messageId: row.messageId,
    }),
    inReplyTo: row.inReplyTo,
    refs: '',
    priority: 'normal',
    hasAttachments: 0,
    attachmentCount: 0,
    attachmentNames: '',
    attachmentSizes: null,
    importanceScore: 0,
    importanceSource: 'none',
  };

  // Header row, body row and thread key in ONE transaction: a torn write here
  // leaves a draft the user can see but whose text is gone, which reads as the
  // app having eaten their reply. Header before body, as everywhere else, so the
  // FTS trigger on `emails` sees the side row already in place and does not
  // tokenize the draft twice.
  //
  // Inserted directly, not through EmailRepository — so the thread resolver's
  // lookup key has to be written here too, or the draft is invisible to the
  // subject fallback and the conversation it belongs to splits around it.
  db.transaction(() => {
    // Blobs first (they have no dependency on the draft row), the rewritten body
    // bound to the insert so its `raw_body_len` describes what is stored, and the
    // edges last because they reference `emails(id)`. Same three-step order as
    // EmailRepository.insertRows — see `inline-image-store.ts`.
    const { rawBody, hashes } = relocateBodyForInsert(db, insertParams.rawBody);
    insertDraftRow.run({ ...insertParams, rawBody });
    db.prepare(UPSERT_BODY_SQL).run({
      id,
      cleanBody: insertParams.cleanBody,
      rawBody,
    });
    writeImageLinks(db, id, hashes);
    writeThreadKey(db, { id, subject: row.subject, date: now });
  })();

  logger.info('[Drafts] Local draft row inserted', id, 'folder=', row.folderPath);
}

/**
 * Delete EVERY draft (local `emails` row + IMAP server copy) in a thread. Called
 * by the send path so a lingering AI auto-draft (or manual draft) is removed once
 * a reply to that thread is actually sent — whether the user edited the AI draft,
 * replied fresh, the agent auto-sent, or the outbox drained it. Mirrors the
 * thread branch of the `drafts:delete` IPC and reuses the same module helpers
 * (resolveAccountTarget / findDraftsFolderPath / serializeDraftImap / pooled
 * delete). Best-effort: the local delete always runs; the IMAP copy is removed
 * when connected so it can't re-sync back. Notifies the renderer to drop the row.
 */
export async function deleteDraftsForThread(accountId: string | undefined, threadId: string): Promise<void> {
  if (!threadId) return;
  const { storage, syncEngine } = await resolveAccountTarget(accountId);
  const db = (storage as any).db;
  if (!db?.prepare) return;

  let draftRows: Array<{ message_id: string; uid: number }> = [];
  try {
    draftRows = db.prepare(
      `SELECT message_id, COALESCE(uid,0) as uid FROM emails WHERE thread_id = ? AND (instr(tags,'|draft|')>0 OR instr(tags,'|Drafts|')>0 OR instr(tags,'|[Gmail]/Drafts|')>0)`,
    ).all(threadId) as Array<{ message_id: string; uid: number }>;
  } catch (e) {
    draftLog('sendCleanup:collect:error', { err: String(e) });
    return;
  }
  if (draftRows.length === 0) return;
  const messageIds = draftRows.map((r) => r.message_id).filter(Boolean);
  draftLog('sendCleanup:start', { threadId, count: messageIds.length });

  // 1. Local delete first (instant truth; works offline).
  try {
    const ph = messageIds.map(() => '?').join(',');
    db.prepare(`DELETE FROM emails WHERE message_id IN (${ph})`).run(...messageIds);
  } catch (err) {
    logger.error('[Drafts] send-cleanup local delete failed:', err);
  }
  // 2. Tell the renderer to drop the row from any open view (Drafts list / thread).
  try { sendToWindow('drafts:removed', { threadId, messageIds }); } catch { /* no window */ }

  // 3. Delete the IMAP server copies on a POOLED connection so they don't re-sync.
  await serializeDraftImap(async () => {
    if (!syncEngine || !syncEngine.isConnected()) return;
    const folderPath = await findDraftsFolderPath(storage);
    if (!folderPath) return;
    const pool = (syncEngine as any).connectionPool;
    // The whole scan-then-expunge sequence is ONE section: a re-select landing
    // between the UID map and the EXPUNGE would delete those UIDs in whatever
    // mailbox is selected by then.
    const runDelete = async (conn: any) => withFolderSelected(conn, folderPath, async () => {
      const uidsToDelete = new Set<number>();
      for (const r of draftRows) if (r.uid && r.uid > 0) uidsToDelete.add(r.uid);
      if (draftRows.some((r) => !r.uid || r.uid <= 0) && typeof conn.fetchMessageIdToUidMap === 'function') {
        const map: Map<string, number> = await conn.fetchMessageIdToUidMap();
        for (const r of draftRows) {
          const uid = map.get(r.message_id.replace(/[<>]/g, '').trim().toLowerCase());
          if (uid) uidsToDelete.add(uid);
        }
      }
      if (uidsToDelete.size > 0) {
        if (typeof conn.deleteAndExpunge === 'function') await conn.deleteAndExpunge([...uidsToDelete]);
        else { await conn.deleteMessages([...uidsToDelete]); await conn.expunge(); }
      }
    });
    try {
      if (pool?.withConnection) await pool.withConnection(runDelete);
      else await runDelete(syncEngine.getClient());
    } catch (error: any) {
      logger.error('[Drafts] send-cleanup IMAP delete failed:', error?.message || error);
    }
  });
}

export function registerDraftHandlers(): void {
  // Get the drafts folder name
  ipcMain.handle('drafts:get-folder', async (_event, accountId?: string) => {
    try {
      const { storage } = await resolveAccountTarget(accountId);
      const folderPath = await findDraftsFolderPath(storage);
      return { success: true, data: folderPath };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  });

  // Save a draft to IMAP Drafts folder
  ipcMain.handle('drafts:save', async (_event, draft: {
    to?: string;
    cc?: string;
    bcc?: string;
    subject?: string;
    body?: string;
    htmlBody?: string;
    inReplyTo?: string;
    threadId?: string;
    accountEmail?: string;
    accountId?: string;
  }) => {
    try {
      return await saveDraftToIMAP(draft);
    } catch (error: any) {
      logger.error('[Drafts] Failed to save draft:', error);
      return { success: false, error: error.message };
    }
  });

  // Find a locally-stored draft (manual or AI-saved) whose in_reply_to
  // header matches any message_id in the provided list (i.e. a draft reply
  // to any email in the current thread). Returns the most recent match.
  ipcMain.handle('drafts:find-for-thread', async (_event, messageIds: string[], accountId?: string) => {
    try {
      if (!Array.isArray(messageIds) || messageIds.length === 0) {
        return { success: true, data: null };
      }
      const { storage } = await resolveAccountTarget(accountId);
      const db = (storage as any).db;
      if (!db?.prepare) return { success: true, data: null };
      const placeholders = messageIds.map(() => '?').join(',');
      const row = db.prepare(`
        SELECT id, message_id as messageId, thread_id as threadId,
               subject, from_address as fromAddress, to_address as toAddress,
               cc_address as ccAddress, date,
               -- Through email_bodies (migration 73 empties the inline
               -- columns): this row is what the composer reopens, so reading
               -- the inline column would silently hand the user a blank draft.
               ${cleanBodyExpression()} as cleanBody,
               ${rawBodyExpression()} as rawBody, in_reply_to as inReplyTo, tags
          FROM emails
         WHERE instr(tags, '|draft|') > 0
           AND in_reply_to IN (${placeholders})
         ORDER BY date DESC
         LIMIT 1
      `).get(...messageIds);
      return { success: true, data: row || null };
    } catch (error: any) {
      logger.error('[Drafts] find-for-thread failed:', error);
      return { success: false, error: error.message };
    }
  });

  // Delete a draft from IMAP AND from the local emails-table mirror.
  // Works for both autosaved drafts (identified by subject/to) and preset/AI
  // drafts (identified by threadId) so "discard" truly removes them.
  ipcMain.handle('drafts:delete', async (_event, options: {
    messageId?: string;
    subject?: string;
    to?: string;
    threadId?: string;
    accountId?: string;
    savedAt?: number;
  }) => {
    draftLog('delete:start', { options, currentAccountId: getCurrentAccountId() });
    // Resolve the draft's OWNING account (falls back to active). Without this the
    // delete ran against the active account's DB/engine — the wrong ones when the
    // draft belongs to another account (e.g. opened from All Inboxes) — so it
    // removed 0 rows and the draft was undeletable ("immortal draft").
    const { storage, syncEngine } = await resolveAccountTarget(options.accountId);
    draftLog('delete:resolved', {
      requestedAccountId: options.accountId,
      dbFile: dbFileOf(storage),
      hasSyncEngine: !!syncEngine,
      imapConnected: (() => { try { return !!syncEngine?.isConnected?.(); } catch { return 'err'; } })(),
    });

    const db = (storage as any).db;

    // Build the set of draft rows (message_id + stored server uid) to remove. A
    // discard passes threadId, so we clear EVERY draft in that thread (both our
    // '|draft|' mirrors and synced '|Drafts|' copies) — this is what finally kills
    // accumulated/racing dupes. The autosave's replace-in-place passes messageId
    // only → single row.
    let draftRows: Array<{ message_id: string; uid: number }> = [];
    try {
      if (db?.prepare) {
        if (options.threadId) {
          draftRows = db.prepare(
            `SELECT message_id, COALESCE(uid,0) as uid FROM emails WHERE thread_id = ? AND (instr(tags,'|draft|')>0 OR instr(tags,'|Drafts|')>0 OR instr(tags,'|[Gmail]/Drafts|')>0)`,
          ).all(options.threadId) as Array<{ message_id: string; uid: number }>;
          if (options.messageId && !draftRows.some((r) => r.message_id === options.messageId)) {
            const one = db.prepare('SELECT message_id, COALESCE(uid,0) as uid FROM emails WHERE message_id = ?').get(options.messageId) as any;
            draftRows.push(one || { message_id: options.messageId, uid: 0 });
          }
        } else if (options.messageId) {
          const one = db.prepare('SELECT message_id, COALESCE(uid,0) as uid FROM emails WHERE message_id = ?').get(options.messageId) as any;
          draftRows = [one || { message_id: options.messageId, uid: 0 }];
        }
      }
    } catch (e) {
      draftLog('delete:collect:error', { err: String(e) });
    }
    const messageIds = draftRows.map((r) => r.message_id).filter(Boolean);
    draftLog('delete:preLocal', { threadId: options.threadId, messageId: options.messageId, draftRows });

    // 1. Local delete FIRST (instant UI truth, works even if IMAP is offline).
    try {
      if (db?.prepare) {
        if (messageIds.length > 0) {
          const ph = messageIds.map(() => '?').join(',');
          const result = db.prepare(`DELETE FROM emails WHERE message_id IN (${ph})`).run(...messageIds);
          draftLog('delete:local', { count: messageIds.length, changes: result.changes });
        } else if (options.subject && options.to) {
          const result = db
            .prepare(`DELETE FROM emails WHERE subject = ? AND to_address = ? AND instr(tags, '|draft|') > 0`)
            .run(options.subject, options.to);
          draftLog('delete:local', { by: 'subject', changes: result.changes });
        }
      }
    } catch (err) {
      logger.error('[Drafts] Local draft cleanup failed:', err);
      draftLog('delete:local:error', { err: String(err) });
    }

    // 2. Delete from IMAP on the TARGET account's engine — using a POOLED
    //    connection (NOT the primary one that runs IDLE/sync). Selecting the
    //    Drafts folder + scanning + deleting on the primary connection collided
    //    with IDLE → "Connection not available", leaving server copies behind to
    //    be re-synced. The pool gives us a dedicated connection, exactly like the
    //    app's normal move/delete does. Still serialized so drafts don't fan out.
    return await serializeDraftImap(async () => {
    // Resolve the folder BEFORE the connectivity check — it reads the local
    // folders table, so it works offline and gives the durable queue a target.
    const folderPath = await findDraftsFolderPath(storage);

    // Persist-first fallback for every path that cannot reach the server NOW.
    // Deleting only the local row while the server copy survives is not a
    // deletion at all: the next Drafts sync pulls that copy straight back in as
    // a fresh row, which then auto-opens in the composer. That is the "the draft
    // came back" half of the draft complaints. Hand the UIDs to the operation
    // queue instead — it persists them in pending_operations and drains on
    // reconnect with the same retry/dead-letter handling as every other IMAP
    // mutation, so the removal survives an offline discard, a crash, or a quit.
    const queueServerDelete = async (reason: string): Promise<number> => {
      const uids = serverDeletableUids(draftRows);
      if (!folderPath || uids.length === 0 || typeof syncEngine?.deleteEmail !== 'function') {
        draftLog('delete:queue:skip', { reason, folderPath, uids: uids.length, hasEngine: !!syncEngine });
        return 0;
      }
      let queued = 0;
      for (const uid of uids) {
        try {
          await syncEngine.deleteEmail(folderPath, uid);
          queued += 1;
        } catch (e) {
          draftLog('delete:queue:error', { uid, err: String(e) });
        }
      }
      draftLog('delete:queued', { reason, folderPath, uids, queued });
      return queued;
    };

    if (!syncEngine || !syncEngine.isConnected()) {
      const queued = await queueServerDelete('offline or no engine');
      draftLog('delete:imap:skip', { reason: 'offline or no engine', queued });
      return { success: true, imap: false, queued, reason: 'offline (queued for retry)' };
    }
    if (!folderPath) {
      draftLog('delete:imap:skip', { reason: 'no drafts folder' });
      return { success: true, imap: false, reason: 'Drafts folder not found' };
    }
    const pool = (syncEngine as any).connectionPool;
    // Select + Message-ID scan + EXPUNGE must not be interleaved with another
    // SELECT on this connection, or the expunge lands in the wrong mailbox.
    const runDelete = async (conn: any) => withFolderSelected(conn, folderPath, async () => {
      // Resolve the server UIDs to delete: stored uid on the row (set at append
      // time), else a full-folder Message-ID→UID scan (the only reliable locator
      // when HEADER MESSAGE-ID SEARCH is unsupported, e.g. sarv.com).
      const uidsToDelete = new Set<number>();
      for (const r of draftRows) {
        if (r.uid && r.uid > 0) uidsToDelete.add(r.uid);
      }
      let scanMatched = 0;
      const needScan = draftRows.some((r) => !r.uid || r.uid <= 0);
      if (needScan && typeof conn.fetchMessageIdToUidMap === 'function') {
        const map: Map<string, number> = await conn.fetchMessageIdToUidMap();
        for (const r of draftRows) {
          const key = r.message_id.replace(/[<>]/g, '').trim().toLowerCase();
          const uid = map.get(key);
          if (uid) { uidsToDelete.add(uid); scanMatched++; }
        }
      }

      // Legacy subject-only fallback (no message-ids known).
      if (uidsToDelete.size === 0 && messageIds.length === 0 && options.subject) {
        const uids = await conn.search({ draft: true, subject: options.subject });
        uids.forEach((u: number) => uidsToDelete.add(u));
      }

      draftLog('delete:imap:resolve', { folderPath, storedUids: draftRows.map((r) => r.uid), scanMatched, uidsToDelete: [...uidsToDelete] });

      let totalDeleted = 0;
      if (uidsToDelete.size > 0) {
        // Atomic \Deleted+EXPUNGE (no race window that leaves orphan |deleted| rows).
        if (typeof conn.deleteAndExpunge === 'function') {
          await conn.deleteAndExpunge([...uidsToDelete]);
        } else {
          await conn.deleteMessages([...uidsToDelete]);
          await conn.expunge();
        }
        totalDeleted = uidsToDelete.size;
      }
      // A row we could not resolve to any server UID is only safe to report as
      // deleted when it never had a server copy to begin with (uid 0). If it had
      // one and the scan still found nothing, say so — the caller must not treat
      // that as a completed removal.
      const unscannable = needScan && typeof conn.fetchMessageIdToUidMap !== 'function'
        && draftRows.some((r) => !r.uid || r.uid <= 0);
      draftLog('delete:imap:done', { folderPath, deletedUids: totalDeleted, unscannable });
      return { success: true, imap: true, deleted: totalDeleted, unscannable };
    });
    try {
      // withConnection poisons a timed-out/broken connection instead of returning
      // it dirty to the pool (which otherwise scrambles the next op's pipeline).
      const result = pool?.withConnection
        ? await pool.withConnection(runDelete)
        : await runDelete(syncEngine.getClient()); // fallback: no pool
      return result;
    } catch (error: any) {
      logger.error('[Drafts] Failed to delete draft from IMAP:', error);
      // The connection died mid-delete. Local rows are already gone, so without
      // a durable retry the server copy would re-sync as a brand-new draft.
      const queued = await queueServerDelete('imap delete failed');
      draftLog('delete:imap:error', { err: error?.message || String(error), queued });
      return { success: true, imap: false, queued, error: error.message };
    }
    });
  });

  // Bulk-remove drafts in a date window across ALL accounts (or one) — local rows
  // AND server copies (pooled connection + Message-ID→UID scan), so they don't
  // re-sync back. Used to clean out accumulated test-junk drafts.
  ipcMain.handle('drafts:cleanup', async (_event, opts: { sinceMs?: number; beforeMs?: number; accountId?: string }) => {
    const results: any[] = [];
    const accountIds = opts.accountId ? [opts.accountId] : (getAllAccountIds() || []);
    const targets = accountIds.length ? accountIds : [undefined as any];
    for (const accountId of targets) {
      try {
        const { storage, syncEngine } = await resolveAccountTarget(accountId);
        const db = (storage as any).db;
        if (!db?.prepare) continue;

        const draftTag = "(instr(tags,'|draft|')>0 OR instr(tags,'|Drafts|')>0 OR instr(tags,'|[Gmail]/Drafts|')>0)";
        const clauses = [draftTag];
        const params: any[] = [];
        if (opts.sinceMs) { clauses.push('date >= ?'); params.push(Math.floor(opts.sinceMs / 1000)); }
        if (opts.beforeMs) { clauses.push('date < ?'); params.push(Math.floor(opts.beforeMs / 1000)); }
        // Also always sweep orphan rows already flagged \Deleted (|deleted|) —
        // leftovers from a prior mark-then-expunge race; the server no longer has
        // them, so they're safe to remove regardless of date.
        const where = `(${clauses.join(' AND ')}) OR (${draftTag} AND instr(tags,'|deleted|')>0)`;
        const rows = db.prepare(
          `SELECT message_id, COALESCE(uid,0) as uid FROM emails WHERE ${where}`,
        ).all(...params) as Array<{ message_id: string; uid: number }>;

        // Local delete.
        if (rows.length > 0) {
          const ph = rows.map(() => '?').join(',');
          db.prepare(`DELETE FROM emails WHERE message_id IN (${ph})`).run(...rows.map((r) => r.message_id));
        }

        // Server delete on a pooled connection. Runs even when no local rows
        // matched, because the server Drafts folder holds copies that were never
        // synced locally (the accumulated test junk). We find what to delete two
        // ways: (a) the local rows' message-ids/uids, and (b) a server-side date
        // SEARCH (SINCE/BEFORE) on the Drafts folder — INTERNALDATE search is
        // reliable (unlike HEADER MESSAGE-ID), so it catches server-only drafts
        // in the window while leaving older real drafts untouched.
        let imapDeleted = 0;
        if (syncEngine?.isConnected()) {
          const folderPath = await findDraftsFolderPath(storage);
          const pool = (syncEngine as any).connectionPool;
          if (folderPath && pool?.withConnection) {
            await serializeDraftImap(() => pool.withConnection(async (conn: any) => {
              // One section — the date SEARCH's UIDs are only valid in the
              // mailbox that produced them, and the EXPUNGE follows them.
              await withFolderSelected(conn, folderPath, async () => {
                const uids = new Set<number>();

                // (a) locally-known copies
                if (rows.length > 0 && typeof conn.fetchMessageIdToUidMap === 'function') {
                  const map: Map<string, number> = await conn.fetchMessageIdToUidMap();
                  for (const r of rows) {
                    if (r.uid > 0) uids.add(r.uid);
                    const u = map.get(r.message_id.replace(/[<>]/g, '').trim().toLowerCase());
                    if (u) uids.add(u);
                  }
                }

                // (b) server-only copies, by INTERNALDATE window
                if (opts.sinceMs || opts.beforeMs) {
                  const crit: any = {};
                  if (opts.sinceMs) crit.since = new Date(opts.sinceMs);
                  if (opts.beforeMs) crit.before = new Date(opts.beforeMs);
                  try {
                    const dateUids = await conn.search(crit);
                    (dateUids || []).forEach((u: number) => uids.add(u));
                  } catch (e) {
                    draftLog('cleanup:datesearch:error', { accountId, err: String(e) });
                  }
                }

                if (uids.size > 0) {
                  if (typeof conn.deleteAndExpunge === 'function') await conn.deleteAndExpunge([...uids]);
                  else { await conn.deleteMessages([...uids]); await conn.expunge(); }
                  imapDeleted = uids.size;
                }
              });
            }));
          }
        }
        const r = { accountId, dbFile: dbFileOf(storage), localDeleted: rows.length, imapDeleted };
        draftLog('cleanup', r);
        results.push(r);
      } catch (e: any) {
        draftLog('cleanup:error', { accountId, err: e?.message || String(e) });
        results.push({ accountId, error: e?.message || String(e) });
      }
    }
    return { success: true, results };
  });

  // TEMP: let the renderer append to the same debug log so one file captures the
  // whole discard flow (renderer args + main-process delete result).
  ipcMain.handle('drafts:debug', async (_event, event: string, data?: Record<string, unknown>) => {
    draftLog('renderer:' + event, data || {});
    return { success: true };
  });

  logger.info('[IPC] Draft handlers registered');
}
