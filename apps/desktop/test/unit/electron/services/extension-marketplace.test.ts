import { createHash } from 'crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { c as createTar } from 'tar';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Installing an extension published on GitHub.
 *
 * What this protects: an extension runs in the main process with real access to
 * the user's mail, and the app's only defences are a pinned SHA-256, a size
 * cap, an archive allowlist and a permission prompt the user actually saw. Each
 * of those is one `if` away from being decoration, and a regression in any of
 * them looks like nothing at all — the install still succeeds. So every refusal
 * is asserted here explicitly, including the ones that should never fire.
 */

const h = vi.hoisted(() => ({
  userData: '',
  appVersion: '1.1.1',
  responses: new Map<
    string,
    { status?: number; body?: string | Buffer; fail?: boolean; etag?: string }
  >(),
  requested: [] as string[],
  /** Every request with the headers it carried, so conditional GETs are visible. */
  requests: [] as { url: string; headers: Record<string, string> }[],
  installed: [] as { id: string; version: string; enabled: boolean }[],
  installCalls: [] as string[],
  /** What was actually on disk when the manager was handed the folder. */
  stagedFiles: [] as string[][],
  uninstalled: [] as string[],
  enabled: [] as string[],
  installThrows: null as string | null,
  /** What `app.getAppPath()` reports: apps/desktop, which is vitest's own cwd. */
  appDir: process.cwd(),
}));

vi.mock('electron', () => ({
  app: {
    getPath: () => h.userData,
    getVersion: () => h.appVersion,
    getName: () => 'Sarv Inbox Test',
    getAppPath: () => h.appDir,
    isPackaged: false,
  },
}));

vi.mock('../../../../electron/services/net-fetch', () => ({
  chromiumFetch: async (url: string, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    h.requested.push(url);
    h.requests.push({ url, headers });
    const canned = h.responses.get(url);
    if (!canned || canned.fail) throw new Error(`offline: ${url}`);
    // A canned `etag` makes the endpoint behave like a real conditional
    // resource: a matching `If-None-Match` gets 304 and no body at all.
    const conditional = canned.etag !== undefined && headers['if-none-match'] === canned.etag;
    const status = conditional ? 304 : (canned.status ?? 200);
    const body = conditional ? '' : (canned.body ?? '');
    const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf-8');
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 200 ? 'OK' : 'Error',
      headers: { get: (name: string) => (name.toLowerCase() === 'etag' ? (canned.etag ?? null) : null) },
      json: async () => JSON.parse(bytes.toString('utf-8')),
      body: {
        getReader: () => {
          let sent = false;
          return {
            read: async () => (sent ? { done: true, value: undefined } : ((sent = true), { done: false, value: new Uint8Array(bytes) })),
            cancel: async () => undefined,
          };
        },
      },
    } as unknown as Response;
  },
}));

vi.mock('../../../../electron/shared', () => ({
  getExtensionManager: () => ({
    getInstalledExtensions: () => h.installed,
    installExtension: async (path: string) => {
      h.installCalls.push(path);
      // The staging folder is deleted as soon as the install returns, so what
      // it contained has to be captured while the manager can still see it.
      h.stagedFiles.push(listRecursively(path));
      if (h.installThrows) throw new Error(h.installThrows);
      const manifest = JSON.parse(readFileSync(join(path, 'sarvinbox-extension.json'), 'utf-8'));
      return { id: manifest.id, version: manifest.version };
    },
    uninstallExtension: async (id: string) => { h.uninstalled.push(id); },
    enableExtension: async (id: string) => { h.enabled.push(id); },
  }),
}));

function listRecursively(dir: string, prefix = ''): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? listRecursively(join(dir, entry.name), `${prefix}${entry.name}/`)
      : [`${prefix}${entry.name}`]
  );
}

/** What `extensions.config.json` actually ships pointing at - the served index. */
const REGISTRY_URL =
  'https://raw.githubusercontent.com/Sarv/SarvInbox-extensions/main/registry/index.json';
const ASSET_URL = 'https://github.com/Sarv/SarvInbox-extensions/releases/download/otp-code-v1.0.0/otp-code-1.0.0.tgz';

function buildArchive(files: Record<string, string>): Buffer {
  const staging = mkdtempSync(join(tmpdir(), 'sarvinbox-archive-'));
  for (const [name, content] of Object.entries(files)) {
    const target = join(staging, name);
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, content, 'utf-8');
  }
  const out = join(staging, 'out.tgz');
  createTar({ gzip: true, cwd: staging, file: out, sync: true }, Object.keys(files));
  const bytes = readFileSync(out);
  rmSync(staging, { recursive: true, force: true });
  return bytes;
}

const MANIFEST = {
  id: 'otp-code',
  name: 'OTP Code',
  version: '1.0.0',
  description: 'Surfaces verification codes',
  author: 'Sarv',
  main: 'dist/index.js',
  permissions: ['email:read', 'ui:notify'],
};

/**
 * The same files, packed the way the publisher packs them: from a staging
 * folder, so tar records `./` and `./dist/` as entries of their own. The
 * explicit-file-list fixture above never produces those, which is how a filter
 * that rejected them went unnoticed.
 */
