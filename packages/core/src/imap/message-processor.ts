// Message Processor - Memory-efficient email processing

import libmime from 'libmime';
import { simpleParser, type ParsedMail } from 'mailparser';

import { classifyFolder, findFolderByType, type ClassifiableFolder } from '../config/folder-mapping';
import { LARGE_MAILBOX_THRESHOLD, STALE_FLAG_VERIFY_MAX, SYNC_RECENT_WINDOW_DAYS, recentWindowCutoffDate } from '../config/sync';
import { getEventBus, createEvent } from '../pipeline/event-bus';
import { parseAuthenticationHeaders } from '../processor/email-processor';
import type { FilterRule } from '../types/filters';
import type { IMAPMessage, IIMAPClient } from '../types/imap';
import type { EmailRecord, FolderRecord } from '../types/models';
import type { IEmailStorage } from '../types/storage';
import { headerLookupFromText, headerValuesFromText } from '../utils/bulk-mail';
import { sanitizeIcsText } from '../utils/calendar';
import { hasCidRefs, resolveCidImages, type CidImagePart } from '../utils/cid-images';
import { createDeferredFetchError } from '../utils/deferred-fetch-error';
import { collectFilterActions, computeFilterActionResult } from '../utils/filters';
import { refreshCountsForFolders } from '../utils/folder-counts';
import { mapGmailLabels, type GmailFolderRole, type KnownCategory } from '../utils/gmail-labels';
import { htmlToPlainText } from '../utils/html-text';
import { emailContentHash, generateId, generateThreadId, synthesizedMessageId } from '../utils/id';
import { logger } from '../utils/logger';
import { SIMPLE_PARSER_OPTIONS } from '../utils/mail-parse';
import { extractOriginIp } from '../utils/origin-ip';
import {
  isStarredSourceFolder,
} from '../utils/provider';
import { assessSpamSignals } from '../utils/spam-signals';
import { isSpamScore } from '../utils/spam-verdict';
import { selectStaleFlagCandidates } from '../utils/stale-flags';
import { buildTags, parseTags, hasTag, addTag, imapFlagsToTags, FLAG_TAG_NAMES } from '../utils/tags';
import { normalizeSubject } from '../utils/validators';

import {
  countReplacementChars,
  hasReplacementChar,
  preservesDecodedText,
  transcodeDetectedCharset,
} from './charset-repair';
import { mapEnvelopeFields } from './envelope-mapper';
import { attachmentSizesFromSource } from './raw-mime-part';
import { withFolderSelected } from './with-folder';

/** A Date as unix seconds, or null when absent or unparseable (an invalid Date has a NaN time). */
function toUnixSeconds(d: Date | null | undefined): number | null {
  const t = d?.getTime?.();
  return typeof t === 'number' && Number.isFinite(t) ? Math.floor(t / 1000) : null;
}

// Deletion-detection throttle for the CONDSTORE delta path. Flag deltas
// (fetchFlagsChangedSince) run every sync — cheap. But the full server UID set
// for deletion detection needs a `SEARCH ALL` (fetchAllUIDs) which we don't want
// to fire on EVERY sync. Reconcile deletions periodically instead; the interval
// is the worst-case latency for an expunge to reflect on the CONDSTORE path.
// (The full/non-CONDSTORE path already fetches all UIDs every sync via its
// `1:* FLAGS` flag reconciliation, so this throttle doesn't apply there.)
const DELETION_RECONCILE_INTERVAL_MS = 5 * 60_000;
// Keyed by folder RECORD id, not path. Every account has a folder literally
// called "INBOX", so a path-keyed module-global let one account's reconcile
// suppress the others' — with three accounts, two of them silently went up to
// 3x the intended interval without reconciling. Folder ids are per-account.
const lastDeletionReconcile = new Map<string, number>(); // folder.id -> ms
// Re-reading EVERY flag is far more expensive than the UID diff above (SEARCH
// ALL + ceil(n/500) FETCHes + a full local pass), so it gets its own throttle
// rather than riding on `forceDeletion`, which every sync sets. This bounds the
// worst-case flag latency; it does not affect deletion.
const FLAG_RECONCILE_INTERVAL_MS = 5 * 60_000;
const lastFlagReconcile = new Map<string, number>(); // folder.id -> ms
// The stale-flag sweep (old locally-unread/starred rows on a WINDOWED mailbox)
// gets its own throttle rather than riding on the two above. The non-CONDSTORE
// windowed path re-reads its window on EVERY sync, so hanging the sweep off that
// would issue an extra FLAGS batch per folder per sync on exactly the accounts
// whose connection budget is tightest. Same interval, independent clock.
const STALE_FLAG_SWEEP_INTERVAL_MS = 5 * 60_000;
const lastStaleFlagSweep = new Map<string, number>(); // folder.id -> ms

// Per-sync total for the ADDITION reconcile (max UIDs fetched per sync); a bigger gap
// drains over successive syncs. Any shortfall — a failed insert, a windowed/count-capped
// initial sync, or a large mid-range gap the downward-only backfill can't fill — drains
// here. Fetched in ADDITION_FETCH_BATCH sub-batches so no single FETCH times out.
const ADDITION_RECONCILE_MAX = 200;
// Sub-batch size for the reconcile's UID FETCHes. One giant FETCH times out on a slow
// server — a 500-UID FETCH hit the 60s op timeout and inserted NOTHING (all-or-nothing),
// stalling the drain. Small sub-batches keep each FETCH well under the timeout (~250ms/
// header here → ~25s for 100) and let partial progress stick even if a later one fails.
const ADDITION_FETCH_BATCH = 100;

/**
 * Is this fetched message really the one we asked for?
 *
 * A UID is only meaningful relative to the mailbox it was read in, and every
 * by-UID fetch here is two awaits — select, then fetch. On the shared primary
 * connection any other operation (a folder sync, a search, a flag store) can
 * SELECT a different mailbox in between, at which point "UID 56" resolves to
 * whatever message holds that UID over there. The fetch SUCCEEDS, so nothing
 * looks wrong, and an unrelated message's content gets stored against this
 * email — which is how a marketing newsletter ended up rendering inside an
 * unrelated work thread.
 *
 * UIDVALIDITY changes and server-side renumbering produce the same class of
 * mismatch, so this checks the invariant itself instead of enumerating causes:
 * the message that came back must carry the message-id we already stored.
 *
 * Returns true when either side has no message-id — some servers omit it, and
 * refusing every such body would be worse than the risk. Callers treat false as
 * "discard and let the retry heal it", never as a hard failure.
 */
export function isExpectedMessage(
  message: Pick<IMAPMessage, 'envelope'>,
  expectedMessageId: string | null | undefined,
): boolean {
  const fetched = message.envelope?.messageId || '';
  const expected = expectedMessageId || '';
  if (!fetched || !expected) return true;
  return fetched === expected;
}

/**
 * Message processor configuration
 */
/**
 * Per-batch context for turning Gmail labels into local tags: this account's
 * path for each system role, plus its category definitions so a `Sarv Inbox/*`
 * mirror label resolves to the right slug. Built once per batch.
 */
interface GmailLabelContext {
  roleToPath: Map<GmailFolderRole, string>;
  knownCategories?: KnownCategory[];
}

export interface MessageProcessorConfig {
  batchSize: number;           // Messages per batch (default: 10)
  maxBatchMemoryMB: number;    // Max memory per batch (default: 50MB)
  headersOnly: boolean;        // Only fetch headers initially
  processAttachments: boolean; // Process attachments info
}

const DEFAULT_CONFIG: MessageProcessorConfig = {
  batchSize: 10,
  maxBatchMemoryMB: 50,
  headersOnly: true,
  processAttachments: true,
};

/**
 * Processing result
 */
export interface ProcessResult {
  inserted: number;
  updated: number;
  skipped: number;
  errors: number;
  maxUid: number;
  /**
   * IDs of the freshly-inserted emails (subset of `inserted`).
   * Realtime sync needs this so it can emit one `new-email` event per
   * row — otherwise the renderer only sees a count and can't merge
   * the new rows into the list without a full reload.
   */
  insertedIds: string[];
  /**
   * Folder paths that a relinked (moved-BACK) message still carried tags for —
   * i.e. the SOURCE folder(s) of an external move into this folder. On an IMAP
   * move the source expunged the message, so those memberships are now stale.
   * The realtime path reconciles these folders promptly (they aren't the
   * live-monitored folder, so their removal would otherwise wait for a periodic
   * cycle) — see RealtimeManager.handleNewMessages.
   */
  relinkedFromFolders: string[];
  /**
   * UIDs the server RETURNED but that hit a TRANSIENT per-message error (e.g. a
   * convert/insert hiccup) and were NOT stored. Callers that track "already tried"
   * UIDs (the addition-reconcile / drain convergence sets) must EXCLUDE these so a
   * transient failure isn't mistaken for "downloaded" and suppressed for the whole
   * session — the message must be retried. A permanently-unprocessable message
   * (e.g. no ENVELOPE) is NOT listed here: it can't be stored on any retry, so it
   * IS marked tried (give up) to avoid re-fetching it forever.
   */
  erroredUids: number[];
}

/**
 * Message Processor
 *
 * Handles:
 * - Converting IMAP messages to EmailRecords
 * - Memory-efficient batch processing
 * - Deduplication
 * - Threading detection
 * - Body parsing (lazy loading support)
 */
export class MessageProcessor {
  private config: MessageProcessorConfig;
  // Supplies UIDs (per folder) that have a pending local flag op not yet sent to
  // the server. syncFlags skips these so a server-wins reconciliation can't
  // revert a just-made local change (e.g. read springing back to unread).
  private pendingUidsProvider?: (folderPath: string) => Promise<Set<number>>;

  // Per-folder set of server UIDs the ADDITION reconcile has already fetched this
  // session and found to be non-progressing — a message that lives PRIMARILY in
  // another folder (e.g. a Gmail INBOX message whose primary is [Gmail]/All Mail)
  // carries this folder's tag but has no uid in this folder's folder_id space, so
  // it resurfaces in `missingFromLocal` on EVERY sync. Without remembering them the
  // reconcile re-fetched the SAME newest 200 forever (all no-ops), and the
  // genuinely-missing older UIDs never got a turn — the folder plateaued short of
  // the server ("stuck at ~8.6k, never finishes downloading"). Excluding them lets
  // the reconcile DRAIN through every candidate once, so real gaps actually fill.
  // Session-only + size-capped: it's a pure convergence optimisation, safe to lose
  // (a restart just re-verifies), never a source of truth.
  private reconcileTriedUids = new Map<string, Set<number>>();

  // Per-folder ids the stale-membership sweep (Phase 2b) has already verified as
  // PRESENT on the server this session. A legitimately cross-folder message (a
  // reply in both Inbox and Sent, a Gmail label mirror) is a permanent member of
  // the tag-only set, so without this it would cost a HEADER search on every
  // sync. Session-scoped and size-capped like reconcileTriedUids.
  private staleSweepVerified = new Map<string, Set<string>>();
  /** Upper bound on HEADER searches one sweep may issue — one round-trip each. */
  private static readonly STALE_SWEEP_MAX_SEARCHES = 100;
  private static readonly RECONCILE_TRIED_CAP = 50000;

  // Per-folder set of OLD local UIDs the stale-flag sweep has already re-read this
  // session. Drives a newest-first rotation through the locally-unread/starred
  // backlog: without it a user with more than STALE_FLAG_VERIFY_MAX genuinely
  // unread old messages would have the same newest batch re-verified on every
  // sweep forever while the rest never got a turn. Cleared and restarted once
  // every candidate has had its turn (see `wrapped`), so a flag flipped in webmail
  // after we checked a message is still picked up on the next lap. Session-only
  // and size-capped, exactly like reconcileTriedUids — a pure scheduling aid, never
  // a source of truth, safe to lose on restart.
  private staleFlagCheckedUids = new Map<string, Set<number>>();

  // Folder ids whose LAST full read returned zero server UIDs while we still held
  // local mail. A single EXISTS-0 read is not trusted to wipe a folder (a flaky /
  // proxied server can transiently report a non-empty mailbox as empty, and
  // serverListComplete is satisfied by 0>=0, so the completeness gate alone can't
  // catch it). We require TWO consecutive empty reads before applying a
  // whole-folder deletion — a genuine remote-empty stays empty across reads; a
  // blip does not. Session-only; cleared on any non-empty read.
  private foldersSeenEmpty = new Set<string>();

  // Queues the SERVER-side move for a message the spam filter files. Wired by
  // SyncEngine to its OperationQueue — the persisted, replayed-on-reconnect
  // path "Report spam" already uses. Without it the re-file is local only, and
  // the next reconcile of the source folder finds the server's copy still
  // there, reads it as an external move-back, and relinks it: the spam
  // reappears in INBOX within minutes. The queued op is also what registers
  // the UID as pending, which is the guard that reconcile honours.
  private spamMover?: (folderPath: string, uid: number) => Promise<unknown>;

  /** Wire the pending-op source (see SyncEngine). */
  setPendingUidsProvider(fn: (folderPath: string) => Promise<Set<number>>): void {
    this.pendingUidsProvider = fn;
  }

  /** Wire the server-side spam move (see SyncEngine). */
  setSpamMover(fn: (folderPath: string, uid: number) => Promise<unknown>): void {
    this.spamMover = fn;
  }

