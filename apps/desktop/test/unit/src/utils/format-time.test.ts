import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { formatCountdown, formatExpiryCountdown } from '../../../../src/utils/format-time';

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

/**
 * The second-by-second countdown on an extension notification card (a
 * verification code's expiry). Takes MILLISECONDS, unlike formatCountdown above
 * — a unit mix-up here renders a 5-minute window as "Expired" or as "83h".
 */
describe('formatExpiryCountdown', () => {
  const NOW_MS = 1_800_000_000_000;
  const inMs = (offset: number) => formatExpiryCountdown(NOW_MS + offset, NOW_MS);

  it('says "Expired" at and after the deadline', () => {
    // Regression: a passed deadline renders a negative countdown ("-3:12").
    expect(inMs(0)).toBe('Expired');
    expect(inMs(-1)).toBe('Expired');
    expect(inMs(-60 * 60_000)).toBe('Expired');
  });

  it('counts single seconds under a minute', () => {
    // Regression: rounding to minutes shows "1m" for the last 60 seconds, which
    // is wrong for 59 of them — the whole reason this is not formatCountdown.
    expect(inMs(59_000)).toBe('59s');
    expect(inMs(1_000)).toBe('1s');
    expect(inMs(1)).toBe('1s');
  });

  it('shows m:ss between one minute and one hour', () => {
    // Regression: the seconds lose their leading zero and "4:05" renders "4:5".
    expect(inMs(4 * 60_000 + 32_000)).toBe('4:32');
    expect(inMs(4 * 60_000 + 5_000)).toBe('4:05');
    expect(inMs(60_000)).toBe('1:00');
    expect(inMs(59 * 60_000 + 59_000)).toBe('59:59');
  });

  it('shows hours and padded minutes past an hour', () => {
    // Regression: a long-lived card renders "65:00", which reads as 65 seconds.
    expect(inMs(60 * 60_000)).toBe('1h 00m');
    expect(inMs(65 * 60_000)).toBe('1h 05m');
    expect(inMs(25 * 60 * 60_000)).toBe('25h 00m');
  });

  it('treats a non-finite deadline as expired rather than rendering NaN', () => {
    // Regression: an extension passing a bad expiresAt shows "NaNs" on the card.
    expect(formatExpiryCountdown(Number.NaN, NOW_MS)).toBe('Expired');
    expect(formatExpiryCountdown(Number.POSITIVE_INFINITY, NOW_MS)).toBe('Expired');
  });

  it('defaults to the real clock when no "now" is given', () => {
    // Regression: the default argument is dropped and every call needs a clock.
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    expect(formatExpiryCountdown(NOW_MS + 30_000)).toBe('30s');
    vi.useRealTimers();
  });
});
