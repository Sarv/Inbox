import { describe, expect, it } from 'vitest';

import { addLocalDays, dateInTimeZone, instantToWallClock, startOfLocalDate, wallClockToInstant } from '../../../../src/utils/local-calendar';

describe('local calendar timezone arithmetic', () => {
  it('round-trips a timezone independent of the machine', () => {
    expect(wallClockToInstant('2026-10-21T09:30', 'Asia/Kolkata')).toBe(Date.parse('2026-10-21T04:00:00Z'));
    expect(instantToWallClock(Date.parse('2026-10-21T04:00:00Z'), 'Asia/Kolkata')).toBe('2026-10-21T09:30');
    expect(dateInTimeZone(Date.parse('2026-10-21T01:00Z'), 'America/Los_Angeles')).toBe('2026-10-20');
  });
  it('rejects a nonexistent spring-forward hour', () => {
    expect(() => wallClockToInstant('2026-03-08T02:30', 'America/New_York')).toThrow('does not exist');
  });
  it('chooses the earlier instant in a repeated fall-back hour', () => {
    expect(wallClockToInstant('2026-11-01T01:30', 'America/New_York')).toBe(Date.parse('2026-11-01T05:30Z'));
  });
  it('handles a thirty-minute DST transition', () => {
    expect(() => wallClockToInstant('2026-10-04T02:15', 'Australia/Lord_Howe')).toThrow('does not exist');
    expect(instantToWallClock(wallClockToInstant('2026-10-04T02:45', 'Australia/Lord_Howe'), 'Australia/Lord_Howe')).toBe('2026-10-04T02:45');
  });
  it('finds a real day boundary when local midnight does not exist', () => {
    const boundary = startOfLocalDate('2026-09-06', 'America/Santiago');
    expect(instantToWallClock(boundary, 'America/Santiago')).toBe('2026-09-06T01:00');
    expect(dateInTimeZone(boundary - 1, 'America/Santiago')).toBe('2026-09-05');
    expect(() => wallClockToInstant('2026-09-06T00:00', 'America/Santiago')).toThrow('does not exist');
  });
  it('represents a wholly skipped local date as an empty interval', () => {
    const boundary = startOfLocalDate('2011-12-30', 'Pacific/Apia');
    expect(boundary).toBe(startOfLocalDate('2011-12-31', 'Pacific/Apia'));
    expect(dateInTimeZone(boundary, 'Pacific/Apia')).toBe('2011-12-31');
    expect(dateInTimeZone(boundary - 1, 'Pacific/Apia')).toBe('2011-12-29');
  });
  it('adds calendar days across month/year boundaries and validates input', () => {
    expect(addLocalDays('2024-02-28', 2)).toBe('2024-03-01');
    expect(addLocalDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(() => addLocalDays('2026-02-30', 1)).toThrow();
    expect(() => wallClockToInstant('2026-02-30T09:00', 'UTC')).toThrow();
    expect(() => wallClockToInstant('2026-02-20T25:00', 'UTC')).toThrow();
    expect(() => instantToWallClock(0, 'Not/AZone')).toThrow('Unsupported timezone');
  });
});
