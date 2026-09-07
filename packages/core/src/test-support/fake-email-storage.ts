/**
 * FakeEmailStorage — an in-memory `IEmailStorage` for sync tests.
 *
 * Companion to `FakeImapServer`: that one models the SERVER, this one models the
 * DB. Together they let a test drive the real MessageProcessor / FolderSyncer
 * end-to-end and then assert on the resulting ROWS ("exactly one live copy with
 * the destination uid") instead of on which `vi.fn()` happened to be called.
 * Hand-rolled `vi.fn()` storages can't express the invariants that actually
 * broke in production — unlink-vs-delete, message-id dedup, uid-clearing on a
 * primary-folder repoint — because those live in the storage semantics.
 *
 * It therefore mirrors the parts of `SqliteStorage` the sync paths depend on,
 * deliberately including their subtle behaviour:
 *
 *   - `insertEmailBatch` dedups on `message_id` and LINKS the existing row to the
 *     folder instead of inserting a second copy (idempotent re-sync).
 *   - `linkEmailToFolder` adds the folder-path tag, and refreshes `uid` only when
 *     the folder is the row's PRIMARY (a secondary label must never take a
 *     foreign uid).
 *   - `updateEmail` NULLs `uid` when `folderId` changes without a new uid (a uid
 *     is only meaningful in its own folder's UID space).
 *   - `unlinkOrDeleteEmailsFromFolder` drops only this folder's membership when
 *     the row still belongs to another REAL folder (repointing the primary and
 *     clearing the uid), and hard-deletes only the last-folder case.
 *   - `invalidateFolderMembership` re-keys a whole folder through those same
 *     unlink-or-delete semantics.
 *
 * Deliberately NOT modelled: SQL, threads/rollups, FTS, embeddings, ordering
 * beyond `date DESC`. Storage-layer SQL is covered by the storage-node tests.
 *
 * Usage:
 *
 *   const db = new FakeEmailStorage();
 *   db.addFolder('INBOX');
 *   db.seedEmail({ folderId: db.folderId('INBOX'), uid: 5, tags: '|INBOX|' });
 *   await processor.syncFlags(server, db.folder('INBOX'), db.asStorage());
 */

import type { FilterRule } from '../types/filters';
import type { EmailRecord, FolderRecord, PaginationOptions } from '../types/models';
import type { IEmailStorage } from '../types/storage';
import { addTag, parseTags, removeTag } from '../utils/tags';

export interface FakeFolderSeed extends Partial<FolderRecord> {
  path?: string;
}

/**
 * A row as the DB really stores it: `uid` is NULLABLE (the column is; the
 * `EmailRecord` type says `number`). A null uid is a real state the sync logic
 * has to cope with — it's what an unlink-or-delete repoint leaves behind — so the
 * fake must be able to represent it.
 */
export type StoredEmail = Omit<EmailRecord, 'uid'> & { uid: number | null };

let seedSeq = 0;

/** Reset the row-id counter so ids are stable per test file. */
export function resetFakeStorageIds(): void {
  seedSeq = 0;
}

/** A fully-populated row from a tiny seed — tests only state what matters. */
function makeRecord(seed: Partial<StoredEmail> & { folderId: string }): StoredEmail {
  seedSeq += 1;
  const now = 1_700_000_000;
  return {
    id: seed.id ?? `row-${seedSeq}`,
    messageId: seed.messageId ?? `<seed-${seedSeq}@test.local>`,
    threadId: seed.threadId ?? `thread-${seedSeq}`,
    uid: seed.uid ?? null,
    tags: seed.tags ?? '||',
    subject: seed.subject ?? `Seed ${seedSeq}`,
    fromAddress: seed.fromAddress ?? 'sender@test.local',
    fromName: seed.fromName ?? null,
    toAddress: seed.toAddress ?? 'me@test.local',
    toNames: seed.toNames ?? '',
    ccAddress: seed.ccAddress ?? null,
    ccNames: seed.ccNames ?? null,
    bccAddress: seed.bccAddress ?? null,
    bccNames: seed.bccNames ?? null,
    replyTo: seed.replyTo ?? null,
    date: seed.date ?? now,
    receivedDate: seed.receivedDate ?? now,
    cleanBody: seed.cleanBody ?? '',
    rawBody: seed.rawBody ?? '',
    contentType: seed.contentType ?? 'text',
    contentHash: seed.contentHash ?? `hash-${seedSeq}`,
    inReplyTo: seed.inReplyTo ?? null,
    references: seed.references ?? '',
    priority: seed.priority ?? null,
    hasAttachments: seed.hasAttachments ?? false,
    attachmentCount: seed.attachmentCount ?? 0,
    attachmentNames: seed.attachmentNames ?? null,
    attachmentSizes: seed.attachmentSizes ?? null,
    calendarIcs: seed.calendarIcs ?? null,
    hasEmbedding: seed.hasEmbedding ?? false,
    embeddingLastGenerated: seed.embeddingLastGenerated ?? null,
    createdAt: seed.createdAt ?? now,
    updatedAt: seed.updatedAt ?? now,
    ...seed,
  } as StoredEmail;
}

