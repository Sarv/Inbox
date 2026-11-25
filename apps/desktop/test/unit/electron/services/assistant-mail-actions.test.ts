import { describe, expect, it, vi } from 'vitest';

import { changeAssistantReadFlags, changeAssistantStarFlags, type AssistantReadTarget } from '../../../../electron/services/assistant-mail-actions';
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

describe('Inbox Agent account-bound star receipts', () => {
  function starTarget() {
    const owner = target();
    const engine = { ...owner.engine, bulkStar: vi.fn(async () => 'queued' as const), bulkUnstar: vi.fn(async () => 'success' as const) };
    return { ...owner, engine };
  }

  // Breaks: a star the agent set never reaches the server, or touches the read flag and unread badge.
  it('stars through the durable queue without touching read state or counts', async () => {
    const owner = starTarget();
    expect(await changeAssistantStarFlags(owner, ['read', 'unread'], true)).toEqual({ appliedIds: [], queuedIds: ['read'], failedIds: [] });
    expect(owner.engine.bulkStar).toHaveBeenCalledExactlyOnceWith('INBOX', [11]);
    expect(owner.rows.get('read')?.tags).toBe('|INBOX|read|starred|');
    expect(owner.storage.applyReadFlagToFolderCountsBatch).not.toHaveBeenCalled();
    expect(owner.onChanged).toHaveBeenCalledExactlyOnceWith('read', true);
  });

  // Breaks: unstarring removes some other tag, or reports an already-unstarred message as changed.
  it('unstars only starred mail and keeps every other tag', async () => {
    const owner = starTarget();
    expect(await changeAssistantStarFlags(owner, ['unread', 'read'], false)).toEqual({ appliedIds: ['unread'], queuedIds: [], failedIds: [] });
    expect(owner.engine.bulkUnstar).toHaveBeenCalledExactlyOnceWith('INBOX', [10]);
    expect(owner.rows.get('unread')?.tags).toBe('|INBOX|');
  });

  // Breaks: an engine without star support (or a failed queue write) leaves a local star the server never gets.
  it('changes nothing when the queue cannot take the star', async () => {
    const owner = target();
    expect(await changeAssistantStarFlags(owner, ['read'], true)).toEqual({ appliedIds: [], queuedIds: [], failedIds: ['read'] });
    const failing = starTarget();
    failing.engine.bulkStar.mockResolvedValue('failed' as never);
    expect(await changeAssistantStarFlags(failing, ['read'], true)).toEqual({ appliedIds: [], queuedIds: [], failedIds: ['read'] });
    expect(failing.storage.updateEmail).not.toHaveBeenCalled();
  });

  // Breaks: a row whose folder is gone, an account with no queue, or a star someone set meanwhile is reported as the agent's change.
  it('fails rows it cannot queue and does not count a star that was already set', async () => {
    const owner = starTarget();
    owner.storage.getFolder.mockResolvedValueOnce(null as never);
    expect(await changeAssistantStarFlags(owner, ['read'], true)).toEqual({ appliedIds: [], queuedIds: [], failedIds: ['read'] });
    expect(await changeAssistantStarFlags({ ...owner, engine: null }, ['read'], true)).toEqual({ appliedIds: [], queuedIds: [], failedIds: ['read'] });
    const raced = starTarget();
    raced.engine.bulkStar.mockImplementation(async () => { raced.rows.get('read')!.tags = '|INBOX|read|starred|'; return 'queued'; });
    expect(await changeAssistantStarFlags(raced, ['read'], true)).toEqual({ appliedIds: [], queuedIds: [], failedIds: [] });
    expect(raced.storage.updateEmail).not.toHaveBeenCalled();
    expect(raced.onChanged).not.toHaveBeenCalled();
    // A row deleted while the queue wrote is not reported as changed either.
    const gone = starTarget();
    gone.engine.bulkStar.mockImplementation(async () => { gone.rows.delete('read'); return 'queued'; });
    expect(await changeAssistantStarFlags(gone, ['read'], true)).toEqual({ appliedIds: [], queuedIds: [], failedIds: [] });
  });

  // Breaks: a row with no tags at all cannot be starred.
  it('stars a row that has no tags yet', async () => {
    const owner = starTarget();
    owner.rows.get('read')!.tags = null as unknown as string;
    expect(await changeAssistantStarFlags(owner, ['read'], true)).toEqual({ appliedIds: [], queuedIds: ['read'], failedIds: [] });
    expect(owner.rows.get('read')?.tags).toBe('|starred|');
  });

  // Breaks: a malformed selection reaches the queue.
  it('rejects a malformed star request', async () => {
    await expect(changeAssistantReadFlags(starTarget(), [''], true)).rejects.toThrow('Invalid read action.');
    await expect(changeAssistantStarFlags(starTarget(), [''], true)).rejects.toThrow('Invalid star action.');
    await expect(changeAssistantStarFlags(starTarget(), ['read'], 'yes' as unknown as boolean)).rejects.toThrow('Invalid star action.');
  });
});
