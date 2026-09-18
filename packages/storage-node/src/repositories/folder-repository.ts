// Folder Repository - All folder-related database operations

import type { FolderRecord } from '@sarvinbox/core';
import { addTag, removeTag, parseTags, buildTags, tagsToImapFlags, imapFlagsToTags, FLAG_TAG_NAMES, createLogger } from '@sarvinbox/core';
import type { Statement } from 'better-sqlite3';

import { BaseRepository, type DatabaseAccessor } from './base-repository';
import {
  isShadowedInFolder,
  READ_MODEL_UNREAD_COUNT_CORRELATED_SQL,
  READ_MODEL_UNREAD_COUNT_SQL,
  readModelComplete,
  unreadInFolderPredicate,
} from './thread-sql';

const logger = createLogger('FolderRepository');

/**
 * Repository for folder operations
 */
export class FolderRepository extends BaseRepository {
  constructor(getDb: DatabaseAccessor) {
    super(getDb);
  }

  /**
   * Sync folders (insert or update). The folder-list sync passes null
   * sync-state fields — COALESCE keeps the existing uid_validity /
   * last_sync_uid / last_sync_time so incremental sync isn't reset.
   */
  async sync(folders: FolderRecord[]): Promise<void> {
    const upsert = this.db.transaction((folders: FolderRecord[]) => {
      const stmt = this.db.prepare(`
        INSERT INTO folders (
          id, name, path, parent_id,
          uid_validity, last_sync_uid, last_sync_time, highest_modseq,
          total_count, unread_count,
          special_use, subscribed
        ) VALUES (
          @id, @name, @path, @parentId,
          @uidValidity, @lastSyncUid, @lastSyncTime, @highestModseq,
          @totalCount, @unreadCount,
          @specialUse, @subscribed
        )
        ON CONFLICT(id) DO UPDATE SET
          name = @name,
          parent_id = @parentId,
          uid_validity = COALESCE(@uidValidity, uid_validity),
          last_sync_uid = COALESCE(@lastSyncUid, last_sync_uid),
          last_sync_time = COALESCE(@lastSyncTime, last_sync_time),
          highest_modseq = COALESCE(@highestModseq, highest_modseq),
          special_use = @specialUse,
          subscribed = @subscribed
      `);

      for (const folder of folders) {
        stmt.run({
          id: folder.id,
          name: folder.name,
          path: folder.path,
          parentId: folder.parentId,
          uidValidity: folder.uidValidity,
          lastSyncUid: folder.lastSyncUid,
          lastSyncTime: folder.lastSyncTime,
          highestModseq: folder.highestModseq ?? null,
          totalCount: folder.totalCount,
          unreadCount: folder.unreadCount,
          specialUse: folder.specialUse,
          subscribed: folder.subscribed ? 1 : 0,
        });
      }

      // Reconcile deletions. The folder-list sync always passes the COMPLETE
      // server list (client.list()), so any LOCAL folder whose id isn't in it
      // has been removed server-side — e.g. an AI category label we migrated
      // from a flat top-level folder to the nested "Sarv Inbox" tree, or a
      // folder the user deleted in webmail. Prune those so they stop lingering
      // in the sidebar.
      //
      // SAFETY: only prune folders that hold NO emails. `emails.folder_id` has
      // ON DELETE CASCADE, so deleting a folder that still has local mail would
      // silently delete that mail — never acceptable as a side effect of a
      // folder LIST. A vanished folder that still has mail is left untouched for
      // the separate email-deletion reconcile to handle. Guarded on a non-empty
      // list so a transient empty LIST can't wipe the sidebar.
      if (folders.length > 0) {
        const ids = folders.map((f) => f.id);
        const placeholders = ids.map(() => '?').join(',');
        const prune = this.db.prepare(
          `DELETE FROM folders
             WHERE id NOT IN (${placeholders})
               AND NOT EXISTS (SELECT 1 FROM emails e WHERE e.folder_id = folders.id)`,
        );
        const info = prune.run(...ids);
        if (info.changes > 0) {
          logger.info(`Pruned ${info.changes} folder(s) deleted server-side (empty — no mail affected)`);
        }
      }
    });

    upsert(folders);
  }

