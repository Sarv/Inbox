/**
 * The extension registry the app browses and installs from.
 *
 * Extensions are NOT bundled with the app and do not live in this repository.
 * They are published to https://github.com/Sarv/SarvInbox-extensions, which
 * serves a `registry.json` index; each entry points at a `.tgz` attached to a
 * GitHub release and pins its SHA-256. Installing is therefore: fetch the
 * index, download the archive, check the hash, show the user which permissions
 * the manifest asks for, and only then unpack and activate.
 *
 * Everything here is PURE — parsing, validation, version comparison, and the
 * merge of "what the registry offers" with "what is installed". The network,
 * the filesystem and the prompt live in the desktop service that calls it
 * (`extension-marketplace.ts`), so the rules that decide whether a download is
 * acceptable can be unit-tested directly instead of through a fake HTTP stack.
 *
 * Parsing never throws. A registry is a remote document that can be truncated,
 * half-written by a failed CI run, or simply newer than this app: one unusable
 * entry must cost the user that one extension, not the whole panel. Bad entries
 * come back in `rejected` with a reason so the log says what was wrong.
 */

import { satisfiesVersion } from './extension-loader';
import { PERMISSION_INFO, type ExtensionPermission } from './types';

/** Hosts a registry document, icon or download may be served from. */
export const TRUSTED_REGISTRY_HOSTS = Object.freeze([
  'github.com',
  'raw.githubusercontent.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
]);

/**
 * The newest registry schema this build understands. Older ones still parse.
 *
 * v1 is one flat document: every field of every extension, including the
 * download URL and its digest, in a single file the app fetches whole.
 *
 * v2 splits it. The index carries only what the Browse LIST draws - name,
 * version, description, author, keywords, engine range, permissions, size and
 * download count - and points at a per-extension document for everything else,
 * fetched when the user actually clicks Install. The download block and its
 * pinned SHA-256 live there. That is roughly a quarter of the bytes per entry,
 * and the part that grows fastest with the catalogue is the part nobody reads
 * until they install something.
 *
 * Both are accepted, because a user may have configured a registry that has not
 * been regenerated. A v1 entry simply arrives with its `download` already
 * filled in and no detail document to fetch.
 */
export const REGISTRY_SCHEMA_VERSION = 2;

const SHA256_HEX = /^[0-9a-f]{64}$/;

/** Archives are small; anything larger is a mistake or an attack, not an extension. */
export const MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024;

export interface RegistryDownload {
  url: string;
  /** Lowercase hex SHA-256 of the archive. The install is refused on mismatch. */
  sha256: string;
  size: number;
  publishedAt?: string;
  releaseTag?: string;
}

export interface RegistryEntryStats {
  downloads: number;
  /** 0-5. Reserved: GitHub has no review system, so no registry fills this in yet. */
  rating?: number;
  ratingCount?: number;
}

/**
 * What the extension contributes, as far as the LIST needs to know.
 *
 * Not the manifest's `contributes` block: only the fields the app turns into
 * "what this does and where you will see it" survive the trip, so the index
 * does not grow a copy of every workflow's configuration. Everything here is
 * descriptive - nothing in it grants anything, and nothing is trusted to be
 * accurate beyond being shown.
 */
export interface RegistryContributions {
  panels?: { title: string; surface: string; autoOpen?: boolean }[];
  workflows?: { name: string; requiresAI?: boolean }[];
  /** Only the count is used - one entry per setting the extension adds. */
  settings?: { key: string }[];
  capabilities?: { id: string; description?: string }[];
}

/** One picture of the extension in use, with its URL already checked. */
export interface RegistryScreenshot {
  url: string;
  caption?: string;
}

export interface RegistryEntry {
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  license?: string;
  keywords: string[];
  homepage?: string;
  iconUrl?: string;
  readmeUrl?: string;
  /** Semver range of app versions this extension declares support for. */
  engineRange?: string;
  permissions: ExtensionPermission[];
  /**
   * Bytes of the release archive.
   *
   * Carried on the entry itself rather than read from `download`, because the
   * list shows a size for every extension but only fetches the download block
   * for the one being installed.
   */
  size: number;
  /**
   * Where the rest of this extension's record lives, when the registry is a v2
   * index. Absolute and already checked against the host allowlist.
   */
  detailUrl?: string;
  /**
   * How to fetch and verify the archive.
   *
   * Absent on a v2 index entry until its detail document has been read -
   * `mergeRegistryDetail` fills it in. Nothing may be downloaded without it,
   * because the digest it carries is the only thing that makes the archive safe
   * to unpack.
   */
  download?: RegistryDownload;
  stats: RegistryEntryStats;
  /**
   * What the extension does once it is running, for the "where will I see
   * this" section of the list and the install prompt.
   *
   * Carried on the index entry rather than only in the detail document because
   * the question it answers - what IS this - is the one being asked while
   * browsing, before anything has been clicked.
   */
  contributes?: RegistryContributions;
  /** Pictures of it in use. Dropped entirely if the URLs are not allowed ones. */
  screenshots?: RegistryScreenshot[];
  /** Which configured registry this came from — shown so the user can tell them apart. */
  sourceUrl: string;
}

