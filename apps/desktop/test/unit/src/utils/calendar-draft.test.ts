import { afterEach, describe, expect, it, vi } from 'vitest';

import type { LocalCalendarAPI, LocalCalendarAvailability } from '../../../../src/types/local-calendar';
import { recheckDraftCalendarAvailability, usedCalendarSlots } from '../../../../src/utils/calendar-draft';

const START = Date.parse('2026-10-21T10:00Z');
const first = { startMs: START, endMs: START + 1_800_000, label: 'Wednesday 10:00–10:30 UTC' };
const second = { startMs: START + 86_400_000, endMs: START + 86_400_000 + 1_800_000, label: 'Thursday 10:00–10:30 UTC' };
const proposal: LocalCalendarAvailability = { status: 'ready', startMs: START, endMs: START + 7 * 86_400_000, checkedAt: START, timeZone: 'UTC', durationMinutes: 30, calendarIds: ['local'], calendarNames: ['Personal'], scope: 'local-only', slots: [first, second] };
function calendar() { return { availability: vi.fn<LocalCalendarAPI['availability']>(async request => ({ success: true, data: { ...proposal, startMs: request.startMs, endMs: request.endMs, slots: [{ startMs: request.startMs, endMs: request.endMs, label: 'Checked' }] } })) }; }
afterEach(() => vi.unstubAllGlobals());

describe('calendar-generated draft time checks', () => {
  it('does no calendar work for ordinary drafts or manually replaced time suggestions', async () => {
    const api = calendar();
    await recheckDraftCalendarAvailability(undefined, 'Here is our quotation.', api);
    await recheckDraftCalendarAvailability(proposal, 'I will call you next Friday at noon.', api);
    expect(api.availability).not.toHaveBeenCalled();
    expect(usedCalendarSlots(proposal, 'A manual Friday meeting')).toEqual([]);
  });

  it('checks only app-generated labels still present, accepting harmless whitespace changes', async () => {
    const api = calendar(); const body = `Please meet ${first.label.replace(' ', '\n  ')}. I removed the other option.`;
    expect(usedCalendarSlots(proposal, body)).toEqual([first]);
    await recheckDraftCalendarAvailability(proposal, body, api);
    expect(api.availability).toHaveBeenCalledExactlyOnceWith({ startMs: first.startMs, endMs: first.endMs, durationMinutes: 30, timeZone: 'UTC', limit: 1 });
  });

  it('checks every retained option and rejects changed start/end boundaries', async () => {
    const api = calendar(); await recheckDraftCalendarAvailability(proposal, `${first.label}\n${second.label}`, api);
    expect(api.availability).toHaveBeenCalledTimes(2);
    api.availability.mockResolvedValueOnce({ success: true, data: { ...proposal, slots: [{ ...first, endMs: first.endMs + 60_000 }] } });
    await expect(recheckDraftCalendarAvailability(proposal, first.label, api)).rejects.toThrow('no longer available');
  });

  it('fails closed when calendar access fails or no calendar is selected', async () => {
    const api = calendar(); api.availability.mockResolvedValueOnce({ success: false, error: 'Database unavailable.' });
    await expect(recheckDraftCalendarAvailability(proposal, first.label, api)).rejects.toThrow('Calendar check failed: Database unavailable.');
    api.availability.mockResolvedValueOnce({ success: true, data: { ...proposal, status: 'no_calendars', slots: [] } });
    await expect(recheckDraftCalendarAvailability(proposal, first.label, api)).rejects.toThrow('no longer available');
    vi.stubGlobal('window', { electronAPI: {} });
    await expect(recheckDraftCalendarAvailability(proposal, first.label)).rejects.toThrow('could not be verified');
  });

  it('does not trust an unready proposal or more than the bounded retained options', async () => {
    const api = calendar();
    await expect(recheckDraftCalendarAvailability({ ...proposal, status: 'no_calendars' }, first.label, api)).rejects.toThrow('could not be verified');
    const slots = Array.from({ length: 13 }, (_, index) => ({ ...first, label: `Generated slot ${index}` }));
    await expect(recheckDraftCalendarAvailability({ ...proposal, slots }, slots.map(slot => slot.label).join('\n'), api)).rejects.toThrow('could not be verified');
    expect(api.availability).not.toHaveBeenCalled();
  });
});
