import { describe, expect, it } from 'vitest';

import { computeTemporalSignal } from '../../../src/agent/signals/temporal-patterns';

// The temporal signal scores an email by its age, the sender's burst rate and
// routine-ness. `value` starts in one of five age bands and is then adjusted; it
// no longer has a dead initial value (CodeQL js/useless-assignment-to-local),
// so every band must assign it.

const HOUR = 3600;
const DAY = 86_400;
// Noon local time, so the outside-business-hours bump stays out of the way.
const sentAt = (() => { const d = new Date(2026, 9, 14, 12, 0, 0); return Math.floor(d.getTime() / 1000); })();
const at = (ageSec: number) => computeTemporalSignal(sentAt, sentAt + ageSec, false, 0, []);

describe('computeTemporalSignal — age bands', () => {
  // Breaks: an age band falls through to the wrong value (or to undefined).
  it('gives each age band its own value', () => {
    expect(at(10 * 60).value).toBe(0.5);
    expect(at(5 * HOUR).value).toBe(0.55);
    expect(at(2 * DAY).value).toBe(0.65);
    expect(at(5 * DAY).value).toBe(0.75);
    expect(at(10 * DAY).value).toBe(0.4);
  });

  // Breaks: a burst or a routine sender stops adjusting the band's value.
  it('adjusts the band value for a burst and for a routine sender', () => {
    expect(computeTemporalSignal(sentAt, sentAt + 60, false, 3, []).value).toBe(0.75);
    expect(computeTemporalSignal(sentAt, sentAt + 60, true, 0, []).value).toBeCloseTo(0.3);
  });
});
