import { randomUUID } from 'node:crypto';

import { classifyFolder, existingCategoryClassification, hasTag, parseAttachmentNames, type ContactRecord, type EmailRecord, type FolderRecord } from '@sarvinbox/core';

import type { InboxAssistantActionMode } from '../../src/types/inbox-assistant';
import type {
  InboxAgentChangeAction, InboxAgentChangeItem, InboxAgentChangeItemStatus, InboxAgentChangeSet,
} from '../../src/types/inbox-assistant-changes';
import { INBOX_AGENT_AUTO_APPLY_PER_REQUEST, INBOX_AGENT_UNDO_HOURS } from '../../src/utils/inbox-assistant-approval';

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
  /**
   * Messages "Approve for me" may change in one run without a card. The
   * shared value is the one the mode's description states and its saved
   * consent names (inbox-assistant-approval.ts).
   */
  autoApplyPerRun: INBOX_AGENT_AUTO_APPLY_PER_REQUEST,
  /** How long a staged set can be approved: after that its snapshot is too old to trust. */
  approveMs: 30 * 60_000,
  /** How long an applied set can be undone, as the mode's description states. */
  undoMs: INBOX_AGENT_UNDO_HOURS * 60 * 60_000,
} as const;

/** What a spam verdict's Undo puts back for one message: where it was, its tags, its stored verdict, and its sender's lists. */
export interface InboxAgentSpamRevert {
  emailId: string;
  tags: string;
  folderId: string;
  verdict: 'spam' | 'ham' | null;
  /** The sender's spammer and trusted listing before the verdict, when it had a sender. */
  sender?: { address: string; spammer: boolean; trusted: boolean };
}

/** What the host can do to mail, per account. The implementation records the change as the agent's, approved by the user. */
export interface InboxAgentMailActions {
  setRead(accountId: string, emailIds: string[], read: boolean): Promise<AssistantReadReceipt>;
  setStarred(accountId: string, emailIds: string[], starred: boolean): Promise<AssistantReadReceipt>;
  move(accountId: string, emailIds: string[], to: AssistantMoveDestination): Promise<AssistantReadReceipt>;
  /** Trash back to Inbox, including Gmail rows whose Trash membership is a label. */
  restore(accountId: string, emailIds: string[]): Promise<AssistantReadReceipt>;
  setCategory(accountId: string, emailIds: string[], slug: string, on: boolean): Promise<AssistantReadReceipt>;
  setLabel(accountId: string, emailIds: string[], name: string, on: boolean): Promise<AssistantReadReceipt>;
  /** Creates the label in the account. False when it already existed (then Undo must not delete it). */
  createLabel(accountId: string, name: string): Promise<boolean>;
  /** Deletes a label this agent created, unless an email still carries it. */
  dropLabel(accountId: string, name: string): Promise<void>;
  /** Snooze until a time (unix seconds), or wake the mail now with null. */
  setSnooze(accountId: string, emailIds: string[], until: number | null): Promise<AssistantReadReceipt>;
  /** The user's spam verdict, as Report spam / Not spam record it. */
  spamVerdict(accountId: string, emailIds: string[], verdict: 'spam' | 'ham'): Promise<AssistantReadReceipt>;
  revertSpamVerdict(accountId: string, rows: InboxAgentSpamRevert[]): Promise<AssistantReadReceipt>;
}

type EmailState = Pick<EmailRecord, 'tags' | 'folderId'> & Partial<EmailRecord>;

/** Reads one message's current state, for the staleness and protection checks. Null: it is gone. */
export type InboxAgentEmailReader = (accountId: string, emailId: string) => Promise<EmailState | null>;

interface Snapshot { tags: string; folderId: string; snoozeUntil: number | null; verdict: 'spam' | 'ham' | null }

interface HeldItem {
  item: InboxAgentChangeItem;
  before: Snapshot;
  /** Where Undo puts a moved message back: its Inbox if it was in one, else its folder. */
  originFolderId: string;
  originIsInbox: boolean;
  /** For a spam verdict: the sender's lists before it, which Undo restores. */
  sender?: InboxAgentSpamRevert['sender'];
  /** It was in Trash, Archive or Spam when staged: moving it back there hides it again. */
  originOutOfSight?: boolean;
  /**
   * For an unstar or a category removal: the message's protection before the
   * request that staged it changed it. A later request in the chat keeps it
   * protected while the agent's own change stands (see loweredEarlier).
   */
  lowered?: string;
  after?: Snapshot;
}

