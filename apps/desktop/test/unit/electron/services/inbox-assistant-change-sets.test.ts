import type { EmailRecord, FolderRecord } from '@sarvinbox/core';
import { describe, expect, it, vi } from 'vitest';

import type { AssistantReadReceipt } from '../../../../electron/services/assistant-mail-actions';
import {
  applyChangeSet, cancelChangeSet, changeCounts, changeProtection, changeSummary, INBOX_AGENT_CHANGE_LIMITS, stageChangeSet,
  undoChangeSet, type HeldChangeSet, type InboxAgentMailActions,
} from '../../../../electron/services/inbox-assistant-change-sets';
import type { InboxAgentChangeAction } from '../../../../src/types/inbox-assistant-changes';
import { emailRecord } from '../../../helpers/email-fixtures';

const T0 = 1_800_000_000_000;

const folder = (id: string, path: string, specialUse: string | null): FolderRecord => ({
  id, name: path, path, parentId: null, uidValidity: 1, lastSyncUid: null, lastSyncTime: null,
  totalCount: 0, unreadCount: 0, specialUse, subscribed: true, createdAt: 0, updatedAt: 0,
});
const FOLDERS = [folder('f-inbox', 'INBOX', '\\Inbox'), folder('f-trash', 'Trash', '\\Trash'), folder('f-work', 'Work', null), folder('f-archive', 'Archive', '\\Archive')];

/**
 * A fake mailbox behind the change actions: each action changes `rows` the
 * way the real services change the database, and records the call.
 */
function mailbox(initial: Array<Partial<EmailRecord> & { id: string; account?: string }>) {
  const rows = new Map(initial.map(({ account = 'a1', ...row }) => [`${account}:${row.id}`, emailRecord({ folderId: 'f-inbox', tags: '|INBOX|', ...row })]));
  const calls: Array<{ op: string; accountId: string; ids: string[]; arg?: unknown }> = [];
  const failing = new Set<string>();
  const thrown = new Set<string>();
  const change = (op: string, accountId: string, ids: string[], arg: unknown, edit: (row: EmailRecord) => boolean): AssistantReadReceipt => {
    calls.push({ op, accountId, ids: [...ids], ...(arg === undefined ? {} : { arg }) });
    if (thrown.has(accountId)) throw new Error('account gone');
    const receipt: AssistantReadReceipt = { appliedIds: [], queuedIds: [], failedIds: [] };
    for (const id of ids) {
      const row = rows.get(`${accountId}:${id}`);
      if (!row || failing.has(id)) { receipt.failedIds.push(id); continue; }
      if (edit(row)) receipt.appliedIds.push(id);
    }
    return receipt;
  };
  const tag = (row: EmailRecord, name: string, on: boolean) => {
    const has = row.tags.includes(`|${name}|`);
    if (has === on) return false;
    row.tags = on ? `${row.tags}${name}|` : row.tags.replace(`|${name}|`, '|');
    return true;
  };
  const place = (row: EmailRecord, id: string) => {
    const destination = FOLDERS.find(item => item.id === id)!;
    const kept = row.tags.split('|').filter(item => item && !FOLDERS.some(known => known.path === item));
    row.tags = `|${[destination.path, ...kept].join('|')}|`;
    row.folderId = id;
    return true;
  };
  const actions: InboxAgentMailActions = {
    setRead: async (accountId, ids, read) => change(read ? 'read' : 'unread', accountId, ids, undefined, row => tag(row, 'read', read)),
    setStarred: async (accountId, ids, starred) => change(starred ? 'star' : 'unstar', accountId, ids, undefined, row => tag(row, 'starred', starred)),
    setCategory: async (accountId, ids, slug, on) => change(on ? 'category+' : 'category-', accountId, ids, slug, row => tag(row, slug, on)),
    restore: async (accountId, ids) => change('restore', accountId, ids, undefined, row => place(row, 'f-inbox')),
    move: async (accountId, ids, to) => change('move', accountId, ids, to, row => {
      const id = to === 'trash' ? 'f-trash' : to === 'archive' ? 'f-archive' : to.folderId;
      return row.folderId === id ? true : place(row, id);
    }),
  };
  const readEmail = vi.fn(async (accountId: string, emailId: string) => rows.get(`${accountId}:${emailId}`) ?? null);
  return { rows, calls, actions, readEmail, failing, thrown, row: (id: string, account = 'a1') => rows.get(`${account}:${id}`)! };
}

