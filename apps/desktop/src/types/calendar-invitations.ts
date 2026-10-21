import type { LocalCalendarEvent } from './local-calendar';

export type LocalCalendarInvitationResponse = 'accepted' | 'tentative' | 'declined';
export type LocalCalendarInvitationParticipation = 'needs-action' | LocalCalendarInvitationResponse;

/** Local invitation state. A response never implies delivery unless the send result says so. */
export interface LocalCalendarInvitation {
  id: string;
  accountId: string;
  accountEmail: string;
  uid: string;
  organizer: string;
  organizerName?: string;
  eventId?: string;
  calendarId?: string;
  title: string;
  startMs?: number;
  endMs?: number;
  timeZone?: string;
  allDay?: boolean;
  recurrence: boolean;
  response: LocalCalendarInvitationParticipation;
  cancelled: boolean;
  sequence: number;
  dtstampMs: number;
  /** Changes whenever the organizer update or local response changes. */
  versionToken: string;
  /** Present for an invitation email that cancels a single recurring occurrence. */
  occurrenceStartMs?: number;
}

export interface LocalCalendarInvitationEmailRequest { accountId: string; emailId: string }
export interface LocalCalendarInvitationResponseRequest extends LocalCalendarInvitationEmailRequest { response: LocalCalendarInvitationResponse }
export interface LocalCalendarInvitationResponseResult { invitation: LocalCalendarInvitation; delivery: 'sent' | 'queued' }
export interface LocalCalendarInvitationIngestInput extends LocalCalendarInvitationEmailRequest { accountEmail: string; fromAddress: string; ics: string }
export interface LocalCalendarInvitationIngestResult {
  status: 'added' | 'updated' | 'cancelled' | 'unchanged' | 'stale';
  invitation: LocalCalendarInvitation;
  event?: LocalCalendarEvent;
}

/** Main-process only: prepared on an explicit RSVP click, then handed to the outbox. */
export interface LocalCalendarPreparedInvitationResponse {
  invitation: LocalCalendarInvitation;
  invitationId: string;
  accountId: string;
  accountEmail: string;
  organizer: string;
  subject: string;
  replyIcs: string;
  response: LocalCalendarInvitationResponse;
  versionToken: string;
}
