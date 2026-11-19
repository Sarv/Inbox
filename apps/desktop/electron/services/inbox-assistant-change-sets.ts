import { randomUUID } from 'node:crypto';

import { classifyFolder, hasTag, type EmailRecord, type FolderRecord } from '@sarvinbox/core';

import type {
  InboxAgentChangeAction, InboxAgentChangeItem, InboxAgentChangeItemStatus, InboxAgentChangeSet,
} from '../../src/types/inbox-assistant-changes';

import type { AssistantReadReceipt } from './assistant-mail-actions';
import type { AssistantMoveDestination } from './assistant-mail-moves';
import { unreadReviewContentProtections } from './inbox-assistant-review-protection';

/**
 * Change sets: how a mail change the Inbox Agent asks for reaches the mailbox.
 *
 * The agent never changes mail directly. A write tool stages the messages it
 * named (ids it was shown, frozen at that moment) with each message's state, and
 * the host applies the set only when the user approves it, or, under "Approve
 * for me", within a cap. Every applied set keeps what it needs to be undone.
 *
 * The rules that make this safe live here, not in the prompt:
 * - a row is applied at most once: approving again retries only failed rows;
 * - a row that changed since it was staged (moved, deleted) is skipped, never
 *   forced;
 * - a protected row (security codes, bank records, invoices, starred mail…) is
 *   applied only when the user ticks it, never automatically;
 * - Undo touches only rows this set changed and that are still as it left them.
 */

export const INBOX_AGENT_CHANGE_LIMITS = {
  /** Messages in one change set. */
  perSet: 1_000,
  /** Change sets one run may stage. */
  setsPerRun: 10,
  /** Messages "Approve for me" may change in one run without a card. */
  autoApplyPerRun: 200,
  /** How long a staged set can be approved: after that its snapshot is too old to trust. */
  approveMs: 30 * 60_000,
  /** How long an applied set can be undone (this app session only). */
  undoMs: 24 * 60 * 60_000,
} as const;

/** What the host can do to mail, per account. The implementation records the change as the agent's, approved by the user. */
export interface InboxAgentMailActions {
  setRead(accountId: string, emailIds: string[], read: boolean): Promise<AssistantReadReceipt>;
  setStarred(accountId: string, emailIds: string[], starred: boolean): Promise<AssistantReadReceipt>;
  move(accountId: string, emailIds: string[], to: AssistantMoveDestination): Promise<AssistantReadReceipt>;
  /** Trash back to Inbox, including Gmail rows whose Trash membership is a label. */
  restore(accountId: string, emailIds: string[]): Promise<AssistantReadReceipt>;
  setCategory(accountId: string, emailIds: string[], slug: string, on: boolean): Promise<AssistantReadReceipt>;
}

/** Reads one message's current state, for the staleness checks. Null: it is gone. */
export type InboxAgentEmailReader = (accountId: string, emailId: string) => Promise<Pick<EmailRecord, 'tags' | 'folderId'> | null>;

interface Snapshot { tags: string; folderId: string }

interface HeldItem {
  item: InboxAgentChangeItem;
  before: Snapshot;
  /** Where Undo puts a moved message back: its Inbox if it was in one, else its folder. */
  originFolderId: string;
  originIsInbox: boolean;
  after?: Snapshot;
}

export interface HeldChangeSet {
  set: InboxAgentChangeSet;
  items: Map<string, HeldItem>;
  /** Destination folder id, for `move`. */
  folderId?: string;
  busy: boolean;
}

const MOVES = new Set<InboxAgentChangeAction>(['archive', 'trash', 'restore', 'move']);
/** Actions that take mail out of the user's sight or attention: the protections apply. */
const GUARDED = new Set<InboxAgentChangeAction>(['mark_read', 'archive', 'trash', 'move']);

