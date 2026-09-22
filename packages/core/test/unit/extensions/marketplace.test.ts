import { describe, expect, it } from 'vitest';

import {
  MAX_DOWNLOAD_BYTES,
  buildCatalog,
  compareExtensionVersions,
  isTrustedRegistryUrl,
  mergeRegistries,
  mergeRegistryDetail,
  parseRegistryDocument,
  resolveTrustedUrl,
  type RegistryEntry,
} from '../../../src/extensions/marketplace';

const SOURCE = 'https://raw.githubusercontent.com/Sarv/SarvInbox-extensions/main/registry.json';
const DIGEST = 'a'.repeat(64);

function entryDocument(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'otp-code',
    name: 'One-Time Passcodes',
    version: '1.0.0',
    description: 'Surfaces verification codes',
    author: 'Sarv',
    license: 'MIT',
    keywords: ['otp'],
    engines: { sarvinbox: '^1.1.0' },
    permissions: ['email:read', 'ui:notify'],
    iconUrl: 'https://raw.githubusercontent.com/Sarv/SarvInbox-extensions/main/extensions/otp-code/icon.svg',
    download: {
      url: 'https://github.com/Sarv/SarvInbox-extensions/releases/download/otp-code-v1.0.0/otp-code-1.0.0.tgz',
      sha256: DIGEST,
      size: 7104,
      publishedAt: '2026-09-22T09:58:11Z',
      releaseTag: 'otp-code-v1.0.0',
    },
    stats: { downloads: 42 },
    ...overrides,
  };
}

function registryDocument(extensions: unknown[], overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    generatedAt: '2026-09-22T10:00:00.000Z',
    source: 'https://github.com/Sarv/SarvInbox-extensions',
    stats: { stars: 12, watchers: 3 },
    extensions,
    ...overrides,
  };
}

describe('isTrustedRegistryUrl', () => {
  // Regression: an http or non-GitHub URL reaching the downloader means the
  // pinned checksum is the only thing between the user and arbitrary code from
  // an arbitrary host, and a MITM on plain http can rewrite both.
  it('accepts https URLs on the known GitHub hosts', () => {
    expect(isTrustedRegistryUrl(SOURCE)).toBe(true);
    expect(isTrustedRegistryUrl('https://github.com/x/y/releases/download/a/b.tgz')).toBe(true);
    expect(isTrustedRegistryUrl('https://objects.githubusercontent.com/a')).toBe(true);
  });

  it('refuses plain http, other hosts, and anything unparseable', () => {
    expect(isTrustedRegistryUrl('http://github.com/x')).toBe(false);
    expect(isTrustedRegistryUrl('https://evil.example.com/registry.json')).toBe(false);
    expect(isTrustedRegistryUrl('https://github.com.evil.example.com/x')).toBe(false);
    expect(isTrustedRegistryUrl('not a url')).toBe(false);
    expect(isTrustedRegistryUrl('')).toBe(false);
    expect(isTrustedRegistryUrl(null)).toBe(false);
  });
});

