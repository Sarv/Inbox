import type { EmailRecord, FilterRule, FilterRuleInput } from '@sarvinbox/core';
import { describe, expect, it, vi } from 'vitest';

import type { AssistantReadReceipt } from '../../../../electron/services/assistant-mail-actions';
import { INBOX_AGENT_CHANGE_LIMITS, stageChangeSet, type InboxAgentMailActions } from '../../../../electron/services/inbox-assistant-change-sets';
import {
  applySettingChange, cancelSettingChange, describeFilter, senderChanges, senderFlags, senderWords, stageSettingChange, undoSettingChange,
  type InboxAgentSettingActions, type SenderSettings, type SettingPlan,
} from '../../../../electron/services/inbox-assistant-setting-changes';
import { emailRecord } from '../../../helpers/email-fixtures';

// Standing changes: a filter or a sender setting the agent asked for. A
// regression here is a setting saved without the user's approval, existing
// mail changed although the user left the box unticked, an Undo that deletes
// a filter the user edited since, or a retry that applies mail changes twice.

const T0 = 1_800_000_000_000;
const FOLDERS = [{ id: 'f-inbox', name: 'INBOX', path: 'INBOX', specialUse: '\\Inbox' }, { id: 'f-archive', name: 'Archive', path: 'Archive', specialUse: '\\Archive' }]
  .map(folder => ({ ...folder, parentId: null, uidValidity: 1, lastSyncUid: null, lastSyncTime: null, totalCount: 0, unreadCount: 0, subscribed: true, createdAt: 0, updatedAt: 0 }));

function world() {
  let clock = 1;
  const filters: FilterRule[] = [];
  const senders = new Map<string, SenderSettings>();
  const calls: string[] = [];
  const failing = new Set<string>();
  const settings: InboxAgentSettingActions = {
    listFilters: vi.fn(async () => filters.map(rule => ({ ...rule }))),
    createFilter: vi.fn(async (_account: string, input: FilterRuleInput) => {
      calls.push(`create ${input.name}`);
      if (failing.has('create')) throw new Error('disk full');
      const rule: FilterRule = { id: `r${filters.length + 1}`, enabled: true, priority: 0, matchType: 'all', stopProcessing: false, createdAt: clock, updatedAt: clock++, ...input } as FilterRule;
      filters.push(rule);
      return { ...rule };
    }),
    updateFilter: vi.fn(async (_account: string, id: string, updates: Partial<FilterRuleInput>) => {
      calls.push(`update ${id}`);
      const rule = filters.find(item => item.id === id);
      if (!rule) return null;
      Object.assign(rule, updates, { updatedAt: clock++ });
      return { ...rule };
    }),
    deleteFilter: vi.fn(async (_account: string, id: string) => { calls.push(`delete ${id}`); filters.splice(filters.findIndex(rule => rule.id === id), 1); }),
    matchFilter: vi.fn(async () => []),
    senderEmails: vi.fn(async () => []),
    sender: vi.fn(async (_account: string, address: string) => ({ ...(senders.get(address) ?? { known: false, blocked: false, vip: false, trusted: false, spammer: false }) })),
    setSender: vi.fn(async (_account: string, address: string, flags) => {
      calls.push(`sender ${JSON.stringify(flags)}`);
      if (failing.has('sender')) throw new Error('locked');
      senders.set(address, { ...(senders.get(address) ?? { known: false, blocked: false, vip: false, trusted: false, spammer: false }), ...flags });
    }),
  };
  const rows = new Map<string, EmailRecord>();
  const receipt = (ids: string[], edit: (row: EmailRecord) => void): AssistantReadReceipt => {
    const result: AssistantReadReceipt = { appliedIds: [], queuedIds: [], failedIds: [] };
    for (const id of ids) {
      if (failing.has(id)) { result.failedIds.push(id); continue; }
      edit(rows.get(id)!);
      result.appliedIds.push(id);
    }
    return result;
  };
  const mail = {
    setRead: vi.fn(async (_account: string, ids: string[], read: boolean) => receipt(ids, row => { row.tags = read ? `${row.tags}read|` : row.tags.replace('|read|', '|'); })),
    createLabel: vi.fn(async () => { calls.push('createLabel'); return true; }),
    dropLabel: vi.fn(async () => { calls.push('dropLabel'); }),
  } as unknown as InboxAgentMailActions;
  const readEmail = vi.fn(async (_account: string, id: string) => rows.get(id) ?? null);
  const options = (over: Record<string, unknown> = {}) => ({ settings, mail, readEmail, nowMs: T0 + 1_000, ...over });
  return { filters, senders, calls, failing, settings, rows, mail, readEmail, options };
}

