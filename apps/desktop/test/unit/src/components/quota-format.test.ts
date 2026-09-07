import { describe, expect, it } from 'vitest';

import { formatBytes, formatQuota, quotaRowState, QUOTA_WARN_PCT, QUOTA_CRITICAL_PCT } from '../../../../src/components/quota-format';

// The quota bar is the user's only warning before a full mailbox silently stops
// accepting mail. These pin the severity thresholds and the no-limit case so the
// bar can't mislead (e.g. showing "ok" green at 96%, or dividing by a zero limit).

const GB = 1024 ** 3;

describe('formatBytes', () => {
  it('scales to GB / MB / KB / B', () => {
    expect(formatBytes(3.2 * GB)).toBe('3.2 GB');
    expect(formatBytes(15 * GB)).toBe('15 GB');   // ≥10 GB drops the decimal
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
    expect(formatBytes(700 * 1024)).toBe('700 KB');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(0)).toBe('0 B');
  });
});

describe('formatQuota', () => {
  // No limit / unlimited must yield null so the bar simply doesn't render — never
  // a divide-by-zero or a bogus 0%/Infinity.
  it('returns null when there is no meaningful limit', () => {
    expect(formatQuota(1000, 0)).toBeNull();
    expect(formatQuota(1000, -1)).toBeNull();
  });

  it('computes percent and a human label', () => {
    const v = formatQuota(3 * GB, 15 * GB)!;
    expect(v.percent).toBe(20);
    expect(v.label).toBe('3.0 GB of 15 GB (20%)');
    expect(v.level).toBe('ok');
  });

  // Severity escalates exactly at the published thresholds — the boundary is what
  // regresses silently, so test AT the threshold, not just around it.
  it('escalates to warning at QUOTA_WARN_PCT and critical at QUOTA_CRITICAL_PCT', () => {
    expect(formatQuota(QUOTA_WARN_PCT * GB, 100 * GB)!.level).toBe('warning');       // exactly 80%
    expect(formatQuota((QUOTA_WARN_PCT - 1) * GB, 100 * GB)!.level).toBe('ok');      // 79%
    expect(formatQuota(QUOTA_CRITICAL_PCT * GB, 100 * GB)!.level).toBe('critical');  // exactly 95%
    expect(formatQuota((QUOTA_CRITICAL_PCT - 1) * GB, 100 * GB)!.level).toBe('warning'); // 94%
  });

  // An over-quota mailbox must clamp to 100% so the bar can't overflow its track.
  it('clamps percent to 100 when usage exceeds the limit', () => {
    const v = formatQuota(20 * GB, 15 * GB)!;
    expect(v.percent).toBe(100);
    expect(v.level).toBe('critical');
  });
});

// The row's presence is what makes the sidebar reflow. These pin WHEN it is on
// screen, because getting it wrong is visible as the footer jumping — the bar
// disappearing on an account switch and popping back a round-trip later.
describe('quotaRowState', () => {
  const QUOTA = { used: 3 * GB, limit: 15 * GB };

  it('keeps showing a known figure WHILE a refresh is running', () => {
    // The anti-flicker rule: a switch reloads the quota, and the row must ride
    // that out with the last-known value rather than unmount.
    const row = quotaRowState({ quota: QUOTA, loading: true, answered: true });
    expect(row.kind).toBe('bar');
    expect(row.kind === 'bar' && row.view.usedLabel).toBe('3.0 GB');
  });

  it('holds the row as a placeholder on a first, unanswered look', () => {
    // Nothing cached and a lookup in flight — occupy the space now so filling it
    // in doesn't shove everything below.
    expect(quotaRowState({ quota: null, loading: true, answered: false }).kind).toBe('placeholder');
  });

  it('hides once the account has answered that it has no quota', () => {
    // `answered` is what stops a no-QUOTA server from flashing a placeholder on
    // every periodic refresh: the answer is known, it's just empty.
    expect(quotaRowState({ quota: null, loading: true, answered: true }).kind).toBe('hidden');
    expect(quotaRowState({ quota: null, loading: false, answered: true }).kind).toBe('hidden');
  });

  it('hides when nothing is known and nothing is loading', () => {
    // Disconnected / never asked: no row, no placeholder that never resolves.
    expect(quotaRowState({ quota: null, loading: false, answered: false }).kind).toBe('hidden');
  });

  it('shows the bar for an unlimited-limit answer as hidden, not a placeholder', () => {
    // limit 0 means "no meaningful limit"; a stuck placeholder would be worse
    // than showing nothing.
    expect(quotaRowState({ quota: { used: 5 * GB, limit: 0 }, loading: true, answered: true }).kind).toBe('hidden');
  });
});
