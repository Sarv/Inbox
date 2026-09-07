/**
 * SMTP IPC Handlers
 *
 * Handles SMTP connection and email sending operations.
 */

import { ipcMain, dialog } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { SMTPClient, emailContentHash, findFolderByType, resolveTlsOptions, providerAutoSavesSentCopy, isAuthTokenError, type SMTPConfig, type SendEmailOptions, createLogger } from '@sarvinbox/core';
import { UPSERT_BODY_SQL, bodyLengthFromParam, relocateBodyForInsert, writeImageLinks, writeThreadKey } from '@sarvinbox/storage-node';
import { getSmtpClient, setSmtpClient, getMainWindow, getStorage, getSyncEngine, getStorageFor, getSmtpClientFor, setSmtpClientFor, getSyncEngineFor, getCurrentAccountId } from '../shared';
import { getValidAccessToken } from '../services/oauth-service';
// Static import (not require()): the bundled main.js has no on-disk services
// file, so a runtime require() throws "Cannot find module".
import { getPipelineUserName } from '../services/unified-pipeline-service';
import { deleteDraftsForThread } from './draft-handlers';
import { getOutboxQueue, drainOutbox, getOutboxQueueForAccount, drainOutboxForAccount, notifyOutboxChanged } from '../services/outbox-service';
import { ensureAccountRuntime } from '../services/accounts-runtime';
const logger = createLogger('smtp-handlers');

const MIME_TYPES: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.html': 'text/html',
  '.zip': 'application/zip',
  '.gz': 'application/gzip',
  '.tar': 'application/x-tar',
  '.7z': 'application/x-7z-compressed',
  '.rar': 'application/vnd.rar',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.json': 'application/json',
  '.xml': 'application/xml',
};

function getMimeType(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  return MIME_TYPES[ext] || 'application/octet-stream';
}

