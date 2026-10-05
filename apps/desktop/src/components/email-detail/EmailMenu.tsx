import {
  Reply,
  ReplyAll,
  Forward,
  Trash2,
  Archive,
  MailOpen,
  MoreVertical,
  Printer,
  Download,
  AlertOctagon,
  ShieldAlert,
  Filter,
  Languages,
  Code,
  FileSignature,
  type LucideIcon,
} from 'lucide-react';
import {
  Fragment,
  useCallback,
  useEffect,
  useEffectEvent,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';

import { useClickAway } from '../../hooks/useClickAway';
import {
  currentViewport,
  placeMenu,
  scrollTopToReveal,
  type MenuAnchor,
} from '../../utils/menu-placement';
import { isModalAlertOpen } from '../../utils/modal-alert';
import { IconButton } from '../Tooltip';

/** What each of the menu's items does, for one message. */
export interface EmailMenuHandlers {
  onReply: () => void;
  onReplyAll: () => void;
  onForward: () => void;
  onDelete: () => void;
  onArchive: () => void;
  onMarkUnread: () => void;
  onReportSpam: () => void;
  onPrint: () => void;
  onDownload: () => void;
  onShowOriginal: () => void;
  onFilterLikeThis: () => void;
  onTranslate: () => void;
  onDetectSignature: () => void;
}

export interface EmailMenuProps extends EmailMenuHandlers {
  email: any;
  className?: string;
}

// ─── Items ────────────────────────────────────────────────────────────────────

/** An extra item, drawn above the message's own (Copy, Open link…). */
export interface MenuItem {
  id: string;
  label: string;
  icon: LucideIcon;
  onSelect: () => void;
}

const NOTHING = () => {};

/**
 * The message's items, in their sections. One table, so the three-dot menu and
 * a right-click menu can never list different things.
 */
const EMAIL_MENU_SECTIONS: readonly (readonly {
  label: string;
  Icon: LucideIcon;
  pick: (handlers: EmailMenuHandlers) => () => void;
}[])[] = [
  [
    { label: 'Reply', Icon: Reply, pick: (h) => h.onReply },
    { label: 'Reply all', Icon: ReplyAll, pick: (h) => h.onReplyAll },
    { label: 'Forward', Icon: Forward, pick: (h) => h.onForward },
  ],
  [
    { label: 'Delete', Icon: Trash2, pick: (h) => h.onDelete },
    { label: 'Archive', Icon: Archive, pick: (h) => h.onArchive },
    { label: 'Mark as unread', Icon: MailOpen, pick: (h) => h.onMarkUnread },
  ],
  [
    { label: 'Report spam', Icon: AlertOctagon, pick: (h) => h.onReportSpam },
    // Not wired to anything yet — it has never been. Kept where it was so this
    // split changes no behaviour; it closes the menu and does nothing else.
    { label: 'Report phishing', Icon: ShieldAlert, pick: () => NOTHING },
  ],
  [
    { label: 'Filter messages like this', Icon: Filter, pick: (h) => h.onFilterLikeThis },
    { label: 'Translate', Icon: Languages, pick: (h) => h.onTranslate },
    { label: 'Print', Icon: Printer, pick: (h) => h.onPrint },
    { label: 'Download message', Icon: Download, pick: (h) => h.onDownload },
    { label: 'Show original', Icon: Code, pick: (h) => h.onShowOriginal },
    { label: 'Detect Signature', Icon: FileSignature, pick: (h) => h.onDetectSignature },
  ],
];

/**
 * `focus-visible`, not `focus`: the menu focuses its first item on open, and
 * after a MOUSE open that item would stay lit while the pointer hovers another
 * — two highlighted rows. Chromium matches `:focus-visible` for that
 * programmatic focus only when the menu was opened (or is being walked) from
 * the keyboard, which is exactly when the reader needs to see it.
 */
const ITEM_CLASS =
  'w-full flex items-center gap-3 px-4 py-2 text-sm hover:bg-accent focus-visible:bg-accent focus:outline-none transition-colors text-left';

function Separator() {
  return <div role="separator" className="h-px bg-border my-1" />;
}

// ─── The dropdown ─────────────────────────────────────────────────────────────

export interface EmailMenuPopoverProps extends EmailMenuHandlers {
  anchor: MenuAnchor;
  /** Every way the menu closes ends here: a choice, a click away, Escape,
   *  a scroll or a resize. */
  onClose: () => void;
  /** Items above the message's own, with a divider under them. */
  leadingItems?: readonly MenuItem[];
  /** Elements that count as part of the menu for click-away — its trigger, so
   *  the press that toggles it shut is not also a click away. */
  insideRefs?: readonly RefObject<HTMLElement | null>[];
  /** Where focus goes back to when the reader dismisses the menu from the
   *  keyboard. Left out, it goes nowhere in particular. */
  returnFocusTo?: RefObject<HTMLElement | null>;
  /** The menu's accessible name. */
  label?: string;
  id?: string;
}

/**
 * The message menu's dropdown, at an anchor.
 *
 * Portalled to `<body>` in fixed viewport coordinates, so an ancestor's
 * `overflow-hidden` (a card's rounded corners) cannot clip it — the lower items
 * used to be cut off on short emails.
 *
 * On open it takes focus (the first item). That is not a nicety: a menu opened
 * by right-clicking a framed mail body would otherwise leave focus inside the
 * frame, whose key presses never reach this document — Escape would do
 * nothing, and a click back into the frame would not read as a click away.
 */
export function EmailMenuPopover({
  anchor,
  onClose,
  leadingItems = [],
  insideRefs = [],
  returnFocusTo,
  label = 'More actions',
  id,
  ...handlers
}: EmailMenuPopoverProps) {
  const dropdownRef = useRef<HTMLDivElement>(null);
  const placement = useMemo(() => placeMenu(anchor, currentViewport()), [anchor]);

  useClickAway([dropdownRef, ...insideRefs], true, onClose);

  /** The reader closed it from the keyboard: focus goes back where it came from. */
  const dismiss = () => {
    returnFocusTo?.current?.focus({ preventScroll: true });
    onClose();
  };
  // The window listeners below attach once; these read the latest props.
  const dismissFromWindow = useEffectEvent(dismiss);
  const close = useEffectEvent(() => onClose());

  useEffect(() => {
    // Close when the PAGE scrolls (the menu is fixed to where it opened), but
    // NOT when scrolling inside the menu itself — otherwise a tall, scrollable
    // menu closes the moment you try to scroll it.
    const onScroll = (event: Event) => {
      const { target } = event;
      if (target instanceof Node && dropdownRef.current?.contains(target)) return;
      close();
    };
    const onResize = () => close();
    // Escape is the menu's, and ONLY the menu's. The app's global Escape
    // (useKeyboardShortcuts, on `document`) deselects the open email — so a
    // press that closed the menu and then reached it would also close the
    // thread the reader was acting on. Capture phase on `window` runs before
    // that listener wherever focus is in this document.
    const onKeyDown = (event: KeyboardEvent) => {
      // A warning above this menu owns Escape, even if our capture listener
      // was registered before the warning mounted.
      if (isModalAlertOpen()) return;
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      dismissFromWindow();
    };
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('keydown', onKeyDown, true);
    };
  }, []);

  // Focus the first item on open — see the component's comment for why this
  // is required rather than polite. `preventScroll`, because a scroll closes it.
  useEffect(() => {
    dropdownRef.current
      ?.querySelector<HTMLElement>('[role="menuitem"]')
      ?.focus({ preventScroll: true });
  }, []);

  const choose = (action: () => void) => {
    action();
    onClose();
  };

  /**
   * Arrow keys walk the items (wrapping), Home/End jump; Tab leaves. Every
   * other key stays in the menu too (Escape never gets here — see above).
   */
  const onMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Tab') {
      // Leaving: back to the trigger, and let Tab carry on from there.
      dismiss();
      return;
    }
    // Focus is on an item — a button, which the app's global shortcuts (on
    // `document`) do not count as typing. A key that bubbled on would act on
    // the conversation BEHIND the menu: `d`, `#` or Delete trashing the whole
    // thread, `e` archiving it, `!` reporting it, an arrow switching threads.
    // Stopping it cancels nothing: Enter and Space still choose the focused
    // item, because a button's activation is its default action, not a
    // listener further up.
    event.stopPropagation();
    const items = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    const at = items.indexOf(document.activeElement as HTMLElement);
    const next =
      event.key === 'ArrowDown' ? (at + 1) % items.length
        : event.key === 'ArrowUp' ? (at - 1 + items.length) % items.length
          : event.key === 'Home' ? 0
            : event.key === 'End' ? items.length - 1
              : -1;
    if (next < 0) return;
    event.preventDefault();
    const target = items[next]!;
    // `preventScroll`, because a page scroll closes the menu — so the menu
    // scrolls ITSELF to the item. Capped to the room on its side, it often
    // scrolls, and a focused item left out of view is one Enter fires blind.
    target.focus({ preventScroll: true });
    const menu = event.currentTarget;
    menu.scrollTop = scrollTopToReveal(
      menu.scrollTop,
      menu.clientHeight,
      target.offsetTop,
      target.offsetHeight,
    );
  };

  return createPortal(
    <div
      ref={dropdownRef}
      id={id}
      role="menu"
      aria-label={label}
      onKeyDown={onMenuKeyDown}
      className="fixed w-56 bg-popover border border-border rounded-lg shadow-lg z-[100] py-1 overflow-y-auto"
      style={placement}
    >
      {leadingItems.length > 0 && (
        <>
          {leadingItems.map(({ id: itemId, label: itemLabel, icon: Icon, onSelect }) => (
            <button
              key={itemId}
              type="button"
              role="menuitem"
              tabIndex={-1}
              onClick={() => choose(onSelect)}
              className={ITEM_CLASS}
            >
              <Icon className="h-4 w-4 text-muted-foreground" />
              {itemLabel}
            </button>
          ))}
          <Separator />
        </>
      )}
      {EMAIL_MENU_SECTIONS.map((section, index) => (
        <Fragment key={section[0]!.label}>
          {index > 0 && <Separator />}
          {section.map(({ label: itemLabel, Icon, pick }) => (
            <button
              key={itemLabel}
              type="button"
              role="menuitem"
              tabIndex={-1}
              onClick={() => choose(pick(handlers))}
              className={ITEM_CLASS}
            >
              <Icon className="h-4 w-4 text-muted-foreground" />
              {itemLabel}
            </button>
          ))}
        </Fragment>
      ))}
    </div>,
    document.body,
  );
}

