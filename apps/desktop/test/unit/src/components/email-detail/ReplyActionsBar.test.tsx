// @vitest-environment happy-dom
import { format } from 'date-fns';
import { createRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ReplyActionsBar,
  ReplyQuickActions,
} from '../../../../../src/components/email-detail/ReplyActionsBar';
import { act, render, toggle, type Mounted } from '../../../../helpers/render';

import { TEN_AM } from './email-fixture';

/**
 * The Reply / Reply All / Forward row, and the same three actions as icons.
 *
 * What breaks if this file goes red: a button answers with the wrong action
 * (Reply All opening a reply to one person reads as mail that "didn't go to
 * everyone"), or its click escapes into the surface under it — a reply card
 * that collapses as its own composer opens, a bubble that treats the click as
 * its own. For the icons: a control the reader cannot name.
 */

let mounted: Mounted | undefined;
afterEach(() => {
  mounted?.unmount();
  mounted = undefined;
  vi.useRealTimers();
});

const handlers = () => ({ onReply: vi.fn(), onReplyAll: vi.fn(), onForward: vi.fn() });

/** The message a bubble's icons answer. */
const MESSAGE = { fromName: 'Bob Ray', fromAddress: 'bob@acme.example', date: TEN_AM };

/** The button whose visible text is exactly `text`. */
const buttonNamed = (view: Mounted, text: string) =>
  view.all('button').find((button) => button.textContent === text) ?? null;

describe('ReplyActionsBar', () => {
  // The row is the standard view's, now shared by three placements; its text
  // and order are what readers already know.
  it('draws Reply, Reply All and Forward, in that order, in the given box', () => {
    mounted = render(<ReplyActionsBar className="the-box" {...handlers()} />);
    const group = mounted.byLabel('Reply actions')!;
    expect(group.className).toBe('the-box');
    expect([...group.querySelectorAll('button')].map((b) => b.textContent)).toEqual([
      'Reply',
      'Reply All',
      'Forward',
    ]);
  });

  // Regression guard for the shared row: each button reaches its own handler
  // and only that one.
  it.each([
    ['Reply', 'onReply'],
    ['Reply All', 'onReplyAll'],
    ['Forward', 'onForward'],
  ] as const)('%s calls %s and nothing else', (text, handler) => {
    const h = handlers();
    mounted = render(<ReplyActionsBar className="" {...h} />);
    toggle(buttonNamed(mounted, text));
    for (const [name, fn] of Object.entries(h)) {
      expect(fn).toHaveBeenCalledTimes(name === handler ? 1 : 0);
    }
  });

  // The chat scrolls the row into view through this ref; a ref that never
  // reached the element would leave the row under the fold, silently.
  it('hands its element to a ref', () => {
    const ref = createRef<HTMLDivElement>();
    mounted = render(<ReplyActionsBar ref={ref} className="" {...handlers()} />);
    expect(ref.current).toBe(mounted.byLabel('Reply actions'));
  });

  // Regression: under a reply the row sits inside a card that reacts to
  // clicks; a click that bubbled out opened the composer AND acted on the card.
  it('keeps each click to itself', () => {
    const outer = vi.fn();
    mounted = render(
      <div onClick={outer}>
        <ReplyActionsBar className="" {...handlers()} />
      </div>,
    );
    for (const text of ['Reply', 'Reply All', 'Forward']) toggle(buttonNamed(mounted, text));
    expect(outer).not.toHaveBeenCalled();
  });
});

describe('ReplyQuickActions', () => {
  // Icon-only, so the accessible name is all a screen reader has.
  it('names each icon', () => {
    mounted = render(<ReplyQuickActions message={MESSAGE} {...handlers()} />);
    for (const name of ['Reply', 'Reply all', 'Forward']) {
      expect(mounted.byLabel(name)?.tagName).toBe('BUTTON');
    }
    expect(mounted.all('button')).toHaveLength(3);
  });

  it.each([
    ['Reply', 'onReply'],
    ['Reply all', 'onReplyAll'],
    ['Forward', 'onForward'],
  ] as const)('%s calls %s and nothing else', (name, handler) => {
    const h = handlers();
    mounted = render(<ReplyQuickActions message={MESSAGE} {...h} />);
    toggle(mounted.byLabel(name));
    for (const [key, fn] of Object.entries(h)) {
      expect(fn).toHaveBeenCalledTimes(key === handler ? 1 : 0);
    }
  });

  // Regression guard: the cluster sits on a chat bubble; a click that reached
  // the bubble would be the bubble's too.
  it('keeps each click to itself', () => {
    const outer = vi.fn();
    mounted = render(
      <div onClick={outer}>
        <ReplyQuickActions message={MESSAGE} {...handlers()} />
      </div>,
    );
    for (const name of ['Reply', 'Reply all', 'Forward']) toggle(mounted.byLabel(name));
    expect(outer).not.toHaveBeenCalled();
  });

  // The project rule for icon-only controls: the shared Tooltip at 40ms. And
  // no shortcut chip — the shortcuts answer the NEWEST message, so a key shown
  // on an older bubble's icon would promise something it does not do.
  it('names each icon in a 40ms tooltip, with no shortcut hint', () => {
    vi.useFakeTimers();
    mounted = render(<ReplyQuickActions message={MESSAGE} {...handlers()} />);
    act(() => {
      mounted!.byLabel('Reply all')!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
    act(() => {
      vi.advanceTimersByTime(39);
    });
    expect(mounted.all('.fixed').some((el) => el.textContent === 'Reply all')).toBe(false);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    const tip = mounted.all('.fixed').find((el) => el.textContent === 'Reply all');
    expect(tip).toBeDefined();
    expect(tip!.querySelector('kbd')).toBeNull();
  });

  // Regression: every bubble's icons are named "Reply", "Reply all" and
  // "Forward" — as are the end row's and the toolbar's, which answer the
  // NEWEST message. Tabbing through, nothing said which message these answer;
  // the group's name does: the sender, and an absolute time.
  it('names the group for the message it answers', () => {
    mounted = render(<ReplyQuickActions message={MESSAGE} {...handlers()} />);
    const when = format(new Date(TEN_AM * 1000), 'MMM d, h:mm a');
    const group = mounted.byLabel(`Reply actions for Bob Ray, ${when}`)!;
    expect(group.getAttribute('role')).toBe('group');
    expect(group.querySelectorAll('button')).toHaveLength(3);
  });

  // A sender with no display name is named by address, never "undefined".
  it('falls back to the sender address when there is no name', () => {
    mounted = render(<ReplyQuickActions message={{ ...MESSAGE, fromName: null }} {...handlers()} />);
    const group = mounted.find('[role="group"]')!;
    expect(group.getAttribute('aria-label')).toMatch(/^Reply actions for bob@acme\.example, /);
  });
});
