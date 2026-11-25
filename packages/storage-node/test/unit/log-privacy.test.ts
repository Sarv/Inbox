import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { folderLogLabel, getLogLevel, setLogLevel, setLogSink } from '@sarvinbox/core';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { captureLogs, type CapturedLogs } from '../../../core/src/test-support/log-capture';
import { FolderRepository } from '../../src/repositories/folder-repository';
import { conversationFoldersIn } from '../../src/repositories/thread-sql';
import { attachSharedContacts } from '../../src/shared-contacts';
import { openTestDb } from '../../src/test-support/test-db';

/**
 * What the storage layer writes to app.log about the user's own names: a
 * folder they named, where their data folder is. What breaks if this file
 * fails: a release app.log (attached to bug reports, sampled into crash
 * reports) names a client's folder or the user's home folder.
 */

let logs: CapturedLogs;
const open: Database.Database[] = [];
let dir = '';

beforeEach(() => {
  logs = captureLogs({ setLogSink, setLogLevel, getLogLevel });
  dir = mkdtempSync(join(tmpdir(), 'storage-log-privacy-'));
});

afterEach(() => {
  logs.stop();
  for (const db of open.splice(0)) db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('FolderRepository.refileLocalRows', () => {
  // Breaks: 'Re-filed N local-only row(s) from <path> to <path>' wrote a
  // user-named folder; a system one (Sent) must stay readable.
  it('names a user folder by its label and a system folder as written', async () => {
    const db = openTestDb();
    open.push(db);
    db.exec(`
      CREATE TABLE folders (id TEXT PRIMARY KEY, path TEXT UNIQUE NOT NULL);
      CREATE TABLE emails (id TEXT PRIMARY KEY, folder_id TEXT NOT NULL, uid INTEGER, tags TEXT NOT NULL DEFAULT '||');
      INSERT INTO folders (id, path) VALUES ('f-user', 'Clients/Sentinel Acme Sent'), ('f-sent', 'Sent');
      INSERT INTO emails (id, folder_id, uid, tags) VALUES ('m1', 'f-user', 0, '|Clients/Sentinel Acme Sent|');
    `);

    expect(await new FolderRepository(() => db).refileLocalRows('f-user', 'f-sent')).toBe(1);

    expect(logs.containing('Sentinel')).toEqual([]);
    expect(logs.containing(`Re-filed 1 local-only row(s) from ${folderLogLabel('Clients/Sentinel Acme Sent')} to Sent`)).toHaveLength(1);
  });
});

describe('attachSharedContacts', () => {
  // Breaks: '[SharedContacts] attached <path>' wrote the directory's absolute
  // path, which names the user through their home folder.
  it('names the directory by its file name only', () => {
    const db = openTestDb();
    open.push(db);

    attachSharedContacts(db, join(dir, 'sarvinbox-contacts.db'));

    expect(logs.containing(dir)).toEqual([]);
    expect(logs.containing('[SharedContacts] attached sarvinbox-contacts.db (0 contacts)')).toHaveLength(1);
  });
});

describe('conversationFoldersIn', () => {
  // Breaks: the "folders table unreadable" warning logged the whole error,
  // whose message can quote the statement or a folder's name; it still throws.
  it('logs an unreadable folders table by the error kind and code only', () => {
    const db = {
      prepare: () => { throw Object.assign(new Error('malformed near "Clients/Sentinel Acme"'), { code: 'SQLITE_CORRUPT' }); },
    } as unknown as Database.Database;

    expect(() => conversationFoldersIn(db)).toThrow(/malformed/);

    expect(logs.containing('Sentinel')).toEqual([]);
    const [line] = logs.containing('folders table unreadable');
    expect(line).toContain("code: 'SQLITE_CORRUPT'");
  });
});
