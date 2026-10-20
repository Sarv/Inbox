/**
 * Turn an AI provider config from the renderer (or from disk) into one main can
 * call with. The renderer never holds a saved API key, so its configs name the
 * provider by `providerId` with an empty `apiKey`; main fills the key in from
 * the vault — only for the endpoint origin it was saved for (`resolveAiKey`) —
 * then attaches the OAuth bearer resolver for OAuth-backed providers.
 */
import { createLogger, effectiveAIBaseUrl } from '@sarvinbox/core';

import { resolveAiKey } from './ai-secret-store';
import { attachOAuthBearer } from './oauth-service';

const logger = createLogger('ai-provider-config');

export interface AIProviderConfigInput {
  type: string;
  apiKey: string;
  baseUrl?: string;
  authMethod?: 'apiKey' | 'oauth';
  oauthProvider?: string;
  oauthEmail?: string;
  /** The renderer's provider id — names the saved key without carrying it. */
  providerId?: string;
}

export async function prepareAIProviderConfig<C extends AIProviderConfigInput>(config: C): Promise<C> {
  let prepared = config;
  if (config && config.authMethod !== 'oauth' && !config.apiKey && config.providerId) {
    const saved = await resolveAiKey(config.providerId, effectiveAIBaseUrl(config)).catch((error: Error) => {
      logger.warn(`[AiConfig] could not read the saved key for ${config.providerId}: ${error.message}`);
      return { status: 'none' } as const;
    });
    if (saved.status === 'found') prepared = { ...config, apiKey: saved.key };
    else logger.warn(`[AiConfig] no usable saved key for ${config.providerId} (${saved.status}); requests will be unauthenticated`);
  }
  return attachOAuthBearer(prepared as Parameters<typeof attachOAuthBearer>[0]) as C;
}
