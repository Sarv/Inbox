// @vitest-environment happy-dom
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SendLaterDropdown } from '../../../../src/components/SendLaterDropdown';
import { useSendLaterDraft } from '../../../../src/hooks/useSendLaterDrafts';
import { sendLaterPresets, toEpochSeconds } from '../../../../src/utils/time-presets';
import { fire, render, typeInto } from '../../../helpers/render';

// What breaks if this suite goes red: the menu that picks a delivery time. A
// preset wired to the wrong value, or a custom pick that reports local minutes
// as if they were epoch seconds, schedules the mail for the wrong moment — and
// the composer closes looking like it worked. A time already in the past
// schedules a message that goes out the instant it is queued, which is not what
// "send later" was asked for.

let onPick: ReturnType<typeof vi.fn<(sendAt: number) => void>>;
let onClose: ReturnType<typeof vi.fn<() => void>>;

/**
 * The menu as its owners mount it: the draft lives OUTSIDE, in a component that
 * stays put, and the menu itself comes and goes. Exactly ComposeToolbar's
 * arrangement, so what this suite proves about preservation is what a composer
 * actually does.
 */
function Owner({ align }: { align?: 'left' | 'right' }) {
  const { draft, update } = useSendLaterDraft();
  const [open, setOpen] = useState(true);
  return (
    <>
      {open && (
        <SendLaterDropdown
          onPick={onPick}
          onClose={onClose}
          draft={draft}
          onDraftChange={update}
          align={align}
        />
      )}
      {/* Last in the DOM, so preset rows keep their indices. */}
      <button aria-label="toggle menu" onClick={() => setOpen((shown) => !shown)} />
    </>
  );
}

const openMenu = () => render(<Owner />);

/** Close the menu and open it again — the mistaken click outside, reproduced. */
const reopen = (view: ReturnType<typeof render>) => {
  fire(view.byLabel('toggle menu'), 'click');
  fire(view.byLabel('toggle menu'), 'click');
};

const openCustom = (view: ReturnType<typeof render>) =>
  fire(view.all('button').find((button) => button.textContent?.includes('Pick date')) ?? null, 'click');

const scheduleButton = (view: ReturnType<typeof render>) =>
  view.all('button').find((button) => button.textContent === 'Schedule') as HTMLButtonElement;

beforeEach(() => {
  onPick = vi.fn<(sendAt: number) => void>();
  onClose = vi.fn<() => void>();
  // A fixed local Wednesday afternoon, so every preset is deterministic.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 8, 23, 14, 20));
});

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
});

