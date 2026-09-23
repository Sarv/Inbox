/**
 * Browsing and installing extensions from the GitHub-hosted registry.
 *
 * Extensions are not bundled with the app and do not live in this repository.
 * They are published to https://github.com/Sarv/SarvInbox-extensions, which
 * serves a `registry.json` index; each entry points at a `.tgz` attached to a
 * GitHub release and pins its SHA-256.
 *
 * An install is therefore five steps, in this order and no other:
 *
 *   1. fetch the index (HTTPS, GitHub hosts only, cached, fails open)
 *   2. download the archive, refusing anything over the declared size
 *   3. hash it and compare against the pinned digest — a mismatch aborts
 *   4. unpack into a staging folder and check the manifest agrees with the
 *      registry about its id and version
 *   5. hand the folder to the extension manager, which copies it in and
 *      activates it
 *
 * Nothing from the archive is executed before step 3 passes. The permission
 * prompt happens before any of it: the renderer shows the user what the
 * manifest asks for and passes back what they agreed to, and
 * `installFromRegistry` refuses if that no longer matches what the registry
 * says — which also catches a registry that changed between browsing and
 * clicking Install.
 *
 * Every rule about what is acceptable lives in `@sarvinbox/core`'s pure
 * `marketplace` module and is unit-tested there; this file is the I/O around
 * it.
 */

import { createHash } from 'crypto';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import {
  MAX_DOWNLOAD_BYTES,
  buildCatalog,
  createLogger,
  isTrustedRegistryUrl,
  mergeRegistries,
  mergeRegistryDetail,
  parseExtensionsConfig,
  parseRegistryDocument,
  registryMirrorUrl,
  type CatalogItem,
  type ExtensionPermission,
  type ParsedExtensionsConfig,
  type ParsedRegistry,
  type RegistryDownload,
  type RegistryEntry,
} from '@sarvinbox/core';
import { app } from 'electron';
import * as tar from 'tar';

import { getExtensionManager } from '../shared';

import { chromiumFetch } from './net-fetch';

const logger = createLogger('extension-marketplace');

/** How long a fetched registry is considered fresh. */
const REGISTRY_TTL_MS = 30 * 60 * 1000;

/** How long live GitHub stats are considered fresh. Unauthenticated API: 60/hour/IP. */
const STATS_TTL_MS = 6 * 60 * 60 * 1000;

const FETCH_TIMEOUT_MS = 20_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;

/** GitHub's maximum page size for the releases API. */
const RELEASES_PER_PAGE = 100;

/**
 * How many pages of releases the stats refresh will walk.
 *
 * Every extension VERSION is its own release tag (`otp-code-v1.0.0`), so a
 * registry of a few hundred extensions passes a hundred releases long before it
 * passes a hundred extensions. Asking for one page used to mean download counts
 * simply stopped refreshing past the newest hundred tags - not visibly, because
 * an extension with no fresh number keeps the one the registry document was
 * generated with, so the tab showed plausible, quietly frozen figures.
 *
 * Five pages is 500 releases against an unauthenticated budget of 60 requests
 * an hour per IP, refreshed at most every six hours. Past that the number is
 * stale rather than wrong, and the real fix is for the registry generator to
 * publish counts rather than for every client to recount them.
 */
const MAX_RELEASE_PAGES = 5;

/** Only these paths are unpacked from an archive. */
const ALLOWED_ARCHIVE_ENTRY = /^(?:\.\/)?(?:sarvinbox-extension\.json|dist\/[\w.-]+\.js|icon\.svg|README\.md|LICENSE)$/;

/**
 * The directory entries a well-formed archive carries.
 *
 * The publisher builds the tarball from a staging folder (`tar -czf … -C … .`),
 * so tar records `./` and `./dist/` as entries of their own beside the files.
 * They can create nothing the file allowlist does not already permit — and
 * counting them as unexpected made every ordinary install warn about the one
 * log line that should only ever name a real surprise.
 */
