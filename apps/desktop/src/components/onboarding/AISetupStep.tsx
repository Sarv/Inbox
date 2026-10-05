import { ArrowLeft, ArrowRight, CheckCircle2, Loader2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { SARV_AI_DISCLOSURE, setAiConsent } from '../../services/ai-consent';
import { addValidatedProvider, loadAISettings, testProvider, type AIProviderType } from '../../services/ai-service';
import {
  checkAIConnection, loadSarvAIConnection, makeAIConnection, providerFromConnection,
  type OnboardingAIConnection,
} from '../../services/onboarding-ai-connection';

import { ProviderIcon } from './ProviderIcon';

export type AISetupStage = 'provider' | 'connection' | 'model';
export interface AISetupStepProps {
  stage: AISetupStage;
  active: boolean;
  preferSarv: boolean;
  preferSarvEmail?: string;
  onStageChange: (stage: AISetupStage) => void;
  onBackToEmail: () => void;
  onComplete: (result: { enabled: boolean; providerName?: string; modelName?: string; keyStorageEncrypted?: false }) => void;
}

const choices: Array<{ type: AIProviderType; icon: string; name: string; detail: string }> = [
  { type: 'sarv', icon: 'sarv-ai', name: 'Sarv AI', detail: 'Use your Sarv account or API key' },
  { type: 'openai', icon: 'openai', name: 'OpenAI', detail: 'Connect with your OpenAI API key' },
  { type: 'gemini', icon: 'gemini', name: 'Google Gemini', detail: 'Connect with your Google AI API key' },
  { type: 'custom', icon: 'custom', name: 'Custom provider', detail: 'Any OpenAI-compatible service or local model' },
];
const fieldClass = 'w-full rounded-xl border border-input bg-background px-3.5 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-60';
const primaryClass = 'flex items-center justify-center gap-2 rounded-xl bg-primary px-5 py-3 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50';

function initialConnections(): Record<AIProviderType, OnboardingAIConnection> {
  const connections = Object.fromEntries(choices.map(({ type }) => [type, makeAIConnection(type)])) as Record<AIProviderType, OnboardingAIConnection>;
  // Stored provider metadata is reused, and keys come from the hydrated vault
  // cache. Draft edits remain only in this mounted component's memory.
  for (const stored of loadAISettings().providers) {
    if (!connections[stored.type] || connections[stored.type].model) continue;
    connections[stored.type] = {
      ...connections[stored.type], name: stored.name, baseUrl: stored.baseUrl || connections[stored.type].baseUrl,
      apiKey: stored.apiKey, useApiKey: Boolean(stored.apiKey), model: stored.model,
      authMethod: stored.authMethod || 'apiKey',
      models: [{ id: stored.model, name: stored.model }],
      verified: stored.authMethod !== 'oauth' && (Boolean(stored.apiKey) || stored.type === 'custom'),
    };
  }
  return connections;
}

export function AISetupStep({ stage, active, preferSarv, preferSarvEmail, onStageChange, onBackToEmail, onComplete }: AISetupStepProps) {
  const [connections, setConnections] = useState(initialConnections);
  const [selected, setSelected] = useState<AIProviderType | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [consent, setConsent] = useState(false);
  const [rememberedSarvShortcut, setRememberedSarvShortcut] = useState<string | null>(null);
  const request = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const timeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const signingIn = useRef(false);
  const activeRef = useRef(active);
  activeRef.current = active;
  const connection = selected ? connections[selected] : null;

  const invalidate = () => {
    request.current++;
    controller.current?.abort();
    if (timeout.current) clearTimeout(timeout.current);
    timeout.current = null;
    if (signingIn.current) {
      signingIn.current = false;
      void window.electronAPI.oauth.cancel().catch(() => {});
    }
    setBusy(false);
  };

  useEffect(() => {
    if (!active) invalidate();
    return () => {
      // This ref is a sequence counter, not a DOM node captured by an effect.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      request.current++;
      controller.current?.abort();
      if (timeout.current) clearTimeout(timeout.current);
      if (signingIn.current) void window.electronAPI.oauth.cancel().catch(() => {});
    };
    // Cancellation follows visibility; stage transitions happen after the
    // operation that requested them has finished.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  const run = async (
    action: (signal: AbortSignal, isCurrent: () => boolean) => Promise<void>,
  ) => {
    invalidate();
    const id = request.current;
    const abort = new AbortController();
    controller.current = abort;
    const isCurrent = () => activeRef.current && request.current === id && !abort.signal.aborted;
    setBusy(true);
    setError('');
    timeout.current = setTimeout(() => {
      if (!activeRef.current || request.current !== id) return;
      abort.abort();
      if (signingIn.current) {
        signingIn.current = false;
        void window.electronAPI.oauth.cancel().catch(() => {});
      }
      setBusy(false);
      setError('The connection timed out. Please try again.');
    }, 60_000);
    try {
      await action(abort.signal, isCurrent);
    } catch (cause) {
      if (activeRef.current && request.current === id) {
        setError(abort.signal.aborted ? 'The connection timed out. Please try again.'
          : cause instanceof Error ? cause.message : 'Could not connect. Please try again.');
      }
    } finally {
      if (request.current === id) {
        if (timeout.current) clearTimeout(timeout.current);
        timeout.current = null;
        setBusy(false);
        signingIn.current = false;
      }
    }
  };

  const saveConnection = (value: OnboardingAIConnection) => {
    setConnections((previous) => ({ ...previous, [value.type]: value }));
  };

  const loadSarv = (
    previous: OnboardingAIConnection,
    selection?: { email?: string; zoneCode?: string; providerCode?: string },
    signIn = false,
  ) => run(async (signal, isCurrent) => {
    if (signIn) {
      signingIn.current = true;
      const result = await window.electronAPI.oauth.startFlow('sarv');
      if (!isCurrent()) return;
      if (!result.success || !result.data) throw new Error('Sarv sign-in was cancelled or could not complete. Try again, or set up AI later.');
      selection = { email: result.data.email };
    }
    const connected = await loadSarvAIConnection(previous, signal, selection);
    if (!isCurrent()) return;
    saveConnection(connected);
    onStageChange('model');
  });

  const choose = (type: AIProviderType) => {
    invalidate();
    setSelected(type);
    setConsent(false);
    setError('');
    const chosen = connections[type];
    if (chosen.verified) onStageChange('model');
    else {
      onStageChange('connection');
      if (type === 'sarv' && chosen.authMethod === 'oauth') void loadSarv(chosen);
    }
  };

  useEffect(() => {
    const identity = preferSarvEmail || 'sarv';
    if (!active || !preferSarv || rememberedSarvShortcut === identity) return;
    setRememberedSarvShortcut(identity);
    invalidate();
    setSelected('sarv');
    setConsent(false);
    onStageChange('connection');
    void loadSarv(connections.sarv, { email: preferSarvEmail });
    // A successfully connected Sarv mailbox gets exactly one catalog reuse
    // attempt; Back and intentional provider changes must not force Sarv again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, preferSarv, preferSarvEmail, rememberedSarvShortcut]);

  const edit = (patch: Partial<OnboardingAIConnection>) => {
    if (!connection) return;
    invalidate();
    setError('');
    setConsent(false);
    saveConnection({ ...connection, ...patch, verified: false, models: [], manualModel: false });
  };

  const skip = () => {
    invalidate();
    setAiConsent('declined');
    onComplete({ enabled: false });
  };

  const back = () => {
    invalidate();
    setError('');
    if (stage === 'provider' || (preferSarv && selected === 'sarv' && stage === 'model')) onBackToEmail();
    else onStageChange('provider');
  };

  const connect = () => {
    if (!connection) return;
    if (connection.authMethod === 'oauth') void loadSarv(connection, undefined, !connection.sarv);
    else void run(async (signal, isCurrent) => {
      const checked = await checkAIConnection(connection, signal);
      if (!isCurrent()) return;
      saveConnection(checked);
      onStageChange('model');
    });
  };

  const enableAI = () => {
    if (!connection?.verified || !connection.model.trim() || !consent) return;
    void run(async (signal, isCurrent) => {
      const provider = providerFromConnection(connection);
      const test = await testProvider(provider, { signal });
      if (!isCurrent()) return;
      if (!test.success) throw new Error(test.message);
      const { id: _id, isDefault: _default, ...draft } = provider;
      const saved = await addValidatedProvider(draft, isCurrent);
      if (!saved || !isCurrent()) return;
      setAiConsent('granted');
      // Registration is now explicit, tested and consented. The mailbox has
      // not been sent in either the catalog check or the synthetic model test.
      onComplete({
        enabled: true, providerName: selected === 'custom' ? saved.name : choices.find((entry) => entry.type === selected)?.name,
        modelName: connection.models.find((model) => model.id === connection.model)?.name || connection.model,
        ...(saved.keyStorageEncrypted === false ? { keyStorageEncrypted: false as const } : {}),
      });
    });
  };

  const label = choices.find((entry) => entry.type === selected)?.name || 'AI';
  const isOAuth = connection?.authMethod === 'oauth';
  const sarv = connection?.sarv;
  const disclosure = selected === 'sarv' ? SARV_AI_DISCLOSURE
    : `AI sorts your inbox, drafts replies and pulls out conversations by sending sender, recipients, subject and message text to ${connection?.name || label}, for every connected email account. Your provider's terms and data policy apply. You can turn AI off in Settings → AI.`;

  return (
    <section aria-label="AI setup" className="space-y-6">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight">{stage === 'provider' ? 'Choose your AI provider' : stage === 'connection' ? `Connect ${label}` : 'Choose your model'}</h2>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">{stage === 'provider'
          ? 'Make your inbox smarter with the AI service you prefer. You can also set this up later.'
          : stage === 'connection' ? 'Connect your account to see which models are available.'
            : 'Pick the model Inbox will use. We will test it before enabling AI.'}</p>
      </div>
      {error && <div role="alert" className="rounded-xl border border-destructive/20 bg-destructive/10 p-3.5 text-sm text-destructive">{error}</div>}
      {stage === 'provider' ? (
        <div className="grid gap-3 sm:grid-cols-2">
          {choices.map((choice) => (
            <button key={choice.type} type="button" onClick={() => choose(choice.type)} className="flex min-h-28 items-center gap-4 rounded-2xl border border-input p-4 text-left transition-colors hover:border-primary/60 hover:bg-primary/5">
              <ProviderIcon id={choice.icon} className="h-10 w-10 shrink-0" />
              <span className="flex-1"><span className="block text-sm font-semibold">{choice.name}</span><span className="mt-1 block text-xs leading-5 text-muted-foreground">{choice.detail}</span></span>
              <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground" />
            </button>
          ))}
        </div>
      ) : connection && (
        <div className="space-y-4">
          <div className="flex items-center gap-3 rounded-xl bg-muted/40 p-3">
            <ProviderIcon id={choices.find((entry) => entry.type === selected)!.icon} className="h-8 w-8" />
            <span className="flex-1 text-sm font-medium">{label}</span>
            <button type="button" onClick={() => { invalidate(); setError(''); onStageChange('provider'); }} className="text-xs font-medium text-primary hover:underline">Change AI provider</button>
          </div>
          {stage === 'connection' && (isOAuth ? (
            <div className="space-y-4 rounded-2xl border border-input p-5">
              <p className="text-sm leading-6 text-muted-foreground">Your Sarv sign-in also connects AI. An existing Sarv session is reused without another sign-in.</p>
              <button type="button" onClick={connect} disabled={busy} className={`${primaryClass} w-full`}>{busy && <Loader2 className="h-4 w-4 animate-spin" />}{connection.sarv ? 'Use current Sarv connection' : 'Sign in with Sarv'}</button>
              {connection.sarv && <button type="button" onClick={() => { void loadSarv(connection, undefined, true); }} disabled={busy} className="block text-sm text-primary hover:underline">Sign in with a different Sarv account</button>}
              <button type="button" onClick={() => edit({ authMethod: 'apiKey' })} disabled={busy} className="text-sm text-primary hover:underline">Use an API key instead</button>
            </div>
          ) : (
            <form onSubmit={(event) => { event.preventDefault(); connect(); }} className="space-y-4">
              {selected === 'custom' && <label className="block space-y-2 text-sm font-medium">Provider name<input value={connection.name} onChange={(event) => edit({ name: event.target.value })} disabled={busy} className={fieldClass} placeholder="My AI server" /></label>}
              {(selected === 'custom' || selected === 'sarv') && <label className="block space-y-2 text-sm font-medium">API endpoint<input type="url" value={connection.baseUrl} onChange={(event) => edit({ baseUrl: event.target.value })} disabled={busy} className={fieldClass} placeholder="https://your-server.example/v1" /><span className="block text-xs font-normal text-muted-foreground">Use the API base URL, without /chat/completions.</span></label>}
              {selected === 'custom' && <label className="block space-y-2 text-sm font-medium">Authentication<select aria-label="Authentication" value={connection.useApiKey ? 'key' : 'none'} onChange={(event) => edit({ useApiKey: event.target.value === 'key' })} disabled={busy} className={fieldClass}><option value="key">API key</option><option value="none">No authentication</option></select></label>}
              {connection.useApiKey && <label className="block space-y-2 text-sm font-medium">API key<input type="password" value={connection.apiKey} onChange={(event) => edit({ apiKey: event.target.value })} disabled={busy} autoComplete="off" spellCheck={false} className={fieldClass} placeholder="Paste your API key" /><span className="block text-xs font-normal leading-5 text-muted-foreground">Saved in your device credential vault after you choose and test a model. A system keyring is needed for encrypted key storage.</span></label>}
              {selected === 'sarv' && <button type="button" onClick={() => { edit({ authMethod: 'oauth' }); void loadSarv({ ...connection, authMethod: 'oauth' }); }} disabled={busy} className="text-sm text-primary hover:underline">Use Sarv sign-in instead</button>}
              <button type="submit" disabled={busy} className={`${primaryClass} w-full`}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowRight className="h-4 w-4" />}Check connection</button>
              <p className="text-xs leading-5 text-muted-foreground">This checks your configuration and lists models. It does not send any email content.</p>
            </form>
          ))}
          {stage === 'model' && (
            <>
              <div className="flex items-center justify-between gap-3 text-xs">
                <span className="flex items-center gap-1.5 text-muted-foreground"><CheckCircle2 className="h-4 w-4 text-green-600" />{(isOAuth && sarv?.email) || 'Connection configured'}</span>
                <button type="button" onClick={() => { invalidate(); setError(''); onStageChange('connection'); }} className="shrink-0 font-medium text-primary hover:underline">Connection settings</button>
              </div>
              {isOAuth && sarv && (sarv.accounts.length > 1 || sarv.zones.length > 1 || sarv.providers.length > 1) && <details className="rounded-xl border border-input p-3 text-sm"><summary className="cursor-pointer font-medium">Advanced connection options</summary><div className="mt-3 space-y-3">
                {sarv.accounts.length > 1 && <label className="block space-y-1 text-sm">Sarv account<select aria-label="Sarv account" value={sarv.email} disabled={busy} onChange={(event) => { setConsent(false); void loadSarv(connection, { email: event.target.value }); }} className={fieldClass}>{sarv.accounts.map((account) => <option key={account.email} value={account.email}>{account.email}</option>)}</select></label>}
                {sarv.zones.length > 1 && <label className="block space-y-1 text-sm">Region<select aria-label="Region" value={sarv.zoneCode} disabled={busy} onChange={(event) => { setConsent(false); void loadSarv(connection, { zoneCode: event.target.value }); }} className={fieldClass}>{sarv.zones.map((zone) => <option key={zone.code} value={zone.code}>{zone.name || zone.code}</option>)}</select></label>}
                {sarv.providers.length > 1 && <label className="block space-y-1 text-sm">Backend<select aria-label="Backend" value={sarv.providerCode} disabled={busy} onChange={(event) => { setConsent(false); void loadSarv(connection, { providerCode: event.target.value }); }} className={fieldClass}>{sarv.providers.map((provider) => <option key={provider.code} value={provider.code}>{provider.name}</option>)}</select></label>}
              </div></details>}
              {connection.manualModel ? <label className="block space-y-2 text-sm font-medium">Model ID<input value={connection.model} disabled={busy} onChange={(event) => { setConsent(false); saveConnection({ ...connection, model: event.target.value }); }} className={fieldClass} placeholder="Enter the exact model ID" /><span className="block text-xs font-normal text-muted-foreground">This server does not publish a catalog. Enter its exact model ID; the next step verifies it.</span></label>
                : <label className="block space-y-2 text-sm font-medium">Model<select aria-label="Model" value={connection.model} disabled={busy} onChange={(event) => { setConsent(false); saveConnection({ ...connection, model: event.target.value }); }} className={fieldClass}><option value="">Select an available model</option>{connection.models.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}</select></label>}
              <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-input p-4"><input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} disabled={busy} className="mt-1" /><span className="text-xs leading-6"><span className="block text-sm font-medium">Allow AI to process my email</span>{disclosure}</span></label>
              <button type="button" disabled={busy || !connection.verified || !connection.model.trim() || !consent} onClick={enableAI} className={`${primaryClass} w-full`}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowRight className="h-4 w-4" />}{busy ? 'Testing and saving…' : 'Test model and enable AI'}</button>
              <p className="text-xs leading-5 text-muted-foreground">The test sends a short sample prompt. Your provider may charge for this request.</p>
            </>
          )}
          {busy && stage === 'connection' && isOAuth && <p role="status" className="text-center text-xs text-muted-foreground">Checking your Sarv session and loading available models…</p>}
        </div>
      )}
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
        <button type="button" onClick={back} className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="h-4 w-4" />Back</button>
        <button type="button" onClick={skip} className="text-sm font-medium text-primary hover:underline">Set up AI later</button>
      </div>
    </section>
  );
}
