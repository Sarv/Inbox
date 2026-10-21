import { KeyRound, RefreshCw, ShieldAlert, X } from 'lucide-react';
import { useState } from 'react';

import { useSecureStorageStatus } from '../hooks/useSecureStorageStatus';
import { secureStorageNotice } from '../utils/secure-storage-status';

import { Tooltip } from './Tooltip';

/**
 * Current key-store access and saved protection are separate observations.
 * Only a confirmed unprotected store is described as unprotected.
 */
export function SecurityStatusBanner() {
  const { status, loading, error, retry, requestAccess, requestingAccess, restarting, accessMessage } = useSecureStorageStatus();
  const [dismissed, setDismissed] = useState<string | null>(null);
  const notice = secureStorageNotice(status, error);
  const noticeKey = notice ? JSON.stringify(notice) : null;
  const allowKeychain = status?.platform === 'darwin' && status.keyStore === 'unavailable';
  const busy = loading || requestingAccess || restarting;

  if (!notice || dismissed === noticeKey) return null;

  return (
    <div role="status" className="flex items-start gap-3 px-4 py-2 bg-amber-500/10 border-b border-amber-500/30 text-sm text-amber-800 dark:text-amber-300">
      <ShieldAlert className="h-4 w-4 flex-shrink-0 text-amber-600 dark:text-amber-400" />
      <span className="flex-1 min-w-0 break-words">
        <span className="font-semibold">{notice.title}</span>{' '}
        <span className="opacity-90">{notice.detail}</span>{' '}
        {notice.advice && <span className="opacity-80">{notice.advice}</span>}
        {accessMessage && <span className="mt-1 block font-medium">{accessMessage}</span>}
      </span>
      <div className="flex shrink-0 flex-col gap-1 sm:flex-row sm:items-start">
        {allowKeychain && <button type="button" onClick={() => void requestAccess()} disabled={busy} aria-label="Allow Keychain access" className="flex items-center gap-1 rounded border border-amber-500/30 px-2 py-1 text-xs hover:bg-amber-500/20 disabled:opacity-50"><KeyRound className="h-3 w-3" />{restarting ? 'Restarting Inbox…' : requestingAccess ? 'Waiting for macOS…' : 'Allow Keychain access'}</button>}
        <button type="button" onClick={() => void retry()} disabled={busy} aria-label="Retry credential protection check" className="flex items-center gap-1 rounded border border-amber-500/30 px-2 py-1 text-xs hover:bg-amber-500/20 disabled:opacity-50"><RefreshCw className={`h-3 w-3 ${loading ? 'animate-spin' : ''}`} />{loading ? 'Checking…' : 'Retry'}</button>
      </div>
      <Tooltip content="Dismiss" delayMs={40}>
        <button
          type="button"
          onClick={() => setDismissed(noticeKey)}
          aria-label="Dismiss"
          className="p-1 rounded hover:bg-amber-500/20 transition-colors flex-shrink-0"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </Tooltip>
    </div>
  );
}
