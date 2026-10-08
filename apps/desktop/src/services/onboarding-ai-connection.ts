import { aiFailureReason, aiProviderFetch, PROVIDER_CONFIGS, type AIProvider, type AIProviderType } from './ai-service';
import {
  buildSarvEdgeBaseUrl, listCaiModels, listCaiProviders, loadZoneSelection, pickRecommendedModel, pickRecommendedProvider,
  type SarvLLMModel, type SarvLLMProvider, type SarvZone,
} from './sarv-cai-api';
import { buildSarvProviderDraft } from './sarv-llm-provider';

export interface OnboardingModel { id: string; name: string }
export interface SarvConnection {
  email: string;
  apiBaseUrl: string;
  edgeBaseUrl: string;
  accounts: Array<{ email: string; displayName?: string }>;
  zones: SarvZone[];
  zoneCode: string;
  providers: SarvLLMProvider[];
  providerCode: string;
  models: SarvLLMModel[];
}

export interface OnboardingAIConnection {
  type: AIProviderType;
  name: string;
  baseUrl: string;
  apiKey: string;
  authMethod: 'apiKey' | 'oauth';
  useApiKey: boolean;
  model: string;
  models: OnboardingModel[];
  verified: boolean;
  manualModel: boolean;
  sarv?: SarvConnection;
  /** An explicit settings edit restores this identity before choosing defaults. */
  savedSarvProvider?: Pick<AIProvider, 'name' | 'baseUrl' | 'model' | 'oauthEmail' | 'sarvZoneCode' | 'sarvProviderCode'>;
  modelWarning?: string;
  /**
   * Resumed from a saved provider whose key is in the vault. With the key field
   * left blank, requests use that saved key — through main, which only sends
   * it to the address it was saved for. The renderer never holds it.
   */
  storedProviderId?: string;
}

export function makeAIConnection(type: AIProviderType): OnboardingAIConnection {
  return {
    type, name: PROVIDER_CONFIGS[type].name, baseUrl: PROVIDER_CONFIGS[type].baseUrl,
    apiKey: '', authMethod: type === 'sarv' ? 'oauth' : 'apiKey', useApiKey: true, model: '', models: [],
    verified: false, manualModel: false,
  };
}

