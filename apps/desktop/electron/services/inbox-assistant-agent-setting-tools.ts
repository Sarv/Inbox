import { addressTokens, classifyFolder, type EmailRecord, type FilterAction, type FilterCondition, type FilterRule, type FilterRuleInput, type FolderRecord } from '@sarvinbox/core';

import type { InboxAgentChangeAction, InboxAgentSettingKind } from '../../src/types/inbox-assistant-changes';

import {
  accountOf, InboxAgentToolError, oneLine, openAccount, optionalBoolean, optionalText, readArgs, roleFolders, selectedAccounts,
  type InboxAgentTool, type InboxAgentToolContext,
} from './inbox-assistant-agent-tools';
import { alreadyDone, destinationFolder, labelNameProblem } from './inbox-assistant-agent-write-tools';
import { changeProtection, INBOX_AGENT_CHANGE_LIMITS, stageChangeSet, type HeldChangeSet, type StageTarget } from './inbox-assistant-change-sets';
import { fullBody } from './inbox-assistant-retrieval';
import {
  describeFilter, INBOX_AGENT_SETTING_LIMITS, senderChanges, senderFlags, senderWords, stageSettingChange,
  type HeldSettingChange, type SenderKind, type SettingPlan,
} from './inbox-assistant-setting-changes';

/**
 * Tools for standing changes: filters and what the app does with a sender
 * (block, VIP, trust). They never change anything themselves. Each stages one
 * card (R1, R2…) that waits for the user's approval in every mode, because a
 * standing change keeps acting on mail nobody has seen yet. See
 * inbox-assistant-setting-changes.ts.
 */

const FIELDS: readonly FilterCondition['field'][] = ['from', 'to', 'cc', 'subject', 'body', 'domain'];
const OPERATORS: readonly FilterCondition['operator'][] = ['contains', 'notContains', 'equals', 'startsWith', 'endsWith'];
const ACTION_TYPES: readonly FilterAction['type'][] = ['markRead', 'star', 'archive', 'delete', 'moveToSpam', 'moveToFolder', 'applyLabel'];
/** At most one of these per filter: a message can only end up in one place. */
const PLACING = new Set<FilterAction['type']>(['archive', 'delete', 'moveToSpam', 'moveToFolder']);
/** Existing mail a filter or block never touches: the user's own mail, and mail already gone. */
const UNTOUCHED_ROLES = new Set(['sent', 'drafts', 'trash', 'spam', 'junk']);

const SENDER_ACTIONS: Record<string, SenderKind> = {
  block: 'block_sender', unblock: 'unblock_sender', vip: 'add_vip', unvip: 'remove_vip', trust: 'trust_sender', untrust: 'untrust_sender',
};

const CONDITION_SCHEMA = { type: 'object', additionalProperties: false, required: ['field', 'operator', 'value'], properties: {
  field: { type: 'string', enum: [...FIELDS] }, operator: { type: 'string', enum: [...OPERATORS] }, value: { type: 'string' },
} };
const ACTION_SCHEMA = { type: 'object', additionalProperties: false, required: ['type'], properties: {
  type: { type: 'string', enum: [...ACTION_TYPES], description: 'delete moves to Trash.' },
  value: { type: 'string', description: 'moveToFolder: a folder from list_folders. applyLabel: the label name (created if missing).' },
} };
const RULE_PROPERTIES = {
  name: { type: 'string', description: 'A short name the user will recognise.' },
  match: { type: 'string', enum: ['all', 'any'], description: 'all: every condition must match (default). any: one is enough.' },
  conditions: { type: 'array', items: CONDITION_SCHEMA, minItems: 1, maxItems: INBOX_AGENT_SETTING_LIMITS.conditions },
  actions: { type: 'array', items: ACTION_SCHEMA, minItems: 1, maxItems: INBOX_AGENT_SETTING_LIMITS.actions },
  stop_processing: { type: 'boolean', description: 'When it matches, no later filter runs. Default false.' },
};

interface FilterRef { accountId: string; rule: FilterRule }

