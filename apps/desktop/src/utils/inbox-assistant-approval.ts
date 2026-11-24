import type { InboxAssistantActionMode } from '../types/inbox-assistant';
import type { InboxAgentChangeAction } from '../types/inbox-assistant-changes';

/**
 * What "Approve for me" covers: the one source for what the agent may change
 * without a card, the words the user agrees to, and the record of that
 * agreement. Shared by the main process (which enforces it) and the renderer
 * (which describes it), so the cap and the list a user consented to are the
 * ones applied. Type imports only: safe for both sides.
 */

/** Messages "Approve for me" may change in one request without a card (change_mail and the agent's own undo together). */
export const INBOX_AGENT_AUTO_APPLY_PER_REQUEST = 200;

/** How long an applied change keeps its Undo. */
export const INBOX_AGENT_UNDO_HOURS = 24;

/**
 * The change_mail actions that may apply without a card. Everything else
 * change_mail can do (a spam verdict) always asks, as do a new label, a
 * protected email, a filter and a sender change.
 */
export const APPROVE_FOR_ME_ACTIONS = [
  'mark_read', 'mark_unread', 'star', 'unstar', 'archive', 'trash', 'restore', 'move',
  'add_category', 'remove_category', 'add_label', 'remove_label', 'snooze', 'unsnooze',
] as const satisfies readonly InboxAgentChangeAction[];

/**
 * The meaning of "Approve for me" a chat's consent was given for, saved with
 * it. Derived from the list and the cap, so widening either one makes every
 * chat ask first again, with no version number to remember to bump.
 */
export const APPROVE_FOR_ME_SCOPE = `agent-1:${INBOX_AGENT_AUTO_APPLY_PER_REQUEST}:${APPROVE_FOR_ME_ACTIONS.join(',')}`;

/** What each action mode does, in the words the control and its confirmation show. */
export const ACTION_MODE_DESCRIPTION: Record<InboxAssistantActionMode, string> = {
  review: 'Inbox Agent prepares each change on a card and changes nothing until you approve it.',
  approve_for_me: 'In this conversation, Inbox Agent applies the mail changes you ask for right away: mark read or unread, star or unstar, '
    + 'archive, move to Trash or back, move to a folder, add or remove a category or label, snooze or wake. '
    + `Up to ${INBOX_AGENT_AUTO_APPLY_PER_REQUEST} emails per request, each change with Undo on its card for ${INBOX_AGENT_UNDO_HOURS} hours. `
    + 'Still asks first: marking read, moving or snoozing protected emails (security codes, financial records, starred or important mail, VIP senders, conversations you are in), '
    + 'spam reports, new labels, filters and sender changes. It never sends mail or deletes permanently.',
};
