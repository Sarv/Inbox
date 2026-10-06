import { describe, expect, it, vi } from 'vitest';

import { SyncEngine } from '../../../src/imap/sync-engine';
import type { IMAPConfig } from '../../../src/types/imap';

function fixture(config: Partial<IMAPConfig> | null, gmail = false) {
  const engine = new SyncEngine({} as never);
  const queue = { setCategorySelection: vi.fn(async () => 'queued' as const),
    applyCategoryLabels: vi.fn(async () => 'success' as const), removeCategoryLabels: vi.fn(async () => 'success' as const),
    markImportant: vi.fn(async () => 'queued' as const) };
  Object.assign(engine, { connectionManager: { imapConfig: config, client: { supportsGmailLabels: () => gmail } }, operationQueue: queue });
  return { engine, queue };
}
const finance = { slug: 'finance', name: 'Finance' };
const promotions = { slug: 'promotions', name: 'Promotions' };
const oauth = { host: 'imap.gmail.com', authMethod: 'oauth2' as const, resolveBearer: async () => 'unused' };

describe('manual category synchronization capability preflight', () => {
  // Important uses IMAP's native flag and does not depend on Gmail's REST category permission.
  it('allows the independent importance flag without category OAuth requirements', () => {
    expect(() => fixture(null).engine.assertManualCategorySync('important')).not.toThrow();
    expect(() => fixture({ host: 'imap.gmail.com', authMethod: 'password' }).engine.assertManualCategorySync('important')).not.toThrow();
  });

  // A complete manual category snapshot can touch native tabs even for a custom category click.
  it('requires account-bound OAuth for every Gmail manual category edit', () => {
    for (const config of [{ host: 'imap.gmail.com', authMethod: 'password' as const }, { host: 'imap.gmail.com', authMethod: 'oauth2' as const }]) {
      for (const slug of ['finance', 'promotions']) expect(() => fixture(config).engine.assertManualCategorySync(slug)).toThrow(/OAuth/);
    }
    expect(() => fixture(oauth).engine.assertManualCategorySync('finance')).not.toThrow();
    expect(() => fixture({ ...oauth, host: 'tenant.example.test' }, true).engine.assertManualCategorySync('social')).not.toThrow();
  });

  // Folder-copy fallback cannot claim an in-place category removal on an ordinary IMAP account.
  it('requires a connected account and rejects generic folder-based category correction', () => {
    expect(() => fixture(null).engine.assertManualCategorySync('finance')).toThrow(/Connect/);
    expect(() => fixture({ host: 'imap.example.test' }).engine.assertManualCategorySync('finance')).toThrow(/cannot sync/);
    expect(() => fixture({ host: 'imap.sarv.com' }).engine.assertManualCategorySync('finance')).not.toThrow();
  });
});

describe('manual category and importance public durable actions', () => {
  // Preflight both desired and undesired categories before accepting one durable full snapshot.
  it('submits one complete selection and blocks unsupported accounts before enqueue', async () => {
    const data = { apply: [finance], remove: [promotions], host: 'imap.sarv.com', mode: 'copy' as const };
    const f = fixture({ host: 'imap.sarv.com' });
    expect(await f.engine.setCategorySelection('INBOX', 1413, data)).toBe('queued');
    expect(f.queue.setCategorySelection).toHaveBeenCalledWith('INBOX', 1413, data);
    const denied = fixture({ host: 'imap.gmail.com', authMethod: 'password' });
    await expect(denied.engine.setCategorySelection('INBOX', 1413, data)).rejects.toThrow(/OAuth/);
    expect(denied.queue.setCategorySelection).not.toHaveBeenCalled();
  });

  // Existing AI mirror operations retain their public wrappers and exact UID/payload scope.
  it('forwards legacy apply/remove and independent importance through the queue', async () => {
    const f = fixture({ host: 'imap.sarv.com' });
    const data = { categories: [finance], host: 'imap.sarv.com', mode: 'copy' as const };
    expect(await f.engine.applyCategoryLabels('INBOX', 1413, data)).toBe('success');
    expect(await f.engine.removeCategoryLabels('INBOX', 1413, data)).toBe('success');
    expect(f.queue.applyCategoryLabels).toHaveBeenCalledWith('INBOX', 1413, data);
    expect(f.queue.removeCategoryLabels).toHaveBeenCalledWith('INBOX', 1413, data);
    expect(await f.engine.markImportant('INBOX', 1413)).toBe('queued');
    expect(await f.engine.markImportant('INBOX', 1413, false)).toBe('queued');
    expect(f.queue.markImportant.mock.calls).toEqual([['INBOX', 1413, true], ['INBOX', 1413, false]]);
  });
});