export interface RegistrySourceStats {
  stars: number;
  watchers?: number;
}

export interface ParsedRegistry {
  sourceUrl: string;
  generatedAt: string | null;
  /** The repository the registry describes, for a "view on GitHub" link. */
  source: string | null;
  stats: RegistrySourceStats;
  entries: RegistryEntry[];
  rejected: RejectedEntry[];
}

export interface RejectedEntry {
  id: string | null;
  reason: string;
}

/** Whether a URL may be fetched: HTTPS only, and only from a known GitHub host. */
export function isTrustedRegistryUrl(url: unknown): url is string {
  if (typeof url !== 'string' || url.length === 0) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  return TRUSTED_REGISTRY_HOSTS.includes(parsed.hostname.toLowerCase());
}

/**
 * Turn a registry URL field into an absolute, trusted URL - or null.
 *
 * Registry documents may write these relative to their own location
 * (`e/otp-code.json`, `../extensions/otp-code/icon.svg`), which keeps the index
 * small and lets the same generated files be served from any host without
 * regenerating them. Resolution cannot be used to escape the allowlist: an
 * absolute URL in the field simply replaces the base, and the result is checked
 * exactly as an absolute one would be.
 */
export function resolveTrustedUrl(value: unknown, baseUrl: string): string | null {
  const raw = asString(value);
  if (!raw) return null;
  let absolute: string;
  try {
    absolute = new URL(raw, baseUrl).toString();
  } catch {
    return null;
  }
  return isTrustedRegistryUrl(absolute) ? absolute : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function asCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

/** Ids become folder names on disk, so the character set is deliberately narrow. */
const EXTENSION_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;

function parseDownload(raw: unknown): { download: RegistryDownload } | { reason: string } {
  if (!raw || typeof raw !== 'object') return { reason: 'no download block' };
  const record = raw as Record<string, unknown>;

  const url = asString(record.url);
  if (!url) return { reason: 'download.url is missing' };
  if (!isTrustedRegistryUrl(url)) return { reason: `download.url is not an allowed https GitHub URL: ${url}` };

  const sha256 = asString(record.sha256)?.toLowerCase() ?? null;
  // Fail closed: an entry with no usable checksum is not installable at all,
  // because the checksum is the only thing that makes the download safe to run.
  if (!sha256 || !SHA256_HEX.test(sha256)) return { reason: 'download.sha256 is not a 64-character hex digest' };

  const size = asCount(record.size);
  if (size <= 0) return { reason: 'download.size is missing or not positive' };
  if (size > MAX_DOWNLOAD_BYTES) return { reason: `download.size ${size} exceeds the ${MAX_DOWNLOAD_BYTES} byte cap` };

  return {
    download: {
      url,
      sha256,
      size,
      publishedAt: asString(record.publishedAt) ?? undefined,
      releaseTag: asString(record.releaseTag) ?? undefined,
    },
  };
}

/**
 * Read the descriptive `contributes` summary off a registry record.
 *
 * Every field is optional and every malformed one is dropped rather than
 * rejecting the entry: this block only decides what sentence is printed under
 * an extension's name. An entry whose panel list is nonsense should lose the
 * sentence, not its place in the catalogue - unlike a permission, which is
 * rejected precisely because it decides what the extension may do.
 */
function parseContributions(raw: unknown): RegistryContributions | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const record = raw as Record<string, unknown>;
  const asArray = (value: unknown): Record<string, unknown>[] =>
    Array.isArray(value)
      ? value.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
      : [];

  const panels = asArray(record.panels)
    .map((panel) => ({
      title: asString(panel.title) ?? '',
      surface: asString(panel.surface) ?? 'modal',
      autoOpen: panel.autoOpen === true ? true : undefined,
    }))
    .filter((panel) => panel.title !== '');

  const workflows = asArray(record.workflows)
    .map((workflow) => ({
      name: asString(workflow.name) ?? '',
      requiresAI: workflow.requiresAI === true ? true : undefined,
    }))
    .filter((workflow) => workflow.name !== '');

  const settings = asArray(record.settings)
    .map((setting) => ({ key: asString(setting.key) ?? '' }))
    .filter((setting) => setting.key !== '');

  const capabilities = asArray(record.capabilities)
    .map((capability) => ({
      id: asString(capability.id) ?? '',
      description: asString(capability.description) ?? undefined,
    }))
    .filter((capability) => capability.id !== '');

  const summary: RegistryContributions = {};
  if (panels.length > 0) summary.panels = panels;
  if (workflows.length > 0) summary.workflows = workflows;
  if (settings.length > 0) summary.settings = settings;
  if (capabilities.length > 0) summary.capabilities = capabilities;
  return Object.keys(summary).length > 0 ? summary : undefined;
}