  /**
   * Get all folders
   */
  async getAll(): Promise<FolderRecord[]> {
    const rows = this.db
      .prepare('SELECT * FROM folders ORDER BY path ASC')
      .all() as any[];

    return rows.map(row => this.rowToRecord(row));
  }

  /**
   * Get folder by ID
   */
  async get(id: string): Promise<FolderRecord | null> {
    const row = this.db
      .prepare('SELECT * FROM folders WHERE id = ?')
      .get(id) as any;

    return row ? this.rowToRecord(row) : null;
  }

  /**
   * Get folder by path
   */
  async getByPath(path: string): Promise<FolderRecord | null> {
    const row = this.db
      .prepare('SELECT * FROM folders WHERE path = ?')
      .get(path) as any;

    return row ? this.rowToRecord(row) : null;
  }

  /**
   * Update folder
   */
  async update(id: string, updates: Partial<FolderRecord>): Promise<void> {
    const { setClauses, params } = this.buildUpdateClauses(updates, {
      boolFields: ['subscribed', 'backfillComplete', 'syncEnabled'],
    });

    if (setClauses.length === 0) return;

    params.id = id;
    this.db.prepare(`
      UPDATE folders
      SET ${setClauses.join(', ')}
      WHERE id = @id
    `).run(params);
  }

  /**
   * Delete folder
   */
  async delete(id: string): Promise<void> {
    this.db.prepare('DELETE FROM folders WHERE id = ?').run(id);
  }

  /**
   * Link an email to a folder (adds folder path as a tag).
   *
   * When the folder is the email's OWN primary folder (`emails.folder_id`), also
   * refresh `emails.uid` to the server's current value for that folder. The
   * primary uid is the single (folder_id, uid) the deletion/expunge reconcile
   * matches on, so it must track the server — e.g. after an external move BACK
   * into a folder repoints the primary and clears the uid (see
   * `unlinkOrDeleteFromFolder`), the next sync of that folder fills it here.
   * A uid is only touched for the primary folder, never for a secondary
   * label/tag, so multi-folder (Gmail label) rows keep their primary uid intact.
   */
  async linkEmail(emailId: string, folderId: string, uid?: number, _flags?: string[]): Promise<void> {
    const folder = this.db.prepare('SELECT path FROM folders WHERE id = ?').get(folderId) as any;
    if (!folder) return;

    const email = this.db.prepare('SELECT tags, folder_id, uid FROM emails WHERE id = ?').get(emailId) as any;
    if (!email) return;

    const newTags = addTag(email.tags, folder.path);
    const isPrimary = email.folder_id === folderId;
    const shouldSetUid = isPrimary && typeof uid === 'number' && uid > 0 && email.uid !== uid;

    if (newTags !== email.tags && shouldSetUid) {
      this.db.prepare('UPDATE emails SET tags = ?, uid = ? WHERE id = ?').run(newTags, uid, emailId);
    } else if (newTags !== email.tags) {
      this.db.prepare('UPDATE emails SET tags = ? WHERE id = ?').run(newTags, emailId);
    } else if (shouldSetUid) {
      this.db.prepare('UPDATE emails SET uid = ? WHERE id = ?').run(uid, emailId);
    }
  }

