// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CalendarViews, type CalendarViewsProps } from '../../../../../src/components/calendar/CalendarViews';
import type { LocalCalendar, LocalCalendarOccurrence } from '../../../../../src/types/local-calendar';
import { act, cleanup, fire, render } from '../../../../helpers/render';

const work: LocalCalendar = { id: 'work', name: 'Work', color: '#2563eb', visible: true, blocksAvailability: true, isDefault: true, provider: 'local' };
const NOW = Date.parse('2026-10-21T10:20Z');
function occurrence(id: string, hour = 10, duration = 60, extra = {}): LocalCalendarOccurrence {
  const startMs = Date.parse('2026-10-21T00:00Z') + hour * 3_600_000;
  const endMs = startMs + duration * 60_000;
  return { occurrenceId: `${id}:${startMs}`, eventId: id, startMs, endMs, event: { id, calendarId: 'work', title: id, description: '', location: '', startMs, endMs, allDay: false, timeZone: 'UTC', busy: true, status: 'confirmed', reminderMinutes: null, updatedAt: NOW, ...extra } };
}
function mount(overrides: Partial<CalendarViewsProps> = {}) {
  const props: CalendarViewsProps = { view: 'month', date: '2026-10-21', timeZone: 'UTC', calendars: [work], occurrences: [occurrence('Planning')], onOpen: vi.fn(), onCreate: vi.fn(), onDateSelect: vi.fn(), nowMs: NOW, ...overrides };
  return { ...render(<CalendarViews {...props} />), props };
}
afterEach(cleanup);