export interface HeldChangeSet {
  set: InboxAgentChangeSet;
  items: Map<string, HeldItem>;
  /** Destination folder id, for `move`. */
  folderId?: string;
  /** For `move`: the destination is an Inbox, so undoing it takes mail out of the Inbox. */
  toInbox?: boolean;
  /** Accounts where applying created the label: Undo deletes it there again. */
  createdLabelIn?: string[];
  /**
   * The user approved rows of it on its card (for an auto-applied set: its
   * protected rest), so the agent may not undo it without asking again.
   */
  userApproved?: boolean;
  busy: boolean;
}

const MOVES = new Set<InboxAgentChangeAction>(['archive', 'trash', 'restore', 'move', 'spam', 'not_spam']);
/**
 * Actions that take mail out of the user's sight or attention, so the
 * protections apply: mark read, archive, Trash, move (to any folder), spam,
 * and snooze (hidden until it wakes, up to a year).
 */
const GUARDED = new Set<InboxAgentChangeAction>(['mark_read', 'archive', 'trash', 'move', 'spam', 'snooze']);
/** Actions that change more than the emails (the filter learns, a sender is listed): they always ask. */
export const STANDING_ACTIONS: ReadonlySet<InboxAgentChangeAction> = new Set(['spam', 'not_spam']);
/**
 * Actions whose Undo always hides mail again: it marks read, moves back to
 * Trash, or snoozes again. A move and a snooze hide mail on Undo only for
 * some rows (see undoHides).
 */
const HIDING_UNDO: ReadonlySet<InboxAgentChangeAction> = new Set(['mark_unread', 'restore', 'unsnooze']);
/** Folder roles out of the user's sight: a message moved back into one is hidden again. */
const OUT_OF_SIGHT_ROLES = new Set(['trash', 'archive', 'spam']);
/** Actions that lower a message's own protection without hiding it, so they apply at once under "Approve for me". */
export const LOWERING_ACTIONS: ReadonlySet<InboxAgentChangeAction> = new Set(['unstar', 'remove_category']);

const VERBS: Record<InboxAgentChangeAction, [string, string]> = {
  mark_read: ['Mark', 'read'], mark_unread: ['Mark', 'unread'], star: ['Star', ''], unstar: ['Unstar', ''],
  archive: ['Archive', ''], trash: ['Move', 'to Trash'], restore: ['Restore', 'from Trash'], move: ['Move', 'to'],
  add_category: ['Add', 'to'], remove_category: ['Remove', 'from'],
  add_label: ['Label', ''], remove_label: ['Remove label from', ''], snooze: ['Snooze', ''], unsnooze: ['Unsnooze', ''],
  spam: ['Report', 'as spam'], not_spam: ['Mark', 'as not spam'],
};

export function changeSummary(action: InboxAgentChangeAction, count: number, target?: string): string {
  const [verb, tail] = VERBS[action];
  const noun = `${count} ${count === 1 ? 'email' : 'emails'}`;
  if (action === 'add_category') return `Add ${noun} to category ${target}`;
  if (action === 'remove_category') return `Remove ${noun} from category ${target}`;
  if (action === 'move') return `Move ${noun} to ${target}`;
  if (action === 'add_label') return `Label ${noun} "${target}"`;
  if (action === 'remove_label') return `Remove label "${target}" from ${noun}`;
  if (action === 'snooze') return `Snooze ${noun} until ${target}`;
  return [verb, noun, tail].filter(Boolean).join(' ');
}

/** Categories a user may file mail into without it meaning "keep this in sight". */
const SOFT_CATEGORIES = new Set(['promotions', 'social', 'updates', 'forums']);

/** Whether an action takes mail out of the user's sight, so that every protection applies to it. */
export function hidesMail(action: InboxAgentChangeAction): boolean {
  return GUARDED.has(action);
}

type ProtectedEmail = Pick<EmailRecord, 'tags' | 'subject' | 'fromAddress'> & Partial<EmailRecord>;

/**
 * The protections the user can turn on by hand, on the email's own flags:
 * starred, important (the user's flag or the provider's), and a category the
 * user chose that is not a soft one. They are what can change between staging
 * a set and approving it, so applyChangeSet checks them again.
 */
