import { randomUUID } from 'node:crypto';

import type { FilterAction, FilterCondition, FilterRule, FilterRuleInput } from '@sarvinbox/core';

import type { InboxAgentSettingChange, InboxAgentSettingKind } from '../../src/types/inbox-assistant-changes';

import {
  applyChangeSet, INBOX_AGENT_CHANGE_LIMITS, InboxAgentChangeError, undoChangeSet,
  type HeldChangeSet, type InboxAgentEmailReader, type InboxAgentMailActions,
} from './inbox-assistant-change-sets';

/**
 * Standing changes: the settings the Inbox Agent asks to change (a filter, a
 * sender block, VIP, trust). Unlike a change set they keep acting after the
 * chat, so they ALWAYS wait for the user's approval, in every mode, one card
 * each. Existing mail a change could also act on (a filter's matches, a
 * blocked sender's mail) is a linked change set, staged with the card and
 * applied only when the user ticks it, through the change sets' own rules
 * (protected mail left alone, Undo).
 *
 * Undo puts back only what is still as the change left it: a filter the user
 * edited since, or a sender the user unblocked themselves, keeps the user's
 * version.
 */

export type SenderFlag = 'blocked' | 'vip' | 'trusted' | 'spammer';
export type SenderFlags = Partial<Record<SenderFlag, boolean>>;

/** What the app knows about a sender in one account. */
export interface SenderSettings {
  /** The sender has mail history here (block and VIP live on that record). */
  known: boolean;
  blocked: boolean;
  vip: boolean;
  trusted: boolean;
  /** On the spammer list: their new mail is filed in Spam. */
  spammer: boolean;
  received?: number;
  read?: number;
  replied?: number;
  /** Unix seconds. */
  lastReceived?: number | null;
}

/** The host's settings, per account. */
export interface InboxAgentSettingActions {
  listFilters(accountId: string): Promise<FilterRule[]>;
  createFilter(accountId: string, input: FilterRuleInput): Promise<FilterRule>;
  updateFilter(accountId: string, id: string, updates: Partial<FilterRuleInput>): Promise<FilterRule | null>;
  deleteFilter(accountId: string, id: string): Promise<void>;
  /** Ids of the stored emails a rule matches, newest first, from the scan the Filters page uses. */
  matchFilter(accountId: string, rule: { matchType: 'all' | 'any'; conditions: FilterCondition[] }): Promise<string[]>;
  /** Ids of the stored emails from exactly this address, newest first. */
  senderEmails(accountId: string, address: string): Promise<string[]>;
  sender(accountId: string, address: string): Promise<SenderSettings>;
  setSender(accountId: string, address: string, flags: SenderFlags): Promise<void>;
}

export const SENDER_KINDS = ['block_sender', 'unblock_sender', 'add_vip', 'remove_vip', 'trust_sender', 'untrust_sender'] as const;
export type SenderKind = typeof SENDER_KINDS[number];

/** What approving a standing change does. */
export type SettingPlan =
  | { kind: 'create_filter'; input: FilterRuleInput; createsLabel?: string }
  | { kind: 'update_filter'; filterId: string; updates: Partial<FilterRuleInput>; expectedUpdatedAt: number; createsLabel?: string }
  | { kind: 'delete_filter'; filterId: string; expectedUpdatedAt: number }
  | { kind: SenderKind; address: string; flags: SenderFlags };

export interface HeldSettingChange {
  change: InboxAgentSettingChange;
  plan: SettingPlan;
  /** Existing mail, applied only when the user ticks it. */
  linked: HeldChangeSet[];
  /** The filter before the change (update, delete), for Undo. */
  filterBefore?: FilterRule;
  /** The filter as the change left it (create, update), to tell whether the user edited it since. */
  filterAfter?: FilterRule;
  /** The sender's flags this change set, as they were before it. */
  senderBefore?: SenderFlags;
  /** Approving created the filter's label: Undo deletes it again if unused. */
  labelCreated?: boolean;
  busy: boolean;
}

export const INBOX_AGENT_SETTING_LIMITS = {
  /** Standing changes one run may ask for. */
  perRun: 5,
  conditions: 10,
  actions: 5,
} as const;

// ── Plain words for the card and the model.

const FIELD_WORDS: Record<FilterCondition['field'], string> = { from: 'From', to: 'To', cc: 'Cc', subject: 'Subject', body: 'Body', domain: 'Sender domain' };
const OPERATOR_WORDS: Record<FilterCondition['operator'], string> = { contains: 'contains', notContains: 'does not contain', equals: 'is', startsWith: 'starts with', endsWith: 'ends with' };