  /**
   * A message VANISHED from `folderId` on the server (expunged, or moved to
   * another folder). If it still belongs to OTHER folders — i.e. its tags carry
   * another real folder's path (a Gmail label, or a copy this sync already relinked
   * elsewhere) — do NOT destroy the row: drop only this folder's tag, and if this
   * folder was the primary, repoint the primary to a surviving folder (uid cleared
   * so that folder's next sync fills the correct one via `linkEmail`). Only when
   * the message belongs to no other folder is the row deleted.
   *
   * This is the fix for a webmail move (e.g. Trash → Inbox) making a message
   * disappear from BOTH folders: the destination sync relinks the row (adds the
   * new folder tag) and the source expunge then unlinks instead of deleting, so
   * the message survives in its new home. Processes a bounded id list in one
   * transaction. Returns how many rows were unlinked vs hard-deleted.
   */
  async unlinkOrDeleteFromFolder(emailIds: string[], folderId: string): Promise<{ unlinked: number; deleted: number }> {
    const result = { unlinked: 0, deleted: 0 };
    if (emailIds.length === 0) return result;

    const folder = this.db.prepare('SELECT path FROM folders WHERE id = ?').get(folderId) as { path: string } | undefined;
    if (!folder) return result;

    // All real folder paths, to tell a folder-membership tag apart from a plain
    // label/flag tag (read/starred/AI category) when scanning an email's tags.
    const allFolders = this.db.prepare('SELECT id, path FROM folders').all() as { id: string; path: string }[];
    const folderIdByPath = new Map(allFolders.map((f) => [f.path, f.id]));

    const run = this.db.transaction((ids: string[]) => {
      const selectStmt = this.db.prepare('SELECT tags, folder_id FROM emails WHERE id = ?');
      const deleteStmt = this.db.prepare('DELETE FROM emails WHERE id = ?');
      const unlinkStmt = this.db.prepare('UPDATE emails SET tags = ? WHERE id = ?');
      const repointStmt = this.db.prepare('UPDATE emails SET tags = ?, folder_id = ?, uid = NULL WHERE id = ?');

      for (const id of ids) {
        const email = selectStmt.get(id) as { tags: string; folder_id: string } | undefined;
        if (!email) continue;

        // Which OTHER real folders does this message still belong to?
        const otherFolderPaths = parseTags(email.tags).filter(
          (t: string) => t !== folder.path && folderIdByPath.has(t),
        );

        if (otherFolderPaths.length === 0) {
          deleteStmt.run(id); // last folder — the message is truly gone
          result.deleted++;
          continue;
        }

        const newTags = removeTag(email.tags, folder.path);
        if (email.folder_id === folderId) {
          // The primary pointer left with this folder — move it to a surviving
          // one; uid cleared so that folder's next sync sets the right value.
          const newPrimary = folderIdByPath.get(otherFolderPaths[0])!;
          repointStmt.run(newTags, newPrimary, id);
        } else {
          unlinkStmt.run(newTags, id);
        }
        result.unlinked++;
      }
    });
    run(emailIds);
    return result;
  }

  /**
   * Re-key a whole folder after a UIDVALIDITY change WITHOUT destroying rows that
   * live in other folders. Selects every row tagged with this folder's path and
   * runs unlink-or-delete on them: a Gmail-label / multi-folder row keeps its
   * other memberships (this folder's tag dropped, primary repointed, uid cleared
   * for a fresh re-sync); a row in no other folder is deleted. Replaces the blind
   * `deleteByFolder` hard-delete that wiped label rows still present elsewhere.
   */
  async invalidateFolderMembership(folderId: string): Promise<{ unlinked: number; deleted: number }> {
    const folder = this.db.prepare('SELECT path FROM folders WHERE id = ?').get(folderId) as { path: string } | undefined;
    if (!folder) return { unlinked: 0, deleted: 0 };
    const ids = (this.db
      .prepare(`SELECT id FROM emails WHERE instr(tags, '|' || ? || '|') > 0`)
      .all(folder.path) as Array<{ id: string }>).map((r) => r.id);
    if (ids.length === 0) return { unlinked: 0, deleted: 0 };
    return this.unlinkOrDeleteFromFolder(ids, folderId);
  }

  /**
   * Unlink an email from a folder (removes folder path tag)
   */
  async unlinkEmail(emailId: string, folderId: string): Promise<void> {
    const folder = this.db.prepare('SELECT path FROM folders WHERE id = ?').get(folderId) as any;
    if (!folder) return;

    const email = this.db.prepare('SELECT tags FROM emails WHERE id = ?').get(emailId) as any;
    if (!email) return;

    const newTags = removeTag(email.tags, folder.path);
    if (newTags !== email.tags) {
      this.db.prepare('UPDATE emails SET tags = ? WHERE id = ?').run(newTags, emailId);
    }
  }