export function flagProtection(email: Pick<EmailRecord, 'tags'> & Partial<EmailRecord>): string | undefined {
  const tags = email.tags || '||';
  if (hasTag(tags, 'starred')) return 'Starred';
  if (hasTag(tags, 'important') || email.gmailImportant === true || email.manualImportant === true) return 'Marked important';
  const classification = existingCategoryClassification(email as EmailRecord);
  if (classification?.source === 'user' && classification.categories.some(category => !SOFT_CATEGORIES.has(category))) return 'In a category you chose';
  return undefined;
}

/** Recorded for mail whose body was never stored (IDLE added it without one): the content gates had nothing to read. */
export const NOT_DOWNLOADED = 'Its content has not been downloaded, so it was not checked';
/** Recorded for mail with attached files: no protection reads them. */
export const ATTACHMENTS_UNCHECKED = 'Attachments were not checked';

/**
 * Why this message must not be hidden without the user ticking it, or
 * undefined, whatever the action. The user's flags (flagProtection), a
 * calendar invitation, encrypted mail nobody could read, the unread review's
 * content gates (security codes, bank and card records, invoices, contracts,
 * business reports) checked on whatever body is stored, and, as the review
 * did, mail whose body was never stored or whose files nobody read.
 */
export function emailProtection(email: ProtectedEmail, body: string): string | undefined {
  const flagged = flagProtection(email);
  if (flagged) return flagged;
  if (email.calendarIcs) return 'A calendar invitation';
  if (email.pgpStatus === 'encrypted') return 'Encrypted: its content was not checked';
  const content = unreadReviewContentProtections(email, body)[0];
  if (content) return content;
  if (!email.rawBody?.trim() && (email.hasBody === false || !body.trim())) return NOT_DOWNLOADED;
  if (email.hasAttachments === true || parseAttachmentNames(email.attachmentNames).length > 0) return ATTACHMENTS_UNCHECKED;
  return undefined;
}

/** Why a message should not be changed this way without the user ticking it, or undefined: an action that hides nothing needs no tick. */
export function changeProtection(action: InboxAgentChangeAction, email: ProtectedEmail, body: string): string | undefined {
  return hidesMail(action) ? emailProtection(email, body) : undefined;
}