function state(context: InboxAgentToolContext) {
  const changes = context.changes!;
  if (!changes.settings) throw new InboxAgentToolError('Settings cannot be changed from this chat.');
  return { changes, settings: changes.settings };
}

/** The one account a standing change is for: named, or the only one selected. */
function oneAccount(args: Record<string, unknown>, context: InboxAgentToolContext) {
  const accounts = selectedAccounts(args, context);
  if (accounts.length > 1) throw new InboxAgentToolError(`Say which account with "account": ${accounts.map(account => account.email).join(', ')}. A setting belongs to one account.`);
  return accounts[0]!;
}

function nextLabel(context: InboxAgentToolContext): string {
  const { changes } = state(context);
  if (changes.settingChanges.length >= INBOX_AGENT_SETTING_LIMITS.perRun) throw new InboxAgentToolError(`At most ${INBOX_AGENT_SETTING_LIMITS.perRun} setting changes per request.`);
  return `R${changes.labelOffset.settings + changes.settingChanges.length + 1}`;
}

function readConditions(value: unknown): FilterCondition[] {
  if (!Array.isArray(value) || !value.length || value.length > INBOX_AGENT_SETTING_LIMITS.conditions) throw new InboxAgentToolError(`"conditions" must list 1 to ${INBOX_AGENT_SETTING_LIMITS.conditions} conditions.`);
  return value.map(raw => {
    const item = raw as Record<string, unknown>;
    if (!item || typeof item !== 'object' || Object.keys(item).some(key => !['field', 'operator', 'value'].includes(key))) throw new InboxAgentToolError('Each condition is {field, operator, value}.');
    if (!FIELDS.includes(item.field as FilterCondition['field'])) throw new InboxAgentToolError(`A condition's "field" is one of ${FIELDS.join(', ')}.`);
    if (!OPERATORS.includes(item.operator as FilterCondition['operator'])) throw new InboxAgentToolError(`A condition's "operator" is one of ${OPERATORS.join(', ')}.`);
    const text = typeof item.value === 'string' ? item.value.trim() : '';
    if (!text || text.length > 200) throw new InboxAgentToolError('A condition needs a "value" of 1 to 200 characters.');
    return { field: item.field as FilterCondition['field'], operator: item.operator as FilterCondition['operator'], value: text };
  });
}

interface CheckedActions { actions: FilterAction[]; folders: Map<string, FolderRecord>; newLabel?: string }

async function readActions(value: unknown, folders: FolderRecord[], accountEmail: string, labels: string[]): Promise<CheckedActions> {
  if (!Array.isArray(value) || !value.length || value.length > INBOX_AGENT_SETTING_LIMITS.actions) throw new InboxAgentToolError(`"actions" must list 1 to ${INBOX_AGENT_SETTING_LIMITS.actions} actions.`);
  const checked: CheckedActions = { actions: [], folders: new Map() };
  for (const raw of value) {
    const item = raw as Record<string, unknown>;
    if (!item || typeof item !== 'object' || Object.keys(item).some(key => !['type', 'value'].includes(key))) throw new InboxAgentToolError('Each action is {type, value?}.');
    const type = item.type as FilterAction['type'];
    if (!ACTION_TYPES.includes(type)) throw new InboxAgentToolError(`An action's "type" is one of ${ACTION_TYPES.join(', ')}.`);
    if (checked.actions.some(action => action.type === type)) throw new InboxAgentToolError(`"${type}" is listed twice.`);
    if (PLACING.has(type) && checked.actions.some(action => PLACING.has(action.type))) throw new InboxAgentToolError('A filter can file mail in one place only: choose one of archive, delete, moveToSpam, moveToFolder.');
    const text = typeof item.value === 'string' ? item.value.trim() : '';
    if (type === 'moveToFolder') {
      if (!text) throw new InboxAgentToolError('moveToFolder needs "value": a folder from list_folders.');
      const folder = destinationFolder(text, folders, accountEmail);
      checked.folders.set(folder.path, folder);
      checked.actions.push({ type, value: folder.path });
    } else if (type === 'applyLabel') {
      if (!text) throw new InboxAgentToolError('applyLabel needs "value": the label name.');
      const known = labels.find(label => label.toLowerCase() === text.toLowerCase());
      if (!known) {
        const problem = labelNameProblem(text, folders);
        if (problem) throw new InboxAgentToolError(problem);
        checked.newLabel = text;
      }
      checked.actions.push({ type, value: known ?? text });
    } else {
      if (text) throw new InboxAgentToolError(`"${type}" takes no "value".`);
      checked.actions.push({ type });
    }
  }
  return checked;
}

