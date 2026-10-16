// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';

import { rangeTitle } from '../../../../../src/components/calendar/calendar-dates';
import type { CalendarEvent, CalendarSource } from '../../../../../src/components/calendar/calendar-types';
import { CalendarView } from '../../../../../src/components/calendar/CalendarView';
import { cleanup, fire, render, toggle, type Mounted } from '../../../../helpers/render';

const at = (day: number, hour = 0, minute = 0) => new Date(2026, 9, day, hour, minute);
const ANCHOR = at(15, 12);

const calendars: CalendarSource[] = [
  { id: 'work', name: 'Work' },
  { id: 'home', name: 'Home' },
];
const timed = (id: string, calendarId: string, start: Date, end: Date, extra: Partial<CalendarEvent> = {}): CalendarEvent => ({
  id, calendarId, title: id, start: start.toISOString(), end: end.toISOString(), allDay: false, ...extra,
});
const events: CalendarEvent[] = [
  timed('Standup', 'work', at(15, 9), at(15, 9, 30), {
    location: 'Room 4',
    organizer: 'lead@example.invalid',
    attendees: ['first@example.invalid', 'second@example.invalid'],
    description: '<b>agenda</b>\nline two',
  }),
  timed('Dentist', 'home', at(16, 15), at(16, 16)),
  { id: 'Holiday', calendarId: 'home', title: 'Holiday', start: '2026-10-14', end: '2026-10-15', allDay: true },
];

let mounted: Mounted;
const mount = (props: Partial<React.ComponentProps<typeof CalendarView>> = {}) => {
  mounted = render(<CalendarView calendars={calendars} events={events} initialDate={ANCHOR} {...props} />);
  return mounted;
};
const title = () => mounted.find('.calv-title')!.textContent;
const buttonByText = (text: string) => mounted.all('button').find((button) => button.textContent?.trim() === text) ?? null;
const eventButtons = () => mounted.all('.calv-event, .calv-chip').map((button) => button.textContent);
const activeView = () => mounted.find('.seg-btn.is-on')!.textContent;

afterEach(() => cleanup());