function publishedArchive(): Buffer {
  const staging = mkdtempSync(join(tmpdir(), 'sarvinbox-published-'));
  mkdirSync(join(staging, 'dist'), { recursive: true });
  writeFileSync(join(staging, 'sarvinbox-extension.json'), JSON.stringify(MANIFEST), 'utf-8');
  writeFileSync(join(staging, 'dist', 'index.js'), 'exports.activate = () => {};', 'utf-8');
  writeFileSync(join(staging, 'icon.svg'), '<svg />', 'utf-8');
  writeFileSync(join(staging, 'README.md'), '# OTP Code', 'utf-8');
  writeFileSync(join(staging, 'LICENSE'), 'All rights reserved.', 'utf-8');
  // Written outside the staging folder: packing `.` would otherwise sweep the
  // half-finished tarball into itself.
  const out = mkdtempSync(join(tmpdir(), 'sarvinbox-published-out-'));
  const archivePath = join(out, 'out.tgz');
  createTar({ gzip: true, cwd: staging, file: archivePath, sync: true }, ['.']);
  const bytes = readFileSync(archivePath);
  rmSync(staging, { recursive: true, force: true });
  rmSync(out, { recursive: true, force: true });
  return bytes;
}

function archiveFor(manifest: Record<string, unknown> = MANIFEST, extra: Record<string, string> = {}) {
  return buildArchive({
    'sarvinbox-extension.json': JSON.stringify(manifest),
    'dist/index.js': 'exports.activate = () => {};',
    ...extra,
  });
}

function registryFor(archive: Buffer, overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    schemaVersion: 1,
    generatedAt: '2026-09-01T00:00:00.000Z',
    source: 'https://github.com/Sarv/SarvInbox-extensions',
    stats: { stars: 12 },
    extensions: [
      {
        id: 'otp-code',
        name: 'OTP Code',
        version: '1.0.0',
        description: 'Surfaces verification codes',
        author: 'Sarv',
        keywords: ['otp'],
        engines: { sarvinbox: '^1.1.0' },
        permissions: ['email:read', 'ui:notify'],
        download: {
          url: ASSET_URL,
          sha256: createHash('sha256').update(archive).digest('hex'),
          size: archive.length,
        },
        stats: { downloads: 42 },
        ...overrides,
      },
    ],
  });
}

type MarketplaceService = typeof import('../../../../electron/services/extension-marketplace');

/** The module instance most recently loaded, so `afterEach` can settle its writes. */
let service: MarketplaceService | null = null;

async function loadService(): Promise<MarketplaceService> {
  vi.resetModules();
  service = await import('../../../../electron/services/extension-marketplace');
  return service;
}

beforeEach(() => {
  h.userData = mkdtempSync(join(tmpdir(), 'sarvinbox-marketplace-'));
  h.appVersion = '1.1.1';
  h.responses = new Map();
  h.requested = [];
  h.requests = [];
  h.installed = [];
  h.installCalls = [];
  h.stagedFiles = [];
  h.uninstalled = [];
  h.enabled = [];
  h.installThrows = null;
});

afterEach(async () => {
  // Cache writes are queued, so one still in flight would land after this temp
  // directory is gone - or, worse, inside the NEXT test's directory, seeding it
  // with stats fresh enough to skip the fetch that test is about to assert on.
  await service?.flushRegistryCache();
  service = null;
  rmSync(h.userData, { recursive: true, force: true });
});

describe('getExtensionsConfig', () => {
  it('reads the build config and always puts the official registry first', async () => {
    const { getExtensionsConfig } = await loadService();
    const config = getExtensionsConfig();
    expect(config.registries[0]).toBe(REGISTRY_URL);
    expect(Array.isArray(config.systemExtensions)).toBe(true);
  });

  // Regression: the file was located by counting `..` from __dirname, which is
  // one level deeper in source than in the bundle the app actually runs, so the
  // running app read no config at all and quietly preinstalled nothing. Asserting
  // against the real shipped file is what makes a resolved path provable - a
  // wrong one falls back to defaults and every other assertion still passes.
  it('reads the file the repository actually ships, not the defaults', async () => {
    const shipped = JSON.parse(readFileSync(join(h.appDir, 'extensions.config.json'), 'utf-8'));
    const { getExtensionsConfig } = await loadService();

    expect(getExtensionsConfig().systemExtensions).toEqual(shipped.systemExtensions);
    expect(shipped.systemExtensions.length).toBeGreaterThan(0);
  });

  it('falls back to defaults when the config is missing', async () => {
    h.appDir = join(h.userData, 'no-config-here');
    const { getExtensionsConfig } = await loadService();

    const config = getExtensionsConfig();
    expect(config.registries).toEqual([REGISTRY_URL]);
    expect(config.systemExtensions).toEqual([]);
  });
});

