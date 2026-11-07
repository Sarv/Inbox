import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `ai:setProviderConfigured(false)` does NOT mean the provider is gone: the app
 * also sends it whenever AI Assist is off (App.tsx, onboarding). The provider is
 * still there for what the user asks for directly, such as the Inbox Agent and
 * reply drafts, and those read main's live copy. Main hears "the last provider is
 * gone" on its own channel, `pipeline:clearAIConfig`.
 *
 * What breaks if this file fails: turning AI Assist off makes the Inbox Agent say
 * "Choose an AI provider" and reply drafts fail until the next mail sync.
 */

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...a: unknown[]) => unknown>(),
  calls: [] as string[],
}));

vi.mock('electron', () => ({
  ipcMain: { handle: (name: string, fn: (...a: unknown[]) => unknown) => h.handlers.set(name, fn) },
}));
vi.mock('../../../../electron/shared', () => ({ requireStorage: vi.fn() }));
vi.mock('../../../../electron/services/accounts-registry', () => ({ readRegistryAccounts: () => [] }));
vi.mock('../../../../electron/services/accounts-runtime', () => ({ ensureAccountRuntime: vi.fn() }));
vi.mock('../../../../electron/services/ai-backlog-cap', () => ({ getAutoBacklogCap: vi.fn(), setAutoBacklogCap: vi.fn() }));
vi.mock('../../../../electron/services/ai-secret-store', () => ({
  listAiSecretIds: vi.fn(), setAiSecret: vi.fn(), deleteAiSecret: vi.fn(), revertAiSecret: vi.fn(), isSecureStorageAvailable: vi.fn(), resolveAiKey: vi.fn(),
}));
vi.mock('../../../../electron/services/conversation-extraction-scheduler', () => ({
  setAIProviderConfigured: (configured: boolean) => { h.calls.push(`scheduler:${configured}`); },
  setBackgroundSplitEnabled: vi.fn(),
}));
vi.mock('../../../../electron/services/pipeline-ai-config-store', () => ({
  clearPipelineAIConfig: async () => { h.calls.push('saved-cleared'); },
}));
// No forget function here: reaching for one fails the test.
vi.mock('../../../../electron/services/unified-pipeline-service', () => ({
  onCategoryDefinitionUpserted: vi.fn(),
}));

import { registerAIHandlers } from '../../../../electron/ipc/ai-handlers';

registerAIHandlers();
const report = (configured: boolean) => h.handlers.get('ai:setProviderConfigured')!({}, configured);

beforeEach(() => { h.calls.length = 0; });

describe('ai:setProviderConfigured', () => {
  it('false stops the scheduler and clears the saved copy, and stays away from the live one', async () => {
    await expect(report(false)).resolves.toEqual({ success: true });
    expect(h.calls).toEqual(['scheduler:false', 'saved-cleared']);
  });

  it('true touches neither copy', async () => {
    await expect(report(true)).resolves.toEqual({ success: true });
    expect(h.calls).toEqual(['scheduler:true']);
  });
});
