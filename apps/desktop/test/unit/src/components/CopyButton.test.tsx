// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CopyButton } from '../../../../src/components/CopyButton';
import { fire, render, settle, act } from '../../../helpers/render';

/**
 * The one copy-to-clipboard control in the app.
 *
 * What breaks if this file goes red: a click on "Copy to Clipboard" stops
 * saying anything. The clipboard is invisible, so a button that looks identical
 * before and after the click reads as broken — people click it repeatedly and
 * still can't tell whether the mail source was copied. The other half is the
 * failure path: `navigator.clipboard` is missing in a non-secure context and
 * rejects when the window isn't focused, and silently pretending that copied
 * is worse than the button saying it didn't.
 */

const writeText = vi.fn(async (_text: string) => {});

let mounted: ReturnType<typeof render> | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  writeText.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  });
});

afterEach(() => {
  mounted?.unmount();
  mounted = null;
  document.body.innerHTML = '';
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const button = () => mounted!.find('button');

describe('copying', () => {
  // The value must be read at click time: the modal's raw source arrives from
  // the server after first render, so a value captured at mount is stale/empty.
  it('copies the value a function prop returns when clicked', async () => {
    let source = 'still loading';
    mounted = render(<CopyButton value={() => source} />);
    source = 'From: a@b.test';

    fire(button(), 'click');
    await settle();

    expect(writeText).toHaveBeenCalledWith('From: a@b.test');
  });

  it('copies a plain string value', async () => {
    mounted = render(<CopyButton value="hello" />);

    fire(button(), 'click');
    await settle();

    expect(writeText).toHaveBeenCalledWith('hello');
  });

  // The whole point of the component: the click has to be visible.
  it('acknowledges the copy, then returns to the resting label', async () => {
    mounted = render(<CopyButton value="hello" label="Copy to Clipboard" copiedLabel="Copied!" />);
    expect(button()!.textContent).toContain('Copy to Clipboard');

    fire(button(), 'click');
    await settle();

    expect(button()!.textContent).toContain('Copied!');
    expect(button()!.getAttribute('aria-label')).toBe('Copied!');

    await act(async () => {
      vi.advanceTimersByTime(2000);
    });

    expect(button()!.textContent).toContain('Copy to Clipboard');
    expect(button()!.textContent).not.toContain('Copied!');
  });

  // A screen reader user gets nothing from an icon swap.
  it('announces the result in a live region', async () => {
    mounted = render(<CopyButton value="hello" />);
    expect(mounted.find('[aria-live="polite"]')!.textContent).toBe('');

    fire(button(), 'click');
    await settle();

    expect(mounted.find('[aria-live="polite"]')!.textContent).toBe('Copied!');
  });
});

describe('failure paths', () => {
  // A rejected write (document not focused, permission denied) must not be
  // reported as a successful copy — the user would paste stale content.
  it('reports a rejected clipboard write instead of claiming success', async () => {
    writeText.mockRejectedValue(new Error('not focused'));
    mounted = render(<CopyButton value="hello" errorLabel="Copy failed" />);

    fire(button(), 'click');
    await settle();

    expect(button()!.textContent).toContain('Copy failed');
  });

  // Non-secure contexts have no navigator.clipboard at all; reading .writeText
  // off undefined must be a reported failure, not an uncaught TypeError.
  it('reports a missing clipboard API', async () => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
    mounted = render(<CopyButton value="hello" />);

    fire(button(), 'click');
    await settle();

    expect(button()!.textContent).toContain('Copy failed');
  });

  // A failure clears the same way a success does, so the button is usable again.
  it('returns to the resting label after a failure', async () => {
    writeText.mockRejectedValue(new Error('denied'));
    mounted = render(<CopyButton value="hello" label="Copy" />);

    fire(button(), 'click');
    await settle();
    await act(async () => {
      vi.advanceTimersByTime(2000);
    });

    expect(button()!.textContent).toContain('Copy');
    expect(button()!.textContent).not.toContain('failed');
  });

  // Re-clicking mid-acknowledgement must restart the window, not let the first
  // click's pending reset wipe the second click's confirmation immediately.
  it('restarts the acknowledgement window on a second click', async () => {
    mounted = render(<CopyButton value="hello" />);

    fire(button(), 'click');
    await settle();
    await act(async () => {
      vi.advanceTimersByTime(1700);
    });
    fire(button(), 'click');
    await settle();
    await act(async () => {
      vi.advanceTimersByTime(300);
    });

    expect(button()!.textContent).toContain('Copied!');
  });

  it('does not copy while disabled', async () => {
    mounted = render(<CopyButton value="hello" disabled />);

    fire(button(), 'click');
    await settle();

    expect(writeText).not.toHaveBeenCalled();
    expect(button()!.hasAttribute('disabled')).toBe(true);
  });

  // The reset timer outliving the mount fires state into a dead tree.
  it('clears its pending reset on unmount', async () => {
    mounted = render(<CopyButton value="hello" />);
    fire(button(), 'click');
    await settle();

    mounted.unmount();
    mounted = null;

    expect(() => vi.advanceTimersByTime(5000)).not.toThrow();
  });
});

describe('styling hooks', () => {
  // Call sites with their own button styling (a modal footer, a toolbar) must
  // be able to replace the defaults without forking the component.
  it('lets a call site replace the default classes', () => {
    mounted = render(<CopyButton value="hello" className="my-own-button" />);

    expect(button()!.className).toBe('my-own-button');
  });
});

describe('icon-only mode', () => {
  // UI convention: an icon-only control must name itself on hover, and must
  // still be reachable by name for assistive tech.
  it('renders no visible label but keeps an aria-label', () => {
    mounted = render(<CopyButton value="hello" label="Copy address" iconOnly />);

    expect(button()!.getAttribute('aria-label')).toBe('Copy address');
    expect(button()!.textContent).toBe('');
  });

  it('shows the label in a tooltip on hover', async () => {
    mounted = render(<CopyButton value="hello" label="Copy address" iconOnly />);

    // React delivers onMouseEnter from a delegated `mouseover`, so that is the
    // event a test has to dispatch for the shared Tooltip to open.
    await act(async () => {
      button()!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
    await act(async () => {
      vi.advanceTimersByTime(100);
    });

    expect(document.body.textContent).toContain('Copy address');
  });
});