describe('fetchCatalog', () => {
  it('lists what the registry offers, marked against what is installed', async () => {
    const archive = archiveFor();
    h.responses.set(REGISTRY_URL, { body: registryFor(archive) });
    const { fetchCatalog } = await loadService();

    const catalog = await fetchCatalog();
    expect(catalog.items).toHaveLength(1);
    expect(catalog.items[0]).toMatchObject({ id: 'otp-code', version: '1.0.0', state: 'available' });
    expect(catalog.registries[0]).toMatchObject({ ok: true, fromCache: false, stars: 12 });
  });

  it('marks an entry that needs a newer app as incompatible rather than hiding it', async () => {
    h.appVersion = '1.0.0';
    h.responses.set(REGISTRY_URL, { body: registryFor(archiveFor()) });
    const { fetchCatalog } = await loadService();

    const catalog = await fetchCatalog();
    expect(catalog.items[0].state).toBe('incompatible');
    expect(catalog.items[0].incompatibleReason).toBeTruthy();
  });

  it('offers an update when the registry is ahead of what is on disk', async () => {
    h.installed = [{ id: 'otp-code', version: '0.9.0', enabled: true }];
    h.responses.set(REGISTRY_URL, { body: registryFor(archiveFor()) });
    const { fetchCatalog } = await loadService();

    expect((await fetchCatalog()).items[0].state).toBe('update-available');
  });

  // An offline user must keep the catalogue they already had: failing closed
  // here would empty the Browse tab every time the network blinked.
  it('falls back to the cached registry and says so when the fetch fails', async () => {
    h.responses.set(REGISTRY_URL, { body: registryFor(archiveFor()) });
    const first = await loadService();
    await first.fetchCatalog();

    h.responses.set(REGISTRY_URL, { fail: true });
    const second = await loadService();
    const catalog = await second.fetchCatalog({ force: true });

    expect(catalog.items).toHaveLength(1);
    expect(catalog.registries[0].ok).toBe(false);
    expect(catalog.registries[0].fromCache).toBe(true);
    expect(catalog.registries[0].error).toMatch(/offline/);
  });

  it('returns an empty catalogue, not a throw, when there is no cache either', async () => {
    h.responses.set(REGISTRY_URL, { fail: true });
    const { fetchCatalog } = await loadService();

    const catalog = await fetchCatalog();
    expect(catalog.items).toEqual([]);
    expect(catalog.registries[0].ok).toBe(false);
  });

  // The checksum is the whole security boundary, so an entry without a usable
  // one is dropped instead of being offered unverifiable.
  it('drops an entry whose checksum is missing', async () => {
    h.responses.set(REGISTRY_URL, {
      body: registryFor(archiveFor(), { download: { url: ASSET_URL, size: 100 } }),
    });
    const { fetchCatalog } = await loadService();
    expect((await fetchCatalog()).items).toEqual([]);
  });

  it('does not re-fetch a registry that is still fresh', async () => {
    h.responses.set(REGISTRY_URL, { body: registryFor(archiveFor()) });
    const { fetchCatalog } = await loadService();

    await fetchCatalog();
    const afterFirst = h.requested.filter((url) => url === REGISTRY_URL).length;
    await fetchCatalog();
    expect(h.requested.filter((url) => url === REGISTRY_URL)).toHaveLength(afterFirst);
  });
});

const GITHUB_API = 'https://api.github.com/repos/Sarv/SarvInbox-extensions';

/** A releases page: `count` entries, only the last of which is for `otp-code`. */
function releasePage(count: number, otpDownloads: number | null): string {
  const releases = Array.from({ length: count }, (_unused, index) => ({
    tag_name: `filler-${index}-v1.0.0`,
    assets: [{ name: `filler-${index}-1.0.0.tgz`, download_count: 1 }],
  }));
  if (otpDownloads !== null) {
    releases[releases.length - 1] = {
      tag_name: 'otp-code-v1.0.0',
      assets: [{ name: 'otp-code-1.0.0.tgz', download_count: otpDownloads }],
    };
  }
  return JSON.stringify(releases);
}

function releasesUrl(page: number): string {
  return `${GITHUB_API}/releases?per_page=100&page=${page}`;
}

describe('registry conditional GET', () => {
  // Breaks: every refresh downloads the whole index again. At a thousand
  // extensions that is megabytes every half hour per user, for a document that
  // only changes when somebody publishes.
  it('replays the stored ETag and reuses the cached document on a 304', async () => {
    h.responses.set(REGISTRY_URL, { body: registryFor(archiveFor()), etag: 'W/"v1"' });
    const first = await loadService();
    await first.fetchCatalog();
    await first.flushRegistryCache();

    const second = await loadService();
    const catalog = await second.fetchCatalog({ force: true });

    const conditional = h.requests.filter((request) => request.url === REGISTRY_URL).at(-1);
    expect(conditional?.headers['if-none-match']).toBe('W/"v1"');
    expect(catalog.items).toHaveLength(1);
    expect(catalog.registries[0]).toMatchObject({ ok: true, fromCache: true });
  });

  // Breaks: the very first fetch sends a conditional request with nothing to
  // fall back on, so a 304 would empty the Browse tab on a fresh install.
  it('sends no If-None-Match when there is no cached document behind it', async () => {
    h.responses.set(REGISTRY_URL, { body: registryFor(archiveFor()), etag: 'W/"v1"' });
    const { fetchCatalog } = await loadService();

    await fetchCatalog();

    const firstRequest = h.requests.find((request) => request.url === REGISTRY_URL);
    expect(firstRequest?.headers['if-none-match']).toBeUndefined();
  });

  // Breaks: a misbehaving server or proxy answers 304 to an unconditional
  // request and the user gets an empty catalogue presented as a success,
  // instead of the fail-open path that keeps whatever they last had.
  it('treats a 304 we never asked for as a failed fetch, not an empty catalogue', async () => {
    h.responses.set(REGISTRY_URL, { status: 304 });
    const { fetchCatalog } = await loadService();

    const catalog = await fetchCatalog();

    expect(catalog.items).toEqual([]);
    expect(catalog.registries[0].ok).toBe(false);
    expect(catalog.registries[0].error).toMatch(/304/);
  });

  // Breaks: a 304 leaves the cache entry stale-dated, so the next refresh - and
  // every refresh after it - pays for a full download anyway and the ETag saves
  // nothing. Also pins that the ETag itself survives a round trip through disk.
  it('restarts the freshness window on a 304', async () => {
    h.responses.set(REGISTRY_URL, { body: registryFor(archiveFor()), etag: 'W/"v1"' });
    const first = await loadService();
    await first.fetchCatalog();
    await first.flushRegistryCache();

    const file = join(h.userData, 'extension-registry-cache.json');
    const aged = JSON.parse(readFileSync(file, 'utf-8'));
    const agedAt = Date.now() - 60 * 60 * 1000;
    aged.registries[REGISTRY_URL].fetchedAt = agedAt;
    writeFileSync(file, JSON.stringify(aged), 'utf-8');

    const second = await loadService();
    await second.fetchCatalog();
    await second.flushRegistryCache();

    const after = JSON.parse(readFileSync(file, 'utf-8'));
    expect(after.registries[REGISTRY_URL].fetchedAt).toBeGreaterThan(agedAt);
    expect(after.registries[REGISTRY_URL].etag).toBe('W/"v1"');

    const before = h.requested.filter((url) => url === REGISTRY_URL).length;
    await second.fetchCatalog();
    expect(h.requested.filter((url) => url === REGISTRY_URL)).toHaveLength(before);
  });
});