export function describeCondition(condition: FilterCondition): string {
  return `${FIELD_WORDS[condition.field]} ${OPERATOR_WORDS[condition.operator]} "${condition.value}"`;
}

export function describeAction(action: FilterAction): string {
  switch (action.type) {
    case 'markRead': return 'Mark read';
    case 'star': return 'Star';
    case 'archive': return 'Archive';
    case 'delete': return 'Move to Trash';
    case 'moveToSpam': return 'Move to Spam';
    case 'moveToFolder': return `Move to ${action.value}`;
    case 'applyLabel': return `Label "${action.value}"`;
  }
}

/** A rule in plain words: one line for when it matches, one for what it does. */
export function describeFilter(rule: Pick<FilterRuleInput, 'matchType' | 'conditions' | 'actions' | 'stopProcessing'> & { enabled?: boolean }): string[] {
  const when = rule.conditions.map(describeCondition);
  return [
    `When ${when.length > 1 ? `${rule.matchType === 'any' ? 'any' : 'all'} of: ` : ''}${when.join(rule.matchType === 'any' ? '; or ' : '; and ')}`,
    `Then: ${rule.actions.map(describeAction).join(', ')}${rule.stopProcessing ? '; and no later filter runs' : ''}`,
    ...(rule.enabled === false ? ['Turned off'] : []),
  ];
}

const SENDER_WORDS: Record<SenderKind, (address: string) => [string, string[]]> = {
  block_sender: address => [`Block ${address}`, ['Their new mail goes to Spam.']],
  unblock_sender: address => [`Unblock ${address}`, ['Their new mail is no longer sent to Spam for being blocked.']],
  add_vip: address => [`Make ${address} a VIP`, ['Their mail is treated as important.']],
  remove_vip: address => [`Remove ${address} from VIPs`, []],
  trust_sender: address => [`Trust ${address}`, ['Their mail that passes authentication is never filed as spam.']],
  untrust_sender: address => [`Stop trusting ${address}`, ['Their mail is checked by the spam filter like anyone\'s.']],
};

export function senderWords(kind: SenderKind, address: string): [string, string[]] {
  return SENDER_WORDS[kind](address);
}

/** The flags each sender change sets. Block and VIP live on the sender's history record, so only a known sender has them. */
export function senderFlags(kind: SenderKind, known: boolean): SenderFlags {
  switch (kind) {
    // A trusted sender bypasses the filter, so blocking ends the trust.
    case 'block_sender': return { ...(known ? { blocked: true } : {}), spammer: true, trusted: false };
    case 'unblock_sender': return { ...(known ? { blocked: false } : {}), spammer: false };
    case 'add_vip': return { vip: true };
    case 'remove_vip': return { vip: false };
    case 'trust_sender': return { trusted: true, spammer: false, ...(known ? { blocked: false } : {}) };
    case 'untrust_sender': return { trusted: false };
  }
}

/** The flags a change would actually alter now; empty when the sender is already as asked. */
export function senderChanges(flags: SenderFlags, current: SenderSettings): SenderFlags {
  return Object.fromEntries(Object.entries(flags).filter(([flag, value]) => current[flag as SenderFlag] !== value)) as SenderFlags;
}

// ── Staging, applying, undoing.

export function stageSettingChange(input: {
  label: string;
  kind: InboxAgentSettingKind;
  accountId: string;
  accountEmail: string;
  summary: string;
  details: string[];
  plan: SettingPlan;
  linked?: HeldChangeSet[];
  /** How the card offers the existing mail, e.g. "Also apply it to the emails it matches now". */
  existingText?: string;
  nowMs: number;
}): HeldSettingChange {
  const linked = (input.linked ?? []).filter(held => held.set.items.length);
  const emails = new Set(linked.flatMap(held => held.set.items.map(item => item.emailId)));
  const guarded = new Set(linked.flatMap(held => held.set.items.filter(item => item.protectedReason).map(item => item.emailId)));
  const change: InboxAgentSettingChange = {
    id: randomUUID(), label: input.label, kind: input.kind, accountId: input.accountId, accountEmail: input.accountEmail,
    summary: input.summary, details: input.details, createdAt: input.nowMs,
    approveBy: input.nowMs + INBOX_AGENT_CHANGE_LIMITS.approveMs, undoBy: 0, status: 'pending',
    ...(emails.size && input.existingText ? { existing: { text: input.existingText, count: emails.size, protectedCount: guarded.size } } : {}),
  };
  return { change, plan: input.plan, linked: change.existing ? linked : [], busy: false };
}

function claim(held: HeldSettingChange): void {
  if (held.busy) throw new InboxAgentChangeError('This change is already being applied.');
  held.busy = true;
}

