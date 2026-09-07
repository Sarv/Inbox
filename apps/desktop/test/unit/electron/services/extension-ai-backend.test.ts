import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The extension AI bridge (main -> renderer over IPC). The interesting parts are
 * the request/response correlation by requestId, that an EMPTY completion is a
 * success (not a failure), and that both the listener and the 60s timeout are
 * always cleaned up so nothing fires after shutdown.
 */

const h = vi.hoisted(() => ({
  window: null as { sent: Array<{ channel: string; payload: Record<string, unknown> }> } | null,
  listeners: [] as Array<(event: unknown, response: unknown) => void>,
}));

vi.mock('electron', () => ({
  ipcMain: {
    on: (_channel: string, cb: (event: unknown, response: unknown) => void) => { h.listeners.push(cb); },
    removeListener: (_channel: string, cb: (event: unknown, response: unknown) => void) => {
      h.listeners = h.listeners.filter((l) => l !== cb);
    },
    handle: vi.fn(),
  },
}));

vi.mock('../../../../electron/shared', () => ({
  getMainWindow: () =>
    h.window
      ? {
          webContents: {
            send: (channel: string, payload: Record<string, unknown>) => h.window!.sent.push({ channel, payload }),
          },
        }
      : null,
}));

import { createExtensionAIBackend } from '../../../../electron/services/extension-ai-backend';

const reply = (response: Record<string, unknown>): void => {
  for (const listener of [...h.listeners]) listener({}, response);
};

const lastRequestId = (): string => h.window!.sent[h.window!.sent.length - 1].payload.requestId as string;

beforeEach(() => {
  vi.useFakeTimers();
  h.window = { sent: [] };
  h.listeners = [];
});

afterEach(() => { vi.useRealTimers(); });

describe('the stubbed capabilities', () => {
  it('returns neutral results (extensions bring their own categorization)', async () => {
    const backend = createExtensionAIBackend();
    await expect(backend.categorize({} as never)).resolves.toEqual({
      category: 'other', categories: [], confidence: 0,
    });
    await expect(backend.generateReplySuggestions({} as never)).resolves.toEqual([]);
    await expect(backend.summarize('anything')).resolves.toBe('');
    await expect(backend.extractActionItems({} as never)).resolves.toEqual([]);
  });

  it('isAvailable tracks whether a window exists to route through', () => {
    const backend = createExtensionAIBackend();
    expect(backend.isAvailable()).toBe(true);
    h.window = null;
    expect(backend.isAvailable()).toBe(false);
  });
});

describe('complete', () => {
  it('sends the prompt to the renderer and resolves with the matching response', async () => {
    const backend = createExtensionAIBackend();
    const pending = backend.complete!({ systemPrompt: 'sys', userPrompt: 'usr', maxTokens: 128 });

    expect(h.window!.sent).toHaveLength(1);
    expect(h.window!.sent[0].channel).toBe('ai:complete-request');
    expect(h.window!.sent[0].payload).toMatchObject({ systemPrompt: 'sys', userPrompt: 'usr', maxTokens: 128 });

    reply({ requestId: lastRequestId(), success: true, result: 'the answer' });
    await expect(pending).resolves.toBe('the answer');
    expect(h.listeners).toHaveLength(0); // listener removed
  });

  it('treats an EMPTY completion as a success', async () => {
    const backend = createExtensionAIBackend();
    const pending = backend.complete!({ systemPrompt: 's', userPrompt: 'u' });
    reply({ requestId: lastRequestId(), success: true, result: '' });
    await expect(pending).resolves.toBe('');
  });

  it('IGNORES a response for a different request', async () => {
    const backend = createExtensionAIBackend();
    const pending = backend.complete!({ systemPrompt: 's', userPrompt: 'u' });
    reply({ requestId: 'someone-else', success: true, result: 'not mine' });
    expect(h.listeners).toHaveLength(1); // still waiting

    reply({ requestId: lastRequestId(), success: true, result: 'mine' });
    await expect(pending).resolves.toBe('mine');
  });

  it('rejects with the renderer’s error, or a default message', async () => {
    const backend = createExtensionAIBackend();
    const first = backend.complete!({ systemPrompt: 's', userPrompt: 'u' });
    reply({ requestId: lastRequestId(), success: false, error: 'no provider configured' });
    await expect(first).rejects.toThrow('no provider configured');

    const second = backend.complete!({ systemPrompt: 's', userPrompt: 'u' });
    reply({ requestId: lastRequestId(), success: false });
    await expect(second).rejects.toThrow('AI completion failed');
  });

  it('rejects a success whose result is not a string', async () => {
    const backend = createExtensionAIBackend();
    const pending = backend.complete!({ systemPrompt: 's', userPrompt: 'u' });
    reply({ requestId: lastRequestId(), success: true });
    await expect(pending).rejects.toThrow('AI completion failed');
  });

  it('times out after 60s and removes its listener', async () => {
    const backend = createExtensionAIBackend();
    const pending = backend.complete!({ systemPrompt: 's', userPrompt: 'u' });
    const assertion = expect(pending).rejects.toThrow('AI completion timed out');
    await vi.advanceTimersByTimeAsync(60_000);
    await assertion;
    expect(h.listeners).toHaveLength(0);
  });

  it('clears the timeout on a response so it cannot fire after shutdown', async () => {
    const backend = createExtensionAIBackend();
    const pending = backend.complete!({ systemPrompt: 's', userPrompt: 'u' });
    reply({ requestId: lastRequestId(), success: true, result: 'done' });
    await expect(pending).resolves.toBe('done');
    // Nothing pending -> advancing past the timeout is inert.
    await vi.advanceTimersByTimeAsync(120_000);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('gives every request a distinct id', async () => {
    const backend = createExtensionAIBackend();
    const a = backend.complete!({ systemPrompt: 's', userPrompt: 'a' });
    const idA = lastRequestId();
    const b = backend.complete!({ systemPrompt: 's', userPrompt: 'b' });
    const idB = lastRequestId();
    expect(idA).not.toBe(idB);

    reply({ requestId: idB, success: true, result: 'B' });
    reply({ requestId: idA, success: true, result: 'A' });
    await expect(a).resolves.toBe('A');
    await expect(b).resolves.toBe('B');
  });

  it('throws immediately when there is no window to route through', async () => {
    h.window = null;
    const backend = createExtensionAIBackend();
    await expect(backend.complete!({ systemPrompt: 's', userPrompt: 'u' })).rejects.toThrow(
      'Main window not available for AI calls',
    );
    expect(h.listeners).toHaveLength(0);
  });
});