describe('GitHub stats pagination', () => {
  // Breaks: only the newest hundred release tags are counted. Every extension
  // version is its own tag, so a few hundred extensions is already past that -
  // and the symptom is not an error, it is download numbers that quietly stop
  // moving while still looking plausible.
  it('walks past the first page of releases', async () => {
    h.responses.set(REGISTRY_URL, { body: registryFor(archiveFor()) });
    h.responses.set(GITHUB_API, { body: JSON.stringify({ stargazers_count: 7 }) });
    h.responses.set(releasesUrl(1), { body: releasePage(100, null) });
    h.responses.set(releasesUrl(2), { body: releasePage(3, 500) });
    const { fetchCatalog } = await loadService();

    const catalog = await fetchCatalog();

    expect(catalog.items[0].stats.downloads).toBe(500);
    expect(catalog.registries[0].stars).toBe(7);
  });

  // Breaks: a short page is not recognised as the last one and the refresh
  // spends the whole unauthenticated budget (60 requests an hour per IP) asking
  // for pages that do not exist.
  it('stops as soon as a page comes back short', async () => {
    h.responses.set(REGISTRY_URL, { body: registryFor(archiveFor()) });
    h.responses.set(GITHUB_API, { body: JSON.stringify({ stargazers_count: 7 }) });
    h.responses.set(releasesUrl(1), { body: releasePage(3, 500) });
    const { fetchCatalog } = await loadService();

    await fetchCatalog();

    expect(h.requested.filter((url) => url.includes('/releases?'))).toEqual([releasesUrl(1)]);
  });

  // Breaks: a repository with thousands of releases is walked page by page on
  // every stats refresh until the API rate-limits the user out of their own
  // catalogue.
  //
  // KNOWN LIMITATION, deliberately recorded rather than treated as correct:
  // past the cap an extension keeps the download count the registry document
  // was generated with, which is stale but never wrong. The fix is for the
  // registry generator to publish counts, not for every client to recount them.
  it('stops at the page cap and leaves further extensions on the registry count', async () => {
    h.responses.set(REGISTRY_URL, { body: registryFor(archiveFor()) });
    h.responses.set(GITHUB_API, { body: JSON.stringify({ stargazers_count: 7 }) });
    for (let page = 1; page <= 8; page += 1) {
      h.responses.set(releasesUrl(page), { body: releasePage(100, null) });
    }
    const { fetchCatalog } = await loadService();

    const catalog = await fetchCatalog();

    expect(h.requested.filter((url) => url.includes('/releases?'))).toHaveLength(5);
    expect(catalog.items[0].stats.downloads).toBe(42);
  });

  // Breaks: a rate-limited or offline GitHub API empties the Browse tab instead
  // of costing the user a fresh number.
  it('keeps the catalogue when the stats API is unreachable', async () => {
    h.responses.set(REGISTRY_URL, { body: registryFor(archiveFor()) });
    h.responses.set(GITHUB_API, { fail: true });
    const { fetchCatalog } = await loadService();

    const catalog = await fetchCatalog();

    expect(catalog.items).toHaveLength(1);
    expect(catalog.items[0].stats.downloads).toBe(42);
  });
});

