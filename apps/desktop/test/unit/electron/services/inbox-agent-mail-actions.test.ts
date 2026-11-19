import type { EmailRecord, FolderRecord } from '@sarvinbox/core';
import { describe, expect, it, vi } from 'vitest';

import { setEmailLabel } from '../../../../electron/services/email-labels';
import {
  agentSpamVerdicts, createAgentLabel, dropAgentLabel, eachAgentEmail, labelAgentEmails, revertAgentSpamVerdicts, snoozeAgentEmails,
  type AgentMailStorage, type AgentMailTarget,
} from '../../../../electron/services/inbox-agent-mail-actions';
import type { VerdictDeps } from '../../../../electron/services/spam-verdict-actions';
import { emailRecord } from '../../../helpers/email-fixtures';

// The Inbox Agent's label, snooze and spam writes. The app and the test harness
// both run these, so a regression here is the agent reporting a change that
// never reached the mailbox, writing to an account that was replaced, or
// deleting a label the user still uses.

const folder = (id: string, path: string, specialUse: string | null): FolderRecord => ({
  id, name: path, path, parentId: null, uidValidity: 1, lastSyncUid: null, lastSyncTime: null,
  totalCount: 0, unreadCount: 0, specialUse, subscribed: true, createdAt: 0, updatedAt: 0,
});

function store(rows: Array<Partial<EmailRecord> & { id: string }>, labels: string[] = []) {
  const emails = new Map(rows.map(row => [row.id, emailRecord({ folderId: 'f-inbox', tags: '|INBOX|', uid: 5, ...row })]));
  const known = labels.map((name, index) => ({ id: `l${index}`, name }));
  const storage = {
    getEmail: vi.fn(async (id: string) => emails.get(id) ?? null),
    updateEmail: vi.fn(async (id: string, updates: Partial<EmailRecord>) => { Object.assign(emails.get(id)!, updates); }),
    getLabels: vi.fn(async () => known.map(label => ({ ...label }))),
    createLabel: vi.fn(async (input: { name: string }) => { known.push({ id: `l${known.length}`, name: input.name }); }),
    deleteLabel: vi.fn(async (id: string) => { known.splice(known.findIndex(label => label.id === id), 1); }),
    countEmailsWithFolderTag: vi.fn(async (tag: string) => [...emails.values()].filter(row => row.tags.includes(`|${tag}|`)).length),
    snoozeEmail: vi.fn(async (id: string, until: number) => { const row = emails.get(id)!; row.tags = `${row.tags}snoozed|`; row.snoozeUntil = until; }),
    unsnoozeEmail: vi.fn(async (id: string) => { const row = emails.get(id)!; row.tags = row.tags.replace('|snoozed|', '|'); row.snoozeUntil = null; }),
    // Verdict storage, for the spam paths.
    getFolders: async () => [folder('f-inbox', 'INBOX', '\\Inbox'), folder('f-spam', 'Spam', '\\Junk')],
    addSpammer: vi.fn(async () => {}), removeSpammer: vi.fn(async () => {}), trustSender: vi.fn(async () => {}), untrustSender: vi.fn(async () => {}),
    setSpamUserVerdict: vi.fn(async () => {}), recalculateFolderCounts: vi.fn(async () => {}),
  };
  const written: string[] = [];
  const target: AgentMailTarget = { storage: storage as unknown as AgentMailStorage, assertCurrent: vi.fn(async () => {}), onWritten: id => { written.push(id); } };
  const deps = { storage, queue: { moveToSpam: vi.fn(async () => {}), move: vi.fn(async () => {}) }, report: vi.fn() } as unknown as VerdictDeps;
  return { emails, known, storage, target, written, deps };
}

