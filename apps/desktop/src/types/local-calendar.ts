/** Local calendar contracts shared by the renderer and main process. Times are epoch milliseconds. */
export interface LocalCalendar {
  id: string;
  name: string;
  color: string;
  provider: 'local';
  visible: boolean;
  blocksAvailability: boolean;
  isDefault: boolean;
}

export interface LocalCalendarRecurrence {
  frequency: 'daily' | 'weekly' | 'monthly';
  interval: number;
  /** Sunday = 0. Used for weekly recurrence. */
  weekDays?: number[];
  count?: number;
  /** Inclusive last local date, YYYY-MM-DD. */
  until?: string;
}

export interface LocalCalendarEvent {
  id: string;
  calendarId: string;
  title: string;
  description: string;
  location: string;
  startMs: number;
  endMs: number;
  timeZone: string;
  allDay: boolean;
  /** Exclusive end date for all-day events. */
  startDate?: string;
  endDate?: string;
  busy: boolean;
  status: 'confirmed' | 'tentative' | 'cancelled';
  reminderMinutes: number | null;
  recurrence?: LocalCalendarRecurrence;
  excludedStarts?: number[];
  parentEventId?: string;
  originalStartMs?: number;
  updatedAt: number;
}

export interface LocalCalendarOccurrence {
  occurrenceId: string;
  eventId: string;
  startMs: number;
  endMs: number;
  event: LocalCalendarEvent;
}

export interface LocalCalendarPreferences {
  timeZone: string;
  workingDays: number[];
  workingStart: string;
  workingEnd: string;
  durationMinutes: number;
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
  minimumNoticeMinutes: number;
  slotIntervalMinutes: number;
}

export interface LocalCalendarRange { startMs: number; endMs: number }
export interface LocalCalendarSnapshot {
  calendars: LocalCalendar[];
  preferences: LocalCalendarPreferences;
  occurrences: LocalCalendarOccurrence[];
}
export type LocalCalendarEventInput = Omit<LocalCalendarEvent, 'id' | 'updatedAt' | 'excludedStarts' | 'parentEventId' | 'originalStartMs'> & {
  id?: string;
  scope?: 'series' | 'occurrence';
  occurrenceStartMs?: number;
};
export interface LocalCalendarAvailabilityRequest extends LocalCalendarRange {
  durationMinutes?: number;
  timeZone?: string;
  limit?: number;
}
export interface LocalCalendarSlot extends LocalCalendarRange { label: string }
/** No private event titles or descriptions are exposed to the drafting model. */
export interface LocalCalendarAvailability extends LocalCalendarRange {
  status: 'ready' | 'no_calendars';
  checkedAt: number;
  timeZone: string;
  durationMinutes: number;
  calendarIds: string[];
  calendarNames: string[];
  scope: 'local-only';
  slots: LocalCalendarSlot[];
}
export type CalendarResult<T> = { success: true; data: T } | { success: false; error: string };
export interface LocalCalendarOpenEvent { eventId: string; startMs: number; occurrenceId?: string }
export interface LocalCalendarAPI {
  invitation(request: import('./calendar-invitations').LocalCalendarInvitationEmailRequest): Promise<CalendarResult<import('./calendar-invitations').LocalCalendarInvitation | null>>;
  respondToInvitation(request: import('./calendar-invitations').LocalCalendarInvitationResponseRequest): Promise<CalendarResult<import('./calendar-invitations').LocalCalendarInvitationResponseResult>>;
  snapshot(range: LocalCalendarRange): Promise<CalendarResult<LocalCalendarSnapshot>>;
  saveCalendar(calendar: Omit<LocalCalendar, 'id' | 'provider'> & { id?: string }): Promise<CalendarResult<LocalCalendar>>;
  deleteCalendar(id: string): Promise<CalendarResult<null>>;
  saveEvent(event: LocalCalendarEventInput): Promise<CalendarResult<LocalCalendarEvent>>;
  deleteEvent(request: { id: string; scope?: 'series' | 'occurrence'; occurrenceStartMs?: number }): Promise<CalendarResult<null>>;
  savePreferences(preferences: LocalCalendarPreferences): Promise<CalendarResult<LocalCalendarPreferences>>;
  availability(request: LocalCalendarAvailabilityRequest): Promise<CalendarResult<LocalCalendarAvailability>>;
  importIcs(request: { calendarId: string; text: string }): Promise<CalendarResult<{ imported: number }>>;
  importFileIcs(request: { calendarId: string; text: string }): Promise<CalendarResult<{ imported: number }>>;
  exportIcs(request: { calendarId: string }): Promise<CalendarResult<{ text: string }>>;
  onChanged(listener: () => void): () => void;
  onOpenEvent(listener: (event: LocalCalendarOpenEvent) => void): () => void;
}