describe('registry cache persistence', () => {
  // Breaks: the cache is written with `fs.writeFileSync` on the main thread.
  // The file grows with the registry - megabytes at a thousand extensions - and
  // every window in the app freezes for as long as the disk takes, on a write
  // nothing is waiting for.
  it('never writes the cache synchronously', async () => {
    const source = readFileSync(
      new URL('../../../../electron/services/extension-marketplace.ts', import.meta.url),
      'utf8'
    );
    expect(source).not.toMatch(/writeFileSync\(\s*cachePath\(\)/);
  });

  // Breaks: a crash or a quit mid-write leaves a truncated cache file, which
  // `readCache` throws away - so the next launch has no fallback at all and an
  // offline user opens an empty Browse tab. Also catches a temp file left
  // sitting in userData forever.
  it('writes the cache through a temp file and renames it into place', async () => {
    h.responses.set(REGISTRY_URL, { body: registryFor(archiveFor()) });
    const { fetchCatalog, flushRegistryCache } = await loadService();

    await fetchCatalog();
    await flushRegistryCache();

    const file = join(h.userData, 'extension-registry-cache.json');
    expect(existsSync(file)).toBe(true);
    expect(existsSync(`${file}.tmp`)).toBe(false);
    expect(JSON.parse(readFileSync(file, 'utf-8')).registries[REGISTRY_URL]).toBeTruthy();
  });

  // Breaks: repeated refreshes queue one full serialisation each, so the cost of
  // a burst of refreshes is the file size times the number of refreshes rather
  // than the file size once.
  it('coalesces a burst of refreshes into a settled cache', async () => {
    h.responses.set(REGISTRY_URL, { body: registryFor(archiveFor()), etag: 'W/"v1"' });
    const { fetchCatalog, flushRegistryCache } = await loadService();

    await Promise.all([
      fetchCatalog({ force: true }),
      fetchCatalog({ force: true }),
      fetchCatalog({ force: true }),
    ]);
    await flushRegistryCache();

    const file = join(h.userData, 'extension-registry-cache.json');
    expect(existsSync(`${file}.tmp`)).toBe(false);
    expect(JSON.parse(readFileSync(file, 'utf-8')).registries[REGISTRY_URL].etag).toBe('W/"v1"');
  });
});

/**
 * The served registry is a thin index: the Browse list carries no download URL
 * and no digest, and those are fetched per-extension only when someone actually
 * installs one. The whole point is that opening Browse costs one small request.
 */
describe('v2 thin index', () => {
  const INDEX_URL = REGISTRY_URL;
  const DETAIL_URL =
    'https://raw.githubusercontent.com/Sarv/SarvInbox-extensions/main/registry/e/otp-code.json';

  function indexFor(archive: Buffer, overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
      schemaVersion: 2,
      generatedAt: '2026-09-01T00:00:00.000Z',
      source: 'https://github.com/Sarv/SarvInbox-extensions',
      stats: { stars: 12 },
      extensions: [
        {
          id: 'otp-code',
          name: 'OTP Code',
          version: '1.0.0',
          description: 'Surfaces verification codes',
          author: 'Sarv',
          keywords: ['otp'],
          iconUrl: '../extensions/otp-code/icon.svg',
          detailUrl: 'e/otp-code.json',
          engines: { sarvinbox: '^1.1.0' },
          permissions: ['email:read', 'ui:notify'],
          size: archive.length,
          stats: { downloads: 42 },
          ...overrides,
        },
      ],
    });
  }

  function detailFor(archive: Buffer, overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
      schemaVersion: 2,
      id: 'otp-code',
      version: '1.0.0',
      license: 'MIT',
      readmeUrl: '../../extensions/otp-code/README.md',
      download: {
        url: ASSET_URL,
        sha256: createHash('sha256').update(archive).digest('hex'),
        size: archive.length,
      },
      ...overrides,
    });
  }

  function useIndex(archive: Buffer, overrides?: Record<string, unknown>): void {
    h.responses.set(INDEX_URL, { body: indexFor(archive, overrides) });
  }

  // Breaks: the whole saving is given back - browsing fetches a detail document
  // for every extension listed, which is more requests than the flat registry
  // ever made.
  it('draws the catalogue from the index alone, with no detail request', async () => {
    const archive = archiveFor();
    useIndex(archive);
    h.responses.set(DETAIL_URL, { body: detailFor(archive) });
    const { fetchCatalog } = await loadService();

    const catalog = await fetchCatalog();
    expect(catalog.items.map((item) => item.id)).toEqual(['otp-code']);
    expect(catalog.items[0].size).toBe(archive.length);
    expect(catalog.items[0].download).toBeUndefined();
    expect(h.requested).toContain(INDEX_URL);
    expect(h.requested).not.toContain(DETAIL_URL);
  });

  // Breaks: the permission prompt has no checksum to show, so either it shows
  // nothing where the digest should be or the install fails after consent.
  it('fetches the detail document on demand, resolved relative to the index', async () => {
    const archive = archiveFor();
    useIndex(archive);
    h.responses.set(DETAIL_URL, { body: detailFor(archive) });
    const { getRegistryEntry } = await loadService();

    const entry = await getRegistryEntry('otp-code');
    expect(h.requested).toContain(DETAIL_URL);
    expect(entry.download?.url).toBe(ASSET_URL);
    expect(entry.license).toBe('MIT');
    expect(entry.readmeUrl).toBe(
      'https://raw.githubusercontent.com/Sarv/SarvInbox-extensions/main/extensions/otp-code/README.md'
    );
  });

  it('installs an extension whose download block came from its detail document', async () => {
    const archive = archiveFor();
    useIndex(archive);
    h.responses.set(DETAIL_URL, { body: detailFor(archive) });
    h.responses.set(ASSET_URL, { body: archive });
    const { installFromRegistry } = await loadService();

    await expect(installFromRegistry('otp-code', ['email:read', 'ui:notify'])).resolves.toEqual({
      id: 'otp-code',
      version: '1.0.0',
    });
    expect(h.installCalls).toHaveLength(1);
  });

  // Breaks: an extension is downloaded before the permissions the user agreed
  // to have been checked - the gate has to close before any bytes move, and the
  // detail fetch is bytes moving.
  it('does not fetch the detail document when the approved permissions disagree', async () => {
    const archive = archiveFor();
    useIndex(archive);
    h.responses.set(DETAIL_URL, { body: detailFor(archive) });
    const { installFromRegistry } = await loadService();

    await expect(installFromRegistry('otp-code', ['email:read'])).rejects.toThrow(
      /different permissions/i
    );
    expect(h.requested).not.toContain(DETAIL_URL);
  });

  // Breaks: the user approves permissions for the version the list showed and
  // the app installs whatever the detail document happens to name.
  it('refuses a detail document that names a different version', async () => {
    const archive = archiveFor();
    useIndex(archive);
    h.responses.set(DETAIL_URL, { body: detailFor(archive, { version: '2.0.0' }) });
    h.responses.set(ASSET_URL, { body: archive });
    const { installFromRegistry } = await loadService();

    await expect(installFromRegistry('otp-code', ['email:read', 'ui:notify'])).rejects.toThrow(
      /the list showed 1\.0\.0/
    );
    expect(h.installCalls).toEqual([]);
  });

  // Breaks: the detail document goes unfetched or unverified and the install
  // proceeds against a URL on a host nothing vetted.
  it('refuses a detail document pointing the download at another host', async () => {
    const archive = archiveFor();
    useIndex(archive);
    h.responses.set(DETAIL_URL, {
      body: detailFor(archive, {
        download: {
          url: 'https://example.com/otp-code-1.0.0.tgz',
          sha256: createHash('sha256').update(archive).digest('hex'),
          size: archive.length,
        },
      }),
    });
    const { installFromRegistry } = await loadService();

    await expect(installFromRegistry('otp-code', ['email:read', 'ui:notify'])).rejects.toThrow();
    expect(h.installCalls).toEqual([]);
  });

  // Breaks: a detail fetch that fails mid-install looks like a successful
  // install of nothing, or leaves the catalogue unusable for everything else.
  it('fails the one install when its detail document cannot be read', async () => {
    const archive = archiveFor();
    useIndex(archive);
    h.responses.set(DETAIL_URL, { fail: true });
    const { fetchCatalog, installFromRegistry } = await loadService();

    await expect(installFromRegistry('otp-code', ['email:read', 'ui:notify'])).rejects.toThrow(
      /offline/
    );
    // The catalogue itself is untouched: only the chosen extension failed.
    expect((await fetchCatalog()).items).toHaveLength(1);
  });

  // Breaks: an index entry that points nowhere is offered as installable and
  // fails with a type error rather than something a user could act on.
  it('rejects an index entry with neither a download block nor a detailUrl', async () => {
    const archive = archiveFor();
    const document = JSON.parse(indexFor(archive)) as {
      extensions: Record<string, unknown>[];
    };
    delete document.extensions[0].detailUrl;
    h.responses.set(INDEX_URL, { body: JSON.stringify(document) });
    const { fetchCatalog } = await loadService();

    expect((await fetchCatalog()).items).toEqual([]);
  });
});

