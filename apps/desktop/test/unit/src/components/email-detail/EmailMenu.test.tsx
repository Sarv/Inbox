// @vitest-environment happy-dom
import { Copy } from 'lucide-react';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import type { UnscannedWarningRequest } from '../../../../../electron/preload';
import { UnscannedAttachmentWarning } from '../../../../../src/components/antivirus/UnscannedAttachmentWarning';
import {
  EmailMenu,
  EmailMenuPopover,
  type EmailMenuHandlers,
} from '../../../../../src/components/email-detail/EmailMenu';
import type { MenuAnchor } from '../../../../../src/utils/menu-placement';
import { act, fire, render, settle, toggle, type Mounted } from '../../../../helpers/render';

/**
 * The message menu: the three-dot button every message has (a reply in the
 * list, the anchor card, the toolbar, a chat bubble), and the same dropdown
 * opened at the pointer by a right-click in the chat.
 *
 * What breaks if this file goes red: the menu every surface depends on. Every
 * other test in the app replaces it with a stand-in, so this is the only place
 * that notices a menu which opens off-screen, never closes, closes the thread
 * with it (Escape reaching the global shortcut), or runs the wrong action.
 */

const VIEWPORT = { width: 1024, height: 768 };

const HANDLER_NAMES: readonly (keyof EmailMenuHandlers)[] = [
  'onReply', 'onReplyAll', 'onForward', 'onDelete', 'onArchive', 'onMarkUnread', 'onReportSpam',
  'onPrint', 'onDownload', 'onShowOriginal', 'onFilterLikeThis', 'onTranslate', 'onDetectSignature',
];
const newHandlers = () =>
  Object.fromEntries(HANDLER_NAMES.map((name) => [name, vi.fn<() => void>()])) as Record<
    keyof EmailMenuHandlers,
    Mock<() => void>
  >;

/** A button's box, as `getBoundingClientRect` reports it. */
const box = (top: number, right: number, height = 28, width = 28) =>
  ({ top, bottom: top + height, right, left: right - width, width, height, x: right - width, y: top, toJSON: () => ({}) }) as DOMRect;

let mounted: Mounted[] = [];
const mount = (element: Parameters<typeof render>[0]) => {
  const view = render(element);
  mounted.push(view);
  return view;
};

beforeEach(() => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: VIEWPORT.width });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: VIEWPORT.height });
});
afterEach(() => {
  mounted.forEach((view) => view.unmount());
  mounted = [];
  delete (document as { activeElement?: unknown }).activeElement;
  document.body.innerHTML = '';
  vi.useRealTimers();
});