  constructor(config: Partial<MessageProcessorConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Process a batch of messages
   */
  async processBatch(
    messages: IMAPMessage[],
    folder: FolderRecord,
    storage: IEmailStorage,
    onProgress?: (processed: number, total: number) => void,
    // `quiet` = historical backfill: insert the header rows for search/visibility
    // but SKIP all reactive processing meant for live mail — auto-spam moves,
    // filter-rule application, and the `email:synced` pipeline emit. Without this,
    // paging in a lakh of old mails would fire a lakh of AI categorisations and
    // wake the body-prefetch backlog for the entire archive.
    opts?: { quiet?: boolean }
  ): Promise<ProcessResult> {
    const quiet = opts?.quiet === true;
    const result: ProcessResult = {
      inserted: 0,
      updated: 0,
      skipped: 0,
      errors: 0,
      maxUid: 0,
      insertedIds: [],
      relinkedFromFolders: [],
      erroredUids: [],
    };

    if (messages.length === 0) {
      return result;
    }

    const folderPath = folder.path;
    // Gmail label context, resolved ONCE per batch (a folder list + category read
    // per message would be thousands of queries during a backfill). Skipped
    // entirely unless this batch actually carries labels, so non-Gmail accounts
    // pay nothing.
    const labelCtx = messages.some((m) => m.labels?.length)
      ? await this.buildGmailLabelContext(storage)
      : undefined;
    // Source folders of any move-BACK relinked in this batch (deduped). The
    // message arrived here but still carries its old folder's tag; that folder
    // needs a reconcile to drop the now-stale membership.
    const relinkedFrom = new Set<string>();
    const isSentFolder = this.isSentFolder(folderPath);
    const isStarredFolder = isStarredSourceFolder(folderPath);
    // The user's own outgoing mail is never spam-scored: a draft has no
    // Message-ID yet, a sent copy carries no authentication verdict, and a
    // `spam` tag on your own words would hide them from the Spam filter view.
    const folderType = classifyFolder(folder);
    const ownMail = isSentFolder || folderType === 'sent' || folderType === 'drafts';

    // UIDs in THIS folder with a pending/executing local op (move/delete/flag) not
    // yet confirmed by the server. Used to tell a genuine external move-BACK into
    // this folder (relink) apart from a stale sync racing a local move-AWAY (skip)
    // — see the `movedAway` guard below. Same source syncFlags uses to avoid
    // reverting local changes.
    const pendingUids = (await this.pendingUidsProvider?.(folderPath)) ?? new Set<number>();

    // Dedup within this in-flight batch — the storage existence check
    // below can't see rows that haven't been inserted yet, so two
    // same-messageId mails in one batch would both pass it.
    const seenMessageIds = new Set<string>();

    // Process in smaller sub-batches for memory efficiency
    for (let i = 0; i < messages.length; i += this.config.batchSize) {
      const batch = messages.slice(i, i + this.config.batchSize);
      const emailRecords: EmailRecord[] = [];

      // A message with NO envelope at all can't be keyed on identity, so it is
      // unprocessable. Drop it here rather than in the loop below: this pre-pass
      // runs outside the per-message try/catch, so one such message used to throw
      // and lose every remaining message in the sub-batch. maxUid still advances
      // past it, or the sync re-fetches the same broken message forever.
      const usable = batch.filter((message) => {
        if (message.envelope) return true;
        logger.error(`Skipping message UID ${message.uid} in ${folderPath}: no ENVELOPE`);
        result.maxUid = Math.max(result.maxUid, message.uid);
        result.errors++;
        return false;
      });

      // Ensure every message has a (possibly synthesized) Message-ID first, then
      // look up all existing rows for the sub-batch in ONE query instead of a
      // SELECT per message (previously an N+1 on every sync).
      for (const message of usable) {
        if (!message.envelope.messageId) {
          // Messages without a Message-ID header default to '' — they would all
          // dedup against the first such row. Synthesize a deterministic id so
          // each one stays unique.
          //
          // Keyed on the MESSAGE, never on where we found it. This used to hash
          // `folderPath|uid|...`, which meant the same headerless message seen
          // in a second folder — every Gmail message is in All Mail as well as
          // its label — was minted a different id and stored a SECOND time, and
          // a UIDVALIDITY reset re-ingested the lot as new mail.
          //
          // Remember that it WAS synthesised: the spam signals score a missing
          // Message-ID, and the stand-in must not pass for the real header.
          message.messageIdSynthesized = true;
          message.envelope.messageId = synthesizedMessageId({
            fromAddress: message.envelope.from?.[0]?.address,
            internalDate: message.date,
            subject: message.envelope.subject,
            toAddress: message.envelope.to?.map((addr) => addr.address).join(','),
            size: message.size,
          });
        }
      }
      const existingByMessageId = new Map(
        (await storage.getEmailsByMessageIds(usable.map((m) => m.envelope.messageId)))
          .map((e) => [e.messageId, e]),
      );

      for (const message of usable) {
        try {
          result.maxUid = Math.max(result.maxUid, message.uid);

          if (seenMessageIds.has(message.envelope.messageId)) {
            result.skipped++;
            continue;
          }
          seenMessageIds.add(message.envelope.messageId);

          // Check for existing message (from the batched lookup above)
          const existing = existingByMessageId.get(message.envelope.messageId) || null;

          if (existing) {
            // The row currently lives in a DIFFERENT folder and lost this folder's
            // tag — it was moved away from here. That happens two ways, and they
            // need OPPOSITE handling:
            //   1. Restore race: the user just moved it away in-app (a pending op
            //      on THIS uid is in flight). A stale sync must NOT relink it back
            //      or the move springs back — skip.
            //   2. External move-BACK: another client moved it into this folder
            //      again (no pending op — the server is authoritative). We MUST
            //      relink, or the message vanishes: its old folder's expunge then
            //      deletes the row and nothing points here. This was the
            //      Trash→Inbox "disappears everywhere" bug.
            // A pending op on this exact uid is the discriminator.
            const movedAway = existing.folderId !== folder.id && !hasTag(existing.tags || '||', folderPath);
            const isRestoreRace = movedAway && pendingUids.has(message.uid);
            if (!isRestoreRace) {
              await storage.linkEmailToFolder(existing.id, folder.id, message.uid, message.flags);
              // External move-BACK: the row still carries its previous folder
              // tag(s), which the source expunged on the move. Note those source
              // folders so the caller can reconcile them promptly — a reconcile
              // (not a blind drop) is model-safe: it only removes memberships the
              // server confirms are gone, so a Gmail label that still applies stays.
              if (movedAway) {
                for (const tok of parseTags(existing.tags || '')) {
                  if (tok && tok !== folderPath && !(FLAG_TAG_NAMES as readonly string[]).includes(tok)) {
                    relinkedFrom.add(tok);
                  }
                }
              }
            }

            // Update starred if in special folder
            if (isStarredFolder || message.flags.includes('\\Flagged')) {
              if (!hasTag(existing.tags || '||', 'starred')) {
                await storage.updateEmail(existing.id, { tags: addTag(existing.tags || '||', 'starred') });
                result.updated++;
              } else {
                result.skipped++;
              }
            } else if (movedAway && !isRestoreRace) {
              // We just ADDED this folder's tag to a row that lived elsewhere — real
              // progress, not a no-op. Count it as updated so the reconcile log
              // reflects actual convergence instead of reporting every relink as
              // "skipped" (which made a working reconcile look stuck).
              result.updated++;
            } else {
              result.skipped++;
            }
            continue;
          }

          // Has the user reported this sender? Looked up BEFORE conversion so
          // the verdict lands in the stored spam score with its own reason,
          // instead of a separate re-file the score knew nothing about. Skipped
          // in quiet/backfill mode with the rest of the reactive work; a
          // failing lookup is "unknown", never a failed message.
          let knownSpammer = false;
          const fromAddress = message.envelope.from?.[0]?.address;
          if (!quiet && fromAddress) {
            try {
              knownSpammer = await storage.isSpammer(fromAddress);
            } catch (err) {
              logger.error(`[AutoSpam] Check failed for ${fromAddress}:`, err);
            }
          }

          // Convert to EmailRecord
          const email = await this.convertMessage(message, folder.id, folderPath, labelCtx, { knownSpammer, ownMail });

          // Apply folder-specific settings
          if (isSentFolder && !hasTag(email.tags, 'read')) {
            email.tags = addTag(email.tags, 'read');
          }
          if (isStarredFolder || message.flags.includes('\\Flagged')) {
            email.tags = addTag(email.tags, 'starred');
          }

          emailRecords.push(email);
        } catch (error) {
          logger.error(`Error processing message UID ${message.uid}:`, error);
          result.errors++;
          // Transient per-message failure — record so callers don't mark it
          // "tried" and suppress a message that was never actually stored.
          result.erroredUids.push(message.uid);
        }
      }

      // Insert batch
      if (emailRecords.length > 0) {
        await storage.insertEmailBatch(emailRecords);

        // No per-email linkEmailToFolder here: insertEmailBatch already
        // inserted rows whose tags carry the folder path (added in
        // convertMessage), so linkEmail would recompute identical tags and
        // never update — a redundant SELECT+addTag per email.

        // Folder list, loaded once per batch and only if something needs it —
        // the spam re-file below and the user's filter rules both do.
        let allFolders: FolderRecord[] | null = null;
        const getAllFolders = async (): Promise<FolderRecord[]> => {
          if (allFolders === null) allFolders = await storage.getFolders();
          return allFolders;
        };

        // Spam: a message whose stored score crossed the line — header signals,
        // an upstream filter's verdict, or a sender the user reported — is
        // filed into the spam folder locally (no server-side IMAP move at
        // ingest, same as the filter rules below). The move goes through the
        // filter engine's own `moveToSpam`, so the two paths cannot disagree
        // about which folder is spam or how a move rewrites the tags. The row
        // keeps its `spam` tag either way: with no spam folder at all it still
        // stays out of the AI pipeline and says why on the shield. Skipped in
        // quiet/backfill mode with the rest of the reactive work.
        if (!quiet) {
          let filed = 0;
          for (const email of emailRecords) {
            if (!isSpamScore(email.spamScore)) continue;
            try {
              const folders = await getAllFolders();
              const moved = computeFilterActionResult(email, [{ type: 'moveToSpam' }], folders);
              if (!moved.changed) continue;
              await storage.updateEmail(email.id, { folderId: moved.folderId, tags: moved.tags });
              // Mirror the move on the server through the operation queue —
              // persisted, replayed on reconnect, and registered as a pending
              // op on this UID so the next reconcile of this folder does not
              // read the server's still-present copy as an external move-back
              // and relink it here. Fire-and-forget, exactly as "Report spam"
              // does; a failure is logged, never a failed sync. The uid is
              // read BEFORE the in-memory update below, while it still names
              // the message in the folder the server has it in.
              if (this.spamMover && email.uid > 0) {
                const { uid } = email;
                this.spamMover(folder.path, uid).catch((err: unknown) => {
                  logger.warn(`[AutoSpam] Server-side move failed for uid ${uid} in ${folder.path}: ${(err as Error)?.message ?? err}`);
                });
              }
              // Keep the in-memory record current: the filter rules and the
              // email:synced event below read it, and must see the re-file.
              email.folderId = moved.folderId;
              email.tags = moved.tags;
              filed += 1;
            } catch (err) {
              // Non-fatal — a failed re-file must not break the sync.
              logger.error(`[AutoSpam] Re-file failed for ${email.fromAddress}:`, err);
            }
          }
          if (filed > 0) logger.info(`[AutoSpam] Filed ${filed} message(s) into the spam folder`);
        }

        // User filter rules: evaluate each new email and apply local tag/folder
        // actions (consistent with the spam re-file above — no server-side
        // IMAP move at ingest). Rules are invariant across the batch, so they
        // are loaded once, lazily, only if any exist.
        let filterRules: FilterRule[] | null = null;

        try {
          filterRules = quiet ? [] : await storage.getEnabledFilterRules();
        } catch (err) {
          logger.error('[Filters] Failed to load filter rules:', err);
          filterRules = [];
        }
        if (filterRules.length > 0) {
          const folders = await getAllFolders();
          for (const email of emailRecords) {
            try {
              const actions = collectFilterActions(email, filterRules);
              if (actions.length === 0) continue;
              // Local projection only (matches auto-spam above); the email is
              // still being ingested so there's no server-side move here.
              const { tags, folderId, changed } = computeFilterActionResult(email, actions, folders);
              if (changed) await storage.updateEmail(email.id, { tags, folderId });
              logger.info(`[Filters] Applied ${actions.length} action(s) to email from ${email.fromAddress}`);
            } catch (err) {
              // Non-fatal — a bad rule must not break sync.
              logger.error(`[Filters] Failed to apply rules for ${email.id}:`, err);
            }
          }
        }

        result.inserted += emailRecords.length;
        for (const email of emailRecords) {
          result.insertedIds.push(email.id);
        }

        // Emit email:synced events for the pipeline (agent, categorization,
        // persister). Skipped in quiet/backfill mode — historical mail must not
        // trigger categorisation or wake the body-prefetch backlog.
        if (!quiet) {
          const eventBus = getEventBus();
          for (const email of emailRecords) {
            eventBus.emit(createEvent.emailSynced(email, folder.path, true));
          }
        }
      }

      // Report progress
      const processed = Math.min(i + batch.length, messages.length);
      onProgress?.(processed, messages.length);

      // Clear batch for GC
      batch.length = 0;
      emailRecords.length = 0;
    }

    result.relinkedFromFolders = [...relinkedFrom];
    return result;
  }

  /**
   * Convert IMAP message to EmailRecord
   */
  /**
   * Resolve Gmail's system label ROLES to this account's real mailbox paths, and
   * load the category definitions a `Sarv Inbox/*` mirror label can name.
   *
   * The path for a role differs per account (`[Gmail]/Sent Mail` vs `Sent`), so
   * it is resolved from the account's own folder list via findFolderByType
   * rather than hardcoded. `\All` is deliberately NOT mapped: All Mail is the
   * superset we are already syncing from, and re-tagging every message with it
   * would put the entire mailbox in one folder view.
   */
  private async buildGmailLabelContext(storage: IEmailStorage): Promise<GmailLabelContext> {
    const roleToPath = new Map<GmailFolderRole, string>();
    let knownCategories: KnownCategory[] | undefined;
    try {
      const folders = ((await storage.getFolders?.()) ?? []) as ClassifiableFolder[];
      // Ranked, not first-seen: an account can expose two mailboxes for one role
      // (Sarv lists `Sent` and an alias `Sent Mail`), and the canonical one — the
      // one the rest of the app routes to — must win wherever the server listed it.
      const roles: GmailFolderRole[] = ['inbox', 'sent', 'drafts', 'trash', 'spam'];
      for (const role of roles) {
        const folder = findFolderByType(folders, role);
        if (folder) roleToPath.set(role, folder.path);
      }
    } catch (e) {
      logger.warn(`[GmailLabels] could not resolve folder roles: ${(e as Error).message}`);
    }
    try {
      const defs = await (storage as { getCategoryDefinitions?: () => Promise<KnownCategory[]> })
        .getCategoryDefinitions?.();
      if (defs?.length) knownCategories = defs;
    } catch {
      // No definitions available — mapGmailLabels falls back to its slug
      // transform, which is right for the common `Sarv Inbox/Promotions` case.
    }
    return { roleToPath, knownCategories };
  }

  /**
   * Back-fill folder membership for rows already stored from the All Mail
   * superset WITHOUT re-downloading them.
   *
   * Mail downloaded before labels were fetched carries `|[Gmail]/All Mail|` and
   * nothing else, so it is on disk yet absent from INBOX, Starred and the user's
   * own labels — the "Gmail stuck at 88 mails" symptom. Re-syncing those messages
   * would cost a full download; their labels cost a few bytes each, so this
   * fetches labels only and merges the resulting tags into the existing rows.
   *
   * ADDITIVE by design: it only ever ADDS membership. A tag the user or a local
   * action removed is not re-added by a later repair… but neither does a repair
   * strip anything, so a concurrent local change can never be clobbered by it.
   * Idempotent — a second run finds nothing to change.
   */
  async repairGmailLabels(
    client: IIMAPClient,
    folder: FolderRecord,
    storage: IEmailStorage,
  ): Promise<{ scanned: number; updated: number }> {
    if (typeof client.fetchAllLabels !== 'function') return { scanned: 0, updated: 0 };
    // Whole-mailbox enumeration: it must be the mailbox we asked for, and the
    // only way to know that is to hold the selection across the fetch.
    const labelRows = await withFolderSelected(client, folder.path, () => client.fetchAllLabels!(folder.path));
    if (labelRows.length === 0) return { scanned: 0, updated: 0 };

    // Both are optional on the interface — a storage impl without them simply
    // can't be repaired, which is better than throwing on a background pass.
    if (!storage.getEmailTagsInFolder || !storage.bulkUpdateTags) return { scanned: 0, updated: 0 };
    const localRows = await storage.getEmailTagsInFolder(folder.id);
    const byUid = new Map<number, { id: string; tags: string }>();
    for (const row of localRows) {
      if (row.uid != null) byUid.set(row.uid, { id: row.id, tags: row.tags || '' });
    }

    const ctx = await this.buildGmailLabelContext(storage);
    const updates: Array<{ id: string; tags: string }> = [];
    // Every tag this repair actually ADDS, so the folders whose membership grew
    // can have their stored counts recomputed. Nothing else will: the repair
    // runs off the backfill scheduler, outside any sync whose end-of-run recount
    // could cover it.
    const touchedTags = new Set<string>();
    for (const { uid, labels } of labelRows) {
      const local = byUid.get(uid);
      if (!local || labels.length === 0) continue;
      const mapped = mapGmailLabels(labels, { knownCategories: ctx.knownCategories });
      const additions = [
        ...mapped.roles.map((r) => ctx.roleToPath.get(r)).filter((p): p is string => !!p),
        ...mapped.labels,
        ...mapped.flags,
        ...mapped.categories,
      ];
      let tags = local.tags;
      for (const tag of additions) {
        if (!hasTag(tags, tag)) {
          tags = addTag(tags, tag);
          touchedTags.add(tag);
        }
      }
      if (tags !== local.tags) updates.push({ id: local.id, tags });
    }

    if (updates.length > 0) {
      await storage.bulkUpdateTags(updates);
      // The rows now belong to folders they weren't counted in. The sidebar
      // badge reads the STORED count, so without this the repair files mail
      // into INBOX/labels that the badge never admits exists.
      await refreshCountsForFolders(storage, touchedTags, `Gmail label repair of ${folder.path}`);
    }
    logger.info(
      `[GmailLabels] ${folder.path}: repaired folder membership for ${updates.length} of ${labelRows.length} message(s)`,
    );
    return { scanned: labelRows.length, updated: updates.length };
  }

  async convertMessage(
    message: IMAPMessage,
    folderId: string,
    folderPath?: string,
    labelCtx?: GmailLabelContext,
    opts?: {
      /** The user has reported this sender (a `spammers` row). */
      knownSpammer?: boolean;
      /** The user's own outgoing mail (Sent / Drafts) — never spam-scored. */
      ownMail?: boolean;
    },
  ): Promise<EmailRecord> {
    const messageId = message.envelope.messageId;

    // Address + subject display fields (decoded) — shared with the repair path.
    const envelopeFields = mapEnvelopeFields(message.envelope);
    const subject = envelopeFields.subject ?? '';
    const normalizedSubject = normalizeSubject(subject);

    // Generate thread ID using references
    // references array is already parsed by client.ts — join for generateThreadId's string param
    const inReplyTo = message.envelope.inReplyTo;
    const references = message.envelope.references.length > 0
      ? message.envelope.references.join(' ')
      : null;
    const threadId = generateThreadId(normalizedSubject, messageId, inReplyTo, references);

    // Parse body content (or leave empty for lazy loading)
    let rawBody = '';
    let cleanBody = '';
    let contentType: 'text' | 'html' | 'multipart' = 'text';
    let calendarIcs: string | null = null;

    if (message.body && !this.config.headersOnly) {
      const parsed = await this.parseBody(message.body);
      rawBody = parsed.rawBody;
      cleanBody = parsed.cleanBody;
      contentType = parsed.contentType;
      calendarIcs = parsed.calendarIcs;
    }

    // Content hash of the BODY, or the explicit no-body marker when this is a
    // headers-only fetch. Never a hash of the subject: that is what made the
    // column claim two messages had identical content because they shared a
    // subject line. The real value lands when the body does — see the
    // `content_hash` recompute in EmailRepository.update.
    const contentHash = emailContentHash({ cleanBody, rawBody, messageId });

    // Attachment count / indicator from the body structure (cheap — no full
    // download). Names + byte sizes are left null here and filled accurately
    // from the message SOURCE via mailparser on body fetch (fillAttachments),
    // which is also what the download path matches against.
    let hasAttachments = false;
    let attachmentCount = 0;
    const attachmentNames: string | null = null;
    const attachmentSizes: string | null = null;

    if (this.config.processAttachments && message.bodyStructure) {
      const attachmentInfo = this.extractAttachmentInfo(message.bodyStructure);
      hasAttachments = attachmentInfo.hasAttachments;
      attachmentCount = attachmentInfo.count;
    }

    const now = Math.floor(Date.now() / 1000);

    // Build unified tags: folder path + IMAP flag tags
    const tagList: string[] = [];
    if (folderPath) tagList.push(folderPath);
    tagList.push(...imapFlagsToTags(message.flags));
    // Gmail labels ARE folder membership. A message fetched from the All Mail
    // superset carries every mailbox it belongs to, so without this it would be
    // filed under All Mail alone — present on disk but missing from INBOX,
    // Starred and the user's own labels. Also recovers the category this app
    // previously mirrored to a `Sarv Inbox/*` label, so old mail regains its chip
    // without paying to re-classify it. No-op on non-Gmail servers (no labels).
    if (message.labels?.length) {
      const mapped = mapGmailLabels(message.labels, {
        knownCategories: labelCtx?.knownCategories,
      });
      for (const role of mapped.roles) {
        const path = labelCtx?.roleToPath.get(role);
        if (path) tagList.push(path);
      }
      tagList.push(...mapped.labels, ...mapped.flags, ...mapped.categories);
    }
    // Mark mailing-list / bulk mail so threading can suppress the subject-based
    // fallback for it (Gmail parity — newsletters/digests never merge on subject).
    // A plain non-flag/non-folder tag: it survives flag sync and never renders as
    // a folder or label, mirroring how AI-category slugs live in the tag string.
    if (message.isBulk) tagList.push('bulk');

    // Mail authentication and the header-only spam signals, both from the
    // headers this fetch already carried. `auth` is parsed once here and
    // shared: the spam score keys on the same DMARC verdict the shield does.
    const auth = message.authHeaders ? parseAuthenticationHeaders(message.authHeaders) : null;
    const headers = message.rawHeaders ? headerLookupFromText(message.rawHeaders) : null;
    const spam = opts?.ownMail
      ? null
      : assessSpamSignals({
          fromAddress: envelopeFields.fromAddress,
          fromName: envelopeFields.fromName,
          replyTo: envelopeFields.replyTo,
          toAddress: envelopeFields.toAddress,
          ccAddress: envelopeFields.ccAddress,
          subject,
          // The id AS RECEIVED: a synthesised stand-in would hide the missing header.
          messageId: message.messageIdSynthesized ? '' : messageId,
          inReplyTo,
          references,
          date: toUnixSeconds(message.envelope?.date),
          internalDate: toUnixSeconds(message.date),
          auth,
          headers,
          knownSpammer: opts?.knownSpammer === true,
        });
    // The classification tag the AI pipeline excludes on and the Spam filter
    // view lists — the same lowercase `spam` the AI's own verdict writes.
    if (spam?.isSpam) tagList.push('spam');
    const tags = buildTags(tagList);

    return {
      id: generateId(),
      messageId,
      threadId,
      folderId,
      uid: message.uid,

      // Unified tags
      tags,

      // Headers (decoded address + subject fields)
      ...envelopeFields,

      // Timestamps
      // A message with no INTERNALDATE must NOT be lost. This used to be an
      // unguarded `message.date.getTime()`: it threw, the message was counted as
      // an error, and it was never retried because maxUid had already advanced
      // past it. Fall back to the envelope date, then to now — the same
      // defensiveness this function already applies when synthesising an id.
      date: Math.floor(
        (message.date?.getTime?.() ?? message.envelope?.date?.getTime?.() ?? Date.now()) / 1000,
      ),
      receivedDate: now,

      // Content
      cleanBody,
      rawBody,
      contentType,
      contentHash,

      // Threading
      inReplyTo: message.envelope.inReplyTo,
      references: message.envelope.references.join(' '),

      // Metadata
      priority: null,

      // Attachments
      hasAttachments,
      attachmentCount,
      attachmentNames,
      attachmentSizes,

      // Calendar invite (captured here only when the body is downloaded at sync;
      // the headers-only path fills it later on body fetch).
      calendarIcs,

      // Mail authentication (SPF / DKIM / DMARC) as the receiving server
      // recorded it. NULL when the server sent no verdict — that is a real
      // state ("unverifiable"), distinct from "checked and failed", and the
      // security level treats the two differently.
      authStatus: auth ? JSON.stringify(auth) : undefined,

      // Spam filter, header stage. NULL when not scored — the user's own
      // outgoing mail — so "not judged" and "judged clean" stay distinct.
      spamScore: spam ? spam.score : null,
      spamReasons: spam ? JSON.stringify(spam.reasons) : null,
      // The connecting client's address, for the reputation stage.
      originIp: extractOriginIp({
        authHeaders: message.authHeaders,
        received: message.rawHeaders ? headerValuesFromText(message.rawHeaders, 'received') : null,
      }),

      // AI
      hasEmbedding: false,
      embeddingLastGenerated: null,

      // Timestamps
      createdAt: now,
      updatedAt: now,
    };
  }

  /**
   * Parse email body + real attachments (filenames + byte sizes) from the raw
   * message source via mailparser. Inline/related images (cid: references in
   * the HTML) are excluded — only true attachments are reported.
   */
  async parseBody(body: string): Promise<{
    rawBody: string;
    cleanBody: string;
    contentType: 'text' | 'html' | 'multipart';
    attachments: { name: string; size: number; contentType: string }[];
    calendarIcs: string | null;
  }> {
    try {
      // `body` is the raw MIME source preserved losslessly as a latin1 string
      // (see ImapFlowClient — one char per byte). Reconstruct the exact bytes so
      // mailparser decodes the message's OWN charset/transfer-encoding correctly
      // instead of choking on a pre-UTF-8-mangled string.
      const bytes = Buffer.from(body || '', 'latin1');
      const parsed = await simpleParser(bytes, SIMPLE_PARSER_OPTIONS);
      return await this.repairMisdeclaredCharset(bytes, this.shapeParsedBody(parsed, body));
    } catch (error) {
      logger.warn('Failed to parse email body:', error);
    }

    return { rawBody: body, cleanBody: body, contentType: 'text', attachments: [], calendarIcs: null };
  }

  /**
   * Turn one mailparser result into the record shape storage expects. Split out
   * of {@link parseBody} so the charset-repair path can shape a SECOND parse of
   * the same message and compare the two.
   */
  private shapeParsedBody(
    parsed: ParsedMail,
    body: string,
  ): {
    rawBody: string;
    cleanBody: string;
    contentType: 'text' | 'html' | 'multipart';
    attachments: { name: string; size: number; contentType: string }[];
    calendarIcs: string | null;
  } {
    const rawAttachments = parsed.attachments || [];

    // Capture a calendar invite (text/calendar part or .ics attachment) so the
    // detail view can render a Gmail-style event card without re-downloading.
    // Scan the RAW parts (before the inline/attachment filtering below) so a
    // part marked inline is still caught. sanitizeIcsText size-caps + sanity-
    // checks it; malformed/oversized ICS is dropped (returns null).
    const calendarIcs = this.extractCalendarIcs(rawAttachments);

    const attachments = rawAttachments
      .filter((a) => a.contentDisposition !== 'inline' && !a.related)
      .map((a) => ({
        name: this.resolveAttachmentName(a),
        size: typeof a.size === 'number' ? a.size : 0,
        contentType: a.contentType || 'application/octet-stream',
      }))
      // Drop the invite's inline text/calendar event body. Google Calendar
      // ships it as an unnamed attachment part alongside the real invite.ics;
      // mailparser surfaces it (no filename → "attachment") but it isn't a
      // downloadable file — it's the event, rendered as the card. Gmail lists
      // only invite.ics. Gated on the generic name so a NAMED calendar file
      // (invite.ics) is always kept.
      .filter((att) => !(att.name === 'attachment' && /calendar|ics/i.test(att.contentType)));

    if (parsed.html) {
      // Put back any `cid:` image mailparser declined to rewrite (see
      // cid-images.ts) BEFORE the HTML is stored, so the repaired body flows
      // through inline-image relocation and the renderer like any other.
      const html = this.resolveInlineCids(parsed.html, rawAttachments);
      // An HTML-only mail (no text/plain alternative) leaves mailparser's
      // `text` undefined, which used to store cleanBody EMPTY — measured on
      // 205 of 26,185 real rows. cleanBody is what the list snippet, the
      // filters and every AI prompt read, so those mails looked bodyless even
      // though the HTML was fully downloaded. Derive the text from the HTML.
      return {
        rawBody: html,
        cleanBody: parsed.text || htmlToPlainText(html),
        contentType: 'html',
        attachments,
        calendarIcs,
      };
    } else if (parsed.text) {
      return { rawBody: parsed.text, cleanBody: parsed.text, contentType: 'text', attachments, calendarIcs };
    }
    return { rawBody: body, cleanBody: body, contentType: 'text', attachments, calendarIcs };
  }

  /**
   * Substitute `cid:` references mailparser left in the HTML with the bytes of
   * the parts they name. A no-op for the overwhelming majority of mail, which
   * has no leftover references at all.
   *
   * Every part is offered, not just the ones filtered into `attachments` above:
   * a cid image is `related`/`inline` by definition, which is exactly what that
   * filter removes.
   */
  private resolveInlineCids(html: string, rawAttachments: ParsedMail['attachments']): string {
    if (!hasCidRefs(html)) return html;
    const parts: CidImagePart[] = (rawAttachments || []).map((attachment) => ({
      cid: attachment.cid,
      contentType: attachment.contentType,
      filename: attachment.filename,
      toBase64: () => Buffer.from(attachment.content).toString('base64'),
    }));
    const resolved = resolveCidImages(html, parts);
    if (resolved !== html) {
      logger.info(`Resolved cid: image reference(s) mailparser left unlinked (${parts.length} parts)`);
    }
    return resolved;
  }

  /**
   * Second chance for a body that decoded to replacement characters: re-parse
   * the message as the encoding its BYTES look like, rather than the one its
   * headers claim.
   *
   * Only reachable when the faithful parse already failed, and it can only ever
   * improve on it — the re-parse is adopted solely when it carries STRICTLY
   * fewer replacement characters. A wrong guess loses and is dropped, which is
   * what makes it safe to act on statistics here at all. See `charset-repair.ts`
   * for why detection is the only cure for a sender's mislabelled part, and why
   * a re-fetch is not.
   *
   * Takes ONLY the bodies from the re-parse and keeps the original's attachments
   * and calendar invite. Transcoding rewrites the whole source, which is
   * byte-for-byte harmless to the ASCII of a base64 or quoted-printable part but
   * would corrupt a binary-transfer-encoded one — so nothing that carries bytes
   * of its own is taken from it.
   */
  private async repairMisdeclaredCharset<
    T extends { rawBody: string; cleanBody: string; contentType: 'text' | 'html' | 'multipart' },
  >(source: Buffer, primary: T): Promise<T> {
    if (!hasReplacementChar(primary.rawBody) && !hasReplacementChar(primary.cleanBody)) return primary;

    const transcoded = transcodeDetectedCharset(source);
    if (!transcoded) return primary;

    const before = countReplacementChars(primary.rawBody) + countReplacementChars(primary.cleanBody);
    try {
      const reparsed = await simpleParser(transcoded.bytes, SIMPLE_PARSER_OPTIONS);
      const candidate = this.shapeParsedBody(reparsed, '');
      const after = countReplacementChars(candidate.rawBody) + countReplacementChars(candidate.cleanBody);
      if (after >= before) return primary;
      // Fewer replacement characters is necessary but NOT sufficient: the
      // re-parse must also have kept every character the first parse already
      // decoded correctly. See `preservesDecodedText` — this is what stops a
      // mixed-charset multipart (one honest UTF-8 part, one mislabelled) from
      // being "repaired" by double-encoding the honest half, and what stops a
      // re-parse that lost the body from scoring a perfect zero.
      if (!preservesDecodedText(primary.rawBody, candidate.rawBody)) return primary;
      if (!preservesDecodedText(primary.cleanBody, candidate.cleanBody)) return primary;
      logger.info(
        `Body charset repaired: declared charset decoded to ${before} replacement char(s), `
        + `re-decoded as ${transcoded.charset} leaves ${after}`,
      );
      return {
        ...primary,
        rawBody: candidate.rawBody,
        cleanBody: candidate.cleanBody,
        contentType: candidate.contentType,
      };
    } catch (error) {
      // The repair is strictly optional — a re-parse that throws just means the
      // original stands. Never let it take down a body that did parse.
      logger.warn('Charset re-parse failed; keeping the original body:', error);
      return primary;
    }
  }

  /**
   * Pull the raw iCalendar text out of a message's parsed attachment parts, if
   * one carries a calendar invite (a `text/calendar` part or a `.ics` file).
   * Returns null when there is none or when the content fails the shared safety
   * guard (size cap + `BEGIN:VCALENDAR` sanity check). Never throws.
   */
  private extractCalendarIcs(
    attachments: Array<{ content?: unknown; contentType?: string; filename?: string }>
  ): string | null {
    const part = attachments.find((a) => {
      const ct = (a.contentType || '').toLowerCase();
      const fn = (a.filename || '').toLowerCase();
      return ct.includes('text/calendar') || ct.includes('application/ics') || fn.endsWith('.ics');
    });
    const content = part?.content;
    if (content == null) return null;
    let text: string;
    if (typeof content === 'string') {
      text = content;
    } else if (Buffer.isBuffer(content)) {
      // ICS is UTF-8 by RFC 5545, but decode defensively: if the bytes aren't
      // valid UTF-8 (would yield U+FFFD replacement chars / mojibake), fall back
      // to lossless latin1 so the VCALENDAR structure survives byte-for-byte.
      const utf8 = content.toString('utf8');
      text = utf8.includes('�') ? content.toString('latin1') : utf8;
    } else {
      return null;
    }
    return sanitizeIcsText(text);
  }

  /**
   * Resolve an attachment's display filename. mailparser's decoded `filename`
   * is the primary source, but it occasionally comes back empty even when the
   * part's Content-Disposition/Content-Type params DO carry a name (unusual
   * encodings, some Google Calendar PDFs) — recover it from the part headers
   * (same fields the BODYSTRUCTURE walk reads), decoding RFC2047 encoded-words.
   * Only falls back to the generic "attachment" when no name exists anywhere.
   */
  private resolveAttachmentName(a: {
    filename?: string;
    headers?: Map<string, unknown>;
  }): string {
    const direct = (a.filename || '').trim();
    if (direct) return direct;

    const headerParam = (name: string, key: string): string | undefined => {
      const h = a.headers?.get(name) as { params?: Record<string, string> } | undefined;
      const v = h?.params?.[key];
      return typeof v === 'string' && v.trim() ? v.trim() : undefined;
    };
    const raw =
      headerParam('content-disposition', 'filename') ||
      headerParam('content-type', 'name') ||
      headerParam('content-type', 'filename');
    if (raw) {
      try {
        return libmime.decodeWords(raw).trim() || raw;
      } catch {
        return raw;
      }
    }
    return 'attachment';
  }

  /**
   * Fetch and parse body on-demand
   */
  async fetchBody(
    client: IIMAPClient,
    folderPath: string,
    uid: number,
    storage: IEmailStorage,
    emailId: string
  ): Promise<{ rawBody: string; cleanBody: string; contentType: string; source: string } | null> {
    // Errors propagate to the caller (sync-engine body-fetch queue), which logs
    // each failure once with retry context. Deliberately no try/catch here —
    // catching just to rethrow double-printed every transient failure.
    //
    // Read the target row BEFORE the network round trip: its message-id is the
    // only thing that can prove the body we get back belongs to this email.
    const target = await storage.getEmail(emailId);

    // Every fetch below resolves a UID, and a UID only means anything inside the
    // mailbox it was issued in — so the selection is held for all of them, not
    // just re-asserted before the first.
    const fetchOne = async (targetUid: number) => {
      const found = await withFolderSelected(client, folderPath, () => client.fetchMessagesByUID([targetUid], {
        fetchHeaders: false,
        fetchBody: true,
        fetchBodyStructure: true,
      }));
      return found[0];
    };

    // Resolve the message by its stored UID. A row can carry NO uid at all —
    // cleared when it was relinked to a new folder and never re-synced there,
    // which is COMMON on Gmail, where applying/moving a category label changes an
    // email's PRIMARY folder and blanks its uid. Or a STALE uid: a UID is only
    // meaningful within one mailbox + UIDVALIDITY, so it can point at a slot that
    // now holds a different message. In BOTH cases the body would otherwise never
    // download — the row sits body-less forever (the "few mails' body never
    // downloads", and the Gmail backlog that drained 0/tick). So fall back to the
    // one stable identifier — the message-id — re-resolve the uid, and repair the
    // row so it fetches now and stays fixed.
    let message = uid ? await fetchOne(uid) : undefined;

    const wrongMessage = !!message && !isExpectedMessage(message, target?.messageId);
    if ((!message || wrongMessage) && target?.messageId) {
      logger.trace(
        wrongMessage
          ? `Body fetch identity mismatch for ${emailId} (UID ${uid} in ${folderPath}): expected ${target.messageId}, server returned ${message?.envelope?.messageId}`
          : `Body fetch: no message at UID ${uid || '(none)'} for ${emailId} in ${folderPath} — resolving by message-id`,
      );
      // HEADER search is matched without angle brackets because servers
      // substring-match the raw header value; a bracketed query misses on some.
      const bare = target.messageId.replace(/^<|>$/g, '');
      let correctedUid: number | undefined;
      let hitCount = 0;
      try {
        const hits = await withFolderSelected(client, folderPath, () =>
          client.search({ header: [{ name: 'message-id', value: bare }] }));
        hitCount = hits.length;
        correctedUid = hits.find((u) => u !== uid);
      } catch (err) {
        // The SEARCH itself failed (timeout, dropped socket, server busy). That
        // is evidence about the CONNECTION, not about the message — returning
        // null here made the prefetcher read "server has no such message" and
        // retire perfectly live mail. Defer instead; the next tick asks again.
        logger.warn(`HEADER Message-ID search failed in ${folderPath}: ${(err as Error).message}`);
        throw createDeferredFetchError(`message-id search failed in "${folderPath}"`);
      }
      if (correctedUid === undefined) {
        // Zero hits IS a verdict: the server was asked for this message-id and
        // has none. But hits we couldn't use (only the stale UID came back) mean
        // the server says the message is there while the FETCH disagreed — a
        // contradiction, so ask again later rather than retiring the row.
        if (hitCount > 0) {
          throw createDeferredFetchError(`UID ${uid} disagrees with the message-id search in "${folderPath}"`);
        }
        logger.trace(`Could not re-resolve ${emailId} by message-id in ${folderPath} — leaving body empty`);
        return null;
      }
      const corrected = await fetchOne(correctedUid);
      if (!corrected || !isExpectedMessage(corrected, target.messageId)) {
        // The search pointed at a UID that then fetched as something else (or as
        // nothing): the mailbox moved under us mid-operation. Deferred, not a
        // verdict — a re-resolve on the next tick usually lands.
        logger.warn(`Re-resolved UID ${correctedUid} for ${emailId} still does not match — will retry`);
        throw createDeferredFetchError(`re-resolved UID ${correctedUid} did not match in "${folderPath}"`);
      }
      logger.info(`Repaired ${uid ? 'stale' : 'missing'} UID for ${emailId} in ${folderPath}: ${uid || '(none)'} -> ${correctedUid}`);
      await storage.updateEmail(emailId, { uid: correctedUid });
      message = corrected;
    }

    if (!message) {
      // No uid AND no message-id to resolve by (or an expunged slot). Return a
      // VERDICT: body-prefetch counts a null as "unavailable" and, after a few
      // strikes, tags the row so it stops being re-seeded every tick.
      logger.trace(`No message found for ${emailId} (UID ${uid || '(none)'} in ${folderPath})`);
      return null;
    }

    if (!message.body) {
      // Identified the message, and the server handed back no source for it. A
      // verdict (there is nothing to download), but log it: this path was silent,
      // so an email stuck here looked identical in the log to one never tried.
      logger.warn(`Body fetch: message for ${emailId} (UID ${message.uid || uid} in ${folderPath}) carries no source`);
      return null;
    }

    const parsed = await this.parseBody(message.body);

    // Update storage. Attachment name+size are authoritative here (parsed from
    // the source, matching the download path) — only written when we actually
    // found attachments so an inline-only email doesn't clear the sync-time
    // indicator.
    const update: Partial<EmailRecord> = {
      rawBody: parsed.rawBody,
      cleanBody: parsed.cleanBody,
      contentType: parsed.contentType,
    };
    // Reconcile attachment metadata from the source (authoritative, matches the
    // download path). When the source has none, correct the flag/count — a
    // body-structure over-count of inline images shouldn't keep re-triggering
    // a source re-fetch on every open.
    if (parsed.attachments.length > 0) {
      update.hasAttachments = true;
      update.attachmentCount = parsed.attachments.length;
      update.attachmentNames = JSON.stringify(parsed.attachments.map((a) => a.name));
      // Sizes come from the DECODED part, which is wrong for a part whose
      // Content-Transfer-Encoding header lies: raw text claiming `base64`
      // collapses to a handful of junk bytes, and the row then advertised a
      // 400-byte .txt as "7 B" forever — even after the download path started
      // recovering the real content. Cross-check each against the part's raw
      // length in the source we just parsed. Not against the server's
      // BODYSTRUCTURE: mailboxes exist that return every parameter with its
      // value missing, so neither the filename nor the size is there to compare.
      update.attachmentSizes = JSON.stringify(
        await attachmentSizesFromSource(Buffer.from(message.body, 'latin1'), parsed.attachments),
      );
    } else {
      update.hasAttachments = false;
      update.attachmentCount = 0;
    }
    // Persist the calendar invite (if any) so the detail view can render the
    // event card offline on subsequent opens. Only set when found — never clear
    // a previously-captured invite on a re-fetch that happened to miss it.
    if (parsed.calendarIcs) {
      update.calendarIcs = parsed.calendarIcs;
    }
    await storage.updateEmail(emailId, update);

    // Return the full raw source alongside the parsed body so the caller can
    // cache it for "Show Original" — it is downloaded here anyway and would
    // otherwise be discarded, forcing a second fetch later.
    return { ...parsed, source: message.body };
  }

  /**
   * Extract attachment info from body structure
   */
  private extractAttachmentInfo(bodyStructure: any): {
    hasAttachments: boolean;
    count: number;
    names: string[];
  } {
    const names: string[] = [];

    const walk = (struct: any) => {
      if (!struct) return;

      // Skip multipart containers — only check leaf parts
      if (struct.type !== 'multipart') {
        const disposition = struct.disposition?.type?.toLowerCase();
        const filename =
          struct.disposition?.params?.filename ||
          struct.params?.name ||
          struct.params?.filename;

        if (disposition === 'attachment' && filename) {
          // Explicit attachment
          names.push(libmime.decodeWords(filename));
        } else if (filename && disposition !== 'inline') {
          // Has a filename but no explicit disposition — treat as attachment
          // (some servers omit disposition entirely)
          names.push(libmime.decodeWords(filename));
        }
      }

      // Recurse into parts
      if (Array.isArray(struct.parts)) {
        struct.parts.forEach(walk);
      }
    };

    walk(bodyStructure);

    return {
      hasAttachments: names.length > 0,
      count: names.length,
      names,
    };
  }

  /**
   * Check if folder is Sent folder
   */
  private isSentFolder(path: string): boolean {
    const lowerPath = path.toLowerCase();
    return (
      lowerPath.includes('sent') ||
      lowerPath === '[gmail]/sent mail'
    );
  }

  /**
   * Sync flags and detect deleted emails
   *
   * Uses two-phase approach:
   * 1. Fetch flags for local UIDs - update any that changed
   * 2. Check for deleted emails by searching for existing UIDs
   */
  async syncFlags(
    client: IIMAPClient,
    folder: FolderRecord,
    storage: IEmailStorage,
    onFlagChange?: (emailId: string, uid: number, flags: string[]) => void,
    onDeleted?: (emailId: string, uid: number) => void,
    options?: { skipDeletion?: boolean; forceDeletion?: boolean; fullReconcile?: boolean },
    // Fires ONLY when a message's read state actually flipped (not on a
    // star-only change), so the caller can maintain folder unread counts with a
    // scan-free delta instead of a full recount.
    onReadChange?: (emailId: string, nowRead: boolean) => void,
    // Progress heartbeat. A whole-mailbox reconcile (fetchAllUIDs + batched
    // fetchFlagsOnly + the addition-reconcile FETCHes) runs on a single POOLED
    // connection and, on a big mailbox like [Gmail]/All Mail, can hold it well
    // past the pool's 120s stuck-eviction timeout. Without a heartbeat the pool
    // reclaims the connection MID-reconcile, which poisons the socket, drops the
    // primary, and triggers the connect-timeout back-off storm (mail stops
    // arriving). Called after each internal sub-step that made progress so the
    // caller can refresh the connection's acquiredAt; a genuinely hung command
    // (no progress > 120s) is still evicted, so leak-safety is preserved.
    touch?: () => void,
  ): Promise<{ updated: number; deleted: number }> {
    const result = { updated: 0, deleted: 0 };

    // Two maps drive the whole pass:
    //  - serverFlagsMap: uid -> flags   (Phase 1 flag reconciliation)
    //  - serverUidsSet:  every uid that exists on the server (Phase 2 deletion)
    // The full path fills BOTH from one `1:*` FLAGS fetch. The CONDSTORE delta
    // path fills serverFlagsMap from only the CHANGED messages (cheap) and
    // serverUidsSet from a UID-only SEARCH ALL — behaviour-identical downstream,
    // it just skips re-fetching flags for unchanged messages.
    const serverUidsSet = new Set<number>();
    const serverFlagsMap = new Map<number, string[]>();
    // True only when serverUidsSet holds the COMPLETE server UID list this sync,
    // so Phase-2 deletion detection may run. Full path: always (it fetches all
    // flags = all UIDs). Delta path: only on the throttled reconcile tick.
    let deletionSetReady = false;
    // The RECENT-WINDOW server UID list (UID SEARCH SINCE), kept separate from
    // serverUidsSet because the two license completely different things. A window
    // is useless for DELETION — every message older than the cutoff is absent from
    // it and would be read as deleted — but it is authoritative for ADDITION: the
    // server enumerated that date range, so a UID in the window we don't hold is a
    // message we genuinely never stored. Large mailboxes only ever get a windowed
    // list, so without this distinction they got NO addition reconcile at all and a
    // gap in a big INBOX could never close.
    const windowedUidsSet = new Set<number>();
    let windowSetReady = false;
    // Assigned as soon as the server's EXISTS is known (below). Declared HERE so
    // the loaders defined below can close over it without depending on where in
    // this function they happen to be called from.
    let isLargeMailbox = false;

    // Full-path loader (the proven behaviour). Returns false when the server
    // fetch fails so the caller bails without touching local flags. Populates
    // BOTH maps from the single 1:* FLAGS fetch — never errors on deleted UIDs,
    // it only returns what exists.
    const loadFullFlags = async (): Promise<boolean> => {
      let serverFlags: Array<{ uid: number; flags: string[] }>;
      try {
        serverFlags = await client.fetchAllFlags(folder.path);
      } catch (err) {
        logger.warn(`Failed to fetch flags from server for ${folder.path}, skipping flag sync: ${(err as Error)?.message ?? err}`);
        return false;
      }
      for (const sf of serverFlags) {
        serverUidsSet.add(sf.uid);
        serverFlagsMap.set(sf.uid, sf.flags);
      }
      return true;
    };

    /**
     * Get the server UID set for a folder whose flag fetch is unusable.
     *
     * Tries the full `1:* FLAGS` fetch first, since one command fills both maps.
     * When that fails — Sarv's INBOX answers a large `FETCH 1:*` with "Command
     * failed" — rebuild the same state from two bounded commands instead:
     * `UID SEARCH ALL` for the complete UID set (Phase-2 deletion), then a
     * BATCHED flag fetch over those UIDs (Phase-1 read/starred). Servers that
     * refuse the whole-mailbox fetch serve bounded ranges fine.
     *
     * Flags are best-effort: if the batched fetch fails entirely, serverFlagsMap
     * stays empty, every uid is a Phase-1 no-op and local flags are left
     * untouched (safe) while deletions still reconcile.
     *
     * Shared by BOTH failure routes. Previously only the non-CONDSTORE branch
     * had this rescue, so a server that advertises CONDSTORE *and* rejects
     * `FETCH 1:*` (imap.sarv.com does both) fell into the delta path, failed
     * both fetches, and returned before Phase 2 — deletions never reconciled
     * and mail trashed in webmail stayed in the app inbox forever.
     *
     * Returns true when serverUidsSet holds the complete server UID list.
     */
    const loadServerUidState = async (reason: string): Promise<boolean> => {
      // Don't even ATTEMPT the unbounded `FETCH 1:*` on a big mailbox. It streams
      // one response line per message under a SINGLE 60s op timeout, and a
      // timed-out IMAP command stays IN-FLIGHT on the socket — so every command
      // queued behind it times out too, IDLE included:
      //   IMAP FETCH flags timed out after 60000ms — recycling the wedged connection
      //   Realtime: Failed to start IDLE: Connection not available
      // On the reported 23,343-message INBOX that fetch was the wedge, and it is
      // reached even for a LARGE mailbox via the background backfill's
      // fullReconcile pass. The route below is bounded (SEARCH ALL for the
      // complete UID set + 500-UID FLAGS batches), so a slow batch fails alone
      // instead of taking the connection down with it. Crucially the UID set
      // still comes from SEARCH ALL, so Phase-2 completeness is unaffected by a
      // partially-failed flag fetch.
      const skipFullFetch = isLargeMailbox && typeof client.fetchAllUIDs === 'function';
      if (!skipFullFetch && await loadFullFlags()) return true;
      if (typeof client.fetchAllUIDs !== 'function') return false;
      try {
        const allUids = await client.fetchAllUIDs(folder.path);
        for (const uid of allUids) serverUidsSet.add(uid);
        touch?.(); // the whole-mailbox UID search landed — heartbeat before the (batched) flag fetch

        // SEARCH ALL yields UIDs but no flags, which is enough for Phase-2
        // deletion and nothing else. Left there, Phase 1 skips every message
        // (empty serverFlagsMap) and read/unread + starred edits made in webmail
        // never reach the app on this folder. Re-fetch the flags in bounded
        // batches — the same server that rejects `1:*` serves ranges fine.
        // Partial results are still a win: whatever lands reconciles.
        if (allUids.length > 0) {
          try {
            const flags = await client.fetchFlagsOnly(allUids, touch, folder.path);
            for (const f of flags) serverFlagsMap.set(f.uid, f.flags);
          } catch (err) {
            logger.warn(`Batched flag fetch failed for ${folder.path}: ${(err as Error).message}`);
          }
        }

        logger.info(
          `syncFlags ${folder.path}: ${reason} — reconciling via SEARCH ALL `
          + `(${allUids.length} server uids, flags for ${serverFlagsMap.size})`,
        );
        return true;
      } catch (err) {
        logger.warn(`fetchAllUIDs deletion fallback failed for ${folder.path}: ${(err as Error).message}`);
        return false;
      }
    };

    /**
     * WINDOWED flag reconcile for large mailboxes (server EXISTS >
     * LARGE_MAILBOX_THRESHOLD). Instead of enumerating the WHOLE mailbox — the
     * `UID SEARCH ALL` / `FETCH 1:*` that returns partial lists or times out at
     * lakh+ scale — reconcile flags for only the recent window
     * (`UID SEARCH SINCE`, compact and reliable). Recent read/unread/starred keep
     * syncing fast; older-mail flag changes are picked up by the background
     * backfill's full reconcile.
     *
     * Deliberately does NOT populate serverUidsSet or set deletionSetReady: a
     * windowed UID set is INCOMPLETE, and diffing local rows against it would
     * falsely "delete" every message outside the window. Whole-folder deletion is
     * therefore deferred to the background pass; hot-path deletions still arrive
     * via CONDSTORE VANISHED (refreshFolderFlags) where the server supports it.
     *
     * Populates serverFlagsMap only (Phase 1). Returns false when the windowed
     * search is unavailable/fails so the caller can fall back.
     */
    const loadWindowedFlags = async (reason: string): Promise<boolean> => {
      if (typeof client.fetchUidsSince !== 'function') return false;
      try {
        const windowUids = await client.fetchUidsSince(recentWindowCutoffDate(), folder.path);
        // Record the window itself, not just the flags read from it — this is the
        // only complete server UID list a large mailbox ever produces, and Phase 2
        // needs it to spot mail that never landed locally (addition only; see the
        // declaration for why it must never drive deletion).
        for (const uid of windowUids) windowedUidsSet.add(uid);
        windowSetReady = true;
        if (windowUids.length > 0) {
          try {
            const flags = await client.fetchFlagsOnly(windowUids, touch, folder.path);
            for (const f of flags) serverFlagsMap.set(f.uid, f.flags);
          } catch (err) {
            logger.warn(`Windowed flag fetch failed for ${folder.path}: ${(err as Error).message}`);
          }
        }
        logger.info(
          `syncFlags ${folder.path}: ${reason} — WINDOWED reconcile `
          + `(${windowUids.length} uids in last ${SYNC_RECENT_WINDOW_DAYS}d, flags for ${serverFlagsMap.size}); `
          + `whole-folder deletion deferred to background backfill`,
        );
        return true;
      } catch (err) {
        logger.warn(`Windowed UID search failed for ${folder.path}: ${(err as Error).message}`);
        return false;
      }
    };

    // Current open-folder CONDSTORE state (read straight off the live mailbox).
    // syncFlags is always called right after the folder is selected, so this is
    // the folder we're about to reconcile. Absent → delta ineligible.
    const currentState = client.getCurrentMailboxState?.() ?? null;
    // SAFETY: syncFlags reads flags/UIDs from whatever mailbox is SELECTED on the
    // connection. If a folder-selection race left a DIFFERENT folder open (e.g.
    // IDLE re-selected INBOX under a parallel sync), reconciling would apply one
    // folder's server state to another's local rows — Phase-1 could wipe flags and
    // Phase-2 could DELETE rows that only look "missing" because we're diffing
    // against the wrong mailbox. Refuse to reconcile on a mismatch.
    if (currentState?.path && currentState.path !== folder.path) {
      logger.warn(
        `[syncFlags] ${folder.path}: ABORTED — connection has "${currentState.path}" selected, not "${folder.path}" (folder-selection race). Skipping to avoid cross-folder flag/deletion corruption.`,
      );
      return result;
    }
    const currentModseq = currentState?.highestModseq;
    const currentUidValidity = currentState?.uidValidity;

    // UIDVALIDITY changed under us (folder recreated/renumbered on the server).
    // Every LOCAL uid for this folder is now keyed to the OLD validity, so:
    //  - Phase-1 matches server flags to local rows BY UID NUMBER → it would apply
    //    the wrong message's flags (read/starred corruption), and
    //  - the end-of-pass persist would ADOPT the new validity onto the folder,
    //    permanently defeating the folder-sync re-key (handleUidValidity then sees
    //    "no change" and never wipes → stale, mis-keyed rows forever).
    // Bail entirely and let FolderSyncer.handleUidValidity do the authoritative,
    // non-destructive re-key + full re-sync.
    if (folder.uidValidity != null && typeof currentUidValidity === 'number' &&
        Number.isFinite(currentUidValidity) && currentUidValidity > 0 &&
        folder.uidValidity !== currentUidValidity) {
      logger.warn(
        `[syncFlags] ${folder.path}: UIDVALIDITY changed (${folder.uidValidity} -> ${currentUidValidity}) — `
        + `skipping flag/deletion reconcile; folder-sync will re-key and re-sync`,
      );
      return result;
    }

    // Server's current message count for this folder. Used by Phase-2's partial-
    // fetch guard to confirm the server UID list is COMPLETE (see below).
    const serverExists = typeof currentState?.exists === 'number' ? currentState.exists : null;
    // Large mailbox: enumerating the WHOLE folder (SEARCH ALL / FETCH 1:*) returns
    // partial lists or times out at lakh+ scale. Above the threshold we reconcile
    // flags for the recent window only and defer whole-folder deletion to the
    // background backfill (see loadWindowedFlags). Unknown EXISTS → treat as small
    // (proven whole-mailbox path).
    isLargeMailbox = serverExists != null && serverExists > LARGE_MAILBOX_THRESHOLD;
    // Windowed reconcile applies to large mailboxes EXCEPT when the caller forces
    // the full whole-mailbox sweep (the background backfill's deferred deletion
    // reconcile — Phase 2). fullReconcile=true → run the proven whole-mailbox path
    // even on a large mailbox (acceptable off the hot path, in the background).
    const windowed = isLargeMailbox && options?.fullReconcile !== true;
    logger.info(
      `[syncFlags] ${folder.path}: entering — server EXISTS=${serverExists ?? '?'}${windowed ? ' (LARGE — windowed reconcile)' : isLargeMailbox ? ' (LARGE — FULL background reconcile)' : ''}, condstore=${client.supportsCondstore()}, storedModseq=${folder.highestModseq ?? 0}, currentModseq=${currentModseq ?? '?'}`,
    );
    const storedModseq = folder.highestModseq ?? 0;

    // Delta eligibility — ALL must hold, else the proven full path:
    //  1. server advertises CONDSTORE and implements both delta helpers
    //  2. we have a stored modseq to diff against (>0; first sync has none)
    //  3. the server reports a current modseq (>0)
    //  4. UIDVALIDITY is unchanged since that stored modseq (else UIDs/modseq
    //     are meaningless — the stored record's validity must equal the live one)
    const deltaEligible =
      client.supportsCondstore() &&
      typeof client.fetchFlagsChangedSince === 'function' &&
      typeof client.fetchAllUIDs === 'function' &&
      storedModseq > 0 &&
      typeof currentModseq === 'number' && currentModseq > 0 &&
      folder.uidValidity != null &&
      typeof currentUidValidity === 'number' &&
      folder.uidValidity === currentUidValidity;

    if (deltaEligible) {
      try {
        // CHANGED flags only (modseq > storedModseq) — the whole optimization.
        const changed = await client.fetchFlagsChangedSince!(storedModseq);
        for (const c of changed) {
          serverFlagsMap.set(c.uid, c.flags);
        }
        // Periodic FULL reconcile (SEARCH ALL + all flags), throttled so it
        // doesn't fire on every sync — the cheap delta above already ran. On
        // non-reconcile ticks serverUidsSet stays empty and deletion detection
        // is skipped this cycle.
        const dueForDeletion =
          options?.forceDeletion === true ||
          Date.now() - (lastDeletionReconcile.get(folder.id) ?? 0) >= DELETION_RECONCILE_INTERVAL_MS;
        if (dueForDeletion && windowed) {
          // Large CONDSTORE mailbox: SKIP the whole-mailbox SEARCH ALL. The
          // CHANGEDSINCE delta above already applied recent flag changes, and
          // deletions arrive via CONDSTORE VANISHED (refreshFolderFlags). Do a
          // WINDOWED flag re-read (throttled) so a drifted/stuck server MODSEQ
          // still can't strand recent read/unread; whole-folder deletion reconcile
          // defers to the background backfill. deletionSetReady stays false → the
          // Phase-2 whole-folder diff is skipped this cycle (safe: never diff
          // against an incomplete window).
          lastDeletionReconcile.set(folder.id, Date.now());
          const dueForFlagReconcile =
            Date.now() - (lastFlagReconcile.get(folder.id) ?? 0) >= FLAG_RECONCILE_INTERVAL_MS;
          if (dueForFlagReconcile) {
            lastFlagReconcile.set(folder.id, Date.now());
            await loadWindowedFlags(`CONDSTORE large-mailbox reconcile (${changed.length} delta changes)`);
          } else {
            logger.debug(
              `syncFlags delta ${folder.path}: ${changed.length} changed since modseq ${storedModseq} (large mailbox — windowed flag re-read throttled, whole-folder deletion deferred)`,
            );
          }
        } else if (dueForDeletion) {
          const allUids = await client.fetchAllUIDs!(folder.path);
          for (const uid of allUids) serverUidsSet.add(uid);
          deletionSetReady = true;
          lastDeletionReconcile.set(folder.id, Date.now());
          touch?.(); // the whole-mailbox UID search landed — heartbeat before the (batched) flag re-read



          // Re-read ALL flags on this tick, not just the CHANGEDSINCE delta.
          //
          // Flags previously had NO full reconcile at all: every flag update
          // came from `fetchFlagsChangedSince`, so the app trusted the server's
          // MODSEQ bookkeeping absolutely. Any bump the server fails to record —
          // or a stored modseq that drifts ahead — desynced read/unread and
          // starred PERMANENTLY, with nothing to correct it, while deletions
          // kept working off their own SEARCH ALL safety net. Observed on
          // imap.sarv.com: HIGHESTMODSEQ sat unchanged across many syncs while
          // messages were being read in webmail, so the delta returned 0 every
          // time and mail stayed bold in the app forever.
          //
          // Throttled SEPARATELY from deletion. `forceDeletion` is set by
          // incrementalSync, i.e. by every folder of every periodic sync and
          // every manual refresh — so piggy-backing on it would run a full
          // SEARCH-ALL-plus-batched-FETCH flag re-read on every single sync, for
          // every folder, on every account. Deletion is a cheap UID diff and can
          // stay on that cadence; re-reading every flag cannot. Worst case a
          // webmail read shows up here one interval late, which is the accepted
          // trade ("syncing a little late is fine, lagging is not").
          const dueForFlagReconcile =
            Date.now() - (lastFlagReconcile.get(folder.id) ?? 0) >= FLAG_RECONCILE_INTERVAL_MS;
          if (dueForFlagReconcile) {
            lastFlagReconcile.set(folder.id, Date.now());
            // Best-effort — a failure just leaves the delta's view in place.
            if (isLargeMailbox) {
              // NEVER re-read the whole flag set on a huge folder ([Gmail]/All Mail,
              // ~26k UIDs = 52 FLAGS batches on ONE pooled connection). Under Gmail's
              // connection cap that doesn't just block — a batch reliably TIMES OUT
              // (observed "flags for 0/1" EVERY cycle), which recycles and POISONS the
              // connection, starves the small pool, and trips the connect-cap back-off:
              //   IMAP FETCH flags (batch) timed out after 60000ms — recycling…
              //   Pool: acquire timeout … / not opening a new connection — 95s back-off
              // i.e. the exact "mail stops arriving" cycle. The CHANGEDSINCE delta above
              // already applied every recent flag change; a WINDOWED re-read (recent
              // 30d only — bounded and reliable) is the drift safety net that actually
              // completes. Whole-mailbox drift on old archive mail is the accepted
              // trade: the whole-mailbox re-read never completed here anyway. Deletion
              // detection is unaffected — it runs off serverUidsSet (fetchAllUIDs above).
              await loadWindowedFlags(`large-mailbox flag drift net (${changed.length} delta changes)`);
            } else {
              try {
                const allFlags = await client.fetchFlagsOnly(allUids, touch, folder.path);
                for (const f of allFlags) serverFlagsMap.set(f.uid, f.flags);
              } catch (err) {
                logger.warn(`Full flag reconcile failed for ${folder.path}: ${(err as Error).message}`);
              }
            }
          }

          logger.info(
            `syncFlags ${folder.path}: reconcile — ${changed.length} changed since modseq ${storedModseq}, `
            + `${allUids.length} server uids, flags for ${serverFlagsMap.size}`
            + `${dueForFlagReconcile ? ' (full flag re-read)' : ''}`,
          );
        } else {
          logger.debug(
            `syncFlags delta ${folder.path}: ${changed.length} changed since modseq ${storedModseq} (deletion reconcile throttled)`,
          );
        }
      } catch (err) {
        // HARD FALLBACK: any delta error → discard partial maps and take the
        // proven full path. Correctness must never depend on the delta working.
        logger.warn(
          `CONDSTORE delta flag sync failed for ${folder.path}, falling back to full fetch: ${(err as Error).message}`,
        );
        serverUidsSet.clear();
        serverFlagsMap.clear();
        if (!(await loadServerUidState('CONDSTORE delta and FLAGS fetch both failed'))) return result;
        deletionSetReady = true;
      }
    } else if (windowed) {
      // Large NON-CONDSTORE mailbox: the whole `1:* FLAGS` / SEARCH ALL is exactly
      // what times out or returns partial lists here. Reconcile flags for the
      // recent window only; whole-folder deletion defers to the background backfill
      // (deletionSetReady stays false → Phase-2 diff skipped). If the windowed
      // search isn't available/fails, fall back to the proven whole-mailbox path.
      if (!(await loadWindowedFlags('large non-CONDSTORE mailbox'))) {
        if (!(await loadServerUidState('FLAGS fetch failed'))) return result;
        deletionSetReady = true;
      }
    } else {
      // Non-CONDSTORE server: the full `1:* FLAGS` fetch is the proven path,
      // with the SEARCH ALL rescue behind it (see loadServerUidState) for the
      // large mailboxes where that fetch times out or is rejected outright.
      if (!(await loadServerUidState('FLAGS fetch failed'))) return result;
      deletionSetReady = true;
    }

    // PHASE 1: Update flags for ALL local emails in the folder
    // (paginated). Previously this was capped at the 200 most-recent
    // emails — which meant a "Mark all as read" done from Gmail
    // webmail (or any other IMAP client) only flowed back to Sarv
    // Inbox for the 200 most-recent emails per folder. Anything older
    // silently stayed at the old read/unread state. Now we paginate
    // through every email in the folder so bulk flag changes done
    // elsewhere always sync correctly.
    const FLAG_SYNC_BATCH = 500;
    const flagTagNames = FLAG_TAG_NAMES as readonly string[];
    // UIDs with a pending local flag change — never let the server-wins pass
    // below overwrite them (the change hasn't round-tripped yet).
    const pendingUids = (await this.pendingUidsProvider?.(folder.path)) ?? new Set<number>();
    let flagOffset = 0;

    // ONE cheap read of (id, uid, tags) for the whole folder, shared by BOTH
    // phases. Replaces Phase 1's paginated `getEmailsByFolder` sweep (SELECT *
    // with thread metadata and both body columns, OFFSET-paged and therefore
    // quadratic) AND Phase 2's separate `getEmailUidsInFolder` scan, which
    // re-read the very same rows moments later in the same tick. Loaded lazily
    // so a cycle that does neither phase reads nothing at all.
    let folderRows: Array<{ id: string; uid: number | null; tags: string }> | null = null;
    let folderRowsLoaded = false;
    const loadFolderRows = async (): Promise<Array<{ id: string; uid: number | null; tags: string }> | null> => {
      if (!folderRowsLoaded) {
        folderRowsLoaded = true;
        if (typeof storage.getEmailTagsInFolder === 'function') {
          folderRows = await storage.getEmailTagsInFolder(folder.id);
        }
      }
      return folderRows;
    };

    // STALE-FLAG SWEEP — the only flag reconcile that OLD mail on a large mailbox
    // ever gets.
    //
    // A windowed pass (`windowSetReady`) covers the recent window and nothing else,
    // and the whole-mailbox re-read it replaced is never coming back — it was the
    // command that timed out, poisoned the pooled connection and stopped mail
    // arriving. So anything older than the window kept whatever flags it had when
    // it was first downloaded: mail read or unstarred in webmail months ago stayed
    // bold in the app forever and kept inflating the folder badge. Observed live as
    // an INBOX badge of 5 whose five rows (May, July, August) were all already read
    // on the server.
    //
    // Verify only what the user can SEE is wrong — the rows we render unread or
    // starred — so the cost tracks the unread count, not the mailbox size, and
    // stays inside ONE bounded FLAGS batch. Results are merged into serverFlagsMap
    // so Phase 1 below applies them through exactly the same path as windowed
    // flags: pending-op guard, snooze preservation, count deltas, all of it. There
    // is no second copy of the apply logic here, deliberately.
    //
    // Runs BEFORE `shouldRunPhase1` is decided, so a sweep that finds work also
    // turns Phase 1 on for a tick the window alone would have skipped.
    if (windowSetReady) {
      const dueForStaleSweep =
        Date.now() - (lastStaleFlagSweep.get(folder.id) ?? 0) >= STALE_FLAG_SWEEP_INTERVAL_MS;
      const rows = dueForStaleSweep ? await loadFolderRows() : null;
      if (rows) {
        lastStaleFlagSweep.set(folder.id, Date.now());
        const checked = this.staleFlagCheckedUids.get(folder.path) ?? new Set<number>();
        const selection = selectStaleFlagCandidates({
          rows,
          knownUids: new Set(serverFlagsMap.keys()),
          pendingUids,
          alreadyChecked: checked,
          max: STALE_FLAG_VERIFY_MAX,
        });
        // Every candidate has had a turn — start the lap again so a flag flipped in
        // webmail after we last looked at that message is still eventually seen.
        if (selection.wrapped) checked.clear();
        if (selection.uids.length > 0) {
          try {
            const staleFlags = await client.fetchFlagsOnly(selection.uids, touch, folder.path);
            for (const f of staleFlags) serverFlagsMap.set(f.uid, f.flags);
            // Mark the whole REQUESTED batch, not just what came back. A UID the
            // server didn't return is gone from the mailbox — a deletion, which this
            // pass has no authority to act on — and leaving it unmarked would park it
            // at the head of a newest-first rotation and re-request it forever.
            for (const uid of selection.uids) checked.add(uid);
            logger.info(
              `[syncFlags] ${folder.path}: stale-flag sweep — re-read ${staleFlags.length}/${selection.uids.length} `
              + `old unread/starred uid(s) outside the ${SYNC_RECENT_WINDOW_DAYS}d window`
              + `${selection.remaining > 0 ? ` (${selection.remaining} more next sweep)` : ''}`
              + `${selection.wrapped ? ' [rotation restarted]' : ''}`,
            );
          } catch (err) {
            // TRANSIENT: mark nothing, so the same UIDs are retried next sweep
            // rather than suppressed for the session on one flaky response.
            logger.warn(`[syncFlags] ${folder.path}: stale-flag sweep failed: ${(err as Error).message}`);
          }
        }
        // Same bound as the addition reconcile's tried-set: clearing only costs a
        // re-verification lap, so it can never grow without limit.
        if (checked.size > MessageProcessor.RECONCILE_TRIED_CAP) checked.clear();
        this.staleFlagCheckedUids.set(folder.path, checked);
      }
    }

    // Nothing to compare against — skip the whole pagination sweep.
    //
    // Phase 1 used to run unconditionally. On the common "server reported no
    // flag changes" tick that meant reading EVERY row of the folder (5 x 500-row
    // pages on a 2.5k INBOX, ~860ms of synchronous SQLite, and it happens twice
    // per sync cycle) purely to compare each tag string against an empty map.
    // Measured in the field: 1047 SlowQuery hits and ~40s of SQL in a single
    // hour, all of it discovering that nothing changed. Phase 2 has its own data
    // source (serverUidsSet) and is unaffected by this skip.
    const shouldRunPhase1 = serverFlagsMap.size > 0;
    if (!shouldRunPhase1) {
      logger.debug(`[syncFlags] ${folder.path}: Phase-1 skipped — server reported no flags this cycle`);
    }
    // Collected per page and written with one chunked, yielding bulk statement
    // instead of an awaited updateEmail per row (each of which re-SELECTs the
    // row with its bodies and commits its own transaction).
    let tagUpdates: Array<{ id: string; tags: string }> = [];
    const flushTagUpdates = async (): Promise<void> => {
      if (tagUpdates.length === 0) return;
      if (typeof storage.bulkUpdateTags === 'function') {
        await storage.bulkUpdateTags(tagUpdates);
      } else {
        for (const u of tagUpdates) await storage.updateEmail(u.id, { tags: u.tags });
      }
      tagUpdates = [];
    };

    /** Reconcile one local row against the server flags. Returns true if changed. */
    const applyServerFlags = (id: string, uid: number, tags: string | null): boolean => {
      // Skip UIDs with an un-synced local flag change — otherwise the server
      // (which hasn't seen the change yet) would revert it.
      if (pendingUids.has(uid)) return false;
      const newFlags = serverFlagsMap.get(uid);
      if (!newFlags) return false;

      const currentTags = parseTags(tags || '||');
      const isSnoozed = currentTags.includes('snoozed');
      const currentFlagTags = currentTags.filter(t => flagTagNames.includes(t));
      let newFlagTags = imapFlagsToTags(newFlags);

      // Preserve local read/unread state for snoozed emails
      if (isSnoozed) {
        newFlagTags = newFlagTags.filter(t => t !== 'read');
        if (currentTags.includes('read')) newFlagTags.push('read');
      }

      if (currentFlagTags.sort().join(',') === newFlagTags.sort().join(',')) return false;

      const nonFlagTags = currentTags.filter(t => !flagTagNames.includes(t));
      tagUpdates.push({ id, tags: buildTags([...nonFlagTags, ...newFlagTags]) });
      result.updated++;
      onFlagChange?.(id, uid, newFlags);
      // Report a genuine read-state flip (ignoring star-only changes) so the
      // caller can maintain folder unread counts without a full recount.
      const oldRead = currentFlagTags.includes('read');
      const newRead = newFlagTags.includes('read');
      if (oldRead !== newRead) onReadChange?.(id, newRead);
      return true;
    };

    // Yield to the main-process event loop. better-sqlite3 is synchronous, so
    // every `await` around it resolves as a microtask and the queue drains
    // without ever reaching libuv's poll phase — a long loop would hold the
    // thread outright and stall IMAP IDLE plus every renderer IPC reply (the
    // beachball). Same guard the storage layer applies in its own chunked writes.
    const yieldToLoop = () => new Promise((resolve) => setImmediate(resolve));

    if (shouldRunPhase1) {
      const rows = await loadFolderRows();
      if (rows) {
        // Cheap path: one index-driven read of (id, uid, tags) for the folder.
        for (let i = 0; i < rows.length; i += FLAG_SYNC_BATCH) {
          for (const row of rows.slice(i, i + FLAG_SYNC_BATCH)) {
            if (row.uid) applyServerFlags(row.id, row.uid, row.tags);
          }
          await flushTagUpdates();
          if (i + FLAG_SYNC_BATCH < rows.length) await yieldToLoop();
        }
      } else {
        // Fallback for storage impls without the lightweight query (mobile).
        for (;;) {
          const batch = await storage.getEmailsByFolder(folder.id, {
            limit: FLAG_SYNC_BATCH,
            offset: flagOffset,
          });
          if (batch.length === 0) break;
          for (const email of batch) {
            // Emails linked to this folder via tags keep the uid of their PRIMARY
            // folder (linkEmailToFolder ignores its uid param) — matching a foreign
            // uid against this folder's UID space would apply flags from an
            // unrelated message. Only trust uids that came from this folder.
            if (email.folderId !== folder.id || !email.uid) continue;
            applyServerFlags(email.id, email.uid, email.tags ?? null);
          }
          await flushTagUpdates();
          if (batch.length < FLAG_SYNC_BATCH) break;
          flagOffset += FLAG_SYNC_BATCH;
          await yieldToLoop();
        }
      }
    }
    await flushTagUpdates();

    // Phase 1 finished — every flag change up to the current modseq is now
    // applied locally, so persist that modseq (paired with its uidValidity) as
    // the new delta baseline. This runs for BOTH paths: the first (full) sync
    // stores its modseq to enable the delta next time, and the delta path
    // advances it. Deliberately BEFORE the Phase-2 returns below (deletion
    // detection is orthogonal to flag-reconciliation and its safety guards may
    // legitimately skip). Only when the server reports a modseq — a
    // non-CONDSTORE server leaves highest_modseq null and always takes the full
    // path. Best-effort: a persist failure must not fail the sync, only forgo
    // the optimization next cycle.
    if (typeof currentModseq === 'number' && currentModseq > 0) {
      const folderUpdate: Partial<FolderRecord> = { highestModseq: currentModseq };
      // Persist uidValidity only when it's the SAME as stored (or first sync). A
      // changed validity is handled by the early bail above + the folder-sync
      // re-key; never adopt it here (that defeated the wipe). Belt-and-suspenders
      // in case a future edit removes the early return.
      if (typeof currentUidValidity === 'number' && Number.isFinite(currentUidValidity) && currentUidValidity > 0 &&
          (folder.uidValidity == null || folder.uidValidity === currentUidValidity)) {
        folderUpdate.uidValidity = currentUidValidity;
      }
      try {
        await storage.updateFolder(folder.id, folderUpdate);
      } catch (err) {
        logger.warn(`Failed to persist highestModseq for ${folder.path}: ${(err as Error).message}`);
      }
    }

    // PHASE 2: Detect server-side deletions.
    //
    // We diff EVERY local UID whose primary folder is this one against the
    // server's COMPLETE UID set (serverUidsSet — filled from `1:* FLAGS` on the
    // full path or `SEARCH ALL` on the CONDSTORE path, so it's the whole folder
    // in both). The previous version only checked the 200 most-recent local
    // rows, so a server-side delete of an OLDER message (common on non-CONDSTORE
    // servers like Sarv, where there's no modseq/VANISHED delta) was never
    // detected — the row orphaned locally as a ghost with a dead UID. The safety
    // guards below (server-empty → skip, >50% missing → skip) make the
    // whole-folder diff safe against a partial/bad server fetch.
    // Skip when explicitly disabled, OR when we DON'T have the complete server
    // UID set this sync (CONDSTORE delta path on a throttled tick) — a partial/
    // empty set must never drive deletion.
    // ADDITION-ONLY pass. On a large mailbox `deletionSetReady` is false on every
    // sync by design (the whole-folder enumeration is what we refuse to run), so
    // this early return used to take the ADDITION reconcile down with it — and the
    // addition reconcile is the only thing that repairs mail which never landed
    // locally. A big INBOX could therefore sit permanently short of the server with
    // no path back, which is exactly how a wedged forward sync turns into missing
    // mail that never reappears. The recent window IS a complete server list for
    // its date range, so run additions from it and stop before the deletion diff.
    const additionOnly = !deletionSetReady && windowSetReady && options?.skipDeletion !== true;
    if (options?.skipDeletion || (!deletionSetReady && !additionOnly)) {
      logger.info(
        `[syncFlags] ${folder.path}: Phase-2 deletion SKIPPED — skipDeletion=${options?.skipDeletion === true}, deletionSetReady=${deletionSetReady}, condstore=${client.supportsCondstore()}, force=${options?.forceDeletion === true}, serverUids=${serverUidsSet.size}`,
      );
      return result;
    }

    // WHOLE-folder local UIDs (cheap id+uid query). Falls back to the recent-200
    // window on storage impls that lack the lightweight query. The primary-folder
    // filter (folder_id = this folder) is the same cross-folder guard as Phase 1:
    // an email whose primary folder is elsewhere carries a foreign uid, so
    // "missing from this folder's UID space" is expected, not a deletion.
    let folderUids: Array<{ id: string; uid: number }>;
    const sharedRows = await loadFolderRows();
    if (sharedRows) {
      // Reuse the single read Phase 1 already paid for (or take it now if Phase 1
      // was skipped) — this used to be a second full scan of the same rows.
      folderUids = sharedRows
        .filter((r): r is { id: string; uid: number; tags: string } => !!r.uid)
        .map((r) => ({ id: r.id, uid: r.uid }));
    } else if (typeof storage.getEmailUidsInFolder === 'function') {
      folderUids = await storage.getEmailUidsInFolder(folder.id);
    } else {
      folderUids = (await storage.getEmailsByFolder(folder.id, { limit: 200, offset: 0 }))
        .filter(e => e.folderId === folder.id && e.uid)
        .map(e => ({ id: e.id, uid: e.uid! }));
    }
    const localUids = folderUids.map(e => e.uid);
    // NOT an early return. `localUids` counts only rows whose PRIMARY folder_id
    // is this folder, and a Gmail label mirror has NONE of those — every message
    // in `Sarv Inbox/Access` lives primarily in All Mail and belongs here by tag.
    // Returning here skipped the ADDITION reconcile for exactly those folders, so
    // a mirror folder could never recover mail it was missing. With no local uids
    // the deletion diff below simply finds nothing to delete, which is correct:
    // there is nothing in this folder's uid space to delete.
    if (localUids.length === 0) {
      logger.debug(`[syncFlags] ${folder.path}: no rows in this folder's own UID space — deletion diff is a no-op, addition reconcile still runs`);
    }

    // Completeness guard for whole-folder detection: a `1:* FLAGS` fetch / SEARCH
    // ALL streams low→high, so a mid-stream connection drop truncates the NEWEST
    // UIDs. If our newest LOCAL uid is beyond the newest the SERVER returned, the
    // server list is likely partial — diffing against it would falsely "delete"
    // the whole truncated tail. Skip. (A genuine deletion of the very newest
    // message is rare; leaving one stale row is far safer than mass-deleting on a
    // partial fetch. The next full sync with a complete list will catch it.)
    let serverMaxUid = 0;
    for (const u of serverUidsSet) if (u > serverMaxUid) serverMaxUid = u;
    let localMaxUid = 0;
    for (const u of localUids) if (u > localMaxUid) localMaxUid = u;
    // The server UID list is PROVABLY complete when we received at least as many
    // UIDs as the mailbox says it holds (EXISTS). In that case localMaxUid >
    // serverMaxUid is NOT a truncated fetch — it's a genuine deletion of the
    // NEWEST message(s) (e.g. the top mails moved to Trash from webmail). Without
    // this, the guard below skipped ALL deletions whenever the newest local mail
    // was the one deleted, so webmail-trashed top mail never left the app inbox.
    const serverListComplete = serverExists != null && serverUidsSet.size >= serverExists;

    // PROVENANCE guard — does this UID set even belong to this folder?
    //
    // Every guard above asks whether the server list is COMPLETE. None of them
    // asks whether it is THIS MAILBOX'S list, and all three are defeated by a
    // wrong list that is LARGER than the folder: on 2026-09-13 a recycled pooled
    // connection enumerated INBOX while the code believed it held "Interview",
    // and 24,662 INBOX UIDs arrived for a 917-message folder. size >= exists made
    // serverListComplete TRUE, local max 985 < server max 27394 passed the
    // truncation guard, and the 46% missing ratio sat under the 50% ceiling — so
    // the completeness check AUTHORISED deleting 410 live messages.
    //
    // Two cheap facts the mailbox itself reports settle provenance:
    //  - UIDNEXT: nothing in this folder can carry a UID at or above it.
    //  - EXISTS: a complete list is about as long as the folder is, never orders
    //    of magnitude longer (slack for mail arriving mid-enumeration).
    // Either one failing means the list came from somewhere else. Skip the whole
    // reconcile — a wrong list must never reach the deletion diff.
    const serverUidNext = typeof currentState?.uidNext === 'number' ? currentState.uidNext : null;
    if (serverUidNext != null && serverMaxUid >= serverUidNext) {
      logger.error(
        `[syncFlags] ${folder.path}: ABORTED — server UID list contains UID ${serverMaxUid} at/above this folder's UIDNEXT ${serverUidNext}; the list is not this mailbox's. Skipping flag/deletion reconcile.`,
      );
      return result;
    }
    const EXISTS_OVERSHOOT_SLACK = 100;
    if (serverExists != null && serverUidsSet.size > serverExists * 2 + EXISTS_OVERSHOOT_SLACK) {
      logger.error(
        `[syncFlags] ${folder.path}: ABORTED — server UID list has ${serverUidsSet.size} UIDs but the mailbox reports EXISTS=${serverExists}; the list is not this mailbox's. Skipping flag/deletion reconcile.`,
      );
      return result;
    }

    // A pure Gmail label mirror has NO rows in its own folder_id UID space (every
    // message lives primarily in All Mail), so every UID in the window would look
    // "missing" on every sync and we'd re-fetch and re-link the same window forever
    // without converging. Those folders are covered by All Mail's own reconcile.
    // Whole-folder mode is unaffected — it has the tag-count gate for this.
    const additionFromWindow = additionOnly && localUids.length > 0;
    // `localUidSpace`, NOT `local`. This counts only rows whose PRIMARY folder is
    // this one; a message linked here by tag (its primary copy living in another
    // folder — every Gmail label, and anything moved) is absent from it by
    // design. Printed as "local" beside a server total it reads as a message
    // deficit, and it is not one: an INBOX showing localUidSpace=1873 against
    // server=1957 held 1954 of those 1957 by tag and was three short, not
    // eighty-four. Hours went into chasing that phantom gap. The comparable
    // number is the tag count, which the addition reconcile below logs as
    // `tagged` — the two are different questions and must not look alike.
    logger.info(
      `[syncFlags] ${folder.path}: Phase-2 running — localUidSpace=${localUids.length} (max ${localMaxUid}; rows primary to this folder — NOT comparable to server total), server=${serverUidsSet.size} (max ${serverMaxUid}, exists ${serverExists ?? '?'}), complete=${serverListComplete}`
      + `${additionOnly ? `, ADDITION-ONLY from ${windowedUidsSet.size}-uid recent window${additionFromWindow ? '' : ' (skipped — no rows in this folder\'s own UID space)'}` : ''}`,
    );
    if (serverMaxUid > 0 && localMaxUid > serverMaxUid && !serverListComplete) {
      logger.warn(`Deletion detection for ${folder.path}: local max UID ${localMaxUid} > server max ${serverMaxUid} (server has ${serverUidsSet.size}, exists ${serverExists ?? '?'}), server list may be partial — skipping`);
      return result;
    }

    // ADDITION reconcile — the mirror of the deletion pass below. If the server
    // lists UIDs the DB does NOT have (and its list is trustworthy), those are
    // messages that never landed locally: a failed insert, or a windowed initial
    // sync that skipped mid-range UIDs. Neither the forward sync (uid > last) nor
    // the backfill (uid < oldest) ever re-fetches these MID-RANGE holes, so a
    // folder silently drifts short of the server — the parity bug where Sent
    // showed 100 of 108. Fetch the missing ones and insert them. BOUNDED: only
    // when the server list is COMPLETE (so "missing" is real, not a truncated
    // fetch) and the gap is small; a bigger shortfall is a fresh/gutted folder the
    // bulk backfill handles. Runs BEFORE the deletion pass and never touches it.
    if ((serverListComplete || additionFromWindow) && typeof client.fetchMessagesByUID === 'function') {
      const localUidSet = new Set(localUids);
      // Whole-folder list when we have one, otherwise the recent window — both are
      // COMPLETE for the range they claim to cover, which is all this pass needs.
      const additionSource = additionFromWindow ? windowedUidsSet : serverUidsSet;
      // NEW mail (uid above the sync watermark) is NOT this pass's job — the
      // forward sync fetches it moments later, as live mail. Reconciling it here
      // instead inserted it with `quiet: true`, which suppresses BOTH the
      // `email:synced` pipeline emit (no AI categorisation, no body prefetch) and
      // the renderer's `new-email` event (no notification, no live list update).
      // The user's mail simply appeared later with no sign it had arrived, and the
      // following getNewMessages reported "0 inserted" because this pass had
      // already taken them.
      const syncWatermark = folder.lastSyncUid || 0;
      const missingFromLocal = [...additionSource].filter(
        (uid) => uid <= syncWatermark && !localUidSet.has(uid) && !pendingUids.has(uid),
      );

      // `localUids` counts only rows whose PRIMARY folder_id is this folder. A
      // message that lives primarily in ANOTHER folder but also belongs here — a
      // reply that landed in both Inbox and Sent — carries this folder's TAG, so it
      // already shows in the folder view, but it never enters this folder's
      // folder_id UID space. Such a message shows up in `missingFromLocal` on EVERY
      // sync; re-fetching + re-linking it each cycle is pure waste and never
      // converges. Gate on the TAG-based membership count (what the view renders):
      // once it accounts for every server message, nothing is genuinely absent.
      let genuinelyMissing = missingFromLocal.length;
      let tagCount: number | null = null;
      if (missingFromLocal.length > 0 && serverExists != null && typeof storage.countEmailsWithFolderTag === 'function') {
        try {
          tagCount = await storage.countEmailsWithFolderTag(folder.path);
          genuinelyMissing = Math.max(0, serverExists - tagCount);
        } catch { /* fall back to the folder_id diff */ }
      }

      // Exclude UIDs we've already fetched this session and that made no progress
      // (present in another folder, no folder_id-space uid here). Without this the
      // reconcile re-fetched the SAME newest 200 every sync — all no-ops — and the
      // genuinely-missing older UIDs never got a turn, so the folder plateaued short
      // of the server forever. Draining the UNtried candidates lets real gaps fill.
      const tried = this.reconcileTriedUids.get(folder.path);
      const drainable = tried ? missingFromLocal.filter((uid) => !tried.has(uid)) : missingFromLocal;

      if (missingFromLocal.length > 0 && genuinelyMissing === 0) {
        // Fully covered by tags → converged. Free the per-folder tried-set (mirrors
        // the drain, which clears on convergence) so it doesn't hold UIDs for the
        // session after the gap is closed.
        this.reconcileTriedUids.delete(folder.path);
        logger.debug(`[syncFlags] ${folder.path}: ${missingFromLocal.length} UID(s) outside folder_id space already present by tag (${tagCount}/${serverExists}) — nothing to reconcile`);
      } else if (genuinelyMissing > 0 && drainable.length === 0) {
        // Every candidate has been fetched once already this session; the residual
        // gap is messages this pass can't resolve (present-elsewhere, or a count
        // artefact). Re-fetching them would just re-loop — wait for a restart /
        // the downward backfill instead of hammering the same no-ops.
        logger.debug(`[syncFlags] ${folder.path}: ${genuinelyMissing} still unaccounted but all ${missingFromLocal.length} candidate UID(s) already tried this session — not re-fetching`);
      } else if (genuinelyMissing > 0) {
        // DRAIN, don't defer: fetch up to ADDITION_RECONCILE_MAX of the missing UIDs
        // THIS sync; a larger gap fills across successive syncs. (Previously a gap >
        // MAX was "left to the backfill" — but the backfill is downward-only, can't
        // fill mid-range holes, and latches backfillComplete while still short, so a
        // big gap stranded forever: e.g. an INBOX stuck at local=1165/server=3215 for
        // days. Newest-missing first so recent mail fills soonest.) Bounded per sync so
        // a huge gap can't stall the loop; runs only while serverListComplete.
        const ordered = drainable.slice().sort((a, b) => b - a);
        const toFetch = ordered.slice(0, ADDITION_RECONCILE_MAX);
        const remaining = ordered.length - toFetch.length;
        logger.info(`[syncFlags] ${folder.path}: addition reconcile — ${genuinelyMissing} genuinely missing (server ${serverExists ?? '?'}, tagged ${tagCount ?? '?'}); fetching ${toFetch.length} of ${drainable.length} untried this sync${remaining > 0 ? ` (${remaining} remaining next sync)` : ''}`);
        // Fetch in small sub-batches: one giant UID FETCH times out on a slow server and
        // inserts nothing (all-or-nothing). Sub-batching keeps each FETCH under the op
        // timeout and makes partial progress durable — if a later sub-batch fails, the
        // earlier ones are already inserted and the rest drains next sync.
        let inserted = 0, linked = 0, unchanged = 0, attempted = 0;
        const triedSet = tried ?? new Set<number>();
        for (let i = 0; i < toFetch.length; i += ADDITION_FETCH_BATCH) {
          const sub = toFetch.slice(i, i + ADDITION_FETCH_BATCH);
          try {
            const fetched = await client.fetchMessagesByUID(sub, {
              fetchHeaders: true,
              fetchBody: false,          // header-only; bodies backfill lazily
              fetchBodyStructure: true,
            });
            attempted += sub.length;
            if (fetched.length > 0) {
              const r = await this.processBatch(fetched, folder, storage, undefined, { quiet: true });
              inserted += r.inserted;
              // Keep these apart. `updated` is real convergence (a row gained
              // this folder's tag); `skipped` is a no-op (the row already had
              // it, or the Message-ID was a duplicate within the batch).
              // Reporting their SUM as "linked" made a reconcile that achieved
              // nothing read as one that placed every message — a gap that never
              // closes while the log says it is closing every cycle. That line
              // cost real debugging time; the two numbers must stay separate.
              linked += r.updated;
              unchanged += r.skipped;
              // Mark tried ONLY the UIDs the server RETURNED and we actually
              // ACCOUNTED FOR (stored, matched, or permanently unprocessable). A UID
              // requested-but-not-returned (partial FETCH) or one that hit a
              // TRANSIENT per-message error is NOT marked — it must be retried, not
              // suppressed for the session on one flaky response.
              const errored = new Set(r.erroredUids);
              for (const m of fetched) if (!errored.has(m.uid)) triedSet.add(m.uid);
            }
            // This header FETCH runs under a 60s op timeout; two of them chained
            // (ADDITION_RECONCILE_MAX / ADDITION_FETCH_BATCH) held a pooled
            // connection ~124s — past the 120s stuck-eviction — and got reclaimed
            // mid-run, poisoning the socket and cascading into the reconnect storm.
            // Heartbeat after each completed sub-batch so a progressing reconcile
            // keeps its connection.
            touch?.();
          } catch (e) {
            logger.warn(`[syncFlags] ${folder.path}: addition reconcile sub-batch failed (${inserted} inserted so far, rest next sync): ${(e as Error).message}`);
            break; // keep what stuck; the remainder drains on the next sync
          }
        }
        // Cap the per-folder tried-set so it can't grow without bound; clearing it
        // just means the next sync re-verifies from scratch (correct, only slower).
        if (triedSet.size > MessageProcessor.RECONCILE_TRIED_CAP) triedSet.clear();
        this.reconcileTriedUids.set(folder.path, triedSet);
        // Always report the outcome, including "nothing changed". A reconcile
        // that fetches messages and places none of them is the signature of a
        // gap that cannot close, and staying silent about it is what let one run
        // unnoticed: the only visible line said `linked 53` every cycle, which
        // read as progress. `unchanged` is that case, named.
        if (attempted > 0) {
          logger.info(
            `[syncFlags] ${folder.path}: addition reconcile inserted ${inserted}, linked ${linked}, `
            + `unchanged ${unchanged}, of ${attempted} attempted`
            + `${inserted + linked === 0 ? ' — NO PROGRESS: every message was already present' : ''}`,
          );
        }
        if (inserted + linked > 0) {
          // Recount HERE rather than reporting upwards. syncFlags returns only
          // {updated, deleted} — flag changes and expunges — and every one of its
          // six callers gates its recount on exactly those two numbers. So a pass
          // that inserted or relinked hundreds of messages left the folder's
          // stored counts untouched: observed live as an INBOX badge frozen at 5
          // while the folder actually held 15 unread, with `linked 200` logged on
          // every sync. Scoped to this folder so it stays on the cheap targeted
          // path (a full recount is a ~200ms synchronous main-thread stall);
          // membership this batch added to OTHER folders via Gmail labels is
          // picked up when those folders sync.
          await refreshCountsForFolders(storage, [folder.path], `addition reconcile of ${folder.path}`);
        }
      }
    }

    // STOP before the deletion diff whenever the server list was a window. Every
    // message older than the window cutoff is legitimately absent from it, so the
    // diff below would read the entire back catalogue as server-side deletions and
    // wipe the folder. An explicit return rather than trusting the ratio guards
    // downstream: those exist to catch a partial fetch, and a 30-day window of a
    // multi-year mailbox is not "partial", it is a different question entirely.
    if (additionOnly) return result;

    // Find local emails whose UIDs are not on server. Never treat a UID with an
    // in-flight local op (pending move/delete, or a just-moved row) as a
    // server-side deletion — the same guard Phase 1 applies. Otherwise a pending
    // move/delete gets clobbered locally before it round-trips. Excluding these
    // from missingUids also keeps the missingRatio safety check meaningful
    // (it then reflects only genuine server deletions).
    const missingUids = localUids.filter(uid => !serverUidsSet.has(uid) && !pendingUids.has(uid));

    // Any non-empty server read clears the "seen empty last time" mark so a later
    // transient EXISTS-0 still needs two fresh consecutive empties (see below).
    if (serverUidsSet.size > 0) this.foldersSeenEmpty.delete(folder.id);

    if (missingUids.length > 0) {
      // Set for O(1) membership in the deletion loop below (both lists are up
      // to 200, so a linear .includes per email was ~40k comparisons).
      const missingUidSet = new Set(missingUids);
      const missingRatio = missingUids.length / localUids.length;

      // Safety check 1: server returned no UIDs at all — likely a connection/
      // fetch problem. Test the FULL uid set (serverUidsSet), NOT the flag data:
      // in the delta path the flag delta is legitimately empty when nothing
      // changed while the folder is still full, so gating on the delta size
      // would falsely skip real deletions. serverUidsSet is the whole server
      // UID space in both paths, so an empty one genuinely means "server has
      // nothing" and still trips this guard.
      // Safety check 1: server returned no UIDs at all for a folder we still hold
      // mail in. This is EITHER a genuine remote-empty OR a transient blip — and
      // serverListComplete can't tell them apart (a spurious EXISTS 0 makes
      // 0>=0 → "complete", which is exactly how a flaky server used to wipe a full
      // folder). So require the empty read to REPEAT: defer on the first empty,
      // act only when a SECOND consecutive read is also empty. A real empty stays
      // empty; a blip is gone by the next sync. (Trash/Spam "empty folder" from
      // another client simply clears one sync later — acceptable vs wiping mail.)
      if (serverUidsSet.size === 0 && localUids.length > 5) {
        if (!this.foldersSeenEmpty.has(folder.id)) {
          this.foldersSeenEmpty.add(folder.id);
          logger.warn(`Server returned 0 UIDs but we have ${localUids.length} local emails in ${folder.path} — deferring deletion until a second confirming empty read (possible transient)`);
          return result;
        }
        // Only claim we're applying when we actually will: a truly-empty folder has
        // serverExists===0 → serverListComplete true → the ratio guard below lets
        // it through. If serverExists is unknown (null), serverListComplete is false
        // and Safety check 2 defers anyway, so don't log a misleading "applying".
        if (serverListComplete) {
          logger.info(`${folder.path}: server empty on two consecutive reads — applying deletion of ${localUids.length} local row(s)`);
        }
      }

      // Safety check 2: a >50% missing ratio usually means a partial/failed fetch, not
      // real mass deletion — UNLESS the server UID list is PROVEN complete
      // (serverUidsSet.size >= serverExists, computed above as serverListComplete). A
      // message absent from a COMPLETE server list is genuinely expunged (e.g. server
      // retention auto-expired thousands), so applying it is authoritative, not a
      // guess — this is exactly what lets a drifted folder self-heal instead of piling
      // up stale rows forever behind the guard. Only skip when completeness is NOT
      // proven (the failure mode the guard actually protects against: a truncated
      // fetch would leave serverUidsSet.size < serverExists → serverListComplete false).
      if (missingRatio > 0.5 && missingUids.length > 5 && !serverListComplete) {
        logger.warn(`Suspicious deletion: ${missingUids.length}/${localUids.length} UIDs missing (${Math.round(missingRatio * 100)}%), skipping (fetch likely incomplete)`);
        return result;
      }
      if (missingRatio > 0.5 && missingUids.length > 5) {
        logger.info(`[syncFlags] ${folder.path}: applying large deletion — ${missingUids.length}/${localUids.length} missing but server list is COMPLETE (${serverUidsSet.size}>=${serverExists}), so these are genuine expiries`);
      }

      logger.info(`Syncing ${missingUids.length} deleted emails in ${folder.path} (server has ${serverUidsSet.size}, local has ${localUids.length})`);

      // Unlink-or-delete rather than a blind bulk delete: a message that VANISHED
      // from THIS folder but still carries another folder's tag (a webmail move
      // BACK into another folder that a concurrent sync already relinked, or a
      // Gmail label) must NOT be destroyed — only its membership here is dropped.
      // Only messages with no other folder survive as a real delete.
      const doomed = folderUids.filter((e) => missingUidSet.has(e.uid));
      // Chunk the apply: a genuine mass-expiry can be tens of thousands of rows, and
      // one unlinkOrDelete transaction that big blocks the (synchronous) main thread.
      // 500/chunk keeps each transaction short.
      const DELETE_CHUNK = 500;
      // Per-row onDeleted drives an in-place UI removal event each — perfect for a
      // normal delete, but a mass reconcile (thousands of expired rows) would flood
      // the IPC bridge. Above the cap, skip per-row events; the folder isn't being
      // viewed at that size and reloads fresh (correct count) on next open, and the
      // caller recounts the badge after sync regardless.
      const EMIT_PER_ROW_MAX = 500;
      const emitPerRow = doomed.length <= EMIT_PER_ROW_MAX;
      for (let i = 0; i < doomed.length; i += DELETE_CHUNK) {
        const chunk = doomed.slice(i, i + DELETE_CHUNK);
        await storage.unlinkOrDeleteEmailsFromFolder(chunk.map((e) => e.id), folder.id);
        if (emitPerRow) for (const e of chunk) onDeleted?.(e.id, e.uid);
      }
      result.deleted = doomed.length;
      if (!emitPerRow) {
        logger.info(`[syncFlags] ${folder.path}: ${doomed.length} rows reconciled (bulk — per-row UI events skipped; folder reloads fresh on open)`);
      }
    }

    // PHASE 2b: stale TAG-ONLY memberships. The diff above only sees rows whose
    // PRIMARY folder is this one. A message whose primary is elsewhere — a copy
    // Trash's sync linked onto an existing INBOX row, a Gmail label — belongs
    // here purely by TAG, and if it later leaves this folder on the server
    // (webmail delete/move while the app was closed, so no expunge was seen),
    // nothing ever drops the tag: the row stays |INBOX|Trash| forever, the
    // badge counts it, the list hides it. Only with a COMPLETE server list can
    // "not here" be trusted, so this runs under the same proof as the diff.
    if (serverListComplete && serverExists != null) {
      try {
        const unlinked = await this.sweepStaleMemberships(
          client, folder, storage, serverUidsSet, serverExists, localUids, onDeleted, touch,
        );
        // Counted as a deletion: every caller gates its badge recount on
        // `deleted`, and a dropped membership changes the folder's counts.
        result.deleted += unlinked;
      } catch (err) {
        // A failed sweep leaves stale tags in place until the next sync — a
        // cosmetic lag, never worth failing the flag sync over.
        logger.warn(`[syncFlags] ${folder.path}: stale-membership sweep failed: ${(err as Error).message}`);
      }
    }

    return result;
  }

  /**
   * Phase 2b worker (see syncFlags). Finds the tag-only members of `folder`,
   * decides arithmetically whether ANY of them can be stale, and only then
   * verifies candidates one HEADER Message-ID search at a time, unlinking the
   * folder's tag from those the server no longer has.
   *
   * The arithmetic gate: the server holds `serverExists` messages; `accounted`
   * of them are our primary rows still present (localUids ∩ serverUidsSet). Every
   * OTHER server message can at most be one tag-only member. So if the tag-only
   * set is no bigger than the unaccounted remainder, it can be entirely
   * legitimate and nothing is searched — this keeps a converged folder (Gmail
   * label mirrors, Inbox+Sent replies) at zero extra round-trips per sync.
   *
   * Returns the number of memberships unlinked (rows are unlinked-or-deleted, so
   * a message that lives elsewhere is never destroyed — only its tag here goes).
   */
  private async sweepStaleMemberships(
    client: IIMAPClient,
    folder: FolderRecord,
    storage: IEmailStorage,
    serverUidsSet: Set<number>,
    serverExists: number,
    localUids: number[],
    onDeleted?: (emailId: string, uid: number) => void,
    touch?: () => void,
  ): Promise<number> {
    if (typeof storage.getFolderMembersOutsideUidSpace !== 'function' || typeof client.search !== 'function') return 0;
    const members = await storage.getFolderMembersOutsideUidSpace(folder.id, folder.path);
    if (members.length === 0) {
      this.staleSweepVerified.delete(folder.path);
      return 0;
    }

    let accounted = 0;
    for (const u of localUids) if (serverUidsSet.has(u)) accounted++;
    const unaccounted = Math.max(0, serverExists - accounted);
    if (members.length <= unaccounted) return 0; // all tag-only members can be real — converged

    const verified = this.staleSweepVerified.get(folder.path) ?? new Set<string>();
    const folderPathById = new Map((await storage.getFolders()).map((f) => [f.id, f.path] as const));
    const pendingByFolder = new Map<string, Set<number>>();
    // At least (members − unaccounted) are stale; verify at most that many PLUS
    // the legitimate ones we pass on the way, bounded by the search cap.
    let searched = 0;
    let unlinked = 0;
    for (const m of members) {
      if (verified.has(m.id) || !m.messageId) continue;
      if (searched >= MessageProcessor.STALE_SWEEP_MAX_SEARCHES) break;
      // A pending local op on the row's primary copy (a move in flight) means the
      // server view is about to change — leave it for the next sync.
      const primaryPath = folderPathById.get(m.folderId);
      if (primaryPath && m.uid != null) {
        let pending = pendingByFolder.get(primaryPath);
        if (!pending) {
          pending = (await this.pendingUidsProvider?.(primaryPath)) ?? new Set<number>();
          pendingByFolder.set(primaryPath, pending);
        }
        if (pending.has(m.uid)) continue;
      }

      searched++;
      // HEADER search without angle brackets — servers substring-match the raw
      // header value and a bracketed query misses on some (same as body fetch).
      const bare = m.messageId.replace(/^<|>$/g, '');
      let hits: number[];
      try {
        hits = await withFolderSelected(client, folder.path, () =>
          client.search({ header: [{ name: 'message-id', value: bare }] }));
      } catch (err) {
        // The SEARCH failed: evidence about the CONNECTION, not the message. Stop
        // the sweep here (nothing unlinked on a guess); the next sync asks again.
        logger.warn(`[syncFlags] ${folder.path}: stale-membership HEADER search failed after ${searched - 1} check(s): ${(err as Error).message}`);
        break;
      }
      touch?.();
      if (hits.length > 0) {
        verified.add(m.id);
        continue;
      }
      // Zero hits from a server whose list we hold complete IS a verdict.
      await storage.unlinkOrDeleteEmailsFromFolder([m.id], folder.id);
      onDeleted?.(m.id, m.uid ?? 0);
      unlinked++;
    }

    if (verified.size > MessageProcessor.RECONCILE_TRIED_CAP) verified.clear();
    this.staleSweepVerified.set(folder.path, verified);
    if (unlinked > 0) {
      logger.info(`[syncFlags] ${folder.path}: stale-membership sweep unlinked ${unlinked} tag-only member(s) no longer on the server (${searched} searched, ${members.length} tag-only, ${unaccounted} unaccounted)`);
    }
    return unlinked;
  }
}
