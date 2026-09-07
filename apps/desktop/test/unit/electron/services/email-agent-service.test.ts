import { describe, expect, it } from 'vitest';

import { initializeEmailAgent, shutdownEmailAgent } from '../../../../electron/services/email-agent-service';

/**
 * Deliberate STUB (core exports no EmailAgent yet — agent-handlers.ts carries the
 * live functionality). Pinned so a future revival has to be explicit: init must
 * keep reporting "no agent" rather than silently returning a half-wired object,
 * and shutdown must stay safe to call unconditionally.
 */
describe('email-agent-service (stub)', () => {
  it('initialize reports that no agent exists', () => {
    expect(initializeEmailAgent()).toBeNull();
  });

  it('shutdown is a safe no-op, repeatable and callable without an init', () => {
    expect(shutdownEmailAgent()).toBeUndefined();
    expect(() => { shutdownEmailAgent(); shutdownEmailAgent(); }).not.toThrow();
  });
});
