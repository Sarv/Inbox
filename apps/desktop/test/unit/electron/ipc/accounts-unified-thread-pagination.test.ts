import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { EmailRecord } from '@sarvinbox/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
  accounts: new Map<string, unknown>(),
}));
vi.mock('electron', () => ({
  ipcMain: { handle: (name: string, fn: (...args: any[]) => any) => h.handlers.set(name, fn), on: () => {} },
}));
vi.mock('../../../../electron/services/accounts-registry', () => ({}));
vi.mock('../../../../electron/services/accounts-runtime', () => ({
  ensureAccountRuntime: async (id: string) => ({ storage: h.accounts.get(id) }),
}));
vi.mock('../../../../electron/services/antivirus-scan-service', () => ({}));
vi.mock('../../../../electron/services/attachment-warning-preferences', () => ({}));
vi.mock('../../../../electron/services/oauth-refresh-scheduler', () => ({}));
vi.mock('../../../../electron/services/outbox-service', () => ({}));
vi.mock('../../../../electron/services/reputation-service', () => ({}));
vi.mock('../../../../electron/services/unified-pipeline-service', () => ({}));
vi.mock('../../../../electron/shared', () => ({}));

import { registerAccountsHandlers } from '../../../../electron/ipc/accounts-handlers';
import { openTestAccount, type TestAccount } from '../../../helpers/account-storage';

let dir: string;
let a: TestAccount;
let b: TestAccount;

const threadKeys = (rows: EmailRecord[]) => new Set(rows.map(row => `${row.accountId}:${row.threadId || row.id}`));
const call = (name: string, opts: Record<string, unknown>) => h.handlers.get(name)!(null, opts);

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'inbox-thread-pagination-'));
  a = await openTestAccount(dir, 'a');
  b = await openTestAccount(dir, 'b');
  h.accounts = new Map([['a', a.storage], ['b', b.storage]]);
  h.handlers.clear();
  registerAccountsHandlers();
  // Header-derived thread IDs are identical across accounts; each mailbox still
  // owns a separate visible conversation. There are 28 unread matching messages
  // but 26 conversations, and both extra replies belong to the first page.
  for (let i = 0; i < 13; i++) {
    await a.add(`t${i}`, { id: `a${i}`, tags: '|INBOX|reminders|', date: 200 + i });
    await b.add(`t${i}`, { id: `b${i}`, tags: '|INBOX|reminders|', date: 100 + i });
  }
  await a.add('t0', { id: 'a0-reply', tags: '|INBOX|reminders|', date: 300 });
  await b.add('t0', { id: 'b0-reply', tags: '|INBOX|reminders|', date: 290 });
  await a.add('other-category', { id: 'finance', tags: '|INBOX|finance|', date: 400 });
  await a.add('read', { id: 'read', tags: '|INBOX|reminders|read|', date: 400 });
  await b.add('off-inbox', { id: 'sent', folderId: 'f-sent', tags: '|Sent|reminders|', date: 400 });
});

afterEach(async () => {
  await a.close();
  await b.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('unified conversation pagination over real account databases', () => {
  it('fills an unread category inbox page with 25 conversations, then one, with a matching total', async () => {
    const opts = { accountIds: ['a', 'b'], limit: 25, filter: { isUnread: true }, aiCategory: 'reminders' };
    const first = await call('accounts:unifiedInbox', opts);
    const next = await call('accounts:unifiedInbox', { ...opts, offset: 25 });
    expect(first.success).toBe(true);
    expect(first.data.total).toBe(26);
    expect(first.data.hasMore).toBe(true);
    expect(threadKeys(first.data.emails).size).toBe(25);
    expect(first.data.emails).toHaveLength(27);
    expect(first.data.emails.map((row: EmailRecord) => row.id)).toEqual(expect.arrayContaining(['a0', 'a0-reply', 'b0', 'b0-reply']));
    expect(next.data.total).toBe(26);
    expect(next.data.hasMore).toBe(false);
    expect(threadKeys(next.data.emails).size).toBe(1);
    for (const key of threadKeys(next.data.emails)) expect(threadKeys(first.data.emails).has(key)).toBe(false);
    const unread = await h.handlers.get('accounts:unifiedCategoryCounts')!(null, ['a', 'b']);
    expect(unread.data.reminders).toBe(26);
    const total = await h.handlers.get('accounts:unifiedCategoryCounts')!(null, ['a', 'b'], 'total');
    expect(total.data.reminders).toBe(27); // includes the separate read conversation
  });

  it('uses the same thread window and exact total for unified unread category search', async () => {
    const opts = { accountIds: ['a', 'b'], searchQuery: { isUnread: true, aiCategory: 'reminders' }, limit: 25 };
    const first = await call('accounts:unifiedSearch', opts);
    const next = await call('accounts:unifiedSearch', { ...opts, offset: 25 });
    expect(first.success).toBe(true);
    expect(first.total).toBe(26);
    expect(threadKeys(first.data).size).toBe(25);
    expect(first.data).toHaveLength(27);
    expect(next.total).toBe(26);
    expect(next.data).toHaveLength(1);
    expect([...threadKeys(next.data)].every(key => !threadKeys(first.data).has(key))).toBe(true);
  });

  it('returns only read conversations for the inverse filter without applying inactive flags', async () => {
    const result = await call('accounts:unifiedInbox', {
      accountIds: ['a', 'b'], limit: 25,
      aiCategory: 'reminders', filter: { isUnread: false, isFlagged: false, hasAttachments: false },
    });
    expect(result.success).toBe(true);
    expect(result.data.total).toBe(1);
    expect(result.data.emails.map((row: EmailRecord) => row.id)).toEqual(['read']);
    expect(result.data.hasMore).toBe(false);
  });

  it('keeps equal-date conversations stable as the per-account over-fetch window grows', async () => {
    a.run('UPDATE emails SET date = 500');
    b.run('UPDATE emails SET date = 500');
    const inboxKeys: string[] = [];
    const searchKeys: string[] = [];
    for (let offset = 0; offset < 26; offset += 3) {
      const inbox = await call('accounts:unifiedInbox', {
        accountIds: ['a', 'b'], limit: 3, offset,
        filter: { isUnread: true }, aiCategory: 'reminders',
      });
      const search = await call('accounts:unifiedSearch', {
        accountIds: ['a', 'b'], limit: 3, offset,
        searchQuery: { isUnread: true, aiCategory: 'reminders' },
      });
      expect(inbox.data.total).toBe(26);
      expect(search.total).toBe(26);
      inboxKeys.push(...threadKeys(inbox.data.emails));
      searchKeys.push(...threadKeys(search.data));
    }
    expect(inboxKeys).toHaveLength(26);
    expect(new Set(inboxKeys).size).toBe(26);
    expect(searchKeys).toEqual(inboxKeys);
  });
});
