/**
 * Whether the chat view is offered and opens, what AI it may spend, which
 * turns it shows, and whether a message's remote images load.
 *
 * Kept out of the component on purpose: every site that used to decide "is
 * this a conversation?" on its own (the card, the thread section, the
 * List/Chat toggle, the composers, the prewarm, the AI trigger) now reads the
 * same answer, and rules that important should be unit-testable without
 * mounting a thread, a store and an IPC bridge.
 */
import type { EmailRecord } from '@sarvinbox/core';
import type { FirstSplitState } from '@sarvinbox/core/first-split';

import type { FirstSplitRunResult } from '../../services/first-split/store';
import { remoteImageFactsOf, shouldAutoLoadRemoteImages } from '../../utils/remote-images';

import { aiEligibilityFor, type AiEligibility, type FirstEmailFacts } from './ai-view-compose';

// The eligibility rule lives beside the facts it maps (pure, so the
// background job can read it without this module's settings imports), and is
// re-exported here with the rest of the chat rules.
export { aiEligibilityFor, type AiEligibility } from './ai-view-compose';

/** Everything {@link chatViewRulesFor} decides from. */
export interface ChatViewRulesInput {
  /** The thread's conversation members (drafts and Trash copies excluded). */
  memberCount: number;
  /** The first member's facts ({@link firstEmailFacts}). */
  facts: FirstEmailFacts;
  /** The thread is still loading (members not known yet). */
  loadingThread: boolean;
  /** The list row's message count for the selected email, while loading. */
  selectedThreadCount: number;
  /** Chat view is on (settings + provider, or the reader's toggle). */
  chatViewEnabled: boolean;
  /** The reader explicitly switched chat on for this email. */
  chatManuallyEnabled: boolean;
  /** A provider is configured and conversation mode is on. */
  aiAvailable: boolean;
  /** A split that may be shown exists for the first email. */
  usableSplit?: boolean;
}

/** The chat view's decisions for one open thread — every consumer reads these. */
export interface ChatViewRules {
  eligibility: AiEligibility;
  /** The List/Chat toggle is offered. */
  offerChat: boolean;
  /**
   * Chat IS the reading surface: the thread section renders ThreadChatView and
   * the standard card hides — never both.
   */
  chatActive: boolean;
  /**
   * The AI half of the Standard/AI pill is shown: the AI view can work
   * (`aiAvailable`) AND there is something for it — the first email quotes
   * history, or a usable split exists. A cached usable split is NOT shown
   * without a provider or with conversation mode off (plan §5): the reader
   * then gets Standard, and the split comes back with the provider.
   */
  showAiToggle: boolean;
  /** The first email may be split automatically (while chat is showing). */
  autoRunAI: boolean;
  /** The AI view can work at all (a provider, conversation mode on) — the input, echoed for the banner. */
  aiAvailable: boolean;
}

/**
 * The single place the chat view decides whether it is offered, whether it
 * opens by itself, and what AI it may spend.
 *
 *   * A thread of two or more members is a conversation: chat offered, and
 *     open whenever chat view is on.
 *   * A SINGLE email is offered chat only when it quotes history. Quoting two
 *     or more earlier messages (a looped-in chain) it opens as chat by itself;
 *     quoting ONE, it stays a card until the reader toggles chat on — a plain
 *     reply-with-quote is not worth reshaping unasked.
 *   * Designed bulk mail (the as-sent rule) is never offered chat on its own.
 *   * While the thread loads, chat pre-shows only when the list row already
 *     says the thread has more than one message — never for every email.
 */
export function chatViewRulesFor(input: ChatViewRulesInput): ChatViewRules {
  const eligibility = aiEligibilityFor(input.facts);
  const quotesHistory = eligibility === 'on_demand' || eligibility === 'auto';
  const single = input.memberCount === 1;
  const offerChat = input.memberCount > 1 || (single && quotesHistory);
  const chatActive = input.chatViewEnabled && (
    input.memberCount > 1
    || (single && (eligibility === 'auto' || (offerChat && input.chatManuallyEnabled)))
    || (input.loadingThread && input.selectedThreadCount > 1)
  );
  return {
    eligibility,
    offerChat,
    chatActive,
    showAiToggle: input.aiAvailable && (quotesHistory || input.usableSplit === true),
    autoRunAI: input.aiAvailable && eligibility === 'auto',
    aiAvailable: input.aiAvailable,
  };
}

