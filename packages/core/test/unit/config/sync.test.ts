import { describe, it, expect } from 'vitest';

import {
  SYNC_RECENT_WINDOW_DAYS,
  LARGE_MAILBOX_THRESHOLD,
  BACKFILL_UID_SPAN,
  recentWindowCutoffSeconds,
  recentWindowCutoffDate,
} from '../../../src/config/sync';

describe('sync config', () => {
  it('cutoff seconds is exactly the window before now', () => {
    const now = 1_700_000_000;
    expect(recentWindowCutoffSeconds(now)).toBe(now - SYNC_RECENT_WINDOW_DAYS * 24 * 60 * 60);
  });

  it('cutoff date mirrors the seconds cutoff', () => {
    const now = 1_700_000_000;
    expect(recentWindowCutoffDate(now).getTime()).toBe(recentWindowCutoffSeconds(now) * 1000);
  });

  it('tunable knobs are sane positive values', () => {
    expect(SYNC_RECENT_WINDOW_DAYS).toBeGreaterThan(0);
    expect(LARGE_MAILBOX_THRESHOLD).toBeGreaterThan(0);
    expect(BACKFILL_UID_SPAN).toBeGreaterThan(0);
  });
});