describe('parseRegistryDocument', () => {
  it('reads a well-formed document', () => {
    const parsed = parseRegistryDocument(registryDocument([entryDocument()]), SOURCE);

    expect(parsed.rejected).toEqual([]);
    expect(parsed.stats).toEqual({ stars: 12, watchers: 3 });
    expect(parsed.generatedAt).toBe('2026-09-22T10:00:00.000Z');
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0]).toMatchObject({
      id: 'otp-code',
      version: '1.0.0',
      engineRange: '^1.1.0',
      permissions: ['email:read', 'ui:notify'],
      sourceUrl: SOURCE,
      stats: { downloads: 42 },
    });
    expect(parsed.entries[0].download.sha256).toBe(DIGEST);
  });

  // Regression: a registry is a remote document that can be truncated or
  // half-written by a failed CI run. One unusable entry must cost the user that
  // one extension, never the whole panel.
  it('keeps the good entries and reports the bad ones', () => {
    const parsed = parseRegistryDocument(
      registryDocument([
        entryDocument(),
        entryDocument({ id: 'broken', download: { url: 'https://github.com/a/b.tgz', sha256: 'nope', size: 10 } }),
        'not an object',
      ]),
      SOURCE
    );

    expect(parsed.entries.map((entry) => entry.id)).toEqual(['otp-code']);
    expect(parsed.rejected).toHaveLength(2);
    expect(parsed.rejected[0]).toEqual({ id: 'broken', reason: expect.stringContaining('sha256') });
    expect(parsed.rejected[1].id).toBeNull();
  });

  // Regression: the checksum IS the security boundary. An entry that loses it
  // must become uninstallable, not install unverified.
  it.each([
    ['a missing digest', undefined],
    ['a short digest', 'ab'],
    ['a digest with a non-hex character', `${'a'.repeat(63)}z`],
    ['a digest that is not a string', 12345],
  ])('rejects an entry with %s', (_label, sha256) => {
    const parsed = parseRegistryDocument(
      registryDocument([
        entryDocument({
          download: { url: 'https://github.com/a/b/releases/download/x/y.tgz', sha256, size: 10 },
        }),
      ]),
      SOURCE
    );
    expect(parsed.entries).toEqual([]);
    expect(parsed.rejected[0].reason).toContain('sha256');
  });

  // Hex is case-insensitive, so an uppercase digest is a valid one. It is
  // normalised here rather than at the comparison so there is exactly one
  // spelling to compare against downstream.
  it('accepts an uppercase digest and lowercases it', () => {
    const parsed = parseRegistryDocument(
      registryDocument([
        entryDocument({
          download: { url: 'https://github.com/a/b/releases/download/x/y.tgz', sha256: 'A'.repeat(64), size: 10 },
        }),
      ]),
      SOURCE
    );
    expect(parsed.entries[0].download.sha256).toBe('a'.repeat(64));
  });

  it('rejects a download URL that is not an allowed https GitHub host', () => {
    const parsed = parseRegistryDocument(
      registryDocument([
        entryDocument({ download: { url: 'https://evil.example.com/x.tgz', sha256: DIGEST, size: 10 } }),
      ]),
      SOURCE
    );
    expect(parsed.rejected[0].reason).toContain('not an allowed https GitHub URL');
  });

  // Regression: a multi-gigabyte "extension" would be downloaded into memory
  // before anything noticed.
  it('rejects a download larger than the cap, and one with no size', () => {
    const tooBig = parseRegistryDocument(
      registryDocument([
        entryDocument({
          download: { url: 'https://github.com/a/b/releases/download/x/y.tgz', sha256: DIGEST, size: MAX_DOWNLOAD_BYTES + 1 },
        }),
      ]),
      SOURCE
    );
    expect(tooBig.rejected[0].reason).toContain('exceeds');

    const noSize = parseRegistryDocument(
      registryDocument([
        entryDocument({
          download: { url: 'https://github.com/a/b/releases/download/x/y.tgz', sha256: DIGEST },
        }),
      ]),
      SOURCE
    );
    expect(noSize.rejected[0].reason).toContain('size');
  });

  // Regression: the user is shown this permission list before activation. A
  // permission the app cannot name is one it cannot show them honestly, so the
  // entry is refused rather than listed with a gap.
  it('rejects an entry asking for a permission this build does not know', () => {
    const parsed = parseRegistryDocument(
      registryDocument([entryDocument({ permissions: ['email:read', 'kernel:pwn'] })]),
      SOURCE
    );
    expect(parsed.entries).toEqual([]);
    expect(parsed.rejected[0].reason).toContain('kernel:pwn');
  });

  // Regression: ids become folder names. A traversal or absolute path here
  // would install outside the extensions directory.
  it.each(['../escape', '/abs', 'Upper', 'has space', ''])('rejects the id %j', (id) => {
    const parsed = parseRegistryDocument(registryDocument([entryDocument({ id })]), SOURCE);
    expect(parsed.entries).toEqual([]);
    expect(parsed.rejected).toHaveLength(1);
  });

  it('requires name, version, description and author', () => {
    const parsed = parseRegistryDocument(registryDocument([entryDocument({ author: '  ' })]), SOURCE);
    expect(parsed.rejected[0].reason).toContain('required');
  });

  // Regression: silently taking the last of two entries with the same id makes
  // which build a user gets depend on array order.
  it('keeps the first of two entries sharing an id', () => {
    const parsed = parseRegistryDocument(
      registryDocument([entryDocument({ version: '1.0.0' }), entryDocument({ version: '9.9.9' })]),
      SOURCE
    );
    expect(parsed.entries.map((entry) => entry.version)).toEqual(['1.0.0']);
    expect(parsed.rejected[0].reason).toContain('duplicate');
  });

  // Regression: a bad icon URL should cost the entry its picture, not its listing.
  it('drops an untrusted icon but keeps the extension', () => {
    const parsed = parseRegistryDocument(
      registryDocument([entryDocument({ iconUrl: 'https://tracker.example.com/pixel.svg' })]),
      SOURCE
    );
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0].iconUrl).toBeUndefined();
  });

  // Regression: a future registry format must not be half-read. Fields this
  // build does not understand could be the ones carrying the safety rules.
  // The "future" version moved from 2 to 3 when the served thin index made 2
  // the current format - the rule is unchanged, only the number it refuses.
  it('refuses a document whose schemaVersion is newer than this build', () => {
    const parsed = parseRegistryDocument(registryDocument([entryDocument()], { schemaVersion: 3 }), SOURCE);
    expect(parsed.entries).toEqual([]);
    expect(parsed.rejected[0].reason).toContain('newer than this app');
  });

  it('returns empty rather than throwing for junk input', () => {
    for (const junk of [null, undefined, 'a string', 42, []]) {
      expect(() => parseRegistryDocument(junk, SOURCE)).not.toThrow();
      expect(parseRegistryDocument(junk, SOURCE).entries).toEqual([]);
    }
  });

  it('reads an optional rating, clamped to 0-5, and ignores ratingCount without one', () => {
    const rated = parseRegistryDocument(
      registryDocument([entryDocument({ stats: { downloads: 1, rating: 9, ratingCount: 30 } })]),
      SOURCE
    );
    expect(rated.entries[0].stats).toEqual({ downloads: 1, rating: 5, ratingCount: 30 });

    const unrated = parseRegistryDocument(registryDocument([entryDocument()]), SOURCE);
    expect(unrated.entries[0].stats.rating).toBeUndefined();
    expect(unrated.entries[0].stats.ratingCount).toBeUndefined();
  });
});