const VERBS: Record<InboxAgentChangeAction, [string, string]> = {
  mark_read: ['Mark', 'read'], mark_unread: ['Mark', 'unread'], star: ['Star', ''], unstar: ['Unstar', ''],
  archive: ['Archive', ''], trash: ['Move', 'to Trash'], restore: ['Restore', 'from Trash'], move: ['Move', 'to'],
  add_category: ['Add', 'to'], remove_category: ['Remove', 'from'],
};

export function changeSummary(action: InboxAgentChangeAction, count: number, target?: string): string {
  const [verb, tail] = VERBS[action];
  const noun = `${count} ${count === 1 ? 'email' : 'emails'}`;
  if (action === 'add_category') return `Add ${noun} to category ${target}`;
  if (action === 'remove_category') return `Remove ${noun} from category ${target}`;
  if (action === 'move') return `Move ${noun} to ${target}`;
  return [verb, noun, tail].filter(Boolean).join(' ');
}

/**
 * Why a message should not be changed this way without the user ticking it,
 * or undefined. Starred and important mail, and the unread review's content
 * gates (security codes, bank and card records, invoices, contracts, business
 * reports, meeting invitations), checked on whatever body is stored.
 */
export function changeProtection(action: InboxAgentChangeAction, email: Pick<EmailRecord, 'tags' | 'subject' | 'fromAddress'>, body: string): string | undefined {
  if (!GUARDED.has(action)) return undefined;
  const tags = email.tags || '||';
  if (hasTag(tags, 'starred')) return 'Starred';
  if (hasTag(tags, 'important')) return 'Marked important';
  return unreadReviewContentProtections(email, body)[0];
}

export interface StageTarget {
  accountId: string;
  accountEmail: string;
  email: EmailRecord;
  folders: FolderRecord[];
  reason?: string;
  protectedReason?: string;
}

function snapshot(email: Pick<EmailRecord, 'tags' | 'folderId'>): Snapshot {
  return { tags: email.tags || '||', folderId: email.folderId };
}

/** The Inbox a message is in (primary or, on Gmail, a label), if any. */
function inboxOf(email: Pick<EmailRecord, 'tags' | 'folderId'>, folders: FolderRecord[]): FolderRecord | undefined {
  const inboxes = folders.filter(folder => classifyFolder(folder) === 'inbox');
  return inboxes.find(folder => folder.id === email.folderId) ?? inboxes.find(folder => hasTag(email.tags || '||', folder.path));
}

export function stageChangeSet(input: {
  label: string;
  action: InboxAgentChangeAction;
  folder?: FolderRecord;
  category?: string;
  targets: StageTarget[];
  nowMs: number;
}): HeldChangeSet {
  const id = randomUUID();
  const items = new Map<string, HeldItem>();
  input.targets.forEach((target, index) => {
    const inbox = inboxOf(target.email, target.folders);
    const item: InboxAgentChangeItem = {
      id: `${input.label.toLowerCase()}-${index + 1}`, accountId: target.accountId, accountEmail: target.accountEmail,
      emailId: target.email.id, threadId: target.email.threadId, subject: target.email.subject || '(No subject)',
      from: target.email.fromName ? `${target.email.fromName} <${target.email.fromAddress}>` : target.email.fromAddress,
      date: target.email.date, status: 'pending',
      ...(target.reason ? { reason: target.reason } : {}),
      ...(target.protectedReason ? { protectedReason: target.protectedReason } : {}),
    };
    items.set(item.id, { item, before: snapshot(target.email), originFolderId: inbox?.id ?? target.email.folderId, originIsInbox: !!inbox });
  });
  const target = input.action === 'move' ? input.folder?.path : input.category;
  const set: InboxAgentChangeSet = {
    id, label: input.label, action: input.action,
    ...(input.folder ? { folder: input.folder.path } : {}), ...(input.category ? { category: input.category } : {}),
    summary: changeSummary(input.action, items.size, target),
    createdAt: input.nowMs, approveBy: input.nowMs + INBOX_AGENT_CHANGE_LIMITS.approveMs, undoBy: 0,
    status: 'pending', items: [...items.values()].map(held => held.item),
  };
  return { set, items, ...(input.folder ? { folderId: input.folder.id } : {}), busy: false };
}

