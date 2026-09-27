import { Clock } from 'lucide-react';
import { useEffect } from 'react';

import type { SendLaterDraft } from '../hooks/useSendLaterDrafts';
import {
  customDateTime,
  customDateTimeError,
  dateInputValue,
  earliestTimeFor,
  futureCustomDraft,
  sendLaterPresets,
  toEpochSeconds,
} from '../utils/time-presets';

export interface SendLaterDropdownProps {
  /** Receives the chosen delivery time as UTC epoch SECONDS. */
  onPick: (sendAt: number) => void;
  onClose: () => void;
  /** What the reader has typed so far, held by the owner so a click outside
   *  (which unmounts this menu) doesn't discard it. See useSendLaterDrafts. */
  draft: SendLaterDraft;
  onDraftChange: (patch: Partial<SendLaterDraft>) => void;
  /** The compose toolbar sits at the bottom of the window, so the menu opens
   *  upward by default; `down` is for a toolbar with room below it. */
  direction?: 'up' | 'down';
  /** Which edge the menu is pinned to, following SnoozeDropdown. A trigger near
   *  the right edge of its container needs `right`, or the 224px menu runs off
   *  the screen. */
  align?: 'left' | 'right';
}

/**
 * "Send later" — the same menu shape as SnoozeDropdown (and the same presets,
 * from utils/time-presets), because both answer "when?" and a reader should
 * not have to learn two.
 *
 * Every time it offers is in the future: the presets by construction, the
 * custom pick by refusing a moment that has already passed.
 */
export function SendLaterDropdown({
  onPick,
  onClose,
  draft,
  onDraftChange,
  direction = 'up',
  align = 'left',
}: SendLaterDropdownProps) {
  const { showCustom, date: customDate, time: customTime } = draft;

  // Reopening with a pick that has since lapsed: refresh it to the nearest
  // valid moment, ONCE, as the menu opens. Doing it on every render would
  // rewrite the fields under someone in the middle of typing.
  useEffect(() => {
    if (!showCustom) return;
    const refreshed = futureCustomDraft(customDate, customTime, new Date());
    if (refreshed.date !== customDate || refreshed.time !== customTime) onDraftChange(refreshed);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- on mount only, see above
  }, []);

  const now = new Date();
  const presets = sendLaterPresets(now);
  const customError = customDateTimeError(customDate, customTime, now);

  const pick = (sendAt: number, event: React.MouseEvent) => {
    event.stopPropagation();
    onPick(sendAt);
    onClose();
  };

  const pickCustom = (event: React.MouseEvent) => {
    event.stopPropagation();
    // Re-checked against the clock at the moment of the click, not the moment
    // of the last render: a menu left open can outlive the time it is offering.
    if (customDateTimeError(customDate, customTime, new Date())) return;
    const chosen = customDateTime(customDate, customTime);
    if (!chosen) return;
    pick(toEpochSeconds(chosen), event);
  };

  const positionClass = direction === 'up' ? 'bottom-full mb-1' : 'top-full mt-1';
  const alignClass = align === 'left' ? 'left-0' : 'right-0';

  return (
    <div className={`absolute ${alignClass} ${positionClass} z-[100] bg-popover border border-border rounded-lg shadow-lg py-1 w-72`}>
      <div className="px-3 py-1.5 text-xs font-semibold text-muted-foreground uppercase">Send later</div>
      {presets.map((option) => (
        <button
          key={option.label}
          onClick={(event) => pick(toEpochSeconds(option.time), event)}
          className="w-full px-3 py-2 text-left hover:bg-accent flex items-center justify-between gap-3"
        >
          <span className="text-sm truncate">{option.label}</span>
          {/* The time never wraps or shrinks: "Mon, 8:00 AM" broken over two
              lines is what made this menu look ragged. */}
          <span className="text-xs text-muted-foreground whitespace-nowrap flex-shrink-0">{option.sublabel}</span>
        </button>
      ))}

      <div className="border-t border-border my-1" />
      {!showCustom ? (
        <button
          onClick={(event) => {
            event.stopPropagation();
            // Whatever was typed before, as long as it is still in the future —
            // otherwise tomorrow morning, or the next half hour for a pick that
            // has lapsed. Local parts throughout: toISOString() offers tomorrow
            // a day early for anyone east of UTC in the evening.
            onDraftChange({ showCustom: true, ...futureCustomDraft(customDate, customTime, now) });
          }}
          className="w-full px-3 py-2 text-left hover:bg-accent flex items-center gap-2"
        >
          <Clock className="h-4 w-4" />
          <span className="text-sm">Pick date &amp; time</span>
        </button>
      ) : (
        <div className="px-3 py-2 space-y-2">
          <input
            type="date"
            aria-label="Delivery date"
            value={customDate}
            onChange={(event) => onDraftChange({ date: event.target.value })}
            onClick={(event) => event.stopPropagation()}
            min={dateInputValue(now)}
            className="w-full px-2 py-1 text-sm border border-input rounded bg-background"
          />
          <input
            type="time"
            aria-label="Delivery time"
            value={customTime}
            onChange={(event) => onDraftChange({ time: event.target.value })}
            onClick={(event) => event.stopPropagation()}
            // On today the earlier half of the day is already gone.
            min={earliestTimeFor(customDate, now)}
            className="w-full px-2 py-1 text-sm border border-input rounded bg-background"
          />
          {/* The date input's own `min` stops the calendar, not a typed date —
              so say why Schedule is refusing rather than leaving it greyed. */}
          {customError && <p role="alert" className="text-xs text-destructive">{customError}</p>}
          <div className="flex gap-2">
            <button
              onClick={(event) => {
                event.stopPropagation();
                onDraftChange({ showCustom: false });
              }}
              className="flex-1 px-2 py-1 text-sm border border-input rounded hover:bg-accent"
            >
              Cancel
            </button>
            <button
              onClick={pickCustom}
              disabled={!customDate || customError !== null}
              className="flex-1 px-2 py-1 text-sm bg-primary text-primary-foreground rounded hover:bg-primary/90 disabled:opacity-50"
            >
              Schedule
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
