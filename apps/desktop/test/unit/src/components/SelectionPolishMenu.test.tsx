// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SelectionPolishMenu } from '../../../../src/components/SelectionPolishMenu';
import { useCompose } from '../../../../src/components/useCompose';
import { act, fire, render, toggle, type Mounted } from '../../../helpers/render';

/**
 * The compose editors' right-click menu over a selection ("Polish Selected
 * Text"), as the reply, forward and compose editors all wire it: useCompose's
 * handler on the editor, SelectionPolishMenu for the menu.
 *
 * What breaks if this file goes red: the menu opens at the raw pointer again
 * and runs off the window near its right or bottom edge (each editor used to
 * place its own copy that way), steals the browser's menu where it has nothing
 * to offer, or stays open over the editor after a click elsewhere.
 */

vi.mock('../../../../src/store/email-store', () => ({
  useEmailStore: () => ({ sendEmail: vi.fn() }),
}));

const VIEWPORT = { width: 1024, height: 768 };

/** What the editor exposes to the test, from inside the hook. */
const hook = { current: null as ReturnType<typeof useCompose> | null };

function Editor({ hasAIProvider }: { hasAIProvider: boolean }) {
  const compose = useCompose({});
  hook.current = compose;
  return (
    <>
      <div data-testid="editor" onContextMenu={(e) => compose.handleSelectionContextMenu(e, hasAIProvider)}>
        The draft body
      </div>
      {compose.contextMenuPlacement && (
        <SelectionPolishMenu
          menuRef={compose.contextMenuRef}
          placement={compose.contextMenuPlacement}
          onPolish={compose.polishSelection}
        />
      )}
    </>
  );
}

let mounted: Mounted | null = null;
let selection = '';

beforeEach(() => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: VIEWPORT.width });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: VIEWPORT.height });
  vi.spyOn(window, 'getSelection').mockImplementation(
    () => ({ toString: () => selection }) as unknown as Selection,
  );
});
afterEach(() => {
  mounted?.unmount();
  mounted = null;
  hook.current = null;
  selection = '';
  delete (document as { activeElement?: unknown }).activeElement;
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

const mountEditor = (hasAIProvider = true) => {
  mounted = render(<Editor hasAIProvider={hasAIProvider} />);
  return mounted;
};
const menuEl = () => [...document.querySelectorAll('button')].find((b) => b.textContent === 'Polish Selected Text')
  ?.parentElement as HTMLElement | undefined;

/** A right-click on the editor at a viewport point. */
const rightClick = (view: Mounted, x: number, y: number) => {
  const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: x, clientY: y });
  act(() => {
    view.find('[data-testid="editor"]')!.dispatchEvent(event);
  });
  return event;
};

describe('the compose right-click menu over a selection', () => {
  // The feature, away from any edge: the menu's corner on the pointer.
  it('opens at the pointer over a selection', () => {
    selection = 'the second paragraph';
    const view = mountEditor();
    const event = rightClick(view, 200, 150);

    expect(event.defaultPrevented).toBe(true);
    expect(menuEl()!.style.left).toBe('200px');
    expect(menuEl()!.style.top).toBe('150px');
  });

  // THE regression: near the bottom-right corner the menu was drawn at the
  // raw pointer, running off both edges. It flips to the pointer's left and
  // hangs above it, inside the window.
  it('stays inside the window near the bottom-right corner', () => {
    selection = 'the second paragraph';
    const view = mountEditor();
    rightClick(view, 1010, 760);

    const style = menuEl()!.style;
    expect(parseFloat(style.left) + 224).toBeLessThanOrEqual(VIEWPORT.width - 8);
    expect(style.left).toBe(`${1010 - 224}px`);
    expect(style.top).toBe('');
    expect(style.bottom).toBe(`${VIEWPORT.height - 760}px`);
  });

  // With nothing selected, the menu has nothing to act on: the browser's own
  // menu (spelling, paste) is left alone.
  it('leaves the right-click alone with nothing selected', () => {
    selection = '   ';
    const view = mountEditor();
    const event = rightClick(view, 200, 150);
    expect(event.defaultPrevented).toBe(false);
    expect(menuEl()).toBeUndefined();
  });

  // Polish needs an AI provider; without one there is no menu to offer.
  it('leaves the right-click alone without an AI provider', () => {
    selection = 'the second paragraph';
    const view = mountEditor(false);
    const event = rightClick(view, 200, 150);
    expect(event.defaultPrevented).toBe(false);
    expect(menuEl()).toBeUndefined();
  });

  // Choosing it polishes exactly the selection, and closes the menu.
  it('polishes the selection it was opened over', () => {
    selection = '  the second paragraph ';
    const view = mountEditor();
    rightClick(view, 200, 150);

    toggle(menuEl()!.querySelector('button'));

    expect(menuEl()).toBeUndefined();
    expect(hook.current!.selectedText).toBe('the second paragraph');
    expect(hook.current!.polishMode).toBe('selection');
    expect(hook.current!.showPolishModal).toBe(true);
  });

  // A press anywhere else closes it; one inside it does not.
  it('closes on a press outside it, not inside it', () => {
    selection = 'the second paragraph';
    const view = mountEditor();
    rightClick(view, 200, 150);

    fire(menuEl()!.querySelector('button'), 'mousedown');
    expect(menuEl()).toBeDefined();
    fire(view.find('[data-testid="editor"]'), 'mousedown');
    expect(menuEl()).toBeUndefined();
  });

  // A click into a framed body (the quoted mail under a reply) never reaches
  // this document; focus moving into the frame closes the menu instead.
  it('closes when focus moves into a framed body', () => {
    selection = 'the second paragraph';
    const view = mountEditor();
    rightClick(view, 200, 150);

    const frame = document.createElement('iframe');
    document.body.appendChild(frame);
    Object.defineProperty(document, 'activeElement', { configurable: true, get: () => frame });
    act(() => {
      window.dispatchEvent(new Event('blur'));
    });
    expect(menuEl()).toBeUndefined();
  });
});