describe('installFromRegistry', () => {
  it('verifies the checksum, unpacks and hands the folder to the manager', async () => {
    const archive = archiveFor();
    h.responses.set(REGISTRY_URL, { body: registryFor(archive) });
    h.responses.set(ASSET_URL, { body: archive });
    const { installFromRegistry } = await loadService();

    const result = await installFromRegistry('otp-code', ['email:read', 'ui:notify']);
    expect(result).toEqual({ id: 'otp-code', version: '1.0.0' });
    expect(h.installCalls).toHaveLength(1);
    expect(h.stagedFiles[0].sort()).toEqual(['dist/index.js', 'sarvinbox-extension.json']);
  });

  // The prompt is a gate, not decoration: if the registry changed between the
  // user reading the permission list and clicking Install, they never agreed
  // to the new set.
  it('refuses when the approved permissions no longer match the registry', async () => {
    const archive = archiveFor();
    h.responses.set(REGISTRY_URL, { body: registryFor(archive) });
    h.responses.set(ASSET_URL, { body: archive });
    const { installFromRegistry } = await loadService();

    await expect(installFromRegistry('otp-code', ['email:read'])).rejects.toThrow(
      /different permissions/i
    );
    expect(h.installCalls).toEqual([]);
  });

  it('accepts the approved permissions in any order', async () => {
    const archive = archiveFor();
    h.responses.set(REGISTRY_URL, { body: registryFor(archive) });
    h.responses.set(ASSET_URL, { body: archive });
    const { installFromRegistry } = await loadService();

    await expect(installFromRegistry('otp-code', ['ui:notify', 'email:read'])).resolves.toBeTruthy();
  });

  // A byte that does not hash to the pinned digest is a different file than the
  // one the registry described, whatever the reason.
  it('refuses a download whose checksum does not match, before anything is unpacked', async () => {
    const archive = archiveFor();
    h.responses.set(REGISTRY_URL, { body: registryFor(archive) });
    // Smaller than the declared size, so the checksum is what refuses it rather
    // than the size cap firing first.
    h.responses.set(ASSET_URL, { body: Buffer.from('not a tarball') });
    const { installFromRegistry } = await loadService();

    await expect(installFromRegistry('otp-code', ['email:read', 'ui:notify'])).rejects.toThrow(
      /checksum mismatch/i
    );
    expect(h.installCalls).toEqual([]);
  });

  it('refuses a download larger than the registry declared', async () => {
    const archive = archiveFor();
    const registry = JSON.parse(registryFor(archive));
    registry.extensions[0].download.size = 10;
    // Re-pin the digest so the size, not the checksum, is what fails.
    registry.extensions[0].download.sha256 = createHash('sha256').update(archive).digest('hex');
    h.responses.set(REGISTRY_URL, { body: JSON.stringify(registry) });
    h.responses.set(ASSET_URL, { body: archive });
    const { installFromRegistry } = await loadService();

    await expect(installFromRegistry('otp-code', ['email:read', 'ui:notify'])).rejects.toThrow(
      /exceeded the declared/i
    );
  });

  // The registry is only an index; the manifest inside the archive is what the
  // host loads. A disagreement means the user approved something else.
  it('refuses when the archive manifest asks for permissions the registry did not list', async () => {
    const archive = archiveFor({ ...MANIFEST, permissions: ['email:read', 'ui:notify', 'email:delete'] });
    h.responses.set(REGISTRY_URL, { body: registryFor(archive) });
    h.responses.set(ASSET_URL, { body: archive });
    const { installFromRegistry } = await loadService();

    await expect(installFromRegistry('otp-code', ['email:read', 'ui:notify'])).rejects.toThrow(
      /different permissions/i
    );
    expect(h.installCalls).toEqual([]);
  });

  it('refuses when the archive contains a different extension than the one requested', async () => {
    const archive = archiveFor({ ...MANIFEST, id: 'something-else' });
    h.responses.set(REGISTRY_URL, { body: registryFor(archive) });
    h.responses.set(ASSET_URL, { body: archive });
    const { installFromRegistry } = await loadService();

    await expect(installFromRegistry('otp-code', ['email:read', 'ui:notify'])).rejects.toThrow(
      /Archive contains/
    );
  });

  it('refuses when the archive version disagrees with the registry', async () => {
    const archive = archiveFor({ ...MANIFEST, version: '2.0.0' });
    h.responses.set(REGISTRY_URL, { body: registryFor(archive) });
    h.responses.set(ASSET_URL, { body: archive });
    const { installFromRegistry } = await loadService();

    await expect(installFromRegistry('otp-code', ['email:read', 'ui:notify'])).rejects.toThrow(
      /Archive is version 2\.0\.0/
    );
  });

  // A publisher who starts shipping extra files must not be able to write them:
  // only the paths the host actually loads come out of the archive.
  it('extracts only the expected paths and drops anything else in the archive', async () => {
    const archive = archiveFor(MANIFEST, {
      'postinstall.sh': 'rm -rf /',
      'dist/index.js.map': '{}',
    });
    h.responses.set(REGISTRY_URL, { body: registryFor(archive) });
    h.responses.set(ASSET_URL, { body: archive });
    const { installFromRegistry } = await loadService();

    await installFromRegistry('otp-code', ['email:read', 'ui:notify']);
    expect(h.stagedFiles[0].sort()).toEqual(['dist/index.js', 'sarvinbox-extension.json']);
  });

  // Every real release is packed from a staging folder, so the tarball carries
  // `./` and `./dist/` as entries. If those count as unexpected, the warning
  // that exists to name a publisher shipping something new fires on every
  // ordinary install instead, and stops meaning anything.
  it('installs an archive packed the way releases are, reporting nothing as unexpected', async () => {
    const archive = publishedArchive();
    h.responses.set(REGISTRY_URL, { body: registryFor(archive) });
    h.responses.set(ASSET_URL, { body: archive });

    // The service logs through its own module-private `createLogger`, so the
    // only place to observe the warning from outside is the sink it writes to.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { installFromRegistry } = await loadService();

    await installFromRegistry('otp-code', ['email:read', 'ui:notify']);

    expect(h.stagedFiles[0].sort()).toEqual([
      'LICENSE',
      'README.md',
      'dist/index.js',
      'icon.svg',
      'sarvinbox-extension.json',
    ]);
    expect(warn.mock.calls.map(String).join('\n')).not.toMatch(/unexpected archive entries/);
    warn.mockRestore();
  });

  it('removes the previous copy first so an update can land', async () => {
    h.installed = [{ id: 'otp-code', version: '0.9.0', enabled: true }];
    const archive = archiveFor();
    h.responses.set(REGISTRY_URL, { body: registryFor(archive) });
    h.responses.set(ASSET_URL, { body: archive });
    const { installFromRegistry } = await loadService();

    await installFromRegistry('otp-code', ['email:read', 'ui:notify']);
    expect(h.uninstalled).toEqual(['otp-code']);
  });

  it('cleans up the staging folder even when the install fails', async () => {
    const archive = archiveFor();
    h.responses.set(REGISTRY_URL, { body: registryFor(archive) });
    h.responses.set(ASSET_URL, { body: archive });
    h.installThrows = 'disk full';
    const { installFromRegistry } = await loadService();

    await expect(installFromRegistry('otp-code', ['email:read', 'ui:notify'])).rejects.toThrow('disk full');
    expect(existsSync(h.installCalls[0])).toBe(false);
  });

  it('refuses an extension that is in no configured registry', async () => {
    h.responses.set(REGISTRY_URL, { body: registryFor(archiveFor()) });
    const { installFromRegistry } = await loadService();

    await expect(installFromRegistry('not-published', [])).rejects.toThrow(/not in any configured registry/);
  });
});

