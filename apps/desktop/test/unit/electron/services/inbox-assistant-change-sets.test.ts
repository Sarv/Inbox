import type { EmailRecord, FolderRecord } from '@sarvinbox/core';
import { describe, expect, it, vi } from 'vitest';

import type { AssistantReadReceipt } from '../../../../electron/services/assistant-mail-actions';
import {
  agentUndoWait, aiActionKindOfChange, applyChangeSet, ATTACHMENTS_UNCHECKED, autoApplyWait, cancelChangeSet, changeCounts, changeProtection, changeSummary, createConversationGuard, emailProtection, hidesMail,
  INBOX_AGENT_CHANGE_LIMITS, NOT_DOWNLOADED, openApprovalWindow, stageChangeSet, undoChangeSet, undoHides, type HeldChangeSet, type InboxAgentMailActions,
} from '../../../../electron/services/inbox-assistant-change-sets';
import type { InboxAgentChangeAction } from '../../../../src/types/inbox-assistant-changes';
import { emailRecord } from '../../../helpers/email-fixtures';

const T0 = 1_800_000_000_000;

const folder = (id: string, path: string, specialUse: string | null): FolderRecord => ({
  id, name: path, path, parentId: null, uidValidity: 1, lastSyncUid: null, lastSyncTime: null,
  totalCount: 0, unreadCount: 0, specialUse, subscribed: true, createdAt: 0, updatedAt: 0,
});
const FOLDERS = [folder('f-inbox', 'INBOX', '\\Inbox'), folder('f-trash', 'Trash', '\\Trash'), folder('f-work', 'Work', null), folder('f-archive', 'Archive', '\\Archive'), folder('f-spam', 'Spam', '\\Junk')];

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
  const actions = {
    setRead: async (accountId, ids, read) => change(read ? 'read' : 'unread', accountId, ids, undefined, row => tag(row, 'read', read)),
    setStarred: async (accountId, ids, starred) => change(starred ? 'star' : 'unstar', accountId, ids, undefined, row => tag(row, 'starred', starred)),
    setCategory: async (accountId, ids, slug, on) => change(on ? 'category+' : 'category-', accountId, ids, slug, row => tag(row, slug, on)),
    restore: async (accountId, ids) => change('restore', accountId, ids, undefined, row => place(row, 'f-inbox')),
    move: async (accountId, ids, to) => change('move', accountId, ids, to, row => {
      const id = to === 'trash' ? 'f-trash' : to === 'archive' ? 'f-archive' : to.folderId;
      return row.folderId === id ? true : place(row, id);
    }),
  } as InboxAgentMailActions;
  const labels = new Map<string, Set<string>>();
  const labelFailing = new Set<string>();
  Object.assign(actions, {
    setLabel: async (accountId, ids, name, on) => change(on ? 'label+' : 'label-', accountId, ids, name, row => tag(row, name, on)),
    createLabel: async (accountId, name) => {
      calls.push({ op: 'createLabel', accountId, ids: [], arg: name });
      if (labelFailing.has(accountId)) throw new Error('no label');
      const known = labels.get(accountId) ?? new Set();
      labels.set(accountId, known);
      if (known.has(name)) return false;
      known.add(name);
      return true;
    },
    dropLabel: async (accountId, name) => { calls.push({ op: 'dropLabel', accountId, ids: [], arg: name }); labels.get(accountId)?.delete(name); },
    setSnooze: async (accountId, ids, until) => change(until === null ? 'unsnooze' : 'snooze', accountId, ids, until ?? undefined, row => {
      if (until === null) { row.snoozeUntil = null; return tag(row, 'snoozed', false); }
      if (row.snoozeUntil === until) return false;
      row.snoozeUntil = until;
      tag(row, 'snoozed', true);
      return true;
    }),
    spamVerdict: async (accountId, ids, verdict) => change(verdict, accountId, ids, undefined, row => {
      row.spamUserVerdict = verdict;
      tag(row, 'spam', verdict === 'spam');
      return verdict === 'spam' ? place(row, 'f-spam') : row.folderId === 'f-spam' ? place(row, 'f-inbox') : true;
    }),
    revertSpamVerdict: async (accountId, revert) => change('revert', accountId, revert.map(item => item.emailId), revert, row => {
      const before = revert.find(item => item.emailId === row.id)!;
      row.spamUserVerdict = before.verdict;
      tag(row, 'spam', before.tags.includes('|spam|'));
      return row.folderId === before.folderId ? true : place(row, before.folderId);
    }),
  } satisfies Partial<InboxAgentMailActions>);
  const readEmail = vi.fn(async (accountId: string, emailId: string) => rows.get(`${accountId}:${emailId}`) ?? null);
  return { rows, calls, actions, readEmail, failing, thrown, labels, labelFailing, row: (id: string, account = 'a1') => rows.get(`${account}:${id}`)! };
}

type StageExtra = { protect?: string[]; category?: string; folder?: FolderRecord; labelName?: string; createsLabelIn?: string[]; snooze?: { until: number; text: string };
  sender?: { address: string; spammer: boolean; trusted: boolean } };