const ALLOWED_ARCHIVE_DIRECTORY = /^(?:\.|\.\/|(?:\.\/)?dist\/)$/;

export interface RegistryStatus {
  url: string;
  /** The repository the registry describes, for a "view on GitHub" link. */
  source: string | null;
  stars: number;
  generatedAt: string | null;
  ok: boolean;
  /** Present when this registry could not be refreshed on this pass. */
  error?: string;
  /** True when the entries came from the on-disk cache rather than the network. */
  fromCache: boolean;
}

export interface MarketplaceCatalog {
  items: CatalogItem[];
  registries: RegistryStatus[];
  fetchedAt: number;
}

interface CachedRegistry {
  fetchedAt: number;
  document: unknown;
  /**
   * The `ETag` the server sent with this document, if it sent one.
   *
   * Replayed as `If-None-Match` on the next refresh so an unchanged registry
   * costs a 304 with no body instead of the whole index. At a thousand
   * extensions the index is megabytes, and it changes only when someone
   * publishes - so nearly every refresh is downloading bytes we already have.
   */
  etag?: string;
}

interface StatsCacheEntry {
  fetchedAt: number;
  stars: number;
  downloadsByExtension: Record<string, number>;
}

interface CacheFile {
  registries: Record<string, CachedRegistry>;
  stats: Record<string, StatsCacheEntry>;
}

let cache: CacheFile | null = null;
let config: ParsedExtensionsConfig | null = null;

function cachePath(): string {
  return path.join(app.getPath('userData'), 'extension-registry-cache.json');
}

function readCache(): CacheFile {
  if (cache) return cache;
  try {
    const raw = JSON.parse(fs.readFileSync(cachePath(), 'utf-8')) as Partial<CacheFile>;
    cache = { registries: raw.registries ?? {}, stats: raw.stats ?? {} };
  } catch {
    // A missing or corrupt cache is not an error: it just means the next fetch
    // has nothing to fall back to.
    cache = { registries: {}, stats: {} };
  }
  return cache;
}

/**
 * The in-flight cache write, and whether another one is owed.
 *
 * The cache file grows with the registry - a thousand extensions is megabytes -
 * and it used to be written with `fs.writeFileSync` on the main thread, which
 * stalls every window for as long as the disk takes. Writes are now queued:
 * callers mark the cache dirty and return, one write runs at a time, and a
 * dirty flag set while a write is in flight schedules exactly one more (never a
 * queue of them, however many times the catalogue was refreshed meanwhile).
 */
let cacheWrite: Promise<void> = Promise.resolve();
let cacheDirty = false;

/**
 * Persist the cache, atomically.
 *
 * Written to a sibling `.tmp` and renamed over the target: a crash or a quit
 * mid-write then leaves the previous complete file rather than a truncated one
 * that `readCache` would throw away. `rename` is atomic on all three platforms -
 * libuv maps it to `MoveFileExW` with `MOVEFILE_REPLACE_EXISTING` on Windows, so
 * renaming over an existing file works there too.
 */
async function persistCache(): Promise<void> {
  while (cacheDirty) {
    cacheDirty = false;
    if (!cache) return;
    const target = cachePath();
    const temporary = `${target}.tmp`;
    try {
      await fsp.writeFile(temporary, JSON.stringify(cache), 'utf-8');
      await fsp.rename(temporary, target);
    } catch (error) {
      logger.warn('Could not persist the registry cache:', error);
      // Best-effort: a leftover temp file would otherwise sit there forever.
      await fsp.rm(temporary, { force: true }).catch(() => undefined);
    }
  }
}

/** Mark the cache dirty; the write happens off the calling path. */
function writeCache(): void {
  if (!cache) return;
  cacheDirty = true;
  cacheWrite = cacheWrite.then(persistCache);
}

/**
 * Resolve once every queued cache write has landed.
 *
 * Only for tests and for shutdown: nothing in the app needs to wait for a cache
 * write, which is the entire point of queuing them.
 */
