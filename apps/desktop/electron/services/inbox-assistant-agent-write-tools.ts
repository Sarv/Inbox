import { TZDate } from '@date-fns/tz';
import {
  classifyFolder, conversationFoldersOf, FLAG_TAG_NAMES, hasTag, isDraftRow, isExcludedFolderCopy, isInboxFolder, isSentCopy, isTrashFolder,
  type EmailRecord, type FolderRecord,
} from '@sarvinbox/core';

import type { InboxAgentChangeAction } from '../../src/types/inbox-assistant-changes';

import {
  accountOf, InboxAgentToolError, oneLine, openAccount, optionalBoolean, optionalText, readArgs, roleFolders,
  type InboxAgentChangeContext, type InboxAgentTool, type InboxAgentToolContext,
} from './inbox-assistant-agent-tools';
import {
  agentUndoWait, autoApplyWait, changeCounts, createConversationGuard, emailProtection, hidesMail, INBOX_AGENT_CHANGE_LIMITS, isChanged, LOWERING_ACTIONS, stageChangeSet,
  type AgentUndoWait, type AutoApplyWait, type ConversationGuard, type HeldChangeSet, type InboxAgentSpamRevert, type StageTarget,
} from './inbox-assistant-change-sets';
import { fullBody, type AssistantResearchMailbox } from './inbox-assistant-retrieval';

/**
 * The tools that change mail. They never change it themselves: they turn the
 * model's request into a change set over messages it was SHOWN in this run
 * (provenance), and the host applies the set on the user's approval or, under
 * "Approve for me", within a cap (inbox-assistant-change-sets.ts).
 *
 * An id the model makes up, or copies out of an email's text, is not in the
 * run's registry and is refused. So mail content can at most make the model
 * ask for something; it can never widen which messages can be touched.
 */

const ACTIONS: readonly InboxAgentChangeAction[] = [
  'mark_read', 'mark_unread', 'star', 'unstar', 'archive', 'trash', 'restore', 'move', 'add_category', 'remove_category',
  'add_label', 'remove_label', 'snooze', 'unsnooze', 'spam', 'not_spam',
];
/** Tags the app itself uses: a label of that name would read as the flag or folder. */
const RESERVED_LABELS = new Set<string>([...FLAG_TAG_NAMES, 'important', 'spam', 'snoozed', 'was_snoozed', 'unread', 'inbox', 'sent', 'trash', 'archive', 'drafts', 'junk']);
/** Snoozing further ahead than this is not snoozing. */
const MAX_SNOOZE_MS = 366 * 24 * 60 * 60_000;
/** A plain move may not stand in for these: Trash has its own action, and Spam, Drafts and Sent are not places to file mail. */
const NOT_MOVE_DESTINATIONS = new Set(['trash', 'junk', 'spam', 'drafts', 'sent']);
const MAX_IDS = 500;

interface Selected {
  accountId: string;
  emailId: string;
  reason?: string;
}

/** The messages a call names: S ids it was shown, and/or one classification's labels. */
function selection(args: Record<string, unknown>, context: InboxAgentToolContext): Selected[] {
  const picked = new Map<string, Selected>();
  const add = (accountId: string, emailId: string, reason?: string) => {
    const key = `${accountId}\0${emailId}`;
    const existing = picked.get(key);
    // Named twice (by id and by label): one row, keeping the classifier's reason.
    if (existing) { if (reason) existing.reason ??= reason; return; }
    picked.set(key, { accountId, emailId, ...(reason ? { reason } : {}) });
  };
  if (args.ids !== undefined) {
    if (!Array.isArray(args.ids) || args.ids.some(id => typeof id !== 'string')) throw new InboxAgentToolError('"ids" must list email ids such as S3.');
    if (args.ids.length > MAX_IDS) throw new InboxAgentToolError(`At most ${MAX_IDS} ids per call. Use from_result for a classified group.`);
    const unknown: string[] = [];
    for (const raw of args.ids as string[]) {
      const id = raw.trim();
      const source = context.registry.get(id);
      if (!source || source.kind !== 'message') { unknown.push(id.slice(0, 12)); continue; }
      add(source.accountId, source.emailId);
    }
    // Ids come only from what a tool showed in this run. One the model was not
    // shown (made up, or read in an email's text) is refused as a whole call,
    // so a partial set is never applied by accident.
    if (unknown.length) throw new InboxAgentToolError(`Not email ids from this conversation's results: ${unknown.slice(0, 10).join(', ')}. Use ids that search_mail, read_thread or deep_search returned.`);
  }
  const fromResult = optionalText(args, 'from_result', 12);
  if (fromResult) {
    const verdicts = context.verdicts?.get(fromResult);
    if (!verdicts) throw new InboxAgentToolError(`${fromResult} is not a classify_messages result from this conversation.`);
    const labels = args.labels;
    if (!Array.isArray(labels) || !labels.length || labels.some(label => typeof label !== 'string')) throw new InboxAgentToolError('"labels" must list the classification labels to change, such as ["not_business"].');
    const wanted = new Set(labels as string[]);
    if (wanted.has('unsure')) throw new InboxAgentToolError('Emails labelled "unsure" are left as they are. Choose a definite label.');
    let matched = 0;
    for (const [id, verdict] of verdicts) {
      if (!wanted.has(verdict.label)) continue;
      const source = context.registry.get(id)!;
      add(source.accountId, source.emailId, verdict.reason);
      matched++;
    }
    if (!matched) throw new InboxAgentToolError(`${fromResult} has no emails labelled ${[...wanted].join(', ')}.`);
  } else if (args.labels !== undefined) {
    throw new InboxAgentToolError('"labels" goes with "from_result".');
  }
  if (args.ids === undefined && !fromResult) throw new InboxAgentToolError('Say which emails: "ids" from results, or "from_result" with "labels".');
  return [...picked.values()];
}

