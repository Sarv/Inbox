import { classifyFolder, hasTag, isInboxFolder, isTrashFolder, type EmailRecord, type FolderRecord } from '@sarvinbox/core';

import type { InboxAgentChangeAction } from '../../src/types/inbox-assistant-changes';

import {
  accountOf, InboxAgentToolError, oneLine, openAccount, optionalBoolean, optionalText, readArgs, roleFolders,
  type InboxAgentTool, type InboxAgentToolContext,
} from './inbox-assistant-agent-tools';
import { changeCounts, changeProtection, INBOX_AGENT_CHANGE_LIMITS, stageChangeSet, type HeldChangeSet, type StageTarget } from './inbox-assistant-change-sets';
import { fullBody } from './inbox-assistant-retrieval';

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

const ACTIONS: readonly InboxAgentChangeAction[] = ['mark_read', 'mark_unread', 'star', 'unstar', 'archive', 'trash', 'restore', 'move', 'add_category', 'remove_category'];
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

/** Why a message is left out of this action because it is already as asked, or undefined. */
function alreadyDone(action: InboxAgentChangeAction, email: EmailRecord, folders: FolderRecord[], destination?: FolderRecord, category?: string): string | undefined {
  const tags = email.tags || '||';
  const primary = folders.find(folder => folder.id === email.folderId);
  const inInbox = folders.some(folder => isInboxFolder(folder) && (folder.id === email.folderId || hasTag(tags, folder.path)));
  const inTrash = !!primary && isTrashFolder(primary);
  switch (action) {
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

function destinationFolder(name: string, folders: FolderRecord[], accountEmail: string): FolderRecord {
  const role = name.toLowerCase();
  const matches = roleFolders(folders, role);
  const folder = matches[0];
  if (!folder) throw new InboxAgentToolError(`No folder named "${name.slice(0, 80)}" in ${accountEmail}. Use list_folders.`);
  if (NOT_MOVE_DESTINATIONS.has(classifyFolder(folder) ?? '') || NOT_MOVE_DESTINATIONS.has(role)) {
    throw new InboxAgentToolError(role === 'trash' ? 'Use action "trash" to move mail to Trash.' : `Mail cannot be moved to ${folder.path} from here.`);
  }
  return folder;
}

type Waiting = 'approval' | 'cap' | 'protected';

function result(held: HeldChangeSet, waiting: Waiting | undefined, notes: string[]): string {
  const { set } = held;
  const counts = changeCounts(set);
  const guarded = set.items.filter(item => item.protectedReason);
  const lines = [`Change set ${set.label}: ${set.summary}.`];
  if (!waiting) {
    lines.push(`Applied now (the user allowed changes in this chat): ${counts.applied} changed, ${counts.queued} saved to sync when the account is online, ${counts.unchanged} already as asked, ${counts.skipped} skipped because they changed meanwhile, ${counts.failed} failed. The user can undo it.`);
  } else {
    lines.push(`NOT applied: it waits for the user to approve it on a card below your answer${waiting === 'cap' ? `, because it is more than the ${INBOX_AGENT_CHANGE_LIMITS.autoApplyPerRun} emails that may change without asking in one request`
      : waiting === 'protected' ? ', because every email in it is protected' : ''}. Do not say it is done; say what you prepared.`);
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
    description: 'Change emails: mark read or unread, star or unstar, archive, move to Trash, restore from Trash, move to a folder, or add or remove a category. Name the emails by ids from earlier results, or by a classify_messages result and the labels to change. Returns a change set id (C1…) and whether it was applied or waits for the user\'s approval.',
    parameters: { type: 'object', additionalProperties: false, required: ['action'], properties: {
      action: { type: 'string', enum: [...ACTIONS] },
      ids: { type: 'array', items: { type: 'string' }, maxItems: MAX_IDS, description: 'Email ids (S…) from earlier results.' },
      from_result: { type: 'string', description: 'A classify_messages result id (T…): change the emails it gave one of "labels".' },
      labels: { type: 'array', items: { type: 'string' }, description: 'With from_result: which labels to change. "unsure" is never changed.' },
      folder: { type: 'string', description: 'For "move": a folder name from list_folders, or archive / inbox.' },
      category: { type: 'string', description: 'For add_category / remove_category: a slug from list_categories, or "important".' },
      include_conversation: { type: 'boolean', description: 'Also change the other emails in each email\'s conversation. Default false: only the emails named.' },
    } },
  },
  async run(raw, context) {
    // Offered only with a change context (runInboxAgent), so it is always there.
    const state = context.changes!;
    const args = readArgs(raw, ['action', 'ids', 'from_result', 'labels', 'folder', 'category', 'include_conversation']);
    const action = optionalText(args, 'action', 30) as InboxAgentChangeAction | undefined;
    if (!action || !ACTIONS.includes(action)) throw new InboxAgentToolError(`"action" must be one of ${ACTIONS.join(', ')}.`);
    const folderName = optionalText(args, 'folder', 200);
    const category = optionalText(args, 'category', 80)?.toLowerCase();
    if (action === 'move' && !folderName) throw new InboxAgentToolError('"folder" is required for move.');
    if (action !== 'move' && folderName) throw new InboxAgentToolError('"folder" goes with action "move" only.');
    if ((action === 'add_category' || action === 'remove_category') !== !!category) throw new InboxAgentToolError('"category" goes with add_category and remove_category, and they need it.');
    const wholeConversations = optionalBoolean(args, 'include_conversation') ?? false;
    if (state.sets.length >= INBOX_AGENT_CHANGE_LIMITS.setsPerRun) throw new InboxAgentToolError(`At most ${INBOX_AGENT_CHANGE_LIMITS.setsPerRun} change sets per request.`);
    const picked = selection(args, context);

    const targets: StageTarget[] = [];
    const left = new Map<string, number>();
    const seen = new Set<string>();
    let destination: { accountId: string; folder: FolderRecord } | undefined;
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
      let folder: FolderRecord | undefined;
      if (action === 'move') {
        folder = destinationFolder(folderName!, opened.folders, account.email);
        // One destination per set: the card names a single folder.
        if (destination && destination.accountId !== account.id) throw new InboxAgentToolError('A move covers one account at a time; call change_mail once per account.');
        destination = { accountId: account.id, folder };
      }
      const named = await opened.mailbox.storage.getEmail(choice.emailId);
      if (!named) { left.set('no longer in the mailbox', (left.get('no longer in the mailbox') ?? 0) + 1); continue; }
      const members = wholeConversations && named.threadId && opened.mailbox.storage.getEmailsByThread
        ? [named, ...(await opened.mailbox.storage.getEmailsByThread(named.threadId)).filter(member => member.id !== named.id)] : [named];
      for (const member of members) {
        const key = `${account.id}\0${member.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const done = alreadyDone(action, member, opened.folders, folder, category);
        if (done) { left.set(done, (left.get(done) ?? 0) + 1); continue; }
        // The stored body only: protections never wait on a download.
        const email = member === named ? named : await opened.mailbox.storage.getEmail(member.id) ?? member;
        const body = fullBody(email);
        const protectedReason = changeProtection(action, email, body);
        targets.push({ accountId: account.id, accountEmail: account.email, email, folders: opened.folders,
          ...(choice.reason && member.id === named.id ? { reason: oneLine(choice.reason, 160) } : {}),
          ...(protectedReason ? { protectedReason } : {}) });
      }
      if (targets.length > INBOX_AGENT_CHANGE_LIMITS.perSet) throw new InboxAgentToolError(`At most ${INBOX_AGENT_CHANGE_LIMITS.perSet} emails per change. Split it into smaller groups.`);
    }
    const notes = [...left].map(([reason, count]) => `${count} left out: ${reason}.`);
    if (!targets.length) return ['Nothing to change.', ...notes].join('\n');

    const held = stageChangeSet({ label: `C${state.sets.length + 1}`, action, ...(destination ? { folder: destination.folder } : {}),
      ...(category ? { category } : {}), targets, nowMs: state.nowMs() });
    state.sets.push(held);
    const unprotected = targets.filter(target => !target.protectedReason).length;
    const waiting: Waiting | undefined = state.mode !== 'approve_for_me' ? 'approval' : !unprotected ? 'protected'
      : state.autoApplied + unprotected > INBOX_AGENT_CHANGE_LIMITS.autoApplyPerRun ? 'cap' : undefined;
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

const undoChange: InboxAgentTool = {
  activity: 'Undoing a change',
  definition: {
    name: 'undo_change',
    description: 'Undo a change set this request applied (C1…), putting each email back as it was. Emails changed by someone since are left as they are now.',
    parameters: { type: 'object', additionalProperties: false, required: ['change_set'], properties: { change_set: { type: 'string' } } },
  },
  async run(raw, context) {
    const state = context.changes!;
    const args = readArgs(raw, ['change_set']);
    const label = optionalText(args, 'change_set', 10)?.toUpperCase();
    const held = state.sets.find(item => item.set.label === label);
    if (!held) throw new InboxAgentToolError(`${label ?? 'That'} is not a change set from this request.`);
    if (held.set.status === 'pending') return `${held.set.label} was not applied, so there is nothing to undo. It waits for the user's approval; tell them they can cancel it on the card.`;
    await state.undo(held);
    const counts = changeCounts(held.set);
    return `${held.set.label}: ${counts.undone} put back${counts.applied + counts.queued ? `, ${counts.applied + counts.queued} left as they are (changed since, or could not be undone)` : ''}.`;
  },
};

export const INBOX_AGENT_WRITE_TOOLS: readonly InboxAgentTool[] = [changeMail, undoChange];
