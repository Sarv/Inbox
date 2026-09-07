import { describe, it, expect } from 'vitest';

import { parseHumanDateToEpochSec } from '../../../../src/utils/human-date';

/** Local month/day of a returned epoch (TZ-robust: parse + read both local). */
function md(epoch: number | null): { month: number; day: number } | null {
  if (epoch == null) return null;
  const d = new Date(epoch * 1000);
  return { month: d.getMonth(), day: d.getDate() };
}

describe('parseHumanDateToEpochSec — day-first parsing', () => {
  it('reads an ambiguous numeric date as DD/MM, not US MM/DD (the Jul 8 / Aug 7 bug)', () => {
    // "07/08/2026" is 7 Aug (DD/MM). The old Date.parse / default-chrono read it
    // as the US July 8 — the exact wrong date the conversation view showed.
    expect(md(parseHumanDateToEpochSec('07/08/2026, 11:12:15'))).toEqual({ month: 7, day: 7 });
    expect(md(parseHumanDateToEpochSec('On 07/08/2026, 11:12:15, mahesh kotak wrote')))
      .toEqual({ month: 7, day: 7 });
  });

  it('reads other DD/MM shapes day-first', () => {
    expect(md(parseHumanDateToEpochSec('27/04/26 03:55 PM'))).toEqual({ month: 3, day: 27 }); // 27 Apr
  });

  it('does not regress unambiguous US dates where the day is > 12', () => {
    // "4/17/2026" can only be 17 Apr — chrono keeps it correct either way.
    expect(md(parseHumanDateToEpochSec('4/17/2026, 2:51:17 PM'))).toEqual({ month: 3, day: 17 });
  });

  it('parses textual-month formats', () => {
    expect(md(parseHumanDateToEpochSec('Thu, Jul 9, 2026 at 10:52 AM'))).toEqual({ month: 6, day: 9 });
    expect(md(parseHumanDateToEpochSec('27 April 2026 18:31'))).toEqual({ month: 3, day: 27 });
    expect(md(parseHumanDateToEpochSec('Fri, Aug 7, 2026 at 4:46 PM'))).toEqual({ month: 7, day: 7 });
  });

  it('returns null for empty / undefined / unparseable input', () => {
    expect(parseHumanDateToEpochSec('')).toBeNull();
    expect(parseHumanDateToEpochSec(undefined)).toBeNull();
    expect(parseHumanDateToEpochSec(null)).toBeNull();
    expect(parseHumanDateToEpochSec('no date here at all')).toBeNull();
  });
});
