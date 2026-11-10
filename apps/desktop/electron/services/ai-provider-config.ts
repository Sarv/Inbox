/**
 * Turn an AI provider config from the renderer (or from disk) into one main can
 * call with. The renderer never holds a saved API key, so its configs name the
 * provider by `providerId` with an empty `apiKey`; main fills the key in from
 * the vault — only for the endpoint origin it was saved for (`resolveAiKey`) —
 * then attaches the OAuth bearer resolver for OAuth-backed providers.
 *
 * It is also where main refuses an address the transport rule forbids
 * (`checkAIEndpoint`: HTTPS, or plain HTTP only to this computer). The renderer
 * applies the same rule when the user types an address, but a config can also
 * come from a provider saved by an older build, from disk, or from a renderer
 * that has been tampered with, and every one of them would send new mail there.
 */
import { aiEndpointHost, checkAIEndpoint, createLogger, effectiveAIBaseUrl, type AIEndpointRefusal } from '@sarvinbox/core';

import { getMainWindow } from '../shared';

import { pinAiSecretOrigin, resolveAiKey } from './ai-secret-store';
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

/**
 * Main will not send mail (or a key) to this provider's address. Its message is
 * the user-facing reason ("AI provider address must use HTTPS…"); callers
 * surface it through their own status/error channel rather than letting it
 * escape as a raw rejection.
 */
export class AIEndpointRefusedError extends Error {
  readonly reason: AIEndpointRefusal;
  constructor(reason: AIEndpointRefusal, message: string) {
    super(message);
    this.name = 'AIEndpointRefusedError';
    this.reason = reason;
  }
}

export function isAIEndpointRefusedError(error: unknown): error is AIEndpointRefusedError {
  return error instanceof AIEndpointRefusedError;
}

/**
 * Tell the renderer main refused the provider, on the channel its "AI inactive
 * / Fix" banner already listens to (terminal: retrying cannot fix an address).
 */
export function reportAIEndpointRefused(error: AIEndpointRefusedError): void {
  reportAIConfigRefused(error.message);
}

/** The same notice for any provider config main will not use. */
export function reportAIConfigRefused(reason: string): void {
  try {
    getMainWindow()?.webContents.send('ai-categorization:error', {
      message: reason, terminal: true, kind: 'client', reason,
    });
  } catch { /* window gone */ }
}

/**
 * @throws AIEndpointRefusedError when the provider's address is set but not one
 *   main may call. A provider with no address at all (a Custom or Sarv config
 *   missing its URL) is left to the call sites, which refuse it themselves.
 */
export async function prepareAIProviderConfig<C extends AIProviderConfigInput>(config: C): Promise<C> {
  const endpoint = config ? effectiveAIBaseUrl(config) : undefined;
  if (endpoint) {
    const check = checkAIEndpoint(endpoint);
    if (!check.ok) {
      // The host only — never the full URL, which can carry a path token.
      logger.warn(`[AiConfig] refused the ${config.type} provider at ${aiEndpointHost(endpoint) ?? 'an unparseable address'}: ${check.reason}`);
      // A key saved before keys were bound to an address would otherwise stay
      // unbound for good (this address can no longer bind it by use) and go to
      // the first address anything else names. Pin it here instead.
      if (config.authMethod !== 'oauth' && config.providerId) {
        await pinAiSecretOrigin(config.providerId, endpoint).catch((error: Error) => {
          logger.warn(`[AiConfig] could not pin the saved key for ${config.providerId}: ${error.message}`);
        });
      }
      throw new AIEndpointRefusedError(check.reason, check.message);
    }
  }
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
