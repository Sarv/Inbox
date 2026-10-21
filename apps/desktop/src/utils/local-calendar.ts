/** Calendar date arithmetic is performed in wall time, never the machine's timezone. */
const formatters = new Map<string, Intl.DateTimeFormat>();
const validZones = new Set<string>();
const dailyOffsets = new Map<string, number[]>();
const dayBoundaries = new Map<string, number>();

export function validateTimeZone(timeZone: string): string {
  if (typeof timeZone !== 'string' || timeZone.length > 100) throw new Error('Choose a valid timezone.');
  if (validZones.has(timeZone)) return timeZone;
  try { new Intl.DateTimeFormat('en-GB', { timeZone }).format(0); } catch { throw new Error(`Unsupported timezone: ${timeZone}`); }
  validZones.add(timeZone);
  return timeZone;
}

function formatter(timeZone: string): Intl.DateTimeFormat {
  let value = formatters.get(timeZone);
  if (!value) {
    validateTimeZone(timeZone);
    value = new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    formatters.set(timeZone, value);
  }
  return value;
}

export function validLocalDate(date: string): boolean {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const parsed = new Date(`${date}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
}

export function instantToWallClock(ms: number, timeZone: string): string {
  if (!Number.isFinite(ms)) throw new Error('Invalid event time.');
  const parts = Object.fromEntries(formatter(timeZone).formatToParts(ms).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

export function dateInTimeZone(ms: number, timeZone: string): string {
  return instantToWallClock(ms, timeZone).slice(0, 10);
}

/** Earliest real boundary of a local date; a skipped date has the next day's boundary. */
export function startOfLocalDate(date: string, timeZone: string): number {
  if (!validLocalDate(date)) throw new Error('Invalid calendar date.');
  validateTimeZone(timeZone);
  const cacheKey = `${timeZone}:${date}`;
  const cached = dayBoundaries.get(cacheKey);
  if (cached !== undefined) return cached;
  // Unlike a manually typed event time, a date boundary may legitimately be 01:00.
  for (let minute = 0; minute < 3 * 1440; minute++) {
    const candidateDate = addLocalDays(date, Math.floor(minute / 1440));
    const time = `${String(Math.floor(minute % 1440 / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
    try {
      let high = wallClockToInstant(`${candidateDate}T${time}`, timeZone);
      let low = high - 60_000;
      // Refine a historic sub-minute transition without rounding away the beginning of the day.
      while (high - low > 1) {
        const middle = Math.floor((low + high) / 2);
        if (dateInTimeZone(middle, timeZone) >= date) high = middle; else low = middle;
      }
      if (dayBoundaries.size >= 2048) dayBoundaries.clear();
      dayBoundaries.set(cacheKey, high);
      return high;
    } catch (error) {
      if (!(error as Error).message.includes('does not exist')) throw error;
    }
  }
  throw new Error('This local date has no supported timezone boundary.');
}

/** Ambiguous fall-back times use the earlier occurrence. Nonexistent spring times are rejected. */
export function wallClockToInstant(text: string, timeZone: string): number {
  validateTimeZone(timeZone);
  if (typeof text !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(text) || !validLocalDate(text.slice(0, 10))) throw new Error('Enter a valid date and time.');
  const hour = Number(text.slice(11, 13));
  const minute = Number(text.slice(14, 16));
  if (hour > 23 || minute > 59) throw new Error('Enter a valid date and time.');
  const target = Date.parse(`${text}:00Z`);
  const cacheKey = `${timeZone}:${text.slice(0, 10)}`;
  let offsets = dailyOffsets.get(cacheKey);
  if (!offsets) {
    const found = new Set<number>();
    // Probe around the entire local date so the cache also covers either DST fold.
    const midnight = Date.parse(`${text.slice(0, 10)}T00:00:00Z`);
    for (let delta = -36; delta <= 60; delta += 6) {
      const probe = midnight + delta * 3_600_000;
      found.add(Date.parse(`${instantToWallClock(probe, timeZone)}:00Z`) - probe);
    }
    offsets = [...found];
    if (dailyOffsets.size >= 2048) dailyOffsets.clear();
    dailyOffsets.set(cacheKey, offsets);
  }
  const candidates = offsets.map(offset => target - offset).filter(value => instantToWallClock(value, timeZone) === text).sort((a, b) => a - b);
  if (candidates.length === 0) throw new Error(`That local time does not exist in ${timeZone} because the clocks change. Choose another time.`);
  return candidates[0]!;
}

export function addLocalDays(date: string, days: number): string {
  if (!validLocalDate(date) || !Number.isInteger(days)) throw new Error('Invalid calendar date.');
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

export function localDateDifference(start: string, end: string): number {
  if (!validLocalDate(start) || !validLocalDate(end)) throw new Error('Invalid calendar date.');
  return (Date.parse(`${end}T00:00Z`) - Date.parse(`${start}T00:00Z`)) / 86_400_000;
}

export function localWeekDay(date: string): number {
  if (!validLocalDate(date)) throw new Error('Invalid calendar date.');
  return new Date(`${date}T00:00Z`).getUTCDay();
}
