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
