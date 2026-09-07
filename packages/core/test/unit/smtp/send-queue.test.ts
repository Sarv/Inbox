import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';

import { SendQueue } from '../../../src/smtp/send-queue';
import type { SendEmailOptions } from '../../../src/types/smtp';

// Regression for the "quit within the undo window loses the whole email" bug.
// The old path deleted the draft immediately and kept the outgoing mail ONLY in
// renderer memory for the 5s undo window; a crash/quit in that window destroyed
// it. The fix persists the send to the outbox FIRST, held for the undo window,
// and commits (transmits) only when the window elapses. These tests prove the
// mail is durable the entire time: never transmitted early, never lost, and
// drained on the next pass once the hold expires (crash recovery).

interface Row {
  id: number;
  payload: unknown;
  status: string;
  retry_count: number;
  next_retry_at: number | null;
  last_error?: string | null;
  smtp_accepted?: boolean;
  sent_append_pending?: boolean;
  raw_mime?: string | null;
  message_id?: string | null;
}

// Minimal, faithful in-memory stand-in for the pending_sends methods SendQueue
// uses — the due-time filter mirrors the SQL (`next_retry_at IS NULL OR <= now`),
// and the append-pending marker mirrors the smtp_accepted + sent_append_pending
// columns (a row carrying those must never be re-sent, only appended).
function makeFakeStorage() {
  const rows = new Map<number, Row>();
  let seq = 0;
  const now = () => Math.floor(Date.now() / 1000);
  const toRecord = (r: Row) => ({
    id: r.id,
    payload: r.payload,
    status: r.status,
    retryCount: r.retry_count,
    lastError: r.last_error ?? null,
    nextRetryAt: r.next_retry_at,
    createdAt: 0,
    updatedAt: 0,
    smtpAccepted: r.smtp_accepted ?? false,
    sentAppendPending: r.sent_append_pending ?? false,
    rawMime: r.raw_mime ?? null,
    messageId: r.message_id ?? null,
  });
  return {
    rows,
    async savePendingSend(payload: unknown, nextRetryAt?: number) {
      const id = ++seq;
      rows.set(id, { id, payload, status: 'pending', retry_count: 0, next_retry_at: nextRetryAt ?? null });
      return id;
    },
    async getDueSends(nowSec: number) {
      return [...rows.values()]
        .filter((r) => r.status === 'pending' && (r.next_retry_at == null || r.next_retry_at <= nowSec))
        .map(toRecord);
    },
    async getAppendPendingSends() {
      return [...rows.values()].filter((r) => r.sent_append_pending).map(toRecord);
    },
    async markSendAppendPending(id: number, rawMime: string, messageId: string) {
      // Mirrors the real SQL: status flips to 'append_pending', which keeps the
      // row out of getDueSends AND out of the executing→pending crash reset, so
      // an SMTP-accepted message can only ever be appended, never re-sent.
      const r = rows.get(id);
      if (r) { r.smtp_accepted = true; r.sent_append_pending = true; r.raw_mime = rawMime; r.message_id = messageId; r.status = 'append_pending'; }
    },
    async getAllSends() { return [...rows.values()].map(toRecord); },
    async updatePendingSendStatus(id: number, status: string) { const r = rows.get(id); if (r) r.status = status; },
    async updatePendingSendAttempt(id: number, retryCount: number, err: string, nextRetryAt: number) {
      const r = rows.get(id); if (r) { r.status = 'pending'; r.retry_count = retryCount; r.next_retry_at = nextRetryAt; r.last_error = err; }
    },
    async markPendingSendFailed(id: number, lastError?: string) {
      const r = rows.get(id); if (r) { r.status = 'failed'; r.last_error = lastError ?? null; }
    },
    async deletePendingSend(id: number) { rows.delete(id); },
    async cancelHeldSend(id: number) {
      const r = rows.get(id);
      if (r && r.status === 'pending' && r.next_retry_at != null && r.next_retry_at > now()) { rows.delete(id); return true; }
      return false;
    },
    async clearSendHold(id: number) { const r = rows.get(id); if (r && r.status === 'pending') r.next_retry_at = null; },
  };
}