export class FakeEmailStorage {
  private emails = new Map<string, StoredEmail>();
  private folders = new Map<string, FolderRecord>();
  private spammers = new Set<string>();
  private filterRules: FilterRule[] = [];

  /** Every mutating call, in order — lets a test assert "we never deleted". */
  readonly calls: string[] = [];

  // ── Test-side control surface ─────────────────────────────────────────

  /** Register a folder. Its id defaults to `f-<path>` so tests can predict it. */
  addFolder(path: string, seed: FakeFolderSeed = {}): FolderRecord {
    const now = 1_700_000_000;
    const record: FolderRecord = {
      id: seed.id ?? `f-${path}`,
      name: seed.name ?? path.split('/').pop() ?? path,
      path,
      parentId: null,
      uidValidity: seed.uidValidity ?? null,
      lastSyncUid: seed.lastSyncUid ?? null,
      lastSyncTime: seed.lastSyncTime ?? null,
      totalCount: seed.totalCount ?? 0,
      unreadCount: seed.unreadCount ?? 0,
      specialUse: seed.specialUse ?? null,
      subscribed: seed.subscribed ?? true,
      createdAt: now,
      updatedAt: now,
      ...seed,
    } as FolderRecord;
    this.folders.set(record.id, record);
    return record;
  }

  /** Insert a row directly, bypassing the ingest path. Returns the row. */
  seedEmail(seed: Partial<StoredEmail> & { folderId: string }): StoredEmail {
    const record = makeRecord(seed);
    this.emails.set(record.id, record);
    return record;
  }

  folderId(path: string): string {
    return this.folder(path).id;
  }

  /** The live FolderRecord (mutated by updateFolder) — pass this to syncFlags. */
  folder(path: string): FolderRecord {
    const found = [...this.folders.values()].find((f) => f.path === path);
    if (!found) throw new Error(`FakeEmailStorage: no folder "${path}"`);
    return found;
  }

  row(id: string): StoredEmail | undefined {
    return this.emails.get(id);
  }

  rowByMessageId(messageId: string): StoredEmail | undefined {
    return [...this.emails.values()].find((e) => e.messageId === messageId);
  }

  /** Every row, insertion order. */
  allRows(): StoredEmail[] {
    return [...this.emails.values()];
  }

  /** Rows carrying `path` as a folder-membership TAG (what the view renders). */
  rowsTaggedWith(path: string): StoredEmail[] {
    return this.allRows().filter((e) => parseTags(e.tags).includes(path));
  }

  /** Rows whose PRIMARY folder is `path`. */
  rowsPrimaryIn(path: string): StoredEmail[] {
    const id = this.folderId(path);
    return this.allRows().filter((e) => e.folderId === id);
  }

  tagsOf(id: string): string[] {
    return parseTags(this.emails.get(id)?.tags ?? '');
  }

  markSpammer(address: string): void {
    this.spammers.add(address.toLowerCase());
  }

  setFilterRules(rules: FilterRule[]): void {
    this.filterRules = rules;
  }

  callCount(method: string): number {
    return this.calls.filter((c) => c === method).length;
  }

  /** Hand to anything expecting the full interface (only sync paths are modelled). */
  asStorage(): IEmailStorage {
    return this as unknown as IEmailStorage;
  }

  private note(method: string): void {
    this.calls.push(method);
  }

  private folderById(id: string): FolderRecord | undefined {
    return this.folders.get(id);
  }

  /** Which OTHER real folders does this row still belong to (tag-wise)? */
  private otherFolderPaths(email: StoredEmail, excludePath: string): string[] {
    const realPaths = new Set([...this.folders.values()].map((f) => f.path));
    return parseTags(email.tags).filter((t) => t !== excludePath && realPaths.has(t));
  }

  // ── Email operations ──────────────────────────────────────────────────

  async insertEmailBatch(emails: EmailRecord[]): Promise<void> {
    this.note('insertEmailBatch');
    for (const email of emails) {
      // message_id dedup: link the EXISTING row to this folder instead of
      // inserting a duplicate (what makes a re-run of a sync idempotent).
      const existing = email.messageId ? this.rowByMessageId(email.messageId) : undefined;
      if (existing) {
        const folder = this.folderById(email.folderId);
        if (folder) existing.tags = addTag(existing.tags || '||', folder.path);
        continue;
      }
      this.emails.set(email.id, { ...email });
    }
  }