function stage(box: ReturnType<typeof mailbox>, action: InboxAgentChangeAction, ids: Array<string | [string, string]>, extra: { protect?: string[]; category?: string; folder?: FolderRecord } = {}): HeldChangeSet {
  return stageChangeSet({
    label: 'C1', action, nowMs: T0, ...(extra.category ? { category: extra.category } : {}), ...(extra.folder ? { folder: extra.folder } : {}),
    targets: ids.map(entry => {
      const [account, id] = Array.isArray(entry) ? entry : ['a1', entry];
      return { accountId: account, accountEmail: `${account}@example.test`, email: { ...box.row(id, account) }, folders: FOLDERS,
        ...(extra.protect?.includes(id) ? { protectedReason: 'Starred' } : {}) };
    }),
  });
}

const options = (box: ReturnType<typeof mailbox>, over: Partial<Parameters<typeof applyChangeSet>[1]> = {}) => ({ actions: box.actions, readEmail: box.readEmail, nowMs: T0 + 1_000, ...over });
const statuses = (held: HeldChangeSet) => held.set.items.map(item => item.status);

describe('staging a change set', () => {
  // Breaks: the card title says something other than what will happen.
  it.each([
    ['mark_read', 1, undefined, 'Mark 1 email read'], ['mark_unread', 2, undefined, 'Mark 2 emails unread'], ['star', 2, undefined, 'Star 2 emails'],
    ['unstar', 1, undefined, 'Unstar 1 email'], ['archive', 3, undefined, 'Archive 3 emails'], ['trash', 2, undefined, 'Move 2 emails to Trash'],
    ['restore', 2, undefined, 'Restore 2 emails from Trash'], ['move', 2, 'Work', 'Move 2 emails to Work'],
    ['add_category', 2, 'promotions', 'Add 2 emails to category promotions'], ['remove_category', 1, 'promotions', 'Remove 1 email from category promotions'],
  ] as const)('summarises %s', (action, count, target, expected) => {
    expect(changeSummary(action, count, target)).toBe(expected);
  });

  // Breaks: a security code, a bank alert or starred mail is archived or marked read with the rest.
  it('protects starred, important and sensitive mail only for actions that hide it', () => {
    const plain = { subject: 'Weekly deals', fromAddress: 'shop@example.test' };
    expect(changeProtection('archive', { ...plain, tags: '|INBOX|starred|' }, '')).toBe('Starred');
    expect(changeProtection('mark_read', { ...plain, tags: '|INBOX|important|' }, '')).toBe('Marked important');
    expect(changeProtection('trash', { ...plain, tags: '|INBOX|' }, 'Your verification code is 482913')).toMatch(/security content/);
    expect(changeProtection('move', { ...plain, tags: '|INBOX|' }, 'Rs. 4,000 debited from your account')).toMatch(/Financial/);
    expect(changeProtection('mark_read', { ...plain, tags: '|INBOX|' }, 'Big sale this weekend')).toBeUndefined();
    // Starring, restoring or marking unread hides nothing: no protection applies.
    for (const action of ['star', 'unstar', 'mark_unread', 'restore', 'add_category'] as const) {
      expect(changeProtection(action, { ...plain, tags: '|INBOX|starred|' }, 'Your verification code is 482913')).toBeUndefined();
    }
  });

  // Breaks: Undo of a Gmail archive puts mail somewhere other than the Inbox it was in.
  it('remembers where each message was, with its Inbox when it carried one', () => {
    const box = mailbox([{ id: 'm1' }, { id: 'm2', folderId: 'f-work', tags: '|Work|' }]);
    const held = stage(box, 'archive', ['m1', 'm2']);
    expect(held.set).toMatchObject({ label: 'C1', status: 'pending', approveBy: T0 + INBOX_AGENT_CHANGE_LIMITS.approveMs, undoBy: 0 });
    expect(held.set.items.map(item => item.id)).toEqual(['c1-1', 'c1-2']);
    expect([...held.items.values()].map(entry => [entry.originFolderId, entry.originIsInbox])).toEqual([['f-inbox', true], ['f-work', false]]);
  });
});

