/**
 * Body re-heal — repairs mail bodies that were stored garbled (mojibake) by the
 * OLD fetch path that force-decoded the raw MIME source as UTF-8, destroying any
 * non-UTF-8 body into U+FFFD replacement characters. The decode fix (latin1 →
 * Buffer → mailparser) prevents this for NEW mail, but bytes already lost in the
 * DB can't be recovered locally — the only cure is to RE-FETCH the raw source
 * from the server and re-parse it with the corrected decode.
 *
 * This runs in the MAIN process, in the background, throttled:
 *   1. ONE chunked keyset scan per account finds emails whose stored clean_body
 *      OR raw_body contains U+FFFD (the corruption tell) — either one alone is
 *      enough, since the plain and HTML alternatives are corrupted separately.
 *      Chunked + yielded so the (heavy) body reads never block the UI.
 *   2. Those are drained a few per tick via SyncEngine.fetchBody(), which
 *      re-downloads the source, re-parses, and updates clean_body/raw_body.
 *
 * Healed rows stop matching U+FFFD, so they never re-queue. Skips disconnected
 * accounts (e.g. a Gmail account in quota back-off) so it adds no connection
 * pressure there — and SAYS SO in the log, because a silent skip made a
 * permanently-disconnected account look like a scheduler that had nothing to do.
 *
 * The SAME scan also collects a second, unrelated defect that needs no network:
 * rows whose clean_body is empty although the raw body downloaded fine. Those
 * are HTML-only mails (no text/plain part), which the old parser stored with an
 * empty clean_body — so the list showed no snippet and the AI passes saw no
 * body. They are repaired LOCALLY from raw_body, so they drain even while the
 * account is offline. Rows whose raw body is ALSO empty are a different tier
 * entirely (never downloaded — the body-prefetch's job) and are dropped by a
 * cheap probe rather than spending the repair budget; see drainEmptyBodies.
 */
import { createLogger, createLoopYielder, isDeferredFetchError, repairedCleanBody } from '@sarvinbox/core';
import { areBodyLengthsReady, cleanBodyExpression, rawBodyExpression, rawBodyLengthExpression } from '@sarvinbox/storage-node';

import { getAllAccountRuntimes } from '../shared';

const logger = createLogger('body-reheal');

const FIRST_TICK_MS = 90_000;      // let initial sync + read-model backfill settle first
const TICK_MS = 3 * 60_000;        // then every 3 minutes
const SCAN_CHUNK = 500;            // rows read per scan query (bounded main-thread cost)
const DRAIN_BATCH = 5;             // corrupted bodies re-fetched per account per tick
const LOCAL_DRAIN_BATCH = 25;      // empty-clean_body rows REPAIRED per account per tick (no network)
const LOCAL_PROBE_BUDGET = 2000;   // rows inspected per tick to find those 25 (see drainEmptyBodies)

const REPLACEMENT_CODEPOINT = 65533; // U+FFFD

let firstTimeout: ReturnType<typeof setTimeout> | null = null;
let tickInterval: ReturnType<typeof setInterval> | null = null;
let running = false;

interface CorruptRow { id: string; uid: number; folderId: string; threadId: string | null }

// Per-account scan/drain state (module-scoped — one runtime per process).
const scanned = new Set<string>();                       // accounts whose scan is complete
const queues = new Map<string, CorruptRow[]>();          // corrupted rows awaiting re-fetch
const emptyQueues = new Map<string, string[]>();         // emailIds with an empty clean_body (local repair)
const attempted = new Set<string>();                     // emailIds tried this session (no repeats)

