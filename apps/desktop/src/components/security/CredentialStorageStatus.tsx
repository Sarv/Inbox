import { KeyRound, RefreshCw, ShieldAlert, ShieldCheck, ShieldQuestion } from 'lucide-react';

import { useSecureStorageStatus } from '../../hooks/useSecureStorageStatus';
import { secureKeyStoreName, secureStorageNotice } from '../../utils/secure-storage-status';

/** Displays metadata only; saved credential values never reach this panel. */
export function CredentialStorageStatus() {
  const { status, loading, error, retry, requestAccess, requestingAccess, restarting, accessMessage } = useSecureStorageStatus();
  const notice = secureStorageNotice(status, error);
  const allowKeychain = status?.platform === 'darwin' && status.keyStore === 'unavailable';
  const busy = loading || requestingAccess || restarting;
  const protectionLabel = { encrypted: 'Encrypted by the OS secure store', unprotected: 'Unprotected saved key', missing: 'Not found', unknown: 'Could not verify' };
  return <section aria-label="Saved credential protection" className="space-y-3">
    <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Saved credential protection</h2><div className="flex flex-wrap gap-2">{allowKeychain && <button type="button" disabled={busy} onClick={() => void requestAccess()} aria-label="Allow Keychain access" className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs hover:bg-accent disabled:opacity-50"><KeyRound className="h-3.5 w-3.5" />{restarting ? 'Restarting Inbox…' : requestingAccess ? 'Waiting for macOS…' : 'Allow Keychain access'}</button>}<button type="button" disabled={busy} onClick={() => void retry()} className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs hover:bg-accent disabled:opacity-50"><RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />{loading ? 'Checking protection…' : 'Check protection again'}</button></div></div>
    {notice && <div className="rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-sm"><p className="font-medium">{notice.title}</p><p className="mt-1 leading-6">{notice.detail} {notice.advice}</p></div>}
    {accessMessage && <p role="status" className="text-sm text-muted-foreground">{accessMessage}</p>}
    {!status ? <p className="text-sm text-muted-foreground">{loading ? 'Checking saved credential protection…' : 'Saved credential protection is unknown.'}</p> : <dl className="divide-y divide-border rounded-lg border border-border bg-card">
      <div className="flex flex-wrap justify-between gap-x-6 gap-y-1 px-4 py-3 text-sm"><dt>{secureKeyStoreName(status)}</dt><dd className="text-muted-foreground">{status.keyStore === 'available' ? 'Available' : status.keyStore === 'basic-text' ? 'Basic-text backend · no OS-backed protection' : 'Currently unavailable'}</dd></div>
      <div className="flex flex-wrap justify-between gap-x-6 gap-y-1 px-4 py-3 text-sm"><dt>Saved database key</dt><dd className={status.databaseKeyProtection === 'unprotected' ? 'text-amber-700 dark:text-amber-400' : 'text-muted-foreground'}>{protectionLabel[status.databaseKeyProtection]}</dd>{status.databaseReadable !== null && <dd className="w-full text-xs text-muted-foreground">{status.databaseReadable ? 'The local database is readable in this session.' : 'The local database could not be read in this session.'}</dd>}</div>
      {status.stores.map(store => {
        const Icon = store.protection === 'encrypted' ? ShieldCheck : store.protection === 'unprotected' ? ShieldAlert : ShieldQuestion;
        const label = store.protection === 'encrypted' ? store.protectedByDatabase ? 'Protected by encrypted database' : 'Encrypted credential envelope' : store.protection === 'unprotected' ? 'Unprotected at rest' : store.protection === 'missing' ? 'No saved data found' : 'Could not verify protection';
        return <div key={store.id} data-credential-store={store.id} className="flex flex-wrap items-center justify-between gap-x-6 gap-y-1 px-4 py-3 text-sm"><dt>{store.label}</dt><dd className={`flex items-center gap-1.5 ${store.protection === 'unprotected' ? 'text-amber-700 dark:text-amber-400' : 'text-muted-foreground'}`}><Icon aria-hidden="true" className="h-3.5 w-3.5" />{label}</dd></div>;
      })}
    </dl>}
  </section>;
}
