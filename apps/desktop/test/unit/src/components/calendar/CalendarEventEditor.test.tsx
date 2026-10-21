// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CalendarEventEditor } from '../../../../../src/components/calendar/CalendarEventEditor';
import type { LocalCalendar, LocalCalendarAPI, LocalCalendarEvent, LocalCalendarEventInput, LocalCalendarOccurrence, LocalCalendarPreferences } from '../../../../../src/types/local-calendar';
import { act, cleanup, fire, render, settle, typeInto } from '../../../../helpers/render';

const calendar: LocalCalendar = { id: 'personal', name: 'Personal', color: '#2563eb', provider: 'local', visible: true, blocksAvailability: true, isDefault: true };
const preferences: LocalCalendarPreferences = { timeZone: 'Asia/Kolkata', workingDays: [1, 2, 3, 4, 5], workingStart: '09:00', workingEnd: '17:00', durationMinutes: 30, bufferBeforeMinutes: 0, bufferAfterMinutes: 0, minimumNoticeMinutes: 0, slotIntervalMinutes: 15 };
const saveEvent = vi.fn<LocalCalendarAPI['saveEvent']>();
const onSaved = vi.fn();
const onClose = vi.fn();
const baseProps = { calendars: [calendar], preferences, date: '2026-10-21', onSaved, onClose };
function button(view: ReturnType<typeof render>, text: string) { return view.all('button').find(item => item.textContent?.trim() === text) ?? null; }
function value(view: ReturnType<typeof render>, label: string) { return (view.byLabel(label) as HTMLInputElement).value; }

beforeEach(() => {
  vi.clearAllMocks();
  saveEvent.mockImplementation(async input => ({ success: true, data: { ...input, id: input.id ?? 'created', updatedAt: Date.now() } }));
  Object.assign(window, { electronAPI: { calendar: { saveEvent } } });
});
afterEach(cleanup);