const INPUT: FilterRuleInput = { name: 'News', enabled: true, matchType: 'all', conditions: [{ field: 'from', operator: 'contains', value: 'news@' }], actions: [{ type: 'markRead' }], stopProcessing: false };

function stage(w: ReturnType<typeof world>, plan: SettingPlan, linkedIds: string[] = [], protect: string[] = []) {
  for (const id of linkedIds) w.rows.set(id, emailRecord({ id, folderId: 'f-inbox', tags: '|INBOX|' }));
  const linked = linkedIds.length ? [stageChangeSet({ label: 'R1-1', action: 'mark_read', nowMs: T0, targets: linkedIds.map(id => ({
    accountId: 'a1', accountEmail: 'a1@example.test', email: { ...w.rows.get(id)! }, folders: FOLDERS, ...(protect.includes(id) ? { protectedReason: 'Starred' } : {}),
  })) })] : [];
  return stageSettingChange({ label: 'R1', kind: plan.kind, accountId: 'a1', accountEmail: 'a1@example.test', summary: 'Change', details: ['d'], plan, linked,
    existingText: 'Also apply it to the emails it matches now', nowMs: T0 });
}

describe('describing a standing change', () => {
  // Breaks: the card says something other than what the filter does.
  it('words a filter\'s conditions and actions', () => {
    expect(describeFilter(INPUT)).toEqual(['When From contains "news@"', 'Then: Mark read']);
    expect(describeFilter({ ...INPUT, enabled: false, matchType: 'any', stopProcessing: true, conditions: [
      { field: 'subject', operator: 'notContains', value: 'a' }, { field: 'domain', operator: 'equals', value: 'b.test' },
      { field: 'to', operator: 'startsWith', value: 'c' }, { field: 'cc', operator: 'endsWith', value: 'd' }, { field: 'body', operator: 'contains', value: 'e' },
    ], actions: [{ type: 'star' }, { type: 'archive' }, { type: 'delete' }, { type: 'moveToSpam' }, { type: 'moveToFolder', value: 'Work' }, { type: 'applyLabel', value: 'Clients' }] }))
      .toEqual([
        'When any of: Subject does not contain "a"; or Sender domain is "b.test"; or To starts with "c"; or Cc ends with "d"; or Body contains "e"',
        'Then: Star, Archive, Move to Trash, Move to Spam, Move to Work, Label "Clients"; and no later filter runs',
        'Turned off',
      ]);
  });

  // Breaks: blocking leaves a trusted sender trusted (their mail bypasses the filter), or VIP is set on a sender with no record.
  it('sets the flags each sender change needs, only the ones that change', () => {
    expect(senderFlags('block_sender', true)).toEqual({ blocked: true, spammer: true, trusted: false });
    expect(senderFlags('block_sender', false)).toEqual({ spammer: true, trusted: false });
    expect(senderFlags('unblock_sender', true)).toEqual({ blocked: false, spammer: false });
    expect(senderFlags('unblock_sender', false)).toEqual({ spammer: false });
    expect(senderFlags('trust_sender', true)).toEqual({ trusted: true, spammer: false, blocked: false });
    expect(senderFlags('trust_sender', false)).toEqual({ trusted: true, spammer: false });
    expect(senderFlags('untrust_sender', true)).toEqual({ trusted: false });
    expect(senderFlags('add_vip', true)).toEqual({ vip: true });
    expect(senderFlags('remove_vip', true)).toEqual({ vip: false });
    expect(senderChanges({ spammer: true, trusted: false }, { known: false, blocked: false, vip: false, trusted: false, spammer: false })).toEqual({ spammer: true });
    for (const kind of ['block_sender', 'unblock_sender', 'add_vip', 'remove_vip', 'trust_sender', 'untrust_sender'] as const) {
      expect(senderWords(kind, 'a@b.test')[0]).toContain('a@b.test');
    }
  });

  // Breaks: an empty existing-mail offer shows on the card, or protected mail is counted as mail it will change.
  it('offers existing mail only when there is some, counting each email once and its protected ones', () => {
    const w = world();
    const held = stage(w, { kind: 'create_filter', input: INPUT }, ['m1', 'm2'], ['m2']);
    expect(held.change.existing).toEqual({ text: 'Also apply it to the emails it matches now', count: 2, protectedCount: 1 });
    expect(held.change).toMatchObject({ status: 'pending', approveBy: T0 + INBOX_AGENT_CHANGE_LIMITS.approveMs, undoBy: 0 });
    expect(stage(w, { kind: 'create_filter', input: INPUT }).change.existing).toBeUndefined();
  });
});