// ─── The three-dot button ─────────────────────────────────────────────────────

/**
 * The three-dot button and its menu, opening under (or above) the button.
 * A right-click menu uses `EmailMenuPopover` directly, at the pointer.
 */
export function EmailMenu({ email: _email, className = '', ...handlers }: EmailMenuProps) {
  const [anchor, setAnchor] = useState<MenuAnchor | null>(null);
  const isOpen = anchor !== null;
  const menuRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const close = useCallback(() => setAnchor(null), []);

  const handleToggle = (event: ReactMouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    setAnchor(isOpen ? null : { kind: 'rect', rect: event.currentTarget.getBoundingClientRect() });
  };

  return (
    <div ref={menuRef} className={`relative ${className}`}>
      {/* Icon-only, so it is an IconButton: the shared Tooltip AND a name. The
          native `title` it had took ~500ms to appear and named nothing for a
          screen reader. The tooltip hides while the menu is open, which it
          would cover. */}
      <IconButton
        ref={buttonRef}
        size="sm"
        variant="bare"
        className="hover:bg-accent rounded transition-colors"
        tooltip="More actions"
        tooltipHidden={isOpen}
        onClick={handleToggle}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        aria-controls={isOpen ? menuId : undefined}
        icon={<MoreVertical className="h-4 w-4 text-muted-foreground" />}
      />

      {anchor && (
        <EmailMenuPopover
          id={menuId}
          anchor={anchor}
          onClose={close}
          insideRefs={[menuRef]}
          returnFocusTo={buttonRef}
          {...handlers}
        />
      )}
    </div>
  );
}
