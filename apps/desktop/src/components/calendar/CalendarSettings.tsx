import { Download, Loader2, Trash2, X } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';

import { requestConfirm } from '../../store/confirm-service';
import type { LocalCalendar, LocalCalendarPreferences } from '../../types/local-calendar';
import { trapDialogTab } from '../../utils/modal-focus';

import { buttonClass, inputClass } from './calendar-view';

export type CalendarSettingsSection = 'calendar' | 'preferences' | 'transfer';
interface CalendarSettingsProps {
  section: CalendarSettingsSection;
  calendar?: LocalCalendar;
  calendars: LocalCalendar[];
  preferences: LocalCalendarPreferences;
  onClose: () => void;
  onSaved: () => void;
}
const MAX_ICS_BYTES = 1_000_000;

export function CalendarSettings({ section, calendar, calendars, preferences, onClose, onSaved }: CalendarSettingsProps) {
  const [name, setName] = useState(calendar?.name ?? '');
  const [color, setColor] = useState(calendar?.color ?? '#2563eb');
  const [visible, setVisible] = useState(calendar?.visible ?? true);
  const [blocksAvailability, setBlocksAvailability] = useState(calendar?.blocksAvailability ?? true);
  const [isDefault, setIsDefault] = useState(calendar?.isDefault ?? calendars.length === 0);
  const [prefs, setPrefs] = useState(preferences);
  const [transferCalendar, setTransferCalendar] = useState(calendar?.id ?? calendars.find(item => item.isDefault)?.id ?? calendars[0]?.id ?? '');
  const [ics, setIcs] = useState('');
  const [exported, setExported] = useState('');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const pending = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const run = async (operation: () => Promise<void>) => {
    if (pending.current) return;
    pending.current = true; setSaving(true); setError(null); setNotice('');
    try { await operation(); } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : 'Could not update the calendar.'); }
    finally { pending.current = false; if (mounted.current) setSaving(false); }
  };
  const save = (submit: FormEvent) => {
    submit.preventDefault();
    void run(async () => {
      const result = section === 'preferences' ? await window.electronAPI.calendar.savePreferences(prefs)
        : await window.electronAPI.calendar.saveCalendar({ ...(calendar ? { id: calendar.id } : {}), name: name.trim(), color, visible, blocksAvailability, isDefault });
      if (!result.success) throw new Error(result.error);
      if (mounted.current) onSaved();
    });
  };
  const remove = async () => {
    if (!calendar || pending.current) return;
    const confirmed = await requestConfirm({ title: 'Delete local calendar', message: `Delete “${calendar.name}” and all of its local events? This cannot be undone.`, confirmLabel: 'Delete calendar', destructive: true });
    if (!confirmed || !mounted.current) return;
    void run(async () => {
      const result = await window.electronAPI.calendar.deleteCalendar(calendar.id);
      if (!result.success) throw new Error(result.error);
      if (mounted.current) onSaved();
    });
  };
  const importIcs = () => void run(async () => {
    if (new TextEncoder().encode(ics).length > MAX_ICS_BYTES) throw new Error('Choose an .ics file smaller than 1 MB.');
    const result = await window.electronAPI.calendar.importIcs({ calendarId: transferCalendar, text: ics });
    if (!result.success) throw new Error(result.error);
    if (mounted.current) { setNotice(`${result.data.imported} events imported.`); setIcs(''); }
  });
  const exportIcs = () => void run(async () => {
    const result = await window.electronAPI.calendar.exportIcs({ calendarId: transferCalendar });
    if (!result.success) throw new Error(result.error);
    if (mounted.current) { setExported(result.data.text); setNotice('Export ready. Download or copy the calendar text below.'); }
  });
  const download = () => {
    const url = URL.createObjectURL(new Blob([exported], { type: 'text/calendar;charset=utf-8' }));
    const link = document.createElement('a'); link.href = url; link.download = `${(calendars.find(item => item.id === transferCalendar)?.name ?? 'calendar').replace(/[^a-z0-9_-]/gi, '_')}.ics`; link.click(); URL.revokeObjectURL(url);
  };
  const title = section === 'preferences' ? 'Calendar preferences' : section === 'transfer' ? 'Import and export' : calendar ? 'Manage local calendar' : 'New local calendar';
  const numericPrefs: Array<{ key: 'durationMinutes' | 'bufferBeforeMinutes' | 'bufferAfterMinutes' | 'minimumNoticeMinutes' | 'slotIntervalMinutes'; label: string; min: number }> = [
    { key: 'durationMinutes', label: 'Meeting duration (minutes)', min: 5 }, { key: 'bufferBeforeMinutes', label: 'Buffer before suggested meeting (minutes)', min: 0 },
    { key: 'bufferAfterMinutes', label: 'Buffer after suggested meeting (minutes)', min: 0 }, { key: 'minimumNoticeMinutes', label: 'Minimum notice (minutes)', min: 0 }, { key: 'slotIntervalMinutes', label: 'Time slot interval (minutes)', min: 5 },
  ];
  return <div className="absolute inset-0 z-30 flex items-center justify-center bg-background/70 p-3 backdrop-blur-sm" onKeyDown={key => { key.stopPropagation(); trapDialogTab(key, key.currentTarget); if (key.key === 'Escape' && !saving) onClose(); }}><section role="dialog" aria-modal="true" aria-labelledby="calendar-settings-heading" className="flex max-h-full w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-border bg-background shadow-xl">
    <header className="flex shrink-0 items-center justify-between border-b border-border p-4"><h2 id="calendar-settings-heading" className="font-semibold">{title}</h2><button type="button" onClick={onClose} disabled={saving} aria-label="Close calendar settings" className="rounded-lg p-2 hover:bg-accent disabled:opacity-50"><X className="h-4 w-4" /></button></header>
    <form onSubmit={save} className="min-h-0 space-y-4 overflow-y-auto p-4">
      {section === 'calendar' && <>
        <label className="block space-y-1 text-xs font-medium">Name<input autoFocus aria-label="Calendar name" value={name} maxLength={120} required onChange={change => setName(change.target.value)} className={inputClass} /></label>
        <label className="flex items-center gap-3 text-sm">Color<input type="color" aria-label="Calendar color" value={color} onChange={change => setColor(change.target.value)} className="h-9 w-14 rounded border border-border bg-background p-1" /></label>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={visible} onChange={change => setVisible(change.target.checked)} />Show in calendar views</label>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={blocksAvailability} onChange={change => setBlocksAvailability(change.target.checked)} />Include in availability checks</label>
        <p className="text-xs leading-5 text-muted-foreground">Visibility controls what you see. Availability checks include busy events in selected calendars even when a calendar is hidden.</p>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={isDefault} onChange={change => setIsDefault(change.target.checked)} />Default for new events</label>
      </>}
      {section === 'preferences' && <>
        <label className="block space-y-1 text-xs font-medium">Time zone<input autoFocus aria-label="Calendar time zone" value={prefs.timeZone} onChange={change => setPrefs(current => ({ ...current, timeZone: change.target.value }))} className={inputClass} placeholder="Asia/Kolkata" /></label>
        <fieldset><legend className="mb-2 text-xs font-medium">Working days</legend><div className="flex flex-wrap gap-3">{['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((day, index) => <label key={day} className="flex items-center gap-1 text-xs"><input type="checkbox" aria-label={`Work on ${day}`} checked={prefs.workingDays.includes(index)} onChange={change => setPrefs(current => ({ ...current, workingDays: change.target.checked ? [...current.workingDays, index] : current.workingDays.filter(value => value !== index) }))} />{day}</label>)}</div></fieldset>
        <div className="grid grid-cols-2 gap-3"><label className="space-y-1 text-xs font-medium">Working day starts<input aria-label="Working hours start" type="time" value={prefs.workingStart} onChange={change => setPrefs(current => ({ ...current, workingStart: change.target.value }))} className={inputClass} /></label><label className="space-y-1 text-xs font-medium">Working day ends<input aria-label="Working hours end" type="time" value={prefs.workingEnd} onChange={change => setPrefs(current => ({ ...current, workingEnd: change.target.value }))} className={inputClass} /></label></div>
        <div className="grid grid-cols-2 gap-3">{numericPrefs.map(field => <label key={field.key} className="space-y-1 text-xs font-medium">{field.label}<input aria-label={field.label} type="number" min={field.min} max={10080} value={prefs[field.key]} onChange={change => setPrefs(current => ({ ...current, [field.key]: Number(change.target.value) }))} className={inputClass} /></label>)}</div>
      </>}
      {section === 'transfer' && <>
        <label className="block space-y-1 text-xs font-medium">Local calendar<select aria-label="Transfer calendar" value={transferCalendar} onChange={change => { setTransferCalendar(change.target.value); setExported(''); }} className={inputClass}>{calendars.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        <label className="block space-y-1 text-xs font-medium">Import .ics file<input aria-label="Import calendar file" type="file" accept=".ics,text/calendar" disabled={saving} onChange={change => { const file = change.target.files?.[0]; if (!file) return; setError(null); if (file.size > MAX_ICS_BYTES) { setError('Choose an .ics file smaller than 1 MB.'); return; } void file.text().then(text => { if (mounted.current) setIcs(text); }).catch(() => { if (mounted.current) setError('Could not read the selected file.'); }); }} className={inputClass} /></label>
        <label className="block space-y-1 text-xs font-medium">Or paste calendar text<textarea aria-label="Calendar import text" value={ics} maxLength={MAX_ICS_BYTES} onChange={change => setIcs(change.target.value)} rows={5} className={`${inputClass} font-mono text-xs`} /></label>
        <p className="text-xs text-muted-foreground">Import up to 1 MB of iCalendar text into the selected local calendar.</p>
        <div className="flex flex-wrap gap-2"><button type="button" disabled={saving || !ics.trim() || !transferCalendar} onClick={importIcs} className={buttonClass}>Import events</button><button type="button" disabled={saving || !transferCalendar} onClick={exportIcs} className={buttonClass}>Export calendar</button></div>
        {exported && <><textarea readOnly aria-label="Calendar export text" value={exported} rows={5} className={`${inputClass} font-mono text-xs`} /><button type="button" onClick={download} className="flex items-center gap-2 text-sm font-medium text-primary"><Download className="h-4 w-4" />Download .ics</button></>}
      </>}
      {error && <p role="alert" className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">{error}</p>}{notice && <p role="status" className="text-sm text-primary">{notice}</p>}
      <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-4">{section === 'calendar' && calendar ? <button type="button" disabled={saving} onClick={() => void remove()} className="flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm text-destructive hover:bg-destructive/10 disabled:opacity-50"><Trash2 className="h-4 w-4" />Delete calendar</button> : <span />}<div className="flex gap-2"><button type="button" disabled={saving} onClick={section === 'transfer' ? onSaved : onClose} className={buttonClass}>{section === 'transfer' ? 'Done' : 'Cancel'}</button>{section !== 'transfer' && <button type="submit" disabled={saving || (section === 'calendar' && !name.trim())} className="flex items-center gap-2 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50">{saving && <Loader2 className="h-4 w-4 animate-spin" />}Save {section === 'calendar' ? 'calendar' : 'preferences'}</button>}</div></footer>
    </form>
  </section></div>;
}
