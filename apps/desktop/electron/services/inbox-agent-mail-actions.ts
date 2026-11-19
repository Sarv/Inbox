import { hasTag, type EmailRecord } from '@sarvinbox/core';

import type { AssistantReadReceipt } from './assistant-mail-actions';
import { setEmailLabel } from './email-labels';
import type { InboxAgentSpamRevert } from './inbox-assistant-change-sets';
import { applyUserSpamVerdict, revertUserSpamVerdict, type VerdictDeps } from './spam-verdict-actions';

/**
 * The Inbox Agent's label, snooze and spam writes for one account, each the
 * same local write the mail view makes, returning the receipt change sets
 * read. Shared by the app (ipc/inbox-assistant-handlers.ts) and the test
 * harness, so a test approves exactly what the app would.
 */

export interface AgentMailStorage {
  getEmail(id: string): Promise<EmailRecord | null>;
  updateEmail(id: string, updates: { tags: string }): Promise<unknown>;
  getLabels(): Promise<Array<{ id: string; name: string }>>;
  createLabel(input: { name: string }, syncedToServer?: boolean): Promise<unknown>;
  deleteLabel(id: string): Promise<void>;
  /** Emails carrying a tag (labels are tags). */
  countEmailsWithFolderTag(tag: string): Promise<number>;
  snoozeEmail(id: string, until: number): Promise<unknown>;
  unsnoozeEmail(id: string, markUnread?: boolean): Promise<void>;
}

export interface AgentMailTarget {
  storage: AgentMailStorage;
  /** Checked before every write: the account must still be the one the change was prepared for. */
  assertCurrent(): Promise<void>;
  /** Told after each email that changed, with its new tags (the mail list refresh). */
  onWritten?(emailId: string, tags: string): void;
}

/**
 * One local write per email: applied when it changed, in no list when it was
 * already so, failed when it threw. The account is checked before each write.
 */
export async function eachAgentEmail(target: AgentMailTarget, emailIds: string[], write: (emailId: string) => Promise<boolean>): Promise<AssistantReadReceipt> {
  const receipt: AssistantReadReceipt = { appliedIds: [], queuedIds: [], failedIds: [] };
  for (const emailId of new Set(emailIds)) {
    try {
      await target.assertCurrent();
      if (!await write(emailId)) continue;
      receipt.appliedIds.push(emailId);
      const after = await target.storage.getEmail(emailId);
      if (after) target.onWritten?.(emailId, after.tags || '||');
    } catch { receipt.failedIds.push(emailId); }
  }
  return receipt;
}

/** The account's own spelling of a label, matched without case, or undefined. */
async function labelNamed(storage: AgentMailStorage, name: string) {
  return (await storage.getLabels()).find(label => label.name.toLowerCase() === name.toLowerCase());
}

export async function labelAgentEmails(target: AgentMailTarget, emailIds: string[], name: string, on: boolean): Promise<AssistantReadReceipt> {
  await target.assertCurrent();
  const label = await labelNamed(target.storage, name);
  if (!label) throw new Error('No such label.');
  return eachAgentEmail(target, emailIds, async emailId => {
    const outcome = await setEmailLabel(target.storage, emailId, label.name, on);
    if (outcome === 'missing') throw new Error('Email not found');
    return outcome === 'changed';
  });
}

/** Creates the label, local only. False when it already existed, so Undo leaves it. */
export async function createAgentLabel(target: AgentMailTarget, name: string): Promise<boolean> {
  await target.assertCurrent();
  if (await labelNamed(target.storage, name)) return false;
  await target.storage.createLabel({ name }, false);
  return true;
}

/** Deletes a label the agent created, unless an email still carries it (the user labelled one meanwhile). */
export async function dropAgentLabel(target: AgentMailTarget, name: string): Promise<void> {
  await target.assertCurrent();
  const label = (await target.storage.getLabels()).find(item => item.name === name);
  if (!label || await target.storage.countEmailsWithFolderTag(name) > 0) return;
  await target.storage.deleteLabel(label.id);
}

/** Snooze until a time (unix seconds), or wake now with null, which leaves read or unread as it is. */
export function snoozeAgentEmails(target: AgentMailTarget, emailIds: string[], until: number | null): Promise<AssistantReadReceipt> {
  return eachAgentEmail(target, emailIds, async emailId => {
    const before = await target.storage.getEmail(emailId);
    if (!before) throw new Error('Email not found');
    const snoozed = hasTag(before.tags || '||', 'snoozed');
    if (until === null) {
      if (!snoozed) return false;
      await target.storage.unsnoozeEmail(emailId, false);
    } else {
      if (snoozed && before.snoozeUntil === until) return false;
      await target.storage.snoozeEmail(emailId, until);
    }
    return true;
  });
}

/** Report spam / Not spam, through the one verdict path the mail view uses. */
export function agentSpamVerdicts(
  target: AgentMailTarget, deps: VerdictDeps, emailIds: string[], verdict: 'spam' | 'ham',
  onVerdict?: (email: EmailRecord) => Promise<void>,
): Promise<AssistantReadReceipt> {
  return eachAgentEmail(target, emailIds, async emailId => {
    const outcome = await applyUserSpamVerdict(deps, emailId, verdict);
    if (!outcome.success) throw new Error('Verdict failed');
    if (outcome.email) { try { await onVerdict?.(outcome.email); } catch { /* Learning only. */ } }
    return true;
  });
}

export function revertAgentSpamVerdicts(target: AgentMailTarget, deps: VerdictDeps, rows: InboxAgentSpamRevert[]): Promise<AssistantReadReceipt> {
  const byId = new Map(rows.map(row => [row.emailId, row]));
  return eachAgentEmail(target, [...byId.keys()], async emailId => {
    const outcome = await revertUserSpamVerdict(deps, byId.get(emailId)!);
    if (!outcome.success) throw new Error('Undo failed');
    return true;
  });
}