/** The `on` value an action sets, for flag and category actions. */
function flagValue(action: InboxAgentChangeAction): boolean {
  return action === 'mark_read' || action === 'star' || action === 'add_category';
}

function inState(action: InboxAgentChangeAction, held: HeldChangeSet, email: Pick<EmailRecord, 'tags' | 'folderId'>, folderId?: string): boolean {
  const tags = email.tags || '||';
  switch (action) {
    case 'mark_read': case 'mark_unread': return hasTag(tags, 'read') === flagValue(action);
    case 'star': case 'unstar': return hasTag(tags, 'starred') === flagValue(action);
    case 'add_category': case 'remove_category': return hasTag(tags, held.set.category!) === flagValue(action);
    default: return email.folderId === folderId;
  }
}

async function run(actions: InboxAgentMailActions, held: HeldChangeSet, action: InboxAgentChangeAction, accountId: string, ids: string[], folderId?: string): Promise<AssistantReadReceipt> {
  switch (action) {
    case 'mark_read': case 'mark_unread': return actions.setRead(accountId, ids, flagValue(action));
    case 'star': case 'unstar': return actions.setStarred(accountId, ids, flagValue(action));
    case 'add_category': case 'remove_category': return actions.setCategory(accountId, ids, held.set.category!, flagValue(action));
    case 'archive': return actions.move(accountId, ids, 'archive');
    case 'trash': return actions.move(accountId, ids, 'trash');
    case 'restore': return actions.restore(accountId, ids);
    case 'move': return actions.move(accountId, ids, { folderId: folderId! });
  }
}

/** A set's status from its rows, once no row waits for a decision. */
function settle(held: HeldChangeSet): void {
  const items = held.set.items;
  if (held.set.status === 'cancelled' || items.some(item => item.status === 'pending')) return;
  if (items.some(item => item.status === 'failed')) held.set.status = 'partial';
  else if (items.some(item => item.status === 'applied' || item.status === 'queued')) held.set.status = 'applied';
  else if (items.some(item => item.status === 'undone')) held.set.status = 'undone';
  else held.set.status = 'applied';
}

async function grouped(
  entries: HeldItem[], apply: (accountId: string, ids: string[]) => Promise<AssistantReadReceipt>,
  signal?: AbortSignal,
): Promise<Map<HeldItem, 'applied' | 'queued' | 'failed' | 'unchanged'>> {
  const outcome = new Map<HeldItem, 'applied' | 'queued' | 'failed' | 'unchanged'>();
  const accounts = new Map<string, HeldItem[]>();
  for (const entry of entries) accounts.set(entry.item.accountId, [...(accounts.get(entry.item.accountId) ?? []), entry]);
  for (const [accountId, list] of accounts) {
    signal?.throwIfAborted();
    let receipt: AssistantReadReceipt;
    // A thrown action (account disconnected, no folder) fails its own account only.
    try { receipt = await apply(accountId, list.map(entry => entry.item.emailId)); }
    catch { receipt = { appliedIds: [], queuedIds: [], failedIds: list.map(entry => entry.item.emailId) }; }
    for (const entry of list) {
      const id = entry.item.emailId;
      outcome.set(entry, receipt.failedIds.includes(id) ? 'failed' : receipt.queuedIds.includes(id) ? 'queued'
        : receipt.appliedIds.includes(id) ? 'applied' : 'unchanged');
    }
  }
  return outcome;
}

export class InboxAgentChangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InboxAgentChangeError';
  }
}

function claim(held: HeldChangeSet): void {
  if (held.busy) throw new InboxAgentChangeError('These changes are already being applied.');
  held.busy = true;
}

/**
 * Apply the selected rows. `itemIds` absent: every row that is not protected.
 * `auto`: "Approve for me", which never applies a protected row. Only pending
 * and failed rows run, so approving twice never applies a row twice.
 */
