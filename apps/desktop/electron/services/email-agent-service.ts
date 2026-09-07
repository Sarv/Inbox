/**
 * Email Agent Service — STUB
 *
 * The earlier draft of this file imported `EmailAgent` and `EmailAgentDeps`
 * from `@sarvinbox/core`, but those classes don't exist in core yet. Sibling
 * file `apps/desktop/electron/ipc/agent-handlers.ts` already exposes the
 * agent functionality the renderer talks to today (search for the comment
 * "Agent Service (moved from deleted email-agent-service.ts)").
 *
 * Keeping this stub so a future revival has a clear landing point. To
 * implement: export `EmailAgent` + `EmailAgentDeps` from
 * `packages/core/src/agent/`, then restore the per-email pipeline + IPC
 * bridge that previously lived here. The original 255-line draft is in git
 * history (commit prior to this stub).
 */

export function initializeEmailAgent(): null {
  // no-op until the core EmailAgent class is exported
  return null;
}

export function shutdownEmailAgent(): void {
  // no-op
}