export function flushRegistryCache(): Promise<void> {
  return cacheWrite;
}

/**
 * The `apps/desktop` directory, wherever this code is running from.
 *
 * Regression: this used to be counted in `..` from `__dirname`, which is a
 * different depth in the two places it runs - `electron/services/` in source,
 * a flat `dist-electron/` after bundling - so the running app looked one level
 * too high and read neither the build config nor the seeded extensions. It
 * failed as defaults, silently: the Browse tab still worked, nothing was
 * preinstalled, and only the log said why. `app.getAppPath()` is the directory
 * of the package.json Electron was launched with, so it does not depend on how
 * many files deep the caller happens to be.
 */
function desktopAppDir(): string {
  const fromElectron = app?.getAppPath?.();
  return fromElectron || path.join(__dirname, '..');
}

/**
 * Where `extensions.config.json` lives.
 *
 * In dev it is read from the repository so editing it does not need a rebuild;
 * in a packaged build electron-builder copies it into Resources.
 */
function configPath(): string {
  // `process.resourcesPath` only exists in a packaged Electron process, so it is
  // guarded rather than assumed - `path.join(undefined, ...)` throws.
  if (process.resourcesPath) {
    const packaged = path.join(process.resourcesPath, 'extensions.config.json');
    if (fs.existsSync(packaged)) return packaged;
  }
  return path.join(desktopAppDir(), 'extensions.config.json');
}

/** The build's registry list and its default-installed extensions. */
export function getExtensionsConfig(): ParsedExtensionsConfig {
  if (config) return config;
  let raw: unknown = null;
  try {
    raw = JSON.parse(fs.readFileSync(configPath(), 'utf-8'));
  } catch (error) {
    logger.warn(`Could not read ${configPath()}; using defaults:`, error);
  }
  config = parseExtensionsConfig(raw);
  for (const warning of config.warnings) logger.warn(`extensions.config.json: ${warning}`);
  return config;
}

async function fetchJson(url: string, timeoutMs = FETCH_TIMEOUT_MS): Promise<unknown> {
  const response = await chromiumFetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.json();
}

/**
 * Ask the CDN mirror first, and fall back to the canonical URL when it fails.
 *
 * The canonical URL stays what everything else is keyed on - the cache entry,
 * the registry status row, the host allowlist check - so the mirror is only
 * ever where the bytes came from. A mirror that is down, blocked or rate-limited
 * costs one extra round trip; it can never cost the catalogue, which is the
 * whole reason the fallback is here rather than a second entry in `registries`
 * (that list is merged, not raced, so a mirror there would double the catalogue).
 *
 * Both hosts serve the same file, so an ETag minted by one and offered to the
 * other is simply not recognised and answered in full. A 304 from either is
 * still the truth - "what you have is current" - whichever one issued the tag.
 */
async function fetchMirrorFirst<T>(
  url: string,
  fetchFrom: (target: string) => Promise<T>
): Promise<T> {
  const mirror = registryMirrorUrl(url);
  if (!mirror) return fetchFrom(url);
  try {
    return await fetchFrom(mirror);
  } catch (error) {
    logger.warn(`Mirror ${mirror} failed (${(error as Error).message}); trying ${url}`);
    return fetchFrom(url);
  }
}

/**
 * Fetch a registry index, conditionally when we have seen it before.
 *
 * `If-None-Match` is only sent when there is a cached document to fall back on,
 * because a 304 with nothing cached is unusable - and the fetch spec says
 * supplying the header forces the request's cache mode to `no-store`, so the
 * 304 reaches us here rather than being turned back into a 200 from Chromium's
 * own HTTP cache. A registry that sends no `ETag` (or a proxy that strips it)
 * just keeps getting full responses, which is exactly the old behaviour.
 */