  /**
   * Get all folders an email belongs to (from tags)
   */
  async getEmailFolders(emailId: string): Promise<{ folderId: string; uid: number | null; flags: string[] }[]> {
    const email = this.db.prepare('SELECT tags, uid, folder_id FROM emails WHERE id = ?').get(emailId) as any;
    if (!email) return [];

    const tagList = parseTags(email.tags);
    const imapFlags = tagsToImapFlags(tagList);

    // Get all folders whose path appears as a tag
    const allFolders = this.db.prepare('SELECT id, path FROM folders').all() as { id: string; path: string }[];
    const results: { folderId: string; uid: number | null; flags: string[] }[] = [];

    for (const folder of allFolders) {
      if (tagList.includes(folder.path)) {
        results.push({
          folderId: folder.id,
          uid: folder.id === email.folder_id ? email.uid : null,
          flags: imapFlags,
        });
      }
    }

    return results;
  }

  /**
   * Update flags for an email (tags-based — updates tags on email)
   */
  async updateEmailFolderFlags(emailId: string, _folderId: string, flags: string[]): Promise<void> {
    const email = this.db.prepare('SELECT tags FROM emails WHERE id = ?').get(emailId) as any;
    if (!email) return;

    const tagList = parseTags(email.tags);
    // Remove old flag-related tags
    const nonFlagTags = tagList.filter((t: string) => !(FLAG_TAG_NAMES as readonly string[]).includes(t));
    // Add new flag tags
    const newFlagTags = imapFlagsToTags(flags);
    const newTags = buildTags([...nonFlagTags, ...newFlagTags]);

    this.db.prepare('UPDATE emails SET tags = ? WHERE id = ?').run(newTags, emailId);
  }

  /** At or below this many requested folders, a targeted per-folder recount (a
   *  couple of index-free-but-C-level `instr` aggregates each) is cheaper than
   *  materialising the WHOLE emails table into JS for a single tally pass — so
   *  the hot realtime/sync path (which always recounts ONE folder) never pays the
   *  full-table scan. Above it, the single JS pass wins and is used instead. */
  private static readonly SCOPED_RECOUNT_MAX_FOLDERS = 6;

  /**
   * Recalculate totalCount and unreadCount for all folders (tags-based).
   *
   * Two strategies, chosen by how many folders the caller asked for:
   * - FEW folders (the hot path: realtime/sync/drain recount ONE folder after new
   *   mail) → {@link recountFoldersTargeted}: a handful of aggregate queries that
   *   stay entirely inside SQLite's C VM and never pull the table into JS.
   * - MANY folders (a full recount / large move) → a SINGLE table pass tallied in
   *   memory, which beats N×instr scans once N is large.
   *
   * The old code always ran the single JS pass, so even a one-folder recount read
   * every row (`SELECT thread_id, tags FROM emails`) and `split('|')`'d it — a
   * ~200ms SYNCHRONOUS main-thread stall that fired dozens of times during an
   * active sync of a big mailbox (macOS beachball / laggy UI). The targeted path
   * removes that cost from the common case; both paths produce identical numbers
   * (pinned by the scoped==full parity tests) so the full recount stays a valid
   * self-healing backstop.
   */
  async recalculateFolderCounts(folderPaths?: string[]): Promise<void> {
    const allFolders = this.db.prepare('SELECT id, path FROM folders').all() as { id: string; path: string }[];
    const wanted = folderPaths && folderPaths.length > 0 ? new Set(folderPaths) : null;
    const folders = wanted ? allFolders.filter((f) => wanted.has(f.path)) : allFolders;
    if (folders.length === 0) return;

    // ONE definition of "unread in this folder" whenever the read model can give
    // it (see readModelUnreadUsable): the badge is then counting exactly the rows
    // the unread-filtered list renders, so the two cannot disagree. The tags scan
    // below stays as the fallback for a DB whose backfill hasn't finished.
    const fromReadModel = this.readModelUnreadUsable();

    if (folders.length <= FolderRepository.SCOPED_RECOUNT_MAX_FOLDERS) {
      this.recountFoldersTargeted(folders, fromReadModel);
    } else {
      this.recountFoldersFullScan(folders, fromReadModel);
    }
  }

