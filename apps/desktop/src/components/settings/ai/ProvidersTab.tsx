import { Eye, EyeOff, Loader2, Trash2, Plus, Star, Pencil, Sparkles, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import {
  AIProvider,
  AIProviderType,
  PROVIDER_CONFIGS,
  addProvider,
  removeProvider,
  setDefaultProvider,
  updateProvider,
  testProvider,
  syncAIProviderToMain,
} from '../../../services/ai-service';
import {
  listCaiProviders,
  listCaiModels,
  loadZoneSelection,
  pickRecommendedProvider,
  pickRecommendedModel,
  type SarvLLMProvider,
  type SarvLLMModel,
  type SarvZone,
} from '../../../services/sarv-cai-api';
import {
  buildSarvProviderDraft,
  findRegisteredSarvProvider,
  registerSarvProvider,
  NO_EDGE_URL_MESSAGE,
  type SarvProviderSelection,
} from '../../../services/sarv-llm-provider';

interface ProvidersTabProps {
  aiProviders: AIProvider[];
  setAiProviders: React.Dispatch<React.SetStateAction<AIProvider[]>>;
}

export function ProvidersTab({ aiProviders, setAiProviders }: ProvidersTabProps) {
  const [showAddProvider, setShowAddProvider] = useState(false);
  const [newProviderType, setNewProviderType] = useState<AIProviderType>('openai');
  const [newProviderApiKey, setNewProviderApiKey] = useState('');
  const [newProviderModel, setNewProviderModel] = useState('');
  const [newProviderName, setNewProviderName] = useState('');
  const [newProviderBaseUrl, setNewProviderBaseUrl] = useState('');
  const [showNewApiKey, setShowNewApiKey] = useState(false);
  const [testingProviderId, setTestingProviderId] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ id: string; success: boolean; message: string } | null>(null);
  const [editingProvider, setEditingProvider] = useState<AIProvider | null>(null);

  // Sarv OAuth LLM connection
  const [sarvConfigured, setSarvConfigured] = useState<boolean | null>(null);
  const [sarvAccount, setSarvAccount] = useState<{ email: string; displayName?: string } | null>(null);
  const [sarvSigningIn, setSarvSigningIn] = useState(false);
  const [sarvError, setSarvError] = useState('');
  const [sarvApiBaseUrl, setSarvApiBaseUrl] = useState<string | null>(null);
  const [sarvEdgeBaseUrl, setSarvEdgeBaseUrl] = useState<string | null>(null);

  // Sarv zone/provider/model picker state
  const [caiZones, setCaiZones] = useState<SarvZone[]>([]);
  // The zone lookup FINISHED (with or without a zone) — the providers fetch
  // waits on this, never on a zone code.
  const [caiZonesResolved, setCaiZonesResolved] = useState(false);
  const [caiProviders, setCaiProviders] = useState<SarvLLMProvider[]>([]);
  const [caiModels, setCaiModels] = useState<SarvLLMModel[]>([]);
  const [pickerZoneCode, setPickerZoneCode] = useState('');
  const [pickerProviderCode, setPickerProviderCode] = useState('');
  const [pickerModelCode, setPickerModelCode] = useState('');
  const [pickerLoading, setPickerLoading] = useState(false);
  // Which signed-in account the recommended model was already auto-registered
  // for — see the auto-registration effect below. Cleared on sign-out.
  const autoRegisteredFor = useRef<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const providers = await window.electronAPI.oauth.listProviders();
        if (providers.success && providers.data) {
          const sarv = providers.data.find((p) => p.id === 'sarv');
          setSarvConfigured(Boolean(sarv?.configured));
          setSarvApiBaseUrl(sarv?.apiBaseUrl ?? null);
          setSarvEdgeBaseUrl(sarv?.llmBaseUrl ?? null);
        } else {
          setSarvConfigured(false);
        }
        const accounts = await window.electronAPI.oauth.listAccounts();
        if (accounts.success && accounts.data) {
          const a = accounts.data.find((x) => x.provider === 'sarv');
          if (a) setSarvAccount({ email: a.email, displayName: a.displayName });
        }
      } catch {
        setSarvConfigured(false);
      }
    })();
  }, []);

  // Once signed in, try zones → then load providers WITH OR WITHOUT one.
  // `loadZoneSelection` never rejects — a zones 403 (credits but no org) is a
  // normal state, and the providers fetch below produces the error that
  // actually matters.
  useEffect(() => {
    if (!sarvAccount || !sarvApiBaseUrl) return;
    setPickerLoading(true);
    setSarvError('');
    loadZoneSelection(sarvApiBaseUrl, sarvAccount.email)
      .then((selection) => {
        setCaiZones(selection.zones);
        setPickerZoneCode(selection.zoneCode);
      })
      .finally(() => {
        setCaiZonesResolved(true);
        setPickerLoading(false);
      });
  }, [sarvAccount, sarvApiBaseUrl]);

  // Zone resolved (or unavailable) → fetch providers, scoped to the zone only
  // if we have one. Defaults to the recommended provider, same as onboarding.
  useEffect(() => {
    if (!sarvAccount || !sarvApiBaseUrl || !caiZonesResolved) return;
    setPickerLoading(true);
    listCaiProviders(sarvApiBaseUrl, sarvAccount.email, pickerZoneCode)
      .then((list) => {
        setCaiProviders(list);
        setPickerProviderCode(pickRecommendedProvider(list)?.code ?? '');
      })
      .catch((err) => setSarvError(`Couldn't load Sarv LLM providers: ${err.message}`))
      .finally(() => setPickerLoading(false));
  }, [caiZonesResolved, pickerZoneCode, sarvAccount, sarvApiBaseUrl]);

  // When provider changes, fetch models for (provider, zone).
  useEffect(() => {
    if (!sarvAccount || !sarvApiBaseUrl || !pickerProviderCode) {
      setCaiModels([]);
      setPickerModelCode('');
      return;
    }
    setPickerLoading(true);
    listCaiModels(sarvApiBaseUrl, sarvAccount.email, pickerProviderCode, pickerZoneCode)
      .then((list) => {
        setCaiModels(list);
        setPickerModelCode(pickRecommendedModel(list, pickerProviderCode)?.code ?? '');
      })
      .catch((err) => setSarvError(`Couldn't load Sarv LLM models: ${err.message}`))
      .finally(() => setPickerLoading(false));
  }, [pickerProviderCode, pickerZoneCode, sarvAccount, sarvApiBaseUrl]);

  const handleSarvSignIn = async () => {
    setSarvError('');
    setSarvSigningIn(true);
    try {
      const res = await window.electronAPI.oauth.startFlow('sarv');
      if (!res.success || !res.data) {
        throw new Error(res.error || 'Sign-in failed');
      }
      setSarvAccount({ email: res.data.email, displayName: res.data.displayName });
      if (res.data.apiBaseUrl) setSarvApiBaseUrl(res.data.apiBaseUrl);
      if (res.data.llmBaseUrl) setSarvEdgeBaseUrl(res.data.llmBaseUrl);
    } catch (err) {
      setSarvError((err as Error).message || 'Sarv sign-in failed');
    } finally {
      setSarvSigningIn(false);
    }
  };

  const handleSarvSignOut = async () => {
    if (!sarvAccount) return;
    try {
      await window.electronAPI.oauth.signOut('sarv', sarvAccount.email);
      autoRegisteredFor.current = null;
      setSarvAccount(null);
      setCaiZones([]);
      setCaiZonesResolved(false);
      setCaiProviders([]);
      setCaiModels([]);
      setPickerZoneCode('');
      setPickerProviderCode('');
      setPickerModelCode('');
    } catch (err) {
      setSarvError((err as Error).message || 'Sign-out failed');
    }
  };

  // The current picker selection, in the shape the shared registration helper
  // takes. Memoised so the auto-registration effect below doesn't re-run on
  // every render.
  const sarvDraft = useMemo(() => {
    if (!sarvAccount) return null;
    const selection: SarvProviderSelection = {
      email: sarvAccount.email,
      providerCode: pickerProviderCode,
      modelCode: pickerModelCode,
      zoneCode: pickerZoneCode,
      providers: caiProviders,
      models: caiModels,
      zones: caiZones,
      fallbackEdgeBaseUrl: sarvEdgeBaseUrl,
    };
    return buildSarvProviderDraft(selection);
  }, [sarvAccount, pickerProviderCode, pickerModelCode, pickerZoneCode, caiProviders, caiModels, caiZones, sarvEdgeBaseUrl]);

  const readySarvDraft = sarvDraft?.ok ? sarvDraft.draft : null;
  const sarvAlreadyAdded = Boolean(
    readySarvDraft && findRegisteredSarvProvider(aiProviders, readySarvDraft),
  );

  // Signing in to Sarv IS the intent to use Sarv AI — don't also require a
  // click on "Add to AI providers" for the recommended provider/model. Without
  // this, every fresh sign-in sits behind the "AI is inactive" banner until
  // someone notices the button.
  //
  // Once per signed-in account (`autoRegisteredFor`), so deliberately deleting
  // the provider isn't undone by the next render; `registerSarvProvider` is
  // idempotent, so a re-mount can't duplicate it either. No `makeDefault`: a
  // provider the user already chose as default keeps it.
  useEffect(() => {
    if (!readySarvDraft || pickerLoading) return;
    if (autoRegisteredFor.current === readySarvDraft.email) return;
    autoRegisteredFor.current = readySarvDraft.email;
    const { provider, added } = registerSarvProvider(readySarvDraft);
    if (added) setAiProviders((prev) => [...prev, provider]);
  }, [readySarvDraft, pickerLoading, setAiProviders]);

  const handleAddSarvModel = () => {
    if (!sarvDraft) return;
    if (!sarvDraft.ok) {
      if (sarvDraft.reason === 'no-edge-url') setSarvError(NO_EDGE_URL_MESSAGE);
      return;
    }
    const { provider, added } = registerSarvProvider(sarvDraft.draft);
    if (added) setAiProviders((prev) => [...prev, provider]);
  };

  const handleAddProvider = () => {
    if (!newProviderApiKey || !newProviderModel) return;
    if (newProviderType === 'custom' && (!newProviderName || !newProviderBaseUrl)) return;

    const provider = addProvider(newProviderType, newProviderApiKey, newProviderModel, {
      name: newProviderType === 'custom' ? newProviderName : undefined,
      baseUrl: newProviderType === 'custom' ? newProviderBaseUrl : undefined,
    });
    setAiProviders(prev => [...prev, provider]);
    // Notify main process that AI provider is now configured
    void syncAIProviderToMain();
    setShowAddProvider(false);
    setNewProviderApiKey('');
    setNewProviderModel('');
    setNewProviderName('');
    setNewProviderBaseUrl('');
    setNewProviderType('openai');
  };

  const handleRemoveProvider = (id: string) => {
    removeProvider(id);
    setAiProviders(prev => {
      const updated = prev.filter(p => p.id !== id);
      if (updated.length > 0 && !updated.some(p => p.isDefault)) {
        updated[0].isDefault = true;
      }
      // Notify main process whether any provider remains
      void syncAIProviderToMain();
      return updated;
    });
  };

  const handleSetDefaultProvider = (id: string) => {
    setDefaultProvider(id);
    setAiProviders(prev => prev.map(p => ({ ...p, isDefault: p.id === id })));
  };

  const handleTestProvider = async (provider: AIProvider) => {
    setTestingProviderId(provider.id);
    setTestResult(null);

    const result = await testProvider(provider);
    setTestResult({ id: provider.id, ...result });
    setTestingProviderId(null);

    setTimeout(() => {
      setTestResult(prev => prev?.id === provider.id ? null : prev);
    }, 5000);
  };

  const handleEditProvider = (provider: AIProvider) => {
    setEditingProvider({ ...provider });
    setShowNewApiKey(false);
  };

  const handleSaveEditProvider = () => {
    if (!editingProvider) return;
    updateProvider(editingProvider.id, {
      apiKey: editingProvider.apiKey,
      model: editingProvider.model,
      name: editingProvider.name,
      baseUrl: editingProvider.baseUrl,
    });
    setAiProviders(prev => prev.map(p =>
      p.id === editingProvider.id ? { ...p, ...editingProvider } : p
    ));
    setEditingProvider(null);
  };

  return (
    <div className="space-y-6">
      {/* Sarv LLM via OAuth */}
      {sarvConfigured && (
        <div className="border-b border-border pb-6 space-y-3">
          <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
            Sarv LLM
          </h3>
          {sarvAccount ? (
            <>
              <div className="flex items-center gap-3 p-4 bg-green-500/10 border border-green-500/20 rounded-lg">
                <div className="p-2 bg-green-500/20 rounded-full">
                  <Sparkles className="h-5 w-5 text-green-500" />
                </div>
                <div className="flex-1">
                  <div className="font-medium text-green-700 dark:text-green-400">
                    Connected as {sarvAccount.displayName || sarvAccount.email}
                  </div>
                  <div className="text-sm text-muted-foreground">
                    Access tokens refresh automatically; stored in the OS keychain.
                  </div>
                </div>
                <button
                  onClick={handleSarvSignOut}
                  className="flex items-center gap-2 px-3 py-1.5 text-sm text-destructive hover:bg-destructive/10 rounded-md transition-colors"
                >
                  <Trash2 className="h-4 w-4" />
                  Sign out
                </button>
              </div>

              {/* Zone → Provider → Model picker */}
              <div className="p-4 bg-muted/30 border border-border rounded-lg max-w-xl">
                <div className="text-sm font-medium mb-3">Add a Sarv LLM model</div>
                {/* Gate on the CATALOG, not on zones: no zone is a normal
                    state for an account without an org, and the old
                    zone-length gate hid the whole picker (and claimed CAI
                    setup was unfinished) even when providers were fetchable. */}
                {!caiZonesResolved || (pickerLoading && caiProviders.length === 0) ? (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Loading your Sarv AI catalog...
                  </div>
                ) : caiProviders.length === 0 ? (
                  <div className="text-sm text-muted-foreground">
                    No LLM providers available on your Sarv account yet. Finish CAI setup in the Sarv dashboard.
                  </div>
                ) : (
                  <div className="space-y-3">
                    {caiZones.length > 1 && (
                      <div>
                        <label className="block text-xs font-medium mb-1 text-muted-foreground">
                          Region
                        </label>
                        <select
                          value={pickerZoneCode}
                          onChange={(e) => setPickerZoneCode(e.target.value)}
                          className="w-full px-3 py-2 bg-background border border-input rounded-md focus:outline-none focus:ring-2 focus:ring-ring text-sm"
                        >
                          {caiZones.map((z) => (
                            <option key={z.code} value={z.code}>
                              {[z.name || z.code, z.city].filter(Boolean).join(' · ')}
                              {z.is_default ? ' (default)' : ''}
                            </option>
                          ))}
                        </select>
                      </div>
                    )}
                    <div>
                      <label className="block text-xs font-medium mb-1 text-muted-foreground">
                        Provider
                      </label>
                      <select
                        value={pickerProviderCode}
                        onChange={(e) => setPickerProviderCode(e.target.value)}
                        disabled={pickerLoading || caiProviders.length === 0}
                        className="w-full px-3 py-2 bg-background border border-input rounded-md focus:outline-none focus:ring-2 focus:ring-ring text-sm disabled:opacity-50"
                      >
                        {caiProviders.length === 0 ? (
                          <option value="">
                            {pickerLoading ? 'Loading providers...' : 'No providers for this zone'}
                          </option>
                        ) : (
                          caiProviders.map((p) => (
                            <option key={p.code} value={p.code}>
                              {p.name || p.code}
                            </option>
                          ))
                        )}
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs font-medium mb-1 text-muted-foreground">
                        Model
                      </label>
                      <select
                        value={pickerModelCode}
                        onChange={(e) => setPickerModelCode(e.target.value)}
                        disabled={pickerLoading || caiModels.length === 0}
                        className="w-full px-3 py-2 bg-background border border-input rounded-md focus:outline-none focus:ring-2 focus:ring-ring text-sm disabled:opacity-50"
                      >
                        {caiModels.length === 0 ? (
                          <option value="">
                            {pickerLoading ? 'Loading models...' : 'No models available'}
                          </option>
                        ) : (
                          caiModels.map((m) => (
                            <option key={m.code} value={m.code}>
                              {m.display_name || m.code}
                            </option>
                          ))
                        )}
                      </select>
                    </div>
                    <button
                      onClick={handleAddSarvModel}
                      disabled={!pickerProviderCode || !pickerModelCode || pickerLoading || sarvAlreadyAdded}
                      className="flex items-center gap-2 px-4 py-2 text-sm bg-primary text-primary-foreground rounded-md hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                    >
                      <Plus className="h-4 w-4" />
                      {sarvAlreadyAdded ? 'Already added' : 'Add to AI providers'}
                    </button>
                  </div>
                )}
              </div>
            </>
          ) : (
            <div className="space-y-2 max-w-md">
              <button
                onClick={handleSarvSignIn}
                disabled={sarvSigningIn}
                className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-background border border-input rounded-md hover:bg-accent disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {sarvSigningIn ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Sparkles className="h-4 w-4" />
                )}
                <span className="text-sm font-medium">Sign in with Sarv</span>
              </button>
              <p className="text-xs text-muted-foreground">
                Uses OAuth 2.1 + PKCE. No API key to paste — your Sarv wallet is charged directly.
              </p>
            </div>
          )}

          {sarvError && (
            <div className="flex items-start gap-2 p-3 bg-destructive/10 border border-destructive/20 rounded-md text-sm text-destructive">
              <X className="h-4 w-4 flex-shrink-0 mt-0.5" />
              {sarvError}
            </div>
          )}
        </div>
      )}

      {/* AI Providers */}
      <div className="border-b border-border pb-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
            AI Providers
          </h3>
          <button
            onClick={() => {
              setShowAddProvider(true);
              setNewProviderModel(PROVIDER_CONFIGS[newProviderType].models[0]?.id || '');
            }}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-primary text-primary-foreground rounded-md hover:bg-primary/90 transition-colors"
          >
            <Plus className="h-4 w-4" />
            Add Provider
          </button>
        </div>

        {/* Existing Providers List */}
        {aiProviders.length === 0 ? (
          <div className="flex items-center justify-center p-8 bg-muted/30 rounded-lg border border-dashed border-border">
            <div className="text-center">
              <div className="text-muted-foreground mb-2">No AI providers configured</div>
              <div className="text-sm text-muted-foreground">Add a provider to enable AI features like Polish Email</div>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            {aiProviders.map((provider) => (
              <div
                key={provider.id}
                className={`flex items-center justify-between p-4 rounded-lg border ${
                  provider.isDefault ? 'border-primary bg-primary/5' : 'border-border bg-muted/30'
                }`}
              >
                <div className="flex items-center gap-3">
                  {provider.isDefault && (
                    <Star className="h-4 w-4 text-primary fill-primary" />
                  )}
                  <div>
                    <div className="font-medium flex items-center gap-2">
                      {provider.name}
                      {provider.isDefault && (
                        <span className="text-xs px-2 py-0.5 bg-primary/20 text-primary rounded-full">Default</span>
                      )}
                    </div>
                    <div className="text-sm text-muted-foreground">
                      Model: {PROVIDER_CONFIGS[provider.type]?.models?.find(m => m.id === provider.model)?.name || provider.model}
                    </div>
                    {provider.baseUrl && (
                      <div className="text-xs text-muted-foreground font-mono mt-0.5">
                        {provider.baseUrl}
                      </div>
                    )}
                    <div className="text-xs text-muted-foreground font-mono mt-0.5">
                      Key: {provider.apiKey.slice(0, 8)}...{provider.apiKey.slice(-4)}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {/* Test Result */}
                  {testResult?.id === provider.id && (
                    <span className={`text-xs px-2 py-1 rounded ${
                      testResult.success
                        ? 'bg-green-500/20 text-green-600'
                        : 'bg-destructive/20 text-destructive'
                    }`}>
                      {testResult.message}
                    </span>
                  )}

                  {/* Test Button */}
                  <button
                    onClick={() => handleTestProvider(provider)}
                    disabled={testingProviderId === provider.id}
                    className="px-3 py-1.5 text-sm border border-border rounded-md hover:bg-accent transition-colors disabled:opacity-50"
                    title="Test connection"
                  >
                    {testingProviderId === provider.id ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      'Test'
                    )}
                  </button>

                  {/* Edit Button */}
                  <button
                    onClick={() => handleEditProvider(provider)}
                    className="p-1.5 border border-border rounded-md hover:bg-accent transition-colors"
                    title="Edit provider"
                  >
                    <Pencil className="h-4 w-4" />
                  </button>

                  {!provider.isDefault && (
                    <button
                      onClick={() => handleSetDefaultProvider(provider.id)}
                      className="px-3 py-1.5 text-sm border border-border rounded-md hover:bg-accent transition-colors"
                      title="Set as default"
                    >
                      Default
                    </button>
                  )}
                  <button
                    onClick={() => handleRemoveProvider(provider.id)}
                    className="p-1.5 text-destructive hover:bg-destructive/10 rounded-md transition-colors"
                    title="Remove provider"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Edit Provider Form */}
        {editingProvider && (
          <div className="mt-4 p-4 bg-muted/50 rounded-lg border border-border">
            <h4 className="font-medium mb-4">Edit {editingProvider.name}</h4>
            <div className="space-y-4">
              {editingProvider.type === 'custom' && (
                <div>
                  <label className="block text-sm font-medium mb-1">Provider Name</label>
                  <input
                    type="text"
                    value={editingProvider.name}
                    onChange={(e) => setEditingProvider(prev => prev ? { ...prev, name: e.target.value } : null)}
                    className="w-full px-3 py-2 bg-background border border-input rounded-md text-sm"
                  />
                </div>
              )}

              {editingProvider.type === 'custom' && (
                <div>
                  <label className="block text-sm font-medium mb-1">API Base URL</label>
                  <input
                    type="text"
                    value={editingProvider.baseUrl || ''}
                    onChange={(e) => setEditingProvider(prev => prev ? { ...prev, baseUrl: e.target.value } : null)}
                    className="w-full px-3 py-2 bg-background border border-input rounded-md text-sm font-mono"
                  />
                </div>
              )}

              <div>
                <label className="block text-sm font-medium mb-1">API Key</label>
                <div className="relative">
                  <input
                    type={showNewApiKey ? 'text' : 'password'}
                    value={editingProvider.apiKey}
                    onChange={(e) => setEditingProvider(prev => prev ? { ...prev, apiKey: e.target.value } : null)}
                    className="w-full px-3 py-2 pr-10 bg-background border border-input rounded-md text-sm font-mono"
                  />
                  <button
                    type="button"
                    onClick={() => setShowNewApiKey(!showNewApiKey)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-muted-foreground hover:text-foreground"
                  >
                    {showNewApiKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium mb-1">Model</label>
                {editingProvider.type === 'custom' || !PROVIDER_CONFIGS[editingProvider.type]?.models?.length ? (
                  <input
                    type="text"
                    value={editingProvider.model}
                    onChange={(e) => setEditingProvider(prev => prev ? { ...prev, model: e.target.value } : null)}
                    placeholder="Model name"
                    className="w-full px-3 py-2 bg-background border border-input rounded-md text-sm font-mono"
                  />
                ) : (
                  <select
                    value={editingProvider.model}
                    onChange={(e) => setEditingProvider(prev => prev ? { ...prev, model: e.target.value } : null)}
                    className="w-full px-3 py-2 bg-background border border-input rounded-md text-sm"
                  >
                    {PROVIDER_CONFIGS[editingProvider.type].models.map((model) => (
                      <option key={model.id} value={model.id}>
                        {model.name}
                      </option>
                    ))}
                  </select>
                )}
              </div>

              <div className="flex items-center gap-2 pt-2">
                <button
                  onClick={handleSaveEditProvider}
                  disabled={!editingProvider.apiKey || !editingProvider.model}
                  className="px-4 py-2 bg-primary text-primary-foreground rounded-md hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed text-sm font-medium"
                >
                  Save Changes
                </button>
                <button
                  onClick={() => setEditingProvider(null)}
                  className="px-4 py-2 text-sm text-muted-foreground hover:text-foreground hover:bg-accent rounded-md transition-colors"
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Add Provider Form */}
        {showAddProvider && (
          <div className="mt-4 p-4 bg-muted/50 rounded-lg border border-border">
            <h4 className="font-medium mb-4">Add New Provider</h4>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium mb-1">Provider</label>
                <select
                  value={newProviderType}
                  onChange={(e) => {
                    const type = e.target.value as AIProviderType;
                    setNewProviderType(type);
                    if (type === 'custom') {
                      setNewProviderModel('');
                      setNewProviderName('');
                      setNewProviderBaseUrl('');
                    } else {
                      setNewProviderModel(PROVIDER_CONFIGS[type].models[0]?.id || '');
                      setNewProviderName('');
                      setNewProviderBaseUrl('');
                    }
                  }}
                  className="w-full px-3 py-2 bg-background border border-input rounded-md text-sm"
                >
                  <option value="openai">OpenAI</option>
                  <option value="gemini">Google Gemini</option>
                  <option value="sarv">Sarv AI</option>
                  <option value="custom">Custom (OpenAI-compatible)</option>
                </select>
              </div>

              {newProviderType === 'custom' && (
                <>
                  <div>
                    <label className="block text-sm font-medium mb-1">Provider Name</label>
                    <input
                      type="text"
                      value={newProviderName}
                      onChange={(e) => setNewProviderName(e.target.value)}
                      placeholder="e.g. Ollama, Together AI, Groq..."
                      className="w-full px-3 py-2 bg-background border border-input rounded-md text-sm"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium mb-1">API Base URL</label>
                    <input
                      type="text"
                      value={newProviderBaseUrl}
                      onChange={(e) => setNewProviderBaseUrl(e.target.value)}
                      placeholder="e.g. https://api.together.xyz/v1"
                      className="w-full px-3 py-2 bg-background border border-input rounded-md text-sm font-mono"
                    />
                    <p className="mt-1 text-xs text-muted-foreground">
                      Must be OpenAI-compatible. The /chat/completions endpoint will be used.
                    </p>
                  </div>
                </>
              )}

              <div>
                <label className="block text-sm font-medium mb-1">API Key</label>
                <div className="relative">
                  <input
                    type={showNewApiKey ? 'text' : 'password'}
                    value={newProviderApiKey}
                    onChange={(e) => setNewProviderApiKey(e.target.value)}
                    placeholder={newProviderType === 'openai' ? 'sk-...' : 'Enter API key'}
                    className="w-full px-3 py-2 pr-10 bg-background border border-input rounded-md text-sm font-mono"
                  />
                  <button
                    type="button"
                    onClick={() => setShowNewApiKey(!showNewApiKey)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-muted-foreground hover:text-foreground"
                  >
                    {showNewApiKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium mb-1">Model</label>
                {newProviderType === 'custom' ? (
                  <input
                    type="text"
                    value={newProviderModel}
                    onChange={(e) => setNewProviderModel(e.target.value)}
                    placeholder="e.g. llama-3.1-70b, mixtral-8x7b..."
                    className="w-full px-3 py-2 bg-background border border-input rounded-md text-sm font-mono"
                  />
                ) : (
                  <select
                    value={newProviderModel}
                    onChange={(e) => setNewProviderModel(e.target.value)}
                    className="w-full px-3 py-2 bg-background border border-input rounded-md text-sm"
                  >
                    {PROVIDER_CONFIGS[newProviderType].models.map((model) => (
                      <option key={model.id} value={model.id}>
                        {model.name}
                      </option>
                    ))}
                  </select>
                )}
              </div>

              {newProviderType === 'sarv' && (
                <div className="p-3 bg-blue-500/10 border border-blue-500/20 rounded-md text-sm">
                  <div className="font-medium text-blue-600 dark:text-blue-400">Sarv AI</div>
                  <div className="text-muted-foreground mt-1">
                    OpenAI-compatible API at ai.sarv.com
                  </div>
                </div>
              )}

              {newProviderType === 'custom' && (
                <div className="p-3 bg-blue-500/10 border border-blue-500/20 rounded-md text-sm">
                  <div className="font-medium text-blue-600 dark:text-blue-400">Custom Provider</div>
                  <div className="text-muted-foreground mt-1">
                    Any OpenAI-compatible API (Ollama, LM Studio, Together AI, Groq, etc.)
                    will work. Just provide the base URL and model name.
                  </div>
                </div>
              )}

              <div className="flex items-center gap-2 pt-2">
                <button
                  onClick={handleAddProvider}
                  disabled={
                    !newProviderApiKey || !newProviderModel ||
                    (newProviderType === 'custom' && (!newProviderName || !newProviderBaseUrl))
                  }
                  className="px-4 py-2 bg-primary text-primary-foreground rounded-md hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed text-sm font-medium"
                >
                  Add Provider
                </button>
                <button
                  onClick={() => {
                    setShowAddProvider(false);
                    setNewProviderApiKey('');
                    setNewProviderModel('');
                    setNewProviderName('');
                    setNewProviderBaseUrl('');
                  }}
                  className="px-4 py-2 text-sm text-muted-foreground hover:text-foreground hover:bg-accent rounded-md transition-colors"
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Manual AI Features Info */}
      <div className="pb-6">
        <h3 className="text-sm font-semibold mb-4 text-muted-foreground uppercase tracking-wider">
          Manual AI Features
        </h3>
        <div className="space-y-3 text-sm">
          <div className="flex items-start gap-3 p-3 bg-muted/50 rounded-lg">
            <div className={`w-2 h-2 mt-1.5 rounded-full ${aiProviders.length > 0 ? 'bg-green-500' : 'bg-muted-foreground'}`} />
            <div>
              <div className="font-medium">Polish Email</div>
              <div className="text-muted-foreground">AI-powered email rewriting and improvement</div>
            </div>
          </div>
          <div className="flex items-start gap-3 p-3 bg-muted/50 rounded-lg">
            <div className="w-2 h-2 mt-1.5 rounded-full bg-muted-foreground" />
            <div>
              <div className="font-medium">Email Summarization</div>
              <div className="text-muted-foreground">Get quick summaries of long email threads (Coming Soon)</div>
            </div>
          </div>
          <div className="flex items-start gap-3 p-3 bg-muted/50 rounded-lg">
            <div className="w-2 h-2 mt-1.5 rounded-full bg-muted-foreground" />
            <div>
              <div className="font-medium">Smart Reply</div>
              <div className="text-muted-foreground">Generate contextual reply suggestions (Coming Soon)</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