/** One-time chunked scan: page every email by its TEXT PK (keyset, index-ordered)
 *  and collect two defects in the SAME pass — clean_body carrying a replacement
 *  char (needs a re-fetch) and clean_body empty while the raw body is present
 *  (repairable locally). Yields between chunks so the large body reads
 *  interleave with the UI.
 *
 *  Deliberately selects only DERIVED values (`instr`, `LENGTH`) and never the
 *  bodies themselves: returning clean_body/raw_body here would ship gigabytes
 *  into JS. `cleanLen` carries no raw_body test — that read is deferred to the
 *  ~200 candidates the local drain actually touches.
 *
 *  `bad` tests BOTH bodies, because they can be corrupted independently.
 *  clean_body is mailparser's `text` (the text/plain alternative) while raw_body
 *  is its `html`, and a sender whose plain part is pure ASCII while the HTML
 *  carries 8-bit characters loses only the HTML to the old decode. Testing
 *  clean_body alone left exactly that mail unqueued forever: a correct list
 *  snippet over a body that renders as replacement characters when opened, which
 *  is the shape this defect was reported in. The second `instr` costs one more
 *  body read per row on a scan that already reads one, and runs once per session.
 *
 *  Both derived values read the body through `email_bodies` (migration 73). This
 *  is the module that MUST NOT be handed the emptied inline columns: on the
 *  inline form every relocated row would come back with `bad = 0` and
 *  `cleanLen = 0`, so the whole mailbox would be queued as an empty-clean-body
 *  repair, every repair would then find nothing to rebuild, and the real
 *  mojibake rows would never be found again. */
async function scanAccount(accountId: string, storage: any): Promise<void> {
  const q: CorruptRow[] = [];
  const emptyIds: string[] = [];
  let cursor = '';
  const stmt = storage.db.prepare(
    `SELECT id, uid, folder_id AS folderId, thread_id AS threadId,
            (instr(${cleanBodyExpression('emails')}, char(${REPLACEMENT_CODEPOINT})) > 0
             OR instr(${rawBodyExpression('emails')}, char(${REPLACEMENT_CODEPOINT})) > 0) AS bad,
            LENGTH(COALESCE(${cleanBodyExpression('emails')}, '')) AS cleanLen
       FROM emails
      WHERE id > ?
      ORDER BY id
      LIMIT ${SCAN_CHUNK}`,
  );
  for (;;) {
    const rows = stmt.all(cursor) as Array<CorruptRow & { uid: number | null; bad: number; cleanLen: number }>;
    if (rows.length === 0) break;
    for (const r of rows) {
      // uid 0 is deliberate, not a skip: a row can carry NO uid (Gmail blanks it
      // when a label change re-homes the message), and fetchBody re-resolves
      // those by message-id and repairs the uid on the way past. Filtering them
      // out here — which this scan used to do — stranded a corrupted body on the
      // one class of row that is ALSO the hardest to notice, since it never
      // re-syncs on its own either.
      if (r.bad > 0 && !attempted.has(r.id)) q.push({ id: r.id, uid: r.uid ?? 0, folderId: r.folderId, threadId: r.threadId });
      else if (r.cleanLen === 0) emptyIds.push(r.id);
    }
    cursor = rows[rows.length - 1].id;
    await new Promise((resolve) => setImmediate(resolve));
  }
  queues.set(accountId, q);
  emptyQueues.set(accountId, emptyIds);
  scanned.add(accountId);
  if (q.length > 0) logger.info(`Body re-heal: queued ${q.length} corrupted bodies for ${accountId}`);
  if (emptyIds.length > 0) logger.info(`Body re-heal: queued ${emptyIds.length} empty clean bodies for local repair for ${accountId}`);
}

/**
 * Rebuild clean_body from the already-downloaded raw body. LOCAL — no IMAP, so
 * this drains even for an account that is offline or in quota back-off, which is
 * the whole point: the body is already on disk, only the text extraction was
 * missing.
 *
 * TWO different rows have an empty clean_body and they are NOT the same defect,
 * so this drains in two stages. Measured on a production-sized mailbox: of 7,915 rows with
 * an empty clean_body, 7,705 have an empty RAW body too — their body was simply
 * never downloaded, which is the body-prefetch's job, not this one — and only 210
 * are the HTML-only mails this repairs. The cheap `LENGTH(raw_body)` probe below
 * separates them, so the expensive budget (a fat read plus a whole-record rewrite)
 * is spent only on rows that can actually be repaired. Without the probe every one
 * of those 7,705 rows costs a full record read before being discarded — and a
 * discard does not count against the repair budget, so a single tick would have
 * chewed through all of them on the main thread, then marked them attempted and
 * never looked again once their bodies finally arrived. Hence a probe budget too:
 * both the cheap and the expensive stage are bounded per tick.
 *
 * The probe budget is sized from a measurement, not a guess: 400 probes against
 * the real 26k-row mailbox took 2ms (~5us each — an empty raw body has no overflow
 * pages to page in). At 400/tick a 7.7k backlog would have taken ~19 ticks, an
 * hour, to reach the repairable rows scattered through it; at 2,000 it is ~4 ticks
 * for ~10ms of yielded main-thread work each.
 *
 * A row whose raw body yields no readable text (image-only mail) is dropped
 * without a write — re-queueing it every session would rewrite a fat record
 * forever for no gain. Every row that gets READ is marked `attempted` so the next
 * tick moves on rather than re-reading it; a not-downloaded row deliberately is
 * NOT, because it becomes repairable the moment its body arrives.
 */
