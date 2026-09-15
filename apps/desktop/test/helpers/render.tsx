import type { ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';

/**
 * A ~30-line React render harness for the renderer's component tests.
 *
 * The repo carries no @testing-library, and these are the first component tests
 * in it — react-dom + happy-dom (both already dependencies) are enough to mount
 * a tree and drive it, so this exists instead of a new testing stack. Put shared
 * render plumbing HERE rather than re-deriving it per test file.
 *
 * Every test file using it must declare the DOM environment on its first line:
 *   // @vitest-environment happy-dom
 */

// React 18 refuses to flush updates from `act` without this flag.
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

export interface Mounted {
  container: HTMLElement;
  /** Re-render the same root with new props. */
  rerender: (element: ReactElement) => void;
  unmount: () => void;
  /** Every element matching a CSS selector, inside the container AND any portal. */
  all: (selector: string) => HTMLElement[];
  /** The first match, or null. Searches portals too (Tooltip renders into body). */
  find: (selector: string) => HTMLElement | null;
  /** The first element whose aria-label matches exactly. */
  byLabel: (label: string) => HTMLElement | null;
}

export function render(element: ReactElement): Mounted {
  const container = document.createElement('div');
  document.body.appendChild(container);
  let root: Root;
  act(() => {
    root = createRoot(container);
    root.render(element);
  });

  const all = (selector: string) =>
    // Portalled content (tooltips, overlays) lives outside `container`, so search
    // the document and filter to what this mount owns.
    [...document.body.querySelectorAll<HTMLElement>(selector)];

  return {
    container,
    all,
    find: (selector) => all(selector)[0] ?? null,
    byLabel: (label) =>
      all('[aria-label]').find((el) => el.getAttribute('aria-label') === label) ?? null,
    rerender: (next) => act(() => root.render(next)),
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

/**
 * Run an interaction and flush the resulting React work.
 *
 * Everything bubbles, including `error`: React attaches its listeners at the
 * root container, so a non-bubbling event dispatched on a leaf never reaches the
 * handler under test.
 */
export function fire(element: Element | null, type: string, init?: KeyboardEventInit) {
  if (!element) throw new Error(`cannot fire ${type} on a missing element`);
  const options = { bubbles: true, cancelable: true };
  act(() => {
    const event =
      type === 'keydown'
        ? new KeyboardEvent(type, { ...options, ...init })
        : type === 'click'
          ? new MouseEvent(type, options)
          : new Event(type, options);
    element.dispatchEvent(event);
  });
}

/** Let pending promises settle, then flush React. */
export async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

export { act };
