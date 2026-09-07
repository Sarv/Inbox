import { CalendarCheck, CalendarClock, CalendarPlus, Loader2, MapPin, Users, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import {
  formatEventRange,
  isInviteCancelled,
  parseCalendarInvite,
  type CalendarInvite,
} from '../../utils/calendar-invite';
import { Tooltip } from '../Tooltip';


interface CalendarInviteBannerProps {
  emailId: string;
  /**
   * Owning account of this email. Threaded to every calendar IPC so the main
   * process resolves the RIGHT per-account DB/engine — without it, an All-Inboxes
   * mail from a non-active account failed with "Email not found".
   */
  accountId?: string;
  /**
   * Raw ICS stored on the email row. A non-empty valid ICS is parsed locally
   * (fast, offline). `null`/`undefined` means "never checked" → fetch + parse the
   * message source once. An empty string is the "checked, no invite" sentinel.
   */
  calendarIcs?: string | null;
  /** Persisted flag: user has added this invite to their calendar (DB-backed). */
  calendarAdded?: boolean;
}

/**
 * Gmail-style calendar-invite card, shown above the message body when an email
 * carries a calendar invite. Renders the event time (in the viewer's local
 * timezone), title, location, organizer and guest count, plus an "Add to
 * calendar" action that opens the .ics in the OS default calendar app.
 *
 * Resolution order: parse the ICS captured on the row (local, offline); if
 * absent but the email has a `.ics` attachment (legacy mail synced before the
 * capture landed), fetch + backfill it via IPC. Renders nothing when there is no
 * parseable invite. Every field is rendered as escaped plain text.
 */
export function CalendarInviteBanner({ emailId, accountId, calendarIcs, calendarAdded }: CalendarInviteBannerProps) {
  const localInvite = useMemo(() => parseCalendarInvite(calendarIcs), [calendarIcs]);
  // Only fetch when the row has NEVER been checked (null/undefined). A stored ''
  // sentinel ("checked, no invite") or any stored string is left alone — no
  // repeat network per open.
  const canFetch = calendarIcs == null;

  const [fetchedInvite, setFetchedInvite] = useState<CalendarInvite | null>(null);
  const [opening, setOpening] = useState(false);
  const [added, setAdded] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);

  // Mirror the DB-backed "added" flag (persists across reopen/restart). Local
  // state is updated optimistically on add/remove; this resyncs it per email.
  useEffect(() => {
    setAdded(Boolean(calendarAdded));
  }, [emailId, calendarAdded]);

  // Legacy fallback: the row was never checked (calendarIcs == null) — ask the
  // main process to extract the invite from the message source (catching unnamed
  // text/calendar parts too), backfill the row, and parse the returned ICS.
  useEffect(() => {
    if (localInvite || !canFetch) {
      setFetchedInvite(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await window.electronAPI.emails.getCalendarInvite(emailId, accountId);
        if (cancelled) return;
        setFetchedInvite(res.success && res.ics ? parseCalendarInvite(res.ics) : null);
      } catch {
        if (!cancelled) setFetchedInvite(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [emailId, localInvite, canFetch]);

  const invite = localInvite ?? fetchedInvite;
  if (!invite) return null;

  const cancelled = isInviteCancelled(invite);
  const timeRange = formatEventRange(invite.startMs, invite.endMs, invite.isAllDay);

  const handleAddToCalendar = async () => {
    setOpening(true);
    setOpenError(null);
    try {
      const res = await window.electronAPI.emails.openCalendarInvite(emailId, accountId);
      if (res.success) {
        setAdded(true); // optimistic
        void window.electronAPI.emails.setCalendarAdded(emailId, true, accountId);
      } else {
        setOpenError(
          res.noHandler
            ? 'No calendar app is set up to open this invite on your system.'
            : res.error || 'Could not open the invite.',
        );
      }
    } catch (error) {
      console.error('[CalendarInvite] Open failed:', error);
      setOpenError('Could not open the invite.');
    } finally {
      setOpening(false);
    }
  };

  // Clears OUR "added" marker only — it does not remove the event from the OS
  // calendar (we have no write access there), so the button just resets.
  const handleClearAdded = () => {
    setAdded(false); // optimistic
    setOpenError(null);
    void window.electronAPI.emails.setCalendarAdded(emailId, false, accountId);
  };

  return (
    <div className="mb-4 rounded-lg border border-blue-500/30 bg-blue-500/[0.06] dark:bg-blue-400/[0.08] overflow-hidden">
      <div className="flex items-start gap-3 p-3">
        <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-md bg-blue-500/15 text-blue-600 dark:text-blue-300">
          <CalendarClock className="h-5 w-5" />
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold text-foreground">{timeRange}</span>
            {cancelled && (
              <span className="rounded px-1.5 py-0.5 text-xs font-medium bg-red-500/15 text-red-600 dark:text-red-400">
                Cancelled
              </span>
            )}
          </div>

          {invite.summary && (
            <div
              className={`mt-0.5 truncate text-sm ${
                cancelled ? 'text-muted-foreground line-through' : 'text-foreground'
              }`}
            >
              {invite.summary}
            </div>
          )}

          {invite.location && (
            <div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
              <MapPin className="h-3.5 w-3.5 flex-shrink-0" />
              <span className="truncate">{invite.location}</span>
            </div>
          )}

          {(invite.organizer || invite.attendeeCount > 0) && (
            <div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
              <Users className="h-3.5 w-3.5 flex-shrink-0" />
              <span className="truncate">
                {invite.organizer}
                {invite.organizer && invite.attendeeCount > 0 ? ' · ' : ''}
                {invite.attendeeCount > 0
                  ? `${invite.attendeeCount} ${invite.attendeeCount === 1 ? 'guest' : 'guests'}`
                  : ''}
              </span>
            </div>
          )}

          <div className="mt-2 flex items-center gap-2">
            {added ? (
              <span className="flex items-center gap-1 rounded-md bg-green-500/15 pl-2.5 pr-1 py-1 text-xs font-medium text-green-700 dark:text-green-400">
                <CalendarCheck className="h-3.5 w-3.5" />
                Added to calendar
                <Tooltip content="Clear (doesn't remove from your calendar)" delayMs={40}>
                  <button
                    onClick={handleClearAdded}
                    aria-label="Clear added-to-calendar mark"
                    className="ml-0.5 rounded p-0.5 hover:bg-green-500/25 transition-colors"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </Tooltip>
              </span>
            ) : (
              <button
                onClick={handleAddToCalendar}
                disabled={opening}
                className="flex items-center gap-1.5 rounded-md bg-blue-500/15 px-2.5 py-1 text-xs font-medium text-blue-700 hover:bg-blue-500/25 disabled:opacity-60 dark:text-blue-300 transition-colors"
              >
                {opening ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <CalendarPlus className="h-3.5 w-3.5" />
                )}
                Add to calendar
              </button>
            )}
            {openError && <span className="text-xs text-amber-600 dark:text-amber-400">{openError}</span>}
          </div>
        </div>
      </div>
    </div>
  );
}