describe('applying a change set', () => {
  // Breaks: approving the card changes protected mail the user never ticked.
  it('applies every unprotected row by default and declines the rest', async () => {
    const box = mailbox([{ id: 'm1' }, { id: 'm2' }, { id: 'm3' }]);
    const held = stage(box, 'mark_read', ['m1', 'm2', 'm3'], { protect: ['m3'] });
    await applyChangeSet(held, options(box));
    expect(statuses(held)).toEqual(['applied', 'applied', 'skipped']);
    expect(held.set.items[2]!.detail).toBe('Not selected.');
    expect(box.calls).toEqual([{ op: 'read', accountId: 'a1', ids: ['m1', 'm2'] }]);
    expect(held.set.status).toBe('applied');
    expect(held.set.undoBy).toBe(T0 + 1_000 + INBOX_AGENT_CHANGE_LIMITS.undoMs);
  });

  // Breaks: a protected row the user explicitly ticked is still dropped.
  it('applies a protected row when the user selects it', async () => {
    const box = mailbox([{ id: 'm1' }, { id: 'm2' }]);
    const held = stage(box, 'archive', ['m1', 'm2'], { protect: ['m2'] });
    await applyChangeSet(held, options(box, { itemIds: ['c1-2'] }));
    expect(statuses(held)).toEqual(['skipped', 'applied']);
    expect(box.row('m2').folderId).toBe('f-archive');
  });

  // Breaks: a second approval (a double click, a retried IPC) applies the change twice.
  it('never applies a row twice, and refuses a second approval of a finished set', async () => {
    const box = mailbox([{ id: 'm1' }]);
    const held = stage(box, 'star', ['m1']);
    await applyChangeSet(held, options(box));
    await expect(applyChangeSet(held, options(box))).rejects.toThrow('already applied');
    expect(box.calls).toHaveLength(1);
  });

  // Breaks: a transient failure (connection blip) is final, or a retry re-applies the rows that succeeded.
  it('retries only the rows that failed', async () => {
    const box = mailbox([{ id: 'm1' }, { id: 'm2' }]);
    box.failing.add('m2');
    const held = stage(box, 'mark_read', ['m1', 'm2']);
    await applyChangeSet(held, options(box));
    expect(statuses(held)).toEqual(['applied', 'failed']);
    expect(held.set.status).toBe('partial');
    expect(held.set.items[1]!.detail).toMatch(/Approve again to retry/);
    box.failing.clear();
    // Approving again with no rows named (the card's default) still runs only the failed row.
    await applyChangeSet(held, options(box));
    expect(box.calls.map(call => call.ids)).toEqual([['m1', 'm2'], ['m2']]);
    expect(statuses(held)).toEqual(['applied', 'applied']);
    expect(held.set.status).toBe('applied');
  });

  // Breaks: one account that disconnects fails the whole set, or its failure is reported as success.
  it('fails only the rows of an account whose action throws', async () => {
    const box = mailbox([{ id: 'm1', account: 'a1' }, { id: 'm1', account: 'a2' }]);
    box.thrown.add('a2');
    const held = stage(box, 'mark_read', [['a1', 'm1'], ['a2', 'm1']]);
    await applyChangeSet(held, options(box));
    expect(statuses(held)).toEqual(['applied', 'failed']);
    expect(box.row('m1', 'a1').tags).toContain('|read|');
  });

  // Breaks: a message the user moved after the agent prepared the set is dragged back out of its new folder.
  it('skips a moved or deleted message, and fails one whose account cannot be read', async () => {
    const box = mailbox([{ id: 'm1' }, { id: 'm2' }, { id: 'm3' }, { id: 'm4' }]);
    const held = stage(box, 'trash', ['m1', 'm2', 'm3', 'm4']);
    box.row('m1').folderId = 'f-work';
    box.rows.delete('a1:m2');
    box.readEmail.mockImplementation(async (account, id) => {
      if (id === 'm3') throw new Error('locked');
      return box.rows.get(`${account}:${id}`) ?? null;
    });
    await applyChangeSet(held, options(box));
    expect(held.set.items.map(item => [item.status, item.detail])).toEqual([
      ['skipped', 'It was moved after the change was prepared.'], ['skipped', 'It no longer exists.'],
      ['failed', 'Its account could not be opened.'], ['applied', undefined],
    ]);
    expect(box.calls).toEqual([{ op: 'move', accountId: 'a1', ids: ['m4'], arg: 'trash' }]);
  });

  // Breaks: the card counts a message as changed when it already was as asked (and Undo would then change it).
  it('reports rows already as asked as unchanged, for flags and for moves', async () => {
    const box = mailbox([{ id: 'm1', tags: '|INBOX|read|' }, { id: 'm2', folderId: 'f-work', tags: '|Work|' }]);
    const read = stage(box, 'mark_read', ['m1']);
    await applyChangeSet(read, options(box));
    expect(statuses(read)).toEqual(['unchanged']);
    const moved = stage(box, 'move', ['m2'], { folder: FOLDERS[2] });
    await applyChangeSet(moved, options(box));
    expect(statuses(moved)).toEqual(['unchanged']);
    expect(moved.set.undoBy).toBe(0);
  });

  // Breaks: a set approved long after it was prepared acts on a stale picture of the mailbox.
  it('refuses approval after the approval window, and marks a pending set expired', async () => {
    const box = mailbox([{ id: 'm1' }]);
    const held = stage(box, 'mark_read', ['m1']);
    await expect(applyChangeSet(held, options(box, { nowMs: T0 + INBOX_AGENT_CHANGE_LIMITS.approveMs + 1 }))).rejects.toThrow('waited too long');
    expect(held.set.status).toBe('expired');
    expect(box.calls).toEqual([]);
  });

  // Breaks: two approvals racing (two windows, a double click) both run.
  it('refuses a second decision while one is running', async () => {
    const box = mailbox([{ id: 'm1' }]);
    const held = stage(box, 'mark_read', ['m1']);
    let release!: () => void;
    const original = box.actions.setRead;
    box.actions.setRead = async (...args) => { await new Promise<void>(resolve => { release = resolve; }); return original(...args); };
    const first = applyChangeSet(held, options(box));
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    await expect(applyChangeSet(held, options(box))).rejects.toThrow('already being applied');
    expect(() => cancelChangeSet(held)).toThrow('being applied');
    release();
    await first;
    expect(statuses(held)).toEqual(['applied']);
  });

  // Breaks: a row id from another card is accepted and nothing (or the wrong row) changes.
  it('refuses rows that are not in the set', async () => {
    const box = mailbox([{ id: 'm1' }]);
    const held = stage(box, 'mark_read', ['m1']);
    await expect(applyChangeSet(held, options(box, { itemIds: ['c9-1'] }))).rejects.toThrow('Choose rows from this change set');
    expect(held.set.status).toBe('pending');
  });

  // Breaks: "Approve for me" applies protected mail, or closes the card so the user cannot decide on it.
  it('auto-applies only unprotected rows and leaves protected ones pending on the card', async () => {
    const box = mailbox([{ id: 'm1' }, { id: 'm2' }]);
    const held = stage(box, 'mark_read', ['m1', 'm2'], { protect: ['m2'] });
    await applyChangeSet(held, options(box, { auto: true }));
    expect(statuses(held)).toEqual(['applied', 'pending']);
    expect(held.set).toMatchObject({ status: 'partial', autoApplied: true });
    // The user can still approve the protected row from the card.
    await applyChangeSet(held, options(box, { itemIds: ['c1-2'] }));
    expect(statuses(held)).toEqual(['applied', 'applied']);
    expect(held.set.status).toBe('applied');
  });

  // Breaks: an auto-applied set with nothing protected stays "partial" and offers Approve again.
  it('closes an auto-applied set with nothing left to decide', async () => {
    const box = mailbox([{ id: 'm1' }]);
    const held = stage(box, 'star', ['m1']);
    await applyChangeSet(held, options(box, { auto: true }));
    expect(held.set).toMatchObject({ status: 'applied', autoApplied: true });
  });

  // Breaks: Stop during a long apply is ignored and later accounts still change.
  it('stops between accounts when the request is stopped', async () => {
    const box = mailbox([{ id: 'm1', account: 'a1' }, { id: 'm1', account: 'a2' }]);
    const held = stage(box, 'mark_read', [['a1', 'm1'], ['a2', 'm1']]);
    const controller = new AbortController();
    const original = box.actions.setRead;
    box.actions.setRead = async (...args) => { const receipt = await original(...args); controller.abort(new Error('Stopped')); return receipt; };
    await expect(applyChangeSet(held, options(box, { signal: controller.signal }))).rejects.toThrow('Stopped');
    expect(box.calls.map(call => call.accountId)).toEqual(['a1']);
    expect(held.busy).toBe(false);
  });
});

