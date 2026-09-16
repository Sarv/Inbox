import { describe, expect, it } from 'vitest';

/**
 * How the dashboard derives its ONE "pending" number.
 *
 * THE incident: the merged `pending` field is computed in the main process, but
 * in dev the renderer hot-reloads while main keeps an older bundle. So the
 * field went missing exactly when the two halves were out of step — and the
 * fallback was `?? unprocessedCount`, the categorizer's count alone, which was
 * 0. The panel showed "0 pending · 100% complete" directly above "Waiting for
 * priority + actions: 99": the precise contradiction the merge existed to
 * remove, reintroduced by its own fallback.
 *
 * Mirrors the expression in AIBoxDashboard. Kept as a pure function so the
 * arithmetic is testable without mounting the panel.
 */
function pendingCount(
  breakdown: { pending?: number; agentPending?: number } | null,
  unprocessedCount: number,
): number {
  return breakdown?.pending ?? ((breakdown?.agentPending ?? 0) + unprocessedCount);
}

const percent = (categorized: number, pending: number) =>
  categorized + pending > 0 ? Math.round((categorized / (categorized + pending)) * 100) : 0;

describe('the dashboard pending count', () => {
  it('uses the merged field when the main process provides it', () => {
    expect(pendingCount({ pending: 99, agentPending: 99 }, 0)).toBe(99);
  });

  // THE regression. An older main process has agentPending but not pending;
  // taking the categorizer's 0 alone declares the run finished while the agent
  // still owes 99 emails.
  it('still reports the agent backlog when the merged field is missing', () => {
    expect(pendingCount({ agentPending: 99 }, 0)).toBe(99);
  });

  it('never reports 100% complete while a pipeline still owes work', () => {
    expect(percent(182, pendingCount({ agentPending: 99 }, 0))).toBeLessThan(100);
  });

  it('adds both queues when neither field is authoritative', () => {
    expect(pendingCount({ agentPending: 5 }, 7)).toBe(12);
  });

  // Before the breakdown has loaded at all there is nothing but the
  // categorizer's own count, and that must not throw.
  it('survives a breakdown that has not loaded yet', () => {
    expect(pendingCount(null, 7)).toBe(7);
    expect(pendingCount(null, 0)).toBe(0);
  });

  // A genuinely finished mailbox must still be able to read 100%, or the bar
  // never completes and the fix trades one wrong number for another.
  it('reports 100% only when both queues are empty', () => {
    expect(percent(182, pendingCount({ pending: 0, agentPending: 0 }, 0))).toBe(100);
  });

  // Zero is a real value, not "missing" — `??` must not treat it as absent, or
  // a finished mailbox would fall through to the sum and report the agent's
  // stale count.
  it('treats a merged value of 0 as authoritative', () => {
    expect(pendingCount({ pending: 0, agentPending: 42 }, 13)).toBe(0);
  });
});
