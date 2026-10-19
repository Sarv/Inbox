import {
  addTag, classifyFolder, createLogger, hasTag, isInboxFolder, isTrashFolder,
  parseTags, removeTag, resolveStandardFolder, type EmailRecord, type FolderRecord, type IEmailStorage,
} from '@sarvinbox/core';

import type { AssistantReadReceipt } from './assistant-mail-actions';

type MoveAction = 'archive' | 'trash';
type QueueResult = 'success' | 'queued' | 'failed';
type MoveStorage = Pick<IEmailStorage,
  'getEmail' | 'getFolder' | 'getFolders' | 'updateEmail' | 'countEmailsFiledIn' | 'recalculateFolderCounts'>;

export interface AssistantMoveTarget {
  storage: MoveStorage;
  engine: {
    move(path: string, uid: number, destination: string, emailId?: string): Promise<QueueResult>;
    isConnected(): boolean;
    fetchUidByMessageId(path: string, messageId: string): Promise<number | null>;
  } | null;
  assertCurrent(): Promise<void>;
  onChanged?(emailId: string, action: MoveAction, destination: string): Promise<void>;
}

const logger = createLogger('AssistantMailMoves');
const unchanged = (current: EmailRecord | null, original: EmailRecord) => !!current
  && current.id === original.id && current.folderId === original.folderId
  && current.uid === original.uid && current.tags === original.tags && current.messageId === original.messageId;
const validUid = (uid: number | null | undefined): uid is number => Number.isSafeInteger(uid) && !!uid && uid > 0;

interface PlannedMove { email: EmailRecord; source: FolderRecord; uid: number }
interface PlacedMove extends PlannedMove { placedTags: string }

/**
 * User-selected review rows use the same persist-first IMAP moves as the mail
 * view. Trash always means a reversible move; this adapter has no delete API.
 * Destination placement precedes the queue call so its explicit row-id mapping
 * can install the destination UID even if the server completes immediately.
 */
