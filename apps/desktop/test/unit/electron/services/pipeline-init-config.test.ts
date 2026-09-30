import { describe, expect, it } from 'vitest';

import {
  bootPipelineConfig,
  isAIAssistOn,
  resolveDeferredPipelineConfig,
} from '../../../../electron/services/pipeline-init-config';

// Regression: on a first "login with Sarv", the pipeline init is DEFERRED (no
// account/storage yet). The renderer's agent:setConfig push can only persist the
// AI-Assist `enabled` switch to disk while deferred — so the deferred init must
// prefer the PERSISTED config over the stale boot config, or categorization comes
// up disabled until the user manually toggles it ("I have to start it").

describe('resolveDeferredPipelineConfig', () => {
  it('persisted enabled:true wins over the stale boot enabled:false (the first-login fix)', () => {
    const boot = { enabled: false, userEmail: 'me@sarv.com' };
    const persisted = { enabled: true };
    expect(resolveDeferredPipelineConfig(boot, persisted).enabled).toBe(true);
  });

  it('honors a deliberate persisted enabled:false (user turned AI Assist off)', () => {
    expect(resolveDeferredPipelineConfig({ enabled: true }, { enabled: false }).enabled).toBe(false);
  });

  it('falls back to the boot enabled when persisted has none', () => {
    expect(resolveDeferredPipelineConfig({ enabled: true }, {}).enabled).toBe(true);
    expect(resolveDeferredPipelineConfig({ enabled: false }, {}).enabled).toBe(false);
  });

  it('defaults to OFF when neither side sets enabled', () => {
    expect(resolveDeferredPipelineConfig({}, {}).enabled).toBe(false);
    expect(resolveDeferredPipelineConfig(undefined, undefined).enabled).toBe(false);
  });

  it('keeps the boot-resolved userEmail when the persisted copy lacks one', () => {
    const merged = resolveDeferredPipelineConfig({ userEmail: 'me@sarv.com' }, { enabled: true });
    expect(merged.userEmail).toBe('me@sarv.com');
  });

  it('lets a persisted userEmail override the boot one', () => {
    const merged = resolveDeferredPipelineConfig({ userEmail: 'old@sarv.com' }, { userEmail: 'new@sarv.com' });
    expect(merged.userEmail).toBe('new@sarv.com');
  });

  it('preserves other boot + persisted fields (shallow merge, persisted wins)', () => {
    const boot = { enabled: false, autoRead: true, maxAutoActionsPerHour: 50 };
    const persisted = { enabled: true, maxAutoActionsPerHour: 10 };
    const merged = resolveDeferredPipelineConfig(boot, persisted);
    expect(merged).toMatchObject({ enabled: true, autoRead: true, maxAutoActionsPerHour: 10 });
  });
});

// AI Assist is the one switch that lets the pipeline send new mail to the AI
// provider for sorting. A stored value that is set but is not a real boolean did
// not survive storage; reading it as "on" would resume sending mail the user
// switched off. Each of these fails OPEN if the strict check is loosened.
const UNREADABLE_SWITCH_VALUES: unknown[] = ['true', 'false', 1, 0, null, {}, []];

describe('isAIAssistOn', () => {
  // Breaks: the pipeline's send gate reads an unreadable switch as ON.
  it('is on only for a real true', () => {
    expect(isAIAssistOn(true)).toBe(true);
    expect(isAIAssistOn(false)).toBe(false);
    expect(isAIAssistOn(undefined)).toBe(false);
    for (const v of UNREADABLE_SWITCH_VALUES) expect(isAIAssistOn(v)).toBe(false);
  });
});

describe('resolveDeferredPipelineConfig — unreadable AI Assist fails closed', () => {
  // Breaks: a garbage persisted switch (e.g. the string "false") turns sorting
  // ON at the deferred first-launch init, even over a boot value of OFF.
  it('treats a persisted non-boolean enabled as OFF, not as the boot value', () => {
    for (const v of UNREADABLE_SWITCH_VALUES) {
      expect(resolveDeferredPipelineConfig({ enabled: true }, { enabled: v as boolean }).enabled).toBe(false);
    }
  });

  // Breaks: a garbage boot value opens the switch when nothing is persisted.
  it('treats a non-boolean boot enabled as OFF when nothing is persisted', () => {
    expect(resolveDeferredPipelineConfig({ enabled: 'true' as unknown as boolean }, {}).enabled).toBe(false);
  });
});

// main.ts builds the launch config with this, so it is what keeps a deliberate
// "AI Assist off" in force across a restart before the renderer re-sends it.
describe('bootPipelineConfig', () => {
  // Breaks: AI Assist off is forgotten on restart and mail is sent at launch.
  it('keeps a persisted enabled:false OFF, and enabled:true ON', () => {
    expect(bootPipelineConfig({ enabled: false }, 'me@sarv.com').enabled).toBe(false);
    expect(bootPipelineConfig({ enabled: true }, 'me@sarv.com').enabled).toBe(true);
  });

  // Breaks: a fresh install (or an unreadable mirror, which loads as {}) starts ON.
  it('starts OFF with no mirror', () => {
    expect(bootPipelineConfig({}, 'me@sarv.com').enabled).toBe(false);
    expect(bootPipelineConfig(undefined, 'me@sarv.com').enabled).toBe(false);
  });

  // Breaks: a mirror that survived as a non-boolean (e.g. "false") starts sorting.
  it('starts OFF for a non-boolean persisted enabled', () => {
    for (const v of UNREADABLE_SWITCH_VALUES) {
      expect(bootPipelineConfig({ enabled: v as boolean }, 'me@sarv.com').enabled).toBe(false);
    }
  });

  // Breaks: the pipeline drafts as a stale persisted address instead of the
  // account the registry resolved at launch.
  it('uses the registry userEmail over a persisted copy, and keeps the other settings', () => {
    const merged = bootPipelineConfig({ enabled: true, userEmail: 'old@sarv.com', draftReplies: false }, 'me@sarv.com');
    expect(merged).toMatchObject({ enabled: true, userEmail: 'me@sarv.com', draftReplies: false });
  });
});
