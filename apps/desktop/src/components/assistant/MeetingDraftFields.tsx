import { useEffect, useMemo, useRef, useState } from 'react';

import type { LocalCalendarAvailability, LocalCalendarAvailabilityRequest } from '../../types/local-calendar';
import { addLocalDays, dateInTimeZone, instantToWallClock, wallClockToInstant } from '../../utils/local-calendar';

export function MeetingDraftFields({ value, onChange }: { value?: LocalCalendarAvailabilityRequest; onChange: (value: LocalCalendarAvailabilityRequest | undefined) => void }) {
  const [enabled, setEnabled] = useState(!!value);
  const [zone, setZone] = useState(value?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [start, setStart] = useState(value && Number.isFinite(value.startMs) ? instantToWallClock(value.startMs, zone) : '');
  const [end, setEnd] = useState(value && Number.isFinite(value.endMs) ? instantToWallClock(value.endMs, zone) : '');
  const [duration, setDuration] = useState(value?.durationMinutes ?? 30);
  const [loading, setLoading] = useState(true);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState<LocalCalendarAvailability>();
  const previewGeneration = useRef(0);
  const api = window.electronAPI?.calendar;
  useEffect(() => {
    let active = true;
    if (!api) { setLoading(false); return; }
    void api.snapshot({ startMs: Date.now(), endMs: Date.now() + 86_400_000 }).then(result => {
      if (!active) return;
      if (!result.success) throw new Error(result.error);
      const preferences = result.data.preferences;
      if (!value) {
        const today = dateInTimeZone(Date.now(), preferences.timeZone);
        setZone(preferences.timeZone);
        setDuration(preferences.durationMinutes);
        setStart(`${today}T${preferences.workingStart}`);
        setEnd(`${addLocalDays(today, 7)}T${preferences.workingEnd}`);
      }
    }).catch(cause => { if (active) setError(cause instanceof Error ? cause.message : 'Calendar is unavailable.'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
    // Read the saved settings once when the drafting form opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api]);
  const range = useMemo(() => {
    try {
      const startMs = wallClockToInstant(start, zone);
      const endMs = wallClockToInstant(end, zone);
      if (endMs <= startMs) throw new Error('Choose an end time after the start.');
      if (!Number.isInteger(duration) || duration < 5 || duration > 480) throw new Error('Choose a duration from 5 to 480 minutes.');
      return { request: { startMs, endMs, durationMinutes: duration, timeZone: zone, limit: 3 }, error: '' };
    } catch (cause) {
      return { request: { startMs: NaN, endMs: NaN, durationMinutes: duration, timeZone: zone, limit: 3 }, error: cause instanceof Error ? cause.message : 'Choose a valid date range.' };
    }
  }, [start, end, duration, zone]);
  useEffect(() => {
    previewGeneration.current++;
    onChange(enabled ? range.request : undefined);
    setPreview(undefined);
    setChecking(false);
  }, [enabled, range, onChange]);
  useEffect(() => () => { previewGeneration.current++; }, []);
  const check = async () => {
    if (!api || range.error) return;
    const generation = ++previewGeneration.current;
    setChecking(true); setError('');
    try {
      const result = await api.availability(range.request);
      if (generation !== previewGeneration.current) return;
      if (!result.success) throw new Error(result.error);
      if (result.data.status !== 'ready') throw new Error('Select a calendar that blocks availability in Calendar settings.');
      setPreview(result.data);
    } catch (cause) { if (generation === previewGeneration.current) setError(cause instanceof Error ? cause.message : 'Calendar could not be checked.'); }
    finally { if (generation === previewGeneration.current) setChecking(false); }
  };
  return <fieldset className="space-y-2 rounded-lg border border-border p-3 text-xs [color-scheme:light] dark:[color-scheme:dark]">
    <legend className="px-1 font-medium">Meeting availability</legend>
    <p className="text-muted-foreground">Meeting requests automatically check your selected local calendars. Choose a range to override the request. Recipient and external calendars are not connected.</p>
    <label className="flex items-center gap-2"><input type="checkbox" checked={enabled} disabled={loading || !api} onChange={event => setEnabled(event.target.checked)} />Choose meeting date range</label>
    {enabled && <div className="space-y-2"><p className="text-muted-foreground">{zone} · Saved working hours and buffers apply.</p><label className="block space-y-1"><span>Meeting range starts</span><input type="datetime-local" aria-label="Meeting range starts" value={start} onChange={event => setStart(event.target.value)} className="block w-full rounded border border-border bg-background p-2" /></label><label className="block space-y-1"><span>Meeting range ends</span><input type="datetime-local" aria-label="Meeting range ends" value={end} onChange={event => setEnd(event.target.value)} className="block w-full rounded border border-border bg-background p-2" /></label><label className="block space-y-1"><span>Meeting duration (minutes)</span><input type="number" min={5} max={480} value={duration} onChange={event => setDuration(Number(event.target.value))} className="block w-full rounded border border-border bg-background p-2" /></label>{range.error && <p role="alert" className="text-destructive">{range.error}</p>}<button type="button" onClick={() => void check()} disabled={!!range.error || checking} className="text-primary hover:underline disabled:opacity-50">{checking ? 'Checking calendar…' : 'Preview available times'}</button></div>}
    {error && <p role="alert" className="text-destructive">{error}</p>}
    {preview && <div role="status" className="space-y-1">{preview.slots.length ? <ul className="space-y-1">{preview.slots.map(slot => <li key={slot.startMs}>{slot.label}</li>)}</ul> : <p>No available times in this range.</p>}<p className="text-muted-foreground">Local calendars only · Rechecked when the draft is prepared.</p></div>}
  </fieldset>;
}