async function fetchRegistryDocument(
  url: string,
  etag: string | undefined
): Promise<{ document?: unknown; etag?: string; notModified: boolean }> {
  const response = await chromiumFetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: etag
      ? { accept: 'application/json', 'if-none-match': etag }
      : { accept: 'application/json' },
  });

  if (response.status === 304) {
    // Only ever requested with a cached document behind it, but a server that
    // answers 304 unasked must not be allowed to produce an empty catalogue:
    // throwing puts it through the same fail-open path as an offline fetch.
    if (!etag) throw new Error('304 Not Modified without a cached registry');
    return { notModified: true };
  }
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return {
    document: await response.json(),
    etag: response.headers?.get('etag') ?? undefined,
    notModified: false,
  };
}

/**
 * Every release of a repository, up to `MAX_RELEASE_PAGES` pages of them.
 *
 * Paged sequentially rather than in parallel: the unauthenticated API is
 * budgeted per IP, and most repositories end after one page, so firing five
 * requests to find that out would spend the budget to learn nothing. A page
 * shorter than the page size is the last one.
 */
async function fetchReleases(api: string): Promise<Record<string, unknown>[]> {
  const releases: Record<string, unknown>[] = [];

  for (let page = 1; page <= MAX_RELEASE_PAGES; page += 1) {
    const batch = await fetchJson(`${api}/releases?per_page=${RELEASES_PER_PAGE}&page=${page}`);
    if (!Array.isArray(batch) || batch.length === 0) break;
    releases.push(...(batch as Record<string, unknown>[]));
    if (batch.length < RELEASES_PER_PAGE) break;
    if (page === MAX_RELEASE_PAGES) {
      logger.debug(
        `Stopped at ${MAX_RELEASE_PAGES} pages of releases for ${api}; download counts beyond ${releases.length} releases stay as the registry published them.`
      );
    }
  }

  return releases;
}

/**
 * Live stars and download counts from the GitHub API.
 *
 * The registry carries both, written when it was last generated — which may be
 * weeks ago, since it is only regenerated on a release. Refreshing them here
 * keeps the numbers honest without a backend of our own. It fails open: the
 * unauthenticated API allows 60 requests an hour per IP, and a rate limit must
 * cost the user a fresh number, not the catalogue.
 */
async function refreshStats(sourceRepo: string): Promise<StatsCacheEntry | null> {
  const match = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/?$/.exec(sourceRepo);
  if (!match) return null;
  const [, owner, repo] = match;

  const cached = readCache().stats[sourceRepo];
  if (cached && Date.now() - cached.fetchedAt < STATS_TTL_MS) return cached;

  try {
    const api = `https://api.github.com/repos/${owner}/${repo}`;
    const [repository, releases] = await Promise.all([
      fetchJson(api) as Promise<Record<string, unknown>>,
      fetchReleases(api),
    ]);

    const downloadsByExtension: Record<string, number> = {};
    for (const release of Array.isArray(releases) ? releases : []) {
      const tag = typeof release.tag_name === 'string' ? release.tag_name : '';
      const parsed = /^(.+)-v\d+\.\d+\.\d+/.exec(tag);
      if (!parsed) continue;
      const assets = Array.isArray(release.assets) ? (release.assets as Record<string, unknown>[]) : [];
      const count = assets
        .filter((asset) => typeof asset.name === 'string' && asset.name.endsWith('.tgz'))
        .reduce((total, asset) => total + (typeof asset.download_count === 'number' ? asset.download_count : 0), 0);
      downloadsByExtension[parsed[1]] = (downloadsByExtension[parsed[1]] ?? 0) + count;
    }

    const entry: StatsCacheEntry = {
      fetchedAt: Date.now(),
      stars: typeof repository.stargazers_count === 'number' ? repository.stargazers_count : 0,
      downloadsByExtension,
    };
    readCache().stats[sourceRepo] = entry;
    writeCache();
    return entry;
  } catch (error) {
    logger.debug(`Could not refresh GitHub stats for ${sourceRepo}: ${(error as Error).message}`);
    return cached ?? null;
  }
}