/** How recent a reply of the user's makes a conversation "ongoing". */
const ONGOING_SECONDS = 30 * 86_400;
/** Mail providers whose domain says nothing about a team. */
const PUBLIC_DOMAINS = new Set(['gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'yahoo.com', 'icloud.com', 'me.com', 'proton.me', 'protonmail.com', 'aol.com']);

export interface ConversationGuardStorage {
  /** The shared address book: its favourite flag. */
  getContacts(options: { search: string; limit: number; offset: number }): Promise<Array<Pick<ContactRecord, 'email' | 'isFavorite'>>>;
  /** The account's own sender record: the VIP flag the sender panel and the agent's change_sender set. */
  getSenderStats?(email: string): Promise<{ isVip?: boolean } | null>;
  getEmailsByThread?(threadId: string): Promise<EmailRecord[]>;
}

/** The sender and conversation protections for one account; see createConversationGuard. */
export type ConversationGuard = (action: InboxAgentChangeAction, email: Pick<EmailRecord, 'fromAddress' | 'threadId' | 'id'>) => Promise<string | undefined>;

/**
 * The protections that need more than the email itself, as the unread review
 * had them: a favourite or VIP sender (the shared address book's favourite, or
 * this account's own VIP record), and a conversation the user is in (a reply
 * of theirs in the last 30 days, or mail from a colleague at their own
 * company's domain). Lookups are cached per sender and conversation; one that
 * fails protects, never the other way round.
 */
export function createConversationGuard(input: { storage: ConversationGuardStorage; ownAddresses: string[]; nowMs: number }): ConversationGuard {
  const own = new Set(input.ownAddresses.map(value => value.trim().toLowerCase()).filter(Boolean));
  const domains = new Set([...own].map(value => value.split('@')[1] ?? '').filter(domain => domain && !PUBLIC_DOMAINS.has(domain)));
  const isOwn = (address: string | null | undefined) => own.has((address ?? '').trim().toLowerCase());
  const colleague = (address: string | null | undefined) => {
    const value = (address ?? '').trim().toLowerCase();
    return !own.has(value) && domains.has(value.split('@')[1] ?? '');
  };
  const senders = new Map<string, Promise<string | undefined>>();
  const threads = new Map<string, Promise<string | undefined>>();
  const since = Math.floor(input.nowMs / 1000) - ONGOING_SECONDS;
  const sender = (address: string) => {
    const key = address.trim().toLowerCase();
    if (!senders.has(key)) {
      senders.set(key, Promise.all([
        input.storage.getContacts({ search: key, limit: 20, offset: 0 }),
        input.storage.getSenderStats ? input.storage.getSenderStats(key) : null,
      ]).then(([rows, stats]) => rows.some(row => row.email.toLowerCase() === key && row.isFavorite) || stats?.isVip === true ? 'A favorite or VIP sender' : undefined)
        .catch(() => 'The sender could not be checked'));
    }
    return senders.get(key)!;
  };
  const thread = (threadId: string) => {
    if (!threads.has(threadId)) {
      threads.set(threadId, (input.storage.getEmailsByThread ? input.storage.getEmailsByThread(threadId) : Promise.resolve([]))
        .then(members => members.some(member => isOwn(member.fromAddress) && member.date >= since) || members.some(member => colleague(member.fromAddress))
          ? 'A conversation you are part of' : undefined)
        .catch(() => 'The conversation could not be checked'));
    }
    return threads.get(threadId)!;
  };
  return async (action, email) => {
    if (!hidesMail(action)) return undefined;
    if (colleague(email.fromAddress)) return 'A conversation you are part of';
    if (email.fromAddress && !isOwn(email.fromAddress)) {
      const reason = await sender(email.fromAddress);
      if (reason) return reason;
    }
    return email.threadId ? thread(email.threadId) : undefined;
  };
}

export interface StageTarget {
  accountId: string;
  accountEmail: string;
  email: EmailRecord;
  folders: FolderRecord[];
  reason?: string;
  protectedReason?: string;
  /** For a spam verdict: the sender's lists now. */
  sender?: InboxAgentSpamRevert['sender'];
  /** For an unstar or a category removal: the protection this request lowers (HeldItem.lowered). */
  lowered?: string;
}

function snapshot(email: EmailState): Snapshot {
  return { tags: email.tags || '||', folderId: email.folderId, snoozeUntil: email.snoozeUntil ?? null, verdict: email.spamUserVerdict ?? null };
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
  labelName?: string;
  createsLabelIn?: string[];
  /** For `snooze`: when (unix seconds), and how the card says it. */
  snooze?: { until: number; text: string };
  note?: string;
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
    const primary = target.folders.find(folder => folder.id === target.email.folderId);
    const outOfSight = !inbox && !!primary && OUT_OF_SIGHT_ROLES.has(classifyFolder(primary) ?? '');
    items.set(item.id, { item, before: snapshot(target.email), originFolderId: inbox?.id ?? target.email.folderId, originIsInbox: !!inbox,
      ...(outOfSight ? { originOutOfSight: true } : {}), ...(target.sender ? { sender: target.sender } : {}),
      ...(target.lowered ? { lowered: target.lowered } : {}) });
  });
  const target = input.action === 'move' ? input.folder?.path : input.action === 'snooze' ? input.snooze?.text
    : input.action === 'add_label' || input.action === 'remove_label' ? input.labelName : input.category;
  const standing = STANDING_ACTIONS.has(input.action) || !!input.createsLabelIn?.length;
  const set: InboxAgentChangeSet = {
    id, label: input.label, action: input.action,
    ...(input.folder ? { folder: input.folder.path } : {}), ...(input.category ? { category: input.category } : {}),
    ...(input.labelName ? { labelName: input.labelName } : {}), ...(input.createsLabelIn?.length ? { createsLabelIn: [...input.createsLabelIn] } : {}),
    ...(input.snooze ? { snoozeUntil: input.snooze.until } : {}), ...(standing ? { standing: true } : {}), ...(input.note ? { note: input.note } : {}),
    summary: changeSummary(input.action, items.size, target),
    createdAt: input.nowMs, approveBy: input.nowMs + INBOX_AGENT_CHANGE_LIMITS.approveMs, undoBy: 0,
    status: 'pending', items: [...items.values()].map(held => held.item),
  };
  const toInbox = input.action === 'move' && !!input.folder && classifyFolder(input.folder) === 'inbox';
  return { set, items, ...(input.folder ? { folderId: input.folder.id } : {}), ...(toInbox ? { toInbox: true } : {}), busy: false };
}

