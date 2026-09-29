import { MailChatView, type ChatMessage, type MessageMenuRequest } from '@sarv-in/email-chat-view';
import type { EmailRecord } from '@sarvinbox/core';
import { createLogger } from '@sarvinbox/core/logger';
import { Loader2, RefreshCw, Sparkles, Star } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';

import { useAppearance, useResolvedTheme } from '../../appearance';
import { buildPolishThreadContext, getCurrentUserEmail } from '../../services/ai-service';
import type { ConversationMessage } from '../../services/conversation-service';
import { resolveRefsInHtml } from '../../services/image-cache';
import { useEmailStore } from '../../store/email-store';
import { writeClipboard } from '../../utils/clipboard';
import { applyEmailDarkMode, DARK_PAPER } from '../../utils/email-dark-mode';
import { toForwardSource } from '../../utils/forward-quote';
import type { MenuAnchor } from '../../utils/menu-placement';
import { openExternalLink } from '../../utils/open-external';
import { hasTag } from '../../utils/tags';
import { AttachmentPills } from '../attachment-viewer/AttachmentPills';
import { InlineForward } from '../InlineForward';
import { InlineReply } from '../InlineReply';
import { IconButton } from '../Tooltip';

import { frameCanvasFor, type RecoloredBody } from './chat-frame-canvas';
import {
  carrierEmailOf,
  chatMessagesFromConversation,
  chatMessagesFromThread,
  ownerEmailOf,
} from './chat-message-adapter';
import {
  blockRemoteImagesFor,
  chatMountsComposer,
  chatSourceFor,
  shouldShowEndReplyBar,
  shouldShowProcessPrompt,
} from './chat-view-rules';
import { buildEmailMenuHandlers, buildReplyHandlers, type EmailMenuWiring } from './email-menu-handlers';
import { EmailMenu, EmailMenuPopover, type EmailMenuHandlers } from './EmailMenu';
import { messageMenuLeadingItems, type MessageMenuTarget } from './message-menu-items';
import { ReplyActionsBar, ReplyQuickActions } from './ReplyActionsBar';
import { SecurityIndicator } from './SecurityIndicator';
import type { EmailDetailContext } from './types';
import { hasLoadedBody, messageAccessibleName, parseAttachments } from './utils';
import { VerifiedBadge } from './VerifiedBadge';

// getCurrentUserEmail used to live here; it moved to ai-service so
// EmailDetail can share it (priority: IMAP username > profile email > fallback).

const log = createLogger('ThreadChatView');

/**
 * The right-click menu's Copy, Copy link and Copy email address.
 *
 * Stateless, where the copy buttons use `useCopyToClipboard`: the menu has
 * closed by the time the write settles, so there is no button left to say
 * "Copied" on — and that hook's state would re-render the whole thread (every
 * bubble) twice per copy to show nothing. A write the browser refuses is not
 * swallowed, though: it lands in the log, where a "copy did nothing" report
 * can be traced.
 */
function copyFromMenu(text: string): void {
  void writeClipboard(text).then((copied) => {
    if (!copied) log.warn('Copy from the message menu did not reach the clipboard');
  });
}

/**
 * The chat's message menu: Forward opens inline (the chat has its own composer,
 * at the end of the conversation), and Delete / Archive act on the one message
 * a bubble shows — never the conversation around it.
 */
const CHAT_MENU_WIRING: EmailMenuWiring = { forward: 'inline', removes: 'message' };

/** An open right-click menu: whose message, where, and over what. */
interface PointMenu extends MessageMenuTarget {
  emailId: string;
  anchor: Extract<MenuAnchor, { kind: 'point' }>;
}

/**
 * How many bubbles are allowed in the DOM at once.
 *
 * A 200-message thread is an ordinary support escalation, and every bubble
 * with a designed body costs a whole sandboxed document. The rest sit behind
 * the view's own "Show N earlier messages" button — nothing is lost, it is
 * just not laid out until asked for.
 */
const MAX_RENDERED_BUBBLES = 40;