const PAYLOAD = { to: ['a@b.com'], subject: 'hi', body: 'x' } as unknown as SendEmailOptions;

describe('SendQueue undo-send hold — persist-first, crash-safe', () => {
  let storage: ReturnType<typeof makeFakeStorage>;
  let sendFn: Mock<any[], any>;
  let queue: SendQueue;

  beforeEach(() => {
    storage = makeFakeStorage();
    sendFn = vi.fn(async () => ({ success: true, messageId: '<m@x>', needsSentAppend: false }));
    queue = new SendQueue();
    queue.initialize({ storage: storage as any, sendFn: sendFn as any, isConnected: () => true });
  });

  it('enqueueHeld persists the send but does NOT transmit it', async () => {
    const { id } = await queue.enqueueHeld(PAYLOAD, 5000);
    expect(storage.rows.has(id)).toBe(true);          // durable immediately
    expect(storage.rows.get(id)!.next_retry_at).toBeGreaterThan(Math.floor(Date.now() / 1000)); // held
    expect(sendFn).not.toHaveBeenCalled();            // not sent yet
  });

  it('a drain during the hold window (a crash-and-restart) does NOT send early, and does NOT lose it', async () => {
    const { id } = await queue.enqueueHeld(PAYLOAD, 60_000);
    await queue.processQueue();                        // simulates a restart drain mid-window
    expect(sendFn).not.toHaveBeenCalled();             // still held → not transmitted early
    expect(storage.rows.has(id)).toBe(true);           // still safely in the outbox
  });

  it('commitHeld releases the hold and transmits exactly once', async () => {
    const { id } = await queue.enqueueHeld(PAYLOAD, 60_000);
    await queue.commitHeld(id);
    expect(sendFn).toHaveBeenCalledTimes(1);           // sent
    expect(storage.rows.has(id)).toBe(false);          // removed on success
  });

  it('cancelHeld (undo) removes the held send so it is never transmitted', async () => {
    const { id } = await queue.enqueueHeld(PAYLOAD, 60_000);
    const cancelled = await queue.cancelHeld(id);
    expect(cancelled).toBe(true);
    await queue.processQueue();
    expect(sendFn).not.toHaveBeenCalled();
    expect(storage.rows.has(id)).toBe(false);
  });

  it('cancelHeld returns false once already committed (too late to unsend, never lost)', async () => {
    const { id } = await queue.enqueueHeld(PAYLOAD, 60_000);
    await queue.commitHeld(id);                        // committed + sent + deleted
    const cancelled = await queue.cancelHeld(id);
    expect(cancelled).toBe(false);                     // undo is a no-op after commit
  });

  it('after the hold elapses, a plain drain transmits it (crash-recovery: restart sends the persisted mail)', async () => {
    // holdMs=0 → next_retry_at = now, i.e. the window has already elapsed.
    await queue.enqueueHeld(PAYLOAD, 0);
    await queue.processQueue();                        // the drain that runs on reconnect/restart
    expect(sendFn).toHaveBeenCalledTimes(1);           // the mail is delivered, not lost
  });

  it('committing AFTER an undo sends nothing (the row is gone — cancel wins)', async () => {
    const { id } = await queue.enqueueHeld(PAYLOAD, 60_000);
    expect(await queue.cancelHeld(id)).toBe(true);
    await queue.commitHeld(id);                        // e.g. the undo-window timer still fires
    expect(sendFn).not.toHaveBeenCalled();             // must NOT resurrect a cancelled send
    expect(storage.rows.size).toBe(0);
  });

  it('a double commit transmits exactly once (no duplicate mail)', async () => {
    const { id } = await queue.enqueueHeld(PAYLOAD, 60_000);
    await queue.commitHeld(id);
    await queue.commitHeld(id);                        // re-entrant timer / double IPC
    expect(sendFn).toHaveBeenCalledTimes(1);
  });

  it('every held-send entry point refuses to run before initialize (no silent data loss)', async () => {
    const bare = new SendQueue();
    await expect(bare.enqueueHeld(PAYLOAD, 1000)).rejects.toThrow(/not initialized/);
    await expect(bare.commitHeld(1)).rejects.toThrow(/not initialized/);
    await expect(bare.cancelHeld(1)).rejects.toThrow(/not initialized/);
    await expect(bare.enqueueAndSend(PAYLOAD)).rejects.toThrow(/not initialized/);
  });
});

