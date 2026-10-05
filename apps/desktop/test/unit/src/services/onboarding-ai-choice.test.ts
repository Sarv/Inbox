// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { loadAgentSettings, pushAgentSettingsToBackend, pushAgentSettingsToBackendStrict, saveAgentSettings } from '../../../../src/services/agent-settings';
import { getDefaultProvider } from '../../../../src/services/ai-service';
import { applyOnboardingAIChoice, suspendOnboardingAI } from '../../../../src/services/onboarding-ai-choice';

vi.mock('../../../../src/services/agent-settings', () => ({ loadAgentSettings: vi.fn(() => ({ enabled: true, autoReply: false })), saveAgentSettings: vi.fn(), pushAgentSettingsToBackend: vi.fn(), pushAgentSettingsToBackendStrict: vi.fn(async () => {}) }));
vi.mock('../../../../src/services/ai-service', () => ({ getDefaultProvider: vi.fn(() => ({ type: 'openai', model: 'tested-model', apiKey: 'synthetic-key' })) }));
const setProviderConfigured = vi.fn(async () => ({ success: true }));
const setAIConfig = vi.fn(async () => ({ success: true }));
beforeEach(() => { vi.clearAllMocks(); window.electronAPI = { ai: { setProviderConfigured }, agent: { setAIConfig, setConfig: vi.fn() } } as any; });
describe('onboarding AI activation', () => {
  it('pauses background processing while setup is open', () => {
    suspendOnboardingAI(); expect(saveAgentSettings).toHaveBeenCalledWith({ enabled: false, autoReply: false });
    expect(pushAgentSettingsToBackend).toHaveBeenCalledWith({ enabled: false, autoReply: false });
    expect(setProviderConfigured).toHaveBeenCalledWith(false);
  });
  it('keeps a pre-existing provider inactive when AI was skipped', async () => {
    await applyOnboardingAIChoice(false); expect(setAIConfig).not.toHaveBeenCalled();
    expect(saveAgentSettings).toHaveBeenCalledWith({ enabled: false, autoReply: false }, { strict: true });
    expect(setProviderConfigured).toHaveBeenCalledWith(false);
  });
  it('restores the tested provider before enabling the passive AI settings', async () => {
    vi.mocked(loadAgentSettings).mockReturnValueOnce({ enabled: false, autoReply: false } as any);
    await applyOnboardingAIChoice(true); expect(setAIConfig).toHaveBeenCalledOnce();
    expect(pushAgentSettingsToBackendStrict).toHaveBeenCalledWith({ enabled: true, autoReply: false });
    expect(setAIConfig.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(pushAgentSettingsToBackendStrict).mock.invocationCallOrder[0]);
  });
  it('does not claim completion if native provider configuration fails', async () => {
    setAIConfig.mockResolvedValueOnce({ success: false });
    await expect(applyOnboardingAIChoice(true)).rejects.toThrow('AI connection');
    expect(pushAgentSettingsToBackendStrict).not.toHaveBeenCalled();
    expect(setProviderConfigured).toHaveBeenCalledWith(false);
  });
  it('rolls back automatic processing if the settings push fails', async () => {
    vi.mocked(pushAgentSettingsToBackendStrict).mockRejectedValueOnce(new Error('IPC unavailable'));
    await expect(applyOnboardingAIChoice(true)).rejects.toThrow('IPC unavailable');
    expect(pushAgentSettingsToBackend).toHaveBeenLastCalledWith({ enabled: false, autoReply: false });
    expect(setProviderConfigured).toHaveBeenLastCalledWith(false);
  });
  it('rejects enablement with no tested provider', async () => {
    vi.mocked(getDefaultProvider).mockReturnValueOnce(null as any);
    await expect(applyOnboardingAIChoice(true)).rejects.toThrow('test an AI model');
    expect(setAIConfig).not.toHaveBeenCalled();
  });
});
