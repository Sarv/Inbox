import { loadAgentSettings, pushAgentSettingsToBackend, pushAgentSettingsToBackendStrict, saveAgentSettings } from './agent-settings';
import { getDefaultProvider } from './ai-service';

/** Pause background mail processing while the first-run model/consent choice is open. */
export function suspendOnboardingAI(): void {
  const settings = { ...loadAgentSettings(), enabled: false };
  saveAgentSettings(settings);
  pushAgentSettingsToBackend(settings);
  void window.electronAPI?.ai?.setProviderConfigured?.(false).catch(() => {});
}

/** Skip keeps provider credentials intact, but must not leave automatic AI running. */
export async function applyOnboardingAIChoice(enabled: boolean): Promise<void> {
  const api = window.electronAPI;
  if (!api?.ai?.setProviderConfigured || !api.agent?.setConfig || !api.agent?.setAIConfig) {
    throw new Error('AI setup is unavailable. Restart Inbox and try again.');
  }
  try {
    if (enabled) {
      const provider = getDefaultProvider();
      if (!provider) throw new Error('Choose and test an AI model before enabling AI.');
      const configured = await api.agent.setAIConfig({
        type: provider.type, apiKey: provider.apiKey, providerId: provider.id, model: provider.model, baseUrl: provider.baseUrl,
        authMethod: provider.authMethod, oauthProvider: provider.oauthProvider, oauthEmail: provider.oauthEmail,
      });
      if (!configured.success) throw new Error('Could not save the AI connection.');
    }
    const configured = await api.ai.setProviderConfigured(enabled);
    if (!configured.success) throw new Error('Could not update AI availability.');
    const settings = { ...loadAgentSettings(), enabled };
    saveAgentSettings(settings, { strict: true });
    await pushAgentSettingsToBackendStrict(settings);
  } catch (error) {
    suspendOnboardingAI();
    throw error;
  }
}
