import type { IMAPConfig, SMTPConfig } from '@sarvinbox/core';
import { CheckCircle2, Eye, EyeOff, Loader2 } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';

import { EMAIL_PROVIDERS, defaultPort, type ConnectionSecurity } from '../../config/email-providers';
import { getOnboardingEmailProgress, isOnboardingPending } from '../../services/onboarding-progress';
import { useEmailStore } from '../../store/email-store';
import { findAccountByEmailHost } from '../../store/helpers';
import { GmailPrivacyNotice } from '../GmailPrivacyNotice';
import { Tooltip } from '../Tooltip';

import { ProviderIcon } from './ProviderIcon';

export interface EmailSetupResult {
  accountId: string;
  email: string;
  providerId: string;
  authMethod: 'oauth2' | 'password';
  sendingConnected: boolean;
  sarvConnected: boolean;
}

interface EmailSetupStepProps {
  stage: 'provider' | 'connection';
  active: boolean;
  onStageChange: (stage: 'provider' | 'connection') => void;
  onConnected: (result: EmailSetupResult) => void;
}

type EmailOAuthProvider = 'sarv' | 'gmail';
type OAuthProviderInfo = NonNullable<Awaited<ReturnType<typeof window.electronAPI.oauth.listProviders>>['data']>[number];
type OAuthAccount = NonNullable<Awaited<ReturnType<typeof window.electronAPI.oauth.listAccounts>>['data']>[number];
// The native OAuth bridge supports Sarv mail; the legacy core IMAP type has not
// yet caught up with that provider. Keep the widening at this UI boundary.
type MailConfig = Omit<IMAPConfig, 'oauthProvider'> & { oauthProvider?: EmailOAuthProvider };
interface FormValues {
  email: string;
  password: string;
  imapHost: string;
  imapPort: string;
  imapSecurity: ConnectionSecurity;
  smtpHost: string;
  smtpPort: string;
  smtpSecurity: 'ssl' | 'starttls';
  allowInsecure: boolean;
  skipSending: boolean;
}
interface ConnectedEmail {
  result: EmailSetupResult;
  smtp: SMTPConfig;
  receivingConnected: boolean;
}

function activeConnection(): ConnectedEmail | null {
  const state = useEmailStore.getState();
  const pending = isOnboardingPending();
  const account = state.accounts.find((item) => item.id === state.activeAccountId) ?? (pending ? state.accounts[0] : undefined);
  if ((!state.connected && !pending) || !account?.imapConfig?.host) return null;
  const preset = EMAIL_PROVIDERS.find((item) => item.imapHost.toLowerCase() === String(account.imapConfig.host).toLowerCase());
  const providerId = preset?.id ?? 'other';
  const authMethod = account.imapConfig.authMethod === 'oauth2' ? 'oauth2' : 'password';
  return {
    result: {
      accountId: account.id, email: account.email, providerId, authMethod,
      sendingConnected: pending ? getOnboardingEmailProgress(account.id)?.sendingConnected === true : account.smtpConfigured && state.smtpConnected,
      sarvConnected: providerId === 'sarv' && authMethod === 'oauth2',
    },
    receivingConnected: state.connected && state.activeAccountId === account.id,
    smtp: account.smtpConfig ?? {
      host: preset?.smtpHost ?? '', port: preset?.smtpPort ?? 465, secure: preset?.smtpSecurity !== 'starttls',
      username: account.email, from: account.email, password: '', authMethod,
      ...(authMethod === 'oauth2' && (providerId === 'sarv' || providerId === 'gmail') ? { oauthProvider: providerId } : {}),
    },
  };
}

function savedForm(connection: ConnectedEmail): FormValues {
  const initial = initialForm(connection.result.providerId);
  const imap = useEmailStore.getState().accounts.find((item) => item.id === connection.result.accountId)?.imapConfig;
  return {
    ...initial, email: connection.result.email, imapHost: imap?.host ?? initial.imapHost,
    imapPort: String(imap?.port ?? initial.imapPort),
    imapSecurity: imap?.security ?? (imap?.secure === false ? 'starttls' : initial.imapSecurity),
    smtpHost: connection.smtp.host, smtpPort: String(connection.smtp.port),
    smtpSecurity: connection.smtp.secure === false ? 'starttls' : 'ssl',
    allowInsecure: Boolean(imap?.allowInsecureTLS),
  };
}

