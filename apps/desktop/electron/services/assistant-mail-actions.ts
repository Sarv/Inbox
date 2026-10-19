import { setEmailReadFlag } from '@sarvinbox/core';

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
  } | null;
  assertCurrent(): Promise<void>;
  onChanged?(emailId: string, read: boolean): Promise<void>;
}

/** Named-account read changes use the ordinary durable queue and count helper. */
export async function changeAssistantReadFlags(
  target: AssistantReadTarget, emailIds: string[], read: boolean,
): Promise<AssistantReadReceipt> {
  if (typeof read !== 'boolean' || !Array.isArray(emailIds) || emailIds.length > 2_000
    || emailIds.some(id => typeof id !== 'string' || !id || id.length > 500)) throw new Error('Invalid read action.');
  await target.assertCurrent();
  const receipt: AssistantReadReceipt = { appliedIds: [], queuedIds: [], failedIds: [] };
  const groups = new Map<string, Array<{ id: string; uid: number }>>();
  for (const id of new Set(emailIds)) {
    const email = await target.storage.getEmail(id);
    if (!email) { receipt.failedIds.push(id); continue; }
    if ((email.tags || '').includes('|read|') === read) continue;
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
      if (!target.engine) throw new Error('This account is not ready to save read changes for sync.');
      const result = await (read ? target.engine.bulkMarkAsRead(path, items.map(item => item.uid))
        : target.engine.bulkMarkAsUnread(path, items.map(item => item.uid)));
      if (result === 'failed') throw new Error('Could not save the read change for sync.');
      await target.assertCurrent();
      for (const item of items) {
        try {
          const changed = await setEmailReadFlag(target.storage, item.id, read, 'Inbox Agent read action');
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