// enqueueAndSend is the smtp:send path. The contract that matters is ordering:
// the row is durable (and marked 'executing') BEFORE the socket is touched, so a
// crash mid-send can only duplicate — never lose — the mail.
describe('SendQueue.enqueueAndSend — persist-first ordering', () => {
  let storage: ReturnType<typeof makeFakeStorage>;
  let queue: SendQueue;

  beforeEach(() => {
    storage = makeFakeStorage();
    queue = new SendQueue();
  });

  it('persists the send and marks it executing BEFORE calling the transport', async () => {
    let snapshot: Row | undefined;
    const sendFn = vi.fn(async () => {
      // Observed from inside the "socket" call: the row must already exist.
      snapshot = { ...[...storage.rows.values()][0] };
      return { success: true, messageId: '<m@x>' };
    });
    queue.initialize({ storage: storage as any, sendFn: sendFn as any, isConnected: () => true });

    const result = await queue.enqueueAndSend(PAYLOAD);
    expect(snapshot).toBeDefined();
    expect(snapshot!.status).toBe('executing');     // durable + claimed before the wire
    expect(result).toEqual({ status: 'success', messageId: '<m@x>' });
    expect(storage.rows.size).toBe(0);              // cleared only after success
  });

  it('when offline, persists as due-now and reports queued without touching the transport', async () => {
    const sendFn = vi.fn();
    queue.initialize({ storage: storage as any, sendFn: sendFn as any, isConnected: () => false });

    const result = await queue.enqueueAndSend(PAYLOAD);
    expect(result).toEqual({ status: 'queued' });
    expect(sendFn).not.toHaveBeenCalled();
    const row = [...storage.rows.values()][0];
    expect(row.status).toBe('pending');
    expect(row.next_retry_at).toBeNull();           // due immediately on reconnect
  });
});