async function loadRegistry(
  url: string,
  force: boolean
): Promise<{ parsed: ParsedRegistry; status: RegistryStatus }> {
  const store = readCache();
  const cached = store.registries[url];
  const fresh = cached && !force && Date.now() - cached.fetchedAt < REGISTRY_TTL_MS;

  if (fresh) {
    const parsed = parseRegistryDocument(cached.document, url);
    return { parsed, status: registryStatus(url, parsed, true) };
  }

  try {
    const result = await fetchMirrorFirst(url, (target) =>
      fetchRegistryDocument(target, cached ? cached.etag : undefined)
    );

    if (result.notModified) {
      // `fetchRegistryDocument` refuses a 304 it did not ask for, so there is
      // always a cached document here. The guard keeps an impossible path from
      // becoming an empty catalogue presented as a success.
      if (!cached) throw new Error('304 Not Modified without a cached registry');
      // Unchanged upstream: keep the document, restart its freshness window so
      // the next half hour of refreshes costs nothing at all.
      cached.fetchedAt = Date.now();
      writeCache();
      const parsed = parseRegistryDocument(cached.document, url);
      return { parsed, status: registryStatus(url, parsed, true) };
    }

    const document = result.document;
    store.registries[url] = { fetchedAt: Date.now(), document, etag: result.etag };
    writeCache();
    const parsed = parseRegistryDocument(document, url);
    for (const rejected of parsed.rejected) {
      logger.warn(`Registry ${url} entry ${rejected.id ?? '(unnamed)'} ignored: ${rejected.reason}`);
    }
    return { parsed, status: registryStatus(url, parsed, false) };
  } catch (error) {
    // Fail open: a registry we cannot reach falls back to whatever we last saw,
    // however old. An offline user keeps their catalogue.
    const message = (error as Error).message;
    logger.warn(`Could not fetch registry ${url}: ${message}`);
    const parsed = parseRegistryDocument(cached?.document ?? null, url);
    return {
      parsed,
      status: { ...registryStatus(url, parsed, true), ok: false, error: message },
    };
  }
}

function registryStatus(url: string, parsed: ParsedRegistry, fromCache: boolean): RegistryStatus {
  return {
    url,
    source: parsed.source,
    stars: parsed.stats.stars,
    generatedAt: parsed.generatedAt,
    ok: true,
    fromCache,
  };
}

/**
 * Everything the Browse tab shows: the registries merged, compared against what
 * is installed, and checked against this app version.
 */
export async function fetchCatalog(options: { force?: boolean } = {}): Promise<MarketplaceCatalog> {
  const { registries } = getExtensionsConfig();
  const loaded = await Promise.all(registries.map((url) => loadRegistry(url, options.force ?? false)));

  const statuses = loaded.map((item) => item.status);
  const parsedRegistries = loaded.map((item) => item.parsed);

  // Live numbers where we can get them, the registry's own where we cannot.
  await Promise.all(
    parsedRegistries.map(async (parsed, index) => {
      if (!parsed.source) return;
      const stats = await refreshStats(parsed.source);
      if (!stats) return;
      statuses[index].stars = stats.stars;
      for (const entry of parsed.entries) {
        const downloads = stats.downloadsByExtension[entry.id];
        if (typeof downloads === 'number') entry.stats.downloads = downloads;
      }
    })
  );

  const manager = getExtensionManager();
  const installed = (manager?.getInstalledExtensions() ?? []).map((extension) => ({
    id: extension.id,
    version: extension.version,
    enabled: extension.enabled,
  }));

  return {
    items: buildCatalog({
      entries: mergeRegistries(parsedRegistries),
      installed,
      appVersion: app.getVersion(),
    }),
    registries: statuses,
    fetchedAt: Date.now(),
  };
}

/** Look one entry up across the configured registries, cache-first. */
/** An entry that carries everything needed to download and verify an archive. */
type InstallableEntry = RegistryEntry & { download: RegistryDownload };