  async insertEmail(email: EmailRecord): Promise<void> {
    await this.insertEmailBatch([email]);
  }

  async getEmail(id: string): Promise<EmailRecord | null> {
    this.note('getEmail');
    return (this.emails.get(id) ?? null) as EmailRecord | null;
  }

  async getEmailById(id: string): Promise<EmailRecord | null> {
    return this.getEmail(id);
  }

  async getEmailByMessageId(messageId: string): Promise<EmailRecord | null> {
    return (this.rowByMessageId(messageId) ?? null) as EmailRecord | null;
  }

  async getEmailsByMessageIds(messageIds: string[]): Promise<EmailRecord[]> {
    this.note('getEmailsByMessageIds');
    const wanted = new Set(messageIds);
    return this.allRows().filter((e) => wanted.has(e.messageId)) as EmailRecord[];
  }

  async updateEmail(id: string, updates: Partial<EmailRecord>): Promise<void> {
    this.note('updateEmail');
    const email = this.emails.get(id);
    if (!email) return;
    const patch: Partial<StoredEmail> = { ...updates };
    // A uid only means something inside its own folder's UID space: repointing
    // the primary folder without a new uid must CLEAR it, or the destination's
    // deletion reconcile treats the stale uid as a server-side deletion.
    if (updates.folderId !== undefined && updates.uid === undefined && email.folderId !== updates.folderId) {
      patch.uid = null;
    }
    Object.assign(email, patch);
  }

  async deleteEmails(ids: string[]): Promise<void> {
    this.note('deleteEmails');
    for (const id of ids) this.emails.delete(id);
  }

  async deleteEmail(id: string): Promise<void> {
    await this.deleteEmails([id]);
  }

  async deleteEmailsByFolder(folderId: string): Promise<number> {
    this.note('deleteEmailsByFolder');
    const folder = this.folderById(folderId);
    if (!folder) return 0;
    const doomed = this.rowsTaggedWith(folder.path);
    for (const e of doomed) this.emails.delete(e.id);
    return doomed.length;
  }

  async linkEmailToFolder(emailId: string, folderId: string, uid?: number, _flags?: string[]): Promise<void> {
    this.note('linkEmailToFolder');
    const folder = this.folderById(folderId);
    const email = this.emails.get(emailId);
    if (!folder || !email) return;
    email.tags = addTag(email.tags || '||', folder.path);
    // uid is refreshed ONLY for the row's own primary folder — a secondary
    // label must never adopt another folder's uid.
    if (email.folderId === folderId && typeof uid === 'number' && uid > 0) email.uid = uid;
  }

  async unlinkEmailFromFolder(emailId: string, folderId: string): Promise<void> {
    const folder = this.folderById(folderId);
    const email = this.emails.get(emailId);
    if (!folder || !email) return;
    email.tags = removeTag(email.tags, folder.path);
  }

  async unlinkOrDeleteEmailsFromFolder(
    emailIds: string[],
    folderId: string,
  ): Promise<{ unlinked: number; deleted: number }> {
    this.note('unlinkOrDeleteEmailsFromFolder');
    const result = { unlinked: 0, deleted: 0 };
    const folder = this.folderById(folderId);
    if (!folder || emailIds.length === 0) return result;

    for (const id of emailIds) {
      const email = this.emails.get(id);
      if (!email) continue;
      const others = this.otherFolderPaths(email, folder.path);
      if (others.length === 0) {
        this.emails.delete(id); // last folder — genuinely gone
        result.deleted++;
        continue;
      }
      email.tags = removeTag(email.tags, folder.path);
      if (email.folderId === folderId) {
        // The primary pointer left with this folder: repoint to a surviving
        // folder and clear the uid so THAT folder's sync stamps the right one.
        email.folderId = this.folder(others[0]).id;
        email.uid = null;
      }
      result.unlinked++;
    }
    return result;
  }

  async invalidateFolderMembership(folderId: string): Promise<{ unlinked: number; deleted: number }> {
    this.note('invalidateFolderMembership');
    const folder = this.folderById(folderId);
    if (!folder) return { unlinked: 0, deleted: 0 };
    const ids = this.rowsTaggedWith(folder.path).map((e) => e.id);
    if (ids.length === 0) return { unlinked: 0, deleted: 0 };
    return this.unlinkOrDeleteEmailsFromFolder(ids, folderId);
  }

  async getEmailIdsByFolderAndUids(folderId: string, uids: number[]): Promise<Array<{ id: string; uid: number }>> {
    this.note('getEmailIdsByFolderAndUids');
    const wanted = new Set(uids);
    return this.allRows()
      .filter((e) => e.folderId === folderId && e.uid != null && wanted.has(e.uid))
      .map((e) => ({ id: e.id, uid: e.uid as number }));
  }

