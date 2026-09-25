// Onboarding step 1 — Sarv sign-in + LLM zone/provider/model selection.
//
// Flow:
//   1. `signin` phase — Login with Sarv or Create Sarv Account. OAuth
//      returns user profile + access token.
//   2. Post-OAuth — populate localStorage profile fields, fetch zones via
//      /oauth/v1/zones, auto-pick the default zone (silent; most users
//      only have one). The zone's `api_domain` becomes the edge URL the
//      AIProvider entry stores — no more SARVINBOX_SARV_EDGE_BASE_URL
//      hard-coding.
//   3. `picker` phase — cascading Provider → Model dropdowns filtered by
//      the chosen zone. User can also switch zone if they have multiple.
//   4. Continue — register the (provider, model, zone.api_domain) tuple
//      as the default AIProvider entry.

import { ArrowLeft, CheckCircle2, Loader2, Sparkles, UserPlus } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import {
  listCaiProviders,
  listCaiModels,
  loadZoneSelection,
  pickRecommendedProvider,
  pickRecommendedModel,
  RECOMMENDED_SARV_PROVIDER,
  RECOMMENDED_SARV_MODEL,
  type SarvLLMProvider,
  type SarvLLMModel,
  type SarvZone,
} from '../../services/sarv-cai-api';
import {
  buildSarvProviderDraft,
  registerSarvProvider,
  NO_EDGE_URL_MESSAGE,
} from '../../services/sarv-llm-provider';
import { useEmailStore } from '../../store/email-store';

interface SarvSignInStepProps {
  /** `mailboxConnected` tells Onboarding the Sarv mailbox was connected over
   *  OAuth during this step, so it can skip the Connect Email + Sending steps. */
  onNext: (opts?: { mailboxConnected?: boolean }) => void;
}

const SETTINGS_KEY = 'sarvinbox-settings';

type SarvStartFlowData = NonNullable<
  Awaited<ReturnType<typeof window.electronAPI.oauth.startFlow>>['data']
>;

interface SignedInAccount {
  email: string;
  displayName?: string;
  apiBaseUrl: string;
  /** Fallback edge URL from env — only used if zone catalog fails to load. */
  fallbackEdgeBaseUrl: string;
}

type Phase = 'signin' | 'picker';