export function registerSmtpHandlers(): void {
  /**
   * Connect to SMTP server
   */
  ipcMain.handle('smtp:connect', async (_event, config: SMTPConfig) => {
    try {
      let smtpClient = getSmtpClient();

      // Create new client if needed
      if (!smtpClient) {
        smtpClient = new SMTPClient();
        setSmtpClient(smtpClient);
      }

      // OAuth2: fetch a valid access token (refreshing if needed).
      if (config.authMethod === 'oauth2') {
        if (!config.oauthProvider) {
          throw new Error('authMethod=oauth2 requires oauthProvider');
        }
        config = {
          ...config,
          accessToken: await getValidAccessToken(config.oauthProvider, config.username),
        };
      }

      // TLS verification ON by default (resolveTlsOptions); insecure only when
      // the account explicitly opts in via allowInsecureTLS.
      const connectConfig = {
        ...config,
        tlsOptions: resolveTlsOptions(config),
      };

      await smtpClient.connect(connectConfig);
      logger.info('[SMTP] Connected successfully');
      // Now that SMTP is (re)connected, flush any sends waiting in the outbox.
      drainOutbox().catch((e) => logger.warn('[SMTP] Outbox drain after connect failed:', e));
      return { success: true };
    } catch (error) {
      logger.error('SMTP connect error:', error);
      return {
        success: false,
        error: (error as Error).message,
      };
    }
  });

  /**
   * Disconnect from SMTP server
   */
  ipcMain.handle('smtp:disconnect', async () => {
    try {
      const smtpClient = getSmtpClient();
      if (smtpClient) {
        await smtpClient.disconnect();
      }
      return { success: true };
    } catch (error) {
      logger.error('SMTP disconnect error:', error);
      return {
        success: false,
        error: (error as Error).message,
      };
    }
  });

  /**
   * Check if connected to SMTP server
   */
  ipcMain.handle('smtp:isConnected', async () => {
    try {
      const smtpClient = getSmtpClient();
      if (!smtpClient) {
        return { success: true, data: false };
      }
      return { success: true, data: smtpClient.isConnected() };
    } catch (error) {
      return {
        success: false,
        error: (error as Error).message,
      };
    }
  });

  /**
   * Send email via SMTP — thin IPC wrapper over sendEmailFromMain so the
   * agent's auto-send path and the renderer compose flow share one code path.
   * Channel name and return shape ({ success, messageId, error }) unchanged.
   */
  // Connect a SPECIFIC account's SMTP on demand (multi-account send-as). The
  // renderer supplies the target account's SMTPConfig (main doesn't store it).
  // Idempotent: no-op if that account's client is already connected.
  ipcMain.handle('smtp:connectFor', async (_event, accountId: string, config: SMTPConfig) => {
    try {
      if (!accountId || !config) return { success: false, error: 'accountId + config required' };
      if (getSmtpClientFor(accountId)?.isConnected()) return { success: true };
      await ensureAccountRuntime(accountId); // ensure the runtime slot exists
      let cfg = config;
      if (cfg.authMethod === 'oauth2') {
        if (!cfg.oauthProvider) throw new Error('authMethod=oauth2 requires oauthProvider');
        cfg = { ...cfg, accessToken: await getValidAccessToken(cfg.oauthProvider, cfg.username) };
      }
      const client = new SMTPClient();
      await client.connect({ ...cfg, tlsOptions: resolveTlsOptions(cfg) });
      setSmtpClientFor(accountId, client);
      // Flush anything queued for this account now that it can send.
      drainOutboxForAccount(accountId).catch((e) => logger.warn('[SMTP] connectFor drain failed:', e));
      return { success: true };
    } catch (error) {
      logger.error('[SMTP] connectFor error:', error);
      return { success: false, error: (error as Error).message };
    }
  });

  ipcMain.handle('smtp:send', async (_event, options: SendEmailOptions) => {
    try {
      // Route through the outbox: the send is persisted BEFORE submit, so an
      // offline/failed send is queued and retried rather than lost. status is
      // 'success' (sent now), 'queued' (offline or scheduled retry) or 'failed'
      // (permanent). The renderer treats 'queued' as an Outbox notice, not an
      // error.
      // Send AS a non-active account (reply from another mailbox) → route to that
      // account's own outbox/SMTP; otherwise the active-account outbox (unchanged).
      const acctId = options.accountId;
      const queue = acctId && acctId !== getCurrentAccountId()
        ? getOutboxQueueForAccount(acctId)
        : getOutboxQueue();
      const result = await queue.enqueueAndSend(options);
      notifyOutboxChanged();
      return {
        success: result.status === 'success',
        queued: result.status === 'queued',
        messageId: result.messageId,
        error: result.error,
      };
    } catch (error) {
      logger.error('SMTP send error:', error);
      return {
        success: false,
        error: (error as Error).message,
      };
    }
  });

  // The account whose outbox owns a given send. Mirrors smtp:send's resolution.
  const queueFor = (accountId?: string) =>
    accountId && accountId !== getCurrentAccountId()
      ? getOutboxQueueForAccount(accountId)
      : getOutboxQueue();

  // Persist-first undo-send: write the mail to the outbox NOW (durable), held for
  // the undo window. The renderer commits it when the window elapses, or cancels
  // it on Undo. A crash during the window can only DELAY delivery (the outbox
  // drains it on restart), never lose the mail — the old path kept it in renderer
  // memory only, so a quit within 5s destroyed the whole email.
  ipcMain.handle('smtp:sendWithUndo', async (_event, options: SendEmailOptions, undoDelayMs: number) => {
    try {
      const { id } = await queueFor(options.accountId).enqueueHeld(options, undoDelayMs);
      notifyOutboxChanged();
      return { success: true, id };
    } catch (error) {
      logger.error('SMTP sendWithUndo error:', error);
      return { success: false, error: (error as Error).message };
    }
  });

  ipcMain.handle('smtp:commitSend', async (_event, id: number, accountId?: string) => {
    try {
      const counts = await queueFor(accountId).commitHeld(id);
      notifyOutboxChanged();
      // 'failed' only when the send permanently failed on this immediate attempt;
      // 'queued' (offline/retry) still means durably persisted — treated as sent.
      return { success: counts.failed === 0, failed: counts.failed };
    } catch (error) {
      logger.error('SMTP commitSend error:', error);
      // The send is still persisted in the outbox and will drain later — never an
      // error the renderer should treat as loss.
      return { success: true, deferred: true };
    }
  });

  ipcMain.handle('smtp:cancelSend', async (_event, id: number, accountId?: string) => {
    try {
      const cancelled = await queueFor(accountId).cancelHeld(id);
      notifyOutboxChanged();
      return { success: true, cancelled };
    } catch (error) {
      logger.error('SMTP cancelSend error:', error);
      return { success: false, cancelled: false, error: (error as Error).message };
    }
  });

  /**
   * Open file picker dialog and return selected files as base64
   */
  ipcMain.handle('dialog:pickFiles', async () => {
    try {
      const mainWindow = getMainWindow();
      const dialogOptions: Electron.OpenDialogOptions = {
        properties: ['openFile', 'multiSelections'],
        title: 'Attach Files',
      };

      const result = mainWindow
        ? await dialog.showOpenDialog(mainWindow, dialogOptions)
        : await dialog.showOpenDialog(dialogOptions);

      if (result.canceled || result.filePaths.length === 0) {
        return { success: true, data: [] };
      }

      const files = await Promise.all(
        result.filePaths.map(async (filePath) => {
          const buffer = await fs.promises.readFile(filePath);
          const filename = path.basename(filePath);
          const contentType = getMimeType(filename);
          return {
            filename,
            content: buffer.toString('base64'),
            contentType,
            encoding: 'base64' as const,
            size: buffer.length,
          };
        })
      );

      return { success: true, data: files };
    } catch (error) {
      logger.error('File picker error:', error);
      return {
        success: false,
        error: (error as Error).message,
      };
    }
  });
}

