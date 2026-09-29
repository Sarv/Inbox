/**
 * Which content the chat view is allowed to show, when it may offer to start
 * an extraction, and whether a message's remote images load.
 *
 * Kept out of the component on purpose: these decisions are the difference
 * between "the AI view shows AI output" and "the AI view shows raw mail
 * wearing an AI badge", and rules that important should be unit-testable
 * without mounting a thread, a store and an IPC bridge.
 */
import type { EmailRecord } from '@sarvinbox/core';

import { qualifiesForSafeAutoLoad, shouldAutoLoadRemoteImages } from '../../store/helpers';

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

/**
 * Whether the Reply / Reply All / Forward row closes the conversation.
 *
 * - Only while the chat IS the reading surface (`chatViewActive`). The chat can
 *   also mount beside the standard card (a single designed mail with a quoted
 *   history, before the reader picks chat), and that card carries the same row
 *   in its own footer — two identical rows, one under each copy of the mail.
 * - Only under actual bubbles. With none, the view shows placeholders, the
 *   "Process now" invitation or its empty text; a row of reply buttons under
 *   "this thread hasn't been processed yet" answers a message nobody can see.
 * - Never while a reply or forward is open. The composer opens in this same
 *   spot, at the end of the conversation, so the row would sit on top of the
 *   box its own buttons opened.
 */
export function shouldShowEndReplyBar({
  chatViewActive,
  renderedCount,
  composerOpen,
}: {
  chatViewActive: boolean;
  renderedCount: number;
  composerOpen: boolean;
}): boolean {
  return chatViewActive && renderedCount > 0 && !composerOpen;
}

/**
 * Whether the chat view mounts the open reply or forward box, rather than the
 * standard card above it.
 *
 * EmailDetail mounts the box for the thread's first message under that card
 * whenever the chat is NOT the reading surface — and the chat can still be on
 * screen then (a single designed mail with a quoted history, before the reader
 * picks chat). Both mounting it put two composers on one reply, each
 * autosaving a draft of its own, under one element id the focus-and-scroll
 * lookup then picks between. EmailDetail mounts the box exactly when this is
 * false (it reads this same rule), so one of the two always takes it and never
 * both.
 */
export function chatMountsComposer({
  chatViewActive,
  targetId,
  anchorId,
}: {
  chatViewActive: boolean;
  /** The message the box is open on. */
  targetId: string;
  /** The thread's first message — the one the standard card shows. */
  anchorId: string | undefined;
}): boolean {
  return chatViewActive || targetId !== anchorId;
}

/**
 * Whether the chat view must withhold this message's remote images.
 *
 * The library blocks everything unless the host says otherwise, and it cannot
 * see the reader's setting — so the app answers for it, per message, using the
 * SAME rule the classic card uses ({@link shouldAutoLoadRemoteImages}). Two
 * renderers disagreeing about one mail is the bug this exists to prevent.
 *
 * A bubble whose source mail is not in the thread map gets blocked: no sender
 * means no allowlist check and no category, so the safe answer is to ask.
 *
 * Unlike its neighbours this reads settings rather than being pure, which is
 * exactly why it is a named function and not an inline arrow at the call site.
 */
export function blockRemoteImagesFor(email: EmailRecord | undefined): boolean {
  if (!email) return true;
  return !shouldAutoLoadRemoteImages(email.fromAddress, qualifiesForSafeAutoLoad(email.tags));
}
