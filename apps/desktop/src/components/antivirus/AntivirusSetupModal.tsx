import type { AntivirusSetupStatus } from '@sarvinbox/core';
import { useEffect, useRef, useState } from 'react';

/** Mounted by the app, outside every extension frame. */
export function AntivirusSetupModal() {
  const [extensionId, setExtensionId] = useState<string | null>(null);
  useEffect(() => window.electronAPI?.antivirus?.onOpenSetup(({ extensionId: id }) => {
    if (typeof id === 'string' && id) setExtensionId(id);
  }), []);
  return extensionId ? <AntivirusSetupDialog key={extensionId} extensionId={extensionId} onClose={() => setExtensionId(null)} /> : null;
}

export function AntivirusSetupDialog({ extensionId, onClose }: { extensionId: string; onClose(): void }) {
  const [setup, setSetup] = useState<AntivirusSetupStatus | null>(null);
  const [endpoint, setEndpoint] = useState('');
  const [credential, setCredential] = useState('');
  const [challenge, setChallenge] = useState<string | null>(null);
  const [selectedAccounts, setSelectedAccounts] = useState<string[]>([]);
  const [allowBody, setAllowBody] = useState(false);
  const [attachmentConsent, setAttachmentConsent] = useState(false);
  const [bodyConsent, setBodyConsent] = useState(false);
  const [busy, setBusy] = useState<'loading' | 'probing' | 'saving' | 'disabling' | null>('loading');
  const [error, setError] = useState('');
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const activeRef = useRef(true);
  const api = window.electronAPI?.antivirus;

  useEffect(() => {
    activeRef.current = true;
    const previous = document.activeElement as HTMLElement | null;
    cancelRef.current?.focus();
    return () => { activeRef.current = false; previous?.focus(); };
  }, []);

  useEffect(() => {
    let current = true;
    const load = async () => {
      try {
        if (!api) throw new Error('Scanner setup is unavailable');
        const response = await api.getSetup(extensionId);
        if (!current) return;
        if (!response.success || !response.data) throw new Error(response.error || 'Could not load scanner setup');
        setSetup(response.data);
        setEndpoint(response.data.endpoint);
        setSelectedAccounts(response.data.allowedAccountIds);
        setAllowBody(response.data.allowBody);
      } catch (failure) {
        if (current) setError(failure instanceof Error ? failure.message : String(failure));
      } finally {
        if (current) setBusy(null);
      }
    };
    void load();
    return () => { current = false; };
  }, [api, extensionId]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        if (!busy) onClose();
      }
      if (event.key === 'Tab') {
        const controls = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), a[href], [tabindex="0"]'
        ) ?? []);
        const first = controls[0];
        const last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [busy, onClose]);

  const invalidate = () => {
    setChallenge(null);
    setAttachmentConsent(false);
    setBodyConsent(false);
  };

  const probe = async () => {
    if (!api || busy || !endpoint.trim()) return;
    setBusy('probing'); setError(''); invalidate();
    const secret = credential.trim() || undefined;
    setCredential('');
    try {
      const response = await api.probe(extensionId, endpoint.trim(), secret);
      if (!activeRef.current) return;
      if (!response.success || !response.data) throw new Error(response.error || 'Could not verify scanner');
      setSetup(response.data.setup);
      setChallenge(response.data.challenge);
      setSelectedAccounts((accounts) => accounts.filter((id) => response.data!.setup.accounts?.some((account) => account.id === id)));
    } catch (failure) {
      if (activeRef.current) setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      if (activeRef.current) setBusy(null);
    }
  };

  const canSave = Boolean(challenge && selectedAccounts.length > 0 && attachmentConsent && (!allowBody || bodyConsent) && !busy);
  const save = async () => {
    if (!api || !canSave || !challenge) return;
    setBusy('saving'); setError('');
    try {
      const response = await api.configure(extensionId, {
        challenge, allowedAccountIds: selectedAccounts, allowBody, attachmentConsent, bodyConsent,
      });
      if (!activeRef.current) return;
      if (!response.success) throw new Error(response.error || 'Could not enable scanning');
      onClose();
    } catch (failure) {
      if (activeRef.current) setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      if (activeRef.current) setBusy(null);
    }
  };

  const disable = async () => {
    if (!api || busy) return;
    setBusy('disabling'); setError('');
    try {
      const response = await api.disable(extensionId);
      if (!activeRef.current) return;
      if (!response.success) throw new Error(response.error || 'Could not disable scanning');
      onClose();
    } catch (failure) {
      if (activeRef.current) setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      if (activeRef.current) setBusy(null);
    }
  };

  const privacyUrl = setup?.privacyPolicyUrl && /^https?:\/\//i.test(setup.privacyPolicyUrl) ? setup.privacyPolicyUrl : null;
  return (
    <div className="fixed inset-0 z-[280] flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true" aria-labelledby="antivirus-setup-title">
      <div ref={dialogRef} className="flex max-h-[90vh] w-full max-w-xl flex-col rounded-lg border border-border bg-card shadow-2xl">
        <header className="flex items-center justify-between border-b border-border p-4">
          <div>
            <h2 id="antivirus-setup-title" className="font-semibold">Set up antivirus scanning</h2>
            <p className="mt-1 text-xs text-muted-foreground">Scanner access for {extensionId}</p>
          </div>
          <button ref={cancelRef} type="button" disabled={busy === 'saving' || busy === 'disabling'} onClick={onClose} className="rounded px-2 py-1 text-sm hover:bg-muted" aria-label="Close scanner setup">Close</button>
        </header>
        <div className="space-y-4 overflow-y-auto p-4 text-sm">
          <p className="text-muted-foreground">Selected files are sent to the service you configure. The extension receives scan results. Review the operator and privacy terms before enabling sharing.</p>
          <p className="text-xs text-muted-foreground">Temporary processing; cancellation requests do not prove deletion and active inspection may continue until the scanner worker finishes.</p>
          <label className="block">Scanner endpoint
            <input aria-label="Scanner endpoint" type="url" value={endpoint} disabled={Boolean(busy)} placeholder="https://scanner.example" onChange={(event) => {
              setEndpoint(event.target.value); invalidate(); setSelectedAccounts([]); setAllowBody(false);
            }} className="mt-1 w-full rounded border border-border bg-background px-3 py-2" />
          </label>
          <label className="block">Authentication credential (optional)
            <input aria-label="Authentication credential" type="password" autoComplete="off" value={credential} disabled={Boolean(busy)} onChange={(event) => { setCredential(event.target.value); invalidate(); }} className="mt-1 w-full rounded border border-border bg-background px-3 py-2" />
            <span className="mt-1 block text-xs text-muted-foreground">Stored by the app in its credential store and never returned to the extension. Leave blank to retain an existing credential for this endpoint.</span>
          </label>
          <button type="button" disabled={Boolean(busy) || !endpoint.trim()} onClick={() => { void probe(); }} className="rounded border border-border px-3 py-2 hover:bg-muted disabled:opacity-50">{busy === 'probing' ? 'Verifying…' : 'Verify scanner'}</button>
          {setup && (challenge || setup.configured) && (
            <section aria-label="Scanner privacy details" className="space-y-2 rounded border border-border bg-muted/30 p-3">
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
                <dt>Operator</dt><dd>{setup.operator || 'Not disclosed'}</dd>
                <dt>Region</dt><dd>{setup.region || 'Not disclosed'}</dd>
                <dt>Metadata retention</dt><dd>{setup.metadataRetentionSeconds === undefined ? 'Not disclosed' : `${setup.metadataRetentionSeconds} seconds`}</dd>
                {setup.contentLifetimeSeconds !== undefined && <><dt>Content processing lifetime</dt><dd>Up to {setup.contentLifetimeSeconds} seconds</dd></>}
                {setup.resultLifetimeSeconds !== undefined && <><dt>Result lifetime</dt><dd>Up to {setup.resultLifetimeSeconds} seconds</dd></>}
                <dt>Privacy terms version</dt><dd className="break-all">{setup.privacyTermsVersion || 'Not disclosed'}</dd>
                <dt>Scan policy version</dt><dd className="break-all">{setup.scanPolicyVersion || 'Not disclosed'}</dd>
              </dl>
              {privacyUrl && <button type="button" className="text-primary underline" onClick={() => { void window.electronAPI.app.openExternal(privacyUrl); }}>Read privacy policy</button>}
              {setup.developmentOnly && <p className="text-amber-600">This localhost service uses an unencrypted development connection.</p>}
            </section>
          )}
          <fieldset disabled={Boolean(busy)} className="space-y-2">
            <legend className="mb-2 font-medium">Accounts allowed to share selected attachments</legend>
            {(setup?.accounts ?? []).map((account) => <label key={account.id} className="flex items-start gap-2">
              <input type="checkbox" checked={selectedAccounts.includes(account.id)} onChange={(event) => {
                setSelectedAccounts((ids) => event.target.checked ? [...ids, account.id] : ids.filter((id) => id !== account.id));
                setAttachmentConsent(false); setBodyConsent(false);
              }} />
              <span>{account.name || account.email} <span className="text-muted-foreground">{account.name ? `(${account.email})` : ''}</span></span>
            </label>)}
            {!setup?.accounts?.length && <p className="text-muted-foreground">Add a mail account before enabling scanner sharing.</p>}
          </fieldset>
          <label className="flex items-start gap-2"><input type="checkbox" checked={attachmentConsent} disabled={!challenge || Boolean(busy)} onChange={(event) => setAttachmentConsent(event.target.checked)} /><span>I agree to send selected attachments from these accounts to {setup?.operator || 'this scanner'} under the privacy terms shown above.</span></label>
          <label className="flex items-start gap-2"><input type="checkbox" checked={allowBody} disabled={Boolean(busy)} onChange={(event) => { setAllowBody(event.target.checked); setBodyConsent(false); }} /><span>Allow email body scanning when I choose it for a message</span></label>
          {allowBody && <label className="flex items-start gap-2"><input type="checkbox" checked={bodyConsent} disabled={!challenge || Boolean(busy)} onChange={(event) => setBodyConsent(event.target.checked)} /><span>I separately agree to share email body text with this scanner. Each body scan still requires my explicit choice.</span></label>}
          {error && <p role="alert" className="rounded border border-destructive/40 bg-destructive/10 p-3 text-destructive">{error}</p>}
        </div>
        <footer className="flex items-center justify-between gap-2 border-t border-border p-4">
          <button type="button" disabled={Boolean(busy) || !setup?.enabled} onClick={() => { void disable(); }} className="rounded border border-border px-3 py-2 text-sm disabled:opacity-50">{busy === 'disabling' ? 'Disabling…' : 'Disable scanning'}</button>
          <div className="flex gap-2">
            <button type="button" disabled={busy === 'saving' || busy === 'disabling'} onClick={onClose} className="rounded border border-border px-3 py-2 text-sm">Cancel</button>
            <button type="button" disabled={!canSave} onClick={() => { void save(); }} className="rounded bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-50">{busy === 'saving' ? 'Enabling…' : 'Enable scanning'}</button>
          </div>
        </footer>
      </div>
    </div>
  );
}
