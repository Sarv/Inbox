/**
 * Queue IPC Handlers
 *
 * Surfaces the two retry queues to the renderer so failures aren't invisible:
 *  - outbox:*  → the SMTP send outbox (pending_sends)
 *  - opqueue:* → dead-lettered IMAP operations (pending_operations, status=failed)
 *
 * Each handler follows the repo convention: requireStorage() + try/catch +
 * { success, data? , error? }.
 */

import { ipcMain } from 'electron';

import { drainOutbox, notifyOutboxChanged } from '../services/outbox-service';
import { requireStorage, getSyncEngine, getSmtpClient } from '../shared';

/** Fate of a single send after a manual retry, for a clear UI status message. */
type RetryOutcome = 'sent' | 'queued' | 'failed';
const outcomeForSend = (send: { status: string } | undefined): RetryOutcome =>
  !send ? 'sent' : send.status === 'failed' ? 'failed' : 'queued';

export function registerQueueHandlers(): void {
  // ========== Outbox (SMTP sends) ==========

  /** Every send in the outbox, shaped for display. */
  ipcMain.handle('outbox:list', async () => {
    try {
      const storage = requireStorage();
      const sends = await storage.getAllSends();
      const data = sends.map((s) => {
        const payload = (s.payload ?? {}) as { to?: string[] | string; subject?: string };
        return {
          id: s.id,
          to: Array.isArray(payload.to) ? payload.to.join(', ') : payload.to ?? '',
          subject: payload.subject ?? '',
          status: s.status,
          retryCount: s.retryCount,
          lastError: s.lastError ?? null,
          nextRetryAt: s.nextRetryAt ?? null,
          createdAt: s.createdAt,
        };
      });
      return { success: true, data };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  /**
   * Full stored content of one queued/failed send, for the Outbox preview. The
   * exact message that WILL be sent (or was attempted) — recipients, subject,
   * body — so the user can see what's sitting in the queue. Attachment bytes are
   * stripped to metadata (name/type/size); we never ship the blobs to the UI.
   */
  ipcMain.handle('outbox:get', async (_event, id: number) => {
    try {
      const storage = requireStorage();
      const send = (await storage.getAllSends()).find((s) => s.id === id);
      if (!send) return { success: false, error: 'Message not found' };
      const p = (send.payload ?? {}) as {
        to?: string[]; cc?: string[]; bcc?: string[];
        subject?: string; body?: string; htmlBody?: string;
        attachments?: Array<{ filename?: string; contentType?: string; content?: unknown; encoding?: string }>;
      };
      const sizeOf = (a: { content?: unknown; encoding?: string }): number => {
        const c = a.content;
        if (c == null) return 0;
        if (typeof c === 'string') return a.encoding === 'base64' ? Math.floor((c.length * 3) / 4) : Buffer.byteLength(c);
        if (Buffer.isBuffer(c)) return c.length;
        if (c instanceof Uint8Array) return c.byteLength;
        return 0;
      };
      return {
        success: true,
        data: {
          to: p.to ?? [],
          cc: p.cc ?? [],
          bcc: p.bcc ?? [],
          subject: p.subject ?? '',
          body: p.body ?? '',
          htmlBody: p.htmlBody ?? '',
          status: send.status,
          lastError: send.lastError ?? null,
          createdAt: send.createdAt,
          attachments: (p.attachments ?? []).map((a) => ({
            filename: a.filename ?? '(unnamed)',
            contentType: a.contentType ?? 'application/octet-stream',
            size: sizeOf(a),
          })),
        },
      };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  /** Pending + failed counts for the Outbox badge. */
  ipcMain.handle('outbox:counts', async () => {
    try {
      const storage = requireStorage();
      return { success: true, data: await storage.getPendingSendCounts() };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  /**
   * Retry a single failed send now. Re-arms the row, drains, then re-reads it to
   * report its precise fate (sent / re-queued / failed again) plus whether SMTP
   * was even connected — so the UI can always show that something happened,
   * instead of a button that appears to do nothing.
   */
  ipcMain.handle('outbox:retry', async (_event, id: number) => {
    try {
      const storage = requireStorage();
      await storage.resetPendingSend(id);
      const connected = getSmtpClient()?.isConnected() ?? false;
      const drained = await drainOutbox();
      const after = (await storage.getAllSends()).find((s) => s.id === id);
      return {
        success: true,
        data: {
          outcome: outcomeForSend(after),
          connected,
          lastError: after?.lastError ?? null,
          drained,
        },
      };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  /** Retry every failed send now. Reports how the whole batch drained. */
  ipcMain.handle('outbox:retryAll', async () => {
    try {
      const storage = requireStorage();
      const sends = await storage.getAllSends();
      const retried = sends.filter((s) => s.status === 'failed');
      for (const s of retried) await storage.resetPendingSend(s.id);
      const connected = getSmtpClient()?.isConnected() ?? false;
      const drained = await drainOutbox();
      return { success: true, data: { retried: retried.length, connected, drained } };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  /** Discard a single send from the outbox. */
  ipcMain.handle('outbox:delete', async (_event, id: number) => {
    try {
      const storage = requireStorage();
      await storage.deletePendingSend(id);
      notifyOutboxChanged();
      return { success: true };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  // ========== IMAP operation dead-letter queue ==========

  /** Pending + failed counts for IMAP flag/move/delete operations. */
  ipcMain.handle('opqueue:counts', async () => {
    try {
      const storage = requireStorage();
      return { success: true, data: await storage.getPendingOperationCounts() };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  /** List dead-lettered IMAP operations. */
  ipcMain.handle('opqueue:failed', async () => {
    try {
      const storage = requireStorage();
      return { success: true, data: await storage.getFailedOperations() };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  /** Re-arm all dead-lettered IMAP operations and drain the queue. */
  ipcMain.handle('opqueue:retry', async () => {
    try {
      const syncEngine = getSyncEngine();
      if (!syncEngine) return { success: false, error: 'Sync engine not available' };
      const count = await syncEngine.retryFailedOperations();
      return { success: true, data: { retried: count } };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  /** Discard every dead-lettered IMAP operation. */
  ipcMain.handle('opqueue:discardAll', async () => {
    try {
      const storage = requireStorage();
      const removed = await storage.deleteFailedOperations();
      notifyOutboxChanged();
      return { success: true, data: { removed } };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  /** Re-arm a single dead-lettered IMAP operation and drain the queue. */
  ipcMain.handle('opqueue:retryOne', async (_event, id: number) => {
    try {
      const syncEngine = getSyncEngine();
      if (!syncEngine) return { success: false, error: 'Sync engine not available' };
      const ok = await syncEngine.retryFailedOperation(id);
      return { success: true, data: { retried: ok ? 1 : 0 } };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  /** Discard every failed send (queued/accepted sends are left untouched). */
  ipcMain.handle('outbox:discardAll', async () => {
    try {
      const storage = requireStorage();
      const removed = await storage.deleteFailedSends();
      notifyOutboxChanged();
      return { success: true, data: { removed } };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  /** Discard a single dead-lettered IMAP operation. */
  ipcMain.handle('opqueue:delete', async (_event, id: number) => {
    try {
      const storage = requireStorage();
      await storage.deletePendingOperation(id);
      return { success: true };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });
}