/**
 * Read the screenshot list, keeping only images from an allowed host.
 *
 * A screenshot is a URL the app will load, so an unchecked one is a request to
 * whatever server an extension author named - fetched the moment the catalogue
 * is drawn, before anyone has chosen to install anything. Running each through
 * `resolveTrustedUrl` keeps it to the same hosts the registry and the download
 * itself come from; a picture elsewhere is simply not shown.
 */
function parseScreenshots(raw: unknown, baseUrl: string): RegistryScreenshot[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const shots = raw
    .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
    .flatMap((item) => {
      const url = resolveTrustedUrl(item.url, baseUrl);
      return url ? [{ url, caption: asString(item.caption) ?? undefined }] : [];
    })
    // Enough to show what it looks like; a registry cannot turn the prompt
    // into an unbounded gallery.
    .slice(0, 6);
  return shots.length > 0 ? shots : undefined;
}

function parseEntry(raw: unknown, sourceUrl: string): { entry: RegistryEntry } | { rejected: RejectedEntry } {
  if (!raw || typeof raw !== 'object') return { rejected: { id: null, reason: 'entry is not an object' } };
  const record = raw as Record<string, unknown>;

  const id = asString(record.id);
  if (!id || !EXTENSION_ID.test(id)) {
    return { rejected: { id, reason: `id "${id ?? ''}" is not a valid extension id` } };
  }

  const name = asString(record.name);
  const version = asString(record.version);
  const description = asString(record.description);
  const author = asString(record.author);
  if (!name || !version || !description || !author) {
    return { rejected: { id, reason: 'name, version, description and author are all required' } };
  }

  // An unknown permission is a rejection rather than something to ignore: the
  // user is about to be shown what this extension may do, and a permission we
  // cannot name is one we cannot put in front of them honestly.
  const requested = asStringArray(record.permissions);
  const unknown = requested.filter((permission) => !(permission in PERMISSION_INFO));
  if (unknown.length > 0) {
    return { rejected: { id, reason: `unknown permissions: ${unknown.join(', ')}` } };
  }

  // A v1 entry carries the whole download block. A v2 index entry carries a
  // size and a pointer to the document that holds it. Neither means the entry
  // cannot be installed at all, so it is not offered.
  const detailUrl = record.detailUrl === undefined
    ? null
    : resolveTrustedUrl(record.detailUrl, sourceUrl);
  if (record.detailUrl !== undefined && !detailUrl) {
    return { rejected: { id, reason: `detailUrl is not an allowed https GitHub URL: ${String(record.detailUrl)}` } };
  }

  let download: RegistryDownload | undefined;
  let size: number;
  if (record.download !== undefined) {
    const parsed = parseDownload(record.download);
    if ('reason' in parsed) return { rejected: { id, reason: parsed.reason } };
    download = parsed.download;
    size = parsed.download.size;
  } else if (detailUrl) {
    size = asCount(record.size);
    if (size <= 0) return { rejected: { id, reason: 'size is missing or not positive' } };
    if (size > MAX_DOWNLOAD_BYTES) {
      return { rejected: { id, reason: `size ${size} exceeds the ${MAX_DOWNLOAD_BYTES} byte cap` } };
    }
  } else {
    return { rejected: { id, reason: 'no download block and no detailUrl' } };
  }

  const engines = (record.engines ?? {}) as Record<string, unknown>;
  const statsRecord = (record.stats ?? {}) as Record<string, unknown>;
  const rating = typeof statsRecord.rating === 'number' && Number.isFinite(statsRecord.rating)
    ? Math.min(5, Math.max(0, statsRecord.rating))
    : undefined;

  const iconUrl = resolveTrustedUrl(record.iconUrl, sourceUrl);
  const readmeUrl = resolveTrustedUrl(record.readmeUrl, sourceUrl);

  return {
    entry: {
      id,
      name,
      version,
      description,
      author,
      license: asString(record.license) ?? undefined,
      keywords: asStringArray(record.keywords),
      homepage: asString(record.homepage) ?? undefined,
      // Dropped rather than rejected: a bad icon URL should cost the entry its
      // picture, not its listing.
      iconUrl: iconUrl ?? undefined,
      readmeUrl: readmeUrl ?? undefined,
      engineRange: asString(engines.sarvinbox) ?? undefined,
      permissions: requested as ExtensionPermission[],
      size,
      detailUrl: detailUrl ?? undefined,
      download,
      contributes: parseContributions(record.contributes),
      screenshots: parseScreenshots(record.screenshots, sourceUrl),
      stats: {
        downloads: asCount(statsRecord.downloads),
        rating,
        ratingCount: rating === undefined ? undefined : asCount(statsRecord.ratingCount),
      },
      sourceUrl,
    },
  };
}

