/**
 * AI-error → pause policy (framework-agnostic, unit-testable).
 *
 * Decides, from a categorization error, whether to (a) treat it as terminal and
 * (b) PAUSE all categorization. The rule that matters for correctness:
 *   - transient (network / 429 / 502) → NOT terminal, keep retrying;
 *   - terminal but per-email ('client' 4xx on one malformed message) → terminal,
 *     but must NOT pause the whole mailbox — the caller fails just that email;
 *   - terminal AND provider-wide ('auth' bad key / 'credit' out of credits) →
 *     pause EVERY request until the user re-configures the provider.
 *
 * The service (unified-pipeline-service) keeps the side effects (setting the
 * pause deadline, raising the renderer banner); this is only the decision, so it
 * can be tested without Electron. `classify` is injectable for deterministic tests.
 */
import { classifyAIError } from '@sarvinbox/core';

type ClassifyFn = (err: unknown) => ReturnType<typeof classifyAIError>;

export interface AIErrorDecision {
  /** The error needs the user to act; auto-retry can't help. */
  terminal: boolean;
  kind: string;
  /** True ONLY for provider-wide failures (auth/credit) that break every request. */
  pauseGlobally: boolean;
  status?: number;
  reason: string;
}

export function decideAIErrorPolicy(err: unknown, classify: ClassifyFn = classifyAIError): AIErrorDecision {
  const info = classify(err);
  if (!info.terminal) {
    return { terminal: false, kind: info.kind, pauseGlobally: false, status: info.status, reason: info.reason };
  }
  const pauseGlobally = info.kind === 'auth' || info.kind === 'credit';
  return { terminal: true, kind: info.kind, pauseGlobally, status: info.status, reason: info.reason };
}
