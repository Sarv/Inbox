import { createLogger } from '@sarvinbox/core/logger';
import { CalendarCheck, CalendarClock, CalendarPlus, Loader2, MapPin, Users, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import type { LocalCalendarInvitation, LocalCalendarInvitationResponse } from '../../types/calendar-invitations';
import {
  formatEventRange,
  isInviteCancelled,
  parseCalendarInvite,
  type CalendarInvite,
} from '../../utils/calendar-invite';
import { UnscannedAttachmentNotice } from '../attachment-viewer/AttachmentDownloadStatus';
import { Tooltip } from '../Tooltip';

const log = createLogger('CalendarInvite');

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
  const [unscannedOpen, setUnscannedOpen] = useState<{ emailId: string; accountId?: string }>();
  const [localMeeting, setLocalMeeting] = useState<LocalCalendarInvitation | null>(null);
  const [meetingChecked, setMeetingChecked] = useState(false);
  const [meetingError, setMeetingError] = useState<string | null>(null);
  const [responding, setResponding] = useState(false);
  const [delivery, setDelivery] = useState<'sent' | 'queued' | null>(null);
  const identity = JSON.stringify([emailId, accountId]);
  const currentIdentity = useRef(identity);
  currentIdentity.current = identity;
  const activeOpen = useRef<symbol | undefined>(undefined);

  useEffect(() => {
    activeOpen.current = undefined;
    setOpening(false);
    setOpenError(null);
    setUnscannedOpen(undefined);
    setLocalMeeting(null);
    setMeetingChecked(false);
    setMeetingError(null);
    setDelivery(null);
    setResponding(false);
    return () => { activeOpen.current = undefined; };
  }, [identity]);

  // Mirror the DB-backed "added" flag (persists across reopen/restart). Local
  // state is updated optimistically on add/remove; this resyncs it per email.
  useEffect(() => {
    setAdded(Boolean(calendarAdded));
  }, [emailId, accountId, calendarAdded]);

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
  }, [emailId, accountId, localInvite, canFetch]);

  useEffect(() => {
    const api = window.electronAPI?.calendar;
    if (!accountId || !api?.invitation || (!calendarIcs && !localInvite && !fetchedInvite)) return;
    let disposed = false;
    let generation = 0;
    const refresh = async () => {
      const current = ++generation;
      try {
        const result = await api.invitation({ accountId, emailId });
        if (disposed || current !== generation) return;
        if (result.success) { setLocalMeeting(result.data); setMeetingError(null); }
        else setMeetingError(result.error);
      } catch { if (!disposed && current === generation) setMeetingError('Could not update the Inbox calendar.'); }
      finally { if (!disposed && current === generation) setMeetingChecked(true); }
    };
    void refresh();
    const unsubscribe = api.onChanged(() => { void refresh(); });
    return () => { disposed = true; unsubscribe(); };
  }, [accountId, emailId, calendarIcs, localInvite, fetchedInvite]);

  const invite = localInvite ?? fetchedInvite;
  if (!invite && !localMeeting) return null;

  const cancelled = localMeeting?.cancelled ?? (invite ? isInviteCancelled(invite) : false);
  const timeRange = localMeeting?.startMs !== undefined
    ? formatEventRange(localMeeting.startMs, localMeeting.endMs ?? null, localMeeting.allDay ?? false, new Date(), localMeeting.timeZone)
    : invite ? formatEventRange(invite.startMs, invite.endMs, invite.isAllDay) : 'Meeting invitation';
  const summary = localMeeting?.title || invite?.summary;
  const localFeatureEnabled = Boolean(accountId && window.electronAPI?.calendar?.invitation);

  const respond = async (response: LocalCalendarInvitationResponse) => {
    if (!accountId || responding) return;
    const requestIdentity = identity;
    setResponding(true); setMeetingError(null); setDelivery(null);
    try {
      const result = await window.electronAPI.calendar.respondToInvitation({ accountId, emailId, response });
      if (currentIdentity.current !== requestIdentity) return;
      if (result.success) { setLocalMeeting(result.data.invitation); setDelivery(result.data.delivery); }
      else setMeetingError(result.error);
    } catch { if (currentIdentity.current === requestIdentity) setMeetingError('Could not send your meeting response.'); }
    finally { if (currentIdentity.current === requestIdentity) setResponding(false); }
  };

  const openLocalMeeting = () => {
    if (localMeeting?.eventId && localMeeting.startMs !== undefined) window.dispatchEvent(new CustomEvent('sarvinbox:calendar-open', { detail: { eventId: localMeeting.eventId, startMs: localMeeting.startMs } }));
  };

  const handleAddToCalendar = async () => {
    const request = Symbol('calendar-open');
    activeOpen.current = request;
    const isCurrent = () => currentIdentity.current === identity && activeOpen.current === request;
    setOpening(true);
    setOpenError(null);
    setUnscannedOpen(undefined);
    try {
      const res = await window.electronAPI.emails.openCalendarInvite(emailId, accountId);
      if (res.success) {
        void window.electronAPI.emails.setCalendarAdded(emailId, true, accountId);
        if (isCurrent()) {
          if (res.notScanned === true) setUnscannedOpen({ emailId, accountId });
          setAdded(true); // optimistic
        }
      } else if (isCurrent()) {
        setOpenError(
          res.noHandler
            ? 'No calendar app is set up to open this invite on your system.'
            : res.error || 'Could not open the invite.',
        );
      }
    } catch (error) {
      log.error('Open failed:', error);
      if (isCurrent()) setOpenError('Could not open the invite.');
    } finally {
      if (isCurrent()) {
        activeOpen.current = undefined;
        setOpening(false);
      }
    }
  };

  // Clears OUR "added" marker only — it does not remove the event from the OS
  // calendar (we have no write access there), so the button just resets.
  const handleClearAdded = () => {
    setAdded(false); // optimistic
    setOpenError(null);
    setUnscannedOpen(undefined);
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

          {summary && (
            <div
              className={`mt-0.5 truncate text-sm ${
                cancelled ? 'text-muted-foreground line-through' : 'text-foreground'
              }`}
            >
              {summary}
            </div>
          )}

          {invite?.location && (
            <div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
              <MapPin className="h-3.5 w-3.5 flex-shrink-0" />
              <span className="truncate">{invite.location}</span>
            </div>
          )}

          {invite && (invite.organizer || invite.attendeeCount > 0) && (
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

          {localMeeting ? (
            <div className="mt-3 space-y-2">
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <CalendarCheck className="h-3.5 w-3.5" />
                <span>{localMeeting.cancelled ? 'Meeting cancelled · Inbox calendar updated' : localMeeting.response === 'needs-action' ? 'Added to Inbox calendar · Awaiting your response' : localMeeting.response === 'declined' ? 'Declined · Availability is free' : localMeeting.response === 'accepted' ? 'Accepted · Inbox calendar updated' : 'Tentative · Inbox calendar updated'}</span>
                {localMeeting.eventId && !(localMeeting.cancelled && localMeeting.occurrenceStartMs !== undefined) && <button type="button" onClick={openLocalMeeting} className="underline underline-offset-2 hover:text-foreground">View in calendar</button>}
              </div>
              {!localMeeting.cancelled && <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Respond to invitation">
                {([['accepted', 'Accept'], ['tentative', 'Tentative'], ['declined', 'Decline']] as const).map(([response, label]) => (
                  <button key={response} type="button" disabled={responding || localMeeting.response === response} aria-pressed={localMeeting.response === response} onClick={() => { void respond(response); }} className="rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted disabled:opacity-60">{label}</button>
                ))}
                {responding && <span role="status" className="text-xs text-muted-foreground">Sending response…</span>}
              </div>}
              {delivery && <p role="status" className="text-xs text-muted-foreground">{delivery === 'sent' ? 'Response sent to the organizer.' : 'Response saved in Outbox. It will send when this account is connected.'}</p>}
            </div>
          ) : localFeatureEnabled && !meetingChecked ? <p role="status" className="mt-2 text-xs text-muted-foreground">Updating Inbox calendar…</p> : <div className="mt-2 flex items-center gap-2">
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
          </div>}
          {meetingError && <p role="alert" className="mt-2 text-xs text-amber-700 dark:text-amber-300">{meetingError}</p>}
          {unscannedOpen?.emailId === emailId && unscannedOpen.accountId === accountId && <UnscannedAttachmentNotice />}
        </div>
      </div>
    </div>
  );
}
