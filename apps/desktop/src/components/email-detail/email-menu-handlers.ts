import { useEmailStore } from '../../store/email-store';

import type { EmailMenuHandlers } from './EmailMenu';
import type { ReplyActionHandlers } from './ReplyActionsBar';
import type { EmailDetailContext } from './types';

/**
 * How Forward opens from a surface: the popup composer (the standard view's
 * cards and toolbar) or inline, under the message (the chat, which has its own
 * composer at the end of the conversation).
 */
export type ForwardMode = 'popup' | 'inline';

/**
 * What Delete and Archive remove: this one message (a reply in the list, a chat
 * bubble), or the whole conversation (the anchor card and the toolbar, which
 * stand for it).
 */
export type RemoveScope = 'message' | 'thread';

export interface EmailMenuWiring {
  forward: ForwardMode;
  removes: RemoveScope;
}

/** The part of the detail context the message menu reaches for. */
export type EmailMenuContext = Pick<
  EmailDetailContext,
  | 'handleReply'
  | 'handleReplyAll'
  | 'handleForward'
  | 'handleInlineForward'
  | 'handleDelete'
  | 'handleArchive'
  | 'deleteEmail'
  | 'archiveEmail'
  | 'markAsRead'
  | 'handleReportSpam'
  | 'handlePrintEmail'
  | 'handleDownloadEmail'
  | 'handleShowOriginal'
  | 'handleFilterLikeThis'
  | 'handleTranslate'
  | 'handleDetectSignature'
>;

/**
 * Reply, Reply all and Forward for one message. Reply and Reply all open inline
 * everywhere (`false`: not the popup); Forward goes the surface's way.
 */
export function buildReplyHandlers(
  ctx: EmailMenuContext,
  email: { id: string },
  forward: ForwardMode,
): ReplyActionHandlers {
  return {
    onReply: () => ctx.handleReply(email, false),
    onReplyAll: () => ctx.handleReplyAll(email, false),
    onForward: forward === 'inline' ? () => ctx.handleInlineForward(email) : () => ctx.handleForward(email),
  };
}

/**
 * Every handler the message menu takes, for one message.
 *
 * The same thirteen lines were written out at each of the menu's four homes
 * (a reply in the list, the anchor card, the toolbar, a chat bubble) and the
 * chat now adds a fifth, its right-click menu. Copies drift: one of them
 * forwarding the other way, or deleting the conversation where the others
 * delete the message, is a menu that means different things in different
 * places. What legitimately differs between them is exactly `wiring`.
 */
export function buildEmailMenuHandlers(
  ctx: EmailMenuContext,
  email: { id: string },
  { forward, removes }: EmailMenuWiring,
): EmailMenuHandlers {
  return {
    ...buildReplyHandlers(ctx, email, forward),
    onDelete: removes === 'thread' ? () => ctx.handleDelete() : () => ctx.deleteEmail(email.id),
    onArchive: removes === 'thread' ? () => ctx.handleArchive() : () => ctx.archiveEmail(email.id),
    // Then the message closes, as it always has from this menu — and only once
    // the flag is written, so a failed write leaves the reader where they were.
    onMarkUnread: async () => {
      await ctx.markAsRead(email.id, false);
      useEmailStore.getState().clearSelectedEmail();
    },
    onReportSpam: () => ctx.handleReportSpam(email.id),
    onPrint: () => ctx.handlePrintEmail(email),
    onDownload: () => ctx.handleDownloadEmail(email),
    onShowOriginal: () => ctx.handleShowOriginal(email),
    onFilterLikeThis: () => ctx.handleFilterLikeThis(email),
    onTranslate: () => ctx.handleTranslate(email),
    onDetectSignature: () => ctx.handleDetectSignature(email),
  };
}