export interface Wanted { destination?: FolderRecord; category?: string; labelName?: string; until?: number }

/** Why a message is left out of this action because it is already as asked, or undefined. */
export function alreadyDone(action: InboxAgentChangeAction, email: EmailRecord, folders: FolderRecord[], wanted: Wanted): string | undefined {
  const { destination, category } = wanted;
  const tags = email.tags || '||';
  const primary = folders.find(folder => folder.id === email.folderId);
  const inInbox = folders.some(folder => isInboxFolder(folder) && (folder.id === email.folderId || hasTag(tags, folder.path)));
  const inTrash = !!primary && isTrashFolder(primary);
  const inSpam = !!primary && classifyFolder(primary) === 'spam';
  switch (action) {
    case 'add_label': return hasTag(tags, wanted.labelName!) ? 'already has that label' : undefined;
    case 'remove_label': return hasTag(tags, wanted.labelName!) ? undefined : 'does not have that label';
    case 'snooze': return hasTag(tags, 'snoozed') && email.snoozeUntil === wanted.until ? 'already snoozed until then' : undefined;
    case 'unsnooze': return hasTag(tags, 'snoozed') ? undefined : 'not snoozed';
    case 'spam': return inSpam && hasTag(tags, 'spam') ? 'already in Spam' : undefined;
    case 'not_spam': return inSpam || hasTag(tags, 'spam') ? undefined : 'not marked as spam';
    case 'mark_read': return hasTag(tags, 'read') ? 'already read' : undefined;
    case 'mark_unread': return hasTag(tags, 'read') ? undefined : 'already unread';
    case 'star': return hasTag(tags, 'starred') ? 'already starred' : undefined;
    case 'unstar': return hasTag(tags, 'starred') ? undefined : 'not starred';
    case 'add_category': return hasTag(tags, category!) ? 'already in that category' : undefined;
    case 'remove_category': return hasTag(tags, category!) ? undefined : 'not in that category';
    case 'archive': return inInbox ? undefined : 'not in the Inbox';
    case 'trash': return inTrash ? 'already in Trash' : undefined;
    case 'restore': return inTrash ? undefined : 'not in Trash';
    case 'move': return email.folderId === destination!.id || hasTag(tags, destination!.path) ? 'already in that folder' : undefined;
  }
}

export function destinationFolder(name: string, folders: FolderRecord[], accountEmail: string): FolderRecord {
  const role = name.toLowerCase();
  const matches = roleFolders(folders, role);
  const folder = matches[0];
  if (!folder) throw new InboxAgentToolError(`No folder named "${name.slice(0, 80)}" in ${accountEmail}. Use list_folders.`);
  if (NOT_MOVE_DESTINATIONS.has(classifyFolder(folder) ?? '') || NOT_MOVE_DESTINATIONS.has(role)) {
    throw new InboxAgentToolError(role === 'trash' ? 'Use action "trash" to move mail to Trash.' : `Mail cannot be moved to ${folder.path} from here.`);
  }
  return folder;
}

