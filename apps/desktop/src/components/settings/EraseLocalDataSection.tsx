import { AlertTriangle, Loader2, RefreshCw, Trash2, X } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState } from 'react';

import type { LocalDataProfileId as ProfileId, LocalDataProfiles as ProfilesState } from '../../types/local-data';
import { trapDialogTab } from '../../utils/modal-focus';

const BUTTON = 'rounded-md border border-border bg-background px-3 py-2 text-sm font-medium text-foreground transition-colors enabled:hover:bg-muted enabled:hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50';
const DESTRUCTIVE = 'inline-flex items-center justify-center gap-2 rounded-md border border-transparent bg-red-600 px-3 py-2 text-sm font-medium text-white transition-colors enabled:hover:bg-red-700 dark:enabled:hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50';

/** Profile paths are displayed for review; only the fixed profile id crosses the erase API. */
export function EraseLocalDataSection() {
  const api = window.electronAPI?.localData;
  const [state, setState] = useState<ProfilesState | null>(null);
  const [selected, setSelected] = useState<ProfileId | null>(null);
  const [loading, setLoading] = useState(true);
  const [readError, setReadError] = useState('');
  const [actionError, setActionError] = useState('');
  const [receipt, setReceipt] = useState('');
  const [open, setOpen] = useState(false);
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const alive = useRef(false);
  const readGeneration = useRef(0);
  const actionGeneration = useRef(0);
  const pending = useRef(false);
  const restartingRef = useRef(false);
  const dialog = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const sectionHeading = useRef<HTMLHeadingElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const confirmationId = useId();

  const refresh = useCallback(async () => {
    const current = ++readGeneration.current;
    setLoading(true); setReadError('');
    try {
      if (!api?.getProfiles) throw new Error('Local data reset is unavailable in this version of Inbox.');
      const result = await api.getProfiles();
      if (!alive.current || current !== readGeneration.current) return;
      if (!result.success) throw new Error(result.error || 'Could not check local profiles.');
      if (!result.data) throw new Error('Could not check local profiles.');
      setState(result.data);
      setSelected(previous => previous ?? result.data.currentProfile);
    } catch (failure) {
      if (alive.current && current === readGeneration.current) setReadError(failure instanceof Error ? failure.message : 'Could not check local profiles.');
    } finally {
      if (alive.current && current === readGeneration.current) setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    alive.current = true; void refresh();
    return () => { alive.current = false; readGeneration.current += 1; actionGeneration.current += 1; };
  }, [refresh]);

  const close = () => {
    if (pending.current || restartingRef.current) return;
    setOpen(false); setConfirmation(''); setActionError('');
  };
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement;
    const fallbackHeading = sectionHeading.current;
    heading.current?.focus({ preventScroll: true });
    const onKey = (event: KeyboardEvent) => {
      event.stopPropagation();
      if (event.key === 'Escape') { event.preventDefault(); closeRef.current(); }
      else trapDialogTab(event, dialog.current);
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      if (opener instanceof HTMLElement && opener.isConnected) {
        opener.focus({ preventScroll: true });
        if (document.activeElement === opener) return;
      }
      if (fallbackHeading?.isConnected) fallbackHeading.focus({ preventScroll: true });
    };
  }, [open]);

  const profile = state?.profiles.find(entry => entry.id === selected);
  const otherRunning = !!profile && !profile.current && profile.running;
  const currentDevelopment = !!profile?.current && profile.id === 'development';
  const ready = !!profile && !loading && !readError;
  const blocked = busy || restarting;
  const canOpen = ready && profile.exists && !profile.blockedReason && !otherRunning && !blocked;
  const requiredText = selected ? `ERASE ${selected}` : '';
  const canErase = canOpen && confirmation === requiredText;

  const begin = () => {
    if (!canOpen || open || pending.current) return;
    setConfirmation(''); setActionError(''); setReceipt(''); setOpen(true);
    void refresh();
  };

  const erase = async () => {
    if (!api || !selected || !canErase || pending.current || restartingRef.current) return;
    const target = selected;
    const current = ++actionGeneration.current;
    pending.current = true; setBusy(true); setActionError('');
    try {
      const result = await api.erase({ profile: target, confirmation });
      if (!alive.current || current !== actionGeneration.current) return;
      if (!result.success) throw new Error(result.error || 'Could not erase the selected local profile.');
      if (!result.data) throw new Error('Could not erase the selected local profile.');
      restartingRef.current = result.data.restarting;
      setRestarting(result.data.restarting);
      setReceipt(result.data.requiresManualStart ? 'Inbox is quitting to erase the development profile. Restart your development server after the reset finishes.' : result.data.restarting ? `Inbox is restarting to finish erasing the ${target} profile.` : `Local data erased for the ${target} profile.`);
      setOpen(false); setConfirmation('');
      if (!result.data.restarting) await refresh();
    } catch (failure) {
      if (alive.current && current === actionGeneration.current) setActionError(failure instanceof Error ? failure.message : 'Could not erase the selected local profile.');
    } finally {
      if (alive.current && current === actionGeneration.current) { pending.current = false; setBusy(false); }
    }
  };

  return <section aria-label="Erase all local data" className="space-y-4 border-t border-border pt-6">
    <div><h3 ref={sectionHeading} tabIndex={-1} className="text-sm font-semibold uppercase tracking-wider text-muted-foreground outline-none">Erase all local data</h3><p className="mt-3 text-sm leading-6 text-muted-foreground">Reset one Inbox profile on this computer. This permanently removes its downloaded mail and attachments, accounts, saved passwords and sign-in tokens, drafts and outbox, Inbox Agent chats, contacts, local calendars, and settings.</p></div>
    <p className="text-sm leading-6 text-muted-foreground">Mail on your email servers and the other Inbox profile are unaffected. Browser sign-in sessions and the operating system’s Keychain encryption master are preserved. Local-only drafts, queued messages, contacts, and calendar events cannot be recovered by syncing again.</p>
    <fieldset disabled={blocked || loading || open} className="space-y-2"><legend className="mb-2 text-sm font-medium">Profile to erase</legend>{state?.profiles.map(entry => <label key={entry.id} className={`flex items-start gap-3 rounded-md border px-3 py-3 ${selected === entry.id ? 'border-foreground/40 bg-muted/40' : 'border-border'} ${blocked || loading || open ? 'opacity-60' : 'cursor-pointer hover:bg-muted/40'}`}>
      <input type="radio" name={`erase-profile-${titleId}`} value={entry.id} checked={selected === entry.id} onChange={() => { if (pending.current || restartingRef.current || open) return; setSelected(entry.id); setConfirmation(''); setReceipt(''); setActionError(''); void refresh(); }} className="mt-1 shrink-0 accent-current" aria-label={`${entry.label}${entry.current ? ' (current profile)' : ''}`} />
      <span className="min-w-0 flex-1"><span className="block text-sm font-medium">{entry.label}{entry.current && <span className="ml-2 text-xs font-normal text-muted-foreground">Current profile</span>}</span><span className="mt-1 block break-all text-xs text-muted-foreground">{entry.path}</span><span className="mt-1 block text-xs text-muted-foreground">{entry.blockedReason || (!entry.exists ? 'No local profile data found.' : entry.current ? entry.id === 'development' ? 'Inbox will quit; restart your development server after the reset finishes.' : 'Inbox will restart after this reset.' : entry.running ? 'Close this profile’s Inbox app before erasing it.' : 'This profile’s Inbox app is closed.')}</span></span>
    </label>)}</fieldset>
    {loading && <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 size={14} className="animate-spin" />Checking local profiles…</p>}
    {!open && readError && <p role="alert" className="text-sm text-destructive">{readError}</p>}
    {otherRunning && <p role="status" className="text-sm text-muted-foreground">Close the {selected} Inbox app, then refresh the profile status before continuing.</p>}
    {receipt && <p role="status" className="text-sm text-muted-foreground">{receipt}</p>}
    <div className="flex flex-wrap gap-2"><button type="button" onClick={begin} disabled={!canOpen || open} className={DESTRUCTIVE}><Trash2 size={15} />Erase all local data…</button><button type="button" disabled={blocked || loading || open} onClick={() => void refresh()} className={`inline-flex items-center gap-2 ${BUTTON}`}><RefreshCw size={14} />Refresh profile status</button></div>

    {open && <div role="alertdialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descriptionId} className="fixed inset-0 z-[250] flex items-center justify-center bg-black/45 p-4" onMouseDown={event => { if (event.target === event.currentTarget) close(); }}>
      <div ref={dialog} className="max-h-full w-full max-w-lg overflow-y-auto rounded-lg border border-border bg-background p-6 text-foreground shadow-xl">
        <div className="flex items-start justify-between gap-3"><h2 ref={heading} id={titleId} tabIndex={-1} className="text-lg font-semibold outline-none">Erase {selected} local data?</h2><button type="button" onClick={close} disabled={blocked} aria-label="Close erase local data dialog" className="rounded p-1 text-muted-foreground enabled:hover:bg-muted enabled:hover:text-foreground disabled:opacity-50"><X size={18} /></button></div>
        <p id={descriptionId} className="mt-3 text-sm leading-6 text-muted-foreground">This permanently erases all local data for the <strong className="font-semibold text-foreground">{selected}</strong> profile. Unsynced drafts, outbox messages, chats, contacts, and local calendar data will be lost. Mail on the server, the other profile, browser sign-in, and the OS Keychain encryption master are unaffected.</p>
        {profile && <p className="mt-3 break-all rounded-md border border-border bg-muted/30 p-3 text-xs text-muted-foreground">{profile.path}</p>}
        {profile?.current && <p className="mt-3 text-sm text-muted-foreground">{currentDevelopment ? 'Inbox will quit; restart your development server after the reset finishes.' : 'Inbox will close and restart to finish the reset.'}</p>}
        <form className="mt-4 space-y-4" onSubmit={event => { event.preventDefault(); event.stopPropagation(); void erase(); }}>
          <div><label htmlFor={confirmationId} className="block text-sm font-medium">Type <span className="font-mono">{requiredText}</span> to confirm</label><input id={confirmationId} aria-label="Erase confirmation" value={confirmation} onChange={event => setConfirmation(event.target.value)} disabled={blocked} autoComplete="off" spellCheck={false} className="mt-2 w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-50" /></div>
          <p className="flex items-start gap-2 text-xs leading-5 text-muted-foreground"><AlertTriangle size={14} className="mt-0.5 shrink-0" />You will also be asked to confirm in the system dialog. This cannot be undone.</p>
          {loading && <p role="status" className="text-sm text-muted-foreground">Rechecking the selected profile…</p>}
          {readError && <p role="alert" className="text-sm text-destructive">{readError}</p>}
          {profile?.blockedReason && <p role="alert" className="text-sm text-destructive">{profile.blockedReason}</p>}
          {otherRunning && <p role="alert" className="text-sm text-destructive">Close the {selected} Inbox app before erasing this profile.</p>}
          {profile && !profile.exists && <p role="status" className="text-sm text-muted-foreground">No local data remains for this profile.</p>}
          {actionError && <p role="alert" className="text-sm text-destructive">{actionError}</p>}
          <div className="flex flex-wrap justify-end gap-2 border-t border-border pt-4"><button type="button" onClick={close} disabled={blocked} className={BUTTON}>Cancel</button><button type="submit" disabled={!canErase} className={DESTRUCTIVE}>{busy ? <Loader2 size={15} className="animate-spin" /> : <Trash2 size={15} />}{busy ? 'Waiting for system confirmation…' : currentDevelopment ? 'Erase and quit' : 'Erase selected profile'}</button></div>
        </form>
      </div>
    </div>}
  </section>;
}
