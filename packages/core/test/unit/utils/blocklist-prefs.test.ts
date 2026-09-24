import { describe, expect, it } from 'vitest';

import {
  defaultBlocklistPrefs,
  normalizeBlocklistEndpoint,
  readBlocklistPrefs,
  type BlocklistPrefs,
} from '../../../src/utils/blocklist-prefs';

/**
 * The blocklist preferences, as both the main process and the Blocklists tab
 * read them.
 *
 * What this protects: which third parties are told, per message, who writes to
 * this user. Three regressions matter. The default must actually reach existing
 * installs — they all have the OLD default saved explicitly; a user who switched
 * lists off, in either of the two places that used to control them, must stay
 * off whatever else happens to the blob; and the second control's choices
 * (the Sarv service, link lookups, registration dates) must survive the
 * move into this one section rather than silently resetting.
 */
const CATALOGUE = ['spamhaus-zen', 'spamhaus-dbl', 'spamcop'] as const;
const DEFAULTS: BlocklistPrefs = {
  enabled: true,
  provider: 'local',
  zones: [...CATALOGUE],
  servers: [],
  endpoint: '',
  reports: false,
  links: false,
  domainAge: true,
};
/** The shape the Settings screen saved into every blob before 2026-09-23. */
const OLD_SAVED_DEFAULT = { enabled: false, zones: [], servers: [] };
const read = (reputation: unknown, legacy: Record<string, unknown> = {}) =>
  readBlocklistPrefs({ signatures: [], ...legacy, reputation }, CATALOGUE);

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

describe('readBlocklistPrefs — the section itself', () => {
  it('reads an absent or unusable section, or blob, as the default', () => {
    for (const section of [undefined, null, 'yes', 42, true, ['spamcop']]) {
      expect(read(section), JSON.stringify(section)).toEqual(DEFAULTS);
    }
    for (const blob of [undefined, null, 'not an object', 7, []]) {
      expect(readBlocklistPrefs(blob, CATALOGUE), JSON.stringify(blob)).toEqual(DEFAULTS);
    }
  });

  // THE first migration. Every install that ever saved Settings has the old
  // default stored as an explicit "off". Read literally, the new default
  // would never reach a single existing user.
  it('reads the old saved default — off, no lists, no resolvers, unmarked — as the new default', () => {
    expect(read(OLD_SAVED_DEFAULT)).toEqual(DEFAULTS);
  });

  // ...and the tab's mark is what keeps a real "off" from being migrated.
  it('honours the same shape when the Blocklists tab marked it as the user’s choice', () => {
    expect(read({ ...OLD_SAVED_DEFAULT, chosen: true })).toEqual({ ...DEFAULTS, enabled: false, zones: [], chosen: true });
  });

  // Regression: every section that is not the old default is somebody's
  // choice, and is read literally — "truthy" is not "true".
  it('reads any other section literally', () => {
    expect(read({ enabled: false, zones: ['spamcop'], servers: [] })).toEqual({ ...DEFAULTS, enabled: false, zones: ['spamcop'] });
    expect(read({ enabled: 1, zones: 'all' })).toEqual({ ...DEFAULTS, enabled: false, zones: [] });
    expect(read({ enabled: false, zones: [] })).toEqual({ ...DEFAULTS, enabled: false, zones: [] });
    expect(read({})).toEqual({ ...DEFAULTS, enabled: false, zones: [] });
    expect(
      read({ enabled: true, zones: ['spamcop', 'spamhaus-zen'], servers: [' 10.0.0.1 ', '', 7], chosen: true }),
    ).toEqual({ ...DEFAULTS, zones: ['spamcop', 'spamhaus-zen'], servers: ['10.0.0.1'], chosen: true });
  });

  // Regression: a zone name this build does not know — a typo, or a blob from
  // a newer build — must never become a query.
  it('drops zone names that are not in the catalogue', () => {
    expect(read({ enabled: true, zones: ['spamcop', 'made-up.example', 42], servers: [] }).zones).toEqual(['spamcop']);
    expect(read({ provider: 'local', enabled: true, zones: ['made-up.example', 'spamcop'] }).zones).toEqual(['spamcop']);
  });

  it('keeps the mark only when it is exactly true', () => {
    expect(read({ enabled: true, zones: [], servers: [], chosen: 'yes' })).not.toHaveProperty('chosen');
  });
});

