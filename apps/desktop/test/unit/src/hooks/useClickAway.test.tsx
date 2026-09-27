// @vitest-environment happy-dom
import { useRef, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useClickAway } from '../../../../src/hooks/useClickAway';
import { fire, render } from '../../../helpers/render';

// What breaks if this suite goes red: every popup menu built on this hook. The
// two directions are opposite failures — a menu that never closes sits over the
// UI and swallows the next click, and a menu that closes on its OWN clicks can
// never be used at all, because choosing an item unmounts it mid-gesture.

function Menu({ onAway, open: initialOpen = true }: { onAway: () => void; open?: boolean }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [open] = useState(initialOpen);
  useClickAway(ref, open, onAway);
  return (
    <div ref={ref} data-testid="menu">
      <button aria-label="Inside">inside</button>
    </div>
  );
}

const outside = () => {
  const button = document.createElement('button');
  button.setAttribute('aria-label', 'Outside');
  document.body.appendChild(button);
  return button;
};

afterEach(() => {
  document.body.innerHTML = '';
});

describe('useClickAway', () => {
  it('reports a press that lands outside the element', () => {
    const onAway = vi.fn();
    const view = render(<Menu onAway={onAway} />);

    fire(outside(), 'mousedown');

    expect(onAway).toHaveBeenCalledTimes(1);
    view.unmount();
  });

  // THE regression that makes a menu unusable: the press that chooses an item
  // must not also be read as a press outside it.
  it('ignores a press on the element itself', () => {
    const onAway = vi.fn();
    const view = render(<Menu onAway={onAway} />);

    fire(view.byLabel('Inside'), 'mousedown');

    expect(onAway).not.toHaveBeenCalled();
    view.unmount();
  });

  // A closed popup must not be listening. Thousands of mounted-but-closed menus
  // each holding a document listener is a real cost, and a closed menu firing
  // `onAway` re-renders its owner on every stray click in the window.
  it('listens for nothing while closed', () => {
    const onAway = vi.fn();
    const view = render(<Menu onAway={onAway} open={false} />);

    fire(outside(), 'mousedown');

    expect(onAway).not.toHaveBeenCalled();
    view.unmount();
  });

  // Unmounting has to take the listener with it, or a menu that is gone keeps
  // calling back into state that no longer exists.
  it('removes the listener when the owner unmounts', () => {
    const onAway = vi.fn();
    render(<Menu onAway={onAway} />).unmount();

    fire(outside(), 'mousedown');

    expect(onAway).not.toHaveBeenCalled();
  });
});
