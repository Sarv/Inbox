import type { FollowUp, FollowUpInput } from '@sarvinbox/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Follow-up reminder IPC and the send-path hook. What breaks if this goes red:
 * a send that asked for a reminder records none (the user is never reminded),
 * a failed reminder write turns a delivered mail into a send error, the
 * Follow-ups view misses a background account, or a dismiss lands in the
 * wrong account's DB and the reminder keeps firing.
 */

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...a: any[]) => any>(),
  accountIds: [] as string[],
  storages: new Map<string, any>(),
  active: null as any,
}));

vi.mock('electron', () => ({
  ipcMain: { handle: (name: string, fn: (...a: any[]) => any) => h.handlers.set(name, fn) },
}));
vi.mock('../../../../electron/shared', () => ({
  getStorage: () => h.active,
  getStorageFor: (id: string) => h.storages.get(id) ?? null,
  getAllAccountIds: () => h.accountIds,
  getMainWindow: () => null,
}));
vi.mock('../../../../electron/services/notification-service', () => ({ notifyFollowUpDue: () => {} }));
vi.mock('@sarvinbox/core', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));

import {
  compareFollowUps,
  recordFollowUpForSend,
  registerFollowUpHandlers,
} from '../../../../electron/ipc/follow-up-handlers';

registerFollowUpHandlers();
const invoke = (channel: string, ...args: unknown[]) => h.handlers.get(channel)!(null, ...args);

const SENT = 1_790_000_000;
const DAY = 86_400;

const followUp = (id: string, over: Partial<FollowUp> = {}): FollowUp => ({
  id,
  messageId: `<${id}@x>`,
  subject: id,
  recipients: '',
  fromAddress: 'me@example.com',
  sentAt: SENT,
  dueAt: SENT + DAY,
  status: 'pending',
  resolvedAt: null,
  emailId: null,
  threadId: null,
  ...over,
});

const store = (open: FollowUp[] = []) => ({
  listOpenFollowUps: vi.fn(async () => open),
  setFollowUpStatus: vi.fn(async () => true),
});

beforeEach(() => {
  h.accountIds = [];
  h.storages.clear();
  h.active = null;
});

describe('recordFollowUpForSend', () => {
  const options = { followUp: { afterSeconds: 3 * DAY }, subject: 'Quote', to: ['alice@example.com', 'bob@example.com'] };

  // The reminder the composer asked for is recorded against the real send time.
  it('records a reminder due the chosen delay after sending', async () => {
    const createFollowUp = vi.fn(async (input: FollowUpInput) => followUp('r', input));
    await recordFollowUpForSend({ createFollowUp }, options, '<m@x>', 'me@example.com', SENT);
    expect(createFollowUp).toHaveBeenCalledWith({
      messageId: '<m@x>',
      subject: 'Quote',
      recipients: 'alice@example.com, bob@example.com',
      fromAddress: 'me@example.com',
      sentAt: SENT,
      dueAt: SENT + 3 * DAY,
    });
  });

  // Most sends ask for nothing; a missing store or Message-ID can't be linked.
  it('records nothing when no reminder was asked for or it cannot be linked', async () => {
    const createFollowUp = vi.fn();
    await expect(recordFollowUpForSend({ createFollowUp }, { ...options, followUp: undefined }, '<m@x>', 'me', SENT)).resolves.toBeNull();
    await expect(recordFollowUpForSend({ createFollowUp }, options, '', 'me', SENT)).resolves.toBeNull();
    await expect(recordFollowUpForSend(null, options, '<m@x>', 'me', SENT)).resolves.toBeNull();
    expect(createFollowUp).not.toHaveBeenCalled();
  });

  // The mail is already delivered: a DB error must not surface as a send failure.
  it('swallows a failed write', async () => {
    const createFollowUp = vi.fn(async () => { throw new Error('database is locked'); });
    await expect(recordFollowUpForSend({ createFollowUp }, { ...options, subject: undefined as unknown as string }, '<m@x>', 'me', SENT)).resolves.toBeNull();
  });

  // Default send time is now, so a reminder never lands in the past.
  it('defaults the send time to now', async () => {
    const createFollowUp = vi.fn(async (input: FollowUpInput) => followUp('r', input));
    const before = Math.floor(Date.now() / 1000);
    await recordFollowUpForSend({ createFollowUp }, options, '<m@x>', 'me');
    expect(createFollowUp.mock.calls[0][0].sentAt).toBeGreaterThanOrEqual(before);
  });
});

describe('followUps:list', () => {
  // Cross-account like All Inboxes: every account's reminders, tagged, due first.
  it('merges every account, tagged and ordered due-first then soonest', async () => {
    h.accountIds = ['acct-a', 'acct-b'];
    h.storages.set('acct-a', store([followUp('a-late', { dueAt: SENT + 5 * DAY })]));
    h.storages.set('acct-b', store([followUp('b-due', { status: 'due', dueAt: SENT + 9 * DAY }), followUp('b-soon')]));
    const res = await invoke('followUps:list');
    expect(res.success).toBe(true);
    expect(res.data.map((f: { id: string; accountId: string }) => `${f.accountId}/${f.id}`)).toEqual([
      'acct-b/b-due',
      'acct-b/b-soon',
      'acct-a/a-late',
    ]);
  });

  // A failing account reports an error rather than a silently short list.
  it('answers with an error when a store fails', async () => {
    h.active = { listOpenFollowUps: async () => { throw new Error('boom'); } };
    expect(await invoke('followUps:list')).toEqual({ success: false, error: 'Error: boom' });
  });
});

describe('followUps:dismiss', () => {
  // The dismiss must reach the reminder's OWN account.
  it('dismisses in the named account, else the active one', async () => {
    const other = store();
    const active = store();
    h.storages.set('acct-b', other);
    h.active = active;
    expect(await invoke('followUps:dismiss', 'f1', 'acct-b')).toEqual({ success: true });
    expect(other.setFollowUpStatus).toHaveBeenCalledWith('f1', 'dismissed');
    await invoke('followUps:dismiss', 'f2');
    expect(active.setFollowUpStatus).toHaveBeenCalledWith('f2', 'dismissed');
  });

  it('answers with an error for an unknown account or a failed write', async () => {
    expect(await invoke('followUps:dismiss', 'f1', 'acct-gone')).toEqual({ success: false, error: 'Account not available' });
    h.active = { setFollowUpStatus: async () => { throw new Error('locked'); } };
    expect(await invoke('followUps:dismiss', 'f1')).toEqual({ success: false, error: 'Error: locked' });
  });
});

describe('compareFollowUps', () => {
  it('orders due before pending, then by due time', () => {
    const list = [followUp('p2', { dueAt: 2 }), followUp('d', { status: 'due', dueAt: 9 }), followUp('p1', { dueAt: 1 })];
    expect([...list].sort(compareFollowUps).map((f) => f.id)).toEqual(['d', 'p1', 'p2']);
  });
});