/**
 * The banner over the first email's slot in the AI view, or null for none.
 *
 *   * `process` — no split yet: "Process now".
 *   * `running` — a split is in flight: a spinner and its status text.
 *   * `retry` — a transient failure that will be retried by itself: says so,
 *     and offers "Retry now".
 *   * `failed` — retrying will not help by itself: the reason and "Try again".
 *   * `resplit` — a split is showing and a provider can redo it: a compact
 *     "Re-split" line. None without a provider — a guard kept for any caller:
 *     the chat view itself never reaches it, since without a provider it does
 *     not show the AI view at all ({@link ChatViewRules.showAiToggle}).
 *
 * The rest of the thread renders under the banner regardless — the AI view is
 * Standard's bubbles with one slot replaced, so a missing split never blanks it.
 */
export type FirstSlotPrompt = 'process' | 'running' | 'retry' | 'failed' | 'resplit' | null;

export function firstSlotPromptFor(input: {
  /** The reader is on the AI half of the pill. */
  showAIView: boolean;
  /** A provider is configured and conversation mode is on. */
  aiAvailable: boolean;
  eligibility: AiEligibility;
  /** The cache's answer for the current key, or `unknown` while it is not known. */
  state: FirstSplitState | 'unknown';
  /** A run for this thread is in flight. */
  running: boolean;
  /** Automatic runs are allowed for this email ({@link ChatViewRules.autoRunAI}). */
  autoRunAI: boolean;
  /**
   * The session guard still lets an automatic run start for this key
   * (first-split store `automaticRunAllowed`). False once its automatic runs
   * kept persisting nothing: no retry will come by itself this session.
   */
  automaticRunAllowed: boolean;
}): FirstSlotPrompt {
  if (!input.showAIView) return null;
  if (input.state === 'usable') {
    // A run in flight is shown either way; Re-split is offered only where it
    // can succeed — with no provider (or conversation mode off) it could only
    // end in a provider failure that saves nothing.
    if (input.running) return 'running';
    return input.aiAvailable ? 'resplit' : null;
  }
  if (!input.aiAvailable) return null;
  if (input.running) return 'running';
  switch (input.state) {
    case 'due':
    case 'retry-later':
    case 'failed-retryable':
      // "Will retry by itself" is only true where automatic runs happen: a
      // single-quote email (`on_demand`) is never split unasked, so its
      // transient failure — or a 4xx under a provider since replaced — is the
      // reader's to retry. Nor is it true for a key the session guard has
      // stopped: its automatic runs will not start again this session.
      return input.autoRunAI && input.automaticRunAllowed ? 'retry' : 'failed';
    case 'failed':
      return 'failed';
    case 'miss':
    case 'skipped':
      return input.eligibility === 'on_demand' || input.eligibility === 'auto' ? 'process' : null;
    default:
      return null;
  }
}

/**
 * The banner's reason for a failed or retrying split, from the stored error
 * kind (core `FirstSplitErrorKind`; free text, so anything unknown reads as a
 * plain failure). Says what went wrong in the reader's terms — never a code.
 */
export function splitFailureReason(errorKind: string | null | undefined): string {
  switch (errorKind) {
    case 'rate_limit':
      return 'The AI provider is limiting requests right now.';
    case 'upstream':
    case 'server':
      return 'The AI provider had a server error.';
    case 'network':
      return 'The AI provider could not be reached.';
    case 'timeout':
      return 'The AI provider took too long to answer.';
    case 'empty':
    case 'unparseable':
      return 'The AI’s answer could not be read.';
    case 'client':
      return 'The AI provider refused the request.';
    case 'unusable':
      return 'The AI found no messages it could stand behind in the quoted history.';
    case 'too_large':
      return 'The quoted history is too large to split.';
    default:
      return 'The AI split did not work.';
  }
}