interface ThreadChatViewProps {
  ctx: EmailDetailContext;
}

export function ThreadChatView({ ctx }: ThreadChatViewProps) {
  const {
    displayEmail,
    threadEmails,
    conversationMessages,
    conversationLoading,
    conversationError,
    conversationProgress,
    showAIView,
    setShowAIView,
    handleRetryConversation,
    handleReExtractMessage,
    handleReply,
    handleReplyAll,
    handleInlineForward,
    showInlineReply,
    inlineReplyMode,
    setInlineReplyMode,
    replyingToEmail,
    inlineReplyDraft,
    handleCloseInlineReply,
    showInlineForward,
    forwardingEmail,
    inlineForwardDraft,
    handleCloseInlineForward,
    chatViewActive,
  } = ctx;

  // A run is in flight when loading (cold open, pre-first-bubbles) OR
  // when progressive counters are live (loading flips false as soon as
  // the first bubbles render, but progress stays non-null to the end).
  const extractionInFlight = conversationLoading || conversationProgress != null;

  const currentUserEmail = useMemo(
    () => getCurrentUserEmail(displayEmail?.toAddress || ''),
    [displayEmail?.toAddress],
  );

  const emailsById = useMemo(
    () => new Map(threadEmails.map((email) => [email.id, email])),
    [threadEmails],
  );

  // Bodies that permanently failed to fetch — so chat bubbles show a Retry
  // affordance instead of an endless "Loading content…" spinner.
  const failedBodies = useEmailStore((s) => s.failedBodies);
  const retryBody = useCallback((emailId: string) => {
    // fetchEmailBody skips ids already in failedBodies, so clear it first.
    useEmailStore.setState((s) => {
      const next = new Set(s.failedBodies);
      next.delete(emailId);
      return { failedBodies: next };
    });
    useEmailStore.getState().fetchEmailBody(emailId);
  }, []);

  // The LLM-extracted turns, when the AI view is the one on screen. Standard
  // has none: it is the library's deterministic split, which produces chat
  // messages directly and needs no ConversationMessage of its own.
  const aiMessages: ConversationMessage[] | undefined = showAIView
    ? conversationMessages || undefined
    : undefined;

  // Dark message bodies are opt-in (Appearance -> "Dark email bodies"). The
  // chat frame takes its canvas from the app's theme, but nothing used to
  // re-colour the mail inside it: a sender's `color:black` stayed black on that
  // dark canvas, and a `background:white` painted a white slab across the
  // bubble. `useAppearance` and `useResolvedTheme` both re-render on a change,
  // so flipping the setting or the theme re-splits the open thread.
  const { darkenEmails } = useAppearance();
  const resolvedTheme = useResolvedTheme();
  const isDark = resolvedTheme === 'dark';
  const recolorBody = useMemo(
    () =>
      (html: string): RecoloredBody => {
        const result = applyEmailDarkMode(html, { enabled: darkenEmails, isDark });
        return { html: result.html, canvas: frameCanvasFor(result, isDark) };
      },
    [darkenEmails, isDark],
  );

  const chatMessages = useMemo<ChatMessage[]>(() => {
    const options = {
      currentUserEmail,
      emailsById,
      failedBodies,
      resolveImages: resolveRefsInHtml,
      recolorBody,
    };
    switch (chatSourceFor(showAIView, aiMessages?.length ?? 0)) {
      // Only what the LLM actually extracted — see `chatSourceFor` for why
      // there is no fallback to the deterministic split here.
      case 'ai':
        return chatMessagesFromConversation(aiMessages!, options);
      // `@sarv-in/email-chat-view` splits the thread's own mails into one bubble per
      // message — quotes, signatures and banners stripped, and the messages
      // that exist only as quotes inside other mails recovered. All of that
      // lives in the library now; the app just hands it stored rows.
      case 'thread':
        return chatMessagesFromThread(threadEmails, options);
      case 'none':
        return [];
    }
  }, [showAIView, aiMessages, threadEmails, currentUserEmail, emailsById, failedBodies, recolorBody]);

  // Per-message extraction state, keyed the way the view hands messages back.
  // AI-only: a deterministic split has no extraction to fail.
  const conversationById = useMemo(() => {
    const map = new Map<string, ConversationMessage>();
    for (const message of aiMessages || []) map.set(message.id, message);
    return map;
  }, [aiMessages]);

  // The thread-level "needs attention" state (orange reload icon) reflects
  // whether any message ACTUALLY failed AI cleanup — i.e. a message showing a
  // per-message re-extract affordance. Computed over the SAME set the view
  // renders (drafts already dropped by the adapter), so a draft whose cleanup
  // fell back to the heuristic cannot turn the icon orange with no visible
  // message to act on. conversationPartial also flips true for benign
  // truncation, which isn't a per-message failure, so it deliberately doesn't
  // colour on that.
  const hasFailedMessage = useMemo(
    () => chatMessages.some((message) => conversationById.get(message.id)?.extractionFailed),
    [chatMessages, conversationById],
  );

  // AI view with nothing extracted: offer the extraction rather than bubbles.
  // Deliberately NOT gated on `conversationPartial` any more — a thread the
  // pipeline never touched at all is not "partial", and that gate was why the
  // prompt stayed hidden while the fallback quietly rendered Standard's
  // bubbles here instead.
  const showProcessPrompt = shouldShowProcessPrompt({
    showAIView,
    extractionInFlight,
    conversationLoading,
    renderedCount: chatMessages.length,
  });

  // Whole-thread transcript for AI polish of the inline reply. Memoized on the
  // thread data so it is NOT rebuilt on every keystroke or unrelated ctx change
  // while the user types their reply.
  const polishThreadContext = useMemo(
    () => buildPolishThreadContext({ conversationMessages, threadEmails, currentUserEmail }),
    [conversationMessages, threadEmails, currentUserEmail],
  );

  // NOT `emailsById.get(message.sourceId)`: on a bubble recovered from a quote
  // that is the mail which QUOTED it, so the actions and the attachment strip
  // below would belong to a different message than the one being read. See
  // `ownerEmailOf` — a quote simply has no email to act on, and gets neither.
  const emailFor = useCallback(
    (message: ChatMessage) => ownerEmailOf(message, emailsById),
    [emailsById],
  );

  /**
   * How one bubble's message is answered — from the same builder as its menus,
   * so the hover icons, the three-dot menu and the right-click menu answer it
   * the same way. Copies would drift (the menu's Forward turned into the popup,
   * say) and leave the icons doing the old thing.
   */
  const replyHandlersFor = useCallback(
    (email: EmailRecord) => buildReplyHandlers(ctx, email, CHAT_MENU_WIRING.forward),
    [ctx],
  );

  /** Everything one bubble's menu does — its three-dot menu and its right-click
   *  menu alike, so the two can never disagree about a message. */
  const menuHandlersFor = useCallback(
    (email: EmailRecord): EmailMenuHandlers => buildEmailMenuHandlers(ctx, email, CHAT_MENU_WIRING),
    [ctx],
  );

  // ─── The right-click menu ──────────────────────────────────────────────────
  //
  // ONE menu for the whole thread, opened at the pointer. It renders outside
  // MailChatView, which remounts on a theme change (see its `key`): a menu
  // inside it would vanish mid-use, and one per bubble would be forty menus.
  const [pointMenu, setPointMenu] = useState<PointMenu | null>(null);
  const closePointMenu = useCallback(() => setPointMenu(null), []);
  const pointEmail = pointMenu ? emailsById.get(pointMenu.emailId) : undefined;

  // Its message left the thread (deleted, moved, the thread switched): close it
  // for good, rather than let it spring back if a reload returns the message.
  useEffect(() => {
    if (pointMenu && !pointEmail) setPointMenu(null);
  }, [pointMenu, pointEmail]);

  /**
   * A right-click anywhere in a bubble opens the same menu as the bubble's
   * three-dot button, for the same message — `emailFor`, so a bubble recovered
   * from a quote (no mail of its own, and no three-dot button either) declines,
   * and the library leaves the right-click alone.
   */
  const onMessageMenu = useCallback(
    (message: ChatMessage, request: MessageMenuRequest) => {
      const email = emailFor(message);
      if (!email) return false;
      setPointMenu({
        emailId: email.id,
        anchor: { kind: 'point', x: request.clientX, y: request.clientY },
        href: request.href,
        selectionText: request.selectionText,
      });
      return true;
    },
    [emailFor],
  );

  const renderActions = useCallback(
    (message: ChatMessage) => {
      const email = emailFor(message);
      if (!email) return null;
      return (
        <BubbleActions
          email={email}
          isStarred={hasTag(email.tags, 'starred')}
          onToggleStar={(starred) => useEmailStore.getState().markMessageStarred(email.id, starred)}
          extractionFailed={!!conversationById.get(message.id)?.extractionFailed}
          onReExtract={
            showAIView && handleReExtractMessage
              ? () => handleReExtractMessage(message.id)
              : undefined
          }
          {...menuHandlersFor(email)}
        />
      );
    },
    [emailFor, conversationById, showAIView, handleReExtractMessage, menuHandlersFor],
  );

  /**
   * Reply, Reply all and Forward on the bubble's bottom corner, on hover —
   * answering THIS bubble's message, not the newest (the bar at the end and
   * the keyboard shortcuts do that).
   *
   * `emailFor`, so a bubble recovered from a quote gets none: it has no mail of
   * its own, and replying to the mail that quoted it would address someone
   * else. The answer depends on the message alone, never on UI state such as an
   * open composer: the library re-mounts a bubble whose answer flips between
   * nothing and something, and a framed body reloads with it.
   */
  const renderQuickActions = useCallback(
    (message: ChatMessage) => {
      const email = emailFor(message);
      if (!email) return null;
      return <ReplyQuickActions message={email} {...replyHandlersFor(email)} />;
    },
    [emailFor, replyHandlersFor],
  );

  // The row that closes the conversation — see `shouldShowEndReplyBar`.
  const showEndReplyBar = shouldShowEndReplyBar({
    chatViewActive,
    renderedCount: chatMessages.length,
    composerOpen: (showInlineReply && !!replyingToEmail) || (showInlineForward && !!forwardingEmail),
  });

  // The library remounts on these two (see the `key` on MailChatView), and a
  // remount scrolls it to its last bubble again.
  const chatViewKey = `${resolvedTheme}:${darkenEmails}`;
  const lastChatMessageId = chatMessages[chatMessages.length - 1]?.id;

  /**
   * Keep the end row in view when the library follows the conversation down.
   *
   * MailChatView scrolls its OWN bottom into view whenever the last message
   * changes — and the row sits after it, below the view's padding, so every
   * thread opened with the row the reader asked for just under the fold. This
   * effect runs after the library's (a child's effects run first), so it lands
   * last. Not while a composer is open: the row is not drawn then, and the
   * composer's own open scrolls to it.
   */
  const endReplyBarRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!showEndReplyBar) return;
    // Optional call: not every DOM implements scrollIntoView (the library
    // guards its own call the same way).
    endReplyBarRef.current?.scrollIntoView?.({ block: 'end' });
  }, [showEndReplyBar, lastChatMessageId, chatViewKey]);

  // The open reply / forward box mounts here unless the standard card above
  // already mounts it — see `chatMountsComposer`.
  const mountsReplyHere =
    showInlineReply &&
    !!replyingToEmail &&
    chatMountsComposer({ chatViewActive, targetId: replyingToEmail.id, anchorId: displayEmail?.id });
  const mountsForwardHere =
    showInlineForward &&
    !!forwardingEmail &&
    chatMountsComposer({ chatViewActive, targetId: forwardingEmail.id, anchorId: displayEmail?.id });

  /**
   * The attachment strip for each bubble, rendered by the app rather than by
   * the library (whose own strip chat-view-theme.css hides).
   *
   * The library draws its chips as plain `<span>`s with no identity and no slot
   * to replace them, so reaching one meant delegating off its class name and
   * recovering the filename from a `title` attribute. That worked, but left the
   * pill unreachable by keyboard and left "this is clickable" to the mouse
   * cursor alone — no tooltip, because a tooltip needs an element we own.
   * `AttachmentPills` renders real buttons, so both come for free.
   *
   * Deliberately NOT the phishing warning, and no longer the shield either.
   * The warning belongs to the standard view (EmailCard, ThreadList), which is
   * where a reader checks who a mail is really from; a banner under every
   * bubble turns the chat into a wall of warnings and is how people learn to
   * ignore the one that matters. The shield moved to the header — see
   * `renderHeaderMeta`.
   */
  const renderFooter = useCallback(
    (message: ChatMessage) => {
      const email = emailFor(message);
      if (!email) return null;
      const attachments = parseAttachments(email.attachmentNames, email.attachmentSizes);
      if (attachments.length === 0) return null;
      return (
        <div className="mt-1.5">
          <AttachmentPills
            emailId={email.id}
            accountId={(email as { accountId?: string }).accountId}
            attachments={attachments}
          />
        </div>
      );
    },
    [emailFor],
  );

  /**
   * The per-message security marks, on the header line after the timestamp.
   *
   * They used to sit under the body, on a row of their own next to the
   * sender's address. Two things were wrong with that: a mark that JUDGES the
   * message read as part of what the sender wrote, and the address was already
   * on the line above — the header names the sender, and hovering it gives the
   * full From/To/Cc. So the marks moved up to the metadata line, where a reader
   * is already looking to answer "who is this from", and the duplicate address
   * went.
   *
   * The shield renders for every message, green through red, with the evidence
   * on hover — the same icon that sits beside the sender in the standard view.
   * A follow-up in a sender run has no header of its own and still gets it:
   * the library gives it a meta-only row, because the sender and the time are
   * inherited from the bubble above but a per-message verdict is not.
   */
  const renderHeaderMeta = useCallback(
    (message: ChatMessage) => {
      const email = emailFor(message);
      if (!email) return null;
      return (
        <>
          <SecurityIndicator
            fromName={email.fromName}
            fromAddress={email.fromAddress}
            html={email.rawBody}
            bodyLoaded={hasLoadedBody(email)}
            authStatus={email.authStatus}
            spamScore={email.spamScore}
            spamReasons={email.spamReasons}
          />
          <VerifiedBadge email={email.fromAddress} authStatus={email.authStatus} />
        </>
      );
    },
    [emailFor],
  );

  return (
    <div
      className="relative border border-border rounded-lg bg-card mt-2 pt-3"
      // The paper a re-coloured body is drawn on, for `chat-view-theme.css`.
      // Derived in JS (email-dark-mode.ts), so it is handed over as a token
      // rather than repeated there as a literal that could drift from it.
      style={{ '--sarv-dark-paper': DARK_PAPER } as CSSProperties}
    >
      {/* AI / Logical toggle — sits on the top border line. Always
          rendered so the user can switch to Standard mid-extraction;
          the re-extract icon only appears once messages exist. */}
      <div className="absolute -top-3 left-0 right-0 flex items-center justify-center z-10">
        {/* `isolate` keeps the frosted layer below inside the pill. */}
        <div className="group relative isolate flex items-center p-1 border border-border shadow-sm rounded-lg">
          {/* The frosted glass, on a layer of its own BEHIND the controls
              rather than on the pill itself. A `backdrop-filter` makes its
              element the containing block of every `position: fixed`
              descendant — and the Tooltip is one, placed in viewport
              coordinates. On the pill, the re-extract icon's tooltip landed
              offset by the pill's own position, far from the icon. */}
          <div
            aria-hidden
            data-pill-backdrop
            className="absolute inset-0 -z-10 rounded-lg bg-muted/70 group-hover:bg-muted/90 backdrop-blur-md transition-colors"
          />
          {/* Animated pill background — Standard sits LEFT (default), AI right. */}
          <div
            className={`absolute top-1 bottom-1 w-[82px] bg-background rounded-md shadow-[0_1px_3px_rgba(0,0,0,0.1)] border border-border/50 transition-all duration-300 ease-out z-0 ${showAIView ? 'left-[83px]' : 'left-1'
              }`}
          />
          <button
            onClick={() => setShowAIView(false)}
            className={`relative z-10 flex items-center justify-center w-[80px] gap-1.5 py-1 rounded-md text-xs font-semibold transition-colors duration-300 ${!showAIView
                ? 'text-foreground'
                : 'text-muted-foreground hover:text-foreground'
              }`}
          >
            Standard
          </button>
          <button
            onClick={() => setShowAIView(true)}
            className={`relative z-10 flex items-center justify-center w-[80px] gap-1.5 py-1 rounded-md text-xs font-semibold transition-colors duration-300 ml-1 ${showAIView
                ? 'text-violet-600 dark:text-violet-400'
                : 'text-muted-foreground hover:text-foreground'
              }`}
          >
            <Sparkles className="h-3.5 w-3.5" />
            AI View
          </button>
          {showAIView && conversationMessages && (
            <div className="relative z-10 flex items-center border-l border-border/50 ml-1 pl-1">
              <IconButton
                size="sm"
                // Its tint IS its state (orange: some message needs AI), so
                // it draws its own hover rather than the ghost one.
                variant="bare"
                tooltip={
                  conversationLoading
                    ? 'Extracting…'
                    : hasFailedMessage
                      ? 'Some messages need AI processing — click to extract again'
                      : 'Re-extract conversation'
                }
                onClick={handleRetryConversation}
                disabled={conversationLoading}
                className={`flex items-center justify-center rounded-md transition-all duration-200 ${
                  hasFailedMessage && !conversationLoading
                    ? 'text-orange-500 hover:text-orange-600 hover:bg-orange-500/10'
                    : 'text-muted-foreground hover:bg-accent/80 hover:text-foreground'
                }`}
                icon={
                  <RefreshCw
                    className={`h-3 w-3 ${
                      conversationLoading
                        ? 'animate-spin text-violet-500'
                        : hasFailedMessage
                          ? 'text-orange-500 hover:text-orange-600'
                          : ''
                    }`}
                  />
                }
              />
            </div>
          )}
        </div>
        {extractionInFlight && (
          <div className="flex items-center gap-1.5 ml-2 px-2 py-0.5 text-[11px] text-muted-foreground bg-card border border-border rounded-md">
            <Loader2 className="h-3 w-3 animate-spin text-violet-500" />
            <span className="font-medium tabular-nums">
              {conversationProgress && conversationProgress.total > 0
                ? `${conversationProgress.done}/${conversationProgress.total}`
                : 'Extracting…'}
            </span>
          </div>
        )}
        {conversationError && (
          <div className="flex items-center gap-1 ml-2">
            <span className="text-xs text-destructive bg-card px-2 py-0.5 rounded border border-border">{conversationError}</span>
            <button
              onClick={handleRetryConversation}
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground bg-card px-2 py-0.5 rounded border border-border transition-colors"
            >
              <RefreshCw className="h-3 w-3" />
              Retry
            </button>
          </div>
        )}
      </div>

      <MailChatView
        // The library reads a frame's theme tokens ONCE, when the frame mounts,
        // and bakes them into its document. Without a remount, flipping dark
        // bodies or the app theme re-renders the mail against the old tokens —
        // dark table rows on a white page. Keyed on exactly the two inputs
        // that change which canvas a body is drawn on. The library (0.2.5+)
        // re-reads its tokens when <html>/<body> attributes or the body change,
        // but a theme flip with dark bodies off changes neither the body nor
        // anything it watches in time: the canvas marker lands on the bubble,
        // possibly after its re-read. So the remount stays, scroll reset and all.
        key={chatViewKey}
        messages={chatMessages}
        currentUserAddress={currentUserEmail}
        loading={showAIView && conversationLoading && chatMessages.length === 0}
        maxRendered={MAX_RENDERED_BUBBLES}
        className="px-3 py-4"
        // The library blocks every remote image unless told otherwise, and it
        // has no way to know the reader's setting — so the app answers, per
        // message, with the same rule the classic card uses. Without this a
        // reader who chose "always load" still saw the banner here.
        // `carrierEmailOf`, not `emailFor`: this asks whose bytes these are, not
        // whose message it is. A recovered quote's images live in the reply that
        // carried it, so the reader's choice about THAT sender is the one to honour.
        blockRemoteImages={(message) => blockRemoteImagesFor(carrierEmailOf(message, emailsById))}
        // The shared rule (utils/open-external): a web link goes to the
        // browser; `#` jumps and `mailto:` links, in any case, open nothing.
        // A module function, so its identity never changes — see there.
        onOpenLink={openExternalLink}
        onRetryBody={(message) => {
          const email = emailFor(message);
          if (email) retryBody(email.id);
        }}
        // No `onPreviewAttachment` / `onDownloadAttachment`: passing either is
        // what draws the library's own chips, which the app replaces with its
        // own buttons (see renderFooter).
        onMessageMenu={onMessageMenu}
        renderActions={renderActions}
        renderQuickActions={renderQuickActions}
        renderHeaderMeta={renderHeaderMeta}
        renderFooter={renderFooter}
        emptyState={
          showProcessPrompt ? (
            <div className="flex flex-col items-center gap-2 py-8 text-center">
              <Sparkles className="h-5 w-5 text-violet-500" />
              <p className="text-xs text-muted-foreground max-w-xs">
                This thread hasn’t been processed with AI yet. Standard view has the
                full content in the meantime.
              </p>
              <button
                onClick={handleRetryConversation}
                className="text-xs font-medium text-primary hover:underline"
              >
                Process now
              </button>
            </div>
          ) : undefined
        }
      />

      {/* The right-click menu — out here, not in the view, so the view's
          remount leaves it be. Keyed by the request: a second right-click
          opens a fresh menu (placed, and focused) at the new point. */}
      {pointMenu && pointEmail && (
        <EmailMenuPopover
          key={`${pointMenu.emailId}:${pointMenu.anchor.x}:${pointMenu.anchor.y}`}
          anchor={pointMenu.anchor}
          onClose={closePointMenu}
          label={`Message actions for ${messageAccessibleName(pointEmail)}`}
          leadingItems={messageMenuLeadingItems(pointMenu, {
            copy: copyFromMenu,
            openLink: openExternalLink,
          })}
          {...menuHandlersFor(pointEmail)}
        />
      )}

      {/* The same row the standard view puts under a message. No email is
          passed, so it answers the NEWEST message — what the keyboard
          shortcuts and the toolbar's Reply answer too. Forward opens inline,
          here, like the reply. */}
      {showEndReplyBar && (
        <ReplyActionsBar
          ref={endReplyBarRef}
          // The standard footer's box, with the card's bottom corners: the
          // card cannot clip it (its toggle hangs above the top edge).
          className="px-4 py-3 border-t border-border bg-accent/10 rounded-b-lg flex items-center gap-2"
          onReply={() => handleReply()}
          onReplyAll={() => handleReplyAll()}
          onForward={() => handleInlineForward()}
        />
      )}

      {/* Inline Reply. ONE composer serves every bubble here (the standard
          view mounts one per card), so it is keyed by the message it answers:
          pointing it at another bubble mounts a fresh composer for that
          message. Unkeyed, it kept the first message's body and draft, and
          re-derived its recipients only when the sender changed. */}
      {mountsReplyHere && (
        <div id="inline-reply-compose" className="border-t border-border">
          <InlineReply
            key={replyingToEmail.id}
            replyToEmail={replyingToEmail}
            mode={inlineReplyMode}
            onClose={handleCloseInlineReply}
            onModeChange={setInlineReplyMode}
            embedded
            draft={inlineReplyDraft}
            threadContext={polishThreadContext || undefined}
          />
        </div>
      )}

      {/* Inline Forward — keyed for the same reason. Unkeyed, forwarding a
          second bubble APPENDED its attachments to the first one's. */}
      {mountsForwardHere && (
        <div id="inline-forward-compose" className="border-t border-border">
          <InlineForward
            key={forwardingEmail.id}
            forwardEmail={toForwardSource(forwardingEmail)}
            // What Undo send restored, so the forward reopens as it was sent.
            draft={inlineForwardDraft}
            onClose={handleCloseInlineForward}
            embedded
          />
        </div>
      )}
    </div>
  );
}