  async getEmailUidsInFolder(folderId: string): Promise<Array<{ id: string; uid: number }>> {
    this.note('getEmailUidsInFolder');
    return this.allRows()
      .filter((e) => e.folderId === folderId && e.uid != null)
      .map((e) => ({ id: e.id, uid: e.uid as number }));
  }

  async getEmailTagsInFolder(folderId: string): Promise<Array<{ id: string; uid: number | null; tags: string }>> {
    this.note('getEmailTagsInFolder');
    return this.allRows()
      .filter((e) => e.folderId === folderId)
      .map((e) => ({ id: e.id, uid: e.uid ?? null, tags: e.tags }));
  }

  async getOldestUidInFolder(folderId: string): Promise<number | null> {
    this.note('getOldestUidInFolder');
    const uids = this.allRows()
      .filter((e) => e.folderId === folderId && e.uid != null)
      .map((e) => e.uid as number);
    return uids.length ? Math.min(...uids) : null;
  }

  async countEmailsWithFolderTag(folderPath: string): Promise<number> {
    this.note('countEmailsWithFolderTag');
    return this.rowsTaggedWith(folderPath).length;
  }

  async getFolderMembersOutsideUidSpace(
    folderId: string,
    folderPath: string,
  ): Promise<Array<{ id: string; messageId: string; folderId: string; uid: number | null }>> {
    this.note('getFolderMembersOutsideUidSpace');
    return this.rowsTaggedWith(folderPath)
      .filter((e) => e.folderId !== folderId)
      .map((e) => ({ id: e.id, messageId: e.messageId, folderId: e.folderId, uid: e.uid ?? null }));
  }

  async bulkUpdateTags(updates: Array<{ id: string; tags: string }>): Promise<void> {
    this.note('bulkUpdateTags');
    for (const u of updates) {
      const email = this.emails.get(u.id);
      if (email) email.tags = u.tags;
    }
  }

  /**
   * The folder VIEW: rows carrying this folder's path as a TAG — which, like the
   * real `instr(tags, '|path|')` query, includes rows whose PRIMARY folder is
   * elsewhere (a reply in both Inbox and Sent). Those carry a FOREIGN uid, which
   * is why the flag/deletion reconcile has to re-check `folderId` itself.
   */
  async getEmailsByFolder(folderId: string, options: PaginationOptions): Promise<EmailRecord[]> {
    this.note('getEmailsByFolder');
    const folder = this.folderById(folderId);
    const rows = (folder ? this.rowsTaggedWith(folder.path) : [])
      .sort((a, b) => b.date - a.date);
    const offset = options?.offset ?? 0;
    const limit = options?.limit ?? rows.length;
    return rows.slice(offset, offset + limit) as EmailRecord[];
  }

  async isSpammer(email: string): Promise<boolean> {
    return this.spammers.has((email || '').toLowerCase());
  }

  async getEnabledFilterRules(): Promise<FilterRule[]> {
    return this.filterRules;
  }

  // ── Folder operations ─────────────────────────────────────────────────

  async syncFolders(folders: FolderRecord[]): Promise<void> {
    this.note('syncFolders');
    for (const incoming of folders) {
      const existing = this.folders.get(incoming.id);
      // Upsert: never clobber sync state (uidValidity / lastSyncUid / modseq) of
      // a folder we already know — the real folder upsert preserves it too.
      this.folders.set(
        incoming.id,
        existing
          ? { ...incoming, uidValidity: existing.uidValidity, lastSyncUid: existing.lastSyncUid, lastSyncTime: existing.lastSyncTime, totalCount: existing.totalCount, unreadCount: existing.unreadCount, highestModseq: (existing as FolderRecord).highestModseq }
          : incoming,
      );
    }
  }

  async getFolders(): Promise<FolderRecord[]> {
    return [...this.folders.values()];
  }

  async getFolder(id: string): Promise<FolderRecord | null> {
    return this.folders.get(id) ?? null;
  }

  async getFolderByPath(path: string): Promise<FolderRecord | null> {
    return [...this.folders.values()].find((f) => f.path === path) ?? null;
  }

  async updateFolder(id: string, updates: Partial<FolderRecord>): Promise<void> {
    this.note('updateFolder');
    const folder = this.folders.get(id);
    if (folder) Object.assign(folder, updates);
  }

  async deleteFolder(id: string): Promise<void> {
    this.folders.delete(id);
  }

  async recalculateFolderCounts(folderPaths?: string[]): Promise<void> {
    this.note('recalculateFolderCounts');
    for (const folder of this.folders.values()) {
      if (folderPaths && !folderPaths.includes(folder.path)) continue;
      const rows = this.rowsTaggedWith(folder.path);
      folder.totalCount = rows.length;
      folder.unreadCount = rows.filter((e) => !parseTags(e.tags).includes('read')).length;
    }
  }
}