describe('compareExtensionVersions', () => {
  it('orders by major, minor then patch', () => {
    expect(compareExtensionVersions('2.0.0', '1.9.9')).toBeGreaterThan(0);
    expect(compareExtensionVersions('1.2.0', '1.10.0')).toBeLessThan(0);
    expect(compareExtensionVersions('1.0.2', '1.0.10')).toBeLessThan(0);
    expect(compareExtensionVersions('1.0.0', '1.0.0')).toBe(0);
  });

  // Regression: a prerelease sorting ABOVE its release would offer users a beta
  // as an upgrade from the stable build.
  it('sorts a prerelease below the release it leads to', () => {
    expect(compareExtensionVersions('1.1.0-beta.1', '1.1.0')).toBeLessThan(0);
    expect(compareExtensionVersions('1.1.0', '1.1.0-beta.1')).toBeGreaterThan(0);
    expect(compareExtensionVersions('1.1.0-alpha', '1.1.0-beta')).toBeLessThan(0);
  });

  it('treats missing or non-numeric parts as zero', () => {
    expect(compareExtensionVersions('1', '1.0.0')).toBe(0);
    expect(compareExtensionVersions('1.x.0', '1.0.0')).toBe(0);
  });
});

describe('buildCatalog', () => {
  const entries = parseRegistryDocument(
    registryDocument([
      entryDocument({ id: 'otp-code', stats: { downloads: 10 } }),
      entryDocument({ id: 'vip-scoring', name: 'VIP', version: '2.0.0', stats: { downloads: 99 } }),
    ]),
    SOURCE
  ).entries;

  it('marks an entry available when nothing is installed', () => {
    const catalog = buildCatalog({ entries, installed: [], appVersion: '1.1.1' });
    expect(catalog.map((item) => item.state)).toEqual(['available', 'available']);
  });

  it('orders by downloads, then by name', () => {
    const catalog = buildCatalog({ entries, installed: [], appVersion: '1.1.1' });
    expect(catalog.map((item) => item.id)).toEqual(['vip-scoring', 'otp-code']);
  });

  it('marks an installed extension, carrying its local version and enabled flag', () => {
    const catalog = buildCatalog({
      entries,
      installed: [{ id: 'otp-code', version: '1.0.0', enabled: false }],
      appVersion: '1.1.1',
    });
    const otp = catalog.find((item) => item.id === 'otp-code');
    expect(otp).toMatchObject({ state: 'installed', installedVersion: '1.0.0', enabled: false });
  });

  it('marks an update when the registry is ahead of the installed copy', () => {
    const catalog = buildCatalog({
      entries,
      installed: [{ id: 'vip-scoring', version: '1.5.0', enabled: true }],
      appVersion: '1.1.1',
    });
    expect(catalog.find((item) => item.id === 'vip-scoring')).toMatchObject({
      state: 'update-available',
      installedVersion: '1.5.0',
    });
  });

  // Regression: an extension needing a newer app must say so in the list.
  // Discovering it at install time means the user has already been asked to
  // approve permissions for something that was never going to run.
  it('marks an entry incompatible with this app version, and says why', () => {
    const catalog = buildCatalog({ entries, installed: [], appVersion: '1.0.0' });
    expect(catalog[0]).toMatchObject({ state: 'incompatible' });
    expect(catalog[0].incompatibleReason).toContain('1.0.0');
  });

  // An extension already on disk stays listed as installed even after the app
  // moves out of its declared range, so the user can still see and remove it.
  it('does not hide an already-installed extension that has become incompatible', () => {
    const catalog = buildCatalog({
      entries,
      installed: [{ id: 'otp-code', version: '1.0.0', enabled: true }],
      appVersion: '1.0.0',
    });
    expect(catalog.find((item) => item.id === 'otp-code')?.state).toBe('installed');
  });

  it('treats an entry with no engine range as compatible', () => {
    const noRange = parseRegistryDocument(
      registryDocument([entryDocument({ engines: {} })]),
      SOURCE
    ).entries;
    expect(buildCatalog({ entries: noRange, installed: [], appVersion: '0.1.0' })[0].state).toBe('available');
  });
});