/**
 * Fill in an entry's download block, fetching its detail document if need be.
 *
 * A v2 registry index carries only what the list draws; the download URL and
 * the digest live in a per-extension document fetched here, once, when the user
 * has actually chosen something. A v1 entry already has its download block and
 * costs no request at all.
 *
 * Deliberately NOT cached. The detail document is about a kilobyte and is read
 * at most once per install, so caching it would save nothing measurable - and
 * it would introduce a failure mode worth avoiding: the URL is stable across
 * versions, so a cached copy from before a release would disagree with the
 * index about the version and block the install it was meant to speed up.
 */
async function resolveEntry(entry: RegistryEntry): Promise<InstallableEntry> {
  if (entry.download) return entry as InstallableEntry;
  if (!entry.detailUrl) {
    throw new Error(`${entry.id} has no download information in ${entry.sourceUrl}`);
  }

  const document = await fetchMirrorFirst(entry.detailUrl, (target) => fetchJson(target));
  const merged = mergeRegistryDetail(document, entry);
  if ('reason' in merged) throw new Error(`${entry.id}: ${merged.reason}`);
  return merged.entry as InstallableEntry;
}

async function findEntry(extensionId: string): Promise<RegistryEntry | null> {
  const catalog = await fetchCatalog();
  return catalog.items.find((item) => item.id === extensionId) ?? null;
}

/**
 * Everything the permission prompt needs about one extension, download block
 * included.
 *
 * The prompt shows the digest the archive will be checked against, so it cannot
 * be drawn from the index alone on a v2 registry.
 */
export async function getRegistryEntry(extensionId: string): Promise<RegistryEntry> {
  const entry = await findEntry(extensionId);
  if (!entry) throw new Error(`"${extensionId}" is not in any configured registry`);
  return resolveEntry(entry);
}

/**
 * Download an archive and prove it is the one the registry pinned.
 *
 * The size is checked while the bytes arrive, not after: a server that ignores
 * the declared size could otherwise stream until the process runs out of
 * memory, and no checksum would ever get the chance to fail.
 */
async function downloadVerified(entry: InstallableEntry): Promise<Buffer> {
  if (!isTrustedRegistryUrl(entry.download.url)) {
    throw new Error(`Refusing to download ${entry.id} from ${entry.download.url}`);
  }

  const response = await chromiumFetch(entry.download.url, {
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    headers: { accept: 'application/octet-stream' },
  });
  if (!response.ok) {
    throw new Error(`Download failed: ${response.status} ${response.statusText}`);
  }

  const cap = Math.min(entry.download.size, MAX_DOWNLOAD_BYTES);
  const chunks: Uint8Array[] = [];
  let received = 0;
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Download returned no body');

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > cap) {
      await reader.cancel().catch(() => undefined);
      throw new Error(`${entry.id}: download exceeded the declared ${cap} bytes`);
    }
    chunks.push(value);
  }

  const bytes = Buffer.concat(chunks);
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== entry.download.sha256) {
    throw new Error(
      `${entry.id}: checksum mismatch — expected ${entry.download.sha256}, got ${digest}. Nothing was installed.`
    );
  }
  return bytes;
}

/**
 * Unpack a verified archive into a staging folder.
 *
 * The archive is flat by construction, and only the handful of paths the app
 * actually loads are extracted. `tar` already refuses `..` and strips leading
 * slashes; the allowlist is the second lock, so a publisher who changes what
 * they ship cannot write a file the installer never expected.
 */
async function extractToStaging(root: string, extensionId: string, archive: Buffer): Promise<string> {
  const archivePath = path.join(root, 'archive.tgz');
  const unpacked = path.join(root, 'unpacked');
  await fsp.writeFile(archivePath, archive);
  await fsp.mkdir(unpacked, { recursive: true });

  const skipped: string[] = [];
  await tar.x({
    file: archivePath,
    cwd: unpacked,
    filter: (entryPath) => {
      const normalized = entryPath.replace(/\\/g, '/');
      if (ALLOWED_ARCHIVE_DIRECTORY.test(normalized)) return true;
      if (ALLOWED_ARCHIVE_ENTRY.test(normalized)) return true;
      skipped.push(normalized);
      return false;
    },
  });
  await fsp.rm(archivePath, { force: true });

  if (skipped.length > 0) {
    logger.warn(`${extensionId}: ignored ${skipped.length} unexpected archive entries (${skipped.slice(0, 5).join(', ')})`);
  }
  return unpacked;
}

