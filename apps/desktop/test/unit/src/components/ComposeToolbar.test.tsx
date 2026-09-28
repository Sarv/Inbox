// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ComposeToolbar } from '../../../../src/components/ComposeToolbar';
import { fire, render, typeInto } from '../../../helpers/render';

// What breaks if this suite goes red: the Send-later pick a composer is holding.
// The menu unmounts on any click outside it, so the draft has to live out here
// in the toolbar — and one per toolbar, or two open composers share a delivery
// time and whichever was typed last wins for both.

const props = {
  sending: false,
  hasAIProvider: false,
  plainBody: 'hello',
  hasRecipients: true,
  onSend: vi.fn(),
  onSendLater: vi.fn(),
  onAttach: vi.fn(),
  onPolish: vi.fn(),
  onDiscard: vi.fn(),
};

// Scoped to the mount, not the document: these tests put TWO toolbars on the
// page, and the shared helper's document-wide search would drive the first
// one's menu for both.
const within = (view: ReturnType<typeof render>, selector: string) =>
  [...view.container.querySelectorAll<HTMLElement>(selector)];

const labelled = (view: ReturnType<typeof render>, label: string) =>
  within(view, `[aria-label="${label}"]`)[0] ?? null;

const toggleMenu = (view: ReturnType<typeof render>) => fire(labelled(view, 'Send later'), 'click');

const openCustom = (view: ReturnType<typeof render>) =>
  fire(within(view, 'button').find((button) => button.textContent?.includes('Pick date')) ?? null, 'click');

/** The mistaken click outside: a press anywhere else closes the menu. */
const clickAway = () => {
  const elsewhere = document.createElement('button');
  document.body.appendChild(elsewhere);
  fire(elsewhere, 'mousedown');
  elsewhere.remove();
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 8, 23, 14, 20));
});

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
});

describe('ComposeToolbar send later', () => {
  it('hides the affordance when the composer cannot schedule', () => {
    const view = render(<ComposeToolbar {...props} onSendLater={undefined} />);
    expect(labelled(view, 'Send later')).toBeNull();
    view.unmount();
  });

  // Regression: the pick used to live inside the menu, so a click outside threw
  // away a date that had just been typed and reopening offered the defaults.
  it('still holds the typed date after the menu is clicked away', () => {
    const view = render(<ComposeToolbar {...props} />);
    toggleMenu(view);
    openCustom(view);
    typeInto(labelled(view, 'Delivery date'), '2026-09-28');
    typeInto(labelled(view, 'Delivery time'), '18:30');

    clickAway();
    expect(labelled(view, 'Delivery date')).toBeNull();

    toggleMenu(view);
    expect((labelled(view, 'Delivery date') as HTMLInputElement).value).toBe('2026-09-28');
    expect((labelled(view, 'Delivery time') as HTMLInputElement).value).toBe('18:30');
    view.unmount();
  });

  // Regression: two composers open at once must not share one delivery time.
  it('keeps each composer on its own pick', () => {
    const first = render(<ComposeToolbar {...props} />);
    toggleMenu(first);
    openCustom(first);
    typeInto(labelled(first, 'Delivery date'), '2026-09-28');
    clickAway();

    const second = render(<ComposeToolbar {...props} />);
    toggleMenu(second);
    openCustom(second);

    // Only the second composer's menu is open, and it opens on the default.
    expect((labelled(second, 'Delivery date') as HTMLInputElement).value).toBe('2026-09-24');

    toggleMenu(first);
    expect((labelled(first, 'Delivery date') as HTMLInputElement).value).toBe('2026-09-28');
    expect((labelled(second, 'Delivery date') as HTMLInputElement).value).toBe('2026-09-24');
    first.unmount();
    second.unmount();
  });

  it('reports the chosen time to the composer as epoch seconds', () => {
    const view = render(<ComposeToolbar {...props} />);
    toggleMenu(view);
    openCustom(view);
    typeInto(labelled(view, 'Delivery date'), '2026-09-28');
    typeInto(labelled(view, 'Delivery time'), '18:30');
    fire(within(view, 'button').find((button) => button.textContent === 'Schedule') ?? null, 'click');

    expect(props.onSendLater).toHaveBeenCalledWith(Math.floor(new Date(2026, 8, 28, 18, 30).getTime() / 1000));
    view.unmount();
  });
});

// The follow-up bell: "remind me if nobody replies". What breaks: a pick that
// never reaches the composer (no reminder is recorded on send), a custom date
// typed into the bell that leaks into Send later's fields, or no way to turn
// a reminder back off.
describe('ComposeToolbar follow-up bell', () => {
  const DAY = 86_400;
  const bell = (view: ReturnType<typeof render>, label = 'Remind me if no reply') => labelled(view, label);
  const button = (view: ReturnType<typeof render>, text: string) =>
    within(view, 'button').find((candidate) => candidate.textContent?.includes(text)) ?? null;

  it('hides the bell when the composer takes no reminder', () => {
    const view = render(<ComposeToolbar {...props} />);
    expect(bell(view)).toBeNull();
    view.unmount();
  });

  // A preset arms a relative delay and closes the menu.
  it('arms a preset delay', () => {
    const onFollowUpChange = vi.fn();
    const view = render(<ComposeToolbar {...props} onFollowUpChange={onFollowUpChange} />);
    fire(bell(view), 'click');
    fire(button(view, 'In 3 days'), 'click');
    expect(onFollowUpChange).toHaveBeenCalledWith({ afterSeconds: 3 * DAY });
    expect(button(view, 'In 3 days')).toBeNull();
    view.unmount();
  });

  // A custom date arms an absolute time, in its own fields — never Send later's.
  it('arms a picked date from its own reminder fields', () => {
    const onFollowUpChange = vi.fn();
    const view = render(<ComposeToolbar {...props} onFollowUpChange={onFollowUpChange} />);
    fire(bell(view), 'click');
    openCustom(view);
    typeInto(labelled(view, 'Reminder date'), '2026-10-01');
    typeInto(labelled(view, 'Reminder time'), '09:00');
    fire(button(view, 'Set reminder'), 'click');
    expect(onFollowUpChange).toHaveBeenCalledWith({ at: Math.floor(new Date(2026, 9, 1, 9, 0).getTime() / 1000) });
    expect(labelled(view, 'Delivery date')).toBeNull();
    view.unmount();
  });

  // An armed bell says what it will do and offers to turn it off.
  it('shows the active reminder and can clear it', () => {
    const onFollowUpChange = vi.fn();
    const view = render(<ComposeToolbar {...props} followUp={{ afterSeconds: 2 * DAY }} onFollowUpChange={onFollowUpChange} />);
    const armed = bell(view, 'Remind me if no reply in 2 days');
    expect(armed?.getAttribute('aria-pressed')).toBe('true');
    fire(armed, 'click');
    fire(button(view, 'Don'), 'click');
    expect(onFollowUpChange).toHaveBeenCalledWith(null);
    expect(button(view, 'In 1 day')).toBeNull();
    view.unmount();
  });

  // With nothing armed there is nothing to clear.
  it('offers no "don\'t remind me" when no reminder is set', () => {
    const view = render(<ComposeToolbar {...props} onFollowUpChange={vi.fn()} />);
    fire(bell(view), 'click');
    expect(button(view, 'Don')).toBeNull();
    clickAway();
    expect(button(view, 'In 1 day')).toBeNull();
    view.unmount();
  });
});
