import { CalendarDays, Check, ExternalLink, Loader2, Mail, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import type { DefaultAppsState } from '../types/default-apps';
import { trapDialogTab } from '../utils/modal-focus';

type Target = 'email' | 'calendar';
const targets: Target[] = ['email', 'calendar'];
const targetName = (target: Target) => target === 'email' ? 'Email' : 'Calendar';

interface Receipt { target: Target; message: string; failed: boolean }
export interface DefaultAppsStartupPromptProps {
  /** Onboarding and other startup questions can finish before this one opens. */
  suppressed?: boolean;
  onOpenChange?: (open: boolean) => void;
}

/** Nothing registers or changes a default until the user presses Make default. */
export function DefaultAppsStartupPrompt({ suppressed = false, onOpenChange }: DefaultAppsStartupPromptProps) {
  const api = window.electronAPI?.defaultApps;
  const [state, setState] = useState<DefaultAppsState | null>(null);
  const [eligible, setEligible] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [selected, setSelected] = useState<Record<Target, boolean>>({ email: false, calendar: false });
  const [dontAskAgain, setDontAskAgain] = useState(false);
  const [busy, setBusy] = useState<'applying' | 'checking' | 'saving' | 'settings' | null>(null);
  const [error, setError] = useState('');
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const mounted = useRef(false);
  const generation = useRef(0);
  const pending = useRef(false);
  const dialog = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const openChange = useRef(onOpenChange);
  openChange.current = onOpenChange;
  const open = eligible && !dismissed && !suppressed;

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; generation.current += 1; };
  }, []);

  useEffect(() => {
    if (!api?.getStatus) return;
    const current = ++generation.current;
    void api.getStatus().then(result => {
      if (!mounted.current || generation.current !== current || !result.success) return;
      setState(result.data);
      setEligible(result.data.shouldPrompt && !result.data.suppressPrompt);
      setSelected({ email: result.data.email.canRequest && result.data.email.status !== 'default', calendar: result.data.calendar.canRequest && result.data.calendar.status !== 'default' });
    }).catch(() => {
      // An unreadable preference must not override a previous Don't ask again.
      // The user can still manage app defaults in the operating system.
    });
    return () => { generation.current += 1; };
  }, [api]);

  useEffect(() => { openChange.current?.(open); }, [open]);
  useEffect(() => () => { openChange.current?.(false); }, []);

  const dismiss = async () => {
    if (pending.current) return;
    if (dontAskAgain === !!state?.suppressPrompt) { setDismissed(true); return; }
    if (!api) return;
    pending.current = true; setBusy('saving'); setError('');
    const current = generation.current;
    try {
      const result = await api.setPromptSuppressed(dontAskAgain);
      if (!mounted.current || current !== generation.current) return;
      if (!result.success) throw new Error(result.error);
      setState(result.data); setDismissed(true);
    } catch (failure) {
      if (mounted.current && current === generation.current) setError(failure instanceof Error ? failure.message : 'Your preference could not be saved. Try again or clear Don’t ask again to close for now.');
    } finally {
      pending.current = false;
      if (mounted.current && current === generation.current) setBusy(null);
    }
  };
  const dismissRef = useRef(dismiss);
  dismissRef.current = dismiss;

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement;
    heading.current?.focus({ preventScroll: true });
    const onKey = (event: KeyboardEvent) => {
      event.stopPropagation();
      if (event.key === 'Escape') { event.preventDefault(); void dismissRef.current(); }
      else trapDialogTab(event, dialog.current);
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true });
    };
  }, [open]);

  if (!open || !state) return null;
  const applicable = targets.filter(target => selected[target] && state[target].canRequest && state[target].status !== 'default');
  const hasSettings = targets.some(target => state[target].method === 'settings') || state.platform === 'darwin' || state.platform === 'win32';

  const makeDefault = async () => {
    if (!api || pending.current || !applicable.length) return;
    const requested = [...applicable];
    const current = generation.current;
    pending.current = true; setBusy('applying'); setError(''); setReceipts([]);
    try {
      if (dontAskAgain) {
        const saved = await api.setPromptSuppressed(true);
        if (!mounted.current || current !== generation.current) return;
        if (saved.success) setState(saved.data);
        else setError(saved.error || 'Your prompt preference could not be saved.');
      }
      for (const target of requested) {
        try {
          const result = await api.requestDefault(target);
          if (!mounted.current || current !== generation.current) return;
          if (!result.success) throw new Error(result.error);
          setState(result.data.state);
          setReceipts(previous => [...previous, { target, message: result.data.message, failed: result.data.outcome === 'unsupported' }]);
        } catch (failure) {
          if (!mounted.current || current !== generation.current) return;
          setReceipts(previous => [...previous, { target, message: failure instanceof Error ? failure.message : `Could not change the default ${target} app.`, failed: true }]);
        }
      }
    } catch (failure) {
      if (mounted.current && current === generation.current) setError(failure instanceof Error ? failure.message : 'Your preference could not be saved.');
    } finally {
      pending.current = false;
      if (mounted.current && current === generation.current) setBusy(null);
    }
  };

  const recheck = async () => {
    if (!api || pending.current) return;
    const current = generation.current;
    pending.current = true; setBusy('checking'); setError('');
    try {
      const result = await api.getStatus();
      if (!mounted.current || current !== generation.current) return;
      if (!result.success) throw new Error(result.error);
      setState(result.data);
    } catch (failure) {
      if (mounted.current && current === generation.current) setError(failure instanceof Error ? failure.message : 'Could not check the current defaults.');
    } finally {
      pending.current = false;
      if (mounted.current && current === generation.current) setBusy(null);
    }
  };

  const openSettings = async () => {
    if (!api || pending.current) return;
    const current = generation.current;
    pending.current = true; setBusy('settings'); setError('');
    try {
      const result = await api.openSettings();
      if (!mounted.current || current !== generation.current) return;
      if (!result.success) throw new Error(result.error);
      if (!result.data.opened) throw new Error('System settings could not be opened. Open your operating system’s default apps settings manually.');
    } catch (failure) {
      if (mounted.current && current === generation.current) setError(failure instanceof Error ? failure.message : 'System settings could not be opened.');
    } finally {
      pending.current = false;
      if (mounted.current && current === generation.current) setBusy(null);
    }
  };

  const buttonBaseClass = 'rounded-md border px-3 py-2 text-sm font-medium transition-colors disabled:cursor-default disabled:opacity-50';
  const buttonClass = `${buttonBaseClass} border-border enabled:hover:bg-muted/50`;
  const primaryButtonClass = `${buttonBaseClass} border-transparent bg-foreground text-background enabled:hover:bg-foreground/90`;
  return <div role="dialog" aria-modal="true" aria-labelledby="default-apps-title" aria-describedby="default-apps-description" className="fixed inset-0 z-[245] flex items-center justify-center bg-black/45 p-4" onMouseDown={event => { if (event.target === event.currentTarget) void dismiss(); }}>
    <div ref={dialog} className="flex max-h-full w-full max-w-lg flex-col overflow-hidden rounded-lg border border-border bg-background text-foreground shadow-xl">
      <header className="flex items-start justify-between gap-4 px-6 pt-6"><h2 id="default-apps-title" ref={heading} tabIndex={-1} className="text-lg font-semibold outline-none">Use Inbox by default</h2><button type="button" onClick={() => void dismiss()} disabled={!!busy} aria-label="Close default app prompt" className="rounded p-1 text-muted-foreground hover:bg-muted/50 disabled:opacity-40"><X size={18} /></button></header>
      <div className="min-h-0 overflow-y-auto px-6 pb-2 pt-2">
        <p id="default-apps-description" className="text-sm leading-6 text-muted-foreground">Choose what opens in Inbox when you use an email link or open a calendar file.</p>
        <div className="mt-5 divide-y divide-border overflow-hidden rounded-md border border-border">{targets.map(target => {
          const status = state[target];
          const isDefault = status.status === 'default';
          const Icon = target === 'email' ? Mail : CalendarDays;
          return <label key={target} className={`flex items-start gap-3 px-4 py-4 ${!status.canRequest || isDefault ? '' : 'cursor-pointer hover:bg-muted/30'}`}>
            <input type="checkbox" checked={isDefault || selected[target]} disabled={!!busy || !status.canRequest || isDefault} onChange={event => setSelected(current => ({ ...current, [target]: event.target.checked }))} aria-label={`Use Inbox for ${target}`} className="mt-1 h-4 w-4 shrink-0 accent-current" />
            <Icon size={19} className="mt-0.5 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span className="min-w-0 flex-1"><span className="flex flex-wrap items-center justify-between gap-2 text-sm font-medium"><span>{targetName(target)}</span>{isDefault && <span className="flex items-center gap-1 text-xs text-muted-foreground"><Check size={13} />Already default</span>}</span><span className="mt-1 block text-xs leading-5 text-muted-foreground">{target === 'email' ? 'Email links (mailto)' : 'Calendar files (.ics) and links (webcal)'}</span>{status.detail && <span className="mt-1 block text-xs leading-5 text-muted-foreground">{status.detail}</span>}</span>
          </label>;
        })}</div>
        {!!receipts.length && <div className="mt-4 space-y-2" aria-live="polite">{receipts.map(receipt => <p key={receipt.target} role={receipt.failed ? 'alert' : 'status'} className={`text-sm leading-5 ${receipt.failed ? 'text-destructive' : 'text-muted-foreground'}`}><strong className="font-medium">{targetName(receipt.target)}: </strong>{receipt.message}</p>)}</div>}
        {error && <p role="alert" className="mt-4 text-sm leading-5 text-destructive">{error}</p>}
        {busy === 'applying' && <p role="status" className="mt-4 flex items-center gap-2 text-sm text-muted-foreground"><Loader2 size={14} className="animate-spin" />Waiting for the system response…</p>}
        {!!receipts.length && <button type="button" onClick={() => void recheck()} disabled={!!busy} className="mt-3 text-xs text-muted-foreground underline underline-offset-2 disabled:opacity-50">{busy === 'checking' ? 'Checking defaults…' : 'Check defaults again'}</button>}
        {hasSettings && <button type="button" onClick={() => void openSettings()} disabled={!!busy} className="mt-4 flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"><ExternalLink size={13} />Open system default app settings</button>}
        <label className="mt-5 flex cursor-pointer items-center gap-2 text-xs text-muted-foreground"><input type="checkbox" checked={dontAskAgain} disabled={!!busy} onChange={event => setDontAskAgain(event.target.checked)} className="h-3.5 w-3.5 accent-current" />Don’t ask again</label>
      </div>
      <footer className="mt-4 flex flex-wrap justify-end gap-2 border-t border-border px-6 py-4"><button type="button" disabled={!!busy} onClick={() => void dismiss()} className={buttonClass}>{busy === 'saving' ? 'Saving…' : receipts.length ? 'Done' : 'Not now'}</button><button type="button" disabled={!!busy || !applicable.length} onClick={() => void makeDefault()} className={primaryButtonClass}>{busy === 'applying' ? 'Making default…' : 'Make default'}</button></footer>
    </div>
  </div>;
}