export interface InstallResult {
  id: string;
  version: string;
}

/**
 * Carry the reader's own choices across the uninstall/install pair that an
 * update is made of.
 *
 * A fresh registration defaults to enabled with empty settings, because that is
 * right for an extension being added for the first time. It is wrong for one
 * being replaced: without this an update silently switches a deliberately
 * disabled extension back on and resets every preference behind it, which for
 * something like "do not mark my mail read" is the update undoing the decision
 * the reader made.
 *
 * Order matters. Settings are written first, while the new copy is running, so
 * the extension that reads them next has them; disabling comes last so an
 * extension the reader had turned off does not spend the gap activated.
 *
 * Learned data is not handled here and does not need to be: it lives in the
 * extension's own storage directory, which an uninstall leaves alone.
 */
async function restoreReaderChoices(
  manager: NonNullable<ReturnType<typeof getExtensionManager>>,
  previous: { id: string; enabled: boolean; settings?: Record<string, unknown> }
): Promise<void> {
  try {
    const settings = previous.settings ?? {};
    if (Object.keys(settings).length > 0) {
      await manager.getRegistry().updateSettings(previous.id, settings);
    }
    if (!previous.enabled) await manager.disableExtension(previous.id);
  } catch (error) {
    // The new version is installed and working; losing a preference is worth
    // recording but not worth failing the update the reader asked for.
    logger.warn(`${previous.id}: could not carry settings across the update: ${String(error)}`);
  }
}

/**
 * Install an extension the user has just approved.
 *
 * `confirmedPermissions` is what the renderer put in front of them. It is
 * compared against what the registry says right now, and a difference aborts:
 * that is what makes the prompt a gate rather than a decoration, and it also
 * catches a registry that changed between the user reading the list and
 * clicking Install.
 */
export async function installFromRegistry(
  extensionId: string,
  confirmedPermissions: string[]
): Promise<InstallResult> {
  const manager = getExtensionManager();
  if (!manager) throw new Error('Extension manager not initialized');

  const listed = await findEntry(extensionId);
  if (!listed) throw new Error(`"${extensionId}" is not in any configured registry`);

  const offered = [...listed.permissions].sort();
  const approved = [...new Set(confirmedPermissions)].sort();
  if (offered.length !== approved.length || offered.some((permission, index) => permission !== approved[index])) {
    throw new Error(
      `${extensionId} now asks for different permissions than the ones shown (${offered.join(', ')}). Review them again.`
    );
  }

  // Only now is the detail document worth fetching: the permissions the user
  // agreed to have already been checked against what the list offered.
  const entry = await resolveEntry(listed);

  const bytes = await downloadVerified(entry);
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), `sarvinbox-ext-${extensionId}-`));

  try {
    const staging = await extractToStaging(root, extensionId, bytes);
    const manifestPath = path.join(staging, 'sarvinbox-extension.json');
    const manifest = JSON.parse(await fsp.readFile(manifestPath, 'utf-8')) as {
      id?: string;
      version?: string;
      permissions?: ExtensionPermission[];
    };

    // The registry is an index, not the source of truth — the manifest inside
    // the archive is what the host will actually load. If they disagree, the
    // user approved something other than what is about to run.
    if (manifest.id !== entry.id) {
      throw new Error(`Archive contains "${manifest.id}", not "${entry.id}"`);
    }
    if (manifest.version !== entry.version) {
      throw new Error(`Archive is version ${manifest.version}, the registry offered ${entry.version}`);
    }
    const inArchive = [...(manifest.permissions ?? [])].sort();
    if (inArchive.length !== offered.length || inArchive.some((permission, index) => permission !== offered[index])) {
      throw new Error(
        `Archive asks for different permissions (${inArchive.join(', ')}) than the registry listed. Nothing was installed.`
      );
    }

    // Reinstalling over an existing copy is how an update lands: the registry
    // refuses a duplicate id, so the old one goes first.
    const previous = manager.getInstalledExtensions().find((installed) => installed.id === entry.id);
    if (previous) {
      await manager.uninstallExtension(entry.id);
    }

    const installed = await manager.installExtension(staging);
    if (previous) await restoreReaderChoices(manager, previous);
    logger.info(`Installed ${installed.id} v${installed.version} from ${entry.sourceUrl}`);
    return { id: installed.id, version: installed.version };
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
}