/**
 * Start a set's approval window when its card reaches the user (the run's
 * answer is delivered), not when the run staged it: a long run must not spend
 * the user's time. Staging keeps a provisional stamp, which the run's own
 * auto-apply checks. Only a set still waiting for a decision (pending, or an
 * auto-applied set whose protected rows wait) is touched, and a window is
 * never shortened.
 */
export function openApprovalWindow(held: HeldChangeSet, nowMs: number): void {
  if (held.set.status !== 'pending' && held.set.status !== 'partial') return;
  held.set.approveBy = Math.max(held.set.approveBy, nowMs + INBOX_AGENT_CHANGE_LIMITS.approveMs);
}

/** Why a change waits for the user's card instead of applying at once. */
export type AutoApplyWait = 'approval' | 'standing' | 'protected' | 'cap';

/**
 * The one rule for whether a run may change `count` emails without a card:
 * only under "Approve for me", never a standing change, never nothing but
 * protected mail, and within the per-request cap (`autoApplied`: what this
 * request already changed without one). change_mail and undo_change both
 * decide by it.
 */
export function autoApplyWait(input: { mode: InboxAssistantActionMode; standing?: boolean; count: number; autoApplied: number }): AutoApplyWait | undefined {
  if (input.mode !== 'approve_for_me') return 'approval';
  if (input.standing) return 'standing';
  if (!input.count) return 'protected';
  return input.autoApplied + input.count > INBOX_AGENT_CHANGE_LIMITS.autoApplyPerRun ? 'cap' : undefined;
}

/** Why the agent's undo of a set waits for the user's Undo on its card. */
export type AgentUndoWait = 'approval' | 'standing' | 'approved' | 'hides' | 'account' | 'cap';

/** Rows Undo can still put back: applied, or saved to sync. */
export const isChanged = (item: InboxAgentChangeItem) => item.status === 'applied' || item.status === 'queued';

/**
 * Whether undoing this row would take mail out of the user's sight again:
 * mark it read, put it back in Trash, snooze it again or for longer, or move
 * it out of the Inbox or back into Trash, Archive or Spam. Decided from what
 * the undo would do to the row (see inverse), not from the set's action name.
 */
export function undoHides(held: HeldChangeSet, item: Pick<InboxAgentChangeItem, 'id'>): boolean {
  const { action } = held.set;
  if (HIDING_UNDO.has(action)) return true;
  const entry = held.items.get(item.id);
  if (!entry) return false;
  // Undo snoozes it back to its earlier time: later than this set's is longer out of sight.
  if (action === 'snooze') return !!entry.before.snoozeUntil && entry.before.snoozeUntil > (held.set.snoozeUntil ?? 0);
  // Undo moves it back where it was (inverse's default).
  if (action === 'move') return !entry.originIsInbox && (!!held.toInbox || !!entry.originOutOfSight);
  return false;
}

/**
 * Why the agent may not undo this set on its own, or undefined when it may.
 * An undo the model asks for is a change like any other and follows the same
 * approval rules: in "Ask for approval" it always waits; under "Approve for
 * me" it may run at once only for a set the agent itself applied without a
 * card, in an account this request selected, within the per-request cap.
 * It waits when undoing touches more than the emails (a spam verdict's sender
 * lists, a label the set created), when the user decided the set on its card,
 * and when undoing any row would hide mail again (undoHides: protections are
 * not checked on Undo).
 */
export function agentUndoWait(held: HeldChangeSet, input: { mode: InboxAssistantActionMode; autoApplied: number; accountIds: string[] }): AgentUndoWait | undefined {
  const rows = held.set.items.filter(isChanged);
  const wait = autoApplyWait({ mode: input.mode, standing: held.set.standing, count: rows.length, autoApplied: input.autoApplied });
  if (wait === 'approval' || wait === 'standing') return wait;
  if (!held.set.autoApplied || held.userApproved) return 'approved';
  if (rows.some(item => undoHides(held, item))) return 'hides';
  if (rows.some(item => !input.accountIds.includes(item.accountId))) return 'account';
  return wait === 'cap' ? 'cap' : undefined;
}

/** The `on` value an action sets, for flag, category and label actions. */
function flagValue(action: InboxAgentChangeAction): boolean {
  return action === 'mark_read' || action === 'star' || action === 'add_category' || action === 'add_label';
}