describe('mergeRegistries', () => {
  const official = parseRegistryDocument(registryDocument([entryDocument({ version: '1.0.0' })]), SOURCE);
  const community = parseRegistryDocument(
    registryDocument([
      entryDocument({ version: '9.9.9' }),
      entryDocument({ id: 'community-only', name: 'Community' }),
    ]),
    'https://raw.githubusercontent.com/someone/else/main/registry.json'
  );

  // Regression: a user-added registry may ADD extensions but must never shadow
  // an official one with a build of its own.
  it('lets the earlier registry win a clash of ids', () => {
    const merged = mergeRegistries([official, community]);
    expect(merged.find((entry) => entry.id === 'otp-code')?.version).toBe('1.0.0');
    expect(merged.map((entry) => entry.id).sort()).toEqual(['community-only', 'otp-code']);
  });

  it('returns nothing for no registries', () => {
    expect(mergeRegistries([])).toEqual([] as RegistryEntry[]);
  });
});

/**
 * The served registry is a thin index: the list carries only what a card draws,
 * and the download URL plus the pinned digest live in a per-extension document
 * fetched when someone actually chooses to install.
 */
describe('v2 thin index', () => {
  const INDEX = 'https://raw.githubusercontent.com/Sarv/SarvInbox-extensions/main/registry/index.json';

  function indexEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    const { download: _dropped, ...rest } = entryDocument();
    return {
      ...rest,
      iconUrl: '../extensions/otp-code/icon.svg',
      detailUrl: 'e/otp-code.json',
      size: 7104,
      ...overrides,
    };
  }

  function parseOne(entry: Record<string, unknown>, source = INDEX): RegistryEntry {
    const parsed = parseRegistryDocument(registryDocument([entry], { schemaVersion: 2 }), source);
    expect(parsed.rejected).toEqual([]);
    expect(parsed.entries).toHaveLength(1);
    return parsed.entries[0];
  }

  // Breaks: the Browse tab shows nothing at all once the registry moves to the
  // served index, because every entry is rejected for having no download block.
  it('accepts an entry with a detailUrl and no download block', () => {
    const entry = parseOne(indexEntry());
    expect(entry.download).toBeUndefined();
    expect(entry.size).toBe(7104);
    expect(entry.detailUrl).toBe(
      'https://raw.githubusercontent.com/Sarv/SarvInbox-extensions/main/registry/e/otp-code.json'
    );
  });

  // Breaks: icons and detail documents are resolved against nothing and the
  // cards draw broken images, or - worse - a relative path is silently kept and
  // later fetched against the app's own file:// origin.
  it('resolves relative URLs against the document that carried them', () => {
    const entry = parseOne(indexEntry());
    expect(entry.iconUrl).toBe(
      'https://raw.githubusercontent.com/Sarv/SarvInbox-extensions/main/extensions/otp-code/icon.svg'
    );
  });

  // Breaks: a registry could point the detail fetch at a host we never vetted
  // and hand the app a download URL and digest of its own choosing. Relative
  // resolution cannot escape the allowlist (a relative path stays on the base
  // host), but an ABSOLUTE value replaces the base entirely - which is exactly
  // the case this pins.
  it('rejects an entry whose detailUrl leaves the allowed hosts', () => {
    const parsed = parseRegistryDocument(
      registryDocument([indexEntry({ detailUrl: 'https://example.com/e/otp-code.json' })], {
        schemaVersion: 2,
      }),
      INDEX
    );
    expect(parsed.entries).toEqual([]);
    expect(parsed.rejected[0]?.reason).toMatch(/detailUrl/);
  });

  // Breaks: the card shows no size, or a hostile registry claims a 4 GB
  // extension and the app offers to download it.
  it.each([
    ['missing', undefined, /size is missing/],
    ['zero', 0, /size is missing/],
    ['over the cap', MAX_DOWNLOAD_BYTES + 1, /exceeds/],
  ])('rejects an entry whose size is %s', (_label, size, reason) => {
    const parsed = parseRegistryDocument(
      registryDocument([indexEntry({ size })], { schemaVersion: 2 }),
      INDEX
    );
    expect(parsed.entries).toEqual([]);
    expect(parsed.rejected[0]?.reason).toMatch(reason);
  });

  // Breaks: an entry with neither a download block nor a detail document is
  // listed as installable and fails only once the user has already consented.
  it('rejects an entry with neither a download block nor a detailUrl', () => {
    const { detailUrl: _dropped, ...noDetail } = indexEntry();
    const parsed = parseRegistryDocument(
      registryDocument([noDetail], { schemaVersion: 2 }),
      INDEX
    );
    expect(parsed.rejected[0]?.reason).toMatch(/no download block and no detailUrl/);
  });

  // Breaks: the previous registry format stops working the moment the app
  // updates, so an older published registry - or a community one that never
  // migrated - empties the Browse tab.
  it('still accepts a v1 entry with its download block inline', () => {
    const entry = parseOne(entryDocument(), SOURCE);
    expect(entry.download?.sha256).toBe(DIGEST);
    expect(entry.size).toBe(7104);
    expect(entry.detailUrl).toBeUndefined();
  });
});

