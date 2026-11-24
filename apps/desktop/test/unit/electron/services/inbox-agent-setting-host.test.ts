import { describe, expect, it, vi } from 'vitest';

import { emailsFromSender, emailsMatchingRule, scanEmailsForFilter } from '../../../../electron/services/filter-matching';
import { createAgentSettingActions, readSender, writeSender, type AgentSettingStorage } from '../../../../electron/services/inbox-agent-setting-host';

// The Inbox Agent's settings over one account's store, and the filter scan the
// Filters page shares. A regression here is a sender reported as unknown when
// it has history (so VIP is refused), a flag written to the wrong list, a
// write to an account that was replaced, or a block that also catches a
// different sender whose name contains the address.

function storage(over: Partial<AgentSettingStorage> = {}): AgentSettingStorage {
  return {
    getFilterRules: vi.fn(async () => []), createFilterRule: vi.fn(), updateFilterRule: vi.fn(), deleteFilterRule: vi.fn(),
    getSenderStats: vi.fn(async () => null), setSenderVip: vi.fn(async () => {}), setSenderBlocked: vi.fn(async () => {}),
    isSpammer: vi.fn(async () => false), addSpammer: vi.fn(async () => {}), removeSpammer: vi.fn(async () => {}),
    isTrustedSender: vi.fn(async () => false), trustSender: vi.fn(async () => {}), untrustSender: vi.fn(async () => {}),
    ...over,
  } as AgentSettingStorage;
}

const ROWS = [
  { id: 'a', fromAddress: 'News@Shop.test', fromName: 'Shop', subject: 'Deals', cleanBody: 'x' },
  { id: 'b', fromAddress: 'other@else.test', fromName: 'news@shop.test fan', subject: 'Hi', cleanBody: 'y' },
];
const withDb = (rows: unknown[]) => ({ db: { prepare: vi.fn(() => ({ all: () => rows })) } });

describe('the filter scan', () => {
  // Breaks: a store without a database (not initialised) throws instead of matching nothing.
  it('matches nothing in a store with no database', () => {
    expect(scanEmailsForFilter({})).toEqual([]);
  });

  // Breaks: blocking news@shop.test also moves mail from someone whose display name mentions it.
  it('finds a sender\'s mail by exact address, while a filter\'s "from" also reads the name', () => {
    const store = withDb(ROWS);
    expect(emailsFromSender(store, ' news@shop.TEST ').map(row => row.id)).toEqual(['a']);
    expect(emailsMatchingRule(store, { matchType: 'all', conditions: [{ field: 'from', operator: 'contains', value: 'news@shop.test' }] }).map(row => row.id)).toEqual(['a', 'b']);
  });
});

describe('reading and writing a sender', () => {
  // Breaks: a sender with history reads as unknown (VIP refused), or stale stored counts are shown over live ones.
  it('reads a known sender with live counts when the store has them, and stored counts otherwise', async () => {
    const stats = { receivedCount: 9, readCount: 1, repliedCount: 2, lastReceived: 100, isVip: true, isBlocked: false };
    const live = storage({ getSenderStats: vi.fn(async () => stats), getSenderEngagement: vi.fn(async () => ({ received: 4, read: 3 })), isTrustedSender: vi.fn(async () => true) });
    expect(await readSender(live, 'a@b.test')).toEqual({ known: true, blocked: false, vip: true, trusted: true, spammer: false, received: 4, read: 3, replied: 2, lastReceived: 100 });
    const stored = storage({ getSenderStats: vi.fn(async () => stats), getSenderEngagement: vi.fn(async () => ({ received: 0, read: 0 })) });
    expect(await readSender(stored, 'a@b.test')).toMatchObject({ received: 9, read: 1 });
    expect(await readSender(storage({ isSpammer: vi.fn(async () => true) }), 'a@b.test')).toEqual({ known: false, blocked: false, vip: false, trusted: false, spammer: true });
  });

  // Breaks: a flag is written to the wrong list, or a flag not asked for is touched.
  it('writes each flag to the list that holds it, and nothing else', async () => {
    const store = storage();
    await writeSender(store, 'a@b.test', { blocked: true, vip: false, spammer: true, trusted: false });
    expect(store.setSenderBlocked).toHaveBeenCalledWith('a@b.test', true);
    expect(store.setSenderVip).toHaveBeenCalledWith('a@b.test', false);
    expect(store.addSpammer).toHaveBeenCalledWith({ email: 'a@b.test', reason: 'Blocked by user' });
    expect(store.untrustSender).toHaveBeenCalledWith('a@b.test');
    const other = storage();
    await writeSender(other, 'a@b.test', { spammer: false, trusted: true });
    expect(other.removeSpammer).toHaveBeenCalledOnce();
    expect(other.trustSender).toHaveBeenCalledOnce();
    expect(other.setSenderBlocked).not.toHaveBeenCalled();
    expect(other.setSenderVip).not.toHaveBeenCalled();
  });

  // Breaks: a setting is written to an account that was removed or replaced after the change was prepared.
  it('checks the account before every write, and not for reads', async () => {
    const store = storage();
    const assertCurrent = vi.fn(async () => { throw new Error('replaced'); });
    const actions = createAgentSettingActions(async () => ({ storage: store, assertCurrent }));
    await expect(actions.createFilter('a1', { name: 'x', conditions: [], actions: [] })).rejects.toThrow('replaced');
    await expect(actions.updateFilter('a1', 'r1', {})).rejects.toThrow('replaced');
    await expect(actions.deleteFilter('a1', 'r1')).rejects.toThrow('replaced');
    await expect(actions.setSender('a1', 'a@b.test', { vip: true })).rejects.toThrow('replaced');
    expect(store.createFilterRule).not.toHaveBeenCalled();
    expect(store.setSenderVip).not.toHaveBeenCalled();
    expect(await actions.listFilters('a1')).toEqual([]);
    expect(await actions.matchFilter('a1', { matchType: 'all', conditions: [] })).toEqual([]);
    expect(await actions.senderEmails('a1', 'a@b.test')).toEqual([]);
    expect((await actions.sender('a1', 'a@b.test')).known).toBe(false);
  });
});