describe('approving a standing change', () => {
  // Breaks: existing mail is changed although the user left the box unticked.
  it('saves the filter and leaves existing mail alone unless ticked', async () => {
    const w = world();
    const held = stage(w, { kind: 'create_filter', input: INPUT }, ['m1']);
    await applySettingChange(held, w.options());
    expect(w.filters.map(rule => rule.name)).toEqual(['News']);
    expect(held.change).toMatchObject({ status: 'applied', undoBy: T0 + 1_000 + INBOX_AGENT_CHANGE_LIMITS.undoMs });
    expect(held.change.existingApplied).toBeUndefined();
    expect(w.mail.setRead).not.toHaveBeenCalled();
    await expect(applySettingChange(held, w.options())).rejects.toThrow('already applied');
  });

  // Breaks: ticking "apply to existing" changes protected mail, or a retry re-applies rows that worked.
  it('applies to unprotected existing mail when ticked, and retries only what failed', async () => {
    const w = world();
    const held = stage(w, { kind: 'create_filter', input: INPUT }, ['m1', 'm2', 'm3'], ['m3']);
    w.failing.add('m2');
    await applySettingChange(held, w.options({ includeExisting: true }));
    expect(held.change).toMatchObject({ status: 'applied', existingApplied: true });
    expect(held.change.existing!.result).toBe('1 email changed · 1 protected left as it is · 1 failed');
    expect(w.rows.get('m3')!.tags).not.toContain('|read|');
    w.failing.clear();
    await applySettingChange(held, w.options());
    expect(w.calls.filter(call => call.startsWith('create'))).toHaveLength(1);
    expect(vi.mocked(w.mail.setRead).mock.calls.map(call => call[1])).toEqual([['m1', 'm2'], ['m2']]);
    expect(held.change.existing!.result).toBe('2 emails changed · 1 protected left as it is');
  });

  // Breaks: a transient failure to save closes the card, so the user cannot try again.
  it('keeps the card open with a reason when the setting could not be saved, and saves on a retry', async () => {
    const w = world();
    const held = stage(w, { kind: 'create_filter', input: { ...INPUT, actions: [{ type: 'applyLabel', value: 'News' }] }, createsLabel: 'News' });
    w.failing.add('create');
    await applySettingChange(held, w.options());
    expect(held.change).toMatchObject({ status: 'pending', detail: 'Could not be saved. Approve again to retry.' });
    w.failing.clear();
    await applySettingChange(held, w.options());
    expect(held.change.status).toBe('applied');
    expect(held.change.detail).toBeUndefined();
    // The label was created once, on the first try, and is not created again.
    expect(w.calls.filter(call => call === 'createLabel')).toHaveLength(1);
    expect(held.labelCreated).toBe(true);
  });

  // Breaks: an update overwrites a filter the user edited after the agent read it.
  it('refuses to update or delete a filter changed or deleted since it was read', async () => {
    const w = world();
    const rule = await w.settings.createFilter('a1', INPUT);
    const update = stage(w, { kind: 'update_filter', filterId: rule.id, updates: { name: 'Renamed' }, expectedUpdatedAt: rule.updatedAt - 1 });
    await applySettingChange(update, w.options());
    expect(update.change).toMatchObject({ status: 'pending', detail: 'This filter was changed after the change was prepared. Ask again to prepare it fresh.' });
    const gone = stage(w, { kind: 'delete_filter', filterId: 'missing', expectedUpdatedAt: 1 });
    await applySettingChange(gone, w.options());
    expect(gone.change.detail).toBe('This filter no longer exists.');
    expect(w.filters[0]!.name).toBe('News');
  });

  // Breaks: an expired, cancelled or busy card can still be approved.
  it('refuses an expired, cancelled or busy change', async () => {
    const w = world();
    const expired = stage(w, { kind: 'create_filter', input: INPUT });
    await expect(applySettingChange(expired, w.options({ nowMs: expired.change.approveBy + 1 }))).rejects.toThrow('waited too long');
    expect(expired.change.status).toBe('expired');
    const cancelled = stage(w, { kind: 'create_filter', input: INPUT });
    cancelSettingChange(cancelled);
    expect(cancelled.change.status).toBe('cancelled');
    await expect(applySettingChange(cancelled, w.options())).rejects.toThrow('was cancelled');
    expect(() => cancelSettingChange(cancelled)).toThrow('can no longer be cancelled');
    const busy = stage(w, { kind: 'create_filter', input: INPUT });
    busy.busy = true;
    await expect(applySettingChange(busy, w.options())).rejects.toThrow('already being applied');
    expect(() => cancelSettingChange(busy)).toThrow('being applied');
    expect(w.filters).toEqual([]);
  });
});

