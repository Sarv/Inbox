import { describe, expect, it, vi } from 'vitest';

import { changeAssistantReadFlags, type AssistantReadTarget } from '../../../../electron/services/assistant-mail-actions';
import { emailRecord } from '../../../helpers/email-fixtures';

function target() {
  const rows = new Map([
    ['unread', emailRecord({ id: 'unread', uid: 10, folderId: 'inbox', tags: '|INBOX|starred|' })],
    ['local', emailRecord({ id: 'local', uid: 0, folderId: 'inbox', tags: '|INBOX|' })],
    ['read', emailRecord({ id: 'read', uid: 11, folderId: 'inbox', tags: '|INBOX|read|' })],
  ]);
  const result = {
    storage: {
      getEmail: vi.fn(async (id: string) => rows.get(id) ?? null),
      getFolder: vi.fn(async () => ({ path: 'INBOX' })),
      updateEmail: vi.fn(async (id: string, patch: object) => { Object.assign(rows.get(id)!, patch); }),
      applyReadFlagToFolderCountsBatch: vi.fn(async () => {}),
      recalculateFolderCounts: vi.fn(async () => {}),
    },
    engine: { bulkMarkAsRead: vi.fn(async () => 'queued' as const), bulkMarkAsUnread: vi.fn(async () => 'success' as const) },
    assertCurrent: vi.fn(async () => {}), onChanged: vi.fn(async () => {}),
  } satisfies AssistantReadTarget;
  return { ...result, rows };
}

describe('Inbox Agent account-bound read receipts', () => {
  it('persists offline changes before updating flags and rejects rows without a server UID', async () => {
    const owner = target();
    owner.engine.bulkMarkAsRead.mockImplementation(async () => {
      expect(owner.storage.updateEmail).not.toHaveBeenCalled();
      return 'queued';
    });
    expect(await changeAssistantReadFlags(owner, ['unread', 'local', 'read', 'missing', 'unread'], true)).toEqual({
      appliedIds: [], queuedIds: ['unread'], failedIds: ['local', 'missing'],
    });
    expect(owner.engine.bulkMarkAsRead).toHaveBeenCalledExactlyOnceWith('INBOX', [10]);
    expect(owner.rows.get('unread')?.tags).toContain('|starred|');
    expect(owner.rows.get('unread')?.tags).toContain('|read|');
    expect(owner.rows.get('local')?.tags).toBe('|INBOX|');
    expect(owner.onChanged).toHaveBeenCalledTimes(1);
    expect(owner.storage.applyReadFlagToFolderCountsBatch).toHaveBeenCalledTimes(1);
  });

  it.each([true, false])('does not acknowledge a pending real MOVE with a null UID as locally applied (read=%s)', async read => {
    const owner = target();
    owner.rows.set('moving', emailRecord({
      id: 'moving', messageId: '<real-server-message@example.test>', folderId: 'trash',
      uid: null as unknown as number, tags: read ? '|Trash|' : '|Trash|read|',
    }));
    expect(await changeAssistantReadFlags(owner, ['moving'], read)).toEqual({ appliedIds: [], queuedIds: [], failedIds: ['moving'] });
    expect(owner.rows.get('moving')?.tags).toBe(read ? '|Trash|' : '|Trash|read|');
    expect(owner.engine.bulkMarkAsRead).not.toHaveBeenCalled();
    expect(owner.engine.bulkMarkAsUnread).not.toHaveBeenCalled();
    expect(owner.storage.updateEmail).not.toHaveBeenCalled();
    expect(owner.storage.applyReadFlagToFolderCountsBatch).not.toHaveBeenCalled();
    expect(owner.onChanged).not.toHaveBeenCalled();
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1.5, undefined])('rejects unusable UIDs without assuming local-only mail (%s)', async uid => {
    const owner = target(); owner.rows.get('unread')!.uid = uid as number;
    expect(await changeAssistantReadFlags(owner, ['unread'], true)).toEqual({ appliedIds: [], queuedIds: [], failedIds: ['unread'] });
    expect(owner.engine.bulkMarkAsRead).not.toHaveBeenCalled();
    expect(owner.storage.updateEmail).not.toHaveBeenCalled();
  });

  it.each([true, false])('does not infer local-only mail when no sync engine is available (read=%s)', async read => {
    const owner = target(); owner.rows.get('local')!.tags = read ? '|INBOX|' : '|INBOX|read|';
    expect(await changeAssistantReadFlags({ ...owner, engine: null }, ['local'], read)).toEqual({ appliedIds: [], queuedIds: [], failedIds: ['local'] });
    expect(owner.storage.updateEmail).not.toHaveBeenCalled();
  });

  it('keeps messages unread when durable queueing fails', async () => {
    const owner = target();
    owner.engine.bulkMarkAsRead.mockRejectedValue(new Error('queue unavailable'));
    expect(await changeAssistantReadFlags(owner, ['unread'], true)).toEqual({ appliedIds: [], queuedIds: [], failedIds: ['unread'] });
    expect(owner.storage.updateEmail).not.toHaveBeenCalled();
  });

  it('does not mutate a replacement or disconnected account after awaiting queueing', async () => {
    const owner = target();
    owner.assertCurrent.mockResolvedValueOnce().mockResolvedValueOnce().mockRejectedValue(new Error('account changed'));
    expect((await changeAssistantReadFlags(owner, ['unread'], true)).failedIds).toEqual(['unread']);
    expect(owner.storage.updateEmail).not.toHaveBeenCalled();
  });

  it('restores only the supplied previously changed messages through the same queue', async () => {
    const owner = target();
    await changeAssistantReadFlags(owner, ['unread'], true);
    expect(await changeAssistantReadFlags(owner, ['unread'], false)).toEqual({ appliedIds: ['unread'], queuedIds: [], failedIds: [] });
    expect(owner.engine.bulkMarkAsUnread).toHaveBeenCalledExactlyOnceWith('INBOX', [10]);
    expect(owner.rows.get('read')?.tags).toContain('|read|');
  });
});
