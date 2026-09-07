import { describe, expect, it } from 'vitest';

import { resolveDeferredPipelineConfig } from '../../../../electron/services/pipeline-init-config';

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
