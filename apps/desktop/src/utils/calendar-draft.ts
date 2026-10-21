import type { LocalCalendarAPI, LocalCalendarAvailability, LocalCalendarSlot } from '../types/local-calendar';

const normalize = (text: string) => text.replace(/\s+/g, ' ').trim();

export function usedCalendarSlots(proposal: LocalCalendarAvailability | undefined, body: string): LocalCalendarSlot[] {
  if (!proposal || !Array.isArray(proposal.slots)) return [];
  const text = normalize(body);
  return proposal.slots.filter(slot => typeof slot.label === 'string' && text.includes(normalize(slot.label)));
}

/** Revalidate only app-generated options still present; manual edits belong to the user. */
export async function recheckDraftCalendarAvailability(
  proposal: LocalCalendarAvailability | undefined,
  body: string,
  api: Pick<LocalCalendarAPI, 'availability'> | undefined = window.electronAPI?.calendar,
): Promise<void> {
  const slots = usedCalendarSlots(proposal, body);
  if (!proposal || !slots.length) return;
  if (!api || proposal.status !== 'ready' || slots.length > 12) throw new Error('Calendar availability could not be verified. Open Calendar and check these times before sending.');
  for (const slot of slots) {
    const result = await api.availability({ startMs: slot.startMs, endMs: slot.endMs, durationMinutes: proposal.durationMinutes, timeZone: proposal.timeZone, limit: 1 });
    if (!result.success) throw new Error(`Calendar check failed: ${result.error}`);
    if (result.data.status !== 'ready' || !result.data.slots.some(value => value.startMs === slot.startMs && value.endMs === slot.endMs)) {
      throw new Error('A proposed meeting time is no longer available. Update the suggested times before sending.');
    }
  }
}
