// @vitest-environment happy-dom
import { useRef, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useClickAway } from '../../../../src/hooks/useClickAway';
import { act, fire, render } from '../../../helpers/render';

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

/** A menu portalled away from its trigger: two boxes, one popup. */
function SplitMenu({ onAway }: { onAway: () => void }) {
  const trigger = useRef<HTMLButtonElement | null>(null);
  const dropdown = useRef<HTMLDivElement | null>(null);
  // A fresh array literal every render, as a caller naturally writes it.
  useClickAway([trigger, dropdown], true, onAway);
  return (
    <>
      <button ref={trigger} aria-label="Trigger">trigger</button>
      <div ref={dropdown} aria-label="Dropdown">
        <iframe title="Inside frame" />
      </div>
    </>
  );
}

/** Make `element` the document's active element, as focus moving into it would. */
const focusLandsOn = (element: Element) => {
  Object.defineProperty(document, 'activeElement', { configurable: true, get: () => element });
};
/** Focus leaves this window: the reader clicked into a frame, or left the app. */
const windowBlurs = () => {
  act(() => {
    window.dispatchEvent(new Event('blur'));
  });
};

afterEach(() => {
  // Back to the prototype's real getter.
  delete (document as { activeElement?: unknown }).activeElement;
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

  // Several refs: a portalled menu is its trigger AND its dropdown. A press on
  // either must stay inside, or pressing the trigger to close the menu would
  // close it (away) and then reopen it (the click's toggle).
  it('treats a press on any of several elements as inside', () => {
    const onAway = vi.fn();
    const view = render(<SplitMenu onAway={onAway} />);

    fire(view.byLabel('Trigger'), 'mousedown');
    fire(view.byLabel('Dropdown'), 'mousedown');
    expect(onAway).not.toHaveBeenCalled();

    fire(outside(), 'mousedown');
    expect(onAway).toHaveBeenCalledTimes(1);
    view.unmount();
  });

  // Regression guard: an inline array is a new value every render. Were the
  // refs an effect dependency, every re-render would tear the listeners down
  // and put them back — work on each keystroke upstream, for nothing.
  it('does not re-attach its listeners when re-rendered with a fresh array', () => {
    const onAway = vi.fn();
    const view = render(<SplitMenu onAway={onAway} />);
    const add = vi.spyOn(document, 'addEventListener');

    view.rerender(<SplitMenu onAway={onAway} />);
    view.rerender(<SplitMenu onAway={onAway} />);

    expect(add).not.toHaveBeenCalled();
    add.mockRestore();
    view.unmount();
  });

  // The other half of not re-attaching: the listener must still call the
  // CURRENT callback, not the one it was attached with.
  it('calls the latest callback after a re-render', () => {
    const first = vi.fn();
    const second = vi.fn();
    const view = render(<SplitMenu onAway={first} />);
    view.rerender(<SplitMenu onAway={second} />);

    fire(outside(), 'mousedown');

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    view.unmount();
  });

  // Regression: a click inside a sandboxed mail body never reaches this
  // document, so a menu stayed open over the mail after the reader clicked
  // into it. Focus moving into the frame is what this document does see.
  it('reports focus moving into a frame as a click away', () => {
    const onAway = vi.fn();
    const view = render(<Menu onAway={onAway} />);
    const frame = document.createElement('iframe');
    document.body.appendChild(frame);

    focusLandsOn(frame);
    windowBlurs();

    expect(onAway).toHaveBeenCalledTimes(1);
    view.unmount();
  });

  // The opposite failure: the window also blurs when the reader switches to
  // another app. Coming back must find the menu as they left it.
  it('leaves the popup open when the window blurs for any other reason', () => {
    const onAway = vi.fn();
    const view = render(<Menu onAway={onAway} />);

    // Focus is wherever the reader left it — here, outside the popup — and the
    // window blurs with it still there.
    focusLandsOn(outside());
    windowBlurs();

    expect(onAway).not.toHaveBeenCalled();
    view.unmount();
  });

  // A frame INSIDE the popup is part of it, like any other element there.
  it('does not report focus moving into a frame inside the popup', () => {
    const onAway = vi.fn();
    const view = render(<SplitMenu onAway={onAway} />);

    focusLandsOn(view.find('iframe[title="Inside frame"]')!);
    windowBlurs();

    expect(onAway).not.toHaveBeenCalled();
    view.unmount();
  });

  // Closed means closed: no blur listener either.
  it('ignores a blur into a frame while closed', () => {
    const onAway = vi.fn();
    const view = render(<Menu onAway={onAway} open={false} />);
    const frame = document.createElement('iframe');
    document.body.appendChild(frame);

    focusLandsOn(frame);
    windowBlurs();

    expect(onAway).not.toHaveBeenCalled();
    view.unmount();
  });

  // Unmounting takes the blur listener too.
  it('removes the blur listener when the owner unmounts', () => {
    const onAway = vi.fn();
    render(<Menu onAway={onAway} />).unmount();
    const frame = document.createElement('iframe');
    document.body.appendChild(frame);

    focusLandsOn(frame);
    windowBlurs();

    expect(onAway).not.toHaveBeenCalled();
  });
});
