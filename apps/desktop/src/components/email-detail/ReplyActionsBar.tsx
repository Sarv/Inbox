import { Forward, Reply, ReplyAll, type LucideIcon } from 'lucide-react';
import type { MouseEvent, Ref } from 'react';

import { IconButton } from '../Tooltip';

import { messageAccessibleName } from './utils';

/** The three ways to answer a message, in the order every surface shows them. */
export interface ReplyActionHandlers {
  onReply: () => void;
  onReplyAll: () => void;
  onForward: () => void;
}

/**
 * One definition of the three actions, drawn two ways: as the labelled row under
 * a message (`ReplyActionsBar`) and as the icon cluster on a chat bubble
 * (`ReplyQuickActions`). `label` is the row's visible text, `name` the icon's
 * tooltip and accessible name — the row has always said "Reply All", and the
 * toolbar and the menus say "Reply all".
 */
const REPLY_ACTIONS: readonly {
  handler: keyof ReplyActionHandlers;
  label: string;
  name: string;
  Icon: LucideIcon;
}[] = [
  { handler: 'onReply', label: 'Reply', name: 'Reply', Icon: Reply },
  { handler: 'onReplyAll', label: 'Reply All', name: 'Reply all', Icon: ReplyAll },
  { handler: 'onForward', label: 'Forward', name: 'Forward', Icon: Forward },
];

/**
 * A click handler that runs `action` and goes no further. These controls sit on
 * surfaces that react to clicks of their own — a reply card toggles open and
 * shut when clicked, a chat bubble is a selection surface — so a reply that
 * also collapsed the card it was opened from would open a composer under a card
 * that just closed.
 */
const only = (action: () => void) => (event: MouseEvent<HTMLButtonElement>) => {
  event.stopPropagation();
  action();
};

const BAR_BUTTON_CLASS =
  'flex items-center gap-2 px-3 py-1.5 hover:bg-accent rounded-md transition-colors text-sm font-medium';

interface ReplyActionsBarProps extends ReplyActionHandlers {
  /**
   * The row's own box. Required, because every placement draws a different one:
   * the anchor card's shaded footer, the divider under an expanded reply, the
   * end of the chat. The buttons inside are identical everywhere.
   */
  className: string;
  /** The row's element — the chat scrolls it into view (React 19 passes `ref`
   *  to a function component as a plain prop). */
  ref?: Ref<HTMLDivElement>;
}

/**
 * The Reply / Reply All / Forward row under a message.
 *
 * It was written out by hand under the anchor card and again under each reply,
 * and the chat view needs a third. What each button DOES stays with the caller
 * on purpose: Forward from the anchor card opens the popup composer, from a reply
 * or the chat it opens inline — and a shared component that picked one would
 * silently change the other.
 */
export function ReplyActionsBar({ className, ref, ...handlers }: ReplyActionsBarProps) {
  return (
    <div ref={ref} role="group" aria-label="Reply actions" className={className}>
      {REPLY_ACTIONS.map(({ handler, label, Icon }) => (
        <button key={handler} type="button" onClick={only(handlers[handler])} className={BAR_BUTTON_CLASS}>
          <Icon className="h-4 w-4" />
          {label}
        </button>
      ))}
    </div>
  );
}

interface ReplyQuickActionsProps extends ReplyActionHandlers {
  /** The message these icons answer. It names the group: every bubble's
   *  buttons are called "Reply", "Reply all" and "Forward" — as are the row at
   *  the end and the toolbar's, which answer the NEWEST message — so the group
   *  is what tells a listener which message these ones answer. */
  message: Parameters<typeof messageAccessibleName>[0];
}

/**
 * Reply, Reply all and Forward as icons, for one chat bubble's corner.
 *
 * Icon-only, so each carries the shared Tooltip and an `aria-label` (both from
 * `IconButton`). No shortcut hints: the keyboard shortcuts answer the NEWEST
 * message, and a hint on an older bubble's icon would promise a key that does
 * something else. The cluster brings its own background because the chat view
 * hangs half of it below the bubble's edge, over whatever is beneath.
 */
export function ReplyQuickActions({ message, ...handlers }: ReplyQuickActionsProps) {
  return (
    <div
      role="group"
      aria-label={`Reply actions for ${messageAccessibleName(message)}`}
      className="flex items-center gap-0.5 p-0.5 rounded-md border border-border bg-card text-muted-foreground shadow-sm"
    >
      {REPLY_ACTIONS.map(({ handler, name, Icon }) => (
        <IconButton
          key={handler}
          size="xs"
          tooltip={name}
          icon={<Icon className="h-3.5 w-3.5" />}
          onClick={only(handlers[handler])}
          className="hover:text-foreground"
        />
      ))}
    </div>
  );
}