/**
 * Where the build seeded its system extensions, or null if it did not.
 *
 * `scripts/prefetch-default-extensions.mjs` downloads and checksum-verifies
 * them at build time, so a first run with no network still starts with the
 * extensions the build promised.
 */
function seedDirFor(extensionId: string): string | null {
  const candidates = [
    process.resourcesPath ? path.join(process.resourcesPath, 'default-extensions', extensionId) : null,
    path.join(desktopAppDir(), 'build', 'default-extensions', extensionId),
  ].filter((dir): dir is string => dir !== null);
  return candidates.find((dir) => fs.existsSync(path.join(dir, 'sarvinbox-extension.json'))) ?? null;
}

/**
 * Install and enable everything `extensions.config.json` names as a system
 * extension.
 *
 * These are the ones the build decided a new profile should start with, so
 * there is no permission prompt - the choice was made when the app was built,
 * and the permissions are listed in the Extensions panel like any other. It
 * runs once per extension: anything already installed is left alone, including
 * one the user has since disabled or removed on purpose.
 *
 * The build's own verified copy is preferred over the network, so first run is
 * instant and works offline; the registry is only asked about an extension the
 * build could not seed.
 */
export async function installSystemExtensions(): Promise<void> {
  const { systemExtensions } = getExtensionsConfig();
  if (systemExtensions.length === 0) return;

  const manager = getExtensionManager();
  if (!manager) return;

  const alreadyInstalled = new Set(manager.getInstalledExtensions().map((installed) => installed.id));
  const wanted = systemExtensions.filter((id) => !alreadyInstalled.has(id));
  if (wanted.length === 0) return;

  const fromNetwork: string[] = [];
  for (const id of wanted) {
    const seed = seedDirFor(id);
    if (!seed) {
      fromNetwork.push(id);
      continue;
    }
    try {
      const installed = await manager.installExtension(seed);
      await manager.enableExtension(id);
      logger.info(`System extension "${id}" v${installed.version} installed from the bundled copy`);
    } catch (error) {
      logger.warn(`Could not install the bundled copy of "${id}": ${(error as Error).message}`);
      fromNetwork.push(id);
    }
  }

  if (fromNetwork.length === 0) return;

  // Only ask the network once, and only for what the build could not seed.
  const catalog = await fetchCatalog().catch((error: Error) => {
    logger.warn(`Could not reach a registry to install system extensions: ${error.message}`);
    return null;
  });
  if (!catalog) return;

  for (const id of fromNetwork) {
    const entry = catalog.items.find((item) => item.id === id);
    if (!entry) {
      logger.warn(`System extension "${id}" is not in any configured registry yet; skipping`);
      continue;
    }
    try {
      await installFromRegistry(id, entry.permissions);
      await manager.enableExtension(id);
      logger.info(`System extension "${id}" installed and enabled`);
    } catch (error) {
      // One failure must not stop the rest: a first run that cannot reach
      // GitHub should still start, and try again next launch.
      logger.warn(`Could not install system extension "${id}": ${(error as Error).message}`);
    }
  }
}