/**
 * Core main-process send path — shared by the 'smtp:send' IPC handler and
 * main-side callers (the agent's auto-send in unified-pipeline-service).
 *
 * Does everything a user-initiated send does: SMTP submit, local Sent-folder
 * mirror row, and a background Sent sync. Returns the exact shape the
 * renderer compose flow expects from 'smtp:send'.
 *
 * NOTE on connection state: the SMTP client is connected by the RENDERER
 * (smtp:connect) using credentials held in renderer localStorage — main has
 * no stored SMTP config to connect from on its own. When the client is
 * missing/unconnected we fail honestly instead of throwing; agent callers
 * fall back to saving a draft.
 */
/**
 * After a reply is sent, mark every PENDING reply/reply_all agent decision for
 * the replied-to THREAD as resolved ("answered"). autoDraftReply only drafts for
 * PENDING decisions, so this guarantees the AI never prepares a fresh draft for a
 * message the user has already answered — the instant the send succeeds, before
 * the Sent copy even syncs back, and regardless of how the reply was composed (AI
 * draft, manual reply, or outbox retry). This complements the renderer-side
 * dismiss guard and autoDraftReply's own not-latest / own-mail gates.
 * Idempotent + best-effort.
 */
async function markThreadRepliesAnswered(storage: any, inReplyToMessageId?: string): Promise<string | null> {
  if (!storage || !inReplyToMessageId) return null;

  // Replied-to email → its thread. Resolved BEFORE the agent-repo gate so the
  // caller still gets the threadId (for draft cleanup) even when there are no
  // agent decisions to update.
  const repliedRows = await storage.getEmailsByMessageIds([inReplyToMessageId]);
  const threadId = repliedRows?.[0]?.threadId;
  if (!threadId) return null;

  const agentRepo = storage.getRepositories?.()?.agent;
  if (agentRepo) {
    const pending = await agentRepo.getPendingDecisions();
    const replyDecisions = pending.filter(
      (d: any) => d.proposedAction === 'reply' || d.proposedAction === 'reply_all',
    );
    if (replyDecisions.length > 0) {
      // Keep only decisions whose email lives in THIS thread.
      const emails = await storage.getEmailsByIds(replyDecisions.map((d: any) => d.emailId));
      const idsInThread = new Set(
        (emails || []).filter((e: any) => e.threadId === threadId).map((e: any) => e.id),
      );
      for (const d of replyDecisions) {
        if (!idsInThread.has(d.emailId)) continue;
        // 'answered-by-send' marks this as a SYSTEM resolution (not an explicit
        // user approval) so analytics/dismiss-gates can tell them apart.
        await agentRepo.updateDecisionStatus(d.id, 'approved', 'reply', 'answered-by-send');
        logger.info(`[SMTP] Resolved pending reply-proposal ${d.id} for answered thread ${threadId}`);
      }
    }
  }
  return threadId;
}

