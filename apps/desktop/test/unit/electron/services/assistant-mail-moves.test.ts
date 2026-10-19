import type { FolderRecord } from '@sarvinbox/core';
import { describe, expect, it, vi } from 'vitest';

import { changeAssistantMailLocation, type AssistantMoveTarget } from '../../../../electron/services/assistant-mail-moves';
import { emailRecord } from '../../../helpers/email-fixtures';

const folder = (id: string, path: string, specialUse: string): FolderRecord => ({ id, path, name: path, specialUse }) as FolderRecord;

function target() {
  const folders = [folder('inbox', 'INBOX', '\\Inbox'), folder('archive', 'Archive', '\\Archive'),
    folder('trash', 'Trash', '\\Trash'), folder('sent', 'Sent', '\\Sent')];
  const rows = new Map([
    ['one', emailRecord({ id: 'one', uid: 10, folderId: 'inbox', tags: '|INBOX|starred|read|Client|' })],
    ['two', emailRecord({ id: 'two', uid: 11, folderId: 'inbox', tags: '|INBOX|' })],
    ['sent', emailRecord({ id: 'sent', uid: 30, folderId: 'sent', tags: '|Sent|read|' })],
    ['archived', emailRecord({ id: 'archived', uid: 40, folderId: 'archive', tags: '|Archive|' })],
  ]);
  const value = {
    storage: {
      getEmail: vi.fn(async (id: string) => rows.has(id) ? { ...rows.get(id)! } : null),
      getFolder: vi.fn(async (id: string) => folders.find(item => item.id === id) ?? null),
      getFolders: vi.fn(async () => folders),
      countEmailsFiledIn: vi.fn(async (_id: string) => 1),
      updateEmail: vi.fn(async (id: string, patch: object) => { Object.assign(rows.get(id)!, patch); }),
      recalculateFolderCounts: vi.fn(async () => {}),
    },
    engine: {
      move: vi.fn(async (_path: string, _uid: number, _destination: string, _emailId?: string) => 'queued' as 'queued' | 'success' | 'failed'),
      isConnected: vi.fn(() => false), fetchUidByMessageId: vi.fn(async () => null as number | null),
    },
    assertCurrent: vi.fn(async () => {}), onChanged: vi.fn(async () => {}),
  } satisfies AssistantMoveTarget;
  return { ...value, rows, folders };
}

