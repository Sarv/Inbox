/**
 * What the AI did to one email, kept on the email's own row (`emails.ai_actions`).
 *
 * Pure (zero imports): the renderer reads the same record through the
 * `@sarvinbox/core/ai-actions` alias to draw the AI icon and its tooltip.
 *
 * A record names the kind of change, when, and whether it was automatic (the
 * background agent, or the Inbox Agent's "Approve for me") or approved by the
 * user on a card. It never holds mail text, a label name, a folder or a reply:
 * the row is read into every list, and the tooltip must not need any of it.
 */

export type AiActionKind =
  | 'read' | 'unread' | 'star' | 'unstar'
  | 'archive' | 'trash' | 'restore' | 'move'
  | 'label' | 'unlabel' | 'category' | 'important'
  | 'snooze' | 'unsnooze' | 'spam' | 'not_spam'
  | 'draft' | 'sent';

export interface AiAction {
  kind: AiActionKind;
  /** Unix seconds. */
  at: number;
  /** True: applied without the user approving this change. */
  auto: boolean;
}

/** Newest kept per email. An email the AI keeps acting on keeps its latest story. */
export const MAX_AI_ACTIONS_PER_EMAIL = 8;

const DESCRIPTIONS: Record<AiActionKind, string> = {
  read: 'Marked as read',
  unread: 'Marked as unread',
  star: 'Starred',
  unstar: 'Unstarred',
  archive: 'Archived',
  trash: 'Moved to Trash',
  restore: 'Restored from Trash',
  move: 'Moved to a folder',
  label: 'Added a label',
  unlabel: 'Removed a label',
  category: 'Changed its category',
  important: 'Marked important',
  snooze: 'Snoozed',
  unsnooze: 'Woke it from snooze',
  spam: 'Reported as spam',
  not_spam: 'Marked as not spam',
  draft: 'Drafted a reply',
  sent: 'Sent a reply',
};

export const AI_ACTION_KINDS = Object.keys(DESCRIPTIONS) as AiActionKind[];

/**
 * Kinds that put the AI icon on a list row. A category change does not: the
 * AI sorts nearly every email, so an icon for it would be on every row and
 * mean nothing. It is still recorded and counted.
 */
export function aiActionShowsIcon(kind: AiActionKind): boolean {
  return kind !== 'category';
}

export function isAiActionKind(value: unknown): value is AiActionKind {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(DESCRIPTIONS, value);
}

/** What the AI did, in a few words ("Marked as read"). */
export function describeAiAction(kind: AiActionKind): string {
  return DESCRIPTIONS[kind];
}

/**
 * The stored record, tolerant of anything: a missing, damaged or foreign value
 * reads as no actions rather than throwing in the middle of drawing a list.
 */
export function parseAiActions(raw: unknown): AiAction[] {
  let value: unknown = raw;
  if (typeof raw === 'string') {
    if (!raw) return [];
    try { value = JSON.parse(raw); } catch { return []; }
  }
  if (!Array.isArray(value)) return [];
  const actions: AiAction[] = [];
  for (const item of value.slice(-MAX_AI_ACTIONS_PER_EMAIL)) {
    if (!item || typeof item !== 'object') continue;
    const { kind, at, auto } = item as Record<string, unknown>;
    if (!isAiActionKind(kind) || typeof at !== 'number' || !Number.isFinite(at)) continue;
    actions.push({ kind, at: Math.floor(at), auto: auto === true });
  }
  return actions;
}

/** The record with one more action at the end, as the column stores it. */
export function appendAiAction(raw: unknown, action: AiAction): string {
  return JSON.stringify([...parseAiActions(raw), action].slice(-MAX_AI_ACTIONS_PER_EMAIL));
}

/**
 * The record without the newest action of `kind` (an Undo), or null when
 * nothing is left, so the column goes back to empty.
 */
export function removeLatestAiAction(raw: unknown, kind: AiActionKind): string | null {
  const actions = parseAiActions(raw);
  for (let index = actions.length - 1; index >= 0; index--) {
    if (actions[index]!.kind === kind) { actions.splice(index, 1); break; }
  }
  return actions.length ? JSON.stringify(actions) : null;
}

/** The actions that earn a list row its AI icon, newest last. */
export function iconAiActions(actions: readonly AiAction[] | undefined): AiAction[] {
  return (actions ?? []).filter(action => aiActionShowsIcon(action.kind));
}

/**
 * The kind an agent action logged to `user_action_log` stands for. `reply`
 * is a drafted reply unless the pipeline marked it 'auto-sent'. Null: not
 * something the AI did to this email (open, ignore, mute…).
 */
export function aiActionKindForLoggedAction(actionType: string, actionValue?: string | null): AiActionKind | null {
  switch (actionType) {
    case 'read': case 'unread': case 'star': case 'unstar': case 'archive':
    case 'spam': case 'move': case 'snooze': case 'unsnooze': case 'important':
      return actionType;
    case 'delete': return 'trash';
    case 'label_add': return 'label';
    case 'label_remove': return 'unlabel';
    case 'reply': case 'reply_all': return actionValue === 'auto-sent' ? 'sent' : 'draft';
    default: return null;
  }
}
