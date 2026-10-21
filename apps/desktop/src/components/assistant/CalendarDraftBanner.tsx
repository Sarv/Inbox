import { CalendarCheck, Loader2, RefreshCw } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import type { LocalCalendarAvailability } from '../../types/local-calendar';
import { recheckDraftCalendarAvailability, usedCalendarSlots } from '../../utils/calendar-draft';

export function CalendarDraftBanner({ proposal, body }: { proposal?: LocalCalendarAvailability; body: string }) {
  const [checking, setChecking] = useState(false);
  const [message, setMessage] = useState('');
  const [failed, setFailed] = useState(false);
  const generation = useRef(0);
  useEffect(() => {
    generation.current++;
    setMessage(''); setFailed(false); setChecking(false);
    return () => { generation.current++; };
  }, [proposal, body]);
  if (!proposal || !usedCalendarSlots(proposal, body).length) return null;
  const check = async () => {
    const current = ++generation.current;
    setChecking(true);
    setMessage('');
    try {
      await recheckDraftCalendarAvailability(proposal, body);
      if (generation.current !== current) return;
      setFailed(false);
      setMessage('These suggested times are still free on your selected local calendars.');
    } catch (error) {
      if (generation.current !== current) return;
      setFailed(true);
      setMessage(error instanceof Error ? error.message : 'Calendar could not be checked.');
    } finally { if (generation.current === current) setChecking(false); }
  };
  return <div aria-label="Meeting availability" className="shrink-0 space-y-1 border-b border-border bg-primary/5 px-3 py-2 text-xs">
    <div className="flex items-start justify-between gap-3"><p className="flex items-center gap-2 font-medium"><CalendarCheck className="h-4 w-4 shrink-0 text-primary" />Local calendar checked · {proposal.timeZone}</p><button type="button" onClick={() => void check()} disabled={checking} className="flex shrink-0 items-center gap-1 text-primary hover:underline disabled:opacity-50">{checking ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}Recheck</button></div>
    <p className="text-muted-foreground">Only selected local calendars are included. These times are not reserved; recipient availability is unknown. Times still in your email are checked again before sending.</p>
    {message && <p role={failed ? 'alert' : 'status'} className={failed ? 'text-destructive' : 'text-foreground'}>{message}</p>}
  </div>;
}
