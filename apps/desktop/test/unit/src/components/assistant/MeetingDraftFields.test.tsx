// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MeetingDraftFields } from '../../../../../src/components/assistant/MeetingDraftFields';
import type { CalendarResult, LocalCalendarAPI, LocalCalendarAvailability } from '../../../../../src/types/local-calendar';
import { act, cleanup, fire, render, toggle, typeInto } from '../../../../helpers/render';

const START = Date.parse('2026-10-21T10:00Z');
const result = (label = 'Wednesday 10:00–10:30 UTC'): LocalCalendarAvailability => ({ status: 'ready', startMs: START, endMs: START + 86_400_000, checkedAt: START, timeZone: 'UTC', durationMinutes: 30, calendarIds: ['local'], calendarNames: ['Personal'], scope: 'local-only', slots: [{ startMs: START, endMs: START + 1_800_000, label }] });
const api = {
  snapshot: vi.fn<LocalCalendarAPI['snapshot']>(async () => ({ success: true, data: { calendars: [], occurrences: [], preferences: { timeZone: 'UTC', workingDays: [1, 2, 3, 4, 5], workingStart: '10:00', workingEnd: '18:00', durationMinutes: 45, bufferBeforeMinutes: 10, bufferAfterMinutes: 15, minimumNoticeMinutes: 60, slotIntervalMinutes: 15 } } })),
  availability: vi.fn<LocalCalendarAPI['availability']>(async () => ({ success: true, data: result() })),
};
async function settle() { await act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); }); }
function button(view: ReturnType<typeof render>, label: string) { return view.all('button').find(item => item.textContent?.trim() === label) ?? null; }
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(START); vi.clearAllMocks(); Object.assign(window, { electronAPI: { calendar: api } }); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('meeting draft date-range override', () => {
  it('reads preferences without making availability calls or adding a meeting override to an ordinary draft', async () => {
    const onChange = vi.fn(); const view = render(<MeetingDraftFields onChange={onChange} />); await settle();
    expect(api.snapshot).toHaveBeenCalledOnce();
    expect(api.availability).not.toHaveBeenCalled();
    expect(onChange.mock.calls.every(([value]) => value === undefined)).toBe(true);
    expect(view.byLabel('Meeting range starts')).toBeNull();
    expect(view.container.textContent).toContain('Recipient and external calendars are not connected.');
  });

  it('emits an explicit bounded range and previews only when requested', async () => {
    const onChange = vi.fn(); const view = render(<MeetingDraftFields onChange={onChange} />); await settle();
    toggle(view.find('input[type="checkbox"]'));
    expect((view.byLabel('Meeting range starts') as HTMLInputElement).value).toBe('2026-10-21T10:00');
    expect((view.find('input[type="number"]') as HTMLInputElement).value).toBe('45');
    typeInto(view.byLabel('Meeting range starts'), '2026-10-22T09:00'); typeInto(view.byLabel('Meeting range ends'), '2026-10-22T17:00'); typeInto(view.find('input[type="number"]'), '30');
    expect(onChange).toHaveBeenLastCalledWith({ startMs: Date.parse('2026-10-22T09:00Z'), endMs: Date.parse('2026-10-22T17:00Z'), timeZone: 'UTC', durationMinutes: 30, limit: 3 });
    expect(api.availability).not.toHaveBeenCalled(); fire(button(view, 'Preview available times'), 'click'); await settle();
    expect(api.availability).toHaveBeenCalledExactlyOnceWith(onChange.mock.calls.at(-1)![0]);
    expect(view.container.textContent).toContain('Wednesday 10:00–10:30 UTC');
    expect(view.container.textContent).toContain('Local calendars only · Rechecked when the draft is prepared.');
    toggle(view.find('input[type="checkbox"]')); expect(onChange).toHaveBeenLastCalledWith(undefined);
  });

  it('blocks invalid ranges locally and reports availability failures without inventing free slots', async () => {
    const view = render(<MeetingDraftFields onChange={vi.fn()} />); await settle(); toggle(view.find('input[type="checkbox"]'));
    typeInto(view.byLabel('Meeting range ends'), '2026-10-20T10:00');
    expect((button(view, 'Preview available times') as HTMLButtonElement).disabled).toBe(true);
    expect(view.find('[role="alert"]')?.textContent).toContain('end time after the start');
    expect(api.availability).not.toHaveBeenCalled();
    typeInto(view.byLabel('Meeting range ends'), '2026-10-22T18:00'); api.availability.mockResolvedValueOnce({ success: false, error: 'Calendar database unavailable.' });
    fire(button(view, 'Preview available times'), 'click'); await settle();
    expect(view.find('[role="alert"]')?.textContent).toContain('Calendar database unavailable.');
    expect(view.container.textContent).not.toContain('Wednesday 10:00–10:30 UTC');
  });

  it('does not label calendars ready when none are included in availability checks', async () => {
    api.availability.mockResolvedValueOnce({ success: true, data: { ...result(), status: 'no_calendars', slots: [] } });
    const view = render(<MeetingDraftFields onChange={vi.fn()} />); await settle(); toggle(view.find('input[type="checkbox"]'));
    fire(button(view, 'Preview available times'), 'click'); await settle();
    expect(view.find('[role="alert"]')?.textContent).toContain('Select a calendar that blocks availability');
    expect(view.find('[role="status"]')).toBeNull();
  });

  it.each(['change', 'disable'] as const)('ignores a pending preview after the range is %s', async action => {
    let resolve!: (value: CalendarResult<LocalCalendarAvailability>) => void;
    api.availability.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const view = render(<MeetingDraftFields onChange={vi.fn()} />); await settle(); toggle(view.find('input[type="checkbox"]'));
    fire(button(view, 'Preview available times'), 'click');
    if (action === 'change') typeInto(view.byLabel('Meeting range starts'), '2026-10-22T10:00'); else toggle(view.find('input[type="checkbox"]'));
    await act(async () => resolve({ success: true, data: result('STALE preview slot') }));
    expect(view.container.textContent).not.toContain('STALE preview slot');
  });
});
