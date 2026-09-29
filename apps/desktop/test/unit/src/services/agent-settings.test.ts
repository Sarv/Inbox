import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AGENT_CONFIG_KEY,
  DEFAULT_AGENT_SETTINGS,
  isAIAssistEnabled,
  loadAgentSettings,
  pushAgentSettingsToBackend,
} from '../../../../src/services/agent-settings';

// AI Assist is the ONE switch that decides whether new mail is sent to the AI
// provider for sorting. The renderer's copy is the source of truth: it is sent
// to the main process at every launch and on every change. What breaks if this
// suite goes red: an "off" the app can no longer read comes back "on" and mail
// is sent again; a fresh install stops sorting after the user connects a
// provider; or a restart forgets the user's choice.

const VERSION_KEY = 'sarvinbox-agent-config-version';
const store = new Map<string, string>();
const setConfig = vi.fn(async (_cfg: Record<string, unknown>) => ({ success: true }));

beforeEach(() => {
  store.clear();
  setConfig.mockClear();
  (globalThis as any).localStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
  };
  (globalThis as any).window = { electronAPI: { agent: { setConfig } } };
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  delete (globalThis as any).localStorage;
  delete (globalThis as any).window;
  vi.restoreAllMocks();
});

/** A config written by the settings tab after the v2 migration, as the app stores it. */
const saved = (patch: Record<string, unknown>) => {
  store.set(VERSION_KEY, '2');
  store.set(AGENT_CONFIG_KEY, JSON.stringify({ ...DEFAULT_AGENT_SETTINGS, ...patch }));
};

describe('loadAgentSettings — nothing stored', () => {
  // Breaks: connecting a provider no longer turns sorting on by itself. The
  // user connects one for exactly this, so a fresh install starts with it ON.
  it('starts with AI Assist on and writes nothing', () => {
    expect(loadAgentSettings().enabled).toBe(true);
    expect(isAIAssistEnabled()).toBe(true);
    expect(store.size).toBe(0);
  });
});

describe('loadAgentSettings — a readable choice', () => {
  // Breaks: a restart forgets that the user switched AI Assist off (or on).
  it('reads back the stored switch', () => {
    saved({ enabled: false });
    expect(isAIAssistEnabled()).toBe(false);
    saved({ enabled: true });
    expect(isAIAssistEnabled()).toBe(true);
  });

  // Breaks: the one-time v2 default-on flip for old installs, which must still
  // run on a readable pre-v2 config and then honour a later deliberate "off".
  it('flips a pre-v2 "off" on once, then honours "off"', () => {
    store.set(AGENT_CONFIG_KEY, JSON.stringify({ enabled: false }));
    expect(isAIAssistEnabled()).toBe(true);
    expect(store.get(VERSION_KEY)).toBe('2');
    store.set(AGENT_CONFIG_KEY, JSON.stringify({ ...DEFAULT_AGENT_SETTINGS, enabled: false }));
    expect(isAIAssistEnabled()).toBe(false);
  });

  // The removed "Smart Email Categorization" switch was never read by the
  // pipeline. Its stored value must not start meaning anything now: AI Assist
  // alone decides, and connecting a provider keeps sorting on (the product
  // decision for this change: no migration turns AI Assist off).
  it('ignores a stored value of the removed Categorization switch', () => {
    store.set('sarvinbox-ai-features', JSON.stringify([{ id: 'email-categorization', enabled: false }]));
    expect(isAIAssistEnabled()).toBe(true);
  });
});

describe('loadAgentSettings — stored but unreadable fails closed', () => {
  // Each is a value that is present but cannot be read as the user's choice.
  // Reading any of them as the default ("on") would resume sending mail that
  // the user may have switched off. Nothing is written back over it either.
  it.each([
    ['broken JSON', '{"enabled":fal'],
    ['an empty string', ''],
    ['null', 'null'],
    ['an array', '[false]'],
    ['a string', '"off"'],
    ['enabled as the string "false"', JSON.stringify({ ...DEFAULT_AGENT_SETTINGS, enabled: 'false' })],
    ['enabled as a number', JSON.stringify({ ...DEFAULT_AGENT_SETTINGS, enabled: 0 })],
  ])('%s: AI Assist is off', (_label, raw) => {
    store.set(AGENT_CONFIG_KEY, raw);
    expect(isAIAssistEnabled()).toBe(false);
    expect(loadAgentSettings()).toEqual({ ...DEFAULT_AGENT_SETTINGS, enabled: false });
    expect(store.get(AGENT_CONFIG_KEY)).toBe(raw);
  });

  // Breaks: a storage that throws (blocked, private mode) reads as "on".
  it('a storage that throws: AI Assist is off', () => {
    (globalThis as any).localStorage = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
    expect(isAIAssistEnabled()).toBe(false);
  });

  // Breaks: an unreadable config skips the v2 flip's write-back guard and the
  // flip turns it into a stored "on".
  it('does not run the v2 flip on an unreadable config', () => {
    store.set(AGENT_CONFIG_KEY, '{"enabled":fal');
    expect(isAIAssistEnabled()).toBe(false);
    expect(store.has(VERSION_KEY)).toBe(false);
  });
});

describe('pushAgentSettingsToBackend', () => {
  // Breaks: the launch push tells the main process "on" for a store it could
  // not read, and main starts sending mail (it trusts the renderer's push).
  it('sends AI Assist OFF to main when the stored settings are unreadable', () => {
    store.set(AGENT_CONFIG_KEY, 'null');
    pushAgentSettingsToBackend();
    expect(setConfig).toHaveBeenCalledTimes(1);
    expect(setConfig.mock.calls[0][0]).toMatchObject({ enabled: false });
  });

  // Breaks: main never learns the user's stored "off" at launch.
  it('sends the stored choice to main', () => {
    saved({ enabled: false, neverAutoReplyTo: 'a@x.test, b@x.test' });
    pushAgentSettingsToBackend();
    expect(setConfig.mock.calls[0][0]).toMatchObject({ enabled: false, neverAutoReplyTo: ['a@x.test', 'b@x.test'] });
  });
});