describe('CalendarView', () => {
  // Regression: with no calendar sync yet the screen must still render, and
  // say why it is empty rather than look broken.
  it('renders an empty calendar with a note when there are no calendars', () => {
    mount({ calendars: [], events: [] });
    expect(mounted.find('.calv-note')!.textContent).toContain('calendar sync');
    expect(mounted.find('.calv-tg')).not.toBeNull();
    expect(eventButtons()).toEqual([]);
  });

  // Regression: week view is the default, titled for the anchor week, and
  // draws timed events in the grid and all-day ones in the all-day row.
  it('opens on the week view with timed and all-day events placed', () => {
    mount();
    expect(activeView()).toBe('Week');
    expect(title()).toBe(rangeTitle('week', ANCHOR));
    expect(mounted.all('.calv-event')).toHaveLength(2);
    expect(mounted.find('.calv-tg-allday .calv-chip')!.textContent).toContain('Holiday');
  });

  // Regression: selecting an event shows its details; the description is
  // server text and must render as TEXT, never as markup.
  it('shows the selected event and renders its description as text', () => {
    mount();
    fire(mounted.byLabel(mounted.all('.calv-event')[0]!.getAttribute('aria-label')!), 'click');
    const panel = mounted.find('.calv-detail')!;
    expect(panel.querySelector('h3')!.textContent).toBe('Standup');
    expect(panel.textContent).toContain('Room 4');
    expect(panel.textContent).toContain('Work');
    expect(panel.textContent).toContain('2 guests');
    expect(panel.textContent).toContain('<b>agenda</b>');
    expect(panel.querySelector('b')).toBeNull();
    expect(mounted.find('.calv-event.is-selected')).not.toBeNull();

    fire(mounted.byLabel('Close event details'), 'click');
    expect(mounted.find('.calv-detail')).toBeNull();
  });

  // Regression: unticking a calendar must hide its events everywhere — and
  // close the panel if the open event belonged to it.
  it('hides a calendar\'s events when it is unticked', () => {
    mount();
    fire(mounted.find('.calv-event')!, 'click');
    expect(mounted.find('.calv-detail')).not.toBeNull();

    toggle(mounted.all('.calv-cal-row input')[0]!); // Work
    expect(eventButtons().some((text) => text?.includes('Standup'))).toBe(false);
    expect(mounted.find('.calv-detail')).toBeNull();

    toggle(mounted.all('.calv-cal-row input')[0]!);
    expect(eventButtons().some((text) => text?.includes('Standup'))).toBe(true);
  });

  // Regression: the toolbar must move by the current view's length and come
  // back with Today.
  it('steps with previous / next and returns with Today', () => {
    mount();
    fire(mounted.byLabel('Next week'), 'click');
    expect(title()).toBe(rangeTitle('week', at(22)));
    fire(mounted.byLabel('Previous week'), 'click');
    fire(mounted.byLabel('Previous week'), 'click');
    expect(title()).toBe(rangeTitle('week', at(8)));
    fire(buttonByText('Today'), 'click');
    expect(title()).toBe(rangeTitle('week', new Date()));
  });

  // Regression: switching views swaps the grid and the heading.
  it('switches between month, week and day', () => {
    mount();
    fire(buttonByText('Month'), 'click');
    expect(activeView()).toBe('Month');
    expect(title()).toBe(rangeTitle('month', ANCHOR));
    expect(mounted.all('.calv-month-cell')).toHaveLength(42);
    expect(mounted.byLabel('Next month')).not.toBeNull();

    fire(buttonByText('Day'), 'click');
    expect(title()).toBe(rangeTitle('day', ANCHOR));
    expect(mounted.all('.calv-tg-col')).toHaveLength(1);
  });

  // Regression: a busy day must not overflow its month cell — the extra events
  // collapse into "+N more", which opens that day.
  it('collapses a busy month cell into "+N more" that opens the day', () => {
    const busy = Array.from({ length: 5 }, (_unused, index) =>
      timed(`Busy ${index}`, 'work', at(20, 9 + index), at(20, 9 + index, 30)));
    mount({ events: busy, initialView: 'month' });
    const more = buttonByText('+3 more');
    expect(more).not.toBeNull();
    expect(mounted.all('.calv-chip')).toHaveLength(2);

    fire(more, 'click');
    expect(activeView()).toBe('Day');
    expect(title()).toBe(rangeTitle('day', at(20)));
    expect(mounted.all('.calv-event')).toHaveLength(5);
  });

  // Regression: picking a day in the rail's month moves the main view there.
  it('moves the view to a day picked in the mini month', () => {
    mount();
    const label = at(28).toLocaleDateString(undefined, { dateStyle: 'full' });
    fire(mounted.find(`.ds-calendar [aria-label="${label}"]`), 'click');
    expect(title()).toBe(rangeTitle('week', at(28)));
    expect(mounted.find('.ds-calendar .cal-day.selected')!.textContent).toBe('28');
  });

  // Regression: paging the mini month browses it alone — the main view stays.
  it('pages the mini month without moving the main view', () => {
    mount();
    const before = title();
    fire(mounted.find('.ds-calendar [aria-label="Next month"]'), 'click');
    expect(mounted.find('.ds-calendar .cal-title')!.textContent).toBe(rangeTitle('month', new Date(2026, 10, 1)));
    expect(title()).toBe(before);
    fire(mounted.find('.ds-calendar [aria-label="Previous month"]'), 'click');
    expect(mounted.find('.ds-calendar .cal-title')!.textContent).toBe(rangeTitle('month', ANCHOR));
  });

  // Regression: a month chip must open its event, and a date number its day.
  it('opens an event from a month chip and a day from its date', () => {
    mount({ initialView: 'month' });
    const chip = mounted.all('.calv-chip').find((each) => each.textContent?.includes('Dentist'))!;
    fire(chip, 'click');
    expect(mounted.find('.calv-detail h3')!.textContent).toBe('Dentist');
    expect(chip.className).toContain('is-selected');

    const label = at(16).toLocaleDateString(undefined, { dateStyle: 'full' });
    fire(mounted.find(`.calv-month [aria-label="${label}"]`), 'click');
    expect(activeView()).toBe('Day');
    expect(title()).toBe(rangeTitle('day', at(16)));
  });

  // Regression: a week column's date opens that day.
  it('opens a day from the week header', () => {
    mount();
    const label = at(13).toLocaleDateString(undefined, { dateStyle: 'full' });
    fire(mounted.find(`.calv-tg-head [aria-label="${label}"]`), 'click');
    expect(activeView()).toBe('Day');
    expect(title()).toBe(rangeTitle('day', at(13)));
  });

  // Regression: an event whose calendar the list does not know (shared, or
  // arriving before its calendar) must still draw and open — with no
  // calendar line rather than a crash.
  it('handles an event from an unknown calendar', () => {
    mount({ events: [timed('Orphan', 'gone', at(15, 10), at(15, 11), { attendees: ['solo@example.invalid'] })] });
    const block = mounted.find('.calv-event')!;
    expect(block.getAttribute('style')).toContain('--cal-palette-1');
    fire(block, 'click');
    const panel = mounted.find('.calv-detail')!;
    expect(panel.textContent).toContain('1 guest');
    expect(panel.textContent).not.toContain('Work');
  });

  // Regression: a calendar's own colour must reach the list and its events.
  it('draws a calendar in the colour the server gave it', () => {
    mount({ calendars: [{ id: 'work', name: 'Work', color: '#123456' }], events: [events[0]!] });
    expect(mounted.find('.calv-cal-row')!.getAttribute('style')).toContain('#123456');
    expect(mounted.find('.calv-event')!.getAttribute('style')).toContain('#123456');
  });
});