export async function sendEmailFromMain(
  options: SendEmailOptions,
): Promise<{ success: boolean; messageId?: string; error?: string; transient?: boolean; rawMessage?: string; needsSentAppend?: boolean }> {
  // Resolve the sending account: a non-active accountId (reply from another
  // mailbox) uses that account's SMTP client + DB + sync engine; otherwise the
  // active account (unchanged behavior).
  const acctId = options.accountId;
  const scoped = !!acctId && acctId !== getCurrentAccountId();
  const smtpClient = scoped ? getSmtpClientFor(acctId!) : getSmtpClient();
  const scopedStorage = scoped ? getStorageFor(acctId!) : getStorage();
  const scopedSyncEngine = scoped ? getSyncEngineFor(acctId!) : getSyncEngine();
  if (!smtpClient) {
    // No client yet — the renderer connects it lazily. Transient so the outbox
    // holds the send and retries once connected.
    return { success: false, error: 'SMTP client not initialized', transient: true };
  }
  if (!smtpClient.isConnected()) {
    return { success: false, error: 'Not connected to SMTP server. Please check connection settings.', transient: true };
  }

  let result = await smtpClient.sendEmail(options);

  // OAuth access tokens expire (~hourly) while the SMTP transporter keeps caching
  // the one it connected with — a later send then fails "invalid or expired token"
  // and nodemailer (static accessToken, no refresh token) can't recover on its
  // own. This is the ONE send choke point (compose, reply, agent auto-send, outbox
  // drains all pass here), so recover uniformly: on an auth/token failure for an
  // OAuth account, force a fresh token, reconnect, and retry once.
  const cfg = smtpClient.getConfig();
  if (!result.success && cfg?.authMethod === 'oauth2' && cfg.oauthProvider && isAuthTokenError(result.error)) {
    logger.warn(`[SMTP] Send failed with an auth/token error for ${cfg.username} — refreshing token and retrying`);
    try {
      const accessToken = await getValidAccessToken(cfg.oauthProvider, cfg.username, true /* forceRefresh */);
      await smtpClient.connect({ ...cfg, accessToken });
      result = await smtpClient.sendEmail(options);
    } catch (refreshErr) {
      logger.error(`[SMTP] Token refresh/reconnect failed for ${cfg.username}:`, refreshErr);
    }
    // If it STILL failed after a refresh attempt, keep it TRANSIENT so the outbox
    // holds and retries rather than permanently dead-lettering the message: an
    // OAuth auth error is recoverable once the token refreshes or the user
    // re-authenticates. (The outbox retry cap still bounds this.) Without this a
    // 5xx "invalid or expired token" classified permanent, dropping the mail.
    if (!result.success) result = { ...result, transient: true };
  }

  // Write a local Sent-folder mirror row so the UI sees the sent message
  // immediately (in thread view, lists, etc.) without waiting for the next
  // IMAP sync to pull it down from the server's Sent folder. Dedupe by
  // message_id when the real IMAP row arrives via sync.
  if (result.success && result.messageId) {
    const fromAddress =
      (smtpClient as any).config?.from ||
      (smtpClient as any).config?.username ||
      '';
    let fromName = '';
    try {
      fromName = getPipelineUserName() || '';
    } catch {}
    try {
      await writeLocalSentRow({
        messageId: result.messageId,
        subject: options.subject || '',
        to: options.to.join(', '),
        cc: options.cc?.join(', ') || '',
        bcc: options.bcc?.join(', ') || '',
        fromAddress,
        fromName,
        bodyText: options.body || '',
        bodyHtml: options.htmlBody || '',
        inReplyTo: options.inReplyTo || '',
        references: options.references?.join(' ') || options.inReplyTo || '',
      }, scopedStorage);
    } catch (err) {
      logger.error('[SMTP] Local sent mirror write failed (non-fatal):', err);
    }

    // Belt-and-suspenders: resolve this thread's pending reply-proposals so the
    // pipeline never re-drafts a reply the user just sent, AND remove any
    // lingering draft (the AI auto-draft or a manual one) now that a real reply
    // has gone out. This is the ONE choke point every send passes through
    // (interactive compose, inline reply, agent auto-send, outbox retries), so it
    // uniformly kills the stale draft the composer paths miss. Non-fatal.
    try {
      const answeredThreadId = await markThreadRepliesAnswered(scopedStorage, options.inReplyTo);
      if (answeredThreadId) {
        await deleteDraftsForThread(acctId, answeredThreadId);
      }
    } catch (err) {
      logger.warn('[SMTP] Post-send thread cleanup (proposals/drafts) failed (non-fatal):', err);
    }

    // Kick off a background Sent-folder sync so the real server row is
    // pulled and reconciled by message-id. Non-blocking so the UI returns
    // fast; any failure is logged and next sync tick will retry.
    try {
      const syncEngine = scopedSyncEngine;
      if (syncEngine && syncEngine.isConnected()) {
        const storage = scopedStorage;
        const folders = storage ? await storage.getFolders() : [];
        const sent = findFolderByType(folders as any, 'sent');
        if (sent?.path) {
          (syncEngine as any).syncAll({
            folders: [sent.path],
            maxMessages: 20,
            skipUnchanged: false,
            parallelSync: false,
          }).catch((e: any) => logger.warn('[SMTP] Background Sent sync failed:', e?.message || e));
        }
      }
    } catch (err) {
      logger.warn('[SMTP] Background Sent sync trigger failed:', err);
    }
  }

  // sendEmail does NOT throw on failure — it returns {success:false,error}.
  // Surface that directly (renderer checks the outer success and expects
  // messageId top-level), instead of wrapping as success unconditionally.
  // `transient` is propagated so the outbox can decide retry vs dead-letter.
  //
  // rawMessage + needsSentAppend drive the durable Sent-folder APPEND: the raw
  // MIME is uploaded to Sent (unless the provider auto-files SMTP submissions,
  // e.g. Gmail). Provider is detected from the sending client's own host.
  const host = (smtpClient as any).config?.host || '';
  const needsSentAppend = result.success && !!result.rawMessage && !providerAutoSavesSentCopy(host);
  return {
    success: result.success,
    messageId: result.messageId,
    error: result.error,
    transient: result.transient,
    rawMessage: result.rawMessage,
    needsSentAppend,
  };
}

