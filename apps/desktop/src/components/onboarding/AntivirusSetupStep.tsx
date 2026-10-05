import type { AntivirusSetupStatus } from '@sarvinbox/core';
import { ArrowLeft, ArrowRight, CheckCircle2, Loader2, ShieldCheck } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { ProviderIcon } from './ProviderIcon';

export interface AntivirusSetupStepProps {
  stage: 'provider' | 'connection';
  active: boolean;
  accountId: string | null;
  onStageChange(stage: 'provider' | 'connection'): void;
  onBack(): void;
  onComplete(result: { enabled: boolean; providerName?: string }): void;
}

const providerName = (setup: AntivirusSetupStatus | null) => setup?.endpoint === 'https://av.sarv.com' ? 'Sarv Antivirus' : setup?.operator || 'Your scanner';

export function AntivirusSetupStep({ stage, active, accountId, onStageChange, onBack, onComplete }: AntivirusSetupStepProps) {
  const [setup, setSetup] = useState<AntivirusSetupStatus | null>(null);
  const [challenge, setChallenge] = useState<string | null>(null);
  const [attachmentConsent, setAttachmentConsent] = useState(false);
  const [busy, setBusy] = useState<'loading' | 'connecting' | 'saving' | null>(null);
  const [error, setError] = useState('');
  const generation = useRef(0);
  const mounted = useRef(true);
  const api = window.electronAPI?.antivirus;
  const protectedAccount = Boolean(accountId && setup?.configured && setup.enabled && setup.allowedAccountIds.includes(accountId));
  const account = setup?.accounts?.find(value => value.id === accountId);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; generation.current += 1; void api?.cancelSarvOAuth?.().catch(() => {}); };
  }, [api]);

  useEffect(() => {
    const current = ++generation.current;
    setChallenge(null); setAttachmentConsent(false); setError('');
    if (!active) {
      setBusy(null);
      void api?.cancelSarvOAuth?.().catch(() => {});
      return;
    }
    setBusy('loading');
    void (async () => {
      try {
        if (!api?.getOnboardingSetup) throw new Error('Scanner setup is unavailable in this app. Update Inbox or skip for now.');
        const response = await api.getOnboardingSetup();
        if (current !== generation.current || !mounted.current) return;
        if (!response.success || !response.data) throw new Error(response.error || 'Could not read scanner setup. Retry or skip for now.');
        setSetup(response.data);
      } catch (failure) {
        if (current === generation.current && mounted.current) setError(failure instanceof Error ? failure.message : 'Could not read scanner setup. Retry or skip for now.');
      } finally {
        if (current === generation.current && mounted.current) setBusy(null);
      }
    })();
    return () => { generation.current += 1; void api?.cancelSarvOAuth?.().catch(() => {}); };
  }, [active, accountId, api]);

  const result = () => ({ enabled: protectedAccount, ...(protectedAccount ? { providerName: providerName(setup) } : {}) });
  const leave = async (back = false) => {
    if (busy === 'saving') return;
    generation.current += 1;
    setBusy(null); setChallenge(null); setAttachmentConsent(false); setError('');
    await api?.cancelSarvOAuth?.().catch(() => {});
    if (!mounted.current) return;
    if (back) { if (stage === 'connection') onStageChange('provider'); else onBack(); }
    else onComplete(result());
  };

  const connect = async () => {
    if (!api?.connectSarvOAuth || busy || !accountId || setup?.configured) return;
    const current = ++generation.current;
    setBusy('connecting'); setChallenge(null); setAttachmentConsent(false); setError('');
    try {
      const response = await api.connectSarvOAuth(accountId);
      if (current !== generation.current || !mounted.current) return;
      if (!response.success || !response.data) throw new Error(response.error || 'Scanner sign-in failed. Retry or skip for now.');
      if (response.data.setup.endpoint !== 'https://av.sarv.com' || !response.data.setup.accounts?.some(account => account.id === accountId)) {
        throw new Error('Scanner access does not match this mailbox. Retry or skip for now.');
      }
      setSetup(response.data.setup); setChallenge(response.data.challenge);
    } catch (failure) {
      if (current === generation.current && mounted.current) setError(failure instanceof Error ? failure.message : 'Scanner sign-in failed. Retry or skip for now.');
    } finally {
      if (current === generation.current && mounted.current) setBusy(null);
    }
  };

  const enable = async () => {
    if (!api?.completeSarvOAuth || busy || !challenge || !accountId || !attachmentConsent) return;
    const current = ++generation.current;
    setBusy('saving'); setError('');
    try {
      const response = await api.completeSarvOAuth({ challenge, accountId, attachmentConsent: true });
      if (current !== generation.current || !mounted.current) return;
      if (!response.success || !response.data) throw new Error(response.error || 'Could not enable antivirus. Retry sign-in or skip for now.');
      if (!response.data.configured || !response.data.enabled || !response.data.allowedAccountIds.includes(accountId)) {
        throw new Error('Antivirus was not enabled for this mailbox. Retry sign-in or skip for now.');
      }
      setSetup(response.data); setChallenge(null); setAttachmentConsent(false);
      onComplete({ enabled: true, providerName: 'Sarv Antivirus' });
    } catch (failure) {
      if (current === generation.current && mounted.current) {
        setChallenge(null); setAttachmentConsent(false);
        setError(failure instanceof Error ? failure.message : 'Could not enable antivirus. Retry sign-in or skip for now.');
      }
    } finally {
      if (current === generation.current && mounted.current) setBusy(null);
    }
  };

  const warning = <p className="text-sm leading-relaxed text-muted-foreground">If you skip setup, Inbox warns before viewing or downloading unscanned attachments. Scanner errors and detected threats remain blocked when scanning is connected.</p>;
  return (
    <div className="space-y-6" aria-busy={Boolean(busy)}>
      <header>
        <p className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">Antivirus · optional</p>
        <h2 className="text-2xl font-semibold tracking-tight">{stage === 'provider' ? 'Protect your attachments.' : 'Connect Sarv Antivirus'}</h2>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{stage === 'provider' ? 'Add virus scanning before opening or downloading email attachments.' : 'Approve scanner access with Sarv, then review its privacy terms.'}</p>
      </header>
      {stage === 'provider' ? (
        <>
          <button type="button" disabled={Boolean(busy)} onClick={() => onStageChange('connection')} className="flex w-full items-center gap-4 rounded-xl border border-border bg-background p-5 text-left transition-colors hover:border-primary hover:bg-primary/5 disabled:opacity-50">
            <ProviderIcon id="sarv" />
            <span className="min-w-0 flex-1"><span className="block font-medium">Sarv Antivirus</span><span className="mt-1 block text-sm text-muted-foreground">av.sarv.com · Connect securely with OAuth</span></span>
            <ArrowRight aria-hidden="true" className="h-4 w-4 shrink-0 text-muted-foreground" />
          </button>
          <p className="text-sm text-muted-foreground">Files are sent to https://av.sarv.com for scanning when you view or download them.</p>
          {protectedAccount && <p className="flex items-center gap-2 text-sm text-primary"><CheckCircle2 aria-hidden="true" className="h-4 w-4" />{providerName(setup)} is already connected for this mailbox.</p>}
        </>
      ) : (
        <>
          <section className="space-y-4 rounded-xl border border-border bg-muted/20 p-5">
            <div className="flex items-center gap-3"><ProviderIcon id="sarv" /><div><h3 className="font-medium">Sarv Antivirus</h3><p className="text-sm text-muted-foreground">https://av.sarv.com</p></div></div>
            {protectedAccount ? <p className="flex items-center gap-2 text-sm text-primary"><CheckCircle2 aria-hidden="true" className="h-4 w-4" />{providerName(setup)} is already protecting this mailbox.</p> : setup?.configured ? (
              <p className="text-sm text-muted-foreground">Your existing scanner connection is kept. Review its approved accounts in Extensions settings after onboarding to add this mailbox.</p>
            ) : challenge ? (
              <>
                <div className="space-y-2 text-sm" aria-label="Scanner privacy details">
                  <p className="flex items-center gap-2 font-medium"><ShieldCheck aria-hidden="true" className="h-4 w-4 text-primary" />Scanner access verified</p>
                  <p>Mailbox: <span className="break-all font-medium">{account?.email || accountId}</span></p>
                  <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-2 text-muted-foreground">
                    <dt>Operator</dt><dd className="break-words">{setup?.operator}</dd>
                    <dt>Region</dt><dd className="break-words">{setup?.region}</dd>
                    <dt>Content lifetime</dt><dd>Up to {setup?.contentLifetimeSeconds} seconds in temporary memory</dd>
                    <dt>Result lifetime</dt><dd>Up to {setup?.resultLifetimeSeconds} seconds</dd>
                    <dt>Usage metadata</dt><dd>{setup?.metadataRetentionSeconds === undefined ? 'Not disclosed' : `Up to ${setup.metadataRetentionSeconds} seconds`}</dd>
                    <dt>Privacy terms</dt><dd className="break-all">{setup?.privacyTermsVersion}</dd>
                  </dl>
                  {setup?.privacyPolicyUrl && <button type="button" onClick={() => { void window.electronAPI.app.openExternal(setup.privacyPolicyUrl!); }} className="text-primary underline underline-offset-2">Read scanner privacy policy</button>}
                </div>
                <label className="flex items-start gap-3 text-sm leading-relaxed"><input type="checkbox" checked={attachmentConsent} disabled={Boolean(busy)} onChange={event => setAttachmentConsent(event.target.checked)} className="mt-1 shrink-0" /><span>I agree to send attachments I view, open or download from {account?.email || 'this mailbox'} to {setup?.operator} under these privacy terms. Email body scanning stays off.</span></label>
                <button type="button" disabled={!attachmentConsent || Boolean(busy)} onClick={() => { void enable(); }} className="flex items-center justify-center gap-2 rounded-lg bg-primary px-5 py-3 text-sm font-medium text-primary-foreground disabled:opacity-50">{busy === 'saving' ? <><Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />Enabling antivirus…</> : 'Enable antivirus'}</button>
              </>
            ) : (
              <>
                <p className="text-sm leading-relaxed text-muted-foreground">Sign in with Sarv in your browser. An existing Sarv session can reuse your sign-in; scanner access is approved separately from email and AI.</p>
                <p className="text-sm leading-relaxed text-muted-foreground">Connecting installs the optional attachment-scanning extension. After you review the scanner’s privacy terms, Inbox creates a scanning credential valid for 90 days and saves it securely on this device. Reconnect when it expires.</p>
                <button type="button" disabled={Boolean(busy) || !accountId || !api?.connectSarvOAuth} onClick={() => { void connect(); }} className="flex items-center justify-center gap-2 rounded-lg bg-primary px-5 py-3 text-sm font-medium text-primary-foreground disabled:opacity-50">{busy === 'connecting' ? <><Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />Waiting for browser sign-in…</> : error ? 'Retry Sarv sign-in' : 'Connect with Sarv'}</button>
                {busy === 'connecting' && <button type="button" onClick={() => { generation.current += 1; void api.cancelSarvOAuth().catch(() => {}); setBusy(null); setError('Antivirus sign-in was cancelled. You can retry or skip for now.'); }} className="text-sm text-primary underline underline-offset-2">Cancel sign-in</button>}
                {!accountId && <p className="text-sm text-muted-foreground">Connect an email account before enabling scanner sharing.</p>}
              </>
            )}
          </section>
          {warning}
        </>
      )}
      {busy === 'loading' && <p role="status" className="text-sm text-muted-foreground">Checking existing scanner setup…</p>}
      {error && <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">{error}</p>}
      <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-5">
        <button type="button" disabled={busy === 'saving'} onClick={() => { void leave(true); }} className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground disabled:opacity-50"><ArrowLeft aria-hidden="true" className="h-4 w-4" />Back</button>
        <button type="button" disabled={busy === 'saving'} onClick={() => { void leave(); }} className={protectedAccount ? 'rounded-lg bg-primary px-5 py-3 text-sm font-medium text-primary-foreground' : 'text-sm text-primary hover:underline disabled:opacity-50'}>{protectedAccount ? 'Continue' : 'Skip for now'}</button>
      </footer>
    </div>
  );
}