describe('SendQueue retry policy — transient retries, permanent dead-letters', () => {
  let storage: ReturnType<typeof makeFakeStorage>;

  const transientFail = () => ({ success: false, error: 'ETIMEDOUT socket hang up', transient: true });
  const permanentFail = () => ({ success: false, error: '550 Mailbox not found', transient: false });

  beforeEach(() => {
    storage = makeFakeStorage();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-19T00:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reschedules a transient (4.x.x) failure with exponential backoff and never sends it early', async () => {
    const sendFn = vi.fn(async () => transientFail());
    const queue = new SendQueue();
    queue.initialize({ storage: storage as any, sendFn: sendFn as any, isConnected: () => true });

    const t0 = Math.floor(Date.now() / 1000);
    expect(await queue.enqueueAndSend(PAYLOAD)).toMatchObject({ status: 'queued' });
    const row = [...storage.rows.values()][0];
    expect(row.status).toBe('pending');
    expect(row.retry_count).toBe(1);
    expect(row.next_retry_at).toBe(t0 + 15);         // baseRetryDelayMs = 15s

    // A drain BEFORE it is due must not re-attempt (that is how a 15s backoff
    // turns into a hot loop hammering the server).
    await vi.advanceTimersByTimeAsync(14_000);
    await queue.processQueue();
    expect(sendFn).toHaveBeenCalledTimes(1);

    // Once due, the next attempt doubles the delay: 15s → 30s.
    await vi.advanceTimersByTimeAsync(1_000);
    const t1 = Math.floor(Date.now() / 1000);
    await queue.processQueue();
    expect(sendFn).toHaveBeenCalledTimes(2);
    expect([...storage.rows.values()][0].retry_count).toBe(2);
    expect([...storage.rows.values()][0].next_retry_at).toBe(t1 + 30);
  });

  it('caps the backoff at maxRetryDelayMs', async () => {
    const sendFn = vi.fn(async () => transientFail());
    const queue = new SendQueue({ baseRetryDelayMs: 60_000, maxRetryDelayMs: 90_000 });
    queue.initialize({ storage: storage as any, sendFn: sendFn as any, isConnected: () => true });

    await queue.enqueueAndSend(PAYLOAD);             // attempt 1 → 60s
    await vi.advanceTimersByTimeAsync(60_000);
    const t = Math.floor(Date.now() / 1000);
    await queue.processQueue();                       // attempt 2 → 120s, capped to 90s
    expect([...storage.rows.values()][0].next_retry_at).toBe(t + 90);
  });

  it('dead-letters a permanent (5.x.x) failure immediately — one attempt, no retry', async () => {
    const sendFn = vi.fn(async () => permanentFail());
    const queue = new SendQueue();
    queue.initialize({ storage: storage as any, sendFn: sendFn as any, isConnected: () => true });

    const result = await queue.enqueueAndSend(PAYLOAD);
    expect(result).toMatchObject({ status: 'failed', error: '550 Mailbox not found' });
    const row = [...storage.rows.values()][0];
    expect(row.status).toBe('failed');               // visible dead-letter, not deleted
    expect(row.last_error).toContain('550');

    // A 'failed' row is never picked up again by a drain.
    await queue.processQueue();
    expect(sendFn).toHaveBeenCalledTimes(1);
  });

  it('treats a failure with no transient flag as permanent (conservative default)', async () => {
    const sendFn = vi.fn(async () => ({ success: false }));
    const queue = new SendQueue();
    queue.initialize({ storage: storage as any, sendFn: sendFn as any, isConnected: () => true });

    const result = await queue.enqueueAndSend(PAYLOAD);
    expect(result).toEqual({ status: 'failed', error: 'Unknown send error' });
  });

  it('treats a THROWN sendFn as transient so the mail is retried rather than lost', async () => {
    const sendFn = vi.fn(async () => { throw new Error('boom in the transport layer'); });
    const queue = new SendQueue();
    queue.initialize({ storage: storage as any, sendFn: sendFn as any, isConnected: () => true });

    const result = await queue.enqueueAndSend(PAYLOAD);
    expect(result).toMatchObject({ status: 'queued', error: 'boom in the transport layer' });
    expect([...storage.rows.values()][0].status).toBe('pending');
  });

  it('handles a sendFn that throws a non-Error value (bad IPC payload)', async () => {
    const sendFn = vi.fn(async () => { throw 'plain string failure'; });
    const queue = new SendQueue();
    queue.initialize({ storage: storage as any, sendFn: sendFn as any, isConnected: () => true });

    const result = await queue.enqueueAndSend(PAYLOAD);
    expect(result).toMatchObject({ status: 'queued', error: 'plain string failure' });
  });

  it('gives up after maxRetries and dead-letters with the retry count in the error', async () => {
    const sendFn = vi.fn(async () => transientFail());
    const queue = new SendQueue({ maxRetries: 2, baseRetryDelayMs: 1_000 });
    queue.initialize({ storage: storage as any, sendFn: sendFn as any, isConnected: () => true });

    await queue.enqueueAndSend(PAYLOAD);              // attempt 1 → retry 1
    await vi.advanceTimersByTimeAsync(2_000);
    await queue.processQueue();                        // attempt 2 → retry 2
    await vi.advanceTimersByTimeAsync(5_000);
    const drain = await queue.processQueue();          // attempt 3 → over the cap

    expect(sendFn).toHaveBeenCalledTimes(3);
    expect(drain).toEqual({ sent: 0, queued: 0, failed: 1 });
    const row = [...storage.rows.values()][0];
    expect(row.status).toBe('failed');
    expect(row.last_error).toContain('gave up after 2 retries');
  });
});