function ruleFields(rule: FilterRule): FilterRuleInput {
  return { name: rule.name, enabled: rule.enabled, priority: rule.priority, matchType: rule.matchType, conditions: rule.conditions, actions: rule.actions, stopProcessing: rule.stopProcessing };
}

async function currentFilter(settings: InboxAgentSettingActions, accountId: string, id: string): Promise<FilterRule | undefined> {
  return (await settings.listFilters(accountId)).find(rule => rule.id === id);
}

export interface SettingDecisionOptions {
  settings: InboxAgentSettingActions;
  mail: InboxAgentMailActions;
  readEmail: InboxAgentEmailReader;
  nowMs: number;
  signal?: AbortSignal;
}

/** The standing part of a change: the filter or the sender's flags. Throws if it could not be saved. */
async function applyPlan(held: HeldSettingChange, options: SettingDecisionOptions): Promise<void> {
  const { plan, change } = held;
  const { settings, mail } = options;
  if ('createsLabel' in plan && plan.createsLabel && !held.labelCreated) {
    held.labelCreated = await mail.createLabel(change.accountId, plan.createsLabel);
  }
  switch (plan.kind) {
    case 'create_filter':
      held.filterAfter = await settings.createFilter(change.accountId, plan.input);
      return;
    case 'update_filter': case 'delete_filter': {
      const before = await currentFilter(settings, change.accountId, plan.filterId);
      if (!before) throw new InboxAgentChangeError('This filter no longer exists.');
      // Edited since it was prepared: the change was written against a version that is gone.
      if (before.updatedAt !== plan.expectedUpdatedAt) throw new InboxAgentChangeError('This filter was changed after the change was prepared. Ask again to prepare it fresh.');
      held.filterBefore = before;
      if (plan.kind === 'delete_filter') { await settings.deleteFilter(change.accountId, plan.filterId); return; }
      const after = await settings.updateFilter(change.accountId, plan.filterId, plan.updates);
      if (!after) throw new InboxAgentChangeError('This filter no longer exists.');
      held.filterAfter = after;
      return;
    }
    default: {
      const current = await settings.sender(change.accountId, plan.address);
      held.senderBefore = Object.fromEntries(Object.keys(plan.flags).map(flag => [flag, current[flag as SenderFlag]])) as SenderFlags;
      await settings.setSender(change.accountId, plan.address, plan.flags);
    }
  }
}

/** Emails (each once, across the linked sets) whose row ended in one of these states. */
function emailsWhere(held: HeldSettingChange, test: (item: HeldChangeSet['set']['items'][number]) => boolean): number {
  return new Set(held.linked.flatMap(set => set.set.items.filter(test).map(item => item.emailId))).size;
}

function existingResult(held: HeldSettingChange): string {
  const changed = emailsWhere(held, item => item.status === 'applied' || item.status === 'queued');
  const failed = emailsWhere(held, item => item.status === 'failed');
  const stale = emailsWhere(held, item => item.status === 'skipped' && item.detail !== 'Not selected.');
  const guarded = held.change.existing?.protectedCount ?? 0;
  return [
    `${changed} ${changed === 1 ? 'email' : 'emails'} changed`,
    guarded ? `${guarded} protected left as ${guarded === 1 ? 'it is' : 'they are'}` : '',
    stale ? `${stale} skipped (changed meanwhile)` : '',
    failed ? `${failed} failed` : '',
  ].filter(Boolean).join(' · ');
}

function undoneResult(held: HeldSettingChange): string {
  const undone = emailsWhere(held, item => item.status === 'undone');
  const left = emailsWhere(held, item => item.status === 'applied' || item.status === 'queued');
  return [`${undone} ${undone === 1 ? 'email' : 'emails'} put back`, left ? `${left} left as ${left === 1 ? 'it is' : 'they are'} now (changed since, or could not be undone)` : ''].filter(Boolean).join(' · ');
}

/**
 * Approve: save the setting, then, if the user ticked it, act on the existing
 * mail (unprotected rows only). Approving again after that retries only the
 * existing mail that failed.
 */