export async function changeAssistantMailLocation(
  target: AssistantMoveTarget, emailIds: string[], action: MoveAction,
): Promise<AssistantReadReceipt> {
  if (!['archive', 'trash'].includes(action) || !Array.isArray(emailIds) || emailIds.length > 2_000
    || emailIds.some(id => typeof id !== 'string' || !id || id.length > 500)) throw new Error('Invalid mail move action.');
  await target.assertCurrent();
  const receipt: AssistantReadReceipt = { appliedIds: [], queuedIds: [], failedIds: [] };
  const destination = await resolveStandardFolder(target.storage, action === 'trash' ? 'trash' : 'archive');
  if (!destination) throw new Error(`${action === 'trash' ? 'Trash' : 'Archive'} folder is unavailable. No mail was moved.`);
  const folders = await target.storage.getFolders();
  const inboxes = folders.filter(isInboxFolder);
  const groups = new Map<string, PlannedMove[]>();
  for (const id of new Set(emailIds)) {
    try {
      const email = await target.storage.getEmail(id);
      const primary = email && await target.storage.getFolder(email.folderId);
      if (!email || !primary) { receipt.failedIds.push(id); continue; }
      const inbox = inboxes.find(folder => folder.id === primary.id)
        ?? inboxes.find(folder => hasTag(email.tags || '||', folder.path));
      // A full conversation includes outgoing and previously archived members.
      // Archiving removes Inbox membership, not the user's Sent history.
      if ((action === 'archive' && !inbox)
        || (action === 'trash' && (isTrashFolder(primary) || hasTag(email.tags || '||', destination.path)))) {
        receipt.appliedIds.push(id);
        continue;
      }
      if (!target.engine) { receipt.failedIds.push(id); continue; }
      const source = action === 'archive' ? inbox! : primary;
      let uid = source.id === primary.id && validUid(email.uid) ? email.uid : null;
      // Gmail's primary row can be All Mail while Inbox is a secondary label.
      // Its All Mail UID must never be sent to Inbox. UID-less moved rows also
      // need authoritative lookup rather than pretending they are local-only.
      if (!validUid(uid) && target.engine.isConnected() && email.messageId && !email.messageId.startsWith('<missing-')) {
        uid = await target.engine.fetchUidByMessageId(source.path, email.messageId.replace(/^<|>$/g, ''));
      }
      if (!validUid(uid)) { receipt.failedIds.push(id); continue; }
      const group = groups.get(source.path) ?? [];
      group.push({ email, source, uid });
      groups.set(source.path, group);
    } catch { receipt.failedIds.push(id); }
  }

  const paths = new Set<string>();
  for (const [path, group] of groups) {
    // Two local rows with the same source UID cannot be mapped unambiguously.
    const duplicateUids = new Set(group.filter((item, index) => group.findIndex(other => other.uid === item.uid) !== index).map(item => item.uid));
    const batches = group.map(item => [item]);
    for (const batch of batches) {
      const placed: PlacedMove[] = [];
      try {
        await target.assertCurrent();
        const currentDestination = await target.storage.getFolder(destination.id);
        if (!currentDestination || currentDestination.path !== destination.path) throw new Error('The destination folder changed.');
        const valid: PlannedMove[] = [];
        for (const item of batch) {
          const current = await target.storage.getEmail(item.email.id);
          const currentSource = await target.storage.getFolder(item.source.id);
          if (duplicateUids.has(item.uid) || !unchanged(current, item.email)
            || currentSource?.path !== path) receipt.failedIds.push(item.email.id);
          else valid.push(item);
        }
        for (const item of valid) {
          await target.assertCurrent();
          // Recheck after earlier rows' asynchronous writes, before changing
          // this row; a concurrent move must not be overwritten by the review.
          if (!unchanged(await target.storage.getEmail(item.email.id), item.email)) {
            receipt.failedIds.push(item.email.id); continue;
          }
          let tags = removeTag(item.email.tags || '||', path);
          for (const folder of folders) {
            const role = classifyFolder(folder);
            if (role === 'inbox' || (action === 'trash' && ['archive', 'sent', 'drafts', 'spam'].includes(role || ''))) {
              tags = removeTag(tags, folder.path);
            }
          }
          tags = addTag(tags, destination.path);
          // A source UID belongs only to its source mailbox. Clear it until
          // the queue writes the mapped destination UID onto this exact row.
          // The storage schema permits NULL while a destination UID is unknown;
          // EmailRecord's legacy type still declares uid as a number.
          await target.storage.updateEmail(item.email.id, { folderId: destination.id, tags, uid: null } as unknown as Partial<EmailRecord>);
          placed.push({ ...item, placedTags: tags });
          paths.add(item.source.path); paths.add(destination.path);
        }
        if (!placed.length) continue;
        await target.assertCurrent();
        // Name the canonical destination for BOTH actions. The generic Trash
        // queue resolves from raw server LIST order, which can disagree with
        // the app's owned-count resolver when the server publishes aliases.
        // move() uses the same durable reversible pipeline, while preserving
        // this exact target path and local row ID through offline replay.
        const result = await target.engine!.move(path, placed[0].uid, destination.path, placed[0].email.id);
        if (result !== 'success' && result !== 'queued') throw new Error('The mail move could not be saved for sync.');
        // The queue/server acknowledgement is authoritative. A later recount,
        // learning failure or account removal cannot turn it into a failed
        // receipt and invite the caller to repeat an already accepted MOVE.
        for (const item of placed) {
          (result === 'queued' ? receipt.queuedIds : receipt.appliedIds).push(item.email.id);
          try { await target.onChanged?.(item.email.id, action, destination.path); } catch { /* Mail was already accepted. */ }
        }
      } catch (error) {
        for (const item of placed) {
          try {
            const current = await target.storage.getEmail(item.email.id);
            // Do not overwrite a later user move while restoring a rejected
            // queue operation. Only restore this adapter's destination row.
            if (current?.folderId === destination.id && current.uid === null) {
              // Undo only the location-tag delta. A user may have changed
              // read/star/category/custom-label tags while MOVE was awaiting
              // its queue acknowledgement; those newer decisions must stay.
              let restoredTags = item.email.tags;
              if (current.tags !== item.placedTags) {
                const before = parseTags(item.email.tags || '||');
                const after = parseTags(item.placedTags);
                let mergedTags = current.tags || '||';
                for (const tag of after.filter(tag => !before.includes(tag))) mergedTags = removeTag(mergedTags, tag);
                for (const tag of before.filter(tag => !after.includes(tag))) mergedTags = addTag(mergedTags, tag);
                restoredTags = mergedTags;
              }
              await target.storage.updateEmail(item.email.id, {
                folderId: item.email.folderId, tags: restoredTags, uid: item.email.uid,
              });
            }
          } catch (rollbackError) { logger.error('Could not restore a rejected mail move', rollbackError); }
        }
        receipt.failedIds.push(...batch.map(item => item.email.id)
          .filter(id => !receipt.failedIds.includes(id) && !receipt.appliedIds.includes(id) && !receipt.queuedIds.includes(id)));
        logger.warn('Inbox Agent mail move was not accepted', error);
      }
    }
  }
  if (paths.size) {
    try { await target.storage.recalculateFolderCounts([...paths]); }
    catch (error) { logger.warn('Could not recount moved mail', error); }
  }
  return receipt;
}