describe('readBlocklistPrefs — a section this build’s tab saved', () => {
  const saved = (over: Record<string, unknown>) => ({
    enabled: true, provider: 'local', zones: ['spamcop'], servers: [], endpoint: '', reports: false,
    links: false, domainAge: true, chosen: true, ...over,
  });

  it('reads every field literally', () => {
    expect(read(saved({ provider: 'sarv', endpoint: 'https://rep.sarv.example/', reports: true, links: true, domainAge: false }))).toEqual({
      enabled: true, provider: 'sarv', zones: ['spamcop'], servers: [], endpoint: 'https://rep.sarv.example',
      reports: true, links: true, domainAge: false, chosen: true,
    });
    expect(read(saved({ enabled: 'yes', reports: 1, links: 'on' }))).toMatchObject({ enabled: false, reports: false, links: false });
    // Registration dates are on unless explicitly off — the same default as a fresh install.
    expect(read(saved({ domainAge: undefined })).domainAge).toBe(true);
  });

  // Regression: once the user has saved the one tab, the fields the retired
  // General control left behind in the blob must not override it. The Settings
  // screen keeps re-saving whatever the blob held, so they never go away.
  it('ignores the retired Settings > General fields entirely', () => {
    const legacy = { spamReputationMode: 'off', spamReputationEndpoint: 'https://old.example', spamReputationReports: true, spamReputationDomainAge: false };
    expect(read(saved({}), legacy)).toEqual({ ...DEFAULTS, zones: ['spamcop'], chosen: true });
  });
});

/**
 * THE second migration: the Settings > General "Sender reputation checks"
 * control, retired on 2026-09-24. Each case is one kind of install that exists.
 */
describe('readBlocklistPrefs — migrating the retired Settings > General control', () => {
  // The default install: 'sarv' saved with no endpoint asked nobody, so its
  // lookups were the Blocklists tab's own — every list, this computer's DNS.
  it('reads the default "Sarv service, no address" as the default', () => {
    expect(read(OLD_SAVED_DEFAULT, { spamReputationMode: 'sarv', spamReputationEndpoint: '', spamReputationReports: false })).toEqual(DEFAULTS);
    expect(read(undefined, { spamReputationMode: 'sarv' })).toEqual(DEFAULTS);
  });

  // Regression: "Off — judge from headers alone" was an explicit choice not to
  // ask anybody. It must not come back on because the other control defaulted
  // on, and it switched off the registration-date lookups too.
  it('keeps an explicit "Off" off, lists and registration dates both', () => {
    expect(read(OLD_SAVED_DEFAULT, { spamReputationMode: 'off' })).toEqual({ ...DEFAULTS, enabled: false, domainAge: false });
    expect(read(undefined, { spamReputationMode: 'off', spamReputationDomainAge: true })).toMatchObject({ enabled: false, domainAge: false });
  });

  // Two explicit, contradictory choices resolve to the one that asks nobody.
  it('lets an explicit off in either control win over an on in the other', () => {
    expect(read({ enabled: true, zones: ['spamcop'], servers: [] }, { spamReputationMode: 'off' }).enabled).toBe(false);
    expect(read({ enabled: false, zones: ['spamcop'], servers: [] }, { spamReputationMode: 'local' }).enabled).toBe(false);
  });

  // 'Local DNS blocklists' also looked up the domains a body links to.
  it('keeps the link lookups that "Local DNS blocklists" made', () => {
    expect(read(OLD_SAVED_DEFAULT, { spamReputationMode: 'local' })).toEqual({ ...DEFAULTS, links: true });
  });

  // A configured Sarv service was THE answer for that user — "lookups never go
  // to list operators from your machine" — so it becomes the provider, with its
  // address, its report opt-in and its link lookups.
  it('turns a configured Sarv service into the Sarv provider', () => {
    expect(
      read(OLD_SAVED_DEFAULT, { spamReputationMode: 'sarv', spamReputationEndpoint: 'https://rep.sarv.example/', spamReputationReports: true }),
    ).toEqual({ ...DEFAULTS, provider: 'sarv', endpoint: 'https://rep.sarv.example', reports: true, links: true });
  });

  // Regression: an address that is not https would carry the user's bearer
  // token in the clear, so it is no address — and with none, nothing moves.
  it('does not treat an unusable Sarv address as configured', () => {
    expect(read(OLD_SAVED_DEFAULT, { spamReputationMode: 'sarv', spamReputationEndpoint: 'http://rep.sarv.example' })).toEqual(DEFAULTS);
  });

  it('carries the registration-date toggle across, on unless it was explicitly off', () => {
    expect(read(undefined, { spamReputationDomainAge: false }).domainAge).toBe(false);
    expect(read(undefined, { spamReputationDomainAge: 'no' }).domainAge).toBe(true);
  });

  // A section the 2026-09-23 tab saved has the mark but none of the new
  // fields: its lists are the user's, the rest comes from the retired control.
  it('reads a marked section from before the merge with the retired control beside it', () => {
    expect(
      read({ enabled: true, zones: ['spamcop'], servers: ['10.0.0.1'], chosen: true }, { spamReputationMode: 'local', spamReputationDomainAge: false }),
    ).toEqual({ ...DEFAULTS, zones: ['spamcop'], servers: ['10.0.0.1'], links: true, domainAge: false, chosen: true });
  });
});

describe('normalizeBlocklistEndpoint', () => {
  it('keeps an https origin without its trailing slashes, and nothing else', () => {
    expect(normalizeBlocklistEndpoint(' https://rep.sarv.example// ')).toBe('https://rep.sarv.example');
    for (const bad of ['http://rep.sarv.example', 'not a url', '', 5, null, undefined]) {
      expect(normalizeBlocklistEndpoint(bad), String(bad)).toBe('');
    }
  });
});