describe('eachAgentEmail', () => {
  // Breaks: an email already as asked is counted as changed, a thrown write is lost, or a replaced account is written to.
  it('reports changed, unchanged and failed emails, once each, and checks the account before every write', async () => {
    const box = store([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
    vi.mocked(box.target.assertCurrent).mockResolvedValueOnce().mockResolvedValueOnce().mockRejectedValueOnce(new Error('replaced'));
    const receipt = await eachAgentEmail(box.target, ['a', 'b', 'a', 'c'], async id => {
      if (id === 'b') return false;
      return true;
    });
    expect(receipt).toEqual({ appliedIds: ['a'], queuedIds: [], failedIds: ['c'] });
    expect(box.written).toEqual(['a']);
    expect(box.target.assertCurrent).toHaveBeenCalledTimes(3);
  });
});

describe('labels', () => {
  // Breaks: a label is applied under a spelling the account does not use, so it never shows under the user's label.
  it('labels in the account\'s own spelling and reports what changed', async () => {
    const box = store([{ id: 'a' }, { id: 'b', tags: '|INBOX|Clients|' }], ['Clients']);
    expect(await labelAgentEmails(box.target, ['a', 'b', 'gone'], 'clients', true)).toEqual({ appliedIds: ['a'], queuedIds: [], failedIds: ['gone'] });
    expect(box.emails.get('a')!.tags).toBe('|INBOX|Clients|');
    expect(await labelAgentEmails(box.target, ['b'], 'Clients', false)).toMatchObject({ appliedIds: ['b'] });
    await expect(labelAgentEmails(box.target, ['a'], 'Leads', true)).rejects.toThrow('No such label.');
  });

  // Breaks: Undo deletes a label the user had before, or one the user put on another email meanwhile.
  it('creates only a missing label, and drops it only when no email carries it', async () => {
    const box = store([{ id: 'a', tags: '|INBOX|Receipts|' }], ['Clients']);
    expect(await createAgentLabel(box.target, 'clients')).toBe(false);
    expect(await createAgentLabel(box.target, 'Receipts')).toBe(true);
    expect(box.storage.createLabel).toHaveBeenCalledWith({ name: 'Receipts' }, false);
    await dropAgentLabel(box.target, 'Receipts');
    expect(box.known.map(label => label.name)).toEqual(['Clients', 'Receipts']);
    box.emails.get('a')!.tags = '|INBOX|';
    await dropAgentLabel(box.target, 'Receipts');
    await dropAgentLabel(box.target, 'Missing');
    expect(box.known.map(label => label.name)).toEqual(['Clients']);
  });

  // Breaks: the mail view's label toggle writes an empty label or reports a missing email as done.
  it('setEmailLabel refuses an empty name and tells missing from unchanged', async () => {
    const box = store([{ id: 'a' }]);
    await expect(setEmailLabel(box.storage, 'a', '  ', true)).rejects.toThrow('Label is required');
    expect(await setEmailLabel(box.storage, 'gone', 'X', true)).toBe('missing');
    expect(await setEmailLabel(box.storage, 'a', 'X', false)).toBe('unchanged');
    expect(await setEmailLabel(box.storage, 'a', 'X', true)).toBe('changed');
  });
});

describe('snooze', () => {
  // Breaks: snoozing again for the same time counts as a change, or waking mail marks it unread like the clock does.
  it('snoozes, skips mail already snoozed until then, and wakes without marking unread', async () => {
    const box = store([{ id: 'a' }, { id: 'b', tags: '|INBOX|snoozed|', snoozeUntil: 500 }]);
    expect(await snoozeAgentEmails(box.target, ['a', 'b', 'gone'], 500)).toEqual({ appliedIds: ['a'], queuedIds: [], failedIds: ['gone'] });
    expect(await snoozeAgentEmails(box.target, ['b'], 900)).toMatchObject({ appliedIds: ['b'] });
    expect(await snoozeAgentEmails(box.target, ['a'], null)).toMatchObject({ appliedIds: ['a'] });
    expect(box.storage.unsnoozeEmail).toHaveBeenCalledWith('a', false);
    expect(await snoozeAgentEmails(box.target, ['a'], null)).toMatchObject({ appliedIds: [] });
  });
});

describe('spam verdicts', () => {
  // Breaks: a verdict that failed is reported as applied, or a failing learning hook fails the verdict.
  it('applies verdicts through the verdict path, and fails only the emails that failed', async () => {
    const box = store([{ id: 'a' }]);
    const learn = vi.fn(async () => { throw new Error('learning down'); });
    expect(await agentSpamVerdicts(box.target, box.deps, ['a', 'gone'], 'spam', learn)).toEqual({ appliedIds: ['a'], queuedIds: [], failedIds: ['gone'] });
    expect(box.emails.get('a')!.folderId).toBe('f-spam');
    expect(learn).toHaveBeenCalledOnce();
    expect(await agentSpamVerdicts(box.target, box.deps, ['a'], 'ham')).toMatchObject({ appliedIds: ['a'] });
  });

  // Breaks: Undo of a verdict reports success for mail it could not move back.
  it('reverts each email from its own row, failing the ones that cannot go back yet', async () => {
    const box = store([{ id: 'a', folderId: 'f-spam', tags: '|Spam|spam|', uid: 8 }, { id: 'b', folderId: 'f-spam', tags: '|Spam|spam|', uid: 0 }]);
    const rows = ['a', 'b'].map(emailId => ({ emailId, tags: '|INBOX|', folderId: 'f-inbox', verdict: null }));
    expect(await revertAgentSpamVerdicts(box.target, box.deps, rows)).toEqual({ appliedIds: ['a'], queuedIds: [], failedIds: ['b'] });
    expect(box.emails.get('a')!.folderId).toBe('f-inbox');
    expect(box.emails.get('b')!.folderId).toBe('f-spam');
  });
});