async function drainEmptyBodies(
  storage: any,
  queue: string[],
): Promise<{ repaired: number; skipped: number; notDownloaded: number }> {
  if (queue.length === 0) return { repaired: 0, skipped: 0, notDownloaded: 0 };
  // Reads only the LENGTH, and only for rows already known to have no clean body:
  // such a record carries no inline body to page in, so the probe stays cheap.
  // Once the v72 backfill has stamped the length columns the probe reads
  // `raw_body_len` and touches no body at all — the reason those columns exist.
  // Before that it falls back to measuring the body through `email_bodies`,
  // wrapped in a COALESCE so a legacy NULL raw body still reports 0 rather than
  // NULL and keeps counting as "never downloaded" exactly as it did before.
  const probe = storage.db.prepare(
    `SELECT COALESCE(${rawBodyLengthExpression('emails', areBodyLengthsReady(storage.db))}, 0) AS rawLen
       FROM emails WHERE id = ?`,
  );
  const read = storage.db.prepare(
    `SELECT ${cleanBodyExpression('emails')} AS cleanBody, ${rawBodyExpression('emails')} AS rawBody
       FROM emails WHERE id = ?`,
  );
  // Time-budgeted rather than one yield per row: a probe is cheap and a repair is
  // not, so a fixed row count is the wrong unit (see createLoopYielder).
  const breathe = createLoopYielder();
  let repaired = 0;
  let skipped = 0;
  let notDownloaded = 0;
  let probed = 0;
  while (queue.length > 0 && repaired < LOCAL_DRAIN_BATCH && probed < LOCAL_PROBE_BUDGET) {
    const id = queue.shift() as string;
    if (attempted.has(id)) continue;
    probed += 1;
    await breathe();
    try {
      const rawLen = (probe.get(id) as { rawLen: number } | undefined)?.rawLen ?? 0;
      if (rawLen === 0) {
        // Body not downloaded yet — leave it to the body-prefetch and do NOT mark
        // it attempted: once its body lands, a later session must repair it.
        notDownloaded += 1;
        continue;
      }
      attempted.add(id);
      const row = read.get(id) as { cleanBody: string | null; rawBody: string | null } | undefined;
      const cleanBody = repairedCleanBody(row?.cleanBody, row?.rawBody);
      if (cleanBody === null) {
        skipped += 1;
      } else {
        await storage.updateEmail(id, { cleanBody });
        repaired += 1;
        logger.trace(`Body re-heal: rebuilt clean body for ${id} (${cleanBody.length} chars)`);
      }
    } catch (error) {
      attempted.add(id); // a row that throws must not be re-probed every tick
      skipped += 1;
      logger.trace(`Body re-heal: local repair failed for ${id}: ${(error as Error).message}`);
    }
  }
  return { repaired, skipped, notDownloaded };
}

/**
 * Re-fetch a bounded batch of corrupted bodies for one account. Returns what the
 * batch did so the caller can log ONE aggregated line per tick instead of a line
 * per email (the per-item detail lives at trace).
 */
