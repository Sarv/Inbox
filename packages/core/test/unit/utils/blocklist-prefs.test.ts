import { describe, expect, it } from 'vitest';

import { defaultBlocklistPrefs, readBlocklistPrefs } from '../../../src/utils/blocklist-prefs';

/**
 * The blocklist preferences, as both the main process and the Blocklists tab
 * read them.
 *
 * What this protects: which third parties are told, per message, who writes to
 * this user. Two regressions matter. The default must actually reach existing
 * installs — they all have the OLD default saved explicitly — and a user who
 * switched lists off must stay off whatever else happens to the blob.
 */
const CATALOGUE = ['spamhaus-zen', 'spamhaus-dbl', 'spamcop'] as const;
const DEFAULTS = { enabled: true, zones: [...CATALOGUE], servers: [] };

describe('defaultBlocklistPrefs', () => {
  it('asks every list in the catalogue, in its order, through the system resolver', () => {
    expect(defaultBlocklistPrefs(CATALOGUE)).toEqual(DEFAULTS);
  });

  // Regression: a shared default array would let one caller's edit leak into
  // every later default.
  it('returns a fresh zone list every time', () => {
    const first = defaultBlocklistPrefs(CATALOGUE);
    first.zones.pop();
    expect(defaultBlocklistPrefs(CATALOGUE).zones).toHaveLength(3);
  });
});

describe('readBlocklistPrefs', () => {
  it('reads an absent or unusable section as the default', () => {
    for (const section of [undefined, null, 'yes', 42, true, ['spamcop']]) {
      expect(readBlocklistPrefs(section, CATALOGUE), JSON.stringify(section)).toEqual(DEFAULTS);
    }
  });

  // THE migration. Every install that ever saved Settings has the old default
  // stored as an explicit "off". Read literally, the new default would never
  // reach a single existing user.
  it('reads the old saved default — off, no lists, no resolvers, unmarked — as the new default', () => {
    expect(readBlocklistPrefs({ enabled: false, zones: [], servers: [] }, CATALOGUE)).toEqual(DEFAULTS);
  });

  // ...and the tab's mark is what keeps a real "off" from being migrated.
  it('honours the same shape when the Blocklists tab marked it as the user’s choice', () => {
    expect(readBlocklistPrefs({ enabled: false, zones: [], servers: [], chosen: true }, CATALOGUE)).toEqual({
      enabled: false,
      zones: [],
      servers: [],
      chosen: true,
    });
  });

  // Regression: every section that is not the old default is somebody's
  // choice, and is read literally — "truthy" is not "true".
  it('reads any other section literally', () => {
    expect(readBlocklistPrefs({ enabled: false, zones: ['spamcop'], servers: [] }, CATALOGUE)).toEqual({
      enabled: false,
      zones: ['spamcop'],
      servers: [],
    });
    expect(readBlocklistPrefs({ enabled: 1, zones: 'all' }, CATALOGUE)).toEqual({ enabled: false, zones: [], servers: [] });
    expect(readBlocklistPrefs({ enabled: false, zones: [] }, CATALOGUE)).toEqual({ enabled: false, zones: [], servers: [] });
    expect(readBlocklistPrefs({}, CATALOGUE)).toEqual({ enabled: false, zones: [], servers: [] });
    expect(
      readBlocklistPrefs({ enabled: true, zones: ['spamcop', 'spamhaus-zen'], servers: [' 10.0.0.1 ', '', 7], chosen: true }, CATALOGUE),
    ).toEqual({ enabled: true, zones: ['spamcop', 'spamhaus-zen'], servers: ['10.0.0.1'], chosen: true });
  });

  // Regression: a zone name this build does not know — a typo, or a blob from
  // a newer build — must never become a query.
  it('drops zone names that are not in the catalogue', () => {
    expect(readBlocklistPrefs({ enabled: true, zones: ['spamcop', 'made-up.example', 42], servers: [] }, CATALOGUE).zones).toEqual([
      'spamcop',
    ]);
  });

  it('keeps the mark only when it is exactly true', () => {
    expect(readBlocklistPrefs({ enabled: true, zones: [], servers: [], chosen: 'yes' }, CATALOGUE)).not.toHaveProperty('chosen');
  });
});