function stage(box: ReturnType<typeof mailbox>, action: InboxAgentChangeAction, ids: Array<string | [string, string]>, extra: StageExtra = {}): HeldChangeSet {
  return stageChangeSet({
    label: 'C1', action, nowMs: T0, ...(extra.category ? { category: extra.category } : {}), ...(extra.folder ? { folder: extra.folder } : {}),
    ...(extra.labelName ? { labelName: extra.labelName } : {}), ...(extra.createsLabelIn ? { createsLabelIn: extra.createsLabelIn } : {}),
    ...(extra.snooze ? { snooze: extra.snooze } : {}),
    targets: ids.map(entry => {
      const [account, id] = Array.isArray(entry) ? entry : ['a1', entry];
      return { accountId: account, accountEmail: `${account}@example.test`, email: { ...box.row(id, account) }, folders: FOLDERS,
        ...(extra.protect?.includes(id) ? { protectedReason: 'Starred' } : {}), ...(extra.sender ? { sender: extra.sender } : {}) };
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

  // Breaks: a new or renamed action that hides mail silently skips every
  // protection (the Record makes TypeScript list every action here).
  it('hidesMail names exactly the actions that take mail out of sight', () => {
    const hides: Record<InboxAgentChangeAction, boolean> = {
      mark_read: true, archive: true, trash: true, move: true, spam: true, snooze: true,
      mark_unread: false, star: false, unstar: false, restore: false, add_category: false, remove_category: false,
      add_label: false, remove_label: false, unsnooze: false, not_spam: false,
    };
    for (const [action, expected] of Object.entries(hides)) expect([action, hidesMail(action as InboxAgentChangeAction)]).toEqual([action, expected]);
  });

  // Breaks: the protection remembered at a request's start depends on the
  // action that first looked at the message, so an unstar records nothing and
  // a later archive in the same request hides formerly starred mail.
  it('says why an email is protected whatever the action, and changeProtection only for hiding actions', () => {
    const starred = { subject: 'Hi', fromAddress: 'a@example.test', tags: '|INBOX|starred|' };
    expect(emailProtection(starred, '')).toBe('Starred');
    expect(changeProtection('unstar', starred, '')).toBeUndefined();
    expect(emailProtection({ ...starred, tags: '|INBOX|' }, 'Big sale this weekend')).toBeUndefined();
  });

  // Breaks: the agent hides mail the retired unread review kept in sight: the
  // provider's Important, an invitation, encrypted mail nobody read, or mail the
  // user filed into a category of their own.
  it('protects what the unread review protected on the email itself', () => {
    const plain = { subject: 'Weekly deals', fromAddress: 'shop@example.test', tags: '|INBOX|' };
    expect(changeProtection('mark_read', { ...plain, gmailImportant: true }, '')).toBe('Marked important');
    expect(changeProtection('archive', { ...plain, manualImportant: true }, '')).toBe('Marked important');
    expect(changeProtection('trash', { ...plain, calendarIcs: 'BEGIN:VCALENDAR' }, '')).toBe('A calendar invitation');
    expect(changeProtection('mark_read', { ...plain, pgpStatus: 'encrypted' }, '')).toMatch(/Encrypted/);
    expect(changeProtection('move', { ...plain, manualCategories: ['clients'] }, '')).toBe('In a category you chose');
    // A soft category the user chose (promotions, social…) is no reason to keep mail in sight.
    // Changed (2026-11-22): these give the email a body, since mail with no stored body is now protected (next test).
    expect(changeProtection('mark_read', { ...plain, manualCategories: ['promotions'] }, 'Big sale this weekend')).toBeUndefined();
    expect(changeProtection('mark_read', { ...plain, gmailImportant: false, manualImportant: false }, 'Big sale this weekend')).toBeUndefined();
    // Filing or starring hides nothing.
    expect(changeProtection('add_category', { ...plain, calendarIcs: 'BEGIN:VCALENDAR' }, '')).toBeUndefined();
  });

  // Breaks: a bank alert or a sign-in code that IDLE added without a body, or an
  // invoice that is only "Please find attached" plus a PDF, is archived, marked
  // read or snoozed unseen, because the content gates had nothing to read (the
  // retired unread review kept both).
  it('protects mail whose body was never downloaded, and mail with attached files', () => {
    const plain = { subject: 'Important update for you', fromAddress: 'alerts@bank.example', tags: '|INBOX|' };
    for (const action of ['mark_read', 'archive', 'trash', 'snooze'] as const) {
      expect(changeProtection(action, { ...plain, hasBody: false, rawBody: '', cleanBody: 'A short preview' }, 'A short preview')).toBe(NOT_DOWNLOADED);
    }
    // No body stored at all, whatever hasBody says.
    expect(emailProtection({ ...plain, rawBody: '' }, '')).toBe(NOT_DOWNLOADED);
    // A downloaded original, or a stored body, is checked as usual.
    expect(emailProtection({ ...plain, hasBody: false, rawBody: '<p>Your weekly offers</p>' }, 'Your weekly offers')).toBeUndefined();
    expect(emailProtection({ ...plain, rawBody: '' }, 'Your weekly offers')).toBeUndefined();
    // A gate that reads the subject still gives its own, more telling reason.
    expect(emailProtection({ ...plain, subject: 'Security alert: new sign-in', hasBody: false }, '')).toMatch(/security content/);
    // Attached files nobody read, by the flag or by the stored names.
    expect(emailProtection({ ...plain, hasAttachments: true }, 'Please find attached')).toBe(ATTACHMENTS_UNCHECKED);
    expect(emailProtection({ ...plain, hasAttachments: false, attachmentNames: '["October.pdf"]' }, 'Please find attached')).toBe(ATTACHMENTS_UNCHECKED);
    expect(emailProtection({ ...plain, hasAttachments: false, attachmentNames: '[]' }, 'Please find attached')).toBeUndefined();
    // Bringing mail back or flagging it hides nothing: never held.
    for (const action of ['mark_unread', 'unsnooze', 'restore', 'star'] as const) {
      expect(changeProtection(action, { ...plain, hasBody: false, hasAttachments: true }, '')).toBeUndefined();
    }
  });

  describe('the conversation guard', () => {
    const NOW = Date.UTC(2026, 10, 19);
    const day = 86_400;
    const member = (from: string, daysAgo: number) => ({ fromAddress: from, date: Math.floor(NOW / 1000) - daysAgo * day }) as EmailRecord;
    function guardOver(over: { contacts?: Array<{ email: string; isFavorite: boolean }>; vip?: string[]; thread?: EmailRecord[]; failContacts?: boolean; failStats?: boolean; failThread?: boolean } = {}) {
      const storage = {
        getContacts: vi.fn(async () => { if (over.failContacts) throw new Error('locked'); return over.contacts ?? []; }),
        getSenderStats: vi.fn(async (address: string) => { if (over.failStats) throw new Error('locked'); return over.vip?.includes(address) ? { isVip: true } : null; }),
        getEmailsByThread: vi.fn(async () => { if (over.failThread) throw new Error('locked'); return over.thread ?? []; }),
      };
      return { storage, guard: createConversationGuard({ storage, ownAddresses: ['me@acme.example', 'Me@Gmail.com'], nowMs: NOW }) };
    }
    const email = { id: 'e1', fromAddress: 'news@shop.example', threadId: 't1' };

    // Breaks: mail from a VIP is marked read or archived without asking.
    it('protects a favourite sender, matched by the exact address', async () => {
      expect(await guardOver({ contacts: [{ email: 'News@Shop.example', isFavorite: true }] }).guard('mark_read', email)).toBe('A favorite or VIP sender');
      expect(await guardOver({ contacts: [{ email: 'other-news@shop.example', isFavorite: true }] }).guard('mark_read', email)).toBeUndefined();
    });

    // Breaks: a sender the user made a VIP (the sender panel's VIP toggle, or an
    // approved change_sender vip card) is not protected, because only the
    // address book's favourite flag was read and VIP lives on the account's own
    // sender record.
    it('protects a VIP sender from the account\'s own sender record, and only in the account that has it', async () => {
      expect(await guardOver({ vip: ['news@shop.example'] }).guard('archive', email)).toBe('A favorite or VIP sender');
      // sender_stats is per account: the same sender is no VIP in an account whose record says nothing.
      expect(await guardOver({ vip: [] }).guard('archive', email)).toBeUndefined();
      expect(await guardOver({ failStats: true }).guard('archive', email)).toBe('The sender could not be checked');
      const { storage, guard } = guardOver({ vip: ['news@shop.example'] });
      await guard('snooze', email);
      await guard('mark_read', { ...email, id: 'e2', fromAddress: 'News@Shop.example' });
      expect(storage.getSenderStats).toHaveBeenCalledExactlyOnceWith('news@shop.example');
    });

    // Breaks: a thread the user replied to last week, or a colleague's mail, is hidden as "not needed".
    it('protects a conversation the user is in: a recent reply, or a colleague at their own domain', async () => {
      expect(await guardOver({ thread: [member('news@shop.example', 1), member('me@acme.example', 10)] }).guard('archive', email)).toBe('A conversation you are part of');
      expect(await guardOver({ thread: [member('news@shop.example', 1), member('me@acme.example', 45)] }).guard('archive', email)).toBeUndefined();
      expect(await guardOver({ thread: [member('ravi@acme.example', 200)] }).guard('archive', email)).toBe('A conversation you are part of');
      expect(await guardOver().guard('trash', { ...email, fromAddress: 'ravi@acme.example' })).toBe('A conversation you are part of');
      // A public mail provider is not a company: another gmail.com sender is no colleague.
      expect(await guardOver({ thread: [member('friend@gmail.com', 1)] }).guard('archive', email)).toBeUndefined();
    });

    // Breaks: a lookup that failed reads as "nothing to protect", so the change goes ahead unchecked.
    it('protects when a lookup fails, and looks each sender and conversation up once', async () => {
      expect(await guardOver({ failContacts: true }).guard('mark_read', email)).toBe('The sender could not be checked');
      expect(await guardOver({ failThread: true }).guard('mark_read', email)).toBe('The conversation could not be checked');
      const { storage, guard } = guardOver();
      await guard('mark_read', email);
      await guard('mark_read', { ...email, id: 'e2' });
      expect(storage.getContacts).toHaveBeenCalledOnce();
      expect(storage.getEmailsByThread).toHaveBeenCalledOnce();
    });

    // Breaks: snoozing a VIP's mail or a live conversation goes ahead unticked,
    // or waking mail (which hides nothing) is held for a card.
    it('guards a snooze like any other hiding action, and never an unsnooze', async () => {
      const { guard } = guardOver({ contacts: [{ email: 'news@shop.example', isFavorite: true }] });
      expect(await guard('snooze', email)).toBe('A favorite or VIP sender');
      expect(await guard('unsnooze', email)).toBeUndefined();
      expect(await guardOver({ thread: [member('me@acme.example', 3)] }).guard('snooze', email)).toBe('A conversation you are part of');
    });

    // Breaks: starring or labelling a VIP's mail is refused, or the user's own mail is looked up as a sender.
    it('applies only to actions that hide mail, and skips the user\'s own messages and threadless mail', async () => {
      const { storage, guard } = guardOver({ contacts: [{ email: 'news@shop.example', isFavorite: true }] });
      expect(await guard('star', email)).toBeUndefined();
      expect(await guard('mark_read', { id: 'e3', fromAddress: 'me@gmail.com', threadId: null as unknown as string })).toBeUndefined();
      expect(storage.getContacts).not.toHaveBeenCalled();
    });
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

  // Breaks: mail the user starred (or marked important) after the agent staged
  // a hiding set is hidden by a later approval or auto-apply, because
  // protection was decided once at staging and never looked at again.
  it('protects a row the user flagged since staging: skipped on a plain approval, pending for auto-apply, applied when ticked', async () => {
    const box = mailbox([{ id: 'm1' }, { id: 'm2' }, { id: 'm3' }]);
    const plain = stage(box, 'archive', ['m1', 'm2']);
    box.row('m1').tags = '|INBOX|starred|';
    await applyChangeSet(plain, options(box));
    expect(plain.set.items.map(item => [item.status, item.protectedReason ?? null, item.detail ?? null])).toEqual([
      ['skipped', 'Starred', 'Protected since it was prepared.'], ['applied', null, null]]);
    expect(box.row('m1').folderId).toBe('f-inbox');

    const auto = stage(box, 'mark_read', ['m1', 'm3']);
    await applyChangeSet(auto, options(box, { auto: true }));
    expect(auto.set.items.map(item => [item.status, item.protectedReason ?? null])).toEqual([['pending', 'Starred'], ['applied', null]]);
    expect(auto.set.status).toBe('partial');
    // The user's own tick decides: a row ticked on the card is applied.
    await applyChangeSet(auto, options(box, { itemIds: ['c1-1'] }));
    expect(box.row('m1').tags).toContain('|read|');

    // Only hiding actions are re-checked: labelling starred mail goes ahead.
    const label = stage(box, 'add_label', ['m1'], { labelName: 'Clients' });
    await applyChangeSet(label, options(box));
    expect(label.set.items[0]).toMatchObject({ status: 'applied' });
    expect(label.set.items[0]!.protectedReason).toBeUndefined();
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

describe('labels, snooze and spam', () => {
  const SOON = 1_800_100_000;

  // Breaks: the card title says something other than what will happen.
  it.each([
    ['add_label', 2, 'Clients', 'Label 2 emails "Clients"'], ['remove_label', 1, 'Clients', 'Remove label "Clients" from 1 email'],
    ['snooze', 3, 'Fri, Nov 21, 2026, 9:00 AM', 'Snooze 3 emails until Fri, Nov 21, 2026, 9:00 AM'], ['unsnooze', 1, undefined, 'Unsnooze 1 email'],
    ['spam', 2, undefined, 'Report 2 emails as spam'], ['not_spam', 1, undefined, 'Mark 1 email as not spam'],
  ] as const)('summarises %s', (action, count, target, expected) => {
    expect(changeSummary(action, count, target)).toBe(expected);
  });

  // Breaks: a spam verdict (which also teaches the filter) or a new label applies under "Approve for me" without asking.
  it('marks spam verdicts and label-creating sets as standing, and plain labels and snoozes as not', () => {
    const box = mailbox([{ id: 'm1' }]);
    expect(stage(box, 'spam', ['m1']).set.standing).toBe(true);
    expect(stage(box, 'not_spam', ['m1']).set.standing).toBe(true);
    expect(stage(box, 'add_label', ['m1'], { labelName: 'Clients', createsLabelIn: ['a1'] }).set).toMatchObject({ standing: true, createsLabelIn: ['a1'], labelName: 'Clients' });
    expect(stage(box, 'add_label', ['m1'], { labelName: 'Clients' }).set.standing).toBeUndefined();
    expect(stage(box, 'snooze', ['m1'], { snooze: { until: SOON, text: 'soon' } }).set).toMatchObject({ snoozeUntil: SOON, summary: 'Snooze 1 email until soon' });
  });

  // Breaks: reporting a security code or a bank alert as spam goes ahead with
  // the rest, or a snooze hides starred or security-code mail for up to a year
  // with no tick. Changed deliberately (2026-11-22): a snooze was unprotected
  // before, so "Approve for me" snoozed protected mail out of sight.
  it('protects sensitive mail from a spam verdict and a snooze, but not from a label', () => {
    const plain = { subject: 'Hi', fromAddress: 'a@example.test', tags: '|INBOX|starred|' };
    expect(changeProtection('spam', plain, '')).toBe('Starred');
    expect(changeProtection('snooze', plain, '')).toBe('Starred');
    expect(changeProtection('snooze', { ...plain, tags: '|INBOX|' }, 'Your verification code is 482913')).toMatch(/security content/);
    for (const action of ['add_label', 'not_spam', 'unsnooze'] as const) expect(changeProtection(action, plain, '')).toBeUndefined();
  });

  // Breaks: a new label is not created before its first email gets it, or Undo leaves the label behind.
  it('creates a new label once per account before labelling, and drops it again on Undo', async () => {
    const box = mailbox([{ id: 'm1' }, { id: 'm2' }]);
    const held = stage(box, 'add_label', ['m1', 'm2'], { labelName: 'Clients', createsLabelIn: ['a1'] });
    await applyChangeSet(held, options(box));
    expect(box.calls.map(call => call.op)).toEqual(['createLabel', 'label+']);
    expect(box.row('m1').tags).toContain('|Clients|');
    expect(held.createdLabelIn).toEqual(['a1']);
    await undoChangeSet(held, options(box));
    expect(box.calls.map(call => call.op)).toEqual(['createLabel', 'label+', 'label-', 'dropLabel']);
    expect(box.row('m1').tags).not.toContain('|Clients|');
    expect(held.createdLabelIn).toEqual([]);
    expect(held.set.status).toBe('undone');
  });

  // Breaks: Undo deletes a label that existed before the agent (the user's own label) or one still on an email.
  it('never drops a label the set did not create, nor while one of its emails keeps it', async () => {
    const box = mailbox([{ id: 'm1' }, { id: 'm2' }]);
    box.labels.set('a1', new Set(['Clients']));
    const existing = stage(box, 'add_label', ['m1'], { labelName: 'Clients', createsLabelIn: ['a1'] });
    await applyChangeSet(existing, options(box));
    expect(existing.createdLabelIn).toBeUndefined();
    await undoChangeSet(existing, options(box));
    expect(box.calls.some(call => call.op === 'dropLabel')).toBe(false);

    const fresh = stage(box, 'add_label', ['m2'], { labelName: 'Leads', createsLabelIn: ['a1'] });
    await applyChangeSet(fresh, options(box));
    box.failing.add('m2');
    await undoChangeSet(fresh, options(box));
    expect(box.calls.some(call => call.op === 'dropLabel')).toBe(false);
    expect(fresh.createdLabelIn).toEqual(['a1']);
  });

  // Breaks: a label that could not be created is reported as applied, or a retry creates it twice.
  it('fails the account\'s rows when its label cannot be created, and retries cleanly', async () => {
    const box = mailbox([{ id: 'm1' }, { id: 'm9', account: 'a2' }]);
    box.labelFailing.add('a1');
    const held = stage(box, 'add_label', ['m1', ['a2', 'm9']], { labelName: 'Clients', createsLabelIn: ['a1', 'a2'] });
    await applyChangeSet(held, options(box));
    expect(held.set.items.map(item => [item.status, item.detail])).toEqual([['failed', 'The label could not be created. Approve again to retry.'], ['applied', undefined]]);
    expect(box.row('m1').tags).not.toContain('|Clients|');
    box.labelFailing.clear();
    await applyChangeSet(held, options(box));
    expect(statuses(held)).toEqual(['applied', 'applied']);
    expect(box.calls.filter(call => call.op === 'createLabel').map(call => call.accountId)).toEqual(['a1', 'a2', 'a1']);
  });

  // Breaks: Undo of a snooze leaves mail hidden, or wakes mail the user had snoozed for another time.
  it('undoes a snooze by waking the mail, or by putting back the earlier snooze time', async () => {
    const box = mailbox([{ id: 'm1' }, { id: 'm2', tags: '|INBOX|snoozed|', snoozeUntil: SOON - 500 }]);
    const held = stage(box, 'snooze', ['m1', 'm2'], { snooze: { until: SOON, text: 'soon' } });
    await applyChangeSet(held, options(box));
    expect([box.row('m1').snoozeUntil, box.row('m2').snoozeUntil]).toEqual([SOON, SOON]);
    await undoChangeSet(held, options(box));
    expect(box.row('m1')).toMatchObject({ snoozeUntil: null });
    expect(box.row('m1').tags).not.toContain('|snoozed|');
    expect(box.row('m2')).toMatchObject({ snoozeUntil: SOON - 500 });
    expect(box.calls.slice(-2).map(call => [call.op, call.arg])).toEqual([['unsnooze', undefined], ['snooze', SOON - 500]]);
  });

  // Breaks: Undo overrides a snooze the user changed themselves after the agent's.
  it('leaves a snooze the user changed since', async () => {
    const box = mailbox([{ id: 'm1' }]);
    const held = stage(box, 'snooze', ['m1'], { snooze: { until: SOON, text: 'soon' } });
    await applyChangeSet(held, options(box));
    box.row('m1').snoozeUntil = SOON + 3_600;
    await undoChangeSet(held, options(box));
    expect(held.set.items[0]).toMatchObject({ status: 'applied', detail: 'Changed since; left as it is now.' });
  });

  // Breaks: Undo of an unsnooze cannot put the mail back to sleep until its old time.
  it('undoes an unsnooze by snoozing again until the old time', async () => {
    const box = mailbox([{ id: 'm1', tags: '|INBOX|snoozed|', snoozeUntil: SOON }]);
    const held = stage(box, 'unsnooze', ['m1']);
    await applyChangeSet(held, options(box));
    expect(box.row('m1').tags).not.toContain('|snoozed|');
    await undoChangeSet(held, options(box));
    expect(box.row('m1')).toMatchObject({ snoozeUntil: SOON });
  });

  // Breaks: Undo of "report spam" leaves mail in Spam, loses its earlier verdict, or forgets the sender's listing.
  it('undoes a spam verdict from what each row was before, sender lists included', async () => {
    const box = mailbox([{ id: 'm1', folderId: 'f-work', tags: '|Work|', spamUserVerdict: 'ham' }]);
    const sender = { address: 'shop@example.test', spammer: false, trusted: true };
    const held = stage(box, 'spam', ['m1'], { sender });
    await applyChangeSet(held, options(box));
    expect(box.row('m1')).toMatchObject({ folderId: 'f-spam', spamUserVerdict: 'spam' });
    await undoChangeSet(held, options(box));
    const revert = box.calls.at(-1)!;
    expect(revert).toMatchObject({ op: 'revert', ids: ['m1'] });
    expect(revert.arg).toEqual([{ emailId: 'm1', tags: '|Work|', folderId: 'f-work', verdict: 'ham', sender }]);
    expect(box.row('m1')).toMatchObject({ folderId: 'f-work', spamUserVerdict: 'ham' });
    expect(held.set.status).toBe('undone');
  });

  // Breaks: a message the user moved out of Spam again is dragged back by Undo of "not spam", or a spam verdict on moved mail is forced.
  it('skips a moved row when applying a verdict, and leaves a row moved since when undoing it', async () => {
    const box = mailbox([{ id: 'm1', folderId: 'f-spam', tags: '|Spam|spam|' }, { id: 'm2' }]);
    const held = stage(box, 'not_spam', ['m1']);
    await applyChangeSet(held, options(box));
    expect(box.row('m1').folderId).toBe('f-inbox');
    box.row('m1').folderId = 'f-archive';
    await undoChangeSet(held, options(box));
    expect(held.set.items[0]!.detail).toBe('Changed since; left as it is now.');

    const stale = stage(box, 'spam', ['m2']);
    box.row('m2').folderId = 'f-work';
    await applyChangeSet(stale, options(box));
    expect(stale.set.items[0]).toMatchObject({ status: 'skipped', detail: 'It was moved after the change was prepared.' });
  });

  // Breaks: Undo of a label removal does not put the label back.
  it('undoes a label removal by labelling again', async () => {
    const box = mailbox([{ id: 'm1', tags: '|INBOX|Clients|' }]);
    const held = stage(box, 'remove_label', ['m1'], { labelName: 'Clients' });
    await applyChangeSet(held, options(box));
    expect(box.row('m1').tags).not.toContain('|Clients|');
    await undoChangeSet(held, options(box));
    expect(box.row('m1').tags).toContain('|Clients|');
  });
});

// When the agent may change mail without a card, and when its own undo must
// ask. A regression here is the model reverting a change, a setting or a spam
// verdict without the user, past the per-request cap, or a card that arrives
// with part of its approval time already spent.
describe('approval rules for the agent', () => {
  /** A set as it is after applying: every row changed, by "Approve for me" unless said otherwise. */
  function appliedSet(action: InboxAgentChangeAction, over: { autoApplied?: boolean; userApproved?: boolean; accounts?: string[]; rows?: number; createsLabelIn?: string[] } = {}): HeldChangeSet {
    const accounts = over.accounts ?? Array.from({ length: over.rows ?? 1 }, () => 'a1');
    const held = stageChangeSet({ label: 'C1', action, nowMs: T0, ...(action.endsWith('_label') ? { labelName: 'Shop' } : {}),
      ...(over.createsLabelIn ? { createsLabelIn: over.createsLabelIn } : {}),
      targets: accounts.map((accountId, index) => ({ accountId, accountEmail: `${accountId}@example.test`, email: emailRecord({ id: `m${index}`, folderId: 'f-inbox', tags: '|INBOX|' }), folders: FOLDERS })) });
    held.set.items.forEach((item, index) => { item.status = index % 2 ? 'queued' : 'applied'; });
    held.set.status = 'applied';
    if (over.autoApplied ?? true) held.set.autoApplied = true;
    if (over.userApproved) held.userApproved = true;
    return held;
  }
  const approveForMe = { mode: 'approve_for_me' as const, autoApplied: 0, accountIds: ['a1'] };
  const applied = (held: HeldChangeSet): HeldChangeSet => {
    for (const item of held.set.items) item.status = 'applied';
    held.set.status = 'applied';
    held.set.autoApplied = true;
    return held;
  };
  /** An auto-applied move of one email from `from` to `to`. */
  function appliedMove(from: string, to: FolderRecord): HeldChangeSet {
    const origin = FOLDERS.find(item => item.id === from)!;
    return applied(stageChangeSet({ label: 'C1', action: 'move', folder: to, nowMs: T0,
      targets: [{ accountId: 'a1', accountEmail: 'a1@example.test', email: emailRecord({ id: 'm1', folderId: from, tags: `|${origin.path}|` }), folders: [...FOLDERS, to] }] }));
  }
  /** An auto-applied snooze until `until` of one email that was snoozed until `before` (null: awake). */
  function appliedSnooze(before: number | null, until: number): HeldChangeSet {
    return applied(stageChangeSet({ label: 'C1', action: 'snooze', snooze: { until, text: 'then' }, nowMs: T0,
      targets: [{ accountId: 'a1', accountEmail: 'a1@example.test', email: emailRecord({ id: 'm1', folderId: 'f-inbox', tags: before ? '|INBOX|snoozed|' : '|INBOX|', snoozeUntil: before }), folders: FOLDERS }] }));
  }

  // Breaks: change_mail and undo_change disagree about when "Approve for me" may act.
  it.each([
    [{ mode: 'review', count: 5, autoApplied: 0 }, 'approval'],
    [{ mode: 'review', standing: true, count: 0, autoApplied: 0 }, 'approval'],
    [{ mode: 'approve_for_me', standing: true, count: 5, autoApplied: 0 }, 'standing'],
    [{ mode: 'approve_for_me', count: 0, autoApplied: 0 }, 'protected'],
    [{ mode: 'approve_for_me', count: 60, autoApplied: 150 }, 'cap'],
    [{ mode: 'approve_for_me', count: 50, autoApplied: 150 }, undefined],
    [{ mode: 'approve_for_me', count: 1, autoApplied: 0 }, undefined],
  ] as const)('one rule for applying without a card (%#)', (input, expected) => {
    expect(autoApplyWait(input)).toBe(expected);
  });

  // Breaks: the model reverts a change, a setting or a spam verdict without the user, or past the per-request cap.
  it.each([
    ['in Ask for approval', appliedSet('star'), { ...approveForMe, mode: 'review' as const }, 'approval'],
    ['a spam verdict, even under Approve for me', appliedSet('spam', { autoApplied: false }), approveForMe, 'standing'],
    ['a not-spam verdict', appliedSet('not_spam', { autoApplied: false }), approveForMe, 'standing'],
    ['a set that created a label', appliedSet('add_label', { autoApplied: false, createsLabelIn: ['a1'] }), approveForMe, 'standing'],
    ['a set the user approved on its card', appliedSet('star', { autoApplied: false }), approveForMe, 'approved'],
    ['an auto-applied set whose protected rest the user approved', appliedSet('archive', { userApproved: true }), approveForMe, 'approved'],
    ['an undo that marks read again', appliedSet('mark_unread'), approveForMe, 'hides'],
    ['an undo that trashes again', appliedSet('restore'), approveForMe, 'hides'],
    ['an undo that snoozes again', appliedSet('unsnooze'), approveForMe, 'hides'],
    ['a row in an account this request did not select', appliedSet('star', { accounts: ['a1', 'a2'] }), approveForMe, 'account'],
    ['more than the cap, applied and queued rows both counted', appliedSet('star', { rows: 60 }), { ...approveForMe, autoApplied: 150 }, 'cap'],
    ['its own change, within the cap', appliedSet('star', { rows: 50 }), { ...approveForMe, autoApplied: 150 }, undefined],
    ['its own archive', appliedSet('archive'), approveForMe, undefined],
    ['a move into the Inbox out of Trash', appliedMove('f-trash', FOLDERS[0]!), approveForMe, 'hides'],
    ['a move into the Inbox out of Archive', appliedMove('f-archive', FOLDERS[0]!), approveForMe, 'hides'],
    ['a move into the Inbox out of a folder', appliedMove('f-work', FOLDERS[0]!), approveForMe, 'hides'],
    ['a move out of Archive into a folder', appliedMove('f-archive', FOLDERS[2]!), approveForMe, 'hides'],
    ['a move out of the Inbox into a folder', appliedMove('f-inbox', FOLDERS[2]!), approveForMe, undefined],
    ['a move between two folders the user files in', appliedMove('f-work', folder('f-personal', 'Personal', null)), approveForMe, undefined],
    ['a snooze moved earlier (undo snoozes it for longer)', appliedSnooze(1_800_200_000, 1_800_100_000), approveForMe, 'hides'],
    ['a snooze moved later', appliedSnooze(1_800_100_000, 1_800_200_000), approveForMe, undefined],
    ['a snooze of mail that was awake', appliedSnooze(null, 1_800_100_000), approveForMe, undefined],
  ])('decides when the agent may undo without a card: %s', (_name, held, input, expected) => {
    expect(agentUndoWait(held, input)).toBe(expected);
  });

  // Breaks: one row whose undo hides mail is let through because the set's
  // other rows are harmless (the wait must come from any row, not the first).
  it('waits when any row of a move would be hidden again by its undo', () => {
    const personal = folder('f-personal', 'Personal', null);
    const held = applied(stageChangeSet({ label: 'C1', action: 'move', folder: personal, nowMs: T0, targets: [
      { accountId: 'a1', accountEmail: 'a1@example.test', email: emailRecord({ id: 'm1', folderId: 'f-inbox', tags: '|INBOX|' }), folders: [...FOLDERS, personal] },
      { accountId: 'a1', accountEmail: 'a1@example.test', email: emailRecord({ id: 'm2', folderId: 'f-trash', tags: '|Trash|' }), folders: [...FOLDERS, personal] },
    ] }));
    expect(held.set.items.map(item => undoHides(held, item))).toEqual([false, true]);
    expect(agentUndoWait(held, approveForMe)).toBe('hides');
    expect(undoHides(held, { id: 'not-a-row' })).toBe(false);
  });

  // Breaks: the protected rest of an auto-applied set, approved by the user on its card, can be undone by the agent without asking.
  it('remembers that the user approved rows of an auto-applied set on its card', async () => {
    const box = mailbox([{ id: 'm1' }, { id: 'm2' }]);
    const held = stage(box, 'archive', ['m1', 'm2'], { protect: ['m2'] });
    await applyChangeSet(held, options(box, { auto: true }));
    expect(held.userApproved).toBeUndefined();
    expect(agentUndoWait(held, approveForMe)).toBeUndefined();
    await applyChangeSet(held, options(box, { itemIds: ['c1-2'] }));
    expect(held.userApproved).toBe(true);
    expect(agentUndoWait(held, approveForMe)).toBe('approved');
  });

  // Breaks: a long run eats the user's approval time, or a decided set reopens.
  it('starts the approval window when the card is handed over, never shortens it, and leaves a decided set alone', () => {
    const box = mailbox([{ id: 'm1' }]);
    const { approveMs } = INBOX_AGENT_CHANGE_LIMITS;
    const delivered = T0 + 4 * 60_000;
    const pending = stage(box, 'mark_read', ['m1']);
    expect(pending.set.approveBy).toBe(T0 + approveMs);
    openApprovalWindow(pending, delivered);
    expect(pending.set.approveBy).toBe(delivered + approveMs);
    openApprovalWindow(pending, T0);
    expect(pending.set.approveBy).toBe(delivered + approveMs);
    const partial = stage(box, 'mark_read', ['m1']);
    partial.set.status = 'partial';
    openApprovalWindow(partial, delivered);
    expect(partial.set.approveBy).toBe(delivered + approveMs);
    for (const status of ['applied', 'cancelled', 'expired', 'undone'] as const) {
      const decided = stage(box, 'mark_read', ['m1']);
      decided.set.status = status;
      openApprovalWindow(decided, delivered);
      expect(decided.set.approveBy).toBe(T0 + approveMs);
    }
  });
});

describe('what the agent did, on each email (emails.ai_actions)', () => {
  /** The mailbox with the two recorder hooks, keeping what they were told. */
  function recordingBox(initial: Parameters<typeof mailbox>[0]) {
    const box = mailbox(initial);
    const recorded: Array<{ accountId: string; ids: string[]; kind: string; auto?: boolean }> = [];
    const forgotten: Array<{ accountId: string; ids: string[]; kind: string }> = [];
    Object.assign(box.actions, {
      recordAiActions: async (accountId: string, ids: string[], kind: string, auto: boolean) => { recorded.push({ accountId, ids, kind, auto }); },
      forgetAiActions: async (accountId: string, ids: string[], kind: string) => { forgotten.push({ accountId, ids, kind }); },
    });
    return { box, recorded, forgotten };
  }

  // Breaks: the list's AI icon is missing on mail the user approved changing,
  // or says "automatically" for a change the user approved.
  it('records the rows the user approved, as approved, per account', async () => {
    const { box, recorded } = recordingBox([{ id: 'm1', account: 'a1' }, { id: 'm2', account: 'a1' }, { id: 'm1', account: 'a2' }]);
    const held = stage(box, 'mark_read', [['a1', 'm1'], ['a1', 'm2'], ['a2', 'm1']]);
    await applyChangeSet(held, options(box));
    expect(recorded).toEqual([
      { accountId: 'a1', ids: ['m1', 'm2'], kind: 'read', auto: false },
      { accountId: 'a2', ids: ['m1'], kind: 'read', auto: false },
    ]);
  });

  // Breaks: "Approve for me" changes are shown as approved by the user.
  it('records an "Approve for me" change as automatic', async () => {
    const { box, recorded } = recordingBox([{ id: 'm1' }]);
    await applyChangeSet(stage(box, 'archive', ['m1']), options(box, { auto: true }));
    expect(recorded).toEqual([{ accountId: 'a1', ids: ['m1'], kind: 'archive', auto: true }]);
  });

  // Breaks: an email the agent did not change (it failed, the user left it
  // unticked, or it was already that way) gets the AI icon anyway.
  it('records only rows that really changed', async () => {
    const { box, recorded } = recordingBox([{ id: 'm1' }, { id: 'm2' }, { id: 'm3' }, { id: 'm4', tags: '|INBOX|read|' }]);
    box.failing.add('m2');
    const held = stage(box, 'mark_read', ['m1', 'm2', 'm3', 'm4'], { protect: ['m3'] });
    await applyChangeSet(held, options(box));
    expect(statuses(held)).toEqual(['applied', 'failed', 'skipped', 'unchanged']);
    expect(recorded).toEqual([{ accountId: 'a1', ids: ['m1'], kind: 'read', auto: false }]);
  });

  // Breaks: a retried failure records the rows that already succeeded twice.
  it('records a retried row once, on the attempt that changed it', async () => {
    const { box, recorded } = recordingBox([{ id: 'm1' }, { id: 'm2' }]);
    box.failing.add('m2');
    const held = stage(box, 'star', ['m1', 'm2']);
    await applyChangeSet(held, options(box));
    box.failing.clear();
    await applyChangeSet(held, options(box));
    expect(recorded.map(entry => entry.ids)).toEqual([['m1'], ['m2']]);
  });

  // Breaks: after Undo the email still claims the AI changed it.
  it('takes the action back off the rows Undo restored', async () => {
    const { box, forgotten } = recordingBox([{ id: 'm1' }, { id: 'm2' }]);
    const held = stage(box, 'add_label', ['m1', 'm2'], { labelName: 'Receipts' });
    await applyChangeSet(held, options(box));
    await undoChangeSet(held, options(box));
    expect(forgotten).toEqual([{ accountId: 'a1', ids: ['m1', 'm2'], kind: 'label' }]);
  });

  // Breaks: an Undo that failed for a row forgets the action anyway, so the
  // row is still changed but has lost its AI icon.
  it('keeps the action on a row whose Undo failed', async () => {
    const { box, forgotten } = recordingBox([{ id: 'm1' }, { id: 'm2' }]);
    const held = stage(box, 'mark_read', ['m1', 'm2']);
    await applyChangeSet(held, options(box));
    box.failing.add('m2');
    await undoChangeSet(held, options(box));
    expect(forgotten).toEqual([{ accountId: 'a1', ids: ['m1'], kind: 'read' }]);
  });

  // Breaks: a database error while recording turns an applied change into a
  // failed one, so the user retries a change that already happened.
  it('applies and undoes normally when recording throws', async () => {
    const box = mailbox([{ id: 'm1' }]);
    Object.assign(box.actions, {
      recordAiActions: async () => { throw new Error('disk full'); },
      forgetAiActions: async () => { throw new Error('disk full'); },
    });
    const held = stage(box, 'mark_read', ['m1']);
    await applyChangeSet(held, options(box));
    expect(statuses(held)).toEqual(['applied']);
    await undoChangeSet(held, options(box));
    expect(statuses(held)).toEqual(['undone']);
  });

  // Breaks: an action is named wrongly in the tooltip and the AI section's counts.
  it.each([
    ['mark_read', undefined, 'read'], ['mark_unread', undefined, 'unread'], ['star', undefined, 'star'], ['unstar', undefined, 'unstar'],
    ['archive', undefined, 'archive'], ['trash', undefined, 'trash'], ['restore', undefined, 'restore'], ['move', undefined, 'move'],
    ['add_category', 'important', 'important'], ['add_category', 'finance', 'category'], ['remove_category', 'important', 'category'],
    ['add_label', undefined, 'label'], ['remove_label', undefined, 'unlabel'], ['snooze', undefined, 'snooze'], ['unsnooze', undefined, 'unsnooze'],
    ['spam', undefined, 'spam'], ['not_spam', undefined, 'not_spam'],
  ] as const)('names %s (%s) as %s', (action, category, kind) => {
    expect(aiActionKindOfChange(action, category)).toBe(kind);
  });
});