async function drainAccount(
  storage: any,
  engine: any,
  queue: CorruptRow[],
): Promise<{ repaired: number; failed: number; skippedOffline: number }> {
  if (queue.length === 0) return { repaired: 0, failed: 0, skippedOffline: 0 };
  // Skip disconnected / quota-backed-off accounts — but REPORT it. This used to
  // return silently, so a queue that never drained (an account offline for
  // hours) produced no log line at all and looked like "nothing to do".
  if (!engine.isConnected?.()) return { repaired: 0, failed: 0, skippedOffline: queue.length };
  const batch = queue.splice(0, DRAIN_BATCH);
  let repaired = 0;
  let failed = 0;
  for (const item of batch) {
    if (attempted.has(item.id)) continue;
    attempted.add(item.id);
    try {
      const folder = await storage.getFolder(item.folderId);
      if (!folder?.path) continue;
      // Re-downloads the raw source, re-parses (now with the corrected decode),
      // and updates clean_body/raw_body. Has its own retry cap internally.
      await engine.fetchBody(item.id, folder.path, item.uid);
      // Bust the thread's AI conversation extraction — it's keyed by email ID, so
      // without this the chat view keeps serving the OLD garbled bubble even though
      // the body underneath is now repaired. Best-effort; the renderer also
      // self-heals a stale cache on open.
      if (item.threadId) {
        try { await storage.deleteConversation(item.threadId); } catch { /* best-effort */ }
      }
      // TRACE: one line per repaired email, and a re-heal pass walks a whole
      // backlog. `tick` logs the aggregated per-account count at debug instead.
      repaired += 1;
      logger.trace(`Body re-heal: re-decoded ${item.id}`);
    } catch (error) {
      // "Ask me again later" (folder wouldn't open, cooling down after timeouts)
      // is not a failed repair — and `attempted` is session-scoped, so leaving
      // the id in it would abandon a still-corrupted body until the next app
      // start. Un-mark it and put it back on the queue.
      if (isDeferredFetchError(error)) {
        attempted.delete(item.id);
        queue.push(item);
        logger.trace(`Body re-heal: deferred for ${item.id}: ${(error as Error).message}`);
        continue;
      }
      failed += 1;
      logger.trace(`Body re-heal: re-fetch failed for ${item.id}: ${(error as Error).message}`);
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
  return { repaired, failed, skippedOffline: 0 };
}

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    for (const [accountId, rt] of getAllAccountRuntimes()) {
      const storage = rt.storage as any;
      const engine = rt.syncEngine as any;
      if (!storage?.db || !engine) continue;
      try {
        if (!scanned.has(accountId)) await scanAccount(accountId, storage);
        const { repaired, failed, skippedOffline } = await drainAccount(storage, engine, queues.get(accountId) ?? []);
        // Runs regardless of connection state — the raw body is already local.
        const local = await drainEmptyBodies(storage, emptyQueues.get(accountId) ?? []);
        // One line per account per tick — silent only when there was nothing at
        // all to do. An offline skip and a no-op local batch both report, so a
        // stuck queue can never be mistaken for an empty one.
        if (repaired || failed || skippedOffline || local.repaired || local.skipped || local.notDownloaded) {
          const remaining = queues.get(accountId)?.length ?? 0;
          const localRemaining = emptyQueues.get(accountId)?.length ?? 0;
          // INFO, not debug: the process runs at 'info' by default, so at debug
          // this line — the only evidence a backlog is draining rather than
          // stuck — never reached app.log. One line per account per 3 minutes,
          // and only when there was work, so it costs nothing and goes quiet.
          logger.info(
            `Body re-heal ${accountId}: repaired ${repaired}, failed ${failed}, ${remaining} queued` +
            (skippedOffline ? ` (SKIPPED — account offline, ${skippedOffline} waiting)` : '') +
            ` | local rebuild ${local.repaired} repaired, ${local.skipped} unrepairable, ` +
            `${local.notDownloaded} body not downloaded yet, ${localRemaining} queued`,
          );
        }
      } catch (error) {
        // Isolate one account's failure so the loop still covers the rest — at
        // WARN, because at debug a permanently-failing account looked identical
        // to one with nothing to do.
        logger.warn(`Body re-heal: account ${accountId} tick failed: ${(error as Error).message}`);
      }
    }
  } catch (error) {
    logger.warn('Body re-heal tick failed:', (error as Error).message);
  } finally {
    running = false;
  }
}

export function startBodyRehealScheduler(): void {
  if (firstTimeout || tickInterval) return;
  firstTimeout = setTimeout(() => {
    void tick();
    tickInterval = setInterval(() => void tick(), TICK_MS);
    tickInterval.unref?.();
  }, FIRST_TICK_MS);
  firstTimeout.unref?.();
}

export function stopBodyRehealScheduler(): void {
  if (firstTimeout) { clearTimeout(firstTimeout); firstTimeout = null; }
  if (tickInterval) { clearInterval(tickInterval); tickInterval = null; }
  running = false;
}