/**
 * The hover controls at a bubble's outer edge.
 *
 * The view reveals `.sec-actions` only on row hover or focus-within — and the
 * menu portals to `<body>` and takes focus, so once it is open the row has
 * neither, and the cluster would fade out from under its own open menu. The
 * pin that stops that lives in chat-view-theme.css, at the level the library
 * hides: an opacity set on a child of the hidden `.sec-actions` multiplies
 * with its 0 and can never show it.
 */
function BubbleActions({
  email,
  isStarred,
  onToggleStar,
  onReExtract,
  extractionFailed,
  ...menu
}: {
  email: EmailRecord;
  /** Read off `email.tags` by the caller, so the star reflects the same
   *  `|starred|` tag the list rows and the folder counts read. */
  isStarred: boolean;
  onToggleStar: (starred: boolean) => void;
  onReExtract?: () => void;
  /** This message's AI cleanup failed → tint the re-extract icon orange (like the
   *  thread-level reload) so an unprocessed message is visible at a glance. */
  extractionFailed?: boolean;
} & EmailMenuHandlers) {
  const [reExtracting, setReExtracting] = useState(false);

  const runReExtract = async () => {
    if (!onReExtract || reExtracting) return;
    setReExtracting(true);
    try {
      await onReExtract();
    } finally {
      setReExtracting(false);
    }
  };

  return (
    <div
      // Named for its message, like the reply icons: every bubble has a
      // "Star" and a menu, and nothing else says whose they are.
      role="group"
      aria-label={`Message actions for ${messageAccessibleName(email)}`}
      className="flex items-center gap-0.5"
    >
      {onReExtract && (
        <IconButton
          size="xs"
          // 'bare': the ghost look dims a disabled button, and while it runs
          // the spinning glyph IS the progress indicator.
          variant="bare"
          tooltip={
            reExtracting
              ? 'Re-extracting with AI…'
              : extractionFailed
                ? 'Process this message with AI'
                : 'Re-extract this message with AI'
          }
          onClick={(e) => { e.stopPropagation(); void runReExtract(); }}
          disabled={reExtracting}
          className="hover:bg-accent rounded transition-colors"
          icon={
            <RefreshCw
              className={`h-3.5 w-3.5 ${
                reExtracting
                  ? 'animate-spin text-violet-500'
                  : extractionFailed
                    ? 'text-orange-500 hover:text-orange-600'
                    : 'text-muted-foreground'
              }`}
            />
          }
        />
      )}
      {/* Named by what a click does ("Star" / "Unstar"), so no aria-pressed:
          a name that flips AND a pressed state would announce the change
          twice ("Unstar, pressed"). */}
      <IconButton
        size="xs"
        tooltip={isStarred ? 'Unstar' : 'Star'}
        onClick={(e) => {
          e.stopPropagation();
          onToggleStar(!isStarred);
        }}
        icon={
          <Star
            className={`h-3.5 w-3.5 ${isStarred ? 'fill-yellow-400 text-yellow-400' : 'text-muted-foreground'}`}
          />
        }
      />
      <EmailMenu email={email} {...menu} />
    </div>
  );
}
