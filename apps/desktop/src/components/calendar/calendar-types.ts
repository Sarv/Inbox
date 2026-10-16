// The shapes the Calendar screen renders.
//
// Deliberately the app's own model, not the Sarv Calendar API's wire format:
// the sync layer maps API rows onto these, so the views never change when the
// API does.

export type CalendarViewMode = 'month' | 'week' | 'day';

export const CALENDAR_VIEW_MODES: readonly CalendarViewMode[] = ['month', 'week', 'day'];

/** One calendar the user can see (their own, or one shared with them). */
export interface CalendarSource {
  id: string;
  name: string;
  /** Colour as sent by the server. Untrusted — see `resolveCalendarColor`. */
  color?: string | null;
}

export interface CalendarEvent {
  id: string;
  calendarId: string;
  title: string;
  /**
   * Timed events: UTC ISO-8601 instants (`2026-10-15T09:30:00.000Z`), rendered
   * in the reader's zone. All-day events: local calendar dates
   * (`2026-10-15`), `end` EXCLUSIVE — a one-day event ends the next day. A date
   * has no zone, so it must not be shifted by one.
   */
  start: string;
  end: string;
  allDay: boolean;
  location?: string | null;
  description?: string | null;
  organizer?: string | null;
  attendees?: string[];
}

/** Slots in the stylesheet's fallback palette (`--cal-palette-1` … `-6`). */
export const CALENDAR_PALETTE_SIZE = 6;

/**
 * The colour a calendar is drawn in. A server colour is used only when the
 * browser parses it as a colour: it lands in an inline style, so anything else
 * (a stray `;`, a `url(...)`) is dropped for the palette slot instead.
 */
export function resolveCalendarColor(
  color: string | null | undefined,
  index: number,
  isColor: (value: string) => boolean = (value) => CSS.supports('color', value),
): string {
  const trimmed = color?.trim();
  if (trimmed && isColor(trimmed)) return trimmed;
  const slot = (((index % CALENDAR_PALETTE_SIZE) + CALENDAR_PALETTE_SIZE) % CALENDAR_PALETTE_SIZE) + 1;
  return `var(--cal-palette-${slot})`;
}