const EMAIL_CHOICES = ['sarv', 'gmail', 'outlook', 'yahoo', 'other'];
const inputClass = 'w-full rounded-lg border border-input bg-background px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-60';
const primaryClass = 'inline-flex items-center justify-center gap-2 rounded-lg bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50';
const textButtonClass = 'rounded-md px-2 py-2 text-sm text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50';

function initialForm(providerId: string): FormValues {
  const preset = EMAIL_PROVIDERS.find((item) => item.id === providerId);
  return {
    email: '', password: '', imapHost: preset?.imapHost ?? '',
    imapPort: String(preset?.imapPort ?? 993), imapSecurity: preset?.imapSecurity ?? 'ssl',
    smtpHost: preset?.smtpHost ?? '', smtpPort: String(preset?.smtpPort ?? 465),
    smtpSecurity: preset?.smtpSecurity === 'starttls' ? 'starttls' : 'ssl',
    allowInsecure: false, skipSending: false,
  };
}

function validPort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Server ports must be between 1 and 65535.');
  return port;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Could not connect. Check your settings and try again.';
}

/** Email provider selection, credential verification and independent sending check. */
export function EmailSetupStep({ stage, active, onStageChange, onConnected }: EmailSetupStepProps) {
  const [initialConnection] = useState(activeConnection);
  const [providerId, setProviderId] = useState(initialConnection?.result.providerId ?? '');
  const [method, setMethod] = useState<'oauth2' | 'password'>(initialConnection?.result.authMethod ?? 'oauth2');
  const [form, setForm] = useState<FormValues>(() => {
    return initialConnection ? savedForm(initialConnection) : initialForm('sarv');
  });
  const [showPassword, setShowPassword] = useState(false);
  const [providers, setProviders] = useState<OAuthProviderInfo[]>([]);
  const [sessions, setSessions] = useState<OAuthAccount[]>([]);
  const [loadingProviders, setLoadingProviders] = useState(true);
  const [busy, setBusy] = useState<'oauth' | 'receiving' | 'sending' | null>(null);
  const [error, setError] = useState('');
  const [connected, setConnected] = useState<ConnectedEmail | null>(initialConnection);
  const [editing, setEditing] = useState(false);
  const drafts = useRef(new Map<string, { form: FormValues; method: 'oauth2' | 'password' }>());
  const connections = useRef(new Map<string, ConnectedEmail>(initialConnection ? [[initialConnection.result.providerId, initialConnection]] : []));
  const operation = useRef(0);
  const mounted = useRef(false);
  const activeRef = useRef(active);
  const busyRef = useRef<typeof busy>(null);

  useEffect(() => {
    mounted.current = true;
    let current = true;
    void Promise.allSettled([
      window.electronAPI.oauth.listProviders(),
      window.electronAPI.oauth.listAccounts(),
    ]).then(([providerList, accountList]) => {
      if (!current) return;
      if (providerList.status === 'fulfilled' && providerList.value.success) setProviders(providerList.value.data ?? []);
      if (accountList.status === 'fulfilled' && accountList.value.success) setSessions(accountList.value.data ?? []);
      setLoadingProviders(false);
    });
    return () => {
      current = false;
      mounted.current = false;
      // Invalidate the latest request; this ref is an async sequence, not a DOM node.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      operation.current++;
      if (busyRef.current === 'oauth') void window.electronAPI.oauth.cancel().catch(() => {});
    };
  }, []);

  useEffect(() => {
    activeRef.current = active;
    if (!active) {
      operation.current++;
      if (busyRef.current === 'oauth') void window.electronAPI.oauth.cancel().catch(() => {});
      busyRef.current = null;
      setBusy(null);
    }
  }, [active]);

  const isCurrent = (id: number) => mounted.current && activeRef.current && operation.current === id;
  const setLoading = (value: typeof busy) => { busyRef.current = value; setBusy(value); };
  const providerName = EMAIL_PROVIDERS.find((item) => item.id === providerId)?.name ?? 'Other email';
  const supportsOAuth = providerId === 'sarv' || providerId === 'gmail';
  const oauthInfo = providers.find((item) => item.id === providerId);
  const existingSession = sessions.find((item) => item.provider === providerId && item.email === connected?.result.email)
    ?? sessions.find((item) => item.provider === providerId);
  const showingSummary = connected !== null && !editing;

  const selectProvider = (id: string) => {
    if (busyRef.current) return;
    if (providerId) drafts.current.set(providerId, { form, method });
    const draft = drafts.current.get(id);
    setProviderId(id);
    setForm(draft?.form ?? initialForm(id));
    setMethod(draft?.method ?? (id === 'sarv' || id === 'gmail' ? 'oauth2' : 'password'));
    setConnected(connections.current.get(id) ?? null);
    setEditing(false);
    setShowPassword(false);
    setError('');
    onStageChange('connection');
  };

  const changeField = <K extends keyof FormValues>(key: K, value: FormValues[K]) => {
    setForm((old) => ({ ...old, [key]: value }));
    setError('');
  };

  const back = () => {
    // An OAuth popup can be cancelled. A committed native account operation
    // cannot be undone safely, so its Back control stays disabled until done.
    if (busyRef.current && busyRef.current !== 'oauth') return;
    operation.current++;
    if (busyRef.current === 'oauth') void window.electronAPI.oauth.cancel().catch(() => {});
    setLoading(null);
    setError('');
    setEditing(false);
    onStageChange('provider');
  };

  const complete = (connection: ConnectedEmail) => {
    connections.current.set(providerId, connection);
    setConnected(connection);
    setEditing(false);
    onConnected(connection.result);
  };

  const verifySending = async (connection: ConnectedEmail, id: number) => {
    if (!isCurrent(id)) return;
    if (useEmailStore.getState().activeAccountId !== connection.result.accountId) {
      await useEmailStore.getState().selectAccount(connection.result.accountId);
      if (!isCurrent(id)) return;
    }
    setLoading('sending');
    try {
      await useEmailStore.getState().connectSmtp(connection.smtp);
      if (!isCurrent(id)) return;
      if (useEmailStore.getState().activeAccountId !== connection.result.accountId) throw new Error('The active email account changed. Retry the sending check.');
      useEmailStore.getState().markSmtpConfigured(true);
      complete({ ...connection, smtp: { ...connection.smtp, password: '' }, result: { ...connection.result, sendingConnected: true } });
    } catch (failure) {
      if (!isCurrent(id)) return;
      // Keep receiving and its background sync. Sending can be retried without
      // another mailbox creation, or explicitly deferred by the user.
      setConnected(connection);
      connections.current.set(providerId, connection);
      setEditing(false);
      setError(`Receiving works. Sending needs attention: ${errorMessage(failure)}`);
    }
  };

  const connectMailbox = async (config: MailConfig, smtp: SMTPConfig, id: number, skipSending: boolean) => {
    if (!isCurrent(id)) return;
    setLoading('receiving');
    // addAccount verifies receiving before persistence, reuses email+host
    // identity, and starts the initial sync without awaiting its completion.
    await useEmailStore.getState().addAccount(config);
    if (!isCurrent(id)) return;
    const account = findAccountByEmailHost(useEmailStore.getState().accounts, config.username, config.host);
    if (!account) throw new Error('The mailbox connected but its account was not saved. Please retry.');
    setForm((old) => ({ ...old, password: '' }));
    const connection: ConnectedEmail = {
      result: {
        accountId: account.id, email: account.email, providerId,
        authMethod: config.authMethod === 'oauth2' ? 'oauth2' : 'password',
        sendingConnected: false, sarvConnected: providerId === 'sarv' && config.authMethod === 'oauth2',
      },
      smtp,
      receivingConnected: true,
    };
    connections.current.set(providerId, connection);
    setConnected(connection);
    setEditing(false);
    if (skipSending) complete({ ...connection, smtp: { ...smtp, password: '' } });
    else await verifySending(connection, id);
  };

  const startOAuth = async (reuseSession: boolean) => {
    if (busyRef.current || !supportsOAuth) return;
    const id = ++operation.current;
    setError('');
    setLoading('oauth');
    try {
      const oauthProvider = providerId as EmailOAuthProvider;
      const preset = EMAIL_PROVIDERS.find((item) => item.id === providerId)!;
      let email = existingSession?.email ?? '';
      let imap = { host: preset.imapHost, port: preset.imapPort, secure: preset.imapSecurity === 'ssl' };
      let smtp = { host: preset.smtpHost, port: preset.smtpPort, secure: preset.smtpSecurity === 'ssl' };
      if (!reuseSession || !existingSession) {
        const response = await window.electronAPI.oauth.startFlow(oauthProvider);
        if (!isCurrent(id)) return;
        if (!response.success || !response.data) throw new Error(response.error || 'Sign-in was cancelled or could not be completed.');
        if (!response.data.imap) throw new Error('Sign-in succeeded, but this account does not provide an email connection. Try manual setup.');
        email = response.data.email;
        imap = response.data.imap;
        smtp = response.data.smtp ?? smtp;
        setSessions((old) => [...old.filter((item) => item.provider !== oauthProvider || item.email !== email), {
          provider: oauthProvider, email, displayName: response.data?.displayName,
          scopes: response.data?.scopes ?? [], createdAt: Date.now(), updatedAt: Date.now(),
        }]);
      }
      setForm((old) => ({ ...old, email }));
      await connectMailbox(
        { ...imap, username: email, password: '', authMethod: 'oauth2', oauthProvider },
        { ...smtp, username: email, password: '', from: email, authMethod: 'oauth2', oauthProvider }, id, false,
      );
    } catch (failure) {
      if (isCurrent(id)) setError(errorMessage(failure));
    } finally {
      if (isCurrent(id)) setLoading(null);
    }
  };

  const connectManual = async (event: FormEvent) => {
    event.preventDefault();
    if (busyRef.current) return;
    const id = ++operation.current;
    setError('');
    setLoading('receiving');
    try {
      const email = form.email.trim();
      if (!email || !form.password || !form.imapHost.trim()) throw new Error('Enter your email, password and incoming server.');
      const smtp: SMTPConfig = {
        host: form.smtpHost.trim(), port: form.skipSending ? Number(form.smtpPort) || 465 : validPort(form.smtpPort),
        secure: form.smtpSecurity === 'ssl', username: email, from: email,
        // Password whitespace can be meaningful. Never silently rewrite it.
        password: form.password, authMethod: 'password', allowInsecureTLS: form.allowInsecure || undefined,
      };
      if (!form.skipSending && !smtp.host) throw new Error('Enter the sending server or choose to set up sending later.');
      await connectMailbox({
        host: form.imapHost.trim(), port: validPort(form.imapPort), security: form.imapSecurity,
        secure: form.imapSecurity === 'ssl', username: email, password: form.password,
        authMethod: 'password', allowInsecureTLS: form.allowInsecure || undefined,
      }, smtp, id, form.skipSending);
    } catch (failure) {
      if (isCurrent(id)) setError(errorMessage(failure));
    } finally {
      if (isCurrent(id)) setLoading(null);
    }
  };

  const retrySending = async () => {
    if (!connected || busyRef.current) return;
    const id = ++operation.current;
    setError('');
    setLoading('sending');
    try { await verifySending(connected, id); }
    catch (failure) { if (isCurrent(id)) setError(errorMessage(failure)); }
    finally { if (isCurrent(id)) setLoading(null); }
  };

  const continueConnected = async () => {
    if (!connected || busyRef.current) return;
    const id = ++operation.current;
    setError('');
    setLoading('receiving');
    try {
      if (useEmailStore.getState().activeAccountId !== connected.result.accountId) {
        await useEmailStore.getState().selectAccount(connected.result.accountId);
      }
      if (isCurrent(id)) complete({ ...connected, smtp: { ...connected.smtp, password: '' } });
    } catch (failure) { if (isCurrent(id)) setError(errorMessage(failure)); }
    finally { if (isCurrent(id)) setLoading(null); }
  };

  const retryReceiving = async () => {
    if (!connected || busyRef.current) return;
    const id = ++operation.current;
    setError(''); setLoading('receiving');
    try {
      const account = useEmailStore.getState().accounts.find((item) => item.id === connected.result.accountId);
      if (!account) throw new Error('This saved account is unavailable. Choose your provider and connect again.');
      if (useEmailStore.getState().activeAccountId !== account.id) await useEmailStore.getState().selectAccount(account.id);
      if (!isCurrent(id)) return;
      // Reconnect uses the saved native vault credentials and starts background
      // sync. It does not add, delete or replace the existing account.
      await useEmailStore.getState().connect(account.imapConfig);
      if (!isCurrent(id)) return;
      const updated = { ...connected, receivingConnected: true };
      setConnected(updated); connections.current.set(providerId, updated);
    } catch (failure) { if (isCurrent(id)) setError(`Receiving is currently unavailable: ${errorMessage(failure)}`); }
    finally { if (isCurrent(id)) setLoading(null); }
  };

  if (!active) return null;
  if (stage === 'provider') return (
    <div className="space-y-6">
      <div><h2 className="text-2xl font-semibold">Where is your email?</h2><p className="mt-2 text-sm text-muted-foreground">Choose your provider to connect your first account.</p></div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {EMAIL_CHOICES.map((id) => (
          <button key={id} type="button" onClick={() => selectProvider(id)} className="flex items-center gap-3 rounded-xl border border-border p-4 text-left hover:border-primary hover:bg-primary/5">
            <ProviderIcon id={id} className="h-9 w-9 shrink-0" />
            <span><strong className="block text-sm font-medium">{EMAIL_PROVIDERS.find((item) => item.id === id)?.name ?? 'Other email'}</strong><span className="text-xs text-muted-foreground">{id === 'sarv' ? 'One sign-in for email and AI' : id === 'gmail' ? 'Browser sign-in or manual setup' : 'Manual IMAP & SMTP setup'}</span></span>
          </button>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">Your mail is stored in an encrypted database on this device. You can add more accounts later.</p>
    </div>
  );

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3"><ProviderIcon id={providerId || 'sarv'} className="h-10 w-10" /><div><h2 className="text-2xl font-semibold">Connect {providerName}</h2><p className="mt-1 text-sm text-muted-foreground">We check receiving and sending separately.</p></div></div>
      {error && <p role="alert" className="rounded-lg border border-destructive/20 bg-destructive/5 p-3 text-sm text-destructive">{error}</p>}
      {showingSummary ? (
        <div className="space-y-4">
          <div className="rounded-xl border border-border p-4"><p className="break-all font-medium">{connected.result.email}</p><p className="mt-1 text-xs text-muted-foreground">{providerName} · {connected.result.authMethod === 'oauth2' ? 'Browser sign-in' : 'Manual connection'}</p><div className="mt-3 flex flex-wrap gap-3 text-sm"><span className={`flex items-center gap-1 ${connected.receivingConnected ? 'text-green-700 dark:text-green-400' : 'text-muted-foreground'}`}><CheckCircle2 className="h-4 w-4" />{connected.receivingConnected ? 'Receiving connected' : 'Receiving connection saved · currently offline'}</span><span>{connected.result.sendingConnected ? 'Sending connected' : 'Sending pending'}</span></div><p className="mt-3 text-xs text-muted-foreground">{connected.receivingConnected ? 'Your first sync continues in the background.' : 'Your account is preserved. Sync resumes when the connection is available.'}</p></div>
          {!connected.receivingConnected && <button type="button" onClick={() => void retryReceiving()} disabled={busy !== null} className={primaryClass}>{busy === 'receiving' ? <><Loader2 className="h-4 w-4 animate-spin" />Reconnecting…</> : 'Retry receiving connection'}</button>}
          {!connected.result.sendingConnected && <button type="button" onClick={() => void retrySending()} disabled={busy !== null} className={primaryClass}>{busy === 'sending' ? <><Loader2 className="h-4 w-4 animate-spin" />Checking sending…</> : 'Retry sending check'}</button>}
          <button type="button" disabled={busy !== null} onClick={() => { setEditing(true); setError(''); }} className={textButtonClass}>Change connection</button>
          <div className="flex items-center justify-between"><button type="button" onClick={back} disabled={busy !== null} className={textButtonClass}>Back</button><button type="button" disabled={busy !== null} onClick={() => void continueConnected()} className={primaryClass}>{busy === 'receiving' ? 'Switching account…' : connected.result.sendingConnected ? 'Continue' : 'Continue with receiving only'}</button></div>
        </div>
      ) : (
        <>
          {supportsOAuth && <div className="flex gap-2 rounded-lg bg-muted/60 p-1"><button type="button" disabled={busy !== null} onClick={() => { setMethod('oauth2'); setError(''); }} className={`flex-1 rounded-md px-3 py-2 text-sm ${method === 'oauth2' ? 'bg-background shadow-sm' : 'text-muted-foreground'}`}>Browser sign-in</button><button type="button" disabled={busy !== null} onClick={() => { setMethod('password'); setError(''); }} className={`flex-1 rounded-md px-3 py-2 text-sm ${method === 'password' ? 'bg-background shadow-sm' : 'text-muted-foreground'}`}>Manual setup</button></div>}
          {method === 'oauth2' && supportsOAuth ? (
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">{providerId === 'sarv' ? 'Sarv connects your mailbox and AI access in one sign-in. You choose a model and approve AI processing in the next step.' : 'Sign in securely in your browser. You do not need to enter your Gmail password here.'}</p>
              {existingSession && <p className="text-sm">Already signed in as <strong className="break-all">{existingSession.email}</strong>.</p>}
              <button type="button" disabled={busy !== null || loadingProviders || !oauthInfo?.configured} onClick={() => void startOAuth(Boolean(existingSession))} className={`${primaryClass} w-full`}>{busy ? <><Loader2 className="h-4 w-4 animate-spin" /> {busy === 'oauth' ? 'Waiting for browser…' : busy === 'receiving' ? 'Checking receiving…' : 'Checking sending…'}</> : existingSession ? `Connect as ${existingSession.email}` : `Sign in with ${providerName}`}</button>
              {!loadingProviders && !oauthInfo?.configured && <p className="text-sm text-muted-foreground">Browser sign-in is unavailable in this build. Use Manual setup to connect.</p>}
              {existingSession && <button type="button" disabled={busy !== null || !oauthInfo?.configured} onClick={() => void startOAuth(false)} className={textButtonClass}>Use a different {providerName} account</button>}
              {providerId === 'gmail' && <GmailPrivacyNotice />}
              <button type="button" onClick={back} disabled={busy !== null && busy !== 'oauth'} className={textButtonClass}>{busy === 'oauth' ? 'Cancel & Back' : 'Back'}</button>
            </div>
          ) : (
            <form onSubmit={(event) => void connectManual(event)} className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2"><label className="space-y-1.5 text-sm font-medium">Email address<input aria-label="Email address" type="email" autoComplete="username" value={form.email} onChange={(event) => changeField('email', event.target.value)} required disabled={busy !== null} className={inputClass} /><span className="block text-xs font-normal text-muted-foreground">Also used as your login and sending address.</span></label><label className="space-y-1.5 text-sm font-medium">Password or app password<div className="relative"><input aria-label="Password or app password" type={showPassword ? 'text' : 'password'} autoComplete="current-password" value={form.password} onChange={(event) => changeField('password', event.target.value)} required disabled={busy !== null} className={`${inputClass} pr-10`} /><Tooltip content={showPassword ? 'Hide password' : 'Show password'} delayMs={40} className="absolute inset-y-0 right-0 flex items-center"><button type="button" aria-label={showPassword ? 'Hide password' : 'Show password'} disabled={busy !== null} onClick={() => setShowPassword((value) => !value)} className="p-3 text-muted-foreground">{showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}</button></Tooltip></div><span className="block text-xs font-normal text-muted-foreground">Use an app password if your provider requires one.</span></label></div>
              <details open={providerId === 'other' || undefined} className="rounded-lg border border-border p-3"><summary className="cursor-pointer text-sm font-medium">Incoming & sending server settings{providerId !== 'other' ? ' · prefilled' : ''}</summary><div className="mt-4 space-y-4">
                <div className="grid gap-3 sm:grid-cols-[1fr_90px_130px]"><label className="space-y-1 text-sm">IMAP server<input aria-label="IMAP server" value={form.imapHost} onChange={(event) => changeField('imapHost', event.target.value)} required disabled={busy !== null} className={inputClass} /></label><label className="space-y-1 text-sm">Port<input aria-label="IMAP port" type="number" min="1" max="65535" value={form.imapPort} onChange={(event) => changeField('imapPort', event.target.value)} required disabled={busy !== null} className={inputClass} /></label><label className="space-y-1 text-sm">Security<select aria-label="IMAP security" value={form.imapSecurity} disabled={busy !== null} onChange={(event) => { const value = event.target.value as ConnectionSecurity; setForm((old) => ({ ...old, imapSecurity: value, imapPort: String(defaultPort('imap', value)) })); }} className={inputClass}><option value="ssl">SSL / TLS</option><option value="starttls">STARTTLS</option><option value="none">None</option></select></label></div>
                <div className="grid gap-3 sm:grid-cols-[1fr_90px_130px]"><label className="space-y-1 text-sm">SMTP server<input aria-label="SMTP server" value={form.smtpHost} onChange={(event) => changeField('smtpHost', event.target.value)} required={!form.skipSending} disabled={busy !== null || form.skipSending} className={inputClass} /></label><label className="space-y-1 text-sm">Port<input aria-label="SMTP port" type="number" min="1" max="65535" value={form.smtpPort} onChange={(event) => changeField('smtpPort', event.target.value)} required={!form.skipSending} disabled={busy !== null || form.skipSending} className={inputClass} /></label><label className="space-y-1 text-sm">Security<select aria-label="SMTP security" value={form.smtpSecurity} disabled={busy !== null || form.skipSending} onChange={(event) => { const value = event.target.value as 'ssl' | 'starttls'; setForm((old) => ({ ...old, smtpSecurity: value, smtpPort: String(defaultPort('smtp', value)) })); }} className={inputClass}><option value="ssl">SSL / TLS</option><option value="starttls">STARTTLS</option></select></label></div>
                <p className="text-xs text-muted-foreground">Sending uses the same email and password. Separate sending credentials can be added in Settings.</p>
                <label className="flex gap-2 text-xs text-muted-foreground"><input type="checkbox" checked={form.allowInsecure} disabled={busy !== null} onChange={(event) => changeField('allowInsecure', event.target.checked)} />Allow self-signed or invalid certificates, only if you trust this server.</label>
              </div></details>
              <label className="flex gap-2 text-sm"><input type="checkbox" aria-label="Set up sending later" checked={form.skipSending} disabled={busy !== null} onChange={(event) => changeField('skipSending', event.target.checked)} />Set up sending later. I only need to receive email for now.</label>
              <div className="flex items-center justify-between gap-3"><button type="button" onClick={back} disabled={busy !== null} className={textButtonClass}>Back</button><button type="submit" disabled={busy !== null || !form.email || !form.password} className={primaryClass}>{busy ? <><Loader2 className="h-4 w-4 animate-spin" /> {busy === 'sending' ? 'Checking sending…' : 'Checking receiving…'}</> : 'Test & connect email'}</button></div>
            </form>
          )}
        </>
      )}
    </div>
  );
}