describe('SendQueue.processQueue — a drain never sends the same mail twice', () => {
  let storage: ReturnType<typeof makeFakeStorage>;
  let sendFn: Mock<any[], any>;
  let connected: boolean;
  let queue: SendQueue;

  beforeEach(() => {
    storage = makeFakeStorage();
    connected = true;
    sendFn = vi.fn(async () => ({ success: true, messageId: '<m@x>' }));
    queue = new SendQueue();
    queue.initialize({ storage: storage as any, sendFn: sendFn as any, isConnected: () => connected });
  });

  it('sends each due row exactly once and reports the tally', async () => {
    await queue.enqueueHeld(PAYLOAD, 0);
    await queue.enqueueHeld(PAYLOAD, 0);
    const result = await queue.processQueue();
    expect(result).toEqual({ sent: 2, queued: 0, failed: 0 });
    expect(sendFn).toHaveBeenCalledTimes(2);

    await queue.processQueue();                        // second drain: nothing left
    expect(sendFn).toHaveBeenCalledTimes(2);
  });

  // The reconnect drain and the periodic-timer drain can overlap; without the
  // guard both would pick up the same due row and send it twice.
  it('overlapping drains are serialized by the processing guard (no double send)', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    sendFn.mockImplementation(async () => { await gate; return { success: true, messageId: '<m@x>' }; });
    await queue.enqueueHeld(PAYLOAD, 0);

    const first = queue.processQueue();
    const second = await queue.processQueue();         // rejected by the guard, immediately
    expect(second).toEqual({ sent: 0, queued: 0, failed: 0 });
    release();
    expect(await first).toEqual({ sent: 1, queued: 0, failed: 0 });
    expect(sendFn).toHaveBeenCalledTimes(1);
  });

  it('does nothing while offline (the mail stays queued for reconnect)', async () => {
    await queue.enqueueHeld(PAYLOAD, 0);
    connected = false;
    expect(await queue.processQueue()).toEqual({ sent: 0, queued: 0, failed: 0 });
    expect(sendFn).not.toHaveBeenCalled();
    expect(storage.rows.size).toBe(1);
  });

  it('stops attempting when the connection drops mid-drain and leaves the rest due', async () => {
    await queue.enqueueHeld(PAYLOAD, 0);
    await queue.enqueueHeld(PAYLOAD, 0);
    sendFn.mockImplementation(async () => { connected = false; return { success: true, messageId: '<m@x>' }; });

    const result = await queue.processQueue();
    expect(sendFn).toHaveBeenCalledTimes(1);           // the second row is not attempted
    expect(result).toEqual({ sent: 1, queued: 1, failed: 0 });
    expect(storage.rows.size).toBe(1);                 // still safely persisted
  });

  it('returns a zero tally when the queue is empty', async () => {
    expect(await queue.processQueue()).toEqual({ sent: 0, queued: 0, failed: 0 });
  });

  it('is inert (never throws) before initialize', async () => {
    expect(await new SendQueue().processQueue()).toEqual({ sent: 0, queued: 0, failed: 0 });
  });
});

