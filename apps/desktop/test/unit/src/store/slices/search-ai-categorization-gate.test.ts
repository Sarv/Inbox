import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// CategoryBadges owns a renderer-only cache that helpers.ts touches; stub it so
// the module graph under test stays free of IPC/DOM side effects.
vi.mock('../../../../../src/components/email-list/CategoryBadges', () => ({
  clearCategoryBadgeCache: vi.fn(),
  applyEmailCategories: vi.fn(),
  getCachedCategorySlugs: vi.fn(() => []),
  warmCategoryDefs: vi.fn(),
}));

// The renderer's two categorization entry points. What breaks if this suite goes
// red: the "Start Processing" button sends mail to the AI provider while AI
// Assist (the one sorting switch) is off; or a value left behind by the removed
// "Smart Email Categorization" switch keeps blocking the button, or the
// provider handoff to the main-process pipeline, for users who once used it.

const store = new Map<string, string>();
const api = {
  aiCategorization: { start: vi.fn(async () => ({ success: true })) },
  agent: {
    setAIConfig: vi.fn(async () => ({ success: true })),
    setConfig: vi.fn(async () => ({ success: true })),
  },
};

const PROVIDER = { id: 'p1', name: 'Test', type: 'openai', apiKey: 'k', model: 'm', isDefault: true };
const OLD_SWITCH_OFF = JSON.stringify([{ id: 'email-categorization', enabled: false }]);

const loadSlice = async () => {
  vi.resetModules();
  const state: Record<string, unknown> = { aiProcessing: false };
  const set = vi.fn((patch: Record<string, unknown>) => { Object.assign(state, patch); });
  const mod = await import('../../../../../src/store/slices/search-ai-slice');
  return { slice: mod.createSearchAISlice(set as any, (() => state) as any, {} as any), set };
};

/** AI Assist as the Email Agent tab saves it. */
const aiAssist = (enabled: boolean) => {
  store.set('sarvinbox-agent-config-version', '2');
  store.set('sarvinbox-agent-config', JSON.stringify({ enabled }));
};

beforeEach(() => {
  store.clear();
  vi.clearAllMocks();
  (globalThis as any).localStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
  };
  (globalThis as any).window = { electronAPI: api };
  store.set('sarvinbox-ai-settings', JSON.stringify({ providers: [PROVIDER] }));
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  delete (globalThis as any).localStorage;
  delete (globalThis as any).window;
  vi.restoreAllMocks();
});

describe('processEmailsForAICategorization (the manual "Start Processing" run)', () => {
  // Breaks: AI Assist says "when off, no LLM calls are made", and the manual
  // run sends mail anyway.
  it('sends nothing while AI Assist is off', async () => {
    aiAssist(false);
    const { slice, set } = await loadSlice();
    await slice.processEmailsForAICategorization();
    expect(api.aiCategorization.start).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalledWith({ aiProcessing: true });
  });

  // Breaks: an AI Assist setting the app cannot read lets the run send mail.
  it('sends nothing when the stored AI Assist setting is unreadable', async () => {
    store.set('sarvinbox-agent-config', '{"enabled":tr');
    const { slice } = await loadSlice();
    await slice.processEmailsForAICategorization();
    expect(api.aiCategorization.start).not.toHaveBeenCalled();
  });

  // Breaks: the run no longer starts for a user with a provider and AI Assist on.
  it('starts the run with the default provider while AI Assist is on', async () => {
    aiAssist(true);
    const { slice } = await loadSlice();
    await slice.processEmailsForAICategorization();
    expect(api.aiCategorization.start).toHaveBeenCalledTimes(1);
    expect(api.aiCategorization.start.mock.calls[0]).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'openai', model: 'm' }),
      'bulk',
    ]));
  });

  // Breaks: the removed switch's leftover "off" still blocks the button.
  it('ignores a leftover value of the removed Categorization switch', async () => {
    store.set('sarvinbox-ai-features', OLD_SWITCH_OFF);
    const { slice } = await loadSlice();
    await slice.processEmailsForAICategorization();
    expect(api.aiCategorization.start).toHaveBeenCalledTimes(1);
  });
});

describe('startAutoAICategorization (the provider handoff to the pipeline)', () => {
  // Breaks: users who once switched the old Categorization toggle off never
  // hand a changed provider to the pipeline again. The handoff sends no mail;
  // the pipeline in main decides that, from AI Assist.
  it('hands the provider to the pipeline regardless of the removed switch', async () => {
    store.set('sarvinbox-ai-features', OLD_SWITCH_OFF);
    const { slice } = await loadSlice();
    slice.startAutoAICategorization();
    expect(api.agent.setAIConfig).toHaveBeenCalledTimes(1);
    expect(api.agent.setAIConfig.mock.calls[0]).toEqual([expect.objectContaining({ type: 'openai', model: 'm' })]);
  });
});