/**
 * A snooze time as the model gives it: local wall time in the user's time zone
 * ("2026-11-21T09:00"), read in that zone (so a date across a daylight-saving
 * change still means 9:00 there), checked to exist and to lie ahead.
 */
export function parseSnoozeUntil(value: string, timeZone: string, nowMs: number): { until: number; text: string } {
  const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})$/.exec(value.trim());
  if (!match) throw new InboxAgentToolError('"until" must be a local date and time such as 2026-11-21T09:00, in the user\'s time zone.');
  const [year, month, day, hour, minute] = match.slice(1).map(Number);
  const date = new TZDate(year, month - 1, day, hour, minute, timeZone);
  // A day or hour that does not exist (31 November, a skipped daylight-saving hour) comes back shifted.
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day || date.getHours() !== hour || date.getMinutes() !== minute) {
    throw new InboxAgentToolError(`${value.trim()} is not a time that exists in ${timeZone}.`);
  }
  const ms = date.getTime();
  if (ms <= nowMs + 60_000) throw new InboxAgentToolError('"until" must be in the future.');
  if (ms > nowMs + MAX_SNOOZE_MS) throw new InboxAgentToolError('Snooze for at most a year.');
  const text = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }).format(ms);
  return { until: Math.floor(ms / 1000), text };
}

/**
 * Why a NEW label cannot have this name, or undefined: it would read as one of
 * the app's own tags, a folder, or a category (labels are tags).
 */
export function labelNameProblem(name: string, folders: FolderRecord[], categories: string[] = []): string | undefined {
  const lower = name.toLowerCase();
  if (name.includes('|') || RESERVED_LABELS.has(lower)) return `"${name}" cannot be a label name. Choose another name.`;
  if (folders.some(folder => folder.path.toLowerCase() === lower || folder.name.toLowerCase() === lower) || categories.some(slug => slug.toLowerCase() === lower)) {
    return `"${name}" is already a folder or category. Choose another label name.`;
  }
  return undefined;
}

/** The label a call names, as the account knows it (its own spelling), or null when it does not exist there yet. */
async function existingLabel(storage: unknown, name: string): Promise<string | null> {
  const labels = await (storage as { getLabels?: () => Promise<Array<{ name: string }>> }).getLabels?.() ?? [];
  return labels.find(label => label.name.toLowerCase() === name.toLowerCase())?.name ?? null;
}

/** The sender's spammer and trusted listing, so a spam verdict's Undo can put them back. */
async function senderLists(storage: unknown, address: string): Promise<InboxAgentSpamRevert['sender']> {
  const lists = storage as { isSpammer?: (email: string) => Promise<boolean>; isTrustedSender?: (email: string) => Promise<boolean> };
  return { address, spammer: !!await lists.isSpammer?.(address), trusted: !!await lists.isTrustedSender?.(address) };
}

/**
 * The review's sender and conversation protections, one guard per account,
 * each caching its lookups for as long as the returned function is kept (one
 * tool call). The user's own addresses: every selected account's, plus that
 * mailbox's aliases. change_mail and a filter's or block's existing mail use
 * the same guards.
 */
export function conversationGuardsFor(context: InboxAgentToolContext): (account: { id: string }, opened: { mailbox: AssistantResearchMailbox }) => ConversationGuard {
  const guards = new Map<string, ConversationGuard>();
  return (account, opened) => {
    let guard = guards.get(account.id);
    if (!guard) {
      guard = createConversationGuard({ storage: opened.mailbox.storage, nowMs: context.changes!.nowMs(),
        ownAddresses: [...context.accounts.map(item => item.email), ...opened.mailbox.aliases] });
      guards.set(account.id, guard);
    }
    return guard;
  };
}

/** Recorded for a message whose state before this request changed it could not be read: it protects, as a failed lookup does. */
const UNCHECKED_AT_START = 'Its state before this request could not be checked';

/** Each run's index of the protection earlier requests in its chat lowered, built on first use. */
const loweredIndex = new WeakMap<NonNullable<InboxAgentToolContext['changes']>, Map<string, { held: HeldChangeSet; lowered: string; itemId: string }>>();

/**
 * The protection an EARLIER request in this chat lowered on this message
 * without a card (an unstar or a category removal the agent applied itself
 * under "Approve for me"), while that change stands: its row is still changed,
 * its Undo window is open, and the user has not approved it on its card. So
 * "unstar these" in one request does not open the mail to an archive in the
 * next. A change the user decided, undid or let expire carries nothing.
 */