export async function applySettingChange(held: HeldSettingChange, options: SettingDecisionOptions & { includeExisting?: boolean }): Promise<void> {
  const { change } = held;
  const retry = change.status === 'applied' && change.existingApplied && held.linked.some(set => set.set.items.some(item => item.status === 'failed'));
  if (change.status !== 'pending' && !retry) throw new InboxAgentChangeError(change.status === 'cancelled' ? 'This change was cancelled.' : 'This change was already applied.');
  if (options.nowMs > change.approveBy) {
    if (change.status === 'pending') change.status = 'expired';
    throw new InboxAgentChangeError('This change waited too long for approval. Ask again to prepare it fresh.');
  }
  claim(held);
  try {
    if (!retry) {
      try { await applyPlan(held, options); }
      catch (error) {
        // Not saved: the card stays open so the user can try again.
        change.detail = error instanceof InboxAgentChangeError ? error.message : 'Could not be saved. Approve again to retry.';
        return;
      }
      delete change.detail;
      change.status = 'applied';
      change.undoBy = options.nowMs + INBOX_AGENT_CHANGE_LIMITS.undoMs;
      if (!options.includeExisting || !held.linked.length) return;
      change.existingApplied = true;
    }
    for (const set of held.linked) {
      if (!['pending', 'partial'].includes(set.set.status)) continue;
      options.signal?.throwIfAborted();
      // Unprotected rows only, and only pending or failed ones: never twice.
      try { await applyChangeSet(set, { actions: options.mail, readEmail: options.readEmail, nowMs: options.nowMs, ...(options.signal ? { signal: options.signal } : {}) }); }
      catch { /* Its rows stay pending or failed, and are counted so. */ }
    }
    change.existing!.result = existingResult(held);
  } finally { held.busy = false; }
}

export function cancelSettingChange(held: HeldSettingChange): void {
  if (held.busy) throw new InboxAgentChangeError('This change is being applied.');
  if (held.change.status !== 'pending') throw new InboxAgentChangeError('This change can no longer be cancelled.');
  held.change.status = 'cancelled';
  delete held.change.detail;
}

/** Undo the standing part, if it is still as the change left it. Answers false when the user changed it since. */
async function undoPlan(held: HeldSettingChange, options: SettingDecisionOptions): Promise<boolean> {
  const { plan, change } = held;
  const { settings } = options;
  switch (plan.kind) {
    case 'create_filter': case 'update_filter': {
      const id = held.filterAfter!.id;
      const current = await currentFilter(settings, change.accountId, id);
      // Already gone (the user deleted the new filter): nothing left to undo.
      if (!current) return plan.kind === 'create_filter';
      if (current.updatedAt !== held.filterAfter!.updatedAt) return false;
      if (plan.kind === 'create_filter') await settings.deleteFilter(change.accountId, id);
      else await settings.updateFilter(change.accountId, id, ruleFields(held.filterBefore!));
      return true;
    }
    case 'delete_filter':
      // Back as it was, under a new id (the store assigns ids).
      await settings.createFilter(change.accountId, ruleFields(held.filterBefore!));
      return true;
    default: {
      const current = await settings.sender(change.accountId, plan.address);
      const back = Object.fromEntries(Object.entries(plan.flags)
        .filter(([flag, value]) => current[flag as SenderFlag] === value)
        .map(([flag]) => [flag, held.senderBefore![flag as SenderFlag]])) as SenderFlags;
      const changedSince = Object.keys(back).length < Object.keys(plan.flags).length;
      if (Object.keys(back).length) await settings.setSender(change.accountId, plan.address, back);
      return !changedSince;
    }
  }
}

/**
 * Undo: the existing mail first (each row only if still as the change left
 * it), then the setting, then a label the change created and nothing uses.
 */
export async function undoSettingChange(held: HeldSettingChange, options: SettingDecisionOptions): Promise<void> {
  const { change } = held;
  if (change.status !== 'applied') throw new InboxAgentChangeError('There is nothing to undo here.');
  if (options.nowMs > change.undoBy) throw new InboxAgentChangeError('This change can no longer be undone from here.');
  claim(held);
  try {
    for (const set of [...held.linked].reverse()) {
      if (!['applied', 'partial'].includes(set.set.status) || !set.set.items.some(item => item.status === 'applied' || item.status === 'queued')) continue;
      options.signal?.throwIfAborted();
      try { await undoChangeSet(set, { actions: options.mail, readEmail: options.readEmail, nowMs: options.nowMs, ...(options.signal ? { signal: options.signal } : {}) }); }
      catch { /* Rows not put back stay as they are, and are counted so. */ }
    }
    let whole: boolean;
    try { whole = await undoPlan(held, options); }
    catch {
      change.detail = 'Could not be undone. Try Undo again.';
      return;
    }
    if (held.labelCreated && 'createsLabel' in held.plan && held.plan.createsLabel) {
      try { await options.mail.dropLabel(change.accountId, held.plan.createsLabel); held.labelCreated = false; } catch { /* The label stays. */ }
    }
    if (change.existing && change.existingApplied) change.existing.result = undoneResult(held);
    change.status = 'undone';
    if (whole) delete change.detail;
    else change.detail = change.kind.endsWith('filter') ? 'The filter was edited since, so it was left as it is now.' : 'Some of it was changed since, so that part was left as it is now.';
  } finally { held.busy = false; }
}
