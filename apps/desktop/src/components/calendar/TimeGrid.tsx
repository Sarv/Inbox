import { differenceInMinutes, isSameDay, setHours, startOfDay } from 'date-fns';
import { useEffect, useRef, type CSSProperties } from 'react';

import {
  eventInterval,
  eventsOnDay,
  formatEventTime,
  isAllDayLike,
  layoutTimedEvents,
  shortWeekday,
  type PositionedEvent,
} from './calendar-dates';
import type { CalendarEvent } from './calendar-types';
import { calendarColorStyle, EventChip, type EventViewProps } from './EventChip';

/** The hour the grid opens scrolled to — the working day, not midnight. */
export const FIRST_VISIBLE_HOUR = 7;

const HOURS = Array.from({ length: 24 }, (_unused, hour) => hour);

/** `minutes` of the day as a length on the grid. */
const minutesToLength = (minutes: number) => `calc(var(--cal-hour-h) * ${minutes / 60})`;

/** Where a block sits: its time span vertically, its overlap column across. */
export function eventBlockStyle({ top, height, column, columns }: PositionedEvent): CSSProperties {
  return {
    top: minutesToLength(top),
    height: minutesToLength(height),
    left: `${(column / columns) * 100}%`,
    width: `calc(${100 / columns}% - 2px)`,
  };
}

interface TimeGridProps extends EventViewProps {
  /** One day (day view) or seven (week view). */
  days: Date[];
  now: Date;
  events: readonly CalendarEvent[];
  onOpenDay: (day: Date) => void;
}

/** The week and day views: a header per day, an all-day row, then the hour grid. */
export function TimeGrid({ days, now, events, onOpenDay, ...eventProps }: TimeGridProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const hourHeight = parseFloat(getComputedStyle(scroller).getPropertyValue('--cal-hour-h')) || 48;
    scroller.scrollTop = hourHeight * FIRST_VISIBLE_HOUR;
  }, []);

  const columnsStyle = { '--cal-days': days.length } as CSSProperties;
  const hasAllDay = days.some((day) => eventsOnDay(events, day).some(isAllDayLike));

  return (
    <div className="calv-tg">
      <div className="calv-tg-head" style={columnsStyle}>
        <div />
        {days.map((day) => {
          const isToday = isSameDay(day, now);
          return (
            <div key={day.toISOString()} className="calv-tg-dayhead">
              <span className="cal-dow">{shortWeekday(day)}</span>
              <button
                type="button"
                className={`cal-day${isToday ? ' selected today' : ''}`}
                aria-label={day.toLocaleDateString(undefined, { dateStyle: 'full' })}
                aria-current={isToday ? 'date' : undefined}
                onClick={() => onOpenDay(day)}
              >
                {day.getDate()}
              </button>
            </div>
          );
        })}
      </div>

      {hasAllDay && (
        <div className="calv-tg-allday" style={columnsStyle}>
          <div className="calv-tg-allday-label">All day</div>
          {days.map((day) => (
            <div key={day.toISOString()} className="calv-tg-allday-cell">
              {eventsOnDay(events, day).filter(isAllDayLike).map((event) => (
                <EventChip key={event.id} event={event} {...eventProps} />
              ))}
            </div>
          ))}
        </div>
      )}

      <div ref={scrollRef} className="calv-tg-scroll">
        <div className="calv-tg-body" style={columnsStyle}>
          <div className="calv-tg-gutter" aria-hidden="true">
            {HOURS.slice(1).map((hour) => (
              <span key={hour} className="calv-tg-hour" style={{ top: minutesToLength(hour * 60) }}>
                {setHours(startOfDay(now), hour).toLocaleTimeString(undefined, { hour: 'numeric' })}
              </span>
            ))}
          </div>
          {days.map((day) => {
            const isToday = isSameDay(day, now);
            return (
              <div key={day.toISOString()} className={`calv-tg-col${isToday ? ' is-today' : ''}`}>
                {layoutTimedEvents(events, day).map((positioned) => (
                  <TimedEventBlock key={positioned.event.id} positioned={positioned} {...eventProps} />
                ))}
                {isToday && (
                  <div
                    className="calv-now"
                    style={{ top: minutesToLength(differenceInMinutes(now, startOfDay(now))) }}
                    aria-hidden="true"
                  />
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

interface TimedEventBlockProps extends EventViewProps {
  positioned: PositionedEvent;
}

function TimedEventBlock({ positioned, colorOf, selectedEventId, onSelectEvent }: TimedEventBlockProps) {
  const { event } = positioned;
  const { start, end } = eventInterval(event);
  const time = `${formatEventTime(start)} – ${formatEventTime(end)}`;
  return (
    <button
      type="button"
      className={`calv-event${selectedEventId === event.id ? ' is-selected' : ''}`}
      style={{ ...eventBlockStyle(positioned), ...calendarColorStyle(colorOf(event)) }}
      aria-label={`${time} ${event.title}`}
      onClick={() => onSelectEvent(event)}
    >
      {event.title || '(No title)'}
      <span className="calv-event-time">{time}</span>
    </button>
  );
}
