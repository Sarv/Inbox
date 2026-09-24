/**
 * The blocklist (DNSBL) preferences stored in the settings blob, read ONE way
 * by every reader: the main process, which decides what gets queried, and the
 * Security > Blocklists tab, which shows the user what is being queried. Two
 * readers that disagreed would show a user ticked boxes for lists nobody asks,
 * or the reverse.
 *
 * ON BY DEFAULT, EVERY LIST. Decided 2026-09-23. A section that is absent,
 * unreadable, or not an object reads as that default.
 *
 * THE MIGRATION this module exists for. Until that date the default was "off,
 * no lists", and the Settings screen saves every default into the blob when it
 * saves anything — so every install that ever pressed Save has
 * `{ enabled: false, zones: [], servers: [] }` stored, indistinguishable from a
 * user who switched it off. Honouring it literally would leave the new default
 * unreachable for everyone who already has the app. So that exact shape, with
 * no `chosen` mark, reads as the default. The one person it misreads is
 * somebody who ticked lists, unticked every one and switched it off before the
 * mark existed; the Blocklists tab writes `chosen: true` on every save from now
 * on, so it cannot happen again.
 *
 * Every other section is read LITERALLY: `enabled` is only the boolean true,
 * a zone list that is not a list of known names is no zones at all. A user who
 * turned lists off stays off whatever else the blob has suffered.
 *
 * Zero imports, so the renderer can take it through a deep alias without the
 * core barrel. The catalogue of zone names is the caller's to pass — both
 * callers already hold `BLOCKLISTS` from `@sarv-in/mailguard/reputation`.
 */

export interface BlocklistPrefs {
  enabled: boolean;
  /** Zone names from the scanner's catalogue. */
  zones: string[];
  /** Resolvers to query. Empty means the system's. */
  servers: string[];
  /** Written by the Blocklists tab on every save: this section is the user's own choice. */
  chosen?: true;
}

/** What a fresh install queries: every list in the catalogue, through the system resolver. */
export function defaultBlocklistPrefs(catalogue: readonly string[]): BlocklistPrefs {
  return { enabled: true, zones: [...catalogue], servers: [] };
}

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

const isEmptyList = (value: unknown): boolean => Array.isArray(value) && value.length === 0;

/**
 * The stored section as the preferences it means. `section` is whatever sat
 * under `reputation` in the parsed blob; `catalogue` is the zone names this
 * build can query, in the order a fresh install should ask them.
 */
export function readBlocklistPrefs(section: unknown, catalogue: readonly string[]): BlocklistPrefs {
  if (!section || typeof section !== 'object' || Array.isArray(section)) {
    return defaultBlocklistPrefs(catalogue);
  }
  const value = section as Record<string, unknown>;
  const chosen = value.chosen === true;
  if (!chosen && value.enabled === false && isEmptyList(value.zones) && isEmptyList(value.servers)) {
    return defaultBlocklistPrefs(catalogue);
  }
  const known = new Set(catalogue);
  return {
    enabled: value.enabled === true,
    // A name this build's catalogue does not know is dropped rather than
    // passed through, so an unknown zone can never become a query.
    zones: strings(value.zones).filter((name) => known.has(name)),
    servers: strings(value.servers).map((server) => server.trim()).filter(Boolean),
    ...(chosen ? { chosen: true as const } : {}),
  };
}
