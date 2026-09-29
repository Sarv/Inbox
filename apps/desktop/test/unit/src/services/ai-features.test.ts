// @vitest-environment happy-dom
// The toggles read the stored AI features from localStorage.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  isAutoChatExtractEnabled,
  isAutoChatViewEnabled,
  isBackgroundSplitEnabled,
  isConversationModeEnabled,
  syncBackgroundSplitToMain,
} from '../../../../src/services/ai-features';

/**
 * The chat view's three AI toggles.
 *
 * What breaks if this file goes red: the chat view or the background split
 * reads a switch the user turned off as on (AI spent against their choice),
 * or a user who never touched the settings gets the wrong defaults —
 * conversation mode and background extraction ON, auto chat view OFF.
 */

const store = (features: Array<{ id: string; enabled: boolean }>) =>
  localStorage.setItem('sarvinbox-ai-features', JSON.stringify(features));

beforeEach(() => localStorage.clear());

describe('AI feature toggles', () => {
  it('uses the defaults when the user never saved a choice', () => {
    expect(isConversationModeEnabled()).toBe(true);
    expect(isAutoChatViewEnabled()).toBe(false);
    expect(isAutoChatExtractEnabled()).toBe(true);
  });

  it('honours the stored choices', () => {
    store([
      { id: 'conversation-mode', enabled: false },
      { id: 'auto-chat-view', enabled: true },
      { id: 'auto-chat-extract', enabled: false },
    ]);
    expect(isConversationModeEnabled()).toBe(false);
    expect(isAutoChatViewEnabled()).toBe(true);
    expect(isAutoChatExtractEnabled()).toBe(false);
  });
});

describe('the background split switch', () => {
  afterEach(() => { delete (window as unknown as { electronAPI?: unknown }).electronAPI; });

  // Breaks: the background split (paid AI) running with conversation mode off
  // because only 'Auto Chat Extract' was read, or never running at the defaults.
  it('is on only when conversation mode AND Auto Chat Extract are on', () => {
    expect(isBackgroundSplitEnabled()).toBe(true);
    store([{ id: 'conversation-mode', enabled: false }, { id: 'auto-chat-extract', enabled: true }]);
    expect(isBackgroundSplitEnabled()).toBe(false);
    store([{ id: 'conversation-mode', enabled: true }, { id: 'auto-chat-extract', enabled: false }]);
    expect(isBackgroundSplitEnabled()).toBe(false);
  });

  // Breaks: main's scheduler scanning every account every 45 s while the
  // switch is off, or never nominating once it is on.
  it('pushes the current state to main', async () => {
    const setBackgroundSplitEnabled = vi.fn(async () => ({ success: true }));
    (window as unknown as { electronAPI: unknown }).electronAPI = { ai: { setBackgroundSplitEnabled } };
    await syncBackgroundSplitToMain();
    store([{ id: 'auto-chat-extract', enabled: false }]);
    await syncBackgroundSplitToMain();
    expect(setBackgroundSplitEnabled.mock.calls).toEqual([[true], [false]]);
  });

  // Best effort: no bridge, an older preload without the method, or a failed
  // IPC must never throw into a settings toggle or the app's startup.
  it('never throws — no bridge, no method, or a rejected call', async () => {
    await expect(syncBackgroundSplitToMain()).resolves.toBeUndefined();
    (window as unknown as { electronAPI: unknown }).electronAPI = { ai: {} };
    await expect(syncBackgroundSplitToMain()).resolves.toBeUndefined();
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      ai: { setBackgroundSplitEnabled: vi.fn(async () => { throw new Error('No handler registered'); }) },
    };
    await expect(syncBackgroundSplitToMain()).resolves.toBeUndefined();
  });
});