describe('CalendarEventEditor', () => {
  it('prefills a clicked timeline minute and saves it in the chosen calendar time zone', async () => {
    const view = render(<CalendarEventEditor {...baseProps} startMinute={14 * 60 + 30} />);
    expect(value(view, 'Event start')).toBe('2026-10-21T14:30');
    expect(value(view, 'Event end')).toBe('2026-10-21T15:30');
    typeInto(view.byLabel('Event title'), 'Afternoon review'); fire(button(view, 'Save event'), 'click'); await settle();
    expect(saveEvent).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ startMs: Date.parse('2026-10-21T09:00Z'), endMs: Date.parse('2026-10-21T10:00Z'), timeZone: 'Asia/Kolkata' }));
    expect(onSaved).toHaveBeenCalledOnce();
  });

  it('opens a new all-day event on only the clicked date and saves its exclusive end in the calendar time zone', async () => {
    const view = render(<CalendarEventEditor {...baseProps} initialAllDay />);
    expect((view.byLabel('Event start') as HTMLInputElement).type).toBe('date');
    expect((view.byLabel('Event end') as HTMLInputElement).type).toBe('date');
    expect(value(view, 'Event start')).toBe('2026-10-21');
    expect(value(view, 'Event end')).toBe('2026-10-21');
    typeInto(view.byLabel('Event title'), 'Company holiday'); fire(button(view, 'Save event'), 'click'); await settle();
    expect(saveEvent).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ allDay: true, startDate: '2026-10-21', endDate: '2026-10-22', startMs: Date.parse('2026-10-20T18:30Z'), endMs: Date.parse('2026-10-21T18:30Z'), timeZone: 'Asia/Kolkata' }));
  });

  it('uses the existing event type instead of the all-day creation default when editing', async () => {
    const event: LocalCalendarEvent = { id: 'timed', calendarId: calendar.id, title: 'Timed meeting', description: '', location: '', startMs: Date.parse('2026-10-21T10:00Z'), endMs: Date.parse('2026-10-21T11:00Z'), timeZone: 'UTC', allDay: false, busy: true, status: 'confirmed', reminderMinutes: null, updatedAt: 0 };
    const occurrence: LocalCalendarOccurrence = { eventId: event.id, occurrenceId: `${event.id}:${event.startMs}`, startMs: event.startMs, endMs: event.endMs, event };
    const view = render(<CalendarEventEditor {...baseProps} occurrence={occurrence} initialAllDay />);
    expect((view.byLabel('Event start') as HTMLInputElement).type).toBe('datetime-local');
    expect(value(view, 'Event start')).toBe('2026-10-21T10:00');
    fire(button(view, 'Save event'), 'click'); await settle();
    expect(saveEvent).toHaveBeenCalledWith(expect.objectContaining({ allDay: false, startMs: event.startMs, endMs: event.endMs }));
  });

  it('rolls a late clicked time across midnight without creating a negative event duration', async () => {
    const view = render(<CalendarEventEditor {...baseProps} startMinute={23 * 60 + 30} />);
    expect(value(view, 'Event start')).toBe('2026-10-21T23:30');
    expect(value(view, 'Event end')).toBe('2026-10-22T00:30');
    typeInto(view.byLabel('Event title'), 'Late meeting'); fire(button(view, 'Save event'), 'click'); await settle();
    const input = saveEvent.mock.calls[0]![0]; expect(input.endMs - input.startMs).toBe(3_600_000);
  });

  it.each([undefined, -1, 1440, 90.5, Number.NaN])('uses the morning default for an absent or invalid timeline minute (%s)', minute => {
    const view = render(<CalendarEventEditor {...baseProps} startMinute={minute} />);
    expect(value(view, 'Event start')).toBe('2026-10-21T09:00');
    expect(value(view, 'Event end')).toBe('2026-10-21T10:00');
  });

  it('keeps an existing event exact instant when a timeline default is also present', async () => {
    const event: LocalCalendarEvent = { id: 'fold', calendarId: calendar.id, title: 'Repeated hour', description: '', location: '', startMs: Date.parse('2026-11-01T06:30Z'), endMs: Date.parse('2026-11-01T07:30Z'), timeZone: 'America/New_York', allDay: false, busy: true, status: 'confirmed', reminderMinutes: null, updatedAt: 0 };
    const occurrence: LocalCalendarOccurrence = { eventId: event.id, occurrenceId: `${event.id}:${event.startMs}`, startMs: event.startMs, endMs: event.endMs, event };
    const view = render(<CalendarEventEditor {...baseProps} occurrence={occurrence} startMinute={600} />);
    expect(value(view, 'Event start')).toBe('2026-11-01T01:30');
    fire(button(view, 'Save event'), 'click'); await settle();
    expect(saveEvent).toHaveBeenCalledWith(expect.objectContaining({ startMs: event.startMs, endMs: event.endMs, timeZone: event.timeZone }));
  });

  it('keeps occurrence scope and dates intact if switching scopes encounters an incomplete time zone', async () => {
    const event: LocalCalendarEvent = { id: 'weekly', calendarId: calendar.id, title: 'Weekly planning', description: '', location: '', startMs: Date.parse('2026-10-14T10:00Z'), endMs: Date.parse('2026-10-14T11:00Z'), timeZone: 'UTC', allDay: false, busy: true, status: 'confirmed', reminderMinutes: null, recurrence: { frequency: 'weekly', interval: 1 }, updatedAt: 0 };
    const occurrence: LocalCalendarOccurrence = { eventId: event.id, occurrenceId: `${event.id}:later`, startMs: Date.parse('2026-10-21T10:00Z'), endMs: Date.parse('2026-10-21T11:00Z'), event };
    const view = render(<CalendarEventEditor {...baseProps} occurrence={occurrence} />);
    typeInto(view.byLabel('Event title'), 'Keep my weekly draft');
    typeInto(view.byLabel('Event time zone'), 'America/');
    const scope = view.byLabel('Event edit scope') as HTMLSelectElement;
    act(() => { scope.value = 'series'; scope.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(scope.value).toBe('occurrence');
    expect(value(view, 'Event start')).toBe('2026-10-21T10:00');
    expect(value(view, 'Event end')).toBe('2026-10-21T11:00');
    expect(view.find('[role="alert"]')?.textContent).toContain('Enter a valid time zone');
    expect(saveEvent).not.toHaveBeenCalled();
    typeInto(view.byLabel('Event time zone'), 'UTC');
    act(() => { scope.value = 'series'; scope.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(value(view, 'Event start')).toBe('2026-10-14T10:00');
    expect(view.find('[role="alert"]')).toBeNull();
    fire(button(view, 'Save event'), 'click'); await settle();
    expect(saveEvent).toHaveBeenCalledWith(expect.objectContaining({ id: event.id, scope: 'series', title: 'Keep my weekly draft', startMs: event.startMs, endMs: event.endMs }));
  });

  it('returns keyboard focus to the opener when the modal is dismissed', () => {
    const opener = document.createElement('button'); opener.textContent = 'Create a meeting'; document.body.appendChild(opener); opener.focus();
    const view = render(<CalendarEventEditor {...baseProps} />);
    expect(document.activeElement).toBe(view.byLabel('Event title'));
    fire(view.byLabel('Event title'), 'keydown', { key: 'Escape' }); expect(onClose).toHaveBeenCalledOnce();
    view.unmount(); expect(document.activeElement).toBe(opener); opener.remove();
  });

  it('locks the draft while saving and prevents duplicate submits or dismissal before completion', async () => {
    let submitted!: LocalCalendarEventInput;
    let finish!: (result: Awaited<ReturnType<LocalCalendarAPI['saveEvent']>>) => void;
    saveEvent.mockImplementation(input => { submitted = input; return new Promise(done => { finish = done; }); });
    const view = render(<CalendarEventEditor {...baseProps} />);
    typeInto(view.byLabel('Event title'), 'Keep this draft'); fire(button(view, 'Save event'), 'click');
    expect((view.byLabel('Event title')?.closest('fieldset') as HTMLFieldSetElement).disabled).toBe(true);
    expect(document.activeElement).toBe(view.find('[role="dialog"]'));
    fire(view.find('form'), 'submit'); fire(view.byLabel('Event title'), 'keydown', { key: 'Escape' });
    expect(saveEvent).toHaveBeenCalledOnce(); expect(onClose).not.toHaveBeenCalled();
    await act(async () => finish({ success: true, data: { ...submitted, id: 'created', updatedAt: 0 } }));
    expect(onSaved).toHaveBeenCalledOnce();
  });
});
