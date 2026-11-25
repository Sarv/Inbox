import { addTag, hasTag, removeTag, setEmailReadFlag } from '@sarvinbox/core';

type QueueResult = 'success' | 'queued' | 'failed';
type ReadStorage = Parameters<typeof setEmailReadFlag>[0] & {
  getFolder(id: string): Promise<{ path: string } | null>;
};

export interface AssistantReadReceipt {
  appliedIds: string[];
  queuedIds: string[];
  failedIds: string[];
}

export interface AssistantReadTarget {
  storage: ReadStorage;
  engine: {
    bulkMarkAsRead(path: string, uids: number[]): Promise<QueueResult>;
    bulkMarkAsUnread(path: string, uids: number[]): Promise<QueueResult>;
    bulkStar?(path: string, uids: number[]): Promise<QueueResult>;
    bulkUnstar?(path: string, uids: number[]): Promise<QueueResult>;
  } | null;
  assertCurrent(): Promise<void>;
  /** Called once per message whose flag changed, with its new value. */
  onChanged?(emailId: string, on: boolean): Promise<void>;
}

/** Named-account read changes use the ordinary durable queue and count helper. */
export function changeAssistantReadFlags(
  target: AssistantReadTarget, emailIds: string[], read: boolean,
): Promise<AssistantReadReceipt> {
  return changeAssistantFlag(target, emailIds, 'read', read);
}

/** Star or unstar through the same durable queue, with the same receipts. */
export function changeAssistantStarFlags(
  target: AssistantReadTarget, emailIds: string[], starred: boolean,
): Promise<AssistantReadReceipt> {
  return changeAssistantFlag(target, emailIds, 'starred', starred);
}

/** The local tag write for one flag. Read goes through the count helper (the unread badge). */
async function writeFlag(storage: ReadStorage, id: string, flag: 'read' | 'starred', on: boolean): Promise<boolean> {
  if (flag === 'read') return setEmailReadFlag(storage, id, on, 'Inbox Agent read action');
  const email = await storage.getEmail(id);
  if (!email || hasTag(email.tags || '||', flag) === on) return false;
  await storage.updateEmail(id, { tags: on ? addTag(email.tags || '||', flag) : removeTag(email.tags || '||', flag) });
  return true;
}

async function changeAssistantFlag(
  target: AssistantReadTarget, emailIds: string[], flag: 'read' | 'starred', read: boolean,
): Promise<AssistantReadReceipt> {
  if (typeof read !== 'boolean' || !Array.isArray(emailIds) || emailIds.length > 2_000
    || emailIds.some(id => typeof id !== 'string' || !id || id.length > 500)) throw new Error(`Invalid ${flag === 'read' ? 'read' : 'star'} action.`);
  await target.assertCurrent();
  const receipt: AssistantReadReceipt = { appliedIds: [], queuedIds: [], failedIds: [] };
  const groups = new Map<string, Array<{ id: string; uid: number }>>();
  for (const id of new Set(emailIds)) {
    const email = await target.storage.getEmail(id);
    if (!email) { receipt.failedIds.push(id); continue; }
    // Already in the requested state: in no list, so the caller can tell.
    if (hasTag(email.tags || '||', flag) === read) continue;
    // A missing UID does not identify local-only mail: reversible moves clear
    // the source UID until the server supplies its destination UID. Without an
    // authoritative mailbox UID we cannot persist the matching server flag,
    // so leave the local flag untouched and let the user retry after sync.
    if (!Number.isSafeInteger(email.uid) || email.uid <= 0) { receipt.failedIds.push(id); continue; }
    const folder = await target.storage.getFolder(email.folderId);
    if (!folder) { receipt.failedIds.push(id); continue; }
    const group = groups.get(folder.path) ?? [];
    group.push({ id, uid: email.uid });
    groups.set(folder.path, group);
  }
  for (const [path, items] of groups) {
    try {
      await target.assertCurrent();
      if (!target.engine) throw new Error('This account is not ready to save changes for sync.');
      const uids = items.map(item => item.uid);
      const engine = target.engine;
      const queue = flag === 'read' ? (read ? engine.bulkMarkAsRead : engine.bulkMarkAsUnread) : (read ? engine.bulkStar : engine.bulkUnstar);
      if (!queue) throw new Error('This account cannot save star changes for sync.');
      const result = await queue.call(engine, path, uids);
      if (result === 'failed') throw new Error('Could not save the change for sync.');
      await target.assertCurrent();
      for (const item of items) {
        try {
          const changed = await writeFlag(target.storage, item.id, flag, read);
          if (!changed) continue;
          if (result === 'queued') receipt.queuedIds.push(item.id);
          else receipt.appliedIds.push(item.id);
          try { await target.onChanged?.(item.id, read); } catch { /* Receipt remains authoritative if learning fails. */ }
        } catch { receipt.failedIds.push(item.id); }
      }
    } catch { receipt.failedIds.push(...items.map(item => item.id)); }
  }
  return receipt;
}