/** Endpoint rules apply before any credentials leave the device. */
export function normalizeAIEndpoint(endpoint: string): string {
  let url: URL;
  try { url = new URL(endpoint.trim()); } catch { throw new Error('Enter a complete API endpoint URL.'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('Use an HTTPS API endpoint. HTTP is supported only for a local model server.');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('The API endpoint must not include a password, query string or fragment.');
  }
  return url.toString().replace(/\/+$/, '');
}

export function providerFromConnection(connection: OnboardingAIConnection): AIProvider {
  if (connection.authMethod === 'oauth') {
    const sarv = connection.sarv;
    if (!sarv) throw new Error('Connect your Sarv account first.');
    const result = buildSarvProviderDraft({
      email: sarv.email, providerCode: sarv.providerCode, modelCode: connection.model,
      zoneCode: sarv.zoneCode, providers: sarv.providers, models: sarv.models,
      zones: sarv.zones, fallbackEdgeBaseUrl: sarv.edgeBaseUrl,
    });
    if (!result.ok) throw new Error('Choose an available Sarv model and connection before continuing.');
    return {
      id: 'onboarding-test', type: 'sarv', name: result.draft.name, model: connection.model,
      baseUrl: normalizeAIEndpoint(result.draft.baseUrl), apiKey: '', isDefault: false,
      authMethod: 'oauth', oauthProvider: 'sarv', oauthEmail: sarv.email,
      sarvZoneCode: sarv.zoneCode, sarvProviderCode: sarv.providerCode,
    };
  }
  const typedKey = connection.useApiKey ? connection.apiKey.trim() : '';
  const savedKey = connection.useApiKey && !typedKey && !!connection.storedProviderId;
  return {
    id: savedKey ? connection.storedProviderId! : 'onboarding-test', type: connection.type, name: connection.name.trim(),
    baseUrl: normalizeAIEndpoint(connection.baseUrl), apiKey: typedKey,
    model: connection.model.trim(), isDefault: false, authMethod: 'apiKey',
    ...(savedKey ? { hasStoredKey: true } : {}),
  };
}

/** Config validation lists models, without generating text or sending mail. */
export async function checkAIConnection(
  connection: OnboardingAIConnection, signal: AbortSignal,
): Promise<OnboardingAIConnection> {
  const baseUrl = normalizeAIEndpoint(connection.baseUrl);
  if (!connection.name.trim()) throw new Error('Enter a name for your AI provider.');
  if (connection.useApiKey && !connection.apiKey.trim() && !connection.storedProviderId) throw new Error('Enter your API key.');
  // Typed key, saved key (via main) or none — aiProviderFetch attaches the right one.
  const provider = providerFromConnection({ ...connection, baseUrl, model: connection.model || 'catalog' });
  const headers: Record<string, string> = { Accept: 'application/json' };
  const models: OnboardingModel[] = [];
  let pageToken = '';
  for (let page = 0; page < 20; page++) {
    const suffix = pageToken ? `?pageToken=${encodeURIComponent(pageToken)}` : '';
    const response = await aiProviderFetch(provider, `${baseUrl}/models${suffix}`, { method: 'GET', headers, signal });
    // Some local OpenAI-compatible servers support generation but no catalog.
    // They still need a specific model test; an auth/network failure never
    // masquerades as a successful connection or fallback.
    if ((response.status === 404 || response.status === 405) && connection.type === 'custom') {
      return { ...connection, baseUrl, verified: true, models: [], manualModel: true };
    }
    if (!response.ok) throw new Error(aiFailureReason(response.status));
    let body: {
      data?: Array<{ id?: string }>;
      models?: Array<{ name?: string; displayName?: string; supportedGenerationMethods?: string[] }>;
      nextPageToken?: string;
    };
    try { body = await response.json() as typeof body; }
    catch { throw new Error('The provider returned an invalid model catalog.'); }
    if (!body || typeof body !== 'object') throw new Error('The provider returned an invalid model catalog.');
    if (connection.type === 'gemini') {
      if (!Array.isArray(body.models)) throw new Error('The provider returned an invalid model catalog.');
      for (const model of body.models) {
        if (model.name && model.supportedGenerationMethods?.includes('generateContent')) {
          models.push({ id: model.name.replace(/^models\//, ''), name: model.displayName || model.name });
        }
      }
      pageToken = body.nextPageToken || '';
      if (pageToken && page === 19) throw new Error('The model catalog is too large. Please try again.');
      if (pageToken) continue;
    } else {
      if (!Array.isArray(body.data)) throw new Error('The provider returned an invalid model catalog.');
      for (const model of body.data) {
        if (!model.id) continue;
        // OpenAI exposes non-chat assets in the same endpoint. The supported
        // families below match this app's chat-completions integration.
        if (connection.type === 'openai'
          && (!/^(gpt-|chatgpt-|o\d)/.test(model.id) || /audio|realtime|transcribe|tts/.test(model.id))) continue;
        models.push({ id: model.id, name: model.id });
      }
    }
    break;
  }
  signal.throwIfAborted();
  if (!models.length) throw new Error('No supported models are available with this connection.');
  const unique = [...new Map(models.map((model) => [model.id, model])).values()];
  return {
    ...connection, baseUrl, verified: true, models: unique, manualModel: false,
    model: unique.some((model) => model.id === connection.model) ? connection.model : '',
  };
}

/** Reuse native Sarv identity; selecting Sarv email never repeats OAuth. */
export async function loadSarvAIConnection(
  previous: OnboardingAIConnection, signal: AbortSignal,
  selection?: { email?: string; zoneCode?: string; providerCode?: string },
): Promise<OnboardingAIConnection> {
  const [providerResult, accountResult] = await Promise.all([
    window.electronAPI.oauth.listProviders(), window.electronAPI.oauth.listAccounts(),
  ]);
  signal.throwIfAborted();
  if (!providerResult.success || !accountResult.success) throw new Error('Could not check your Sarv connection. Please try again.');
  const config = providerResult.data?.find((provider) => provider.id === 'sarv');
  const accounts = accountResult.data?.filter((account) => account.provider === 'sarv') || [];
  const selectedEmail = selection?.email || previous.sarv?.email;
  const account = selectedEmail ? accounts.find((entry) => entry.email.toLowerCase() === selectedEmail.toLowerCase()) : accounts[0];
  if (!account) throw new Error('Sign in with Sarv to connect AI.');
  if (!config?.apiBaseUrl || !config.llmBaseUrl) throw new Error('Sarv AI is unavailable in this app configuration.');
  const zoneSelection = await loadZoneSelection(config.apiBaseUrl, account.email);
  signal.throwIfAborted();
  const saved = !previous.sarv && previous.savedSarvProvider?.oauthEmail?.toLowerCase() === account.email.toLowerCase()
    ? previous.savedSarvProvider : undefined;
  const savedZones = saved?.baseUrl ? zoneSelection.zones.filter((zone) =>
    normalizeAIEndpoint(buildSarvEdgeBaseUrl(zone.api_domain, config.llmBaseUrl)) === normalizeAIEndpoint(saved.baseUrl!),
  ) : [];
  const savedZone = savedZones.find((zone) => zone.code === saved?.sarvZoneCode) || savedZones[0];
  const previousZone = previous.sarv?.email === account.email ? previous.sarv.zoneCode : undefined;
  const protectedZone = previousZone ?? saved?.sarvZoneCode;
  if (protectedZone && !selection?.zoneCode && zoneSelection.zones.length
    && !zoneSelection.zones.some((zone) => zone.code === protectedZone)) {
    throw new Error('Your saved Sarv region is no longer available. Choose a new Sarv connection to continue.');
  }
  const zoneCode = selection?.zoneCode
    ?? previousZone
    ?? saved?.sarvZoneCode
    ?? savedZone?.code
    ?? (saved ? '' : zoneSelection.zoneCode);
  const providers = await listCaiProviders(config.apiBaseUrl, account.email, zoneCode);
  signal.throwIfAborted();
  if (!providers.length) throw new Error('No AI backends are available on your Sarv account.');
  const protectedBackend = previous.sarv?.email === account.email ? previous.sarv.providerCode : saved?.sarvProviderCode;
  const oldCode = selection?.providerCode ?? protectedBackend;
  if (protectedBackend && !selection?.providerCode && !providers.some((entry) => entry.code === protectedBackend)) {
    throw new Error('Your saved Sarv backend is no longer available. Choose a new Sarv connection to continue.');
  }
  let providerCode = providers.find((entry) => entry.code === oldCode)?.code || pickRecommendedProvider(providers)!.code;
  let models: SarvLLMModel[];
  if (saved && !selection?.providerCode && !providers.some((entry) => entry.code === oldCode)) {
    // Older entries did not store a backend code. Restore their model's backend,
    // preferring the exact generated name if the same model appears twice.
    const ordered = [...providers].sort((left, right) => Number(saved.name.startsWith(`Sarv · ${right.name} · `)) - Number(saved.name.startsWith(`Sarv · ${left.name} · `)));
    let restored: { code: string; models: SarvLLMModel[] } | undefined;
    let available: { code: string; models: SarvLLMModel[] } | undefined;
    for (const provider of ordered) {
      const catalog = await listCaiModels(config.apiBaseUrl, account.email, provider.code, zoneCode);
      signal.throwIfAborted();
      if (!available && catalog.length) available = { code: provider.code, models: catalog };
      if (!catalog.some((model) => model.code === saved.model)) continue;
      restored = { code: provider.code, models: catalog };
      break;
    }
    const result = restored || available;
    if (!result) throw new Error('No models are available for this Sarv backend. Choose another backend or try again.');
    providerCode = result.code;
    models = result.models;
  } else models = await listCaiModels(config.apiBaseUrl, account.email, providerCode, zoneCode);
  signal.throwIfAborted();
  if (!models.length) throw new Error('No models are available for this Sarv backend. Choose another backend or try again.');
  const sarv: SarvConnection = {
    email: account.email, apiBaseUrl: config.apiBaseUrl, edgeBaseUrl: previous.sarv?.email === account.email ? previous.sarv.edgeBaseUrl : saved?.baseUrl || config.llmBaseUrl,
    accounts, zones: zoneSelection.zones, zoneCode, providers, providerCode, models,
  };
  const sameConnection = previous.sarv?.email === account.email && previous.sarv.zoneCode === zoneCode && previous.sarv.providerCode === providerCode;
  const missingSavedModel = (Boolean(previous.model) && !models.some((entry) => entry.code === previous.model)
    || Boolean(previous.modelWarning) && !previous.model)
    && (Boolean(saved) && !selection?.providerCode || sameConnection);
  const model = missingSavedModel ? '' : models.some((entry) => entry.code === previous.model)
    ? previous.model : pickRecommendedModel(models, providerCode)?.code || '';
  const connection: OnboardingAIConnection = {
    ...previous, authMethod: 'oauth', model, verified: true, sarv,
    models: models.map((entry) => ({ id: entry.code, name: entry.display_name || entry.code })),
    modelWarning: missingSavedModel ? 'Your previous model is no longer available. Choose an available model before saving.' : undefined,
  };
  // Validate that there is an edge endpoint before offering a valid selection.
  providerFromConnection({ ...connection, model: model || models[0].code });
  return connection;
}