  /**
   * May `unread_count` be taken from the materialized read model?
   *
   * Two conditions, both necessary:
   *  - the backfill is COMPLETE (`readModelComplete`) — a partial projection
   *    would silently UNDER-report, which is the failure mode that looks like
   *    "my mail disappeared";
   *  - the dirty queue is EMPTY — `thread_folders` is rebuilt asynchronously, so
   *    a pending row means the projection is one drain behind the `emails` table
   *    and a recount fired right after a write (a move, a bulk action) would
   *    store a number that was true a moment ago. With rows pending we recount
   *    from `emails`, which is always current, and the drain's own refresh
   *    re-states the badge from the read model as soon as it catches up.
   */
  private readModelUnreadUsable(): boolean {
    try {
      if (!readModelComplete(this.db)) return false;
      const dirty = this.db.prepare('SELECT EXISTS(SELECT 1 FROM read_model_dirty) AS pending').get() as
        { pending: number } | undefined;
      return (dirty?.pending ?? 0) === 0;
    } catch {
      // No read-model tables at all (a DB below migration v65, or a fixture that
      // builds only the tables it needs). "Can't tell" is not "usable" — fall
      // back to the tags scan rather than counting from a table that isn't there.
      return false;
    }
  }

  /**
   * Re-state `folders.unread_count` from the materialized read model.
   *
   * This is the STRUCTURAL half of keeping the sidebar honest. Every other write
   * to `unread_count` is a hand-maintained adjustment some author has to remember
   * (a +/-1 delta when a flag flips, a recount after a sync) and the bug this
   * exists to end was exactly one forgotten decrement: the INBOX badge sat at 7
   * over a list that had nothing unread in it, for the rest of the session.
   *
   * Driven by the read-model drain instead, it cannot be forgotten: the `emails`
   * triggers dirty a thread on EVERY write to its tags — repository method or
   * ad-hoc `UPDATE emails SET tags` alike — and the drain that clears those rows
   * calls this. So any code path that marks mail read, now or in future, pays the
   * badge update whether or not its author knew a badge existed.
   *
   * `refreshed` is false (and nothing is written) when the read model isn't
   * usable, so a caller can tell "refreshed" from "left to the tags-based
   * recount". `changed` names only the folders whose badge ACTUALLY moved —
   * the `IS NOT` guard skips the rest — because it is what wakes the renderer,
   * and a refresh that woke it on every drain would re-query the sidebar for
   * nothing.
   */
  refreshUnreadFromReadModel(folderIds?: string[]): { refreshed: boolean; changed: string[] } {
    if (!this.readModelUnreadUsable()) return { refreshed: false, changed: [] };
    const scoped = folderIds && folderIds.length > 0;
    const sql = `UPDATE folders SET unread_count = (${READ_MODEL_UNREAD_COUNT_CORRELATED_SQL})`
      + (scoped ? ` WHERE id IN (${folderIds!.map(() => '?').join(',')}) AND` : ' WHERE')
      + ` unread_count IS NOT (${READ_MODEL_UNREAD_COUNT_CORRELATED_SQL})`
      + ' RETURNING path';
    let changed: string[] = [];
    this.timed('refreshUnreadFromReadModel', () => {
      changed = (this.db.prepare(sql).all(...(scoped ? folderIds! : [])) as { path: string }[])
        .map((row) => row.path);
    }, { folderCount: scoped ? folderIds!.length : 'all' });
    return { refreshed: true, changed };
  }

