import { ArrowRight, Check, CheckCircle2, Loader2, Mail, ShieldCheck, Sparkles } from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';

import { EMAIL_PROVIDERS } from '../../config/email-providers';
import { applyOnboardingAIChoice, suspendOnboardingAI } from '../../services/onboarding-ai-choice';
import { beginOnboarding, completeOnboarding, getOnboardingEmailProgress, isOnboardingPending, saveOnboardingEmailProgress } from '../../services/onboarding-progress';
import { useEmailStore } from '../../store/email-store';

import { AISetupStep } from './AISetupStep';
import { AntivirusSetupStep } from './AntivirusSetupStep';
import { EmailSetupStep, type EmailSetupResult } from './EmailSetupStep';

type Phase = 'email-provider' | 'email-connect' | 'ai-provider' | 'ai-connect' | 'model' | 'antivirus-provider' | 'antivirus-connect' | 'ready';
type AIResult = { enabled: boolean; providerName?: string; modelName?: string; keyStorageEncrypted?: boolean };
type AVResult = { enabled: boolean; providerName?: string };

function resumedEmail(): EmailSetupResult | null {
  if (!isOnboardingPending()) return null;
  const { accounts, activeAccountId } = useEmailStore.getState();
  const account = accounts.find((item) => item.id === activeAccountId) ?? accounts[0];
  if (!account) return null;
  const config = account.imapConfig;
  const provider = EMAIL_PROVIDERS.find((item) => item.imapHost === config?.host);
  const authMethod = config?.authMethod === 'oauth2' ? 'oauth2' : 'password';
  return {
    accountId: account.id, email: account.email, providerId: provider?.id ?? 'other',
    authMethod, sendingConnected: getOnboardingEmailProgress(account.id)?.sendingConnected === true,
    sarvConnected: authMethod === 'oauth2' && config?.oauthProvider === 'sarv',
  };
}

