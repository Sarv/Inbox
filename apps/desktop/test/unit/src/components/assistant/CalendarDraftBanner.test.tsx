// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CalendarDraftBanner } from '../../../../../src/components/assistant/CalendarDraftBanner';
import type { CalendarResult, LocalCalendarAPI, LocalCalendarAvailability } from '../../../../../src/types/local-calendar';
import { act, cleanup, fire, render, settle } from '../../../../helpers/render';

const START = Date.parse('2026-10-21T10:00Z');
function proposal(label = 'Wednesday 10:00–10:30 UTC', startMs = START): LocalCalendarAvailability { return { status: 'ready', startMs, endMs: startMs + 86_400_000, checkedAt: START, timeZone: 'UTC', durationMinutes: 30, calendarIds: ['local'], calendarNames: ['Personal'], scope: 'local-only', slots: [{ startMs, endMs: startMs + 1_800_000, label }] }; }
const api = { availability: vi.fn<LocalCalendarAPI['availability']>(async request => ({ success: true, data: { ...proposal(), slots: [{ ...request, label: 'Checked slot' }] } })) };
beforeEach(() => { vi.clearAllMocks(); Object.assign(window, { electronAPI: { calendar: api } }); });
afterEach(cleanup);

describe('calendar meeting draft banner', () => {
  it('clearly limits its claim to local calendars and does not reserve or assume recipient availability', () => {
    const value = proposal(); const view = render(<CalendarDraftBanner proposal={value} body={`Can we meet ${value.slots[0]!.label}?`} />);
    expect(view.byLabel('Meeting availability')).not.toBeNull();
    expect(view.container.textContent).toContain('Only selected local calendars are included.');
    expect(view.container.textContent).toContain('These times are not reserved; recipient availability is unknown.');
    expect(api.availability).not.toHaveBeenCalled();
    view.rerender(<CalendarDraftBanner proposal={value} body="I will suggest another time manually." />);
    expect(view.byLabel('Meeting availability')).toBeNull();
  });

  it('rechecks explicitly and reports conflicts rather than claiming the slot is still free', async () => {
    const value = proposal(); const view = render(<CalendarDraftBanner proposal={value} body={value.slots[0]!.label} />);
    fire(view.all('button')[0]!, 'click'); await settle();
    expect(view.find('[role="status"]')?.textContent).toContain('still free on your selected local calendars');
    api.availability.mockResolvedValueOnce({ success: true, data: { ...value, slots: [] } });
    fire(view.all('button')[0]!, 'click'); await settle();
    expect(view.find('[role="alert"]')?.textContent).toContain('no longer available');
  });

  it('surfaces unavailable calendar checks and allows retry', async () => {
    const value = proposal(); api.availability.mockResolvedValueOnce({ success: false, error: 'Calendar offline.' });
    const view = render(<CalendarDraftBanner proposal={value} body={value.slots[0]!.label} />);
    fire(view.all('button')[0]!, 'click'); await settle();
    expect(view.find('[role="alert"]')?.textContent).toContain('Calendar check failed: Calendar offline.');
    expect((view.all('button')[0] as HTMLButtonElement).disabled).toBe(false);
  });

  it('does not apply a pending successful recheck to a different draft proposal', async () => {
    let resolve!: (value: CalendarResult<LocalCalendarAvailability>) => void;
    api.availability.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const first = proposal(); const next = proposal('Thursday 10:00–10:30 UTC', START + 86_400_000);
    const view = render(<CalendarDraftBanner proposal={first} body={first.slots[0]!.label} />); fire(view.all('button')[0]!, 'click');
    view.rerender(<CalendarDraftBanner proposal={next} body={next.slots[0]!.label} />);
    await act(async () => resolve({ success: true, data: first }));
    expect(view.container.textContent).not.toContain('These suggested times are still free');
  });

  it('does not apply an earlier recheck after the email retains a different generated time', async () => {
    let resolve!: (value: CalendarResult<LocalCalendarAvailability>) => void;
    api.availability.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const first = proposal(); const later = proposal('Thursday 10:00–10:30 UTC', START + 86_400_000);
    const both = { ...first, slots: [...first.slots, ...later.slots] };
    const view = render(<CalendarDraftBanner proposal={both} body={first.slots[0]!.label} />); fire(view.all('button')[0]!, 'click');
    view.rerender(<CalendarDraftBanner proposal={both} body={later.slots[0]!.label} />);
    await act(async () => resolve({ success: true, data: first }));
    expect(view.container.textContent).not.toContain('These suggested times are still free');
  });
});