/** The change-set action, and its destination, that does a filter action to existing mail. */
function mailActionFor(action: FilterAction, folders: FolderRecord[], checked: CheckedActions): { action: InboxAgentChangeAction; folder?: FolderRecord; labelName?: string } | undefined {
  switch (action.type) {
    case 'markRead': return { action: 'mark_read' };
    case 'star': return { action: 'star' };
    case 'archive': return { action: 'archive' };
    case 'delete': return { action: 'trash' };
    case 'applyLabel': return { action: 'add_label', labelName: action.value! };
    case 'moveToFolder': return { action: 'move', folder: checked.folders.get(action.value!)! };
    case 'moveToSpam': {
      const spam = roleFolders(folders, 'spam')[0];
      return spam ? { action: 'move', folder: spam } : undefined;
    }
  }
}

/**
 * Existing mail as linked change sets, one per action, frozen now like any
 * change set: the user's own and already-gone mail left out, protections
 * computed, and only what each action would change.
 */
async function linkedSets(
  context: InboxAgentToolContext, account: { id: string; email: string }, ids: string[],
  steps: Array<{ action: InboxAgentChangeAction; folder?: FolderRecord; labelName?: string }>, label: string,
): Promise<{ sets: HeldChangeSet[]; truncated: boolean }> {
  const opened = (await openAccount(context, accountOf(context, account.id)))!;
  const emails: EmailRecord[] = [];
  let truncated = false;
  for (const id of ids) {
    context.signal.throwIfAborted();
    const email = await opened.mailbox.storage.getEmail(id);
    if (!email) continue;
    const folder = opened.folders.find(item => item.id === email.folderId);
    if (folder && UNTOUCHED_ROLES.has(classifyFolder(folder) ?? '')) continue;
    if (emails.length >= INBOX_AGENT_CHANGE_LIMITS.perSet) { truncated = true; break; }
    emails.push(email);
  }
  const nowMs = context.changes!.nowMs();
  const sets = steps.map((step, index) => {
    const targets: StageTarget[] = [];
    for (const email of emails) {
      if (alreadyDone(step.action, email, opened.folders, { ...(step.folder ? { destination: step.folder } : {}), ...(step.labelName ? { labelName: step.labelName } : {}) })) continue;
      const protectedReason = changeProtection(step.action, email, fullBody(email));
      targets.push({ accountId: account.id, accountEmail: account.email, email, folders: opened.folders, ...(protectedReason ? { protectedReason } : {}) });
    }
    return stageChangeSet({ label: `${label}-${index + 1}`, action: step.action, targets, nowMs,
      ...(step.folder ? { folder: step.folder } : {}), ...(step.labelName ? { labelName: step.labelName } : {}) });
  });
  return { sets, truncated };
}

function stage(context: InboxAgentToolContext, input: Parameters<typeof stageSettingChange>[0]): HeldSettingChange {
  const held = stageSettingChange(input);
  context.changes!.settingChanges.push(held);
  context.progress({ stage: 'action', status: 'done', message: `Prepared: ${held.change.summary}`, detail: 'Waiting for your approval below the answer.' });
  return held;
}

function staged(held: HeldSettingChange, notes: string[] = []): string {
  const { change } = held;
  return [
    `Setting change ${change.label}: ${change.summary}.`,
    ...change.details,
    'NOT applied: a setting change always waits for the user to approve it on a card below your answer. Do not say it is done; say what you prepared.',
    ...(change.existing ? [`It applies to ${change.existing.count} existing ${change.existing.count === 1 ? 'email' : 'emails'} too only if the user ticks that on the card (unticked by default)${change.existing.protectedCount ? `; ${change.existing.protectedCount} of them are protected and stay as they are` : ''}.`] : []),
    ...notes,
  ].join('\n');
}

