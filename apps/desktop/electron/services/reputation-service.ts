/**
 * Blocklist (DNSBL) lookups for the whole process.
 *
 * The scanner's reputation stage is the only spam check that leaves the
 * machine: it tells a third party, in real time, which addresses and domains
 * are writing to this user. Three things follow from that, and are true of no
 * other stage in the filter.
 *
 *  - It is ON by default, with every zone in the scanner's catalogue, and the
 *    user unticks lists or turns it off in Security > Blocklists. Default-on
 *    is a product decision taken on 2026-09-23: the lure that shaped that
 *    week's work was five days old and on no list, but the lists ARE where a
 *    week-old campaign ends up, and a filter that never asks them never
 *    benefits. What makes default-on safe to ship is the per-zone breaker in
 *    the core stage — an operator that refuses this network is retired on its
 *    own while the others keep answering.
 *  - There is exactly ONE stage for the process, shared by every account's
 *    sync engine. Two accounts receiving the same newsletter ask the operator
 *    once, not twice, and one account's failures open the breaker for all of
 *    them, which is right: the failure is the resolver, not the account.
 *  - Its settings live in the ordinary settings blob, mirrored into the core
 *    DB by the renderer's app-settings bootstrap, so main reads them with the
 *    same `getAllAppSettings` every other durable setting uses and hears about
 *    a change through `noteAppSettingChanged` below.
 *
 * The resolver list matters more than it looks. Spamhaus and others refuse
 * queries that reach them through a public or open resolver, which is what a
 * home connection on its ISP's DNS (or on 8.8.8.8) almost always is. The
 * refusal is itself an answer, `127.255.255.254`; the library reads it as a
 * refusal rather than a listing, and the breaker inside ReputationStage stops
 * us hammering a zone that will never answer. A user who wants this on
 * realistically needs their own resolver or a keyed subscription zone.
 */
import { BLOCKLISTS, type Blocklist } from '@sarv-in/mailguard';
import {
  createLogger,
  readBlocklistPrefs,
  ReputationStage,
  type BlocklistPrefs,
  type ReputationLookup,
  type ReputationSubject,
} from '@sarvinbox/core';

import { getAllAppSettings } from './core-db';

const logger = createLogger('Reputation');

/** The localStorage key the settings blob is mirrored under. */
export const SETTINGS_KEY = 'sarvinbox-settings';

/**
 * The user's choices, as stored inside that blob. The shape and the reading —
 * defaults, the one-time migration of the old saved "off", the literal read of
 * everything else — live in core's `blocklist-prefs`, shared with the
 * Blocklists tab so the ticks a user sees are the lists that are queried.
 */
export type ReputationSettings = BlocklistPrefs;

/** Every zone the scanner describes, in catalogue order — what a fresh install asks. */
export const DEFAULT_ZONES: readonly string[] = BLOCKLISTS.map((list) => list.name);

export const DEFAULT_REPUTATION_SETTINGS: ReputationSettings = readBlocklistPrefs(undefined, DEFAULT_ZONES);

const CATALOGUE = new Map<string, Blocklist>(BLOCKLISTS.map((list) => [list.name, list]));

/** Every zone this build can be asked to query, for the settings UI. */
export function availableBlocklists(): ReadonlyArray<{ name: string; zone: string; kind: string }> {
  return BLOCKLISTS.map(({ name, zone, kind }) => ({ name, zone, kind }));
}

/**
 * Read the user's choices out of the stored settings blob.
 *
 * This value crosses from the renderer's localStorage into a DNS query, so
 * the section is re-derived rather than trusted — by `readBlocklistPrefs`,
 * which is also what the Blocklists tab reads it with. An unreadable blob
 * reads as no section at all: the defaults.
 */
export function readReputationSettings(
  stored: Record<string, string> = getAllAppSettings(),
): ReputationSettings {
  let section: unknown;
  try {
    const raw = stored[SETTINGS_KEY];
    section = raw ? (JSON.parse(raw) as { reputation?: unknown } | null)?.reputation : undefined;
  } catch {
    section = undefined;
  }
  return readBlocklistPrefs(section, DEFAULT_ZONES);
}

let stage: ReputationStage | null = null;
let applied: ReputationSettings | null = null;

/**
 * The one lookup every engine is handed. It reads whichever stage is current
 * at call time, so a settings change takes effect without re-wiring a single
 * engine — including engines belonging to accounts activated before the
 * change.
 */
const lookup: ReputationLookup = (subject: ReputationSubject) =>
  stage ? stage.assess(subject) : Promise.resolve(null);

function buildStage(settings: ReputationSettings): ReputationStage | null {
  if (!settings.enabled || settings.zones.length === 0) return null;
  const blocklists = settings.zones
    .map((name) => CATALOGUE.get(name))
    .filter((list): list is Blocklist => list !== undefined);
  return new ReputationStage({ blocklists, servers: settings.servers });
}

const sameSettings = (a: ReputationSettings, b: ReputationSettings): boolean =>
  a.enabled === b.enabled &&
  a.zones.join(' ') === b.zones.join(' ') &&
  a.servers.join(' ') === b.servers.join(' ');

/**
 * Give a sync engine the shared lookup.
 *
 * Called for every engine, whether or not the feature is on: a lookup with no
 * stage behind it answers `null` and costs nothing, and wiring only-when-
 * enabled would leave every engine created before the switch unwired.
 */
export function attachReputation(engine: { setReputationLookup(fn: ReputationLookup): void }): void {
  refreshReputation();
  engine.setReputationLookup(lookup);
}

/**
 * Re-read the settings and rebuild the stage if they changed.
 *
 * The rebuild drops the cache, which is the point: a user who has just added a
 * zone expects the next message to be asked about, not answered from a verdict
 * reached before that zone was on the list.
 */
export function refreshReputation(): void {
  const settings = readReputationSettings();
  if (applied && sameSettings(settings, applied)) return;
  applied = settings;
  stage = buildStage(settings);
  logger.info(
    stage
      ? `Blocklist lookups on: ${settings.zones.join(', ')} via ${settings.servers.length > 0 ? settings.servers.join(', ') : 'the system resolver'}`
      : 'Blocklist lookups off',
  );
}

/**
 * Told by the app-settings IPC that a key was written. Only the settings blob
 * carries this feature's configuration, so everything else is ignored.
 */
export function noteAppSettingChanged(key: string): void {
  if (key === SETTINGS_KEY) refreshReputation();
}