function loweredEarlier(context: InboxAgentToolContext, accountId: string, emailId: string): string | undefined {
  const state = context.changes!;
  let index = loweredIndex.get(state);
  if (!index) {
    index = new Map();
    for (const held of state.earlier.sets) {
      if (!held.set.autoApplied || !LOWERING_ACTIONS.has(held.set.action)) continue;
      for (const entry of held.items.values()) {
        if (entry.lowered) index.set(`${entry.item.accountId}\0${entry.item.emailId}`, { held, lowered: entry.lowered, itemId: entry.item.id });
      }
    }
    loweredIndex.set(state, index);
  }
  const found = index.get(`${accountId}\0${emailId}`);
  if (!found || found.held.userApproved || state.nowMs() > found.held.set.undoBy) return undefined;
  const entry = found.held.items.get(found.itemId);
  return entry && isChanged(entry.item) ? `${found.lowered} before an earlier request in this chat changed it` : undefined;
}

/**
 * Why a message must stay unticked in a set being staged, or undefined: its
 * protection now, else its protection at this request's first look at it (so
 * an unstar or a category removal earlier in the request lowers nothing),
 * else the protection an earlier request's own unstar or category removal
 * lowered (loweredEarlier), else the sender and conversation guard. Only
 * actions that hide mail are protected, but every action records the first
 * look, which always comes before any set of this request changes the
 * message (undo_change records its rows itself before it changes them).
 */
export async function stagedProtection(
  context: InboxAgentToolContext, accountId: string, action: InboxAgentChangeAction, email: EmailRecord, guard: ConversationGuard, body = fullBody(email),
): Promise<string | undefined> {
  const { atStart } = context.changes!;
  const key = `${accountId}\0${email.id}`;
  const now = emailProtection(email, body);
  if (!atStart.has(key)) atStart.set(key, now ?? null);
  if (!hidesMail(action)) return undefined;
  const start = atStart.get(key);
  const before = !start ? undefined : start === UNCHECKED_AT_START ? start : `${start} before this request changed it`;
  return now ?? before ?? loweredEarlier(context, accountId, email.id) ?? await guard(action, email);
}

/**
 * Record, before an undo changes them, the protection of the messages it is
 * about to change, unless this request already looked at them. The agent
 * undoes only mail of the accounts this request selected (agentUndoWait); mail
 * that is gone is skipped. A read that fails protects that row only: the
 * mailbox is opened here directly, never through the run's cache, so a blip
 * in this best-effort check does not mark the account unavailable for the rest
 * of the request.
 */
async function rememberAtStart(context: InboxAgentToolContext, rows: Array<{ accountId: string; emailId: string }>): Promise<void> {
  const { atStart } = context.changes!;
  for (const row of rows) {
    const key = `${row.accountId}\0${row.emailId}`;
    if (atStart.has(key)) continue;
    try {
      const mailbox = await context.deps.openMailbox(row.accountId);
      const email = await mailbox.storage.getEmail(row.emailId);
      if (email) atStart.set(key, emailProtection(email, fullBody(email)) ?? null);
    } catch {
      atStart.set(key, UNCHECKED_AT_START);
    }
  }
}

/**
 * The other messages of a conversation that include_conversation adds: never
 * a draft (the core conversation predicate), never a copy already in Trash or
 * Spam for an action that hides mail, and, for a move or a spam report, never
 * the user's own sent copy (it stays in Sent, as the filter and block paths
 * leave it). Trash still takes sent copies, as the app's Delete conversation does.
 */
function conversationAdditions(action: InboxAgentChangeAction, named: EmailRecord, rows: EmailRecord[], folders: FolderRecord[]): { members: EmailRecord[]; ownCopies: number } {
  const conversation = conversationFoldersOf(folders);
  const roleOf = (email: EmailRecord) => classifyFolder(folders.find(folder => folder.id === email.folderId) ?? { path: '', name: '', specialUse: null }) ?? '';
  let ownCopies = 0;
  const members = rows.filter(member => {
    if (member.id === named.id || isDraftRow(member.tags, conversation) || roleOf(member) === 'drafts') return false;
    if (hidesMail(action) && (isExcludedFolderCopy(member.tags) || ['trash', 'spam'].includes(roleOf(member)))) return false;
    if ((action === 'move' || action === 'spam') && (roleOf(member) === 'sent' || isSentCopy(member.tags, conversation))) { ownCopies++; return false; }
    return true;
  });
  return { members, ownCopies };
}