const menu = () => document.querySelector<HTMLElement>('[role="menu"]');
const item = (label: string) =>
  [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((el) => el.textContent === label) ?? null;
const itemLabels = () => [...document.querySelectorAll('[role="menuitem"]')].map((el) => el.textContent);
const trigger = (view: Mounted) => view.byLabel('More actions') as HTMLButtonElement;

/** Mount the three-dot menu with its button at `rect`, and open it. */
const openAt = (rect: DOMRect, handlers = newHandlers()) => {
  const view = mount(<EmailMenu email={{ id: 'm1' }} {...handlers} />);
  const button = trigger(view);
  button.getBoundingClientRect = () => rect;
  toggle(button);
  return { view, button, handlers };
};

const keydown = (target: EventTarget, key: string) => {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
};

describe('EmailMenu — the three-dot button', () => {
  // Regression: the trigger carried only the native `title` (a ~500ms delay
  // and no accessible name). It is named, says it opens a menu, and says
  // whether that menu is open.
  it('names the trigger and states the menu it opens', () => {
    const view = mount(<EmailMenu email={{ id: 'm1' }} {...newHandlers()} />);
    const button = trigger(view);
    expect(button.tagName).toBe('BUTTON');
    expect(button.hasAttribute('title')).toBe(false);
    expect(button.getAttribute('aria-haspopup')).toBe('menu');
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(button.hasAttribute('aria-controls')).toBe(false);

    toggle(button);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(button.getAttribute('aria-controls')).toBe(menu()!.id);
  });

  // The shared Tooltip at the project's 40ms, not sooner.
  it('shows its tooltip at 40ms', () => {
    vi.useFakeTimers();
    const view = mount(<EmailMenu email={{ id: 'm1' }} {...newHandlers()} />);
    act(() => {
      trigger(view).dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
    act(() => {
      vi.advanceTimersByTime(39);
    });
    const tip = () => view.all('.fixed').find((el) => el.textContent === 'More actions');
    expect(tip()).toBeUndefined();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(tip()).toBeDefined();
  });

  // The tooltip would sit over the menu the button just opened: while the
  // menu is open, hovering the button shows none.
  it('shows no tooltip while its menu is open', () => {
    vi.useFakeTimers();
    const { view, button } = openAt(box(100, 600));
    act(() => {
      button.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
    act(() => {
      vi.advanceTimersByTime(200);
    });
    const tip = () => view.all('.fixed').find((el) => el.textContent === 'More actions');
    expect(menu()).not.toBeNull();
    expect(tip()).toBeUndefined();

    // Closed again, the button names itself on hover as before.
    toggle(button);
    act(() => {
      button.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
      button.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
    act(() => {
      vi.advanceTimersByTime(40);
    });
    expect(tip()).toBeDefined();
  });

  // The feature itself: a click opens the menu, portalled out of the button's
  // box (so a card's `overflow-hidden` cannot clip it), every item a menuitem.
  it('opens a portalled menu of every item on click', () => {
    const { view } = openAt(box(100, 600));
    expect(menu()).not.toBeNull();
    expect(view.container.contains(menu())).toBe(false);
    expect(itemLabels()).toEqual([
      'Reply', 'Reply all', 'Forward',
      'Delete', 'Archive', 'Mark as unread',
      'Report spam', 'Report phishing',
      'Filter messages like this', 'Translate', 'Print', 'Download message', 'Show original', 'Detect Signature',
    ]);
    expect(menu()!.querySelectorAll('[role="separator"]')).toHaveLength(3);
  });

  // Required, not polite: a menu that does not take focus cannot hear Escape
  // when it was opened from a framed body (see EmailMenuPopover).
  it('focuses the first item on open', () => {
    openAt(box(100, 600));
    expect(document.activeElement).toBe(item('Reply'));
  });

  // The trigger toggles: its own press is not a click-away (which would close
  // the menu, then let the click reopen it).
  it('closes when the trigger is pressed again', () => {
    const { button } = openAt(box(100, 600));
    fire(button, 'mousedown');
    expect(menu()).not.toBeNull();
    toggle(button);
    expect(menu()).toBeNull();
  });

  // The placement reaches the DOM: near the bottom, the menu hangs above.
  it('draws the menu above a button near the bottom edge', () => {
    openAt(box(700, 600));
    const style = menu()!.style;
    expect(style.bottom).toBe(`${VIEWPORT.height - 700 + 4}px`);
    expect(style.top).toBe('');
    expect(style.maxHeight).toBe('692px');
  });

  // A chat bubble keeps its action cluster shown while the menu is open, off
  // this attribute (chat-view-theme.css) — so every close path has to clear it.
  it('says whether its menu is open through every close path', () => {
    const { button } = openAt(box(100, 600));
    expect(button.getAttribute('aria-expanded')).toBe('true');
    toggle(item('Print'));
    expect(button.getAttribute('aria-expanded')).toBe('false');

    toggle(button);
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });
    expect(button.getAttribute('aria-expanded')).toBe('false');
  });

  // Regression: the menu focuses its first item on open, and with a plain
  // `focus:` highlight a MOUSE-opened menu kept that item lit while the
  // pointer hovered another — two highlighted rows. The keyboard highlight is
  // `focus-visible`, which Chromium does not match for focus that follows a
  // mouse open, and does for one that follows a key.
  it('highlights the focused item only for keyboard focus', () => {
    openAt(box(100, 600));
    for (const each of document.querySelectorAll('[role="menuitem"]')) {
      const classes = each.className.split(/\s+/);
      expect(classes).toContain('focus-visible:bg-accent');
      expect(classes.filter((name) => name.startsWith('focus:bg-'))).toEqual([]);
    }
  });

  // Every item reaches ITS handler, and choosing closes the menu.
  it.each([
    ['Reply', 'onReply'],
    ['Reply all', 'onReplyAll'],
    ['Forward', 'onForward'],
    ['Delete', 'onDelete'],
    ['Archive', 'onArchive'],
    ['Mark as unread', 'onMarkUnread'],
    ['Report spam', 'onReportSpam'],
    ['Filter messages like this', 'onFilterLikeThis'],
    ['Translate', 'onTranslate'],
    ['Print', 'onPrint'],
    ['Download message', 'onDownload'],
    ['Show original', 'onShowOriginal'],
    ['Detect Signature', 'onDetectSignature'],
  ] as const)('runs %s and closes', (label, handler) => {
    const { handlers } = openAt(box(100, 600));
    toggle(item(label));
    expect(handlers[handler]).toHaveBeenCalledTimes(1);
    for (const [name, fn] of Object.entries(handlers)) {
      if (name !== handler) expect(fn).not.toHaveBeenCalled();
    }
    expect(menu()).toBeNull();
  });

  // KNOWN GAP, pinned so it is not mistaken for a wiring bug: "Report phishing"
  // has never been connected to anything. It closes the menu and does nothing.
  it('known gap: Report phishing runs no handler', () => {
    const { handlers } = openAt(box(100, 600));
    toggle(item('Report phishing'));
    for (const fn of Object.values(handlers)) expect(fn).not.toHaveBeenCalled();
    expect(menu()).toBeNull();
  });
});

describe('EmailMenu — every way it closes', () => {
  // A menu that never closes sits over the mail and swallows the next click.
  it('closes on a press outside it', () => {
    openAt(box(100, 600));
    const outside = document.createElement('div');
    document.body.appendChild(outside);
    fire(outside, 'mousedown');
    expect(menu()).toBeNull();
  });

  // ...and not on a press inside it, or no item could ever be chosen.
  it('stays open on a press inside it', () => {
    openAt(box(100, 600));
    fire(item('Print'), 'mousedown');
    expect(menu()).not.toBeNull();
  });

  // The menu is fixed where it opened; a page that scrolls under it leaves it
  // pointing at nothing.
  it('closes when the page scrolls', () => {
    openAt(box(100, 600));
    act(() => {
      document.dispatchEvent(new Event('scroll'));
    });
    expect(menu()).toBeNull();
  });

  // Regression guard: the menu scrolls within itself when tall — closing on
  // its own scroll made the lower items unreachable.
  it('stays open when the menu itself scrolls', () => {
    openAt(box(100, 600));
    act(() => {
      menu()!.dispatchEvent(new Event('scroll'));
    });
    expect(menu()).not.toBeNull();
  });

  it('closes when the window resizes', () => {
    openAt(box(100, 600));
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });
    expect(menu()).toBeNull();
  });

  // THE regression this guards: the app's global Escape (on `document`)
  // deselects the open email. An Escape that closed the menu and ALSO reached
  // it would close the thread the reader was acting on.
  it('closes on Escape without the press reaching the global shortcut', () => {
    const { button } = openAt(box(100, 600));
    const globalShortcut = vi.fn();
    document.addEventListener('keydown', globalShortcut);

    const event = keydown(document.activeElement!, 'Escape');

    expect(menu()).toBeNull();
    expect(globalShortcut).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
    // Dismissed from the keyboard, focus goes back to the button.
    expect(document.activeElement).toBe(button);
    document.removeEventListener('keydown', globalShortcut);
  });

  // Breaks: an earlier window capture listener dismisses the underlying message menu while the attachment warning owns Escape.
  it('leaves Escape to a later-mounted warning, then resumes normal menu dismissal', async () => {
    openAt(box(100, 600));
    let onWarning: ((request: UnscannedWarningRequest) => void) | undefined;
    const respond = vi.fn(async () => ({ success: true }));
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      antivirus: {
        onUnscannedWarning: (callback: typeof onWarning) => { onWarning = callback; return () => {}; },
        onUnscannedWarningClosed: () => () => {},
        getPendingUnscannedWarning: async () => ({ success: true, data: null }),
        respondUnscannedWarning: respond,
      },
    };
    mount(<UnscannedAttachmentWarning />);
    act(() => onWarning?.({
      id: 'synthetic-warning', accountId: 'synthetic-work', action: 'view',
      filename: 'arakiri_A_50186774_/_3.pdf',
    }));

    keydown(document.activeElement!, 'Escape');
    await settle();

    expect(respond).toHaveBeenCalledWith({ id: 'synthetic-warning', choice: 'cancel', dontShowAgain: false });
    expect(menu()).not.toBeNull();
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    keydown(document.activeElement!, 'Escape');
    expect(menu()).toBeNull();
    delete (window as { electronAPI?: unknown }).electronAPI;
  });

  // Wherever focus is in this document — not only on an item.
  it('keeps Escape from the global shortcut even with focus elsewhere', () => {
    openAt(box(100, 600));
    const globalShortcut = vi.fn();
    document.addEventListener('keydown', globalShortcut);

    keydown(document.body, 'Escape');

    expect(menu()).toBeNull();
    expect(globalShortcut).not.toHaveBeenCalled();
    document.removeEventListener('keydown', globalShortcut);
  });

  // Once closed, Escape belongs to the app again — a leftover listener would
  // leave the reader unable to close the thread with Escape at all.
  it('lets Escape through again once the menu is gone', () => {
    const { button } = openAt(box(100, 600));
    toggle(button);
    const globalShortcut = vi.fn();
    document.addEventListener('keydown', globalShortcut);

    keydown(document.body, 'Escape');

    expect(globalShortcut).toHaveBeenCalledTimes(1);
    document.removeEventListener('keydown', globalShortcut);
  });

  // Regression: a click into a sandboxed mail body never reached the host
  // document, so the menu stayed open over the mail. Focus moving into the
  // frame closes it.
  it('closes when focus moves into a mail body frame', () => {
    openAt(box(100, 600));
    const frame = document.createElement('iframe');
    document.body.appendChild(frame);
    Object.defineProperty(document, 'activeElement', { configurable: true, get: () => frame });
    act(() => {
      window.dispatchEvent(new Event('blur'));
    });
    expect(menu()).toBeNull();
  });

  // Switching to another app blurs the window too; the menu waits.
  it('stays open when the reader switches to another app', () => {
    openAt(box(100, 600));
    act(() => {
      window.dispatchEvent(new Event('blur'));
    });
    expect(menu()).not.toBeNull();
  });
});

describe('EmailMenu — keyboard', () => {
  // A menu is walked with the arrows (wrapping) and Home/End, and those keys
  // stay in the menu: none of them may reach the app's shortcuts.
  it('walks the items with the arrow keys, Home and End', () => {
    openAt(box(100, 600));
    const globalShortcut = vi.fn();
    document.addEventListener('keydown', globalShortcut);

    keydown(document.activeElement!, 'ArrowDown');
    expect(document.activeElement).toBe(item('Reply all'));
    keydown(document.activeElement!, 'End');
    expect(document.activeElement).toBe(item('Detect Signature'));
    keydown(document.activeElement!, 'ArrowDown');
    expect(document.activeElement).toBe(item('Reply'));
    keydown(document.activeElement!, 'ArrowUp');
    expect(document.activeElement).toBe(item('Detect Signature'));
    keydown(document.activeElement!, 'Home');
    expect(document.activeElement).toBe(item('Reply'));

    expect(globalShortcut).not.toHaveBeenCalled();
    document.removeEventListener('keydown', globalShortcut);
  });

  // THE regression: focus is on an item, a button, which the app's global
  // shortcuts do not count as typing — so a key that bubbled past the menu
  // acted on the conversation BEHIND it: `d`/`#`/Delete/Backspace trashed the
  // whole thread, `e` archived it, an arrow switched threads. No key reaches
  // `document` while the menu has focus.
  it.each(['d', '#', 'Delete', 'Backspace', 'e', '!', 'ArrowRight', 'ArrowLeft', 'Enter', ' ', 'x'])(
    'keeps %j from the app\'s shortcuts',
    (key) => {
      openAt(box(100, 600));
      const globalShortcut = vi.fn();
      document.addEventListener('keydown', globalShortcut);

      keydown(document.activeElement!, key);

      expect(globalShortcut).not.toHaveBeenCalled();
      expect(menu()).not.toBeNull();
      document.removeEventListener('keydown', globalShortcut);
    },
  );

  // ...without cancelling what the key does in the menu itself: Enter and
  // Space activate a button as its DEFAULT action, which only preventDefault
  // would stop. A menu that swallowed them could not be used from the keyboard.
  it('leaves Enter and Space free to choose the focused item', () => {
    openAt(box(100, 600));
    expect(keydown(document.activeElement!, 'Enter').defaultPrevented).toBe(false);
    expect(keydown(document.activeElement!, ' ').defaultPrevented).toBe(false);
  });

  // Regression: the menu is capped to the room on its side and scrolls. Focus
  // moved with `preventScroll` (a PAGE scroll closes the menu), so End, or an
  // arrow past the last visible row, focused an item out of view — and Enter
  // then fired it blind. The menu now scrolls ITSELF to the focused item.
  it('scrolls a height-capped menu to the item the keyboard reaches', () => {
    openAt(box(100, 600));
    const list = menu()!;
    const items = [...list.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    // 14 items, 36px each, in a 200px window onto them.
    items.forEach((each, index) => {
      Object.defineProperty(each, 'offsetTop', { configurable: true, value: 4 + index * 36 });
      Object.defineProperty(each, 'offsetHeight', { configurable: true, value: 36 });
    });
    Object.defineProperty(list, 'clientHeight', { configurable: true, value: 200 });

    keydown(document.activeElement!, 'End');
    expect(document.activeElement).toBe(item('Detect Signature'));
    // Its bottom edge (4 + 13 * 36 + 36 = 508) is the view's.
    expect(list.scrollTop).toBe(508 - 200);

    // Wrapping to the first item scrolls back up to it.
    keydown(document.activeElement!, 'ArrowDown');
    expect(document.activeElement).toBe(item('Reply'));
    expect(list.scrollTop).toBe(4);

    // ArrowUp from the first wraps to the last, and follows it down again.
    keydown(document.activeElement!, 'ArrowUp');
    expect(document.activeElement).toBe(item('Detect Signature'));
    expect(list.scrollTop).toBe(308);

    // A step that stays in view leaves the scroll where it is.
    keydown(document.activeElement!, 'ArrowUp');
    expect(list.scrollTop).toBe(308);
    // ...and the menu's own scrolling does not close it.
    expect(menu()).not.toBeNull();
  });

  // Tab leaves the menu: it closes and hands focus back to the button, from
  // which Tab carries on.
  it('closes on Tab and returns focus to the button', () => {
    const { button } = openAt(box(100, 600));
    keydown(document.activeElement!, 'Tab');
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(button);
  });
});

describe('EmailMenuPopover — at a point, with extra items', () => {
  const point = (x: number, y: number): MenuAnchor => ({ kind: 'point', x, y });

  // A right-click menu opens with its corner on the pointer.
  it('is drawn at the point', () => {
    mount(<EmailMenuPopover anchor={point(120, 200)} onClose={vi.fn()} {...newHandlers()} />);
    expect(menu()!.style.left).toBe('120px');
    expect(menu()!.style.top).toBe('200px');
  });

  // Extra items (Copy, Open link…) come first, divided from the message's own.
  it('puts the extra items first, above a divider', () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    mount(
      <EmailMenuPopover
        anchor={point(120, 200)}
        onClose={onClose}
        leadingItems={[{ id: 'copy', label: 'Copy', icon: Copy, onSelect }]}
        {...newHandlers()}
      />,
    );
    expect(itemLabels().slice(0, 2)).toEqual(['Copy', 'Reply']);
    const first = menu()!.firstElementChild!;
    expect(first.textContent).toBe('Copy');
    expect(first.nextElementSibling!.getAttribute('role')).toBe('separator');
    // It is the first item, so it is the one focused.
    expect(document.activeElement).toBe(item('Copy'));

    toggle(item('Copy'));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  // No extra items, no stray divider at the top.
  it('draws no leading divider without extra items', () => {
    mount(<EmailMenuPopover anchor={point(120, 200)} onClose={vi.fn()} {...newHandlers()} />);
    expect(menu()!.firstElementChild!.textContent).toBe('Reply');
  });

  // Named: the caller names it for its message; left out, "More actions".
  it('carries its accessible name', () => {
    mount(<EmailMenuPopover anchor={point(1, 1)} onClose={vi.fn()} {...newHandlers()} />);
    expect(menu()!.getAttribute('aria-label')).toBe('More actions');
    mounted.forEach((view) => view.unmount());
    mounted = [];
    mount(<EmailMenuPopover anchor={point(1, 1)} onClose={vi.fn()} label="Message actions for Bob" {...newHandlers()} />);
    expect(menu()!.getAttribute('aria-label')).toBe('Message actions for Bob');
  });

  // With no trigger to return to, Escape still closes it — and still keeps the
  // press from the global shortcut.
  it('closes on Escape with nowhere to return focus to', () => {
    const onClose = vi.fn();
    mount(<EmailMenuPopover anchor={point(1, 1)} onClose={onClose} {...newHandlers()} />);
    const globalShortcut = vi.fn();
    document.addEventListener('keydown', globalShortcut);

    keydown(document.activeElement!, 'Escape');

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(globalShortcut).not.toHaveBeenCalled();
    document.removeEventListener('keydown', globalShortcut);
  });

  // Its listeners go with it: after unmount, nothing closes a menu that is gone.
  it('stops listening when unmounted', () => {
    const onClose = vi.fn();
    const view = mount(<EmailMenuPopover anchor={point(1, 1)} onClose={onClose} {...newHandlers()} />);
    view.unmount();
    mounted = [];
    act(() => {
      window.dispatchEvent(new Event('resize'));
      document.dispatchEvent(new Event('scroll'));
    });
    fire(document.body, 'mousedown');
    expect(onClose).not.toHaveBeenCalled();
  });
});