describe('Inbox Agent account-bound reversible mail moves', () => {
  it('archives only Inbox members and acknowledges sent/previously archived members as unchanged', async () => {
    const owner = target();
    expect(await changeAssistantMailLocation(owner, ['one', 'sent', 'archived', 'missing', 'one'], 'archive')).toEqual({
      appliedIds: ['sent', 'archived'], queuedIds: ['one'], failedIds: ['missing'],
    });
    expect(owner.engine.move).toHaveBeenCalledExactlyOnceWith('INBOX', 10, 'Archive', 'one');
    expect(owner.rows.get('one')).toMatchObject({ folderId: 'archive', uid: null, tags: '|starred|read|Client|Archive|' });
    expect(owner.rows.get('sent')).toMatchObject({ folderId: 'sent', uid: 30, tags: '|Sent|read|' });
    expect(owner.storage.recalculateFolderCounts).toHaveBeenCalledExactlyOnceWith(['INBOX', 'Archive']);
    expect(owner.onChanged).toHaveBeenCalledExactlyOnceWith('one', 'archive', 'Archive');
  });

  it('persists a reversible Trash move with exact IDs, with no source UIDs in its destination', async () => {
    const owner = target();
    owner.engine.move.mockImplementation(async (_path, _uid, _destination, emailId) => {
      expect(owner.rows.get(emailId!)).toMatchObject({ folderId: 'trash', uid: null });
      return 'queued';
    });
    expect(await changeAssistantMailLocation(owner, ['one', 'two'], 'trash')).toEqual({ appliedIds: [], queuedIds: ['one', 'two'], failedIds: [] });
    expect(owner.engine.move).toHaveBeenNthCalledWith(1, 'INBOX', 10, 'Trash', 'one');
    expect(owner.engine.move).toHaveBeenNthCalledWith(2, 'INBOX', 11, 'Trash', 'two');
    expect(owner.rows.get('one')?.tags).toBe('|starred|read|Client|Trash|');
  });

  it('keeps destination UIDs assigned during an immediately completed move', async () => {
    const owner = target();
    owner.engine.move.mockImplementation(async () => { owner.rows.get('one')!.uid = 81; return 'success'; });
    expect(await changeAssistantMailLocation(owner, ['one'], 'trash')).toEqual({ appliedIds: ['one'], queuedIds: [], failedIds: [] });
    expect(owner.rows.get('one')?.uid).toBe(81);
  });

  it.each(['trash', 'archive'] as const)('restores original local membership if the %s queue rejects', async action => {
    const owner = target();
    const before = { ...owner.rows.get('one')! };
    owner.engine.move.mockRejectedValue(new Error('queue unavailable'));
    expect(await changeAssistantMailLocation(owner, ['one'], action)).toEqual({ appliedIds: [], queuedIds: [], failedIds: ['one'] });
    expect(owner.rows.get('one')).toEqual(before);
    expect(owner.onChanged).not.toHaveBeenCalled();
  });

  it('requires a Trash folder and never falls back to deletion', async () => {
    const owner = target(); owner.folders.splice(2, 1);
    await expect(changeAssistantMailLocation(owner, ['one'], 'trash')).rejects.toThrow('Trash folder is unavailable');
    expect(owner.storage.updateEmail).not.toHaveBeenCalled();
    expect(owner.engine.move).not.toHaveBeenCalled();
  });

  it('uses the app canonical Trash path when a server publishes multiple aliases', async () => {
    const owner = target();
    Object.assign(owner.folders[2], { uidValidity: 42, serverMessageCount: 50 });
    const canonical = folder('canonical-trash', 'Deleted Items', '');
    Object.assign(canonical, { uidValidity: 42, serverMessageCount: 50 });
    owner.folders.push(canonical);
    owner.storage.countEmailsFiledIn.mockImplementation(async id => id === canonical.id ? 50 : 0);
    expect(await changeAssistantMailLocation(owner, ['one'], 'trash')).toEqual({ appliedIds: [], queuedIds: ['one'], failedIds: [] });
    expect(owner.engine.move).toHaveBeenCalledExactlyOnceWith('INBOX', 10, 'Deleted Items', 'one');
    expect(owner.rows.get('one')).toMatchObject({ folderId: 'canonical-trash', tags: '|starred|read|Client|Deleted Items|' });
    expect(owner.storage.recalculateFolderCounts).toHaveBeenCalledExactlyOnceWith(['INBOX', 'Deleted Items']);
  });

  it('keeps exact per-message receipts when one canonical Trash move succeeds and another rejects', async () => {
    const owner = target();
    owner.engine.move.mockResolvedValueOnce('success').mockResolvedValueOnce('failed');
    expect(await changeAssistantMailLocation(owner, ['one', 'two'], 'trash')).toEqual({ appliedIds: ['one'], queuedIds: [], failedIds: ['two'] });
    expect(owner.rows.get('one')).toMatchObject({ folderId: 'trash', uid: null });
    expect(owner.rows.get('two')).toMatchObject({ folderId: 'inbox', uid: 11, tags: '|INBOX|' });
    expect(owner.onChanged).toHaveBeenCalledExactlyOnceWith('one', 'trash', 'Trash');
  });

  it('leaves mail intact when its named account has no operation queue', async () => {
    const owner = target();
    expect(await changeAssistantMailLocation({ ...owner, engine: null }, ['one'], 'trash')).toEqual({ appliedIds: [], queuedIds: [], failedIds: ['one'] });
    expect(owner.storage.updateEmail).not.toHaveBeenCalled();
  });

  it('archives a secondary Gmail Inbox label using its own UID, preserving custom labels and Sent', async () => {
    const owner = target();
    Object.assign(owner.folders[1], { path: '[Gmail]/All Mail', specialUse: '\\All' });
    Object.assign(owner.rows.get('one')!, { folderId: 'archive', uid: 201, tags: '|[Gmail]/All Mail|INBOX|Sent|read|Client|' });
    owner.engine.isConnected.mockReturnValue(true); owner.engine.fetchUidByMessageId.mockResolvedValue(51);
    expect((await changeAssistantMailLocation(owner, ['one'], 'archive')).queuedIds).toEqual(['one']);
    expect(owner.engine.fetchUidByMessageId).toHaveBeenCalledExactlyOnceWith('INBOX', 'm1@x');
    expect(owner.engine.move).toHaveBeenCalledExactlyOnceWith('INBOX', 51, '[Gmail]/All Mail', 'one');
    expect(owner.rows.get('one')?.tags).toBe('|[Gmail]/All Mail|Sent|read|Client|');
  });

  it('does not send an All Mail UID into Inbox while offline', async () => {
    const owner = target();
    Object.assign(owner.rows.get('one')!, { folderId: 'archive', uid: 201, tags: '|Archive|INBOX|' });
    expect((await changeAssistantMailLocation(owner, ['one'], 'archive')).failedIds).toEqual(['one']);
    expect(owner.engine.move).not.toHaveBeenCalled();
    expect(owner.storage.updateEmail).not.toHaveBeenCalled();
  });

  it('does not silently claim UID-less synced messages were moved locally', async () => {
    const owner = target(); owner.rows.get('one')!.uid = 0;
    expect((await changeAssistantMailLocation(owner, ['one'], 'trash')).failedIds).toEqual(['one']);
    expect(owner.storage.updateEmail).not.toHaveBeenCalled();
  });

  it('rejects duplicate source UIDs rather than mapping two rows to one moved message', async () => {
    const owner = target(); owner.rows.get('two')!.uid = 10;
    expect(await changeAssistantMailLocation(owner, ['one', 'two'], 'trash')).toEqual({ appliedIds: [], queuedIds: [], failedIds: ['one', 'two'] });
    expect(owner.storage.updateEmail).not.toHaveBeenCalled();
    expect(owner.engine.move).not.toHaveBeenCalled();
  });

  it('revalidates account identity before writing and before enqueueing each group', async () => {
    const owner = target();
    owner.assertCurrent.mockResolvedValueOnce().mockRejectedValueOnce(new Error('account replaced'));
    expect((await changeAssistantMailLocation(owner, ['one'], 'trash')).failedIds).toEqual(['one']);
    expect(owner.storage.updateEmail).not.toHaveBeenCalled();
    expect(owner.engine.move).not.toHaveBeenCalled();
  });

  it('revalidates rows after asynchronous UID lookup and refuses concurrent moves', async () => {
    const owner = target();
    Object.assign(owner.rows.get('one')!, { folderId: 'archive', tags: '|Archive|INBOX|' });
    owner.engine.isConnected.mockReturnValue(true);
    owner.engine.fetchUidByMessageId.mockImplementation(async () => {
      // Return immutable storage snapshots, as the real repository does.
      owner.rows.get('one')!.folderId = 'sent'; return 51;
    });
    owner.storage.getEmail.mockImplementation(async id => owner.rows.has(id) ? { ...owner.rows.get(id)! } : null);
    expect((await changeAssistantMailLocation(owner, ['one'], 'archive')).failedIds).toEqual(['one']);
    expect(owner.storage.updateEmail).not.toHaveBeenCalled();
  });

  it('does not turn an accepted server move into failure when logging or recount fails', async () => {
    const owner = target(); owner.engine.move.mockResolvedValue('success');
    owner.onChanged.mockRejectedValue(new Error('learning unavailable'));
    owner.storage.recalculateFolderCounts.mockRejectedValue(new Error('count unavailable'));
    expect(await changeAssistantMailLocation(owner, ['one'], 'archive')).toEqual({ appliedIds: ['one'], queuedIds: [], failedIds: [] });
    expect(owner.rows.get('one')?.folderId).toBe('archive');
  });

  it('does not overwrite a later user move when restoring a rejected move', async () => {
    const owner = target(); owner.engine.move.mockImplementation(async () => {
      Object.assign(owner.rows.get('one')!, { folderId: 'sent', uid: 99, tags: '|Sent|' });
      throw new Error('move failed');
    });
    expect((await changeAssistantMailLocation(owner, ['one'], 'archive')).failedIds).toEqual(['one']);
    expect(owner.rows.get('one')).toMatchObject({ folderId: 'sent', uid: 99, tags: '|Sent|' });
  });

  it('preserves concurrent read, star and custom-label decisions when rolling back rejected Trash', async () => {
    const owner = target();
    owner.engine.move.mockImplementation(async () => {
      owner.rows.get('two')!.tags = '|Trash|read|starred|important|Client/New|';
      throw new Error('queue rejected');
    });
    expect((await changeAssistantMailLocation(owner, ['two'], 'trash')).failedIds).toEqual(['two']);
    expect(owner.rows.get('two')).toMatchObject({ folderId: 'inbox', uid: 11 });
    expect(owner.rows.get('two')!.tags.split('|').filter(Boolean).sort()).toEqual(['Client/New', 'INBOX', 'important', 'read', 'starred'].sort());
  });

  it.each([[''], ['a'.repeat(501)], Array.from({ length: 2001 }, (_, index) => String(index))].map(ids => ({ ids })))('rejects malformed or oversized row selections', async ({ ids }) => {
    const owner = target();
    await expect(changeAssistantMailLocation(owner, ids as unknown as string[], 'trash')).rejects.toThrow('Invalid mail move action');
    expect(owner.storage.getEmail).not.toHaveBeenCalled();
  });
});