describe('SendLaterDropdown', () => {
  it('offers the shared presets, each labelled with the time it means', () => {
    const view = openMenu();
    const rows = view.all('button').filter((button) => button.textContent?.includes('Tomorrow morning'));
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain('Thu, 8:00 AM');
    view.unmount();
  });

  // Regression: the menu must report the SAME epoch the presets computed. An
  // off-by-a-timezone here is a mail sent in the middle of the night.
  it('reports the chosen preset as UTC epoch seconds and closes', () => {
    const view = openMenu();
    const expected = toEpochSeconds(sendLaterPresets(new Date(2026, 8, 23, 14, 20))[0].time);

    fire(view.all('button')[0], 'click');

    expect(onPick).toHaveBeenCalledWith(expected);
    expect(onClose).toHaveBeenCalledTimes(1);
    view.unmount();
  });

  it('opens a date and time picker, defaulted to tomorrow morning', () => {
    const view = openMenu();
    openCustom(view);

    expect((view.byLabel('Delivery date') as HTMLInputElement).value).toBe('2026-09-24');
    expect((view.byLabel('Delivery time') as HTMLInputElement).value).toBe('09:00');
    view.unmount();
  });

  it('schedules the custom pick as the local time the reader typed', () => {
    const view = openMenu();
    openCustom(view);
    typeInto(view.byLabel('Delivery date'), '2026-09-25');
    typeInto(view.byLabel('Delivery time'), '17:45');
    fire(scheduleButton(view), 'click');

    expect(onPick).toHaveBeenCalledWith(toEpochSeconds(new Date(2026, 8, 25, 17, 45)));
    view.unmount();
  });

  // Regression: an empty date must not schedule "Invalid Date", which reaches
  // storage as NaN and becomes a message no drain ever picks up.
  it('cannot schedule an empty custom date', () => {
    const view = openMenu();
    openCustom(view);
    typeInto(view.byLabel('Delivery date'), '');

    expect(scheduleButton(view).disabled).toBe(true);
    fire(scheduleButton(view), 'click');
    expect(onPick).not.toHaveBeenCalled();
    view.unmount();
  });

  it('closes the custom picker without scheduling anything', () => {
    const view = openMenu();
    openCustom(view);
    fire(view.all('button').find((button) => button.textContent === 'Cancel') ?? null, 'click');

    expect(view.byLabel('Delivery date')).toBeNull();
    expect(onPick).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    view.unmount();
  });

  // Regression: a trigger near the right edge of its row (the Outbox clock)
  // needs the menu pinned to the right, or 288px of it opens off-screen. The
  // default stays `left-0` for the composer, which opens from the left.
  it('pins itself to the edge it was asked for', () => {
    const left = render(<Owner />);
    expect(left.container.firstElementChild?.className).toContain('left-0');
    left.unmount();

    const right = render(<Owner align="right" />);
    expect(right.container.firstElementChild?.className).toContain('right-0');
    expect(right.container.firstElementChild?.className).not.toContain('left-0');
    right.unmount();
  });

  // A preset label and its time share one row. happy-dom does no layout, so the
  // only thing a test can pin is that the time is still told not to wrap —
  // which is what stopped "Mon, 8:00 AM" breaking over two lines.
  it('keeps each preset time on one line', () => {
    const view = openMenu();
    const row = view.all('button').find((button) => button.textContent?.includes('Tomorrow morning'));
    const time = row?.lastElementChild as HTMLElement;
    expect(time.className).toContain('whitespace-nowrap');
    expect(time.className).toContain('flex-shrink-0');
    view.unmount();
  });

  // In the evening "Later today" would mean 1am tomorrow, so it is not offered.
  it('drops Later today in the evening', () => {
    vi.setSystemTime(new Date(2026, 8, 23, 22, 40));
    const view = openMenu();
    expect(view.all('button').some((button) => button.textContent?.includes('Later today'))).toBe(false);
    view.unmount();
  });

  describe('refuses a moment that has already passed', () => {
    // Regression: today's date with an earlier time was accepted and queued a
    // "scheduled" send that the very next drain picked up — the message went
    // out at once, which is the opposite of what the reader asked for.
    it('will not schedule an earlier time today', () => {
      const view = openMenu();
      openCustom(view);
      typeInto(view.byLabel('Delivery date'), '2026-09-23');
      typeInto(view.byLabel('Delivery time'), '09:02');

      expect(scheduleButton(view).disabled).toBe(true);
      fire(scheduleButton(view), 'click');
      expect(onPick).not.toHaveBeenCalled();
      expect(view.find('[role="alert"]')?.textContent).toContain('already passed');
      view.unmount();
    });

    // The date input's `min` stops the calendar widget, not a typed or pasted
    // date, so the guard cannot live in the attribute alone.
    it('will not schedule a date before today', () => {
      const view = openMenu();
      openCustom(view);
      typeInto(view.byLabel('Delivery date'), '2026-09-20');

      expect(scheduleButton(view).disabled).toBe(true);
      expect(view.find('[role="alert"]')).not.toBeNull();
      view.unmount();
    });

    it('still refuses a time that lapses while the menu sits open', () => {
      const view = openMenu();
      openCustom(view);
      typeInto(view.byLabel('Delivery date'), '2026-09-23');
      typeInto(view.byLabel('Delivery time'), '14:25');
      expect(scheduleButton(view).disabled).toBe(false);

      // Five minutes pass with the menu open and no re-render.
      vi.setSystemTime(new Date(2026, 8, 23, 14, 30));
      fire(scheduleButton(view), 'click');

      expect(onPick).not.toHaveBeenCalled();
      view.unmount();
    });

    it('bounds the time input by the clock on today, but not on a later day', () => {
      const view = openMenu();
      openCustom(view);
      typeInto(view.byLabel('Delivery date'), '2026-09-23');
      expect(view.byLabel('Delivery time')?.getAttribute('min')).toBe('14:20');

      typeInto(view.byLabel('Delivery date'), '2026-09-24');
      expect(view.byLabel('Delivery time')?.getAttribute('min')).toBeNull();
      view.unmount();
    });

    // Regression: a click landing on the date or time field must stay in the
    // menu. It bubbles out otherwise, and whatever sits behind the composer
    // treats picking a delivery time as a click on itself.
    it('keeps a click on the fields inside the menu', () => {
      const view = openMenu();
      openCustom(view);
      const outside = vi.fn();
      document.addEventListener('click', outside);

      fire(view.byLabel('Delivery date'), 'click');
      fire(view.byLabel('Delivery time'), 'click');

      expect(outside).not.toHaveBeenCalled();
      expect(onPick).not.toHaveBeenCalled();
      document.removeEventListener('click', outside);
      view.unmount();
    });

    it('lets the date input refuse the past days it can', () => {
      const view = openMenu();
      openCustom(view);
      expect(view.byLabel('Delivery date')?.getAttribute('min')).toBe('2026-09-23');
      view.unmount();
    });
  });

  describe('keeps what was typed while its owner is on screen', () => {
    // Regression: a mistaken click outside unmounts the menu. With the pick
    // held inside it, the date and time were gone and reopening offered the
    // defaults again — the reader had to type it all a second time.
    it('still has the date and time after a click outside', () => {
      const view = openMenu();
      openCustom(view);
      typeInto(view.byLabel('Delivery date'), '2026-09-28');
      typeInto(view.byLabel('Delivery time'), '18:30');

      reopen(view);

      expect((view.byLabel('Delivery date') as HTMLInputElement).value).toBe('2026-09-28');
      expect((view.byLabel('Delivery time') as HTMLInputElement).value).toBe('18:30');
      view.unmount();
    });

    it('reopens on the custom pane it was left on, not the preset list', () => {
      const view = openMenu();
      openCustom(view);
      reopen(view);
      expect(view.byLabel('Delivery date')).not.toBeNull();
      view.unmount();
    });

    // Regression: preservation must not preserve a time into uselessness.
    // Pick five minutes out, click away, come back ten minutes later — the
    // fields would still show the lapsed time with Schedule greyed and nothing
    // saying why. It refreshes to the next half hour instead.
    it('refreshes a preserved time that lapsed while the menu was shut', () => {
      const view = openMenu();
      openCustom(view);
      typeInto(view.byLabel('Delivery date'), '2026-09-23');
      typeInto(view.byLabel('Delivery time'), '14:25');

      vi.setSystemTime(new Date(2026, 8, 23, 14, 35));
      reopen(view);

      expect((view.byLabel('Delivery date') as HTMLInputElement).value).toBe('2026-09-23');
      expect((view.byLabel('Delivery time') as HTMLInputElement).value).toBe('15:00');
      expect(scheduleButton(view).disabled).toBe(false);
      expect(view.find('[role="alert"]')).toBeNull();
      view.unmount();
    });

    it('leaves a preserved time alone while it is still in the future', () => {
      const view = openMenu();
      openCustom(view);
      typeInto(view.byLabel('Delivery date'), '2026-09-23');
      typeInto(view.byLabel('Delivery time'), '18:00');

      vi.setSystemTime(new Date(2026, 8, 23, 14, 35));
      reopen(view);

      expect((view.byLabel('Delivery time') as HTMLInputElement).value).toBe('18:00');
      view.unmount();
    });

    // Two composers, two delivery times: the draft belongs to the owner, so
    // one mount can never read or overwrite the other's.
    it('keeps two owners apart', () => {
      // Scoped to each mount: with two menus on the page the shared helpers'
      // document-wide search would read the first one twice.
      const dateIn = (view: ReturnType<typeof render>) =>
        view.container.querySelector<HTMLInputElement>('[aria-label="Delivery date"]');

      const first = render(<Owner />);
      const firstPick = [...first.container.querySelectorAll<HTMLElement>('button')]
        .find((button) => button.textContent?.includes('Pick date'));
      fire(firstPick ?? null, 'click');
      typeInto(dateIn(first), '2026-09-28');

      const second = render(<Owner />);
      const secondPick = [...second.container.querySelectorAll<HTMLElement>('button')]
        .find((button) => button.textContent?.includes('Pick date'));
      fire(secondPick ?? null, 'click');

      expect(dateIn(first)?.value).toBe('2026-09-28');
      expect(dateIn(second)?.value).toBe('2026-09-24');
      first.unmount();
      second.unmount();
    });
  });
});