describe('cancelling', () => {
  // Breaks: a cancelled card can still be approved later.
  it('cancels a pending set and refuses to apply it afterwards', async () => {
    const box = mailbox([{ id: 'm1' }]);
    const held = stage(box, 'archive', ['m1']);
    cancelChangeSet(held);
    expect(held.set.status).toBe('cancelled');
    expect(held.set.items[0]).toMatchObject({ status: 'skipped', detail: 'Cancelled.' });
    await expect(applyChangeSet(held, options(box))).rejects.toThrow('cancelled');
    expect(() => cancelChangeSet(held)).toThrow('can no longer be cancelled');
  });

  // Breaks: leaving the protected rest of an auto-applied set throws away its Undo.
  it('leaves the applied rows of a partly applied set undoable', async () => {
    const box = mailbox([{ id: 'm1' }, { id: 'm2' }]);
    const held = stage(box, 'mark_read', ['m1', 'm2'], { protect: ['m2'] });
    await applyChangeSet(held, options(box, { auto: true }));
    cancelChangeSet(held);
    expect(held.set.status).toBe('applied');
    await undoChangeSet(held, options(box));
    expect(box.row('m1').tags).not.toContain('|read|');
  });
});

describe('undo', () => {
  // Breaks: Undo applies the wrong inverse, so mail ends up somewhere it never was.
  it.each([
    ['mark_read', {}, 'unread'], ['mark_unread', { tags: '|INBOX|read|' }, 'read'], ['star', {}, 'unstar'], ['unstar', { tags: '|INBOX|starred|' }, 'star'],
    ['add_category', {}, 'category-'], ['remove_category', { tags: '|INBOX|promotions|' }, 'category+'],
  ] as const)('puts %s back', async (action, row, inverse) => {
    const box = mailbox([{ id: 'm1', ...row }]);
    const before = box.row('m1').tags;
    const held = stage(box, action, ['m1'], { category: 'promotions' });
    await applyChangeSet(held, options(box));
    await undoChangeSet(held, options(box));
    expect(box.calls.at(-1)!.op).toBe(inverse);
    expect(box.row('m1').tags.split('|').filter(Boolean).sort()).toEqual(before.split('|').filter(Boolean).sort());
    expect(held.set.status).toBe('undone');
  });

  // Breaks: undoing an archive, a move or a trash puts mail in the wrong folder.
  it.each([
    ['archive', 'f-inbox', undefined, { folderId: 'f-inbox' }],
    ['move', 'f-inbox', FOLDERS[2], { folderId: 'f-inbox' }],
    ['trash', 'f-work', undefined, { folderId: 'f-work' }],
  ] as const)('moves %s back to where it was', async (action, from, destination, expected) => {
    const box = mailbox([{ id: 'm1', folderId: from, tags: from === 'f-work' ? '|Work|' : '|INBOX|' }]);
    const held = stage(box, action, ['m1'], destination ? { folder: destination } : {});
    await applyChangeSet(held, options(box));
    await undoChangeSet(held, options(box));
    expect(box.calls.at(-1)).toMatchObject({ op: 'move', arg: expected });
    expect(box.row('m1').folderId).toBe(from);
  });

  // Breaks: Undo of a Trash move from the Inbox misses Gmail's Trash label, or a restore cannot be undone.
  it('restores Inbox mail from Trash, and trashes restored mail again', async () => {
    const box = mailbox([{ id: 'm1' }, { id: 'm2', folderId: 'f-trash', tags: '|Trash|' }]);
    const trashed = stage(box, 'trash', ['m1']);
    await applyChangeSet(trashed, options(box));
    await undoChangeSet(trashed, options(box));
    expect(box.calls.at(-1)!.op).toBe('restore');
    const restored = stage(box, 'restore', ['m2']);
    await applyChangeSet(restored, options(box));
    await undoChangeSet(restored, options(box));
    expect(box.calls.at(-1)).toMatchObject({ op: 'move', arg: 'trash' });
    expect(box.row('m2').folderId).toBe('f-trash');
  });

  // Breaks: Undo overwrites what the user did after the agent's change.
  it('leaves a row the user changed since, and says so', async () => {
    const box = mailbox([{ id: 'm1' }, { id: 'm2' }]);
    const held = stage(box, 'archive', ['m1', 'm2']);
    await applyChangeSet(held, options(box));
    box.row('m1').folderId = 'f-work';
    await undoChangeSet(held, options(box));
    expect(held.set.items.map(item => [item.status, item.detail])).toEqual([['applied', 'Changed since; left as it is now.'], ['undone', undefined]]);
    expect(box.row('m1').folderId).toBe('f-work');
    expect(held.set.status).toBe('applied');
  });

  // Breaks: a failed undo is reported as undone (the user thinks mail is back when it is not).
  it('keeps a row whose undo failed as changed, ready to try again', async () => {
    const box = mailbox([{ id: 'm1' }]);
    const held = stage(box, 'mark_read', ['m1']);
    await applyChangeSet(held, options(box));
    box.failing.add('m1');
    await undoChangeSet(held, options(box));
    expect(held.set.items[0]).toMatchObject({ status: 'applied', detail: 'Could not be undone. Try Undo again.' });
    box.failing.clear();
    await undoChangeSet(held, options(box));
    expect(held.set.items[0]!.status).toBe('undone');
  });

  // Breaks: Undo runs on a set that was never applied, or long after its window.
  it('refuses undo before apply, after the window, and for rows not in the set', async () => {
    const box = mailbox([{ id: 'm1' }]);
    const held = stage(box, 'mark_read', ['m1']);
    await expect(undoChangeSet(held, options(box))).rejects.toThrow('nothing to undo');
    await applyChangeSet(held, options(box));
    await expect(undoChangeSet(held, options(box, { itemIds: ['x'] }))).rejects.toThrow('Choose rows');
    await expect(undoChangeSet(held, options(box, { nowMs: held.set.undoBy + 1 }))).rejects.toThrow('can no longer be undone');
    // A row whose state cannot be read is treated as changed, never forced back.
    box.readEmail.mockRejectedValueOnce(new Error('locked'));
    await undoChangeSet(held, options(box, { itemIds: ['c1-1'] }));
    expect(held.set.items[0]!.detail).toBe('Changed since; left as it is now.');
  });

  // Breaks: the counts the model and the activity line report disagree with the rows.
  it('counts rows by status', async () => {
    const box = mailbox([{ id: 'm1' }, { id: 'm2', tags: '|INBOX|read|' }]);
    const held = stage(box, 'mark_read', ['m1', 'm2']);
    await applyChangeSet(held, options(box));
    expect(changeCounts(held.set)).toEqual({ pending: 0, applied: 1, queued: 0, unchanged: 1, failed: 0, skipped: 0, undone: 0 });
  });
});