export async function applyChangeSet(held: HeldChangeSet, options: {
  actions: InboxAgentMailActions; readEmail: InboxAgentEmailReader; nowMs: number;
  itemIds?: string[]; auto?: boolean; signal?: AbortSignal;
}): Promise<void> {
  const { set } = held;
  if (!['pending', 'partial'].includes(set.status)) throw new InboxAgentChangeError(set.status === 'cancelled' ? 'These changes were cancelled.' : 'These changes were already applied.');
  if (options.nowMs > set.approveBy) {
    if (set.status === 'pending') set.status = 'expired';
    throw new InboxAgentChangeError('These changes waited too long for approval. Ask again to stage them fresh.');
  }
  const wanted = options.itemIds ? new Set(options.itemIds) : undefined;
  if (wanted && [...wanted].some(id => !held.items.has(id))) throw new InboxAgentChangeError('Choose rows from this change set.');
  claim(held);
  try {
    const selected: HeldItem[] = [];
    for (const entry of held.items.values()) {
      const { item } = entry;
      if (item.status !== 'pending' && item.status !== 'failed') continue;
      const chosen = wanted ? wanted.has(item.id) : !item.protectedReason;
      if (!chosen || (options.auto && item.protectedReason)) {
        // An approval decides the whole card: a pending row left unticked is
        // declined. Auto-apply leaves protected rows for the user to decide.
        if (item.status === 'pending' && !options.auto) { item.status = 'skipped'; item.detail = 'Not selected.'; }
        continue;
      }
      selected.push(entry);
    }
    // Staleness: a move acts on where the message was when it was staged. A
    // message the user (or sync) moved or deleted since then is left alone.
    const ready: HeldItem[] = [];
    for (const entry of selected) {
      options.signal?.throwIfAborted();
      let current: Pick<EmailRecord, 'tags' | 'folderId'> | null;
      try { current = await options.readEmail(entry.item.accountId, entry.item.emailId); }
      catch { entry.item.status = 'failed'; entry.item.detail = 'Its account could not be opened.'; continue; }
      if (!current) { entry.item.status = 'skipped'; entry.item.detail = 'It no longer exists.'; continue; }
      if (MOVES.has(set.action) && current.folderId !== entry.before.folderId) {
        entry.item.status = 'skipped'; entry.item.detail = 'It was moved after the change was prepared.'; continue;
      }
      ready.push(entry);
    }
    const outcome = await grouped(ready, (accountId, ids) => run(options.actions, held, set.action, accountId, ids, held.folderId), options.signal);
    for (const [entry, result] of outcome) {
      entry.item.status = result;
      if (result === 'failed') entry.item.detail = 'Could not be changed. Approve again to retry.';
      else delete entry.item.detail;
      if (result === 'applied' || result === 'queued') {
        try {
          const after = await options.readEmail(entry.item.accountId, entry.item.emailId);
          if (after) entry.after = snapshot(after);
        } catch { /* Undo then reads it as changed and leaves it alone. */ }
        // A move service reports mail already in place as applied. Nothing
        // moved, so there is nothing for Undo to move back.
        if (MOVES.has(set.action) && entry.after?.folderId === entry.before.folderId && entry.after.tags === entry.before.tags) entry.item.status = 'unchanged';
      }
    }
    if (options.auto) set.autoApplied = true;
    if ([...held.items.values()].some(entry => entry.item.status === 'applied' || entry.item.status === 'queued')) set.undoBy = options.nowMs + INBOX_AGENT_CHANGE_LIMITS.undoMs;
    // Auto-apply leaves protected rows pending on the card; the set stays open for them.
    if (!options.auto || ![...held.items.values()].some(entry => entry.item.status === 'pending')) settle(held);
    else set.status = 'partial';
  } finally { held.busy = false; }
}

