import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { formatCountdown } from '../../../../src/utils/format-time';

// snoozeUntil is stored in SECONDS (the DB column), while Date.now() is in ms —
// pinning the clock is the only way to test the conversion, and a unit mix-up
// here shows the user "45m" for a mail due in 45 hours.
const NOW_SEC = 1_800_000_000; // arbitrary fixed instant

describe('formatCountdown', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_SEC * 1000);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const inSec = (seconds: number) => formatCountdown(NOW_SEC + seconds);

  it('says "Due now" once the snooze time has passed (or is exactly now)', () => {
    expect(inSec(0)).toBe('Due now');
    expect(inSec(-1)).toBe('Due now');
    expect(inSec(-86_400)).toBe('Due now');
  });

  it('shows whole minutes under an hour', () => {
    expect(inSec(45 * 60)).toBe('45m');
    expect(inSec(59 * 60 + 59)).toBe('59m');
  });

  it('never shows "0m" for a snooze that is still in the future', () => {
    // A sub-minute countdown must still read as at least a minute, or the chip
    // flickers to "0m" while the mail is genuinely still snoozed.
    expect(inSec(1)).toBe('1m');
    expect(inSec(59)).toBe('1m');
  });

  it('shows hours + remaining minutes', () => {
    expect(inSec(2 * 3600 + 15 * 60)).toBe('2h 15m');
  });

  it('drops the minutes part on an exact hour', () => {
    expect(inSec(3600)).toBe('1h');
    expect(inSec(5 * 3600)).toBe('5h');
  });

  it('shows days + remaining hours once past 24h', () => {
    expect(inSec(2 * 86_400 + 3 * 3600)).toBe('2d 3h');
    expect(inSec(86_400 + 3600 + 59 * 60)).toBe('1d 1h'); // minutes are dropped at day scale
  });

  it('drops the hours part on an exact day boundary', () => {
    expect(inSec(86_400)).toBe('1d');
    expect(inSec(7 * 86_400)).toBe('7d');
  });

  it('rounds DOWN rather than up (a "2d" label never over-promises)', () => {
    expect(inSec(2 * 86_400 - 1)).toBe('1d 23h');
  });
});