/**
 * Upload a just-sent message into the IMAP Sent folder and reconcile the local
 * Sent row's UID by Message-ID. This is the durable half of the send: SMTP
 * accepted the message, but on a generic server (sarv.com) the Sent copy only
 * exists if WE append it — otherwise the message is lost on reinstall / another
 * device.
 *
 * Reuses the EXACT raw MIME submitted to SMTP (so the Message-ID matches), and
 * is idempotent: it dedupes by Message-ID before appending, so a crash-retry
 * (append succeeded but the marker wasn't cleared) won't create a duplicate.
 *
 * Throws when the append cannot be completed right now (IMAP offline) so the
 * caller keeps the append-pending marker and retries on the next drain/restart.
 * Injected into the outbox SendQueue and also called best-effort by the agent
 * auto-send path (which sends outside the queue).
 */
export async function appendSentCopy(
  rawMime: string,
  messageId: string,
  payload: SendEmailOptions,
): Promise<void> {
  const acctId = payload.accountId;
  const scoped = !!acctId && acctId !== getCurrentAccountId();
  const storage = scoped ? getStorageFor(acctId!) : getStorage();
  const syncEngine = scoped ? getSyncEngineFor(acctId!) : getSyncEngine();

  if (!storage) throw new Error('No storage for Sent append');
  if (!syncEngine || !syncEngine.isConnected()) {
    // Transient: keep the marker, retry when IMAP reconnects.
    throw new Error('IMAP offline — Sent append deferred');
  }

  const folders = await storage.getFolders();
  const sent = findFolderByType(folders as any, 'sent');
  if (!sent?.path) {
    // No Sent folder exists on this account — nothing to append to. Returning
    // (not throwing) lets the caller clear the marker instead of looping.
    logger.warn('[SMTP] No Sent folder — skipping Sent append');
    return;
  }
  const sentPath = sent.path;
  const midKey = messageId.replace(/[<>]/g, '').trim().toLowerCase();

  const run = async (conn: any): Promise<void> => {
    await conn.selectFolder(sentPath);

    // Dedupe: is this message ALREADY in the server's Sent folder? Some servers
    // auto-file a Sent copy, so only append when it's genuinely missing. A
    // Message-ID scan is the reliable locator on servers without
    // UIDPLUS/HEADER-SEARCH (sarv.com).
    let alreadyOnServer = false;
    if (midKey && typeof conn.fetchMessageIdToUidMap === 'function') {
      try {
        const map: Map<string, number> = await conn.fetchMessageIdToUidMap();
        alreadyOnServer = map.has(midKey);
      } catch (e) {
        logger.warn('[SMTP] Sent Message-ID scan failed (will still append):', (e as Error)?.message || e);
      }
    }

    if (!alreadyOnServer) {
      // Not already in Sent → upload it (seen, since the user sent it).
      await conn.appendMessage(sentPath, rawMime, ['\\Seen']);
    }

    // DELIBERATELY do NOT stamp the local mirror row's UID here. The local Sent
    // row (writeLocalSentRow) is intentionally uid=0, which Phase-2 deletion
    // PROTECTS — it diffs only rows carrying a real server UID
    // (message-processor's `.filter(r => !!r.uid)`). Stamping the just-APPENDed
    // UID here dropped the row out of that protection into the "diff against the
    // server's Sent UID list" set — and on a server whose Sent listing lags the
    // APPEND (sarv.com), the very next Sent sync saw that UID as "missing from
    // server" and DELETED the local copy, so a just-sent mail VANISHED from Sent
    // until a later full sync re-fetched it. Leaving it uid=0 keeps it visible +
    // protected; the next natural Sent sync fetches the server copy and stamps the
    // real UID via linkEmailToFolder — at which point the UID is provably IN the
    // server listing, so deletion can't fire.
  };

  const pool = (syncEngine as any).connectionPool;
  if (pool?.withConnection) {
    await pool.withConnection(run);
  } else {
    await run((syncEngine as any).getClient());
  }
  logger.info('[SMTP] Sent copy appended (UID stamped by the next Sent sync)', sentPath, messageId);
}