export function cancelChangeSet(held: HeldChangeSet): void {
  if (held.busy) throw new InboxAgentChangeError('These changes are being applied.');
  if (!['pending', 'partial'].includes(held.set.status)) throw new InboxAgentChangeError('These changes can no longer be cancelled.');
  for (const { item } of held.items.values()) if (item.status === 'pending') { item.status = 'skipped'; item.detail = 'Cancelled.'; }
  if (held.set.status === 'pending' || !held.set.items.some(item => item.status === 'applied' || item.status === 'queued')) held.set.status = 'cancelled';
  else settle(held);
}

/** The action that puts a row back, and where. */
function inverse(action: InboxAgentChangeAction, entry: HeldItem): { action: InboxAgentChangeAction; folderId?: string } {
  switch (action) {
    case 'mark_read': return { action: 'mark_unread' };
    case 'mark_unread': return { action: 'mark_read' };
    case 'star': return { action: 'unstar' };
    case 'unstar': return { action: 'star' };
    case 'add_category': return { action: 'remove_category' };
    case 'remove_category': return { action: 'add_category' };
    case 'restore': return { action: 'trash' };
    // Out of Trash into the Inbox goes through restore (Gmail keeps Trash as a label).
    case 'trash': return entry.originIsInbox ? { action: 'restore' } : { action: 'move', folderId: entry.originFolderId };
    default: return { action: 'move', folderId: entry.originFolderId };
  }
}

/**
 * Undo the selected changed rows (default: all of them). A row is put back
 * only if it is still exactly as this set left it; one the user changed since
 * keeps the user's change and says so.
 */
export async function undoChangeSet(held: HeldChangeSet, options: {
  actions: InboxAgentMailActions; readEmail: InboxAgentEmailReader; nowMs: number; itemIds?: string[]; signal?: AbortSignal;
}): Promise<void> {
  const { set } = held;
  if (!['applied', 'partial'].includes(set.status)) throw new InboxAgentChangeError('There is nothing to undo here.');
  if (options.nowMs > set.undoBy) throw new InboxAgentChangeError('These changes can no longer be undone from here.');
  const wanted = options.itemIds ? new Set(options.itemIds) : undefined;
  if (wanted && [...wanted].some(id => !held.items.has(id))) throw new InboxAgentChangeError('Choose rows from this change set.');
  claim(held);
  try {
    const plans = new Map<string, { action: InboxAgentChangeAction; folderId?: string; entries: HeldItem[] }>();
    for (const entry of held.items.values()) {
      const { item } = entry;
      if ((item.status !== 'applied' && item.status !== 'queued') || (wanted && !wanted.has(item.id))) continue;
      options.signal?.throwIfAborted();
      let current: Pick<EmailRecord, 'tags' | 'folderId'> | null = null;
      try { current = await options.readEmail(item.accountId, item.emailId); } catch { /* Treated as changed. */ }
      const expectedFolder = entry.after?.folderId;
      if (!current || !entry.after || !inState(set.action, held, current, expectedFolder)) {
        item.detail = 'Changed since; left as it is now.';
        continue;
      }
      const back = inverse(set.action, entry);
      const key = `${back.action}\0${back.folderId ?? ''}`;
      const plan = plans.get(key) ?? { ...back, entries: [] };
      plan.entries.push(entry);
      plans.set(key, plan);
    }
    for (const plan of plans.values()) {
      const outcome = await grouped(plan.entries, (accountId, ids) => run(options.actions, held, plan.action, accountId, ids, plan.folderId), options.signal);
      for (const [entry, result] of outcome) {
        if (result === 'failed') entry.item.detail = 'Could not be undone. Try Undo again.';
        else { entry.item.status = 'undone'; delete entry.item.detail; }
      }
    }
    settle(held);
  } finally { held.busy = false; }
}

/** Counts by status, for the model and the activity line. */
export function changeCounts(set: InboxAgentChangeSet): Record<InboxAgentChangeItemStatus, number> {
  const counts = { pending: 0, applied: 0, queued: 0, unchanged: 0, failed: 0, skipped: 0, undone: 0 };
  for (const item of set.items) counts[item.status]++;
  return counts;
}
