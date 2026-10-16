import { useEffect, useState } from 'react';

/**
 * The current time, re-read every `intervalMs` while the component is mounted.
 * For displays that must follow the clock — "today", a now-line — without each
 * one running its own timer logic.
 */
export function useNow(intervalMs = 60_000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}
