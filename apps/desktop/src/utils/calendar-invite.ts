// Renderer-side iCalendar (.ics) parsing + display formatting for the calendar
// invite banner. Parsing lives here (not in @sarvinbox/core) because it depends
// on `ical.js`, a browser-bundled dependency the Node main process never needs —
// the main process only CAPTURES the raw ICS text. The shared safety guard and
// the CalendarInvite type come from core so both sides agree on one definition.

import type { CalendarInvite } from '@sarvinbox/core';
import {
  differenceInCalendarDays,
  format,
  isSameDay,
  isSameYear,
  isToday,
  isTomorrow,
} from 'date-fns';
import ICAL from 'ical.js';

export type { CalendarInvite };

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// NOTE: this mirrors `sanitizeIcsText` / `MAX_ICS_CHARS` in
// packages/core/src/utils/calendar.ts. It is deliberately inlined rather than
// imported: the renderer may only import TYPES from `@sarvinbox/core` (every
// other renderer file does the same) — importing a runtime VALUE pulls in the
// core barrel, which transitively loads Node-only modules (mailparser →
// `stream`) that cannot run in the browser and blank the renderer. Keep the two
// copies in sync; the logic is a trivial, pure guard.
const MAX_ICS_CHARS = 256 * 1024;

function guardIcs(text: string | null | undefined): string | null {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > MAX_ICS_CHARS) return null;
  if (!/BEGIN:VCALENDAR/i.test(trimmed)) return null;
  return trimmed;
}

/** Trim + length-cap a free-text field so it is safe/compact to render. */
const cap = (value: unknown, max: number): string | null => {
  if (value == null) return null;
  const text = String(value).trim();
  if (!text) return null;
  return text.length > max ? `${text.slice(0, max)}…` : text;
};

/**
 * Parse raw iCalendar text into a structured, render-safe {@link CalendarInvite}.
 * Returns null when the text is absent, fails the shared safety guard, has no
 * VEVENT, or cannot be parsed. NEVER throws — a malformed invite simply yields
 * no banner rather than breaking the detail view. The parser executes nothing;
 * ICS is inert plain text and every field is length-capped for rendering.
 */
export function parseCalendarInvite(icsText: string | null | undefined): CalendarInvite | null {
  const ics = guardIcs(icsText);
  if (!ics) return null;

  try {
    const jcal = ICAL.parse(ics);
    const comp = new ICAL.Component(jcal);
    const vevent = comp.getFirstSubcomponent('vevent');
    if (!vevent) return null;

    const event = new ICAL.Event(vevent);

    const startDate = event.startDate;
    if (!startDate) return null;
    const startMs = startDate.toJSDate().getTime();
    if (!Number.isFinite(startMs)) return null;

    const endDate = event.endDate;
    const endMsRaw = endDate ? endDate.toJSDate().getTime() : null;
    const endMs = endMsRaw != null && Number.isFinite(endMsRaw) ? endMsRaw : null;

    // Organizer: prefer the CN display name, else the bare mailto address.
    let organizer: string | null = null;
    const orgProp = vevent.getFirstProperty('organizer');
    if (orgProp) {
      const cn = orgProp.getParameter('cn');
      if (typeof cn === 'string' && cn.trim()) {
        organizer = cap(cn, 200);
      } else {
        const val = orgProp.getFirstValue();
        organizer = cap(String(val ?? '').replace(/^mailto:/i, ''), 200);
      }
    }

    const method = comp.getFirstPropertyValue('method');
    const status = vevent.getFirstPropertyValue('status');

    return {
      summary: cap(event.summary, 300),
      startMs,
      endMs,
      isAllDay: Boolean(startDate.isDate),
      location: cap(event.location, 300),
      organizer,
      attendeeCount: vevent.getAllProperties('attendee').length,
      method: cap(method, 40),
      status: cap(status, 40),
    };
  } catch {
    // Malformed ICS → no card. Deliberately swallowed; never surface to the UI.
    return null;
  }
}

/** True when the invite (or its parsed status) marks the event cancelled. */
export function isInviteCancelled(invite: CalendarInvite): boolean {
  return (
    invite.method?.toUpperCase() === 'CANCEL' || invite.status?.toUpperCase() === 'CANCELLED'
  );
}

/**
 * Human day label relative to now, matching the compact style Gmail uses:
 * "Today" / "Tomorrow" / a weekday within the coming week / else a dated label.
 */
function dayLabel(date: Date, now: Date): string {
  if (isToday(date)) return 'Today';
  if (isTomorrow(date)) return 'Tomorrow';
  const days = differenceInCalendarDays(date, now);
  if (days > 1 && days < 7) return format(date, 'EEEE');
  return isSameYear(date, now) ? format(date, 'EEE, MMM d') : format(date, 'EEE, MMM d, yyyy');
}

/**
 * Format an event's time range in the VIEWER's local timezone (the absolute
 * instants already encode the origin timezone), e.g. "Tomorrow · 3:00 – 4:00 PM".
 * All-day events show only the day(s); the ICS all-day DTEND is exclusive, so the
 * inclusive last day is DTEND minus one day.
 */
export function formatEventRange(
  startMs: number,
  endMs: number | null,
  isAllDay: boolean,
  now: Date = new Date(),
): string {
  const start = new Date(startMs);
  const end = endMs != null ? new Date(endMs) : null;

  if (isAllDay) {
    if (!end || differenceInCalendarDays(end, start) <= 1) return dayLabel(start, now);
    const lastDay = new Date(end.getTime() - MS_PER_DAY); // DTEND is exclusive
    return `${dayLabel(start, now)} – ${dayLabel(lastDay, now)}`;
  }

  const startFull = format(start, 'h:mm a');
  if (!end) return `${dayLabel(start, now)} · ${startFull}`;

  if (isSameDay(start, end)) {
    // Collapse the meridiem on the start time when both fall in the same period
    // ("3:00 – 4:00 PM" rather than "3:00 PM – 4:00 PM").
    const sameMeridiem = format(start, 'a') === format(end, 'a');
    const startStr = sameMeridiem ? format(start, 'h:mm') : startFull;
    return `${dayLabel(start, now)} · ${startStr} – ${format(end, 'h:mm a')}`;
  }

  // Spans multiple days.
  return `${dayLabel(start, now)} ${startFull} – ${dayLabel(end, now)} ${format(end, 'h:mm a')}`;
}