/** Whether a message is still exactly as this set left it (`after`), so Undo may put it back. */
function inState(action: InboxAgentChangeAction, held: HeldChangeSet, email: EmailState, after: Snapshot): boolean {
  const tags = email.tags || '||';
  switch (action) {
    case 'mark_read': case 'mark_unread': return hasTag(tags, 'read') === flagValue(action);
    case 'star': case 'unstar': return hasTag(tags, 'starred') === flagValue(action);
    case 'add_category': case 'remove_category': return hasTag(tags, held.set.category!) === flagValue(action);
    case 'add_label': case 'remove_label': return hasTag(tags, held.set.labelName!) === flagValue(action);
    // Snoozed again by the user for another time is the user's change.
    case 'snooze': return hasTag(tags, 'snoozed') && (email.snoozeUntil ?? null) === after.snoozeUntil;
    case 'unsnooze': return !hasTag(tags, 'snoozed');
    case 'spam': case 'not_spam': return email.folderId === after.folderId && hasTag(tags, 'spam') === hasTag(after.tags, 'spam');
    default: return email.folderId === after.folderId;
  }
}

/** One step a set (or its Undo) runs over a group of rows. */
interface Step { action: InboxAgentChangeAction | 'revert_spam'; folderId?: string; until?: number | null }

async function run(actions: InboxAgentMailActions, held: HeldChangeSet, step: Step, accountId: string, ids: string[]): Promise<AssistantReadReceipt> {
  switch (step.action) {
    case 'mark_read': case 'mark_unread': return actions.setRead(accountId, ids, flagValue(step.action));
    case 'star': case 'unstar': return actions.setStarred(accountId, ids, flagValue(step.action));
    case 'add_category': case 'remove_category': return actions.setCategory(accountId, ids, held.set.category!, flagValue(step.action));
    case 'add_label': case 'remove_label': return actions.setLabel(accountId, ids, held.set.labelName!, flagValue(step.action));
    case 'snooze': return actions.setSnooze(accountId, ids, step.until ?? held.set.snoozeUntil!);
    case 'unsnooze': return actions.setSnooze(accountId, ids, null);
    case 'spam': return actions.spamVerdict(accountId, ids, 'spam');
    case 'not_spam': return actions.spamVerdict(accountId, ids, 'ham');
    case 'revert_spam': {
      const rows = new Map([...held.items.values()].filter(entry => entry.item.accountId === accountId).map(entry => [entry.item.emailId, entry]));
      return actions.revertSpamVerdict(accountId, ids.map(id => {
        const entry = rows.get(id)!;
        return { emailId: id, tags: entry.before.tags, folderId: entry.before.folderId, verdict: entry.before.verdict, ...(entry.sender ? { sender: entry.sender } : {}) };
      }));
    }
    case 'archive': return actions.move(accountId, ids, 'archive');
    case 'trash': return actions.move(accountId, ids, 'trash');
    case 'restore': return actions.restore(accountId, ids);
    case 'move': return actions.move(accountId, ids, { folderId: step.folderId! });
  }
}

/** A set's status from its rows, once no row waits for a decision. */
function settle(held: HeldChangeSet): void {
  const items = held.set.items;
  if (held.set.status === 'cancelled' || items.some(item => item.status === 'pending')) return;
  if (items.some(item => item.status === 'failed')) held.set.status = 'partial';
  else if (items.some(isChanged)) held.set.status = 'applied';
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
      let current: EmailState | null;
      try { current = await options.readEmail(entry.item.accountId, entry.item.emailId); }
      catch { entry.item.status = 'failed'; entry.item.detail = 'Its account could not be opened.'; continue; }
      if (!current) { entry.item.status = 'skipped'; entry.item.detail = 'It no longer exists.'; continue; }
      if (MOVES.has(set.action) && current.folderId !== entry.before.folderId) {
        entry.item.status = 'skipped'; entry.item.detail = 'It was moved after the change was prepared.'; continue;
      }
      // Protection is decided at staging and only ever added: a row the user
      // flagged since (starred it, marked it important) is protected now and is
      // hidden only if the user ticks it. A row the user ticked is their call.
      const flagged = hidesMail(set.action) && (!wanted || options.auto) ? flagProtection(current) : undefined;
      if (flagged) {
        entry.item.protectedReason = flagged;
        // Auto-apply leaves it pending on the card, as any protected row.
        if (!options.auto) { entry.item.status = 'skipped'; entry.item.detail = 'Protected since it was prepared.'; }
        continue;
      }
      ready.push(entry);
    }
    // A new label is created in each account just before its first email gets
    // it. If that fails, the account's rows fail and nothing is labelled there.
    const blocked = new Set<string>();
    if (set.action === 'add_label' && set.createsLabelIn?.length) {
      for (const accountId of new Set(ready.map(entry => entry.item.accountId))) {
        if (!set.createsLabelIn.includes(accountId) || held.createdLabelIn?.includes(accountId)) continue;
        try {
          if (await options.actions.createLabel(accountId, set.labelName!)) held.createdLabelIn = [...(held.createdLabelIn ?? []), accountId];
        } catch { blocked.add(accountId); }
      }
    }
    for (const entry of ready) if (blocked.has(entry.item.accountId)) { entry.item.status = 'failed'; entry.item.detail = 'The label could not be created. Approve again to retry.'; }
    const outcome = await grouped(ready.filter(entry => !blocked.has(entry.item.accountId)), (accountId, ids) => run(options.actions, held, { action: set.action, folderId: held.folderId }, accountId, ids), options.signal);
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
    else held.userApproved = true;
    if ([...held.items.values()].some(entry => isChanged(entry.item))) set.undoBy = options.nowMs + INBOX_AGENT_CHANGE_LIMITS.undoMs;
    // Auto-apply leaves protected rows pending on the card; the set stays open for them.
    if (!options.auto || ![...held.items.values()].some(entry => entry.item.status === 'pending')) settle(held);
    else set.status = 'partial';
  } finally { held.busy = false; }
}