// The Sent copy is the other half of "sent exactly once": SMTP has already
// accepted the message, so a retry here must APPEND only — never re-transmit —
// and providers that file the copy themselves (Gmail) must not get a duplicate.
describe('SendQueue Sent-folder APPEND', () => {
  let storage: ReturnType<typeof makeFakeStorage>;
  let sendFn: Mock<any[], any>;
  let appendSentFn: Mock<any[], any>;
  let connected: boolean;

  const RAW = 'Message-ID: <m@x>\r\n\r\nbody';

  const makeQueue = (needsSentAppend: boolean, opts: { rawMessage?: string } = { rawMessage: RAW }) => {
    sendFn = vi.fn(async () => ({ success: true, messageId: '<m@x>', rawMessage: opts.rawMessage, needsSentAppend }));
    const queue = new SendQueue();
    queue.initialize({
      storage: storage as any,
      sendFn: sendFn as any,
      isConnected: () => connected,
      appendSentFn: appendSentFn as any,
    });
    return queue;
  };

  beforeEach(() => {
    storage = makeFakeStorage();
    connected = true;
    appendSentFn = vi.fn(async () => {});
  });

  it('appends the exact submitted MIME + Message-ID, marking the row BEFORE the upload', async () => {
    let markedBeforeAppend: { accepted?: boolean; pending?: boolean } = {};
    appendSentFn.mockImplementation(async () => {
      const row = [...storage.rows.values()][0];
      markedBeforeAppend = { accepted: row?.smtp_accepted, pending: row?.sent_append_pending };
    });

    const result = await makeQueue(true).enqueueAndSend(PAYLOAD);
    expect(result.status).toBe('success');
    // Crash-safety: the marker exists while the append runs, so a crash here
    // resumes as append-only instead of re-sending.
    expect(markedBeforeAppend).toEqual({ accepted: true, pending: true });
    expect(appendSentFn).toHaveBeenCalledWith(RAW, '<m@x>', PAYLOAD);
    expect(storage.rows.size).toBe(0);                 // completed → row gone
  });

  // Gmail files SMTP submissions into Sent itself; appending would show the user
  // two copies of every sent mail.
  it('does NOT append for providers that auto-file to Sent (needsSentAppend=false)', async () => {
    const result = await makeQueue(false).enqueueAndSend(PAYLOAD);
    expect(result.status).toBe('success');
    expect(appendSentFn).not.toHaveBeenCalled();
    expect(storage.rows.size).toBe(0);
  });

  it('skips the append when the raw MIME is missing (nothing to upload)', async () => {
    const result = await makeQueue(true, {}).enqueueAndSend(PAYLOAD);
    expect(result.status).toBe('success');
    expect(appendSentFn).not.toHaveBeenCalled();
    expect(storage.rows.size).toBe(0);
  });

  it('appends with an empty Message-ID rather than skipping when the send did not return one', async () => {
    sendFn = vi.fn(async () => ({ success: true, rawMessage: RAW, needsSentAppend: true }));
    const queue = new SendQueue();
    queue.initialize({ storage: storage as any, sendFn: sendFn as any, isConnected: () => connected, appendSentFn: appendSentFn as any });
    await queue.enqueueAndSend(PAYLOAD);
    expect(appendSentFn).toHaveBeenCalledWith(RAW, '', PAYLOAD);
  });

  it('reports success when the append fails, keeps the marker, and completes it later WITHOUT re-sending', async () => {
    appendSentFn.mockRejectedValueOnce(new Error('IMAP offline'));
    const queue = makeQueue(true);

    const result = await queue.enqueueAndSend(PAYLOAD);
    expect(result.status).toBe('success');             // the SEND did succeed
    const row = [...storage.rows.values()][0];
    expect(row.sent_append_pending).toBe(true);        // marker retained for retry
    expect(row.smtp_accepted).toBe(true);

    await queue.processQueue();                        // the next drain / restart
    expect(appendSentFn).toHaveBeenCalledTimes(2);
    expect(sendFn).toHaveBeenCalledTimes(1);           // NEVER re-transmitted
    expect(storage.rows.size).toBe(0);
  });

  it('keeps retrying a deferred append while it keeps failing (marker survives)', async () => {
    appendSentFn.mockRejectedValue('IMAP offline');   // non-Error rejection too

    const queue = makeQueue(true);
    await queue.enqueueAndSend(PAYLOAD);
    await queue.processQueue();
    expect(storage.rows.size).toBe(1);
    expect([...storage.rows.values()][0].sent_append_pending).toBe(true);
    expect(sendFn).toHaveBeenCalledTimes(1);
  });

  it('drops an append marker that has no MIME so it cannot loop forever', async () => {
    const id = await storage.savePendingSend(PAYLOAD);
    const row = storage.rows.get(id)!;
    row.smtp_accepted = true;
    row.sent_append_pending = true;
    row.raw_mime = null;
    row.status = 'append_pending';                     // not due → cannot be re-sent

    const queue = makeQueue(true);
    await queue.processQueue();
    expect(appendSentFn).not.toHaveBeenCalled();
    expect(storage.rows.size).toBe(0);
  });

  it('stops the append drain when the connection drops between rows', async () => {
    for (const _ of [0, 1]) {
      const id = await storage.savePendingSend(PAYLOAD);
      const row = storage.rows.get(id)!;
      row.smtp_accepted = true;
      row.sent_append_pending = true;
      row.raw_mime = RAW;
      row.status = 'append_pending';
    }
    appendSentFn.mockImplementation(async () => { connected = false; });

    await makeQueue(true).processQueue();
    expect(appendSentFn).toHaveBeenCalledTimes(1);
    expect(storage.rows.size).toBe(1);                 // the other marker is kept
  });

  // The crash window: SMTP accepted the message but the Sent copy never went up.
  // A restart must complete the APPEND and must NOT re-transmit the mail.
  it('a restart completes the Sent copy without re-sending the message', async () => {
    appendSentFn.mockRejectedValueOnce(new Error('IMAP offline'));
    const queue = makeQueue(true);
    await queue.enqueueAndSend(PAYLOAD);
    expect([...storage.rows.values()][0].status).toBe('append_pending');

    await queue.loadFromStorage();                     // startup crash-recovery
    expect([...storage.rows.values()][0].status).toBe('append_pending'); // NOT reset to pending
    await queue.processQueue();                        // the drain after restart

    expect(sendFn).toHaveBeenCalledTimes(1);           // never re-sent
    expect(appendSentFn).toHaveBeenCalledTimes(2);     // appended on the retry
    expect(storage.rows.size).toBe(0);
  });

  it('survives a storage failure while loading append-pending rows', async () => {
    const queue = makeQueue(true);
    storage.getAppendPendingSends = vi.fn(async () => { throw new Error('db locked'); }) as any;
    await expect(queue.processQueue()).resolves.toEqual({ sent: 0, queued: 0, failed: 0 });
  });

  it('does not attempt any append when no appendSentFn is wired', async () => {
    const queue = new SendQueue();
    sendFn = vi.fn(async () => ({ success: true, messageId: '<m@x>', rawMessage: RAW, needsSentAppend: true }));
    queue.initialize({ storage: storage as any, sendFn: sendFn as any, isConnected: () => true });
    const result = await queue.enqueueAndSend(PAYLOAD);
    expect(result.status).toBe('success');
    expect(appendSentFn).not.toHaveBeenCalled();
    expect(storage.rows.size).toBe(0);
  });
});