const NOTES: Partial<Record<InboxAgentChangeAction, string>> = {
  spam: 'Also sends these senders\' future mail to Spam.',
  not_spam: 'Also stops sending these senders\' future mail to Spam.',
};

function result(held: HeldChangeSet, waiting: AutoApplyWait | undefined, notes: string[]): string {
  const { set } = held;
  const counts = changeCounts(set);
  const guarded = set.items.filter(item => item.protectedReason);
  const lines = [`Change set ${set.label}: ${set.summary}.`];
  if (!waiting) {
    lines.push(`Applied now (the user allowed changes in this chat): ${counts.applied} changed, ${counts.queued} saved to sync when the account is online, ${counts.unchanged} already as asked, ${counts.skipped} skipped because they changed meanwhile, ${counts.failed} failed. The user can undo it.`);
  } else {
    lines.push(`NOT applied: it waits for the user to approve it on a card below your answer${waiting === 'cap' ? `, because it is more than the ${INBOX_AGENT_CHANGE_LIMITS.autoApplyPerRun} emails that may change without asking in one request`
      : waiting === 'protected' ? ', because every email in it is protected'
        : waiting === 'standing' ? `, because it changes more than these emails (${set.note ?? (set.createsLabelIn?.length ? 'it creates a new label' : 'it teaches the spam filter')}), which always needs the user's approval` : ''}. Do not say it is done; say what you prepared.`);
  }
  if (guarded.length) {
    const reasons = [...new Set(guarded.map(item => item.protectedReason))].slice(0, 4).join('; ');
    lines.push(`${guarded.length} of them ${guarded.length === 1 ? 'is' : 'are'} protected and left unticked for the user to decide (${reasons}).`);
  }
  return [...lines, ...notes].join('\n');
}

const changeMail: InboxAgentTool = {
  activity: 'Preparing mail changes',
  definition: {
    name: 'change_mail',
    description: 'Change emails: mark read or unread, star or unstar, archive, move to Trash, restore from Trash, move to a folder, add or remove a category or a label, snooze until a time or unsnooze, or report as spam / not spam. Name the emails by ids from earlier results, or by a classify_messages result and the labels to change. Returns a change set id (C1…) and whether it was applied or waits for the user\'s approval.',
    parameters: { type: 'object', additionalProperties: false, required: ['action'], properties: {
      action: { type: 'string', enum: [...ACTIONS] },
      ids: { type: 'array', items: { type: 'string' }, maxItems: MAX_IDS, description: 'Email ids (S…) from earlier results.' },
      from_result: { type: 'string', description: 'A classify_messages result id (T…): change the emails it gave one of "labels".' },
      labels: { type: 'array', items: { type: 'string' }, description: 'With from_result: which labels to change. "unsure" is never changed.' },
      folder: { type: 'string', description: 'For "move": a folder name from list_folders, or archive / inbox.' },
      category: { type: 'string', description: 'For add_category / remove_category: a slug from list_categories, or "important".' },
      label_name: { type: 'string', description: 'For add_label / remove_label: the label\'s name. add_label with a label the account does not have yet creates it (that always asks the user first).' },
      until: { type: 'string', description: 'For snooze: when the mail comes back, as local date and time in the user\'s time zone, e.g. 2026-11-21T09:00.' },
      include_conversation: { type: 'boolean', description: 'Also change the other emails in each email\'s conversation. Default false: only the emails named.' },
    } },
  },
  async run(raw, context) {
    // Offered only with a change context (runInboxAgent), so it is always there.
    const state = context.changes!;
    const args = readArgs(raw, ['action', 'ids', 'from_result', 'labels', 'folder', 'category', 'label_name', 'until', 'include_conversation']);
    const action = optionalText(args, 'action', 30) as InboxAgentChangeAction | undefined;
    if (!action || !ACTIONS.includes(action)) throw new InboxAgentToolError(`"action" must be one of ${ACTIONS.join(', ')}.`);
    const folderName = optionalText(args, 'folder', 200);
    const category = optionalText(args, 'category', 80)?.toLowerCase();
    if (action === 'move' && !folderName) throw new InboxAgentToolError('"folder" is required for move.');
    if (action !== 'move' && folderName) throw new InboxAgentToolError('"folder" goes with action "move" only.');
    if ((action === 'add_category' || action === 'remove_category') !== !!category) throw new InboxAgentToolError('"category" goes with add_category and remove_category, and they need it.');
    const labelName = optionalText(args, 'label_name', 60)?.trim();
    if ((action === 'add_label' || action === 'remove_label') !== !!labelName) throw new InboxAgentToolError('"label_name" goes with add_label and remove_label, and they need it.');
    if (labelName && (labelName.includes('|') || RESERVED_LABELS.has(labelName.toLowerCase()))) throw new InboxAgentToolError(labelNameProblem(labelName, [])!);
    const untilText = optionalText(args, 'until', 40);
    if ((action === 'snooze') !== !!untilText) throw new InboxAgentToolError('"until" goes with snooze, and snooze needs it.');
    const snooze = untilText ? parseSnoozeUntil(untilText, context.timeZone, state.nowMs()) : undefined;
    const wholeConversations = optionalBoolean(args, 'include_conversation') ?? false;
    if (state.sets.length >= INBOX_AGENT_CHANGE_LIMITS.setsPerRun) throw new InboxAgentToolError(`At most ${INBOX_AGENT_CHANGE_LIMITS.setsPerRun} change sets per request.`);
    const picked = selection(args, context);

    const targets: StageTarget[] = [];
    const left = new Map<string, number>();
    const seen = new Set<string>();
    let destination: { accountId: string; folder: FolderRecord } | undefined;
    /** Each account's spelling of the label, or null where applying creates it. */
    const labelIn = new Map<string, string | null>();
    const senders = new Map<string, InboxAgentSpamRevert['sender']>();
    const guardOf = conversationGuardsFor(context);
    for (const choice of picked) {
      context.signal.throwIfAborted();
      const account = accountOf(context, choice.accountId);
      const opened = await openAccount(context, account);
      if (!opened) throw new InboxAgentToolError(`${account.email} could not be opened, so nothing was changed.`);
      if (category && category !== 'important') {
        let slugs: string[] = [];
        try { slugs = (opened.mailbox.storage.getCategoryDefinitions?.() ?? []).map(definition => definition.slug.toLowerCase()); } catch { /* Checked by the change itself. */ }
        if (!slugs.includes(category)) throw new InboxAgentToolError(`"${category}" is not a category in ${account.email}. Use list_categories.`);
      }
      if (labelName && !labelIn.has(account.id)) {
        let known: string | null;
        try { known = await existingLabel(opened.mailbox.storage, labelName); }
        catch { throw new InboxAgentToolError(`The labels of ${account.email} could not be read, so nothing was changed.`); }
        if (!known && action === 'remove_label') throw new InboxAgentToolError(`${account.email} has no label "${labelName}".`);
        // A label must not shadow a folder or a category: its tag would read as one.
        const problem = known ? undefined : labelNameProblem(labelName, opened.folders, (opened.mailbox.storage.getCategoryDefinitions?.() ?? []).map(definition => definition.slug));
        if (problem) throw new InboxAgentToolError(problem);
        labelIn.set(account.id, known);
      }
      let folder: FolderRecord | undefined;
      if (action === 'move') {
        folder = destinationFolder(folderName!, opened.folders, account.email);
        // One destination per set: the card names a single folder.
        if (destination && destination.accountId !== account.id) throw new InboxAgentToolError('A move covers one account at a time; call change_mail once per account.');
        destination = { accountId: account.id, folder };
      }
      const named = await opened.mailbox.storage.getEmail(choice.emailId);
      if (!named) { left.set('no longer in the mailbox', (left.get('no longer in the mailbox') ?? 0) + 1); continue; }
      let members = [named];
      if (wholeConversations && named.threadId && opened.mailbox.storage.getEmailsByThread) {
        // The email the model named stays whatever it is; only what the conversation adds is filtered.
        const added = conversationAdditions(action, named, await opened.mailbox.storage.getEmailsByThread(named.threadId), opened.folders);
        members = [named, ...added.members];
        if (added.ownCopies) left.set('your own sent copy', (left.get('your own sent copy') ?? 0) + added.ownCopies);
      }
      for (const member of members) {
        const key = `${account.id}\0${member.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const done = alreadyDone(action, member, opened.folders, { ...(folder ? { destination: folder } : {}), ...(category ? { category } : {}),
          ...(labelName ? { labelName: labelIn.get(account.id) ?? labelName } : {}), ...(snooze ? { until: snooze.until } : {}) });
        if (done) { left.set(done, (left.get(done) ?? 0) + 1); continue; }
        // The stored body only: protections never wait on a download.
        const email = member === named ? named : await opened.mailbox.storage.getEmail(member.id) ?? member;
        const protectedReason = await stagedProtection(context, account.id, action, email, guardOf(account, opened));
        // What an unstar or a category removal lowers, so the next request in the chat still protects it.
        const firstLook = LOWERING_ACTIONS.has(action) ? state.atStart.get(key) : undefined;
        const lowered = firstLook && firstLook !== UNCHECKED_AT_START ? firstLook : undefined;
        const address = (action === 'spam' || action === 'not_spam') && email.fromAddress ? email.fromAddress.toLowerCase() : undefined;
        if (address && !senders.has(`${account.id}\0${address}`)) {
          try { senders.set(`${account.id}\0${address}`, await senderLists(opened.mailbox.storage, email.fromAddress)); }
          catch { throw new InboxAgentToolError(`The spam lists of ${account.email} could not be read, so nothing was changed.`); }
        }
        targets.push({ accountId: account.id, accountEmail: account.email, email, folders: opened.folders,
          ...(address ? { sender: senders.get(`${account.id}\0${address}`) } : {}),
          ...(choice.reason && member.id === named.id ? { reason: oneLine(choice.reason, 160) } : {}),
          ...(protectedReason ? { protectedReason } : {}), ...(lowered ? { lowered } : {}) });
      }
      if (targets.length > INBOX_AGENT_CHANGE_LIMITS.perSet) throw new InboxAgentToolError(`At most ${INBOX_AGENT_CHANGE_LIMITS.perSet} emails per change. Split it into smaller groups.`);
    }
    const notes = [...left].map(([reason, count]) => `${count} left out: ${reason}.`);
    if (!targets.length) return ['Nothing to change.', ...notes].join('\n');

    // Labels differ only in case across accounts at most; the first account's spelling names the set.
    const spelling = [...labelIn.values()].find(Boolean) ?? labelName;
    const createsLabelIn = [...labelIn].filter(([, known]) => !known).map(([accountId]) => accountId);
    const held = stageChangeSet({ label: `C${state.labelOffset.sets + state.sets.length + 1}`, action, ...(destination ? { folder: destination.folder } : {}),
      ...(category ? { category } : {}), ...(spelling ? { labelName: spelling } : {}), ...(createsLabelIn.length ? { createsLabelIn } : {}),
      ...(snooze ? { snooze } : {}), note: NOTES[action] ?? (createsLabelIn.length ? `Also creates the label "${spelling}".` : undefined),
      targets, nowMs: state.nowMs() });
    state.sets.push(held);
    const unprotected = targets.filter(target => !target.protectedReason).length;
    const waiting = autoApplyWait({ mode: state.mode, standing: held.set.standing, count: unprotected, autoApplied: state.autoApplied });
    if (!waiting) {
      context.progress({ stage: 'action', status: 'running', message: held.set.summary });
      await state.apply(held);
      state.autoApplied += unprotected;
      const counts = changeCounts(held.set);
      context.progress({ stage: 'action', status: counts.failed ? 'warning' : 'done', message: `${held.set.summary}: done`, detail: `${counts.applied + counts.queued} changed${counts.failed ? `, ${counts.failed} failed` : ''}. Undo is on the card.` });
    } else {
      context.progress({ stage: 'action', status: 'done', message: `Prepared: ${held.set.summary}`, detail: 'Waiting for your approval below the answer.' });
    }
    return result(held, waiting, notes);
  },
};

/** Why the agent's undo of a change set waits for the user, as the model is told. */
const UNDO_WAITS: Record<AgentUndoWait, string> = {
  approval: 'this chat asks the user before every change',
  standing: 'undoing it changes more than these emails (the spam filter and the sender lists, or a label it created)',
  approved: 'the user approved it on its card, so undoing it is their decision too',
  hides: 'undoing it would hide mail again (marked read, moved out of the Inbox or back to Trash, Archive or Spam, or snoozed again)',
  account: 'it changed mail in an account this request did not select',
  cap: `undoing it is more than the ${INBOX_AGENT_CHANGE_LIMITS.autoApplyPerRun} emails that may change without asking in one request`,
};

/** Record an earlier change the agent undid or asked the user to undo: one entry per change, the latest outcome. */
function noteUndo(state: InboxAgentChangeContext, request: InboxAgentChangeContext['undoRequests'][number]): void {
  const index = state.undoRequests.findIndex(item => item.id === request.id);
  if (index < 0) state.undoRequests.push(request);
  else state.undoRequests[index] = request;
}

const undoChange: InboxAgentTool = {
  activity: 'Undoing a change',
  definition: {
    name: 'undo_change',
    description: 'Undo a change set (C1…) or a setting change (R1…) from this chat that was applied, putting things back as they were. Anything changed by someone since is left as it is now. Only a change set you applied yourself under "Approve for me" is undone at once; any other undo (a setting change, everything in "Ask for approval") puts the change\'s Undo on a card for the user, and nothing is undone until they click it.',
    parameters: { type: 'object', additionalProperties: false, required: ['change_set'], properties: { change_set: { type: 'string', description: 'C… or R…' } } },
  },
  async run(raw, context) {
    const state = context.changes!;
    const args = readArgs(raw, ['change_set']);
    const label = optionalText(args, 'change_set', 10)?.toUpperCase();
    const setting = [...state.settingChanges, ...state.earlier.settings].find(item => item.change.label === label);
    if (setting) {
      const { change } = setting;
      if (change.status === 'pending') return `${label} was not applied, so there is nothing to undo. It waits for the user's approval; tell them they can cancel it on the card.`;
      if (change.status !== 'applied') return `${label} is ${change.status}; there is nothing to undo.`;
      if (state.nowMs() > change.undoBy) return `${label} can no longer be undone from here.`;
      // A setting keeps acting on mail nobody has seen: undoing one is the
      // user's decision in every mode, so the agent has no way to do it.
      noteUndo(state, { kind: 'setting', id: change.id, label: change.label, summary: change.summary, outcome: 'waiting' });
      context.progress({ stage: 'action', status: 'done', message: `Asked to undo: ${change.summary}`, detail: 'Waiting for your Undo below the answer.' });
      return `${label}: NOT undone. Undoing a setting change always waits for the user: its Undo is on a card below your answer. Do not say it is undone.`;
    }
    const held = [...state.sets, ...state.earlier.sets].find(item => item.set.label === label);
    if (!held) throw new InboxAgentToolError(`${label ?? 'That'} is not a change from this chat that can still be undone.`);
    const { set } = held;
    if (set.status === 'pending') return `${set.label} was not applied, so there is nothing to undo. It waits for the user's approval; tell them they can cancel it on the card.`;
    if (!['applied', 'partial'].includes(set.status)) return `${set.label} is ${set.status}; there is nothing to undo.`;
    const rows = set.items.filter(isChanged);
    if (!rows.length) return `${set.label}: nothing is left to undo.`;
    if (state.nowMs() > set.undoBy) return `${set.label} can no longer be undone from here.`;
    // One of this run's own sets already has its card, with Undo, under the answer.
    const earlier = !state.sets.includes(held);
    const wait = agentUndoWait(held, { mode: state.mode, autoApplied: state.autoApplied, accountIds: context.accounts.map(account => account.id) });
    if (wait) {
      if (earlier) noteUndo(state, { kind: 'change_set', id: set.id, label: set.label, summary: set.summary, outcome: 'waiting' });
      context.progress({ stage: 'action', status: 'done', message: `Asked to undo: ${set.summary}`, detail: 'Waiting for your Undo below the answer.' });
      return `${set.label}: NOT undone. It waits for the user: its Undo is on a card below your answer, because ${UNDO_WAITS[wait]}. Do not say it is undone.`;
    }
    // Counted against the per-request cap before it runs, whether or not each
    // row can be put back, as change_mail counts what it applies.
    state.autoApplied += rows.length;
    state.autoUndone += rows.length;
    context.progress({ stage: 'action', status: 'running', message: `Undo: ${set.summary}` });
    await rememberAtStart(context, rows);
    // What THIS call put back: rows an earlier Undo (the user's, or an earlier request's) already put back are not counted again.
    const undoneBefore = changeCounts(set).undone;
    await state.undo(held);
    const putBack = changeCounts(set).undone - undoneBefore;
    const left = rows.filter(isChanged).length;
    // Nothing put back (every row changed since, or refused): the card's Undo is still the user's to try.
    if (earlier) noteUndo(state, { kind: 'change_set', id: set.id, label: set.label, summary: set.summary, outcome: putBack ? 'undone' : 'waiting' });
    context.progress({ stage: 'action', status: left ? 'warning' : 'done', message: `Undo: ${set.summary}: done`, detail: `${putBack} put back${left ? `, ${left} left as they are` : ''}.` });
    return `${set.label}: ${putBack} put back${left ? `, ${left} left as they are (changed since, or could not be undone)` : ''}.`;
  },
};

export const INBOX_AGENT_WRITE_TOOLS: readonly InboxAgentTool[] = [changeMail, undoChange];