describe('mergeRegistryDetail', () => {
  const INDEX = 'https://raw.githubusercontent.com/Sarv/SarvInbox-extensions/main/registry/index.json';
  const DETAIL_URL =
    'https://raw.githubusercontent.com/Sarv/SarvInbox-extensions/main/registry/e/otp-code.json';

  function listed(overrides: Partial<RegistryEntry> = {}): RegistryEntry {
    const { download: _dropped, ...rest } = entryDocument();
    const parsed = parseRegistryDocument(
      registryDocument([{ ...rest, detailUrl: 'e/otp-code.json', size: 7104 }], {
        schemaVersion: 2,
      }),
      INDEX
    );
    return { ...parsed.entries[0], ...overrides };
  }

  function detail(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      schemaVersion: 2,
      id: 'otp-code',
      version: '1.0.0',
      license: 'Apache-2.0',
      readmeUrl: '../../extensions/otp-code/README.md',
      download: entryDocument().download,
      ...overrides,
    };
  }

  // Breaks: the permission prompt has no checksum to show and the install has
  // nothing to verify against, so the whole thin-index path cannot complete.
  it('folds the download block into the listed entry', () => {
    const merged = mergeRegistryDetail(detail(), listed());
    expect('entry' in merged).toBe(true);
    if (!('entry' in merged)) return;
    expect(merged.entry.download?.sha256).toBe(DIGEST);
    expect(merged.entry.size).toBe(7104);
    expect(merged.entry.license).toBe('Apache-2.0');
    expect(merged.entry.readmeUrl).toBe(
      'https://raw.githubusercontent.com/Sarv/SarvInbox-extensions/main/extensions/otp-code/README.md'
    );
  });

  // Breaks: the archive's size is taken from the list rather than from the
  // document the digest was computed over, so a list that understates it lets a
  // larger download past the size check.
  it('takes the size from the download block, not from the list', () => {
    const download = { ...entryDocument().download as Record<string, unknown>, size: 9001 };
    const merged = mergeRegistryDetail(detail({ download }), listed());
    if (!('entry' in merged)) throw new Error(merged.reason);
    expect(merged.entry.size).toBe(9001);
  });

  // Breaks: the user approves permissions for the version they were shown and
  // the app installs a different one. This is the reason the id and the version
  // are repeated in the detail document at all.
  it.each([
    ['a different id', { id: 'vip-scoring' }, /not "otp-code"/],
    ['a different version', { version: '2.0.0' }, /the list showed 1\.0\.0/],
  ])('refuses a detail document with %s', (_label, overrides, reason) => {
    const merged = mergeRegistryDetail(detail(overrides), listed());
    expect('reason' in merged).toBe(true);
    if ('reason' in merged) expect(merged.reason).toMatch(reason);
  });

  // Breaks: a detail document with a malformed or untrusted download is merged
  // anyway, and the install proceeds against a URL nothing vetted.
  it.each([
    ['no download at all', {}],
    ['a download on an untrusted host', { url: 'https://example.com/otp.tgz' }],
    ['a short digest', { sha256: 'abc' }],
  ])('refuses a detail document with %s', (label, patch) => {
    const download =
      label === 'no download at all'
        ? undefined
        : { ...(entryDocument().download as Record<string, unknown>), ...patch };
    const merged = mergeRegistryDetail(detail({ download }), listed());
    expect('reason' in merged).toBe(true);
  });

  // Breaks: a registry published under a future format is merged on a
  // best-effort basis instead of being refused, which is the one thing a
  // security-relevant document must not do.
  it('refuses a detail document from a newer schema', () => {
    const merged = mergeRegistryDetail(detail({ schemaVersion: 99 }), listed());
    expect('reason' in merged).toBe(true);
  });

  // Breaks: a malformed response (an HTML error page parsed as JSON, say) is
  // treated as a valid empty document.
  it.each([[null], ['not an object'], [42]])('refuses %s as a detail document', (raw) => {
    expect('reason' in mergeRegistryDetail(raw, listed())).toBe(true);
  });

  // Breaks: the detail document is resolved against the index rather than
  // against its own URL, so `../../extensions/...` lands one directory too high
  // and every README link 404s.
  it('resolves the detail document relative to the detail URL', () => {
    const entry = listed();
    expect(entry.detailUrl).toBe(DETAIL_URL);
  });
});