describe('SendQueue.loadFromStorage — crash recovery', () => {
  let storage: ReturnType<typeof makeFakeStorage>;
  let queue: SendQueue;

  beforeEach(() => {
    storage = makeFakeStorage();
    queue = new SendQueue();
    queue.initialize({ storage: storage as any, sendFn: vi.fn() as any, isConnected: () => true });
  });

  // A send stuck in 'executing' is one the app died in the middle of: it must be
  // retried (at-least-once), never left invisible in the outbox forever.
  it('resets sends stranded in executing back to pending, leaving failed ones alone', async () => {
    const stranded = await storage.savePendingSend(PAYLOAD);
    storage.rows.get(stranded)!.status = 'executing';
    const dead = await storage.savePendingSend(PAYLOAD);
    storage.rows.get(dead)!.status = 'failed';

    await queue.loadFromStorage();
    expect(storage.rows.get(stranded)!.status).toBe('pending');
    expect(storage.rows.get(dead)!.status).toBe('failed');
  });

  it('leaves an already-pending send exactly as it is', async () => {
    const pending = await storage.savePendingSend(PAYLOAD);
    await queue.loadFromStorage();
    expect(storage.rows.get(pending)!.status).toBe('pending');
  });

  it('never throws when the outbox table cannot be read', async () => {
    storage.getAllSends = vi.fn(async () => { throw new Error('db corrupt'); }) as any;
    await expect(queue.loadFromStorage()).resolves.toBeUndefined();
  });

  it('is a no-op before initialize', async () => {
    await expect(new SendQueue().loadFromStorage()).resolves.toBeUndefined();
  });
});