  /**
   * Targeted recount for a small set of folders. Each folder costs exactly two
   * `instr(tags, '|path|')` aggregate scans — the SAME membership predicate
   * `countByFolderTag` / the sidebar-unread query use — evaluated in C without
   * ever materialising the row set in JS. `instr` with both delimiters is what
   * stops `Work` matching `Work/Reports` (there is no `|Work|` inside
   * `|Work/Reports|`), so a folder that is a path-prefix of another is counted
   * correctly.
   */
  private recountFoldersTargeted(folders: Array<{ id: string; path: string }>, fromReadModel = false): void {
    const updateStmt = this.db.prepare('UPDATE folders SET total_count = ?, unread_count = ? WHERE id = ?');
    // total_count = messages tagged with the folder (one per copy, read or not).
    const totalStmt = this.db.prepare(
      "SELECT COUNT(*) AS c FROM emails WHERE instr(tags, '|' || ? || '|') > 0",
    );
    // unread_count = distinct threads with an unread copy that LISTS in the
    // folder (unreadInFolderPredicate: not read, not \Deleted, not shadowed by
    // Trash/Junk/Sent/…); NULL thread_ids never count (mirrors the JS tally's
    // `thread_id != null`). The listing scope differs per folder (a folder never
    // excludes itself), so the statement is built per folder path.
    const unreadStmtFor = (path: string) => this.db.prepare(
      `SELECT COUNT(DISTINCT thread_id) AS c FROM emails
       WHERE instr(tags, '|' || ? || '|') > 0
         AND ${unreadInFolderPredicate(path)}
         AND thread_id IS NOT NULL`,
    );
    // The read-model alternative: count the folder's unread threads straight out
    // of the partial index the list reads, one constant (cache-friendly)
    // statement for every folder. Prepared only when it will be used — a store
    // below migration v64 has no `thread_folders` to prepare against.
    const readModelUnreadStmt = fromReadModel ? this.db.prepare(READ_MODEL_UNREAD_COUNT_SQL) : null;
    this.timed('recalculateFolderCounts', () => {
      for (const folder of folders) {
        const total = (totalStmt.get(folder.path) as { c: number }).c;
        const unread = readModelUnreadStmt
          ? (readModelUnreadStmt.get(folder.id) as { c: number }).c
          : (unreadStmtFor(folder.path).get(folder.path) as { c: number }).c;
        updateStmt.run(total, unread, folder.id);
      }
    }, { folderCount: folders.length, mode: fromReadModel ? 'targeted-readmodel' : 'targeted' });
  }

  /**
   * Full recount via a SINGLE table pass + in-memory tally, NOT two `instr(tags,
   * ?)` scans per folder. `instr(tags, ...)` can't use an index, so a per-folder
   * approach re-scans the whole table 2×N times — for many folders that is far
   * worse than one pass tallying each email's folder tokens (~O(emails ×
   * tags-per-email)). Used when enough folders are requested that the single pass
   * wins over {@link recountFoldersTargeted}.
   */
  private recountFoldersFullScan(folders: Array<{ id: string; path: string }>, fromReadModel = false): void {
    const updateStmt = this.db.prepare('UPDATE folders SET total_count = ?, unread_count = ? WHERE id = ?');
    this.timed('recalculateFolderCounts', () => {
      const byToken = new Map<string, { id: string; total: number; unreadThreads: Set<string> }>();
      for (const f of folders) byToken.set(f.path, { id: f.id, total: 0, unreadThreads: new Set() });

      const rows = this.db.prepare('SELECT thread_id, tags FROM emails').all() as Array<{
        thread_id: string | null;
        tags: string | null;
      }>;
      for (const row of rows) {
        const tags = row.tags;
        if (!tags) continue;
        // Tags are '|'-delimited tokens: '|INBOX|read|Label|'. Split once and
        // match tokens against folder paths (flag tokens like 'read'/'starred'
        // simply won't be in byToken).
        const parts = tags.split('|');
        // Mirror unreadInFolderPredicate: an unread copy counts for a folder only
        // if it's not \Deleted and not shadowed there by another special folder.
        const unreadCopy = parts.indexOf('read') === -1 && parts.indexOf('deleted') === -1;
        for (const part of parts) {
          if (!part) continue;
          const t = byToken.get(part);
          if (!t) continue;
          t.total++;
          // Mirror SQL COUNT(DISTINCT thread_id): NULL thread_ids are ignored.
          if (unreadCopy && row.thread_id != null && !isShadowedInFolder(parts, part)) {
            t.unreadThreads.add(row.thread_id);
          }
        }
      }

      const readModelUnreadStmt = fromReadModel ? this.db.prepare(READ_MODEL_UNREAD_COUNT_SQL) : null;
      for (const t of byToken.values()) {
        const unread = readModelUnreadStmt
          ? (readModelUnreadStmt.get(t.id) as { c: number }).c
          : t.unreadThreads.size;
        updateStmt.run(t.total, unread, t.id);
      }
    }, { folderCount: folders.length, mode: fromReadModel ? 'full-scan-readmodel' : 'full-scan' });
  }