/**
 * Turn a fetched registry document into entries this build can act on.
 *
 * Never throws — see the file comment.
 */
export function parseRegistryDocument(raw: unknown, sourceUrl: string): ParsedRegistry {
  const empty: ParsedRegistry = {
    sourceUrl,
    generatedAt: null,
    source: null,
    stats: { stars: 0 },
    entries: [],
    rejected: [],
  };

  if (!raw || typeof raw !== 'object') {
    return { ...empty, rejected: [{ id: null, reason: 'registry document is not an object' }] };
  }
  const document = raw as Record<string, unknown>;

  const schemaVersion = document.schemaVersion;
  if (typeof schemaVersion !== 'number' || schemaVersion > REGISTRY_SCHEMA_VERSION) {
    return {
      ...empty,
      rejected: [
        {
          id: null,
          reason: `registry schemaVersion ${String(schemaVersion)} is newer than this app understands (${REGISTRY_SCHEMA_VERSION})`,
        },
      ],
    };
  }

  const statsRecord = (document.stats ?? {}) as Record<string, unknown>;
  const rawEntries = Array.isArray(document.extensions) ? document.extensions : [];

  const entries: RegistryEntry[] = [];
  const rejected: RejectedEntry[] = [];
  const seen = new Set<string>();

  for (const rawEntry of rawEntries) {
    const parsed = parseEntry(rawEntry, sourceUrl);
    if ('rejected' in parsed) {
      rejected.push(parsed.rejected);
      continue;
    }
    // First listing of an id wins. A registry that names the same extension
    // twice is broken; silently taking the last one would make which build the
    // user gets depend on array order.
    if (seen.has(parsed.entry.id)) {
      rejected.push({ id: parsed.entry.id, reason: 'duplicate id in the same registry' });
      continue;
    }
    seen.add(parsed.entry.id);
    entries.push(parsed.entry);
  }

  return {
    sourceUrl,
    generatedAt: asString(document.generatedAt),
    source: asString(document.source),
    stats: { stars: asCount(statsRecord.stars), watchers: asCount(statsRecord.watchers) },
    entries,
    rejected,
  };
}

/**
 * Fold a per-extension detail document into the index entry it belongs to.
 *
 * This is where a v2 install gets its download URL and its pinned digest, so
 * the checks here are the same ones `parseEntry` applies to a v1 entry, plus
 * two the split makes possible:
 *
 *   - the document must name the SAME id, or a registry could point one
 *     extension's entry at another extension's archive;
 *   - it must name the SAME version the list offered, because the user is about
 *     to approve permissions for the version they were shown. A half-regenerated
 *     registry - index published, details not yet - fails here rather than
 *     quietly installing something else.
 *
 * Never throws; a reason comes back instead, for the same logging reason the
 * rest of this module never throws.
 */
export function mergeRegistryDetail(
  raw: unknown,
  entry: RegistryEntry
): { entry: RegistryEntry } | { reason: string } {
  if (!raw || typeof raw !== 'object') return { reason: 'detail document is not an object' };
  const document = raw as Record<string, unknown>;

  const schemaVersion = document.schemaVersion;
  if (typeof schemaVersion === 'number' && schemaVersion > REGISTRY_SCHEMA_VERSION) {
    return {
      reason: `detail schemaVersion ${schemaVersion} is newer than this app understands (${REGISTRY_SCHEMA_VERSION})`,
    };
  }

  const id = asString(document.id);
  if (id !== entry.id) return { reason: `detail document is for "${id ?? ''}", not "${entry.id}"` };

  const version = asString(document.version);
  if (version !== entry.version) {
    return {
      reason: `detail document offers ${entry.id} ${version ?? '(no version)'}, the list showed ${entry.version}`,
    };
  }

  const download = parseDownload(document.download);
  if ('reason' in download) return { reason: download.reason };

  const base = entry.detailUrl ?? entry.sourceUrl;
  const readmeUrl = resolveTrustedUrl(document.readmeUrl, base);
  const homepage = asString(document.homepage);

  return {
    entry: {
      ...entry,
      license: asString(document.license) ?? entry.license,
      homepage: homepage ?? entry.homepage,
      readmeUrl: readmeUrl ?? entry.readmeUrl,
      // The detail document is the authority on the archive, including its
      // size: it is the file the digest was taken over.
      size: download.download.size,
      download: download.download,
      // The detail document is where a v2 registry puts the long-form record,
      // so it may carry these when the thin index did not. It can also correct
      // them - it is the same generator run, describing the same archive.
      contributes: parseContributions(document.contributes) ?? entry.contributes,
      screenshots: parseScreenshots(document.screenshots, base) ?? entry.screenshots,
    },
  };
}

