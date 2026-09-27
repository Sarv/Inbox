import { Clock } from 'lucide-react';
import { useState } from 'react';

// The same presets and the same custom-pick parsing the compose "Send later"
// menu uses — see utils/time-presets.
import { customDateTime, dateInputValue, snoozePresets, toEpochSeconds } from '../../utils/time-presets';

import type { SnoozeDropdownProps } from './types';

export function SnoozeDropdown({ emailId, isSnoozed, onSnooze, onBulkSnooze, onUnsnooze, onClose, align = 'right' }: SnoozeDropdownProps) {
  const [showCustomDatePicker, setShowCustomDatePicker] = useState(false);
  const [customSnoozeDate, setCustomSnoozeDate] = useState('');
  const [customSnoozeTime, setCustomSnoozeTime] = useState('09:00');

  const snoozeOptions = snoozePresets();

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

    const snoozeDate = customDateTime(customSnoozeDate, customSnoozeTime);
    if (!snoozeDate) return;

    handleSnooze(toEpochSeconds(snoozeDate), e);
  };

  const alignClass = align === 'left' ? 'left-0' : 'right-0';

  return (
    <div className={`absolute ${alignClass} top-full mt-1 z-[100] bg-popover border border-border rounded-lg shadow-lg py-1 w-72`}>
      <div className="px-3 py-1.5 text-xs font-semibold text-muted-foreground uppercase">
        Snooze until
      </div>
      {snoozeOptions.map((option) => (
        <button
          key={option.label}
          onClick={(e) => handleSnooze(toEpochSeconds(option.time), e)}
          className="w-full px-3 py-2 text-left hover:bg-accent flex items-center justify-between gap-3"
        >
          <span className="text-sm truncate">{option.label}</span>
          {/* The time never wraps or shrinks: "Mon, 8:00 AM" broken over two
              lines is what made this menu look ragged. */}
          <span className="text-xs text-muted-foreground whitespace-nowrap flex-shrink-0">{option.sublabel}</span>
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
            // Local date parts: toISOString() would offer "tomorrow" a day
            // early for anyone east of UTC late in the evening.
            setCustomSnoozeDate(dateInputValue(tomorrow));
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
            min={dateInputValue(new Date())}
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