describe('resolveTrustedUrl', () => {
  const BASE = 'https://raw.githubusercontent.com/Sarv/SarvInbox-extensions/main/registry/index.json';

  // Breaks: a registry hands the app a URL on a host nobody vetted and the app
  // fetches it, which is the whole point of having an allowlist.
  it.each([
    ['a relative path', 'e/otp-code.json', `${BASE.replace('index.json', '')}e/otp-code.json`],
    ['a parent path', '../extensions/otp-code/icon.svg',
      'https://raw.githubusercontent.com/Sarv/SarvInbox-extensions/main/extensions/otp-code/icon.svg'],
    ['an absolute allowed URL', 'https://github.com/Sarv/x/releases/download/a/b.tgz',
      'https://github.com/Sarv/x/releases/download/a/b.tgz'],
    ['an absolute foreign URL', 'https://example.com/x.json', null],
    ['a protocol-relative URL', '//example.com/x.json', null],
    ['plain http', 'http://raw.githubusercontent.com/a/b.json', null],
    ['a non-string', 42, null],
    ['nothing', undefined, null],
  ])('resolves %s', (_label, value, expected) => {
    expect(resolveTrustedUrl(value, BASE)).toBe(expected);
  });
});

/**
 * The descriptive half of an entry: what the extension does, and pictures of it.
 *
 * What this protects: these fields answer "what IS this" in the catalogue and
 * in the install prompt. Two properties matter and pull in opposite directions.
 * They must be forgiving — a malformed panel list should cost an extension its
 * sentence, never its listing, unlike a permission, which is rejected exactly
 * because it decides what the extension may do. And screenshot URLs must be as
 * unforgiving as every other URL here: a screenshot is a request the app makes
 * while merely DRAWING the catalogue, before anyone has chosen to trust
 * anything, so an unchecked one is a beacon to whatever host an author names.
 */