export function cancelChangeSet(held: HeldChangeSet): void {
  if (held.busy) throw new InboxAgentChangeError('These changes are being applied.');
  if (!['pending', 'partial'].includes(held.set.status)) throw new InboxAgentChangeError('These changes can no longer be cancelled.');
  for (const { item } of held.items.values()) if (item.status === 'pending') { item.status = 'skipped'; item.detail = 'Cancelled.'; }
  if (held.set.status === 'pending' || !held.set.items.some(isChanged)) held.set.status = 'cancelled';
  else settle(held);
}

/** The step that puts a row back, and where. */
function inverse(action: InboxAgentChangeAction, entry: HeldItem): Step {
  switch (action) {
    case 'add_label': return { action: 'remove_label' };
    case 'remove_label': return { action: 'add_label' };
    case 'snooze': return entry.before.snoozeUntil ? { action: 'snooze', until: entry.before.snoozeUntil } : { action: 'unsnooze' };
    case 'unsnooze': return entry.before.snoozeUntil ? { action: 'snooze', until: entry.before.snoozeUntil } : { action: 'unsnooze' };
    case 'spam': case 'not_spam': return { action: 'revert_spam' };
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
    const plans = new Map<string, Step & { entries: HeldItem[] }>();
    for (const entry of held.items.values()) {
      const { item } = entry;
      if ((item.status !== 'applied' && item.status !== 'queued') || (wanted && !wanted.has(item.id))) continue;
      options.signal?.throwIfAborted();
      let current: Pick<EmailRecord, 'tags' | 'folderId'> | null = null;
      try { current = await options.readEmail(item.accountId, item.emailId); } catch { /* Treated as changed. */ }
      if (!current || !entry.after || !inState(set.action, held, current, entry.after)) {
        item.detail = 'Changed since; left as it is now.';
        continue;
      }
      const back = inverse(set.action, entry);
      const key = `${back.action}\0${back.folderId ?? ''}\0${back.until ?? ''}`;
      const plan = plans.get(key) ?? { ...back, entries: [] };
      plan.entries.push(entry);
      plans.set(key, plan);
    }
    for (const plan of plans.values()) {
      const outcome = await grouped(plan.entries, (accountId, ids) => run(options.actions, held, plan, accountId, ids), options.signal);
      for (const [entry, result] of outcome) {
        if (result === 'failed') entry.item.detail = 'Could not be undone. Try Undo again.';
        else { entry.item.status = 'undone'; delete entry.item.detail; }
      }
    }
    // A label this set created goes again once none of its emails keeps it.
    for (const accountId of held.createdLabelIn ?? []) {
      if (set.items.some(item => item.accountId === accountId && isChanged(item))) continue;
      try { await options.actions.dropLabel(accountId, set.labelName!); held.createdLabelIn = held.createdLabelIn!.filter(id => id !== accountId); }
      catch { /* The label stays; the emails are back as they were. */ }
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