  /** Above this many flips a single full recount is cheaper than N thread-scoped
   *  lookups, so applyReadFlagDeltaBatch defers to recalculateFolderCounts(). */
  private static readonly UNREAD_DELTA_MAX_BATCH = 200;

  /**
   * Precise, scan-free maintenance of `unread_count` after a SINGLE email's
   * read-flag flip — the hot path (auto-mark-read on open). Thin wrapper over
   * the batch form.
   */
  async applyReadFlagDelta(emailId: string, nowRead: boolean): Promise<void> {
    return this.applyReadFlagDeltaBatch([{ emailId, nowRead }]);
  }

  /**
   * Precise, scan-free maintenance of `unread_count` for a BATCH of read-flag
   * flips (bulk mark-read/unread, realtime server-driven flag sync). A read flip
   * only moves a thread in/out of the unread set of the folders it's tagged in;
   * it never changes a message count, so `total_count` is deliberately left
   * alone. For each affected (thread, folder) we compute the exact ±1 delta from
   * the LIVE `emails` table (indexed by `thread_id`, so it reads a handful of
   * rows, not the whole table) — correct regardless of the async read-model's
   * lag, and regardless of how many copies flipped or in which direction (a
   * thread whose copies flip both ways in one sync is handled):
   *   liveUnread = unread copies in (thread, folder) NOW (after the flips)
   *   before     = liveUnread + (copies flipped→read) − (copies flipped→unread)
   *   delta      = (liveUnread>0 ? 1 : 0) − (before>0 ? 1 : 0)
   * This matches `recalculateFolderCounts`' unread definition exactly (distinct
   * thread_ids with a copy satisfying unreadInFolderPredicate for the folder —
   * not read, not \Deleted, not shadowed by another special folder; NULL
   * thread_id never counts), so the cheap delta and the periodic full recount
   * can't disagree — the full recount stays the self-healing backstop.
   * Above UNREAD_DELTA_MAX_BATCH flips one full recount is cheaper, so defer.
   */
  async applyReadFlagDeltaBatch(flips: Array<{ emailId: string; nowRead: boolean }>): Promise<void> {
    if (flips.length === 0) return;
    if (flips.length >= FolderRepository.UNREAD_DELTA_MAX_BATCH) {
      await this.recalculateFolderCounts();
      return;
    }

    const dirById = new Map(flips.map((f) => [f.emailId, f.nowRead]));
    const ids = [...dirById.keys()];
    const rows = this.db.prepare(
      `SELECT id, thread_id, tags FROM emails WHERE id IN (${ids.map(() => '?').join(',')})`,
    ).all(...ids) as Array<{ id: string; thread_id: string | null; tags: string | null }>;

    const folderPaths = new Set(
      (this.db.prepare('SELECT path FROM folders').all() as { path: string }[]).map((f) => f.path),
    );

    // Per (thread, folder): how many flipped copies went to read vs unread.
    type Acc = { threadId: string; folder: string; toRead: number; toUnread: number };
    const acc = new Map<string, Acc>();
    for (const r of rows) {
      if (r.thread_id == null || !r.tags) continue; // NULL thread never counts
      const nowRead = dirById.get(r.id);
      if (nowRead === undefined) continue;
      const toks = r.tags.split('|');
      // A \Deleted copy never counts as unread anywhere (unreadInFolderPredicate),
      // so its read flip can't move a badge.
      if (toks.includes('deleted')) continue;
      for (const tok of toks) {
        if (!tok || !folderPaths.has(tok)) continue;
        // Shadowed here (e.g. an INBOX copy that also sits in Trash) → it was
        // never in this folder's unread set, so the flip contributes nothing.
        if (isShadowedInFolder(toks, tok)) continue;
        const key = `${r.thread_id}\u0000${tok}`;
        const a = acc.get(key) ?? { threadId: r.thread_id, folder: tok, toRead: 0, toUnread: 0 };
        if (nowRead) a.toRead++; else a.toUnread++;
        acc.set(key, a);
      }
    }
    if (acc.size === 0) return;

    this.timed('applyReadFlagDeltaBatch', () => {
      // Same per-folder predicate as the recount, prepared once per folder touched.
      const countUnreadByFolder = new Map<string, Statement>();
      const countUnreadFor = (path: string) => {
        let stmt = countUnreadByFolder.get(path);
        if (!stmt) {
          stmt = this.db.prepare(
            `SELECT COUNT(*) AS c FROM emails
             WHERE thread_id = ? AND instr(tags, '|' || ? || '|') > 0 AND ${unreadInFolderPredicate(path)}`,
          );
          countUnreadByFolder.set(path, stmt);
        }
        return stmt;
      };
      const folderDelta = new Map<string, number>();
      for (const a of acc.values()) {
        const liveUnread = (countUnreadFor(a.folder).get(a.threadId, a.folder) as { c: number }).c;
        const before = liveUnread + a.toRead - a.toUnread;
        const delta = (liveUnread > 0 ? 1 : 0) - (before > 0 ? 1 : 0);
        if (delta !== 0) folderDelta.set(a.folder, (folderDelta.get(a.folder) ?? 0) + delta);
      }
      const upd = this.db.prepare('UPDATE folders SET unread_count = MAX(0, unread_count + ?) WHERE path = ?');
      for (const [folder, d] of folderDelta) if (d !== 0) upd.run(d, folder);
    }, { flips: flips.length, pairs: acc.size });
  }