export function SarvSignInStep({ onNext }: SarvSignInStepProps) {
  const [phase, setPhase] = useState<Phase>('signin');
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [signupUrl, setSignupUrl] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // Phase 2 — picker state
  const [account, setAccount] = useState<SignedInAccount | null>(null);
  const [zones, setZones] = useState<SarvZone[]>([]);
  const [providers, setProviders] = useState<SarvLLMProvider[]>([]);
  const [models, setModels] = useState<SarvLLMModel[]>([]);
  const [zoneCode, setZoneCode] = useState('');
  // The zone lookup has FINISHED (with or without a zone). The provider fetch
  // waits on this, never on `zoneCode` — see the zones effect below.
  const [zonesResolved, setZonesResolved] = useState(false);
  const [providerCode, setProviderCode] = useState('');
  const [modelCode, setModelCode] = useState('');
  const [pickerBusy, setPickerBusy] = useState(false);
  // True once the Sarv MAILBOX (not just AI identity) is connected over OAuth
  // during this step — lets Onboarding skip Connect Email + Sending.
  const [mailboxConnected, setMailboxConnected] = useState(false);

  // React 18 StrictMode double-mounts in dev. The cleanup flips `mountedRef`
  // to false on the simulated unmount; we must flip it back to true on
  // every (re)mount or stale fetches silently skip setState and the UI
  // locks on "Loading…".
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const res = await window.electronAPI.oauth.listProviders();
        if (res.success && res.data) {
          const sarv = res.data.find((p) => p.id === 'sarv');
          setConfigured(Boolean(sarv?.configured));
          const oauthBase =
            (sarv as { oauthBase?: string } | undefined)?.oauthBase
            || 'https://oauth.sarv.com';
          setSignupUrl(`${oauthBase}/register`);
        } else {
          setConfigured(false);
        }
      } catch {
        setConfigured(false);
      }
    })();
  }, []);

  // After sign-in → try zones → load providers, WITH OR WITHOUT a zone.
  //
  // `loadZoneSelection` never rejects: a zones 403 (an account with CAI
  // credits but no organization) is a normal state, and the providers fetch
  // below is what decides whether the account really can't use AI. Making a
  // zones failure fatal here is what left such accounts signed in with zero
  // AI providers and an "AI inactive" banner.
  useEffect(() => {
    if (phase !== 'picker' || !account) return;
    setPickerBusy(true);
    setError('');
    loadZoneSelection(account.apiBaseUrl, account.email)
      .then((selection) => {
        if (!mountedRef.current) return;
        setZones(selection.zones);
        setZoneCode(selection.zoneCode);
      })
      .finally(() => {
        if (!mountedRef.current) return;
        setZonesResolved(true);
        setPickerBusy(false);
      });
  }, [phase, account]);

  // Zone resolved (or unavailable) → fetch providers. `zoneCode` is passed
  // as an optional filter and an empty one is dropped from the query string,
  // so this works unscoped. Recommended default: `sarv_partners`.
  useEffect(() => {
    if (phase !== 'picker' || !account || !zonesResolved) return;
    setPickerBusy(true);
    listCaiProviders(account.apiBaseUrl, account.email, zoneCode)
      .then((list) => {
        if (!mountedRef.current) return;
        setProviders(list);
        setProviderCode(pickRecommendedProvider(list)?.code ?? '');
      })
      .catch((err: Error) => mountedRef.current && setError(`Couldn't load providers: ${err.message}`))
      .finally(() => mountedRef.current && setPickerBusy(false));
  }, [phase, account, zonesResolved, zoneCode]);

  // When provider changes → fetch models for (provider, zone).
  useEffect(() => {
    if (phase !== 'picker' || !account || !providerCode) {
      setModels([]);
      setModelCode('');
      return;
    }
    setPickerBusy(true);
    listCaiModels(account.apiBaseUrl, account.email, providerCode, zoneCode)
      .then((list) => {
        if (!mountedRef.current) return;
        setModels(list);
        setModelCode(pickRecommendedModel(list, providerCode)?.code ?? '');
      })
      .catch((err: Error) => mountedRef.current && setError(`Couldn't load models: ${err.message}`))
      .finally(() => mountedRef.current && setPickerBusy(false));
  }, [phase, account, providerCode, zoneCode]);

  // "Login with Sarv" is a mailbox sign-in too, not just an AI/identity one: the
  // same OAuth flow returns an `imap` config for the Sarv mailbox, and the token
  // authenticates it over XOAUTH2. So connect the Sarv mailbox here (IMAP + the
  // auto-derived SMTP) — best-effort and PROBED first, so an account with no
  // Sarv mailbox / a server that rejects the token silently falls through to the
  // manual Connect Email step instead of erroring. On success we flag it so
  // Onboarding skips Connect Email + Sending.
  const tryConnectSarvMailbox = async (data: SarvStartFlowData): Promise<void> => {
    const imap = (data as { imap?: { host: string; port: number; secure: boolean } }).imap;
    if (!imap?.host || !data.email) return;
    const candidate = {
      host: imap.host,
      port: imap.port,
      secure: imap.secure,
      username: data.email,
      password: '',
      authMethod: 'oauth2' as const,
      oauthProvider: 'sarv' as const,
    };
    try {
      // Fast auth-only check (main injects the just-issued token). Gates the
      // decision without waiting on a full folder sync.
      const probe = await window.electronAPI.imap.probeCredentials(candidate as any);
      if (!probe.success) return; // no mailbox / token rejected → manual step
      setMailboxConnected(true);
      // Connect + initial sync run in the BACKGROUND so the AI picker shows
      // immediately; addAccount already probed above, so skip its re-verify.
      void useEmailStore.getState().addAccount(candidate as any, { alreadyVerified: true })
        .catch((e) => console.warn('[SarvSignInStep] Sarv mailbox connect failed after probe:', (e as Error)?.message));
    } catch (e) {
      console.warn('[SarvSignInStep] Sarv mailbox auto-connect skipped:', (e as Error)?.message);
    }
  };

  const handleSignIn = async () => {
    setError('');
    setLoading(true);
    try {
      const res = await window.electronAPI.oauth.startFlow('sarv');
      if (!res.success || !res.data) throw new Error(res.error || 'Sign-in failed');

      populateProfileFromSarv(res.data);
      // Connect the Sarv mailbox over OAuth (best-effort, probed). Awaits only
      // the quick probe; the sync itself runs in the background.
      await tryConnectSarvMailbox(res.data);
      if (!res.data.apiBaseUrl || !res.data.llmBaseUrl) {
        throw new Error('Sarv sign-in succeeded but API/edge URLs are missing');
      }
      setAccount({
        email: res.data.email,
        displayName: res.data.displayName,
        apiBaseUrl: res.data.apiBaseUrl,
        fallbackEdgeBaseUrl: res.data.llmBaseUrl,
      });
      setPhase('picker');
    } catch (err) {
      setError((err as Error).message || 'Sarv sign-in failed');
    } finally {
      setLoading(false);
    }
  };

  const handleCreateAccount = () => {
    if (!signupUrl) return;
    window.electronAPI.app.openExternal(signupUrl);
  };

  // Let users connect their email first and configure AI later from
  // Settings → AI → Providers. Nothing is written here — App.tsx
  // re-syncs ai.setProviderConfigured() from the default-provider
  // presence on every boot, so leaving without a provider just keeps
  // AI features dormant until one is added.
  const handleSkip = () => {
    onNext({ mailboxConnected });
  };

  const handleContinue = () => {
    if (!account) return;
    const drafted = buildSarvProviderDraft({
      email: account.email,
      providerCode,
      modelCode,
      zoneCode,
      providers,
      models,
      zones,
      fallbackEdgeBaseUrl: account.fallbackEdgeBaseUrl,
    });
    if (!drafted.ok) {
      if (drafted.reason === 'no-edge-url') setError(NO_EDGE_URL_MESSAGE);
      return;
    }
    try {
      // The model picked here IS the default the user chose, so override any
      // earlier one. Registration is idempotent, so this can't duplicate an
      // entry Settings already auto-registered for the same account.
      registerSarvProvider(drafted.draft, { makeDefault: true });
      onNext({ mailboxConnected });
    } catch (err) {
      setError((err as Error).message || 'Failed to register LLM provider');
    }
  };

  const handleBackToSignIn = () => {
    setPhase('signin');
    setZones([]);
    setProviders([]);
    setModels([]);
    setZoneCode('');
    setZonesResolved(false);
    setProviderCode('');
    setModelCode('');
    setError('');
  };

  const isSignedIn = phase === 'picker' && account !== null;
  const showZoneSelector = zones.length > 1; // hide when only one zone
  const zoneLabel = (z: SarvZone) =>
    [z.name || z.code, z.city].filter(Boolean).join(' · ');

  return (
    <div>
      <div className="flex items-center gap-3 mb-6">
        <div className="p-2 bg-primary/10 rounded-lg">
          <Sparkles className="h-6 w-6 text-primary" />
        </div>
        <div>
          <h2 className="text-xl font-semibold">
            {isSignedIn ? 'Pick your LLM' : 'Sign in to Sarv'}
          </h2>
          <p className="text-sm text-muted-foreground">
            {isSignedIn
              ? `Signed in as ${account?.displayName || account?.email}. Choose which Sarv model Sarv Inbox should use — you can change the default later in Settings.`
              : 'Your Sarv account unlocks the AI features and your wallet pays for LLM calls — no API keys to paste.'}
          </p>
        </div>
      </div>

      {/* Success confirmation — the zone/LLM step can still error (e.g. the
          account isn't linked to a CAI org), so make it unmistakable that the
          Sarv sign-in itself succeeded. */}
      {isSignedIn && (
        <div className="flex items-center gap-2 p-3 mb-4 bg-green-50 dark:bg-green-950/30 border border-green-200 dark:border-green-900 rounded-md text-sm text-green-700 dark:text-green-400 font-medium">
          <CheckCircle2 className="h-4 w-4 shrink-0" />
          Signed in to Sarv as {account?.displayName || account?.email}
        </div>
      )}

      {/* Mailbox auto-connected over OAuth — Connect Email + Sending are done,
          so the flow will jump straight to Shortcuts after this step. */}
      {isSignedIn && mailboxConnected && (
        <div className="flex items-center gap-2 p-3 mb-4 bg-green-50 dark:bg-green-950/30 border border-green-200 dark:border-green-900 rounded-md text-sm text-green-700 dark:text-green-400 font-medium">
          <CheckCircle2 className="h-4 w-4 shrink-0" />
          Your Sarv mailbox is connected — mail is syncing. Sending is set up too.
        </div>
      )}

      {configured === false && (
        <div className="p-3 mb-4 bg-destructive/10 border border-destructive/20 rounded-md text-sm text-destructive">
          Sarv OAuth isn't configured for this build. Set SARVINBOX_SARV_CLIENT_ID (and related env vars) before signing in. See SARV_OAUTH_SETUP.md.
        </div>
      )}

      {error && (
        <div className="p-3 mb-4 bg-destructive/10 border border-destructive/20 rounded-md text-sm text-destructive">
          {error}
        </div>
      )}

      {phase === 'signin' && (
        <div className="space-y-3">
          <button
            onClick={handleSignIn}
            disabled={loading || configured === false}
            className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-primary text-primary-foreground rounded-md hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors font-medium"
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
            Login with Sarv
          </button>
          <button
            onClick={handleCreateAccount}
            disabled={loading || !signupUrl}
            className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-background border border-input rounded-md hover:bg-accent disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            <UserPlus className="h-4 w-4" />
            Create Sarv Account
          </button>
          <p className="text-xs text-muted-foreground mt-3">
            OAuth 2.1 + PKCE. Sarv Inbox will ask for permission to read your profile, call the LLM on your behalf, and refresh tokens in the background. You can revoke access any time in your Sarv dashboard.
          </p>
          <button
            onClick={handleSkip}
            disabled={loading}
            className="w-full mt-2 px-4 py-2 text-sm font-medium text-primary hover:underline disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            Skip for now — connect email first, add AI later in Settings
          </button>
        </div>
      )}

      {phase === 'picker' && account && (
        <div className="space-y-4">
          {/* Gated on the zone lookup FINISHING, not on it returning a zone:
              an account with no org has no zones and must still reach the
              provider/model dropdowns. */}
          {!zonesResolved ? (
            <div className="flex items-center gap-2 p-4 bg-muted/30 rounded-lg text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading your Sarv AI catalog...
            </div>
          ) : (
            <>
              {showZoneSelector && (
                <div>
                  <label className="block text-sm font-medium mb-1">Region</label>
                  <select
                    value={zoneCode}
                    onChange={(e) => setZoneCode(e.target.value)}
                    className="w-full px-3 py-2 bg-background border border-input rounded-md focus:outline-none focus:ring-2 focus:ring-ring text-sm"
                  >
                    {zones.map((z) => (
                      <option key={z.code} value={z.code}>
                        {zoneLabel(z)}
                        {z.is_default ? ' (default)' : ''}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              <div>
                <label className="block text-sm font-medium mb-1">Provider</label>
                <select
                  value={providerCode}
                  onChange={(e) => setProviderCode(e.target.value)}
                  disabled={pickerBusy || providers.length === 0}
                  className="w-full px-3 py-2 bg-background border border-input rounded-md focus:outline-none focus:ring-2 focus:ring-ring text-sm disabled:opacity-50"
                >
                  {providers.length === 0 ? (
                    <option value="">
                      {pickerBusy ? 'Loading providers...' : 'No providers on your Sarv account'}
                    </option>
                  ) : (
                    providers.map((p) => (
                      <option key={p.code} value={p.code}>
                        {p.name || p.code}
                        {p.code === RECOMMENDED_SARV_PROVIDER ? '  ★ Recommended' : ''}
                      </option>
                    ))
                  )}
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium mb-1">Model</label>
                <select
                  value={modelCode}
                  onChange={(e) => setModelCode(e.target.value)}
                  disabled={pickerBusy || models.length === 0}
                  className="w-full px-3 py-2 bg-background border border-input rounded-md focus:outline-none focus:ring-2 focus:ring-ring text-sm disabled:opacity-50"
                >
                  {models.length === 0 ? (
                    <option value="">
                      {pickerBusy ? 'Loading models...' : 'No models available for this provider'}
                    </option>
                  ) : (
                    models.map((m) => (
                      <option key={m.code} value={m.code}>
                        {m.display_name || m.code}
                        {providerCode === RECOMMENDED_SARV_PROVIDER && m.code === RECOMMENDED_SARV_MODEL
                          ? '  ★ Recommended'
                          : ''}
                      </option>
                    ))
                  )}
                </select>
                {/* Recommendation note — shown only when Sarv Partners +
                    GPT-OSS-120B is the active selection. Tells the user
                    they've picked the fine-tuned configuration that
                    Sarv Inbox is optimized for. */}
                {providerCode === RECOMMENDED_SARV_PROVIDER && modelCode === RECOMMENDED_SARV_MODEL && (
                  <p className="mt-2 text-xs text-muted-foreground leading-relaxed">
                    <span className="text-amber-600 dark:text-amber-400">★</span>{' '}
                    Best results — Sarv has fine-tuned this GPT-OSS-120B deployment
                    for Sarv Inbox's chat-view extraction and reply drafting.
                  </p>
                )}
              </div>
            </>
          )}

          <div className="flex items-center gap-3 pt-1">
            <button
              onClick={handleBackToSignIn}
              className="flex items-center gap-1.5 px-4 py-2.5 text-sm text-muted-foreground hover:text-foreground hover:bg-accent rounded-md transition-colors"
            >
              <ArrowLeft className="h-4 w-4" />
              Sign in as different user
            </button>
            <button
              onClick={handleContinue}
              disabled={!providerCode || !modelCode || pickerBusy}
              className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 bg-primary text-primary-foreground rounded-md hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors font-medium"
            >
              Continue
            </button>
          </div>

          {/* Escape hatch — when zones/providers can't load (e.g. the Sarv
              account isn't linked to a CAI org) Continue stays disabled, so
              offer the same skip as the sign-in phase: proceed without an AI
              provider and let the user add one later in Settings → AI. */}
          <button
            onClick={handleSkip}
            disabled={pickerBusy}
            className="w-full px-4 py-2 text-sm font-medium text-primary hover:underline disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            Skip for now — connect email first, add AI later in Settings
          </button>
        </div>
      )}
    </div>
  );
}

function populateProfileFromSarv(flow: SarvStartFlowData): void {
  try {
    const current = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    const merged = {
      ...current,
      profileEmail: current.profileEmail || flow.email,
      profileName: current.profileName || flow.displayName || '',
    };
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(merged));
  } catch (err) {
    console.warn('[SarvSignInStep] Failed to populate profile:', err);
  }
}