export function Onboarding({ onComplete }: { onComplete: () => void }) {
  const [email, setEmail] = useState(resumedEmail);
  const [phase, setPhase] = useState<Phase>(() => !email ? 'email-provider'
    : !getOnboardingEmailProgress(email.accountId) ? 'email-connect'
      : email.sarvConnected ? 'model' : 'ai-provider');
  const [ai, setAI] = useState<AIResult | null>(null);
  const [av, setAV] = useState<AVResult | null>(null);
  const [finishing, setFinishing] = useState(false);
  const [error, setError] = useState('');
  const card = useRef<HTMLDivElement>(null);
  const finishingRef = useRef(false);
  const emailActive = phase.startsWith('email-');
  const aiActive = phase.startsWith('ai-') || phase === 'model';
  const avActive = phase.startsWith('antivirus-');
  const combined = email?.sarvConnected === true;
  const labels = combined ? ['Email', 'Model', 'Antivirus', 'Ready'] : ['Email', 'Connect', 'AI', 'Model', 'Antivirus', 'Ready'];
  const index = phase === 'ready' ? labels.length - 1
    : avActive ? labels.length - 2
      : phase === 'model' ? labels.indexOf('Model')
        : aiActive ? (combined ? 1 : labels.indexOf('AI'))
          : phase === 'email-connect' && !combined ? 1 : 0;

  useEffect(() => {
    try { beginOnboarding(); } catch { setError('Setup progress could not be saved. Free some device storage and try again.'); }
    suspendOnboardingAI();
  }, []);

  useEffect(() => {
    const heading = card.current?.querySelector<HTMLElement>('[data-active-step] h1, [data-active-step] h2');
    if (heading) {
      heading.tabIndex = -1;
      heading.focus({ preventScroll: true });
    }
    card.current?.scrollTo?.({ top: 0 });
  }, [phase]);

  const containKeyboard = (event: KeyboardEvent<HTMLDivElement>) => {
    // Email shortcuts must never reach the mailbox behind this modal.
    event.stopPropagation();
    if (event.key !== 'Tab' || !card.current) return;
    const controls = [...card.current.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [tabindex="0"]')]
      .filter((item) => {
        if (item.closest('[hidden]')) return false;
        let ancestor = item.parentElement;
        while (ancestor && ancestor !== card.current) {
          if (ancestor.tagName === 'DETAILS' && !ancestor.hasAttribute('open') &&
            !ancestor.querySelector(':scope > summary')?.contains(item)) return false;
          ancestor = ancestor.parentElement;
        }
        return true;
      });
    if (!controls.length) { event.preventDefault(); return; }
    const first = controls[0];
    const last = controls[controls.length - 1];
    if (event.shiftKey && (!controls.includes(document.activeElement as HTMLElement) || document.activeElement === first)) {
      event.preventDefault(); last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault(); first.focus();
    }
  };

  const finish = async () => {
    if (finishingRef.current || !email || !ai || !av) return;
    finishingRef.current = true;
    setFinishing(true);
    setError('');
    try {
      await applyOnboardingAIChoice(ai.enabled);
      completeOnboarding();
      onComplete();
    } catch {
      suspendOnboardingAI();
      setError('Setup could not be saved. Try opening your inbox again. Your connections are preserved.');
      finishingRef.current = false;
      setFinishing(false);
    }
  };

  return (
    <div role="dialog" aria-modal="true" aria-label="Set up Inbox" className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-background px-4 py-4 sm:py-6" onKeyDown={containKeyboard}>
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-br from-primary/5 via-background to-primary/10" />
      <div className="relative my-auto w-full max-w-2xl">
        <div className="mb-6 flex items-center justify-center gap-3">
          <img src="/icon.png" alt="" aria-hidden="true" className="h-10 w-10 rounded-xl" />
          <span className="text-xl font-semibold tracking-tight">Inbox</span>
        </div>
        <ol aria-label="Setup progress" className="mb-6 flex justify-center gap-2 sm:gap-4">
          {labels.map((label, step) => (
            <li key={label} aria-current={step === index ? 'step' : undefined} className="flex min-w-0 flex-col items-center gap-1.5 text-center">
              <span className={`flex h-7 w-7 items-center justify-center rounded-full text-xs font-semibold ${step <= index ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'}`}>
                {step < index ? <Check aria-hidden="true" className="h-3.5 w-3.5" /> : step + 1}
              </span>
              <span className={`text-[10px] sm:text-xs ${step === index ? 'font-medium text-foreground' : 'text-muted-foreground'}`}>{label}</span>
            </li>
          ))}
        </ol>
        <div ref={card} className="max-h-[calc(100dvh-200px)] overflow-y-auto rounded-2xl border border-border bg-card p-5 shadow-xl sm:p-8 [&_h1:focus]:outline-none [&_h2:focus]:outline-none">
          {error && <p role="alert" className="mb-4 text-sm text-destructive">{error}</p>}
          <div hidden={!emailActive} data-active-step={emailActive ? '' : undefined}>
            <EmailSetupStep stage={phase === 'email-connect' ? 'connection' : 'provider'} active={emailActive}
              onStageChange={(stage) => setPhase(stage === 'connection' ? 'email-connect' : 'email-provider')}
              onConnected={(result) => {
                try { saveOnboardingEmailProgress(result.accountId, result.sendingConnected); }
                catch { setError('Setup progress could not be saved. Your email connection is kept.'); }
                setEmail(result); setAI(null); setAV(null);
                setPhase(result.sarvConnected ? 'model' : 'ai-provider');
              }} />
          </div>
          <div hidden={!aiActive} data-active-step={aiActive ? '' : undefined}>
            <AISetupStep stage={phase === 'model' ? 'model' : phase === 'ai-connect' ? 'connection' : 'provider'} active={aiActive}
              preferSarv={combined} preferSarvEmail={email?.email}
              onStageChange={(stage) => setPhase(stage === 'model' ? 'model' : stage === 'connection' ? 'ai-connect' : 'ai-provider')}
              onBackToEmail={() => setPhase('email-connect')}
              onComplete={(result) => { setAI(result); setPhase('antivirus-provider'); }} />
          </div>
          <div hidden={!avActive} data-active-step={avActive ? '' : undefined}>
            <AntivirusSetupStep stage={phase === 'antivirus-connect' ? 'connection' : 'provider'} active={avActive} accountId={email?.accountId ?? null}
              onStageChange={(stage) => setPhase(stage === 'connection' ? 'antivirus-connect' : 'antivirus-provider')}
              onBack={() => setPhase(ai?.enabled ? 'model' : 'ai-provider')}
              onComplete={(result) => { setAV(result); setPhase('ready'); }} />
          </div>
          <div hidden={phase !== 'ready'} data-active-step={phase === 'ready' ? '' : undefined}>
            <CheckCircle2 aria-hidden="true" className="mb-4 h-10 w-10 text-primary" />
            <h1 className="text-2xl font-semibold tracking-tight">Your inbox is ready</h1>
            <p className="mt-2 text-sm text-muted-foreground">Your account is saved. Mail syncs in the background when connected. You can change these connections in Settings.</p>
            <dl className="my-6 divide-y divide-border rounded-xl border border-border px-4">
              <div className="flex items-start gap-3 py-4">
                <Mail aria-hidden="true" className="mt-1 h-5 w-5 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1"><dt className="text-sm font-medium">Email</dt><dd className="break-all text-sm text-muted-foreground">{email?.email}</dd><dd className="text-xs text-muted-foreground">{email?.sendingConnected ? 'Receiving and sending connected' : 'Receiving connected · set up sending in Settings'}</dd></div>
                <button disabled={finishing} onClick={() => setPhase('email-connect')} className="text-xs font-medium text-primary">Edit email</button>
              </div>
              <div className="flex items-start gap-3 py-4">
                <Sparkles aria-hidden="true" className="mt-1 h-5 w-5 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1"><dt className="text-sm font-medium">AI</dt><dd className="break-words text-sm text-muted-foreground">{ai?.enabled ? `${ai.providerName} · ${ai.modelName}` : 'Skipped · automatic AI is off'}</dd>{ai?.enabled && ai.keyStorageEncrypted === false && <dd className="mt-1 text-xs text-amber-700 dark:text-amber-400">Device keyring unavailable; your API key is stored without encryption.</dd>}</div>
                <button disabled={finishing} onClick={() => setPhase(ai?.enabled ? 'model' : 'ai-provider')} className="text-xs font-medium text-primary">Edit AI</button>
              </div>
              <div className="flex items-start gap-3 py-4">
                <ShieldCheck aria-hidden="true" className="mt-1 h-5 w-5 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1"><dt className="text-sm font-medium">Antivirus</dt><dd className="text-sm text-muted-foreground">{av?.enabled ? `${av.providerName} · scan before viewing or downloading` : 'Skipped · unscanned attachments show a warning'}</dd></div>
                <button disabled={finishing} onClick={() => setPhase('antivirus-provider')} className="text-xs font-medium text-primary">Edit antivirus</button>
              </div>
            </dl>
            <button disabled={finishing} onClick={() => void finish()} className="flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-5 py-3 font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50">
              {finishing ? <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" /> : <ArrowRight aria-hidden="true" className="h-4 w-4" />} Open inbox
            </button>
            <p className="mt-4 text-center text-xs text-muted-foreground">Press ? in your inbox anytime to explore keyboard shortcuts.</p>
          </div>
        </div>
      </div>
    </div>
  );
}
