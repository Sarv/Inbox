import { isLoopbackHost } from './loopback';

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

/** Why an AI provider address was refused. */
export type AIEndpointRefusal = 'invalid' | 'insecure' | 'credentials';

/** What the user is told about each refusal. */
export const AI_ENDPOINT_REFUSALS: Readonly<Record<AIEndpointRefusal, string>> = {
  invalid: 'AI provider address is missing or is not a web address.',
  insecure: 'AI provider address must use HTTPS. Plain HTTP is allowed only for a model server on this computer.',
  credentials: 'AI provider address must not include a username or password.',
};

export type AIEndpointCheck =
  | { ok: true; url: URL; origin: string }
  | { ok: false; reason: AIEndpointRefusal; message: string };

/**
 * The transport rule for every address an AI provider request goes to — the
 * renderer's endpoint field, main's key binding and proxy, and the background
 * categorizers all apply this one check:
 *  - HTTPS to any host;
 *  - plain HTTP only to this computer (`isLoopbackHost`), where a local model
 *    server runs and nothing crosses a network — mail text and API keys never
 *    travel unencrypted;
 *  - never a username or password in the URL.
 */
export function checkAIEndpoint(url: string | undefined | null): AIEndpointCheck {
  const refuse = (reason: AIEndpointRefusal): AIEndpointCheck => ({ ok: false, reason, message: AI_ENDPOINT_REFUSALS[reason] });
  if (typeof url !== 'string' || !url.trim()) return refuse('invalid');
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return refuse('invalid');
  }
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLoopbackHost(parsed.hostname))) {
    return refuse('insecure');
  }
  if (parsed.username || parsed.password) return refuse('credentials');
  return { ok: true, url: parsed, origin: parsed.origin };
}

/**
 * `host[:port]` of an AI provider address, whether or not it may be called —
 * for telling the user (or the log) where mail would go. Null when unparseable.
 */
export function aiEndpointHost(url: string | undefined | null): string | null {
  if (typeof url !== 'string') return null;
  try {
    return new URL(url.trim()).host || null;
  } catch {
    return null;
  }
}

/**
 * `scheme://host[:port]` of an AI endpoint main may call, or null when it may
 * not (`checkAIEndpoint`): not a URL, plain HTTP to another computer, or
 * credentials in the URL. Main's proxy and the stored-key binding refuse on null.
 */
export function aiEndpointOrigin(url: string | undefined | null): string | null {
  const check = checkAIEndpoint(url);
  return check.ok ? check.origin : null;
}

/**
 * The header that carries an API key for a provider type. Gemini takes it in
 * `x-goog-api-key` — never in the `?key=` query string, which ends up in logs
 * and error messages; everything else is an OpenAI-style Bearer token.
 */
export function aiApiKeyHeaders(type: string, apiKey: string): Record<string, string> {
  return type === 'gemini' ? { 'x-goog-api-key': apiKey } : { Authorization: `Bearer ${apiKey}` };
}
