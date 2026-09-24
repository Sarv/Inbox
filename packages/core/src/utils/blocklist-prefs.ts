/**
 * The blocklist preferences — who is asked about incoming mail, and how —
 * stored in the settings blob, read ONE way by every reader: the main process,
 * which decides what gets asked, and the Security > Blocklists tab, which shows
 * the user what is being asked. Two readers that disagreed would show a user
 * ticked boxes for lists nobody asks, or the reverse.
 *
 * ONE SETTING FOR ONE FEATURE. Until 2026-09-24 two controls asked the same
 * lists about the same sender: Security > Blocklists drove the lookup made as
 * mail arrives (`enabled` / `zones` / `servers` under `reputation`), and
 * Settings > General drove a background pass (`spamReputationMode` off / local
 * / sarv, `spamReputationEndpoint`, `spamReputationReports`,
 * `spamReputationDomainAge` at the top of the blob). They are one section now,
 * and this module is where the old fields are read into it.
 *
 * ON BY DEFAULT, EVERY LIST, THIS COMPUTER'S DNS. Decided 2026-09-23. A section
 * that is absent, unreadable, or not an object reads as that default.
 *
 * TWO MIGRATIONS, both for sections the new tab has never saved (the tab
 * writes `provider`, and a section that has one is read literally, legacy
 * fields ignored):
 *
 *  - The old saved "off". Until 2026-09-23 the default was "off, no lists", and
 *    the Settings screen saves every default into the blob when it saves
 *    anything — so every install that ever pressed Save has
 *    `{ enabled: false, zones: [], servers: [] }` stored, indistinguishable
 *    from a user who switched it off. That exact shape, with no `chosen` mark,
 *    reads as the default. The one person it misreads is somebody who ticked
 *    lists, unticked every one and switched it off before the mark existed.
 *  - The General tab's fields. `spamReputationMode: 'sarv'` with an endpoint
 *    becomes the Sarv provider; 'local' or a configured Sarv service keeps the
 *    link-domain lookups that mode made. An EXPLICIT off in either place wins:
 *    `spamReputationMode: 'off'` said "judge from headers alone", so it turns
 *    the lists off and the registration-date lookups with them, whatever the
 *    other section says. Two contradictory choices resolve to the one that asks
 *    nobody — the user can turn it back on, and cannot un-ask a query.
 *
 * Every other value is read LITERALLY: `enabled` is only the boolean true, a
 * zone list that is not a list of known names is no zones at all, an endpoint
 * that is not https is no endpoint.
 *
 * Zero imports, so the renderer can take it through a deep alias without the
 * core barrel. The catalogue of zone names is the caller's to pass — both
 * callers already hold `BLOCKLISTS` from `@sarv-in/mailguard/reputation`.
 */

/** Who answers: this computer's own DNS queries, or the Sarv-hosted service. */
export type BlocklistProvider = 'local' | 'sarv';

export interface BlocklistPrefs {
  /** Ask anyone at all about incoming mail's sender (and, with `links`, its links). */
  enabled: boolean;
  /** Who is asked. 'sarv' with no endpoint asks nobody. */
  provider: BlocklistProvider;
  /** 'local': zone names from the scanner's catalogue. */
  zones: string[];
  /** 'local': resolvers to query. Empty means the system's. */
  servers: string[];
  /** 'sarv': the service origin, https only. Empty means not configured. */
  endpoint: string;
  /** 'sarv': share the user's own Report spam / Not spam verdicts. Opt-in. */
  reports: boolean;
  /** Also ask about the domains a message's body links to. Opt-in. */
  links: boolean;
  /**
   * Ask the domain registry (RDAP) how recently the sender's and the linked
   * domains were registered. Not a blocklist, so not under `enabled`; on by
   * default.
   */
  domainAge: boolean;
  /** Written by the Blocklists tab on every save: this section is the user's own choice. */
  chosen?: true;
}

/** What a fresh install asks: every list in the catalogue, through the system resolver. */
export function defaultBlocklistPrefs(catalogue: readonly string[]): BlocklistPrefs {
  return {
    enabled: true,
    provider: 'local',
    zones: [...catalogue],
    servers: [],
    endpoint: '',
    reports: false,
    links: false,
    domainAge: true,
  };
}

/**
 * The Sarv service origin as it may be used: https only, no trailing slash.
 * Anything else — http, not a URL, not a string — is no endpoint, so a stray
 * value can never turn into a request carrying the user's bearer token.
 */
export function normalizeBlocklistEndpoint(value: unknown): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return '';
  try {
    return new URL(raw).protocol === 'https:' ? raw.replace(/\/+$/, '') : '';
  } catch {
    return '';
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

const isEmptyList = (value: unknown): boolean => Array.isArray(value) && value.length === 0;

const isProvider = (value: unknown): value is BlocklistProvider => value === 'local' || value === 'sarv';

/** A zone name this build's catalogue does not know is dropped, so it can never become a query. */
const knownZones = (value: unknown, catalogue: readonly string[]): string[] => {
  const known = new Set(catalogue);
  return strings(value).filter((name) => known.has(name));
};

const resolvers = (value: unknown): string[] =>
  strings(value).map((server) => server.trim()).filter(Boolean);

/**
 * The preferences the settings blob means. `settings` is the whole parsed
 * blob — the legacy fields this reads live beside the section, not in it;
 * `catalogue` is the zone names this build can query, in the order a fresh
 * install should ask them.
 */
export function readBlocklistPrefs(settings: unknown, catalogue: readonly string[]): BlocklistPrefs {
  const blob = isRecord(settings) ? settings : {};
  const section = isRecord(blob.reputation) ? blob.reputation : null;
  const chosen = section?.chosen === true ? { chosen: true as const } : {};

  // Saved by this build's tab: literal, and nothing outside it counts.
  if (section && isProvider(section.provider)) {
    return {
      enabled: section.enabled === true,
      provider: section.provider,
      zones: knownZones(section.zones, catalogue),
      servers: resolvers(section.servers),
      endpoint: normalizeBlocklistEndpoint(section.endpoint),
      reports: section.reports === true,
      links: section.links === true,
      domainAge: section.domainAge !== false,
      ...chosen,
    };
  }

  // Everything below is a section written before the two settings were one.
  // `explicit` is a section somebody chose; the old saved default is not one.
  const defaults = defaultBlocklistPrefs(catalogue);
  const explicit =
    section &&
    !(!chosen.chosen && section.enabled === false && isEmptyList(section.zones) && isEmptyList(section.servers))
      ? section
      : null;
  const mode = blob.spamReputationMode;
  const off = mode === 'off';
  const endpoint = normalizeBlocklistEndpoint(blob.spamReputationEndpoint);
  // Any mode but 'off' and 'local' was the old default, 'sarv' — which, with
  // no endpoint, asked nobody.
  const sarv = !off && mode !== 'local' && endpoint !== '';
  return {
    enabled: (explicit ? explicit.enabled === true : defaults.enabled) && !off,
    provider: sarv ? 'sarv' : 'local',
    zones: explicit ? knownZones(explicit.zones, catalogue) : defaults.zones,
    servers: explicit ? resolvers(explicit.servers) : defaults.servers,
    endpoint,
    reports: blob.spamReputationReports === true,
    // The background pass looked up link domains through whichever provider
    // the General tab named; the default named none that could answer.
    links: mode === 'local' || sarv,
    domainAge: !off && blob.spamReputationDomainAge !== false,
    ...chosen,
  };
}
