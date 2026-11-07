import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The standalone categorizer's start handlers hand a renderer config to
 * prepareAIProviderConfig, which refuses a plain-HTTP address on another
 * computer (CASA audit I-7). The refusal must come back as the handlers'
 * `{ success: false }` and reach the Fix banner — never start a run, never
 * leave an old auto-process sending to the provider the user moved away from.
 *
 * What breaks if this file fails: a manual "Categorize" run sends mail over
 * plain HTTP; the renderer's "processing" spinner waits forever for a run that
 * never started; or an auto-process keeps using the previous provider.
 */

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
  service: null as any,
  send: vi.fn(),
  attachOAuthBearer: vi.fn((c: unknown) => c),
}));

vi.mock('electron', () => ({
  ipcMain: { handle: (name: string, fn: (...args: any[]) => any) => { h.handlers.set(name, fn); } },
}));
vi.mock('@sarvinbox/core', async (orig) => ({
  ...(await orig<typeof import('@sarvinbox/core')>()),
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../../../../electron/services/ai-categorization-service', () => ({
  AICategorizationService: class {
    start = vi.fn(async () => {});
    startAutoProcess = vi.fn();
    stopAutoProcess = vi.fn();
    getStatus = () => ({ running: false, progress: null });
    isAutoProcessing = () => false;
  },
}));
vi.mock('../../../../electron/services/ai-secret-store', () => ({
  resolveAiKey: vi.fn(async () => ({ status: 'found', key: 'sk-vault' })),
}));
vi.mock('../../../../electron/services/oauth-service', () => ({ attachOAuthBearer: h.attachOAuthBearer }));
vi.mock('../../../../electron/shared', () => ({
  getAICategorizationService: () => h.service,
  setAICategorizationService: (s: unknown) => { h.service = s; },
  getMainWindow: () => ({ webContents: { send: h.send } }),
}));

import { registerAICategorizationHandlers } from '../../../../electron/ipc/ai-categorization-handlers';

const PLAIN_HTTP = { type: 'custom', apiKey: '', model: 'm', baseUrl: 'http://models.lan.example/v1' };
const HTTPS = { type: 'openai', apiKey: '', providerId: 'p1', model: 'm', baseUrl: 'https://api.openai.com/v1' };
const invoke = (channel: string, ...args: unknown[]) => h.handlers.get(channel)!({}, ...args);
const bannerSends = () => h.send.mock.calls.filter(([channel, p]) => channel === 'ai-categorization:error' && p.terminal);

beforeEach(() => {
  h.handlers.clear();
  h.service = null;
  h.send.mockReset();
  h.attachOAuthBearer.mockReset().mockImplementation((c: unknown) => c);
  registerAICategorizationHandlers();
});

describe('ai-categorization:start', () => {
  // THE finding through a manual run. Breaks: the run starts and sends mail over plain HTTP.
  it('refuses a plain-HTTP provider on another computer without starting a run, and raises the Fix banner', async () => {
    const result = await invoke('ai-categorization:start', PLAIN_HTTP, 'bulk', {});
    expect(result).toEqual({ success: false, error: expect.stringMatching(/^AI provider address must use HTTPS/) });
    expect(h.service.start).not.toHaveBeenCalled();
    expect(bannerSends()).toHaveLength(1);
  });

  // Breaks: a valid provider no longer starts, or starts without its saved key.
  it('starts a run with the prepared config for an HTTPS provider', async () => {
    await expect(invoke('ai-categorization:start', HTTPS, 'bulk', {})).resolves.toEqual({ success: true });
    expect(h.service.start).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'sk-vault' }), 'bulk', {});
    expect(bannerSends()).toEqual([]);
  });

  // An unexpected failure is not a refusal: still a { success: false }, but
  // no "insecure address" banner. Breaks: every failure is blamed on HTTPS.
  it('reports any other failure without the refusal banner', async () => {
    h.attachOAuthBearer.mockImplementation(() => { throw new Error('token store locked'); });
    await expect(invoke('ai-categorization:start', HTTPS, 'bulk', {})).resolves.toEqual({ success: false, error: 'token store locked' });
    expect(bannerSends()).toEqual([]);
  });
});

describe('ai-categorization:startAuto', () => {
  // Breaks: the auto-process adopts (or keeps using the old provider after) a refused config.
  it('refuses a plain-HTTP provider and stops the auto-process that was running', async () => {
    await invoke('ai-categorization:startAuto', HTTPS, {});
    expect(h.service.startAutoProcess).toHaveBeenCalledTimes(1);

    const result = await invoke('ai-categorization:startAuto', PLAIN_HTTP, {});
    expect(result).toEqual({ success: false, error: expect.stringMatching(/^AI provider address must use HTTPS/) });
    expect(h.service.startAutoProcess).toHaveBeenCalledTimes(1);
    expect(h.service.stopAutoProcess).toHaveBeenCalledTimes(1);
    expect(bannerSends()).toHaveLength(1);
  });

  // Breaks: an unrelated failure tears down a working auto-process.
  it('leaves the auto-process alone on a failure that is not a refusal', async () => {
    await invoke('ai-categorization:startAuto', HTTPS, {});
    h.attachOAuthBearer.mockImplementation(() => { throw new Error('token store locked'); });
    await expect(invoke('ai-categorization:startAuto', HTTPS, {})).resolves.toEqual({ success: false, error: 'token store locked' });
    expect(h.service.stopAutoProcess).not.toHaveBeenCalled();
  });
});