async function accountLabels(context: InboxAgentToolContext, accountId: string): Promise<string[]> {
  const opened = await openAccount(context, accountOf(context, accountId));
  const storage = opened?.mailbox.storage as { getLabels?: () => Promise<Array<{ name: string }>> } | undefined;
  try { return (await storage?.getLabels?.() ?? []).map(label => label.name); }
  catch { throw new InboxAgentToolError('The labels of this account could not be read, so nothing was prepared.'); }
}

const listFilters: InboxAgentTool = {
  activity: 'Reading filters',
  definition: {
    name: 'list_filters',
    description: 'The filters (rules for incoming mail) in each selected account, with ids (F1…) for update_filter and delete_filter.',
    parameters: { type: 'object', additionalProperties: false, properties: { account: { type: 'string', description: 'Limit to one selected account (its email).' } } },
  },
  async run(raw, context) {
    const { settings } = state(context);
    const args = readArgs(raw, ['account']);
    const refs = context.filterRefs ??= new Map<string, FilterRef>();
    const lines: string[] = [];
    for (const account of selectedAccounts(args, context)) {
      let rules: FilterRule[];
      try { rules = await settings.listFilters(account.id); }
      catch { lines.push(`${account.email}: filters could not be read.`); continue; }
      lines.push(`${account.email}: ${rules.length ? `${rules.length} ${rules.length === 1 ? 'filter' : 'filters'}` : 'no filters'}`);
      for (const rule of rules.slice(0, 100)) {
        const known = [...refs].find(([, ref]) => ref.accountId === account.id && ref.rule.id === rule.id)?.[0];
        const id = known ?? `F${refs.size + 1}`;
        refs.set(id, { accountId: account.id, rule });
        lines.push(`  ${id} | "${oneLine(rule.name, 80)}"${rule.enabled ? '' : ' (off)'} | ${describeFilter(rule).slice(0, 2).join(' | ')}`);
      }
    }
    return lines.join('\n');
  },
};

/** Stage the filter's existing-mail sets and say what they cover. */
async function filterExisting(context: InboxAgentToolContext, account: { id: string; email: string }, rule: Pick<FilterRuleInput, 'matchType' | 'conditions' | 'actions'>, checked: CheckedActions, label: string) {
  const { settings } = state(context);
  const opened = (await openAccount(context, accountOf(context, account.id)))!;
  let ids: string[];
  try { ids = await settings.matchFilter(account.id, { matchType: rule.matchType ?? 'all', conditions: rule.conditions }); }
  catch { throw new InboxAgentToolError(`The mail of ${account.email} could not be checked against the filter, so nothing was prepared.`); }
  const steps = rule.actions.map(action => mailActionFor(action, opened.folders, checked)).filter(step => !!step);
  const { sets, truncated } = await linkedSets(context, account, ids, steps, label);
  return { sets, text: `Also apply it to the emails it matches now${truncated ? ` (the newest ${INBOX_AGENT_CHANGE_LIMITS.perSet})` : ''}` };
}

