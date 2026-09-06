/**
 * Which content the chat view is allowed to show, and when it may offer to
 * start an extraction.
 *
 * Pure on purpose: these two decisions are the difference between "the AI view
 * shows AI output" and "the AI view shows raw mail wearing an AI badge", and a
 * rule that important should be unit-testable without mounting a thread, a
 * store and an IPC bridge.
 */

/** Where the bubbles on screen come from. */
export type ChatSource =
  /** The LLM-extracted turns. */
  | 'ai'
  /** The library's deterministic split of the thread's own mails. */
  | 'thread'
  /** Nothing renders — AI view with nothing extracted yet. */
  | 'none';

/**
 * Pick the source for the current view.
 *
 * The AI view NEVER falls back to the deterministic split. A message the
 * pipeline has not processed is simply not rendered: two views showing
 * identical bubbles makes the toggle meaningless, hides which messages the LLM
 * actually handled, and makes an untouched thread look processed. Standard
 * still has the full content, so nothing is unreachable.
 */
export function chatSourceFor(showAIView: boolean, aiMessageCount: number): ChatSource {
  if (!showAIView) return 'thread';
  return aiMessageCount > 0 ? 'ai' : 'none';
}

/**
 * Whether to replace the empty view with the "Process now" invitation.
 *
 * Waiting states win: while an extraction is running, or the stored
 * conversation is still loading, the view shows its own progress rather than
 * inviting the reader to start work that is already under way.
 */
export function shouldShowProcessPrompt({
  showAIView,
  extractionInFlight,
  conversationLoading,
  renderedCount,
}: {
  showAIView: boolean;
  extractionInFlight: boolean;
  conversationLoading: boolean;
  renderedCount: number;
}): boolean {
  if (!showAIView || renderedCount > 0) return false;
  return !extractionInFlight && !conversationLoading;
}
