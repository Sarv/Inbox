import type { LocalCalendarRange } from '../../types/local-calendar';
import { addLocalDays, startOfLocalDate } from '../../utils/local-calendar';

export type CalendarView = 'agenda' | 'day' | 'week' | 'month';

export function monthDates(date: string): string[] {
  const first = `${date.slice(0, 7)}-01`;
  const offset = (new Date(`${first}T12:00:00Z`).getUTCDay() + 6) % 7;
  const end = new Date(`${first}T12:00:00Z`);
  end.setUTCMonth(end.getUTCMonth() + 1, 0);
  const daysInMonth = end.getUTCDate();
  const start = addLocalDays(first, -offset);
  return Array.from({ length: Math.ceil((offset + daysInMonth) / 7) * 7 }, (_, index) => addLocalDays(start, index));
}

export function viewDates(view: CalendarView, date: string): string[] {
  if (view === 'month') return monthDates(date);
  const first = date;
  const weekday = new Date(`${first}T12:00:00Z`).getUTCDay();
  const start = view === 'week' ? addLocalDays(first, -((weekday + 6) % 7)) : first;
  const days = view === 'week' ? 7 : view === 'agenda' ? 30 : 1;
  return Array.from({ length: days }, (_, index) => addLocalDays(start, index));
}

export function viewRange(view: CalendarView, date: string, timeZone: string): LocalCalendarRange {
  const dates = viewDates(view, date);
  const startMs = startOfLocalDate(dates[0]!, timeZone);
  const endMs = startOfLocalDate(addLocalDays(dates[dates.length - 1]!, 1), timeZone);
  // A date skipped by an international date-line change has no events. The
  // minimal query still loads calendar metadata without creating a zero range.
  return { startMs, endMs: Math.max(startMs + 1, endMs) };
}

export function moveDate(view: CalendarView, date: string, direction: number): string {
  if (view !== 'month') return addLocalDays(date, direction * (view === 'day' ? 1 : view === 'week' ? 7 : 30));
  const value = new Date(`${date.slice(0, 7)}-01T12:00:00Z`);
  value.setUTCMonth(value.getUTCMonth() + direction);
  return value.toISOString().slice(0, 10);
}

export function dateLabel(date: string, options: Intl.DateTimeFormatOptions = { weekday: 'short', month: 'short', day: 'numeric' }): string {
  return new Intl.DateTimeFormat(undefined, { ...options, timeZone: 'UTC' }).format(new Date(`${date}T12:00:00Z`));
}

export const compactInputClass = 'min-w-0 rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/30 disabled:opacity-50 [color-scheme:light] dark:[color-scheme:dark]';
export const inputClass = `w-full ${compactInputClass}`;
export const buttonClass = 'rounded-lg border border-border px-3 py-2 text-sm hover:bg-accent disabled:opacity-50';
