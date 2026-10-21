// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Calendar } from '../../../../../src/components/calendar/Calendar';
import type { CalendarResult, LocalCalendar, LocalCalendarAPI, LocalCalendarEvent, LocalCalendarOccurrence, LocalCalendarOpenEvent, LocalCalendarPreferences, LocalCalendarSnapshot } from '../../../../../src/types/local-calendar';
import { act, cleanup, fire, render, toggle, typeInto } from '../../../../helpers/render';

const confirm = vi.hoisted(() => vi.fn(async () => true));
vi.mock('../../../../../src/store/confirm-service', () => ({ requestConfirm: confirm }));
const NOW = Date.parse('2026-10-21T10:00:00Z');
const ok = <T,>(data: T): CalendarResult<T> => ({ success: true, data });
const personal: LocalCalendar = { id: 'personal', name: 'Personal', color: '#2563eb', provider: 'local', visible: true, blocksAvailability: true, isDefault: true };
const seedPreferences: LocalCalendarPreferences = { timeZone: 'UTC', workingDays: [1, 2, 3, 4, 5], workingStart: '09:00', workingEnd: '17:00', durationMinutes: 30, bufferBeforeMinutes: 0, bufferAfterMinutes: 0, minimumNoticeMinutes: 60, slotIntervalMinutes: 15 };
const seedEvent: LocalCalendarEvent = { id: 'planning', calendarId: 'personal', title: 'Planning meeting', description: 'Discuss the release.', location: 'Meeting room', startMs: NOW, endMs: NOW + 3_600_000, timeZone: 'UTC', allDay: false, busy: true, status: 'confirmed', reminderMinutes: 15, updatedAt: NOW };
const occurrence = (event = seedEvent, startMs = event.startMs): LocalCalendarOccurrence => ({ occurrenceId: `${event.id}:${startMs}`, eventId: event.parentEventId ?? event.id, startMs, endMs: startMs + event.endMs - event.startMs, event });
let calendars: LocalCalendar[];
let preferences: LocalCalendarPreferences;
let occurrences: LocalCalendarOccurrence[];
const changed = new Set<() => void>();
const opened = new Set<(event: LocalCalendarOpenEvent) => void>();
const api = {
  snapshot: vi.fn<LocalCalendarAPI['snapshot']>(async () => ok({ calendars, preferences, occurrences })),
  saveCalendar: vi.fn<LocalCalendarAPI['saveCalendar']>(async input => {
    const result: LocalCalendar = { ...input, id: input.id ?? 'created', provider: 'local' };
    calendars = [...calendars.filter(item => item.id !== result.id).map(item => result.isDefault ? { ...item, isDefault: false } : item), result];
    return ok(result);
  }),
  deleteCalendar: vi.fn<LocalCalendarAPI['deleteCalendar']>(async id => { calendars = calendars.filter(item => item.id !== id); return ok(null); }),
  saveEvent: vi.fn<LocalCalendarAPI['saveEvent']>(async input => {
    const result: LocalCalendarEvent = { ...input, id: input.id ?? 'created-event', updatedAt: NOW };
    occurrences = [...occurrences.filter(item => item.eventId !== result.id), occurrence(result)]; return ok(result);
  }),
  deleteEvent: vi.fn<LocalCalendarAPI['deleteEvent']>(async input => { occurrences = occurrences.filter(item => item.eventId !== input.id); return ok(null); }),
  savePreferences: vi.fn<LocalCalendarAPI['savePreferences']>(async input => { preferences = input; return ok(input); }),
  importIcs: vi.fn<LocalCalendarAPI['importIcs']>(async () => ok({ imported: 2 })),
  exportIcs: vi.fn<LocalCalendarAPI['exportIcs']>(async () => ok({ text: 'BEGIN:VCALENDAR\r\nEND:VCALENDAR' })),
  availability: vi.fn<LocalCalendarAPI['availability']>(),
  onChanged: vi.fn<LocalCalendarAPI['onChanged']>(listener => { changed.add(listener); return () => changed.delete(listener); }),
  onOpenEvent: vi.fn<LocalCalendarAPI['onOpenEvent']>(listener => { opened.add(listener); return () => opened.delete(listener); }),
};
async function settle() { await act(async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); }); }
async function mount(props = {}) { const view = render(<Calendar {...props} />); await settle(); return view; }
function button(view: ReturnType<typeof render>, text: string) { return view.all('button').find(item => item.textContent?.trim() === text) ?? null; }
function select(view: ReturnType<typeof render>, label: string, value: string) {
  if (label === 'Calendar view') { fire(view.byLabel(label)?.querySelector(`button[title^="${value[0]!.toUpperCase()}${value.slice(1)} view"]`) ?? null, 'click'); return; }
  const field = view.byLabel(label) as HTMLSelectElement; act(() => { field.value = value; field.dispatchEvent(new Event('change', { bubbles: true })); });
}
function check(view: ReturnType<typeof render>, text: string) { return view.all('label').find(label => label.textContent?.trim() === text)?.querySelector('input') ?? null; }

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(NOW); vi.clearAllMocks(); confirm.mockResolvedValue(true);
  calendars = [{ ...personal }]; preferences = { ...seedPreferences, workingDays: [...seedPreferences.workingDays] }; occurrences = [occurrence()]; changed.clear(); opened.clear();
  api.snapshot.mockImplementation(async () => ok({ calendars, preferences, occurrences }));
  Object.assign(window, { electronAPI: { calendar: api } });
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('local Calendar page', () => {
  it('switches views with shortcuts without intercepting typing or an open event editor', async () => {
    const view = await mount();
    const key = (target: Element, value: string) => act(() => { target.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true })); });
    key(document.body, 'w'); await settle();
    expect(view.byLabel('Week view')).not.toBeNull();
    expect(view.byLabel('Calendar view')?.querySelector('[aria-pressed="true"]')?.textContent).toBe('Week');
    key(view.byLabel('Calendar date')!, 'd'); await settle();
    expect(view.byLabel('Week view')).not.toBeNull();
    key(document.body, 'd'); await settle();
    expect(view.byLabel('Day view')).not.toBeNull();
    fire(button(view, 'New event'), 'click'); key(document.body, 'm'); await settle();
    expect(view.byLabel('Event title')).not.toBeNull();
    expect(view.byLabel('Day view')).not.toBeNull();
  });

  it('navigates the small calendar by keyboard and retains one date in the tab order', async () => {
    const view = await mount();
    const navigator = view.byLabel('Date navigator')!;
    const selected = navigator.querySelector<HTMLButtonElement>('button[aria-pressed="true"]')!;
    expect(selected.textContent).toBe('21');
    expect(navigator.querySelectorAll('button[aria-pressed][tabindex="0"]')).toHaveLength(1);
    act(() => { selected.focus(); selected.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true })); });
    await settle();
    expect((view.byLabel('Calendar date') as HTMLInputElement).value).toBe('2026-10-22');
    expect(document.activeElement?.textContent).toBe('22');
    act(() => { document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })); });
    await settle();
    expect((view.byLabel('Calendar date') as HTMLInputElement).value).toBe('2026-10-29');
    expect(document.activeElement?.textContent).toBe('29');
  });

  it('starts a new event at the clicked time and creates an all-day event from its own row', async () => {
    const view = await mount(); select(view, 'Calendar view', 'week'); await settle();
    fire(view.byLabel('Create event on 2026-10-21 at 11:30'), 'click');
    expect((view.byLabel('Event start') as HTMLInputElement).value).toBe('2026-10-21T11:30');
    expect((view.byLabel('Event end') as HTMLInputElement).value).toBe('2026-10-21T12:30');
    typeInto(view.byLabel('Event title'), 'Time grid meeting'); fire(button(view, 'Save event'), 'click'); await settle();
    expect(api.saveEvent).toHaveBeenCalledWith(expect.objectContaining({ startMs: Date.parse('2026-10-21T11:30Z'), endMs: Date.parse('2026-10-21T12:30Z') }));
    fire(view.byLabel('Create event on 2026-10-21'), 'click');
    expect((check(view, 'All day') as HTMLInputElement).checked).toBe(true);
    expect((view.byLabel('Event start') as HTMLInputElement).value).toBe('2026-10-21');
    typeInto(view.byLabel('Event title'), 'Day away'); fire(button(view, 'Save event'), 'click'); await settle();
    expect(api.saveEvent).toHaveBeenLastCalledWith(expect.objectContaining({ allDay: true, startDate: '2026-10-21', endDate: '2026-10-22' }));
  });

  it('uses the full available page, exposes local-only scope, and switches all four views with bounded date ranges', async () => {
    const view = await mount();
    expect(view.byLabel('Calendar')?.className).toContain('w-full');
    expect(view.byLabel('Calendar')?.className).not.toContain('max-w');
    expect(view.container.textContent).toContain('Local calendars only.');
    expect(view.byLabel('Month view')).not.toBeNull();
    for (const mode of ['day', 'week', 'agenda', 'month']) {
      select(view, 'Calendar view', mode); await settle();
      expect(view.byLabel(`${mode[0]!.toUpperCase()}${mode.slice(1)} view`)).not.toBeNull();
      const range = api.snapshot.mock.calls.at(-1)![0]; expect(range.endMs).toBeGreaterThan(range.startMs);
      expect(range.endMs - range.startMs).toBeLessThanOrEqual(43 * 86_400_000);
    }
    fire(view.byLabel('Next calendar period'), 'click'); await settle();
    expect((view.byLabel('Calendar date') as HTMLInputElement).value).toBe('2026-11-01');
    fire(button(view, 'Today'), 'click'); await settle();
    expect((view.byLabel('Calendar date') as HTMLInputElement).value).toBe('2026-10-21');
  });

  it('creates an event with local wall time, recurrence and reminder and refreshes the visible calendar', async () => {
    const view = await mount(); fire(button(view, 'New event'), 'click');
    typeInto(view.byLabel('Event title'), 'Customer review');
    typeInto(view.byLabel('Event start'), '2026-10-21T14:00'); typeInto(view.byLabel('Event end'), '2026-10-21T15:00');
    select(view, 'Event recurrence', 'monthly'); typeInto(view.byLabel('Recurrence interval'), '2'); typeInto(view.byLabel('Recurrence until'), '2026-12-31'); select(view, 'Event reminder', '30');
    fire(button(view, 'Save event'), 'click'); await settle();
    expect(api.saveEvent).toHaveBeenCalledWith(expect.objectContaining({ calendarId: 'personal', title: 'Customer review', startMs: Date.parse('2026-10-21T14:00Z'), endMs: Date.parse('2026-10-21T15:00Z'), timeZone: 'UTC', allDay: false, reminderMinutes: 30, recurrence: { frequency: 'monthly', interval: 2, until: '2026-12-31' } }));
    expect(view.byLabel('Event title')).toBeNull();
    expect(view.byLabel('Open event: Customer review (Personal)')).not.toBeNull();
  });

  it('saves all-day inclusive UI dates as an exclusive end date without losing multi-day coverage', async () => {
    const view = await mount(); fire(button(view, 'New event'), 'click');
    typeInto(view.byLabel('Event title'), 'Conference'); toggle(check(view, 'All day'));
    typeInto(view.byLabel('Event start'), '2026-10-21'); typeInto(view.byLabel('Event end'), '2026-10-23');
    fire(button(view, 'Save event'), 'click'); await settle();
    expect(api.saveEvent).toHaveBeenCalledWith(expect.objectContaining({ allDay: true, startDate: '2026-10-21', endDate: '2026-10-24', startMs: Date.parse('2026-10-21T00:00Z'), endMs: Date.parse('2026-10-24T00:00Z') }));
    expect(view.all('button').filter(item => item.getAttribute('aria-label') === 'Open event: Conference (Personal)')).toHaveLength(3);
  });

  it('keeps all-day calendar dates stable when the display time zone differs from the event zone', async () => {
    occurrences = [occurrence({ ...seedEvent, title: 'Local holiday', allDay: true, timeZone: 'Asia/Kolkata', startDate: '2026-10-21', endDate: '2026-10-22', startMs: Date.parse('2026-10-20T18:30Z'), endMs: Date.parse('2026-10-21T18:30Z') })];
    const view = await mount();
    const event = view.byLabel('Open event: Local holiday (Personal)')!;
    expect(view.all('button').filter(item => item.getAttribute('aria-label') === 'Open event: Local holiday (Personal)')).toHaveLength(1);
    expect(event.closest('section')?.getAttribute('aria-label')).toContain('21');
  });

  it('edits one recurring occurrence using its original locator while series editing preserves the original series date', async () => {
    const repeating = { ...seedEvent, startMs: NOW - 7 * 86_400_000, endMs: NOW - 7 * 86_400_000 + 3_600_000, recurrence: { frequency: 'weekly' as const, interval: 1, weekDays: [3] } };
    occurrences = [occurrence(repeating, NOW)];
    const view = await mount(); fire(view.byLabel('Open event: Planning meeting (Personal)'), 'click');
    expect((view.byLabel('Event edit scope') as HTMLSelectElement).value).toBe('occurrence');
    select(view, 'Event edit scope', 'series'); expect((view.byLabel('Event start') as HTMLInputElement).value).toBe('2026-10-14T10:00');
    select(view, 'Event edit scope', 'occurrence'); expect((view.byLabel('Event start') as HTMLInputElement).value).toBe('2026-10-21T10:00');
    expect((view.byLabel('Event end') as HTMLInputElement).value).toBe('2026-10-21T11:00');
    typeInto(view.byLabel('Event title'), 'Rescheduled planning'); fire(button(view, 'Save event'), 'click'); await settle();
    expect(api.saveEvent).toHaveBeenCalledWith(expect.objectContaining({ id: 'planning', scope: 'occurrence', occurrenceStartMs: NOW, startMs: NOW, endMs: NOW + 3_600_000, title: 'Rescheduled planning' }));
    expect(api.saveEvent.mock.calls.at(-1)![0].recurrence).toBeUndefined();
    occurrences = [occurrence(repeating, NOW)]; act(() => { for (const listener of changed) listener(); }); await settle();
    fire(view.byLabel('Open event: Planning meeting (Personal)'), 'click'); select(view, 'Event edit scope', 'series');
    expect((view.byLabel('Event start') as HTMLInputElement).value).toBe('2026-10-14T10:00');
    fire(button(view, 'Delete event'), 'click'); await settle();
    expect(api.deleteEvent).toHaveBeenCalledExactlyOnceWith({ id: 'planning', scope: 'series' });
  });

  it('restores inclusive all-day occurrence dates after a round trip through series scope', async () => {
    const startMs = Date.parse('2026-10-21T00:00Z');
    const repeating = { ...seedEvent, title: 'Weekly all-day', allDay: true, startDate: '2026-10-14', endDate: '2026-10-16', startMs: Date.parse('2026-10-14T00:00Z'), endMs: Date.parse('2026-10-16T00:00Z'), recurrence: { frequency: 'weekly' as const, interval: 1 } };
    occurrences = [occurrence(repeating, startMs)];
    const view = await mount(); fire(view.byLabel('Open event: Weekly all-day (Personal)'), 'click');
    select(view, 'Event edit scope', 'series'); expect((view.byLabel('Event start') as HTMLInputElement).value).toBe('2026-10-14');
    expect((view.byLabel('Event end') as HTMLInputElement).value).toBe('2026-10-15');
    select(view, 'Event edit scope', 'occurrence'); expect((view.byLabel('Event start') as HTMLInputElement).value).toBe('2026-10-21');
    expect((view.byLabel('Event end') as HTMLInputElement).value).toBe('2026-10-22');
    typeInto(view.byLabel('Event title'), 'Updated all-day title'); fire(button(view, 'Save event'), 'click'); await settle();
    expect(api.saveEvent).toHaveBeenCalledWith(expect.objectContaining({ id: 'planning', scope: 'occurrence', occurrenceStartMs: startMs, startDate: '2026-10-21', endDate: '2026-10-23', startMs, endMs: Date.parse('2026-10-23T00:00Z') }));
  });

  it('keeps a moved recurring override bound to its master and original occurrence', async () => {
    occurrences = [occurrence({ ...seedEvent, id: 'override', title: 'Moved planning', startMs: NOW + 86_400_000, endMs: NOW + 86_400_000 + 3_600_000, parentEventId: 'planning', originalStartMs: NOW })];
    const view = await mount(); fire(view.byLabel('Open event: Moved planning (Personal)'), 'click');
    expect([...(view.byLabel('Event edit scope') as HTMLSelectElement).options].map(option => option.value)).toEqual(['occurrence']);
    typeInto(view.byLabel('Event title'), 'Updated moved planning'); fire(button(view, 'Save event'), 'click'); await settle();
    expect(api.saveEvent).toHaveBeenCalledWith(expect.objectContaining({ id: 'planning', scope: 'occurrence', occurrenceStartMs: NOW, startMs: NOW + 86_400_000 }));
  });

  it('keeps a hidden calendar in availability checks until its separate preference is changed', async () => {
    const view = await mount(); toggle(view.byLabel('Show calendar: Personal')); await settle();
    expect(api.saveCalendar).toHaveBeenCalledWith({ id: 'personal', name: 'Personal', color: '#2563eb', visible: false, blocksAvailability: true, isDefault: true });
    expect(view.byLabel('Open event: Planning meeting (Personal)')).toBeNull();
    expect(view.container.textContent).toContain('Checks availability');
    fire(view.byLabel('Manage calendar: Personal'), 'click'); toggle(check(view, 'Include in availability checks')); fire(button(view, 'Save calendar'), 'click'); await settle();
    expect(api.saveCalendar).toHaveBeenLastCalledWith(expect.objectContaining({ visible: false, blocksAvailability: false }));
    expect(view.container.textContent).toContain('Display only');
  });

  it('manages calendar name, color and default status and confirms deletion', async () => {
    const view = await mount(); fire(view.byLabel('Create local calendar'), 'click');
    typeInto(view.byLabel('Calendar name'), 'Work'); typeInto(view.byLabel('Calendar color'), '#16a34a'); toggle(check(view, 'Default for new events'));
    fire(button(view, 'Save calendar'), 'click'); await settle();
    expect(api.saveCalendar).toHaveBeenCalledWith(expect.objectContaining({ name: 'Work', color: '#16a34a', isDefault: true, blocksAvailability: true, visible: true }));
    fire(view.byLabel('Manage calendar: Work'), 'click'); fire(button(view, 'Delete calendar'), 'click'); await settle();
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ destructive: true, title: 'Delete local calendar' }));
    expect(api.deleteCalendar).toHaveBeenCalledExactlyOnceWith('created');
  });

  it('saves working hours and time zone and renders event times in that chosen zone', async () => {
    const view = await mount(); fire(button(view, 'Working hours & preferences'), 'click');
    typeInto(view.byLabel('Calendar time zone'), 'Asia/Kolkata'); typeInto(view.byLabel('Working hours start'), '10:00'); typeInto(view.byLabel('Buffer before suggested meeting (minutes)'), '10');
    fire(button(view, 'Save preferences'), 'click'); await settle();
    expect(api.savePreferences).toHaveBeenCalledWith(expect.objectContaining({ timeZone: 'Asia/Kolkata', workingStart: '10:00', bufferBeforeMinutes: 10 }));
    select(view, 'Calendar view', 'day'); await settle();
    const time = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' }).format(NOW);
    expect(view.byLabel('Open event: Planning meeting (Personal)')?.textContent).toContain(time);
  });

  it('imports and exports bounded iCalendar text without calling external providers', async () => {
    const view = await mount(); fire(button(view, 'Import / export .ics'), 'click');
    typeInto(view.byLabel('Calendar import text'), 'BEGIN:VCALENDAR\nEND:VCALENDAR'); fire(button(view, 'Import events'), 'click'); await settle();
    expect(api.importIcs).toHaveBeenCalledExactlyOnceWith({ calendarId: 'personal', text: 'BEGIN:VCALENDAR\nEND:VCALENDAR' });
    expect(view.container.textContent).toContain('2 events imported.');
    fire(button(view, 'Export calendar'), 'click'); await settle();
    expect(api.exportIcs).toHaveBeenCalledExactlyOnceWith({ calendarId: 'personal' });
    expect((view.byLabel('Calendar export text') as HTMLTextAreaElement).value).toBe('BEGIN:VCALENDAR\r\nEND:VCALENDAR');
  });

  it('rejects oversized UTF-8 calendar imports before invoking the main process', async () => {
    const view = await mount(); fire(button(view, 'Import / export .ics'), 'click');
    typeInto(view.byLabel('Calendar import text'), '😀'.repeat(250_001)); fire(button(view, 'Import events'), 'click'); await settle();
    expect(api.importIcs).not.toHaveBeenCalled();
    expect(view.find('[role="alert"]')?.textContent).toContain('smaller than 1 MB');
  });

  it('rejects nonexistent daylight-saving wall times without discarding the event draft', async () => {
    const view = await mount(); fire(button(view, 'New event'), 'click'); typeInto(view.byLabel('Event title'), 'Spring transition');
    typeInto(view.byLabel('Event time zone'), 'America/New_York'); typeInto(view.byLabel('Event start'), '2026-03-08T02:30'); typeInto(view.byLabel('Event end'), '2026-03-08T03:30');
    fire(button(view, 'Save event'), 'click'); await settle();
    expect(api.saveEvent).not.toHaveBeenCalled();
    expect(view.find('[role="alert"]')?.textContent).toContain('does not exist');
    expect((view.byLabel('Event title') as HTMLInputElement).value).toBe('Spring transition');
  });

  it('preserves a second-fold instant when only the title of an imported event changes', async () => {
    const startMs = Date.parse('2026-11-01T06:30:00Z'); const endMs = Date.parse('2026-11-01T07:30:00Z');
    occurrences = [occurrence({ ...seedEvent, startMs, endMs, timeZone: 'America/New_York' })];
    const view = await mount(); fire(view.byLabel('Open event: Planning meeting (Personal)'), 'click');
    expect((view.byLabel('Event start') as HTMLInputElement).value).toBe('2026-11-01T01:30');
    typeInto(view.byLabel('Event title'), 'Retitled imported meeting'); fire(button(view, 'Save event'), 'click'); await settle();
    expect(api.saveEvent).toHaveBeenCalledWith(expect.objectContaining({ startMs, endMs, timeZone: 'America/New_York' }));
  });

  it('preserves untouched endpoint seconds independently when changing the other event time', async () => {
    const endMs = NOW + 30 * 60_000 + 54_321;
    occurrences = [occurrence({ ...seedEvent, startMs: NOW + 12_345, endMs })];
    const view = await mount(); fire(view.byLabel('Open event: Planning meeting (Personal)'), 'click');
    typeInto(view.byLabel('Event start'), '2026-10-21T10:15'); fire(button(view, 'Save event'), 'click'); await settle();
    expect(api.saveEvent).toHaveBeenCalledWith(expect.objectContaining({ startMs: NOW + 15 * 60_000, endMs }));
  });

  it('renders midnight-gap dates and saves all-day events using their first valid instant', async () => {
    preferences = { ...preferences, timeZone: 'America/Santiago' };
    const view = await mount(); select(view, 'Calendar view', 'day'); typeInto(view.byLabel('Calendar date'), '2026-09-06'); await settle();
    expect(view.byLabel('Day view')).not.toBeNull();
    expect(api.snapshot).toHaveBeenLastCalledWith({ startMs: Date.parse('2026-09-06T04:00Z'), endMs: Date.parse('2026-09-07T03:00Z') });
    fire(button(view, 'New event'), 'click'); typeInto(view.byLabel('Event title'), 'DST holiday'); toggle(check(view, 'All day'));
    fire(button(view, 'Save event'), 'click'); await settle();
    expect(api.saveEvent).toHaveBeenCalledWith(expect.objectContaining({ allDay: true, startDate: '2026-09-06', endDate: '2026-09-07', startMs: Date.parse('2026-09-06T04:00Z'), endMs: Date.parse('2026-09-07T03:00Z') }));
  });

  it('traps keyboard focus inside event editing and leaves the drawer with Escape', async () => {
    const view = await mount(); fire(button(view, 'New event'), 'click'); typeInto(view.byLabel('Event title'), 'Keyboard review');
    const save = button(view, 'Save event')!; act(() => save.focus()); fire(save, 'keydown', { key: 'Tab' });
    expect(document.activeElement).toBe(view.byLabel('Close event details'));
    fire(view.byLabel('Event title'), 'keydown', { key: 'Escape' });
    expect(view.byLabel('Event title')).toBeNull(); expect(api.saveEvent).not.toHaveBeenCalled();
  });

  it('retains an event draft when saving fails and reports snapshot errors with retry', async () => {
    const view = await mount(); fire(button(view, 'New event'), 'click'); typeInto(view.byLabel('Event title'), 'Keep this draft');
    api.saveEvent.mockResolvedValueOnce({ success: false, error: 'Event could not be stored.' }); fire(button(view, 'Save event'), 'click'); await settle();
    expect(view.find('[role="alert"]')?.textContent).toContain('Event could not be stored.');
    expect((view.byLabel('Event title') as HTMLInputElement).value).toBe('Keep this draft');
    fire(view.byLabel('Close event details'), 'click'); api.snapshot.mockResolvedValueOnce({ success: false, error: 'Calendar unavailable.' });
    act(() => { for (const listener of changed) listener(); }); await settle();
    expect(view.find('[role="alert"]')?.textContent).toContain('Calendar unavailable.');
    fire(button(view, 'Try again'), 'click'); await settle(); expect(view.byLabel('Month view')).not.toBeNull();
  });

  it('opens reminder events from a pending global id and removes listeners when leaving', async () => {
    const payload = { eventId: 'planning', startMs: NOW, occurrenceId: occurrence().occurrenceId };
    const onEventOpened = vi.fn(); const view = await mount({ initialEvent: payload, onEventOpened });
    expect((view.byLabel('Event title') as HTMLInputElement).value).toBe('Planning meeting');
    expect(onEventOpened).toHaveBeenCalledWith(payload);
    expect(changed.size).toBe(1); expect(opened.size).toBe(1);
    view.unmount(); expect(changed.size).toBe(0); expect(opened.size).toBe(0);
  });

  it('navigates a reminder to its exact recurring occurrence date instead of choosing the nearest occurrence to Today', async () => {
    const later = Date.parse('2026-12-31T10:00Z');
    const repeating = { ...seedEvent, recurrence: { frequency: 'daily' as const, interval: 1 } };
    const expected = occurrence(repeating, later);
    occurrences = [occurrence(repeating), occurrence(repeating, later - 86_400_000), expected];
    const payload = { eventId: 'planning', startMs: later, occurrenceId: expected.occurrenceId };
    const onEventOpened = vi.fn(); const view = await mount({ initialEvent: payload, onEventOpened });
    expect((view.byLabel('Calendar date') as HTMLInputElement).value).toBe('2026-12-31');
    expect((view.byLabel('Event start') as HTMLInputElement).value).toBe('2026-12-31T10:00');
    expect(onEventOpened).toHaveBeenCalledWith(payload);
  });

  it('does not open a different series occurrence when a reminder points to a missing one', async () => {
    const payload = { eventId: 'planning', startMs: NOW + 86_400_000, occurrenceId: 'missing-occurrence' };
    const view = await mount({ initialEvent: payload });
    expect(view.byLabel('Event title')).toBeNull();
    expect(view.container.textContent).toContain('This event is no longer available.');
    expect(view.byLabel('Month view')).not.toBeNull();
  });

  it('shows loading until a snapshot is ready and ignores responses after unmount', async () => {
    let resolve!: (result: CalendarResult<LocalCalendarSnapshot>) => void;
    api.snapshot.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const view = render(<Calendar />); expect(view.container.textContent).toContain('Loading calendar…');
    expect((button(view, 'New event') as HTMLButtonElement).disabled).toBe(true);
    view.unmount(); await act(async () => resolve(ok({ calendars, preferences, occurrences })));
    expect(view.container.isConnected).toBe(false);
  });

  it('keeps calendar selection reachable when its own pane becomes narrow', async () => {
    const width = window.innerWidth;
    const view = await mount();
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 600 });
    act(() => { window.dispatchEvent(new Event('resize')); });
    expect(view.byLabel('Local calendars')?.className).toContain('hidden');
    fire(view.byLabel('Show calendar sidebar'), 'click');
    expect(view.byLabel('Local calendars')?.className).toContain('absolute');
    expect(view.byLabel('Local calendars')?.getAttribute('aria-modal')).toBe('true');
    expect(document.activeElement).toBe(view.byLabel('Close calendar sidebar'));
    act(() => { document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); });
    expect(view.byLabel('Local calendars')?.className).toContain('hidden');
    expect(document.activeElement).toBe(view.byLabel('Show calendar sidebar'));
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
    act(() => { window.dispatchEvent(new Event('resize')); });
  });

  it('does not replace a newer view with a stale snapshot response', async () => {
    let resolve!: (result: CalendarResult<LocalCalendarSnapshot>) => void;
    api.snapshot.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const view = render(<Calendar />); select(view, 'Calendar view', 'day'); await settle();
    expect(view.byLabel('Day view')).not.toBeNull();
    await act(async () => resolve(ok({ calendars: [{ ...personal, name: 'Stale calendar' }], preferences: { ...preferences, timeZone: 'Asia/Tokyo' }, occurrences: [] })));
    expect(view.byLabel('Day view')).not.toBeNull();
    expect(view.byLabel('Show calendar: Personal')).not.toBeNull();
    expect(view.container.textContent).not.toContain('Stale calendar');
  });
});