describe('contributes and screenshots', () => {
  const ARCHIVE_URL =
    'https://github.com/Sarv/SarvInbox-extensions/releases/download/otp-code-v1.0.0/otp-code-1.0.0.tgz';
  const contributes = {
    panels: [{ id: 'codes', title: 'Passcodes', surface: 'sidebar', autoOpen: true }],
    workflows: [{ id: 'scan', name: 'Find codes' }],
    settings: [{ key: 'markRead' }],
    capabilities: [{ id: 'thread.summarize', export: 'summarize' }],
  };

  it('carries the summary through to the entry', () => {
    const parsed = parseRegistryDocument(
      registryDocument([entryDocument({ contributes })]),
      SOURCE
    );

    expect(parsed.entries[0].contributes).toEqual({
      panels: [{ title: 'Passcodes', surface: 'sidebar', autoOpen: true }],
      workflows: [{ name: 'Find codes', requiresAI: undefined }],
      settings: [{ key: 'markRead' }],
      capabilities: [{ id: 'thread.summarize', description: undefined }],
    });
  });

  // Regression: rejecting the entry over a decorative field would take a
  // perfectly installable extension out of the catalogue.
  it('drops a malformed summary without rejecting the extension', () => {
    const parsed = parseRegistryDocument(
      registryDocument([
        entryDocument({ contributes: { panels: 'not a list', workflows: [{ name: 42 }] } }),
      ]),
      SOURCE
    );

    expect(parsed.rejected).toEqual([]);
    expect(parsed.entries[0].contributes).toBeUndefined();
  });

  it('leaves the summary absent when the registry has none', () => {
    const parsed = parseRegistryDocument(registryDocument([entryDocument()]), SOURCE);

    expect(parsed.entries[0].contributes).toBeUndefined();
  });

  it('keeps screenshots served from an allowed host', () => {
    const parsed = parseRegistryDocument(
      registryDocument([
        entryDocument({
          screenshots: [
            { url: 'extensions/otp-code/shot.png', caption: 'A code in the sidebar' },
          ],
        }),
      ]),
      SOURCE
    );

    expect(parsed.entries[0].screenshots).toEqual([
      {
        url: 'https://raw.githubusercontent.com/Sarv/SarvInbox-extensions/main/extensions/otp-code/shot.png',
        caption: 'A code in the sidebar',
      },
    ]);
  });

  // Regression: the catalogue loads every screenshot it is given the moment it
  // is drawn. An off-allowlist URL is a request to a stranger's server made on
  // the reader's behalf, with their IP, for an extension they have not
  // installed and may never install.
  it('refuses a screenshot from anywhere else', () => {
    const parsed = parseRegistryDocument(
      registryDocument([
        entryDocument({
          screenshots: [
            { url: 'https://tracker.example.com/pixel.png' },
            { url: 'http://raw.githubusercontent.com/Sarv/x/main/shot.png' },
          ],
        }),
      ]),
      SOURCE
    );

    expect(parsed.rejected).toEqual([]);
    expect(parsed.entries[0].screenshots).toBeUndefined();
  });

  // A registry is third-party data; the prompt is a fixed-size dialog.
  it('caps how many screenshots an entry can carry', () => {
    const many = Array.from({ length: 12 }, (_unused, index) => ({
      url: `https://raw.githubusercontent.com/Sarv/x/main/${index}.png`,
    }));
    const parsed = parseRegistryDocument(
      registryDocument([entryDocument({ screenshots: many })]),
      SOURCE
    );

    expect(parsed.entries[0].screenshots).toHaveLength(6);
  });

  // A v2 index is deliberately thin, so the long-form record is where these
  // may live; the merge must not drop what the index already had either.
  it('takes them from the detail document, keeping the index values otherwise', () => {
    const indexed = parseRegistryDocument(
      registryDocument(
        [
          entryDocument({
            download: undefined,
            size: 7104,
            detailUrl: 'e/otp-code.json',
            contributes: { workflows: [{ name: 'Find codes' }] },
          }),
        ],
        { schemaVersion: 2 }
      ),
      SOURCE
    ).entries[0];

    const withDetail = mergeRegistryDetail(
      {
        schemaVersion: 2,
        id: 'otp-code',
        version: '1.0.0',
        download: { url: ARCHIVE_URL, sha256: DIGEST, size: 7104 },
        contributes,
      },
      indexed
    );

    expect('entry' in withDetail).toBe(true);
    if (!('entry' in withDetail)) return;
    expect(withDetail.entry.contributes?.panels?.[0].title).toBe('Passcodes');

    const noDetailFields = mergeRegistryDetail(
      {
        schemaVersion: 2,
        id: 'otp-code',
        version: '1.0.0',
        download: { url: ARCHIVE_URL, sha256: DIGEST, size: 7104 },
      },
      indexed
    );

    expect('entry' in noDetailFields).toBe(true);
    if (!('entry' in noDetailFields)) return;
    expect(noDetailFields.entry.contributes?.workflows?.[0].name).toBe('Find codes');
  });
});