describe('undoing a standing change', () => {
  // Breaks: Undo leaves the agent's filter running, or leaves its existing-mail changes in place.
  it('puts existing mail back, then deletes the created filter and the label it created', async () => {
    const w = world();
    const held = stage(w, { kind: 'create_filter', input: INPUT, createsLabel: 'News' }, ['m1']);
    await applySettingChange(held, w.options({ includeExisting: true }));
    expect(w.rows.get('m1')!.tags).toContain('|read|');
    await undoSettingChange(held, w.options());
    expect(w.rows.get('m1')!.tags).not.toContain('|read|');
    expect(w.filters).toEqual([]);
    expect(w.calls.at(-1)).toBe('dropLabel');
    expect(held.change).toMatchObject({ status: 'undone' });
    expect(held.change.existing!.result).toBe('1 email put back');
    await expect(undoSettingChange(held, w.options())).rejects.toThrow('nothing to undo');
  });

  // Breaks: Undo deletes or reverts a filter the user edited after approving.
  it('leaves a filter the user edited since, and says so', async () => {
    const w = world();
    const created = stage(w, { kind: 'create_filter', input: INPUT });
    await applySettingChange(created, w.options());
    await w.settings.updateFilter('a1', w.filters[0]!.id, { name: 'Mine now' });
    await undoSettingChange(created, w.options());
    expect(w.filters.map(rule => rule.name)).toEqual(['Mine now']);
    expect(created.change).toMatchObject({ status: 'undone', detail: 'The filter was edited since, so it was left as it is now.' });
  });

  // Breaks: Undo of an update or a delete does not bring the user's filter back as it was.
  it('restores an updated filter, and recreates a deleted one', async () => {
    const w = world();
    const rule = await w.settings.createFilter('a1', INPUT);
    const update = stage(w, { kind: 'update_filter', filterId: rule.id, updates: { name: 'Renamed', enabled: false }, expectedUpdatedAt: rule.updatedAt });
    await applySettingChange(update, w.options());
    expect(w.filters[0]).toMatchObject({ name: 'Renamed', enabled: false });
    await undoSettingChange(update, w.options());
    expect(w.filters[0]).toMatchObject({ name: 'News', enabled: true });

    const current = w.filters[0]!;
    const remove = stage(w, { kind: 'delete_filter', filterId: current.id, expectedUpdatedAt: current.updatedAt });
    await applySettingChange(remove, w.options());
    expect(w.filters).toEqual([]);
    await undoSettingChange(remove, w.options());
    expect(w.filters.map(item => [item.name, item.conditions])).toEqual([['News', INPUT.conditions]]);
  });

  // Breaks: Undo of a deleted-by-the-user agent filter fails, or an update whose filter vanished claims success.
  it('treats a created filter the user already deleted as undone, and an updated one that vanished as changed since', async () => {
    const w = world();
    const created = stage(w, { kind: 'create_filter', input: INPUT });
    await applySettingChange(created, w.options());
    await w.settings.deleteFilter('a1', w.filters[0]!.id);
    await undoSettingChange(created, w.options());
    expect(created.change).toMatchObject({ status: 'undone' });
    expect(created.change.detail).toBeUndefined();

    const rule = await w.settings.createFilter('a1', INPUT);
    const update = stage(w, { kind: 'update_filter', filterId: rule.id, updates: { name: 'X' }, expectedUpdatedAt: rule.updatedAt });
    await applySettingChange(update, w.options());
    await w.settings.deleteFilter('a1', rule.id);
    await undoSettingChange(update, w.options());
    expect(update.change.detail).toBe('The filter was edited since, so it was left as it is now.');
  });

  // Breaks: Undo of a block unblocks a sender the user had blocked themselves, or restores flags the user changed since.
  it('restores each sender flag it set, only where it is still as the change left it', async () => {
    const w = world();
    w.senders.set('a@b.test', { known: true, blocked: false, vip: false, trusted: true, spammer: false });
    const held = stage(w, { kind: 'block_sender', address: 'a@b.test', flags: { blocked: true, spammer: true, trusted: false } });
    await applySettingChange(held, w.options());
    expect(held.senderBefore).toEqual({ blocked: false, spammer: false, trusted: true });
    expect(w.senders.get('a@b.test')).toMatchObject({ blocked: true, spammer: true, trusted: false });
    // The user takes them off the spam list themselves.
    w.senders.get('a@b.test')!.spammer = false;
    await undoSettingChange(held, w.options());
    expect(w.senders.get('a@b.test')).toMatchObject({ blocked: false, spammer: false, trusted: true });
    expect(w.calls.at(-1)).toBe('sender {"blocked":false,"trusted":true}');
    expect(held.change).toMatchObject({ status: 'undone', detail: 'Some of it was changed since, so that part was left as it is now.' });
  });

  // Breaks: a failed Undo closes the card, or Undo runs after its window.
  it('keeps the change undoable when Undo fails, and refuses after the window', async () => {
    const w = world();
    const held = stage(w, { kind: 'add_vip', address: 'a@b.test', flags: { vip: true } });
    await applySettingChange(held, w.options());
    w.failing.add('sender');
    await undoSettingChange(held, w.options());
    expect(held.change).toMatchObject({ status: 'applied', detail: 'Could not be undone. Try Undo again.' });
    await expect(undoSettingChange(held, w.options({ nowMs: held.change.undoBy + 1 }))).rejects.toThrow('can no longer be undone');
    w.failing.clear();
    await undoSettingChange(held, w.options());
    expect(held.change.status).toBe('undone');
  });
});
