import type { InboxAgentUndoRequest } from '../../types/inbox-assistant-changes';

/**
 * The line an earlier card carries when it is shown again under a later
 * answer, because the Inbox Agent undid it or asked to (an undo request). Only
 * the card's own Undo is offered there; nothing changes until the user clicks it.
 */
export function undoRequestNote(outcome: InboxAgentUndoRequest['outcome'], card: { canUndo: boolean; undone: boolean }): string | undefined {
  if (outcome === 'undone') return 'Undone for you.';
  if (card.canUndo) return 'Inbox Agent asked to undo this. Nothing changes until you click Undo.';
  // Undone since (the user clicked it): the card's own status says so.
  return card.undone ? undefined : 'This can no longer be undone from here.';
}