/**
 * The one line the banner adds after the reader's own run (Process now, Try
 * again, Retry now, Re-split) when that run changed nothing on screen — so a
 * click that failed does not look like a click that did nothing. Null when
 * the run persisted a row (the banner then shows that row's state and
 * reason) or had nothing to report.
 *
 *   * `kept` — main refused to replace the usable split shown (a failure, or
 *     a lesser partial, over it): the re-split failed and the split stays.
 *   * `stale` — the first email changed while it was split: nothing saved.
 *   * `provider` — no usable provider (auth, credit, none configured).
 *   * `error` / `invalid` — reading or saving the split failed.
 *   * `unknown` — main had no body to split under a key it vouches for.
 */
export function manualRunNoticeFor(result: FirstSplitRunResult | null | undefined): string | null {
  if (!result) return null;
  switch (result.state) {
    case 'saved': {
      if (result.save.applied) return null;
      if (result.save.reason === 'kept') {
        const status = result.outcome.status;
        return status === 'ok' || status === 'partial'
          ? 'The new split was not better than the one shown, so the previous split is kept.'
          : `Re-split failed. ${splitFailureReason(result.outcome.errorKind)} The previous split is kept.`;
      }
      if (result.save.reason === 'stale') {
        return 'The first email changed while it was being split, so nothing was saved.';
      }
      return 'The split could not be saved.';
    }
    case 'provider':
      return 'The AI provider could not be used, so nothing was split. Check its settings.';
    case 'error':
      return 'The split could not be run or saved.';
    case 'unknown':
      return 'The first email is not ready to split yet.';
    default:
      return null;
  }
}

/** Where the chat view's turns come from. */
export type ChatSource =
  /** Standard's turns, the first email's slot replaced by its AI split. */
  | 'ai'
  /** Standard's turns as they are — the library's deterministic split. */
  | 'thread';

/**
 * Where the chat view's turns come from: the AI composition when the reader
 * is on the AI half AND a usable split exists, Standard's own turns otherwise.
 *
 * There is no "nothing" source any more. The AI view used to render only what
 * a whole-thread extraction had produced, so an unprocessed thread showed an
 * empty pane and a thread whose extraction failed lost every later email. It
 * is now Standard's bubbles with ONE slot replaced (the first email's), so a
 * missing or failed split leaves that slot as Standard shows it and every
 * other email untouched.
 */
export function chatSourceFor(showAIView: boolean, usableSplit: boolean): ChatSource {
  return showAIView && usableSplit ? 'ai' : 'thread';
}

/**
 * Whether the Reply / Reply All / Forward row closes the conversation.
 *
 * - Only while the chat IS the reading surface (`chatViewActive`, the rules'
 *   `chatActive`). The standard card carries the same row in its own footer;
 *   were the chat ever on screen beside it, that would be two identical rows,
 *   one under each copy of the mail.
 * - Only under actual bubbles. With none (an empty thread) the view shows its
 *   empty text, and a row of reply buttons under it answers a message nobody
 *   can see.
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
 * whenever the chat is NOT the reading surface. Both mounting it put two
 * composers on one reply, each autosaving a draft of its own, under one element
 * id the focus-and-scroll lookup then picks between. EmailDetail mounts the box
 * exactly when this is false (it reads this same rule), so one of the two
 * always takes it and never both — whichever surfaces are on screen.
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
 * SAME rule the classic card uses ({@link shouldAutoLoadRemoteImages}), with
 * the same facts (`remoteImageFactsOf`: sender, tags, authentication, and the
 * message's own account — `viewAccountId` for thread rows that carry none).
 * Two renderers disagreeing about one mail is the bug this exists to prevent.
 *
 * A bubble whose source mail is not in the thread map gets blocked: no sender
 * means no allowlist check and no category, so the safe answer is to ask.
 *
 * Unlike its neighbours this reads settings and the trust caches rather than
 * being pure, which is exactly why it is a named function and not an inline
 * arrow at the call site — and why the caller subscribes to those caches
 * (ThreadChatView) so a bubble re-decides when one of them changes.
 */
export function blockRemoteImagesFor(email: EmailRecord | undefined, viewAccountId?: string | null): boolean {
  if (!email) return true;
  return !shouldAutoLoadRemoteImages(remoteImageFactsOf(email, viewAccountId));
}
