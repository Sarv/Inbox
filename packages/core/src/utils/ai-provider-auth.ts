/** Shared by onboarding, renderer AI and main-process categorization. */
export function buildAIAuthHeaders(
  provider: { type: string; authMethod?: string; resolveBearer?: unknown },
  bearer: unknown,
): Record<string, string> {
  if (typeof bearer === 'string' && bearer.trim()) return { Authorization: `Bearer ${bearer.trim()}` };
  // Selecting no authentication is supported only by Custom services. An
  // empty OAuth token must always remain an error, even for a custom endpoint.
  if (provider.type === 'custom' && provider.authMethod !== 'oauth' && !provider.resolveBearer
    && (bearer === '' || bearer === undefined || bearer === null)) return {};
  throw new Error(`empty bearer token for AI provider '${provider.type}': API key or OAuth token is missing.`);
}

/** Options for Chat Completions, restricted to each provider's supported fields. */
export function buildAIChatRequestOptions(
  provider: { type: string; model?: string },
): Record<string, unknown> {
  // Sarv's vLLM-backed models use this extension to avoid spending a
  // structured-output budget on inline thinking. OpenAI rejects the extension.
  if (provider.type === 'sarv') {
    return {
      chat_template_kwargs: { enable_thinking: false },
      reasoning_effort: 'minimal',
    };
  }
  // Reasoning support varies by model, including within the OpenAI families.
  // Leave those providers' defaults intact rather than guessing from a name.
  // The Responses API's `reasoning` object is not a Chat Completions parameter.
  return {};
}

/**
 * The endpoint each provider type uses when none is configured. The single
 * source for the renderer's provider presets, both main-process categorizers
 * and the stored-key binding (which must bind to the URL a request actually
 * goes to). Sarv and Custom have none: their base URL is always configured.
 */
export const AI_DEFAULT_BASE_URLS: Readonly<Record<string, string>> = {
  openai: 'https://api.openai.com/v1',
  gemini: 'https://generativelanguage.googleapis.com/v1beta',
};

/** The base URL a provider's requests go to: its own, else its type's default. */
export function effectiveAIBaseUrl(provider: { type: string; baseUrl?: string }): string | undefined {
  return provider.baseUrl || AI_DEFAULT_BASE_URLS[provider.type];
}

/** `scheme://host[:port]` of an endpoint URL, or null when it isn't one. */
export function aiEndpointOrigin(url: string | undefined | null): string | null {
  if (typeof url !== 'string' || !url.trim()) return null;
  try {
    const parsed = new URL(url.trim());
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

/**
 * The header that carries an API key for a provider type. Gemini takes it in
 * `x-goog-api-key` — never in the `?key=` query string, which ends up in logs
 * and error messages; everything else is an OpenAI-style Bearer token.
 */
export function aiApiKeyHeaders(type: string, apiKey: string): Record<string, string> {
  return type === 'gemini' ? { 'x-goog-api-key': apiKey } : { Authorization: `Bearer ${apiKey}` };
}
