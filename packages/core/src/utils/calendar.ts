// Calendar-invite (iCalendar / RFC 5545) shared helpers.
//
// This module is intentionally DEPENDENCY-FREE: it holds the type + the safety
// guard used both by the main-process capture path (message-processor, when it
// pulls the raw ICS off a text/calendar part) and by the renderer's parser. The
// actual ICS parsing lives in the renderer (apps/desktop) where the `ical.js`
// dependency is bundled — the main process never needs to parse, only capture.

/**
 * Structured view of a single VEVENT, produced by the renderer's
 * `parseCalendarInvite`. Times are absolute epoch milliseconds so the UI can
 * format them in the viewer's local timezone (matching how Gmail renders the
 * event card). All string fields are already length-capped and safe to render
 * as plain text.
 */
export interface CalendarInvite {
  summary: string | null;
  startMs: number; // absolute instant, epoch ms
  endMs: number | null; // absolute instant, epoch ms (null when no DTEND)
  isAllDay: boolean;
  location: string | null;
  organizer: string | null; // display name, else the bare email address
  attendeeCount: number;
  method: string | null; // REQUEST | REPLY | CANCEL | ...
  status: string | null; // CONFIRMED | CANCELLED | TENTATIVE | ...
}

/**
 * Upper bound on the raw ICS we will store/parse, measured in string length
 * (UTF-16 code units — an isomorphic proxy for size that works in both the Node
 * main process and the browser renderer, no `Buffer`/`TextEncoder` needed).
 * Real invites are a few KB; the cap keeps a pathologically large or hostile
 * part from bloating the DB or feeding the parser (resource-exhaustion guard).
 */
export const MAX_ICS_CHARS = 256 * 1024; // ~256 K chars

/**
 * Sanity-check raw ICS text before it is stored or parsed. Returns the text
 * (trimmed) when it looks like a real, bounded iCalendar object; otherwise null.
 * Pure — performs no I/O and executes nothing (ICS is plain text; there is no
 * embedded code to run). This is the single guard both the capture path and the
 * parser funnel through.
 */
export function sanitizeIcsText(text: string | null | undefined): string | null {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (trimmed.length > MAX_ICS_CHARS) return null;
  if (!/BEGIN:VCALENDAR/i.test(trimmed)) return null;
  return trimmed;
}
