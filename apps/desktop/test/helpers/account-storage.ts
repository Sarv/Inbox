import { join } from 'node:path';

import type { EmailRecord, FolderRecord } from '@sarvinbox/core';
import { SQLiteStorage } from '@sarvinbox/storage-node';

import { emailRecord } from './email-fixtures';

/**
 * A REAL account database for main-process tests: the built storage-node
 * facade over a temp file, with the production schema, migrations and folder
 * classification. For code whose correctness is "which rows of this account's
 * database it reads" — the conversation-membership predicate, the first-split
 * cache's key, the live-draft gate — where a hand-written fake would only
 * restate the assumption under test.
 *
 * Emails go in through the repository with an explicit thread id (no thread
 * resolution), so a test decides exactly which rows share a thread — including
 * the SAME thread id in two accounts, which header-derived ids produce.
 */

const T0 = 1_780_000_000;

const folder = (id: string, path: string, specialUse: string | null): FolderRecord => ({
  id, name: path, path, parentId: null, uidValidity: 1, lastSyncUid: null, lastSyncTime: null,
  totalCount: 0, unreadCount: 0, specialUse, subscribed: true, createdAt: T0, updatedAt: T0,
});

/** INBOX, Sent, a provider-path Drafts folder (`INBOX.Drafts`) and Trash. */
export const TEST_ACCOUNT_FOLDERS: readonly FolderRecord[] = [
  folder('f-inbox', 'INBOX', '\\Inbox'),
  folder('f-sent', 'Sent', '\\Sent'),
  folder('f-drafts', 'INBOX.Drafts', '\\Drafts'),
  folder('f-trash', 'Trash', '\\Trash'),
];

export interface TestAccount {
  storage: SQLiteStorage;
  /** Insert one email into `threadId` (creating the thread row first). */
  add: (threadId: string, over: Partial<EmailRecord> & { id: string }) => Promise<void>;
  /** Raw SQL on the account's connection, for arranging state a test needs. */
  run: (sql: string, ...params: unknown[]) => void;
  close: () => Promise<void>;
}

/** Open (and migrate) `<dir>/<name>.db` as an account database. */
export async function openTestAccount(dir: string, name: string): Promise<TestAccount> {
  const storage = new SQLiteStorage({ dbPath: join(dir, `${name}.db`) });
  await storage.initialize();
  await storage.syncFolders([...TEST_ACCOUNT_FOLDERS]);
  const db = (storage as unknown as { db: { prepare: (sql: string) => { run: (...args: unknown[]) => void } } }).db;
  const run = (sql: string, ...params: unknown[]): void => db.prepare(sql).run(...params);
  return {
    storage,
    run,
    add: async (threadId, over) => {
      // The thread row first: emails.thread_id is an enforced foreign key.
      run(`INSERT OR IGNORE INTO threads (id, subject, first_message_id, last_message_id, last_message_date)
           VALUES (?, ?, ?, ?, ?)`, threadId, over.subject ?? 'Subject', over.id, over.id, over.date ?? T0);
      await storage.getRepositories().email.insert(emailRecord({
        messageId: `<${over.id}@test.example>`,
        threadId,
        folderId: 'f-inbox',
        date: T0,
        rawBody: `<p>${over.id} body</p>`,
        cleanBody: `${over.id} body`,
        contentHash: `hash-${over.id}`,
        ...over,
      }));
    },
    close: async () => {
      // Let any fire-and-forget work settle before the handle goes away.
      for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
      await storage.close();
    },
  };
}