const createFilter: InboxAgentTool = {
  activity: 'Preparing a filter',
  definition: {
    name: 'create_filter',
    description: 'Prepare a new filter: a rule the app runs on every new email. It waits for the user\'s approval on a card, which also offers (unticked) to apply it to the mail it matches now.',
    parameters: { type: 'object', additionalProperties: false, required: ['name', 'conditions', 'actions'], properties: {
      account: { type: 'string', description: 'The account it is for (its email). Needed when several are selected.' }, ...RULE_PROPERTIES,
    } },
  },
  async run(raw, context) {
    const args = readArgs(raw, ['account', 'name', 'match', 'conditions', 'actions', 'stop_processing']);
    const account = oneAccount(args, context);
    const label = nextLabel(context);
    const name = optionalText(args, 'name', 80)?.trim();
    if (!name) throw new InboxAgentToolError('"name" is required.');
    const match = optionalText(args, 'match', 10) ?? 'all';
    if (match !== 'all' && match !== 'any') throw new InboxAgentToolError('"match" is all or any.');
    const conditions = readConditions(args.conditions);
    const opened = await openAccount(context, account);
    if (!opened) throw new InboxAgentToolError(`${account.email} could not be opened, so nothing was prepared.`);
    const checked = await readActions(args.actions, opened.folders, account.email, await accountLabels(context, account.id));
    const input: FilterRuleInput = { name, enabled: true, matchType: match, conditions, actions: checked.actions, stopProcessing: optionalBoolean(args, 'stop_processing') ?? false };
    const existing = await filterExisting(context, account, input, checked, label);
    const held = stage(context, {
      label, kind: 'create_filter', accountId: account.id, accountEmail: account.email, summary: `Create filter "${name}"`,
      details: [...describeFilter(input), ...(checked.newLabel ? [`Creates the label "${checked.newLabel}".`] : [])],
      plan: { kind: 'create_filter', input, ...(checked.newLabel ? { createsLabel: checked.newLabel } : {}) },
      linked: existing.sets, existingText: existing.text, nowMs: context.changes!.nowMs(),
    });
    return staged(held);
  },
};

function filterRef(args: Record<string, unknown>, context: InboxAgentToolContext): FilterRef {
  const id = optionalText(args, 'filter', 8)?.toUpperCase();
  const ref = id ? context.filterRefs?.get(id) : undefined;
  if (!ref) throw new InboxAgentToolError(`${id ?? 'That'} is not a filter id from list_filters in this conversation. Call list_filters first.`);
  accountOf(context, ref.accountId);
  return ref;
}

const updateFilter: InboxAgentTool = {
  activity: 'Preparing a filter change',
  definition: {
    name: 'update_filter',
    description: 'Prepare a change to a filter from list_filters: rename it, turn it on or off, or replace its conditions or actions (give the whole new list). Waits for the user\'s approval.',
    parameters: { type: 'object', additionalProperties: false, required: ['filter'], properties: {
      filter: { type: 'string', description: 'F… from list_filters.' }, ...RULE_PROPERTIES, enabled: { type: 'boolean' },
    } },
  },
  async run(raw, context) {
    const args = readArgs(raw, ['filter', 'name', 'match', 'conditions', 'actions', 'stop_processing', 'enabled']);
    const ref = filterRef(args, context);
    const account = accountOf(context, ref.accountId);
    const label = nextLabel(context);
    const updates: Partial<FilterRuleInput> = {};
    const name = optionalText(args, 'name', 80)?.trim();
    if (name) updates.name = name;
    const match = optionalText(args, 'match', 10);
    if (match !== undefined) {
      if (match !== 'all' && match !== 'any') throw new InboxAgentToolError('"match" is all or any.');
      updates.matchType = match;
    }
    if (args.conditions !== undefined) updates.conditions = readConditions(args.conditions);
    const opened = await openAccount(context, account);
    if (!opened) throw new InboxAgentToolError(`${account.email} could not be opened, so nothing was prepared.`);
    let checked: CheckedActions = { actions: ref.rule.actions, folders: new Map() };
    if (args.actions !== undefined) {
      checked = await readActions(args.actions, opened.folders, account.email, await accountLabels(context, account.id));
      updates.actions = checked.actions;
    }
    const stop = optionalBoolean(args, 'stop_processing');
    if (stop !== undefined) updates.stopProcessing = stop;
    const enabled = optionalBoolean(args, 'enabled');
    if (enabled !== undefined) updates.enabled = enabled;
    if (!Object.keys(updates).length) throw new InboxAgentToolError('Say what to change: name, match, conditions, actions, stop_processing or enabled.');
    const merged = { ...ref.rule, ...updates };
    // New conditions or actions on a filter that is on can act on mail it matches now.
    const offer = merged.enabled && (updates.conditions || updates.actions || updates.matchType || updates.enabled);
    if (offer) for (const action of merged.actions) if (action.type === 'moveToFolder' && !checked.folders.has(action.value!)) checked.folders.set(action.value!, destinationFolder(action.value!, opened.folders, account.email));
    const existing = offer ? await filterExisting(context, account, merged, checked, label) : undefined;
    const held = stage(context, {
      label, kind: 'update_filter', accountId: account.id, accountEmail: account.email, summary: `Change filter "${ref.rule.name}"`,
      details: [...(updates.name ? [`Renamed to "${updates.name}"`] : []), ...describeFilter(merged), `Was: ${describeFilter(ref.rule).join('; ')}`,
        ...(checked.newLabel ? [`Creates the label "${checked.newLabel}".`] : [])],
      plan: { kind: 'update_filter', filterId: ref.rule.id, updates, expectedUpdatedAt: ref.rule.updatedAt, ...(checked.newLabel ? { createsLabel: checked.newLabel } : {}) },
      ...(existing ? { linked: existing.sets, existingText: existing.text } : {}), nowMs: context.changes!.nowMs(),
    });
    return staged(held);
  },
};

