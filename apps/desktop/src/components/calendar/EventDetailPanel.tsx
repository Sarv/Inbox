import { AlignLeft, CalendarDays, Clock, MapPin, User, Users, X } from 'lucide-react';

import { Tooltip } from '../Tooltip';

import { formatEventWhen } from './calendar-dates';
import type { CalendarEvent, CalendarSource } from './calendar-types';
import { calendarColorStyle } from './EventChip';

interface EventDetailPanelProps {
  event: CalendarEvent;
  calendar: CalendarSource | undefined;
  color: string;
  onClose: () => void;
}

/**
 * The selected event, read-only. Every field is server text and is rendered as
 * TEXT — a description is never parsed as HTML here.
 */
export function EventDetailPanel({ event, calendar, color, onClose }: EventDetailPanelProps) {
  const attendees = event.attendees ?? [];
  return (
    <aside className="calv-detail" aria-label="Event details">
      <div className="calv-detail-head">
        <span className="calv-swatch" style={calendarColorStyle(color)} aria-hidden="true" />
        <h3>{event.title || '(No title)'}</h3>
        <Tooltip content="Close" delayMs={40}>
          <button type="button" className="btn btn-ghost btn-sm btn-icon" aria-label="Close event details" onClick={onClose}>
            <X size={16} />
          </button>
        </Tooltip>
      </div>
      <div className="calv-detail-body">
        <div className="calv-field">
          <Clock size={16} aria-hidden="true" />
          <span>{formatEventWhen(event)}</span>
        </div>
        {calendar && (
          <div className="calv-field">
            <CalendarDays size={16} aria-hidden="true" />
            <span>{calendar.name}</span>
          </div>
        )}
        {event.location && (
          <div className="calv-field">
            <MapPin size={16} aria-hidden="true" />
            <span>{event.location}</span>
          </div>
        )}
        {event.organizer && (
          <div className="calv-field">
            <User size={16} aria-hidden="true" />
            <span>Organizer: {event.organizer}</span>
          </div>
        )}
        {attendees.length > 0 && (
          <div className="calv-field">
            <Users size={16} aria-hidden="true" />
            <div>
              <div>{attendees.length} {attendees.length === 1 ? 'guest' : 'guests'}</div>
              <ul>{attendees.map((attendee) => <li key={attendee}>{attendee}</li>)}</ul>
            </div>
          </div>
        )}
        {event.description && (
          <div className="calv-field">
            <AlignLeft size={16} aria-hidden="true" />
            <span className="calv-desc">{event.description}</span>
          </div>
        )}
      </div>
    </aside>
  );
}