/**
 * Registry documents fetched through the CDN mirror.
 *
 * `raw.githubusercontent.com` has no edge in much of the world, and the panel's
 * visible failure is a 20s abort followed by a stale cached list. The mirror is
 * asked first and the canonical host is the fallback, so what these protect is
 * the property that makes that safe: the canonical URL stays the identity of
 * the registry — its cache key, its status row — and a mirror that is down is
 * one retry, never a lost catalogue.
 */
describe('the CDN mirror', () => {
  const MIRROR_INDEX_URL =
    'https://cdn.jsdelivr.net/gh/Sarv/SarvInbox-extensions@main/registry/index.json';
  const MIRROR_DETAIL_URL =
    'https://cdn.jsdelivr.net/gh/Sarv/SarvInbox-extensions@main/registry/e/otp-code.json';
  const DETAIL_URL =
    'https://raw.githubusercontent.com/Sarv/SarvInbox-extensions/main/registry/e/otp-code.json';

  /**
   * Only the two hosts the index itself can come from. The catalogue also
   * refreshes GitHub's star and download counts, and counting those requests
   * here would make these assertions about something they are not testing.
   */
  const indexRequests = () =>
    h.requested.filter((url) => url === MIRROR_INDEX_URL || url === REGISTRY_URL);

  it('asks the mirror before the canonical host', async () => {
    // Breaks: the change buys nothing - every fetch still goes to the host that
    // was timing out, and the mirror is dead weight nobody notices is unused.
    h.responses.set(MIRROR_INDEX_URL, { body: registryFor(archiveFor()) });
    const { fetchCatalog } = await loadService();

    const catalog = await fetchCatalog();
    expect(catalog.items.map((item) => item.id)).toEqual(['otp-code']);
    expect(indexRequests()).toEqual([MIRROR_INDEX_URL]);
  });

  it('falls back to the canonical host when the mirror does not answer', async () => {
    // Breaks: a CDN outage, or a network that blocks it, takes the whole
    // catalogue down with it - the exact failure the mirror was added to avoid.
    h.responses.set(REGISTRY_URL, { body: registryFor(archiveFor()) });
    const { fetchCatalog } = await loadService();

    const catalog = await fetchCatalog();
    expect(catalog.items.map((item) => item.id)).toEqual(['otp-code']);
    expect(catalog.registries[0]).toMatchObject({ ok: true, fromCache: false });
    expect(indexRequests()).toEqual([MIRROR_INDEX_URL, REGISTRY_URL]);
  });

  it('reports the registry under its canonical URL whichever host served it', async () => {
    // Breaks: the configured registry and the one shown as its status row stop
    // matching, so "which registry failed" names a URL nobody configured.
    h.responses.set(MIRROR_INDEX_URL, { body: registryFor(archiveFor()) });
    const { fetchCatalog } = await loadService();

    expect((await fetchCatalog()).registries[0].url).toBe(REGISTRY_URL);
  });

  it('caches under the canonical URL, so a mirrored fetch is not refetched', async () => {
    // Breaks: caching under whichever host answered means the mirror and the
    // canonical host each keep their own copy, and every failover refetches a
    // document already on disk.
    h.responses.set(MIRROR_INDEX_URL, { body: registryFor(archiveFor()) });
    const { fetchCatalog } = await loadService();

    await fetchCatalog();
    expect(indexRequests()).toEqual([MIRROR_INDEX_URL]);
    await fetchCatalog();
    expect(indexRequests()).toEqual([MIRROR_INDEX_URL]);
  });

  it('fetches the detail document through the mirror too', async () => {
    // Breaks: Browse is fast and Install still hangs on the slow host, which is
    // the worse half - it stalls after the user has committed to installing.
    const archive = archiveFor();
    h.responses.set(MIRROR_INDEX_URL, {
      body: JSON.stringify({
        schemaVersion: 2,
        generatedAt: '2026-09-01T00:00:00.000Z',
        source: 'https://github.com/Sarv/SarvInbox-extensions',
        extensions: [
          {
            id: 'otp-code',
            name: 'OTP Code',
            version: '1.0.0',
            description: 'Surfaces verification codes',
            author: 'Sarv',
            keywords: ['otp'],
            detailUrl: 'e/otp-code.json',
            engines: { sarvinbox: '^1.1.0' },
            permissions: ['email:read', 'ui:notify'],
            size: archive.length,
            stats: { downloads: 42 },
          },
        ],
      }),
    });
    h.responses.set(MIRROR_DETAIL_URL, {
      body: JSON.stringify({
        schemaVersion: 2,
        id: 'otp-code',
        version: '1.0.0',
        download: {
          url: ASSET_URL,
          sha256: createHash('sha256').update(archive).digest('hex'),
          size: archive.length,
        },
      }),
    });
    const { getRegistryEntry } = await loadService();

    const entry = await getRegistryEntry('otp-code');
    expect(entry.download?.url).toBe(ASSET_URL);
    expect(h.requested).toContain(MIRROR_DETAIL_URL);
    expect(h.requested).not.toContain(DETAIL_URL);
  });

  it('downloads the archive from the release, which the mirror cannot serve', async () => {
    // Breaks: release assets are not repository files, so a mirrored download
    // URL is a 404 on every install - and the digest check would never even be
    // reached to say why.
    const archive = archiveFor();
    h.responses.set(MIRROR_INDEX_URL, { body: registryFor(archive) });
    h.responses.set(ASSET_URL, { body: archive });
    const { installFromRegistry } = await loadService();

    await installFromRegistry('otp-code', ['email:read', 'ui:notify']);
    expect(h.requested).toContain(ASSET_URL);
    expect(h.requested.filter((url) => url.includes('cdn.jsdelivr.net/gh') && url.endsWith('.tgz'))).toEqual([]);
  });
});
