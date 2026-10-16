import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useMemo, useState } from 'react';

import { useNow } from '../../hooks/useNow';
import { Tooltip } from '../Tooltip';

import { rangeTitle, shiftAnchor, viewDays } from './calendar-dates';
import { CALENDAR_VIEW_MODES, resolveCalendarColor, type CalendarEvent, type CalendarSource, type CalendarViewMode } from './calendar-types';
import { calendarColorStyle } from './EventChip';
import { EventDetailPanel } from './EventDetailPanel';
import { MiniMonth } from './MiniMonth';
import { MonthGrid } from './MonthGrid';
import { TimeGrid } from './TimeGrid';

const VIEW_LABELS: Record<CalendarViewMode, string> = { month: 'Month', week: 'Week', day: 'Day' };

const STEP_LABELS: Record<CalendarViewMode, { previous: string; next: string }> = {
  month: { previous: 'Previous month', next: 'Next month' },
  week: { previous: 'Previous week', next: 'Next week' },
  day: { previous: 'Previous day', next: 'Next day' },
};

interface CalendarViewProps {
  calendars: readonly CalendarSource[];
  events: readonly CalendarEvent[];
  /** Starting view; the reader switches from there. */
  initialView?: CalendarViewMode;
  /** Starting day; defaults to today. */
  initialDate?: Date;
}

/**
 * The Calendar screen: a rail (month picker + calendar list), a toolbar, the
 * month / week / day view, and the selected event's details. Presentation only
 * — the calendars and events come in as props.
 */
export function CalendarView({ calendars, events, initialView = 'week', initialDate }: CalendarViewProps) {
  const now = useNow();
  const [view, setView] = useState<CalendarViewMode>(initialView);
  const [anchor, setAnchor] = useState(() => initialDate ?? new Date());
  const [hiddenCalendarIds, setHiddenCalendarIds] = useState<readonly string[]>([]);
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);

  const colorByCalendar = useMemo(
    () => new Map(calendars.map((calendar, index) => [calendar.id, resolveCalendarColor(calendar.color, index)])),
    [calendars],
  );
  const colorOf = (event: CalendarEvent) => colorByCalendar.get(event.calendarId) ?? resolveCalendarColor(null, 0);
  const visibleEvents = useMemo(
    () => events.filter((event) => !hiddenCalendarIds.includes(event.calendarId)),
    [events, hiddenCalendarIds],
  );
  const selectedEvent = visibleEvents.find((event) => event.id === selectedEventId);

  const toggleCalendar = (calendarId: string) =>
    setHiddenCalendarIds((hidden) =>
      hidden.includes(calendarId) ? hidden.filter((id) => id !== calendarId) : [...hidden, calendarId],
    );
  const openDay = (day: Date) => {
    setAnchor(day);
    setView('day');
  };
  const eventProps = {
    colorOf,
    selectedEventId,
    onSelectEvent: (event: CalendarEvent) => setSelectedEventId(event.id),
  };

  return (
    <div className="sarv-calendar">
      <div className="calv-rail">
        <MiniMonth anchor={anchor} view={view} today={now} onPick={setAnchor} />
        <section>
          <h3 className="calv-section-h">My calendars</h3>
          {calendars.length === 0 ? (
            <p className="calv-note">No calendars yet. Your Sarv calendars will appear here once calendar sync is connected.</p>
          ) : (
            <div className="calv-cal-list">
              {calendars.map((calendar) => (
                <label key={calendar.id} className="calv-cal-row" style={calendarColorStyle(colorByCalendar.get(calendar.id)!)}>
                  <input
                    type="checkbox"
                    className="check"
                    checked={!hiddenCalendarIds.includes(calendar.id)}
                    onChange={() => toggleCalendar(calendar.id)}
                  />
                  <span>{calendar.name}</span>
                </label>
              ))}
            </div>
          )}
        </section>
      </div>

      <div className="calv-main">
        <div className="calv-toolbar">
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => setAnchor(new Date())}>
            Today
          </button>
          <Tooltip content={STEP_LABELS[view].previous} delayMs={40}>
            <button
              type="button"
              className="btn btn-ghost btn-sm btn-icon"
              aria-label={STEP_LABELS[view].previous}
              onClick={() => setAnchor(shiftAnchor(view, anchor, -1))}
            >
              <ChevronLeft size={16} />
            </button>
          </Tooltip>
          <Tooltip content={STEP_LABELS[view].next} delayMs={40}>
            <button
              type="button"
              className="btn btn-ghost btn-sm btn-icon"
              aria-label={STEP_LABELS[view].next}
              onClick={() => setAnchor(shiftAnchor(view, anchor, 1))}
            >
              <ChevronRight size={16} />
            </button>
          </Tooltip>
          <h2 className="calv-title" aria-live="polite">{rangeTitle(view, anchor)}</h2>
          <div className="seg" role="group" aria-label="Calendar view">
            {CALENDAR_VIEW_MODES.map((mode) => (
              <button
                key={mode}
                type="button"
                className={`seg-btn${view === mode ? ' is-on' : ''}`}
                aria-pressed={view === mode}
                onClick={() => setView(mode)}
              >
                {VIEW_LABELS[mode]}
              </button>
            ))}
          </div>
        </div>

        {view === 'month' ? (
          <MonthGrid anchor={anchor} today={now} events={visibleEvents} onOpenDay={openDay} {...eventProps} />
        ) : (
          <TimeGrid days={viewDays(view, anchor)} now={now} events={visibleEvents} onOpenDay={openDay} {...eventProps} />
        )}
      </div>

      {selectedEvent && (
        <EventDetailPanel
          event={selectedEvent}
          calendar={calendars.find((calendar) => calendar.id === selectedEvent.calendarId)}
          color={colorOf(selectedEvent)}
          onClose={() => setSelectedEventId(null)}
        />
      )}
    </div>
  );
}