  /**
   * Recalculate starred count
   */
  async recalculateStarredCount(): Promise<number> {
    const result = this.db.prepare(
      `SELECT COUNT(*) as count FROM emails WHERE instr(tags, '|starred|') > 0`
    ).get() as { count: number };

    return result?.count || 0;
  }

  /**
   * Convert database row to FolderRecord
   */
  private rowToRecord(row: any): FolderRecord {
    return {
      id: row.id,
      name: row.name,
      path: row.path,
      parentId: row.parent_id,
      uidValidity: row.uid_validity,
      lastSyncUid: row.last_sync_uid,
      lastSyncTime: row.last_sync_time,
      highestModseq: row.highest_modseq || null,  // CONDSTORE support
      totalCount: row.total_count,
      unreadCount: row.unread_count,
      serverMessageCount: row.last_known_message_count || 0,
      backfillOldestUid: row.backfill_oldest_uid ?? null,
      backfillComplete: row.backfill_complete === 1,
      specialUse: row.special_use,
      subscribed: row.subscribed === 1,
      // Per-folder sync policy (v68). Default enabled when the column is absent
      // (older rows) so a missing value never silently stops syncing a folder.
      syncEnabled: row.sync_enabled === undefined || row.sync_enabled === null ? true : row.sync_enabled === 1,
      syncMode: row.sync_mode ?? null,
      keepDays: row.keep_days ?? null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