/**
 * Newest-first comparison of two extension versions.
 *
 * Returns > 0 when `left` is newer. Prereleases sort below the release they
 * lead up to, so `1.1.0-beta.1` is older than `1.1.0`.
 */
export function compareExtensionVersions(left: string, right: string): number {
  const split = (value: string): { parts: number[]; pre: string } => {
    const [core = '', pre = ''] = value.split('-', 2);
    const parts = core.split('.').map((part) => {
      const parsed = Number.parseInt(part, 10);
      return Number.isFinite(parsed) ? parsed : 0;
    });
    return { parts, pre };
  };

  const a = split(left);
  const b = split(right);
  for (let index = 0; index < 3; index += 1) {
    const difference = (a.parts[index] ?? 0) - (b.parts[index] ?? 0);
    if (difference !== 0) return difference;
  }
  if (a.pre === b.pre) return 0;
  if (a.pre === '') return 1;
  if (b.pre === '') return -1;
  return a.pre < b.pre ? -1 : 1;
}

export type CatalogState = 'available' | 'installed' | 'update-available' | 'incompatible';

export interface CatalogItem extends RegistryEntry {
  state: CatalogState;
  /** Version currently on disk, when the extension is installed. */
  installedVersion?: string;
  /** Whether the installed copy is switched on. */
  enabled?: boolean;
  /** Why it cannot be installed, when `state` is 'incompatible'. */
  incompatibleReason?: string;
}

export interface InstalledSummary {
  id: string;
  version: string;
  enabled: boolean;
}

export interface BuildCatalogOptions {
  entries: RegistryEntry[];
  installed: InstalledSummary[];
  /** The running app version, checked against each entry's `engines.sarvinbox`. */
  appVersion: string;
}

/**
 * Merge what the registries offer with what is on disk.
 *
 * Compatibility is decided here rather than at install time so an extension
 * that needs a newer app says so in the list, instead of failing after the user
 * has already agreed to its permissions.
 */
export function buildCatalog({ entries, installed, appVersion }: BuildCatalogOptions): CatalogItem[] {
  const installedById = new Map(installed.map((item) => [item.id, item]));

  return entries
    .map((entry): CatalogItem => {
      const local = installedById.get(entry.id);
      const compatible = !entry.engineRange || satisfiesVersion(appVersion, entry.engineRange);

      if (!compatible && !local) {
        return {
          ...entry,
          state: 'incompatible',
          incompatibleReason: `Needs Sarv Inbox ${entry.engineRange}; this is ${appVersion}`,
        };
      }
      if (!local) return { ...entry, state: 'available' };

      const newer = compareExtensionVersions(entry.version, local.version) > 0;
      return {
        ...entry,
        state: newer && compatible ? 'update-available' : 'installed',
        installedVersion: local.version,
        enabled: local.enabled,
      };
    })
    .sort((left, right) => {
      // Most-downloaded first, then alphabetical, so an empty registry and a
      // registry with no download counts still list deterministically.
      const byDownloads = right.stats.downloads - left.stats.downloads;
      return byDownloads !== 0 ? byDownloads : left.name.localeCompare(right.name);
    });
}

/**
 * Merge several registries into one catalogue, the earlier source winning a
 * clash.
 *
 * The official registry is always first in the configured list, so a
 * user-added registry can add extensions but can never shadow an official one
 * with a build of its own.
 */
export function mergeRegistries(registries: ParsedRegistry[]): RegistryEntry[] {
  const byId = new Map<string, RegistryEntry>();
  for (const registry of registries) {
    for (const entry of registry.entries) {
      if (!byId.has(entry.id)) byId.set(entry.id, entry);
    }
  }
  return [...byId.values()];
}