const deleteFilter: InboxAgentTool = {
  activity: 'Preparing to delete a filter',
  definition: {
    name: 'delete_filter',
    description: 'Prepare deleting a filter from list_filters. Mail it already filed stays where it is. Waits for the user\'s approval.',
    parameters: { type: 'object', additionalProperties: false, required: ['filter'], properties: { filter: { type: 'string', description: 'F… from list_filters.' } } },
  },
  async run(raw, context) {
    const args = readArgs(raw, ['filter']);
    const ref = filterRef(args, context);
    const account = accountOf(context, ref.accountId);
    const held = stage(context, {
      label: nextLabel(context), kind: 'delete_filter', accountId: account.id, accountEmail: account.email, summary: `Delete filter "${ref.rule.name}"`,
      details: [...describeFilter(ref.rule), 'Mail it already filed stays where it is.'],
      plan: { kind: 'delete_filter', filterId: ref.rule.id, expectedUpdatedAt: ref.rule.updatedAt }, nowMs: context.changes!.nowMs(),
    });
    return staged(held);
  },
};

/**
 * A sender address the agent may act on: one the user wrote in the request,
 * or the sender of an email a tool showed in this run. An address that only
 * appears inside an email's text cannot be blocked, trusted or made a VIP.
 */
function knownAddress(raw: string, context: InboxAgentToolContext): string {
  const address = raw.trim().toLowerCase();
  if (addressTokens(address).length !== 1 || addressTokens(address)[0] !== address) throw new InboxAgentToolError('"address" must be one email address, such as news@shop.example.');
  const fromUser = addressTokens(context.question.toLowerCase()).includes(address);
  const fromShown = context.registry.evidence().some(source => source.kind === 'message' && addressTokens(source.from.toLowerCase()).includes(address));
  if (!fromUser && !fromShown) throw new InboxAgentToolError(`${address} is not the sender of an email shown in this conversation, nor in the user's request. Search for their mail first.`);
  return address;
}

