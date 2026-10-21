import { useCallback, useEffect, useRef, useState } from 'react';

import type { SecureStorageStatus } from '../types/secure-storage';

/** Read metadata about saved protection separately from current key-store availability. */
export function useSecureStorageStatus() {
  const api = window.electronAPI?.secureCreds;
  const [status, setStatus] = useState<SecureStorageStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [requestingAccess, setRequestingAccess] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [accessMessage, setAccessMessage] = useState<string | null>(null);
  const alive = useRef(false);
  const generation = useRef(0);
  const accessGeneration = useRef(0);
  const accessInFlight = useRef(false);
  const restartingRef = useRef(false);
  const retry = useCallback(async () => {
    const current = ++generation.current;
    setLoading(true); setError(null);
    try {
      if (!api?.status) throw new Error('Credential protection status is unavailable in this version of Inbox.');
      const result = await api.status();
      if (!alive.current || current !== generation.current) return;
      if (!result.success || !result.data) throw new Error(result.error || 'Credential protection could not be checked.');
      setStatus(result.data);
    } catch (failure) {
      if (alive.current && current === generation.current) {
        setStatus(null);
        setError(failure instanceof Error ? failure.message : 'Credential protection could not be checked.');
      }
    } finally { if (alive.current && current === generation.current) setLoading(false); }
  }, [api]);
  /** Explicit user action only: metadata checks must never request OS permission. */
  const requestAccess = useCallback(async () => {
    if (!alive.current || accessInFlight.current || restartingRef.current) return;
    const current = ++accessGeneration.current;
    accessInFlight.current = true;
    setRequestingAccess(true); setAccessMessage(null);
    try {
      if (!api?.requestAccess) throw new Error('Keychain permission requests are unavailable in this version of Inbox.');
      const result = await api.requestAccess();
      if (!alive.current || current !== accessGeneration.current) return;
      if (!result.success || !result.data) throw new Error(result.error || 'Could not request macOS Keychain access.');
      if (result.data.outcome === 'authorized') {
        if (result.data.restarting) {
          restartingRef.current = true;
          setRestarting(true);
          setAccessMessage('Restarting Inbox to retry Keychain access and verify saved storage protection…');
        } else {
          setAccessMessage('Secure storage is available. Rechecking saved protection…');
          await retry();
        }
      } else if (result.data.outcome === 'cancelled') {
        setAccessMessage('The Keychain access request was cancelled. You can try again when ready.');
      } else {
        setAccessMessage('macOS Keychain access is still unavailable. Sign out and back in, or restart your Mac, then retry.');
      }
    } catch (failure) {
      if (alive.current && current === accessGeneration.current) setAccessMessage(failure instanceof Error ? failure.message : 'Could not request macOS Keychain access.');
    } finally {
      if (alive.current && current === accessGeneration.current) {
        accessInFlight.current = false;
        setRequestingAccess(false);
      }
    }
  }, [api, retry]);
  useEffect(() => {
    alive.current = true; void retry();
    return () => { alive.current = false; generation.current += 1; accessGeneration.current += 1; accessInFlight.current = false; };
  }, [retry]);
  return { status, loading, error, retry, requestAccess, requestingAccess, restarting, accessMessage };
}
