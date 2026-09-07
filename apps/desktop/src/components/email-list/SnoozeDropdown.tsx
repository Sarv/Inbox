import { format, addDays, nextSaturday, startOfDay, setHours, setMinutes } from 'date-fns';
import { Clock } from 'lucide-react';
import { useState } from 'react';

import type { SnoozeDropdownProps } from './types';

function getSnoozeOptions() {
  const now = new Date();
  const tomorrow = startOfDay(addDays(now, 1));
  const tomorrowMorning = setMinutes(setHours(tomorrow, 8), 0);

  const weekend = nextSaturday(now);
  const weekendMorning = setMinutes(setHours(startOfDay(weekend), 9), 0);

  const nextWeek = startOfDay(addDays(now, 7));
  const nextWeekMorning = setMinutes(setHours(nextWeek, 8), 0);

  return [
    { label: 'Tomorrow', time: tomorrowMorning, sublabel: format(tomorrowMorning, 'EEE, h:mm a') },
    { label: 'This weekend', time: weekendMorning, sublabel: format(weekendMorning, 'EEE, h:mm a') },
    { label: 'Next week', time: nextWeekMorning, sublabel: format(nextWeekMorning, 'EEE, MMM d') },
  ];
}

export function SnoozeDropdown({ emailId, isSnoozed, onSnooze, onBulkSnooze, onUnsnooze, onClose, align = 'right' }: SnoozeDropdownProps) {
  const [showCustomDatePicker, setShowCustomDatePicker] = useState(false);
  const [customSnoozeDate, setCustomSnoozeDate] = useState('');
  const [customSnoozeTime, setCustomSnoozeTime] = useState('09:00');

  const snoozeOptions = getSnoozeOptions();

  const handleSnooze = (snoozeUntil: number, e: React.MouseEvent) => {
    e.stopPropagation();
    if (onBulkSnooze) {
      onBulkSnooze(snoozeUntil);
    } else if (onSnooze && emailId) {
      onSnooze(emailId, snoozeUntil, e);
    }
    onClose();
  };

  const handleCustomSnooze = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!customSnoozeDate) return;

    const [year, month, day] = customSnoozeDate.split('-').map(Number);
    const [hours, minutes] = customSnoozeTime.split(':').map(Number);
    const snoozeDate = new Date(year, month - 1, day, hours, minutes);
    const snoozeUntil = Math.floor(snoozeDate.getTime() / 1000);

    handleSnooze(snoozeUntil, e);
  };

  const alignClass = align === 'left' ? 'left-0' : 'right-0';

  return (
    <div className={`absolute ${alignClass} top-full mt-1 z-[100] bg-popover border border-border rounded-lg shadow-lg py-1 w-56`}>
      <div className="px-3 py-1.5 text-xs font-semibold text-muted-foreground uppercase">
        Snooze until
      </div>
      {snoozeOptions.map((option) => (
        <button
          key={option.label}
          onClick={(e) => handleSnooze(Math.floor(option.time.getTime() / 1000), e)}
          className="w-full px-3 py-2 text-left hover:bg-accent flex items-center justify-between"
        >
          <span className="text-sm">{option.label}</span>
          <span className="text-xs text-muted-foreground">{option.sublabel}</span>
        </button>
      ))}

      {/* Custom date/time picker */}
      <div className="border-t border-border my-1" />
      {!showCustomDatePicker ? (
        <button
          onClick={(e) => {
            e.stopPropagation();
            setShowCustomDatePicker(true);
            const tomorrow = new Date();
            tomorrow.setDate(tomorrow.getDate() + 1);
            setCustomSnoozeDate(tomorrow.toISOString().split('T')[0]);
          }}
          className="w-full px-3 py-2 text-left hover:bg-accent flex items-center gap-2"
        >
          <Clock className="h-4 w-4" />
          <span className="text-sm">Pick date & time</span>
        </button>
      ) : (
        <div className="px-3 py-2 space-y-2">
          <input
            type="date"
            value={customSnoozeDate}
            onChange={(e) => setCustomSnoozeDate(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            min={new Date().toISOString().split('T')[0]}
            className="w-full px-2 py-1 text-sm border border-input rounded bg-background"
          />
          <input
            type="time"
            value={customSnoozeTime}
            onChange={(e) => setCustomSnoozeTime(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            className="w-full px-2 py-1 text-sm border border-input rounded bg-background"
          />
          <div className="flex gap-2">
            <button
              onClick={(e) => {
                e.stopPropagation();
                setShowCustomDatePicker(false);
              }}
              className="flex-1 px-2 py-1 text-sm border border-input rounded hover:bg-accent"
            >
              Cancel
            </button>
            <button
              onClick={handleCustomSnooze}
              disabled={!customSnoozeDate}
              className="flex-1 px-2 py-1 text-sm bg-primary text-primary-foreground rounded hover:bg-primary/90 disabled:opacity-50"
            >
              Snooze
            </button>
          </div>
        </div>
      )}

      {isSnoozed && emailId && onUnsnooze && (
        <>
          <div className="border-t border-border my-1" />
          <button
            onClick={async (e) => {
              e.stopPropagation();
              await onUnsnooze(emailId);
              onClose();
            }}
            className="w-full px-3 py-2 text-left hover:bg-accent text-sm text-red-500"
          >
            Remove snooze
          </button>
        </>
      )}
    </div>
  );
}