describe('conventional Calendar canvas', () => {
  it('renders a dynamic month with separate weekday header, date navigation and distinct today marker', () => {
    const view = mount();
    expect(view.all('.calendar-canvas-weekdays span')).toHaveLength(7);
    expect(view.all('.calendar-canvas-month-day')).toHaveLength(35);
    expect(view.byLabel('Show day 2026-10-21')?.getAttribute('aria-current')).toBe('date');
    fire(view.byLabel('Show day 2026-10-22'), 'click'); expect(view.props.onDateSelect).toHaveBeenCalledExactlyOnceWith('2026-10-22');
    fire(view.byLabel('Create event on 2026-10-22'), 'click'); expect(view.props.onCreate).toHaveBeenCalledExactlyOnceWith('2026-10-22');
  });

  it('keeps month rows finite and opens every hidden event in a focus-trapped list', () => {
    const items = Array.from({ length: 7 }, (_, index) => occurrence(`Meeting ${index + 1}`, 8 + index));
    const view = mount({ occurrences: items });
    expect(view.all('.calendar-canvas-event-strip')).toHaveLength(3);
    const more = view.byLabel('Show all 7 events on 2026-10-21')!;
    expect(more.textContent).toBe('+4 more'); more.focus(); fire(more, 'click');
    const dialog = view.byLabel('Events on 2026-10-21')!;
    expect(dialog.getAttribute('role')).toBe('dialog');
    expect(dialog.querySelectorAll('.calendar-canvas-list-event')).toHaveLength(7);
    expect(document.activeElement).toBe(view.byLabel('Close day events'));
    const controls = [...dialog.querySelectorAll('button')]; controls.at(-1)!.focus(); fire(controls.at(-1)!, 'keydown', { key: 'Tab' });
    expect(document.activeElement).toBe(controls[0]);
    fire(dialog.querySelector('[aria-label="Open event: Meeting 7 (Work)"]'), 'click');
    expect(view.props.onOpen).toHaveBeenCalledExactlyOnceWith(items[6]); expect(view.byLabel('Events on 2026-10-21')).toBeNull();
    expect(document.activeElement).toBe(more);
  });

  it('dismisses month overflow with Escape and clears it when the displayed month changes', () => {
    const view = mount({ occurrences: Array.from({ length: 5 }, (_, i) => occurrence(`Meeting ${i}`)) });
    fire(view.byLabel('Show all 5 events on 2026-10-21'), 'click'); fire(view.byLabel('Events on 2026-10-21'), 'keydown', { key: 'Escape' });
    expect(view.byLabel('Events on 2026-10-21')).toBeNull();
    fire(view.byLabel('Show all 5 events on 2026-10-21'), 'click'); view.rerender(<CalendarViews {...view.props} date="2026-11-21" />);
    expect(view.byLabel('Events on 2026-10-21')).toBeNull();
  });

  it('positions week meetings in overlap lanes, retains all-day events and creates at the selected half hour', () => {
    const first = occurrence('Planning', 10, 60);
    const second = occurrence('Review', 10.5, 60);
    const holiday = occurrence('Holiday', 0, 1440, { allDay: true });
    const view = mount({ view: 'week', occurrences: [first, second, holiday] });
    expect(view.all('.calendar-canvas-time-day')).toHaveLength(7);
    expect(view.find('.calendar-canvas-time-scroll')?.scrollTop).toBe(480);
    const planning = view.byLabel('Open event: Planning (Work)')!;
    expect(planning.style.top).toBe('600px'); expect(planning.style.height).toBe('60px'); expect(planning.style.width).toContain('50%');
    expect(view.byLabel('Open event: Review (Work)')!.style.left).toContain('50%');
    expect(view.byLabel('Open event: Holiday (Work)')?.closest('.calendar-canvas-all-day')).not.toBeNull();
    expect(view.byLabel('Current time')?.style.top).toBe('620px');
    fire(view.byLabel('Create event on 2026-10-21 at 14:30'), 'click'); expect(view.props.onCreate).toHaveBeenCalledExactlyOnceWith('2026-10-21', 870);
    fire(planning, 'click'); expect(view.props.onOpen).toHaveBeenCalledExactlyOnceWith(first);
  });

  it('shows timed multi-day segments on each date and keeps very late short events readable inside the day', () => {
    const overnight = occurrence('Overnight', 23, 120);
    const late = occurrence('Last minute', 23 + 59 / 60, 1);
    const view = mount({ view: 'week', occurrences: [overnight, late] });
    const segments = view.all('[aria-label="Open event: Overnight (Work)"]'); expect(segments).toHaveLength(2);
    expect(segments[0]!.textContent).toContain('→'); expect(segments[1]!.textContent).toContain('←');
    const last = view.byLabel('Open event: Last minute (Work)')!;
    expect(last.style.height).toBe('28px'); expect(Number.parseFloat(last.style.top) + Number.parseFloat(last.style.height)).toBe(1440);
  });

  it('uses day-aware overnight times in month, agenda and the expanded day list without changing the event locator', () => {
    const night = occurrence('Overnight', 22, 210);
    const end = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' }).format(night.endMs);
    const view = mount({ occurrences: [night] });
    const monthEvents = view.all('[aria-label="Open event: Overnight (Work)"]');
    expect(monthEvents).toHaveLength(2);
    expect(monthEvents[1]!.querySelector('.calendar-canvas-event-time')?.textContent).toBe(`Until ${end}`);
    expect(monthEvents[1]!.title).toContain('21'); expect(monthEvents[1]!.title).toContain('22');
    view.rerender(<CalendarViews {...view.props} view="agenda" />);
    const agendaEvents = view.all('[aria-label="Open event: Overnight (Work)"]');
    expect(agendaEvents[0]!.querySelector('.calendar-canvas-list-time')?.textContent).toContain('24:00');
    expect(agendaEvents[1]!.querySelector('.calendar-canvas-list-time')?.textContent).toBe(`00:00${end}`);
    expect(agendaEvents[1]!.textContent).toContain('Continues from previous day');
    const moreItems = [night, ...Array.from({ length: 4 }, (_, i) => {
      const item = occurrence(`Next day ${i}`, 9 + i);
      return { ...item, startMs: item.startMs + 86_400_000, endMs: item.endMs + 86_400_000 };
    })];
    view.rerender(<CalendarViews {...view.props} occurrences={moreItems} />);
    fire(view.byLabel('Show all 5 events on 2026-10-22'), 'click');
    const expanded = view.byLabel('Events on 2026-10-22')!.querySelector('[aria-label="Open event: Overnight (Work)"]')!;
    expect(expanded.querySelector('.calendar-canvas-list-time')?.textContent).toBe(`00:00${end}`);
    fire(expanded, 'click'); expect(view.props.onOpen).toHaveBeenCalledExactlyOnceWith(night);
  });

  it('offers one keyboard slot per day with arrow navigation and preserves explicit all-day creation', () => {
    const view = mount({ view: 'week', occurrences: [] });
    expect(view.all('.calendar-canvas-slot[tabindex="0"]')).toHaveLength(7);
    const escaped = vi.fn(); window.addEventListener('keydown', escaped);
    try {
      const first = view.byLabel('Create event on 2026-10-21 at 09:00')!;
      act(() => first.focus()); fire(first, 'keydown', { key: 'ArrowDown' });
      const half = view.byLabel('Create event on 2026-10-21 at 09:30')!;
      expect(document.activeElement).toBe(half); expect(first.tabIndex).toBe(-1); expect(half.tabIndex).toBe(0);
      fire(half, 'keydown', { key: 'ArrowRight' }); expect(document.activeElement).toBe(view.byLabel('Create event on 2026-10-22 at 09:30'));
      expect(escaped).not.toHaveBeenCalled(); expect(view.all('.calendar-canvas-slot[tabindex="0"]')).toHaveLength(7);
      fire(view.byLabel('Create event on 2026-10-21'), 'click'); expect(view.props.onCreate).toHaveBeenCalledExactlyOnceWith('2026-10-21', undefined, true);
    } finally { window.removeEventListener('keydown', escaped); }
  });

  it('filters hidden calendars and renders the selected display timezone without moving all-day dates', () => {
    const hidden = { ...work, id: 'hidden', name: 'Hidden', visible: false };
    const holiday = occurrence('Holiday', 0, 1440, { allDay: true });
    const view = mount({ view: 'day', timeZone: 'Asia/Kolkata', calendars: [work, hidden], occurrences: [occurrence('Planning'), holiday, occurrence('Hidden event', 10, 60, { calendarId: 'hidden' })] });
    expect(view.byLabel('Open event: Planning (Work)')?.style.top).toBe('930px');
    expect(view.byLabel('Open event: Holiday (Work)')).not.toBeNull();
    expect(view.byLabel('Open event: Hidden event (Hidden)')).toBeNull();
    expect(view.byLabel('Current time')?.style.top).toBe('950px');
  });
});
