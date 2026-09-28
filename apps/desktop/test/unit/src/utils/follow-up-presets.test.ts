import { describe, expect, it } from 'vitest';

import { describeFollowUp, followUpPresets, followUpStatusText } from '../../../../src/utils/follow-up-presets';

// The compose bell's choices and how a reminder reads back. A preset wired to
// the wrong delay reminds on the wrong day; a summary that misreads the
// request tells the user a reminder is set when it is not (or vice versa).

const DAY = 86_400;
// Local-time construction: every expectation below is formatted in local time too.
const NOW = new Date(2026, 8, 28, 9, 0, 0);

describe('followUpPresets', () => {
  // Delays, not times: each counts from the actual send.
  it('offers 1, 2, 3 days and a week as delays, with the local date they land on', () => {
    expect(followUpPresets(NOW)).toEqual([
      { label: 'In 1 day', sublabel: 'Tue, Sep 29', value: { afterSeconds: DAY } },
      { label: 'In 2 days', sublabel: 'Wed, Sep 30', value: { afterSeconds: 2 * DAY } },
      { label: 'In 3 days', sublabel: 'Thu, Oct 1', value: { afterSeconds: 3 * DAY } },
      { label: 'In 1 week', sublabel: 'Mon, Oct 5', value: { afterSeconds: 7 * DAY } },
    ]);
  });

  it('defaults to the current clock', () => {
    expect(followUpPresets()).toHaveLength(4);
  });
});

describe('describeFollowUp', () => {
  it('names a preset delay by its short label', () => {
    expect(describeFollowUp({ afterSeconds: 7 * DAY })).toBe('Remind me if no reply in 1 week');
  });

  // A delay that is no preset (an old draft) still reads sensibly.
  it('rounds any other delay to whole days, at least one', () => {
    expect(describeFollowUp({ afterSeconds: 5 * DAY })).toBe('Remind me if no reply in 5 days');
    expect(describeFollowUp({ afterSeconds: 3600 })).toBe('Remind me if no reply in 1 day');
  });

  it('shows a picked date in local time', () => {
    expect(describeFollowUp({ at: Math.floor(NOW.getTime() / 1000) })).toBe('Remind me if no reply by Mon, Sep 28, 9:00 AM');
  });

  // No reminder must read as none, so the bell does not show as active.
  it.each([null, undefined, {}, { at: 0 }, { afterSeconds: 0 }])('is null for %j', (request) => {
    expect(describeFollowUp(request)).toBeNull();
  });
});

describe('followUpStatusText', () => {
  const sentAt = Math.floor(NOW.getTime() / 1000);

  it('says since when there has been no reply once due', () => {
    expect(followUpStatusText({ status: 'due', sentAt, dueAt: sentAt + DAY })).toBe('No reply since Mon, Sep 28');
  });

  it('says when it will remind while waiting', () => {
    expect(followUpStatusText({ status: 'pending', sentAt, dueAt: sentAt + DAY })).toBe('Reminder Tue, Sep 29, 9:00 AM');
  });
});
