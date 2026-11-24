import type { FilterRule, FilterRuleInput } from '@sarvinbox/core';

import { emailsFromSender, emailsMatchingRule } from './filter-matching';
import type { InboxAgentSettingActions, SenderFlag, SenderSettings } from './inbox-assistant-setting-changes';

/**
 * The Inbox Agent's settings for one account's store: the same filter records
 * the Filters page edits, the same sender record block and VIP live on, and
 * the same spammer and trusted lists the spam filter reads at ingest. Shared
 * by the app (ipc/inbox-assistant-handlers.ts) and the test harness.
 */

export interface AgentSettingStorage {
  getFilterRules(): Promise<FilterRule[]>;
  createFilterRule(input: FilterRuleInput): Promise<FilterRule>;
  updateFilterRule(id: string, updates: Partial<FilterRuleInput>): Promise<FilterRule | null>;
  deleteFilterRule(id: string): Promise<void>;
  getSenderStats(email: string): Promise<{ receivedCount: number; readCount: number; repliedCount: number; lastReceived: number | null; isVip: boolean; isBlocked: boolean } | null>;
  getSenderEngagement?(email: string): Promise<{ received: number; read: number }>;
  setSenderVip(email: string, isVip: boolean): Promise<void>;
  setSenderBlocked(email: string, isBlocked: boolean): Promise<void>;
  isSpammer(email: string): Promise<boolean>;
  addSpammer(spammer: { email: string; reason?: string }): Promise<void>;
  removeSpammer(email: string): Promise<void>;
  isTrustedSender(email: string): Promise<boolean>;
  trustSender(email: string): Promise<void>;
  untrustSender(email: string): Promise<void>;
}

export interface AgentSettingTarget {
  storage: AgentSettingStorage;
  /** Checked before every write: the account must still be the one the change was prepared for. */
  assertCurrent(): Promise<void>;
}

export async function readSender(storage: AgentSettingStorage, address: string): Promise<SenderSettings> {
  const [stats, spammer, trusted] = await Promise.all([storage.getSenderStats(address), storage.isSpammer(address), storage.isTrustedSender(address)]);
  if (!stats) return { known: false, blocked: false, vip: false, trusted, spammer };
  // Live counts where the store has them, as the sender panel shows (stored counters drift).
  const live = await storage.getSenderEngagement?.(address);
  const counts = live && live.received > 0 ? { received: live.received, read: live.read } : { received: stats.receivedCount, read: stats.readCount };
  return { known: true, blocked: stats.isBlocked, vip: stats.isVip, trusted, spammer, ...counts, replied: stats.repliedCount, lastReceived: stats.lastReceived };
}

/** Set each flag given, in the store that holds it. */
export async function writeSender(storage: AgentSettingStorage, address: string, flags: Partial<Record<SenderFlag, boolean>>): Promise<void> {
  if (flags.blocked !== undefined) await storage.setSenderBlocked(address, flags.blocked);
  if (flags.vip !== undefined) await storage.setSenderVip(address, flags.vip);
  if (flags.spammer === true) await storage.addSpammer({ email: address, reason: 'Blocked by user' });
  if (flags.spammer === false) await storage.removeSpammer(address);
  if (flags.trusted === true) await storage.trustSender(address);
  if (flags.trusted === false) await storage.untrustSender(address);
}

/** The settings interface over a per-account resolver. Writes check the account first. */
export function createAgentSettingActions(target: (accountId: string) => Promise<AgentSettingTarget>): InboxAgentSettingActions {
  const writing = async (accountId: string) => {
    const resolved = await target(accountId);
    await resolved.assertCurrent();
    return resolved.storage;
  };
  return {
    listFilters: async accountId => (await target(accountId)).storage.getFilterRules(),
    createFilter: async (accountId, input) => (await writing(accountId)).createFilterRule(input),
    updateFilter: async (accountId, id, updates) => (await writing(accountId)).updateFilterRule(id, updates),
    deleteFilter: async (accountId, id) => (await writing(accountId)).deleteFilterRule(id),
    matchFilter: async (accountId, rule) => emailsMatchingRule((await target(accountId)).storage, rule).map(email => email.id),
    senderEmails: async (accountId, address) => emailsFromSender((await target(accountId)).storage, address).map(email => email.id),
    sender: async (accountId, address) => readSender((await target(accountId)).storage, address),
    setSender: async (accountId, address, flags) => writeSender(await writing(accountId), address, flags),
  };
}
