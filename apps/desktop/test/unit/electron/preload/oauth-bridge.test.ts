import { readFileSync } from 'fs';
import { join } from 'path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ElectronAPI } from '../../../../electron/preload';

/**
 * The renderer must never be able to obtain an access token (CASA I-2): the
 * Sarv token is also the Sarv mailbox's XOAUTH2 credential, and the renderer
 * renders untrusted email HTML. What breaks if this file fails: the
 * `oauth.getAccessToken` bridge (or any other bridge onto a token channel)
 * comes back, or the catalog / AI bridges stop reaching main's channels.
 */

const h = vi.hoisted(() => ({ api: null as ElectronAPI | null, invoke: vi.fn() }));
vi.mock('@sentry/electron/preload', () => ({}));
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: (_key: string, api: ElectronAPI) => { h.api = api; } },
  ipcRenderer: { invoke: h.invoke, on: vi.fn(), removeListener: vi.fn(), removeAllListeners: vi.fn(), send: vi.fn() },
  webFrame: {},
}));

import '../../../../electron/preload';

beforeEach(() => { h.invoke.mockReset().mockResolvedValue({ ok: true, body: [] }); });

describe('preload OAuth bridge', () => {
  // THE I-2 regression: breaks if the renderer can ask for a token again.
  it('exposes no getAccessToken, and no access-token channel anywhere in the preload', () => {
    expect(h.api!.oauth).not.toHaveProperty('getAccessToken');
    const source = readFileSync(join(__dirname, '../../../../electron/preload.ts'), 'utf8');
    expect(source).not.toMatch(/getAccessToken|invoke\(\s*'[^']*(access.?token|bearer)[^']*'/i);
  });

  // Breaks the Sarv pickers: the catalog bridge must reach main's channel with
  // the request as given (kind + account, no URL, no token).
  it('sends catalog requests to oauth:sarvCatalog', async () => {
    const request = { kind: 'models' as const, email: 'me@sarv.com', providerCode: 'sarv_partners', zoneCode: 'jpr1' };
    await expect(h.api!.oauth.sarvCatalog(request)).resolves.toEqual({ ok: true, body: [] });
    expect(h.invoke).toHaveBeenCalledExactlyOnceWith('oauth:sarvCatalog', request);
  });

  // Breaks: main never hears the last AI provider is gone, and keeps using its copy.
  it('sends "no AI provider" to pipeline:clearAIConfig', async () => {
    await h.api!.agent.clearAIConfig();
    expect(h.invoke).toHaveBeenCalledExactlyOnceWith('pipeline:clearAIConfig');
  });

  // Breaks Sarv AI requests: they go through main's AI proxy channel, carrying
  // the account (never a token).
  it('sends AI requests, including a Sarv sign-in, to ai:providerFetch', async () => {
    const request = {
      requestId: 'r1', providerId: 's', type: 'sarv', url: 'https://jpr1-ai-edge.sarv.com/edge/v1/llm/chat/completions',
      oauth: { provider: 'sarv', email: 'me@sarv.com' },
    };
    await h.api!.aiProxy.fetch(request);
    expect(h.invoke).toHaveBeenCalledExactlyOnceWith('ai:providerFetch', request);
  });
});