const changeSender: InboxAgentTool = {
  activity: 'Preparing a sender change',
  definition: {
    name: 'change_sender',
    description: 'Prepare a change to how the app treats a sender: block (their new mail goes to Spam), unblock, vip / unvip, trust (never filed as spam) / untrust. The address must be the sender of an email from results, or one the user wrote. Waits for the user\'s approval; a block also offers (unticked) to move their existing mail to Spam.',
    parameters: { type: 'object', additionalProperties: false, required: ['address', 'action'], properties: {
      address: { type: 'string' }, action: { type: 'string', enum: Object.keys(SENDER_ACTIONS) },
      account: { type: 'string', description: 'The account it is for (its email). Needed when several are selected.' },
    } },
  },
  async run(raw, context) {
    const { settings } = state(context);
    const args = readArgs(raw, ['address', 'action', 'account']);
    const kind = SENDER_ACTIONS[optionalText(args, 'action', 10) ?? ''];
    if (!kind) throw new InboxAgentToolError(`"action" is one of ${Object.keys(SENDER_ACTIONS).join(', ')}.`);
    const address = knownAddress(optionalText(args, 'address', 320) ?? '', context);
    const account = oneAccount(args, context);
    let current;
    try { current = await settings.sender(account.id, address); }
    catch { throw new InboxAgentToolError(`What ${account.email} knows about ${address} could not be read, so nothing was prepared.`); }
    if ((kind === 'add_vip' || kind === 'remove_vip') && !current.known) throw new InboxAgentToolError(`${account.email} has no mail history with ${address}, so it cannot be a VIP there.`);
    const flags = senderChanges(senderFlags(kind, current.known), current);
    if (!Object.keys(flags).length) return `${address} is already as asked in ${account.email}. Nothing to change.`;
    const label = nextLabel(context);
    let linked: HeldChangeSet[] = [];
    let existingText: string | undefined;
    if (kind === 'block_sender') {
      const opened = (await openAccount(context, account))!;
      const spam = roleFolders(opened.folders, 'spam')[0];
      if (spam) {
        let ids: string[];
        try { ids = await settings.senderEmails(account.id, address); }
        catch { throw new InboxAgentToolError(`The mail of ${account.email} could not be read, so nothing was prepared.`); }
        const result = await linkedSets(context, account, ids, [{ action: 'move', folder: spam }], label);
        linked = result.sets;
        existingText = `Also move their emails here to Spam${result.truncated ? ` (the newest ${INBOX_AGENT_CHANGE_LIMITS.perSet})` : ''}`;
      }
    }
    const [summary, details] = senderWords(kind, address);
    const plan: SettingPlan = { kind, address, flags };
    const held = stage(context, { label, kind: kind as InboxAgentSettingKind, accountId: account.id, accountEmail: account.email, summary, details,
      plan, linked, ...(existingText ? { existingText } : {}), nowMs: context.changes!.nowMs() });
    return staged(held);
  },
};

const senderProfile: InboxAgentTool = {
  activity: 'Looking up a sender',
  definition: {
    name: 'sender_profile',
    description: 'What the app knows about a sender in each selected account: how much mail they sent, how much was read and replied to, when they last wrote, and whether they are blocked, a VIP, trusted or on the spam list.',
    parameters: { type: 'object', additionalProperties: false, required: ['address'], properties: {
      address: { type: 'string' }, account: { type: 'string', description: 'Limit to one selected account (its email).' },
    } },
  },
  async run(raw, context) {
    const { settings } = state(context);
    const args = readArgs(raw, ['address', 'account']);
    const address = (optionalText(args, 'address', 320) ?? '').trim().toLowerCase();
    if (addressTokens(address)[0] !== address) throw new InboxAgentToolError('"address" must be one email address.');
    const lines: string[] = [];
    for (const account of selectedAccounts(args, context)) {
      let sender;
      try { sender = await settings.sender(account.id, address); }
      catch { lines.push(`${account.email}: could not be read.`); continue; }
      const flags = [sender.blocked ? 'blocked' : '', sender.vip ? 'VIP' : '', sender.trusted ? 'trusted' : '', sender.spammer ? 'on the spam list (new mail goes to Spam)' : ''].filter(Boolean);
      const last = sender.lastReceived ? new Intl.DateTimeFormat('en-CA', { timeZone: context.timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(sender.lastReceived * 1000) : undefined;
      lines.push(sender.known
        ? `${account.email}: ${sender.received ?? 0} received, ${sender.read ?? 0} read, ${sender.replied ?? 0} replied to${last ? `, last on ${last}` : ''}. ${flags.length ? flags.join(', ') : 'No special treatment'}.`
        : `${account.email}: no mail history with ${address}.${flags.length ? ` ${flags.join(', ')}.` : ''}`);
    }
    return lines.join('\n');
  },
};

export const INBOX_AGENT_SETTING_TOOLS: readonly InboxAgentTool[] = [listFilters, createFilter, updateFilter, deleteFilter, changeSender, senderProfile];