/**
 * Write a local emails-table mirror row for a just-sent message.
 *
 * Why: IMAP Sent-folder sync may lag (or be broken) so a user-sent reply or
 * forward doesn't appear in the thread until the next sync tick. Writing a
 * local row here makes the sent message visible immediately. When the real
 * IMAP row arrives via sync, message-id collision is handled by the UPSERT
 * path (storage.insertEmail dedupes on message_id).
 *
 * Exported for tests: like the draft mirror, this hand-writes an `emails` row
 * instead of going through EmailRepository, so the column contracts the
 * repository would have maintained (body lengths, thread key, `content_hash`)
 * are this function's responsibility and need a real schema to verify. It is
 * not part of the IPC surface.
 */
export async function writeLocalSentRow(row: {
  messageId: string;
  subject: string;
  to: string;
  cc: string;
  bcc: string;
  fromAddress: string;
  fromName?: string;
  bodyText: string;
  bodyHtml: string;
  inReplyTo: string;
  references: string;
}, targetStorage?: ReturnType<typeof getStorage>): Promise<void> {
  // Mirror into the SENDING account's DB (targetStorage), not just the active one.
  const storage = targetStorage ?? getStorage();
  if (!storage) return;
  const db = (storage as any).db;
  if (!db?.prepare) return;

  // Find the Sent folder via the unified resolver (special_use → path → name).
  const allFolders = await storage.getFolders();
  const sentRecord = findFolderByType(allFolders as any, 'sent');
  if (!sentRecord?.path) {
    logger.warn('[SMTP] No Sent folder found — skipping local sent mirror');
    return;
  }
  const sentFolder = db
    .prepare('SELECT id, path FROM folders WHERE path = ? LIMIT 1')
    .get(sentRecord.path) as any;
  if (!sentFolder?.id) {
    logger.warn('[SMTP] Sent folder not in folders table — skipping');
    return;
  }

  // If this message-id is already in the DB (e.g. re-send), skip.
  const existing = db
    .prepare('SELECT id FROM emails WHERE message_id = ?')
    .get(row.messageId) as any;
  if (existing?.id) {
    logger.info('[SMTP] Sent mirror already exists for message-id', row.messageId);
    return;
  }

  // Derive a stable id from the message-id.
  const id = row.messageId.replace(/[<>]/g, '');
  const now = Math.floor(Date.now() / 1000);

  // Thread the reply into the same conversation. If inReplyTo matches an
  // existing email, reuse its thread_id; otherwise start a new thread.
  let threadId = id;
  if (row.inReplyTo) {
    const inReply = db
      .prepare('SELECT thread_id FROM emails WHERE message_id = ? LIMIT 1')
      .get(row.inReplyTo) as any;
    if (inReply?.thread_id) threadId = inReply.thread_id;
  }

  // emails.thread_id has a FK to threads(id) — if we're starting a brand new
  // thread here (no matching inReplyTo), we have to insert the parent row
  // first or the email insert below fails with SQLITE_CONSTRAINT_FOREIGNKEY.
  try {
    db.prepare(`
      INSERT OR IGNORE INTO threads
        (id, subject, first_message_id, last_message_id, last_message_date, message_count, participants, has_unread, has_flagged, labels)
      VALUES
        (?, ?, ?, ?, ?, 1, '[]', 0, 0, '[]')
    `).run(threadId, row.subject || '', row.messageId, row.messageId, now);
  } catch (err) {
    logger.warn('[SMTP] Thread upsert failed, insert may still succeed if row exists:', err);
  }

  const insertSentRow = db.prepare(`
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
      -- The bodies go to the email_bodies side table (migration 73), written in
      -- the same transaction below; '' rather than NULL so the read-side
      -- COALESCE stays total.
      '', '',
      -- Same contract as the drafts insert and the repository: every writer of
      -- a body writes its length, in SQL, through the shared helper. A NULL
      -- here would make the sent copy invisible to the fast has-body test.
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
    folderId: sentFolder.id,
    uid: 0, // local-only until IMAP assigns a real UID during sync
    tags: `|${sentFolder.path}|read|`,
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
    rawBody: row.bodyHtml || row.bodyText,
    contentType: row.bodyHtml ? 'html' : 'text',
    // Through the shared rule, like every other writer of a body. This used to
    // be '', which is the one value that makes EVERY sent copy look like the
    // same content to anything comparing hashes.
    contentHash: emailContentHash({
      cleanBody: row.bodyText,
      rawBody: row.bodyHtml || row.bodyText,
      messageId: row.messageId,
    }),
    inReplyTo: row.inReplyTo,
    refs: row.references,
    priority: 'normal',
    hasAttachments: 0,
    attachmentCount: 0,
    attachmentNames: '',
    attachmentSizes: null,
    importanceScore: 0,
    importanceSource: 'none',
  };

  // Header row, body row and thread key in ONE transaction: the sent mirror is
  // the user's only local record of what they sent, so a torn write that leaves
  // the row without its body is worse than no row at all.
  //
  // This row is inserted directly, not through EmailRepository, so the thread
  // resolver's lookup key has to be written here too. Without it the reply that
  // comes back to a mail WE sent cannot find the sent copy by subject and starts
  // its own conversation.
  db.transaction(() => {
    // The sent mirror carries whatever the composer produced, inline images
    // included, so it bloats exactly like a received mail. Blobs first, the
    // rewritten body bound to the insert (its `raw_body_len` must describe what
    // is stored), edges last because they reference `emails(id)`. Same order as
    // EmailRepository.insertRows — see `inline-image-store.ts`.
    const { rawBody, hashes } = relocateBodyForInsert(db, insertParams.rawBody);
    insertSentRow.run({ ...insertParams, rawBody });
    db.prepare(UPSERT_BODY_SQL).run({
      id,
      cleanBody: insertParams.cleanBody,
      rawBody,
    });
    writeImageLinks(db, id, hashes);
    writeThreadKey(db, { id, subject: row.subject, date: now });
  })();

  logger.info('[SMTP] Wrote local sent mirror row', id, 'thread', threadId);
}
